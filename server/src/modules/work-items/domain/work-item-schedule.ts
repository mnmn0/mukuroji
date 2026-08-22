import {
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MAX_HOLIDAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type WorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
  type WorkItemScheduleChangePreview,
  type WorkItemScheduleOperation,
  type WorkItemScheduleWeekday,
} from '@mukuroji/contracts'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const WEEKDAY_ORDER: readonly WorkItemScheduleWeekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]

/** Stable validation error raised by the Work Item schedule domain. */
export class WorkItemScheduleError extends Error {
  /** HTTP status exposed by a transport adapter. */
  readonly status: number
  /** Stable client-facing error code. */
  readonly code: string

  /**
   * Creates a Work Item schedule error.
   *
   * @param status - HTTP status exposed by a transport adapter.
   * @param code - Stable client-facing error code.
   * @param message - Safe human-readable explanation.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'WorkItemScheduleError'
    this.status = status
    this.code = code
  }
}

/**
 * Strictly validates and canonicalizes an untrusted Work Item schedule.
 *
 * Calendar weekdays are returned in Monday-first order and holidays are returned
 * in ascending ISO-date order. Duplicate entries are collapsed.
 *
 * @param value - Candidate schedule from an untrusted boundary.
 * @returns A detached canonical schedule.
 */
export function normalizeWorkItemSchedule(value: unknown): WorkItemSchedule {
  if (!isRecord(value) || typeof value.mode !== 'string') {
    return invalidSchedule('Schedule must be an object with an explicit mode.')
  }

  const calendarPolicy = normalizeCalendarPolicy(value.calendarPolicy)
  const plannedEffortMinutes = normalizePlannedEffort(value.plannedEffortMinutes)
  const plannedEffort = plannedEffortMinutes === undefined
    ? {}
    : { plannedEffortMinutes }

  if (value.mode === 'unscheduled') {
    requireOnlyKeys(value, ['mode', 'calendarPolicy', 'plannedEffortMinutes'])
    return {
      mode: 'unscheduled',
      calendarPolicy,
      ...plannedEffort,
    }
  }

  if (value.mode === 'due-date') {
    requireOnlyKeys(value, [
      'mode',
      'calendarPolicy',
      'plannedEffortMinutes',
      'dueDate',
    ])
    return {
      mode: 'due-date',
      calendarPolicy,
      dueDate: normalizeIsoDate(value.dueDate),
      ...plannedEffort,
    }
  }

  if (value.mode === 'date-range') {
    requireOnlyKeys(value, [
      'mode',
      'calendarPolicy',
      'plannedEffortMinutes',
      'startDate',
      'endDate',
      'durationDays',
    ])
    const startDate = normalizeIsoDate(value.startDate)
    const endDate = normalizeIsoDate(value.endDate)
    const durationDays = normalizePositiveDuration(value.durationDays)
    const calculatedDurationDays = calculateWorkItemScheduleDurationDays(
      startDate,
      endDate,
      calendarPolicy,
    )
    if (calculatedDurationDays === 0) {
      return invalidDuration(
        'A date-range schedule must contain at least one working date.',
      )
    }
    if (durationDays !== calculatedDurationDays) {
      throw new WorkItemScheduleError(
        400,
        'WorkItemScheduleDurationMismatch',
        'Date-range duration must equal its inclusive working-date count.',
      )
    }
    return {
      mode: 'date-range',
      calendarPolicy,
      startDate,
      endDate,
      durationDays,
      ...plannedEffort,
    }
  }

  if (value.mode === 'milestone') {
    requireOnlyKeys(value, [
      'mode',
      'calendarPolicy',
      'plannedEffortMinutes',
      'startDate',
      'endDate',
      'durationDays',
    ])
    const startDate = normalizeIsoDate(value.startDate)
    const endDate = normalizeIsoDate(value.endDate)
    if (startDate !== endDate || value.durationDays !== 0) {
      return invalidSchedule(
        'A milestone must use one date for both endpoints and have zero duration.',
      )
    }
    return {
      mode: 'milestone',
      calendarPolicy,
      startDate,
      endDate,
      durationDays: 0,
      ...plannedEffort,
    }
  }

  return invalidSchedule('Schedule mode is not supported.')
}

/**
 * Checks whether an unknown value is a canonicalizable Work Item schedule.
 *
 * @param value - Candidate schedule.
 * @returns True when strict schedule normalization succeeds.
 */
export function isWorkItemSchedule(value: unknown): value is WorkItemSchedule {
  try {
    normalizeWorkItemSchedule(value)
    return true
  } catch {
    return false
  }
}

/**
 * Checks whether a schedule is already stored in its exact canonical representation.
 *
 * Unlike {@link isWorkItemSchedule}, this predicate rejects values that normalization would
 * rewrite, including timezone aliases and duplicate or out-of-order calendar entries.
 *
 * @param value - Candidate persisted schedule.
 * @returns True only when the value exactly matches its normalized representation.
 */
export function isCanonicalWorkItemSchedule(value: unknown): value is WorkItemSchedule {
  if (!isRecord(value)) {
    return false
  }

  try {
    const normalized = normalizeWorkItemSchedule(value)
    if (
      value.mode !== normalized.mode ||
      !isCanonicalCalendarPolicy(value.calendarPolicy, normalized.calendarPolicy) ||
      !hasCanonicalPlannedEffort(value, normalized)
    ) {
      return false
    }

    switch (normalized.mode) {
      case 'unscheduled':
        return true
      case 'due-date':
        return value.dueDate === normalized.dueDate
      case 'date-range':
      case 'milestone':
        return value.startDate === normalized.startDate &&
          value.endDate === normalized.endDate &&
          value.durationDays === normalized.durationDays
    }
  } catch {
    return false
  }
}

/**
 * Compares a persisted calendar policy with its normalized counterpart.
 *
 * @param value - Candidate policy from storage.
 * @param normalized - Canonical policy derived from the candidate.
 * @returns Whether timezone and ordered calendar collections are already canonical.
 */
function isCanonicalCalendarPolicy(
  value: unknown,
  normalized: WorkItemScheduleCalendarPolicy,
): boolean {
  return isRecord(value) &&
    value.timeZone === normalized.timeZone &&
    hasExactStringEntries(value.workingWeekdays, normalized.workingWeekdays) &&
    hasExactStringEntries(value.holidays, normalized.holidays)
}

/**
 * Compares an unknown string collection without rewriting order or duplicates.
 *
 * @param value - Candidate array from storage.
 * @param expected - Canonical ordered values.
 * @returns Whether both arrays contain identical values in identical order.
 */
function hasExactStringEntries(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
}

/**
 * Requires optional effort to have the same value and field presence as canonical output.
 *
 * @param value - Candidate schedule record.
 * @param normalized - Canonical schedule derived from the candidate.
 * @returns Whether optional effort is represented canonically.
 */
function hasCanonicalPlannedEffort(
  value: Record<string, unknown>,
  normalized: WorkItemSchedule,
): boolean {
  const hasNormalizedEffort = normalized.plannedEffortMinutes !== undefined
  return Object.hasOwn(value, 'plannedEffortMinutes') === hasNormalizedEffort &&
    value.plannedEffortMinutes === normalized.plannedEffortMinutes
}

/**
 * Derives the deadline projection from a canonical schedule.
 *
 * @param schedule - Schedule to project.
 * @returns An empty string for an unscheduled item, otherwise its deadline or end date.
 */
export function deriveWorkItemScheduleDueDate(schedule: WorkItemSchedule): string {
  const normalized = normalizeWorkItemSchedule(schedule)
  return readWorkItemSchedulePrimaryDate(normalized) ?? ''
}

/**
 * Applies one validated schedule operation without mutating the input schedule.
 *
 * @param schedule - Current canonical schedule.
 * @param operation - Replacement, move, or resize operation.
 * @returns The canonical schedule after the operation.
 */
export function applyWorkItemScheduleOperation(
  schedule: WorkItemSchedule,
  operation: WorkItemScheduleOperation,
): WorkItemSchedule {
  const current = normalizeWorkItemSchedule(schedule)
  const normalizedOperation = normalizeWorkItemScheduleOperation(operation)

  if (normalizedOperation.type === 'replace') {
    return normalizedOperation.schedule
  }

  if (normalizedOperation.type === 'resize') {
    if (current.mode !== 'date-range') {
      return invalidOperation('Only a date-range schedule can be resized.')
    }
    const durationDays = calculateWorkItemScheduleDurationDays(
      current.startDate,
      normalizedOperation.endDate,
      current.calendarPolicy,
    )
    if (durationDays === 0) {
      return invalidDuration(
        'A resized date range must contain at least one working date.',
      )
    }
    return {
      ...current,
      endDate: normalizedOperation.endDate,
      durationDays,
    }
  }

  if (current.mode === 'unscheduled') {
    return invalidOperation('An unscheduled item cannot be moved.')
  }
  if (current.mode === 'due-date') {
    return {
      ...current,
      dueDate: normalizedOperation.targetDate,
    }
  }
  if (current.mode === 'milestone') {
    return {
      ...current,
      startDate: normalizedOperation.targetDate,
      endDate: normalizedOperation.targetDate,
    }
  }

  return {
    ...current,
    startDate: normalizedOperation.targetDate,
    endDate: calculateWorkItemScheduleEndDate(
      normalizedOperation.targetDate,
      current.durationDays,
      current.calendarPolicy,
    ),
  }
}

/**
 * Builds the direct self-impact preview for one schedule operation.
 *
 * Dependency propagation can append impacts and warnings after this domain preview.
 *
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @param expectedRevision - Revision observed before previewing the operation.
 * @param before - Schedule before the operation.
 * @param operation - Operation to preview.
 * @returns A preview containing the target impact and no dependency warnings.
 */
export function previewWorkItemScheduleChange(
  teamId: string,
  workItemId: string,
  expectedRevision: number,
  before: WorkItemSchedule,
  operation: WorkItemScheduleOperation,
): WorkItemScheduleChangePreview {
  const normalizedTeamId = normalizePreviewIdentifier(teamId, 'Team ID')
  const normalizedWorkItemId = normalizePreviewIdentifier(workItemId, 'Work Item ID')
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemSchedulePreview',
      'Expected revision must be a positive integer.',
    )
  }
  const normalizedBefore = normalizeWorkItemSchedule(before)
  const after = applyWorkItemScheduleOperation(normalizedBefore, operation)
  return {
    expectedRevision,
    impacts: [{
      teamId: normalizedTeamId,
      workItemId: normalizedWorkItemId,
      kind: 'direct',
      expectedRevision,
      before: normalizedBefore,
      after,
      dateDeltaDays: calculateWorkItemScheduleDateDeltaDays(normalizedBefore, after),
    }],
    evaluatedRevisions: [{
      teamId: normalizedTeamId,
      workItemId: normalizedWorkItemId,
      expectedRevision,
    }],
    conflicts: [],
    affectedProjects: [],
    affectedMilestoneIds: [],
    requiresConfirmation: false,
    warnings: [],
  }
}

