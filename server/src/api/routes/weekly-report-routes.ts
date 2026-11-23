import { createHash } from 'node:crypto'
import { readWorkItemPlannedEndDate, type WeeklyReportStoredItem } from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import { normalizeProjectMemberKey, ProjectDataError } from '../../modules/directory'
import {
  buildTeamWeeklySummary,
  listWeeklyReportHistoryUseCase,
  readTeamWeeklyReportStatusUseCase,
  readWeeklyReportUseCase,
  readWeeklyReportWeekStart,
  saveWeeklyReportDraftUseCase,
  submitWeeklyReportUseCase,
  type WeeklyReportItemLocation,
  type WeeklyReportItemLocator,
  type WeeklyReportItemReadCheck,
  type WeeklyReportMemberScope,
} from '../../modules/weekly-reports'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson } from '../shared/http'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  canAccessAssignedProject,
  createApiMutationContext,
  readLegacyProjectScopeAccesses,
  requireTeamPermission,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  createProjectReadCheck,
  readLocalToday,
  readProjectBaselines,
  readSummaryWorkItems,
} from '../shared/team-project-read'
import type { TeamPermissionContext } from '../shared/workspace-access'

/** Most Work Items read at once while a report is submitted or read. */
const RESOLVE_CONCURRENCY = 8

/**
 * Registers the weekly report endpoints.
 *
 * A member reads and writes only their own reports. A Team manager reads the submitted reports
 * of the members of the Projects they manage, and the submission state of those members; never
 * the saved, unsubmitted notes. Every reader sees only the Work Items they may read themselves.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerWeeklyReportRoutes(routeApp: Hono): void {
  /** Lists who submitted a report for a week among the members the manager may read. */
  routeApp.get('/api/teams/:teamId/weekly-reports', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessRead(principal)
      const teamId = readTeamId(c)
      const weekStart = readWeeklyReportWeekStart(c.req.query('weekStart'), today())
      const roster = await readManagedRoster(principal, teamId)
      return c.json(await readTeamWeeklyReportStatusUseCase(
        workItemDependencies.weeklyReports,
        { workspaceId: principal.directoryId, teamId },
        roster,
        weekStart,
      ))
    })
  })

  /**
   * Summarizes a week of the Team and of each Project the reader may read: completed Work Items,
   * delays against the Project schedule baseline, overdue Work Items, and Milestones reached.
   * Any Team viewer may read it; only Work Items the reader may read are counted.
   */
  routeApp.get('/api/teams/:teamId/weekly-summary', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessRead(principal)
      const teamId = readTeamId(c)
      const weekStart = readWeeklyReportWeekStart(c.req.query('weekStart'), today())
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      const canReadProject = createProjectReadCheck(principal, context)
      const projectIds = context.team.projects.map((project) => project.id).filter((projectId) => canReadProject(projectId))
      const [workItems, baselines] = await Promise.all([
        readSummaryWorkItems(principal, context, canReadProject),
        readProjectBaselines(principal.directoryId, teamId, projectIds),
      ])
      const now = new Date()
      return c.json(buildTeamWeeklySummary({
        teamId,
        weekStart,
        now,
        projectIds,
        baselines,
        workItems,
        localToday: (workItem) => readLocalToday(now, workItem),
      }))
    })
  })

  /** Lists one member's weeks, newest first. Other readers than the author see only submitted weeks. */
  routeApp.get('/api/teams/:teamId/weekly-reports/:memberKey', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessRead(principal)
      const { scope, isAuthor } = await authorizeRead(principal, c)
      const limit = c.req.query('limit')
      const cursor = c.req.query('cursor')
      return c.json(await listWeeklyReportHistoryUseCase(workItemDependencies.weeklyReports, scope, {
        submittedOnly: !isAuthor,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      }))
    })
  })

  /** Reads one member's week: the latest or requested version, and the author's saved notes. */
  routeApp.get('/api/teams/:teamId/weekly-reports/:memberKey/:weekStart', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessRead(principal)
      const { scope, isAuthor, readerContext } = await authorizeRead(principal, c)
      const weekStart = readWeeklyReportWeekStart(c.req.param('weekStart'), today())
      const versionQuery = c.req.query('version')
      let version: number | undefined
      if (versionQuery !== undefined) {
        version = /^\d{1,4}$/u.test(versionQuery) ? Number(versionQuery) : Number.NaN
        if (!Number.isSafeInteger(version) || version < 1) {
          throw new ProjectDataError(400, 'InvalidWeeklyReport', 'version must be a positive integer.')
        }
      }
      return c.json(await readWeeklyReportUseCase(workItemDependencies.weeklyReports, scope, weekStart, {
        includeDraft: isAuthor,
        canReadItem: createItemReadCheck(principal, readerContext),
        locateItems: createItemLocator(principal, scope.teamId),
        ...(version === undefined ? {} : { version }),
      }))
    })
  })

  /** Saves the author's notes for a week without submitting them. */
  routeApp.put('/api/teams/:teamId/weekly-reports/:memberKey/:weekStart/draft', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessWrite(principal)
      const { scope, authorContext } = await authorizeAuthorWrite(principal, c)
      const weekStart = readWeeklyReportWeekStart(c.req.param('weekStart'), today())
      const body = await readJson<unknown>(c.req)
      return c.json(await saveWeeklyReportDraftUseCase(workItemDependencies.weeklyReports, scope, weekStart, body, {
        now: new Date().toISOString(),
        callerAuthorization: await createCallerAuthorization(principal, scope.teamId),
        auditContext: createApiMutationContext(c, principal, body),
        canReadItem: createItemReadCheck(principal, authorContext),
        locateItems: createItemLocator(principal, scope.teamId),
      }))
    })
  })

  /** Submits a new, unchangeable version of the author's report for a week. */
  routeApp.post('/api/teams/:teamId/weekly-reports/:memberKey/:weekStart/submissions', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessWrite(principal)
      const { scope, authorContext } = await authorizeAuthorWrite(principal, c)
      const weekStart = readWeeklyReportWeekStart(c.req.param('weekStart'), today())
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const canReadItem = createItemReadCheck(principal, authorContext)
      const response = await submitWeeklyReportUseCase(workItemDependencies.weeklyReports, scope, weekStart, body, {
        now: new Date().toISOString(),
        callerAuthorization: await createCallerAuthorization(principal, scope.teamId),
        auditContext,
        submissionReceipt: createSubmissionHash('receipt', scope, weekStart, auditContext.actor.id, auditContext.idempotencyKeyHash, auditContext.requestFingerprint),
        submissionKey: createSubmissionHash('key', scope, weekStart, auditContext.actor.id, auditContext.idempotencyKeyHash),
        resolveItems: async (workItemIds) => await resolveAuthorItems(principal, scope.teamId, workItemIds, canReadItem),
        canReadItem,
        locateItems: createItemLocator(principal, scope.teamId),
      })
      return c.json(response, 201)
    })
  })
}

