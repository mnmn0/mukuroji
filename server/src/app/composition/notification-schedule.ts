import {
  createDynamoDbBudgetAlertProjectReader,
  createDynamoDbMemberProjectReader,
  createDynamoDbProjectManagerReader,
  createDynamoDbScheduledWorkItemSource,
  createDynamoDbWeeklyReportRosterReader,
  createNotificationScheduleHandler,
  type ScheduledMemberAccessExpiryReader,
} from '../../modules/notifications'
import { DynamoDbTenantAdministrationClient } from '../../modules/tenant-administration'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access/workspace-access'
import { DynamoDbWeeklyReportStore } from '../../modules/weekly-reports'
import { createWeeklyReportReader, createWorkspaceMemberNameReader } from './weekly-report-reminders'
import { DynamoDbReminderSettingsStore } from '../../modules/notifications/adapter-out/dynamodb/reminder-settings-store'
import { DynamoDbTimeTrackingRepository } from '../../modules/time-tracking'
import { createTimesheetReader } from './timesheet-reminders'
import { createBudgetThresholdReader } from './budget-threshold-alerts'
import { DynamoDbProjectExpenseStore } from '../../modules/project-budget'
import { DynamoDbEnterpriseIdentityReadClient } from '../../modules/enterprise-identity'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import {
  DynamoDbCustomerClient,
  type CustomerRetentionClient,
} from '../../modules/customers'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import type {
  NotificationScheduleEvent,
  NotificationScheduleResult,
} from '../../modules/notifications/adapter-in/schedules/notification-schedule'

/**
 * Builds the reader of members whose access ends soon for the notification schedule.
 *
 * @param workspaceAccess - Lists members whose access ends at or before an instant.
 * @param readMemberProjects - Reads a member's active Projects and their managers.
 * @returns The reader the schedule uses for access expiry notices (ADR 0095).
 */
export function createMemberAccessExpiryReader(
  workspaceAccess: Pick<DynamoDbWorkspaceAccessClient, 'listMembersWithAccessExpiringBefore'>,
  readMemberProjects: ScheduledMemberAccessExpiryReader['readMemberProjects'],
): ScheduledMemberAccessExpiryReader {
  return {
    async listMembersExpiringBetween(after, before) {
      return (await workspaceAccess.listMembersWithAccessExpiringBefore(before))
        .flatMap(({ workspaceId, member }) => {
          const accessExpiresAt = member.accessExpiresAt
          if (accessExpiresAt === undefined || Date.parse(accessExpiresAt) <= after.getTime()) return []
          const displayName = member.name?.trim()
          return [{
            workspaceId,
            memberKey: member.memberKey,
            ...(displayName ? { displayName } : {}),
            accessExpiresAt,
          }]
        })
    },
    readMemberProjects,
  }
}

/** Runs retention independently so a Customer failure cannot suppress notifications. */
export function createRetentionAwareNotificationScheduleHandler(
  retentionClient: Pick<CustomerRetentionClient, 'sweepExpiredRetention'>,
  notificationHandler: (
    event: NotificationScheduleEvent,
  ) => Promise<NotificationScheduleResult>,
): (event?: NotificationScheduleEvent) => Promise<NotificationScheduleResult> {
  return async (event: NotificationScheduleEvent = {}) => {
    let retentionError: unknown
    let retentionFailed = false
    try {
      await retentionClient.sweepExpiredRetention(event.time)
    } catch (error) {
      retentionFailed = true
      retentionError = error
      console.error(
        'Customer retention sweep failed; continuing notification delivery.',
        error instanceof Error ? error.name : 'unknown error',
      )
    }
    const result = await notificationHandler(event)
    if (retentionFailed) throw retentionError
    return result
  }
}

/**
 * Creates the production Notification schedule handler.
 *
 * @returns A handler for due notifications and time-driven Customer retention.
 */
