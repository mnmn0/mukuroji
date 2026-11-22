import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import type {
  EnterpriseCustomRole,
  TeamWeeklyReportStatusResponse,
  WeeklyReportHistoryResponse,
  WeeklyReportResponse,
} from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'

afterEach(() => {
  resetTestApp()
})

/** Week used by the tests; a past Monday so it is never a future week. */
const WEEK = '2026-11-16'
/** Path of the demo member's report for {@link WEEK}. */
const OWN_PATH = `/api/teams/core-team/weekly-reports/demo@example.com/${WEEK}`

/**
 * Sends an authenticated request.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @param idempotencyKey - Idempotency key header, if any.
 * @returns The response.
 */
function request(path: string, method = 'GET', body?: unknown, idempotencyKey?: string) {
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Builds a submission body.
 *
 * @param expectedSubmissionCount - Versions already submitted.
 * @param reflection - Reflection note.
 * @param expectedRevision - Saved revision the notes were edited from.
 * @returns The body.
 */
function submission(expectedSubmissionCount: number, reflection = 'Good week', expectedRevision = expectedSubmissionCount) {
  return {
    expectedSubmissionCount,
    expectedRevision,
    sections: {
      completed: [{ workItemId: 'item-visible', minutes: 90 }],
      started: [{ workItemId: 'item-other-project', minutes: 30 }],
      overdue: [{ workItemId: 'item-missing', minutes: 0 }],
      upcoming: [],
    },
    time: [
      { workItemId: 'item-visible', minutes: 90 },
      { workItemId: 'item-other-project', minutes: 30 },
    ],
    indirectTime: [{ category: 'meeting', minutes: 45 }],
    totalMinutes: 165,
    timeIsPartial: false,
    notes: { issues: ' Need review ', reflection },
  }
}

/**
 * Stores one submitted version for a member, referencing a Work Item of `refero` and one of
 * `secret`.
 *
 * @param memberKey - Author.
 */
async function seedSubmission(memberKey: string) {
  const store = getTestAppDependencies().workItems.weeklyReports
  const scope = { workspaceId: 'user#demo@example.com', teamId: 'core-team', memberKey }
  await store.submit({
    ...scope,
    now: '2026-11-20T09:00:00.000Z',
    callerAuthorization: [{ ConditionCheck: { TableName: 't', Key: {}, ConditionExpression: 'attribute_exists(x)' } }],
    auditContext: createMutationAuditContext({
      workspaceId: scope.workspaceId,
      actor: { id: memberKey, kind: 'user', displayName: 'Author' },
      idempotencyKey: 'seed',
      request: { method: 'POST', path: '/seed', body: {} },
      source: { kind: 'api' },
    }),
    previous: null,
    receipt: { key: `seed-${memberKey}`, receipt: 'seed' },
    next: {
      weekStart: WEEK,
      revision: 1,
      updatedAt: '2026-11-20T09:00:00.000Z',
      notes: { issues: '', reflection: 'Submitted text' },
      submissionCount: 1,
      lastSubmittedAt: '2026-11-20T09:00:00.000Z',
    },
    submission: {
      version: 1,
      submittedAt: '2026-11-20T09:00:00.000Z',
      weekStart: WEEK,
      weekEnd: '2026-11-22',
      sections: {
        completed: [{ workItemId: 'a', minutes: 60 }, { workItemId: 'b', minutes: 30 }],
        started: [],
        overdue: [],
        upcoming: [],
      },
      time: [{ workItemId: 'b', minutes: 30 }],
      indirectTime: [],
      items: [
        { workItemId: 'a', key: 'REF-1', title: 'Visible title', projectId: 'refero' },
        { workItemId: 'b', key: 'SEC-1', title: 'Secret title', projectId: 'secret' },
      ],
      totalMinutes: 90,
      timeIsPartial: false,
      notes: { issues: '', reflection: 'Submitted text' },
    },
  })
}

test('saves notes, submits versions, and lists the history of the author', async () => {
  configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'member' }],
    detailAssignedProjectIds: { 'item-visible': 'refero', 'item-other-project': 'secret' },
    detailKeys: { 'item-visible': 'REF-1' },
    detailMissingIssueIds: ['item-missing'],
  })

  const empty = await request(OWN_PATH)
  expect(empty.status).toBe(200)
  expect(await empty.json()).toEqual({ teamId: 'core-team', memberKey: 'demo@example.com', weekStart: WEEK, submissionCount: 0 })

  const saved = await request(`${OWN_PATH}/draft`, 'PUT', { expectedRevision: 0, notes: { issues: 'Blocked', reflection: '' } })
  expect(saved.status).toBe(200)
  expect((await saved.json() as WeeklyReportResponse).draft).toMatchObject({ revision: 1, notes: { issues: 'Blocked', reflection: '' } })

  const stale = await request(`${OWN_PATH}/draft`, 'PUT', { expectedRevision: 0, notes: { issues: 'Other', reflection: '' } })
  expect(stale.status).toBe(409)

  const submitted = await request(`${OWN_PATH}/submissions`, 'POST', submission(0, 'Good week', 1), 'submit-1')
  expect(submitted.status).toBe(201)
  const report = await submitted.json() as WeeklyReportResponse
  expect(report.submissionCount).toBe(1)
  expect(report.draft).toMatchObject({ revision: 2, notes: { issues: 'Need review', reflection: 'Good week' } })
  // The Work Item of a Project the author cannot read and the missing one are not kept.
  expect(report.submission).toMatchObject({
    version: 1,
    weekStart: WEEK,
    weekEnd: '2026-11-22',
    sections: {
      completed: [{ hidden: false, workItemId: 'item-visible', key: 'REF-1', title: '初回オンボーディングの離脱要因を減らす', minutes: 90 }],
      started: [],
      overdue: [],
      upcoming: [],
    },
    time: [{ hidden: false, workItemId: 'item-visible', minutes: 90 }],
    // Indirect work references no Work Item, so it is kept as sent.
    indirectTime: [{ category: 'meeting', minutes: 45 }],
    totalMinutes: 165,
  })

  const retried = await request(`${OWN_PATH}/submissions`, 'POST', submission(0, 'Good week', 1), 'submit-1')
  expect(retried.status).toBe(201)
  expect((await retried.json() as WeeklyReportResponse).submission).toEqual(report.submission)

  const reusedKey = await request(`${OWN_PATH}/submissions`, 'POST', submission(1, 'Changed', 2), 'submit-1')
  expect(reusedKey.status).toBe(409)
  expect(await reusedKey.json()).toMatchObject({ code: 'WeeklyReportIdempotencyConflict' })

  const staleCount = await request(`${OWN_PATH}/submissions`, 'POST', submission(0, 'Again', 2), 'submit-2')
  expect(staleCount.status).toBe(409)

  // Notes saved elsewhere after this editor read revision 1 are not replaced by a submission.
  const staleNotes = await request(`${OWN_PATH}/submissions`, 'POST', submission(1, 'Old text', 1), 'submit-stale-notes')
  expect(staleNotes.status).toBe(409)
  expect(await staleNotes.json()).toMatchObject({ code: 'WeeklyReportConflict' })

  const second = await request(`${OWN_PATH}/submissions`, 'POST', submission(1, 'Fixed a typo', 2), 'submit-3')
  expect(second.status).toBe(201)
  expect(await second.json()).toMatchObject({ submissionCount: 2, submission: { version: 2, notes: { reflection: 'Fixed a typo' } } })

  // A retry of the first request after a later version still answers with the version it produced.
  const lateRetry = await request(`${OWN_PATH}/submissions`, 'POST', submission(0, 'Good week', 1), 'submit-1')
  expect(lateRetry.status).toBe(201)
  const lateReport = await lateRetry.json() as WeeklyReportResponse
  expect(lateReport.submission).toEqual(report.submission)
  expect(lateReport.submissionCount).toBe(2)

  const first = await request(`${OWN_PATH}?version=1`)
  expect((await first.json() as WeeklyReportResponse).submission?.notes.reflection).toBe('Good week')
  expect((await request(`${OWN_PATH}?version=3`)).status).toBe(404)

  await request(`/api/teams/core-team/weekly-reports/demo@example.com/2026-11-09/draft`, 'PUT', {
    expectedRevision: 0,
    notes: { issues: '', reflection: 'Draft only' },
  })
  const history = await request('/api/teams/core-team/weekly-reports/demo@example.com?limit=1')
  expect(history.status).toBe(200)
  const page = await history.json() as WeeklyReportHistoryResponse
  expect(page.weeks).toEqual([{ weekStart: WEEK, submissionCount: 2, lastSubmittedAt: expect.any(String) }])
  expect(page.nextCursor).toBe(WEEK)
  const older = await request(`/api/teams/core-team/weekly-reports/demo@example.com?limit=1&cursor=${page.nextCursor}`)
  expect((await older.json() as WeeklyReportHistoryResponse).weeks).toEqual([{ weekStart: '2026-11-09', submissionCount: 0 }])
})