/**
 * Authenticates the request and maps failures to responses.
 *
 * @param c - Hono request context.
 * @param operation - Work run with the authenticated principal.
 * @returns The operation response or the error response.
 */
async function withPrincipal(c: Context, operation: (principal: WorkspacePrincipal) => Promise<Response>) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    return await operation(principal)
  } catch (error) {
    return toWeeklyReportErrorResponse(c, error)
  }
}

/**
 * Returns today's UTC date.
 *
 * @returns `YYYY-MM-DD`.
 */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Reads and trims the Team identifier of a route.
 *
 * @param c - Hono request context.
 * @returns The Team ID.
 * @throws ProjectDataError when it is missing.
 */
function readTeamId(c: Context) {
  const teamId = c.req.param('teamId')?.trim()
  if (!teamId) throw new ProjectDataError(400, 'InvalidWeeklyReport', 'Team ID is required.')
  return teamId
}

/**
 * Reads the Team and normalized author of a member route.
 *
 * @param principal - Authenticated principal.
 * @param c - Hono request context.
 * @returns The author scope.
 * @throws ProjectDataError when the member key is missing.
 */
function readMemberScope(principal: WorkspacePrincipal, c: Context): WeeklyReportMemberScope {
  const memberKey = c.req.param('memberKey')?.trim()
  if (!memberKey || memberKey.length > 256) throw new ProjectDataError(400, 'InvalidWeeklyReport', 'Member key is required.')
  return {
    workspaceId: principal.directoryId,
    teamId: readTeamId(c),
    memberKey: normalizeProjectMemberKey(memberKey),
  }
}

