import { describe, expect, test } from 'bun:test'
import { DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS } from '@mukuroji/contracts'
import { createTimeTrackingRouter } from './time-tracking-router'
import {
  InMemoryTimeTrackingRepository,
  TimeTrackingError,
  TimeTrackingService,
} from '../../time-tracking'

/** Converts a domain status to the HTTP status values accepted by Hono. */
function toHttpStatus(status: number): 400 | 403 | 404 | 409 | 500 {
  return status === 400 || status === 403 || status === 404 || status === 409 ? status : 500
}

/**
 * Creates a router whose caller is `manager-1`, with a configurable management scope.
 *
 * @param scope - Whether the caller manages time at all, and whether it manages the whole Team.
 * @param timeZone - Workspace time zone; the Workspace default when omitted.
 * @returns The router and its service.
 */
function createFixture(scope: { canManage: boolean; wholeTeam: boolean }, timeZone?: string) {
  const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
    ...(timeZone
      ? {
          categories: {
            readCategories: async () => DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
            readTimeZone: async () => timeZone,
          },
        }
      : {}),
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: (() => {
      let id = 0
      return () => `id-${++id}`
    })(),
  })
  const router = createTimeTrackingRouter({
    readBearerAccessToken: (context) => context.req.header('Authorization')?.replace(/^Bearer\s+/u, ''),
    authenticate: async () => ({ directoryId: 'workspace-1', userKey: 'manager-1' }),
    requireWrite: () => {},
    requireTeamPermission: async () => {},
    listTimeTrackingTeams: async () => [],
    canManageRates: async () => scope.canManage,
    getAccessibleProjectIds: async () => undefined,
    canManageWholeTeam: async () => scope.wholeTeam,
    canManageWorkspacePeriods: async () => false,
    listWorkspaceTeams: async () => [],
    getManagedProjectIds: async () => undefined,
    verifyProject: async () => {},
    verifyWorkItem: async () => undefined,
    createAuthorizationConditionChecks: () => [],
    getTimeTracking: () => service,
    readJson: async (request) => await request.json(),
    mapError: (context, error) => {
      if (error instanceof TimeTrackingError) {
        return context.json({ code: error.code, message: error.message }, toHttpStatus(error.status))
      }
      throw error
    },
  })
  return { router, service }
}

const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' }

/**
 * Records time for the caller from a start and an end.
 *
 * @param router - Router under test.
 * @param startAt - Start instant.
 * @param endAt - End instant.
 * @returns The response.
 */
async function record(router: ReturnType<typeof createFixture>['router'], startAt: string, endAt: string) {
  return await router.request('/api/teams/team-1/time-entries', {
    method: 'POST',
    headers,
    body: JSON.stringify({ workItemId: 'work-item-1', startAt, endAt, billable: false }),
  })
}

/**
 * Saves a policy as the caller.
 *
 * @param router - Router under test.
 * @param body - Request body.
 * @returns The response.
 */
async function savePolicy(router: ReturnType<typeof createFixture>['router'], body: Record<string, unknown>) {
  return await router.request('/api/teams/team-1/time-entry-policy', { method: 'PUT', headers, body: JSON.stringify(body) })
}

