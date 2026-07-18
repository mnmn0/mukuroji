import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_IMPORT_DLQ_RETENTION_DAYS,
  WORK_ITEM_IMPORT_SOURCE_RETENTION_DAYS,
  WorkItemImportError,
  type PutWorkItemImportSourceRequest,
  type WorkItemImportExecution,
  type WorkItemImportExecutionStatus,
  type WorkItemImportExecutionStore,
  type WorkItemImportQueue,
  type WorkItemImportQueueMessage,
  type WorkItemImportRowReceipt,
  type WorkItemImportSourceLocator,
  type WorkItemImportSourceOwner,
  type WorkItemImportSourceStore,
} from './work-item-import'
import { WORK_ITEM_IMPORT_MAX_BYTES } from './work-item-transfer'

const executionRecordPrefix = 'IMPORT_EXECUTION#'
const receiptRecordPrefix = 'IMPORT_RECEIPT#'

/** Versioned/encrypted S3 bucket を利用する import source store です。 */
export class S3WorkItemImportSourceStore implements WorkItemImportSourceStore {
  /** AWS SDK S3 client です。 */
  private readonly client: S3Client
  /** Import source bucket 名です。 */
  private readonly bucketName: string

  /** S3 import source store を作成します。 */
  constructor(client: S3Client, bucketName: string) {
    this.client = client
    this.bucketName = requireText(bucketName, 'Work Item import bucket name')
  }

  /** Source を if-none-match と server-side encryption で保存します。 */
  async putImmutable(
    request: PutWorkItemImportSourceRequest,
  ): Promise<WorkItemImportSourceLocator> {
    const objectKey = createSourceObjectKey(request)
    const checksum = Buffer.from(request.sha256, 'hex').toString('base64')
    let objectVersionId: string | undefined
    let sourceExpiresAt = request.expiresAt
    try {
      const response = await this.client.send(createPutSourceCommand(
        this.bucketName,
        objectKey,
        checksum,
        request,
        true,
      ))
      objectVersionId = response.VersionId
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error
      const existing = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      }))
      if (
        existing.Metadata?.['mukuroji-sha256'] !== request.sha256 ||
        existing.Metadata?.['mukuroji-byte-length'] !== String(request.byteLength)
      ) {
        throw new WorkItemImportError(
          'ImportSourceConflict',
          'Import source object is already bound to different content.',
        )
      }
      const reusableExpiry = readReusableSourceExpiry(existing, request.expiresAt)
      if (existing.VersionId && reusableExpiry) {
        objectVersionId = existing.VersionId
        sourceExpiresAt = reusableExpiry
      } else {
        const refreshed = await this.client.send(createPutSourceCommand(
          this.bucketName,
          objectKey,
          checksum,
          request,
          false,
        ))
        objectVersionId = refreshed.VersionId
      }
    }
    if (!objectVersionId) {
      throw new WorkItemImportError(
        'ImportSourceVersionUnavailable',
        'Import source storage did not return an immutable object version.',
        true,
      )
    }
    return {
      bucketName: this.bucketName,
      objectKey,
      objectVersionId,
      sha256: request.sha256,
      byteLength: request.byteLength,
      expiresAt: sourceExpiresAt,
    }
  }

  /** Version ID 固定 read と SHA-256/byte-size/UTF-8 検証を行います。 */
  async getVerified(
    locator: WorkItemImportSourceLocator,
    expected: WorkItemImportSourceOwner,
  ) {
    assertExpectedLocator(locator, expected, this.bucketName)
    const response = await this.client.send(new GetObjectCommand({
      Bucket: locator.bucketName,
      Key: locator.objectKey,
      VersionId: locator.objectVersionId,
      ChecksumMode: 'ENABLED',
    }))
    if (
      typeof response.ContentLength === 'number' &&
      (response.ContentLength > WORK_ITEM_IMPORT_MAX_BYTES ||
        response.ContentLength !== locator.byteLength)
    ) {
      throw new WorkItemImportError(
        'ImportSourceIntegrityInvalid',
        'Import source size does not match its immutable descriptor.',
      )
    }
    const bytes = await response.Body?.transformToByteArray()
    if (!bytes || bytes.byteLength !== locator.byteLength || bytes.byteLength > WORK_ITEM_IMPORT_MAX_BYTES) {
      throw new WorkItemImportError(
        'ImportSourceIntegrityInvalid',
        'Import source body does not match its immutable descriptor.',
      )
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== locator.sha256) {
      throw new WorkItemImportError(
        'ImportSourceIntegrityInvalid',
        'Import source digest does not match its immutable descriptor.',
      )
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new WorkItemImportError(
        'ImportSourceEncodingInvalid',
        'Import source must be valid UTF-8.',
        false,
        { cause: error },
      )
    }
  }

  /** Terminal job の immutable source version だけを削除します。 */
  async deleteVersion(
    locator: WorkItemImportSourceLocator,
    expected: WorkItemImportSourceOwner,
  ) {
    assertExpectedLocator(locator, expected, this.bucketName)
    await this.client.send(new DeleteObjectCommand({
      Bucket: locator.bucketName,
      Key: locator.objectKey,
      VersionId: locator.objectVersionId,
    }))
  }
}

