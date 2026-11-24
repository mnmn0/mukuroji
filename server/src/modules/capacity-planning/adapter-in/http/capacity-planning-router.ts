import { Hono, type Context } from 'hono'
import type {
  CapacityPlanningGranularity,
  WorkItemScheduleCalendarPolicy,
  WorkspaceWeekStartDay,
  WorkloadCalendarSource,
  ResourceAssignmentStatus,
  WorkloadTimeOff,
  WorkingSchedule,
  WorkingScheduleDay,
} from '@mukuroji/contracts'
import type { MutationAuditContext } from '../../../audit'
import { isWorkloadCalendarSource } from '@mukuroji/contracts'
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

/** Team authorization context reused by all workload operations in one request. */
export type CapacityPlanningTeamPermission = {
  /** Project IDs visible to the principal, or undefined for the whole Team. */
  visibleProjectIds?: ReadonlySet<string>
  /** All Project IDs belonging to the Team. */
  teamProjectIds?: readonly string[]
  /** Whether confidential workload records may be returned. */
  canViewConfidential?: boolean
}

/** Visibility derived from one request-scoped Team authorization context. */
export type CapacityPlanningVisibility = {
  /** Member IDs visible to the principal, or undefined for the whole Team. */
  visibleMemberIds?: ReadonlySet<string>
  /** Project IDs visible to the principal, or undefined for the whole Team. */
  visibleProjectIds?: ReadonlySet<string>
  /** Whether confidential workload records may be returned. */
  canViewConfidential: boolean
}

/** A Team the principal may view, with the permission checked for it. */
export type CapacityPlanningViewableTeam = {
  /** Team identifier. */
  teamId: string
  /** Team display name. */
  name: string
  /** Viewer permission already checked for the Team. */
  permission: CapacityPlanningTeamPermission
}

