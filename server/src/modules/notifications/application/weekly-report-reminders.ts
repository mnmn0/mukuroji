import {
  DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS,
  DEFAULT_WORKSPACE_TIME_ZONE,
  toWorkspaceLocalDate,
  workspaceWeekContaining,
  type WeeklyReportReminderSettings,
  type WorkspaceWeekStartDay,
} from '@mukuroji/contracts'

/** Milliseconds in one day. */
const dayMilliseconds = 86_400_000

/** Milliseconds in one hour, the interval of the reminder schedule. */
const hourMilliseconds = 3_600_000

/** One weekly local time at which the hourly schedule acts. */
export type WeeklyReportReminderSlot = {
  /** Local weekday, 0 (Sunday) to 6 (Saturday). */
  weekday: number
  /** Local hour, 0 to 23. The schedule runs hourly, so minutes are not configurable. */
  hour: number
}

/** When weekly report reminders go out, and in which time zone the slots are read. */
export type WeeklyReportReminderTiming = {
  /** IANA time zone of both slots. */
  timeZone: string
  /** When the author of an unsubmitted report is reminded. */
  reminder: WeeklyReportReminderSlot
  /** When the managers are told the report is still unsubmitted; absent to never tell them. */
  escalation?: WeeklyReportReminderSlot
}

/**
 * Turns a Workspace's reminder settings into the schedule timing, in the Workspace time zone.
 *
 * @param settings - Stored settings; the defaults when the Workspace has not chosen its own.
 * @param timeZone - Workspace time zone the hours are read in; Japan time by default.
 * @returns The timing, or undefined when reminders are off. Escalation needs the reminder.
 */
export function toWeeklyReportReminderTiming(
  settings: WeeklyReportReminderSettings = DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS,
  timeZone: string = DEFAULT_WORKSPACE_TIME_ZONE,
): WeeklyReportReminderTiming | undefined {
  if (!settings.enabled) return undefined
  return {
    timeZone,
    reminder: settings.reminder,
    ...(settings.escalationEnabled ? { escalation: settings.escalation } : {}),
  }
}

/** What one hourly run sends, and which local date the target week contains. */
export type WeeklyReportReminderRun = {
  /** `reminder` tells the author; `escalation` tells the author's managers. */
  kind: 'reminder' | 'escalation'
  /** Local `YYYY-MM-DD` date inside the week the run is about. */
  date: string
}

/** A Project member who may write weekly reports in the Team. */
export type WeeklyReportRosterMember = {
  /** Lower-case Workspace member key. */
  memberKey: string
  /** Display name cached on the membership, when there is one. */
  displayName?: string
}

/** One active Project of a Team with the members who write and manage it. */
export type WeeklyReportRosterProject = {
  /** Project ID. */
  projectId: string
  /** Unarchived `manager` and `member` memberships; viewers do not write weekly reports. */
  writers: WeeklyReportRosterMember[]
  /** Lower-case member keys of the unarchived managers. */
  managerMemberKeys: string[]
}

/** The members expected to write weekly reports in one Team. */
export type WeeklyReportTeamRoster = {
  /** Workspace containing the Team. */
  workspaceId: string
  /** Team ID. */
  teamId: string
  /** Active Projects of the Team. */
  projects: WeeklyReportRosterProject[]
}

/** One reminder or escalation for one unsubmitted weekly report. */
export type WeeklyReportReminderCandidate = {
  /** Reminder to the author, or escalation to one manager. */
  kind: 'reminder' | 'escalation'
  /** Workspace containing the Team. */
  workspaceId: string
  /** Team of the report. */
  teamId: string
  /** First day of the unsubmitted week. */
  weekStart: string
  /** Lower-case member key of the author. */
  authorMemberKey: string
  /** Author display name, for the escalation summary. */
  authorDisplayName?: string
  /** Who receives the notification: the author, or one manager. */
  recipientMemberKey: string
  /** Project the delivery is authorized against; the author writes in it and the manager manages it. */
  projectId: string
}

/**
 * Tells what an hourly run sends, if anything.
 *
 * The reminder is about the week that contains the reminder day. The escalation is about the same
 * week: the most recent reminder day at or before the escalation (a week back when both fall on
 * the same weekday and the escalation hour is not later).
 *
 * @param now - Schedule execution instant.
 * @param timing - Reminder timing.
 * @returns The run, or undefined when this hour is neither slot.
 */
export function resolveWeeklyReportReminderRun(
  now: Date,
  timing: WeeklyReportReminderTiming,
): WeeklyReportReminderRun | undefined {
  const date = toWorkspaceLocalDate(now, timing.timeZone)
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay()
  const hour = readLocalHour(now, timing.timeZone)
  const previousHour = readLocalHour(new Date(now.getTime() - hourMilliseconds), timing.timeZone)
  if (weekday === timing.reminder.weekday && isSlotHour(timing.reminder.hour, hour, previousHour)) {
    return { kind: 'reminder', date }
  }
  const escalation = timing.escalation
  if (!escalation || weekday !== escalation.weekday || !isSlotHour(escalation.hour, hour, previousHour)) {
    return undefined
  }
  let daysBack = (escalation.weekday - timing.reminder.weekday + 7) % 7
  if (daysBack === 0 && escalation.hour <= timing.reminder.hour) daysBack = 7
  return { kind: 'escalation', date: addDays(date, -daysBack) }
}

