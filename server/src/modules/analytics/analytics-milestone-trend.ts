import {
  analyticsDateToEpochDay,
  analyticsEpochDayToDate,
  type AnalyticsGroup,
  type AnalyticsSeriesPoint,
  type AnalyticsTableRow,
} from '@mukuroji/contracts'

/** Warning of a Milestone trend widget computed by a run that cannot read Milestones. */
export const ANALYTICS_MILESTONE_HISTORY_UNAVAILABLE_WARNING =
  'Milestone history is not available for this run.'

/** Planning entity fields whose history the Milestone trend reads. */
export const ANALYTICS_MILESTONE_TREND_FIELDS = Object.freeze([
  'forecast.endDate',
  'teamId',
  'projectId',
] as const)

/** Planning entity field whose history the Milestone trend reads. */
export type AnalyticsMilestoneTrendField = typeof ANALYTICS_MILESTONE_TREND_FIELDS[number]

/** One recorded change of a Milestone field. */
export type AnalyticsMilestoneFieldChange = {
  /** Changed field. */
  field: AnalyticsMilestoneTrendField
  /** Value before the change; omitted when the field was absent. */
  before?: string
  /** Value after the change; omitted when the field was removed. */
  after?: string
}

/** One audit event of a Milestone, reduced to the fields the trend reads. */
export type AnalyticsMilestoneChange = {
  /** Audit event ID, which orders events recorded at the same instant. */
  eventId: string
  /** ISO 8601 instant the change was recorded at. */
  occurredAt: string
  /** Changed trend fields of the event. */
  changes: AnalyticsMilestoneFieldChange[]
}

/**
 * A Milestone the caller can read now, with its recorded date history.
 *
 * The API reads only live Milestones that the current Planning ACL shows, so the engine never
 * widens access. The history comes from the `planning-entity` audit timeline.
 */
export type AnalyticsMilestoneHistory = {
  /** Planning entity ID. */
  id: string
  /** Current title. */
  title: string
  /** Current Team scope. */
  teamId?: string
  /** Current Project scope. */
  projectId?: string
  /** Current forecast end date (`YYYY-MM-DD`). */
  forecastEndDate: string
  /** Current baseline end date (`YYYY-MM-DD`). */
  baselineEndDate: string
  /** ISO 8601 creation instant. */
  createdAt: string
  /**
   * ISO 8601 instant of the latest write. A move of an ancestor changes the Milestone's scope
   * without an event of its own, so the engine treats a scope that differs from the recorded one
   * as changed at this instant.
   */
  updatedAt: string
  /** Recorded changes in any order; the engine sorts them. */
  history: AnalyticsMilestoneChange[]
}

/**
 * Returns the key that fixes a Milestone and its current scope in a snapshot's permission scope.
 *
 * The dates of a Milestone are shown only while its scope equals the current one, so a saved
 * snapshot stays readable only while the Milestone keeps that scope.
 *
 * @param milestone - Milestone ID and current Team / Project scope.
 * @returns The scope key.
 */
export function createAnalyticsMilestoneScopeKey(
  milestone: Pick<AnalyticsMilestoneHistory, 'id' | 'teamId' | 'projectId'>,
) {
  return [milestone.id, milestone.teamId ?? '', milestone.projectId ?? ''].join('\0')
}

/** Calendar bucket the trend is evaluated at. */
export type AnalyticsMilestoneTrendBucket = {
  /** Bucket start epoch milliseconds. */
  from: number
  /** Bucket end epoch milliseconds. */
  to: number
}

/** Inputs of {@link createAnalyticsMilestoneTrend}. */
export type AnalyticsMilestoneTrendInput = {
  /** Authorized Milestones, or `undefined` when the run cannot read Milestones. */
  milestones: readonly AnalyticsMilestoneHistory[] | undefined
  /** Calendar buckets of the chart; empty for metric and table widgets. */
  buckets: readonly AnalyticsMilestoneTrendBucket[]
  /** Period start epoch milliseconds. */
  periodFrom: number
  /** Period end epoch milliseconds. */
  periodTo: number
  /** Query `asOf` epoch milliseconds. */
  asOf: number
  /** Maximum number of table rows. */
  maxRows: number
}

