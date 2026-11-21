import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS,
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  type WeeklyReportReminderSettings,
  type WorkspaceCalendarSettings,
} from '@mukuroji/contracts'
import type { WeeklyReportReminderRevalidator } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import type { ScheduledWeeklyReportReader, WeeklyReportTeamRoster } from '../../modules/notifications'
import {
  DynamoDbWeeklyReportStore,
  createWeeklyReportUnsubmittedCondition,
  type WeeklyReportStore,
} from '../../modules/weekly-reports'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'

/** Sources the schedule's weekly report reader is assembled from. */
export type WeeklyReportReaderSources = {
  /** Weekly report rows. */
  store: Pick<WeeklyReportStore, 'getWeeks'>
  /** Reads a Workspace's tenant profile, which holds its calendar and reminder settings. */
  readProfile(workspaceId: string): Promise<{
    /** Saved calendar settings; absent until the Workspace saves its own. */
    calendar?: WorkspaceCalendarSettings
    /** Saved reminder settings; absent until the Workspace saves its own. */
    weeklyReportReminders?: WeeklyReportReminderSettings
  } | undefined>
  /** Lists a Workspace's Team rosters from the Project Directory. */
  readTeamRosters(workspaceId: string): Promise<WeeklyReportTeamRoster[]>
}

/**
 * Adapts the weekly report store, tenant profiles, and Project Directory to the schedule's reader.
 *
 * @param sources - Store, profile reader, and roster reader.
 * @returns Reader of week start days, rosters, and submitted members.
 */
export function createWeeklyReportReader(sources: WeeklyReportReaderSources): ScheduledWeeklyReportReader {
  return {
    async readWorkspaceSettings(workspaceId) {
      const profile = await sources.readProfile(workspaceId)
      return {
        weekStartDay: (profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS).weekStartDay,
        reminders: profile?.weeklyReportReminders ?? DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS,
      }
    },
    readTeamRosters: sources.readTeamRosters,
    async readSubmittedMembers(workspaceId, teamId, memberKeys, weekStart) {
      const weeks = await sources.store.getWeeks({ workspaceId, teamId }, memberKeys, weekStart)
      return new Set([...weeks].flatMap(([memberKey, week]) => week.submissionCount > 0 ? [memberKey] : []))
    },
  }
}

/**
 * Adapts the weekly report store to the projection's reminder revalidator.
 *
 * @param store - Weekly report store.
 * @param tableName - Planning table that holds the weeks, for the transaction condition.
 * @returns Revalidator that reads the author's week and fences it while it stays unsubmitted.
 */
export function createWeeklyReportReminderRevalidator(
  store: Pick<WeeklyReportStore, 'getWeek'>,
  tableName: string,
): WeeklyReportReminderRevalidator {
  return {
    async findUnsubmittedWeek(input) {
      const scope = { workspaceId: input.workspaceId, teamId: input.teamId, memberKey: input.memberKey }
      const week = await store.getWeek(scope, input.weekStart)
      if (week && week.submissionCount > 0) return undefined
      return createWeeklyReportUnsubmittedCondition(tableName, scope, input.weekStart)
    },
  }
}

/**
 * Builds the projection's weekly report reminder revalidator over the Planning table.
 *
 * @param planningTableName - Planning table that holds weekly reports, when configured.
 * @param documentClient - Document client; a new one by default.
 * @returns The revalidator, or undefined so weekly report reminders are dropped (fail closed).
 */
export function createConfiguredWeeklyReportReminderRevalidator(
  planningTableName: string | undefined,
  documentClient?: DynamoDBDocumentClient,
): WeeklyReportReminderRevalidator | undefined {
  if (!planningTableName) return undefined
  return createWeeklyReportReminderRevalidator(
    new DynamoDbWeeklyReportStore(
      planningTableName,
      documentClient ?? createDynamoDbDocumentClient(createDynamoDbClient()),
    ),
    planningTableName,
  )
}
