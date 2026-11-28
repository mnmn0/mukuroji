import type {
  EnterprisePermissionId,
  ProjectDecisionEntryResponse,
  ProjectDecisionLogResponse,
  TeamDecisionLogResponse,
} from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Decision fields every test starts from. */
const baseEntry = {
  title: ' Keep decisions in DynamoDB ',
  content: 'Store each decision as one Planning-table row.',
  rationale: 'No new table to run.',
  decidedAt: '2026-11-27T01:00:00.000Z',
  sources: [{ url: 'https://example.slack.com/archives/C1/p1', label: 'Slack thread' }],
  status: 'active',
  origin: 'project',
}

/**
 * Finds a Project of the fake Team that the demo user may use, with one of its Work Items.
 *
 * @returns The Project ID and a Work Item assigned to it.
 */
async function readProject(): Promise<{ projectId: string; workItemId: string }> {
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(
    'user#demo@example.com',
    'core-team',
  )
  const issue = issues.find((candidate) => candidate.assignedProjectId !== undefined)
  if (!issue?.assignedProjectId) throw new Error('The fake Team has no Project Work Item.')
  return { projectId: issue.assignedProjectId, workItemId: issue.id }
}

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

test('records, retries, edits, supersedes, and lists decisions', async () => {
  configureFakeProjectClients(true)
  const { projectId, workItemId } = await readProject()
  const path = `/api/teams/core-team/projects/${projectId}/decision-log`

  const empty = await request(path)
  expect(empty.status).toBe(200)
  expect(await empty.json()).toEqual({ teamId: 'core-team', projectId, entries: [], viewer: { canEdit: true } })

  const body = { entry: { ...baseEntry, relatedWorkItemIds: [workItemId], origin: 'work-item' } }
  const created = await request(`${path}/entries`, 'POST', body, 'create-1')
  expect(created.status).toBe(201)
  const first = (await created.json() as ProjectDecisionEntryResponse).entry
  expect(first).toMatchObject({
    title: 'Keep decisions in DynamoDB',
    origin: 'work-item',
    relatedWorkItemIds: [workItemId],
    recordedByMemberId: 'demo@example.com',
    revision: 1,
  })

  const retried = await request(`${path}/entries`, 'POST', body, 'create-1')
  expect(retried.status).toBe(201)
  expect((await retried.json() as ProjectDecisionEntryResponse).entry.id).toBe(first.id)
  const reused = await request(`${path}/entries`, 'POST', { entry: { ...baseEntry, title: 'Other' } }, 'create-1')
  expect(reused.status).toBe(409)

  const second = (await (await request(`${path}/entries`, 'POST', {
    entry: { ...baseEntry, title: 'Move to S3 Vectors', decidedAt: '2026-11-28T01:00:00.000Z' },
  }, 'create-2')).json() as ProjectDecisionEntryResponse).entry

  const supersedeBody = {
    expectedRevision: 1,
    entry: { ...baseEntry, status: 'superseded', supersededByEntryId: second.id, origin: 'document' },
  }
  const superseded = await request(`${path}/entries/${first.id}`, 'PUT', supersedeBody, 'supersede-1')
  expect(superseded.status).toBe(200)
  const supersededEntry = (await superseded.json() as ProjectDecisionEntryResponse).entry
  // The origin and the recorder stay as recorded.
  expect(supersededEntry).toMatchObject({ status: 'superseded', supersededByEntryId: second.id, origin: 'work-item', revision: 2 })
  expect(supersededEntry.relatedWorkItemIds).toBeUndefined()
  const supersedeRetried = await request(`${path}/entries/${first.id}`, 'PUT', supersedeBody, 'supersede-1')
  expect((await supersedeRetried.json() as ProjectDecisionEntryResponse).entry).toEqual(supersededEntry)

  const stale = await request(`${path}/entries/${first.id}`, 'PUT', { ...supersedeBody, expectedRevision: 1 })
  expect(stale.status).toBe(409)

  const listed = await request(path)
  expect((await listed.json() as ProjectDecisionLogResponse).entries.map((entry) => entry.id)).toEqual([second.id, first.id])
})

