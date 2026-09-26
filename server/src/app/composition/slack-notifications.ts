import { randomUUID } from 'node:crypto'
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { authorizeNotificationDelivery } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import { DynamoDbEnterpriseIdentityReadClient } from '../../modules/enterprise-identity'
import { createSlackNotificationSender, deliverDueSlackNotifications, DynamoDbSlackDeliveryStore } from '../../modules/notifications'
import { createProductionTenantAvailability } from './tenant-administration'

/**
 * Creates a scheduled sender for opted-in recipients' durable Inbox notifications.
 * @returns A handler with current tenant authorization and recipient-scoped credentials.
 */
export function createProductionSlackNotificationHandler() {
  const tableName = process.env.NOTIFICATIONS_TABLE_NAME?.trim()
  const identityTableName = process.env.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  if (!tableName || !identityTableName) throw new Error('Slack notification runtime is not configured.')
  const store = new DynamoDbSlackDeliveryStore(createDynamoDbDocumentClient(createDynamoDbClient()), tableName)
  const enterpriseIdentity = new DynamoDbEnterpriseIdentityReadClient(identityTableName)
  const tenant = createProductionTenantAvailability()
  const secrets = createSecretsManagerClient()
  const send = createSlackNotificationSender(async (secretId) => {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }), {
      abortSignal: AbortSignal.timeout(5_000),
    })
    return response.SecretString
  })
  return () => deliverDueSlackNotifications({
    store, send, createToken: randomUUID, now: () => new Date(),
    async isAuthorized(delivery) {
      if (!await tenant.isActive(delivery.workspaceId)) return false
      const notification = delivery.notification
      return authorizeNotificationDelivery({
        ...notification,
        workspaceId: delivery.workspaceId,
        notificationCandidates: notification.reasons.map((reason) => ({ memberKey: delivery.memberKey, reason })),
        dueDate: delivery.dueDate,
        outboxStatus: 'pending',
      }, delivery.memberKey, enterpriseIdentity)
    },
  })
}