/** Widget result parts of the Milestone trend. */
export type AnalyticsMilestoneTrendResult = {
  /** Number of Milestones whose date moved in the period. */
  value: number | null
  /** Number of Milestones that existed at `asOf`. */
  sampleSize: number
  /** Chart points whose segments carry each Milestone's date. */
  series: AnalyticsSeriesPoint[]
  /** One group per Milestone. */
  groups: AnalyticsGroup[]
  /** One table row per Milestone. */
  rows: AnalyticsTableRow[]
  /** Non-fatal notes. */
  warnings: string[]
}

/** A Milestone with its changes sorted and its timestamps parsed. */
type PreparedMilestone = {
  /** Source Milestone. */
  milestone: AnalyticsMilestoneHistory
  /** Creation epoch milliseconds. */
  createdAt: number
  /** Changes in recorded order. */
  history: Array<AnalyticsMilestoneChange & { at: number }>
}

/**
 * Builds the Milestone trend: each Milestone's forecast end date at every bucket end.
 *
 * A field's value at an instant is the `after` of its latest change at or before it, otherwise
 * the `before` of its earliest later change, otherwise the current value. A Milestone shows a
 * date only after its creation and only while its recorded Team / Project scope equals the
 * current one, so history recorded in another scope is never shown.
 *
 * @param input - Authorized Milestones and the evaluation buckets.
 * @returns Value, series, groups, rows, and warnings of the widget.
 */
export function createAnalyticsMilestoneTrend(
  input: AnalyticsMilestoneTrendInput,
): AnalyticsMilestoneTrendResult {
  if (input.milestones === undefined) {
    return {
      value: null,
      sampleSize: 0,
      series: input.buckets.map((bucket) => createPoint(bucket, [])),
      groups: [],
      rows: [],
      warnings: [ANALYTICS_MILESTONE_HISTORY_UNAVAILABLE_WARNING],
    }
  }
  const prepared = input.milestones
    .map(prepareMilestone)
    .filter((entry): entry is PreparedMilestone =>
      entry !== undefined && entry.createdAt <= input.asOf
    )
  const periodEnd = Math.min(input.periodTo, input.asOf)
  const summaries = prepared.map((entry) => {
    const start = firstVisibleDate(entry, Math.max(input.periodFrom, entry.createdAt), periodEnd)
    const end = dateAt(entry, periodEnd)
    const changeCount = entry.history.filter((change) =>
      change.at >= input.periodFrom &&
      change.at <= periodEnd &&
      change.changes.some((fieldChange) =>
        // Creation records the first date, which is not a change of it.
        fieldChange.field === 'forecast.endDate' &&
        fieldChange.before !== undefined &&
        fieldChange.after !== undefined &&
        fieldChange.before !== fieldChange.after
      ) &&
      isInCurrentScope(entry, change.at)
    ).length
    return {
      entry,
      start,
      end,
      changeCount,
      shiftDays: start === undefined || end === undefined ? null : end - start,
    }
  }).sort((left, right) =>
    (left.end ?? Number.MAX_SAFE_INTEGER) - (right.end ?? Number.MAX_SAFE_INTEGER) ||
    left.entry.milestone.title.localeCompare(right.entry.milestone.title) ||
    left.entry.milestone.id.localeCompare(right.entry.milestone.id)
  )
  const order = summaries.map((summary) => summary.entry)
  const series = input.buckets.map((bucket) => {
    const evaluationAt = Math.min(bucket.to, input.asOf)
    return createPoint(bucket, order.flatMap((entry) => {
      const value = dateAt(entry, evaluationAt)
      return value === undefined ? [] : [{ key: entry.milestone.id, value }]
    }))
  })
  const withoutHistory = prepared.filter((entry) => entry.history.length === 0).length
  return {
    value: summaries.filter((summary) => summary.changeCount > 0).length,
    sampleSize: summaries.length,
    series,
    groups: summaries.map((summary) => ({
      key: summary.entry.milestone.id,
      label: summary.entry.milestone.title,
      value: summary.shiftDays,
      sampleSize: summary.changeCount,
    })),
    rows: summaries.slice(0, input.maxRows).map((summary) => ({
      id: summary.entry.milestone.id,
      label: summary.entry.milestone.title,
      values: {
        milestoneId: summary.entry.milestone.id,
        baselineEndDate: normalizeDate(summary.entry.milestone.baselineEndDate) ?? null,
        periodStartForecastEndDate: toDate(summary.start),
        forecastEndDate: toDate(summary.end),
        shiftDays: summary.shiftDays,
        changeCount: summary.changeCount,
      },
    })),
    warnings: [
      ...(summaries.length === 0 ? ['No Milestones match this report scope.'] : []),
      ...(withoutHistory === 0
        ? []
        : [`${withoutHistory} Milestone(s) have no recorded date history; their current date is shown since creation.`]),
    ],
  }
}