/** Developer platform DynamoDB table に execution/receipt を保存する store です。 */
export class DynamoDbWorkItemImportExecutionStore implements WorkItemImportExecutionStore {
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Developer platform table 名です。 */
  private readonly tableName: string

  /** DynamoDB import execution store を作成します。 */
  constructor(documentClient: DynamoDBDocumentClient, tableName: string) {
    this.documentClient = documentClient
    this.tableName = requireText(tableName, 'Developer platform table name')
  }

  /** Execution を条件付き作成し、retry 時は existing row を返します。 */
  async createOrGet(execution: WorkItemImportExecution) {
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: toExecutionItem(execution),
        ConditionExpression:
          'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      }))
      return structuredClone(execution)
    } catch (error) {
      if (!isConditionalFailure(error)) throw error
      const existing = await this.get(execution.workspaceId, execution.jobId)
      if (!existing) throw error
      return existing
    }
  }

  /** Execution を strong-consistent read します。 */
  async get(workspaceId: string, jobId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createExecutionRecordKey(jobId) },
      ConsistentRead: true,
    }))
    return response.Item ? readExecutionItem(response.Item) : undefined
  }

  /** Expired lease を takeover 可能な条件付き update で claim します。 */
  async claim(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ) {
    try {
      const response = await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: createExecutionRecordKey(jobId) },
        UpdateExpression:
          'SET #status = :running, leaseOwner = :leaseOwner, leaseExpiresAt = :leaseExpiresAt, updatedAt = :now',
        ConditionExpression:
          '(#status = :queued OR #status = :running) AND cancelRequested = :false AND ' +
          '(attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt < :now OR leaseOwner = :leaseOwner)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':queued': 'queued',
          ':running': 'running',
          ':false': false,
          ':leaseOwner': leaseOwner,
          ':leaseExpiresAt': leaseExpiresAt,
          ':now': now,
        },
        ReturnValues: 'ALL_NEW',
      }))
      return response.Attributes ? readExecutionItem(response.Attributes) : undefined
    } catch (error) {
      if (isConditionalFailure(error)) return undefined
      throw error
    }
  }

  /** Current lease owner の marker を条件付きで除去します。 */
  async releaseClaim(workspaceId: string, jobId: string, leaseOwner: string) {
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: createExecutionRecordKey(jobId) },
        UpdateExpression: 'REMOVE leaseOwner, leaseExpiresAt',
        ConditionExpression: 'leaseOwner = :leaseOwner',
        ExpressionAttributeValues: { ':leaseOwner': leaseOwner },
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) throw error
    }
  }

  /** Receipt insert と checkpoint/lease renewal を1 transaction にします。 */
  async recordRowReceipt(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    receipt: WorkItemImportRowReceipt,
    leaseExpiresAt: string,
  ) {
    const recordKey = createReceiptRecordKey(jobId, receipt.row)
    const execution = await this.get(workspaceId, jobId)
    if (!execution) {
      throw new WorkItemImportError('ImportJobNotFound', 'Import execution was not found.')
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                workspaceId,
                recordKey,
                entryType: 'work-item-import-receipt',
                ...receipt,
                expiresAt: execution.expiresAt,
              },
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { workspaceId, recordKey: createExecutionRecordKey(jobId) },
              UpdateExpression:
                'SET checkpointRow = :row, leaseExpiresAt = :leaseExpiresAt, updatedAt = :updatedAt',
              ConditionExpression:
                '#status = :running AND cancelRequested = :false AND leaseOwner = :leaseOwner AND checkpointRow < :row',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':running': 'running',
                ':false': false,
                ':leaseOwner': leaseOwner,
                ':row': receipt.row,
                ':leaseExpiresAt': leaseExpiresAt,
                ':updatedAt': receipt.completedAt,
              },
            },
          },
        ],
      }))
      return 'created' as const
    } catch (error) {
      const existing = await this.readReceipt(workspaceId, recordKey)
      if (existing) {
        if (
          existing.jobId !== receipt.jobId ||
          existing.row !== receipt.row ||
          existing.requestDigest !== receipt.requestDigest ||
          existing.idempotencyKey !== receipt.idempotencyKey
        ) {
          throw new WorkItemImportError(
            'ImportRowReceiptConflict',
            'Import row receipt is bound to a different request.',
          )
        }
        return 'existing' as const
      }
      throw error
    }
  }

  /** Execution を cancelled にし、worker の次 checkpoint を拒否します。 */
  async requestCancellation(workspaceId: string, jobId: string, now: string) {
    try {
      const response = await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: createExecutionRecordKey(jobId) },
        UpdateExpression:
          'SET #status = :cancelled, cancelRequested = :true, updatedAt = :now REMOVE leaseOwner, leaseExpiresAt',
        ConditionExpression:
          'attribute_exists(workspaceId) AND (#status = :queued OR #status = :running)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':queued': 'queued',
          ':running': 'running',
          ':cancelled': 'cancelled',
          ':true': true,
          ':now': now,
        },
        ReturnValues: 'ALL_NEW',
      }))
      if (!response.Attributes) throw new Error('Import cancellation returned no state.')
      return readExecutionItem(response.Attributes)
    } catch (error) {
      if (!isConditionalFailure(error)) throw error
      const existing = await this.get(workspaceId, jobId)
      if (!existing) {
        throw new WorkItemImportError('ImportJobNotFound', 'Import execution was not found.')
      }
      if (!isTerminal(existing.status)) throw error
      return existing
    }
  }

  /** Current lease owner の completion report を保存して terminal にします。 */
  async markCompletedIfClaimed(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    report: NonNullable<WorkItemImportExecution['terminalReport']>,
    now: string,
  ) {
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: createExecutionRecordKey(jobId) },
        UpdateExpression:
          'SET #status = :completed, terminalReport = :report, updatedAt = :now ' +
          'REMOVE leaseOwner, leaseExpiresAt, terminalProblem',
        ConditionExpression:
          '#status = :running AND cancelRequested = :false AND leaseOwner = :leaseOwner',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':running': 'running',
          ':completed': 'completed',
          ':false': false,
          ':leaseOwner': leaseOwner,
          ':report': report,
          ':now': now,
        },
      }))
      return true
    } catch (error) {
      if (isConditionalFailure(error)) return false
      throw error
    }
  }

  /** Current lease owner の retry exhaustion だけを failed に遷移します。 */
  async markFailedIfClaimed(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    problem: NonNullable<WorkItemImportExecution['terminalProblem']>,
    report: WorkItemImportExecution['terminalReport'],
    now: string,
  ) {
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: createExecutionRecordKey(jobId) },
        UpdateExpression: report
          ? 'SET #status = :failed, terminalProblem = :problem, terminalReport = :report, ' +
            'updatedAt = :now REMOVE leaseOwner, leaseExpiresAt'
          : 'SET #status = :failed, terminalProblem = :problem, updatedAt = :now ' +
            'REMOVE leaseOwner, leaseExpiresAt, terminalReport',
        ConditionExpression:
          '#status = :running AND cancelRequested = :false AND leaseOwner = :leaseOwner',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':running': 'running',
          ':failed': 'failed',
          ':false': false,
          ':leaseOwner': leaseOwner,
          ':problem': problem,
          ...(report ? { ':report': report } : {}),
          ':now': now,
        },
      }))
      return true
    } catch (error) {
      if (isConditionalFailure(error)) return false
      throw error
    }
  }

  private async readReceipt(workspaceId: string, recordKey: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey },
      ConsistentRead: true,
    }))
    if (!response.Item) return undefined
    return readReceiptItem(response.Item)
  }
}

