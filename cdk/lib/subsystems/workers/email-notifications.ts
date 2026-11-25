import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as ses from 'aws-cdk-lib/aws-ses';
import type { ScheduledJobGrant } from './scheduled-jobs';
import type { ScheduleWorkerInput } from './schedules';

/** Inputs for the Email notification job. */
export interface EmailNotificationJobInput extends ScheduleWorkerInput {
  /** Web application origin that resolves Inbox deep links in the message. */
  readonly webOrigin: string;
  /** Configuration set that publishes bounces and complaints to the feedback job. */
  readonly configurationSet: ses.IConfigurationSet;
}

/**
 * Defines the every-minute job that drains the sparse Email delivery queue through SES.
 *
 * The job reads the queue and calls SES only when `NotificationEmailSender` is set; with the
 * default empty value it returns without any read, so the opt-in needs no separate module.
 *
 * @param scope - Stack scope used to preserve stable construct identities.
 * @param input - Shared storage, configuration, and the web origin.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineEmailNotificationJob(
  scope: cdk.Stack,
  input: EmailNotificationJobInput,
): ScheduledJobGrant {
  const stores = input.dataStores;
  const parameters = input.parameters;
  new cloudwatch.Alarm(scope, 'EmailNotificationBacklogAlarm', {
    alarmDescription: 'Email notifications have remained overdue by at least 15 minutes for three consecutive runs; inspect SES sending limits and delivery failures.',
    metric: new cloudwatch.Metric({
      namespace: 'Mukuroji/Notifications', metricName: 'OldestDueAgeSeconds',
      dimensionsMap: { Channel: 'Email' }, statistic: 'Maximum', period: cdk.Duration.minutes(1),
    }),
    threshold: 900, evaluationPeriods: 3, datapointsToAlarm: 3,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return {
    id: 'EmailNotification',
    runtimeScope: 'notification-schedule',
    environment: {
      NOTIFICATION_EMAIL_SENDER: parameters.notificationEmailSender.valueAsString,
      NOTIFICATION_EMAIL_APP_ORIGIN: input.webOrigin,
      NOTIFICATION_EMAIL_CONFIGURATION_SET: input.configurationSet.configurationSetName,
      // Timesheet reminders reread their time entries before they are sent.
      ANALYTICS_TABLE_NAME: stores.analyticsTable.tableName,
      NOTIFICATIONS_TABLE_NAME: stores.notificationsTable.tableName,
      ENTERPRISE_IDENTITY_TABLE_NAME: stores.enterpriseIdentityTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME: stores.tenantAdministrationTable.tableName,
      PROJECT_DIRECTORY_TABLE_NAME: stores.projectDirectoryTable.tableName,
      WORKSPACE_ACCESS_TABLE_NAME: stores.workspaceAccessTable.tableName,
      WORK_ITEMS_TABLE_NAME: stores.workItemsTable.tableName,
      PLANNING_TABLE_NAME: stores.planningTable.tableName,
      DOCUMENTS_TABLE_NAME: stores.documentsTable.tableName,
      REQUEST_INTAKE_TABLE_NAME: stores.requestIntakeTable.tableName,
      COLLABORATION_TABLE_NAME: stores.collaborationTable.tableName,
      FILE_PROOFING_TABLE_NAME: stores.fileProofingTable.tableName,
      COGNITO_USER_POOL_ID: parameters.cognitoUserPoolId,
      SYSTEM_ADMIN_GROUPS: parameters.systemAdminGroups.valueAsString,
    },
    grant: (grantee) => {
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [stores.notificationsTable.tableArn],
      }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'], resources: [`${stores.notificationsTable.tableArn}/index/EmailDeliveryIndex`],
      }));
      for (const table of [stores.enterpriseIdentityTable, stores.tenantAdministrationTable, stores.workspaceAccessTable, stores.workItemsTable, stores.planningTable, stores.documentsTable]) {
        grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:Query'], resources: [table.tableArn] }));
      }
      // Directory memberships are queried; GetItem reads the recipient's language preference.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:Query'], resources: [stores.projectDirectoryTable.tableArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [stores.requestIntakeTable.tableArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [stores.collaborationTable.tableArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [stores.fileProofingTable.tableArn] }));
      // A timesheet reminder is sent only while one of its time entries is still unsubmitted.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [stores.analyticsTable.tableArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'], resources: [parameters.cognitoUserPoolArn],
      }));
      // SES authorizes the sending identity, which may be the address or its domain, and the
      // configuration set; the condition pins every message to the configured sender. An empty
      // sender matches nothing.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [
          scope.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' }),
          scope.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: input.configurationSet.configurationSetName }),
        ],
        conditions: { StringEquals: { 'ses:FromAddress': parameters.notificationEmailSender.valueAsString } },
      }));
    },
  };
}