/**
 * Calculates the signed calendar-day movement of a schedule's primary date.
 *
 * Date ranges and milestones use their end date, while due-date schedules use
 * their due date. This matches the canonical deadline projection used by task
 * surfaces. A transition to or from an unscheduled value has no comparable date
 * and therefore reports zero.
 *
 * @param before - Canonical schedule before a proposed change.
 * @param after - Canonical schedule after a proposed change.
 * @returns Signed calendar days from the before primary date to the after date.
 */
export function calculateWorkItemScheduleDateDeltaDays(
  before: WorkItemSchedule,
  after: WorkItemSchedule,
): number {
  const beforeDate = readWorkItemSchedulePrimaryDate(normalizeWorkItemSchedule(before))
  const afterDate = readWorkItemSchedulePrimaryDate(normalizeWorkItemSchedule(after))
  if (!beforeDate || !afterDate) return 0
  return parseIsoDate(afterDate).epochDay - parseIsoDate(beforeDate).epochDay
}

/**
 * Reads the date used to summarize movement for one canonical schedule.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns The primary local date, or undefined for an unscheduled item.
 */
function readWorkItemSchedulePrimaryDate(
  schedule: WorkItemSchedule,
): string | undefined {
  if (schedule.mode === 'unscheduled') return undefined
  if (schedule.mode === 'due-date') return schedule.dueDate
  return schedule.endDate
}

