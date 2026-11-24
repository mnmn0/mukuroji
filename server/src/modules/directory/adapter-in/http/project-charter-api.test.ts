import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  planningApiRequest,
  resetTestApp,
} = createApiTestHarness()
import { afterEach, describe, expect, test } from 'bun:test'

afterEach(() => {
  resetTestApp()
})

const charterPath = '/api/teams/core-team/projects/refero/charter'
const lifecyclePath = '/api/teams/core-team/projects/refero/lifecycle'

/**
 * Sends an authenticated JSON request.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - Optional JSON body.
 * @returns The response.
 */
async function send(path: string, method: string, body?: unknown) {
  return await app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Project update target of the Project the charter tests edit. */
const updateTarget = { type: 'project', teamId: 'core-team', projectId: 'refero' }

/**
 * Configures a weekly update cadence owned by the given member.
 *
 * @param ownerMemberKey - Member who publishes the Project updates.
 */
async function configureUpdateCadence(ownerMemberKey: string) {
  const response = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target: updateTarget,
    cadence: {
      updateOwnerMemberKey: ownerMemberKey,
      cadence: { unit: 'week', count: 1 },
      timeZone: 'Asia/Tokyo',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 0,
  })
  expect(response.status).toBe(200)
}

/**
 * Reads the update owner of the Project's cadence from the Planning snapshot.
 *
 * @returns The member key, or undefined without a cadence.
 */
async function readUpdateOwner(): Promise<string | undefined> {
  const response = await planningApiRequest('/api/planning')
  const body: { updateTargets: Array<{ target: { projectId?: string }; cadence?: { updateOwnerMemberKey: string } }> } =
    await response.json()
  return body.updateTargets.find((candidate) => candidate.target.projectId === 'refero')?.cadence?.updateOwnerMemberKey
}

