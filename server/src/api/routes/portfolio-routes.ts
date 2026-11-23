import {
  isPortfolioMonth,
  PORTFOLIO_DASHBOARD_SCHEMA_VERSION,
  PORTFOLIO_TIME_ENTRY_READ_LIMIT,
  type ProjectRaidEntry,
  type TeamPortfolioResponse,
  type TeamPortfolioSnapshotResponse,
} from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  assertPortfolioProjectLimit,
  canCaptureTeamPortfolioSnapshot,
  captureTeamPortfolioSnapshot,
  buildTeamPortfolioProjects,
  redactTeamPortfolioSnapshot,
  type PortfolioBudgetSource,
} from '../../modules/portfolio-dashboard'
import { readProjectRaidLogUseCase } from '../../modules/project-raid-log'
import { TimeTrackingError } from '../../modules/time-tracking'
import { mapInOrderWithConcurrency } from '../shared/agent-run-access'
import { requireAppDependencies, workItemDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken } from '../shared/http'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  createApiMutationContext,
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
import { projectAccessAllows, type TeamPermissionContext } from '../shared/workspace-access'

/** Most Project logs read at once. */
const RAID_LOG_READ_CONCURRENCY = 8

/** Reader access to a Team's portfolio, decided once per request. */
type PortfolioAccess = {
  /** Reader's Team context at viewer level. */
  context: TeamPermissionContext
  /** Projects of the Team the reader may read, in directory order. */
  readableProjectIds: string[]
  /** Whether the reader may read a Project's Work Items, or Team-level ones for `undefined`. */
  canReadProject: (projectId: string | undefined) => boolean
  /** Whether the reader may see a Project's budget and cost. */
  canSeeCost: (projectId: string) => boolean
  /** Whether the reader manages the whole Team and may save snapshots. */
  managesWholeTeam: boolean
}

/**
 * Registers the Team portfolio endpoints that the Workspace portfolio dashboard combines.
 *
 * Reading needs viewer access to the Team; each row needs read access to its Project, and the
 * budget and cost of a row need the Project time manager access that the time tracking reports
 * require. Saving the month's snapshot needs a manager of the whole Team.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerPortfolioRoutes(routeApp: Hono): void {
  /** Returns the current portfolio metrics of each readable Project of a Team. */
  routeApp.get('/api/teams/:teamId/portfolio', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessRead(principal)
      const teamId = readTeamId(c)
      const timeZone = readTimeZone(c)
      const access = await readPortfolioAccess(principal, teamId)
      const now = new Date()
      const projects = await computeTeamPortfolio(principal, access, timeZone, now)
      return c.json({
        schemaVersion: PORTFOLIO_DASHBOARD_SCHEMA_VERSION,
        teamId,
        generatedAt: now.toISOString(),
        timeZone,
        projects,
        hiddenProjectCount: access.context.team.projects.length - access.readableProjectIds.length,
        costHiddenProjectCount: projects.filter((project) => project.costHidden).length,
        viewer: { canCaptureSnapshot: access.managesWholeTeam },
      } satisfies TeamPortfolioResponse)
    })
  })

  /** Returns one month's saved snapshot as the reader may see it now. */
  routeApp.get('/api/teams/:teamId/portfolio/snapshots/:month', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessRead(principal)
      const teamId = readTeamId(c)
      const month = readMonth(c)
      const access = await readPortfolioAccess(principal, teamId)
      const stored = await workItemDependencies.portfolioSnapshots.get(principal.directoryId, teamId, month)
      const readable = new Set(access.readableProjectIds)
      return c.json({
        snapshot: stored === null
          ? null
          : redactTeamPortfolioSnapshot(stored, (projectId) => readable.has(projectId), access.canSeeCost),
      } satisfies TeamPortfolioSnapshotResponse)
    })
  })

  /**
   * Saves the current month's snapshot of every Project the manager can read, replacing an
   * earlier save of the same month. Only the current month in the request's timezone can be
   * saved, so a past month's comparison cannot be rewritten later.
   */
  routeApp.put('/api/teams/:teamId/portfolio/snapshots/:month', async (c) => {
    return await withPrincipal(c, async (principal) => {
      requireWorkspaceBusinessWrite(principal)
      const teamId = readTeamId(c)
      const month = readMonth(c)
      const timeZone = readTimeZone(c)
      const access = await readPortfolioAccess(principal, teamId)
      const now = new Date()
      const auditContext = createApiMutationContext(c, principal, { month })
      const stored = await captureTeamPortfolioSnapshot(
        {
          store: workItemDependencies.portfolioSnapshots,
          computeProjects: async () => await computeTeamPortfolio(principal, access, timeZone, now),
        },
        {
          workspaceId: principal.directoryId,
          teamId,
          month,
          currentMonth: currentMonth(now, timeZone),
          now,
          canCapture: access.managesWholeTeam,
          callerAuthorization: createPlanningCallerAuthorizationConditionChecks(
            principal,
            [],
            principal.principalKind !== 'service-account',
          ),
          auditContext,
          idempotencyKeyHash: auditContext.idempotencyKeyHash,
          requestFingerprint: auditContext.requestFingerprint,
        },
      )
      const readable = new Set(access.readableProjectIds)
      return c.json({
        snapshot: redactTeamPortfolioSnapshot(stored, (projectId) => readable.has(projectId), access.canSeeCost),
      } satisfies TeamPortfolioSnapshotResponse)
    })
  })
}

