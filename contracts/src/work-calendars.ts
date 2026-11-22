import type { WorkItemScheduleCalendarPolicy } from './work-items'
import { createWorkspaceWorkItemCalendarPolicy } from './work-items'
import {
  WORKSPACE_CALENDAR_WEEKDAYS,
  isWorkspaceCalendarWeekday,
  isWorkspaceHolidayDate,
  isWorkspacePublicHolidayCalendar,
  type WorkspaceCalendarSettings,
  type WorkspaceCalendarWeekday,
  type WorkspacePublicHolidayCalendar,
} from './workspace-calendar'

/**
 * Most company days off a Team or Project calendar adds on top of the Workspace calendar.
 *
 * Every Team and Project calendar is one row, so the limit keeps each row small.
 */
export const WORK_CALENDAR_MAX_ADDITIONAL_HOLIDAYS = 128

/** Most Work Items a calendar change preview lists as examples. */
export const WORK_CALENDAR_CHANGE_EXAMPLE_LIMIT = 10

/**
 * Most Work Items one calendar change may adjust. A change that would adjust more is refused, so a
 * save never leaves part of a Team on the old calendar without saying so.
 */
export const WORK_CALENDAR_CHANGE_MAX_WORK_ITEMS = 480

/**
 * How Work Items that follow a shared calendar keep their dates when the calendar changes.
 *
 * `keep-duration` keeps the start date and the number of working days, so the end date moves.
 * `keep-end-date` keeps both dates, so the number of working days is recounted.
 */
export type WorkCalendarAdjustment = 'keep-duration' | 'keep-end-date'

/** Every calendar change adjustment, in the order screens list them. */
export const WORK_CALENDAR_ADJUSTMENTS: readonly WorkCalendarAdjustment[] = ['keep-duration', 'keep-end-date']

/** Adjustment a Team uses until it chooses one. */
export const DEFAULT_WORK_CALENDAR_ADJUSTMENT: WorkCalendarAdjustment = 'keep-duration'

/** Which shared calendar a request reads or changes. */
export type WorkCalendarScope =
  | {
      /** The Workspace calendar every Team starts from. */
      kind: 'workspace'
    }
  | {
      /** The default calendar of one Team. */
      kind: 'team'
      /** Team that owns the calendar. */
      teamId: string
    }
  | {
      /** The default calendar of one Project, which starts from its Team's calendar. */
      kind: 'project'
      /** Team that owns the Project. */
      teamId: string
      /** Project that owns the calendar. */
      projectId: string
    }

/**
 * Rules a Team or Project calendar changes relative to the calendar it inherits.
 *
 * A Team inherits the Workspace calendar and a Project inherits its Team's calendar.
 */
export type WorkCalendarOverrides = {
  /** Working weekdays in Monday-first order; omitted to inherit them. */
  workingWeekdays?: WorkspaceCalendarWeekday[]
  /** National holidays to take off; omitted to inherit the choice. */
  publicHolidays?: WorkspacePublicHolidayCalendar
  /** Company days off added to the inherited ones, sorted ascending without duplicates. */
  additionalHolidays: string[]
}

/** A stored Team or Project calendar. */
export type WorkCalendar = WorkCalendarOverrides & {
  /** Team or Project that owns the calendar. */
  scope: Extract<WorkCalendarScope, { kind: 'team' | 'project' }>
  /**
   * Adjustment the settings screen chooses first when this Team's calendars change. Only a Team
   * calendar keeps one; a Project uses its Team's.
   */
  changeAdjustment?: WorkCalendarAdjustment
  /** Revision that increases on every save, starting at 1. */
  revision: number
  /** When the calendar was last saved, as an ISO timestamp. */
  updatedAt: string
  /** Member key of the member who last saved the calendar. */
  updatedBy: string
}

/** Response of `GET /api/teams/:teamId/work-calendar`. */
export type WorkCalendarResponse = {
  /** Scope that was read. */
  scope: Extract<WorkCalendarScope, { kind: 'team' | 'project' }>
  /** The scope's own stored calendar; omitted while it inherits everything. */
  calendar?: WorkCalendar
  /** The Team calendar a Project calendar starts from; only for a Project scope. */
  teamCalendar?: WorkCalendar
  /** Adjustment to choose first when this calendar changes. */
  changeAdjustment: WorkCalendarAdjustment
  /** Calendar new Work Items in this scope take, with every inherited rule applied. */
  resolvedPolicy: WorkItemScheduleCalendarPolicy
  /** Whether the current member may change this calendar. */
  canManage: boolean
}