describe('Project charter API', () => {
  test('moves the health update owner to a new charter owner and leaves it when the owner stays', async () => {
    configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
    await configureUpdateCadence('demo@example.com')

    const saved = await send(charterPath, 'PUT', {
      expectedRevision: 0,
      charter: { ownerUserId: 'sato@example.com' },
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ updateOwnerSync: 'synced' })
    expect(await readUpdateOwner()).toBe('sato@example.com')

    // Saving other fields with the same owner does not touch the cadence.
    await configureUpdateCadenceOwnerDirectly('demo@example.com')
    const unchanged = await send(charterPath, 'PUT', {
      expectedRevision: 1,
      charter: { ownerUserId: 'sato@example.com', purpose: '更新' },
    })
    expect(unchanged.status).toBe(200)
    expect(await unchanged.json()).not.toHaveProperty('updateOwnerSync')
    expect(await readUpdateOwner()).toBe('demo@example.com')
  })

  test('keeps the update owner when the new charter owner cannot publish updates in the Project', async () => {
    // A Workspace owner without Project roles; owner@example.com has no access to the Project.
    configureFakeProjectClients(false, {
      workspaceRole: 'owner',
      systemAdminMemberKeys: ['demo@example.com'],
    })
    await configureUpdateCadence('demo@example.com')

    const saved = await send(charterPath, 'PUT', {
      expectedRevision: 0,
      charter: { ownerUserId: 'owner@example.com' },
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      charter: { owner: { userId: 'owner@example.com' } },
      updateOwnerSync: 'owner-not-eligible',
    })
    expect(await readUpdateOwner()).toBe('demo@example.com')
  })

  test('reports a Project without an update cadence and keeps the charter saved', async () => {
    configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })

    const saved = await send(charterPath, 'PUT', {
      expectedRevision: 0,
      charter: { ownerUserId: 'sato@example.com' },
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      charter: { owner: { userId: 'sato@example.com' } },
      updateOwnerSync: 'not-configured',
    })
  })


  test('reads the default charter of a legacy Project', async () => {
    configureFakeProjectClients(true)

    const response = await send(charterPath, 'GET')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      teamId: 'core-team',
      projectId: 'refero',
      lifecycleState: 'active',
      charter: { tags: [], repositoryUrls: [] },
      revision: 0,
      viewer: { canEdit: true, canDecideProposal: true },
    })
  })

  test.each([
    ['a Project manager', { workspaceRole: 'member' as const }, { canEdit: true, canDecideProposal: false }],
    ['a Project member', { role: 'member' as const, workspaceRole: 'member' as const }, { canEdit: false, canDecideProposal: false }],
  ])('tells %s which charter actions the server allows', async (_label, options, viewer) => {
    configureFakeProjectClients(true, options)

    const response = await send(charterPath, 'GET')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ viewer })
  })

  test('saves a charter with a resolved owner snapshot and audit context', async () => {
    const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

    const response = await send(charterPath, 'PUT', {
      expectedRevision: 0,
      charter: {
        code: 'ops-1',
        purpose: '社内基盤の刷新',
        ownerUserId: 'sato@example.com',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2027-03-31',
        tags: ['基盤'],
      },
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      revision: 1,
      charter: {
        code: 'OPS-1',
        owner: { userId: 'sato@example.com', displayName: '佐藤 花子' },
        plannedEndDate: '2027-03-31',
      },
    })
    expect(calls.projectCharterUpdates).toEqual([
      expect.objectContaining({
        teamId: 'core-team',
        projectId: 'refero',
        expectedRevision: 0,
        audited: true,
        authorizationRecordKeys: ['MEMBER#demo@example.com'],
      }),
    ])
  })

  test('rejects invalid charters, stale revisions, and inactive people', async () => {
    configureFakeProjectClients(true, { inactiveWorkspaceMemberKeys: ['suzuki@example.com'] })

    const invalid = await send(charterPath, 'PUT', {
      expectedRevision: 0,
      charter: { plannedStartDate: '2026-05-01', plannedEndDate: '2026-04-01' },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'InvalidProjectCharter' })

    const stale = await send(charterPath, 'PUT', { expectedRevision: 3, charter: {} })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'ProjectCharterRevisionConflict' })

    const inactive = await send(charterPath, 'PUT', {
      expectedRevision: 0,
      charter: { sponsorUserId: 'suzuki@example.com' },
    })
    expect(inactive.status).toBe(409)
    expect(await inactive.json()).toMatchObject({ code: 'ProjectCharterPersonInactive' })
  })

  test('lets a Workspace administrator without a Project role read the charter it may edit', async () => {
    configureFakeProjectClients(false)
    const administrator = await send(charterPath, 'GET')
    expect(administrator.status).toBe(200)
    expect(await administrator.json()).toMatchObject({ viewer: { canEdit: true } })

    resetTestApp()
    configureFakeProjectClients(false, { workspaceRole: 'member' })
    const member = await send(charterPath, 'GET')
    expect(member.status).toBe(403)
  })

  test('requires a Project manager or Workspace administrator to edit', async () => {
    const calls = configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })

    const charter = await send(charterPath, 'PUT', { expectedRevision: 0, charter: {} })
    const lifecycle = await send(lifecyclePath, 'POST', { expectedRevision: 0, state: 'on-hold' })

    expect(charter.status).toBe(403)
    expect(lifecycle.status).toBe(403)
    expect(calls.projectCharterUpdates).toEqual([])
    expect(calls.projectLifecycleTransitions).toEqual([])
  })

  test('requires a Workspace administrator to decide on a proposed Project', async () => {
    const calls = configureFakeProjectClients(true, {
      workspaceRole: 'member',
      projectLifecycleStates: { 'core-team/refero': 'proposed' },
    })

    const denied = await send(lifecyclePath, 'POST', { expectedRevision: 0, state: 'approved' })

    expect(denied.status).toBe(403)
    expect(calls.projectLifecycleTransitions).toEqual([])
  })

  test('lets a Workspace administrator approve a proposed Project', async () => {
    const calls = configureFakeProjectClients(true, {
      projectLifecycleStates: { 'core-team/refero': 'proposed' },
    })

    const approved = await send(lifecyclePath, 'POST', { expectedRevision: 0, state: 'approved' })
    const stale = await send(lifecyclePath, 'POST', { expectedRevision: 0, state: 'active' })

    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ lifecycleState: 'approved', revision: 1 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'ProjectCharterRevisionConflict' })
    expect(calls.projectLifecycleTransitions).toEqual([
      expect.objectContaining({ state: 'approved', expectedRevision: 0 }),
    ])
  })

  test('moves the lifecycle and rejects disallowed transitions', async () => {
    const calls = configureFakeProjectClients(true)

    const onHold = await send(lifecyclePath, 'POST', { expectedRevision: 0, state: 'on-hold' })
    expect(onHold.status).toBe(200)
    expect(await onHold.json()).toMatchObject({ lifecycleState: 'on-hold', revision: 1 })

    const backToProposal = await send(lifecyclePath, 'POST', { expectedRevision: 1, state: 'proposed' })
    expect(backToProposal.status).toBe(409)
    expect(await backToProposal.json()).toMatchObject({ code: 'ProjectLifecycleTransitionNotAllowed' })

    const unknown = await send(lifecyclePath, 'POST', { expectedRevision: 1, state: 'done' })
    expect(unknown.status).toBe(400)
    expect(calls.projectLifecycleTransitions).toEqual([
      expect.objectContaining({
        state: 'on-hold',
        expectedRevision: 0,
        audited: true,
        authorizationRecordKeys: ['MEMBER#demo@example.com'],
      }),
    ])
  })

  test('shows the lifecycle in the directory and rejects new Work Items in a closed Project', async () => {
    const calls = configureFakeProjectClients(true)

    const closed = await send(lifecyclePath, 'POST', { expectedRevision: 0, state: 'closed' })
    expect(closed.status).toBe(200)

    const directory = await send('/api/teams/projects', 'GET')
    expect(await directory.json()).toMatchObject({
      teams: [{ projects: [{ id: 'refero', lifecycleState: 'closed' }] }],
    })

    const created = await send('/api/teams/core-team/issues', 'POST', {
      title: 'Closed project work',
      assignedProjectId: 'refero',
    })
    expect(created.status).toBe(409)
    expect(await created.json()).toMatchObject({ code: 'ProjectClosedForNewWorkItems' })
    expect(calls.issueCreates).toEqual([])

    const reopened = await send(lifecyclePath, 'POST', { expectedRevision: 1, state: 'active' })
    expect(reopened.status).toBe(200)
  })
})

/**
 * Moves the cadence owner back through the cadence endpoint, as a person would in Planning.
 *
 * @param ownerMemberKey - Member who publishes the Project updates.
 */
async function configureUpdateCadenceOwnerDirectly(ownerMemberKey: string) {
  const snapshot: { revision: number } = await (await planningApiRequest('/api/planning')).json()
  const response = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target: updateTarget,
    cadence: {
      updateOwnerMemberKey: ownerMemberKey,
      cadence: { unit: 'week', count: 1 },
      timeZone: 'Asia/Tokyo',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: snapshot.revision,
  })
  expect(response.status).toBe(200)
}