/**
 * Decides what the reader may see of a Team's portfolio.
 *
 * Cost visibility follows the time tracking reports: the reader must manage time in the Team,
 * and a reader who manages only some Projects sees only those Projects' costs.
 *
 * @param principal - Reader.
 * @param teamId - Team ID.
 * @returns The access.
 * @throws ProjectDataError 403 or 404 when the reader cannot view the Team, and 413 when the
 *   Team has more Projects than one portfolio lists.
 */
async function readPortfolioAccess(principal: WorkspacePrincipal, teamId: string): Promise<PortfolioAccess> {
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  assertPortfolioProjectLimit(context.team.projects.length)
  const canReadProject = createProjectReadCheck(principal, context)
  const readableProjectIds = context.team.projects
    .map((project) => project.id)
    .filter((projectId) => canReadProject(projectId))
  const managerContext = await readTeamManagerContext(principal, teamId)
  const costProjectIds = new Set(
    (managerContext?.projectAccesses ?? [])
      .filter((projectAccess) => projectAccessAllows(projectAccess, 'manager'))
      .map((projectAccess) => projectAccess.projectId),
  )
  const readable = new Set(readableProjectIds)
  return {
    context,
    readableProjectIds,
    canReadProject,
    canSeeCost: (projectId) =>
      readable.has(projectId) &&
      managerContext !== undefined &&
      (principal.isSystemAdmin || costProjectIds.has(projectId)),
    managesWholeTeam: canCaptureTeamPortfolioSnapshot({
      isSystemAdmin: principal.isSystemAdmin,
      isTeamManager: managerContext !== undefined,
      directTeamGrant: managerContext?.directTeamGrant === true,
      projectIds: context.team.projects.map((project) => project.id),
      canReadProject: (projectId) => readable.has(projectId),
      canSeeCost: (projectId) => costProjectIds.has(projectId),
    }),
  }
}

/**
 * Reads the reader's manager-level Team context, the same check the time tracking reports use to
 * decide who may see confidential costs.
 *
 * @param principal - Reader.
 * @param teamId - Team ID.
 * @returns The context, or `undefined` when the reader manages no Project of the Team.
 */
async function readTeamManagerContext(principal: WorkspacePrincipal, teamId: string) {
  try {
    return await requireTeamPermission(principal, teamId, 'manager')
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return undefined
    throw error
  }
}

/**
 * Computes the metrics of each Project the reader may read.
 *
 * @param principal - Reader.
 * @param access - Reader access.
 * @param timeZone - IANA timezone of the budget periods.
 * @param now - Instant of the computation.
 * @returns One row per readable Project.
 */
async function computeTeamPortfolio(
  principal: WorkspacePrincipal,
  access: PortfolioAccess,
  timeZone: string,
  now: Date,
) {
  const teamId = access.context.team.id
  const costProjectIds = access.readableProjectIds.filter((projectId) => access.canSeeCost(projectId))
  const [workItems, baselines, raidEntries, budgets] = await Promise.all([
    readSummaryWorkItems(principal, access.context, access.canReadProject),
    readProjectBaselines(principal.directoryId, teamId, access.readableProjectIds),
    readRaidEntries(principal.directoryId, teamId, access.readableProjectIds),
    readBudgets(principal.directoryId, teamId, costProjectIds, timeZone, now),
  ])
  return buildTeamPortfolioProjects({
    projectIds: access.readableProjectIds,
    workItems,
    baselines,
    raidEntries,
    budgets,
    canSeeCost: access.canSeeCost,
    today: now.toISOString().slice(0, 10),
    localToday: (workItem) => readLocalToday(now, workItem),
  })
}

/**
 * Reads the log entries of each Project.
 *
 * @param workspaceId - Workspace directory ID.
 * @param teamId - Team ID.
 * @param projectIds - Readable Projects.
 * @returns Entries keyed by Project ID.
 */
async function readRaidEntries(workspaceId: string, teamId: string, projectIds: readonly string[]) {
  const logs = await mapInOrderWithConcurrency(projectIds, RAID_LOG_READ_CONCURRENCY, async (projectId) => {
    const log = await readProjectRaidLogUseCase(workItemDependencies.projectRaidLogs, { workspaceId, teamId, projectId })
    return [projectId, log.entries] as const
  })
  return new Map<string, readonly ProjectRaidEntry[]>(logs)
}