/**
 * Counts working dates in one inclusive local-date range.
 *
 * @param startDate - Inclusive local start date in `YYYY-MM-DD` form.
 * @param endDate - Inclusive local end date in `YYYY-MM-DD` form.
 * @param policy - Calendar policy defining working weekdays and holidays.
 * @returns The inclusive number of working dates.
 */
export function calculateWorkItemScheduleDurationDays(
  startDate: string,
  endDate: string,
  policy: WorkItemScheduleCalendarPolicy,
): number {
  const start = parseIsoDate(startDate)
  const end = parseIsoDate(endDate)
  if (end.epochDay < start.epochDay) {
    return invalidRange('Schedule end date cannot be before its start date.')
  }
  if (end.epochDay - start.epochDay + 1 > WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS) {
    return invalidRange('Schedule date range exceeds the supported planning horizon.')
  }
  const normalizedPolicy = normalizeCalendarPolicy(policy)
  const workingWeekdays = new Set(normalizedPolicy.workingWeekdays)
  const holidays = new Set(normalizedPolicy.holidays)
  let durationDays = 0
  for (let epochDay = start.epochDay; epochDay <= end.epochDay; epochDay += 1) {
    const date = formatEpochDay(epochDay)
    if (
      workingWeekdays.has(weekdayForEpochDay(epochDay)) &&
      !holidays.has(date)
    ) {
      durationDays += 1
    }
  }
  return durationDays
}

