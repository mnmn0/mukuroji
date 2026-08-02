import { Hono, type Context } from 'hono'
import type {
  CapacityPlanningGranularity,
  ResourceAssignmentStatus,
  WorkloadTimeOff,
  WorkingSchedule,
  WorkingScheduleDay,
} from '@mukuroji/contracts'
import {
  CapacityPlanningError,
  type CapacityPlanningService,
} from '../../capacity-planning'

/** Minimum authenticated identity used by the capacity planning adapter. */
export type CapacityPlanningPrincipal = {
  /** Canonical Workspace identifier. */
  directoryId: string
  /** Canonical Workspace member key. */
  userKey: string
}

/** Dependencies injected into the capacity planning HTTP adapter. */
export type CapacityPlanningRouterDependencies<Principal extends CapacityPlanningPrincipal> = {
  /** Reads the bearer token from a request. */
  readBearerAccessToken(context: Context): string | undefined
  /** Resolves a bearer token to an authenticated Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** Verifies Team access for the requested operation. */
  requireTeamPermission(principal: Principal, teamId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<void>
  /** Returns whether the principal may view confidential allocations. */
  canViewConfidential(principal: Principal, teamId: string): Promise<boolean>
  /** Returns member IDs visible to the principal, or undefined for the whole Team. */
  getVisibleMemberIds(principal: Principal, teamId: string): Promise<ReadonlySet<string> | undefined>
  /** Returns Project IDs visible to the principal, or undefined for the whole Team. */
  getVisibleProjectIds(principal: Principal, teamId: string): Promise<ReadonlySet<string> | undefined>
  /** Returns whether the principal may mutate another member's profile. */
  canManageMember(principal: Principal, teamId: string, memberId: string): Promise<boolean>
  /** Verifies Project access for a mutation. */
  verifyProject(principal: Principal, teamId: string, projectId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<void>
  /** Verifies Work Item access and returns its owning Project when available. */
  verifyWorkItem(principal: Principal, teamId: string, workItemId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<string | undefined>
  /** Returns the service bound to the current app. */
  getCapacityPlanning(): CapacityPlanningService
  /** Safely parses a JSON request body. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Maps authentication, authorization, validation, and persistence failures to HTTP. */
  mapError(context: Context, error: unknown): Response
}

/** Creates authenticated workload, availability, resource request, and assignment routes. */
export function createCapacityPlanningRouter<Principal extends CapacityPlanningPrincipal>(
  dependencies: CapacityPlanningRouterDependencies<Principal>,
): Hono {
  const router = new Hono()

  router.get('/api/teams/:teamId/workload', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId) => {
      const fromDate = readRequiredQuery(context, 'from')
      const toDate = readRequiredQuery(context, 'to')
      const granularity = readGranularity(context.req.query('granularity'))
      const visibleMemberIds = await dependencies.getVisibleMemberIds(principal, teamId)
      const visibleProjectIds = await dependencies.getVisibleProjectIds(principal, teamId)
      const canViewConfidential = await dependencies.canViewConfidential(principal, teamId)
      const snapshot = await dependencies.getCapacityPlanning().getSnapshot({
        workspaceId: principal.directoryId,
        teamId,
        fromDate,
        toDate,
        granularity,
        viewerMemberId: principal.userKey,
        ...(visibleMemberIds ? { visibleMemberIds } : {}),
        ...(visibleProjectIds ? { visibleProjectIds } : {}),
        canViewConfidential,
      })
      return context.json(snapshot)
    })
  })

  router.put('/api/teams/:teamId/workload/profiles/:memberId', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId) => {
      const memberId = readRequiredString(context.req.param('memberId'), 'Member ID')
      const canManage = await dependencies.canManageMember(principal, teamId, memberId)
      if (!canManage && memberId !== principal.userKey) {
        throw new CapacityPlanningError(403, 'WorkloadProfileDenied', 'Only the member or a Team manager may change this profile.')
      }
      const body = asRecord(await dependencies.readJson(context.req))
      const result = await dependencies.getCapacityPlanning().saveMemberProfile({
        workspaceId: principal.directoryId,
        teamId,
        memberId,
        ...(readOptionalString(body.displayName) ? { displayName: readOptionalString(body.displayName) } : {}),
        ...(readOptionalString(body.role) ? { role: readOptionalString(body.role) } : {}),
        skills: readStringArray(body.skills, 'Skills'),
        timeZone: readRequiredString(body.timeZone, 'Timezone'),
        schedule: readWorkingSchedule(body.schedule),
        holidays: readHolidays(body.holidays),
        expectedRevision: readRequiredInteger(body.expectedRevision, 'Expected profile revision'),
        expectedTeamRevision: readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision'),
        actorMemberId: principal.userKey,
      })
      return context.json({ profile: result })
    })
  })

  router.put('/api/teams/:teamId/workload/profiles/:memberId/time-off/:timeOffId', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId) => {
      const memberId = readRequiredString(context.req.param('memberId'), 'Member ID')
      const canManage = await dependencies.canManageMember(principal, teamId, memberId)
      if (!canManage && memberId !== principal.userKey) {
        throw new CapacityPlanningError(403, 'WorkloadTimeOffDenied', 'Only the member or a Team manager may change this time off.')
      }
      const body = asRecord(await dependencies.readJson(context.req))
      const status = readTimeOffStatus(body.status)
      if (status === 'approved') await dependencies.requireTeamPermission(principal, teamId, 'manager')
      const timeOff: WorkloadTimeOff = {
        id: readRequiredString(context.req.param('timeOffId'), 'Time-off ID'),
        fromDate: readRequiredString(body.fromDate, 'Start date'),
        toDate: readRequiredString(body.toDate, 'End date'),
        ...(body.minutesPerDay === undefined ? {} : { minutesPerDay: readRequiredInteger(body.minutesPerDay, 'Time-off minutes') }),
        ...(readOptionalString(body.reason) ? { reason: readOptionalString(body.reason) } : {}),
        status,
        revision: 0,
      }
      const result = await dependencies.getCapacityPlanning().saveTimeOff({
        workspaceId: principal.directoryId,
        teamId,
        memberId,
        ...timeOff,
        expectedRevision: readRequiredInteger(body.expectedRevision, 'Expected profile revision'),
        expectedTeamRevision: readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision'),
        actorMemberId: principal.userKey,
      })
      return context.json({ timeOff: result })
    })
  })

  router.post('/api/teams/:teamId/workload/requests', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const projectId = readOptionalString(body.projectId)
      if (projectId) await dependencies.verifyProject(principal, teamId, projectId, 'manager')
      const result = await dependencies.getCapacityPlanning().createRequest({
        workspaceId: principal.directoryId,
        teamId,
        ...(projectId ? { projectId } : {}),
        title: readRequiredString(body.title, 'Request title'),
        ...(readOptionalString(body.role) ? { role: readOptionalString(body.role) } : {}),
        skillIds: readStringArray(body.skillIds, 'Request skills'),
        fromDate: readRequiredString(body.fromDate, 'Start date'),
        toDate: readRequiredString(body.toDate, 'End date'),
        requestedMinutes: readRequiredInteger(body.requestedMinutes, 'Requested minutes'),
        confidential: readRequiredBoolean(body.confidential, 'Confidential'),
        expectedTeamRevision: readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision'),
        actorMemberId: principal.userKey,
      })
      return context.json({ request: result }, 201)
    })
  })

  router.post('/api/teams/:teamId/workload/assignments', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const memberId = readRequiredString(body.memberId, 'Member ID')
      const canManage = await dependencies.canManageMember(principal, teamId, memberId)
      if (!canManage) throw new CapacityPlanningError(403, 'ResourceAssignmentDenied', 'Only a Team manager may assign another member.')
      const projectId = readOptionalString(body.projectId)
      if (projectId) await dependencies.verifyProject(principal, teamId, projectId, 'manager')
      const workItemId = readOptionalString(body.workItemId)
      const workItemProjectId = workItemId
        ? await dependencies.verifyWorkItem(principal, teamId, workItemId, 'manager')
        : undefined
      if (projectId && workItemProjectId && projectId !== workItemProjectId) {
        throw new CapacityPlanningError(400, 'InvalidRequest', 'The Work Item does not belong to the selected Project.')
      }
      const result = await dependencies.getCapacityPlanning().createAssignment({
        workspaceId: principal.directoryId,
        teamId,
        ...(readOptionalString(body.requestId) ? { requestId: readOptionalString(body.requestId) } : {}),
        ...((projectId ?? workItemProjectId) ? { projectId: projectId ?? workItemProjectId } : {}),
        ...(workItemId ? { workItemId } : {}),
        ...(readOptionalString(body.cycleId) ? { cycleId: readOptionalString(body.cycleId) } : {}),
        ...(readOptionalString(body.recurringWorkId) ? { recurringWorkId: readOptionalString(body.recurringWorkId) } : {}),
        memberId,
        ...(readOptionalString(body.role) ? { role: readOptionalString(body.role) } : {}),
        skillIds: readStringArray(body.skillIds, 'Assignment skills'),
        fromDate: readRequiredString(body.fromDate, 'Start date'),
        toDate: readRequiredString(body.toDate, 'End date'),
        allocationMinutes: readRequiredInteger(body.allocationMinutes, 'Allocation minutes'),
        plannedEffortMinutes: readRequiredInteger(body.plannedEffortMinutes, 'Planned effort minutes'),
        confidential: readRequiredBoolean(body.confidential, 'Confidential'),
        status: readAssignmentStatus(body.status),
        expectedTeamRevision: readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision'),
        actorMemberId: principal.userKey,
      })
      return context.json({ assignment: result }, 201)
    })
  })

  router.patch('/api/teams/:teamId/workload/assignments/:assignmentId', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const result = await dependencies.getCapacityPlanning().updateAssignment({
        workspaceId: principal.directoryId,
        teamId,
        assignmentId: readRequiredString(context.req.param('assignmentId'), 'Assignment ID'),
        ...(readOptionalString(body.memberId) ? { memberId: readOptionalString(body.memberId) } : {}),
        ...(readOptionalString(body.fromDate) ? { fromDate: readOptionalString(body.fromDate) } : {}),
        ...(readOptionalString(body.toDate) ? { toDate: readOptionalString(body.toDate) } : {}),
        ...(body.allocationMinutes === undefined ? {} : { allocationMinutes: readRequiredInteger(body.allocationMinutes, 'Allocation minutes') }),
        ...(body.plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes: readRequiredInteger(body.plannedEffortMinutes, 'Planned effort minutes') }),
        ...(body.status === undefined ? {} : { status: readAssignmentStatus(body.status) }),
        expectedRevision: readRequiredInteger(body.expectedRevision, 'Expected assignment revision'),
        expectedTeamRevision: readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision'),
        actorMemberId: principal.userKey,
      })
      return context.json({ assignment: result })
    })
  })

  router.post('/api/teams/:teamId/workload/what-if', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const visibleMemberIds = await dependencies.getVisibleMemberIds(principal, teamId)
      const visibleProjectIds = await dependencies.getVisibleProjectIds(principal, teamId)
      const canViewConfidential = await dependencies.canViewConfidential(principal, teamId)
      const result = await dependencies.getCapacityPlanning().whatIf({
        workspaceId: principal.directoryId,
        teamId,
        fromDate: readRequiredString(body.fromDate, 'Snapshot start date'),
        toDate: readRequiredString(body.toDate, 'Snapshot end date'),
        granularity: readGranularity(readOptionalString(body.granularity)),
        memberId: readRequiredString(body.memberId, 'Member ID'),
        assignmentId: readOptionalString(body.assignmentId),
        assignmentFromDate: readRequiredString(body.assignmentFromDate, 'Assignment start date'),
        assignmentToDate: readRequiredString(body.assignmentToDate, 'Assignment end date'),
        allocationMinutes: readRequiredInteger(body.allocationMinutes, 'Allocation minutes'),
        plannedEffortMinutes: readRequiredInteger(body.plannedEffortMinutes, 'Planned effort minutes'),
        viewerMemberId: principal.userKey,
        ...(visibleMemberIds ? { visibleMemberIds } : {}),
        ...(visibleProjectIds ? { visibleProjectIds } : {}),
        canViewConfidential,
      })
      return context.json(result)
    })
  })

  return router
}