/**
 * Reads the budget and cost of each Project whose costs the reader may see.
 *
 * @param workspaceId - Workspace directory ID.
 * @param teamId - Team ID.
 * @param projectIds - Projects with visible costs.
 * @param timeZone - IANA timezone of the budget periods.
 * @param now - Instant the cost is totalled up to.
 * @returns Budgets keyed by Project ID.
 * @throws ProjectDataError 413 when the budget periods hold too many time entries.
 */
async function readBudgets(
  workspaceId: string,
  teamId: string,
  projectIds: readonly string[],
  timeZone: string,
  now: Date,
): Promise<ReadonlyMap<string, PortfolioBudgetSource>> {
  if (projectIds.length === 0) return new Map()
  try {
    return await requireAppDependencies().timeTracking.timeTrackingService.summarizeProjectBudgets({
      workspaceId,
      teamId,
      projectIds,
      timeZone,
      now,
      entryLimit: PORTFOLIO_TIME_ENTRY_READ_LIMIT,
    })
  } catch (error) {
    if (error instanceof TimeTrackingError && (error.status === 400 || error.status === 413)) {
      throw new ProjectDataError(error.status, error.code, error.message)
    }
    throw error
  }
}

/**
 * Authenticates the request and maps failures to responses.
 *
 * @param c - Hono request context.
 * @param operation - Route body.
 * @returns The response.
 */
async function withPrincipal(c: Context, operation: (principal: WorkspacePrincipal) => Promise<Response>) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    return await operation(principal)
  } catch (error) {
    return toPortfolioErrorResponse(c, error)
  }
}

/** Error codes of the portfolio endpoints whose status is passed through. */
const PORTFOLIO_ERROR_CODES = new Set([
  'InvalidPortfolioRequest',
  'InvalidPortfolioSnapshot',
  'InvalidTimeRange',
  'InvalidTimeZone',
  'PortfolioTooLarge',
  'PortfolioSnapshotForbidden',
  'PortfolioSnapshotConflict',
  'PortfolioSnapshotIdempotencyConflict',
  'PortfolioSnapshotCorruptState',
  'PortfolioSnapshotStorageFailure',
  'PortfolioSnapshotRetryable',
  'PortfolioSnapshotAuthorizationUnavailable',
])

/**
 * Maps a portfolio failure to a response; other failures follow the shared Project data mapping.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toPortfolioErrorResponse(c: Context, error: unknown) {
  if (error instanceof ProjectDataError && PORTFOLIO_ERROR_CODES.has(error.code)) {
    const status = toPortfolioStatus(error.status)
    if (status >= 500) {
      console.error('Portfolio request failed.', { status, code: error.code, requestId: c.req.header('X-Request-Id'), error })
    }
    return c.json({ code: error.code, message: error.message }, status)
  }
  return toProjectDataErrorResponse(c, error)
}

/**
 * Narrows a portfolio error status to the statuses the endpoints answer with.
 *
 * @param status - Status carried by the error.
 * @returns The same status when it is expected, otherwise 502.
 */
function toPortfolioStatus(status: number): 400 | 403 | 409 | 413 | 502 | 503 {
  switch (status) {
    case 400:
    case 403:
    case 409:
    case 413:
    case 503:
      return status
    default:
      return 502
  }
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
  if (!teamId) throw new ProjectDataError(400, 'InvalidPortfolioRequest', 'Team ID is required.')
  return teamId
}

/**
 * Reads the snapshot month of a route.
 *
 * @param c - Hono request context.
 * @returns The month as `YYYY-MM`.
 * @throws ProjectDataError when it is malformed.
 */
function readMonth(c: Context) {
  const month = c.req.param('month')
  if (!isPortfolioMonth(month)) throw new ProjectDataError(400, 'InvalidPortfolioRequest', 'month must be YYYY-MM.')
  return month
}

/**
 * Reads the timezone that bounds budget periods and the current month.
 *
 * @param c - Hono request context.
 * @returns A valid IANA timezone; UTC when omitted.
 * @throws ProjectDataError when it is not a valid timezone.
 */
function readTimeZone(c: Context) {
  const timeZone = c.req.query('timeZone') ?? 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new ProjectDataError(400, 'InvalidPortfolioRequest', 'timeZone must be a valid IANA timezone identifier.')
  }
  return timeZone
}

/**
 * Returns the calendar month of an instant in a timezone.
 *
 * @param now - Instant.
 * @param timeZone - IANA timezone.
 * @returns The month as `YYYY-MM`.
 */
function currentMonth(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now)
  const year = parts.find((part) => part.type === 'year')?.value ?? ''
  const month = parts.find((part) => part.type === 'month')?.value ?? ''
  return `${year}-${month}`
}
