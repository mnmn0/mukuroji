import { isTimeBudgetAlertPercent, type TimeBudget, type TimeTrackingGroupBy, type TimeTrackingSummary } from '@mukuroji/contracts'
import { isFiniteNumber, isNonnegativeSafeInteger, isNumberRecord, isOptionalString, isRecord } from '../../../shared/api/jsonValidation'
import {
  createInvalidTimeTrackingResponseError,
  createTeamTimeTrackingUrl,
  requestTimeTrackingJson,
  TimeTrackingApiError,
} from './timeTrackingRequest'
import { readCanManageTeam, readSummaryGroups } from './timeTrackingValidation'

/** Budget whose figures a report also returns. */
export type TimeReportBudgetScope =
  | {
    /** Team budget. */
    scopeType: 'team'
  }
  | {
    /** Project budget. */
    scopeType: 'project'
    /** Project whose budget is read or saved. */
    projectId: string
  }

/** Fields of a report or CSV export request. */
export type TimeReportInput = {
  /** Inclusive start as a local `YYYY-MM-DD` date. */
  from: string
  /** Inclusive end as a local `YYYY-MM-DD` date. */
  to: string
  /** IANA timezone of the local dates. */
  timeZone: string
  /** Grouping dimension. */
  groupBy: TimeTrackingGroupBy
  /** Budget returned with the report, for members who may see it. */
  budgetScope?: TimeReportBudgetScope
  /** Only time of this Project is reported (ADR 0116). */
  filterProjectId?: string
}

/** Fields of a budget update. */
export type SaveTimeBudgetInput = {
  /** Budget amount in minor currency units. */
  amountMinor: number
  /** ISO 4217 currency code. */
  currency: string
  /** Inclusive local period start as `YYYY-MM-DD`. */
  periodFrom?: string
  /** Inclusive local period end as `YYYY-MM-DD`. */
  periodTo?: string
  /** Whether this saves the scope's budget for exactly this period instead of its default budget. */
  periodBudget?: boolean
  /** Use percentage that notifies the Project owner; only a Project's default budget takes it. */
  alertPercent?: number
  /** Revision being replaced, or 0 for a new budget. */
  expectedRevision: number
  /** Update time of the budget being replaced, which tells it apart from one deleted and saved again. */
  expectedUpdatedAt?: string
}

/** Every grouping the API returns. */
const groupings = ['day', 'week', 'user', 'project', 'work-item', 'category', 'phase', 'investment'] as const satisfies readonly TimeTrackingGroupBy[]

/** Fails to compile when a grouping of the contract is missing from {@link groupings}. */
const groupingsAreComplete: Exclude<TimeTrackingGroupBy, typeof groupings[number]> extends never ? true : never = true

const groupByValues: ReadonlySet<string> = new Set(groupingsAreComplete ? groupings : [])

/**
 * Builds the query string shared by the summary and the CSV export.
 *
 * @param input - Period, timezone, grouping, and budget scope.
 * @returns Encoded query.
 */
export function createTimeReportQuery(input: TimeReportInput): string {
  const query = new URLSearchParams({ from: input.from, to: input.to, timeZone: input.timeZone, groupBy: input.groupBy })
  if (input.budgetScope) {
    query.set('budgetScope', input.budgetScope.scopeType)
    if (input.budgetScope.scopeType === 'project') query.set('projectId', input.budgetScope.projectId)
  }
  if (input.filterProjectId) query.set('filterProjectId', input.filterProjectId)
  return query.toString()
}

/**
 * Validates a Team or Project budget from the API.
 *
 * @param value - Unknown JSON value.
 * @returns The budget, or undefined when the shape is invalid.
 */
