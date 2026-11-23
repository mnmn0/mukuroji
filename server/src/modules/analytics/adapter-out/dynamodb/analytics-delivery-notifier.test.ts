import { expect, test } from 'bun:test'
import type { PutCommand } from '@aws-sdk/lib-dynamodb'
import type { AnalyticsReport } from '@mukuroji/contracts'
import type { AnalyticsDeliveryNotification, AnalyticsDeliveryReceipt } from '../../analytics'
import {
  ANALYTICS_REPORT_DELIVERED_EVENT_TYPE,
  createAnalyticsDeliveryAuditEvent,
  createAnalyticsDeliveryAuditNotifier,
  createAnalyticsSnapshotDeepLink,
} from './analytics-delivery-notifier'

const DELIVERED_AT = '2026-07-18T08:00:12.000Z'

/**
 * Creates one recipient delivery for a saved report.
 *
 * @param overrides - Report fields changed for the focused scenario.
 * @param recipientMemberKey - Recipient who passed the current ACL check.
 * @returns A delivery notification input.
 */
function createDelivery(
  overrides: Partial<AnalyticsReport> = {},
  recipientMemberKey = 'recipient@example.com',
): AnalyticsDeliveryNotification {
  const report: AnalyticsReport = {
    schemaVersion: 1,
    id: 'weekly-report',
    workspaceId: 'workspace-1',
    name: 'Weekly portfolio',
    visibility: 'shared',
    ownerMemberKey: 'owner@example.com',
    timeZone: 'Asia/Tokyo',
    revision: 3,
    filter: { period: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z' } },
    widgets: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
  const receipt: AnalyticsDeliveryReceipt = {
    workspaceId: report.workspaceId,
    reportId: report.id,
    occurrenceKey: `2026-07-18T08:00:00.000Z#definition#${recipientMemberKey}`,
    reportRevision: report.revision,
    format: 'pdf',
    snapshotId: 'snapshot-1',
    recipientMemberKeys: [recipientMemberKey],
    createdAt: '2026-07-18T08:00:00.000Z',
  }
  return {
    report,
    snapshotId: receipt.snapshotId,
    receipt,
    recipientMemberKey,
    deliveredAt: DELIVERED_AT,
  }
}

test('builds a recipient-scoped outbox event with a snapshot deep link', () => {
  const event = createAnalyticsDeliveryAuditEvent(createDelivery(), 30)

  expect(event).toMatchObject({
    directoryId: 'workspace-1',
    eventType: ANALYTICS_REPORT_DELIVERED_EVENT_TYPE,
    entity: { type: 'analytics-report', id: 'weekly-report' },
    target: { type: 'analytics-snapshot', id: 'snapshot-1' },
    occurredAt: DELIVERED_AT,
    outboxStatus: 'pending',
    metadata: {
      actorMemberKey: 'system',
      deepLink: '/reports?v=1&report=weekly-report&snapshot=snapshot-1',
      notificationTitle: 'Weekly portfolio',
      notificationCandidates: [{ memberKey: 'recipient@example.com', reason: 'report-recipient' }],
    },
  })
  // A shared report carries no Team, so delivery is not narrowed to one Team's members.
  expect(event.metadata).not.toHaveProperty('teamId')
})

test('carries the Team of a Team report so external delivery re-checks Team access', () => {
  const event = createAnalyticsDeliveryAuditEvent(
    createDelivery({ visibility: 'team', teamId: 'core-team' }),
    30,
  )

  expect(event.metadata).toMatchObject({ teamId: 'core-team' })
})

test('carries the Team and Project of a Project report so external delivery re-checks Project access', () => {
  const event = createAnalyticsDeliveryAuditEvent(
    createDelivery({ visibility: 'project', teamId: 'core-team', projectId: 'refero' }),
    30,
  )

  expect(event.metadata).toMatchObject({ teamId: 'core-team', projectId: 'refero' })
})

test('derives one stable event ID per occurrence and recipient', () => {
  const first = createAnalyticsDeliveryAuditEvent(createDelivery(), 30)
  const retried = createAnalyticsDeliveryAuditEvent(
    { ...createDelivery(), deliveredAt: '2026-07-18T08:05:12.000Z' },
    30,
  )
  const otherRecipient = createAnalyticsDeliveryAuditEvent(
    createDelivery({}, 'other@example.com'),
    30,
  )

  expect(retried.eventId).toBe(first.eventId)
  expect(otherRecipient.eventId).not.toBe(first.eventId)
})

test('accepts the longest report ID allowed by the report contract', () => {
  const longReportId = `r${'x'.repeat(127)}`

  expect(() => createAnalyticsDeliveryAuditEvent(createDelivery({ id: longReportId }), 30)).not.toThrow()
})

test('writes the event conditionally and treats a duplicate retry as delivered', async () => {
  const commands: PutCommand[] = []
  let duplicate = false
  const notifier = createAnalyticsDeliveryAuditNotifier({
    auditEventsTableName: 'audit-events',
    auditRetentionDays: 30,
    documentClient: {
      async send(command: PutCommand) {
        commands.push(command)
        if (duplicate) {
          const error = new Error('The conditional request failed')
          error.name = 'ConditionalCheckFailedException'
          throw error
        }
        return {}
      },
    },
  })

  await notifier(createDelivery())
  duplicate = true
  await notifier(createDelivery())

  expect(commands).toHaveLength(2)
  expect(commands[0]?.input).toMatchObject({
    TableName: 'audit-events',
    ConditionExpression: 'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
  })
  expect(commands[1]?.input.Item?.eventId).toBe(commands[0]?.input.Item?.eventId)
})

test('propagates other audit write failures so the occurrence is retried', async () => {
  const notifier = createAnalyticsDeliveryAuditNotifier({
    auditEventsTableName: 'audit-events',
    auditRetentionDays: 30,
    documentClient: {
      async send() {
        throw new Error('Throughput exceeded')
      },
    },
  })

  await expect(notifier(createDelivery())).rejects.toThrow('Throughput exceeded')
})

test('encodes report and snapshot IDs in the Reports deep link', () => {
  expect(createAnalyticsSnapshotDeepLink('report a', 'snap&1'))
    .toBe('/reports?v=1&report=report+a&snapshot=snap%261')
})
