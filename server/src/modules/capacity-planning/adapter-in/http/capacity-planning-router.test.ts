import { describe, expect, test } from 'bun:test'
import type { MutationAuditContext } from '../../../audit'
import {
  CapacityPlanningError,
  CapacityPlanningService,
  createDefaultWorkingSchedule,
  InMemoryCapacityPlanningRepository,
  type CapacityPlanningDataSource,
} from '../../capacity-planning'
import {
  createCapacityPlanningRouter,
  type CapacityPlanningRouterDependencies,
} from './capacity-planning-router'

/** Minimal principal used by the capacity-planning router tests. */
type TestPrincipal = {
  /** Canonical Workspace identifier. */
  directoryId: string
  /** Canonical Workspace member key. */
  userKey: string
}

const principal: TestPrincipal = { directoryId: 'workspace-1', userKey: 'member-1' }

const auditContext: MutationAuditContext = {
  workspaceId: 'workspace-1',
  actor: { id: 'actor-1', kind: 'user' },
  source: { kind: 'api' },
  idempotencyKeyHash: 'hash-1',
  requestFingerprint: 'fingerprint-1',
  correlationId: 'correlation-1',
  occurredAt: '2026-08-02T12:00:00.000Z',
}

const emptyDataSource: CapacityPlanningDataSource = {
  listTimeEntries: async () => [],
  listEstimates: async () => [],
}

/** Creates a router with deterministic authentication and an in-memory service. */
function createFixture(options: { allowManager?: boolean; canViewConfidential?: boolean; deniedProjectIds?: string[] } = {}) {
  const calls: string[] = []
  const repository = new InMemoryCapacityPlanningRepository()
  const service = new CapacityPlanningService(
    repository,
    emptyDataSource,
    { now: () => new Date('2026-08-02T12:00:00.000Z'), createId: () => 'capacity-id-1' },
  )
  const dependencies: CapacityPlanningRouterDependencies<TestPrincipal> = {
    readBearerAccessToken: (context) => context.req.header('Authorization')?.replace(/^Bearer\s+/u, ''),
    authenticate: async (accessToken) => {
      calls.push(`authenticate:${accessToken}`)
      return principal
    },
    requireTeamPermission: async (_value, teamId, minimum) => {
      calls.push(`permission:${teamId}:${minimum}`)
      if (minimum === 'manager' && options.allowManager === false) {
        throw new CapacityPlanningError(403, 'PermissionDenied', 'manager required')
      }
      return {}
    },
    getWorkloadVisibility: async () => ({ canViewConfidential: options.canViewConfidential ?? false }),
    verifyMember: async () => undefined,
    canManageMember: async (_value, _teamId, memberId) => memberId === principal.userKey,
    canManageTeam: async (_value, teamId) => {
      calls.push(`manageTeam:${teamId}`)
      return options.allowManager !== false
    },
    createAuditContext: () => auditContext,
    verifyProject: async (_value, teamId, projectId, minimum) => {
      calls.push(`project:${teamId}:${projectId}:${minimum}`)
      if (options.deniedProjectIds?.includes(projectId)) {
        throw new CapacityPlanningError(403, 'ProjectPermissionDenied', 'project manager required')
      }
    },
    verifyWorkItem: async () => undefined,
    getCapacityPlanning: () => service,
    readJson: async (request) => await request.json(),
    mapError: (context, error) => context.json({
      code: error instanceof CapacityPlanningError ? error.code : 'mapped',
    }, 503),
  }
  return { calls, repository, router: createCapacityPlanningRouter(dependencies), service }
}

/** Creates one resource request through the service so routes can change it. */
async function seedRequest(
  service: CapacityPlanningService,
  overrides: { confidential?: boolean; projectId?: string } = {},
) {
  return await service.createRequest({
    workspaceId: principal.directoryId,
    teamId: 'team-1',
    ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
    title: 'Launch support',
    skillIds: [],
    fromDate: '2026-08-03',
    toDate: '2026-08-07',
    requestedMinutes: 480,
    confidential: overrides.confidential ?? false,
    expectedTeamRevision: 0,
    actorMemberId: principal.userKey,
  })
}

/** Creates a profile and one planned absence for a member through the service. */
async function seedTimeOff(service: CapacityPlanningService, memberId = principal.userKey) {
  const scope = { workspaceId: principal.directoryId, teamId: 'team-1', memberId, actorMemberId: memberId }
  const profile = await service.saveMemberProfile({
    ...scope,
    skills: [],
    timeZone: 'UTC',
    schedule: createDefaultWorkingSchedule(),
    holidays: [],
    expectedRevision: 0,
    expectedTeamRevision: 0,
  })
  const timeOff = await service.saveTimeOff({
    ...scope,
    id: 'time-off-1',
    fromDate: '2026-08-03',
    toDate: '2026-08-03',
    status: 'planned',
    expectedRevision: profile.revision,
    expectedTeamRevision: 1,
  })
  return { profile, timeOff }
}