/**
 * Normalizes the principal's own member key.
 *
 * @param principal - Authenticated principal.
 * @returns The member key reports are stored under.
 */
function ownMemberKey(principal: WorkspacePrincipal) {
  return normalizeProjectMemberKey(principal.userKey)
}

/**
 * Authorizes a read of one member's reports: the author, or a manager of one of the author's
 * Projects in the Team. Any other reader gets 404, so the response does not reveal whose
 * reports exist.
 *
 * @param principal - Authenticated principal.
 * @param c - Hono request context.
 * @returns The author scope, whether the reader is the author, and the reader's Team context.
 */
async function authorizeRead(principal: WorkspacePrincipal, c: Context) {
  const scope = readMemberScope(principal, c)
  const readerContext = await requireTeamPermission(principal, scope.teamId, 'viewer')
  const isAuthor = scope.memberKey === ownMemberKey(principal)
  if (!isAuthor && !await managesMember(principal, scope.teamId, scope.memberKey)) {
    throw new ProjectDataError(404, 'WeeklyReportNotFound', 'The weekly report was not found.')
  }
  return { scope, isAuthor, readerContext }
}

/**
 * Authorizes a write: only the author, with member access to the Team, writes their reports.
 *
 * @param principal - Authenticated principal.
 * @param c - Hono request context.
 * @returns The author scope and the author's Team context at viewer level, used to resolve and
 *   filter Work Items.
 */
async function authorizeAuthorWrite(principal: WorkspacePrincipal, c: Context) {
  const scope = readMemberScope(principal, c)
  if (scope.memberKey !== ownMemberKey(principal)) {
    throw new ProjectDataError(403, 'WeeklyReportForbidden', 'Only the author can change a weekly report.')
  }
  await requireTeamPermission(principal, scope.teamId, 'member')
  const authorContext = await requireTeamPermission(principal, scope.teamId, 'viewer')
  return { scope, authorContext }
}

/** A principal's manager-level access to a Team. */
type ManagerAccess = {
  /** Team context of the principal. */
  context: TeamPermissionContext
  /** Whether the principal manages every Project of the Team. */
  wholeTeam: boolean
}

/**
 * Tells whether the principal is a Workspace owner or admin under legacy (non-Enterprise)
 * authorization, who reads every member's reports in the Teams they can view, as for Team
 * configuration.
 *
 * @param principal - Authenticated principal.
 * @returns Whether the principal administers the Workspace.
 */