test('rejects invalid weeks and bodies', async () => {
  configureFakeProjectClients(true)
  expect((await request('/api/teams/core-team/weekly-reports/demo@example.com/2026-02-30')).status).toBe(400)
  expect((await request('/api/teams/core-team/weekly-reports/demo@example.com/2099-01-05')).status).toBe(400)
  const tooLong = await request(`${OWN_PATH}/draft`, 'PUT', { expectedRevision: 0, notes: { issues: 'x'.repeat(4_001), reflection: '' } })
  expect(tooLong.status).toBe(400)
  const badMinutes = await request(`${OWN_PATH}/submissions`, 'POST', { ...submission(0), totalMinutes: -1 })
  expect(badMinutes.status).toBe(400)
  const unknownCategory = await request(`${OWN_PATH}/submissions`, 'POST', { ...submission(0), indirectTime: [{ category: 'Lunch break', minutes: 30 }] })
  expect(unknownCategory.status).toBe(400)
  const repeatedCategory = await request(`${OWN_PATH}/submissions`, 'POST', {
    ...submission(0),
    indirectTime: [{ category: 'meeting', minutes: 30 }, { category: 'meeting', minutes: 15 }],
  })
  expect(repeatedCategory.status).toBe(400)
})

test('lets only the author write a report', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', projectAccesses: [{ projectId: 'refero', role: 'manager' }] })
  const path = `/api/teams/core-team/weekly-reports/sato@example.com/${WEEK}`
  const draft = await request(`${path}/draft`, 'PUT', { expectedRevision: 0, notes: { issues: '', reflection: '' } })
  expect(draft.status).toBe(403)
  const submit = await request(`${path}/submissions`, 'POST', submission(0))
  expect(submit.status).toBe(403)
})

