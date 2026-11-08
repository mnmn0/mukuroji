import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { ScheduledJobGrant } from './scheduled-jobs';
import type { ScheduleWorkerInput } from './schedules';

/**
 * Defines the every-minute job that drains the sparse Slack delivery queue.
 *
 * @param scope - Stack scope used to preserve stable construct identities.
 * @param input - Shared storage, configuration, and runtime controls.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineSlackNotificationJob(
  scope: cdk.Stack,
  input: ScheduleWorkerInput,
): ScheduledJobGrant {
  const stores = input.dataStores;
  const parameters = input.parameters;
  new cloudwatch.Alarm(scope, 'SlackNotificationBacklogAlarm', {
    alarmDescription: 'Slack notifications have remained overdue by at least 15 minutes for three consecutive runs; inspect queue capacity and delivery failures.',
    metric: new cloudwatch.Metric({
      namespace: 'Mukuroji/Notifications', metricName: 'OldestDueAgeSeconds',
      dimensionsMap: { Channel: 'Slack' }, statistic: 'Maximum', period: cdk.Duration.minutes(1),
    }),
    threshold: 900, evaluationPeriods: 3, datapointsToAlarm: 3,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return {
    id: 'SlackNotification',
    runtimeScope: 'notification-schedule',
    environment: {
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
        actions: ['dynamodb:Query'], resources: [`${stores.notificationsTable.tableArn}/index/SlackDeliveryIndex`],
      }));
      for (const table of [stores.enterpriseIdentityTable, stores.tenantAdministrationTable, stores.workspaceAccessTable, stores.workItemsTable, stores.planningTable, stores.documentsTable]) {
        grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:Query'], resources: [table.tableArn] }));
      }
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [stores.projectDirectoryTable.tableArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [stores.requestIntakeTable.tableArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [stores.collaborationTable.tableArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [stores.fileProofingTable.tableArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminListGroupsForUser'], resources: [parameters.cognitoUserPoolArn] }));
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [scope.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: 'mukuroji/automation-webhooks/*/slack/*', arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
      }));
    },
  };
}
