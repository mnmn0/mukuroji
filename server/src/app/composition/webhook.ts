import {
  createQueueWebhookDeliveryMessage,
  createSqsWebhookDeliveryQueue,
  createWebhookDeliveryHandler,
  createWebhookProjectionHandler,
  deliverPreparedWebhook,
  DynamoDbWebhookAuditEventReader,
  DynamoDbWebhookDeliveryClaimStore,
  DynamoDbWebhookGrantCleanupStore,
  DynamoDbWebhookProjectionStateStore,
  type WebhookDeliveryQueue,
} from '../../modules/developer-platform/adapter-in/events/webhook-processing'
import { createDynamoDbDeveloperPlatformAdapters } from '../../modules/developer-platform/adapter-out/dynamodb/developer-platform-adapters'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../../modules/documents/adapter-out/dynamodb/document-authorization'
import {
  DynamoDbWebhookSubscriptionAuthorizer,
} from '../../modules/developer-platform/webhook-authorization'
import {
  DynamoDbEnterpriseIdentityReadClient,
} from '../../modules/enterprise-identity'
import {
  DynamoDbWorkspaceAccessClient,
} from '../../modules/workspace-access/workspace-access'

/**
 * Production Webhook SQS queue adapter を作成します。
 */
export function createProductionWebhookQueue(): WebhookDeliveryQueue {
  return createSqsWebhookDeliveryQueue()
}

/**
 * Audit event stream 用 Webhook projection handler を組み立てます。
 */
export function createProductionWebhookProjectionHandler(
  queue = createProductionWebhookQueue(),
) {
  return createWebhookProjectionHandler({ queue })
}

/**
 * Webhook delivery SQS handler を組み立てます。
 */
export function createProductionWebhookDeliveryHandler(
  queue = createProductionWebhookQueue(),
) {
  const adapters = createDynamoDbDeveloperPlatformAdapters()
  return createWebhookDeliveryHandler({
    auditEvents: new DynamoDbWebhookAuditEventReader(),
    developerPlatform: {
      enqueueWebhookEvent: (request) =>
        adapters.webhookDeliveries.enqueueWebhookEvent(request),
      listWebhookDeliveries: (request) =>
        adapters.webhookDeliveries.listWebhookDeliveries(request),
      getWebhookDelivery: (request) =>
        adapters.webhookDeliveries.getWebhookDelivery(request),
      prepareWebhookDelivery: (request) =>
        adapters.webhookDeliveries.prepareWebhookDelivery(request),
      recordWebhookDeliveryAttempt: (request) =>
        adapters.webhookDeliveries.recordWebhookDeliveryAttempt(request),
      replayWebhookDelivery: (request) =>
        adapters.webhookDeliveries.replayWebhookDelivery(request),
      listActiveWebhookSubscriptionsPage: (request) =>
        adapters.webhookSubscriptions.listActiveWebhookSubscriptionsPage(request),
    },
    authorizer: new DynamoDbWebhookSubscriptionAuthorizer({
      workspaceAccess: new DynamoDbWorkspaceAccessClient({
        documentAuthorizationRevisionMutationPort:
          new DynamoDbDocumentAuthorizationRevisionMutationAdapter(),
      }),
      enterpriseIdentity: new DynamoDbEnterpriseIdentityReadClient(
        readRequiredEnvironment('ENTERPRISE_IDENTITY_TABLE_NAME'),
      ),
    }),
    projections: new DynamoDbWebhookProjectionStateStore(),
    grantCleanup: new DynamoDbWebhookGrantCleanupStore(),
    queue,
    claims: new DynamoDbWebhookDeliveryClaimStore(),
    deliver: deliverPreparedWebhook,
    now: () => new Date(),
    random: Math.random,
  })
}

/**
 * API replay 用 Webhook enqueue operation を組み立てます。
 */
export function createProductionQueueWebhookDeliveryMessage(
  queue = createProductionWebhookQueue(),
) {
  return createQueueWebhookDeliveryMessage(queue)
}

function readRequiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new TypeError(`${name} is required by the Webhook delivery worker.`)
  }
  return value
}
