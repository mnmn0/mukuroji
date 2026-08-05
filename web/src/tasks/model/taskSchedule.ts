import {
  DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  deriveWorkItemScheduleDueDate,
  type DateRangeWorkItemSchedule,
  type DueDateWorkItemSchedule,
  type MilestoneWorkItemSchedule,
  type UnscheduledWorkItemSchedule,
  type WorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
  type WorkItemScheduleOperation,
  type WorkItemScheduleWeekday,
} from '@mukuroji/contracts'

const MILLISECONDS_PER_CALENDAR_DAY = 24 * 60 * 60 * 1_000

const taskScheduleWeekdays: readonly WorkItemScheduleWeekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

/** A source that always carries the canonical Work Item schedule. */
export type TaskScheduleSource = {
  /** Canonical schedule shared by every planning surface. */
  schedule: WorkItemSchedule
}

/** Locale-neutral schedule data from which a view can build its own translated label. */
export type TaskScheduleSummary = {
  /** Explicit schedule state; consumers must not infer it from the presence of dates. */
  mode: WorkItemSchedule['mode']
  /** Deadline supplied only for a deadline-only schedule. */
  dueDate?: string
  /** Inclusive start supplied only for a date range or milestone. */
  startDate?: string
  /** Inclusive end supplied only for a date range or milestone. */
  endDate?: string
  /** Working-day duration supplied only for a date range or milestone. */
  durationDays?: number
  /** Optional planned effort, independent from the schedule duration. */
  plannedEffortMinutes?: number
}

/** Inclusive UTC calendar-date boundaries rendered by a task timeline. */
export type TaskTimelineDateRange = {
  /** First local date shown by the timeline. */
  startDate: string
  /** Last local date shown by the timeline. */
  endDate: string
}

/** Localized-message keys for every explicit schedule mode. */
export const taskScheduleModeLabelKeys = {
  'date-range': 'tasks.schedule.dateRange',
  'due-date': 'tasks.schedule.dueDate',
  milestone: 'tasks.schedule.milestone',
  unscheduled: 'tasks.schedule.unscheduled',
} as const

/**
 * Creates an independent copy of the default UTC Monday-to-Friday policy.
 *
 * @returns A mutable policy copy that cannot mutate the shared contract constant.
 */
export function createDefaultTaskScheduleCalendarPolicy(): WorkItemScheduleCalendarPolicy {
  return {
    holidays: [...DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.holidays],
    timeZone: DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.timeZone,
    workingWeekdays: [...DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY.workingWeekdays],
  }
}

/**
 * Creates an explicitly unscheduled task using the default calendar policy.
 *
 * @param plannedEffortMinutes - Optional effort estimate independent from calendar placement.
 * @returns A new unscheduled Work Item schedule.
 */
export function createDefaultUnscheduledTaskSchedule(
  plannedEffortMinutes?: number,
): UnscheduledWorkItemSchedule {
  return {
    calendarPolicy: createDefaultTaskScheduleCalendarPolicy(),
    mode: 'unscheduled',
    ...createPlannedEffortFields(plannedEffortMinutes),
  }
}

/**
 * Creates a deadline-only task without inferring a start date or duration.
 *
 * @param dueDate - Deadline in `YYYY-MM-DD` form.
 * @param plannedEffortMinutes - Optional effort estimate independent from calendar placement.
 * @returns A new deadline-only Work Item schedule.
 */
export function createDefaultDueDateTaskSchedule(
  dueDate: string,
  plannedEffortMinutes?: number,
): DueDateWorkItemSchedule {
  return {
    calendarPolicy: createDefaultTaskScheduleCalendarPolicy(),
    dueDate: requireTaskScheduleDate(normalizeTaskScheduleDate(dueDate)),
    mode: 'due-date',
    ...createPlannedEffortFields(plannedEffortMinutes),
  }
}

