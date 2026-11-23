import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import { InMemoryProjectRaidLogStore } from '../../adapter-out/dynamodb/project-raid-log-store'
import type { ProjectRaidEntryResponse, ProjectRaidLogResponse, ProjectRaidScheduleChange } from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/**
 * Finds a Project of the fake Team that the demo user may use.
 *
 * @returns The Project ID of the first fake Team Work Item.
 */
async function readProjectId(): Promise<string> {
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(
    'user#demo@example.com',
    'core-team',
  )
  const projectId = issues[0]?.assignedProjectId
  if (!projectId) throw new Error('The fake Team has no Project Work Item.')
  return projectId
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

test('creates, edits, closes, and lists Project log entries', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/raid-log`

  const empty = await request(path)
  expect(empty.status).toBe(200)
  expect(await empty.json()).toEqual({ teamId: 'core-team', projectId, entries: [], viewer: { canEdit: true, canDecide: true } })

  const created = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'risk', title: ' Vendor delay ', probability: 4, impact: 4, reviewDueDate: '2026-12-01', status: 'open' },
  }, 'create-1')
  expect(created.status).toBe(201)
  const createdEntry = (await created.json() as ProjectRaidEntryResponse).entry
  expect(createdEntry).toMatchObject({ kind: 'risk', title: 'Vendor delay', probability: 4, impact: 4, revision: 1, status: 'open' })

  const retried = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'risk', title: ' Vendor delay ', probability: 4, impact: 4, reviewDueDate: '2026-12-01', status: 'open' },
  }, 'create-1')
  expect(retried.status).toBe(201)
  expect((await retried.json() as ProjectRaidEntryResponse).entry.id).toBe(createdEntry.id)

  const reused = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'Other', impact: 2, status: 'open' },
  }, 'create-1')
  expect(reused.status).toBe(409)

  const closeBody = {
    expectedRevision: 1,
    entry: { kind: 'risk', title: 'Vendor delay', probability: 2, impact: 4, response: 'Second vendor signed', status: 'closed' },
  }
  const closed = await request(`${path}/entries/${createdEntry.id}`, 'PUT', closeBody, 'close-1')
  expect(closed.status).toBe(200)
  const closedEntry = (await closed.json() as ProjectRaidEntryResponse).entry

  const closeRetried = await request(`${path}/entries/${createdEntry.id}`, 'PUT', closeBody, 'close-1')
  expect(closeRetried.status).toBe(200)
  expect((await closeRetried.json() as ProjectRaidEntryResponse).entry).toEqual(closedEntry)
  expect(closedEntry).toMatchObject({ revision: 2, status: 'closed', response: 'Second vendor signed' })
  expect(closedEntry.reviewDueDate).toBeUndefined()
  expect(typeof closedEntry.closedAt).toBe('string')

  // The same key with other content on the new revision is a different request, not a retry.
  const reusedUpdateKey = await request(`${path}/entries/${createdEntry.id}`, 'PUT', {
    expectedRevision: 2,
    entry: { kind: 'risk', title: 'Vendor delay', probability: 1, impact: 1, status: 'open' },
  }, 'close-1')
  expect(reusedUpdateKey.status).toBe(409)
  expect(await reusedUpdateKey.json()).toMatchObject({ code: 'ProjectRaidEntryIdempotencyConflict' })

  const stale = await request(`${path}/entries/${createdEntry.id}`, 'PUT', {
    expectedRevision: 1,
    entry: { kind: 'risk', title: 'Vendor delay', probability: 2, impact: 4, status: 'open' },
  })
  expect(stale.status).toBe(409)

  const kindChange = await request(`${path}/entries/${createdEntry.id}`, 'PUT', {
    expectedRevision: 2,
    entry: { kind: 'issue', title: 'Vendor delay', impact: 4, status: 'open' },
  })
  expect(kindChange.status).toBe(400)

  const listed = await request(path)
  expect((await listed.json() as ProjectRaidLogResponse).entries).toEqual([closedEntry])
})

test('rejects invalid entries and unknown entry IDs', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/raid-log/entries`

  const invalid = await request(path, 'POST', { entry: { kind: 'risk', title: 'No probability', impact: 3, status: 'open' } })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ code: 'InvalidProjectRaidEntry' })

  const missing = await request(`${path}/unknown`, 'PUT', {
    expectedRevision: 1,
    entry: { kind: 'issue', title: 'A', impact: 3, status: 'open' },
  })
  expect(missing.status).toBe(404)
})

test('answers 404 for a Project outside the Team', async () => {
  configureFakeProjectClients(true)
  const response = await request('/api/teams/core-team/projects/not-in-team/raid-log')
  expect(response.status).toBe(404)
})

