import type {
  CalendarFeedListResponse,
  IssueCalendarFeedResponse,
} from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'

const {
  app,
  configureFakeProjectClients,
  createCyclePlanningInput,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Workspace of the fake signed-in member. */
const WORKSPACE_ID = 'user#demo@example.com'

/**
 * Sends a request signed in as the fake member.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @returns The response.
 */
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Issues a feed and returns its response.
 *
 * @param body - Issue request.
 * @returns The issued feed and path.
 */
async function issue(body: unknown): Promise<IssueCalendarFeedResponse> {
  const response = await request('/api/me/calendar-feeds', 'POST', body)
  expect(response.status).toBe(201)
  return await response.json() as IssueCalendarFeedResponse
}

/**
 * Adds a Cycle and a Milestone to the fake Project `refero`, and a Milestone to the Project
 * `private-project`.
 */
async function seedPlanning(): Promise<void> {
  const planning = getTestAppDependencies().workItems.planning
  let revision = 0
  /** Shared fields of an entity that is not a Cycle. */
  const plain = { cadence: undefined, capacity: undefined, carryOverPolicy: undefined }
  for (const [id, type, parentId, projectId] of [
    ['portfolio', 'portfolio', undefined, undefined],
    ['roadmap', 'roadmap', 'portfolio', undefined],
    ['refero-phase', 'phase', 'roadmap', 'refero'],
    ['private-phase', 'phase', 'roadmap', 'private-project'],
  ] as const) {
    await planning.create(WORKSPACE_ID, {
      ...createCyclePlanningInput(id, revision),
      ...plain,
      type,
      ...(parentId ? { parentId } : {}),
      ...(projectId ? { projectId } : { teamId: undefined, projectId: undefined }),
    }, { workItems: [] })
    revision += 1
  }
  await planning.create(WORKSPACE_ID, {
    ...createCyclePlanningInput('refero-cycle', revision),
    title: 'Sprint 12',
  }, { workItems: [] })
  revision += 1
  for (const [id, parentId, projectId, title] of [
    ['refero-milestone', 'refero-phase', 'refero', 'Beta release'],
    ['private-milestone', 'private-phase', 'private-project', 'Private launch'],
  ] as const) {
    await planning.create(WORKSPACE_ID, {
      ...createCyclePlanningInput(id, revision),
      ...plain,
      type: 'milestone',
      title,
      parentId,
      projectId,
      baseline: { startDate: '2026-08-14', endDate: '2026-08-14' },
      forecast: { startDate: '2026-08-14', endDate: '2026-08-14' },
    }, { workItems: [] })
    revision += 1
  }
}

test('serves the member feed with the caller\'s scheduled Work Items and their Project dates', async () => {
  configureFakeProjectClients(true, {
    teamIssueCount: 3,
    issueContributorAssignments: [{
      assignmentId: 'assignment-1',
      memberUserId: 'demo@example.com',
      status: 'in-progress',
    }],
  })
  await seedPlanning()

  const issued = await issue({ kind: 'member' })
  expect(issued.feed).toMatchObject({ kind: 'member', locale: 'ja' })
  expect(issued.feedPath).toMatch(/^\/api\/public\/calendar-feeds\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.ics$/)

  const feed = await app.request(issued.feedPath)
  expect(feed.status).toBe(200)
  expect(feed.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
  expect(feed.headers.get('referrer-policy')).toBe('no-referrer')
  const body = await feed.text()
  expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
  expect(body).toContain('X-WR-CALNAME:Mukuroji: 自分の予定')
  expect(body).toContain('BEGIN:VEVENT')
  expect(body).toContain('UID:work-item.core-team.')
  expect(body).toContain('DTSTART;VALUE=DATE:20260618')
  expect(body).toMatch(/SUMMARY:期限: /)
  expect(body).toContain('SUMMARY:◆ マイルストーン: Beta release')
  // The member has no Work Item in the other Project, so its Milestone stays out.
  expect(body).not.toContain('Private launch')
  expect(body).toContain('DTSTART;VALUE=DATE:20260814')
  expect(body).toContain('DTEND;VALUE=DATE:20260815')
  expect(body).toContain('SUMMARY:Cycle: Sprint 12')
  expect(body).toContain('DTEND;VALUE=DATE:20260715')

  const listed = await request('/api/me/calendar-feeds')
  const list = await listed.json() as CalendarFeedListResponse
  expect(list.feeds).toEqual([issued.feed])
  expect(JSON.stringify(list)).not.toContain('tokenHash')
})

test('replacing a token stops the old URL, and revoking stops the feed', async () => {
  configureFakeProjectClients(true)
  const first = await issue({ kind: 'member', locale: 'en' })
  const second = await issue({ kind: 'member' })
  expect(second.feed.id).toBe(first.feed.id)
  expect(second.feed.createdAt).toBe(first.feed.createdAt)
  // A replacement keeps the language chosen before.
  expect(second.feed.locale).toBe('en')
  expect(second.feedPath).not.toBe(first.feedPath)

  expect((await app.request(first.feedPath)).status).toBe(404)
  const current = await app.request(second.feedPath)
  expect(current.status).toBe(200)
  expect(await current.text()).toContain('X-WR-CALNAME:Mukuroji: My schedule')

  const revoked = await request(`/api/me/calendar-feeds/${second.feed.id}`, 'DELETE')
  expect(revoked.status).toBe(204)
  const gone = await app.request(second.feedPath)
  expect(gone.status).toBe(404)
  expect(gone.headers.get('cache-control')).toBe('no-store')
  expect((await request(`/api/me/calendar-feeds/${second.feed.id}`, 'DELETE')).status).toBe(404)
  expect(((await (await request('/api/me/calendar-feeds')).json()) as CalendarFeedListResponse).feeds).toEqual([])
})

test('serves a Project feed and drops it when the owner can no longer read the Project', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
  })
  await seedPlanning()

  const issued = await issue({ kind: 'project', teamId: 'core-team', projectId: 'refero' })
  expect(issued.feed).toMatchObject({ kind: 'project', teamId: 'core-team', projectId: 'refero' })
  const feed = await app.request(issued.feedPath)
  expect(feed.status).toBe(200)
  const body = await feed.text()
  expect(body).toContain('X-WR-CALNAME:Mukuroji: ')
  expect(body).toMatch(/SUMMARY:期限: /)
  expect(body).toContain('SUMMARY:◆ マイルストーン: Beta release')
  expect(body).toContain('SUMMARY:Cycle: Sprint 12')
  expect(body).not.toContain('Private launch')

  const store = getTestAppDependencies().workItems.calendarFeeds
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'private-project', role: 'viewer' }],
  })
  // Keep the feed rows across the new access configuration.
  setTestAppDependencies({ calendarFeeds: store })
  expect((await app.request(issued.feedPath)).status).toBe(404)
})

