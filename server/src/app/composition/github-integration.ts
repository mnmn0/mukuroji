import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { createSqsClient } from '../../infrastructure/aws/sqs-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { getConfiguredAuditTableName, type MutationAuditContext } from '../../modules/audit'
import { DynamoDbTenantAdministrationClient, TenantAdministrationError } from '../../modules/tenant-administration'
import {
  CachedGitHubAppCredentialSource,
  createGitHubReconcileHandler,
  createGitHubSyncQueueHandler,
  DynamoDbGitHubIntegrationStore,
  DynamoDbGitHubNotificationSink,
  GitHubAppHttpGateway,
  GitHubIntegrationError,
  InMemoryGitHubIntegrationStore,
  InMemoryGitHubNotificationSink,
  InMemoryGitHubSyncQueue,
  SqsGitHubSyncQueue,
  type GitHubAppCredentialSource,
  type GitHubAppGateway,
  type GitHubIntegrationStore,
  type GitHubPullRequestNotificationSink,
  type GitHubSyncQueue,
} from '../../modules/github-integration'

/** Adapters of the GitHub App integration (ADR 0079). */
export type GitHubIntegrationDependencies = {
  /** Workspace of this deployment, when configured. */
  workspaceId: string | undefined
  /** Repository links, member logins, and snapshots. */
  store: GitHubIntegrationStore<MutationAuditContext>
  /** App credentials. */
  credentials: GitHubAppCredentialSource
  /** GitHub reads. */
  gateway: GitHubAppGateway
  /** Sync job queue. */
  queue: GitHubSyncQueue
}

/** Secrets Manager ARN of a full secret, as the stack passes it. */
const SECRET_ARN_PATTERN = /^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,519}$/u

/**
 * Creates the GitHub App adapters from the environment.
 *
 * `GITHUB_APP_SECRET_ARN` names the App secret the stack's optional GitHub App module creates.
 * Local runs may pass the same JSON in `GITHUB_APP_CREDENTIALS` instead; a deployed Lambda never
 * reads a plain value. Without either, the integration reports "not configured" and the webhook
 * endpoint answers 404.
 *
 * @returns The adapters.
 */
export function createProductionGitHubIntegrationDependencies(): GitHubIntegrationDependencies {
  const { environment } = loadServerConfig()
  const credentials = new CachedGitHubAppCredentialSource(createSecretLoader(environment))
  const queueUrl = environment.GITHUB_SYNC_QUEUE_URL?.trim()
  return {
    workspaceId: environment.MUKUROJI_WORKSPACE_DIRECTORY_ID?.trim() || undefined,
    store: new DynamoDbGitHubIntegrationStore(
      environment.PLANNING_TABLE_NAME ?? 'mukuroji-planning-local',
      createDynamoDbDocumentClient(),
      getConfiguredAuditTableName(),
      environment.MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY || undefined,
    ),
    credentials,
    gateway: new GitHubAppHttpGateway(credentials),
    queue: queueUrl ? new SqsGitHubSyncQueue(createSqsClient(), queueUrl) : unavailableQueue,
  }
}

/**
 * Creates in-memory adapters for tests: no App is configured until a test replaces the credentials.
 *
 * @returns The adapters.
 */
export function createTestGitHubIntegrationDependencies(): GitHubIntegrationDependencies {
  const credentials = new CachedGitHubAppCredentialSource(async () => undefined)
  return {
    workspaceId: undefined,
    store: new InMemoryGitHubIntegrationStore(),
    credentials,
    gateway: new GitHubAppHttpGateway(credentials),
    queue: new InMemoryGitHubSyncQueue(),
  }
}

/** Audit retention used when `AUDIT_RETENTION_DAYS` is not set, as for the other workers. */
const DEFAULT_AUDIT_RETENTION_DAYS = 2_555

/**
 * Creates the sink of pull request notifications: audit events in the audit table, or memory when
 * no audit table is configured (local runs).
 *
 * @returns The sink.
 */
