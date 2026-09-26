import { randomUUID } from 'node:crypto'
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { authorizeNotificationDelivery, createNotificationDeliveryAuthorizationCache } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import { DynamoDbEnterpriseIdentityReadClient } from '../../modules/enterprise-identity'
import { DynamoDbDocumentsClient } from '../../modules/documents/adapter-out/dynamodb/dynamo-db-documents-client'
import { DynamoDbTriageClient } from '../../modules/triage'
import { createApprovalNotificationReader } from '../../modules/files/adapter-out/dynamodb/approval-notification-reader'
import { createSlackDeliveryTelemetry, createSlackNotificationSender, deliverDueSlackNotifications } from '../../modules/notifications'
import { DynamoDbSlackDeliveryStore } from '../../modules/notifications/adapter-out/dynamodb/slack-delivery-store'
import { createProductionTenantAvailability } from './tenant-administration'

/**
 * Creates a scheduled sender for opted-in recipients' durable Inbox notifications.
 * @returns A handler with current tenant authorization and recipient-scoped credentials.
 */
export function createProductionSlackNotificationHandler() {
  const tableName = process.env.NOTIFICATIONS_TABLE_NAME?.trim()
  const identityTableName = process.env.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const fileTableName = process.env.FILE_PROOFING_TABLE_NAME?.trim()
  if (!tableName || !identityTableName || !fileTableName) throw new Error('Slack notification runtime is not configured.')
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const store = new DynamoDbSlackDeliveryStore(documentClient, tableName)
  const readApproval = createApprovalNotificationReader(documentClient, fileTableName)
  const enterpriseIdentity = new DynamoDbEnterpriseIdentityReadClient(identityTableName)
  const documents = new DynamoDbDocumentsClient({ autoCreateLocal: false })
  const triage = new DynamoDbTriageClient()
  const tenant = createProductionTenantAvailability()
  const secrets = createSecretsManagerClient()
  const send = createSlackNotificationSender(async (secretId) => {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }), {
      abortSignal: AbortSignal.timeout(5_000),
    })
    return response.SecretString
  })
  return () => {
    return deliverDueSlackNotifications({
      store, send, telemetry: createSlackDeliveryTelemetry(), createToken: randomUUID, now: () => new Date(),
      /** Rechecks tenant availability and the recipient's current source visibility. */
      async isAuthorized(delivery) {
        if (!await tenant.isActive(delivery.workspaceId)) return false
        const notification = delivery.notification
        return authorizeNotificationDelivery({
          ...notification,
          workspaceId: delivery.workspaceId,
          notificationCandidates: notification.reasons.map((reason) => ({ memberKey: delivery.memberKey, reason })),
          dueDate: delivery.dueDate,
          targetId: delivery.targetId,
          fileId: delivery.fileId,
          outboxStatus: 'pending',
        }, delivery.memberKey, enterpriseIdentity, createNotificationDeliveryAuthorizationCache(),
        (request) => documents.get(request), (workspaceId, teamId, entryId) => triage.getEntry(workspaceId, teamId, entryId), readApproval)
      },
    })
  }
}
