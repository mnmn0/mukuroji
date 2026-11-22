import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  WORK_CALENDAR_CHANGE_EXAMPLE_LIMIT,
  haveSameWorkCalendarRules,
  resolveSharedWorkItemCalendarPolicy,
  type WorkCalendar,
  type WorkCalendarAdjustment,
  type WorkCalendarChangeExample,
  type WorkCalendarChangeImpact,
  type WorkCalendarOverrides,
  type WorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
  type WorkspaceCalendarSettings,
} from '@mukuroji/contracts'
import {
  normalizeWorkItemSchedule,
  rebaseWorkItemScheduleCalendar,
  type TeamIssueResponseItem,
  type WorkItemScheduleCascadeUpdate,
} from '../../modules/work-items'
import { workspaceDependencies } from './app-dependencies'

/** Workspace calendar inputs every shared calendar resolution starts from. */
export type WorkspaceCalendarInputs = {
  /** Stored Workspace calendar settings, or the defaults. */
  settings: WorkspaceCalendarSettings
  /** Synced national holiday dates when the Workspace uses them. */
  nationalHolidayDates?: readonly string[]
}

/** Team and Project calendars of one Team. */
export type TeamWorkCalendars = {
  /** The Team's own calendar, when stored. */
  team?: WorkCalendar
  /** Project calendars keyed by Project ID. */
  projects: ReadonlyMap<string, WorkCalendar>
}

/** Team and Project a new or existing Work Item belongs to. */
export type WorkCalendarTarget = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Project the Work Item is assigned to, if any. */
  projectId?: string
}

/**
 * Reads the Workspace calendar settings and, when used, the national holidays.
 *
 * A Workspace that has not saved calendar settings gets the defaults; any other read failure
 * propagates so a stored calendar is never silently replaced.
 *
 * @param directoryId - Workspace directory to read.
 * @returns The settings and national holiday dates.
 */
export async function readWorkspaceCalendarInputs(directoryId: string): Promise<WorkspaceCalendarInputs> {
  const settings = await readWorkspaceCalendarSettingsOf(directoryId)
  return settings.publicHolidays === 'japan'
    ? { settings, nationalHolidayDates: await workspaceDependencies.nationalHolidays.listDates() }
    : { settings }
}

/**
 * Reads every stored calendar of one Team.
 *
 * @param directoryId - Workspace directory.
 * @param teamId - Team to read.
 * @returns The Team calendar and the Project calendars.
 */
export async function readTeamWorkCalendars(directoryId: string, teamId: string): Promise<TeamWorkCalendars> {
  const calendars = await workspaceDependencies.workCalendars.listTeam(directoryId, teamId)
  const projects = new Map<string, WorkCalendar>()
  let team: WorkCalendar | undefined
  for (const calendar of calendars) {
    if (calendar.scope.teamId !== teamId) continue
    if (calendar.scope.kind === 'team') team = calendar
    else projects.set(calendar.scope.projectId, calendar)
  }
  return team ? { team, projects } : { projects }
}

/**
 * Resolves the shared calendar of a Team or one of its Projects from already read inputs.
 *
 * @param inputs - Workspace calendar inputs.
 * @param teamCalendar - Team rules, if any.
 * @param projectCalendar - Project rules, if any.
 * @returns The shared calendar policy.
 */
export function resolveWorkCalendarPolicyFrom(
  inputs: WorkspaceCalendarInputs,
  teamCalendar: WorkCalendarOverrides | undefined,
  projectCalendar: WorkCalendarOverrides | undefined,
): WorkItemScheduleCalendarPolicy {
  return resolveSharedWorkItemCalendarPolicy(
    inputs.settings,
    [teamCalendar, projectCalendar],
    inputs.nationalHolidayDates,
  )
}