describe('createCapacityPlanningRouter', () => {
  test('requires a bearer token and applies viewer permission to workload reads', async () => {
    const { calls, router } = createFixture()
    const unauthorized = await router.request('/api/teams/team-1/workload?from=2026-08-03&to=2026-08-03&granularity=day')
    const authorized = await router.request('/api/teams/team-1/workload?from=2026-08-03&to=2026-08-03&granularity=day', {
      headers: { Authorization: 'Bearer workload-token' },
    })

    expect(unauthorized.status).toBe(401)
    expect(authorized.status).toBe(200)
    expect(await authorized.json()).toMatchObject({ viewer: { memberId: 'member-1', canManage: true } })
    expect(calls).toEqual(['authenticate:workload-token', 'permission:team-1:viewer', 'manageTeam:team-1'])
  })

  test('requires manager permission for resource requests', async () => {
    const { calls, router } = createFixture()
    const response = await router.request('/api/teams/team-1/workload/requests', {
      method: 'POST',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Launch support',
        skillIds: ['support'],
        fromDate: '2026-08-03',
        toDate: '2026-08-07',
        requestedMinutes: 480,
        confidential: false,
        expectedTeamRevision: 0,
      }),
    })

    expect(response.status).toBe(201)
    expect(calls).toEqual(['authenticate:workload-token', 'permission:team-1:manager'])
  })

  test('rejects an assignment to another member before calling the service', async () => {
    const { calls, router } = createFixture()
    const response = await router.request('/api/teams/team-1/workload/assignments', {
      method: 'POST',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'member-2' }),
    })

    expect(response.status).toBe(503)
    expect(calls).toEqual(['authenticate:workload-token', 'permission:team-1:manager'])
  })

  test('does not let a member approve their own time off', async () => {
    const { calls, router } = createFixture({ allowManager: false })
    const response = await router.request('/api/teams/team-1/workload/profiles/member-1/time-off/time-off-1', {
      method: 'PUT',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromDate: '2026-08-03',
        toDate: '2026-08-03',
        status: 'approved',
        expectedRevision: 1,
        expectedTeamRevision: 0,
      }),
    })

    expect(await response.json()).toEqual({ code: 'WorkloadTimeOffReviewDenied' })
    expect(calls).toEqual([
      'authenticate:workload-token',
      'permission:team-1:member',
      'manageTeam:team-1',
    ])
  })

  test('lets only a Team manager approve or reject time off, and lets a member withdraw their own', async () => {
    const member = createFixture({ allowManager: false })
    const saved = await seedTimeOff(member.service)
    const send = async (router: typeof member.router, memberId: string, body: Record<string, unknown>) =>
      await router.request(`/api/teams/team-1/workload/profiles/${memberId}/time-off/${saved.timeOff.id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    const approvedByMember = await send(member.router, 'member-1', { status: 'approved', expectedRevision: 1, expectedTeamRevision: 2 })
    const rejectedByMember = await send(member.router, 'member-1', { status: 'rejected', expectedRevision: 1, expectedTeamRevision: 2 })
    const withdrawn = await send(member.router, 'member-1', { status: 'canceled', expectedRevision: 1, expectedTeamRevision: 2 })

    expect(await approvedByMember.json()).toEqual({ code: 'WorkloadTimeOffReviewDenied' })
    expect(await rejectedByMember.json()).toEqual({ code: 'WorkloadTimeOffReviewDenied' })
    expect(await withdrawn.json()).toMatchObject({ timeOff: { status: 'canceled', revision: 2 } })

    const manager = createFixture()
    const reviewed = await seedTimeOff(manager.service, 'member-2')
    const approved = await send(manager.router, 'member-2', { status: 'approved', expectedRevision: 1, expectedTeamRevision: 2 })
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ timeOff: { id: reviewed.timeOff.id, status: 'approved', reviewedBy: 'member-1' } })
    expect(manager.repository.auditLog.at(-1)?.events[0]).toMatchObject({
      eventType: 'workload.time-off.approved',
      metadata: { notificationCandidates: [{ memberKey: 'member-2', reason: 'time-off-review' }] },
    })
  })

  test('does not let a member change another member\'s time off status', async () => {
    const { router, service } = createFixture({ allowManager: false })
    const saved = await seedTimeOff(service, 'member-2')
    const response = await router.request(`/api/teams/team-1/workload/profiles/member-2/time-off/${saved.timeOff.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'canceled', expectedRevision: 1, expectedTeamRevision: 2 }),
    })

    expect(await response.json()).toEqual({ code: 'WorkloadTimeOffReviewDenied' })
  })

  test('lets a Project manager change and cancel a resource request', async () => {
    const { calls, router, service } = createFixture()
    const request = await seedRequest(service, { projectId: 'project-1' })
    calls.length = 0
    const changed = await router.request(`/api/teams/team-1/workload/requests/${request.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Launch hardening', requestedMinutes: 960, expectedRevision: 1, expectedTeamRevision: 1 }),
    })
    const canceled = await router.request(`/api/teams/team-1/workload/requests/${request.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'canceled', expectedRevision: 2, expectedTeamRevision: 2 }),
    })

    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ request: { title: 'Launch hardening', requestedMinutes: 960 } })
    expect(canceled.status).toBe(200)
    expect(await canceled.json()).toMatchObject({ request: { status: 'canceled', revision: 3 } })
    expect(calls.slice(0, 3)).toEqual([
      'authenticate:workload-token',
      'permission:team-1:manager',
      'project:team-1:project-1:manager',
    ])
  })

  test('checks the Project of every assignment before canceling them with a Team-wide request', async () => {
    const { calls, router, service } = createFixture({ deniedProjectIds: ['project-b'] })
    const request = await seedRequest(service)
    await service.saveMemberProfile({
      workspaceId: principal.directoryId, teamId: 'team-1', memberId: 'member-2', skills: [], timeZone: 'UTC',
      schedule: createDefaultWorkingSchedule(), holidays: [], expectedRevision: 0, expectedTeamRevision: 1, actorMemberId: 'member-2',
    })
    await service.createAssignment({
      workspaceId: principal.directoryId, teamId: 'team-1', requestId: request.id, projectId: 'project-b', memberId: 'member-2',
      skillIds: [], fromDate: '2026-08-03', toDate: '2026-08-03', allocationMinutes: 60, plannedEffortMinutes: 60,
      confidential: false, status: 'tentative', expectedTeamRevision: 2, actorMemberId: principal.userKey,
    })
    const current = await service.getRequest(principal.directoryId, 'team-1', request.id)
    calls.length = 0
    const response = await router.request(`/api/teams/team-1/workload/requests/${request.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'canceled', cancelAssignments: true, expectedRevision: current.revision, expectedTeamRevision: 3 }),
    })

    expect(await response.json()).toEqual({ code: 'ProjectPermissionDenied' })
    expect(calls).toContain('project:team-1:project-b:manager')
    expect(await service.listActiveRequestAssignments(principal.directoryId, 'team-1', request.id)).toHaveLength(1)
    expect((await service.getRequest(principal.directoryId, 'team-1', request.id)).status).not.toBe('canceled')
  })

  test('rejects a resource request change from a non-manager or an unsupported status', async () => {
    const { router, service } = createFixture({ allowManager: false })
    const request = await seedRequest(service)
    const denied = await router.request(`/api/teams/team-1/workload/requests/${request.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'canceled', expectedRevision: 1, expectedTeamRevision: 1 }),
    })
    const manager = createFixture()
    const managed = await seedRequest(manager.service)
    const invalid = await manager.router.request(`/api/teams/team-1/workload/requests/${managed.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'filled', expectedRevision: 1, expectedTeamRevision: 1 }),
    })

    expect(await denied.json()).toEqual({ code: 'PermissionDenied' })
    expect(await invalid.json()).toEqual({ code: 'InvalidRequest' })
    expect((await manager.service.getRequest(principal.directoryId, 'team-1', managed.id)).status).toBe('open')
  })

  test('hides a confidential resource request from a manager who cannot view confidential work', async () => {
    const hidden = createFixture({ canViewConfidential: false })
    const hiddenRequest = await seedRequest(hidden.service, { confidential: true })
    const response = await hidden.router.request(`/api/teams/team-1/workload/requests/${hiddenRequest.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'canceled', expectedRevision: 1, expectedTeamRevision: 1 }),
    })
    const visible = createFixture({ canViewConfidential: true })
    const visibleRequest = await seedRequest(visible.service, { confidential: true })
    const allowed = await visible.router.request(`/api/teams/team-1/workload/requests/${visibleRequest.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'canceled', expectedRevision: 1, expectedTeamRevision: 1 }),
    })

    expect(await response.json()).toEqual({ code: 'ResourceRequestNotFound' })
    expect((await hidden.service.getRequest(principal.directoryId, 'team-1', hiddenRequest.id)).status).toBe('open')
    expect(allowed.status).toBe(200)
  })
})
