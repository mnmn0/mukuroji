import * as iam from 'aws-cdk-lib/aws-iam';
import type { StackParameters } from '../../config/stack-parameters';
import type { DataStoreResources } from '../data-stores';
import type { ScheduledJobGrant } from './scheduled-jobs';

/**
 * Inputs required by the scheduled jobs.
 */
export interface ScheduleWorkerInput {
  /** Shared data stores read or written by scheduled processing. */
  readonly dataStores: DataStoreResources;
  /** Stack parameters used for authorization and retention. */
  readonly parameters: StackParameters;
}

/**
 * Defines the five-minute job that delivers due saved analytics reports and notifies recipients.
 *
 * @param input Shared data stores and parameters.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineAnalyticsScheduleJob(input: ScheduleWorkerInput): ScheduledJobGrant {
  const {
    analyticsTable,
    auditEventsTable,
    projectDirectoryTable,
    tenantAdministrationTable,
    workItemsTable,
    workspaceAccessTable,
  } = input.dataStores;
  const {
    auditRetentionDays,
    cognitoUserPoolArn,
    cognitoUserPoolClientId,
    cognitoUserPoolId,
    systemAdminGroups,
  } = input.parameters;

  return {
    id: 'AnalyticsSchedule',
    runtimeScope: 'analytics-schedule',
    environment: {
      ANALYTICS_SCHEDULE_INDEX_NAME: 'ScheduleDueIndex',
      ANALYTICS_TABLE_NAME: analyticsTable.tableName,
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
      COGNITO_CLIENT_ID: cognitoUserPoolClientId,
      COGNITO_USER_POOL_ID: cognitoUserPoolId,
      PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
      WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
      SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
      WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
    },
    grant: (grantee) => {
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        // BatchGetItem reads per-Work-Item history rows for scheduled reports (ADR 0042).
        actions: ['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [analyticsTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${analyticsTable.tableArn}/index/ScheduleDueIndex`],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [cognitoUserPoolArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${auditEventsTable.tableArn}/index/EntityOccurredAtIndex`],
      }));
      // Each delivered recipient gets one conditional audit outbox event, which the
      // collaboration projection turns into an Inbox notification.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [auditEventsTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [projectDirectoryTable.tableArn, workItemsTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [workspaceAccessTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [tenantAdministrationTable.tableArn],
      }));
    },
  };
}

/**
 * Defines the hourly job that emits scheduled notifications and applies Customer retention.
 *
 * @param input Shared data stores and parameters.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineNotificationScheduleJob(input: ScheduleWorkerInput): ScheduledJobGrant {
  const {
    analyticsTable,
    auditEventsTable,
    customersTable,
    notificationsTable,
    planningTable,
    projectDirectoryTable,
    tenantAdministrationTable,
    workItemsTable,
  } = input.dataStores;
  const { auditRetentionDays, notificationReminderDefaultDays } = input.parameters;

  return {
    id: 'NotificationSchedule',
    runtimeScope: 'notification-schedule',
    environment: {
      ANALYTICS_TABLE_NAME: analyticsTable.tableName,
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
      CUSTOMERS_TABLE_NAME: customersTable.tableName,
      // The same parameter feeds the API, which shows these defaults in the Team settings.
      NOTIFICATION_REMINDER_DEFAULT_DAYS: notificationReminderDefaultDays.valueAsString,
      NOTIFICATION_SCHEDULE_MAX_PAGES: '1000',
      NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE: '100',
      NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
      PLANNING_TABLE_NAME: planningTable.tableName,
      PLANNING_UPDATE_SCHEDULE_INDEX_NAME: 'UpdateScheduleDueIndex',
      PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
      WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
    },
    grant: (grantee) => {
      // Planning update targets, and the weekly report rows that decide who is reminded.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'],
        resources: [planningTable.tableArn],
      }));
      // The Workspace week start day decides which week a weekly report reminder is about.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [tenantAdministrationTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${planningTable.tableArn}/index/UpdateScheduleDueIndex`],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [planningTable.tableArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'dynamodb:Attributes': [
              'workspaceId',
              'recordKey',
              'nextNotificationAtRecordKey',
              'updateScheduleShard',
              'updatedAt',
            ],
          },
        },
      }));
      projectDirectoryTable.grants.readData(grantee);
      workItemsTable.grants.readData(grantee);
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [workItemsTable.tableArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'dynamodb:Attributes': [
              'directoryTeamId',
              'issueId',
              'customerCompletionPreparationAt',
              'customerCompletionPreparationRevision',
            ],
          },
        },
      }));
      auditEventsTable.grants.writeData(grantee);
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:TransactWriteItems'],
        resources: [customersTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [customersTable.tableArn, `${customersTable.tableArn}/index/CustomerRetentionIndex`],
      }));
      // Team and personal reminder overrides.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [notificationsTable.tableArn],
      }));
      // Unsubmitted time entries for timesheet reminders.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${analyticsTable.tableArn}/index/TimeEntryTeamDateIndex`],
      }));
    },
  };
}

/**
 * Defines the hourly job that creates next Cycles and carries over unfinished Work Items.
 *
 * @param input Shared data stores and parameters.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineCycleScheduleJob(input: ScheduleWorkerInput): ScheduledJobGrant {
  const { planningTable, workItemsTable } = input.dataStores;

  return {
    id: 'CycleSchedule',
    runtimeScope: 'automation-schedule',
    // Three small statements; the inline policy keeps the shared role within ten managed policies.
    policy: 'shared-role',
    environment: {
      PLANNING_TABLE_NAME: planningTable.tableName,
      PLANNING_UPDATE_SCHEDULE_INDEX_NAME: 'UpdateScheduleDueIndex',
      WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
    },
    grant: (grantee) => {
      // The Planning graph is read and committed with the same META revision CAS as the API.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
        ],
        resources: [planningTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${planningTable.tableArn}/index/UpdateScheduleDueIndex`],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'],
        resources: [workItemsTable.tableArn],
      }));
    },
  };
}

/**
 * Defines the six-hourly job that stores the Cabinet Office national holiday list once a month.
 *
 * The list goes in one shared row of the tenant administration table, which the API reads when it
 * builds a new Work Item's calendar. The job may write only that row, and it reaches the Cabinet
 * Office over the Lambda's default internet access.
 *
 * @param input Shared data stores and parameters.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineJapanesePublicHolidaySyncJob(input: ScheduleWorkerInput): ScheduledJobGrant {
  const { tenantAdministrationTable } = input.dataStores;

  return {
    id: 'JapanesePublicHolidaySync',
    runtimeScope: 'automation-schedule',
    // One statement, so it stays in the shared role's inline policy.
    policy: 'shared-role',
    environment: {
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
    },
    grant: (grantee) => {
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [tenantAdministrationTable.tableArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'dynamodb:LeadingKeys': ['system#public-holidays'],
          },
        },
      }));
    },
  };
}