/**
 * Parses a Milestone's timestamps and sorts its changes.
 *
 * @param milestone - Authorized Milestone.
 * @returns The prepared Milestone, or `undefined` when its creation instant is invalid.
 */
function prepareMilestone(milestone: AnalyticsMilestoneHistory): PreparedMilestone | undefined {
  const createdAt = Date.parse(milestone.createdAt)
  if (Number.isNaN(createdAt)) return undefined
  const history = milestone.history.flatMap((change) => {
    const at = Date.parse(change.occurredAt)
    return Number.isNaN(at) ? [] : [{ ...change, at }]
  }).sort((left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId))
  const prepared: PreparedMilestone = { milestone, createdAt, history }
  // An ancestor move changes the scope without an event of the Milestone; place that change at
  // the latest write, which is no earlier than the move, so earlier dates stay hidden.
  const recordedTeamId = latestRecordedValue(history, 'teamId', milestone.teamId)
  const recordedProjectId = latestRecordedValue(history, 'projectId', milestone.projectId)
  if (recordedTeamId !== milestone.teamId || recordedProjectId !== milestone.projectId) {
    const updatedAt = Date.parse(milestone.updatedAt)
    const at = Math.max(Number.isNaN(updatedAt) ? 0 : updatedAt, history.at(-1)?.at ?? 0)
    history.push({
      eventId: '\uffffinferred-scope',
      occurredAt: new Date(at).toISOString(),
      at,
      changes: [
        { field: 'teamId', ...withValue('before', recordedTeamId), ...withValue('after', milestone.teamId) },
        { field: 'projectId', ...withValue('before', recordedProjectId), ...withValue('after', milestone.projectId) },
      ],
    })
  }
  return prepared
}

/**
 * Returns the value a field has after the last recorded change of it.
 *
 * @param history - Sorted changes.
 * @param field - Field to read.
 * @param current - Current value, used when the field was never recorded.
 * @returns The latest recorded value.
 */
function latestRecordedValue(
  history: readonly AnalyticsMilestoneChange[],
  field: AnalyticsMilestoneTrendField,
  current: string | undefined,
) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const fieldChange = history[index]?.changes.find((candidate) => candidate.field === field)
    if (fieldChange) return fieldChange.after
  }
  return current
}

/**
 * Builds an optional `before` / `after` property.
 *
 * @param key - Property name.
 * @param value - Value, or `undefined` for an absent field.
 * @returns The property, or an empty object.
 */
function withValue(key: 'before' | 'after', value: string | undefined) {
  return value === undefined ? {} : { [key]: value }
}

