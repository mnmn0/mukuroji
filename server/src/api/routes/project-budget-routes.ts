import type { Context, Hono } from 'hono'
import {
  deriveWorkItemProgressPercent,
  isProjectBudgetReportInterval,
  PROJECT_BUDGET_REPORT_MAX_POINTS,
  type ProjectBudgetReport,
  type ProjectBudgetReportInterval,
  type TimeEntry,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  createProjectBudgetReport,
  type ProjectBudgetTimeEntry,
  type ProjectBudgetWorkItemProgress,
} from '../../modules/project-budget'
import { TimeTrackingError } from '../../modules/time-tracking'
import { requireAppDependencies, workItemDependencies } from '../shared/app-dependencies'
import { WORK_ITEMS_AGGREGATE_ITEM_LIMIT, WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE } from '../shared/constants'
import { readBearerAccessToken } from '../shared/http'
import { toWorkItemConfigurationErrorResponse } from '../shared/collaboration-access'
import { requireTeamPermission, requireWorkspaceBusinessRead } from '../shared/project-access'
import { requireTeamProjectManager } from '../shared/project-manager-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { createWorkItemListLimitExceededError } from '../shared/work-item-access'

/** Pattern of a `YYYY-MM-DD` local date. */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Milliseconds in one UTC day. */
const DAY_MS = 86_400_000

/**
 * Widest offset of any IANA timezone from UTC, in milliseconds. Entries are read this far
 * around the UTC dates and then kept by their local date.
 */
const MAX_TIMEZONE_OFFSET_MS = 14 * 3_600_000

/**
 * Registers the Project budget report endpoints.
 *
 * Both need manager access to the Project, because the report totals every member's time and
 * confidential cost on the Project.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerProjectBudgetRoutes(routeApp: Hono): void {
  /** Returns the budget against actual report and the earned value figures of one Project. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/budget-report', async (c) => {
    try {
      return c.json(await readReport(c))
    } catch (error) {
      return toProjectBudgetErrorResponse(c, error)
    }
  })

  /** Exports the series of the same report as CSV. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/budget-report/export', async (c) => {
    try {
      const report = await readReport(c)
      return c.body(createProjectBudgetReportCsv(report), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="project-budget-${report.projectId.replaceAll(/[^A-Za-z0-9_-]/g, '_')}-${report.from}-${report.to}.csv"`,
        'Cache-Control': 'no-store',
      })
    } catch (error) {
      return toProjectBudgetErrorResponse(c, error)
    }
  })
}

/** Query of a report request. */
type ReportQuery = {
  /** First local date. */
  from: string
  /** Last local date. */
  to: string
  /** IANA timezone. */
  timeZone: string
  /** Series bucket. */
  interval: ProjectBudgetReportInterval
}

/**
 * Authorizes a report request and builds the report.
 *
 * @param c - Hono request context.
 * @returns The report.
 * @throws ProjectDataError for an invalid request or a caller who does not manage the Project.
 */
async function readReport(c: Context): Promise<ProjectBudgetReport> {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) throw new ProjectDataError(401, 'Unauthorized', 'Bearer token is required.')
  const teamId = c.req.param('teamId')?.trim()
  const projectId = c.req.param('projectId')?.trim()
  if (!teamId || !projectId) throw invalidRequest('Team ID and Project ID are required.')
  const query = readReportQuery(c)
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  requireWorkspaceBusinessRead(principal)
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  await requireTeamProjectManager(principal, context, teamId, projectId, () => new ProjectDataError(
    403,
    'ProjectBudgetForbidden',
    'Only a Project manager can read the Project budget report.',
  ))
  const workspaceId = principal.directoryId
  const timeTracking = requireAppDependencies().timeTracking.timeTrackingService
  const [budget, baseline, configuration, entries] = await Promise.all([
    timeTracking.getBudget(workspaceId, teamId, 'project', projectId),
    workItemDependencies.scheduleBaselines.get(workspaceId, teamId, projectId),
    workItemDependencies.workItemConfigurations.getTeamConfiguration(workspaceId, teamId),
    timeTracking.listAllEntries({
      workspaceId,
      teamId,
      from: new Date(Date.parse(`${query.from}T00:00:00Z`) - MAX_TIMEZONE_OFFSET_MS).toISOString(),
      to: new Date(Date.parse(`${query.to}T00:00:00Z`) + DAY_MS + MAX_TIMEZONE_OFFSET_MS).toISOString(),
      projectIds: new Set([projectId]),
    }),
  ])
  const baselineIds = new Set((baseline?.entries ?? []).map((entry) => entry.workItemId))
  const workItems = baselineIds.size === 0
    ? new Map<string, ProjectBudgetWorkItemProgress>()
    : await readWorkItemProgress(workspaceId, teamId, baselineIds, configuration.configuration.progressMode)
  return createProjectBudgetReport({
    teamId,
    projectId,
    ...query,
    today: localDateAt(Date.now(), query.timeZone),
    budget: budget ?? null,
    baseline,
    workItems,
    entries: entries.map((entry) => toBudgetEntry(entry, query.timeZone)),
  })
}