export function readTimeBudget(value: unknown): TimeBudget | undefined {
  if (!isRecord(value)) return undefined
  const { schemaVersion, workspaceId, teamId, scopeType, scopeId, amountMinor, currency, periodFrom, periodTo, periodBudget, alertPercent, revision, updatedAt } = value
  if (
    (periodBudget !== undefined && periodBudget !== true) ||
    (alertPercent !== undefined && !isTimeBudgetAlertPercent(alertPercent)) ||
    schemaVersion !== 1 || typeof workspaceId !== 'string' || typeof teamId !== 'string' ||
    (scopeType !== 'team' && scopeType !== 'project') ||
    typeof scopeId !== 'string' || !isNonnegativeSafeInteger(amountMinor) || typeof currency !== 'string' ||
    !isOptionalString(periodFrom) || !isOptionalString(periodTo) || !isNonnegativeSafeInteger(revision) ||
    typeof updatedAt !== 'string'
  ) {
    return undefined
  }
  return {
    schemaVersion,
    workspaceId,
    teamId,
    scopeType,
    scopeId,
    amountMinor,
    currency,
    ...(periodFrom === undefined ? {} : { periodFrom }),
    ...(periodTo === undefined ? {} : { periodTo }),
    ...(periodBudget === true ? { periodBudget } : {}),
    ...(isTimeBudgetAlertPercent(alertPercent) ? { alertPercent } : {}),
    revision,
    updatedAt,
  }
}

/**
 * Validates a grouped time tracking report from the API.
 *
 * @param value - Unknown JSON value.
 * @returns The report, or undefined when the shape is invalid.
 */
export function readTimeTrackingSummary(value: unknown): TimeTrackingSummary | undefined {
  if (!isRecord(value)) return undefined
  const {
    from, to, timeZone, groupBy, totalMinutes, totalBillableMinutes, totalEstimateMinutes,
    totalActualCostMinor, totalActualCostByCurrency, budget, budgetPeriods, costsRedacted, canManageTeam,
  } = value
  const groups = readSummaryGroups(value.groups)
  const parsedBudget = budget === undefined ? undefined : readTimeBudget(budget)
  const parsedBudgetPeriods = budgetPeriods === undefined ? undefined : readTimeBudgetPeriods(budgetPeriods)
  if (
    typeof from !== 'string' || typeof to !== 'string' || typeof timeZone !== 'string' ||
    typeof groupBy !== 'string' || !groupByValues.has(groupBy) || !groups ||
    !isNonnegativeSafeInteger(totalMinutes) || !isNonnegativeSafeInteger(totalBillableMinutes) ||
    !isFiniteNumber(totalEstimateMinutes) ||
    (totalActualCostMinor !== undefined && !isFiniteNumber(totalActualCostMinor)) ||
    (totalActualCostByCurrency !== undefined && !isNumberRecord(totalActualCostByCurrency)) ||
    (budget !== undefined && !parsedBudget) || (budgetPeriods !== undefined && !parsedBudgetPeriods) ||
    typeof costsRedacted !== 'boolean'
  ) {
    return undefined
  }
  // An older API totalled every member's visible time, so its report is not limited to the caller.
  const parsedCanManageTeam = readCanManageTeam(canManageTeam, true)
  if (parsedCanManageTeam === undefined) return undefined
  return {
    from,
    to,
    timeZone,
    groupBy: readGroupBy(groupBy),
    groups,
    totalMinutes,
    totalBillableMinutes,
    totalEstimateMinutes,
    ...(totalActualCostMinor === undefined ? {} : { totalActualCostMinor }),
    ...(totalActualCostByCurrency === undefined ? {} : { totalActualCostByCurrency }),
    ...(parsedBudget ? { budget: parsedBudget } : {}),
    ...(parsedBudgetPeriods ? { budgetPeriods: parsedBudgetPeriods } : {}),
    costsRedacted,
    canManageTeam: parsedCanManageTeam,
  }
}

/**
 * Validates a scope's budgets per period from the API.
 *
 * @param value - Unknown JSON value.
 * @returns The budgets, or undefined when any is invalid or lacks its period.
 */
function readTimeBudgetPeriods(value: unknown): TimeBudget[] | undefined {
  if (!Array.isArray(value)) return undefined
  const budgets: TimeBudget[] = []
  for (const item of value) {
    const budget = readTimeBudget(item)
    if (!budget?.periodBudget || !budget.periodFrom || !budget.periodTo) return undefined
    budgets.push(budget)
  }
  return budgets
}

/**
 * Narrows a checked grouping name to the contract type.
 *
 * @param value - Grouping already checked against the known values.
 * @returns The same grouping, typed; `day` for anything else.
 */
function readGroupBy(value: string): TimeTrackingGroupBy {
  return groupings.find((grouping) => grouping === value) ?? 'day'
}

