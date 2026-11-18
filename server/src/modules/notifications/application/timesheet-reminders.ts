/** Milliseconds in one day. */
const dayMilliseconds = 86_400_000

/**
 * How far back the schedule looks for unsubmitted time entries. Older drafts are left alone so
 * the daily read stays bounded.
 */
export const TIMESHEET_REMINDER_LOOKBACK_DAYS = 92

/** Most entry IDs one reminder carries for delivery-time revalidation. */
export const TIMESHEET_REMINDER_MAX_ENTRY_IDS = 20

/** A draft or rejected time entry that its owner has not submitted. */
export type UnsubmittedTimeEntry = {
  /** Time entry ID. */
  entryId: string
  /** Lower-case Workspace member key of the entry owner. */
  memberKey: string
  /** Absolute start of the recorded interval. */
  startAt: string
  /** Absolute end of the recorded interval. */
  endAt: string
}

/** One timesheet submission reminder for one member of one Team. */
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
  /** Reminder threshold in days that applied to this member. */
  reminderDays: number
  /** Index of the `reminderDays`-long period since the Unix epoch; one reminder per period. */
  cycle: number
}

/**
 * Groups a Team's unsubmitted entries into one reminder per member.
 *
 * An entry is due for submission once `reminderDays` have passed since it ended. A member with at
 * least one such entry gets one reminder per `reminderDays`-long period counted from the Unix
 * epoch, so the reminder repeats on that interval while drafts remain and never repeats inside
 * one period.
 *
 * @param workspaceId - Workspace containing the Team.
 * @param teamId - Team the entries belong to.
 * @param entries - Draft and rejected entries read for the Team.
 * @param now - Schedule execution instant.
 * @param reminderDaysFor - Resolves the member's effective reminder threshold.
 * @returns One candidate per member with an entry past the threshold, ordered by member key.
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
    const due = (entriesByMember.get(memberKey) ?? [])
      .filter((entry) => now.getTime() - Date.parse(entry.endAt) >= thresholdMilliseconds)
      .sort((left, right) =>
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
      reminderDays,
      cycle: Math.floor(now.getTime() / thresholdMilliseconds),
    })
  }
  return candidates
}
