import { SQSClient } from '@aws-sdk/client-sqs'
import { DynamoDbDeveloperPlatformClient } from './developer-platform'
import { requireConfiguredConnectorSyncEngine } from './index'
import {
  DynamoDbConnectorPollCheckpointStore,
  DynamoDbConnectorPollInventory,
} from './connector-sync-aws'
import {
  SqsConnectorSyncQueue,
  processConnectorSyncAuditProjectionBatch,
  processConnectorSyncWorkerBatch,
  scheduleConnectorPollInventory,
  type ConnectorPollScheduleEvent,
  type ConnectorSyncDynamoStreamEvent,
  type ConnectorSyncSqsEvent,
} from './connector-sync-worker'

let platform: DynamoDbDeveloperPlatformClient | undefined
let queue: SqsConnectorSyncQueue | undefined
let checkpoints: DynamoDbConnectorPollCheckpointStore | undefined
let inventory: DynamoDbConnectorPollInventory | undefined
let sqsClient: SQSClient | undefined

/** ID-only connector sync SQS batch を current RBAC と durable checkpoint で処理します。 */
export async function queueHandler(event: ConnectorSyncSqsEvent) {
  return processConnectorSyncWorkerBatch(event, {
    platform: getPlatform(),
    engine: await requireConfiguredConnectorSyncEngine(),
    queue: getQueue(),
    checkpoints: getCheckpoints(),
    inventory: getInventory(),
    maximumPollPages: 10,
    maximumInventoryPages: 100,
  })
}

/** AuditEvents stream の Work Item changes を ID-only connector jobs へ射影します。 */
export async function auditProjectionHandler(
  event: ConnectorSyncDynamoStreamEvent,
) {
  return processConnectorSyncAuditProjectionBatch(event, { queue: getQueue() })
}

/** Global sparse link inventory を列挙して bounded polling jobs を enqueue します。 */
export async function pollHandler(event: ConnectorPollScheduleEvent = {}) {
  return scheduleConnectorPollInventory(event, {
    inventory: getInventory(),
    queue: getQueue(),
    maximumPages: 100,
  })
}

function getPlatform() {
  platform ??= new DynamoDbDeveloperPlatformClient()
  return platform
}

function getQueue() {
  if (queue) return queue
  const queueUrl = process.env.CONNECTOR_SYNC_QUEUE_URL?.trim()
  if (!queueUrl) {
    throw new TypeError('Connector sync queue is not configured.')
  }
  queue = new SqsConnectorSyncQueue(getSqsClient(), queueUrl)
  return queue
}

function getCheckpoints() {
  checkpoints ??= new DynamoDbConnectorPollCheckpointStore()
  return checkpoints
}

function getInventory() {
  inventory ??= new DynamoDbConnectorPollInventory()
  return inventory
}

function getSqsClient() {
  if (sqsClient) return sqsClient
  const endpoint = process.env.SQS_ENDPOINT ?? process.env.AWS_ENDPOINT_URL_SQS ??
    process.env.AWS_ENDPOINT_URL
  sqsClient = new SQSClient({
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
  return sqsClient
}