/**
 * Resolves an inclusive range end while preserving a positive working-day duration.
 *
 * @param startDate - Inclusive local range start in `YYYY-MM-DD` form.
 * @param durationDays - Positive number of working dates to occupy.
 * @param policy - Calendar policy defining working weekdays and holidays.
 * @returns The local date containing the final counted working date.
 */
export function calculateWorkItemScheduleEndDate(
  startDate: string,
  durationDays: number,
  policy: WorkItemScheduleCalendarPolicy,
): string {
  const start = parseIsoDate(startDate)
  const normalizedDurationDays = normalizePositiveDuration(durationDays)
  const normalizedPolicy = normalizeCalendarPolicy(policy)
  const workingWeekdays = new Set(normalizedPolicy.workingWeekdays)
  const holidays = new Set(normalizedPolicy.holidays)
  let remainingDays = normalizedDurationDays

  for (
    let epochDay = start.epochDay;
    epochDay - start.epochDay < WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS;
    epochDay += 1
  ) {
    const date = formatEpochDay(epochDay)
    if (
      workingWeekdays.has(weekdayForEpochDay(epochDay)) &&
      !holidays.has(date)
    ) {
      remainingDays -= 1
      if (remainingDays === 0) {
        return date
      }
    }
  }

  return invalidRange('Schedule duration exceeds the supported ISO date range.')
}

/**
 * Resolves an inclusive range start while preserving a positive working-day duration.
 *
 * @param endDate - Inclusive local range end in `YYYY-MM-DD` form.
 * @param durationDays - Positive number of working dates to occupy.
 * @param policy - Calendar policy defining working weekdays and holidays.
 * @returns The local date containing the first counted working date.
 */
export function calculateWorkItemScheduleStartDate(
  endDate: string,
  durationDays: number,
  policy: WorkItemScheduleCalendarPolicy,
): string {
  const end = parseIsoDate(endDate)
  const normalizedDurationDays = normalizePositiveDuration(durationDays)
  const normalizedPolicy = normalizeCalendarPolicy(policy)
  const workingWeekdays = new Set(normalizedPolicy.workingWeekdays)
  const holidays = new Set(normalizedPolicy.holidays)
  let remainingDays = normalizedDurationDays

  for (
    let epochDay = end.epochDay;
    end.epochDay - epochDay < WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS;
    epochDay -= 1
  ) {
    const date = formatEpochDay(epochDay)
    if (
      workingWeekdays.has(weekdayForEpochDay(epochDay)) &&
      !holidays.has(date)
    ) {
      remainingDays -= 1
      if (remainingDays === 0) {
        return date
      }
    }
  }

  return invalidRange('Schedule duration exceeds the supported ISO date range.')
}

/**
 * Maps an absolute instant to an ISO local date under a schedule policy timezone.
 *
 * @param instant - Date object, epoch milliseconds, or timestamp with an explicit offset.
 * @param policy - Calendar policy whose IANA timezone selects the local date.
 * @returns The local `YYYY-MM-DD` date containing the instant.
 */
