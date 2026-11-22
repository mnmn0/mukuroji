import type { Context, Hono } from 'hono'
import {
  DEFAULT_WORK_CALENDAR_ADJUSTMENT,
  WORK_CALENDAR_CHANGE_MAX_WORK_ITEMS,
  WORK_ITEM_HIERARCHY_MAX_ITEMS,
  isWorkCalendarAdjustment,
  readWorkCalendarOverrides,
  readWorkspaceCalendarSettings,
  type WorkCalendar,
  type WorkCalendarAdjustment,
  type WorkCalendarChangeResult,
  type WorkCalendarOverrides,
  type WorkCalendarResponse,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  InvalidStoredWorkCalendarError,
  WorkCalendarRevisionConflictError,
  type StoredWorkCalendarScope,
} from '../../modules/tenant-administration'
import { WORK_ITEM_SCHEDULE_CASCADE_LIMIT, type TeamIssueResponseItem } from '../../modules/work-items'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { toWorkItemConfigurationErrorResponse } from '../shared/collaboration-access'
import { readBearerAccessToken } from '../shared/http'
import {
  canAccessAssignedProject,
  createApiMutationContext,
  requireAssignedProjectPermission,
  requireTeamConfigurationAdministration,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import type { TeamPermissionContext } from '../shared/workspace-access'
import {
  planWorkCalendarChange,
  readTeamWorkCalendars,
  readWorkspaceCalendarInputs,
  resolveWorkCalendarPolicyFrom,
  type TeamWorkCalendars,
  type WorkCalendarChangePlan,
  type WorkspaceCalendarInputs,
} from '../shared/workspace-calendar'

/** Largest calendar request body, in UTF-16 code units. */
const MAX_WORK_CALENDAR_BODY_LENGTH = 32_768

/**
 * Registers the shared Team and Project calendar endpoints (ADR 0058).
 *
 * Every Team member reads the calendar new Work Items take. A Team calendar is changed by a member
 * who administers the Team configuration, and a Project calendar also by its Project manager. A
 * change is previewed first; saving it rewrites the schedules of the Work Items that follow the
 * calendar, keeping either their working days or their end dates. Workspace administrators
 * preview a Workspace calendar change and apply the saved Workspace calendar the same way.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerWorkCalendarRoutes(routeApp: Hono): void {
  /** Returns a Team or Project calendar with the calendar new Work Items there take. */
  routeApp.get('/api/teams/:teamId/work-calendar', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const teamId = readTeamId(c)
      const projectId = readOptionalProjectId(c.req.query('projectId'))
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      const scope = createScope(context, teamId, projectId)
      if (scope.kind === 'project') requireAssignedProjectPermission(principal, context, scope.projectId, 'viewer')
      const [inputs, calendars] = await Promise.all([
        readWorkspaceCalendarInputs(principal.directoryId),
        readTeamWorkCalendars(principal.directoryId, teamId),
      ])
      const own = scope.kind === 'team' ? calendars.team : calendars.projects.get(scope.projectId)
      const response: WorkCalendarResponse = {
        scope,
        ...(own ? { calendar: own } : {}),
        ...(scope.kind === 'project' && calendars.team ? { teamCalendar: calendars.team } : {}),
        changeAdjustment: calendars.team?.changeAdjustment ?? DEFAULT_WORK_CALENDAR_ADJUSTMENT,
        resolvedPolicy: resolveWorkCalendarPolicyFrom(
          inputs,
          calendars.team,
          scope.kind === 'project' ? calendars.projects.get(scope.projectId) : undefined,
        ),
        canManage: await canManageCalendar(principal, context, scope),
      }
      return c.json(response)
    } catch (error) {
      return toWorkCalendarErrorResponse(c, error)
    }
  })

  /** Shows what a Team or Project calendar change would do without saving it. */
  routeApp.post('/api/teams/:teamId/work-calendar/preview', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const teamId = readTeamId(c)
      const input = readChangeInput(await readJsonBody(c), false)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      const scope = createScope(context, teamId, input.projectId)
      await requireCalendarManager(principal, context, scope)
      const plan = await planTeamCalendarChange(principal, context, scope, input.overrides, input.adjustment)
      return c.json(plan.impact)
    } catch (error) {
      return toWorkCalendarErrorResponse(c, error)
    }
  })

  /** Saves a Team or Project calendar and adjusts the Work Items that follow it. */
  routeApp.put('/api/teams/:teamId/work-calendar', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const teamId = readTeamId(c)
      const body = await readJsonBody(c)
      const input = readChangeInput(body, true)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      const scope = createScope(context, teamId, input.projectId)
      await requireCalendarManager(principal, context, scope)
      const plan = await planTeamCalendarChange(principal, context, scope, input.overrides, input.adjustment)
      requireApplicablePlan(plan)
      const calendar = await workspaceDependencies.workCalendars.save(
        principal.directoryId,
        {
          scope,
          overrides: input.overrides,
          ...(scope.kind === 'team' ? { changeAdjustment: input.adjustment } : {}),
        },
        input.expectedRevision,
        principal.userKey,
        new Date().toISOString(),
      )
      const applied = await applyPlan(c, principal, plan, body)
      const result: WorkCalendarChangeResult = { calendar, impact: plan.impact, ...applied }
      return c.json(result)
    } catch (error) {
      return toWorkCalendarErrorResponse(c, error)
    }
  })

  /** Shows what saving new Workspace calendar settings would do to the Work Items that follow it. */
  routeApp.post('/api/workspace/work-calendar/preview', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const body = await readJsonBody(c)
      const adjustment = readAdjustment(body)
      const calendar = readWorkspaceCalendarSettings(readRecord(body).calendar)
      if (!calendar) throw invalidRequest('calendar is not valid Workspace calendar settings.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      requireWorkspaceAdministration(principal)
      const current = await readWorkspaceCalendarInputs(principal.directoryId)
      const candidate: WorkspaceCalendarInputs = calendar.publicHolidays === 'japan'
        ? { settings: calendar, nationalHolidayDates: await workspaceDependencies.nationalHolidays.listDates() }
        : { settings: calendar }
      const plan = await planWorkspaceCalendarChange(principal, current, candidate, adjustment)
      return c.json(plan.impact)
    } catch (error) {
      return toWorkCalendarErrorResponse(c, error)
    }
  })

  /** Adjusts the Work Items that follow the saved Workspace calendar. */
  routeApp.post('/api/workspace/work-calendar/apply', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const body = await readJsonBody(c)
      const adjustment = readAdjustment(body)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      requireWorkspaceAdministration(principal)
      const current = await readWorkspaceCalendarInputs(principal.directoryId)
      const plan = await planWorkspaceCalendarChange(principal, current, current, adjustment)
      requireApplicablePlan(plan)
      const applied = await applyPlan(c, principal, plan, body)
      const result: WorkCalendarChangeResult = { impact: plan.impact, ...applied }
      return c.json(result)
    } catch (error) {
      return toWorkCalendarErrorResponse(c, error)
    }
  })
}