export function createProductionNotificationScheduleHandler() {
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const customerClient = new DynamoDbCustomerClient({ documentClient })
  const environment = loadServerConfig().environment
  const projectDirectoryTableName = environment.PROJECT_DIRECTORY_TABLE_NAME?.trim()
  if (!projectDirectoryTableName) throw new Error('PROJECT_DIRECTORY_TABLE_NAME is required.')
  const notificationsTableName = environment.NOTIFICATIONS_TABLE_NAME?.trim()
  if (!notificationsTableName) throw new Error('NOTIFICATIONS_TABLE_NAME is required.')
  const analyticsTableName = environment.ANALYTICS_TABLE_NAME?.trim()
  if (!analyticsTableName) throw new Error('ANALYTICS_TABLE_NAME is required.')
  const workItemsTableName = environment.WORK_ITEMS_TABLE_NAME?.trim()
  if (!workItemsTableName) throw new Error('WORK_ITEMS_TABLE_NAME is required.')
  const planningTableName = environment.PLANNING_TABLE_NAME?.trim()
  if (!planningTableName) throw new Error('PLANNING_TABLE_NAME is required.')
  const tenantAdministrationTableName = environment.TENANT_ADMINISTRATION_TABLE_NAME?.trim()
  if (!tenantAdministrationTableName) throw new Error('TENANT_ADMINISTRATION_TABLE_NAME is required.')
  const tenantAdministration = new DynamoDbTenantAdministrationClient(tenantAdministrationTableName, documentClient)
  const workspaceAccessTableName = environment.WORKSPACE_ACCESS_TABLE_NAME?.trim()
  if (!workspaceAccessTableName) throw new Error('WORKSPACE_ACCESS_TABLE_NAME is required.')
  // Read-only: the schedule lists active members for their current display names (ADR 0074)
  // and members whose access ends soon (ADR 0095).
  const workspaceAccess = new DynamoDbWorkspaceAccessClient(workspaceAccessTableName, documentClient)
  const timeTrackingRepository = new DynamoDbTimeTrackingRepository(analyticsTableName, documentClient)
  // Read-only: the schedule reads budgets, entries, and expenses to check budget use (ADR 0105).
  const projectExpenses = new DynamoDbProjectExpenseStore(planningTableName, documentClient)
  // Read-only: Enterprise roles can make a member a Project manager who gets budget alerts.
  const enterpriseIdentityTableName = environment.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const enterpriseIdentity = enterpriseIdentityTableName
    ? new DynamoDbEnterpriseIdentityReadClient(enterpriseIdentityTableName, documentClient)
    : undefined
  const notificationHandler = createNotificationScheduleHandler(
    documentClient,
    createDynamoDbScheduledWorkItemSource({
      documentClient,
      workItemsTableName,
      projectDirectoryTableName,
    }),
    async ({ workspaceId, teamId, workItemId }) => {
      await customerClient.prepareCompletionNotifications(
        workspaceId,
        teamId,
        workItemId,
        'system:customer-completion-schedule',
      )
    },
    createDynamoDbProjectManagerReader({
      documentClient,
      tableName: projectDirectoryTableName,
    }),
    new DynamoDbReminderSettingsStore(documentClient, notificationsTableName),
    createTimesheetReader(timeTrackingRepository),
    createWeeklyReportReader({
      store: new DynamoDbWeeklyReportStore(planningTableName, documentClient),
      readProfile: async (workspaceId) => await tenantAdministration.getProfile(workspaceId),
      readTeamRosters: createDynamoDbWeeklyReportRosterReader({
        documentClient,
        tableName: projectDirectoryTableName,
      }),
      readMemberNames: createWorkspaceMemberNameReader(workspaceAccess),
    }),
    createMemberAccessExpiryReader(
      workspaceAccess,
      createDynamoDbMemberProjectReader({ documentClient, tableName: projectDirectoryTableName }),
    ),
    createBudgetThresholdReader({
      readProjects: createDynamoDbBudgetAlertProjectReader({ documentClient, tableName: projectDirectoryTableName }),
      readProfile: async (workspaceId) => await tenantAdministration.getProfile(workspaceId),
      getBudget: async (workspaceId, teamId, projectId) =>
        await timeTrackingRepository.getBudget(workspaceId, teamId, 'project', projectId),
      listEntries: async (input) => await timeTrackingRepository.listEntries({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        ...(input.from === undefined ? {} : { from: input.from }),
        to: input.to,
        projectIds: new Set([input.projectId]),
      }),
      listExpenses: async (workspaceId, teamId, projectId) =>
        await projectExpenses.list({ workspaceId, teamId, projectId }),
      listWorkspaceMembers: async (workspaceId) => await workspaceAccess.listMembers(workspaceId),
      ...(enterpriseIdentity
        ? { readEnterpriseSnapshot: async (workspaceId: string) => await enterpriseIdentity.getSnapshot(workspaceId) }
        : {}),
    }),
  )
  return createRetentionAwareNotificationScheduleHandler(
    customerClient,
    notificationHandler,
  )
}