/** Dependencies injected into the capacity planning HTTP adapter. */
export type CapacityPlanningRouterDependencies<Principal extends CapacityPlanningPrincipal> = {
  /** Reads the bearer token from a request. */
  readBearerAccessToken(context: Context): string | undefined
  /** Resolves a bearer token to an authenticated Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** Verifies Team access for the requested operation. */
  requireTeamPermission(principal: Principal, teamId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<CapacityPlanningTeamPermission>
  /**
   * Lists the Teams whose workload the principal may view, with each Team's checked permission,
   * for the Workspace-wide workload read. Teams the principal cannot view are left out.
   */
  listWorkloadTeams(principal: Principal): Promise<CapacityPlanningViewableTeam[]>
  /** Resolves all workload visibility from the permission already checked by `withTeam`. */
  getWorkloadVisibility(principal: Principal, teamId: string, permission: CapacityPlanningTeamPermission): Promise<CapacityPlanningVisibility>
  /** Verifies that a member belongs to the authorized Team scope. */
  verifyMember(principal: Principal, teamId: string, memberId: string, permission: CapacityPlanningTeamPermission): Promise<void>
  /** Returns whether the principal may mutate another member's profile. */
  canManageMember(principal: Principal, teamId: string, memberId: string): Promise<boolean>
  /** Returns whether the principal is a Team manager who may review time off and assignments. */
  canManageTeam(principal: Principal, teamId: string): Promise<boolean>
  /** Creates the request audit context for a mutation, or undefined when audit is not recorded. */
  createAuditContext?(context: Context, principal: Principal, body: unknown): MutationAuditContext | undefined
  /** Verifies Project access for a mutation. */
  verifyProject(principal: Principal, teamId: string, projectId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<void>
  /** Verifies Work Item access and returns its owning Project when available. */
  verifyWorkItem(principal: Principal, teamId: string, workItemId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<string | undefined>
  /** Returns the service bound to the current app. */
  getCapacityPlanning(): CapacityPlanningService
  /**
   * Reads the Workspace calendar that inheriting profiles follow; the default Workspace calendar
   * is used when omitted.
   */
  readWorkspaceCalendar?(principal: Principal): Promise<WorkItemScheduleCalendarPolicy>
  /**
   * Lists the Workspace Teams that are not archived, whatever the caller may view, so archived
   * Teams' records stay out of Workspace-wide totals; every stored Team counts when omitted.
   */
  listActiveTeamIds?(principal: Principal): Promise<ReadonlySet<string>>
  /** Reads the day the Workspace week starts on; weekly buckets start on Monday when omitted. */
  readWeekStartDay?(principal: Principal): Promise<WorkspaceWeekStartDay>
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
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, permission) => {
      const fromDate = readRequiredQuery(context, 'from')
      const toDate = readRequiredQuery(context, 'to')
      const granularity = readGranularity(context.req.query('granularity'))
      const visibility = await dependencies.getWorkloadVisibility(principal, teamId, permission)
      const canManage = await dependencies.canManageTeam(principal, teamId)
      const snapshot = await dependencies.getCapacityPlanning().getSnapshot({
        workspaceId: principal.directoryId,
        teamId,
        fromDate,
        toDate,
        granularity,
        viewerMemberId: principal.userKey,
        viewer: { memberId: principal.userKey, canManage },
        ...(visibility.visibleMemberIds ? { visibleMemberIds: visibility.visibleMemberIds } : {}),
        ...(visibility.visibleProjectIds ? { visibleProjectIds: visibility.visibleProjectIds } : {}),
        canViewConfidential: visibility.canViewConfidential,
        ...await readWorkspaceCalendarInput(principal, dependencies),
        ...await readActiveTeamIdsInput(principal, dependencies),
        ...await readWeekStartDayInput(principal, dependencies),
      })
      return context.json(snapshot)
    })
  })

  router.get('/api/workload', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      const fromDate = readRequiredQuery(context, 'from')
      const toDate = readRequiredQuery(context, 'to')
      const granularity = readGranularity(context.req.query('granularity'))
      const teams = await dependencies.listWorkloadTeams(principal)
      const visibilities = await Promise.all(teams.map(async (team) => {
        const visibility = await dependencies.getWorkloadVisibility(principal, team.teamId, team.permission)
        return {
          teamId: team.teamId,
          name: team.name,
          ...(visibility.visibleMemberIds ? { visibleMemberIds: visibility.visibleMemberIds } : {}),
          ...(visibility.visibleProjectIds ? { visibleProjectIds: visibility.visibleProjectIds } : {}),
          canViewConfidential: visibility.canViewConfidential,
        }
      }))
      const snapshot = await dependencies.getCapacityPlanning().getWorkspaceSnapshot({
        workspaceId: principal.directoryId,
        fromDate,
        toDate,
        granularity,
        viewerMemberId: principal.userKey,
        teams: visibilities,
        ...await readWorkspaceCalendarInput(principal, dependencies),
        ...await readActiveTeamIdsInput(principal, dependencies),
        ...await readWeekStartDayInput(principal, dependencies),
      })
      return context.json(snapshot)
    })
  })

  router.put('/api/teams/:teamId/workload/profiles/:memberId', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId, permission) => {
      const memberId = readRequiredString(context.req.param('memberId'), 'Member ID')
      await dependencies.verifyMember(principal, teamId, memberId, permission)
      const canManage = await dependencies.canManageMember(principal, teamId, memberId)
      if (!canManage && memberId !== principal.userKey) {
        throw new CapacityPlanningError(403, 'WorkloadProfileDenied', 'Only the member or a Team manager may change this profile.')
      }
      const body = asRecord(await dependencies.readJson(context.req))
      const calendarSource = readCalendarSource(body.calendarSource)
      const result = await dependencies.getCapacityPlanning().saveMemberProfile({
        workspaceId: principal.directoryId,
        teamId,
        memberId,
        ...(readOptionalString(body.displayName) ? { displayName: readOptionalString(body.displayName) } : {}),
        ...(readOptionalString(body.role) ? { role: readOptionalString(body.role) } : {}),
        skills: readStringArray(body.skills, 'Skills'),
        ...(calendarSource === undefined ? {} : { calendarSource }),
        timeZone: readRequiredString(body.timeZone, 'Timezone'),
        schedule: readWorkingSchedule(body.schedule),
        holidays: readHolidays(body.holidays),
        expectedRevision: readRequiredInteger(body.expectedRevision, 'Expected profile revision'),
        expectedTeamRevision: readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision'),
        actorMemberId: principal.userKey,
      }, auditOptions(context, dependencies, principal, body))
      return context.json({ profile: result })
    })
  })

  router.put('/api/teams/:teamId/workload/profiles/:memberId/time-off/:timeOffId', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId, permission) => {
      const memberId = readRequiredString(context.req.param('memberId'), 'Member ID')
      await dependencies.verifyMember(principal, teamId, memberId, permission)
      const canManage = await dependencies.canManageMember(principal, teamId, memberId)
      if (!canManage && memberId !== principal.userKey) {
        throw new CapacityPlanningError(403, 'WorkloadTimeOffDenied', 'Only the member or a Team manager may change this time off.')
      }
      const body = asRecord(await dependencies.readJson(context.req))
      const status = readTimeOffStatus(body.status)
      if (status === 'approved' || status === 'rejected') await requireTimeOffReviewer(dependencies, principal, teamId)
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
      }, auditOptions(context, dependencies, principal, body))
      return context.json({ timeOff: result })
    })
  })

  router.patch('/api/teams/:teamId/workload/profiles/:memberId/time-off/:timeOffId', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId, permission) => {
      const memberId = readRequiredString(context.req.param('memberId'), 'Member ID')
      await dependencies.verifyMember(principal, teamId, memberId, permission)
      const body = asRecord(await dependencies.readJson(context.req))
      const status = readTimeOffStatus(body.status)
      // The member may withdraw or resubmit their own absence; only a Team manager decides it.
      if (status === 'approved' || status === 'rejected' || memberId !== principal.userKey) {
        await requireTimeOffReviewer(dependencies, principal, teamId)
      }
      const result = await dependencies.getCapacityPlanning().reviewTimeOff({
        workspaceId: principal.directoryId,
        teamId,
        memberId,
        timeOffId: readRequiredString(context.req.param('timeOffId'), 'Time-off ID'),
        status,
        expectedRevision: readRequiredInteger(body.expectedRevision, 'Expected time-off revision'),
        expectedTeamRevision: readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision'),
        actorMemberId: principal.userKey,
      }, auditOptions(context, dependencies, principal, body))
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
      }, auditOptions(context, dependencies, principal, body))
      return context.json({ request: result }, 201)
    })
  })

  router.patch('/api/teams/:teamId/workload/requests/:requestId', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, permission) => {
      const requestId = readRequiredString(context.req.param('requestId'), 'Request ID')
      const current = await dependencies.getCapacityPlanning().getRequest(principal.directoryId, teamId, requestId)
      if (current.projectId) await dependencies.verifyProject(principal, teamId, current.projectId, 'manager')
      const visibility = await dependencies.getWorkloadVisibility(principal, teamId, permission)
      if (current.confidential && !visibility.canViewConfidential) {
        throw new CapacityPlanningError(404, 'ResourceRequestNotFound', 'The resource request was not found.')
      }
      const body = asRecord(await dependencies.readJson(context.req))
      const cancelAssignments = body.cancelAssignments === undefined
        ? undefined
        : readRequiredBoolean(body.cancelAssignments, 'Cancel assignments')
      const expectedTeamRevision = readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision')
      const authorizedAssignmentIds = new Set<string>()
      if (cancelAssignments === true) {
        // Each assignment can belong to another Project or member than the request, so the cascade
        // checks every one as the single assignment PATCH would. The checks hold only for the plan
        // revision the cascade commits against, so a plan read at any other revision is refused.
        const { teamRevision, assignments } = await dependencies.getCapacityPlanning().listActiveRequestAssignments(principal.directoryId, teamId, requestId)
        if (teamRevision !== expectedTeamRevision) {
          throw new CapacityPlanningError(409, 'CapacityPlanningRevisionConflict', 'The workload plan was changed by another request.')
        }
        for (const projectId of new Set(assignments.flatMap((assignment) => assignment.projectId ? [assignment.projectId] : []))) {
          await dependencies.verifyProject(principal, teamId, projectId, 'manager')
        }
        for (const memberId of new Set(assignments.map((assignment) => assignment.memberId))) {
          await dependencies.verifyMember(principal, teamId, memberId, permission)
        }
        for (const assignment of assignments) authorizedAssignmentIds.add(assignment.id)
      }
      const access = { canViewConfidential: visibility.canViewConfidential, authorizedAssignmentIds }
      const result = await dependencies.getCapacityPlanning().updateRequest({
        workspaceId: principal.directoryId,
        teamId,
        requestId,
        ...(body.title === undefined ? {} : { title: readRequiredString(body.title, 'Request title') }),
        ...(body.role === undefined ? {} : { role: readClearableString(body.role, 'Request role') }),
        ...(body.skillIds === undefined ? {} : { skillIds: readStringArray(body.skillIds, 'Request skills') }),
        ...(body.fromDate === undefined ? {} : { fromDate: readRequiredString(body.fromDate, 'Start date') }),
        ...(body.toDate === undefined ? {} : { toDate: readRequiredString(body.toDate, 'End date') }),
        ...(body.requestedMinutes === undefined ? {} : { requestedMinutes: readRequiredInteger(body.requestedMinutes, 'Requested minutes') }),
        ...(body.confidential === undefined ? {} : { confidential: readRequiredBoolean(body.confidential, 'Confidential') }),
        ...(body.status === undefined ? {} : { status: readRequestCancelStatus(body.status) }),
        ...(cancelAssignments === undefined ? {} : { cancelAssignments }),
        expectedRevision: readRequiredInteger(body.expectedRevision, 'Expected request revision'),
        expectedTeamRevision,
        actorMemberId: principal.userKey,
      }, access, auditOptions(context, dependencies, principal, body))
      return context.json({ request: result })
    })
  })

  router.post('/api/teams/:teamId/workload/assignments', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, permission) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const memberId = readRequiredString(body.memberId, 'Member ID')
      await dependencies.verifyMember(principal, teamId, memberId, permission)
      const canManage = await dependencies.canManageMember(principal, teamId, memberId)
      if (!canManage) throw new CapacityPlanningError(403, 'ResourceAssignmentDenied', 'Only a Team manager may assign another member.')
      const projectId = readOptionalString(body.projectId)
      if (projectId) await dependencies.verifyProject(principal, teamId, projectId, 'manager')
      const requestId = readOptionalString(body.requestId)
      const request = requestId
        ? await dependencies.getCapacityPlanning().getRequest(principal.directoryId, teamId, requestId)
        : undefined
      if (request?.projectId) await dependencies.verifyProject(principal, teamId, request.projectId, 'manager')
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
        ...(requestId ? { requestId } : {}),
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
      }, auditOptions(context, dependencies, principal, body))
      return context.json({ assignment: result }, 201)
    })
  })

  router.patch('/api/teams/:teamId/workload/assignments/:assignmentId', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, permission) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const assignmentId = readRequiredString(context.req.param('assignmentId'), 'Assignment ID')
      const current = await dependencies.getCapacityPlanning().getAssignment(principal.directoryId, teamId, assignmentId)
      if (current.projectId) await dependencies.verifyProject(principal, teamId, current.projectId, 'manager')
      await dependencies.verifyMember(principal, teamId, current.memberId, permission)
      const nextMemberId = readOptionalString(body.memberId)
      if (nextMemberId) await dependencies.verifyMember(principal, teamId, nextMemberId, permission)
      const result = await dependencies.getCapacityPlanning().updateAssignment({
        workspaceId: principal.directoryId,
        teamId,
        assignmentId,
        ...(nextMemberId ? { memberId: nextMemberId } : {}),
        ...(readOptionalString(body.fromDate) ? { fromDate: readOptionalString(body.fromDate) } : {}),
        ...(readOptionalString(body.toDate) ? { toDate: readOptionalString(body.toDate) } : {}),
        ...(body.allocationMinutes === undefined ? {} : { allocationMinutes: readRequiredInteger(body.allocationMinutes, 'Allocation minutes') }),
        ...(body.plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes: readRequiredInteger(body.plannedEffortMinutes, 'Planned effort minutes') }),
        ...(body.status === undefined ? {} : { status: readAssignmentStatus(body.status) }),
        expectedRevision: readRequiredInteger(body.expectedRevision, 'Expected assignment revision'),
        expectedTeamRevision: readRequiredInteger(body.expectedTeamRevision, 'Expected Team revision'),
        actorMemberId: principal.userKey,
      }, auditOptions(context, dependencies, principal, body))
      return context.json({ assignment: result })
    })
  })

  router.post('/api/teams/:teamId/workload/what-if', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, permission) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const memberId = readRequiredString(body.memberId, 'Member ID')
      await dependencies.verifyMember(principal, teamId, memberId, permission)
      const visibility = await dependencies.getWorkloadVisibility(principal, teamId, permission)
      const result = await dependencies.getCapacityPlanning().whatIf({
        workspaceId: principal.directoryId,
        teamId,
        fromDate: readRequiredString(body.fromDate, 'Snapshot start date'),
        toDate: readRequiredString(body.toDate, 'Snapshot end date'),
        granularity: readGranularity(readOptionalString(body.granularity)),
        memberId,
        assignmentId: readOptionalString(body.assignmentId),
        assignmentFromDate: readRequiredString(body.assignmentFromDate, 'Assignment start date'),
        assignmentToDate: readRequiredString(body.assignmentToDate, 'Assignment end date'),
        allocationMinutes: readRequiredInteger(body.allocationMinutes, 'Allocation minutes'),
        plannedEffortMinutes: readRequiredInteger(body.plannedEffortMinutes, 'Planned effort minutes'),
        viewerMemberId: principal.userKey,
        ...(visibility.visibleMemberIds ? { visibleMemberIds: visibility.visibleMemberIds } : {}),
        ...(visibility.visibleProjectIds ? { visibleProjectIds: visibility.visibleProjectIds } : {}),
        canViewConfidential: visibility.canViewConfidential,
        ...await readWorkspaceCalendarInput(principal, dependencies),
        ...await readActiveTeamIdsInput(principal, dependencies),
        ...await readWeekStartDayInput(principal, dependencies),
      })
      return context.json(result)
    })
  })

  return router
}