/**
 * Plans a Team or Project calendar change over the Team's Work Items.
 *
 * @param principal - Authenticated principal, for the examples it may see.
 * @param context - Team permission context.
 * @param scope - Calendar that changes.
 * @param overrides - New rules of the calendar.
 * @param adjustment - How date ranges keep their dates.
 * @returns The plan.
 */
async function planTeamCalendarChange(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  scope: StoredWorkCalendarScope,
  overrides: WorkCalendarOverrides,
  adjustment: WorkCalendarAdjustment,
): Promise<WorkCalendarChangePlan> {
  const [inputs, calendars, workItems] = await Promise.all([
    readWorkspaceCalendarInputs(principal.directoryId),
    readTeamWorkCalendars(principal.directoryId, scope.teamId),
    readTeamWorkItems(principal.directoryId, scope.teamId),
  ])
  const changed: TeamWorkCalendars = scope.kind === 'team'
    ? { team: toCandidateCalendar(calendars.team, scope, overrides), projects: calendars.projects }
    : {
        ...(calendars.team ? { team: calendars.team } : {}),
        projects: new Map([
          ...calendars.projects,
          [scope.projectId, toCandidateCalendar(calendars.projects.get(scope.projectId), scope, overrides)],
        ]),
      }
  return planWorkCalendarChange({
    workItems,
    before: createResolver(inputs, calendars),
    after: createResolver(inputs, changed),
    adjustment,
    canShowExample: (workItem) =>
      canAccessAssignedProject(principal, context, workItem.assignedProjectId, 'viewer'),
    adoptLegacy: true,
  })
}

/**
 * Plans a Workspace calendar change over every Team's Work Items.
 *
 * Examples are limited to Work Items the administrator may see in their Team.
 *
 * @param principal - Authenticated Workspace administrator.
 * @param current - Saved Workspace calendar inputs.
 * @param candidate - Workspace calendar inputs after the change.
 * @param adjustment - How date ranges keep their dates.
 * @returns The plan.
 */