test('refuses a Project feed for a Project the caller cannot read', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
  })
  const response = await request('/api/me/calendar-feeds', 'POST', {
    kind: 'project',
    teamId: 'core-team',
    projectId: 'private-project',
  })
  expect(response.status).toBe(404)
})

test('answers 404 for a feed whose owner is no longer an active member', async () => {
  configureFakeProjectClients(true)
  const issued = await issue({ kind: 'member' })
  const store = getTestAppDependencies().workItems.calendarFeeds
  configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })
  setTestAppDependencies({ calendarFeeds: store })
  expect((await app.request(issued.feedPath)).status).toBe(404)
})

test('rejects malformed tokens, missing sign-in, and invalid requests', async () => {
  configureFakeProjectClients(true)
  for (const token of ['nope', 'a.b.ics', `${Buffer.from(WORKSPACE_ID).toString('base64url')}.${'A'.repeat(43)}.ics`]) {
    expect((await app.request(`/api/public/calendar-feeds/${token}`)).status).toBe(404)
  }
  expect((await app.request('/api/me/calendar-feeds')).status).toBe(401)
  for (const body of [{}, { kind: 'team' }, { kind: 'member', locale: 'fr' }, { kind: 'project', teamId: 'core-team' }, { kind: 'member', extra: 1 }]) {
    const response = await request('/api/me/calendar-feeds', 'POST', body)
    expect(response.status).toBe(400)
  }
})