/**
 * Requires a Team manager for approving or rejecting time off, or for changing another member's.
 *
 * @param dependencies - Router dependencies.
 * @param principal - Authenticated caller.
 * @param teamId - Team identifier.
 */
async function requireTimeOffReviewer<Principal extends CapacityPlanningPrincipal>(
  dependencies: CapacityPlanningRouterDependencies<Principal>,
  principal: Principal,
  teamId: string,
): Promise<void> {
  if (!await dependencies.canManageTeam(principal, teamId)) {
    throw new CapacityPlanningError(403, 'WorkloadTimeOffReviewDenied', 'Only a Team manager may approve, reject, or change another member\'s time off.')
  }
}

/**
 * Creates the audit options passed to a workload mutation.
 *
 * @param context - Hono request context.
 * @param dependencies - Router dependencies.
 * @param principal - Authenticated caller.
 * @param body - Parsed request body recorded in the audit fingerprint.
 * @returns Mutation options with the audit context, when audit is configured.
 */
function auditOptions<Principal extends CapacityPlanningPrincipal>(
  context: Context,
  dependencies: CapacityPlanningRouterDependencies<Principal>,
  principal: Principal,
  body: unknown,
): { auditContext?: MutationAuditContext } {
  const auditContext = dependencies.createAuditContext?.(context, principal, body)
  return auditContext ? { auditContext } : {}
}