/**
 * Reads the Team's grouped report, with costs and the budget only for members who may see them.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team whose entries are summarized.
 * @param input - Period, timezone, grouping, and budget scope.
 * @returns Validated report.
 */
export async function getTimeTrackingSummary(
  accessToken: string,
  teamId: string,
  input: TimeReportInput,
): Promise<TimeTrackingSummary> {
  const data = await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(teamId, `/time-tracking/summary?${createTimeReportQuery(input)}`),
    accessToken,
  )
  const summary = readTimeTrackingSummary(data)
  if (!summary) throw createInvalidTimeTrackingResponseError('Time summary')
  return summary
}

/**
 * Downloads the CSV export of the same report the screen shows.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team whose entries are exported.
 * @param input - Period, timezone, grouping, and Project filter.
 * @returns CSV body.
 */
export async function downloadTimeTrackingCsv(
  accessToken: string,
  teamId: string,
  input: TimeReportInput,
): Promise<Blob> {
  // The CSV carries no budget, so the budget scope is left out of the export query.
  const reportInput: TimeReportInput = {
    from: input.from,
    to: input.to,
    timeZone: input.timeZone,
    groupBy: input.groupBy,
    ...(input.filterProjectId ? { filterProjectId: input.filterProjectId } : {}),
  }
  const url = createTeamTimeTrackingUrl(teamId, `/time-tracking/export?${createTimeReportQuery(reportInput)}`)
  let response: Response
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch {
    throw new TimeTrackingApiError(0, 'The time tracking API could not be reached.', 'NetworkUnavailable')
  }
  if (!response.ok) {
    throw new TimeTrackingApiError(response.status, 'The time tracking export failed.')
  }
  return new Blob([await response.text()], { type: 'text/csv;charset=utf-8' })
}

/**
 * Saves a Team or Project budget.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the budget or its Project.
 * @param scope - Team or Project budget.
 * @param input - Amount, currency, optional period, and the revision being replaced.
 * @returns Saved budget.
 */
export async function saveTimeBudget(
  accessToken: string,
  teamId: string,
  scope: TimeReportBudgetScope,
  input: SaveTimeBudgetInput,
): Promise<TimeBudget> {
  const path = scope.scopeType === 'team'
    ? '/time-budget'
    : `/projects/${encodeURIComponent(scope.projectId)}/time-budget`
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, path), accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amountMinor: input.amountMinor,
      currency: input.currency,
      ...(input.periodFrom ? { periodFrom: input.periodFrom } : {}),
      ...(input.periodTo ? { periodTo: input.periodTo } : {}),
      ...(input.periodBudget ? { periodBudget: true } : {}),
      ...(input.alertPercent === undefined ? {} : { alertPercent: input.alertPercent }),
      expectedRevision: input.expectedRevision,
      ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
    }),
  })
  const budget = isRecord(data) ? readTimeBudget(data.budget) : undefined
  if (!budget) throw createInvalidTimeTrackingResponseError('Time budget')
  return budget
}

/**
 * Deletes one of a Team's or Project's budgets per period.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the budget or its Project.
 * @param scope - Team or Project budget.
 * @param budget - Budget per period to delete, whose revision is expected.
 */
export async function deleteTimeBudgetPeriod(
  accessToken: string,
  teamId: string,
  scope: TimeReportBudgetScope,
  budget: Pick<TimeBudget, 'periodFrom' | 'periodTo' | 'revision' | 'updatedAt'>,
): Promise<void> {
  if (!budget.periodFrom || !budget.periodTo) throw createInvalidTimeTrackingResponseError('Time budget period')
  const scopePath = scope.scopeType === 'team' ? '' : `/projects/${encodeURIComponent(scope.projectId)}`
  // The save time tells this budget from one saved again for the same period after a delete.
  const query = new URLSearchParams({ expectedRevision: String(budget.revision), expectedUpdatedAt: budget.updatedAt })
  await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(
      teamId,
      `${scopePath}/time-budget/periods/${encodeURIComponent(budget.periodFrom)}/${encodeURIComponent(budget.periodTo)}?${query.toString()}`,
    ),
    accessToken,
    { method: 'DELETE' },
  )
}