/**
 * Creates an inclusive date-range task under the UTC Monday-to-Friday draft policy.
 *
 * The returned duration is only a client draft. Custom timezone and holiday rules remain a
 * server-side preview and validation responsibility.
 *
 * @param startDate - Inclusive range start in `YYYY-MM-DD` form.
 * @param endDate - Inclusive range end in `YYYY-MM-DD` form.
 * @param plannedEffortMinutes - Optional effort estimate independent from calendar duration.
 * @returns A new date-range Work Item schedule with an inclusive draft duration.
 */
export function createDefaultDateRangeTaskSchedule(
  startDate: string,
  endDate: string,
  plannedEffortMinutes?: number,
): DateRangeWorkItemSchedule {
  const normalizedStartDate = requireTaskScheduleDate(normalizeTaskScheduleDate(startDate))
  const normalizedEndDate = requireTaskScheduleDate(normalizeTaskScheduleDate(endDate))

  return {
    calendarPolicy: createDefaultTaskScheduleCalendarPolicy(),
    durationDays: countTaskScheduleWorkingDays(normalizedStartDate, normalizedEndDate),
    endDate: normalizedEndDate,
    mode: 'date-range',
    ...createPlannedEffortFields(plannedEffortMinutes),
    startDate: normalizedStartDate,
  }
}

/**
 * Creates a zero-duration milestone under the default calendar policy.
 *
 * @param date - Milestone date in `YYYY-MM-DD` form.
 * @param plannedEffortMinutes - Optional effort estimate independent from calendar duration.
 * @returns A new milestone Work Item schedule.
 */
export function createDefaultMilestoneTaskSchedule(
  date: string,
  plannedEffortMinutes?: number,
): MilestoneWorkItemSchedule {
  const normalizedDate = requireTaskScheduleDate(normalizeTaskScheduleDate(date))

  return {
    calendarPolicy: createDefaultTaskScheduleCalendarPolicy(),
    durationDays: 0,
    endDate: normalizedDate,
    mode: 'milestone',
    ...createPlannedEffortFields(plannedEffortMinutes),
    startDate: normalizedDate,
  }
}

/**
 * Resolves the canonical schedule carried by a Work Item.
 *
 * @param source - Work Item carrying a canonical schedule.
 * @returns The canonical schedule without inferring state from another field.
 */
export function resolveTaskSchedule(source: TaskScheduleSource): WorkItemSchedule {
  return source.schedule
}

/**
 * Compares two canonical schedules by value without depending on object key order.
 *
 * @param first - First canonical schedule.
 * @param second - Second canonical schedule.
 * @returns Whether mode, dates, duration, effort, and calendar policy are identical.
 */
export function areTaskSchedulesEqual(
  first: WorkItemSchedule,
  second: WorkItemSchedule,
): boolean {
  if (
    first.mode !== second.mode ||
    first.plannedEffortMinutes !== second.plannedEffortMinutes ||
    first.calendarPolicy.timeZone !== second.calendarPolicy.timeZone ||
    !haveEqualStringEntries(
      first.calendarPolicy.workingWeekdays,
      second.calendarPolicy.workingWeekdays,
    ) ||
    !haveEqualStringEntries(first.calendarPolicy.holidays, second.calendarPolicy.holidays)
  ) {
    return false
  }

  switch (first.mode) {
    case 'unscheduled':
      return second.mode === 'unscheduled'
    case 'due-date':
      return second.mode === 'due-date' && first.dueDate === second.dueDate
    case 'date-range':
      return second.mode === 'date-range' &&
        first.startDate === second.startDate &&
        first.endDate === second.endDate &&
        first.durationDays === second.durationDays
    case 'milestone':
      return second.mode === 'milestone' &&
        first.startDate === second.startDate &&
        first.endDate === second.endDate
  }
}

/**
 * Compares ordered string collections by value.
 *
 * @param first - First ordered collection.
 * @param second - Second ordered collection.
 * @returns Whether both collections contain the same entries in the same order.
 */
function haveEqualStringEntries(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return first.length === second.length &&
    first.every((entry, index) => entry === second[index])
}