/**
 * Reads the current progress of the baseline Work Items, archived ones included, because
 * archiving finished work must not take back what it earned.
 *
 * @param workspaceId - Workspace directory ID.
 * @param teamId - Team ID.
 * @param ids - Work Item IDs the baseline holds.
 * @param progressMode - Team progress mode.
 * @returns Progress keyed by Work Item ID; deleted Work Items are missing.
 * @throws ProjectDataError 413 when the Team has more Work Items than one read may evaluate.
 */
async function readWorkItemProgress(
  workspaceId: string,
  teamId: string,
  ids: ReadonlySet<string>,
  progressMode: Parameters<typeof deriveWorkItemProgressPercent>[1],
): Promise<Map<string, ProjectBudgetWorkItemProgress>> {
  const result = new Map<string, ProjectBudgetWorkItemProgress>()
  let evaluated = 0
  let startAfterIssueId: string | undefined
  do {
    const response = await workItemDependencies.teamIssues.getTeamIssues(workspaceId, teamId, {
      limit: WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE,
      includeArchived: true,
      consistentRead: true,
      limitEvaluatedRows: true,
      ...(startAfterIssueId ? { startAfterIssueId } : {}),
    })
    evaluated += response.evaluatedCount ?? response.issues.length
    if (evaluated > WORK_ITEMS_AGGREGATE_ITEM_LIMIT) {
      throw createWorkItemListLimitExceededError(`Team has more than ${WORK_ITEMS_AGGREGATE_ITEM_LIMIT} Work Items to report on.`)
    }
    for (const issue of response.issues) {
      if (!ids.has(issue.id)) continue
      result.set(issue.id, {
        canceled: issue.statusCategory === 'canceled',
        progressPercent: deriveWorkItemProgressPercent(issue, progressMode) ?? 0,
      })
    }
    if (response.nextStartAfterIssueId !== undefined && response.nextStartAfterIssueId === startAfterIssueId) {
      throw new ProjectDataError(503, 'WorkItemListReadStalled', `Team "${teamId}" Work Item read did not advance.`)
    }
    startAfterIssueId = response.nextStartAfterIssueId
  } while (startAfterIssueId !== undefined)
  return result
}

/**
 * Converts a time entry to what the report reads: its start date in the report timezone.
 *
 * @param entry - Stored time entry.
 * @param timeZone - Report timezone.
 * @returns The report entry.
 */
function toBudgetEntry(entry: TimeEntry, timeZone: string): ProjectBudgetTimeEntry {
  return {
    localDate: localDateAt(Date.parse(entry.startAt), timeZone),
    durationMinutes: entry.durationMinutes,
    currency: entry.currency,
    ...(entry.actualCostMinor === undefined ? {} : { actualCostMinor: entry.actualCostMinor }),
  }
}

/** Cached local date formatters by timezone. */
const localDateFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Formats an instant as a local date.
 *
 * @param timestamp - Epoch milliseconds.
 * @param timeZone - IANA timezone.
 * @returns `YYYY-MM-DD` in the timezone.
 */
function localDateAt(timestamp: number, timeZone: string): string {
  let formatter = localDateFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    localDateFormatters.set(timeZone, formatter)
  }
  return formatter.format(new Date(timestamp))
}

/**
 * Reads and validates the report query.
 *
 * @param c - Hono request context.
 * @returns The query.
 * @throws ProjectDataError 400 for a missing or invalid value or a range with too many points.
 */
function readReportQuery(c: Context): ReportQuery {
  const from = c.req.query('from')
  const to = c.req.query('to')
  if (!isLocalDate(from) || !isLocalDate(to)) throw invalidRequest('from and to must be YYYY-MM-DD dates.')
  if (from > to) throw invalidRequest('from must not be after to.')
  const timeZone = c.req.query('timeZone') ?? 'UTC'
  if (!isTimeZone(timeZone)) throw invalidRequest('timeZone must be an IANA timezone.')
  const interval = c.req.query('interval') ?? 'day'
  if (!isProjectBudgetReportInterval(interval)) throw invalidRequest('interval must be day or week.')
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
  const points = interval === 'day' ? days : Math.ceil(days / 7) + 1
  if (points > PROJECT_BUDGET_REPORT_MAX_POINTS) {
    throw invalidRequest(`The range must hold at most ${PROJECT_BUDGET_REPORT_MAX_POINTS} ${interval === 'day' ? 'days' : 'weeks'}.`)
  }
  return { from, to, timeZone, interval }
}