test('shows a manager the submitted report of a member without the saved notes or hidden Work Items', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    detailAssignedProjectIds: { a: 'refero', b: 'secret' },
  })
  await seedSubmission('sato@example.com')

  const read = await request(`/api/teams/core-team/weekly-reports/sato@example.com/${WEEK}`)
  expect(read.status).toBe(200)
  const report = await read.json() as WeeklyReportResponse
  expect(report.draft).toBeUndefined()
  expect(report.submission?.sections.completed).toEqual([
    { hidden: false, workItemId: 'a', key: 'REF-1', title: 'Visible title', minutes: 60 },
    { hidden: true, minutes: 30 },
  ])
  expect(report.submission?.time).toEqual([{ hidden: true, minutes: 30 }])
  expect(JSON.stringify(report)).not.toContain('Secret title')
  expect(JSON.stringify(report)).not.toContain('SEC-1')

  const status = await request(`/api/teams/core-team/weekly-reports?weekStart=${WEEK}`)
  expect(status.status).toBe(200)
  expect(await status.json() as TeamWeeklyReportStatusResponse).toEqual({
    teamId: 'core-team',
    weekStart: WEEK,
    members: [{ memberKey: 'demo@example.com', submissionCount: 0 }],
  })

  const history = await request('/api/teams/core-team/weekly-reports/sato@example.com')
  expect((await history.json() as WeeklyReportHistoryResponse).weeks).toEqual([
    { weekStart: WEEK, submissionCount: 1, lastSubmittedAt: '2026-11-20T09:00:00.000Z' },
  ])
})

test('checks a Work Item at the Project it is in now, and a deleted one at the Project stored at submission', async () => {
  // `a` was submitted in `refero` and moved to `secret`; `b` was submitted in `secret` and moved to `refero`.
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    detailAssignedProjectIds: { a: 'secret', b: 'refero' },
  })
  await seedSubmission('sato@example.com')
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  const readDetail = teamIssues.getTeamIssueDetail.bind(teamIssues)
  const reads: unknown[] = []
  teamIssues.getTeamIssueDetail = async (directoryId, teamId, workItemId, options) => {
    reads.push(options)
    return await readDetail(directoryId, teamId, workItemId, options)
  }
  const moved = await request(`/api/teams/core-team/weekly-reports/sato@example.com/${WEEK}`)
  // The Project decides visibility, so a move just made is read strongly consistent.
  expect(reads).toEqual([
    { consistentIssueRead: true, includeEvents: false },
    { consistentIssueRead: true, includeEvents: false },
  ])
  expect((await moved.json() as WeeklyReportResponse).submission?.sections.completed).toEqual([
    { hidden: true, minutes: 60 },
    { hidden: false, workItemId: 'b', key: 'SEC-1', title: 'Secret title', minutes: 30 },
  ])

  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    detailMissingIssueIds: ['a', 'b'],
  })
  const deleted = await request(`/api/teams/core-team/weekly-reports/sato@example.com/${WEEK}`)
  expect((await deleted.json() as WeeklyReportResponse).submission?.sections.completed).toEqual([
    { hidden: false, workItemId: 'a', key: 'REF-1', title: 'Visible title', minutes: 60 },
    { hidden: true, minutes: 30 },
  ])
})