describe('time entry policy routes', () => {
  test('reads the defaults, and only a manager of the whole Team changes them', async () => {
    const member = createFixture({ canManage: false, wholeTeam: false })
    const read = await member.router.request('/api/teams/team-1/time-entry-policy', { headers })
    expect(await read.json()).toEqual({
      policy: { teamId: 'team-1', overlap: 'off', dailyLimit: 'off', dailyLimitMinutes: 600, revision: 0 },
      canEdit: false,
    })
    const partial = createFixture({ canManage: true, wholeTeam: false })
    const denied = await savePolicy(partial.router, { overlap: 'reject', dailyLimit: 'off', dailyLimitMinutes: 600, expectedRevision: 0 })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'TimeEntryPolicyDenied' })

    const manager = createFixture({ canManage: true, wholeTeam: true })
    for (const invalid of [
      { overlap: 'block', dailyLimit: 'off', dailyLimitMinutes: 600 },
      { overlap: 'warn', dailyLimit: 'warn', dailyLimitMinutes: 0 },
      { overlap: 'warn', dailyLimit: 'warn', dailyLimitMinutes: 1441 },
      { overlap: 'warn', dailyLimit: 'warn', dailyLimitMinutes: 90.5 },
    ]) {
      const rejected = await savePolicy(manager.router, { ...invalid, expectedRevision: 0 })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ code: 'InvalidTimeEntryPolicy' })
    }
    const saved = await savePolicy(manager.router, { overlap: 'warn', dailyLimit: 'reject', dailyLimitMinutes: 480, expectedRevision: 0 })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ policy: { overlap: 'warn', dailyLimit: 'reject', dailyLimitMinutes: 480, revision: 1 }, canEdit: true })
    const stale = await savePolicy(manager.router, { overlap: 'off', dailyLimit: 'off', dailyLimitMinutes: 480, expectedRevision: 0 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'TimeEntryPolicyRevisionConflict' })
  })

  test('only a manager of the whole Team reads and changes investment assignments (ADR 0116)', async () => {
    const member = createFixture({ canManage: false, wholeTeam: false })
    const memberRead = await member.router.request('/api/teams/team-1/investment-assignments', { headers })
    expect(memberRead.status).toBe(403)
    const save = (router: ReturnType<typeof createFixture>['router'], body: Record<string, unknown>) =>
      router.request('/api/teams/team-1/investment-assignments', { method: 'PUT', headers, body: JSON.stringify(body) })
    const partial = createFixture({ canManage: true, wholeTeam: false })
    const denied = await save(partial.router, { projects: { alpha: 'maintenance' }, workItems: {}, expectedRevision: 0 })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'InvestmentAssignmentsDenied' })
    const partialRead = await partial.router.request('/api/teams/team-1/investment-assignments', { headers })
    expect(await partialRead.json()).toMatchObject({ code: 'InvestmentAssignmentsDenied' })

    const manager = createFixture({ canManage: true, wholeTeam: true })
    const read = await manager.router.request('/api/teams/team-1/investment-assignments', { headers })
    expect(await read.json()).toEqual({ assignments: { teamId: 'team-1', projects: {}, workItems: {}, revision: 0 }, canEdit: true })
    for (const invalid of [
      { projects: { alpha: 'Maintenance' }, workItems: {} },
      { projects: { alpha: 'unclassified' }, workItems: {} },
      { projects: [], workItems: {} },
    ]) {
      const rejected = await save(manager.router, { ...invalid, expectedRevision: 0 })
      expect(rejected.status).toBe(400)
    }
    // A key that would replace the prototype is refused, not merged.
    const prototypeKey = await manager.router.request('/api/teams/team-1/investment-assignments', {
      method: 'PUT',
      headers,
      body: '{"projects":{},"workItems":{"__proto__":"maintenance"},"expectedRevision":0}',
    })
    expect(prototypeKey.status).toBe(400)
    const unknown = await save(manager.router, { projects: { alpha: 'custom-research' }, workItems: {}, expectedRevision: 0 })
    expect(await unknown.json()).toMatchObject({ code: 'InvalidInvestmentCategory' })
    const saved = await save(manager.router, { projects: { alpha: 'maintenance' }, workItems: { 'task-1': 'operations' }, expectedRevision: 0 })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      assignments: { projects: { alpha: 'maintenance' }, workItems: { 'task-1': 'operations' }, revision: 1 },
      canEdit: true,
    })
    const report = await manager.router.request(
      '/api/teams/team-1/time-tracking/summary?from=2026-08-01&to=2026-08-07&groupBy=investment&filterProjectId=alpha',
      { headers },
    )
    expect(report.status).toBe(200)
    expect(await report.json()).toMatchObject({ groupBy: 'investment', groups: [], totalMinutes: 0 })
  })

  test('warns about or rejects overlapping time', async () => {
    const { router } = createFixture({ canManage: true, wholeTeam: true })
    const first = await record(router, '2026-08-03T01:00:00.000Z', '2026-08-03T03:00:00.000Z')
    expect(await first.json()).not.toHaveProperty('warnings')
    // Without a policy, overlapping time is saved as before.
    const unchecked = await record(router, '2026-08-03T02:00:00.000Z', '2026-08-03T02:30:00.000Z')
    expect(unchecked.status).toBe(201)
    expect(await unchecked.json()).not.toHaveProperty('warnings')

    await savePolicy(router, { overlap: 'warn', dailyLimit: 'off', dailyLimitMinutes: 600, expectedRevision: 0 })
    const warned = await record(router, '2026-08-03T02:45:00.000Z', '2026-08-03T04:00:00.000Z')
    expect(warned.status).toBe(201)
    expect((await warned.json()).warnings).toEqual([{ code: 'TimeEntryOverlap', entryIds: ['id-1'] }])
    // Touching ends do not overlap.
    const adjacent = await record(router, '2026-08-03T04:00:00.000Z', '2026-08-03T05:00:00.000Z')
    expect(await adjacent.json()).not.toHaveProperty('warnings')

    await savePolicy(router, { overlap: 'reject', dailyLimit: 'off', dailyLimitMinutes: 600, expectedRevision: 1 })
    const rejected = await record(router, '2026-08-03T04:30:00.000Z', '2026-08-03T04:45:00.000Z')
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'TimeEntryOverlap' })
    // An entry recorded as a date and minutes has no time of day, so it never overlaps, even when
    // the span it is stored with covers the timed entries of the same day.
    const durationOnly = await router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workItemId: 'work-item-1', date: '2026-08-03', minutes: 720, timeZone: 'Asia/Tokyo', billable: false }),
    })
    expect(durationOnly.status).toBe(201)
  })

  test('checks the daily total in the Workspace time zone, and only when an edit moves the time', async () => {
    const { router, service } = createFixture({ canManage: true, wholeTeam: true })
    // 23:00-01:00 JST spans two local days: 60 minutes on each.
    const night = await record(router, '2026-08-03T14:00:00.000Z', '2026-08-03T16:00:00.000Z')
    const nightEntry = (await night.json()).entry
    await savePolicy(router, { overlap: 'off', dailyLimit: 'warn', dailyLimitMinutes: 120, expectedRevision: 0 })
    const warned = await record(router, '2026-08-03T10:00:00.000Z', '2026-08-03T11:30:00.000Z')
    expect((await warned.json()).warnings).toEqual([
      { code: 'TimeEntryDailyLimitExceeded', date: '2026-08-03', minutes: 150, limitMinutes: 120 },
    ])

    await savePolicy(router, { overlap: 'off', dailyLimit: 'reject', dailyLimitMinutes: 120, expectedRevision: 1 })
    const rejected = await router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workItemId: 'work-item-1', date: '2026-08-04', minutes: 61, timeZone: 'Asia/Tokyo', billable: false }),
    })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'TimeEntryDailyLimitExceeded' })

    // The day is already over the limit, but a description fix does not move the time.
    const described = await router.request(`/api/teams/team-1/time-entries/${nightEntry.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ expectedRevision: 1, description: 'Release support' }),
    })
    expect(described.status).toBe(200)
    // Shrinking the night entry to 30 minutes on 08-04 is checked and fits.
    const moved = await router.request(`/api/teams/team-1/time-entries/${nightEntry.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ expectedRevision: 2, startAt: '2026-08-03T15:00:00.000Z', endAt: '2026-08-03T15:30:00.000Z' }),
    })
    expect(moved.status).toBe(200)
    const growing = await router.request(`/api/teams/team-1/time-entries/${nightEntry.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ expectedRevision: 3, startAt: '2026-08-03T09:00:00.000Z', endAt: '2026-08-03T10:00:00.000Z' }),
    })
    expect(growing.status).toBe(409)
    expect((await service.getEntry('workspace-1', 'team-1', nightEntry.id)).revision).toBe(3)
  })

  test('counts a started minute toward the daily total, as the report does', async () => {
    const { router } = createFixture({ canManage: true, wholeTeam: true })
    // 60 minutes and 20 seconds is recorded and reported as 61 minutes.
    expect((await record(router, '2026-08-03T00:00:00.000Z', '2026-08-03T01:00:20.000Z')).status).toBe(201)
    await savePolicy(router, { overlap: 'off', dailyLimit: 'reject', dailyLimitMinutes: 120, expectedRevision: 0 })
    const rejected = await record(router, '2026-08-03T02:00:00.000Z', '2026-08-03T03:00:00.000Z')
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'TimeEntryDailyLimitExceeded' })
  })

  test('splits an entry that crosses midnight between the days as the report does', async () => {
    const { router } = createFixture({ canManage: true, wholeTeam: true })
    expect((await record(router, '2026-08-03T01:00:00.000Z', '2026-08-03T01:59:00.000Z')).status).toBe(201)
    expect((await record(router, '2026-08-04T01:00:00.000Z', '2026-08-04T01:59:00.000Z')).status).toBe(201)
    await savePolicy(router, { overlap: 'off', dailyLimit: 'warn', dailyLimitMinutes: 59, expectedRevision: 0 })
    // 23:59:30-00:00:30 JST is 30 seconds on each day. The report counts its 1 minute once, on
    // 08-03, so only that day goes over; counting a started minute on each day would flag both.
    const crossing = await record(router, '2026-08-03T14:59:30.000Z', '2026-08-03T15:00:30.000Z')
    expect(crossing.status).toBe(201)
    expect((await crossing.json()).warnings).toEqual([
      { code: 'TimeEntryDailyLimitExceeded', date: '2026-08-03', minutes: 60, limitMinutes: 59 },
    ])
  })

  test('counts days in the time zone the Workspace chose', async () => {
    const { router } = createFixture({ canManage: true, wholeTeam: true }, 'UTC')
    await savePolicy(router, { overlap: 'off', dailyLimit: 'reject', dailyLimitMinutes: 600, expectedRevision: 0 })
    // Both are on 2026-08-03 in UTC, though in Tokyo they fall on two days.
    expect((await record(router, '2026-08-03T08:00:00.000Z', '2026-08-03T14:00:00.000Z')).status).toBe(201)
    const rejected = await record(router, '2026-08-03T16:00:00.000Z', '2026-08-03T22:00:00.000Z')
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'TimeEntryDailyLimitExceeded' })
  })

  test("gives no warnings to a manager editing another member's time", async () => {
    const { router, service } = createFixture({ canManage: true, wholeTeam: true })
    const base = { workspaceId: 'workspace-1', teamId: 'team-1', userId: 'member-2', workItemId: 'work-item-1', billable: false, currency: 'JPY', source: 'manual' as const }
    await service.createEntry({ ...base, startAt: '2026-08-03T00:00:00.000Z', endAt: '2026-08-03T02:00:00.000Z' }, true)
    const other = await service.createEntry({ ...base, startAt: '2026-08-03T05:00:00.000Z', endAt: '2026-08-03T06:00:00.000Z' }, true)
    await savePolicy(router, { overlap: 'warn', dailyLimit: 'warn', dailyLimitMinutes: 60, expectedRevision: 0 })
    const moved = await router.request(`/api/teams/team-1/time-entries/${other.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ expectedRevision: other.revision, startAt: '2026-08-03T01:00:00.000Z', endAt: '2026-08-03T03:00:00.000Z' }),
    })
    expect(moved.status).toBe(200)
    expect(await moved.json()).not.toHaveProperty('warnings')
  })
})
