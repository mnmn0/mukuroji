import { expect, test } from 'bun:test'
import { createRequestRequesterNotificationTransactItems } from './requester-notifications'

/**
 * Builds the notification items for one requester value.
 *
 * @param requesterUserId - Stored requester member key.
 * @returns The audit outbox items.
 */
function build(requesterUserId: string | undefined) {
  return createRequestRequesterNotificationTransactItems({
    auditTableName: 'audit',
    auditRetentionDays: 30,
    workspaceId: 'workspace-1',
    submissionId: 'req-1',
    ...(requesterUserId === undefined ? {} : { requesterUserId }),
    formTitle: 'IT request',
    kind: 'rejected',
    actorId: 'manager@example.com',
    occurredAt: '2026-07-16T09:00:00.000Z',
    occurrenceId: 'event-1',
  })
}

test('notifies members whose email holds any printable character', () => {
  for (const memberKey of ["O'Connor@example.com", 'alice=ops@example.com', 'a+b@example.com']) {
    const items = build(memberKey)
    expect(items).toHaveLength(1)
    expect(JSON.stringify(items)).toContain(JSON.stringify(memberKey.toLowerCase()).slice(1, -1))
  }
})

test('writes nothing for an anonymous request or a key with whitespace', () => {
  expect(build(undefined)).toEqual([])
  expect(build('two words@example.com')).toEqual([])
  expect(build('line\nbreak@example.com')).toEqual([])
})
