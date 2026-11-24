import { createHash } from 'node:crypto'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { createNotificationMessage, formatNotificationMessage } from '@mukuroji/contracts'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createMutationAuditContext,
  type AuditEventV1,
} from '../../../audit'
import type {
  AnalyticsDeliveryNotification,
  AnalyticsDeliveryNotifier,
} from '../../analytics'

/** Audit event type that the collaboration projection turns into a recipient notification. */
export const ANALYTICS_REPORT_DELIVERED_EVENT_TYPE = 'analytics.report.delivered'

/** Notification reason recorded for a scheduled report recipient. */
export const ANALYTICS_REPORT_RECIPIENT_REASON = 'report-recipient'

const analyticsScheduleActorId = 'system:analytics-schedule'
const analyticsScheduleRoute = '/internal/analytics-schedule'

/** Settings for the audit-outbox delivery notifier. */
export type AnalyticsDeliveryAuditNotifierOptions = {
  /** DocumentClient that writes the audit outbox row. */
  documentClient: {
    /** Sends the conditional audit outbox put. */
    send(command: PutCommand): Promise<unknown>
  }
  /** Audit events table whose stream feeds the collaboration projection. */
  auditEventsTableName: string
  /** Audit retention period used for the event TTL. */
  auditRetentionDays: number
}

/**
 * Creates a notifier that emits one audit outbox event per recipient delivery.
 *
 * The collaboration projection turns the event into an Inbox row (and Slack or Email when the
 * recipient opted in), after re-checking the recipient's membership and Team access. The event ID
 * is derived from the receipt occurrence key, so a retry of the same occurrence is a no-op.
 *
 * @param options - Audit table, retention, and DocumentClient.
 * @returns The idempotent delivery notifier.
 */
export function createAnalyticsDeliveryAuditNotifier(
  options: AnalyticsDeliveryAuditNotifierOptions,
): AnalyticsDeliveryNotifier {
  return async (notification) => {
    const auditEvent = createAnalyticsDeliveryAuditEvent(
      notification,
      options.auditRetentionDays,
    )
    try {
      await options.documentClient.send(new PutCommand({
        TableName: options.auditEventsTableName,
        Item: auditEvent,
        ConditionExpression:
          'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
        ExpressionAttributeNames: {
          '#directoryId': 'directoryId',
          '#eventId': 'eventId',
        },
      }))
    } catch (error) {
      // An earlier attempt of the same occurrence already queued the notification.
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return
      throw error
    }
  }
}

/**
 * Builds the deterministic audit outbox event for one recipient delivery.
 *
 * @param notification - Delivered report, snapshot, receipt, and recipient.
 * @param auditRetentionDays - Audit retention period.
 * @returns Immutable schema-v1 audit outbox event.
 */
export function createAnalyticsDeliveryAuditEvent(
  notification: AnalyticsDeliveryNotification,
  auditRetentionDays: number,
): AuditEventV1 {
  const { report, snapshotId, receipt, recipientMemberKey, deliveredAt } = notification
  const context = createMutationAuditContext({
    workspaceId: report.workspaceId,
    actor: {
      id: analyticsScheduleActorId,
      kind: 'system',
      displayName: 'Mukuroji analytics schedule',
    },
    // The occurrence key binds the schedule time, report definition, and recipient. Hashing keeps
    // the key within the audit limit for the longest report IDs.
    idempotencyKey: `analytics-delivery-notification-v1:${createHash('sha256')
      .update(`${report.id}\0${receipt.occurrenceKey}`)
      .digest('hex')}`,
    occurredAt: deliveredAt,
    request: {
      method: 'SCHEDULE',
      path: analyticsScheduleRoute,
      body: {
        reportId: report.id,
        occurrenceKey: receipt.occurrenceKey,
      },
    },
    source: {
      kind: 'system',
      method: 'SCHEDULE',
      route: analyticsScheduleRoute,
    },
  })
  const reportDeliveredMessage = createNotificationMessage('analytics.report-delivered')
  return createAuditEvent({
    context,
    eventType: ANALYTICS_REPORT_DELIVERED_EVENT_TYPE,
    entity: { type: 'analytics-report', id: report.id },
    target: { type: 'analytics-snapshot', id: snapshotId },
    action: 'delivered',
    changes: [],
    summary: formatNotificationMessage(reportDeliveredMessage, 'en'),
    metadata: {
      actorMemberKey: 'system',
      notificationMessage: reportDeliveredMessage,
      // Team and Project reports carry their scope so external delivery re-checks the recipient's
      // access to that Team or Project.
      ...((report.visibility === 'team' || report.visibility === 'project') && report.teamId
        ? { teamId: report.teamId }
        : {}),
      ...(report.visibility === 'project' && report.projectId ? { projectId: report.projectId } : {}),
      deepLink: createAnalyticsSnapshotDeepLink(report.id, snapshotId),
      notificationTitle: report.name,
      analyticsSnapshotId: snapshotId,
      analyticsDeliveryFormat: receipt.format,
      notificationCandidates: [{
        memberKey: recipientMemberKey,
        reason: ANALYTICS_REPORT_RECIPIENT_REASON,
      }],
    },
    expiresAt: calculateAuditExpiresAt(deliveredAt, auditRetentionDays),
    outboxStatus: 'pending',
  })
}

/**
 * Builds the Reports page path that opens one immutable snapshot of a report.
 *
 * @param reportId - Saved report ID.
 * @param snapshotId - Snapshot record ID.
 * @returns A relative application path in the canonical v1 Reports URL schema.
 */
export function createAnalyticsSnapshotDeepLink(reportId: string, snapshotId: string) {
  const search = new URLSearchParams({ v: '1', report: reportId, snapshot: snapshotId })
  return `/reports?${search.toString()}`
}