/** Standard SQS queue に secret-free import locators を送る adapter です。 */
export class SqsWorkItemImportQueue implements WorkItemImportQueue {
  /** AWS SDK SQS client です。 */
  private readonly client: SQSClient
  /** Import queue URL です。 */
  private readonly queueUrl: string

  /** SQS import queue adapter を作成します。 */
  constructor(client: SQSClient, queueUrl: string) {
    this.client = client
    this.queueUrl = requireText(queueUrl, 'Work Item import queue URL')
  }

  /** Workspace/job locator だけを JSON message として送信します。 */
  async enqueue(message: WorkItemImportQueueMessage) {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify({
        workspaceId: requireText(message.workspaceId, 'Workspace ID'),
        jobId: requireText(message.jobId, 'Import job ID'),
      }),
    }))
  }
}

/** Production/local 環境変数から DynamoDB import store を作成します。 */
export function createDefaultWorkItemImportExecutionStore() {
  const endpoint = readEnvironment('DYNAMODB_ENDPOINT') ??
    readEnvironment('AWS_ENDPOINT_URL_DYNAMODB') ??
    readEnvironment('AWS_ENDPOINT_URL')
  const client = new DynamoDBClient({
    region: readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'ap-northeast-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  })
  return new DynamoDbWorkItemImportExecutionStore(
    DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    readEnvironment('DEVELOPER_PLATFORM_TABLE_NAME') ?? 'mukuroji-developer-platform-local',
  )
}

/** Production/local 環境変数から S3 import source store を作成します。 */
export function createDefaultWorkItemImportSourceStore() {
  const endpoint = readEnvironment('AWS_ENDPOINT_URL_S3') ?? readEnvironment('AWS_ENDPOINT_URL')
  return new S3WorkItemImportSourceStore(
    new S3Client({
      region: readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'ap-northeast-1',
      ...(endpoint
        ? {
            endpoint,
            forcePathStyle: true,
            credentials: {
              accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
              secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
            },
          }
        : {}),
    }),
    readEnvironment('WORK_ITEM_IMPORT_BUCKET_NAME') ?? 'mukuroji-work-item-import-local',
  )
}

/** Production/local 環境変数から SQS import queue を作成します。 */
export function createDefaultWorkItemImportQueue() {
  const endpoint = readEnvironment('AWS_ENDPOINT_URL_SQS') ?? readEnvironment('AWS_ENDPOINT_URL')
  return new SqsWorkItemImportQueue(
    new SQSClient({
      region: readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'ap-northeast-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
              secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
            },
          }
        : {}),
    }),
    readEnvironment('WORK_ITEM_IMPORT_QUEUE_URL') ?? 'http://localhost:4566/000000000000/work-item-import',
  )
}