test('lets a Project viewer read the log but not change it', async () => {
  configureFakeProjectClients(true, { projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  const path = '/api/teams/core-team/projects/refero/raid-log'
  const read = await request(path)
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ viewer: { canEdit: false } })
  const response = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'A', impact: 3, status: 'open' },
  })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'ProjectRaidLogForbidden' })
})

/**
 * Grants the demo user one Enterprise role on the `refero` Project only.
 *
 * @param roleId - Built-in Project role to assign.
 */
function grantEnterpriseProjectRole(roleId: 'project:member' | 'project:viewer') {
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const readSnapshot = identity.getSnapshot.bind(identity)
  identity.getSnapshot = async (currentWorkspaceId) => ({
    ...await readSnapshot(currentWorkspaceId),
    roleAssignments: [{
      workspaceId,
      assignmentId: 'refero-grant',
      principalKind: 'member',
      principalId: 'demo@example.com',
      roleId,
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

test('reports edit access to an Enterprise member granted only on the Project', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, {
      workspaceRole: 'member',
      projectAccesses: [],
      teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
    })
    grantEnterpriseProjectRole('project:member')
    const path = '/api/teams/core-team/projects/refero/raid-log'
    const read = await requestAsEnterprise(path)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ viewer: { canEdit: true } })
    const created = await requestAsEnterprise(`${path}/entries`, 'POST', {
      entry: { kind: 'issue', title: 'A', impact: 3, status: 'open' },
    })
    expect(created.status).toBe(201)
  })
})

test('keeps an Enterprise Project viewer read-only', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    configureFakeProjectClients(true, {
      workspaceRole: 'member',
      projectAccesses: [],
      teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
    })
    grantEnterpriseProjectRole('project:viewer')
    const path = '/api/teams/core-team/projects/refero/raid-log'
    const read = await requestAsEnterprise(path)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ viewer: { canEdit: false } })
    const created = await requestAsEnterprise(`${path}/entries`, 'POST', {
      entry: { kind: 'issue', title: 'A', impact: 3, status: 'open' },
    })
    expect(created.status).toBe(403)
  })
})

test('refuses a change by a member without Project access', async () => {
  configureFakeProjectClients(false)
  const projectId = await readProjectId()
  const response = await request(`/api/teams/core-team/projects/${projectId}/raid-log/entries`, 'POST', {
    entry: { kind: 'issue', title: 'A', impact: 3, status: 'open' },
  })
  expect([403, 404]).toContain(response.status)
})

test('requires a bearer token', async () => {
  const response = await app.request('/api/teams/core-team/projects/p/raid-log')
  expect(response.status).toBe(401)
})