/**
 * Selects the explicit schedule state without deriving it from date fields.
 *
 * @param source - Task schedule source to resolve.
 * @returns The canonical schedule mode.
 */
export function resolveTaskScheduleMode(source: TaskScheduleSource): WorkItemSchedule['mode'] {
  return resolveTaskSchedule(source).mode
}

/**
 * Selects an explicit start date without inventing one for a deadline-only task.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns The range or milestone start date, or undefined for other modes.
 */
export function resolveTaskScheduleStartDate(schedule: WorkItemSchedule): string | undefined {
  switch (schedule.mode) {
    case 'date-range':
    case 'milestone':
      return schedule.startDate
    case 'due-date':
    case 'unscheduled':
      return undefined
  }
}

/**
 * Selects the final scheduled date without inventing a date for an unscheduled task.
 *
 * A deadline is the final date for deadline-oriented sorting and rendering, but it remains a
 * distinct deadline-only state because {@link resolveTaskScheduleStartDate} returns undefined.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns The deadline or inclusive range end, or undefined when unscheduled.
 */
export function resolveTaskScheduleEndDate(schedule: WorkItemSchedule): string | undefined {
  switch (schedule.mode) {
    case 'due-date':
      return schedule.dueDate
    case 'date-range':
    case 'milestone':
      return schedule.endDate
    case 'unscheduled':
      return undefined
  }
}

/**
 * Selects the date used to anchor a task on Calendar or Gantt surfaces.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns A range or milestone start, a deadline, or undefined when unscheduled.
 */
export function resolveTaskSchedulePrimaryDate(schedule: WorkItemSchedule): string | undefined {
  return resolveTaskScheduleStartDate(schedule) ?? resolveTaskScheduleEndDate(schedule)
}

/**
 * Creates locale-neutral schedule data while retaining the explicit schedule mode.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns Structural dates, duration, and effort for view-specific localization.
 */
export function resolveTaskScheduleSummary(schedule: WorkItemSchedule): TaskScheduleSummary {
  const plannedEffort = createPlannedEffortFields(schedule.plannedEffortMinutes)

  switch (schedule.mode) {
    case 'unscheduled':
      return {
        mode: schedule.mode,
        ...plannedEffort,
      }
    case 'due-date':
      return {
        dueDate: schedule.dueDate,
        mode: schedule.mode,
        ...plannedEffort,
      }
    case 'date-range':
    case 'milestone':
      return {
        durationDays: schedule.durationDays,
        endDate: schedule.endDate,
        mode: schedule.mode,
        ...plannedEffort,
        startDate: schedule.startDate,
      }
  }
}

/**
 * Formats only schedule dates, leaving state labels and locale-specific prose to the caller.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns One ISO date, an inclusive ISO date range, or undefined when unscheduled.
 */
export function formatTaskScheduleRange(schedule: WorkItemSchedule): string | undefined {
  switch (schedule.mode) {
    case 'unscheduled':
      return undefined
    case 'due-date':
      return schedule.dueDate
    case 'milestone':
      return schedule.startDate
    case 'date-range':
      return schedule.startDate === schedule.endDate
        ? schedule.startDate
        : `${schedule.startDate} – ${schedule.endDate}`
  }
}

/**
 * Derives the ISO deadline projection used by deadline-oriented views and indexes.
 *
 * Date ranges and milestones project their inclusive end. An explicit unscheduled state projects
 * an empty string without inferring placement.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns A `YYYY-MM-DD` deadline, or an empty string when unscheduled.
 */
export function deriveTaskScheduleDueDate(schedule: WorkItemSchedule): string {
  return deriveWorkItemScheduleDueDate(schedule)
}

/**
 * Counts UTC Monday-to-Friday dates in an inclusive range for an optimistic client draft.
 *
 * This helper intentionally does not apply timezone or holiday rules. The server owns the
 * authoritative duration and any rescheduling under a non-default calendar policy.
 *
 * @param startDate - Inclusive range start in `YYYY-MM-DD` form.
 * @param endDate - Inclusive range end in `YYYY-MM-DD` form.
 * @returns The number of Monday-to-Friday dates, or zero for a reversed range.
 */