async function planWorkspaceCalendarChange(
  principal: WorkspacePrincipal,
  current: WorkspaceCalendarInputs,
  candidate: WorkspaceCalendarInputs,
  adjustment: WorkCalendarAdjustment,
): Promise<WorkCalendarChangePlan> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const teams = await Promise.all(directory.teams.map(async (team) => ({
    teamId: team.id,
    calendars: await readTeamWorkCalendars(principal.directoryId, team.id),
    workItems: await readTeamWorkItems(principal.directoryId, team.id),
    context: await requireTeamPermission(principal, team.id, 'viewer').catch(() => undefined),
  })))
  const calendarsByTeam = new Map(teams.map((team) => [team.teamId, team.calendars]))
  const contextsByTeam = new Map(teams.map((team) => [team.teamId, team.context]))
  const resolverFor = (inputs: WorkspaceCalendarInputs) => (workItem: TeamIssueResponseItem) =>
    createResolver(inputs, calendarsByTeam.get(workItem.teamId) ?? { projects: new Map() })(workItem)
  return planWorkCalendarChange({
    workItems: teams.flatMap((team) => team.workItems),
    before: resolverFor(current),
    after: resolverFor(candidate),
    adjustment,
    canShowExample: (workItem) => {
      const context = contextsByTeam.get(workItem.teamId)
      return context !== undefined &&
        canAccessAssignedProject(principal, context, workItem.assignedProjectId, 'viewer')
    },
    adoptLegacy: false,
  })
}

/**
 * Creates the resolver of the shared calendar each Work Item of a Team follows.
 *
 * @param inputs - Workspace calendar inputs.
 * @param calendars - Team and Project calendars.
 * @returns A resolver keyed by the Work Item's Project.
 */
function createResolver(
  inputs: WorkspaceCalendarInputs,
  calendars: TeamWorkCalendars,
): (workItem: TeamIssueResponseItem) => WorkItemScheduleCalendarPolicy {
  const cache = new Map<string, WorkItemScheduleCalendarPolicy>()
  return (workItem) => {
    const projectKey = workItem.assignedProjectId ?? ''
    const cached = cache.get(projectKey)
    if (cached) return cached
    const policy = resolveWorkCalendarPolicyFrom(
      inputs,
      calendars.team,
      workItem.assignedProjectId === undefined ? undefined : calendars.projects.get(workItem.assignedProjectId),
    )
    cache.set(projectKey, policy)
    return policy
  }
}

/**
 * Builds the calendar a change would store, for planning before the save.
 *
 * @param current - Stored calendar, if any.
 * @param scope - Calendar scope.
 * @param overrides - New rules.
 * @returns A calendar carrying the new rules.
 */
function toCandidateCalendar(
  current: WorkCalendar | undefined,
  scope: StoredWorkCalendarScope,
  overrides: WorkCalendarOverrides,
): WorkCalendar {
  return {
    ...overrides,
    scope,
    revision: (current?.revision ?? 0) + 1,
    updatedAt: current?.updatedAt ?? new Date(0).toISOString(),
    updatedBy: current?.updatedBy ?? 'preview',
  }
}

/**
 * Reads the non-archived Work Items of a Team for a calendar change.
 *
 * @param directoryId - Workspace directory.
 * @param teamId - Team to read.
 * @returns The Work Items.
 * @throws ProjectDataError 413 when the Team has more than the hierarchy read limit.
 */
async function readTeamWorkItems(directoryId: string, teamId: string): Promise<TeamIssueResponseItem[]> {
  const { teamIssues } = workItemDependencies
  if (!teamIssues.getTeamHierarchyEntries) {
    throw new ProjectDataError(503, 'WorkCalendarUnavailable', 'Work Items cannot be read for a calendar change.')
  }
  const entries = await teamIssues.getTeamHierarchyEntries(directoryId, teamId, WORK_ITEM_HIERARCHY_MAX_ITEMS)
  if (entries.length > WORK_ITEM_HIERARCHY_MAX_ITEMS) {
    throw new ProjectDataError(
      413,
      'WorkCalendarChangeTooLarge',
      `A Team with more than ${WORK_ITEM_HIERARCHY_MAX_ITEMS} Work Items cannot change its calendar here.`,
    )
  }
  return entries.map((entry) => entry.issue)
}

