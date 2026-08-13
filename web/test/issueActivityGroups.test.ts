import { describe, expect, test } from 'bun:test'
import type { TeamIssueActivityEvent } from '../src/issues/api'
import { groupIssueActivity } from '../src/issues/model/activityGroups'

/**
 * Creates one deterministic activity fixture.
 *
 * @param id - Stable event ID.
 * @param eventType - Audit event type.
 * @param actorUserId - Actor identifier.
 * @param occurredAtSecond - Second offset used to order the fixture.
 * @returns Activity event fixture.
 */
function createEvent(
  id: string,
  eventType: string,
  actorUserId = 'demo@example.com',
  occurredAtSecond = 0,
): TeamIssueActivityEvent {
  return {
    actorUserId,
    eventId: id,
    eventType,
    occurredAt: `2026-08-09T00:00:${String(occurredAtSecond).padStart(2, '0')}.000Z`,
  }
}

describe('issue activity grouping', () => {
  test('merges consecutive system updates across a flattened page boundary', () => {
    const groups = groupIssueActivity([
      createEvent('system-1', 'work-item.updated', 'system:workflow', 1),
      createEvent('system-2', 'work-item.updated', 'system:workflow', 2),
      createEvent('comment-1', 'comment.created', 'demo@example.com', 3),
      createEvent('system-3', 'custom.changed', 'system:automation', 4),
      createEvent('system-4', 'custom.changed', 'system:automation', 5),
    ])

    expect(groups).toHaveLength(3)
    expect(groups[0]?.kind).toBe('system-group')
    expect(groups[0]?.kind === 'system-group' ? groups[0].events : []).toHaveLength(2)
    expect(groups[1]?.kind).toBe('event')
    expect(groups[2]?.kind === 'system-group' ? groups[2].events : []).toHaveLength(2)
  })

  test('keeps user events distinct even when their types match', () => {
    const groups = groupIssueActivity([
      createEvent('comment-1', 'comment.created', 'demo@example.com', 1),
      createEvent('comment-2', 'comment.created', 'demo@example.com', 2),
    ])

    expect(groups.map((group) => group.kind)).toEqual(['event', 'event'])
  })

  test('keeps a human Work Item update outside system groups', () => {
    const groups = groupIssueActivity([
      createEvent('system-1', 'work-item.updated', 'system:workflow', 1),
      createEvent('human-1', 'work-item.updated', 'demo@example.com', 2),
      createEvent('system-2', 'work-item.updated', 'system:workflow', 3),
    ])

    expect(groups.map((group) => group.kind)).toEqual([
      'system-group',
      'event',
      'system-group',
    ])
  })
})
