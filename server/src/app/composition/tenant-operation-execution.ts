import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { S3Client } from '@aws-sdk/client-s3'
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { SendMessageCommand } from '@aws-sdk/client-sqs'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import { createSqsClient } from '../../infrastructure/aws/sqs-client'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  TenantOperationExecutor,
  TenantOperationResourceOwnerExecutor,
  resolveTenantOperationResourceOwner,
  type TenantOperationResourceOwnerKind,
} from '../../modules/tenant-administration'
import {
  AwsTenantOperationResourceOwner,
  type TenantOperationResourceOwnerConfig,
} from '../../modules/tenant-administration/adapter-out/aws/tenant-operation-resource-owner'
import type {
  TenantOperationExecutionProcessor,
} from '../../modules/tenant-administration/adapter-in/events/tenant-operation-execution'
import type {
  TenantOperationResourceOwnerProcessor,
} from '../../modules/tenant-administration/adapter-in/events/tenant-operation-resource-owner'
import { createProductionTenantAdministrationClient } from './tenant-administration'

/**
 * Creates the trusted production tenant operation executor.
 *
 * @returns An executor backed by durable tenant state and append-only audit history.
 */
export function createProductionTenantOperationExecutor(): TenantOperationExecutionProcessor {
  const client = createProductionTenantAdministrationClient()
  const executor = new TenantOperationExecutor(client)
  const sqs = createSqsClient()
  return {
    async execute(input) {
      return await executor.execute(input)
    },
    async reconcileAuditRetention(workspaceId) {
      return await client.reconcileAuditRetention(workspaceId)
    },
    async reconcileAuditEventRetention(workspaceId, eventId, occurredAt) {
      await client.reconcileAuditEventRetention(
        workspaceId,
        eventId,
        occurredAt,
      )
    },
    async dispatchOperationExecution(job) {
      const owner = resolveTenantOperationResourceOwner(job.step)
      await sqs.send(new SendMessageCommand({
        QueueUrl: readTenantOperationQueueUrl(owner),
        MessageBody: JSON.stringify(job),
      }))
    },
  }
}

/**
 * Creates one capability-isolated production resource-owner queue processor.
 *
 * @returns A bounded AWS resource owner that commits only content-addressed proof.
 */
export function createProductionTenantOperationResourceOwner(): TenantOperationResourceOwnerProcessor {
  const serverConfig = loadServerConfig()
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient(serverConfig))
  const sqs = createSqsClient()
  const secretsManagerClient = createSecretsManagerClient()
  const owner = readTenantOperationResourceOwnerKind()
  const capability = readTenantOperationCapability(owner)
  const queueUrl = requireEnvironment(
    'TENANT_OPERATION_RESOURCE_OWNER_QUEUE_URL',
  )
  let executor: TenantOperationResourceOwnerExecutor | undefined

  /** Loads sensitive key material once and constructs the bounded owner in memory. */
  async function resolveExecutor(): Promise<TenantOperationResourceOwnerExecutor> {
    if (executor) return executor
    const response = await secretsManagerClient.send(new GetSecretValueCommand({
      SecretId: requireEnvironment('TENANT_OPERATION_PSEUDONYM_SECRET_ARN'),
    }))
    if (typeof response.SecretString !== 'string') {
      throw new TypeError('Tenant operation pseudonym secret is invalid.')
    }
    const state = createProductionTenantAdministrationClient(response.SecretString)
    const awsOwner = new AwsTenantOperationResourceOwner({
      owner,
      documentClient,
      s3Client: new S3Client({ region: serverConfig.awsRegion }),
      cognitoClient: new CognitoIdentityProviderClient({
        region: serverConfig.awsRegion,
        ...(serverConfig.cognitoEndpoint
          ? {
              endpoint: serverConfig.cognitoEndpoint,
              credentials: {
                accessKeyId: serverConfig.environment.AWS_ACCESS_KEY_ID ?? 'test',
                secretAccessKey: serverConfig.environment.AWS_SECRET_ACCESS_KEY ?? 'test',
              },
            }
          : {}),
      }),
      secretsManagerClient,
      config: readTenantOperationResourceOwnerConfig(),
      pseudonymKey: response.SecretString,
    })
    executor = new TenantOperationResourceOwnerExecutor(
      state,
      awsOwner,
      {
        /** Enqueues one same-capability continuation without accepting a destination. */
        async send(job, delaySeconds) {
          await sqs.send(new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(job),
            ...(delaySeconds === undefined ? {} : { DelaySeconds: delaySeconds }),
          }))
        },
      },
      capability.executorId,
      capability.allowedSteps,
    )
    return executor
  }

  return {
    /** Executes one queued page after lazy in-memory secret hydration. */
    async execute(job) {
      return await (await resolveExecutor()).execute(job)
    },
  }
}

/** Resolves one capability queue URL without accepting a caller-supplied destination. */
function readTenantOperationQueueUrl(
  owner: ReturnType<typeof resolveTenantOperationResourceOwner>,
): string {
  const environmentName = {
    export: 'TENANT_EXPORT_EXECUTION_QUEUE_URL',
    access: 'TENANT_ACCESS_EXECUTION_QUEUE_URL',
    identity: 'TENANT_IDENTITY_EXECUTION_QUEUE_URL',
    data: 'TENANT_DATA_EXECUTION_QUEUE_URL',
    secrets: 'TENANT_SECRETS_EXECUTION_QUEUE_URL',
    verification: 'TENANT_VERIFICATION_EXECUTION_QUEUE_URL',
  }[owner]
  const value = process.env[environmentName]?.trim()
  if (!value) {
    throw new Error(`Required tenant operation queue is missing: ${environmentName}`)
  }
  return value
}

