import { describe, expect, test } from 'bun:test'
import type { TeamIssueActivityEvent } from '../src/issues/api'
import { groupIssueActivity } from '../src/issues/model/activityGroups'

/**
 * Creates one deterministic activity fixture.
 *
 * @param id - Stable event ID.
 * @param eventType - Audit event type.
 * @param actorUserId - Actor identifier.
 * @returns Activity event fixture.
 */
function createEvent(
  id: string,
  eventType: string,
  actorUserId = 'demo@example.com',
): TeamIssueActivityEvent {
  return {
    actorUserId,
    eventId: id,
    eventType,
    occurredAt: `2026-08-09T00:00:0${id.length}.000Z`,
  }
}

describe('issue activity grouping', () => {
  test('merges consecutive system updates across a flattened page boundary', () => {
    const groups = groupIssueActivity([
      createEvent('system-1', 'work-item.updated', 'system:workflow'),
      createEvent('system-2', 'work-item.updated', 'system:workflow'),
      createEvent('comment-1', 'comment.created'),
      createEvent('system-3', 'custom.changed', 'system:automation'),
      createEvent('system-4', 'custom.changed', 'system:automation'),
    ])

    expect(groups).toHaveLength(3)
    expect(groups[0]?.kind).toBe('system-group')
    expect(groups[0]?.kind === 'system-group' ? groups[0].events : []).toHaveLength(2)
    expect(groups[1]?.kind).toBe('event')
    expect(groups[2]?.kind === 'system-group' ? groups[2].events : []).toHaveLength(2)
  })

  test('keeps user events distinct even when their types match', () => {
    const groups = groupIssueActivity([
      createEvent('comment-1', 'comment.created'),
      createEvent('comment-2', 'comment.created'),
    ])

    expect(groups.map((group) => group.kind)).toEqual(['event', 'event'])
  })

  test('keeps a human Work Item update outside system groups', () => {
    const groups = groupIssueActivity([
      createEvent('system-1', 'work-item.updated', 'system:workflow'),
      createEvent('human-1', 'work-item.updated', 'demo@example.com'),
      createEvent('system-2', 'work-item.updated', 'system:workflow'),
    ])

    expect(groups.map((group) => group.kind)).toEqual([
      'system-group',
      'event',
      'system-group',
    ])
  })
})