/**
 * Reports whether a value is a real calendar date written as `YYYY-MM-DD`.
 *
 * @param value - Candidate value.
 * @returns Whether it is a valid date.
 */
function isLocalDate(value: string | undefined): value is string {
  if (value === undefined || !LOCAL_DATE_PATTERN.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

/**
 * Reports whether a value names an IANA timezone the runtime knows.
 *
 * @param value - Candidate timezone.
 * @returns Whether it is valid.
 */
function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Creates the error for a malformed report request.
 *
 * @param message - Explanation.
 * @returns The error.
 */
function invalidRequest(message: string) {
  return new ProjectDataError(400, 'InvalidProjectBudgetReportRequest', message)
}

/**
 * Writes the report series as CSV, one row per bucket, with the earned value summary first.
 *
 * @param report - Report to export.
 * @returns CSV text ending with a newline.
 */
function createProjectBudgetReportCsv(report: ProjectBudgetReport): string {
  const currency = report.budget?.currency ?? ''
  const ev = report.earnedValue
  const rows: Array<Array<string | number>> = [
    ['From', 'To', 'Time zone', 'As of', 'Budget', 'Currency', 'BAC minutes', 'PV minutes', 'EV minutes', 'AC minutes', 'SPI', 'CPI', 'EAC minutes', 'PV', 'EV', 'AC', 'Cost CPI', 'EAC'],
    [
      report.from,
      report.to,
      report.timeZone,
      report.asOf,
      report.budget?.amountMinor ?? '',
      currency,
      ev?.budgetAtCompletionMinutes ?? '',
      ev?.plannedValueMinutes ?? '',
      ev?.earnedValueMinutes ?? '',
      report.actualMinutes,
      ev?.schedulePerformanceIndex ?? '',
      ev?.costPerformanceIndex ?? '',
      ev?.estimateAtCompletionMinutes ?? '',
      ev?.money?.plannedValueMinor ?? '',
      ev?.money?.earnedValueMinor ?? '',
      ev?.money?.actualCostMinor ?? '',
      ev?.money?.costPerformanceIndex ?? '',
      ev?.money?.estimateAtCompletionMinor ?? '',
    ],
    [],
    ['Period start', 'Period end', 'Planned value minutes', 'Actual minutes', 'Planned value', 'Actual cost', 'Currency'],
    ...report.points.map((point) => [
      point.date,
      point.endDate,
      point.plannedValueMinutes,
      point.actualMinutes ?? '',
      point.plannedValueMinor ?? '',
      point.actualCostMinor ?? '',
      currency,
    ]),
  ]
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

/**
 * Quotes one CSV cell and neutralizes spreadsheet formulas.
 *
 * @param value - Cell value.
 * @returns The CSV cell.
 */
function csvCell(value: string | number): string {
  const text = String(value)
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** HTTP status of each Project budget report error code. */
const projectBudgetErrorStatuses = {
  InvalidProjectBudgetReportRequest: 400,
  Unauthorized: 401,
  ProjectBudgetForbidden: 403,
} as const satisfies Record<string, 400 | 401 | 403>

/**
 * Reports whether an error code is one of the report-specific codes.
 *
 * @param code - Error code.
 * @returns Whether the code has a report status.
 */
function isProjectBudgetErrorCode(code: string): code is keyof typeof projectBudgetErrorStatuses {
  return Object.hasOwn(projectBudgetErrorStatuses, code)
}

/**
 * Maps report failures to their HTTP status and stable code.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The error response.
 */
function toProjectBudgetErrorResponse(c: Context, error: unknown) {
  if (error instanceof ProjectDataError && isProjectBudgetErrorCode(error.code)) {
    return c.json({ code: error.code, message: error.message }, projectBudgetErrorStatuses[error.code])
  }
  if (error instanceof TimeTrackingError) {
    if (error.status === 400) return c.json({ code: error.code, message: error.message }, 400)
    console.error(error)
    return c.json({ code: 'ProjectBudgetReportUnavailable', message: 'The Project budget report is unavailable.' }, 503)
  }
  return toWorkItemConfigurationErrorResponse(c, error)
}
