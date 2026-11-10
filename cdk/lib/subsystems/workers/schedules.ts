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
 * Defines the five-minute job that delivers due saved analytics reports.
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
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
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
    auditEventsTable,
    customersTable,
    planningTable,
    projectDirectoryTable,
    workItemsTable,
  } = input.dataStores;
  const { auditRetentionDays } = input.parameters;

  return {
    id: 'NotificationSchedule',
    runtimeScope: 'notification-schedule',
    environment: {
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
      CUSTOMERS_TABLE_NAME: customersTable.tableName,
      NOTIFICATION_SCHEDULE_MAX_PAGES: '1000',
      NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE: '100',
      PLANNING_TABLE_NAME: planningTable.tableName,
      PLANNING_UPDATE_SCHEDULE_INDEX_NAME: 'UpdateScheduleDueIndex',
      PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
      WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
    },
    grant: (grantee) => {
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [planningTable.tableArn],
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
    },
  };
}
