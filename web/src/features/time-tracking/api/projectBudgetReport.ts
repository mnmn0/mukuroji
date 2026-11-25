import {
  isProjectBudgetReportInterval,
  type ProjectBudgetReport,
  type ProjectBudgetReportBaseline,
  type ProjectBudgetReportInterval,
  type ProjectBudgetReportPoint,
  type ProjectEarnedValueMetrics,
  type ProjectEarnedValueMoney,
} from '@mukuroji/contracts'
import { isFiniteNumber, isNonnegativeSafeInteger, isNumberRecord, isRecord } from '../../../shared/api/jsonValidation'
import { readTimeBudget } from './timeReport'
import {
  createInvalidTimeTrackingResponseError,
  createTeamTimeTrackingUrl,
  requestTimeTrackingJson,
  TimeTrackingApiError,
} from './timeTrackingRequest'

/** Range, timezone, and series bucket of a Project budget report request. */
export type ProjectBudgetReportInput = {
  /** First local date as `YYYY-MM-DD`. */
  from: string
  /** Last local date as `YYYY-MM-DD`. */
  to: string
  /** IANA timezone of the local dates. */
  timeZone: string
  /** Series bucket. */
  interval: ProjectBudgetReportInterval
}

/**
 * Builds the path of a Project budget report endpoint with its query.
 *
 * @param projectId - Project identifier.
 * @param suffix - Empty for the report, `/export` for the CSV.
 * @param input - Range, timezone, and bucket.
 * @returns Path below the Team.
 */
function createReportPath(projectId: string, suffix: '' | '/export', input: ProjectBudgetReportInput): string {
  const query = new URLSearchParams({ from: input.from, to: input.to, timeZone: input.timeZone, interval: input.interval })
  return `/projects/${encodeURIComponent(projectId)}/budget-report${suffix}?${query.toString()}`
}

/**
 * Reads the budget against actual report and earned value figures of one Project.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param input - Range, timezone, and bucket.
 * @returns The validated report.
 * @throws TimeTrackingApiError when the request fails or the response is malformed.
 */
export async function getProjectBudgetReport(
  accessToken: string,
  teamId: string,
  projectId: string,
  input: ProjectBudgetReportInput,
): Promise<ProjectBudgetReport> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, createReportPath(projectId, '', input)), accessToken)
  const report = readProjectBudgetReport(data)
  if (!report || report.teamId !== teamId || report.projectId !== projectId) {
    throw createInvalidTimeTrackingResponseError('Project budget report')
  }
  return report
}

/**
 * Downloads the CSV export of the same report.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param input - Range, timezone, and bucket.
 * @returns CSV body.
 */
export async function downloadProjectBudgetReportCsv(
  accessToken: string,
  teamId: string,
  projectId: string,
  input: ProjectBudgetReportInput,
): Promise<Blob> {
  let response: Response
  try {
    response = await fetch(createTeamTimeTrackingUrl(teamId, createReportPath(projectId, '/export', input)), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  } catch {
    throw new TimeTrackingApiError(0, 'The time tracking API could not be reached.', 'NetworkUnavailable')
  }
  if (!response.ok) throw new TimeTrackingApiError(response.status, 'The Project budget export failed.')
  return new Blob([await response.text()], { type: 'text/csv;charset=utf-8' })
}

/**
 * Validates a Project budget report from the API.
 *
 * @param value - Unknown JSON value.
 * @returns The report, or undefined when the shape is invalid.
 */
export function readProjectBudgetReport(value: unknown): ProjectBudgetReport | undefined {
  if (!isRecord(value)) return undefined
  const { teamId, projectId, from, to, timeZone, interval, asOf, actualMinutes, uncostedMinutes, actualCostByCurrency } = value
  if (
    typeof teamId !== 'string' || typeof projectId !== 'string' || typeof from !== 'string' || typeof to !== 'string' ||
    typeof timeZone !== 'string' || !isProjectBudgetReportInterval(interval) || typeof asOf !== 'string' ||
    !isNonnegativeSafeInteger(actualMinutes) || !isNonnegativeSafeInteger(uncostedMinutes) || !isNumberRecord(actualCostByCurrency) ||
    !Array.isArray(value.points)
  ) {
    return undefined
  }
  const budget = value.budget === null ? null : readTimeBudget(value.budget)
  const baseline = value.baseline === null ? null : readBaseline(value.baseline)
  const earnedValue = value.earnedValue === null ? null : readEarnedValue(value.earnedValue)
  const points = value.points.map(readPoint)
  const budgetConsumedPercent = readOptionalNumber(value.budgetConsumedPercent)
  const effortConsumedPercent = readOptionalNumber(value.effortConsumedPercent)
  if (
    budget === undefined || baseline === undefined || earnedValue === undefined ||
    budgetConsumedPercent === false || effortConsumedPercent === false
  ) {
    return undefined
  }
  const validPoints = points.filter((point): point is ProjectBudgetReportPoint => point !== undefined)
  if (validPoints.length !== points.length) return undefined
  return {
    teamId,
    projectId,
    from,
    to,
    timeZone,
    interval,
    asOf,
    budget,
    baseline,
    actualMinutes,
    uncostedMinutes,
    actualCostByCurrency,
    ...(budgetConsumedPercent === undefined ? {} : { budgetConsumedPercent }),
    ...(effortConsumedPercent === undefined ? {} : { effortConsumedPercent }),
    earnedValue,
    points: validPoints,
  }
}

/**
 * Reads an optional finite number.
 *
 * @param value - Unknown value.
 * @returns The number, undefined when absent, or `false` when present but not a number.
 */
function readOptionalNumber(value: unknown): number | undefined | false {
  if (value === undefined) return undefined
  return isFiniteNumber(value) ? value : false
}

/**
 * Reads the active baseline summary.
 *
 * @param value - Unknown value.
 * @returns The summary, or undefined when invalid.
 */
function readBaseline(value: unknown): ProjectBudgetReportBaseline | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, capturedAt, entryCount, unscheduledEffortMinutes, canceledEffortMinutes } = value
  if (
    (id !== undefined && typeof id !== 'string') || (name !== undefined && typeof name !== 'string') ||
    typeof capturedAt !== 'string' || !isNonnegativeSafeInteger(entryCount) ||
    !isNonnegativeSafeInteger(unscheduledEffortMinutes) || !isNonnegativeSafeInteger(canceledEffortMinutes)
  ) {
    return undefined
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    capturedAt,
    entryCount,
    unscheduledEffortMinutes,
    canceledEffortMinutes,
  }
}

