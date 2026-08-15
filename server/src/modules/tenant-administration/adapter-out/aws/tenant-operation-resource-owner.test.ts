import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { TenantOperation } from '@mukuroji/contracts'
import {
  TENANT_OPERATION_EXECUTION_JOB_VERSION,
  type TenantOperationExecutionJob,
} from '../../application/tenant-operation-resource-owner'
import {
  AwsTenantOperationResourceOwner,
  type TenantOperationResourceOwnerConfig,
} from './tenant-operation-resource-owner'

const testCredentials = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
}
const testPseudonymKey = '1'.repeat(64)
const inertSecretsManagerClient = new SecretsManagerClient({
  credentials: testCredentials,
  region: 'ap-northeast-1',
})

/** Creates stable test resource names for every tenant-owned store. */
function createConfig(): TenantOperationResourceOwnerConfig {
  return {
    tenantAdministrationTableName: 'tenant-administration',
    tenantExportBucketName: 'tenant-export',
    fileBucketName: 'tenant-files',
    workItemImportBucketName: 'work-item-imports',
    cognitoUserPoolId: 'user-pool-1',
    workItemsTableName: 'work-items',
    workItemEventsTableName: 'work-item-events',
    workItemConfigurationTableName: 'work-item-configuration',
    automationTableName: 'automation',
    automationWebhookSecretPrefix: 'mukuroji/automation-webhooks',
    automationInboundWebhookSecretPrefix: 'mukuroji/automation-inbound-webhooks',
    planningTableName: 'planning',
    capacityPlanningTableName: 'capacity-planning',
    developerPlatformTableName: 'developer-platform',
    analyticsTableName: 'analytics',
    requestIntakeTableName: 'request-intake',
    projectDirectoryTableName: 'project-directory',
    auditEventsTableName: 'audit-events',
    workspaceAccessTableName: 'workspace-access',
    enterpriseIdentityTableName: 'enterprise-identity',
    documentsTableName: 'documents',
    collaborationTableName: 'collaboration',
    workspaceSearchTableName: 'workspace-search',
    notificationsTableName: 'notifications',
    focusTableName: 'focus',
    realtimeSessionsTableName: 'realtime-sessions',
    fileProofingTableName: 'file-proofing',
  }
}

/** Creates a running closure operation at the data-deletion step. */
function createOperation(workspaceId = 'workspace/one'): TenantOperation {
  return {
    operationId: 'operation-1',
    workspaceId,
    kind: 'closure',
    status: 'running',
    requestedBy: 'owner@example.com',
    requestedAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:04:00.000Z',
    updatedBy: 'executor:tenant-member-anonymization',
    currentStep: 'delete-data',
    completedSteps: [
      'export',
      'revoke-access',
      'anonymize-members',
    ],
    lastEvidenceReference: `evidence:sha256:${'1'.padStart(64, '0')}`,
    revision: 4,
  }
}

/** Creates a bounded data-deletion job at one resource target. */
function createDataJob(
  targetIndex: number,
  workspaceId = 'workspace/one',
): TenantOperationExecutionJob {
  return {
    version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
    workspaceId,
    operationId: 'operation-1',
    step: 'delete-data',
    cursor: { targetIndex, processedCount: 0 },
  }
}

/** Reads a serialized Smithy JSON request body without a type assertion. */
function readJsonRequestBody(request: unknown): unknown {
  if (!isRecord(request)) throw new Error('Expected a serialized AWS request.')
  const body = Reflect.get(request, 'body')
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body))
  }
  throw new Error('Expected a JSON request body.')
}

/** Reads a string or byte-backed Smithy request body. */
function readTextRequestBody(request: unknown): string {
  if (!isRecord(request)) throw new Error('Expected a serialized AWS request.')
  const body = Reflect.get(request, 'body')
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  throw new Error('Expected a text request body.')
}