test('rejects invalid decisions, a Slack origin, unknown replacements, and outsiders as deciders', async () => {
  configureFakeProjectClients(true)
  const { projectId } = await readProject()
  const path = `/api/teams/core-team/projects/${projectId}/decision-log/entries`

  const invalid = await request(path, 'POST', { entry: { ...baseEntry, content: ' ' } })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ code: 'InvalidProjectDecisionEntry' })

  const slack = await request(path, 'POST', { entry: { ...baseEntry, origin: 'slack' } })
  expect(slack.status).toBe(400)

  const future = await request(path, 'POST', { entry: { ...baseEntry, decidedAt: '2999-01-01T00:00:00.000Z' } })
  expect(future.status).toBe(400)

  const unsafeLink = await request(path, 'POST', { entry: { ...baseEntry, sources: [{ url: 'javascript:alert(1)' }] } })
  expect(unsafeLink.status).toBe(400)

  const unknownReplacement = await request(path, 'POST', {
    entry: { ...baseEntry, status: 'superseded', supersededByEntryId: 'missing' },
  })
  expect(unknownReplacement.status).toBe(400)

  const outsider = await request(path, 'POST', { entry: { ...baseEntry, deciderMemberIds: ['stranger@example.com'] } })
  expect(outsider.status).toBe(400)

  const { members } = await getTestAppDependencies().workspace.projectDirectory.getProjectMembers(
    'user#demo@example.com',
    projectId,
    'core-team',
  )
  const [member] = members
  if (!member) throw new Error('The fake Project has no member.')
  const accepted = await request(path, 'POST', { entry: { ...baseEntry, deciderMemberIds: [member.id] } }, 'decider-1')
  expect(accepted.status).toBe(201)

  const missing = await request(`${path}/unknown`, 'PUT', { expectedRevision: 1, entry: baseEntry })
  expect(missing.status).toBe(404)
})

test('answers 404 for a Project outside the Team', async () => {
  configureFakeProjectClients(true)
  const response = await request('/api/teams/core-team/projects/not-in-team/decision-log')
  expect(response.status).toBe(404)
})

test('lets a Project viewer read decisions but not record them', async () => {
  configureFakeProjectClients(true, { projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  const path = '/api/teams/core-team/projects/refero/decision-log'
  const read = await request(path)
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ viewer: { canEdit: false } })
  const response = await request(`${path}/entries`, 'POST', { entry: baseEntry })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'ProjectDecisionLogForbidden' })
})

test('merges decisions with decided change requests across the Projects the caller may see', async () => {
  configureFakeProjectClients(true)
  const { projectId } = await readProject()
  await request(`/api/teams/core-team/projects/${projectId}/decision-log/entries`, 'POST', { entry: baseEntry }, 'team-1')
  const raidPath = `/api/teams/core-team/projects/${projectId}/raid-log/entries`
  const changeRequest = (await (await request(raidPath, 'POST', {
    entry: { kind: 'change-request', title: 'Drop OpenSearch', impact: 3, status: 'open' },
  }, 'raid-1')).json() as { entry: { id: string; revision: number } }).entry
  const decided = await request(`${raidPath}/${changeRequest.id}/decision`, 'POST', {
    expectedRevision: changeRequest.revision,
    outcome: 'rejected',
  }, 'raid-decide-1')
  expect(decided.status).toBe(200)

  const all = await request('/api/teams/core-team/decision-log')
  expect(all.status).toBe(200)
  const allBody = await all.json() as TeamDecisionLogResponse
  // The change request was decided just now, after the decision's own time.
  expect(allBody.items.map((item) => item.kind)).toEqual(['change-request', 'decision'])
  expect(allBody.truncated).toBe(false)

  const filtered = await request('/api/teams/core-team/decision-log?q=dynamodb')
  expect((await filtered.json() as TeamDecisionLogResponse).items.map((item) => item.kind)).toEqual(['decision'])

  const otherProject = await request('/api/teams/core-team/decision-log?projectId=not-visible')
  expect((await otherProject.json() as TeamDecisionLogResponse).items).toEqual([])

  const tooLong = await request(`/api/teams/core-team/decision-log?q=${'a'.repeat(101)}`)
  expect(tooLong.status).toBe(400)
})