export function workItemScheduleInstantToLocalDate(
  instant: Date | number | string,
  policy: WorkItemScheduleCalendarPolicy,
): string {
  const normalizedPolicy = normalizeCalendarPolicy(policy)
  const date = normalizeInstant(instant)
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone: normalizedPolicy.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = formatter.formatToParts(date)
  const year = findDateTimePart(parts, 'year')
  const month = findDateTimePart(parts, 'month')
  const day = findDateTimePart(parts, 'day')
  return normalizeIsoDate(`${year.padStart(4, '0')}-${month}-${day}`)
}

/**
 * Adds whole Gregorian calendar days without applying timezone or DST offsets.
 *
 * @param date - Local date in `YYYY-MM-DD` form.
 * @param days - Signed number of calendar days to add.
 * @returns The shifted local ISO date.
 */
export function addWorkItemScheduleCalendarDays(date: string, days: number): string {
  const parsed = parseIsoDate(date)
  if (!Number.isSafeInteger(days)) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleDate',
      'Calendar-day offset must be a safe integer.',
    )
  }
  return formatEpochDay(parsed.epochDay + days)
}

/**
 * Canonicalizes a schedule calendar policy from an untrusted value.
 *
 * @param value - Candidate calendar policy.
 * @returns A detached canonical policy.
 */
function normalizeCalendarPolicy(value: unknown): WorkItemScheduleCalendarPolicy {
  if (!isRecord(value)) {
    return invalidCalendarPolicy('Calendar policy must be an object.')
  }
  if (!hasOnlyKeys(value, ['timeZone', 'workingWeekdays', 'holidays'])) {
    return invalidCalendarPolicy('Calendar policy contains unsupported fields.')
  }
  const timeZone = normalizeTimeZone(value.timeZone)
  if (!Array.isArray(value.workingWeekdays)) {
    return invalidCalendarPolicy('Working weekdays must be an array.')
  }
  if (value.workingWeekdays.length > WEEKDAY_ORDER.length) {
    return invalidCalendarPolicy('Working weekdays cannot contain more than seven entries.')
  }
  const weekdaySet = new Set<WorkItemScheduleWeekday>()
  for (const weekday of value.workingWeekdays) {
    if (!isWorkItemScheduleWeekday(weekday)) {
      return invalidCalendarPolicy('Working weekdays contain an unsupported value.')
    }
    weekdaySet.add(weekday)
  }
  if (weekdaySet.size === 0) {
    return invalidCalendarPolicy('Calendar policy must contain a working weekday.')
  }
  if (!Array.isArray(value.holidays)) {
    return invalidCalendarPolicy('Holidays must be an array.')
  }
  if (value.holidays.length > WORK_ITEM_SCHEDULE_MAX_HOLIDAYS) {
    return invalidCalendarPolicy(
      `Calendar policy cannot contain more than ${WORK_ITEM_SCHEDULE_MAX_HOLIDAYS} holidays.`,
    )
  }
  const holidaySet = new Set<string>()
  for (const holiday of value.holidays) {
    holidaySet.add(normalizeIsoDate(holiday))
  }
  return {
    timeZone,
    workingWeekdays: WEEKDAY_ORDER.filter((weekday) => weekdaySet.has(weekday)),
    holidays: [...holidaySet].sort(),
  }
}

/**
 * Validates and canonicalizes an IANA timezone identifier.
 *
 * @param value - Candidate timezone.
 * @returns The runtime's canonical IANA identifier.
 */
function normalizeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return invalidTimeZone('Schedule timezone must be an IANA identifier.')
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions()
      .timeZone
  } catch {
    return invalidTimeZone('Schedule timezone must be an IANA identifier.')
  }
}

/**
 * Validates optional planned effort.
 *
 * @param value - Candidate effort in minutes.
 * @returns The validated effort or undefined when omitted.
 */
function normalizePlannedEffort(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleEffort',
      'Planned effort minutes must be a nonnegative integer.',
    )
  }
  return value
}

/**
 * Validates one positive working-day duration.
 *
 * @param value - Candidate duration.
 * @returns The validated duration.
 */
function normalizePositiveDuration(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS
  ) {
    return invalidDuration('Date-range duration must be a positive integer.')
  }
  return value
}

/**
 * Validates and canonicalizes one schedule operation.
 *
 * @param value - Candidate schedule operation.
 * @returns A detached validated operation.
 */