test('accepts a Project member as owner and Work Items of the same Project only', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/raid-log`
  const dependencies = getTestAppDependencies()
  const { members } = await dependencies.workspace.projectDirectory.getProjectMembers(
    'user#demo@example.com',
    projectId,
    'core-team',
  )
  const ownerMemberId = members[0]?.id
  if (!ownerMemberId) throw new Error('The fake Project has no member.')
  const { issues } = await dependencies.workItems.teamIssues.getTeamIssues('user#demo@example.com', 'core-team')
  const sameProject = issues.find((issue) => issue.assignedProjectId === projectId)
  const otherProject = issues.find((issue) => issue.assignedProjectId !== projectId)
  if (!sameProject) throw new Error('The fake Project has no Work Item.')

  const created = await request(`${path}/entries`, 'POST', {
    entry: {
      kind: 'issue',
      title: 'Build server down',
      impact: 3,
      ownerMemberId,
      relatedWorkItemIds: [sameProject.id, ` ${sameProject.id} `],
      status: 'open',
    },
  }, 'refs-1')
  expect(created.status).toBe(201)
  const entry = (await created.json() as ProjectRaidEntryResponse).entry
  expect(entry).toMatchObject({ ownerMemberId, relatedWorkItemIds: [sameProject.id] })

  const outsider = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'Outsider', impact: 3, ownerMemberId: 'nobody@example.com', status: 'open' },
  }, 'refs-2')
  expect(outsider.status).toBe(400)
  expect(await outsider.json()).toMatchObject({ code: 'InvalidProjectRaidEntry' })

  const missing = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'Missing', impact: 3, relatedWorkItemIds: ['wireframe'], status: 'open' },
  }, 'refs-3')
  expect(missing.status).toBe(400)

  if (otherProject) {
    const foreign = await request(`${path}/entries/${entry.id}`, 'PUT', {
      expectedRevision: 1,
      entry: { kind: 'issue', title: 'Build server down', impact: 3, relatedWorkItemIds: [sameProject.id, otherProject.id], status: 'open' },
    }, 'refs-4')
    expect(foreign.status).toBe(400)
  }

  const cleared = await request(`${path}/entries/${entry.id}`, 'PUT', {
    expectedRevision: 1,
    entry: { kind: 'issue', title: 'Build server down', impact: 3, status: 'open' },
  }, 'refs-5')
  expect(cleared.status).toBe(200)
  const clearedEntry = (await cleared.json() as ProjectRaidEntryResponse).entry
  expect(clearedEntry.ownerMemberId).toBeUndefined()
  expect(clearedEntry.relatedWorkItemIds).toBeUndefined()

  const tooMany = await request(`${path}/entries`, 'POST', {
    entry: {
      kind: 'issue',
      title: 'Too many',
      impact: 3,
      relatedWorkItemIds: Array.from({ length: 11 }, (_, index) => `item-${index}`),
      status: 'open',
    },
  }, 'refs-6')
  expect(tooMany.status).toBe(400)
})

test('fences another owner once and adds no second fence when the caller owns the entry', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/raid-log`
  const store = new InMemoryProjectRaidLogStore()
  const recorded: unknown[][] = []
  setTestAppDependencies({
    projectRaidLogs: {
      list: (scope) => store.list(scope),
      listOpenOwnedBy: (scope, owner) => store.listOpenOwnedBy(scope, owner),
      get: (scope, entryId) => store.get(scope, entryId),
      async create(input) {
        recorded.push([...input.callerAuthorization])
        return await store.create(input)
      },
      async update(input) {
        recorded.push([...input.callerAuthorization])
        return await store.update(input)
      },
    },
  })
  const dependencies = getTestAppDependencies()
  const fences: string[] = []
  const order: string[] = []
  const workspaceAccess = dependencies.workspace.workspaceAccess
  setTestAppDependencies({
    workspaceAccess: {
      ...workspaceAccess,
      getMember: workspaceAccess.getMember.bind(workspaceAccess),
      getActiveMember: workspaceAccess.getActiveMember.bind(workspaceAccess),
      async createActiveMemberConditionCheck(workspaceId: string, memberKey: string) {
        fences.push(memberKey)
        order.push('fence')
        return { ConditionCheck: { TableName: 'access', Key: { workspaceId, recordKey: `MEMBER#${memberKey}` }, ConditionExpression: 'attribute_exists(workspaceId)' } }
      },
    },
  })
  const projectDirectory = getTestAppDependencies().workspace.projectDirectory
  const listMembers = projectDirectory.getProjectMembers.bind(projectDirectory)
  setTestAppDependencies({
    projectDirectory: new Proxy(projectDirectory, {
      get(target, property, receiver) {
        if (property !== 'getProjectMembers') return Reflect.get(target, property, receiver)
        return async (workspaceId: string, requestedProjectId: string, teamId?: string) => {
          order.push('members')
          const response = await listMembers(workspaceId, requestedProjectId, teamId)
          const first = response.members[0]
          if (!first) throw new Error('The fake Project has no member.')
          return { ...response, members: [...response.members, { ...first, id: 'sato@example.com', email: 'sato@example.com' }] }
        }
      },
    }),
  })
  const self = { id: 'demo@example.com' }
  const other = { id: 'sato@example.com' }

  const own = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'Mine', impact: 2, ownerMemberId: self.id, status: 'open' },
  }, 'own-1')
  expect(own.status).toBe(201)
  expect(fences).toEqual([])
  const theirs = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'Theirs', impact: 2, ownerMemberId: other.id, status: 'open' },
  }, 'own-2')
  expect(theirs.status).toBe(201)
  expect(fences).toEqual([other.id])
  // The owner's version is fenced before membership is read, so a later removal fails the write.
  expect(order.slice(-2)).toEqual(['fence', 'members'])
  const { issues } = await dependencies.workItems.teamIssues.getTeamIssues('user#demo@example.com', 'core-team')
  const related = issues.find((issue) => issue.assignedProjectId === projectId)
  if (!related) throw new Error('The fake Project has no Work Item.')
  const linked = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'Linked', impact: 2, relatedWorkItemIds: [related.id], status: 'open' },
  }, 'own-3')
  expect(linked.status).toBe(201)
  expect(recorded.at(-1)).toContainEqual({
    ConditionCheck: expect.objectContaining({
      Key: { directoryTeamId: 'user#demo@example.com#team#core-team', issueId: related.id },
      ConditionExpression: 'attribute_exists(issueId) AND #assignedProjectId = :projectId',
      ExpressionAttributeValues: { ':projectId': projectId },
    }),
  })
  expect(recorded).toHaveLength(3)
  for (const checks of recorded) {
    const keys = checks.map((check) => JSON.stringify(check))
    expect(new Set(keys).size).toBe(keys.length)
  }
})