/** Runs an operation after bearer authentication. */
async function withAuthenticated<Principal extends CapacityPlanningPrincipal>(
  context: Context,
  dependencies: CapacityPlanningRouterDependencies<Principal>,
  operation: (principal: Principal) => Promise<Response>,
): Promise<Response> {
  const accessToken = dependencies.readBearerAccessToken(context)
  if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
  try {
    return await operation(await dependencies.authenticate(accessToken, context))
  } catch (error) {
    return dependencies.mapError(context, error)
  }
}

/** Runs an operation after bearer authentication and Team authorization. */
async function withTeam<Principal extends CapacityPlanningPrincipal>(
  context: Context,
  dependencies: CapacityPlanningRouterDependencies<Principal>,
  minimum: 'viewer' | 'member' | 'manager',
  operation: (principal: Principal, teamId: string) => Promise<Response>,
): Promise<Response> {
  return await withAuthenticated(context, dependencies, async (principal) => {
    const teamId = readRequiredString(context.req.param('teamId'), 'Team ID')
    await dependencies.requireTeamPermission(principal, teamId, minimum)
    return await operation(principal, teamId)
  })
}

/** Converts unknown JSON into a record. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** Checks whether a value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a required string. */
function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new CapacityPlanningError(400, 'InvalidRequest', `${label} is required.`)
  return value.trim()
}

