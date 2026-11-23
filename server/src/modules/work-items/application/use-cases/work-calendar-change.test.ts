import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  type WorkCalendar,
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
  type WorkCalendarVersion,
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

/** Versions before any Team calendar is stored. */
const unsaved: WorkCalendarVersion = new Map([['workspace', 1]])

/** Versions once this change saved the Team calendar. */
const savedOnce: WorkCalendarVersion = new Map([['workspace', 1], ['team:team-1', 1]])

/**
 * Saves the Team calendar of the change.
 *
 * @returns The saved calendar.
 */
async function saveTeamCalendar(): Promise<WorkCalendar> {
  return {
    scope: { kind: 'team', teamId: 'team-1' },
    additionalHolidays: ['2026-12-09'],
    revision: 1,
    updatedAt: '2026-11-22T00:00:00.000Z',
    updatedBy: 'user#a@example.com',
  }
}

test('stops rewriting once a newer calendar change has been saved', async () => {
  const written: WorkCalendarScheduleUpdate[][] = []
  let version = savedOnce
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(30),
    readCalendarVersion: async () => version,
    async writeSchedules(updates) {
      written.push([...updates])
      // Another member saves the calendar again while the first transaction is written.
      version = new Map([['workspace', 1], ['team:team-1', 2]])
    },
  }, { plannedVersion: unsaved, save: saveTeamCalendar })
  expect(written.map((batch) => batch.length)).toEqual([24])
  expect(applied).toMatchObject({ updatedCount: 24, conflictCount: 6 })
})

test('writes nothing when the calendars changed between the plan and the first rewrite', async () => {
  const written: WorkCalendarScheduleUpdate[][] = []
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(3),
    readCalendarVersion: async () => new Map([['workspace', 2]]),
    async writeSchedules(updates) {
      written.push([...updates])
    },
  }, { plannedVersion: unsaved })
  expect(written).toEqual([])
  expect(applied).toMatchObject({ updatedCount: 0, conflictCount: 3 })
})

test('writes nothing when another calendar was saved before this change saved its own', async () => {
  const written: WorkCalendarScheduleUpdate[][] = []
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(3),
    // The Team calendar the rules inherited from moved on while this Project calendar was saved.
    readCalendarVersion: async () => new Map([['workspace', 1], ['team:team-1', 2], ['project:team-1:p1', 1]]),
    async writeSchedules(updates) {
      written.push([...updates])
    },
  }, {
    plannedVersion: new Map([['workspace', 1], ['team:team-1', 1]]),
    save: async () => ({ ...await saveTeamCalendar(), scope: { kind: 'project', teamId: 'team-1', projectId: 'p1' } }),
  })
  expect(written).toEqual([])
  expect(applied).toMatchObject({ calendar: { revision: 1 }, updatedCount: 0, conflictCount: 3 })
})

test('rewrites after its own save, including a resumed one', async () => {
  for (const plannedVersion of [unsaved, savedOnce]) {
    const applied = await applyWorkCalendarChange(rules, {
      readWorkItems: async () => workItems(3),
      readCalendarVersion: async () => savedOnce,
      async writeSchedules() {},
    }, { plannedVersion, save: saveTeamCalendar })
    expect(applied).toMatchObject({ updatedCount: 3, conflictCount: 0 })
  }
})

test('stops the change when the member authorization changed', async () => {
  let batches = 0
  const applying = applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(30),
    readCalendarVersion: async () => unsaved,
    async writeSchedules() {
      batches += 1
      throw new ProjectDataError(409, 'WorkItemAuthorizationChanged', 'Work Item authorization changed during the mutation.')
    },
  }, { plannedVersion: unsaved })
  await expect(applying).rejects.toMatchObject({ code: 'WorkItemAuthorizationChanged' })
  expect(batches).toBe(1)
})

test('splits a transaction that exceeds the DynamoDB item limit', async () => {
  const written: number[] = []
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(24),
    readCalendarVersion: async () => unsaved,
    async writeSchedules(updates) {
      if (updates.length > 12) {
        throw new ProjectDataError(413, 'WorkItemScheduleCascadeLimitExceeded', 'The schedule cascade exceeds the limit.')
      }
      written.push(updates.length)
    },
  }, { plannedVersion: unsaved })
  expect(written).toEqual([12, 12])
  expect(applied).toMatchObject({ updatedCount: 24, conflictCount: 0 })
})

test('counts earlier conflicts when a newer change stops the rewrite', async () => {
  let version = savedOnce
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => workItems(30),
    readCalendarVersion: async () => version,
    async writeSchedules() {
      version = new Map([['workspace', 1], ['team:team-1', 2]])
      throw new ProjectDataError(409, 'WorkItemScheduleConflict', 'A Work Item changed.')
    },
  }, { plannedVersion: unsaved, save: saveTeamCalendar })
  expect(applied).toMatchObject({ updatedCount: 0, conflictCount: 30 })
})

test('stops retrying conflicted Work Items once a newer change has been saved', async () => {
  let version = savedOnce
  let writes = 0
  const applied = await applyWorkCalendarChange(rules, {
    readWorkItems: async () => {
      // The fresh read for the retry sees Work Items another change already moved on.
      if (writes > 0) version = new Map([['workspace', 1], ['team:team-1', 2]])
      return workItems(3)
    },
    readCalendarVersion: async () => version,
    async writeSchedules() {
      writes += 1
      throw new ProjectDataError(409, 'WorkItemScheduleConflict', 'A Work Item changed.')
    },
  }, { plannedVersion: unsaved, save: saveTeamCalendar })
  expect(writes).toBe(1)
  expect(applied).toMatchObject({ updatedCount: 0, conflictCount: 3 })
})
