import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  authorizeNotificationDelivery,
  createNotificationDeliveryAuthorizationCache,
  isCurrentPlanningMilestoneNotification,
  readMemberAccessExpiryNoticeFence,
  readTimesheetReminderFence,
  readWeeklyReportReminderFence,
  type AuditProjectionEvent,
  type PlanningMilestoneNotificationRevalidator,
  type TimesheetReminderRevalidator,
  type WeeklyReportReminderRevalidator,
} from '../../modules/collaboration/adapter-in/events/collaboration-projection'
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
  /**
   * Rereads a timesheet reminder's entries before it is sent; without it every timesheet reminder
   * is suppressed, so a reminder for a submitted timesheet is never sent.
   */
  timesheetReminders?: TimesheetReminderRevalidator
  /**
   * Rereads a weekly report reminder's week before it is sent; without it every weekly report
   * reminder and escalation is suppressed, so a reminder for a submitted week is never sent.
   */
  weeklyReportReminders?: WeeklyReportReminderRevalidator
  /**
   * Rereads a Milestone notification's Milestone and the recipient's watch before it is sent;
   * without it every Milestone notification is suppressed.
   */
  planningMilestones?: PlanningMilestoneNotificationRevalidator
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
    const event = toDeliveryProjectionEvent(delivery)
    // The member may have submitted the entries while quiet hours or a digest held the message.
    if (!(await readTimesheetReminderFence(event, tables.timesheetReminders)).current) return false
    // Likewise the author may have submitted the weekly report since the schedule scanned the week.
    if (!(await readWeeklyReportReminderFence(event, tables.weeklyReportReminders)).current) return false
    // An admin may have cleared or moved the member's access expiry since the notice was queued.
    if (!(await readMemberAccessExpiryNoticeFence(event)).current) return false
    // A Milestone may have been archived or moved, or the recipient may have stopped watching it.
    if (!await isCurrentPlanningMilestoneNotification(event, tables.planningMilestones, delivery.memberKey)) return false
    return authorizeNotificationDelivery(event, delivery.memberKey, enterpriseIdentity, createNotificationDeliveryAuthorizationCache(),
    (request) => documents.get(request), (workspaceId, teamId, entryId) => triage.getEntry(workspaceId, teamId, entryId), readApproval)
  }
}

/**
 * Rebuilds the projection event a queued delivery was saved from, for the delivery-time rechecks.
 * @param delivery - Queued external-channel delivery.
 * @returns The event fields the authorization and the timesheet, weekly report, and access expiry fences read.
 */
export function toDeliveryProjectionEvent(delivery: ChannelDelivery): AuditProjectionEvent {
  const notification = delivery.notification
  return {
    ...notification,
    workspaceId: delivery.workspaceId,
    notificationCandidates: notification.reasons.map((reason) => ({ memberKey: delivery.memberKey, reason })),
    dueDate: delivery.dueDate,
    workItemUpdatedAt: delivery.workItemUpdatedAt,
    daysUntilDue: delivery.daysUntilDue,
    workItemReopenedAt: delivery.workItemReopenedAt,
    weeklyReportAuthorMemberKey: delivery.weeklyReportAuthorMemberKey,
    weeklyReportWeekStart: delivery.weeklyReportWeekStart,
    accessExpiryMemberKey: delivery.accessExpiryMemberKey,
    accessExpiresAt: delivery.accessExpiresAt,
    timeEntryIds: delivery.timeEntryIds,
    timesheetDueBefore: delivery.timesheetDueBefore,
    targetId: delivery.targetId,
    fileId: delivery.fileId,
    outboxStatus: 'pending',
  }
}
