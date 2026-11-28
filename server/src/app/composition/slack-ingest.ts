import { getConfiguredAuditTableName } from '../../modules/audit'
import { createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { createSqsClient } from '../../infrastructure/aws/sqs-client'
import { readServerEnvironment, type ServerEnvironment } from '../../infrastructure/config/server-config'
import { DynamoDbTenantAdministrationClient, TenantAdministrationError } from '../../modules/tenant-administration'
import {
  DynamoDbSlackIngestStore,
  FetchSlackWebApi,
  processSlackIngestBatch,
  SecretsManagerSlackIngestConfigSource,
  SqsSlackIngestQueue,
  unconfiguredSlackIngestConfigSource,
  type SlackIngestBatchResponse,
  type SlackIngestConfigSource,
  type SlackIngestQueue,
  type SlackIngestSqsEvent,
  type SlackIngestStore,
} from '../../modules/slack-ingest'

/** Ports shared by the Slack ingest routes. */
export type SlackIngestDependencies = {
  /** Slack app settings; always not configured where the queue is not deployed. */
  config: SlackIngestConfigSource
  /** Ingest rows. */
  store: SlackIngestStore
  /** Worker queue. */
  queue: SlackIngestQueue
}

/** Queue used where no Slack ingest queue is deployed; the routes answer before reaching it. */
const unavailableQueue: SlackIngestQueue = {
  /**
   * Refuses every job.
   *
   * @returns Never.
   */
  async send() {
    throw new Error('Slack ingest queue is not configured.')
  },
}

/**
 * Creates the production Slack ingest ports of the API.
 *
 * @param environment - Runtime environment.
 * @returns The ports; without `SLACK_INGEST_QUEUE_URL` the receiver reports not configured.
 */
export function createProductionSlackIngestDependencies(
  environment: ServerEnvironment = readServerEnvironment(),
): SlackIngestDependencies {
  const queueUrl = environment.SLACK_INGEST_QUEUE_URL?.trim()
  return {
    config: queueUrl
      ? new SecretsManagerSlackIngestConfigSource(createSecretsManagerClient())
      : unconfiguredSlackIngestConfigSource,
    store: new DynamoDbSlackIngestStore(
      environment.DEVELOPER_PLATFORM_TABLE_NAME ?? 'mukuroji-developer-platform-local',
      createDynamoDbDocumentClient(),
      getConfiguredAuditTableName(),
    ),
    queue: queueUrl ? new SqsSlackIngestQueue(createSqsClient(), queueUrl) : unavailableQueue,
  }
}

/**
 * Creates the production SQS handler of the Slack ingest worker.
 *
 * @param environment - Runtime environment that names the queue and table.
 * @returns The batch handler.
 */
export function createProductionSlackIngestHandler(
  environment: ServerEnvironment = readServerEnvironment(),
): (event: SlackIngestSqsEvent) => Promise<SlackIngestBatchResponse> {
  const queueUrl = environment.SLACK_INGEST_QUEUE_URL?.trim()
  const tableName = environment.DEVELOPER_PLATFORM_TABLE_NAME?.trim()
  const tenantTableName = environment.TENANT_ADMINISTRATION_TABLE_NAME?.trim()
  if (!queueUrl || !tableName || !tenantTableName) throw new Error('Slack ingest worker is not configured.')
  const tenant = new DynamoDbTenantAdministrationClient(tenantTableName, createDynamoDbDocumentClient())
  const ports = {
    config: new SecretsManagerSlackIngestConfigSource(createSecretsManagerClient()),
    store: new DynamoDbSlackIngestStore(tableName, createDynamoDbDocumentClient()),
    queue: new SqsSlackIngestQueue(createSqsClient(), queueUrl),
    createSlackWebApi: (botToken: string) => new FetchSlackWebApi(botToken),
    now: () => new Date(),
    isWorkspaceActive: async (workspaceId: string) => {
      try {
        await tenant.assertActive(workspaceId)
        return true
      } catch (error) {
        if (error instanceof TenantAdministrationError && (error.code === 'TenantClosing' || error.code === 'TenantClosed')) {
          return false
        }
        throw error
      }
    },
  }
  return async (event) => await processSlackIngestBatch(event, ports)
}
