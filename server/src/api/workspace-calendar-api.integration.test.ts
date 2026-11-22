import { afterEach, expect, test } from 'bun:test'
import type { WorkItemSchedule, WorkspaceCalendarSettings } from '@mukuroji/contracts'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicWorkItemService } from './api-router'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'
import { createDefaultTenantAdministrationSnapshot } from '../modules/tenant-administration'

const {
  configureFakeProjectClients,
  getTestAppDependencies,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId: 'user#demo@example.com',
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read', 'work-items:write'],
}

/**
 * Makes the Workspace return saved calendar settings and records the schedules sent to storage.
 *
 * @param calendar - Calendar settings the Workspace profile holds.
 * @returns Schedules of the Work Items created afterwards.
 */
function configureWorkspaceCalendar(calendar: WorkspaceCalendarSettings): unknown[] {
  const schedules: unknown[] = []
  configureFakeProjectClients(true, {
    directoryId: credential.workspaceId,
    role: 'member',
    workspaceRole: 'member',
    issueCreateHook(input) {
      schedules.push(input.schedule)
    },
  })
  const profile = {
    ...createDefaultTenantAdministrationSnapshot(credential.workspaceId, 'demo@example.com', '2026-11-01T00:00:00.000Z')
      .profile,
    calendar,
  }
  setTestAppDependencies({
    tenantAdministration: new Proxy(getTestAppDependencies().workspace.tenantAdministration, {
      get(target, property, receiver) {
        if (property === 'getProfile') return async () => profile
        return Reflect.get(target, property, receiver)
      },
    }),
  })
  return schedules
}

/**
 * Creates a Work Item through the Public API service.
 *
 * @param fields - Schedule or due date from the request body, or neither.
 * @param key - Idempotency key.
 * @returns The created Work Item.
 */
async function createWorkItem(fields: { schedule?: WorkItemSchedule, dueDate?: string }, key: string) {
  const workItems = createCanonicalPublicWorkItemService()
  return await runWithTestAppDependencies(() => workItems.create(
    credential,
    {
      teamId: 'core-team',
      title: 'Created by a coding agent',
      assigneeUserId: 'demo@example.com',
      priority: 'medium',
      ...fields,
    },
    { requestId: key, idempotencyKey: key },
  ))
}

const workspaceCalendar: WorkspaceCalendarSettings = {
  fiscalYearStartMonth: 4,
  weekStartDay: 1,
  workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  holidays: ['2026-12-29'],
  publicHolidays: 'japan',
  timeZone: 'Asia/Tokyo',
}

test('gives a Public API Work Item without a schedule the Workspace working calendar', async () => {
  const schedules = configureWorkspaceCalendar(workspaceCalendar)

  await createWorkItem({ dueDate: '2026-12-01' }, 'due-date-without-schedule')
  await createWorkItem({}, 'unscheduled-without-schedule')

  const [dueDate, unscheduled] = schedules
  expect(dueDate).toMatchObject({ mode: 'due-date', dueDate: '2026-12-01', calendarPolicy: { timeZone: 'Asia/Tokyo' } })
  expect(unscheduled).toMatchObject({ mode: 'unscheduled' })
  const holidays = readHolidays(dueDate)
  expect(holidays).toContain('2026-12-29')
  expect(holidays).toContain('2026-11-23')
  expect(holidays).toContain('2027-01-01')
  expect(readHolidays(unscheduled)).toEqual(holidays)
})

test('keeps a schedule the client sent', async () => {
  const schedules = configureWorkspaceCalendar(workspaceCalendar)
  const sent: WorkItemSchedule = {
    mode: 'due-date',
    dueDate: '2026-12-01',
    calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] },
  }

  await createWorkItem({ schedule: sent }, 'explicit-policy')

  expect(schedules).toEqual([sent])
})

test('uses only company holidays when the Workspace turned national holidays off', async () => {
  const schedules = configureWorkspaceCalendar({ ...workspaceCalendar, publicHolidays: 'none' })

  await createWorkItem({}, 'without-national-holidays')

  expect(readHolidays(schedules[0])).toEqual(['2026-12-29'])
})

/**
 * Reads the holidays of a recorded schedule.
 *
 * @param schedule - Schedule recorded by the storage fake.
 * @returns The holidays of its calendar policy.
 */
function readHolidays(schedule: unknown): unknown {
  if (typeof schedule !== 'object' || schedule === null) return undefined
  const policy: unknown = Reflect.get(schedule, 'calendarPolicy')
  if (typeof policy !== 'object' || policy === null) return undefined
  return Reflect.get(policy, 'holidays')
}