/** Reads the immutable resource-owner identity configured by CDK. */
function readTenantOperationResourceOwnerKind(): TenantOperationResourceOwnerKind {
  const value = process.env.TENANT_OPERATION_RESOURCE_OWNER?.trim()
  if (
    value === 'export' ||
    value === 'access' ||
    value === 'identity' ||
    value === 'data' ||
    value === 'secrets' ||
    value === 'verification'
  ) {
    return value
  }
  throw new Error('TENANT_OPERATION_RESOURCE_OWNER is invalid.')
}

/** Reads and cross-checks one owner capability binding. */
function readTenantOperationCapability(owner: TenantOperationResourceOwnerKind): {
  readonly executorId: string
  readonly allowedSteps: readonly (
    'snapshot' |
    'prepare-artifact' |
    'verify-artifact' |
    'export' |
    'revoke-access' |
    'anonymize-members' |
    'delete-data' |
    'delete-secrets' |
    'verify'
  )[]
} {
  const expected = {
    export: {
      executorId: 'executor:tenant-export',
      allowedSteps: ['snapshot', 'prepare-artifact', 'verify-artifact', 'export'],
    },
    access: {
      executorId: 'executor:tenant-access-revocation',
      allowedSteps: ['revoke-access'],
    },
    identity: {
      executorId: 'executor:tenant-member-anonymization',
      allowedSteps: ['anonymize-members'],
    },
    data: {
      executorId: 'executor:tenant-data-deletion',
      allowedSteps: ['delete-data'],
    },
    secrets: {
      executorId: 'executor:tenant-secret-deletion',
      allowedSteps: ['delete-secrets'],
    },
    verification: {
      executorId: 'executor:tenant-closure-verification',
      allowedSteps: ['verify'],
    },
  } satisfies Record<TenantOperationResourceOwnerKind, {
    readonly executorId: string
    readonly allowedSteps: readonly (
      'snapshot' |
      'prepare-artifact' |
      'verify-artifact' |
      'export' |
      'revoke-access' |
      'anonymize-members' |
      'delete-data' |
      'delete-secrets' |
      'verify'
    )[]
  }>
  const capability = expected[owner]
  const configuredExecutor = process.env.TENANT_OPERATION_EXECUTOR_ID?.trim()
  const configuredSteps = (process.env.TENANT_OPERATION_ALLOWED_STEPS ?? '')
    .split(',')
    .map((step) => step.trim())
    .filter((step) => step.length > 0)
  if (
    configuredExecutor !== capability.executorId ||
    configuredSteps.join(',') !== capability.allowedSteps.join(',')
  ) {
    throw new Error('Tenant operation resource-owner capability is inconsistent.')
  }
  return capability
}

/** Reads every AWS resource name required by capability-isolated owners. */
function readTenantOperationResourceOwnerConfig(): TenantOperationResourceOwnerConfig {
  return {
    tenantAdministrationTableName: requireEnvironment('TENANT_ADMINISTRATION_TABLE_NAME'),
    tenantExportBucketName: requireEnvironment('TENANT_EXPORT_BUCKET_NAME'),
    fileBucketName: requireEnvironment('FILE_BUCKET_NAME'),
    workItemImportBucketName: requireEnvironment('WORK_ITEM_IMPORT_BUCKET_NAME'),
    cognitoUserPoolId: requireEnvironment('COGNITO_USER_POOL_ID'),
    legacyTasksTableName: requireEnvironment('MUKUROJI_PROJECT_TASKS_TABLE'),
    workItemsTableName: requireEnvironment('WORK_ITEMS_TABLE_NAME'),
    workItemEventsTableName: requireEnvironment('MUKUROJI_TEAM_ISSUE_EVENTS_TABLE'),
    workItemConfigurationTableName: requireEnvironment('WORK_ITEM_CONFIGURATION_TABLE_NAME'),
    automationTableName: requireEnvironment('AUTOMATION_TABLE_NAME'),
    automationWebhookSecretPrefix: requireEnvironment('AUTOMATION_WEBHOOK_SECRET_PREFIX'),
    automationInboundWebhookSecretPrefix: requireEnvironment(
      'AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX',
    ),
    planningTableName: requireEnvironment('PLANNING_TABLE_NAME'),
    capacityPlanningTableName: requireEnvironment('CAPACITY_PLANNING_TABLE_NAME'),
    developerPlatformTableName: requireEnvironment('DEVELOPER_PLATFORM_TABLE_NAME'),
    analyticsTableName: requireEnvironment('ANALYTICS_TABLE_NAME'),
    requestIntakeTableName: requireEnvironment('REQUEST_INTAKE_TABLE_NAME'),
    projectDirectoryTableName: requireEnvironment('PROJECT_DIRECTORY_TABLE_NAME'),
    auditEventsTableName: requireEnvironment('AUDIT_EVENTS_TABLE_NAME'),
    workspaceAccessTableName: requireEnvironment('WORKSPACE_ACCESS_TABLE_NAME'),
    enterpriseIdentityTableName: requireEnvironment('ENTERPRISE_IDENTITY_TABLE_NAME'),
    documentsTableName: requireEnvironment('DOCUMENTS_TABLE_NAME'),
    collaborationTableName: requireEnvironment('COLLABORATION_TABLE_NAME'),
    workspaceSearchTableName: requireEnvironment('WORKSPACE_SEARCH_TABLE_NAME'),
    notificationsTableName: requireEnvironment('NOTIFICATIONS_TABLE_NAME'),
    realtimeSessionsTableName: requireEnvironment('REALTIME_SESSIONS_TABLE_NAME'),
    fileProofingTableName: requireEnvironment('FILE_PROOFING_TABLE_NAME'),
  }
}

/** Reads one mandatory CDK-injected environment value. */
function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Required tenant operation resource is missing: ${name}`)
  return value
}
