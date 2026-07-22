import { SQSClient } from '@aws-sdk/client-sqs'
import {
  requireConfiguredConnectorSyncEngine,
} from '../../api/api-router'
import { createConnectorEventHandlers } from '../../modules/developer-platform/adapter-in/events/connector-events'
import { DynamoDbDeveloperPlatformClient } from '../../modules/developer-platform/developer-platform'
import {
  DynamoDbConnectorPollCheckpointStore,
  DynamoDbConnectorPollInventory,
} from '../../modules/developer-platform/connector-sync-aws'
import { SqsConnectorSyncQueue } from '../../modules/developer-platform/connector-sync-worker'

/**
 * Creates production Connector queue, projection, and polling handlers.
 *
 * @returns Connector handlers bound only to their queue and persistence adapters.
 */
export function createProductionConnectorEventHandlers() {
  const queueUrl = process.env.CONNECTOR_SYNC_QUEUE_URL?.trim()
  if (!queueUrl) {
    throw new TypeError('Connector sync queue is not configured.')
  }
  const endpoint = process.env.SQS_ENDPOINT ?? process.env.AWS_ENDPOINT_URL_SQS ??
    process.env.AWS_ENDPOINT_URL
  const sqsClient = new SQSClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
  return createConnectorEventHandlers({
    platform: new DynamoDbDeveloperPlatformClient(),
    getEngine: requireConfiguredConnectorSyncEngine,
    queue: new SqsConnectorSyncQueue(sqsClient, queueUrl),
    checkpoints: new DynamoDbConnectorPollCheckpointStore(),
    inventory: new DynamoDbConnectorPollInventory(),
  })

}
