/** Timeline scales the Gantt chart offers. `auto` fits the planning horizon into bounded columns. */
export const taskGanttScales = ['auto', 'day', 'week', 'month', 'quarter'] as const

/** One Gantt timeline scale. */
export type TaskGanttScale = typeof taskGanttScales[number]

/** Scales that always align their columns to calendar units. */
type TaskGanttCalendarScale = Exclude<TaskGanttScale, 'auto'>

/** One bounded Gantt column that may aggregate several calendar dates. */
export type TaskGanttTimelineColumn = {
  /** Inclusive first date represented by the column. */
  startDate: string
  /** Inclusive final date represented by the column. */
  endDate: string
  /** Compact visible label for the timeline header. */
  label: string
}

/** Inclusive date range covered by a timeline. */
export type TaskGanttDateRange = {
  /** Inclusive first date in `YYYY-MM-DD` form. */
  startDate: string
  /** Inclusive last date in `YYYY-MM-DD` form. */
  endDate: string
}

/** Columns built for a calendar scale, with the scale that was actually used. */
export type TaskGanttScaledColumns = {
  /** Ordered columns covering the requested range. */
  columns: TaskGanttTimelineColumn[]
  /** Scale used, coarser than requested when the range needs too many columns. */
  scale: TaskGanttCalendarScale
}

/** Ordered timeline columns and the pixel width of each column. */
export type TaskGanttTimelineAxis = {
  /** Ordered inclusive columns. */
  columns: readonly TaskGanttTimelineColumn[]
  /** Rendered width of every column in pixels. */
  columnWidth: number
}

/** Horizontal pixel span of one date on a timeline axis. */
export type TaskGanttDateSpan = {
  /** Offset of the start of the date from the start of the timeline. */
  left: number
  /** Offset of the end of the date from the start of the timeline. */
  right: number
}

/** Inputs of one point of the progress line. */
export type TaskGanttProgressPointInput = {
  /** Timeline columns and their width. */
  axis: TaskGanttTimelineAxis
  /** Planned first date of the row. */
  startDate?: string
  /** Planned last date of the row. */
  endDate?: string
  /** Progress rate from 0 through 100, when the row has one. */
  progressPercent?: number
  /** Today's date in `YYYY-MM-DD` form. */
  today: string
  /** Horizontal center of today on the timeline. */
  todayX: number
}

/** Column width of the day, week, and automatic scales. */
const TASK_GANTT_DAY_COLUMN_WIDTH = 42
/** Column width of the month scale, wide enough for a `YYYY-MM` label. */
const TASK_GANTT_MONTH_COLUMN_WIDTH = 56
/** Column width of the quarter scale, wide enough for a `YYYY Q1` label. */
const TASK_GANTT_QUARTER_COLUMN_WIDTH = 64
/** Most columns a calendar scale renders before falling back to a coarser scale. */
const MAX_TASK_GANTT_SCALED_COLUMNS = 1_200
const MILLISECONDS_PER_DAY = 86_400_000
/** Scales from finest to coarsest, used when a range is too long for the requested scale. */
const taskGanttCalendarScales: readonly TaskGanttCalendarScale[] = ['day', 'week', 'month', 'quarter']

/**
 * Narrows a select value to a supported Gantt scale.
 *
 * @param value - Raw value from a form control.
 * @returns Whether the value is a supported scale.
 */
export function isTaskGanttScale(value: string): value is TaskGanttScale {
  return taskGanttScales.some((scale) => scale === value)
}

/**
 * Returns the pixel width of one column at a scale.
 *
 * @param scale - Scale whose columns are rendered.
 * @returns Column width in pixels.
 */
export function resolveTaskGanttColumnWidth(scale: TaskGanttScale): number {
  if (scale === 'month') return TASK_GANTT_MONTH_COLUMN_WIDTH
  if (scale === 'quarter') return TASK_GANTT_QUARTER_COLUMN_WIDTH
  return TASK_GANTT_DAY_COLUMN_WIDTH
}

/**
 * Builds columns aligned to calendar days, Monday-start weeks, months, or quarters.
 *
 * The first column starts at the unit containing the range start, and the last column ends at
 * the unit containing the range end. A range that needs more than a bounded number of columns
 * uses the next coarser scale.
 *
 * @param range - Inclusive range the columns must cover.
 * @param scale - Requested calendar scale.
 * @returns The columns and the scale that was used.
 */