/** Reads an optional string. */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Reads a required query value. */
function readRequiredQuery(context: Context, name: string): string {
  return readRequiredString(context.req.query(name), name)
}

/** Reads a bounded integer. */
function readRequiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CapacityPlanningError(400, 'InvalidRequest', `${label} must be a non-negative integer.`)
  return value
}

/** Reads a required boolean. */
function readRequiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new CapacityPlanningError(400, 'InvalidRequest', `${label} must be a boolean.`)
  return value
}

/** Reads a bounded string array. */
function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new CapacityPlanningError(400, 'InvalidRequest', `${label} must be an array of strings.`)
  return value.map((entry) => entry.trim()).filter(Boolean)
}

/** Reads and validates a working schedule shape. */
function readWorkingSchedule(value: unknown): WorkingSchedule {
  if (!isRecord(value)) throw new CapacityPlanningError(400, 'InvalidRequest', 'schedule is required.')
  const readDay = (dayValue: unknown): WorkingScheduleDay => {
    if (!isRecord(dayValue) || typeof dayValue.enabled !== 'boolean' || typeof dayValue.minutes !== 'number') {
      throw new CapacityPlanningError(400, 'InvalidRequest', 'schedule contains an invalid weekday.')
    }
    return { enabled: dayValue.enabled, minutes: dayValue.minutes }
  }
  return {
    monday: readDay(value.monday),
    tuesday: readDay(value.tuesday),
    wednesday: readDay(value.wednesday),
    thursday: readDay(value.thursday),
    friday: readDay(value.friday),
    saturday: readDay(value.saturday),
    sunday: readDay(value.sunday),
  }
}

