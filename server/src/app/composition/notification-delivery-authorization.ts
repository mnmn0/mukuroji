import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { authorizeNotificationDelivery, createNotificationDeliveryAuthorizationCache } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import { DynamoDbEnterpriseIdentityReadClient } from '../../modules/enterprise-identity'
import { DynamoDbDocumentsClient } from '../../modules/documents/adapter-out/dynamodb/dynamo-db-documents-client'
import { DynamoDbTriageClient } from '../../modules/triage'
import { createApprovalNotificationReader } from '../../modules/files/adapter-out/dynamodb/approval-notification-reader'
import type { ChannelDelivery } from '../../modules/notifications'
import { createProductionTenantAvailability } from './tenant-administration'

/** Tables the external-delivery authorizer reads beyond the shared projection environment. */
export type NotificationDeliveryAuthorizationTables = {
  /** Enterprise identity table. */
  identityTableName: string
  /** File proofing table that holds approval targets. */
  fileTableName: string
}

/**
 * Creates the production recheck shared by every external notification channel.
 * @param documentClient - DynamoDB document client configured by the composition root.
 * @param tables - Enterprise identity and file proofing table names.
 * @returns Authorizer that rechecks tenant availability and the recipient's current source visibility.
 */
export function createProductionNotificationDeliveryAuthorizer(
  documentClient: DynamoDBDocumentClient,
  tables: NotificationDeliveryAuthorizationTables,
): (delivery: ChannelDelivery) => Promise<boolean> {
  const readApproval = createApprovalNotificationReader(documentClient, tables.fileTableName)
  const enterpriseIdentity = new DynamoDbEnterpriseIdentityReadClient(tables.identityTableName)
  const documents = new DynamoDbDocumentsClient({ autoCreateLocal: false })
  const triage = new DynamoDbTriageClient()
  const tenant = createProductionTenantAvailability()
  return async (delivery) => {
    if (!await tenant.isActive(delivery.workspaceId)) return false
    const notification = delivery.notification
    return authorizeNotificationDelivery({
      ...notification,
      workspaceId: delivery.workspaceId,
      notificationCandidates: notification.reasons.map((reason) => ({ memberKey: delivery.memberKey, reason })),
      dueDate: delivery.dueDate,
      workItemUpdatedAt: delivery.workItemUpdatedAt,
      daysUntilDue: delivery.daysUntilDue,
      workItemReopenedAt: delivery.workItemReopenedAt,
      weeklyReportAuthorMemberKey: delivery.weeklyReportAuthorMemberKey,
      targetId: delivery.targetId,
      fileId: delivery.fileId,
      outboxStatus: 'pending',
    }, delivery.memberKey, enterpriseIdentity, createNotificationDeliveryAuthorizationCache(),
    (request) => documents.get(request), (workspaceId, teamId, entryId) => triage.getEntry(workspaceId, teamId, entryId), readApproval)
  }
}
