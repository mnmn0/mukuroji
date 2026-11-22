import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  createWorkspaceWorkItemCalendarPolicy,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { ProjectDataError } from '../../../directory'
import {
  applyWorkCalendarChange,
  type WorkCalendarChangeRules,
  type WorkCalendarChangeWorkItem,
  type WorkCalendarScheduleUpdate,
} from './work-calendar-change'

/** Shared Monday-to-Friday calendar without holidays. */
const shared: WorkItemScheduleCalendarPolicy = {
  ...createWorkspaceWorkItemCalendarPolicy(DEFAULT_WORKSPACE_CALENDAR_SETTINGS),
  calendarSource: 'shared',
}

/** The same calendar with one more day off. */
const withHoliday: WorkItemScheduleCalendarPolicy = { ...shared, holidays: [...shared.holidays, '2026-12-09'] }

/**
 * Builds Work Items on the shared calendar.
 *
 * @param count - How many Work Items to build.
 * @returns The Work Items.
 */
function workItems(count: number): WorkCalendarChangeWorkItem[] {
  return Array.from({ length: count }, (_, index) => ({
    teamId: 'team-1',
    id: `item-${String(index).padStart(3, '0')}`,
    title: `Item ${index}`,
    revision: 1,
    schedule: { mode: 'date-range', calendarPolicy: shared, startDate: '2026-12-07', endDate: '2026-12-11', durationDays: 5 },
  }))
}

/** Rules that add the day off to every Work Item. */
const rules: WorkCalendarChangeRules = {
  before: () => shared,
  after: () => withHoliday,
  adjustment: 'keep-end-date',
  includes: () => true,
  canShowExample: () => true,
  adoptLegacy: true,
}

test('stops rewriting once a newer calendar change has been saved', async () => {
  const written: WorkCalendarScheduleUpdate[][] = []
  let version = 'v1'
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(30),
    readCalendarVersion: async () => version,
    async writeSchedules(updates) {
      written.push([...updates])
      // Another member saves the calendar again while the first transaction is written.
      version = 'v2'
    },
  }, async () => ({
    scope: { kind: 'team', teamId: 'team-1' },
    additionalHolidays: ['2026-12-09'],
    revision: 1,
    updatedAt: '2026-11-22T00:00:00.000Z',
    updatedBy: 'user#a@example.com',
  }))
  expect(written.map((batch) => batch.length)).toEqual([24])
  expect(applied).toMatchObject({ updatedCount: 24, conflictCount: 6 })
})

test('writes nothing when the calendars changed between the plan and the first rewrite', async () => {
  let reads = 0
  const written: WorkCalendarScheduleUpdate[][] = []
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(3),
    readCalendarVersion: async () => (reads++ === 0 ? 'planned' : 'newer'),
    async writeSchedules(updates) {
      written.push([...updates])
    },
  })
  expect(written).toEqual([])
  expect(applied).toMatchObject({ updatedCount: 0, conflictCount: 3 })
})

test('stops the change when the member authorization changed', async () => {
  let batches = 0
  const applying = applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(30),
    readCalendarVersion: async () => 'v1',
    async writeSchedules() {
      batches += 1
      throw new ProjectDataError(409, 'WorkItemAuthorizationChanged', 'Work Item authorization changed during the mutation.')
    },
  })
  await expect(applying).rejects.toMatchObject({ code: 'WorkItemAuthorizationChanged' })
  expect(batches).toBe(1)
})

test('splits a transaction that exceeds the DynamoDB item limit', async () => {
  const written: number[] = []
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(24),
    readCalendarVersion: async () => 'v1',
    async writeSchedules(updates) {
      if (updates.length > 12) {
        throw new ProjectDataError(413, 'WorkItemScheduleCascadeLimitExceeded', 'The schedule cascade exceeds the limit.')
      }
      written.push(updates.length)
    },
  })
  expect(written).toEqual([12, 12])
  expect(applied).toMatchObject({ updatedCount: 24, conflictCount: 0 })
})
