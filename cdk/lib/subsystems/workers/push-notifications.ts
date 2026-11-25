import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { ScheduledJobGrant } from './scheduled-jobs';
import type { ScheduleWorkerInput } from './schedules';

/** Secrets Manager name the operator stores the VAPID private key under. */
export const WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_ID = 'mukuroji/web-push/vapid-private-key';

/** Inputs for the Web Push notification job. */
export interface PushNotificationJobInput extends ScheduleWorkerInput {
  /** Web application origin that resolves deep links and serves as the VAPID contact. */
  readonly webOrigin: string;
}

/**
 * Defines the every-minute job that drains the sparse Web Push delivery queue.
 *
 * The job reads the queue, the VAPID private key secret, and calls push services only when
 * `WebPushVapidPublicKey` is set; with the default empty value it returns without any read.
 *
 * @param scope - Stack scope used to preserve stable construct identities.
 * @param input - Shared storage, configuration, and the web origin.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function definePushNotificationJob(
  scope: cdk.Stack,
  input: PushNotificationJobInput,
): ScheduledJobGrant {
  const stores = input.dataStores;
  const parameters = input.parameters;
  new cloudwatch.Alarm(scope, 'PushNotificationBacklogAlarm', {
    alarmDescription: 'Web Push notifications have remained overdue by at least 15 minutes for three consecutive runs; inspect the VAPID secret and push service failures.',
    metric: new cloudwatch.Metric({
      namespace: 'Mukuroji/Notifications', metricName: 'OldestDueAgeSeconds',
      dimensionsMap: { Channel: 'Push' }, statistic: 'Maximum', period: cdk.Duration.minutes(1),
    }),
    threshold: 900, evaluationPeriods: 3, datapointsToAlarm: 3,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return {
    id: 'PushNotification',
    runtimeScope: 'notification-schedule',
    environment: {
      WEB_PUSH_VAPID_PUBLIC_KEY: parameters.webPushVapidPublicKey.valueAsString,
      WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_ID: WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_ID,
      NOTIFICATION_PUSH_APP_ORIGIN: input.webOrigin,
      PUSH_SUBSCRIPTIONS_TABLE_NAME: stores.pushSubscriptionsTable.tableName,
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
        actions: ['dynamodb:Query'], resources: [`${stores.notificationsTable.tableArn}/index/PushDeliveryIndex`],
      }));
      // Devices are listed and their owner records read; only gone registrations are deleted.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:DeleteItem'], resources: [stores.pushSubscriptionsTable.tableArn],
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
        actions: ['cognito-idp:AdminListGroupsForUser'], resources: [parameters.cognitoUserPoolArn],
      }));
      // Only the one VAPID private key secret; the trailing wildcard is the ARN's random suffix.
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [scope.formatArn({
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME, service: 'secretsmanager', resource: 'secret',
          resourceName: `${WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_ID}-??????`,
        })],
      }));
    },
  };
}
