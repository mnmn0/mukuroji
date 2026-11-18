import type { TimesheetReminderRevalidator } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import type { ScheduledTimesheetReader } from '../../modules/notifications'
import type { TimeTrackingRepository } from '../../modules/time-tracking'

/**
 * Adapts the time tracking repository to the schedule's unsubmitted entry reader.
 *
 * @param repository - Time entry repository.
 * @returns Reader that lists a Team's draft and rejected entries in a period.
 */
export function createTimesheetReader(
  repository: Pick<TimeTrackingRepository, 'listEntries'>,
): ScheduledTimesheetReader {
  return {
    async listUnsubmittedEntries(workspaceId, teamId, from, to) {
      const entries = await repository.listEntries({
        workspaceId,
        teamId,
        from: from.toISOString(),
        to: to.toISOString(),
      })
      return entries
        .filter((entry) => entry.status === 'draft' || entry.status === 'rejected')
        .map((entry) => ({
          entryId: entry.id,
          memberKey: entry.userId.toLowerCase(),
          startAt: entry.startAt,
          endAt: entry.endAt,
        }))
    },
  }
}

/**
 * Adapts the time tracking repository to the projection's timesheet reminder revalidator.
 *
 * @param repository - Time entry repository.
 * @returns Revalidator that reads the named entries until one is still unsubmitted.
 */
export function createTimesheetReminderRevalidator(
  repository: Pick<TimeTrackingRepository, 'getEntry'>,
): TimesheetReminderRevalidator {
  return {
    async hasUnsubmittedEntry(input) {
      for (const entryId of input.entryIds) {
        const entry = await repository.getEntry(input.workspaceId, input.teamId, entryId)
        if (
          entry &&
          entry.userId.toLowerCase() === input.memberKey &&
          (entry.status === 'draft' || entry.status === 'rejected')
        ) {
          return true
        }
      }
      return false
    },
  }
}