export function countTaskScheduleWorkingDays(startDate: string, endDate: string): number {
  return countTaskSchedulePolicyWorkingDays(
    startDate,
    endDate,
    DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY,
  )
}

/**
 * Counts working dates in an inclusive range under an explicit calendar policy.
 *
 * Date-only values are evaluated by weekday without converting them through the browser's local
 * timezone. The policy timezone is retained for server-side instant conversion, while weekday and
 * holiday membership remain properties of the supplied local calendar dates.
 *
 * @param startDate - Inclusive local start date in `YYYY-MM-DD` form.
 * @param endDate - Inclusive local end date in `YYYY-MM-DD` form.
 * @param policy - Weekday and holiday rules captured by the schedule.
 * @returns The inclusive working-date count, or zero for a reversed range.
 */
export function countTaskSchedulePolicyWorkingDays(
  startDate: string,
  endDate: string,
  policy: WorkItemScheduleCalendarPolicy,
): number {
  const normalizedStartDate = requireTaskScheduleDate(startDate)
  const normalizedEndDate = requireTaskScheduleDate(endDate)

  if (normalizedStartDate > normalizedEndDate) {
    return 0
  }
  requireSupportedTaskScheduleDateSpan(normalizedStartDate, normalizedEndDate)

  const holidays = new Set(policy.holidays)
  const workingWeekdays = new Set(policy.workingWeekdays)
  let count = 0
  let date = normalizedStartDate

  while (date <= normalizedEndDate) {
    const weekday = taskScheduleWeekdays[requireTaskScheduleDateObject(date).getUTCDay()]
    if (weekday && workingWeekdays.has(weekday) && !holidays.has(date)) {
      count += 1
    }
    if (date === normalizedEndDate) {
      break
    }
    date = addTaskTimelineDays(date, 1)
  }

  return count
}

/**
 * Creates inclusive timeline boundaries around all dated schedules.
 *
 * Unscheduled entries are ignored. The fallback is used only when no schedule has a date, and
 * optional padding uses UTC calendar-day arithmetic without applying scheduling policy.
 *
 * @param schedules - Canonical schedules considered by the timeline.
 * @param fallbackDate - Date shown when every task is unscheduled.
 * @param paddingDays - Non-negative number of calendar dates added to both boundaries.
 * @returns Inclusive timeline boundaries in chronological order.
 */
export function createTaskTimelineDateRange(
  schedules: readonly WorkItemSchedule[],
  fallbackDate: string,
  paddingDays = 0,
): TaskTimelineDateRange {
  const dates = schedules.flatMap((schedule) => {
    const startDate = resolveTaskScheduleStartDate(schedule)
    const endDate = resolveTaskScheduleEndDate(schedule)
    return [startDate, endDate].filter(isTaskScheduleDate)
  })
  const normalizedFallbackDate = requireTaskScheduleDate(fallbackDate)
  const sortedDates = dates.length > 0
    ? dates.toSorted((firstDate, secondDate) => firstDate.localeCompare(secondDate))
    : [normalizedFallbackDate]
  const firstDate = sortedDates[0]
  const lastDate = sortedDates.at(-1)

  if (firstDate === undefined || lastDate === undefined) {
    return {
      endDate: normalizedFallbackDate,
      startDate: normalizedFallbackDate,
    }
  }

  const padding = normalizeTimelinePadding(paddingDays)
  return {
    endDate: addTaskTimelineDays(lastDate, padding),
    startDate: addTaskTimelineDays(firstDate, -padding),
  }
}

/**
 * Lists every UTC calendar date in an inclusive timeline range.
 *
 * @param range - Inclusive timeline boundaries.
 * @returns Ordered ISO dates, or an empty list when the range is reversed.
 */