/**
 * Reads the Teams that are not archived as optional snapshot input.
 *
 * @param principal - Authenticated caller.
 * @param dependencies - Router dependencies.
 * @returns `activeTeamIds` when the dependency is configured, otherwise nothing.
 */
async function readActiveTeamIdsInput<Principal extends CapacityPlanningPrincipal>(
  principal: Principal,
  dependencies: CapacityPlanningRouterDependencies<Principal>,
): Promise<{ activeTeamIds?: ReadonlySet<string> }> {
  return dependencies.listActiveTeamIds ? { activeTeamIds: await dependencies.listActiveTeamIds(principal) } : {}
}

/**
 * Reads the Workspace calendar a workload read passes to inheriting profiles.
 *
 * @param principal - Authenticated member whose Workspace is read.
 * @param dependencies - Router dependencies.
 * @returns The `workspaceCalendar` snapshot field, or nothing when the router has no reader.
 */
async function readWorkspaceCalendarInput<Principal extends CapacityPlanningPrincipal>(
  principal: Principal,
  dependencies: CapacityPlanningRouterDependencies<Principal>,
): Promise<{ workspaceCalendar?: WorkItemScheduleCalendarPolicy }> {
  if (!dependencies.readWorkspaceCalendar) return {}
  return { workspaceCalendar: await dependencies.readWorkspaceCalendar(principal) }
}

