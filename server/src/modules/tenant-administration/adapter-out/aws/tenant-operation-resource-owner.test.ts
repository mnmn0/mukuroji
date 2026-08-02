import { describe, expect, test } from 'bun:test'
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
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

/** Creates stable test resource names for every tenant-owned store. */
function createConfig(): TenantOperationResourceOwnerConfig {
  return {
    tenantAdministrationTableName: 'tenant-administration',
    tenantExportBucketName: 'tenant-export',
    fileBucketName: 'tenant-files',
    cognitoUserPoolId: 'user-pool-1',
    legacyTasksTableName: 'legacy-tasks',
    workItemsTableName: 'work-items',
    workItemEventsTableName: 'work-item-events',
    workItemConfigurationTableName: 'work-item-configuration',
    automationTableName: 'automation',
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
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.')
  return JSON.parse(body)
}

/** Reads a string or byte-backed Smithy request body. */
function readTextRequestBody(request: unknown): string {
  if (!isRecord(request)) throw new Error('Expected a serialized AWS request.')
  const body = Reflect.get(request, 'body')
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  throw new Error('Expected a text request body.')
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
      config: createConfig(),
      pseudonymKey: testPseudonymKey,
    })
    const operation = createOperation()

    try {
      await owner.execute(createDataJob(0), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'legacy-tasks',
        FilterExpression: '(begins_with(#tenant0, :tenant0))',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one#' },
        },
      })

      await owner.execute(createDataJob(3), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'work-item-configuration',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace%2Fone#work-item-configuration' },
          ':tenant1': { S: 'workspace%2Fone#team#' },
        },
      })

      await owner.execute(createDataJob(4), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'automation',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one' },
          ':tenant1': { S: 'workspace%2Fone#automation' },
          ':tenant2': { S: 'workspace%2Fone#automation#' },
        },
      })

      await owner.execute(createDataJob(6), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'capacity-planning',
        KeyConditionExpression: '#partitionKey = :tenantValue',
        ExpressionAttributeValues: {
          ':tenantValue': { S: 'workspace/one' },
        },
      })

      await owner.execute(createDataJob(8), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'request-intake',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one' },
          ':tenant1': { S: 'WORKSPACE#workspace/one' },
        },
      })

      await owner.execute(createDataJob(10), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'documents',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one' },
          ':tenant1': { S: 'workspace/one' },
        },
      })

      await owner.execute(createDataJob(11), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'collaboration',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one#' },
        },
      })

      await owner.execute(createDataJob(13), operation)
      expect(requests.at(-1)).toMatchObject({
        TableName: 'notifications',
        ExpressionAttributeValues: {
          ':tenant0': { S: 'workspace/one#' },
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
    const lowLevelClient = new DynamoDBClient({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle() {
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify({
                Items: [{
                  directoryProjectId: { S: 'workspace-1#project#one' },
                  taskId: { S: 'task-1' },
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
    const s3Client = new S3Client({
      credentials: testCredentials,
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          exportBodies.push(readTextRequestBody(request))
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
    }

    try {
      const result = await owner.execute(job, operation)

      expect(result).toMatchObject({ status: 'continuing' })
      expect(exportBodies).toHaveLength(1)
      expect(exportBodies[0]).toContain('Visible title')
      expect(exportBodies[0]).toContain('[REDACTED]')
      expect(exportBodies[0]).not.toContain('reusable-secret')
      expect(exportBodies[0]).not.toContain('capability-digest')
    } finally {
      documentClient.destroy()
      s3Client.destroy()
      cognitoClient.destroy()
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