export function listTaskTimelineDates(range: TaskTimelineDateRange): string[] {
  const startDate = requireTaskScheduleDate(range.startDate)
  const endDate = requireTaskScheduleDate(range.endDate)

  if (startDate > endDate) {
    return []
  }
  requireSupportedTaskScheduleDateSpan(startDate, endDate)

  const dates: string[] = []
  let date = startDate

  while (date <= endDate) {
    dates.push(date)
    if (date === endDate) {
      break
    }
    date = addTaskTimelineDays(date, 1)
  }

  return dates
}

/**
 * Adds whole UTC calendar days to a date-only value without browser timezone arithmetic.
 *
 * @param date - Source date in `YYYY-MM-DD` form.
 * @param days - Safe integer number of calendar days to add, which may be negative.
 * @returns The shifted `YYYY-MM-DD` date.
 */
export function addTaskTimelineDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) {
    throw new RangeError('Timeline day offset must be a safe integer.')
  }

  const nextDate = requireTaskScheduleDateObject(date)
  nextDate.setUTCDate(nextDate.getUTCDate() + days)
  return nextDate.toISOString().slice(0, 10)
}

/**
 * Creates a complete schedule replacement operation for server preview.
 *
 * @param schedule - Candidate replacement schedule.
 * @returns A replace operation preserving the candidate schedule.
 */
export function createReplaceTaskScheduleOperation(
  schedule: WorkItemSchedule,
): WorkItemScheduleOperation {
  return { schedule, type: 'replace' }
}

/**
 * Creates a schedule move operation for server preview.
 *
 * @param targetDate - New deadline, milestone date, or range start.
 * @returns A move operation without applying client-side calendar policy.
 */
export function createMoveTaskScheduleOperation(targetDate: string): WorkItemScheduleOperation {
  return {
    targetDate: requireTaskScheduleDate(normalizeTaskScheduleDate(targetDate)),
    type: 'move',
  }
}

/**
 * Creates a date-range resize operation for server preview.
 *
 * @param endDate - New inclusive range end.
 * @returns A resize operation without recalculating server-owned schedule impacts.
 */
export function createResizeTaskScheduleOperation(endDate: string): WorkItemScheduleOperation {
  return {
    endDate: requireTaskScheduleDate(normalizeTaskScheduleDate(endDate)),
    type: 'resize',
  }
}

/**
 * Replaces an editable deadline without discarding calendar policy or planned effort.
 *
 * Range tasks and milestones require their mode-specific editors and are rejected here so a
 * deadline-only control cannot silently collapse their canonical schedule.
 *
 * @param schedule - Current canonical schedule shown by a deadline-only editor.
 * @param dueDate - New date-only value, or an empty value to mark the item unscheduled.
 * @returns A due-date or unscheduled schedule retaining non-placement metadata.
 */
export function replaceTaskDeadlineSchedule(
  schedule: WorkItemSchedule,
  dueDate: string,
): DueDateWorkItemSchedule | UnscheduledWorkItemSchedule {
  if (schedule.mode === 'date-range' || schedule.mode === 'milestone') {
    throw new RangeError('Range tasks and milestones require mode-specific schedule edits.')
  }

  const calendarPolicy = {
    holidays: [...schedule.calendarPolicy.holidays],
    timeZone: schedule.calendarPolicy.timeZone,
    workingWeekdays: [...schedule.calendarPolicy.workingWeekdays],
  }
  const effort = createPlannedEffortFields(schedule.plannedEffortMinutes)
  const normalizedDueDate = dueDate.trim()
  return normalizedDueDate
    ? {
        calendarPolicy,
        dueDate: requireTaskScheduleDate(normalizedDueDate),
        mode: 'due-date',
        ...effort,
      }
    : {
        calendarPolicy,
        mode: 'unscheduled',
        ...effort,
      }
}

/**
 * Removes calendar placement while retaining the schedule's policy and planned effort.
 *
 * @param schedule - Current canonical schedule being moved to the unscheduled bucket.
 * @returns An explicit unscheduled schedule with detached calendar policy arrays.
 */