/** Reads one serialized Smithy HTTP query value. */
function readHttpQueryValue(
  request: unknown,
  name: string,
): string | undefined {
  if (!isRecord(request)) throw new Error('Expected a serialized AWS request.')
  const query = Reflect.get(request, 'query')
  if (!isRecord(query)) return undefined
  const value = Reflect.get(query, name)
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/** Reads one serialized Smithy HTTP header value. */
function readHttpHeader(
  request: unknown,
  name: string,
): string | undefined {
  if (!isRecord(request)) throw new Error('Expected a serialized AWS request.')
  const headers = Reflect.get(request, 'headers')
  if (!isRecord(headers)) return undefined
  const value = Reflect.get(headers, name.toLowerCase())
  return typeof value === 'string' ? value : undefined
}

/** Creates one successful XML response for the AWS SDK test transport. */
function createS3XmlResponse(body: string) {
  return {
    response: {
      body: new TextEncoder().encode(body),
      headers: { 'content-type': 'application/xml' },
      statusCode: 200,
    },
  }
}

/** Returns true for a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('AwsTenantOperationResourceOwner', () => {
  test('uses delimiter-safe and encoded selectors for every scanned tenant key family', async () => {
    const requests: unknown[] = []
    const lowLevelClient = new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          requests.push(readJsonRequestBody(request))
          return {
            response: {
              body: new TextEncoder().encode('{"Items":[]}'),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'data',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation = createOperation()

    try {
      await owner.execute(createDataJob(0), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'work-items',
        FilterExpression: '(begins_with(#tenant0, :tenant0))',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one#' },
        },
      })

      await owner.execute(createDataJob(2), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'work-item-configuration',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace%2Fone#work-item-configuration' },
          ':tenant1': { S: 'workspace%2Fone#team#' },
        },
      })

      await owner.execute(createDataJob(3), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'automation',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one' },
          ':tenant1': { S: 'workspace%2Fone#automation' },
          ':tenant2': { S: 'workspace%2Fone#automation#' },
        },
      })

      await owner.execute(createDataJob(5), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'capacity-planning',
        KeyConditionExpression: '#partitionKey = :tenantValue',
        ExpressionAttributeValues: {
          ':tenantValue': { S: 'workspace/one' },
        },
      })

      await owner.execute(createDataJob(7), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'request-intake',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one' },
          ':tenant1': { S: 'WORKSPACE#workspace/one' },
        },
      })

      await owner.execute(createDataJob(9), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'documents',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one' },
          ':tenant1': { S: 'workspace/one' },
        },
      })

      await owner.execute(createDataJob(10), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'collaboration',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one#' },
        },
      })

      await owner.execute(createDataJob(12), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'notifications',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one#' },
        },
      })

      await owner.execute(createDataJob(13), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'focus',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'WORKSPACE#workspace%2Fone#' },
        },
      })

      await owner.execute(createDataJob(14), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'realtime-sessions',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one' },
        },
      })

      await owner.execute(createDataJob(15), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'file-proofing',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'WORKSPACE#workspace/one#' },
        },
      })
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })

  test('selects credential-auth locator partitions by nested target Workspace', async () => {
    const requests: unknown[] = []
    const lowLevelClient = new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          requests.push(readJsonRequestBody(request))
          return {
            response: {
              body: new TextEncoder().encode('{"Items":[]}'),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'secrets',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })

    try {
      await owner.execute({
        ...createDataJob(0),
        step: 'delete-secrets',
      }, {
        ...createOperation(),
        currentStep: 'delete-secrets',
      })
      expect(requests[0]).toMatchObject({
        TableName: 'developer-platform',
        FilterExpression: '(#tenant0 = :tenant0 OR #tenant1.#tenant1_1 = :tenant1)',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one' },
          ':tenant1': { S: 'workspace/one' },
        },
      })
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })

  test('encrypts scan cursors and rejects tampering or cross-operation replay', async () => {
    const requests: unknown[] = []
    let requestCount = 0
    const otherTenantKey = {
      directoryProjectId: 'workspace-other#project-1',
      taskId: 'private-task-1',
    }
    const lowLevelClient = new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          requests.push(readJsonRequestBody(request))
          requestCount += 1
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify(requestCount === 1
                ? {
                    Items: [],
                    LastEvaluatedKey: {
                      directoryProjectId: { S: otherTenantKey.directoryProjectId },
                      taskId: { S: otherTenantKey.taskId },
                    },
                  }
                : { Items: [] })),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'data',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation = createOperation()

    try {
      const first = await owner.execute(createDataJob(0), operation)
      if (first.status !== 'continuing' || !first.nextJob.cursor?.position) {
        throw new Error('Expected an encrypted continuation cursor.')
      }
      const serialized = JSON.stringify(first.nextJob)
      expect(serialized).not.toContain(otherTenantKey.directoryProjectId)
      expect(serialized).not.toContain(otherTenantKey.taskId)

      await owner.execute(first.nextJob, operation)
      expect(requests[1]).toMatchObject({
        ExclusiveStartKey: {
          directoryProjectId: { S: otherTenantKey.directoryProjectId },
          taskId: { S: otherTenantKey.taskId },
        },
      })

      const position = first.nextJob.cursor.position
      const replacement = position.endsWith('A') ? 'B' : 'A'
      const tamperedJob: TenantOperationExecutionJob = {
        ...first.nextJob,
        cursor: {
          ...first.nextJob.cursor,
          position: `${position.slice(0, -1)}${replacement}`,
        },
      }
      await expect(owner.execute(tamperedJob, operation)).rejects.toMatchObject({
        code: 'TenantOperationCursorInvalid',
      })

      const crossOperation = { ...operation, operationId: 'operation-2' }
      await expect(owner.execute({
        ...first.nextJob,
        operationId: 'operation-2',
      }, crossOperation)).rejects.toMatchObject({
        code: 'TenantOperationCursorInvalid',
      })
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })

  test('continues filtered verification scans and repairs a discovered residual row', async () => {
    let requestCount = 0
    const lowLevelClient = new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle() {
          requestCount += 1
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify(requestCount === 1
                ? {
                    Items: [],
                    LastEvaluatedKey: {
                      directoryProjectId: { S: 'workspace-other#project-1' },
                      taskId: { S: 'task-other' },
                    },
                  }
                : {
                    Items: [{
                      directoryProjectId: { S: 'workspace/one#project-1' },
                      taskId: { S: 'residual-task' },
                    }],
                  })),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'verification',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation: TenantOperation = {
      ...createOperation(),
      currentStep: 'verify',
      completedSteps: [
        'export',
        'revoke-access',
        'anonymize-members',
        'delete-data',
        'delete-secrets',
      ],
      revision: 6,
    }
    const job: TenantOperationExecutionJob = {
      version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
      workspaceId: operation.workspaceId,
      operationId: operation.operationId,
      step: 'verify',
    }

    try {
      const first = await owner.execute(job, operation)
      expect(first).toMatchObject({
        status: 'continuing',
        nextJob: { cursor: { targetIndex: 0 } },
      })
      if (first.status !== 'continuing') {
        throw new Error('Expected a verification continuation.')
      }
      expect(await owner.execute(first.nextJob, operation)).toEqual({
        status: 'repair',
        step: 'delete-data',
      })
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })

  test('delays the first closure export snapshot until writers quiesce', async () => {
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    }))
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'export',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
      clock: () => new Date('2026-08-02T00:01:00.000Z'),
    })
    const operation: TenantOperation = {
      ...createOperation(),
      currentStep: 'export',
      completedSteps: [],
      revision: 1,
    }
    const job: TenantOperationExecutionJob = {
      version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
      workspaceId: operation.workspaceId,
      operationId: operation.operationId,
      step: 'export',
    }

    try {
      expect(await owner.execute(job, operation)).toEqual({
        status: 'continuing',
        nextJob: {
          ...job,
          cursor: {
            targetIndex: 0,
            phase: 'snapshot',
            processedCount: 0,
          },
        },
        delaySeconds: 900,
      })
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })

  test('redacts reusable credentials before writing an export page', async () => {
    const dynamoRequests: unknown[] = []
    const lowLevelClient = new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          dynamoRequests.push(readJsonRequestBody(request))
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify({
                Items: [{
                  scopeKey: { S: 'WORKSPACE#workspace-1#USER#member-1' },
                  recordKey: { S: 'SNOOZE#team-1#work-item-1' },
                  title: { S: 'Visible title' },
                  apiToken: { S: 'reusable-secret' },
                  tokenHash: { S: 'capability-digest' },
                }],
              })),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
    const exportBodies: string[] = []
    const exportPaths: string[] = []
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          exportBodies.push(readTextRequestBody(request))
          if (isRecord(request)) {
            const path = Reflect.get(request, 'path')
            if (typeof path === 'string') exportPaths.push(path)
          }
          return {
            response: {
              body: new Uint8Array(),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'export',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation: TenantOperation = {
      ...createOperation('workspace-1'),
      kind: 'export',
      currentStep: 'snapshot',
      completedSteps: [],
      exportFormat: 'jsonl',
      revision: 1,
    }
    const job: TenantOperationExecutionJob = {
      version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      step: 'snapshot',
      cursor: {
        targetIndex: 17,
        phase: 'snapshot',
        processedCount: 0,
      },
    }

    try {
      const result = await owner.execute(job, operation)

      expect(result).toMatchObject({ status: 'continuing' })
      expect(exportBodies).toHaveLength(1)
      expect(exportBodies[0]).toContain('Visible title')
      expect(exportBodies[0]).toContain('[REDACTED]')
      expect(exportBodies[0]).not.toContain('reusable-secret')
      expect(exportBodies[0]).not.toContain('capability-digest')
      expect(dynamoRequests[0]).toMatchObject({
        TableName: 'focus',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'WORKSPACE#workspace-1#' },
        },
      })
      expect(exportPaths[0]).toContain('/snapshot/data/focus/')
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })

  test('exports regular, Request Intake, and Work Item import objects', async () => {
    const workspaceId = 'workspace/one'
    const requestWorkspaceDigest = createHash('sha256')
      .update(workspaceId)
      .digest('hex')
      .slice(0, 32)
    const requestObjectKey =
      `workspaces/${requestWorkspaceDigest}/request-submissions/attachment-1/content`
    const importWorkspaceDigest = createHash('sha256')
      .update(workspaceId)
      .digest('hex')
    const importObjectKey =
      `work-item-imports/${importWorkspaceDigest}/job-1/source.source`
    const listedPrefixes: string[] = []
    const copiedSources: string[] = []
    const copiedPaths: string[] = []
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          const listedPrefix = readHttpQueryValue(request, 'prefix')
          if (readHttpQueryValue(request, 'list-type') === '2' && listedPrefix) {
            listedPrefixes.push(listedPrefix)
            const objectKey = listedPrefixes.length === 2
              ? requestObjectKey
              : listedPrefixes.length === 3
                ? importObjectKey
                : undefined
            const contents = objectKey
              ? `<Contents><Key>${objectKey}</Key><Size>7</Size></Contents>`
              : ''
            return createS3XmlResponse(
              `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
              `<Name>tenant-files</Name><Prefix>${listedPrefix}</Prefix>` +
              `<KeyCount>${contents ? '1' : '0'}</KeyCount><MaxKeys>20</MaxKeys>` +
              `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
            )
          }
          const copySource = readHttpHeader(request, 'x-amz-copy-source')
          if (copySource) {
            copiedSources.push(copySource)
            if (isRecord(request)) {
              const path = Reflect.get(request, 'path')
              if (typeof path === 'string') copiedPaths.push(path)
            }
            return createS3XmlResponse(
              '<CopyObjectResult><ETag>"etag-1"</ETag></CopyObjectResult>',
            )
          }
          throw new Error('Unexpected S3 export request.')
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    }))
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'export',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation: TenantOperation = {
      ...createOperation(workspaceId),
      kind: 'export',
      currentStep: 'snapshot',
      completedSteps: [],
      exportFormat: 'jsonl',
      revision: 1,
    }
    const job: TenantOperationExecutionJob = {
      version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
      workspaceId,
      operationId: operation.operationId,
      step: 'snapshot',
      cursor: {
        targetIndex: 21,
        phase: 'snapshot',
        processedCount: 0,
      },
    }

    try {
      const regularFiles = await owner.execute(job, operation)
      if (regularFiles.status !== 'continuing') {
        throw new Error('Expected the Request Intake namespace continuation.')
      }
      const requestAttachments = await owner.execute(
        regularFiles.nextJob,
        operation,
      )
      if (requestAttachments.status !== 'continuing') {
        throw new Error('Expected the Work Item import namespace continuation.')
      }
      const importSources = await owner.execute(
        requestAttachments.nextJob,
        operation,
      )
      if (importSources.status !== 'continuing') {
        throw new Error('Expected the export snapshot completion continuation.')
      }

      expect(listedPrefixes).toEqual([
        `workspaces/${encodeURIComponent(workspaceId)}/files/`,
        `workspaces/${requestWorkspaceDigest}/request-submissions/`,
        `work-item-imports/${importWorkspaceDigest}/`,
      ])
      expect(copiedSources).toHaveLength(2)
      expect(copiedSources[0]).toContain(requestWorkspaceDigest)
      expect(copiedSources[1]).toContain(importObjectKey)
      expect(copiedPaths).toHaveLength(2)
      expect(copiedPaths[0]).toContain(
        '/snapshot/request-intake-attachments/attachment-1/content',
      )
      expect(copiedPaths[1]).toContain(
        '/snapshot/work-item-import-sources/job-1/source.source',
      )
      expect(importSources.nextJob.cursor?.targetIndex).toBe(24)
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })

  test('deletes every version from all tenant object namespaces', async () => {
    const workspaceId = 'workspace-1'
    const requestWorkspaceDigest = createHash('sha256')
      .update(workspaceId)
      .digest('hex')
      .slice(0, 32)
    const requestObjectKey =
      `workspaces/${requestWorkspaceDigest}/request-submissions/attachment-1/content`
    const importWorkspaceDigest = createHash('sha256')
      .update(workspaceId)
      .digest('hex')
    const importObjectKey =
      `work-item-imports/${importWorkspaceDigest}/job-1/source.source`
    const listedPrefixes: string[] = []
    const deletionBodies: string[] = []
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          const listedPrefix = readHttpQueryValue(request, 'prefix')
          if (listedPrefix) {
            listedPrefixes.push(listedPrefix)
            const objectKey = listedPrefixes.length === 2
              ? requestObjectKey
              : listedPrefixes.length === 3
                ? importObjectKey
                : undefined
            const version = objectKey
              ? `<Version><Key>${objectKey}</Key>` +
                `<VersionId>version-${listedPrefixes.length}</VersionId>` +
                '<IsLatest>true</IsLatest><Size>7</Size></Version>'
              : ''
            return createS3XmlResponse(
              `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
              `<Name>tenant-files</Name><Prefix>${listedPrefix}</Prefix>` +
              `<MaxKeys>20</MaxKeys><IsTruncated>false</IsTruncated>` +
              `${version}</ListVersionsResult>`,
            )
          }
          const body = readTextRequestBody(request)
          deletionBodies.push(body)
          return createS3XmlResponse(
            '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>',
          )
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    }))
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'data',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation = createOperation(workspaceId)

    try {
      const regularFiles = await owner.execute(
        createDataJob(16, workspaceId),
        operation,
      )
      if (regularFiles.status !== 'continuing') {
        throw new Error('Expected the Request Intake deletion continuation.')
      }
      const requestAttachments = await owner.execute(
        regularFiles.nextJob,
        operation,
      )
      if (requestAttachments.status !== 'continuing') {
        throw new Error('Expected the Work Item import deletion continuation.')
      }
      const importSources = await owner.execute(
        requestAttachments.nextJob,
        operation,
      )
      if (importSources.status !== 'continuing') {
        throw new Error('Expected the data-deletion evidence continuation.')
      }

      expect(listedPrefixes).toEqual([
        `workspaces/${workspaceId}/files/`,
        `workspaces/${requestWorkspaceDigest}/request-submissions/`,
        `work-item-imports/${importWorkspaceDigest}/`,
      ])
      expect(deletionBodies).toHaveLength(2)
      expect(deletionBodies[0]).toContain(requestObjectKey)
      expect(deletionBodies[0]).toContain('version-2')
      expect(deletionBodies[1]).toContain(importObjectKey)
      expect(deletionBodies[1]).toContain('version-3')
      expect(importSources.nextJob.cursor?.targetIndex).toBe(19)
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })

  test('repairs closure when a Work Item import source version remains', async () => {
    const workspaceId = 'workspace-1'
    const requestWorkspaceDigest = createHash('sha256')
      .update(workspaceId)
      .digest('hex')
      .slice(0, 32)
    const importWorkspaceDigest = createHash('sha256')
      .update(workspaceId)
      .digest('hex')
    const importObjectKey =
      `work-item-imports/${importWorkspaceDigest}/job-1/source.source`
    const listedPrefixes: string[] = []
    const secretsManagerClient = new SecretsManagerClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle() {
          return {
            response: {
              body: new TextEncoder().encode('{"SecretList":[]}'),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          const listedPrefix = readHttpQueryValue(request, 'prefix')
          if (!listedPrefix) throw new Error('Expected an S3 list request.')
          listedPrefixes.push(listedPrefix)
          const version = listedPrefixes.length === 3
            ? `<Version><Key>${importObjectKey}</Key>` +
              '<VersionId>version-1</VersionId><IsLatest>true</IsLatest>' +
              '<Size>7</Size></Version>'
            : ''
          return createS3XmlResponse(
            `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<Name>tenant-files</Name><Prefix>${listedPrefix}</Prefix>` +
            `<MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated>` +
            `${version}</ListVersionsResult>`,
          )
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    }))
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'verification',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation: TenantOperation = {
      ...createOperation(workspaceId),
      currentStep: 'verify',
      completedSteps: [
        'export',
        'revoke-access',
        'anonymize-members',
        'delete-data',
        'delete-secrets',
      ],
      revision: 6,
    }
    const job: TenantOperationExecutionJob = {
      version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
      workspaceId,
      operationId: operation.operationId,
      step: 'verify',
      cursor: { targetIndex: 18, processedCount: 18 },
    }

    try {
      expect(await owner.execute(job, operation)).toEqual({
        status: 'repair',
        step: 'delete-data',
      })
      expect(listedPrefixes).toEqual([
        `workspaces/${workspaceId}/files/`,
        `workspaces/${requestWorkspaceDigest}/request-submissions/`,
        `work-item-imports/${importWorkspaceDigest}/`,
      ])
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
      secretsManagerClient.destroy()
    }
  })

  test('deletes both Automation secret namespaces with encrypted pagination', async () => {
    const workspaceId = 'workspace/one'
    const workspaceHash = createHash('sha256').update(workspaceId).digest('hex')
    const outboundSecret = `mukuroji/automation-webhooks/${workspaceHash}/partner-primary`
    const inboundSecret = `mukuroji/automation-inbound-webhooks/${workspaceHash}/endpoint-1`
    const secretRequests: unknown[] = []
    let listRequestCount = 0
    const secretsManagerClient = new SecretsManagerClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          const body = readJsonRequestBody(request)
          secretRequests.push(body)
          const isListRequest = isRecord(body) && Array.isArray(body.Filters)
          let responseBody: Record<string, unknown> = {}
          if (isListRequest) {
            listRequestCount += 1
            responseBody = listRequestCount === 1
              ? {
                  SecretList: [{ Name: outboundSecret }],
                  NextToken: 'provider-secret-token',
                }
              : listRequestCount === 3
                ? { SecretList: [{ Name: inboundSecret }] }
                : { SecretList: [] }
          }
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify(responseBody)),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle() {
          return {
            response: {
              body: new TextEncoder().encode('{}'),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    }))
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'secrets',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation: TenantOperation = {
      ...createOperation(workspaceId),
      currentStep: 'delete-secrets',
      completedSteps: [
        'export',
        'revoke-access',
        'anonymize-members',
        'delete-data',
      ],
      revision: 5,
    }
    const job: TenantOperationExecutionJob = {
      version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
      workspaceId,
      operationId: operation.operationId,
      step: 'delete-secrets',
      cursor: { targetIndex: 2, processedCount: 0 },
    }

    try {
      const outboundPage = await owner.execute(job, operation)
      if (outboundPage.status !== 'continuing') {
        throw new Error('Expected an outbound secret continuation.')
      }
      expect(JSON.stringify(outboundPage.nextJob)).not.toContain(
        'provider-secret-token',
      )
      const outboundComplete = await owner.execute(outboundPage.nextJob, operation)
      if (outboundComplete.status !== 'continuing') {
        throw new Error('Expected an inbound namespace continuation.')
      }
      const inboundComplete = await owner.execute(outboundComplete.nextJob, operation)
      if (inboundComplete.status !== 'continuing') {
        throw new Error('Expected an evidence continuation.')
      }
      expect(await owner.execute(inboundComplete.nextJob, operation)).toMatchObject({
        status: 'completed',
        evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })

      const serializedRequests = JSON.stringify(secretRequests)
      expect(serializedRequests).toContain(
        `mukuroji/automation-webhooks/${workspaceHash}/`,
      )
      expect(serializedRequests).toContain(
        `mukuroji/automation-inbound-webhooks/${workspaceHash}/`,
      )
      const deletedSecretIds = secretRequests.flatMap((request) =>
        isRecord(request) && typeof request.SecretId === 'string'
          ? [request.SecretId]
          : []
      )
      expect(deletedSecretIds).toEqual([outboundSecret, inboundSecret])
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
      secretsManagerClient.destroy()
    }
  })

  test('repairs closure when an Automation secret remains after table deletion', async () => {
    const workspaceId = 'workspace/one'
    const workspaceHash = createHash('sha256').update(workspaceId).digest('hex')
    const inboundPrefix = `mukuroji/automation-inbound-webhooks/${workspaceHash}/`
    const secretsManagerClient = new SecretsManagerClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          const body = readJsonRequestBody(request)
          const serialized = JSON.stringify(body)
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify({
                SecretList: serialized.includes(inboundPrefix)
                  ? [{ Name: `${inboundPrefix}endpoint-1` }]
                  : [],
              })),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    }))
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'verification',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation: TenantOperation = {
      ...createOperation(workspaceId),
      currentStep: 'verify',
      completedSteps: [
        'export',
        'revoke-access',
        'anonymize-members',
        'delete-data',
        'delete-secrets',
      ],
      revision: 6,
    }
    const job: TenantOperationExecutionJob = {
      version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
      workspaceId,
      operationId: operation.operationId,
      step: 'verify',
      cursor: { targetIndex: 18, processedCount: 18 },
    }

    try {
      expect(await owner.execute(job, operation)).toEqual({
        status: 'repair',
        step: 'delete-secrets',
      })
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
      secretsManagerClient.destroy()
    }
  })

  test('pseudonymizes retained control-plane member fields before deletion', async () => {
    const writtenItems: unknown[] = []
    const lowLevelClient = new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          const body = readJsonRequestBody(request)
          if (!isRecord(body)) throw new Error('Expected a DynamoDB request body.')
          if (typeof body.KeyConditionExpression === 'string') {
            return {
              response: {
                body: new TextEncoder().encode(JSON.stringify({
                  Items: [
                    {
                      workspaceId: { S: 'workspace-1' },
                      recordKey: { S: 'PROFILE' },
                      kind: { S: 'profile' },
                      payload: {
                        S: JSON.stringify({
                          ownerMemberKey: 'owner@example.com',
                          status: 'closing',
                        }),
                      },
                    },
                    {
                      workspaceId: { S: 'workspace-1' },
                      recordKey: { S: 'OPERATION#older-export' },
                      kind: { S: 'operation' },
                      payload: {
                        S: JSON.stringify({
                          requestedBy: 'admin@example.com',
                          updatedBy: 'executor:tenant-export',
                        }),
                      },
                    },
                    {
                      workspaceId: { S: 'workspace-1' },
                      recordKey: { S: 'OPERATION#operation-1' },
                      kind: { S: 'operation' },
                      payload: {
                        S: JSON.stringify({
                          operationId: 'operation-1',
                          requestedBy: 'owner@example.com',
                          updatedBy: 'executor:tenant-access-revocation',
                        }),
                      },
                    },
                  ],
                })),
                headers: {},
                statusCode: 200,
              },
            }
          }
          if (isRecord(body.Item)) writtenItems.push(body.Item)
          return {
            response: {
              body: new TextEncoder().encode('{}'),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const cognitoClient = new CognitoIdentityProviderClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
    })
    const owner = new AwsTenantOperationResourceOwner({
      owner: 'identity',
      documentClient,
      s3Client,
      cognitoClient,
      secretsManagerClient: inertSecretsManagerClient,
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
      clock: () => new Date('2026-08-02T00:05:00.000Z'),
    })
    const operation: TenantOperation = {
      ...createOperation('workspace-1'),
      currentStep: 'anonymize-members',
      completedSteps: ['export', 'revoke-access'],
      revision: 3,
    }
    const job: TenantOperationExecutionJob = {
      version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      step: 'anonymize-members',
      cursor: { targetIndex: 1, processedCount: 2 },
    }

    try {
      const result = await owner.execute(job, operation)
      const serializedWrites = JSON.stringify(writtenItems)

      expect(result).toMatchObject({
        status: 'completed',
        evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })
      expect(serializedWrites).toContain('deleted+')
      expect(serializedWrites).not.toContain('owner@example.com')
      expect(serializedWrites).not.toContain('admin@example.com')
      expect(serializedWrites).toContain('executor:tenant-export')
      expect(writtenItems).toHaveLength(3)
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
    }
  })
})