test('approves a change request with the captured baseline and rejects one without changes', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/raid-log`
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues('user#demo@example.com', 'core-team')
  const related = issues.find((issue) => issue.assignedProjectId === projectId)
  if (!related) throw new Error('The fake Project has no Work Item.')
  const scheduleChanges: ProjectRaidScheduleChange[] = [{ workItemId: related.id, operation: { type: 'move', targetDate: '2026-12-10' } }]

  const misplaced = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'risk', title: 'Risk', probability: 2, impact: 2, relatedWorkItemIds: [related.id], scheduleChanges, status: 'open' },
  }, 'cr-0')
  expect(misplaced.status).toBe(400)
  const unrelated = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'change-request', title: 'Move', impact: 3, scheduleChanges, status: 'open' },
  }, 'cr-0b')
  expect(unrelated.status).toBe(400)

  const create = async (title: string, key: string) => {
    const response = await request(`${path}/entries`, 'POST', {
      entry: { kind: 'change-request', title, impact: 3, relatedWorkItemIds: [related.id], scheduleChanges, status: 'open' },
    }, key)
    expect(response.status).toBe(201)
    return (await response.json() as ProjectRaidEntryResponse).entry
  }
  const rejectedRequest = await create('Add reports', 'cr-1')
  expect(rejectedRequest.scheduleChanges).toEqual(scheduleChanges)
  const rejected = await request(`${path}/entries/${rejectedRequest.id}/decision`, 'POST', {
    expectedRevision: 1,
    outcome: 'rejected',
  }, 'decide-1')
  expect(rejected.status).toBe(200)
  const rejectedEntry = (await rejected.json() as ProjectRaidEntryResponse).entry
  expect(rejectedEntry).toMatchObject({ status: 'closed', revision: 2, decision: { outcome: 'rejected', decidedByMemberId: 'demo@example.com' } })
  const replayed = await request(`${path}/entries/${rejectedRequest.id}/decision`, 'POST', {
    expectedRevision: 1,
    outcome: 'rejected',
  }, 'decide-1')
  expect((await replayed.json() as ProjectRaidEntryResponse).entry).toEqual(rejectedEntry)
  const again = await request(`${path}/entries/${rejectedRequest.id}/decision`, 'POST', {
    expectedRevision: 2,
    outcome: 'approved',
  }, 'decide-2')
  expect(again.status).toBe(409)
  const edited = await request(`${path}/entries/${rejectedRequest.id}`, 'PUT', {
    expectedRevision: 2,
    entry: { kind: 'change-request', title: 'Add reports', impact: 3, status: 'open' },
  }, 'edit-decided')
  expect(edited.status).toBe(409)

  const approvedRequest = await create('Move the launch', 'cr-2')
  const unknownBaseline = await request(`${path}/entries/${approvedRequest.id}/decision`, 'POST', {
    expectedRevision: 1,
    outcome: 'approved',
    baselineId: 'not-active',
  }, 'decide-3')
  expect(unknownBaseline.status).toBe(400)
  // The approver captured this baseline just before deciding.
  const activeBaselineId = 'baseline-cr-2'
  const baselines = getTestAppDependencies().workItems.scheduleBaselines
  setTestAppDependencies({
    scheduleBaselines: {
      getSaved: baselines.getSaved.bind(baselines),
      write: baselines.write.bind(baselines),
      async get() {
        return { id: activeBaselineId, revision: 3, capturedAt: '2026-11-23T00:00:00.000Z', entries: [], savedBaselines: [] }
      },
    },
  })
  const approved = await request(`${path}/entries/${approvedRequest.id}/decision`, 'POST', {
    expectedRevision: 1,
    outcome: 'approved',
    baselineId: activeBaselineId,
  }, 'decide-4')
  expect(approved.status).toBe(200)
  expect((await approved.json() as ProjectRaidEntryResponse).entry.decision).toMatchObject({ outcome: 'approved', baselineId: activeBaselineId })

  const risk = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'risk', title: 'Risk', probability: 2, impact: 2, status: 'open' },
  }, 'risk-1')
  const riskEntry = (await risk.json() as ProjectRaidEntryResponse).entry
  const notRequest = await request(`${path}/entries/${riskEntry.id}/decision`, 'POST', {
    expectedRevision: 1,
    outcome: 'approved',
  }, 'decide-5')
  expect(notRequest.status).toBe(400)
})
