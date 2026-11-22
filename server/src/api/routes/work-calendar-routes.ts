import type { Context, Hono } from 'hono'
import {
  DEFAULT_WORK_CALENDAR_ADJUSTMENT,
  WORK_ITEM_HIERARCHY_MAX_ITEMS,
  isWorkCalendarAdjustment,
  readWorkCalendarOverrides,
  readWorkspaceCalendarSettings,
  type WorkCalendarAdjustment,
  type WorkCalendarOverrides,
  type WorkCalendarResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  InvalidStoredWorkCalendarError,
  WorkCalendarRevisionConflictError,
  type StoredWorkCalendarScope,
} from '../../modules/tenant-administration'
import {
  applyWorkCalendarChange,
  previewWorkCalendarChange,
  type TeamIssueResponseItem,
  type WorkCalendarChangePorts,
  type WorkCalendarChangeRules,
  type WorkCalendarChangeWorkItem,
} from '../../modules/work-items'
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
import { createPlanningFencedWorkItemAuthorizationSnapshot } from '../shared/planning-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { projectWorkItemMutationSearchDocumentBestEffort } from '../shared/search-access'
import type { TeamPermissionContext } from '../shared/workspace-access'
import {
  createWorkCalendarResolver,
  readTeamWorkCalendars,
  readWorkspaceCalendarInputs,
  resolveWorkCalendarPolicyFrom,
  withCandidateWorkCalendar,
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
      const change = await createTeamCalendarChange(principal, context, scope, input.overrides, input.adjustment)
      return c.json(await previewWorkCalendarChange(
        change.rules,
        createWorkCalendarChangePorts(c, principal, change.teamIds, undefined),
      ))
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
      const change = await createTeamCalendarChange(principal, context, scope, input.overrides, input.adjustment)
      const result = await applyWorkCalendarChange(
        change.rules,
        createWorkCalendarChangePorts(c, principal, change.teamIds, body),
        () => workspaceDependencies.workCalendars.save(
          principal.directoryId,
          {
            scope,
            overrides: input.overrides,
            ...(scope.kind === 'team' ? { changeAdjustment: input.adjustment } : {}),
          },
          input.expectedRevision,
          principal.userKey,
          new Date().toISOString(),
        ),
      )
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
      // The candidate keeps the synced holidays, which a Team or Project calendar may turn on.
      const candidate: WorkspaceCalendarInputs = { ...current, settings: calendar }
      const change = await createWorkspaceCalendarChange(principal, current, candidate, adjustment)
      return c.json(await previewWorkCalendarChange(
        change.rules,
        createWorkCalendarChangePorts(c, principal, change.teamIds, undefined),
      ))
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
      const change = await createWorkspaceCalendarChange(principal, current, current, adjustment)
      return c.json(await applyWorkCalendarChange(
        change.rules,
        createWorkCalendarChangePorts(c, principal, change.teamIds, body),
      ))
    } catch (error) {
      return toWorkCalendarErrorResponse(c, error)
    }
  })
}

/** Which Teams a calendar change reads and the rules it follows. */
type CalendarChange = {
  /** Teams whose Work Items the change reads. */
  teamIds: readonly string[]
  /** Rules of the change. */
  rules: WorkCalendarChangeRules
}

/**
 * Builds a Team or Project calendar change.
 *
 * A Project change reaches only the Work Items of that Project, so a Project manager never
 * rewrites Work Items elsewhere in the Team.
 *
 * @param principal - Authenticated principal, for the examples it may see.
 * @param context - Team permission context.
 * @param scope - Calendar that changes.
 * @param overrides - New rules of the calendar.
 * @param adjustment - How date ranges keep their dates.
 * @returns The change.
 */
async function createTeamCalendarChange(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  scope: StoredWorkCalendarScope,
  overrides: WorkCalendarOverrides,
  adjustment: WorkCalendarAdjustment,
): Promise<CalendarChange> {
  const [inputs, calendars] = await Promise.all([
    readWorkspaceCalendarInputs(principal.directoryId),
    readTeamWorkCalendars(principal.directoryId, scope.teamId),
  ])
  return {
    teamIds: [scope.teamId],
    rules: {
      before: createWorkCalendarResolver(inputs, calendars),
      after: createWorkCalendarResolver(inputs, withCandidateWorkCalendar(calendars, scope, overrides)),
      adjustment,
      includes: (workItem) => workItem.teamId === scope.teamId &&
        (scope.kind === 'team' || workItem.assignedProjectId === scope.projectId),
      canShowExample: (workItem) =>
        canAccessAssignedProject(principal, context, workItem.assignedProjectId, 'viewer'),
      adoptLegacy: true,
    },
  }
}