/**
 * Refuses a change that would rewrite more Work Items than one save may.
 *
 * @param plan - Planned change.
 * @throws ProjectDataError 413 when the plan is too large.
 */
function requireApplicablePlan(plan: WorkCalendarChangePlan): void {
  if (plan.updates.length > WORK_CALENDAR_CHANGE_MAX_WORK_ITEMS) {
    throw new ProjectDataError(
      413,
      'WorkCalendarChangeTooLarge',
      `A calendar change can adjust at most ${WORK_CALENDAR_CHANGE_MAX_WORK_ITEMS} Work Items at once.`,
    )
  }
}

/**
 * Rewrites the planned schedules in bounded transactions.
 *
 * A transaction whose Work Item changed meanwhile is skipped and counted, so saving the same
 * calendar again adjusts the rest.
 *
 * @param c - Hono request context, for the audit context.
 * @param principal - Member who changed the calendar.
 * @param plan - Planned change.
 * @param body - Request body recorded in the audit context.
 * @returns How many Work Items were rewritten or skipped.
 */
async function applyPlan(
  c: Context,
  principal: WorkspacePrincipal,
  plan: WorkCalendarChangePlan,
  body: unknown,
): Promise<{ updatedCount: number, conflictCount: number }> {
  const updateSchedules = workItemDependencies.teamIssues.updateTeamIssueSchedules
  if (plan.updates.length === 0) return { updatedCount: 0, conflictCount: 0 }
  if (!updateSchedules) {
    throw new ProjectDataError(503, 'WorkCalendarUnavailable', 'Work Item schedules cannot be rewritten.')
  }
  let updatedCount = 0
  let conflictCount = 0
  for (let index = 0; index < plan.updates.length; index += WORK_ITEM_SCHEDULE_CASCADE_LIMIT) {
    const chunk = plan.updates.slice(index, index + WORK_ITEM_SCHEDULE_CASCADE_LIMIT)
    try {
      await updateSchedules.call(
        workItemDependencies.teamIssues,
        principal.directoryId,
        chunk,
        [],
        principal.userKey,
        createApiMutationContext(c, principal, { body, chunk: index / WORK_ITEM_SCHEDULE_CASCADE_LIMIT }),
      )
      updatedCount += chunk.length
    } catch (error) {
      if (error instanceof ProjectDataError && error.status === 409) {
        conflictCount += chunk.length
        continue
      }
      throw error
    }
  }
  return { updatedCount, conflictCount }
}

/**
 * Reports whether the principal may change a calendar, without failing.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context.
 * @param scope - Calendar scope.
 * @returns Whether a change would be allowed.
 */
async function canManageCalendar(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  scope: StoredWorkCalendarScope,
): Promise<boolean> {
  try {
    await requireCalendarManager(principal, context, scope)
    return true
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 403) return false
    throw error
  }
}

/**
 * Requires the principal to manage a calendar.
 *
 * A Team calendar needs Team configuration administration. A Project calendar also accepts a
 * manager of that Project.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context read at viewer level.
 * @param scope - Calendar scope.
 */
async function requireCalendarManager(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  scope: StoredWorkCalendarScope,
): Promise<void> {
  if (scope.kind === 'project' && canAccessAssignedProject(principal, context, scope.projectId, 'manager')) {
    return
  }
  try {
    await requireTeamConfigurationAdministration(principal, scope.teamId)
  } catch (error) {
    if (scope.kind === 'project' && error instanceof Error && 'status' in error && error.status === 403) {
      const managerContext = await requireTeamPermission(principal, scope.teamId, 'manager').catch(() => undefined)
      if (managerContext && (managerContext.directTeamGrant ||
        canAccessAssignedProject(principal, managerContext, scope.projectId, 'manager'))) {
        return
      }
      throw new ProjectDataError(
        403,
        'WorkCalendarForbidden',
        'Only a Project manager or a Team administrator can change this calendar.',
      )
    }
    throw error
  }
}

/**
 * Builds the scope of a request and checks that its Project belongs to the Team.
 *
 * @param context - Team permission context.
 * @param teamId - Requested Team.
 * @param projectId - Requested Project, if any.
 * @returns The scope.
 * @throws ProjectDataError 404 when the Project is not in the Team.
 */
function createScope(
  context: TeamPermissionContext,
  teamId: string,
  projectId: string | undefined,
): StoredWorkCalendarScope {
  if (projectId === undefined) return { kind: 'team', teamId }
  if (!context.team.projects.some((project) => project.id === projectId)) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }
  return { kind: 'project', teamId, projectId }
}

