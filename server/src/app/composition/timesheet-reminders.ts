import type { TimesheetReminderRevalidator } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import type { ScheduledTimesheetReader } from '../../modules/notifications'
import { DynamoDbTimeTrackingRepository, type TimeTrackingRepository } from '../../modules/time-tracking'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'

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

/**
 * Builds the projection's timesheet reminder revalidator over the Analytics table.
 *
 * @param analyticsTableName - Analytics table that holds time entries, when configured.
 * @returns The revalidator, or undefined so timesheet reminders are dropped (fail closed).
 */
export function createConfiguredTimesheetReminderRevalidator(
  analyticsTableName: string | undefined,
): TimesheetReminderRevalidator | undefined {
  if (!analyticsTableName) return undefined
  return createTimesheetReminderRevalidator(new DynamoDbTimeTrackingRepository(
    analyticsTableName,
    createDynamoDbDocumentClient(createDynamoDbClient()),
  ))
}