/**
 * Reads one series point.
 *
 * @param value - Unknown value.
 * @returns The point, or undefined when invalid.
 */
function readPoint(value: unknown): ProjectBudgetReportPoint | undefined {
  if (!isRecord(value)) return undefined
  const { date, endDate, plannedValueMinutes } = value
  const plannedValueMinor = readOptionalNumber(value.plannedValueMinor)
  const actualMinutes = readOptionalNumber(value.actualMinutes)
  const actualCostMinor = readOptionalNumber(value.actualCostMinor)
  if (
    typeof date !== 'string' || typeof endDate !== 'string' || !isFiniteNumber(plannedValueMinutes) ||
    plannedValueMinor === false || actualMinutes === false || actualCostMinor === false
  ) {
    return undefined
  }
  return {
    date,
    endDate,
    plannedValueMinutes,
    ...(plannedValueMinor === undefined ? {} : { plannedValueMinor }),
    ...(actualMinutes === undefined ? {} : { actualMinutes }),
    ...(actualCostMinor === undefined ? {} : { actualCostMinor }),
  }
}

/** Required number fields of the earned value figures in minutes. */
const earnedValueRequiredFields = [
  'budgetAtCompletionMinutes',
  'plannedValueMinutes',
  'earnedValueMinutes',
  'actualMinutes',
  'scheduleVarianceMinutes',
  'costVarianceMinutes',
] as const

/** Optional number fields of the earned value figures in minutes. */
const earnedValueOptionalFields = [
  'schedulePerformanceIndex',
  'costPerformanceIndex',
  'estimateAtCompletionMinutes',
  'estimateToCompleteMinutes',
  'varianceAtCompletionMinutes',
] as const

/** Required number fields of the earned value figures in money. */
const moneyRequiredFields = [
  'budgetAtCompletionMinor',
  'plannedValueMinor',
  'earnedValueMinor',
  'actualCostMinor',
  'scheduleVarianceMinor',
  'costVarianceMinor',
] as const

/** Optional number fields of the earned value figures in money. */
const moneyOptionalFields = [
  'costPerformanceIndex',
  'estimateAtCompletionMinor',
  'estimateToCompleteMinor',
  'varianceAtCompletionMinor',
] as const

/**
 * Reads named number fields from a record.
 *
 * @param record - Source record.
 * @param required - Fields that must be finite numbers.
 * @param optional - Fields that may be absent.
 * @returns The fields, or undefined when one is invalid.
 */
function readNumberFields<Required extends string, Optional extends string>(
  record: Record<string, unknown>,
  required: readonly Required[],
  optional: readonly Optional[],
): (Record<Required, number> & Partial<Record<Optional, number>>) | undefined {
  const result: Partial<Record<Required | Optional, number>> = {}
  for (const field of required) {
    const value = record[field]
    if (!isFiniteNumber(value)) return undefined
    result[field] = value
  }
  for (const field of optional) {
    const value = readOptionalNumber(record[field])
    if (value === false) return undefined
    if (value !== undefined) result[field] = value
  }
  return hasRequiredFields(result, required) ? result : undefined
}

/**
 * Narrows a partial record to one that holds every required field.
 *
 * @param value - Partial record.
 * @param required - Fields that must be present.
 * @returns Whether every required field is a number.
 */
function hasRequiredFields<Required extends string, Optional extends string>(
  value: Partial<Record<Required | Optional, number>>,
  required: readonly Required[],
): value is Record<Required, number> & Partial<Record<Optional, number>> {
  return required.every((field) => typeof value[field] === 'number')
}

/**
 * Reads the earned value figures.
 *
 * @param value - Unknown value.
 * @returns The figures, or undefined when invalid.
 */
function readEarnedValue(value: unknown): ProjectEarnedValueMetrics | undefined {
  if (!isRecord(value)) return undefined
  const minutes = readNumberFields(value, earnedValueRequiredFields, earnedValueOptionalFields)
  if (!minutes) return undefined
  if (value.money === undefined) return minutes
  const money = readMoney(value.money)
  return money ? { ...minutes, money } : undefined
}

/**
 * Reads the earned value figures in money.
 *
 * @param value - Unknown value.
 * @returns The figures, or undefined when invalid.
 */
function readMoney(value: unknown): ProjectEarnedValueMoney | undefined {
  if (!isRecord(value) || typeof value.currency !== 'string') return undefined
  const amounts = readNumberFields(value, moneyRequiredFields, moneyOptionalFields)
  return amounts ? { currency: value.currency, ...amounts } : undefined
}
