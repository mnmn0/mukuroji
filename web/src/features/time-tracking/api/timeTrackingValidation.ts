import type {
  RunningTimer,
  TimeEntry,
  TimeEntryHistory,
  TimeEntrySource,
  TimeEntryStatus,
  TimeEstimate,
  TimeSheet,
  TimeSummaryGroup,
} from '@mukuroji/contracts'
import {
  isFiniteNumber,
  isNonnegativeSafeInteger,
  isNumberRecord,
  isOptionalString,
  isRecord,
} from '../../../shared/api/jsonValidation'

const entryStatuses = new Set<string>(['draft', 'submitted', 'approved', 'rejected', 'locked'])
const historyActions = new Set<string>(['created', 'updated', 'submitted', 'approved', 'rejected', 'locked'])

/**
 * Returns whether a value is a time entry lifecycle state.
 *
 * @param value - Unknown candidate.
 * @returns Whether the value is a known status.
 */
export function isTimeEntryStatus(value: unknown): value is TimeEntryStatus {
  return typeof value === 'string' && entryStatuses.has(value)
}

/**
 * Returns whether a value is a time entry source.
 *
 * @param value - Unknown candidate.
 * @returns Whether the value is manual or timer.
 */
function isTimeEntrySource(value: unknown): value is TimeEntrySource {
  return value === 'manual' || value === 'timer'
}

/**
 * Returns whether an optional field is absent or a finite number.
 *
 * @param value - Unknown candidate.
 * @returns Whether the value is undefined or finite.
 */
function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value)
}

/**
 * Validates one time entry from the API.
 *
 * @param value - Unknown JSON value.
 * @returns The entry, or undefined when the shape is invalid.
 */
export function readTimeEntry(value: unknown): TimeEntry | undefined {
  if (!isRecord(value)) return undefined
  const {
    schemaVersion, id, workspaceId, teamId, projectId, workItemId, userId, startAt, endAt,
    durationMinutes, description, billable, currency, status, source, revision, hourlyRateMinor,
    actualCostMinor, createdAt, updatedAt, submittedAt, approvedAt, rejectedAt, lockedAt,
  } = value
  if (
    schemaVersion !== 1 ||
    typeof id !== 'string' || typeof workspaceId !== 'string' || typeof teamId !== 'string' ||
    !isOptionalString(projectId) || typeof workItemId !== 'string' || typeof userId !== 'string' ||
    typeof startAt !== 'string' || typeof endAt !== 'string' || !isNonnegativeSafeInteger(durationMinutes) ||
    !isOptionalString(description) || typeof billable !== 'boolean' || typeof currency !== 'string' ||
    !isTimeEntryStatus(status) || !isTimeEntrySource(source) || !isNonnegativeSafeInteger(revision) ||
    !isOptionalNumber(hourlyRateMinor) || !isOptionalNumber(actualCostMinor) ||
    typeof createdAt !== 'string' || typeof updatedAt !== 'string' || !isOptionalString(submittedAt) ||
    !isOptionalString(approvedAt) || !isOptionalString(rejectedAt) || !isOptionalString(lockedAt)
  ) {
    return undefined
  }
  return {
    schemaVersion,
    id,
    workspaceId,
    teamId,
    ...(projectId === undefined ? {} : { projectId }),
    workItemId,
    userId,
    startAt,
    endAt,
    durationMinutes,
    ...(description === undefined ? {} : { description }),
    billable,
    currency,
    status,
    source,
    revision,
    ...(hourlyRateMinor === undefined ? {} : { hourlyRateMinor }),
    ...(actualCostMinor === undefined ? {} : { actualCostMinor }),
    createdAt,
    updatedAt,
    ...(submittedAt === undefined ? {} : { submittedAt }),
    ...(approvedAt === undefined ? {} : { approvedAt }),
    ...(rejectedAt === undefined ? {} : { rejectedAt }),
    ...(lockedAt === undefined ? {} : { lockedAt }),
  }
}

/**
 * Validates a running timer from the API.
 *
 * @param value - Unknown JSON value.
 * @returns The timer, or undefined when the shape is invalid.
 */
export function readRunningTimer(value: unknown): RunningTimer | undefined {
  if (!isRecord(value)) return undefined
  const { schemaVersion, id, workspaceId, teamId, projectId, workItemId, userId, startedAt, description, billable, revision, updatedAt } = value
  if (
    schemaVersion !== 1 ||
    typeof id !== 'string' || typeof workspaceId !== 'string' || typeof teamId !== 'string' ||
    !isOptionalString(projectId) || typeof workItemId !== 'string' || typeof userId !== 'string' ||
    typeof startedAt !== 'string' || !isOptionalString(description) || typeof billable !== 'boolean' ||
    !isNonnegativeSafeInteger(revision) || typeof updatedAt !== 'string'
  ) {
    return undefined
  }
  return {
    schemaVersion,
    id,
    workspaceId,
    teamId,
    ...(projectId === undefined ? {} : { projectId }),
    workItemId,
    userId,
    startedAt,
    ...(description === undefined ? {} : { description }),
    billable,
    revision,
    updatedAt,
  }
}