/** Body of a calendar change preview or save. */
export type WorkCalendarChangeInput = {
  /** Project whose calendar changes; omitted for the Team calendar. */
  projectId?: string
  /** New rules of the calendar. */
  overrides: WorkCalendarOverrides
  /** How Work Items that follow the calendar keep their dates. */
  adjustment: WorkCalendarAdjustment
}

/** Body of `PUT /api/teams/:teamId/work-calendar`. */
export type SaveWorkCalendarInput = WorkCalendarChangeInput & {
  /** Revision read before the change; 0 when the scope had no stored calendar. */
  expectedRevision: number
}

/** Body of `POST /api/workspace/work-calendar/apply`, run after the Workspace calendar is saved. */
export type ApplyWorkspaceWorkCalendarInput = {
  /** How Work Items that follow the Workspace calendar keep their dates. */
  adjustment: WorkCalendarAdjustment
}

/** Body of `POST /api/workspace/work-calendar/preview`. */
export type PreviewWorkspaceWorkCalendarInput = ApplyWorkspaceWorkCalendarInput & {
  /** Workspace calendar settings to compare with the saved ones. */
  calendar: WorkspaceCalendarSettings
}

/** Dates of one Work Item schedule that a calendar change may move. */
export type WorkCalendarChangeDates = {
  /** Inclusive start date. */
  startDate: string
  /** Inclusive end date. */
  endDate: string
  /** Working days between the two dates under the calendar. */
  durationDays: number
}

/** One Work Item a calendar change adjusts. */
export type WorkCalendarChangeExample = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Short reference such as `ABC-12`, when the Work Item has one. */
  key?: string
  /** Work Item title. */
  title: string
  /** Dates before the change. */
  before: WorkCalendarChangeDates
  /** Dates after the change. */
  after: WorkCalendarChangeDates
}

/** What a calendar change does to the Work Items that follow the calendar. */
export type WorkCalendarChangeImpact = {
  /** Adjustment the impact was computed with. */
  adjustment: WorkCalendarAdjustment
  /** Work Items that follow the calendar and are read for the change. */
  followingCount: number
  /** Work Items whose dates or working days change. */
  changedCount: number
  /** Up to {@link WORK_CALENDAR_CHANGE_EXAMPLE_LIMIT} changed Work Items, earliest start first. */
  examples: WorkCalendarChangeExample[]
  /**
   * Changed Work Items that would have no working day left with the kept dates; they keep their
   * duration instead.
   */
  fallbackToKeepDurationCount: number
}

/** Response of a calendar save or of applying the Workspace calendar. */
export type WorkCalendarChangeResult = {
  /** Stored calendar after the save; omitted for the Workspace calendar. */
  calendar?: WorkCalendar
  /** Impact that was applied. */
  impact: WorkCalendarChangeImpact
  /** Work Items whose schedule was rewritten. */
  updatedCount: number
  /**
   * Work Items left unchanged because they changed while the save ran; saving the same calendar
   * again adjusts them.
   */
  conflictCount: number
}

/**
 * Narrows an untrusted value to a calendar change adjustment.
 *
 * @param value - Untrusted candidate.
 * @returns Whether the value names an adjustment.
 */
export function isWorkCalendarAdjustment(value: unknown): value is WorkCalendarAdjustment {
  return WORK_CALENDAR_ADJUSTMENTS.some((adjustment) => adjustment === value)
}

/**
 * Reads untrusted Team or Project calendar rules.
 *
 * @param value - Untrusted candidate, such as a request body field or a stored row field.
 * @returns The rules with weekdays in Monday-first order and holidays sorted without duplicates,
 *   or undefined when any field is invalid or unknown.
 */
