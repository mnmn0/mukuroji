import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  resolveSharedWorkItemCalendarPolicy,
  type WorkCalendar,
  type WorkCalendarOverrides,
  type WorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
  type WorkspaceCalendarSettings,
} from '@mukuroji/contracts'
import {
  normalizeWorkItemSchedule,
  rebaseWorkItemScheduleCalendar,
} from '../../modules/work-items'
import { ambientWorkCalendarSources, type WorkCalendarSources } from './app-dependencies'

/** Workspace calendar inputs every shared calendar resolution starts from. */
export type WorkspaceCalendarInputs = {
  /** Stored Workspace calendar settings, or the defaults. */
  settings: WorkspaceCalendarSettings
  /** Synced national holiday dates, used where a calendar turns the national holidays on. */
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
 * Reads the Workspace calendar settings and the synced national holidays.
 *
 * A Workspace that has not saved calendar settings gets the defaults; any other read failure
 * propagates so a stored calendar is never silently replaced.
 *
 * @param directoryId - Workspace directory to read.
 * @param sources - Calendar reads; the request-bound ones by default.
 * @returns The settings and national holiday dates.
 */
export async function readWorkspaceCalendarInputs(
  directoryId: string,
  sources: WorkCalendarSources = ambientWorkCalendarSources,
): Promise<WorkspaceCalendarInputs> {
  // The synced dates are read even when the Workspace does not use them, because a Team or Project
  // calendar can turn the national holidays on.
  const [settings, nationalHolidayDates] = await Promise.all([
    readWorkspaceCalendarSettingsOf(directoryId, sources),
    sources.nationalHolidays.listDates(),
  ])
  return { settings, nationalHolidayDates }
}

/**
 * Reads every stored calendar of one Team.
 *
 * @param directoryId - Workspace directory.
 * @param teamId - Team to read.
 * @param sources - Calendar reads; the request-bound ones by default.
 * @returns The Team calendar and the Project calendars.
 */
export async function readTeamWorkCalendars(
  directoryId: string,
  teamId: string,
  sources: WorkCalendarSources = ambientWorkCalendarSources,
): Promise<TeamWorkCalendars> {
  const calendars = await sources.workCalendars.listTeam(directoryId, teamId)
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
 * @param sources - Calendar reads; the request-bound ones by default.
 * @returns A new calendar policy.
 */
export async function readWorkspaceWorkItemCalendarPolicy(
  directoryId: string,
  target?: WorkCalendarTarget,
  sources: WorkCalendarSources = ambientWorkCalendarSources,
): Promise<WorkItemScheduleCalendarPolicy> {
  const inputs = await readWorkspaceCalendarInputs(directoryId, sources)
  if (!target) return resolveWorkCalendarPolicyFrom(inputs, undefined, undefined)
  const calendars = await readTeamWorkCalendars(directoryId, target.teamId, sources)
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
 * @param sources - Calendar reads; the request-bound ones by default.
 * @returns The schedule to create the Work Item with.
 */
export async function applySharedCalendarToNewSchedule(
  directoryId: string,
  target: WorkCalendarTarget,
  value: unknown,
  sources: WorkCalendarSources = ambientWorkCalendarSources,
): Promise<unknown> {
  if (!requestsSharedCalendar(value)) return value
  const schedule = normalizeWorkItemSchedule(value)
  const policy = await readWorkspaceWorkItemCalendarPolicy(directoryId, target, sources)
  return rebaseWorkItemScheduleCalendar(schedule, policy, 'keep-end-date').schedule
}

/**
 * Applies the resolved shared calendar to a validated schedule that follows it.
 *
 * @param directoryId - Workspace directory that owns the Work Item.
 * @param target - Team and Project of the Work Item.
 * @param schedule - Validated schedule.
 * @returns The schedule on the resolved calendar, or the schedule unchanged when it has its own rules.
 */
export async function applySharedCalendarToSchedule(
  directoryId: string,
  target: WorkCalendarTarget,
  schedule: WorkItemSchedule,
): Promise<WorkItemSchedule> {
  if (schedule.calendarPolicy.calendarSource !== 'shared') return schedule
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
 * @param sources - Calendar reads; the request-bound ones by default.
 * @returns The stored settings, or the defaults.
 */
export async function readWorkspaceCalendarSettingsOf(
  directoryId: string,
  sources: WorkCalendarSources = ambientWorkCalendarSources,
): Promise<WorkspaceCalendarSettings> {
  const profile = await sources.tenantAdministration.getProfile(directoryId)
  return profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS
}

/**
 * Creates the resolver of the shared calendar each Work Item of a Team follows.
 *
 * @param inputs - Workspace calendar inputs.
 * @param calendars - Team and Project calendars.
 * @returns A resolver keyed by the Work Item's Project.
 */
export function createWorkCalendarResolver(
  inputs: WorkspaceCalendarInputs,
  calendars: TeamWorkCalendars,
): (workItem: { assignedProjectId?: string }) => WorkItemScheduleCalendarPolicy {
  const cache = new Map<string, WorkItemScheduleCalendarPolicy>()
  return (workItem) => {
    const projectKey = workItem.assignedProjectId ?? ''
    const cached = cache.get(projectKey)
    if (cached) return cached
    const policy = resolveWorkCalendarPolicyFrom(
      inputs,
      calendars.team,
      workItem.assignedProjectId === undefined ? undefined : calendars.projects.get(workItem.assignedProjectId),
    )
    cache.set(projectKey, policy)
    return policy
  }
}

/**
 * Builds the Team calendars as they would be after one calendar takes new rules.
 *
 * @param calendars - Stored Team and Project calendars.
 * @param scope - Calendar that changes.
 * @param overrides - New rules of that calendar.
 * @returns The Team calendars with the candidate rules.
 */
export function withCandidateWorkCalendar(
  calendars: TeamWorkCalendars,
  scope: WorkCalendar['scope'],
  overrides: WorkCalendarOverrides,
): TeamWorkCalendars {
  const candidate = (current: WorkCalendar | undefined): WorkCalendar => ({
    ...overrides,
    scope,
    revision: (current?.revision ?? 0) + 1,
    updatedAt: current?.updatedAt ?? new Date(0).toISOString(),
    updatedBy: current?.updatedBy ?? 'preview',
  })
  if (scope.kind === 'team') return { team: candidate(calendars.team), projects: calendars.projects }
  return {
    ...(calendars.team ? { team: calendars.team } : {}),
    projects: new Map([...calendars.projects, [scope.projectId, candidate(calendars.projects.get(scope.projectId))]]),
  }
}