function isLegacyWorkspaceAdministrator(principal: WorkspacePrincipal) {
  return principal.enterprisePermissions === undefined &&
    (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin')
}

/**
 * Reads the principal's manager-level access to a Team: a system administrator, a legacy
 * Workspace owner or admin, or a Team-wide Enterprise grant manages the whole Team; a Project
 * manager manages their Projects.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team ID.
 * @returns The access, or `undefined` when the principal manages no Project of the Team.
 */
async function readManagerContext(principal: WorkspacePrincipal, teamId: string): Promise<ManagerAccess | undefined> {
  try {
    if (isLegacyWorkspaceAdministrator(principal)) {
      return { context: await requireTeamPermission(principal, teamId, 'viewer'), wholeTeam: true }
    }
    const context = await requireTeamPermission(principal, teamId, 'manager')
    return { context, wholeTeam: principal.isSystemAdmin || context.directTeamGrant === true }
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return undefined
    throw error
  }
}

/**
 * Tells whether the principal manages a Project the member belongs to in the Team.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team ID.
 * @param memberKey - Normalized member key of the author.
 * @returns Whether the principal may read the member's submitted reports.
 */
async function managesMember(principal: WorkspacePrincipal, teamId: string, memberKey: string) {
  const access = await readManagerContext(principal, teamId)
  if (!access) return false
  const { context } = access
  // A report exists only if its author could write in the Team, so a Team-wide reader reads any.
  if (access.wholeTeam) return true
  const teamProjectIds = new Set(context.team.projects.map((project) => project.id))
  // Legacy memberships are qualified against the directory; one whose Project ID several Teams
  // share is dropped, so it never proves membership in this Team.
  const memberAccesses = await readLegacyProjectScopeAccesses({ directoryId: principal.directoryId, userKey: memberKey })
  return memberAccesses.some((access) =>
    access.role !== undefined &&
    access.teamId === teamId &&
    teamProjectIds.has(access.projectId) &&
    canAccessAssignedProject(principal, context, access.projectId, 'manager'))
}

/**
 * Lists the members whose reports the principal may read: the members of every Project of the
 * Team the principal manages.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team ID.
 * @returns Members with their display names, when the directory has one.
 * @throws ProjectDataError 403 when the principal manages no Project of the Team.
 */
async function readManagedRoster(principal: WorkspacePrincipal, teamId: string) {
  const access = await readManagerContext(principal, teamId)
  if (!access) {
    throw new ProjectDataError(403, 'WeeklyReportForbidden', 'Only a Team manager can list the weekly reports of the Team.')
  }
  const { context, wholeTeam } = access
  const projects = context.team.projects.filter((project) =>
    wholeTeam || canAccessAssignedProject(principal, context, project.id, 'manager'))
  const responses = await Promise.all(projects.map(async (project) =>
    await workspaceDependencies.projectDirectory.getProjectMembers(principal.directoryId, project.id, teamId)))
  const roster = new Map<string, { memberKey: string; displayName?: string }>()
  for (const response of responses) {
    for (const member of response.members) {
      const memberKey = normalizeProjectMemberKey(member.id)
      const displayName = member.name?.trim()
      const existing = roster.get(memberKey)
      if (existing?.displayName !== undefined) continue
      roster.set(memberKey, { memberKey, ...(displayName ? { displayName } : {}) })
    }
  }
  return [...roster.values()]
}

/**
 * Builds the reader check applied to every Work Item of a report: the reader must be able to read
 * the Work Item's Project in the Team (a Team-level Work Item needs only Team access, which the
 * route already required).
 *
 * @param principal - Reader.
 * @param context - Reader's Team context at viewer level.
 * @returns The check.
 */
function createItemReadCheck(principal: WorkspacePrincipal, context: TeamPermissionContext): WeeklyReportItemReadCheck {
  const canReadProject = createProjectReadCheck(principal, context)
  return (item) => canReadProject(item.projectId)
}

/** A Work Item as the weekly report routes read it from the Team. */
type TeamIssue = Awaited<ReturnType<typeof workItemDependencies.teamIssues.getTeamIssueDetail>>['issue']

/**
 * Reads Work Items of the Team a few at a time, leaving out those that no longer exist.
 *
 * @param principal - Reader.
 * @param teamId - Team ID.
 * @param workItemIds - Distinct IDs.
 * @returns The Work Items found, keyed by ID.
 */
async function readTeamIssues(principal: WorkspacePrincipal, teamId: string, workItemIds: readonly string[]) {
  const found = new Map<string, TeamIssue>()
  const unique = [...new Set(workItemIds)]
  for (let offset = 0; offset < unique.length; offset += RESOLVE_CONCURRENCY) {
    const batch = unique.slice(offset, offset + RESOLVE_CONCURRENCY)
    const issues = await Promise.all(batch.map(async (workItemId) => {
      try {
        // Read strongly consistent: the Project decides who may see the Work Item, so a move
        // just made must not be missed.
        const { issue } = await workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, workItemId, {
          consistentIssueRead: true,
          includeEvents: false,
        })
        return issue.id === workItemId ? issue : undefined
      } catch (error) {
        // A deleted Work Item is left out; the caller decides what that means.
        if (isTeamIssueNotFoundError(error)) return undefined
        throw error
      }
    }))
    for (const issue of issues) if (issue) found.set(issue.id, issue)
  }
  return found
}

/**
 * Reads the referenced Work Items with the author's permissions, keeping those the author may
 * read and copying their key, title, Project, and planned end.
 *
 * @param principal - Author.
 * @param teamId - Team ID.
 * @param workItemIds - Distinct referenced IDs.
 * @param canRead - Author's read check.
 * @returns Resolved Work Items keyed by ID.
 */
