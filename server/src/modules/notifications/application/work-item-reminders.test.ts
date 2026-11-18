import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import {
  DEFAULT_WORK_ITEM_REMINDER_POLICY,
  evaluateScheduledWorkItemNotifications,
  normalizeWorkItemReminderPolicy,
  parseUtcDateOnly,
} from './work-item-reminders'

/** Creates a canonical started Work Item due on the given date in a UTC calendar. */
function createWorkItem(dueDate: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#platform',
    teamId: 'core-team',
    assignedProjectId: 'platform',
    issueId: 'release-checklist',
    sortOrder: 10,
    title: 'Release checklist',
    assigneeUserId: 'Member@Example.com',
    creatorMemberKey: 'creator@example.com',
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate,
    schedule: {
      calendarPolicy: {
        holidays: [],
        timeZone: 'UTC',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
      dueDate,
      mode: 'due-date',
    },
    priority: 'medium',
    createdAt: '2026-07-01T09:00:00.000Z',
    updatedAt: '2026-07-11T09:00:00.000Z',
    ...overrides,
  }
}

const now = new Date('2026-07-12T09:00:00.000Z')

describe('scheduled Work Item reminders', () => {
  test('parses only valid canonical UTC date-only values', () => {
    expect(parseUtcDateOnly('2026/07/12')).toBeUndefined()
    expect(parseUtcDateOnly('2026-07-12')).toBe('2026-07-12')
    expect(parseUtcDateOnly('2024-02-29')).toBe('2024-02-29')
    expect(parseUtcDateOnly('1000-01-01')).toBe('1000-01-01')
    expect(parseUtcDateOnly('0999-12-31')).toBeUndefined()
    expect(parseUtcDateOnly('2026-02-29')).toBeUndefined()
    expect(parseUtcDateOnly('2026-02/28')).toBeUndefined()
    expect(parseUtcDateOnly('2026/13/01')).toBeUndefined()
    expect(parseUtcDateOnly('2026/07/12T00:00:00Z')).toBeUndefined()
  })

  test('picks the stage from the days until the due date in the Work Item calendar', () => {
    const stages = (dueDate: string) => {
      const evaluation = evaluateScheduledWorkItemNotifications(createWorkItem(dueDate), now)
      return {
        owner: evaluation.candidates.map((candidate) => candidate.reason),
        escalation: evaluation.escalation?.reason,
      }
    }

    expect(stages('2026-07-16')).toEqual({ owner: [], escalation: undefined })
    expect(stages('2026-07-15')).toEqual({ owner: ['due-soon'], escalation: undefined })
    expect(stages('2026-07-12')).toEqual({ owner: ['due'], escalation: undefined })
    expect(stages('2026-07-06')).toEqual({ owner: ['overdue'], escalation: undefined })
    expect(stages('2026-07-05')).toEqual({
      owner: ['overdue', 'overdue-reminder'],
      escalation: 'overdue-escalation',
    })
  })

  test('carries the reopen time on the escalation only', () => {
    const evaluation = evaluateScheduledWorkItemNotifications(
      createWorkItem('2026-07-05', { reopenedAt: '2026-07-10T09:00:00.000Z' }),
      now,
    )

    expect(evaluation.escalation?.reopenedAt).toBe('2026-07-10T09:00:00.000Z')
    expect(evaluation.candidates.every((candidate) => candidate.reopenedAt === undefined)).toBe(true)
  })

  test('skips closed Work Items and rejects non-canonical rows', () => {
    for (const overrides of [
      { statusCategory: 'completed' },
      { statusCategory: 'canceled' },
      { archivedAt: '2026-07-11T09:00:00.000Z', archivedBy: 'member@example.com' },
    ]) {
      expect(evaluateScheduledWorkItemNotifications(createWorkItem('2026-07-05', overrides), now))
        .toEqual({ candidates: [] })
    }
    expect(() => evaluateScheduledWorkItemNotifications({ issueId: 'not-a-work-item' }, now))
      .toThrow(TypeError)
  })

  test('fills omitted thresholds with defaults and rejects out-of-range values', () => {
    expect(normalizeWorkItemReminderPolicy(undefined)).toEqual(DEFAULT_WORK_ITEM_REMINDER_POLICY)
    expect(normalizeWorkItemReminderPolicy({ dueSoonDays: 5 }))
      .toEqual({ ...DEFAULT_WORK_ITEM_REMINDER_POLICY, dueSoonDays: 5 })
    for (const dueSoonDays of [0, 366, 1.5]) {
      expect(() => normalizeWorkItemReminderPolicy({ dueSoonDays })).toThrow(RangeError)
    }
  })
})