test('hides a member outside the manager\'s Projects from that manager', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    mentionAccessDeniedMemberKeys: ['outsider@example.com'],
  })
  expect((await request(`/api/teams/core-team/weekly-reports/outsider@example.com/${WEEK}`)).status).toBe(404)
  expect((await request('/api/teams/core-team/weekly-reports/outsider@example.com')).status).toBe(404)
})

test('does not let a legacy membership of a Project ID several Teams share prove Team membership', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'refero', role: 'manager', teamId: 'core-team' }],
    projectAccessesByMember: {
      'legacy@example.com': [{ projectId: 'refero', role: 'member' }],
      'qualified@example.com': [{ projectId: 'refero', role: 'member', teamId: 'core-team' }],
    },
    additionalTeams: [{ id: 'other-team', name: 'Other Team', projects: [{ id: 'refero', name: 'Other Refero', tone: 'green' }] }],
  })
  expect((await request(`/api/teams/core-team/weekly-reports/legacy@example.com/${WEEK}`)).status).toBe(404)
  expect((await request(`/api/teams/core-team/weekly-reports/qualified@example.com/${WEEK}`)).status).toBe(200)
})

test('lets a legacy Workspace admin read every member of the Team', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin', projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  await seedSubmission('sato@example.com')
  const read = await request(`/api/teams/core-team/weekly-reports/sato@example.com/${WEEK}`)
  expect(read.status).toBe(200)
  expect((await read.json() as WeeklyReportResponse).submission?.version).toBe(1)
  expect((await request(`/api/teams/core-team/weekly-reports?weekStart=${WEEK}`)).status).toBe(200)
})

test('hides Work Items from an Enterprise role without work-items.read', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const readIdentity = identity.getSnapshot.bind(identity)
  const customRole: EnterpriseCustomRole = {
    workspaceId, roleId: 'custom:team-only', name: 'Team only',
    permissions: ['teams.read', 'teams.write', 'teams.manage', 'projects.read'],
    guestAssignable: false, revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }
  identity.getSnapshot = async (id) => ({
    ...await readIdentity(id),
    roleAssignments: [{
      workspaceId, assignmentId: 'team-only',
      principalKind: 'member', principalId: 'demo@example.com', roleId: customRole.roleId,
      scope: { workspaceId, kind: 'team', targetId: 'core-team' }, source: 'direct',
    }],
    customRoles: [customRole],
  })
  setTestAppDependencies({ enterpriseIdentity: identity })
  await seedSubmission('sato@example.com')

  const read = await request(`/api/teams/core-team/weekly-reports/sato@example.com/${WEEK}`)
  expect(read.status).toBe(200)
  const report = await read.json() as WeeklyReportResponse
  expect(report.submission?.sections.completed).toEqual([{ hidden: true, minutes: 60 }, { hidden: true, minutes: 30 }])
  expect(JSON.stringify(report)).not.toContain('Visible title')
})

test('refuses a submission past the most versions of a week', async () => {
  configureFakeProjectClients(true)
  for (let count = 0; count < 10; count += 1) {
    expect((await request(`${OWN_PATH}/submissions`, 'POST', submission(count), `limit-${count}`)).status).toBe(201)
  }
  const over = await request(`${OWN_PATH}/submissions`, 'POST', submission(10), 'limit-10')
  expect(over.status).toBe(413)
  expect(await over.json()).toMatchObject({ code: 'WeeklyReportSubmissionLimit' })
})

test('hides other members\' reports and the Team status from a member who manages nothing', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', projectAccesses: [{ projectId: 'refero', role: 'member' }] })
  expect((await request(`/api/teams/core-team/weekly-reports/sato@example.com/${WEEK}`)).status).toBe(404)
  expect((await request('/api/teams/core-team/weekly-reports/sato@example.com')).status).toBe(404)
  expect((await request(`/api/teams/core-team/weekly-reports?weekStart=${WEEK}`)).status).toBe(403)
})

test('requires a bearer token', async () => {
  const response = await app.request(OWN_PATH)
  expect(response.status).toBe(401)
})
