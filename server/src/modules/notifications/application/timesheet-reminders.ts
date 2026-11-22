import { DEFAULT_WORKSPACE_TIME_ZONE } from '@mukuroji/contracts'
import { readLocalHour } from './weekly-report-reminders'

/** Milliseconds in one day. */
const dayMilliseconds = 86_400_000

/**
 * How far back the schedule looks for unsubmitted time entries. Older drafts are left alone so
 * the daily read stays bounded.
 */
export const TIMESHEET_REMINDER_LOOKBACK_DAYS = 92

/** Most entry IDs one reminder carries for delivery-time revalidation. */
export const TIMESHEET_REMINDER_MAX_ENTRY_IDS = 20

/** Local hour of the Workspace day at which timesheet reminders go out: 09:00, the start of work. */
export const DEFAULT_TIMESHEET_REMINDER_HOUR = 9

/**
 * Tells whether an hourly run is the one run of the Workspace day that sends timesheet reminders.
 *
 * The hour is read on the Workspace's wall clock, so the reminder keeps arriving at the same local
 * time whatever the offset from UTC (including across daylight saving changes).
 *
 * @param now - Schedule execution instant.
 * @param hour - Local hour, 0 to 23.
 * @param timeZone - IANA time zone of the Workspace.
 * @returns Whether `now` falls in that local hour.
 */
export function isTimesheetReminderHour(
  now: Date,
  hour: number,
  timeZone: string = DEFAULT_WORKSPACE_TIME_ZONE,
): boolean {
  return readLocalHour(now, timeZone) === hour
}

/** A draft or rejected time entry that its owner has not submitted. */
export type UnsubmittedTimeEntry = {
  /** Time entry ID. */
  entryId: string
  /** Lower-case Workspace member key of the entry owner. */
  memberKey: string
  /** Project the entry was recorded against. */
  projectId: string
  /** Absolute start of the recorded interval. */
  startAt: string
  /** Absolute end of the recorded interval. */
  endAt: string
}

/** One timesheet submission reminder for one member's entries in one Project of one Team. */
export type TimesheetReminderCandidate = {
  /** Workspace containing the Team. */
  workspaceId: string
  /** Team whose timesheet has unsubmitted entries. */
  teamId: string
  /** Lower-case member key of the entry owner, who receives the reminder. */
  memberKey: string
  /** Unsubmitted entry IDs, oldest first, at most {@link TIMESHEET_REMINDER_MAX_ENTRY_IDS}. */
  entryIds: string[]
  /** Number of unsubmitted entries past the reminder threshold. */
  unsubmittedCount: number
  /** Start of the oldest unsubmitted entry. */
  oldestStartAt: string
  /** Project the entries were recorded against; delivery is authorized against it. */
  projectId: string
  /** Entries that ended at or before this instant were due; delivery revalidates against it. */
  dueBefore: string
  /** Reminder threshold in days that applied to this member. */
  reminderDays: number
  /** Index of the `reminderDays`-long period since the Unix epoch; one reminder per period. */
  cycle: number
}

/**
 * Groups a Team's unsubmitted entries into one reminder per member and Project.
 *
 * Each reminder is authorized against its own Project, so entries in a Project the member can no
 * longer read cannot hold back the reminder for a Project they can still submit. An entry is due for submission once `reminderDays` have passed since it ended. A member with at
 * least one such entry gets one reminder per `reminderDays`-long period counted from the Unix
 * epoch, so the reminder repeats on that interval while drafts remain and never repeats inside
 * one period.
 *
 * @param workspaceId - Workspace containing the Team.
 * @param teamId - Team the entries belong to.
 * @param entries - Draft and rejected entries read for the Team.
 * @param now - Schedule execution instant.
 * @param reminderDaysFor - Resolves the member's effective reminder threshold.
 * @returns One candidate per member and Project with an entry past the threshold, ordered by
 *   member key and then Project ID.
 */
export async function evaluateTimesheetReminders(
  workspaceId: string,
  teamId: string,
  entries: readonly UnsubmittedTimeEntry[],
  now: Date,
  reminderDaysFor: (memberKey: string) => Promise<number>,
): Promise<TimesheetReminderCandidate[]> {
  const entriesByMember = new Map<string, UnsubmittedTimeEntry[]>()
  for (const entry of entries) {
    const memberEntries = entriesByMember.get(entry.memberKey) ?? []
    memberEntries.push(entry)
    entriesByMember.set(entry.memberKey, memberEntries)
  }
  const candidates: TimesheetReminderCandidate[] = []
  for (const memberKey of [...entriesByMember.keys()].sort()) {
    const reminderDays = await reminderDaysFor(memberKey)
    const thresholdMilliseconds = reminderDays * dayMilliseconds
    const dueByProject = new Map<string, UnsubmittedTimeEntry[]>()
    for (const entry of entriesByMember.get(memberKey) ?? []) {
      if (now.getTime() - Date.parse(entry.endAt) < thresholdMilliseconds) continue
      const projectEntries = dueByProject.get(entry.projectId) ?? []
      projectEntries.push(entry)
      dueByProject.set(entry.projectId, projectEntries)
    }
    for (const projectId of [...dueByProject.keys()].sort()) {
      const due = (dueByProject.get(projectId) ?? []).sort((left, right) =>
        left.startAt.localeCompare(right.startAt) || left.entryId.localeCompare(right.entryId))
      const oldest = due[0]
      if (!oldest) continue
      candidates.push({
        workspaceId,
        teamId,
        memberKey,
        entryIds: due.slice(0, TIMESHEET_REMINDER_MAX_ENTRY_IDS).map((entry) => entry.entryId),
        unsubmittedCount: due.length,
        oldestStartAt: oldest.startAt,
        projectId,
        dueBefore: new Date(now.getTime() - thresholdMilliseconds).toISOString(),
        reminderDays,
        cycle: Math.floor(now.getTime() / thresholdMilliseconds),
      })
    }
  }
  return candidates
}
