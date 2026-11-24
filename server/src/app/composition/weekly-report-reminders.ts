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
    /** Tenant lifecycle; a closing or closed Workspace is not reminded. */
    status: 'active' | 'closing' | 'closed'
    /** Saved calendar settings; absent until the Workspace saves its own. */
    calendar?: WorkspaceCalendarSettings
    /** Saved reminder settings; absent until the Workspace saves its own. */
    weeklyReportReminders?: WeeklyReportReminderSettings
  } | undefined>
  /** Lists a Workspace's Team rosters from the Project Directory. */
  readTeamRosters(workspaceId: string): Promise<WeeklyReportTeamRoster[]>
  /**
   * Reads members' display names, deactivated members included, by lower-cased member key;
   * undefined means no name.
   * Project member rows keep the name they were written with, so these names replace them.
   */
  readMemberNames?(workspaceId: string): Promise<ReadonlyMap<string, string | undefined>>
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
      const reminders = profile?.weeklyReportReminders ?? DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS
      const calendar = profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS
      return {
        weekStartDay: calendar.weekStartDay,
        timeZone: calendar.timeZone,
        // A Workspace being closed keeps its settings but is no longer reminded.
        reminders: profile && profile.status !== 'active' ? { ...reminders, enabled: false } : reminders,
      }
    },
    async readTeamRosters(workspaceId) {
      const rosters = await sources.readTeamRosters(workspaceId)
      if (!sources.readMemberNames) return rosters
      const names = await sources.readMemberNames(workspaceId)
      return rosters.map((roster) => applyMemberNames(roster, names))
    },
    async readSubmittedMembers(workspaceId, teamId, memberKeys, weekStart) {
      const weeks = await sources.store.getWeeks({ workspaceId, teamId }, memberKeys, weekStart)
      return new Set([...weeks].flatMap(([memberKey, week]) => week.submissionCount > 0 ? [memberKey] : []))
    },
  }
}

/**
 * Builds the weekly report reader's member name source from the Workspace member rows.
 *
 * Deactivated members are read too: a Project member row can outlive the Workspace membership, and
 * that writer must still be named by its current name rather than the one the Project row kept.
 *
 * @param workspaceAccess - Workspace member store.
 * @returns Reader of display names by lower-cased member key; undefined means no name.
 */
export function createWorkspaceMemberNameReader(
  workspaceAccess: {
    /** Lists every member row of a Workspace, deactivated members included. */
    listMembers(workspaceId: string): Promise<readonly { memberKey: string; name?: string }[]>
  },
): (workspaceId: string) => Promise<ReadonlyMap<string, string | undefined>> {
  return async (workspaceId) => new Map(
    (await workspaceAccess.listMembers(workspaceId)).map((member) => [
      member.memberKey.trim().toLowerCase(),
      member.name?.trim() || undefined,
    ]),
  )
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

/**
 * Replaces the writer names of a roster with the Workspace member names.
 *
 * @param roster - Roster read from the Project Directory.
 * @param names - Display names by lower-cased member key.
 * @returns The roster with current names; a writer missing from the map keeps its Project name.
 */
function applyMemberNames(
  roster: WeeklyReportTeamRoster,
  names: ReadonlyMap<string, string | undefined>,
): WeeklyReportTeamRoster {
  return {
    ...roster,
    projects: roster.projects.map((project) => ({
      ...project,
      writers: project.writers.map((writer) => {
        const key = writer.memberKey.toLowerCase()
        if (!names.has(key)) return writer
        const { displayName: _projectName, ...rest } = writer
        const name = names.get(key)
        return name ? { ...rest, displayName: name } : rest
      }),
    })),
  }
}