/**
 * Reads the calendar policy a Work Item created without one takes.
 *
 * It is the Workspace calendar with the Team and Project calendars applied (ADR 0058), marked as
 * following them, and it matches the policy the Web puts on a new Work Item. Without a target the
 * Workspace calendar alone is used.
 *
 * @param directoryId - Workspace directory that owns the new Work Item.
 * @param target - Team and Project of the new Work Item.
 * @returns A new calendar policy.
 */
export async function readWorkspaceWorkItemCalendarPolicy(
  directoryId: string,
  target?: WorkCalendarTarget,
): Promise<WorkItemScheduleCalendarPolicy> {
  const inputs = await readWorkspaceCalendarInputs(directoryId)
  if (!target) return resolveWorkCalendarPolicyFrom(inputs, undefined, undefined)
  const calendars = await readTeamWorkCalendars(directoryId, target.teamId)
  return resolveWorkCalendarPolicyFrom(
    inputs,
    calendars.team,
    target.projectId === undefined ? undefined : calendars.projects.get(target.projectId),
  )
}

/**
 * Replaces the rules of a new schedule that asks to follow the shared calendar.
 *
 * A client sends `calendarSource: 'shared'` with the calendar it showed; the server applies the
 * calendar it resolves itself, keeping the chosen dates and recounting the working days (or
 * keeping the working days when no working day would be left). A schedule with its own rules, or
 * a value that is not a schedule, is returned unchanged for the usual validation.
 *
 * @param directoryId - Workspace directory that owns the new Work Item.
 * @param target - Team and Project of the new Work Item.
 * @param value - Untrusted schedule of the create request.
 * @returns The schedule to create the Work Item with.
 */
export async function applySharedCalendarToNewSchedule(
  directoryId: string,
  target: WorkCalendarTarget,
  value: unknown,
): Promise<unknown> {
  if (!requestsSharedCalendar(value)) return value
  const schedule = normalizeWorkItemSchedule(value)
  const policy = await readWorkspaceWorkItemCalendarPolicy(directoryId, target)
  return rebaseWorkItemScheduleCalendar(schedule, policy, 'keep-end-date').schedule
}

/**
 * Reports whether an untrusted schedule asks to follow the shared calendar.
 *
 * @param value - Untrusted schedule.
 * @returns Whether its calendar policy carries `calendarSource: 'shared'`.
 */
function requestsSharedCalendar(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const policy: unknown = Reflect.get(value, 'calendarPolicy')
  return typeof policy === 'object' && policy !== null && Reflect.get(policy, 'calendarSource') === 'shared'
}

/**
 * Reads a Workspace's calendar settings, which decide its week start and fiscal year start.
 *
 * A Workspace that has not saved calendar settings gets the defaults; any other read failure
 * propagates so a stored week start is never silently replaced.
 *
 * @param directoryId - Workspace directory to read.
 * @returns The stored settings, or the defaults.
 */
export async function readWorkspaceCalendarSettingsOf(
  directoryId: string,
): Promise<WorkspaceCalendarSettings> {
  const profile = await workspaceDependencies.tenantAdministration.getProfile(directoryId)
  return profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS
}

/** Inputs of a calendar change plan. */
export type WorkCalendarChangePlanInput = {
  /** Work Items of every Team the change can reach. */
  workItems: readonly TeamIssueResponseItem[]
  /** Shared calendar each Work Item follows before the change. */
  before(workItem: TeamIssueResponseItem): WorkItemScheduleCalendarPolicy
  /** Shared calendar each Work Item follows after the change. */
  after(workItem: TeamIssueResponseItem): WorkItemScheduleCalendarPolicy
  /** How date ranges keep their dates. */
  adjustment: WorkCalendarAdjustment
  /** Whether the caller may see a Work Item as an example. */
  canShowExample(workItem: TeamIssueResponseItem): boolean
}

/** A calendar change plan: what it does and the schedule rewrites it needs. */
export type WorkCalendarChangePlan = {
  /** Impact shown in the preview. */
  impact: WorkCalendarChangeImpact
  /** Schedule rewrites, in Team then Work Item order. */
  updates: WorkItemScheduleCascadeUpdate[]
}