/**
 * Reads the Workspace week start a workload read buckets weeks by.
 *
 * @param principal - Authenticated member whose Workspace is read.
 * @param dependencies - Router dependencies.
 * @returns The `weekStartDay` snapshot field, or nothing when the router has no reader.
 */
async function readWeekStartDayInput<Principal extends CapacityPlanningPrincipal>(
  principal: Principal,
  dependencies: CapacityPlanningRouterDependencies<Principal>,
): Promise<{ weekStartDay?: WorkspaceWeekStartDay }> {
  if (!dependencies.readWeekStartDay) return {}
  return { weekStartDay: await dependencies.readWeekStartDay(principal) }
}

/**
 * Reads the optional calendar source of a profile update.
 *
 * @param value - Untrusted `calendarSource` field.
 * @returns The calendar source, or undefined when the field is missing.
 * @throws CapacityPlanningError When the field names no calendar source.
 */
function readCalendarSource(value: unknown): WorkloadCalendarSource | undefined {
  if (value === undefined) return undefined
  if (!isWorkloadCalendarSource(value)) {
    throw new CapacityPlanningError(400, 'InvalidCalendarSource', 'Calendar source must be workspace or custom.')
  }
  return value
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
  operation: (principal: Principal, teamId: string, permission: CapacityPlanningTeamPermission) => Promise<Response>,
): Promise<Response> {
  return await withAuthenticated(context, dependencies, async (principal) => {
    const teamId = readRequiredString(context.req.param('teamId'), 'Team ID')
    const permission = await dependencies.requireTeamPermission(principal, teamId, minimum)
    return await operation(principal, teamId, permission)
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

/** Reads a string that may be empty to clear an optional value. */
function readClearableString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new CapacityPlanningError(400, 'InvalidRequest', `${label} must be a string.`)
  return value.trim()
}

/** Reads a required query value. */
function readRequiredQuery(context: Context, name: string): string {
  return readRequiredString(context.req.query(name), name)
}

/** Reads a non-negative safe integer. */
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
  if (value === 'planned' || value === 'approved' || value === 'rejected' || value === 'canceled') return value
  throw new CapacityPlanningError(400, 'InvalidRequest', 'time-off status is invalid.')
}

/** Reads the only request status a client may set; fill states are derived from assignments. */
function readRequestCancelStatus(value: unknown): 'canceled' {
  if (value === 'canceled') return value
  throw new CapacityPlanningError(400, 'InvalidRequest', 'request status may only be set to canceled.')
}
