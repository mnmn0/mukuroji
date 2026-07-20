import { SQSClient } from '@aws-sdk/client-sqs'
import {
  createProductionAppDependencies,
  requireConfiguredConnectorSyncEngine,
  runWithAppDependencies,
} from '../app/createApp'
import {
  createConnectorEventHandlers,
} from '../modules/developer-platform/adapter-in/events/connector-events'
import {
  DynamoDbDeveloperPlatformClient,
} from '../modules/developer-platform/developer-platform'
import {
  DynamoDbConnectorPollCheckpointStore,
  DynamoDbConnectorPollInventory,
} from '../modules/developer-platform/connector-sync-aws'
import {
  SqsConnectorSyncQueue,
} from '../modules/developer-platform/connector-sync-worker'

let connectorEventHandlers: ReturnType<typeof createConnectorEventHandlers> | undefined

/** Warm invocation で共有する connector handler composition を遅延生成します。 */
function getConnectorEventHandlers() {
  if (connectorEventHandlers) return connectorEventHandlers
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
  connectorEventHandlers = createConnectorEventHandlers({
    platform: new DynamoDbDeveloperPlatformClient(),
    getEngine: requireConfiguredConnectorSyncEngine,
    queue: new SqsConnectorSyncQueue(sqsClient, queueUrl),
    checkpoints: new DynamoDbConnectorPollCheckpointStore(),
    inventory: new DynamoDbConnectorPollInventory(),
  })
  return connectorEventHandlers
}

/** ID-only connector sync SQS batch handler です。 */
export const queueHandler = (...args: Parameters<
  ReturnType<typeof createConnectorEventHandlers>['queueHandler']
>) => {
  const dependencies = createProductionAppDependencies()
  return runWithAppDependencies(
    dependencies,
    () => getConnectorEventHandlers().queueHandler(...args),
  )
}

/** AuditEvents stream connector projection handler です。 */
export const auditProjectionHandler = (...args: Parameters<
  ReturnType<typeof createConnectorEventHandlers>['auditProjectionHandler']
>) => {
  const dependencies = createProductionAppDependencies()
  return runWithAppDependencies(
    dependencies,
    () => getConnectorEventHandlers().auditProjectionHandler(...args),
  )
}

/** Connector global inventory schedule handler です。 */
export const pollHandler = (...args: Parameters<
  ReturnType<typeof createConnectorEventHandlers>['pollHandler']
>) => {
  const dependencies = createProductionAppDependencies()
  return runWithAppDependencies(
    dependencies,
    () => getConnectorEventHandlers().pollHandler(...args),
  )
}

export * from '../modules/developer-platform/adapter-in/events/connector-events'