export function unscheduleTaskSchedule(
  schedule: WorkItemSchedule,
): UnscheduledWorkItemSchedule {
  return {
    calendarPolicy: {
      holidays: [...schedule.calendarPolicy.holidays],
      timeZone: schedule.calendarPolicy.timeZone,
      workingWeekdays: [...schedule.calendarPolicy.workingWeekdays],
    },
    mode: 'unscheduled',
    ...createPlannedEffortFields(schedule.plannedEffortMinutes),
  }
}

/**
 * Trims a task date before strict ISO validation.
 *
 * @param date - ISO calendar date candidate.
 * @returns The trimmed candidate without rewriting it.
 */
function normalizeTaskScheduleDate(date: string): string {
  return date.trim()
}

/**
 * Builds an optional effort fragment without emitting an explicit undefined property.
 *
 * @param plannedEffortMinutes - Optional effort estimate.
 * @returns An empty object or a planned-effort property.
 */
function createPlannedEffortFields(plannedEffortMinutes?: number) {
  if (
    plannedEffortMinutes !== undefined &&
    (!Number.isSafeInteger(plannedEffortMinutes) || plannedEffortMinutes < 0)
  ) {
    throw new RangeError('Planned effort minutes must be a nonnegative integer.')
  }
  return plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }
}

/**
 * Checks whether a value is a real ISO calendar date.
 *
 * @param value - Candidate date-only string.
 * @returns True when the value round-trips through UTC date parsing.
 */
function isTaskScheduleDate(value: string | undefined): value is string {
  return value !== undefined && parseTaskScheduleDate(value) !== undefined
}

/**
 * Parses a real ISO calendar date at UTC midnight.
 *
 * @param value - Candidate `YYYY-MM-DD` value.
 * @returns A UTC Date or undefined for malformed and impossible dates.
 */
function parseTaskScheduleDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return undefined
  }

  const date = new Date(`${value}T00:00:00.000Z`)
  if (
    Number(value.slice(0, 4)) < WORK_ITEM_SCHEDULE_MIN_YEAR ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    return undefined
  }

  return date
}

/**
 * Requires a real ISO calendar date while preserving its date-only value.
 *
 * @param value - Candidate date-only string.
 * @returns The validated string.
 */
function requireTaskScheduleDate(value: string): string {
  if (!isTaskScheduleDate(value)) {
    throw new RangeError(`Invalid task schedule date: ${value}`)
  }
  return value
}

/**
 * Requires and parses a real ISO calendar date.
 *
 * @param value - Candidate date-only string.
 * @returns A mutable UTC Date representing the supplied calendar date.
 */
function requireTaskScheduleDateObject(value: string): Date {
  const date = parseTaskScheduleDate(value)
  if (date === undefined) {
    throw new RangeError(`Invalid task schedule date: ${value}`)
  }
  return date
}

/**
 * Rejects an inclusive date span beyond the shared server planning horizon in constant time.
 *
 * @param startDate - Valid inclusive schedule start.
 * @param endDate - Valid inclusive schedule end on or after the start.
 * @returns The inclusive number of calendar dates in the supported span.
 */
function requireSupportedTaskScheduleDateSpan(
  startDate: string,
  endDate: string,
): number {
  const startTime = requireTaskScheduleDateObject(startDate).getTime()
  const endTime = requireTaskScheduleDateObject(endDate).getTime()
  const spanDays = Math.round(
    (endTime - startTime) / MILLISECONDS_PER_CALENDAR_DAY,
  ) + 1
  if (spanDays > WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS) {
    throw new RangeError('Task schedule date range exceeds the supported planning horizon.')
  }
  return spanDays
}

/**
 * Validates symmetric timeline padding.
 *
 * @param paddingDays - Candidate padding count.
 * @returns A non-negative safe integer.
 */
function normalizeTimelinePadding(paddingDays: number): number {
  if (!Number.isSafeInteger(paddingDays) || paddingDays < 0) {
    throw new RangeError('Timeline padding must be a non-negative safe integer.')
  }
  return paddingDays
}
