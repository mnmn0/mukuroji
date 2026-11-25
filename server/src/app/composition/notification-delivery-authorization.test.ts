import { expect, test } from 'bun:test'
import { MEMBER_ACCESS_EXPIRING_EVENT_TYPE, type ChannelDelivery } from '../../modules/notifications'
import { toDeliveryProjectionEvent } from './notification-delivery-authorization'

test('carries an access expiry notice\'s member and expiry to the delivery-time recheck', () => {
  const delivery: ChannelDelivery = {
    workspaceId: 'workspace-1',
    memberKey: 'lead@example.com',
    recipientKey: 'workspace-1#lead@example.com',
    notificationKey: '2026-11-24T00:00:00.000Z#event-1',
    attempts: 0,
    version: 1,
    nextAttemptAt: '2026-11-24T00:00:00.000Z',
    expiresAt: 2_000_000_000,
    accessExpiryMemberKey: 'guest@example.com',
    accessExpiresAt: '2026-11-28T00:00:00.000Z',
    notification: {
      id: 'notification-1',
      eventId: 'event-1',
      eventType: MEMBER_ACCESS_EXPIRING_EVENT_TYPE,
      reasons: ['member-access-expiry'],
      teamId: 'core',
      projectId: 'platform',
      occurredAt: '2026-11-24T00:00:00.000Z',
      state: 'unread',
    },
  }

  expect(toDeliveryProjectionEvent(delivery)).toMatchObject({
    eventType: MEMBER_ACCESS_EXPIRING_EVENT_TYPE,
    accessExpiryMemberKey: 'guest@example.com',
    accessExpiresAt: '2026-11-28T00:00:00.000Z',
    notificationCandidates: [{ memberKey: 'lead@example.com', reason: 'member-access-expiry' }],
  })
})