/**
 * Reads the Team identifier of a calendar route.
 *
 * @param c - Hono request context.
 * @returns The trimmed Team ID.
 */
function readTeamId(c: Context): string {
  const teamId = c.req.param('teamId')?.trim()
  if (!teamId) throw invalidRequest('Team ID is required.')
  return teamId
}

/**
 * Reads an optional Project identifier.
 *
 * @param value - Untrusted query or body value.
 * @returns The trimmed Project ID, or undefined when absent.
 */
function readOptionalProjectId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw invalidRequest('projectId must be a Project ID.')
  }
  return value.trim()
}

/**
 * Reads the body of a calendar preview or save.
 *
 * @param body - Parsed body.
 * @param requireRevision - Whether `expectedRevision` is required (a save).
 * @returns The validated input.
 */
function readChangeInput(body: unknown, requireRevision: boolean) {
  const record = readRecord(body)
  const overrides = readWorkCalendarOverrides(record.overrides)
  if (!overrides) throw invalidRequest('overrides are not valid calendar rules.')
  const adjustment = readAdjustment(body)
  const projectId = readOptionalProjectId(record.projectId)
  const expectedRevision: unknown = record.expectedRevision
  if (
    requireRevision &&
    (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  ) {
    throw invalidRequest('expectedRevision must be a nonnegative integer.')
  }
  return {
    overrides,
    adjustment,
    ...(projectId === undefined ? {} : { projectId }),
    expectedRevision: typeof expectedRevision === 'number' ? expectedRevision : 0,
  }
}

/**
 * Reads the adjustment of a calendar request body.
 *
 * @param body - Parsed body.
 * @returns The adjustment.
 */
function readAdjustment(body: unknown): WorkCalendarAdjustment {
  const adjustment: unknown = readRecord(body).adjustment
  if (!isWorkCalendarAdjustment(adjustment)) {
    throw invalidRequest('adjustment must be "keep-duration" or "keep-end-date".')
  }
  return adjustment
}

/**
 * Narrows a parsed body to an object.
 *
 * @param body - Parsed body.
 * @returns The body as a record.
 */
function readRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('The request body must be an object.')
  }
  return Object.fromEntries(Object.entries(body))
}

/**
 * Reads a JSON request body.
 *
 * @param c - Hono request context.
 * @returns The parsed body.
 */
async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text()
  if (text.length > MAX_WORK_CALENDAR_BODY_LENGTH) throw invalidRequest('The request body is too large.')
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw invalidRequest('The request body must be JSON.')
  }
}

/**
 * Creates the error for a malformed calendar request.
 *
 * @param message - Explanation.
 * @returns The error.
 */
function invalidRequest(message: string): ProjectDataError {
  return new ProjectDataError(400, 'InvalidWorkCalendarRequest', message)
}

/** HTTP status of each calendar-specific error code. */
const workCalendarErrorStatuses = {
  InvalidWorkCalendarRequest: 400,
  WorkCalendarForbidden: 403,
  ProjectNotFound: 404,
  WorkCalendarChangeTooLarge: 413,
  WorkCalendarUnavailable: 503,
} as const satisfies Record<string, 400 | 403 | 404 | 413 | 503>

/**
 * Reports whether an error code is one of the calendar-specific codes.
 *
 * @param code - Error code.
 * @returns Whether the code has a calendar status.
 */
function isWorkCalendarErrorCode(code: string): code is keyof typeof workCalendarErrorStatuses {
  return Object.hasOwn(workCalendarErrorStatuses, code)
}

/**
 * Maps calendar failures to HTTP responses and delegates everything else.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The error response.
 */
function toWorkCalendarErrorResponse(c: Context, error: unknown) {
  if (error instanceof WorkCalendarRevisionConflictError) {
    return c.json({ code: 'WorkCalendarConflict', message: error.message }, 409)
  }
  if (error instanceof InvalidStoredWorkCalendarError) {
    console.error(error)
    return c.json({ code: 'WorkCalendarCorruptState', message: error.message }, 502)
  }
  if (error instanceof ProjectDataError && isWorkCalendarErrorCode(error.code)) {
    return c.json({ code: error.code, message: error.message }, workCalendarErrorStatuses[error.code])
  }
  return toWorkItemConfigurationErrorResponse(c, error)
}