export function createTaskGanttScaledColumns(
  range: TaskGanttDateRange,
  scale: TaskGanttCalendarScale,
): TaskGanttScaledColumns {
  const startIndex = taskGanttCalendarScales.indexOf(scale)
  for (const candidate of taskGanttCalendarScales.slice(startIndex)) {
    const columns = createCalendarColumns(range, candidate)
    if (columns.length <= MAX_TASK_GANTT_SCALED_COLUMNS || candidate === 'quarter') {
      return { columns, scale: candidate }
    }
  }
  return { columns: createCalendarColumns(range, 'quarter'), scale: 'quarter' }
}

/**
 * Locates one date on a timeline axis.
 *
 * A column that spans several dates gives each date an equal share of its width.
 *
 * @param axis - Ordered columns and their width.
 * @param date - Date in `YYYY-MM-DD` form.
 * @returns The pixel span of the date, or undefined outside the timeline.
 */
export function resolveTaskGanttDateSpan(
  axis: TaskGanttTimelineAxis,
  date: string,
): TaskGanttDateSpan | undefined {
  const columnIndex = axis.columns.findIndex((column) => column.startDate <= date && date <= column.endDate)
  const column = axis.columns[columnIndex]
  if (!column) return undefined
  const dayCount = differenceTaskGanttDays(column.startDate, column.endDate) + 1
  const dayWidth = axis.columnWidth / dayCount
  const left = columnIndex * axis.columnWidth + differenceTaskGanttDays(column.startDate, date) * dayWidth
  return { left, right: left + dayWidth }
}

/** Horizontal span of one non-working day on a timeline axis. */
export type TaskGanttNonWorkingSpan = TaskGanttDateSpan & {
  /** Non-working local date in `YYYY-MM-DD` form. */
  date: string
}

/**
 * Lists the day columns that fall on non-working days, so the chart can shade them.
 *
 * Only single-day columns are listed: a week, month, or quarter column mixes working and
 * non-working days, so shading it would hide which days are working.
 *
 * @param axis - Timeline columns and their width.
 * @param isWorkingDate - Tells whether a local date is a working day.
 * @returns The span of every non-working day column, in timeline order.
 */
export function listTaskGanttNonWorkingSpans(
  axis: TaskGanttTimelineAxis,
  isWorkingDate: (date: string) => boolean,
): TaskGanttNonWorkingSpan[] {
  return axis.columns.flatMap((column, index) =>
    column.startDate === column.endDate && !isWorkingDate(column.startDate)
      ? [{
          date: column.startDate,
          left: index * axis.columnWidth,
          right: (index + 1) * axis.columnWidth,
        }]
      : [])
}

/**
 * Places one row on the progress line (イナズマ線).
 *
 * The point sits at the progress position inside the planned range, measured on the whole
 * range even when the timeline clips it. A row is on schedule, and so sits on today's line,
 * when it has no planned dates or progress rate, when it finished before today, or when it has
 * not started and is not due to start yet. A point left of today means the row is behind, and
 * a point right of today means it is ahead.
 *
 * @param input - Timeline, planned dates, progress rate, and today.
 * @returns Horizontal position of the point, kept inside the timeline.
 */
export function resolveTaskGanttProgressPointX(input: TaskGanttProgressPointInput): number {
  const { axis, endDate, progressPercent, startDate, today, todayX } = input
  if (startDate === undefined || endDate === undefined || progressPercent === undefined || endDate < startDate) {
    return todayX
  }
  const progress = Math.min(Math.max(progressPercent, 0), 100)
  if (progress >= 100 && endDate < today) return todayX
  if (progress <= 0 && today < startDate) return todayX
  const progressDays = ((differenceTaskGanttDays(startDate, endDate) + 1) * progress) / 100
  const wholeDays = Math.floor(progressDays)
  const progressDate = addTaskGanttDays(startDate, wholeDays)
  const span = resolveTaskGanttDateSpan(axis, progressDate)
  if (span) return span.left + (span.right - span.left) * (progressDays - wholeDays)
  const firstDate = axis.columns[0]?.startDate
  return firstDate !== undefined && progressDate < firstDate ? 0 : axis.columns.length * axis.columnWidth
}

