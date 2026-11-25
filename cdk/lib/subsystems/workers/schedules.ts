import * as iam from 'aws-cdk-lib/aws-iam';
import type { StackParameters } from '../../config/stack-parameters';
import type { DataStoreResources } from '../data-stores';
import { grantPlanningRevisionFenceAccess } from '../../policies/planning-revision-fence';
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
    workspaceAccessTable,
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
      WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
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
      // Members' current display names for weekly report reminders (ADR 0074), and the members
      // whose access ends soon for access expiry notices (ADR 0095).
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:Scan'],
        resources: [workspaceAccessTable.tableArn],
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
 * Defines the quarter-hourly job that delivers the daily / weekly Update digests members opted
 * into as one Inbox notification each (ADR 0066).
 *
 * The worker finds due members through the sparse `InboxDigestDueIndex`, rechecks each member's
 * current access with the same reads as the API's Update Feed, and commits the digest receipt and
 * the Inbox row in one transaction fenced by the member's current access rows.
 *
 * @param input Shared data stores and parameters.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineInboxDigestJob(input: ScheduleWorkerInput): ScheduledJobGrant {
  const {
    collaborationTable,
    enterpriseIdentityTable,
    notificationsTable,
    planningTable,
    projectDirectoryTable,
    tenantAdministrationTable,
    workspaceAccessTable,
  } = input.dataStores;
  const {
    cognitoUserPoolArn,
    cognitoUserPoolClientId,
    cognitoUserPoolId,
    inboxDigestDeliveryEnabled,
    systemAdminGroups,
  } = input.parameters;

  return {
    id: 'InboxDigest',
    runtimeScope: 'notification-schedule',
    // The role already holds ten managed policies with every optional module on.
    policy: 'shared-role',
    environment: {
      COGNITO_CLIENT_ID: cognitoUserPoolClientId,
      COGNITO_USER_POOL_ID: cognitoUserPoolId,
      COLLABORATION_TABLE_NAME: collaborationTable.tableName,
      ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
      INBOX_DIGEST_WORKER_ENABLED: inboxDigestDeliveryEnabled.valueAsString,
      NOTIFICATIONS_TABLE_NAME: notificationsTable.tableName,
      PLANNING_TABLE_NAME: planningTable.tableName,
      PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
      SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
      WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
    },
    grant: (grantee) => {
      // The Update Feed reads the Planning graph, read state and saved feeds; the worker writes
      // only its digest, checkpoint, deferred and failure rows, each in a conditional transaction.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'dynamodb:BatchGetItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
        ],
        resources: [planningTable.tableArn],
      }));
      // Deletes only remove settled deferred rows from the worker's own system partition.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:DeleteItem'],
        resources: [planningTable.tableArn],
        conditions: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['SYSTEM#INBOX_DIGEST'] },
        },
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${planningTable.tableArn}/index/InboxDigestDueIndex`],
      }));
      // The member's channel preference fences the transaction that inserts the Inbox row.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [notificationsTable.tableArn],
      }));
      // Current membership, Enterprise policy, tenant state, Projects and watchers decide what
      // the member may still read, and fence the delivery transaction.
      for (const table of [
        collaborationTable,
        enterpriseIdentityTable,
        projectDirectoryTable,
        tenantAdministrationTable,
        workspaceAccessTable,
      ]) {
        grantee.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: [
            'dynamodb:BatchGetItem',
            'dynamodb:ConditionCheckItem',
            'dynamodb:GetItem',
            'dynamodb:Query',
          ],
          resources: [table.tableArn],
        }));
      }
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        // Current groups decide whether the member is a system administrator.
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [cognitoUserPoolArn],
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

/**
 * Defines the hourly job that deactivates members whose access expiry has passed (ADR 0095).
 *
 * The job reads the Project directory, Planning owners, and private Document managers to leave
 * active a member who still manages or owns something, and writes the deactivation in one
 * transaction fenced by the Planning revision, the Document ACL generation, and the tenant state.
 *
 * @param input Shared data stores and parameters.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineMemberAccessExpiryJob(input: ScheduleWorkerInput): ScheduledJobGrant {
  const {
    auditEventsTable,
    documentsTable,
    planningTable,
    projectDirectoryTable,
    tenantAdministrationTable,
    workspaceAccessTable,
    workspaceAuditPseudonymSecret,
  } = input.dataStores;
  const { apiRuntimeConfigurationRevision, auditRetentionDays } = input.parameters;

  return {
    id: 'MemberAccessExpiry',
    runtimeScope: 'notification-schedule',
    // The role already holds ten managed policies with every optional module on.
    policy: 'shared-role',
    environment: {
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
      DOCUMENTS_TABLE_NAME: documentsTable.tableName,
      // Secret ARN only: the job reads the value at cold start, and a new revision replaces
      // warm environments that cached the old one.
      MUKUROJI_WORKER_SECRET_REVISION: apiRuntimeConfigurationRevision.valueAsString,
      MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY_SECRET_ARN: workspaceAuditPseudonymSecret.secretArn,
      PLANNING_TABLE_NAME: planningTable.tableName,
      PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
      WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
    },
    grant: (grantee) => {
      workspaceAuditPseudonymSecret.grantRead(grantee);
      // Expired members are found by a filtered scan; the deactivation is a member row update.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem'],
        resources: [workspaceAccessTable.tableArn],
      }));
      // Planning owners and the Document managers are read; their revisions fence the write.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [planningTable.tableArn, documentsTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [documentsTable.tableArn],
        conditions: {
          StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
        },
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [planningTable.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['FENCE#*'] },
          StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
        },
      }));
      grantPlanningRevisionFenceAccess(planningTable, grantee);
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [projectDirectoryTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [auditEventsTable.tableArn],
      }));
      // A closing tenant refuses the membership write inside the same transaction.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem', 'dynamodb:GetItem'],
        resources: [tenantAdministrationTable.tableArn],
      }));
    },
  };
}