export function normalizeWorkItemScheduleOperation(
  value: unknown,
): WorkItemScheduleOperation {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return invalidOperation('Schedule operation must be an object with a type.')
  }
  if (value.type === 'replace') {
    if (!hasOnlyKeys(value, ['type', 'schedule'])) {
      return invalidOperation('Replace operation contains unsupported fields.')
    }
    return {
      type: 'replace',
      schedule: normalizeWorkItemSchedule(value.schedule),
    }
  }
  if (value.type === 'move') {
    if (!hasOnlyKeys(value, ['type', 'targetDate'])) {
      return invalidOperation('Move operation contains unsupported fields.')
    }
    return {
      type: 'move',
      targetDate: normalizeIsoDate(value.targetDate),
    }
  }
  if (value.type === 'resize') {
    if (!hasOnlyKeys(value, ['type', 'endDate'])) {
      return invalidOperation('Resize operation contains unsupported fields.')
    }
    return {
      type: 'resize',
      endDate: normalizeIsoDate(value.endDate),
    }
  }
  return invalidOperation('Schedule operation type is not supported.')
}

/**
 * Validates one preview identifier without rewriting its storage identity.
 *
 * @param value - Candidate identifier.
 * @param label - Human-readable identifier kind.
 * @returns The unchanged validated identifier.
 */
function normalizePreviewIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemSchedulePreview',
      `${label} must be a non-empty string.`,
    )
  }
  return value
}

/**
 * Parses a strict real Gregorian ISO date.
 *
 * @param value - Candidate `YYYY-MM-DD` date.
 * @returns Numeric date fields and the corresponding UTC epoch day.
 */
function parseIsoDate(value: unknown) {
  if (typeof value !== 'string') {
    return invalidDate('Schedule date must use YYYY-MM-DD form.')
  }
  const match = ISO_DATE_PATTERN.exec(value)
  const yearText = match?.[1]
  const monthText = match?.[2]
  const dayText = match?.[3]
  if (!yearText || !monthText || !dayText) {
    return invalidDate('Schedule date must use YYYY-MM-DD form.')
  }
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  if (
    year < WORK_ITEM_SCHEDULE_MIN_YEAR ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return invalidDate('Schedule date must be a real Gregorian date.')
  }
  return {
    year,
    month,
    day,
    epochDay: date.getTime() / MILLISECONDS_PER_DAY,
  }
}

/**
 * Returns a strict ISO date after validating it.
 *
 * @param value - Candidate date.
 * @returns The unchanged canonical date.
 */
function normalizeIsoDate(value: unknown): string {
  const parsed = parseIsoDate(value)
  return [
    String(parsed.year).padStart(4, '0'),
    String(parsed.month).padStart(2, '0'),
    String(parsed.day).padStart(2, '0'),
  ].join('-')
}

/**
 * Formats one UTC epoch day as a supported four-digit ISO date.
 *
 * @param epochDay - Whole days since the Unix epoch.
 * @returns The corresponding `YYYY-MM-DD` date.
 */