function createProductionNotificationSink(): GitHubPullRequestNotificationSink {
  const auditTableName = getConfiguredAuditTableName()
  if (!auditTableName) return new InMemoryGitHubNotificationSink()
  const configured = Number(loadServerConfig().environment.AUDIT_RETENTION_DAYS)
  const retentionDays = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_AUDIT_RETENTION_DAYS
  return new DynamoDbGitHubNotificationSink(auditTableName, createDynamoDbDocumentClient(), retentionDays)
}

/**
 * Creates the tenant lifecycle check of the workers: a closing or closed tenant is not synchronized.
 * A deployed worker must name the tenant table; a local run without one treats the tenant as active.
 *
 * @returns The check.
 */
function createProductionTenantActivityCheck(): (workspaceId: string) => Promise<boolean> {
  const environment = loadServerConfig().environment
  const tableName = environment.TENANT_ADMINISTRATION_TABLE_NAME?.trim()
  if (!tableName) {
    if (environment.AWS_LAMBDA_FUNCTION_NAME?.trim()) throw new Error('GitHub sync worker requires TENANT_ADMINISTRATION_TABLE_NAME.')
    return async () => true
  }
  const tenant = new DynamoDbTenantAdministrationClient(tableName, createDynamoDbDocumentClient())
  return async (workspaceId) => {
    try {
      await tenant.assertActive(workspaceId)
      return true
    } catch (error) {
      if (error instanceof TenantAdministrationError && (error.code === 'TenantClosing' || error.code === 'TenantClosed')) return false
      throw error
    }
  }
}

/**
 * Creates the GitHub sync worker entrypoints.
 *
 * @param dependencies - Adapters.
 * @param notifications - Sink of pull request notifications.
 * @returns The SQS handler and the hourly reconcile handler.
 */
export function createGitHubSyncWorkerHandlers(
  dependencies: GitHubIntegrationDependencies = createProductionGitHubIntegrationDependencies(),
  notifications: GitHubPullRequestNotificationSink = createProductionNotificationSink(),
  isTenantActive: (workspaceId: string) => Promise<boolean> = createProductionTenantActivityCheck(),
) {
  const workspaceId = dependencies.workspaceId
  if (!workspaceId) throw new Error('GitHub sync worker requires MUKUROJI_WORKSPACE_DIRECTORY_ID.')
  const worker = {
    store: dependencies.store,
    gateway: dependencies.gateway,
    queue: dependencies.queue,
    notifications,
    workspaceId,
    now: () => new Date(),
    log: (message: string, details: Record<string, unknown>) => console.info(JSON.stringify({ message, ...details })),
    isTenantActive,
  }
  return {
    queueHandler: createGitHubSyncQueueHandler(worker),
    reconcileHandler: createGitHubReconcileHandler(worker, async () => await dependencies.credentials.read() !== null),
  }
}

/**
 * Chooses where the App secret is read from.
 *
 * @param environment - Server environment.
 * @returns A loader that returns the secret string, or `undefined` when none is configured.
 */
function createSecretLoader(environment: Readonly<Record<string, string | undefined>>): () => Promise<string | undefined> {
  const secretArn = environment.GITHUB_APP_SECRET_ARN?.trim()
  if (secretArn) {
    if (!SECRET_ARN_PATTERN.test(secretArn)) throw new Error('GITHUB_APP_SECRET_ARN is invalid.')
    return async () => {
      const response = await createSecretsManagerClient().send(new GetSecretValueCommand({ SecretId: secretArn }))
      return typeof response.SecretString === 'string' ? response.SecretString : undefined
    }
  }
  const deployed = Boolean(environment.AWS_LAMBDA_FUNCTION_NAME?.trim()) && environment.MUKUROJI_LOCAL_AWS_RUNTIME !== 'floci'
  const plain = deployed ? undefined : environment.GITHUB_APP_CREDENTIALS
  return async () => plain
}

/** Queue of a runtime without the GitHub sync queue; sending fails as not configured. */
const unavailableQueue: GitHubSyncQueue = {
  async send() {
    throw new GitHubIntegrationError('not-configured', 'GitHubSyncQueueNotConfigured', 'The GitHub sync queue is not configured.')
  },
}
