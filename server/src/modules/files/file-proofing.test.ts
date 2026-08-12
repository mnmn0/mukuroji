import { describe, expect, test } from 'bun:test'
import {
  GetObjectAttributesCommand,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { createMutationAuditContext } from '../audit/audit'
import {
  DynamoDbFileProofingClient,
  FILE_UPLOAD_MAX_SIZE_BYTES,
  FileProofingError,
  S3FileObjectClient,
  createApprovalSummary,
  createFileProofingScopeKey,
  mapGuardDutyScanStatus,
  type FileObjectClient,
  type FileApprovalCompletionTransitionResolver,
  type FileProofingActor,
  type FileProofingScope,
  type PresignedPutUpload,
  type VerifiedFileObject,
} from './file-proofing'

/** Test で DynamoDB command を保存する最小 DocumentClient です。 */
class MemoryDocumentClient {
  /** `scopeKey` / `recordKey` で保持する item map です。 */
  readonly items = new Map<string, Record<string, unknown>>()

  /** DynamoDB pagination を再現する任意 page size です。 */
  queryPageSize?: number

  /** 次の transaction request で返す任意 error です。 */
  nextTransactionError?: Error

  /** 実行した transaction request です。 */
  readonly transactionInputs: TransactWriteCommandInput[] = []

  /** 実行した scope query の record key prefixes です。 */
  readonly queryPrefixes: Array<string | undefined> = []

  async send(command: unknown) {
    if (command instanceof BatchGetCommand) {
      const requestItems = command.input.RequestItems
      if (!requestItems) {
        throw new Error('BatchGetCommand requires request items.')
      }
      const responses = Object.fromEntries(Object.entries(requestItems).map(
        ([tableName, request]) => {
          if (!request.Keys) {
            throw new Error(`BatchGetCommand requires keys for ${tableName}.`)
          }
          return [tableName, request.Keys.flatMap((key) => {
            const item = this.items.get(createMemoryKey(key as Record<string, unknown>))
            return item ? [item] : []
          })]
        },
      ))
      return { Responses: responses }
    }
    if (command instanceof GetCommand) {
      const input = command.input
      return { Item: this.items.get(createMemoryKey(input.Key as Record<string, unknown>)) }
    }
    if (command instanceof QueryCommand) {
      const input = command.input
      const values = input.ExpressionAttributeValues as Record<string, string>
      const scopeKey = values[':scopeKey']
      const prefix = values[':recordPrefix']
      this.queryPrefixes.push(prefix)
      const matchingItems = [...this.items.values()].filter((item) =>
        item.scopeKey === scopeKey &&
        (!prefix || String(item.recordKey).startsWith(prefix))
      )
      const exclusiveKey = input.ExclusiveStartKey as Record<string, unknown> | undefined
      const startIndex = exclusiveKey
        ? matchingItems.findIndex((item) => createMemoryKey(item) === createMemoryKey(exclusiveKey)) + 1
        : 0
      const pageSize = this.queryPageSize ?? input.Limit ?? matchingItems.length
      const items = matchingItems.slice(startIndex, startIndex + pageSize)
      const hasMore = startIndex + items.length < matchingItems.length
      return {
        Items: items,
        ...(hasMore && items.length > 0
          ? {
              LastEvaluatedKey: {
                scopeKey: items.at(-1)!.scopeKey,
                recordKey: items.at(-1)!.recordKey,
              },
            }
          : {}),
      }
    }
    if (command instanceof PutCommand) {
      const input = command.input
      const item = input.Item as Record<string, unknown>
      this.assertCondition(item, input.ConditionExpression, input.ExpressionAttributeValues)
      this.items.set(createMemoryKey(item), structuredClone(item))
      return {}
    }
    if (command instanceof UpdateCommand) {
      const input = command.input
      const key = createMemoryKey(input.Key as Record<string, unknown>)
      const existing = this.items.get(key)
      if (!existing) {
        throw Object.assign(new Error('Conditional update failed.'), {
          name: 'ConditionalCheckFailedException',
        })
      }
      const values = input.ExpressionAttributeValues as Record<string, unknown>
      this.items.set(key, {
        ...existing,
        expiresAt: values[':expiresAt'],
        retentionUntil: values[':retentionUntil'],
      })
      return {}
    }
    if (command instanceof TransactWriteCommand) {
      this.transactionInputs.push(command.input)
      if (this.nextTransactionError) {
        const error = this.nextTransactionError
        this.nextTransactionError = undefined
        throw error
      }
      const puts = (command.input.TransactItems ?? []).flatMap((entry) => entry.Put ? [entry.Put] : [])
      const updates = (command.input.TransactItems ?? [])
        .flatMap((entry) => entry.Update ? [entry.Update] : [])
      const conditionChecks = (command.input.TransactItems ?? [])
        .flatMap((entry) => entry.ConditionCheck ? [entry.ConditionCheck] : [])
      for (const put of puts) {
        this.assertCondition(
          put.Item as Record<string, unknown>,
          put.ConditionExpression,
          put.ExpressionAttributeValues,
        )
      }
      for (const check of conditionChecks) {
        this.assertCondition(
          check.Key as Record<string, unknown>,
          check.ConditionExpression,
          check.ExpressionAttributeValues,
        )
      }
      for (const update of updates) {
        const existing = this.items.get(createMemoryKey(update.Key as Record<string, unknown>))
        const values = update.ExpressionAttributeValues as Record<string, unknown>
        const expressions = `${update.UpdateExpression ?? ''} ${update.ConditionExpression ?? ''}`
        for (const token of Object.keys(values)) {
          if (!expressions.includes(token)) {
            throw new Error(`Unused DynamoDB expression value: ${token}`)
          }
        }
        if (values[':pendingDelta'] !== undefined) {
          if (Number(values[':pendingDelta']) < 0 && Number(existing?.pendingCount ?? 0) < 1) {
            throw createTransactionCancelledError()
          }
          continue
        }
        if (values[':entryType'] === 'approval-summary') {
          if (
            existing?.entryType !== 'approval-summary' ||
            Number(existing.pendingCount ?? 0) < 1
          ) {
            throw createTransactionCancelledError()
          }
          continue
        }
        const expectedRevision = values[':expectedRevision'] ?? values[':fileRevision']
        const actualRevision = existing?.revision
        if (!existing || actualRevision !== expectedRevision) {
          throw createTransactionCancelledError()
        }
        this.assertCondition(
          update.Key as Record<string, unknown>,
          update.ConditionExpression,
          values,
        )
      }
      for (const put of puts) {
        const item = put.Item as Record<string, unknown>
        this.items.set(createMemoryKey(item), structuredClone(item))
      }
      for (const update of updates) {
        const key = createMemoryKey(update.Key as Record<string, unknown>)
        const existing = this.items.get(key)
        const values = update.ExpressionAttributeValues as Record<string, unknown>
        if (values[':pendingDelta'] !== undefined) {
          const dueAt = [...values[':dueAtSet'] as Set<string>][0]!
          const pendingDueAt = new Set(existing?.pendingDueAt as Set<string> | undefined)
          if (Number(values[':pendingDelta']) > 0) {
            pendingDueAt.add(dueAt)
          } else {
            pendingDueAt.delete(dueAt)
          }
          this.items.set(key, {
            ...update.Key as Record<string, unknown>,
            ...existing,
            entryType: 'approval-summary',
            pendingCount: Number(existing?.pendingCount ?? 0) + Number(values[':pendingDelta']),
            approvedCount: Number(existing?.approvedCount ?? 0) + Number(values[':approvedDelta']),
            rejectedCount: Number(existing?.rejectedCount ?? 0) + Number(values[':rejectedDelta']),
            changesRequestedCount: Number(existing?.changesRequestedCount ?? 0) +
              Number(values[':changesDelta']),
            pendingDueAt,
            updatedAt: values[':updatedAt'],
          })
          continue
        }
        if (values[':entryType'] === 'approval-summary') {
          this.items.set(key, {
            ...existing!,
            updatedAt: values[':updatedAt'],
          })
          continue
        }
        this.items.set(key, values[':delta'] === undefined
          ? {
              ...existing!,
              workflowSchemaVersion: values[':workflowSchemaVersion'],
              workflowStatusId: values[':workflowStatusId'],
              statusCategory: values[':statusCategory'],
              updatedAt: values[':updatedAt'],
              revision: Number(existing!.revision) + 1,
            }
          : {
              ...existing!,
              pendingApprovalCount: Number(existing!.pendingApprovalCount ?? 0) +
                Number(values[':delta']),
              updatedAt: values[':updatedAt'],
              revision: Number(existing!.revision) + 1,
            })
      }
      return {}
    }
    throw new Error(`Unsupported command: ${String(command)}`)
  }

  private assertCondition(
    item: Record<string, unknown>,
    condition: string | undefined,
    values: Record<string, unknown> | undefined,
  ) {
    if (!condition) {
      return
    }
    const existing = this.items.get(createMemoryKey(item))
    if ((condition.includes('attribute_not_exists(scopeKey)') ||
      condition.includes('attribute_not_exists(#directoryId)')) && existing) {
      throw createTransactionCancelledError()
    }
    if (condition.includes('currentVersionId') &&
      existing?.currentVersionId !==
        (values?.[':expectedCurrentVersionId'] ?? values?.[':versionId'])) {
      throw createTransactionCancelledError()
    }
    if (condition.includes('revision')) {
      const expectedRevision = values?.[':expectedRevision'] ??
        values?.[':fileRevision'] ??
        values?.[':revision']
      const actualRevision = existing?.revision
      if (actualRevision !== expectedRevision) {
        throw createTransactionCancelledError()
      }
    }
    if (condition.includes('attribute_not_exists(#deletedAt)') && existing?.deletedAt) {
      throw createTransactionCancelledError()
    }
    if (condition.includes('#pending >= :one') && Number(existing?.pendingApprovalCount ?? 0) < 1) {
      throw createTransactionCancelledError()
    }
    if (
      condition.includes('#pendingApprovalCount = :expectedPendingApprovalCount') &&
      Number(existing?.pendingApprovalCount ?? 0) !==
        Number(values?.[':expectedPendingApprovalCount'])
    ) {
      throw createTransactionCancelledError()
    }
  }
}

/** Test 用 object storage adapter です。 */
class FakeFileObjectClient implements FileObjectClient {
  /** Object key ごとの metadata です。 */
  readonly objects = new Map<string, VerifiedFileObject>()

  /** 最後に署名した object key です。 */
  lastObjectKey?: string

  /** Verify 中の競合を再現する hook です。 */
  beforeVerify?: () => Promise<void>

  /** 検証した object key 一覧です。 */
  readonly verifiedObjectKeys: string[] = []

  /** 最後に access URL へ固定した immutable object version ID です。 */
  lastAccessObjectVersionId?: string

  /** 最後に scan status を読んだ immutable object version ID です。 */
  lastScanStatusObjectVersionId?: string

  /** Abandoned upload lifecycle から除外した immutable object version ID 一覧です。 */
  readonly completedObjectVersionIds: string[] = []

  /** 次の completed tag 更新だけを失敗させる error です。 */
  markCompletedFailure?: Error

  /** Deleted quarantine tag 更新を試行した immutable object version ID 一覧です。 */
  readonly quarantineAttempts: string[] = []

  /** 成功した delete 操作の順序です。 */
  readonly deletionOperations: string[] = []

  /** 次の deleted quarantine tag 更新だけを失敗させる error です。 */
  quarantineDeletedFailure?: Error

  async createUpload(input: {
    objectKey: string
    contentType: string
    sizeBytes: number
  }): Promise<PresignedPutUpload> {
    this.lastObjectKey = input.objectKey
    this.objects.set(input.objectKey, {
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      scanStatus: 'scanning',
      objectVersionId: `object-version-${this.objects.size + 1}`,
    })
    return {
      url: `https://objects.example.test/${encodeURIComponent(input.objectKey)}`,
      method: 'PUT',
      headers: {
        'content-type': input.contentType,
      },
      expiresAt: '2026-07-13T00:10:00.000Z',
      maxSizeBytes: FILE_UPLOAD_MAX_SIZE_BYTES,
    }
  }

  async verifyUpload(objectKey: string, _expected: { contentType: string; sizeBytes: number }) {
    const object = this.requireObject(objectKey)
    this.verifiedObjectKeys.push(objectKey)
    await this.beforeVerify?.()
    return object
  }

  async getScanStatus(objectKey: string, objectVersionId?: string) {
    this.lastScanStatusObjectVersionId = objectVersionId
    return this.requireObject(objectKey).scanStatus
  }

  async markCompleted(_objectKey: string, objectVersionId?: string) {
    if (this.markCompletedFailure) {
      const failure = this.markCompletedFailure
      this.markCompletedFailure = undefined
      throw failure
    }
    if (objectVersionId) {
      this.completedObjectVersionIds.push(objectVersionId)
    }
  }

  async createAccess(input: {
    objectKey: string
    objectVersionId?: string
    fileName: string
    disposition: 'inline' | 'attachment'
  }) {
    this.lastAccessObjectVersionId = input.objectVersionId
    if (this.requireObject(input.objectKey).scanStatus !== 'available') {
      throw new FileProofingError(423, 'FileScanPending', 'File scan is pending.')
    }
    return {
      url: `https://objects.example.test/read/${encodeURIComponent(input.objectKey)}?disposition=${input.disposition}`,
      expiresAt: '2026-07-13T00:05:00.000Z',
    }
  }

  async quarantineDeletedVersion(objectKey: string, objectVersionId: string) {
    this.quarantineAttempts.push(objectVersionId)
    if (this.quarantineDeletedFailure) {
      const failure = this.quarantineDeletedFailure
      this.quarantineDeletedFailure = undefined
      throw failure
    }
    this.requireObject(objectKey)
    this.deletionOperations.push(`quarantine:${objectVersionId}`)
  }

  async softDelete(objectKey: string) {
    this.deletionOperations.push(`soft-delete:${objectKey}`)
    this.objects.delete(objectKey)
  }

  private requireObject(objectKey: string) {
    const object = this.objects.get(objectKey)
    if (!object) {
      throw new Error(`Object ${objectKey} was not uploaded.`)
    }
    return object
  }
}

const scope: FileProofingScope = {
  workspaceId: 'workspace-1',
  teamId: 'core',
  kind: 'work-item',
  issueId: 'work-item-1',
}

const manager: FileProofingActor = {
  memberKey: 'manager@example.com',
  guest: false,
  canWrite: true,
  canManage: true,
}

function createClient(workItemsTableName?: string, auditTableName?: string) {
  const documentClient = new MemoryDocumentClient()
  const objectClient = new FakeFileObjectClient()
  const client = new DynamoDbFileProofingClient(
    documentClient as unknown as DynamoDBDocumentClient,
    'file-proofing',
    objectClient,
    { auditTableName, workItemsTableName },
  )
  return { client, documentClient, objectClient }
}

function createAuditContext(
  idempotencyKey: string,
  body: Readonly<Record<string, unknown>> = { idempotencyKey },
  occurredAt = '2026-07-13T00:00:00.000Z',
) {
  return createMutationAuditContext({
    workspaceId: scope.workspaceId,
    actor: { id: manager.memberKey, kind: 'user' },
    idempotencyKey,
    request: { method: 'POST', path: '/api/files', body },
    source: { kind: 'api', route: '/api/files' },
    occurredAt,
  })
}

async function createAvailableFile() {
  const state = createClient()
  const session = await state.client.createUpload(
    scope,
    manager,
    { contentType: 'image/png', fileName: 'review.png', sizeBytes: 1024 },
    createAuditContext('create-file'),
  )
  const objectKey = state.objectClient.lastObjectKey!
  state.objectClient.objects.set(objectKey, {
    contentType: 'image/png',
    objectVersionId: 'immutable-object-version-1',
    sizeBytes: 1024,
    scanStatus: 'available',
  })
  await state.client.completeUpload(
    scope,
    manager,
    session.file.id,
    session.version.id,
    createAuditContext('complete-file'),
  )
  return { ...state, session }
}

describe('file proofing domain', () => {
  test('signs upload length and media type so object metadata cannot bypass validation', async () => {
    const client = new S3FileObjectClient(
      new S3Client({
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        region: 'us-east-1',
        requestChecksumCalculation: 'WHEN_REQUIRED',
      }),
      'mukuroji-files-test',
    )
    const upload = await client.createUpload({
      contentType: 'image/png',
      objectKey: 'workspaces/workspace-1/files/file-1/version-1/proof.png',
      sizeBytes: 1024,
    })
    const url = new URL(upload.url)
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')

    expect(signedHeaders?.split(';')).toContain('content-length')
    expect(signedHeaders?.split(';')).toContain('content-type')
    expect(signedHeaders?.split(';')).toContain('if-none-match')
    expect(signedHeaders?.split(';')).toContain('x-amz-tagging')
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBeFalse()
    expect(url.searchParams.has('x-amz-tagging')).toBeFalse()
    expect(upload.headers['content-type']).toBe('image/png')
    expect(upload.headers['if-none-match']).toBe('*')
  })

  test('pins verified scan and access operations to one immutable S3 version', async () => {
    const sentCommands: unknown[] = []
    const s3Client = new S3Client({
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      region: 'us-east-1',
      requestChecksumCalculation: 'WHEN_REQUIRED',
    })
    ;(s3Client as unknown as { send(command: unknown): Promise<Record<string, unknown>> }).send =
      async (command) => {
        sentCommands.push(command)
        if (command instanceof GetObjectAttributesCommand) {
          return { ObjectSize: 1024, VersionId: 'immutable-s3-version-1' }
        }
        if (command instanceof GetObjectTaggingCommand) {
          return {
            TagSet: [
              { Key: 'mukuroji-upload', Value: 'pending' },
              { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
            ],
          }
        }
        if (command instanceof PutObjectTaggingCommand) {
          return {}
        }
        throw new Error('Unexpected S3 command.')
      }
    const client = new S3FileObjectClient(s3Client, 'mukuroji-files-test')
    const objectKey = 'workspaces/workspace-1/files/file-1/version-1/proof.png'

    const verified = await client.verifyUpload(objectKey, {
      contentType: 'image/png',
      sizeBytes: 1024,
    })
    await client.markCompleted(objectKey, verified.objectVersionId)
    const access = await client.createAccess({
      objectKey,
      objectVersionId: verified.objectVersionId,
      fileName: 'proof.png',
      disposition: 'inline',
    })

    expect(verified).toMatchObject({
      objectVersionId: 'immutable-s3-version-1',
      scanStatus: 'available',
    })
    expect(new URL(access.url).searchParams.get('versionId')).toBe('immutable-s3-version-1')
    const versionedTagReads = sentCommands.filter((command) =>
      command instanceof GetObjectTaggingCommand &&
      command.input.VersionId === 'immutable-s3-version-1'
    )
    expect(versionedTagReads).toHaveLength(3)
    const completion = sentCommands.find((command) => command instanceof PutObjectTaggingCommand)
    expect(completion).toBeInstanceOf(PutObjectTaggingCommand)
    expect((completion as PutObjectTaggingCommand).input).toMatchObject({
      VersionId: 'immutable-s3-version-1',
      Tagging: {
        TagSet: [
          { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
          { Key: 'mukuroji-upload', Value: 'completed' },
        ],
      },
    })
  })

  test('quarantines the exact immutable S3 version while preserving existing tags', async () => {
    const sentCommands: unknown[] = []
    const s3Client = new S3Client({
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      region: 'us-east-1',
      requestChecksumCalculation: 'WHEN_REQUIRED',
    })
    ;(s3Client as unknown as { send(command: unknown): Promise<Record<string, unknown>> }).send =
      async (command) => {
        sentCommands.push(command)
        if (command instanceof GetObjectTaggingCommand) {
          return {
            TagSet: [
              { Key: 'mukuroji-upload', Value: 'completed' },
              { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
            ],
          }
        }
        if (command instanceof PutObjectTaggingCommand) {
          return {}
        }
        throw new Error('Unexpected S3 command.')
      }
    const client = new S3FileObjectClient(s3Client, 'mukuroji-files-test')

    await client.quarantineDeletedVersion(
      'workspaces/workspace-1/files/file-1/version-1/proof.png',
      'immutable-s3-version-1',
    )

    expect(sentCommands[0]).toBeInstanceOf(GetObjectTaggingCommand)
    expect((sentCommands[0] as GetObjectTaggingCommand).input.VersionId)
      .toBe('immutable-s3-version-1')
    expect(sentCommands[1]).toBeInstanceOf(PutObjectTaggingCommand)
    expect((sentCommands[1] as PutObjectTaggingCommand).input).toMatchObject({
      VersionId: 'immutable-s3-version-1',
      Tagging: {
        TagSet: [
          { Key: 'mukuroji-upload', Value: 'completed' },
          { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
          { Key: 'mukuroji-deleted', Value: 'true' },
        ],
      },
    })
  })

  test('treats only missing immutable versions as completed synchronous quarantine', async () => {
    const s3Client = new S3Client({
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      region: 'us-east-1',
      requestChecksumCalculation: 'WHEN_REQUIRED',
    })
    let failure = Object.assign(new Error('Object key is gone.'), { name: 'NoSuchKey' })
    ;(s3Client as unknown as { send(command: unknown): Promise<Record<string, unknown>> }).send =
      async () => {
        throw failure
      }
    const client = new S3FileObjectClient(s3Client, 'mukuroji-files-test')
    const quarantine = () => client.quarantineDeletedVersion(
      'workspaces/workspace-1/files/file-1/version-1/proof.png',
      'immutable-s3-version-1',
    )

    await expect(quarantine()).resolves.toBeUndefined()

    failure = Object.assign(new Error('Object version is gone.'), { name: 'NoSuchVersion' })
    await expect(quarantine()).resolves.toBeUndefined()

    failure = Object.assign(new Error('S3 is unavailable.'), { name: 'ServiceUnavailable' })
    await expect(quarantine()).rejects.toMatchObject({
      message: 'S3 is unavailable.',
      name: 'ServiceUnavailable',
    })
  })

  test('maps GuardDuty tags without treating missing scans as clean', () => {
    expect(mapGuardDutyScanStatus(undefined)).toBe('scanning')
    expect(mapGuardDutyScanStatus([{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }]))
      .toBe('available')
    expect(mapGuardDutyScanStatus([{ Key: 'GuardDutyMalwareScanStatus', Value: 'THREATS_FOUND' }]))
      .toBe('blocked')
    expect(mapGuardDutyScanStatus([{ Key: 'GuardDutyMalwareScanStatus', Value: 'FAILED' }]))
      .toBe('failed')
  })

  test('creates an idempotent direct upload session outside the API body', async () => {
    const { client } = createClient()
    const audit = createAuditContext('same-upload')
    const first = await client.createUpload(
      scope,
      manager,
      { contentType: 'application/pdf', fileName: '../proof.pdf', sizeBytes: 4096 },
      audit,
    )
    const retry = await client.createUpload(
      scope,
      manager,
      { contentType: 'application/pdf', fileName: '../proof.pdf', sizeBytes: 4096 },
      audit,
    )

    expect(first.file.id).toBe(retry.file.id)
    expect(first.version.id).toBe(retry.version.id)
    expect(first.file.name).toBe('proof.pdf')
    expect(first.upload.method).toBe('PUT')
    expect(first.upload.url).toStartWith('https://objects.example.test/')
    expect(first.version.scanStatus).toBe('pending')
  })

  test('does not expose a clean object before upload completion pins its S3 version', async () => {
    const { client, objectClient } = createClient()
    const session = await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'unverified.png', sizeBytes: 10 },
      createAuditContext('unverified-upload'),
    )
    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'image/png',
      objectVersionId: 'unverified-object-version-1',
      sizeBytes: 10,
      scanStatus: 'available',
    })

    const listed = await client.list(scope, manager)
    expect(listed.files[0]?.currentVersion.scanStatus).toBe('pending')
    expect(objectClient.completedObjectVersionIds).toEqual([])
    await expect(client.createAccess(
      scope,
      manager,
      session.file.id,
      session.version.id,
      'inline',
    )).rejects.toMatchObject({ code: 'FileUploadIncomplete', status: 423 })
  })

  test('keeps a durable scanning repair state when completed tag persistence fails', async () => {
    const { client, documentClient, objectClient } = createClient()
    const session = await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'repair.png', sizeBytes: 12 },
      createAuditContext('repair-upload'),
    )
    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'image/png',
      objectVersionId: 'immutable-repair-version-1',
      sizeBytes: 12,
      scanStatus: 'available',
    })
    objectClient.markCompletedFailure = new Error('Transient object tagging failure.')

    await expect(client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('repair-complete'),
    )).rejects.toThrow('Transient object tagging failure.')
    const stored = [...documentClient.items.values()].find((item) =>
      item.entryType === 'file' && item.fileId === session.file.id
    )
    expect(stored?.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: session.version.id,
        objectVersionId: 'immutable-repair-version-1',
        scanStatus: 'scanning',
      }),
    ]))

    objectClient.markCompletedFailure = new Error('Second transient object tagging failure.')
    const deferred = await client.list(scope, manager)
    expect(deferred.files[0]?.currentVersion.scanStatus).toBe('scanning')

    const repaired = await client.list(scope, manager)
    expect(repaired.files[0]?.currentVersion.scanStatus).toBe('available')
    expect(objectClient.completedObjectVersionIds).toContain('immutable-repair-version-1')
  })

  test('returns a completed upload idempotently without re-verifying or duplicating audit', async () => {
    const { client, documentClient, objectClient } = createClient(undefined, 'audit-events')
    const session = await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'idempotent.png', sizeBytes: 12 },
      createAuditContext('idempotent-complete-upload'),
    )
    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'image/png',
      objectVersionId: 'immutable-idempotent-version-1',
      sizeBytes: 12,
      scanStatus: 'available',
    })

    const first = await client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('idempotent-complete-first'),
    )
    const retry = await client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('idempotent-complete-retry'),
    )

    expect(retry).toEqual(first)
    expect(objectClient.verifiedObjectKeys).toHaveLength(1)
    expect([...documentClient.items.values()].filter((item) =>
      item.eventType === 'file.upload-completed'
    )).toHaveLength(1)
  })

  test('rejects reusing one idempotency key with a different upload payload', async () => {
    const { client } = createClient()
    await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'first.png', sizeBytes: 10 },
      createAuditContext('reused-upload', { fileName: 'first.png', sizeBytes: 10 }),
    )

    await expect(client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'second.png', sizeBytes: 20 },
      createAuditContext('reused-upload', { fileName: 'second.png', sizeBytes: 20 }),
    )).rejects.toMatchObject({ code: 'IdempotencyKeyReused', status: 409 })
  })

  test('does not misclassify non-conditional transaction cancellation as a conflict', async () => {
    const { client, documentClient } = createClient()
    const throttled = createTransactionCancelledError([{ Code: 'ProvisionedThroughputExceeded' }])
    documentClient.nextTransactionError = throttled

    await expect(client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'throttled.png', sizeBytes: 10 },
      createAuditContext('throttled-upload'),
    )).rejects.toMatchObject({
      message: 'Conditional transaction failed.',
      name: 'TransactionCanceledException',
    })

    documentClient.nextTransactionError = createTransactionCancelledError([
      { Code: 'ConditionalCheckFailed' },
      { Code: 'ProvisionedThroughputExceeded' },
    ])
    await expect(client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'mixed-failure.png', sizeBytes: 10 },
      createAuditContext('mixed-failure-upload'),
    )).rejects.toMatchObject({
      message: 'Conditional transaction failed.',
      name: 'TransactionCanceledException',
    })
  })

  test('reads every DynamoDB page in a file scope', async () => {
    const { client, documentClient } = createClient()
    await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'first.png', sizeBytes: 10 },
      createAuditContext('page-one'),
    )
    await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'second.png', sizeBytes: 10 },
      createAuditContext('page-two'),
    )
    documentClient.queryPageSize = 1
    documentClient.queryPrefixes.length = 0

    expect((await client.list(scope, manager)).files).toHaveLength(2)
    expect([...documentClient.queryPrefixes].sort()).toEqual([
      'APPROVAL#',
      'FILE#',
      'FILE#',
    ])
  })

  test('rejects unsupported or oversized upload metadata before signing', async () => {
    const { client } = createClient()
    await expect(client.createUpload(
      scope,
      manager,
      { contentType: 'application/x-msdownload', fileName: 'malware.exe', sizeBytes: 100 },
    )).rejects.toMatchObject({ code: 'FileTypeNotAllowed', status: 415 })
    await expect(client.createUpload(
      scope,
      manager,
      {
        contentType: 'application/pdf',
        fileName: 'huge.pdf',
        sizeBytes: FILE_UPLOAD_MAX_SIZE_BYTES + 1,
      },
    )).rejects.toMatchObject({ code: 'FileTooLarge', status: 413 })
  })

  test('allows access only after a clean scan and records version replacement', async () => {
    const { client, objectClient, session } = await createAvailableFile()
    const access = await client.createAccess(
      scope,
      manager,
      session.file.id,
      session.version.id,
      'inline',
      createAuditContext('download-file'),
    )
    expect(access.url).toContain('disposition=inline')
    expect(objectClient.lastAccessObjectVersionId).toBe('immutable-object-version-1')
    expect(objectClient.completedObjectVersionIds).toContain('immutable-object-version-1')

    const replacement = await client.createVersionUpload(
      scope,
      manager,
      session.file.id,
      { contentType: 'image/png', fileName: 'review-v2.png', sizeBytes: 2048 },
      createAuditContext('replace-file'),
    )
    expect(replacement.version.number).toBe(2)
    expect(replacement.file.versionCount).toBe(2)
    expect(replacement.file.currentVersion.id).toBe(session.version.id)

    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'image/png',
      objectVersionId: 'immutable-object-version-2',
      sizeBytes: 2048,
      scanStatus: 'blocked',
    })
    const completed = await client.completeUpload(
      scope,
      manager,
      replacement.file.id,
      replacement.version.id,
      createAuditContext('complete-blocked'),
    )
    expect(completed.version.scanStatus).toBe('blocked')
    expect(completed.file.currentVersion.id).toBe(replacement.version.id)
    await expect(client.createAccess(
      scope,
      manager,
      replacement.file.id,
      replacement.version.id,
      'attachment',
    )).rejects.toMatchObject({ code: 'FileThreatDetected', status: 423 })
  })

  test('does not promote a replacement session while the current version has an approval', async () => {
    const { client, objectClient, session } = await createAvailableFile()
    const replacement = await client.createVersionUpload(
      scope,
      manager,
      session.file.id,
      { contentType: 'image/png', fileName: 'pending-approval-v2.png', sizeBytes: 2048 },
      createAuditContext('pending-approval-replacement'),
    )
    const replacementObjectKey = objectClient.lastObjectKey!
    objectClient.objects.set(replacementObjectKey, {
      contentType: 'image/png',
      objectVersionId: 'immutable-pending-approval-version-2',
      sizeBytes: 2048,
      scanStatus: 'available',
    })
    const approval = await client.createApproval(
      scope,
      manager,
      {
        fileId: session.file.id,
        versionId: session.version.id,
        reviewerMemberKeys: ['reviewer@example.com'],
        dueAt: '2099-07-20T00:00:00.000Z',
      },
      createAuditContext('pending-current-version-approval'),
    )

    await expect(client.completeUpload(
      scope,
      manager,
      session.file.id,
      replacement.version.id,
      createAuditContext('blocked-replacement-completion'),
    )).rejects.toMatchObject({ code: 'FileApprovalPending', status: 409 })
    expect(objectClient.verifiedObjectKeys).not.toContain(replacementObjectKey)
    const blockedFile = (await client.list(scope, manager)).files.find(
      (file) => file.id === session.file.id,
    )
    expect(blockedFile?.currentVersion.id).toBe(session.version.id)

    const decided = await client.decideApproval(
      scope,
      { memberKey: 'reviewer@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      { decision: 'approve', expectedRevision: approval.revision },
      createAuditContext('approve-current-version'),
    )
    expect(decided.status).toBe('approved')

    const completed = await client.completeUpload(
      scope,
      manager,
      session.file.id,
      replacement.version.id,
      createAuditContext('complete-replacement-after-approval'),
    )
    expect(completed.file.currentVersion.id).toBe(replacement.version.id)
  })

  test('keeps replacement promotion CAS-bound when an approval starts during verification', async () => {
    const { client, objectClient, session } = await createAvailableFile()
    const replacement = await client.createVersionUpload(
      scope,
      manager,
      session.file.id,
      { contentType: 'image/png', fileName: 'racing-approval-v2.png', sizeBytes: 2048 },
      createAuditContext('racing-approval-replacement'),
    )
    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'image/png',
      objectVersionId: 'immutable-racing-approval-version-2',
      sizeBytes: 2048,
      scanStatus: 'available',
    })
    objectClient.beforeVerify = async () => {
      objectClient.beforeVerify = undefined
      await client.createApproval(
        scope,
        manager,
        {
          fileId: session.file.id,
          versionId: session.version.id,
          reviewerMemberKeys: ['reviewer@example.com'],
          dueAt: '2099-07-20T00:00:00.000Z',
        },
        createAuditContext('racing-current-version-approval'),
      )
    }

    await expect(client.completeUpload(
      scope,
      manager,
      session.file.id,
      replacement.version.id,
      createAuditContext('racing-replacement-completion'),
    )).rejects.toMatchObject({ code: 'FileVersionConflict', status: 409 })
    const current = (await client.list(scope, manager)).files.find(
      (file) => file.id === session.file.id,
    )
    expect(current?.currentVersion.id).toBe(session.version.id)
    expect(current?.capabilities.canDelete).toBeFalse()
  })

  test('projects download access into the parent Work Item activity audit', async () => {
    const { client, documentClient, objectClient } = createClient(undefined, 'audit-events')
    const session = await client.createUpload(
      scope,
      manager,
      { contentType: 'application/pdf', fileName: 'history.pdf', sizeBytes: 64 },
      createAuditContext('history-file'),
    )
    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'application/pdf',
      objectVersionId: 'immutable-history-version-1',
      scanStatus: 'available',
      sizeBytes: 64,
    })
    await client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('history-complete'),
    )
    await client.createAccess(
      scope,
      manager,
      session.file.id,
      session.version.id,
      'attachment',
      createAuditContext('history-download'),
    )

    const event = [...documentClient.items.values()]
      .find((item) => item.eventType === 'file.download-accessed')
    expect(event).toMatchObject({
      entityId: 'team/core/issue/work-item-1',
      entityType: 'work-item',
      targetType: 'file',
    })
  })

  test('does not let a stale upload completion resurrect a concurrently deleted file', async () => {
    const { client, objectClient } = createClient()
    const session = await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'racing.png', sizeBytes: 32 },
      createAuditContext('racing-file'),
    )
    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'image/png',
      objectVersionId: 'immutable-racing-version-1',
      scanStatus: 'available',
      sizeBytes: 32,
    })
    objectClient.beforeVerify = async () => {
      objectClient.beforeVerify = undefined
      await client.deleteFile(scope, manager, session.file.id, createAuditContext('racing-delete'))
    }

    await expect(client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('racing-complete'),
    )).rejects.toMatchObject({ code: 'FileVersionConflict', status: 409 })
    expect((await client.list(scope, manager)).files).toEqual([])
    await expect(client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'racing.png', sizeBytes: 32 },
      createAuditContext('racing-file'),
    )).rejects.toMatchObject({ code: 'FileDeleted', status: 410 })
  })

  test('quarantines immutable versions before delete returns and retries after tag failure', async () => {
    const { client, objectClient, session } = await createAvailableFile()
    const objectKey = objectClient.lastObjectKey!
    objectClient.quarantineDeletedFailure = new Error('Deleted tag update failed.')

    await expect(client.deleteFile(
      scope,
      manager,
      session.file.id,
      createAuditContext('delete-tag-failure'),
    )).rejects.toThrow('Deleted tag update failed.')
    expect((await client.list(scope, manager)).files).toEqual([])
    expect(objectClient.objects.has(objectKey)).toBeTrue()
    expect(objectClient.quarantineAttempts).toEqual(['immutable-object-version-1'])
    expect(objectClient.deletionOperations).toEqual([])

    await client.deleteFile(scope, manager, session.file.id)
    expect(objectClient.quarantineAttempts).toEqual([
      'immutable-object-version-1',
      'immutable-object-version-1',
    ])
    expect(objectClient.deletionOperations).toEqual([
      'quarantine:immutable-object-version-1',
      `soft-delete:${objectKey}`,
    ])
  })

  test('keeps private files hidden from guests and honors explicit guest access', async () => {
    const { client } = createClient()
    await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'private.png', sizeBytes: 10 },
      createAuditContext('private-file'),
    )
    await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'guest.png', sizeBytes: 10, guestAccess: true },
      createAuditContext('guest-file'),
    )
    const guestFiles = await client.list(scope, {
      memberKey: 'guest@example.com',
      guest: true,
      canWrite: false,
      canManage: false,
    })
    expect(guestFiles.files.map((file) => file.name)).toEqual(['guest.png'])
  })

  test('hides Work Item approvals from guests while preserving shared File approvals', async () => {
    const { client, objectClient } = createClient()
    const session = await client.createUpload(
      scope,
      manager,
      {
        contentType: 'image/png',
        fileName: 'guest-approval.png',
        sizeBytes: 10,
        guestAccess: true,
      },
      createAuditContext('guest-approval-file'),
    )
    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'image/png',
      objectVersionId: 'immutable-guest-approval-version-1',
      scanStatus: 'available',
      sizeBytes: 10,
    })
    await client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('guest-approval-completion'),
    )
    const fileApproval = await client.createApproval(
      scope,
      manager,
      {
        dueAt: '2099-07-20T00:00:00.000Z',
        fileId: session.file.id,
        reviewerMemberKeys: ['guest@example.com'],
        versionId: session.version.id,
      },
      createAuditContext('guest-file-approval'),
    )
    const workItemApproval = await client.createWorkItemApproval(
      scope,
      manager,
      {
        dueAt: '2099-07-20T00:00:00.000Z',
        reviewerMemberKeys: ['guest@example.com'],
      },
      createAuditContext('guest-work-item-approval'),
    )

    const guestActor: FileProofingActor = {
      memberKey: 'guest@example.com',
      guest: true,
      canWrite: false,
      canManage: false,
    }
    const guestCollection = await client.list(scope, guestActor)

    expect(guestCollection.approvals).toEqual([
      expect.objectContaining({
        id: fileApproval.id,
        subjectType: 'file-version',
      }),
    ])
    expect(guestCollection.approvals.map((approval) => approval.id))
      .not.toContain(workItemApproval.id)
    const guestInbox = await client.listReviewerApprovals(scope.workspaceId, guestActor)
    expect(guestInbox.approvals).toEqual([
      expect.objectContaining({
        id: fileApproval.id,
        subjectType: 'file-version',
      }),
    ])
    expect(guestInbox.approvals.map((approval) => approval.id))
      .not.toContain(workItemApproval.id)
  })

  test('keeps a downgraded guest uploader from deleting its shared file', async () => {
    const { client } = createClient()
    const session = await client.createUpload(
      scope,
      manager,
      {
        contentType: 'image/png',
        fileName: 'downgraded-uploader.png',
        sizeBytes: 10,
        guestAccess: true,
      },
      createAuditContext('downgraded-uploader-file'),
    )
    const downgradedGuest: FileProofingActor = {
      memberKey: manager.memberKey,
      guest: true,
      canWrite: false,
      canManage: false,
    }

    const visibleFile = (await client.list(scope, downgradedGuest)).files.find(
      (file) => file.id === session.file.id,
    )
    expect(visibleFile?.capabilities.canDelete).toBeFalse()
    await expect(client.deleteFile(
      scope,
      downgradedGuest,
      session.file.id,
      createAuditContext('downgraded-uploader-delete'),
    )).rejects.toMatchObject({ code: 'FileDeleteDenied', status: 403 })
    expect((await client.list(scope, manager)).files.map((file) => file.id))
      .toContain(session.file.id)
  })

  test('persists positioned annotations only against the clean immutable object version', async () => {
    const { client, documentClient, objectClient, session } = await createAvailableFile()
    objectClient.lastScanStatusObjectVersionId = undefined
    const annotation = await client.createAnnotation(
      scope,
      manager,
      session.file.id,
      session.version.id,
      { anchor: { kind: 'image', x: 0.25, y: 0.75 }, bodyMarkdown: 'Check this pixel.' },
      createAuditContext('annotation'),
    )
    expect(annotation.anchor).toEqual({ kind: 'image', x: 0.25, y: 0.75 })
    expect<string | undefined>(
      objectClient.lastScanStatusObjectVersionId,
    ).toBe('immutable-object-version-1')
    expect(await client.listAnnotations(scope, manager, session.file.id, session.version.id))
      .toHaveLength(1)
    await expect(client.createAnnotation(
      scope,
      manager,
      session.file.id,
      session.version.id,
      { anchor: { kind: 'image', x: 2, y: 0 }, bodyMarkdown: 'Invalid.' },
    )).rejects.toMatchObject({ code: 'InvalidAnnotationAnchor', status: 400 })
    objectClient.objects.get(objectClient.lastObjectKey!)!.scanStatus = 'blocked'
    await expect(client.createAnnotation(
      scope,
      manager,
      session.file.id,
      session.version.id,
      { anchor: { kind: 'image', x: 0.5, y: 0.5 }, bodyMarkdown: 'Blocked.' },
    )).rejects.toMatchObject({ code: 'FileThreatDetected', status: 423 })
    await client.deleteFile(scope, manager, session.file.id, createAuditContext('delete-annotation-file'))
    await expect(client.listAnnotations(scope, manager, session.file.id, session.version.id))
      .rejects.toMatchObject({ code: 'FileDeleted', status: 410 })
    const storedAnnotation = [...documentClient.items.values()]
      .find((item) => item.entryType === 'annotation')
    expect(storedAnnotation?.expiresAt).toBeNumber()
  })

  test('rejects annotations before upload completion pins an immutable object version', async () => {
    const { client } = createClient()
    const session = await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'pending-annotation.png', sizeBytes: 10 },
      createAuditContext('pending-annotation-upload'),
    )

    await expect(client.createAnnotation(
      scope,
      manager,
      session.file.id,
      session.version.id,
      { anchor: { kind: 'image', x: 0.5, y: 0.5 }, bodyMarkdown: 'Not yet.' },
    )).rejects.toMatchObject({ code: 'FileUploadIncomplete', status: 423 })
  })

  test('aggregates reviewer decisions and exposes approval Inbox projections', async () => {
    const { client, documentClient, session } = await createAvailableFile()
    const approval = await client.createApproval(
      scope,
      manager,
      {
        fileId: session.file.id,
        versionId: session.version.id,
        reviewerMemberKeys: ['first@example.com', 'second@example.com'],
        dueAt: '2099-07-20T00:00:00.000Z',
      },
      createAuditContext('approval'),
    )
    expect([...documentClient.items.values()].find((item) =>
      item.entryType === 'file-approval-index' && item.approvalId === approval.id
    )).toMatchObject({
      fileId: session.file.id,
      dueAt: approval.dueAt,
      reviewerMemberKeys: ['first@example.com', 'second@example.com'],
      recordKey: `FILE_APPROVAL#${session.file.id}#${approval.id}`,
    })
    const pendingFile = (await client.list(scope, manager)).files.find(
      (file) => file.id === session.file.id,
    )
    expect(pendingFile?.capabilities).toMatchObject({
      canDelete: false,
      canUploadVersion: false,
    })
    await expect(client.createVersionUpload(
      scope,
      manager,
      session.file.id,
      { contentType: 'image/png', fileName: 'blocked-version.png', sizeBytes: 10 },
    )).rejects.toMatchObject({ code: 'FileApprovalPending', status: 409 })
    await expect(client.deleteFile(scope, manager, session.file.id))
      .rejects.toMatchObject({ code: 'FileApprovalPending', status: 409 })
    await expect(client.decideApproval(
      scope,
      { memberKey: 'first@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      { decision: 'approve', expectedRevision: approval.revision, comment: 'あ'.repeat(2_001) },
    )).rejects.toMatchObject({ code: 'InvalidFileProofingInput', status: 400 })
    await expect(client.decideApproval(
      scope,
      { memberKey: 'first@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      { decision: 'approve', expectedRevision: approval.revision, comment: 123 as unknown as string },
    )).rejects.toMatchObject({ code: 'InvalidFileProofingInput', status: 400 })
    const first = await client.decideApproval(
      scope,
      { memberKey: 'first@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      { decision: 'approve', expectedRevision: approval.revision },
      createAuditContext('first-decision', undefined, '2026-07-13T01:00:00.000Z'),
    )
    expect(first.status).toBe('pending')
    expect(await client.getApprovalSummary(scope)).toMatchObject({
      pendingCount: 1,
      updatedAt: '2026-07-13T01:00:00.000Z',
    })
    const second = await client.decideApproval(
      scope,
      { memberKey: 'second@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      { decision: 'approve', expectedRevision: first.revision },
      createAuditContext('second-decision', undefined, '2026-07-13T02:00:00.000Z'),
    )
    expect(second.status).toBe('approved')
    expect(await client.getApprovalSummary(scope)).toMatchObject({
      approvedCount: 1,
      pendingCount: 0,
      updatedAt: '2026-07-13T02:00:00.000Z',
    })
    expect((await client.listReviewerApprovals(scope.workspaceId, {
      memberKey: 'first@example.com',
      guest: false,
      canWrite: false,
      canManage: false,
    })).approvals).toEqual([])
    documentClient.queryPrefixes.length = 0
    await client.deleteFile(scope, manager, session.file.id, createAuditContext('delete-approved-file'))
    const reviewRows = [...documentClient.items.values()].filter((item) =>
      item.entryType === 'approval' ||
      item.entryType === 'file-approval-index' ||
      item.entryType === 'reviewer-approval'
    )
    expect(reviewRows).not.toHaveLength(0)
    expect(reviewRows.every((item) => typeof item.expiresAt === 'number')).toBeTrue()
    expect(documentClient.queryPrefixes).toEqual([
      `ANNOTATION#${session.file.id}#`,
      `FILE_APPROVAL#${session.file.id}#`,
    ])
  })

  test('lets the requester cancel a pending approval and unblock file changes', async () => {
    const { client, session } = await createAvailableFile()
    const approval = await client.createApproval(
      scope,
      manager,
      {
        fileId: session.file.id,
        versionId: session.version.id,
        reviewerMemberKeys: ['reviewer@example.com'],
        dueAt: '2099-07-20T00:00:00.000Z',
      },
      createAuditContext('cancel-approval'),
    )

    await expect(client.cancelApproval(
      scope,
      { memberKey: 'reviewer@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      { expectedRevision: approval.revision },
    )).rejects.toMatchObject({ code: 'ApprovalCancelDenied', status: 403 })

    const cancelled = await client.cancelApproval(
      scope,
      manager,
      approval.id,
      { expectedRevision: approval.revision },
      createAuditContext('cancel-approval-request'),
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.capabilities.canCancel).toBeFalse()
    expect(await client.getApprovalSummary(scope)).toMatchObject({ pendingCount: 0 })
    expect((await client.listReviewerApprovals(scope.workspaceId, {
      memberKey: 'reviewer@example.com',
      guest: false,
      canWrite: false,
      canManage: false,
    })).approvals).toEqual([])
    const unblockedFile = (await client.list(scope, manager)).files.find(
      (file) => file.id === session.file.id,
    )
    expect(unblockedFile?.capabilities).toMatchObject({
      canDelete: true,
      canUploadVersion: true,
    })

    const replacement = await client.createVersionUpload(
      scope,
      manager,
      session.file.id,
      { contentType: 'image/png', fileName: 'after-cancel.png', sizeBytes: 20 },
      createAuditContext('version-after-cancel'),
    )
    expect(replacement.version.number).toBe(2)
    await client.deleteFile(scope, manager, session.file.id, createAuditContext('delete-after-cancel'))
  })

  test('rejects invalid approval revisions consistently as domain input errors', async () => {
    const { client, session } = await createAvailableFile()
    const approval = await client.createApproval(
      scope,
      manager,
      {
        fileId: session.file.id,
        versionId: session.version.id,
        reviewerMemberKeys: ['reviewer@example.com'],
        dueAt: '2099-07-20T00:00:00.000Z',
      },
      createAuditContext('invalid-revision-approval'),
    )
    const reviewer = {
      memberKey: 'reviewer@example.com',
      guest: false,
      canWrite: false,
      canManage: false,
    }

    await expect(client.decideApproval(
      scope,
      reviewer,
      approval.id,
      { decision: 'approve', expectedRevision: 0 },
    )).rejects.toMatchObject({ code: 'InvalidFileProofingInput', status: 400 })
    await expect(client.cancelApproval(
      scope,
      manager,
      approval.id,
      { expectedRevision: -1 },
    )).rejects.toMatchObject({ code: 'InvalidFileProofingInput', status: 400 })
  })

  test('sets completedAt for rejected and changes-requested approval outcomes', async () => {
    const { client, session } = await createAvailableFile()
    const reviewer = {
      memberKey: 'reviewer@example.com',
      guest: false,
      canWrite: false,
      canManage: false,
    }
    const rejectedRequest = await client.createApproval(
      scope,
      manager,
      {
        fileId: session.file.id,
        versionId: session.version.id,
        reviewerMemberKeys: [reviewer.memberKey],
        dueAt: '2099-07-20T00:00:00.000Z',
      },
      createAuditContext('rejected-approval'),
    )
    const rejected = await client.decideApproval(
      scope,
      reviewer,
      rejectedRequest.id,
      { decision: 'reject', expectedRevision: rejectedRequest.revision },
      createAuditContext('reject-decision'),
    )
    expect(rejected).toMatchObject({
      completedAt: '2026-07-13T00:00:00.000Z',
      status: 'rejected',
    })

    const changesRequest = await client.createApproval(
      scope,
      manager,
      {
        fileId: session.file.id,
        versionId: session.version.id,
        reviewerMemberKeys: [reviewer.memberKey],
        dueAt: '2099-07-21T00:00:00.000Z',
      },
      createAuditContext('changes-requested-approval'),
    )
    const changesRequested = await client.decideApproval(
      scope,
      reviewer,
      changesRequest.id,
      { decision: 'request-changes', expectedRevision: changesRequest.revision },
      createAuditContext('request-changes-decision'),
    )
    expect(changesRequested).toMatchObject({
      completedAt: '2026-07-13T00:00:00.000Z',
      status: 'changes-requested',
    })
  })

  test('keeps duplicate due dates accurate and pages compact reviewer projections', async () => {
    const { client, documentClient, objectClient, session } = await createAvailableFile()
    const secondSession = await client.createUpload(
      scope,
      manager,
      { contentType: 'image/png', fileName: 'second-review.png', sizeBytes: 30 },
      createAuditContext('second-review-file'),
    )
    objectClient.objects.set(objectClient.lastObjectKey!, {
      contentType: 'image/png',
      objectVersionId: 'immutable-second-review-version-1',
      scanStatus: 'available',
      sizeBytes: 30,
    })
    await client.completeUpload(
      scope,
      manager,
      secondSession.file.id,
      secondSession.version.id,
      createAuditContext('second-review-complete'),
    )
    const dueAt = '2099-07-20T00:00:00.000Z'
    const first = await client.createApproval(
      scope,
      manager,
      {
        dueAt,
        fileId: session.file.id,
        reviewerMemberKeys: ['reviewer@example.com'],
        versionId: session.version.id,
      },
      createAuditContext('same-due-first'),
    )
    const second = await client.createApproval(
      scope,
      manager,
      {
        dueAt,
        fileId: secondSession.file.id,
        reviewerMemberKeys: ['reviewer@example.com'],
        versionId: secondSession.version.id,
      },
      createAuditContext('same-due-second'),
    )
    const compactProjection = [...documentClient.items.values()].find((item) =>
      item.entryType === 'reviewer-approval' && item.approvalId === first.id
    )
    expect(compactProjection).toMatchObject({
      approvalId: first.id,
      approvalStatus: 'pending',
      reviewerStatus: 'pending',
    })
    expect(compactProjection?.approval).toBeUndefined()

    expect(await client.getApprovalSummary(scope)).toMatchObject({
      nextDueAt: dueAt,
      pendingDueAt: [dueAt, dueAt],
      pendingCount: 2,
      updatedAt: expect.any(String),
    })
    const firstPage = await client.listReviewerApprovals(
      scope.workspaceId,
      { memberKey: 'reviewer@example.com', guest: false, canWrite: false, canManage: false },
      { limit: 1 },
    )
    expect(firstPage.approvals).toHaveLength(1)
    expect(firstPage.nextCursor).toBeString()
    const secondPage = await client.listReviewerApprovals(
      scope.workspaceId,
      { memberKey: 'reviewer@example.com', guest: false, canWrite: false, canManage: false },
      { cursor: firstPage.nextCursor, limit: 1 },
    )
    expect(secondPage.approvals).toHaveLength(1)
    expect(secondPage.approvals[0]?.id).not.toBe(firstPage.approvals[0]?.id)

    await client.cancelApproval(
      scope,
      manager,
      first.id,
      { expectedRevision: first.revision },
      createAuditContext('cancel-same-due-first'),
    )
    expect(await client.getApprovalSummary(scope)).toMatchObject({
      nextDueAt: dueAt,
      pendingDueAt: [dueAt],
      pendingCount: 1,
    })
    await client.cancelApproval(
      scope,
      manager,
      second.id,
      { expectedRevision: second.revision },
      createAuditContext('cancel-same-due-second'),
    )
    const summaries = await client.getApprovalSummaries([scope])
    expect(summaries.get(createFileProofingScopeKey(scope))).toMatchObject({
      pendingCount: 0,
      updatedAt: expect.any(String),
    })
    expect(summaries.get(createFileProofingScopeKey(scope))?.nextDueAt).toBeUndefined()
  })

  test('fails closed when a stored approval summary projection is malformed', async () => {
    const state = createClient()
    const scopeKey = createFileProofingScopeKey(scope)
    state.documentClient.items.set(createMemoryKey({
      scopeKey,
      recordKey: 'APPROVAL_SUMMARY',
    }), {
      scopeKey,
      recordKey: 'APPROVAL_SUMMARY',
      entryType: 'approval-summary',
      pendingCount: 1,
      approvedCount: -1,
      rejectedCount: 0,
      changesRequestedCount: 0,
      updatedAt: '2026-07-13T00:00:00.000Z',
    })

    await expect(state.client.getApprovalSummary(scope)).rejects.toMatchObject({
      code: 'ApprovalSummaryUnavailable',
      status: 503,
    })
    await expect(state.client.getApprovalSummaries([scope])).rejects.toMatchObject({
      code: 'ApprovalSummaryUnavailable',
      status: 503,
    })
  })

  test('fails closed when a stored approval summary contains an invalid due-date key', async () => {
    const state = createClient()
    const scopeKey = createFileProofingScopeKey(scope)
    state.documentClient.items.set(createMemoryKey({
      scopeKey,
      recordKey: 'APPROVAL_SUMMARY',
    }), {
      scopeKey,
      recordKey: 'APPROVAL_SUMMARY',
      entryType: 'approval-summary',
      pendingCount: 1,
      approvedCount: 0,
      rejectedCount: 0,
      changesRequestedCount: 0,
      pendingDueAt: new Set(['not-a-date#approval-1']),
      updatedAt: '2026-07-13T00:00:00.000Z',
    })

    await expect(state.client.getApprovalSummary(scope)).rejects.toMatchObject({
      code: 'ApprovalSummaryUnavailable',
      status: 503,
    })
  })

  test('creates one durable Work Item approval across retries and transitions after unanimous approval', async () => {
    const state = createClient('work-items', 'audit-events')
    const workItemKey = {
      directoryTeamId: 'workspace-1#team#core',
      issueId: 'work-item-1',
    }
    state.documentClient.items.set(createMemoryKey(workItemKey), {
      ...workItemKey,
      workflowSchemaVersion: 1,
      workflowStatusId: 'review-ready',
      statusCategory: 'started',
      revision: 4,
      updatedAt: '2026-07-12T00:00:00.000Z',
    })
    const automationActor: FileProofingActor = {
      memberKey: 'automation:rule-1',
      kind: 'service',
      guest: false,
      canWrite: true,
      canManage: true,
    }
    const auditContext = createMutationAuditContext({
      workspaceId: scope.workspaceId,
      actor: { id: automationActor.memberKey, kind: 'service' },
      idempotencyKey: 'execution-1:action-2',
      request: {
        method: 'POST',
        path: '/internal/automation/approval',
        body: {
          completionTransition: 'qa-approved',
          dueAt: '2026-07-14T00:00:00.000Z',
          reviewerMemberKeys: ['first@example.com', 'second@example.com'],
        },
      },
      source: { kind: 'system', route: 'approval' },
      occurredAt: '2026-07-13T00:00:00.000Z',
    })
    const input = {
      completionTransition: 'qa-approved',
      dueAt: '2026-07-14T00:00:00.000Z',
      reviewerMemberKeys: ['first@example.com', 'second@example.com'],
    }

    const created = await state.client.createWorkItemApproval(
      scope,
      automationActor,
      input,
      auditContext,
    )
    const itemCountAfterCreate = state.documentClient.items.size
    const replayed = await state.client.createWorkItemApproval(
      scope,
      automationActor,
      input,
      auditContext,
    )

    expect(created).toMatchObject({
      subjectType: 'work-item',
      requestedByKind: 'service',
      requestedByMemberKey: automationActor.memberKey,
      status: 'pending',
      revision: 1,
    })
    expect(created).not.toHaveProperty('fileId')
    expect(created).not.toHaveProperty('versionId')
    expect(replayed.id).toBe(created.id)
    expect(state.documentClient.items.size).toBe(itemCountAfterCreate)
    expect([...state.documentClient.items.values()].filter((item) =>
      item.entryType === 'approval' && item.id === created.id
    )).toHaveLength(1)
    expect([...state.documentClient.items.values()].filter((item) =>
      item.entryType === 'file-approval-index' && item.approvalId === created.id
    )).toHaveLength(0)
    expect([...state.documentClient.items.values()].filter((item) =>
      item.eventType === 'approval.requested' && item.targetId === created.id
    )).toHaveLength(1)
    expect(await state.client.getApprovalSummary(scope)).toMatchObject({
      pendingCount: 1,
      approvedCount: 0,
    })
    expect((await state.client.listReviewerApprovals(scope.workspaceId, {
      memberKey: 'first@example.com',
      guest: false,
      canWrite: false,
      canManage: false,
    })).approvals).toEqual([expect.objectContaining({
      id: created.id,
      subjectType: 'work-item',
    })])

    const firstDecision = await state.client.decideApproval(
      scope,
      { memberKey: 'first@example.com', guest: false, canWrite: false, canManage: false },
      created.id,
      { decision: 'approve', expectedRevision: created.revision },
      createAuditContext('work-item-first-decision'),
    )
    expect(firstDecision.status).toBe('pending')
    const completed = await state.client.decideApproval(
      scope,
      { memberKey: 'second@example.com', guest: false, canWrite: false, canManage: false },
      created.id,
      { decision: 'approve', expectedRevision: firstDecision.revision },
      createAuditContext('work-item-second-decision'),
      async (completionTransition) => ({
        workflowStatusId: completionTransition,
        statusCategory: 'completed',
        workflowSchemaVersion: 1,
        expectedRevision: 4,
        configurationConditionChecks: [{
          ConditionCheck: {
            TableName: 'work-item-configuration',
            Key: {
              scopeKey: 'workspace-1#team#core#work-item-configuration',
              recordKey: 'CONFIG',
            },
            ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          },
        }],
      }),
    )

    expect(completed.status).toBe('approved')
    expect(state.documentClient.items.get(createMemoryKey(workItemKey))).toMatchObject({
      revision: 5,
      workflowStatusId: 'qa-approved',
      statusCategory: 'completed',
    })
    expect(await state.client.getApprovalSummary(scope)).toMatchObject({
      pendingCount: 0,
      approvedCount: 1,
    })
    expect((await state.client.listReviewerApprovals(scope.workspaceId, {
      memberKey: 'second@example.com',
      guest: false,
      canWrite: false,
      canManage: false,
    })).approvals).toEqual([])
  })

  test('transitions the canonical Work Item with configuration guards when every reviewer approves', async () => {
    const state = createClient('work-items', 'audit-events')
    const workItemKey = {
      directoryTeamId: 'workspace-1#team#core',
      issueId: 'work-item-1',
    }
    state.documentClient.items.set(createMemoryKey(workItemKey), {
      ...workItemKey,
      workflowSchemaVersion: 1,
      workflowStatusId: 'review-ready',
      statusCategory: 'started',
      revision: 3,
      updatedAt: '2026-07-12T00:00:00.000Z',
    })
    const session = await state.client.createUpload(
      scope,
      manager,
      { contentType: 'application/pdf', fileName: 'approval.pdf', sizeBytes: 20 },
      createAuditContext('workflow-file'),
    )
    state.objectClient.objects.set(state.objectClient.lastObjectKey!, {
      contentType: 'application/pdf',
      objectVersionId: 'immutable-approval-version-1',
      sizeBytes: 20,
      scanStatus: 'available',
    })
    await state.client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('workflow-complete'),
    )
    const approval = await state.client.createApproval(
      scope,
      manager,
      {
        fileId: session.file.id,
        versionId: session.version.id,
        reviewerMemberKeys: ['reviewer@example.com'],
        dueAt: '2099-07-20T00:00:00.000Z',
        completionTransition: ' qa-approved ',
      },
      createAuditContext('workflow-approval'),
    )
    state.documentClient.items.set(createMemoryKey(workItemKey), {
      ...state.documentClient.items.get(createMemoryKey(workItemKey)),
      revision: 4,
      workflowStatusId: 'quality-review',
    })
    const resolverCalls: string[] = []
    const resolveCompletionTransition: FileApprovalCompletionTransitionResolver = async (
      completionTransition,
    ) => {
      resolverCalls.push(completionTransition)
      return {
        workflowStatusId: completionTransition,
        statusCategory: 'completed',
        workflowSchemaVersion: 1,
        expectedRevision: 4,
        configurationConditionChecks: [{
          ConditionCheck: {
            TableName: 'work-item-configuration',
            Key: {
              scopeKey: 'workspace-1#team#core#work-item-configuration',
              recordKey: 'CONFIG',
            },
            ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          },
        }],
      }
    }
    const completed = await state.client.decideApproval(
      scope,
      { memberKey: 'reviewer@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      { decision: 'approve', expectedRevision: 1 },
      createAuditContext('workflow-decision'),
      resolveCompletionTransition,
    )

    expect(completed.status).toBe('approved')
    expect(resolverCalls).toEqual(['qa-approved'])
    expect(state.documentClient.items.get(createMemoryKey(workItemKey))).toMatchObject({
      revision: 5,
      workflowSchemaVersion: 1,
      workflowStatusId: 'qa-approved',
      statusCategory: 'completed',
    })
    expect(state.documentClient.items.get(createMemoryKey(workItemKey))).not.toHaveProperty('status')
    const transaction = state.documentClient.transactionInputs.at(-1)?.TransactItems ?? []
    const workItemUpdate = transaction.find((entry) => entry.Update?.TableName === 'work-items')?.Update
    expect(workItemUpdate).toMatchObject({
      ConditionExpression: 'attribute_exists(issueId) AND revision = :expectedRevision',
      ExpressionAttributeValues: {
        ':expectedRevision': 4,
        ':statusCategory': 'completed',
        ':workflowSchemaVersion': 1,
        ':workflowStatusId': 'qa-approved',
      },
    })
    expect(workItemUpdate?.UpdateExpression).toContain('#workflowStatusId = :workflowStatusId')
    expect(workItemUpdate?.UpdateExpression).not.toContain('#status = :status')
    expect(transaction).toContainEqual(expect.objectContaining({
      ConditionCheck: expect.objectContaining({ TableName: 'work-item-configuration' }),
    }))
    const completionAudit = [...state.documentClient.items.values()].find(
      (item) => item.eventType === 'approval.completed',
    )
    expect(completionAudit?.metadata).toMatchObject({
      automation: {
        action: 'work-item.transition',
        workflowStatusId: 'qa-approved',
      },
    })
  })

  test('fails closed when an approval transition resolver is unavailable or cannot resolve the ID', async () => {
    const state = createClient('work-items')
    const session = await state.client.createUpload(
      scope,
      manager,
      { contentType: 'application/pdf', fileName: 'unresolved-approval.pdf', sizeBytes: 20 },
      createAuditContext('unresolved-workflow-file'),
    )
    state.objectClient.objects.set(state.objectClient.lastObjectKey!, {
      contentType: 'application/pdf',
      objectVersionId: 'immutable-unresolved-approval-version-1',
      sizeBytes: 20,
      scanStatus: 'available',
    })
    await state.client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('unresolved-workflow-complete'),
    )
    const approval = await state.client.createApproval(
      scope,
      manager,
      {
        completionTransition: 'qa-approved',
        dueAt: '2099-07-20T00:00:00.000Z',
        fileId: session.file.id,
        reviewerMemberKeys: ['reviewer@example.com'],
        versionId: session.version.id,
      },
      createAuditContext('unresolved-workflow-approval'),
    )

    const decisionInput = { decision: 'approve', expectedRevision: approval.revision } as const
    await expect(state.client.decideApproval(
      scope,
      { memberKey: 'reviewer@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      decisionInput,
      createAuditContext('missing-workflow-resolver'),
    )).rejects.toMatchObject({
      code: 'ApprovalCompletionTransitionUnavailable',
      status: 503,
    })
    const unresolved: FileApprovalCompletionTransitionResolver = async () => undefined
    await expect(state.client.decideApproval(
      scope,
      { memberKey: 'reviewer@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      decisionInput,
      createAuditContext('unresolved-workflow-transition'),
      unresolved,
    )).rejects.toMatchObject({
      code: 'ApprovalCompletionTransitionConflict',
      status: 409,
    })
    expect((await state.client.list(scope, manager)).approvals[0]?.status).toBe('pending')
  })

  test('rejects a completion transition when the Work Item has no strict revision', async () => {
    const state = createClient('work-items')
    const workItemKey = {
      directoryTeamId: 'workspace-1#team#core',
      issueId: 'work-item-1',
    }
    state.documentClient.items.set(createMemoryKey(workItemKey), {
      ...workItemKey,
      workflowSchemaVersion: 1,
      workflowStatusId: 'quality-review',
      statusCategory: 'started',
      updatedAt: '2026-07-12T00:00:00.000Z',
    })
    const session = await state.client.createUpload(
      scope,
      manager,
      { contentType: 'application/pdf', fileName: 'revisionless-approval.pdf', sizeBytes: 20 },
      createAuditContext('revisionless-workflow-file'),
    )
    state.objectClient.objects.set(state.objectClient.lastObjectKey!, {
      contentType: 'application/pdf',
      objectVersionId: 'immutable-revisionless-approval-version-1',
      sizeBytes: 20,
      scanStatus: 'available',
    })
    await state.client.completeUpload(
      scope,
      manager,
      session.file.id,
      session.version.id,
      createAuditContext('revisionless-workflow-complete'),
    )
    const approval = await state.client.createApproval(
      scope,
      manager,
      {
        completionTransition: 'qa-approved',
        dueAt: '2099-07-20T00:00:00.000Z',
        fileId: session.file.id,
        reviewerMemberKeys: ['reviewer@example.com'],
        versionId: session.version.id,
      },
      createAuditContext('revisionless-workflow-approval'),
    )
    const resolveCompletionTransition: FileApprovalCompletionTransitionResolver = async (
      completionTransition,
    ) => ({
      workflowStatusId: completionTransition,
      statusCategory: 'completed',
      workflowSchemaVersion: 1,
      expectedRevision: 1,
      configurationConditionChecks: [],
    })

    await expect(state.client.decideApproval(
      scope,
      { memberKey: 'reviewer@example.com', guest: false, canWrite: false, canManage: false },
      approval.id,
      { decision: 'approve', expectedRevision: approval.revision },
      createAuditContext('revisionless-workflow-decision'),
      resolveCompletionTransition,
    )).rejects.toMatchObject({
      code: 'ApprovalCompletionTransitionConflict',
      status: 409,
    })
    expect(state.documentClient.items.get(createMemoryKey(workItemKey))?.revision).toBeUndefined()
    expect((await state.client.list(scope, manager)).approvals[0]?.status).toBe('pending')
  })

  test('builds stable scope keys and approval summaries', () => {
    expect(createFileProofingScopeKey(scope)).toBe(
      'WORKSPACE#workspace-1#TEAM#core#WORKITEM#work-item-1',
    )
    expect(createApprovalSummary([
      {
        id: 'approval-1',
        subjectType: 'file-version',
        revision: 1,
        fileId: 'file-1',
        versionId: 'version-1',
        status: 'changes-requested',
        reviewers: [],
        dueAt: '2026-01-01T00:00:00.000Z',
        requestedByMemberKey: 'manager@example.com',
        requestedByKind: 'member',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        capabilities: { canCancel: false, canDecide: false },
      },
      {
        id: 'approval-2',
        subjectType: 'work-item',
        revision: 2,
        status: 'pending',
        reviewers: [],
        dueAt: '2026-02-01T00:00:00.000Z',
        requestedByMemberKey: 'manager@example.com',
        requestedByKind: 'member',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        capabilities: { canCancel: true, canDecide: false },
      },
    ])).toMatchObject({
      changesRequestedCount: 1,
      pendingCount: 1,
      pendingDueAt: ['2026-02-01T00:00:00.000Z'],
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
  })
})

function createMemoryKey(item: Record<string, unknown>) {
  const partition = item.scopeKey ?? item.directoryTeamId ?? item.directoryId
  const sort = item.recordKey ?? item.issueId ?? item.eventId
  return `${String(partition)}\u0000${String(sort)}`
}

function createTransactionCancelledError(
  cancellationReasons: readonly Record<string, unknown>[] = [{ Code: 'ConditionalCheckFailed' }],
) {
  return Object.assign(new Error('Conditional transaction failed.'), {
    name: 'TransactionCanceledException',
    CancellationReasons: cancellationReasons,
  })
}