/**
 * Validates a Work Item estimate from the API.
 *
 * @param value - Unknown JSON value.
 * @returns The estimate, or undefined when the shape is invalid.
 */
export function readTimeEstimate(value: unknown): TimeEstimate | undefined {
  if (!isRecord(value)) return undefined
  const { schemaVersion, workspaceId, teamId, workItemId, estimateMinutes, revision, updatedBy, updatedAt } = value
  if (
    schemaVersion !== 1 ||
    typeof workspaceId !== 'string' || typeof teamId !== 'string' || typeof workItemId !== 'string' ||
    !isNonnegativeSafeInteger(estimateMinutes) || !isNonnegativeSafeInteger(revision) ||
    typeof updatedBy !== 'string' || typeof updatedAt !== 'string'
  ) {
    return undefined
  }
  return { schemaVersion, workspaceId, teamId, workItemId, estimateMinutes, revision, updatedBy, updatedAt }
}

/**
 * Validates one immutable history record.
 *
 * @param value - Unknown JSON value.
 * @returns The record, or undefined when the shape is invalid.
 */
export function readTimeEntryHistory(value: unknown): TimeEntryHistory | undefined {
  if (!isRecord(value)) return undefined
  const { id, entryId, action, fromStatus, toStatus, actorUserId, reason, occurredAt } = value
  if (
    typeof id !== 'string' || typeof entryId !== 'string' ||
    typeof action !== 'string' || !historyActions.has(action) ||
    (fromStatus !== undefined && !isTimeEntryStatus(fromStatus)) ||
    (toStatus !== undefined && !isTimeEntryStatus(toStatus)) ||
    typeof actorUserId !== 'string' || !isOptionalString(reason) || typeof occurredAt !== 'string'
  ) {
    return undefined
  }
  return {
    id,
    entryId,
    action: readHistoryAction(action),
    ...(fromStatus === undefined ? {} : { fromStatus }),
    ...(toStatus === undefined ? {} : { toStatus }),
    actorUserId,
    ...(reason === undefined ? {} : { reason }),
    occurredAt,
  }
}

/**
 * Narrows a checked history action string to its contract union.
 *
 * @param value - Action already checked against the known set.
 * @returns Contract action.
 */
function readHistoryAction(value: string): TimeEntryHistory['action'] {
  switch (value) {
    case 'updated':
    case 'submitted':
    case 'approved':
    case 'rejected':
    case 'locked':
      return value
    default:
      return 'created'
  }
}

/**
 * Validates one grouped report row.
 *
 * @param value - Unknown JSON value.
 * @returns The row, or undefined when the shape is invalid.
 */
function readSummaryGroup(value: unknown): TimeSummaryGroup | undefined {
  if (!isRecord(value)) return undefined
  const { key, label, minutes, billableMinutes, entryCount, estimateMinutes, actualCostMinor, actualCostByCurrency } = value
  if (
    typeof key !== 'string' || typeof label !== 'string' || !isNonnegativeSafeInteger(minutes) ||
    !isNonnegativeSafeInteger(billableMinutes) || !isNonnegativeSafeInteger(entryCount) ||
    !isOptionalNumber(estimateMinutes) || !isOptionalNumber(actualCostMinor) ||
    (actualCostByCurrency !== undefined && !isNumberRecord(actualCostByCurrency))
  ) {
    return undefined
  }
  return {
    key,
    label,
    minutes,
    billableMinutes,
    entryCount,
    ...(estimateMinutes === undefined ? {} : { estimateMinutes }),
    ...(actualCostMinor === undefined ? {} : { actualCostMinor }),
    ...(actualCostByCurrency === undefined ? {} : { actualCostByCurrency }),
  }
}

/**
 * Validates a list of grouped report rows.
 *
 * @param value - Unknown JSON value.
 * @returns The rows, or undefined when any row is invalid.
 */
function readSummaryGroups(value: unknown): TimeSummaryGroup[] | undefined {
  if (!Array.isArray(value)) return undefined
  const groups = value.map(readSummaryGroup)
  return groups.every((group) => group !== undefined) ? groups.filter((group) => group !== undefined) : undefined
}

/**
 * Validates a Team timesheet from the API.
 *
 * @param value - Unknown JSON value.
 * @returns The timesheet, or undefined when the shape is invalid.
 */
export function readTimeSheet(value: unknown): TimeSheet | undefined {
  if (!isRecord(value)) return undefined
  const days = readSummaryGroups(value.days)
  const weeks = readSummaryGroups(value.weeks)
  if (
    typeof value.from !== 'string' || typeof value.to !== 'string' || typeof value.timeZone !== 'string' ||
    !days || !weeks || typeof value.costsRedacted !== 'boolean'
  ) {
    return undefined
  }
  return { from: value.from, to: value.to, timeZone: value.timeZone, days, weeks, costsRedacted: value.costsRedacted }
}

/**
 * Validates a list of time entries.
 *
 * @param value - Unknown JSON value.
 * @returns The entries, or undefined when any entry is invalid.
 */
export function readTimeEntries(value: unknown): TimeEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value.map(readTimeEntry)
  return entries.every((entry) => entry !== undefined) ? entries.filter((entry) => entry !== undefined) : undefined
}
