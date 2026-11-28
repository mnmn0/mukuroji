import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { createSqsClient } from '../../infrastructure/aws/sqs-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { getConfiguredAuditTableName, type MutationAuditContext } from '../../modules/audit'
import {
  CachedGitHubAppCredentialSource,
  createGitHubReconcileHandler,
  createGitHubSyncQueueHandler,
  DynamoDbGitHubIntegrationStore,
  GitHubAppHttpGateway,
  GitHubIntegrationError,
  InMemoryGitHubIntegrationStore,
  InMemoryGitHubSyncQueue,
  SqsGitHubSyncQueue,
  type GitHubAppCredentialSource,
  type GitHubAppGateway,
  type GitHubIntegrationStore,
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

/**
 * Creates the GitHub sync worker entrypoints.
 *
 * @param dependencies - Adapters.
 * @returns The SQS handler and the hourly reconcile handler.
 */
export function createGitHubSyncWorkerHandlers(dependencies: GitHubIntegrationDependencies = createProductionGitHubIntegrationDependencies()) {
  const workspaceId = dependencies.workspaceId
  if (!workspaceId) throw new Error('GitHub sync worker requires MUKUROJI_WORKSPACE_DIRECTORY_ID.')
  const worker = {
    store: dependencies.store,
    gateway: dependencies.gateway,
    queue: dependencies.queue,
    workspaceId,
    now: () => new Date(),
    log: (message: string, details: Record<string, unknown>) => console.info(JSON.stringify({ message, ...details })),
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