/**
 * Plans what a shared calendar change does to the Work Items that follow it (ADR 0058).
 *
 * A Work Item follows the calendar when its policy is marked `shared`, or when it is an older row
 * with its own policy that equals the calendar before the change; such a row is marked `shared`
 * when the change is applied. Every following Work Item whose rules differ from the new calendar
 * is rewritten; the impact counts those whose dates or working days change.
 *
 * @param input - Work Items, calendars before and after, and the adjustment.
 * @returns The impact and the rewrites.
 */
export function planWorkCalendarChange(input: WorkCalendarChangePlanInput): WorkCalendarChangePlan {
  const updates: WorkItemScheduleCascadeUpdate[] = []
  const examples: { example: WorkCalendarChangeExample, sortKey: string }[] = []
  let followingCount = 0
  let changedCount = 0
  let fallbackToKeepDurationCount = 0
  const ordered = [...input.workItems].sort((left, right) =>
    left.teamId === right.teamId ? compareText(left.id, right.id) : compareText(left.teamId, right.teamId))
  for (const workItem of ordered) {
    const current = workItem.schedule.calendarPolicy
    const before = input.before(workItem)
    if (current.calendarSource !== 'shared' && !haveSameWorkCalendarRules(current, before)) continue
    followingCount += 1
    const after = input.after(workItem)
    if (current.calendarSource === 'shared' && haveSameWorkCalendarRules(current, after)) continue
    const rebased = rebaseWorkItemScheduleCalendar(workItem.schedule, after, input.adjustment)
    updates.push({
      teamId: workItem.teamId,
      workItemId: workItem.id,
      expectedRevision: workItem.revision,
      schedule: rebased.schedule,
    })
    const beforeDates = readScheduleDates(workItem.schedule)
    const afterDates = readScheduleDates(rebased.schedule)
    if (!beforeDates || !afterDates || sameDates(beforeDates, afterDates)) continue
    changedCount += 1
    if (rebased.fellBackToKeepDuration) fallbackToKeepDurationCount += 1
    if (!input.canShowExample(workItem)) continue
    examples.push({
      sortKey: `${beforeDates.startDate}\0${workItem.teamId}\0${workItem.id}`,
      example: {
        teamId: workItem.teamId,
        workItemId: workItem.id,
        ...(workItem.key ? { key: workItem.key } : {}),
        title: workItem.title,
        before: beforeDates,
        after: afterDates,
      },
    })
  }
  return {
    impact: {
      adjustment: input.adjustment,
      followingCount,
      changedCount,
      examples: examples
        .sort((left, right) => compareText(left.sortKey, right.sortKey))
        .slice(0, WORK_CALENDAR_CHANGE_EXAMPLE_LIMIT)
        .map((entry) => entry.example),
      fallbackToKeepDurationCount,
    },
    updates,
  }
}

/**
 * Reads the dates of a date-range schedule.
 *
 * @param schedule - Canonical schedule.
 * @returns The dates, or undefined for a schedule without a date range.
 */
function readScheduleDates(schedule: WorkItemSchedule) {
  return schedule.mode === 'date-range'
    ? { startDate: schedule.startDate, endDate: schedule.endDate, durationDays: schedule.durationDays }
    : undefined
}

/**
 * Compares the dates of two date ranges.
 *
 * @param left - First dates.
 * @param right - Second dates.
 * @returns Whether start, end, and working days are equal.
 */
function sameDates(
  left: { startDate: string, endDate: string, durationDays: number },
  right: { startDate: string, endDate: string, durationDays: number },
): boolean {
  return left.startDate === right.startDate &&
    left.endDate === right.endDate &&
    left.durationDays === right.durationDays
}

/**
 * Compares text by UTF-16 code units, as the other deterministic orders do.
 *
 * @param left - First text.
 * @param right - Second text.
 * @returns A negative, zero, or positive number.
 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