/**
 * Returns a Milestone field's value at an instant.
 *
 * @param entry - Prepared Milestone.
 * @param field - Field to read.
 * @param at - Evaluation epoch milliseconds.
 * @returns The field value, or `undefined` when the field was absent.
 */
function fieldAt(entry: PreparedMilestone, field: AnalyticsMilestoneTrendField, at: number) {
  let earliestLater: AnalyticsMilestoneFieldChange | undefined
  for (let index = entry.history.length - 1; index >= 0; index -= 1) {
    const change = entry.history[index]
    const fieldChange = change?.changes.find((candidate) => candidate.field === field)
    if (!change || !fieldChange) continue
    if (change.at <= at) return fieldChange.after
    earliestLater = fieldChange
  }
  if (earliestLater) return earliestLater.before
  if (field === 'forecast.endDate') return entry.milestone.forecastEndDate
  return field === 'teamId' ? entry.milestone.teamId : entry.milestone.projectId
}

/**
 * Returns whether a Milestone's recorded scope at an instant is its current scope.
 *
 * @param entry - Prepared Milestone.
 * @param at - Evaluation epoch milliseconds.
 * @returns Whether the Team and Project at the instant equal the current ones.
 */
function isInCurrentScope(entry: PreparedMilestone, at: number) {
  return fieldAt(entry, 'teamId', at) === entry.milestone.teamId &&
    fieldAt(entry, 'projectId', at) === entry.milestone.projectId
}

/**
 * Returns a Milestone's forecast end date at an instant as a day number.
 *
 * @param entry - Prepared Milestone.
 * @param at - Evaluation epoch milliseconds.
 * @returns Days since 1970-01-01, or `undefined` when the date is unknown or hidden.
 */
function dateAt(entry: PreparedMilestone, at: number) {
  if (at < entry.createdAt || !isInCurrentScope(entry, at)) return undefined
  const value = fieldAt(entry, 'forecast.endDate', at)
  return value === undefined ? undefined : analyticsDateToEpochDay(value)
}

/**
 * Returns a Milestone's first date that is visible in a range.
 *
 * The date at the range start is used when it is visible; otherwise the date right after the
 * first change in the range that makes it visible, such as a move into the current scope.
 *
 * @param entry - Prepared Milestone.
 * @param from - Range start epoch milliseconds.
 * @param to - Range end epoch milliseconds.
 * @returns Days since 1970-01-01, or `undefined` when no date is visible in the range.
 */
function firstVisibleDate(entry: PreparedMilestone, from: number, to: number) {
  const atStart = dateAt(entry, from)
  if (atStart !== undefined) return atStart
  for (const change of entry.history) {
    if (change.at <= from || change.at > to) continue
    const value = dateAt(entry, change.at)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Builds one chart point.
 *
 * @param bucket - Calendar bucket.
 * @param segments - Milestone dates at the bucket end.
 * @returns The point; its value is the number of Milestones with a date.
 */
function createPoint(
  bucket: AnalyticsMilestoneTrendBucket,
  segments: Array<{ key: string; value: number }>,
): AnalyticsSeriesPoint {
  return {
    from: new Date(bucket.from).toISOString(),
    to: new Date(bucket.to).toISOString(),
    value: segments.length,
    sampleSize: segments.length,
    segments,
  }
}

/**
 * Formats an optional day number as a date.
 *
 * @param epochDay - Days since 1970-01-01.
 * @returns The `YYYY-MM-DD` date, or null.
 */
function toDate(epochDay: number | undefined) {
  return epochDay === undefined ? null : analyticsEpochDayToDate(epochDay) ?? null
}

/**
 * Returns a valid `YYYY-MM-DD` date unchanged.
 *
 * @param value - Candidate date.
 * @returns The date, or `undefined` when it is invalid.
 */
function normalizeDate(value: string) {
  return analyticsDateToEpochDay(value) === undefined ? undefined : value
}