async function resolveAuthorItems(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemIds: readonly string[],
  canRead: WeeklyReportItemReadCheck,
) {
  const resolved = new Map<string, WeeklyReportStoredItem>()
  // A Work Item deleted since the draft was built is left out, like one the author cannot read.
  for (const issue of (await readTeamIssues(principal, teamId, workItemIds)).values()) {
    const plannedEndDate = readWorkItemPlannedEndDate(issue.schedule)
    const item: WeeklyReportStoredItem = {
      workItemId: issue.id,
      ...(issue.key === undefined ? {} : { key: issue.key }),
      title: issue.title,
      ...(issue.assignedProjectId === undefined ? {} : { projectId: issue.assignedProjectId }),
      ...(plannedEndDate === undefined ? {} : { plannedEndDate }),
    }
    if (canRead(item)) resolved.set(item.workItemId, item)
  }
  return resolved
}

/**
 * Builds the locator that reads where the Work Items of a stored version are now, so a Work Item
 * moved to another Project is checked against that Project. A deleted Work Item is absent and
 * keeps the Project stored at submission.
 *
 * @param principal - Reader.
 * @param teamId - Team ID.
 * @returns The locator.
 */
function createItemLocator(principal: WorkspacePrincipal, teamId: string): WeeklyReportItemLocator {
  return async (workItemIds) => {
    const locations = new Map<string, WeeklyReportItemLocation>()
    for (const issue of (await readTeamIssues(principal, teamId, workItemIds)).values()) {
      locations.set(issue.id, issue.assignedProjectId === undefined ? {} : { projectId: issue.assignedProjectId })
    }
    return locations
  }
}

/**
 * Builds the commit-time fences that fail a write when the author lost Workspace access or the
 * Team was archived after the request was authorized.
 *
 * @param principal - Author.
 * @param teamId - Team ID.
 * @returns The condition checks.
 * @throws ProjectDataError 503 when the directory cannot build the active-reference fences.
 */
async function createCallerAuthorization(principal: WorkspacePrincipal, teamId: string) {
  const { projectDirectory } = workspaceDependencies
  if (!projectDirectory.createActiveReferenceConditionChecks) {
    throw new ProjectDataError(503, 'WeeklyReportAuthorizationUnavailable', 'Team access cannot be verified.')
  }
  return [
    ...createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'),
    ...await projectDirectory.createActiveReferenceConditionChecks(principal.directoryId, teamId),
  ]
}

/**
 * Derives a submission receipt (with content) or key (without), so a retried request with the
 * same Idempotency-Key is recognized and a reused key with other content is refused.
 *
 * @param kind - `receipt` or `key`.
 * @param scope - Author.
 * @param weekStart - First day of the week.
 * @param parts - Actor, idempotency key hash, and, for a receipt, the request fingerprint.
 * @returns A hexadecimal hash.
 */
function createSubmissionHash(kind: 'receipt' | 'key', scope: WeeklyReportMemberScope, weekStart: string, ...parts: string[]) {
  return createHash('sha256')
    .update(JSON.stringify([`weekly-report-submission-${kind}`, scope.teamId, scope.memberKey, weekStart, ...parts]))
    .digest('hex')
}

/**
 * Converts a weekly report failure to an HTTP response.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toWeeklyReportErrorResponse(c: Context, error: unknown) {
  if (error instanceof ProjectDataError && (error.code.startsWith('WeeklyReport') || error.code === 'InvalidWeeklyReport')) {
    const status = toWeeklyReportStatus(error.status)
    if (status >= 500) {
      // Request headers tie the failure to the request log; the body is not recorded.
      console.error('Weekly report request failed.', {
        status,
        code: error.code,
        requestId: c.req.header('X-Request-Id'),
        correlationId: c.req.header('X-Correlation-Id')?.trim(),
        error,
      })
    }
    return c.json({ code: error.code, message: error.message }, status)
  }
  return toProjectDataErrorResponse(c, error)
}

/**
 * Narrows a weekly report error status to the statuses the endpoints answer with.
 *
 * @param status - Status carried by the error.
 * @returns The same status when it is expected, otherwise 502.
 */
function toWeeklyReportStatus(status: number): 400 | 403 | 404 | 409 | 413 | 502 | 503 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 413:
    case 503:
      return status
    default:
      return 502
  }
}