/**
 * Builds a Workspace calendar change over every Team.
 *
 * Examples are limited to Work Items the administrator may see in their Team.
 *
 * @param principal - Authenticated Workspace administrator.
 * @param current - Saved Workspace calendar inputs.
 * @param candidate - Workspace calendar inputs after the change.
 * @param adjustment - How date ranges keep their dates.
 * @returns The change.
 */
async function createWorkspaceCalendarChange(
  principal: WorkspacePrincipal,
  current: WorkspaceCalendarInputs,
  candidate: WorkspaceCalendarInputs,
  adjustment: WorkCalendarAdjustment,
): Promise<CalendarChange> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const teams = await Promise.all(directory.teams.map(async (team) => ({
    teamId: team.id,
    calendars: await readTeamWorkCalendars(principal.directoryId, team.id),
    context: await requireTeamPermission(principal, team.id, 'viewer').catch(() => undefined),
  })))
  const calendarsByTeam = new Map(teams.map((team) => [team.teamId, team.calendars]))
  const contextsByTeam = new Map(teams.map((team) => [team.teamId, team.context]))
  const resolverFor = (inputs: WorkspaceCalendarInputs) => {
    const resolvers = new Map(teams.map((team) => [team.teamId, createWorkCalendarResolver(inputs, team.calendars)]))
    const fallback = createWorkCalendarResolver(inputs, { projects: new Map() })
    return (workItem: WorkCalendarChangeWorkItem) => (resolvers.get(workItem.teamId) ?? fallback)(workItem)
  }
  return {
    teamIds: teams.map((team) => team.teamId),
    rules: {
      before: resolverFor(current),
      after: resolverFor(candidate),
      adjustment,
      includes: (workItem) => calendarsByTeam.has(workItem.teamId),
      canShowExample: (workItem) => {
        const context = contextsByTeam.get(workItem.teamId)
        return context !== undefined &&
          canAccessAssignedProject(principal, context, workItem.assignedProjectId, 'viewer')
      },
      adoptLegacy: false,
    },
  }
}

/**
 * Connects a calendar change to the Work Item reads and the schedule cascade writes.
 *
 * @param c - Hono request context, for the audit context.
 * @param principal - Member who changes the calendar.
 * @param teamIds - Teams whose Work Items the change reads.
 * @param body - Request body recorded in the audit context.
 * @returns The ports.
 */
function createWorkCalendarChangePorts(
  c: Context,
  principal: WorkspacePrincipal,
  teamIds: readonly string[],
  body: unknown,
): WorkCalendarChangePorts {
  return {
    async readWorkItems() {
      const teams = await Promise.all(teamIds.map((teamId) => readTeamWorkItems(principal.directoryId, teamId)))
      return teams.flat()
    },
    async readCalendarVersion() {
      const [profile, calendars] = await Promise.all([
        workspaceDependencies.tenantAdministration.getProfile(principal.directoryId),
        Promise.all(teamIds.map((teamId) => workspaceDependencies.workCalendars.listTeam(principal.directoryId, teamId))),
      ])
      return JSON.stringify([
        profile?.revision ?? 0,
        calendars.flat().map((calendar) => [
          calendar.scope.teamId,
          calendar.scope.kind === 'project' ? calendar.scope.projectId : '',
          calendar.revision,
        ]),
      ])
    },
    async writeSchedules(updates, batch) {
      const updateSchedules = workItemDependencies.teamIssues.updateTeamIssueSchedules
      if (!updateSchedules) {
        throw new ProjectDataError(503, 'WorkCalendarUnavailable', 'Work Item schedules cannot be rewritten.')
      }
      // Fence every batch on the member's authorization so a revoked member stops rewriting.
      const result = await updateSchedules.call(
        workItemDependencies.teamIssues,
        principal.directoryId,
        updates,
        [],
        principal.userKey,
        createApiMutationContext(c, principal, { body, batch }),
        undefined,
        await createPlanningFencedWorkItemAuthorizationSnapshot(principal),
      )
      await Promise.all(result.issues.map((issue) =>
        projectWorkItemMutationSearchDocumentBestEffort(principal.directoryId, issue, 'Work calendar change')
      ))
    },
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