function formatEpochDay(epochDay: number): string {
  if (!Number.isSafeInteger(epochDay)) {
    return invalidDate('Schedule date is outside the supported ISO range.')
  }
  const date = new Date(epochDay * MILLISECONDS_PER_DAY)
  const year = date.getUTCFullYear()
  if (
    !Number.isFinite(date.getTime()) ||
    year < WORK_ITEM_SCHEDULE_MIN_YEAR ||
    year > 9_999
  ) {
    return invalidDate('Schedule date is outside the supported ISO range.')
  }
  return [
    String(year).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * Resolves the schedule weekday for one UTC epoch day.
 *
 * @param epochDay - Whole days since the Unix epoch.
 * @returns The corresponding lowercase weekday name.
 */
function weekdayForEpochDay(epochDay: number): WorkItemScheduleWeekday {
  const weekday = new Date(epochDay * MILLISECONDS_PER_DAY).getUTCDay()
  if (weekday === 0) return 'sunday'
  if (weekday === 1) return 'monday'
  if (weekday === 2) return 'tuesday'
  if (weekday === 3) return 'wednesday'
  if (weekday === 4) return 'thursday'
  if (weekday === 5) return 'friday'
  return 'saturday'
}

/**
 * Parses an absolute instant and rejects offset-free local timestamps.
 *
 * @param instant - Candidate instant.
 * @returns A detached valid Date object.
 */
function normalizeInstant(instant: Date | number | string): Date {
  if (
    typeof instant === 'string' &&
    !/(?:Z|[+-]\d{2}:\d{2})$/u.test(instant)
  ) {
    return invalidInstant('Schedule instant must include an explicit UTC offset.')
  }
  const date = instant instanceof Date
    ? new Date(instant.getTime())
    : new Date(instant)
  if (!Number.isFinite(date.getTime())) {
    return invalidInstant('Schedule instant must be a valid timestamp.')
  }
  return date
}

/**
 * Reads one date-time format part from an Intl result.
 *
 * @param parts - Parts produced by an ISO-calendar formatter.
 * @param type - Required part kind.
 * @returns The formatter's value for the part.
 */
function findDateTimePart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: 'year' | 'month' | 'day',
): string {
  const part = parts.find((candidate) => candidate.type === type)
  if (!part) {
    return invalidInstant('Schedule instant could not be mapped to a local date.')
  }
  return part.value
}

/**
 * Checks a supported Work Item schedule weekday literal.
 *
 * @param value - Candidate weekday.
 * @returns True for one of the seven contract literals.
 */
function isWorkItemScheduleWeekday(value: unknown): value is WorkItemScheduleWeekday {
  return value === 'monday' ||
    value === 'tuesday' ||
    value === 'wednesday' ||
    value === 'thursday' ||
    value === 'friday' ||
    value === 'saturday' ||
    value === 'sunday'
}

/**
 * Checks a non-array object with string keys.
 *
 * @param value - Candidate value.
 * @returns True when property access is safe at the record level.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks that a record has no unsupported enumerable string fields.
 *
 * @param value - Record to inspect.
 * @param allowedKeys - Complete allowed field list.
 * @returns True when every own enumerable string field is allowed.
 */
function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

/**
 * Rejects unsupported schedule fields.
 *
 * @param value - Schedule record to inspect.
 * @param allowedKeys - Complete allowed field list for its mode.
 */
function requireOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  if (!hasOnlyKeys(value, allowedKeys)) {
    invalidSchedule('Schedule contains fields that are invalid for its mode.')
  }
}

/**
 * Raises a generic schedule validation error.
 *
 * @param message - Safe error message.
 * @returns Never returns.
 */
function invalidSchedule(message: string): never {
  throw new WorkItemScheduleError(400, 'InvalidWorkItemSchedule', message)
}

/**
 * Raises a calendar policy validation error.
 *
 * @param message - Safe error message.
 * @returns Never returns.
 */
function invalidCalendarPolicy(message: string): never {
  throw new WorkItemScheduleError(400, 'InvalidWorkItemScheduleCalendarPolicy', message)
}

/**
 * Raises a timezone validation error.
 *
 * @param message - Safe error message.
 * @returns Never returns.
 */
function invalidTimeZone(message: string): never {
  throw new WorkItemScheduleError(400, 'InvalidWorkItemScheduleTimeZone', message)
}

/**
 * Raises an ISO date validation error.
 *
 * @param message - Safe error message.
 * @returns Never returns.
 */
function invalidDate(message: string): never {
  throw new WorkItemScheduleError(400, 'InvalidWorkItemScheduleDate', message)
}

/**
 * Raises a date-range validation error.
 *
 * @param message - Safe error message.
 * @returns Never returns.
 */
function invalidRange(message: string): never {
  throw new WorkItemScheduleError(400, 'InvalidWorkItemScheduleRange', message)
}

/**
 * Raises a working-duration validation error.
 *
 * @param message - Safe error message.
 * @returns Never returns.
 */
function invalidDuration(message: string): never {
  throw new WorkItemScheduleError(400, 'InvalidWorkItemScheduleDuration', message)
}

/**
 * Raises a schedule operation validation error.
 *
 * @param message - Safe error message.
 * @returns Never returns.
 */
function invalidOperation(message: string): never {
  throw new WorkItemScheduleError(400, 'InvalidWorkItemScheduleOperation', message)
}

/**
 * Raises an instant validation error.
 *
 * @param message - Safe error message.
 * @returns Never returns.
 */
function invalidInstant(message: string): never {
  throw new WorkItemScheduleError(400, 'InvalidWorkItemScheduleInstant', message)
}