/** Reads holiday values. */
function readHolidays(value: unknown): Array<{ date: string; label?: string }> {
  if (!Array.isArray(value)) throw new CapacityPlanningError(400, 'InvalidRequest', 'holidays must be an array.')
  return value.map((entry) => {
    if (!isRecord(entry)) throw new CapacityPlanningError(400, 'InvalidRequest', 'holiday is invalid.')
    return {
      date: readRequiredString(entry.date, 'Holiday date'),
      ...(readOptionalString(entry.label) ? { label: readOptionalString(entry.label) } : {}),
    }
  })
}

/** Reads the supported workload granularity. */
function readGranularity(value: string | undefined): CapacityPlanningGranularity {
  if (value === 'day' || value === 'week' || value === 'month') return value
  throw new CapacityPlanningError(400, 'InvalidGranularity', 'granularity must be day, week, or month.')
}

/** Reads an assignment lifecycle state. */
function readAssignmentStatus(value: unknown): ResourceAssignmentStatus {
  if (value === 'tentative' || value === 'confirmed' || value === 'canceled') return value
  throw new CapacityPlanningError(400, 'InvalidRequest', 'assignment status is invalid.')
}

/** Reads a time-off lifecycle state. */
function readTimeOffStatus(value: unknown): WorkloadTimeOff['status'] {
  if (value === 'planned' || value === 'approved' || value === 'canceled') return value
  throw new CapacityPlanningError(400, 'InvalidRequest', 'time-off status is invalid.')
}
