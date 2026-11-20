import type { TimesheetReminderRevalidator } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import type { ScheduledTimesheetReader } from '../../modules/notifications'
import {
  DynamoDbTimeTrackingRepository,
  createTimeEntryRevisionCondition,
  type TimeTrackingRepository,
} from '../../modules/time-tracking'
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
      // Entries without a Project are left out: the timesheet a member opens from the reminder
      // lists and submits only Project entries, so they could never clear the reminder there.
      return entries.flatMap((entry) =>
        (entry.status === 'draft' || entry.status === 'rejected') && entry.projectId !== undefined
          ? [{
              entryId: entry.id,
              memberKey: entry.userId.toLowerCase(),
              projectId: entry.projectId,
              startAt: entry.startAt,
              endAt: entry.endAt,
            }]
          : [])
    },
  }
}

/**
 * Adapts the time tracking repository to the projection's timesheet reminder revalidator.
 *
 * @param repository - Time entry repository.
 * @param tableName - Analytics table that stores the entries, for the transaction condition.
 * @returns Revalidator that reads the named entries until one is still unsubmitted.
 */
export function createTimesheetReminderRevalidator(
  repository: Pick<TimeTrackingRepository, 'getEntry'>,
  tableName: string,
): TimesheetReminderRevalidator {
  return {
    async findUnsubmittedEntry(input) {
      for (const entryId of input.entryIds) {
        const entry = await repository.getEntry(input.workspaceId, input.teamId, entryId)
        if (
          entry &&
          entry.userId.toLowerCase() === input.memberKey &&
          // An entry moved to another Project no longer belongs to the Project this reminder is for.
          entry.projectId === input.projectId &&
          (entry.status === 'draft' || entry.status === 'rejected') &&
          // An entry whose dates were corrected after the scan must still be past the threshold.
          Date.parse(entry.endAt) <= Date.parse(input.dueBefore)
        ) {
          return createTimeEntryRevisionCondition(
            tableName,
            input.workspaceId,
            input.teamId,
            entry.id,
            entry.revision,
          )
        }
      }
      return undefined
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
  return createTimesheetReminderRevalidator(
    new DynamoDbTimeTrackingRepository(
      analyticsTableName,
      createDynamoDbDocumentClient(createDynamoDbClient()),
    ),
    analyticsTableName,
  )
}