function createSourceObjectKey(request: PutWorkItemImportSourceRequest) {
  const workspaceDigest = createHash('sha256').update(request.workspaceId).digest('hex')
  const jobId = requireText(request.jobId, 'Import job ID')
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId)) {
    throw new WorkItemImportError('ImportJobIdInvalid', 'Import job ID is invalid.')
  }
  return `work-item-imports/${workspaceDigest}/${jobId}/${request.sha256}.source`
}

function createPutSourceCommand(
  bucketName: string,
  objectKey: string,
  checksum: string,
  request: PutWorkItemImportSourceRequest,
  ifAbsent: boolean,
) {
  return new PutObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
    Body: request.content,
    ContentLength: request.byteLength,
    ContentType: 'text/plain; charset=utf-8',
    ChecksumSHA256: checksum,
    ...(ifAbsent ? { IfNoneMatch: '*' } : {}),
    Metadata: {
      'mukuroji-sha256': request.sha256,
      'mukuroji-byte-length': String(request.byteLength),
      'mukuroji-expires-at': request.expiresAt,
    },
    ServerSideEncryption: 'AES256',
  })
}

function readReusableSourceExpiry(
  existing: {
    /** S3 object version 作成時刻です。 */
    LastModified?: Date
    /** Import source metadata です。 */
    Metadata?: Record<string, string>
  },
  requestedExpiresAt: string,
) {
  const requestedExpiry = Date.parse(requestedExpiresAt)
  if (!Number.isFinite(requestedExpiry)) {
    throw new WorkItemImportError(
      'ImportSourceExpiryInvalid',
      'Import source expiry is invalid.',
    )
  }
  const storedExpiry = Date.parse(existing.Metadata?.['mukuroji-expires-at'] ?? '')
  const lifecycleExpiry = existing.LastModified
    ? existing.LastModified.getTime() + WORK_ITEM_IMPORT_SOURCE_RETENTION_DAYS * 24 * 60 * 60 * 1_000
    : Number.NaN
  if (!Number.isFinite(storedExpiry) || !Number.isFinite(lifecycleExpiry)) return undefined
  const actualExpiry = Math.min(storedExpiry, lifecycleExpiry)
  const minimumReusableExpiry = requestedExpiry -
    (WORK_ITEM_IMPORT_SOURCE_RETENTION_DAYS - WORK_ITEM_IMPORT_DLQ_RETENTION_DAYS) *
      24 * 60 * 60 * 1_000
  return actualExpiry >= minimumReusableExpiry
    ? new Date(actualExpiry).toISOString()
    : undefined
}