/**
 * Tells whether an hourly run falls on a slot's local hour.
 *
 * When the clocks go forward over the slot (for example 2:00 does not exist on the day daylight
 * saving time starts), the run of the first hour after the gap acts instead, so the week's
 * reminder is not lost. An offset that is not a whole hour (such as Asia/Kathmandu) runs within
 * the slot's local hour rather than on the hour.
 *
 * @param slotHour - Local hour of the slot.
 * @param hour - Local hour of this run.
 * @param previousHour - Local hour one hour before this run.
 * @returns Whether this run acts for the slot.
 */
function isSlotHour(slotHour: number, hour: number, previousHour: number): boolean {
  if (hour === slotHour) return true
  // The local hour jumped past the slot: one hour ago it was before the slot, now it is after.
  const step = (hour - previousHour + 24) % 24
  const slotOffset = (slotHour - previousHour + 24) % 24
  return step > 1 && slotOffset > 0 && slotOffset < step
}

/**
 * Finds the first day of the Workspace week that contains a local date.
 *
 * @param date - Local `YYYY-MM-DD` date.
 * @param weekStartDay - Day the Workspace week starts on.
 * @returns The week start.
 */
export function weeklyReportWeekStart(date: string, weekStartDay: WorkspaceWeekStartDay): string {
  return workspaceWeekContaining(date, weekStartDay).from
}

/**
 * Builds the notifications of one run for one Team.
 *
 * Every writer of an active Project in the Team who has not submitted the week gets one reminder,
 * authorized against the first Project (by ID) they write in. An escalation goes once to each
 * manager of a Project the author writes in, other than the author, authorized against the first
 * such Project the manager manages.
 *
 * @param roster - Team roster.
 * @param kind - Reminder or escalation.
 * @param weekStart - First day of the week.
 * @param submittedMemberKeys - Authors who have submitted the week.
 * @returns Candidates ordered by author and then recipient.
 */
export function evaluateWeeklyReportReminders(
  roster: WeeklyReportTeamRoster,
  kind: WeeklyReportReminderRun['kind'],
  weekStart: string,
  submittedMemberKeys: ReadonlySet<string>,
): WeeklyReportReminderCandidate[] {
  const projects = [...roster.projects].sort((left, right) => left.projectId.localeCompare(right.projectId))
  const authors = new Map<string, { displayName?: string; projectIds: string[] }>()
  for (const project of projects) {
    for (const writer of project.writers) {
      const author = authors.get(writer.memberKey) ?? { projectIds: [] }
      author.projectIds.push(project.projectId)
      if (author.displayName === undefined && writer.displayName) author.displayName = writer.displayName
      authors.set(writer.memberKey, author)
    }
  }
  const managersByProject = new Map(projects.map((project) => [project.projectId, project.managerMemberKeys]))
  const candidates: WeeklyReportReminderCandidate[] = []
  for (const authorMemberKey of [...authors.keys()].sort()) {
    if (submittedMemberKeys.has(authorMemberKey)) continue
    const author = authors.get(authorMemberKey)
    const firstProjectId = author?.projectIds[0]
    if (!author || firstProjectId === undefined) continue
    const base = {
      kind,
      workspaceId: roster.workspaceId,
      teamId: roster.teamId,
      weekStart,
      authorMemberKey,
      ...(author.displayName ? { authorDisplayName: author.displayName } : {}),
    }
    if (kind === 'reminder') {
      candidates.push({ ...base, recipientMemberKey: authorMemberKey, projectId: firstProjectId })
      continue
    }
    const projectByManager = new Map<string, string>()
    for (const projectId of author.projectIds) {
      for (const managerMemberKey of managersByProject.get(projectId) ?? []) {
        if (managerMemberKey === authorMemberKey || projectByManager.has(managerMemberKey)) continue
        projectByManager.set(managerMemberKey, projectId)
      }
    }
    for (const managerMemberKey of [...projectByManager.keys()].sort()) {
      const projectId = projectByManager.get(managerMemberKey)
      if (projectId === undefined) continue
      candidates.push({ ...base, recipientMemberKey: managerMemberKey, projectId })
    }
  }
  return candidates
}

/**
 * Reads the local hour of an instant in a time zone.
 *
 * @param instant - Instant.
 * @param timeZone - IANA time zone.
 * @returns Hour from 0 to 23.
 */
export function readLocalHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone })
    .formatToParts(instant)
    .find((part) => part.type === 'hour')?.value
  return Number(hour) % 24
}

/**
 * Adds whole days to a `YYYY-MM-DD` date.
 *
 * @param date - Date.
 * @param days - Days to add; negative to go back.
 * @returns The shifted date.
 */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * dayMilliseconds).toISOString().slice(0, 10)
}