test('leaves out the Projects a Project-scoped member may not see', async () => {
  const teamProjects = [
    { id: 'refero', name: 'Refero', tone: 'blue' as const },
    { id: 'apollo', name: 'Apollo', tone: 'green' as const },
  ]
  configureFakeProjectClients(true, {
    teamProjects,
    projectAccesses: [{ projectId: 'refero', role: 'manager' }, { projectId: 'apollo', role: 'manager' }],
  })
  for (const projectId of ['refero', 'apollo']) {
    const created = await request(`/api/teams/core-team/projects/${projectId}/decision-log/entries`, 'POST', {
      entry: baseEntry,
    }, `hidden-${projectId}`)
    expect(created.status).toBe(201)
  }
  const store = getTestAppDependencies().workItems.projectDecisionLogs
  configureFakeProjectClients(true, { teamProjects, projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  setTestAppDependencies({ projectDecisionLogs: store })
  const response = await request('/api/teams/core-team/decision-log')
  expect(response.status).toBe(200)
  expect((await response.json() as TeamDecisionLogResponse).items.map((item) => item.projectId)).toEqual(['refero'])
})

/**
 * Grants the demo user one Enterprise role on the `refero` Project only.
 *
 * @param permissions - Permissions of the custom role.
 */
function grantEnterpriseProjectPermissions(permissions: EnterprisePermissionId[]) {
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const readSnapshot = identity.getSnapshot.bind(identity)
  identity.getSnapshot = async (currentWorkspaceId) => ({
    ...await readSnapshot(currentWorkspaceId),
    customRoles: [{
      workspaceId,
      roleId: 'custom:decision-writer',
      name: 'Decision writer',
      permissions,
      guestAssignable: false,
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    roleAssignments: [{
      workspaceId,
      assignmentId: 'refero-grant',
      principalKind: 'member',
      principalId: 'demo@example.com',
      roleId: 'custom:decision-writer',
      scope: { workspaceId, kind: 'project', targetId: 'refero', parentTeamId: 'core-team' },
      source: 'direct',
    }],
  })
  setTestAppDependencies({ enterpriseIdentity: identity })
}

/**
 * Sends a request as an Enterprise session.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @returns The response.
 */
function requestAsEnterprise(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${createAccessToken([], { client_id: 'mukuroji-main-client', token_use: 'access' })}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': 'enterprise-create' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Environment that turns the test session into an Enterprise session. */
const enterpriseEnvironment = {
  COGNITO_CLIENT_ID: 'mukuroji-main-client',
  COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
  COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
  ENTERPRISE_SSO_STATE_SECRET: 'test-sso-state-secret-with-at-least-32-characters',
}

test('lets an Enterprise writer record decisions only with projects.write', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, {
      workspaceRole: 'member',
      projectAccesses: [],
      teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
    })
    const path = '/api/teams/core-team/projects/refero/decision-log'
    grantEnterpriseProjectPermissions(['projects.read'])
    const viewerRead = await requestAsEnterprise(path)
    expect(viewerRead.status).toBe(200)
    expect(await viewerRead.json()).toMatchObject({ viewer: { canEdit: false } })
    expect((await requestAsEnterprise(`${path}/entries`, 'POST', { entry: baseEntry })).status).toBe(403)

    grantEnterpriseProjectPermissions(['projects.read', 'projects.write'])
    const writerRead = await requestAsEnterprise(path)
    expect(await writerRead.json()).toMatchObject({ viewer: { canEdit: true } })
    expect((await requestAsEnterprise(`${path}/entries`, 'POST', { entry: baseEntry })).status).toBe(201)
  })
})