export function readWorkCalendarOverrides(value: unknown): WorkCalendarOverrides | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const allowed = new Set(['workingWeekdays', 'publicHolidays', 'additionalHolidays'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined
  const workingWeekdays: unknown = Reflect.get(value, 'workingWeekdays')
  const publicHolidays: unknown = Reflect.get(value, 'publicHolidays')
  const additionalHolidays: unknown = Reflect.get(value, 'additionalHolidays')
  const overrides: WorkCalendarOverrides = { additionalHolidays: [] }
  if (workingWeekdays !== undefined) {
    if (!Array.isArray(workingWeekdays) || workingWeekdays.length > WORKSPACE_CALENDAR_WEEKDAYS.length) {
      return undefined
    }
    const entries: unknown[] = workingWeekdays
    if (!entries.every(isWorkspaceCalendarWeekday)) return undefined
    const weekdays = WORKSPACE_CALENDAR_WEEKDAYS.filter((weekday) => entries.includes(weekday))
    if (weekdays.length === 0) return undefined
    overrides.workingWeekdays = weekdays
  }
  if (publicHolidays !== undefined) {
    if (!isWorkspacePublicHolidayCalendar(publicHolidays)) return undefined
    overrides.publicHolidays = publicHolidays
  }
  if (additionalHolidays !== undefined) {
    if (!Array.isArray(additionalHolidays)) return undefined
    const entries: unknown[] = additionalHolidays
    if (!entries.every(isWorkspaceHolidayDate)) return undefined
    const holidays = [...new Set(entries.filter(isWorkspaceHolidayDate))].sort()
    if (holidays.length > WORK_CALENDAR_MAX_ADDITIONAL_HOLIDAYS) return undefined
    overrides.additionalHolidays = holidays
  }
  return overrides
}

/**
 * Reports whether calendar rules change nothing, so the calendar only inherits.
 *
 * @param overrides - Rules to check.
 * @returns Whether no weekday, national holiday, or company holiday is overridden.
 */
export function isEmptyWorkCalendarOverrides(overrides: WorkCalendarOverrides): boolean {
  return overrides.workingWeekdays === undefined &&
    overrides.publicHolidays === undefined &&
    overrides.additionalHolidays.length === 0
}

/**
 * Applies Team and Project calendar rules on top of Workspace calendar settings.
 *
 * Later layers win for working weekdays and the national holiday choice; company days off add up.
 *
 * @param workspace - Workspace calendar settings.
 * @param layers - Team rules, then Project rules; missing layers are skipped.
 * @returns Workspace-shaped settings with every layer applied.
 */
export function applyWorkCalendarOverrides(
  workspace: WorkspaceCalendarSettings,
  layers: readonly (WorkCalendarOverrides | undefined)[],
): WorkspaceCalendarSettings {
  let settings: WorkspaceCalendarSettings = {
    ...workspace,
    workingWeekdays: [...workspace.workingWeekdays],
    holidays: [...workspace.holidays],
  }
  for (const layer of layers) {
    if (!layer) continue
    settings = {
      ...settings,
      workingWeekdays: layer.workingWeekdays ? [...layer.workingWeekdays] : settings.workingWeekdays,
      publicHolidays: layer.publicHolidays ?? settings.publicHolidays,
      holidays: [...new Set([...settings.holidays, ...layer.additionalHolidays])].sort(),
    }
  }
  return settings
}

/**
 * Resolves the shared calendar policy new Work Items in a Team or Project take.
 *
 * @param workspace - Workspace calendar settings.
 * @param layers - Team rules, then Project rules; missing layers are skipped.
 * @param nationalHolidayDates - National holiday dates synced from the Cabinet Office; the bundled
 *   national holidays are used when omitted.
 * @param referenceDate - Date the kept days off are nearest to when there are too many.
 * @returns A policy marked as following the shared calendar.
 */
export function resolveSharedWorkItemCalendarPolicy(
  workspace: WorkspaceCalendarSettings,
  layers: readonly (WorkCalendarOverrides | undefined)[],
  nationalHolidayDates?: readonly string[],
  referenceDate?: string,
): WorkItemScheduleCalendarPolicy {
  return {
    ...createWorkspaceWorkItemCalendarPolicy(
      applyWorkCalendarOverrides(workspace, layers),
      nationalHolidayDates,
      referenceDate,
    ),
    calendarSource: 'shared',
  }
}

/**
 * Reports whether two calendar policies count working days the same way.
 *
 * The calendar source is ignored, so a legacy policy equal to a shared calendar compares equal.
 *
 * @param left - First canonical policy.
 * @param right - Second canonical policy.
 * @returns Whether the time zone, working weekdays, and holidays are the same.
 */
export function haveSameWorkCalendarRules(
  left: WorkItemScheduleCalendarPolicy,
  right: WorkItemScheduleCalendarPolicy,
): boolean {
  return left.timeZone === right.timeZone &&
    left.workingWeekdays.length === right.workingWeekdays.length &&
    left.workingWeekdays.every((weekday, index) => weekday === right.workingWeekdays[index]) &&
    left.holidays.length === right.holidays.length &&
    left.holidays.every((holiday, index) => holiday === right.holidays[index])
}