function createExecutionRecordKey(jobId: string) {
  return `${executionRecordPrefix}${jobId}`
}

function createReceiptRecordKey(jobId: string, row: number) {
  return `${receiptRecordPrefix}${jobId}#${String(row).padStart(6, '0')}`
}

function toExecutionItem(execution: WorkItemImportExecution) {
  return {
    recordKey: createExecutionRecordKey(execution.jobId),
    entryType: 'work-item-import-execution',
    ...execution,
  }
}

function readExecutionItem(value: Record<string, unknown>): WorkItemImportExecution {
  const source = value.source as Partial<WorkItemImportSourceLocator> | undefined
  if (
    value.entryType !== 'work-item-import-execution' ||
    !isText(value.workspaceId) ||
    !isText(value.jobId) ||
    value.recordKey !== createExecutionRecordKey(value.jobId) ||
    !isText(value.createdByUserId) ||
    !isText(value.teamId) ||
    !(value.assignedProjectId === undefined || isText(value.assignedProjectId)) ||
    !(value.format === 'csv' || value.format === 'json') ||
    !Array.isArray(value.mapping) ||
    !isText(value.requestDigest) ||
    !isExecutionStatus(value.status) ||
    !Number.isSafeInteger(value.checkpointRow) ||
    (value.checkpointRow as number) < 0 ||
    typeof value.cancelRequested !== 'boolean' ||
    !isText(value.createdAt) ||
    !isText(value.updatedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !source ||
    !isText(source.bucketName) ||
    !isText(source.objectKey) ||
    !isText(source.objectVersionId) ||
    !isSha256(source.sha256) ||
    !Number.isSafeInteger(source.byteLength) ||
    !isText(source.expiresAt)
  ) {
    throw new WorkItemImportError('ImportExecutionInvalid', 'Stored import execution is invalid.')
  }
  return structuredClone(value) as WorkItemImportExecution
}

function readReceiptItem(value: Record<string, unknown>): WorkItemImportRowReceipt {
  if (
    value.entryType !== 'work-item-import-receipt' ||
    !isText(value.jobId) ||
    !Number.isSafeInteger(value.row) ||
    (value.row as number) <= 0 ||
    !isSha256(value.requestDigest) ||
    !isText(value.idempotencyKey) ||
    !isText(value.completedAt)
  ) {
    throw new WorkItemImportError('ImportRowReceiptInvalid', 'Stored import row receipt is invalid.')
  }
  return {
    jobId: value.jobId,
    row: value.row as number,
    requestDigest: value.requestDigest,
    idempotencyKey: value.idempotencyKey,
    completedAt: value.completedAt,
  }
}

function assertExpectedLocator(
  locator: WorkItemImportSourceLocator,
  expected: WorkItemImportSourceOwner,
  bucketName: string,
) {
  const expectedObjectKey = createSourceObjectKey({
    workspaceId: expected.workspaceId,
    jobId: expected.jobId,
    content: '',
    sha256: locator.sha256,
    byteLength: locator.byteLength,
    expiresAt: locator.expiresAt,
  })
  if (locator.bucketName !== bucketName || locator.objectKey !== expectedObjectKey) {
    throw new WorkItemImportError(
      'ImportSourceLocatorInvalid',
      'Import source locator does not belong to the expected tenant and job.',
    )
  }
}

function isExecutionStatus(value: unknown): value is WorkItemImportExecutionStatus {
  return value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
}

function isTerminal(value: WorkItemImportExecutionStatus) {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
}

function isConditionalFailure(error: unknown) {
  const name = readErrorName(error)
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException'
}

function isPreconditionFailure(error: unknown) {
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return candidate?.name === 'PreconditionFailed' || candidate?.$metadata?.httpStatusCode === 412
}

function readErrorName(error: unknown) {
  return error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
    ? error.name
    : undefined
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function requireText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized) throw new WorkItemImportError('ImportConfigurationInvalid', `${label} is required.`)
  return normalized
}

function readEnvironment(name: string) {
  return process.env[name]?.trim() || undefined
}