/**
 * Builds the columns of one calendar scale without a column limit.
 *
 * @param range - Inclusive range the columns must cover.
 * @param scale - Calendar scale of every column.
 * @returns Ordered columns covering the range.
 */
function createCalendarColumns(
  range: TaskGanttDateRange,
  scale: TaskGanttCalendarScale,
): TaskGanttTimelineColumn[] {
  const columns: TaskGanttTimelineColumn[] = []
  let startDate = startOfCalendarUnit(range.startDate, scale)
  while (startDate <= range.endDate) {
    const endDate = endOfCalendarUnit(startDate, scale)
    columns.push({ endDate, label: formatCalendarColumnLabel(startDate, scale), startDate })
    startDate = addTaskGanttDays(endDate, 1)
  }
  return columns
}

/**
 * Finds the first date of the calendar unit containing a date.
 *
 * @param date - Date in `YYYY-MM-DD` form.
 * @param scale - Calendar unit.
 * @returns The unit's first date.
 */
function startOfCalendarUnit(date: string, scale: TaskGanttCalendarScale): string {
  if (scale === 'day') return date
  if (scale === 'week') {
    const dayOfWeek = new Date(`${date}T00:00:00.000Z`).getUTCDay()
    return addTaskGanttDays(date, -((dayOfWeek + 6) % 7))
  }
  const year = Number(date.slice(0, 4))
  const monthIndex = Number(date.slice(5, 7)) - 1
  const firstMonthIndex = scale === 'quarter' ? monthIndex - (monthIndex % 3) : monthIndex
  return formatUtcDate(Date.UTC(year, firstMonthIndex, 1))
}

/**
 * Finds the last date of the calendar unit starting on a date.
 *
 * @param startDate - First date of the unit.
 * @param scale - Calendar unit.
 * @returns The unit's last date.
 */
function endOfCalendarUnit(startDate: string, scale: TaskGanttCalendarScale): string {
  if (scale === 'day') return startDate
  if (scale === 'week') return addTaskGanttDays(startDate, 6)
  const year = Number(startDate.slice(0, 4))
  const monthIndex = Number(startDate.slice(5, 7)) - 1
  const monthCount = scale === 'quarter' ? 3 : 1
  return formatUtcDate(Date.UTC(year, monthIndex + monthCount, 0))
}

/**
 * Formats a column header label for a calendar scale.
 *
 * @param startDate - First date of the column.
 * @param scale - Calendar scale of the column.
 * @returns `MM-DD` for days and weeks, `YYYY-MM` for months, and `YYYY Qn` for quarters.
 */
function formatCalendarColumnLabel(startDate: string, scale: TaskGanttCalendarScale): string {
  if (scale === 'day' || scale === 'week') return startDate.slice(5)
  if (scale === 'month') return startDate.slice(0, 7)
  return `${startDate.slice(0, 4)} Q${Math.floor((Number(startDate.slice(5, 7)) - 1) / 3) + 1}`
}

/**
 * Adds calendar days to a date.
 *
 * @param date - Date in `YYYY-MM-DD` form.
 * @param days - Signed number of days.
 * @returns The shifted date.
 */
function addTaskGanttDays(date: string, days: number): string {
  return formatUtcDate(new Date(`${date}T00:00:00.000Z`).getTime() + days * MILLISECONDS_PER_DAY)
}

/**
 * Counts calendar days between two dates.
 *
 * @param startDate - First date in `YYYY-MM-DD` form.
 * @param endDate - Second date in `YYYY-MM-DD` form.
 * @returns Signed whole-day distance.
 */
function differenceTaskGanttDays(startDate: string, endDate: string): number {
  const startTime = new Date(`${startDate}T00:00:00.000Z`).getTime()
  const endTime = new Date(`${endDate}T00:00:00.000Z`).getTime()
  return Math.round((endTime - startTime) / MILLISECONDS_PER_DAY)
}

/**
 * Formats a UTC epoch time as a date.
 *
 * @param time - Milliseconds since the epoch at UTC midnight.
 * @returns The date in `YYYY-MM-DD` form.
 */
function formatUtcDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}
