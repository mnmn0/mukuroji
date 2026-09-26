import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { bindRuntimeControls } from '../runtime-controls';
import type { ScheduleWorkerInput } from './schedules';

/**
 * Adds a bounded scheduled worker for the sparse Slack delivery queue.
 * @param scope - Stack scope used to preserve stable construct identities.
 * @param input - Shared storage, configuration, and runtime controls.
 */
export function buildSlackNotificationWorker(scope: cdk.Stack, input: ScheduleWorkerInput): void {
  const stores = input.dataStores;
  const parameters = input.parameters;
  const dlq = new sqs.Queue(scope, 'SlackNotificationDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN, retentionPeriod: cdk.Duration.days(14),
  });
  const worker = new nodejs.NodejsFunction(scope, 'SlackNotificationFunction', {
    entry: path.join(input.lambdaBuildPaths.serverHandlersDirectory, 'slack-notifications-handler.ts'),
    handler: 'handler', runtime: lambda.Runtime.NODEJS_22_X, tracing: lambda.Tracing.ACTIVE,
    depsLockFilePath: input.lambdaBuildPaths.depsLockFilePath,
    projectRoot: input.lambdaBuildPaths.projectRoot,
    timeout: cdk.Duration.minutes(5), memorySize: 512,
    logGroup: new logs.LogGroup(scope, 'SlackNotificationLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.RETAIN,
    }),
    description: 'Delivers opted-in Inbox notifications to recipient-bound Slack destinations.',
    onFailure: new destinations.SqsDestination(dlq), retryAttempts: 0,
    bundling: { bundleAwsSDK: true, minify: true, sourceMap: true, target: 'node22' },
    environment: {
      NOTIFICATIONS_TABLE_NAME: stores.notificationsTable.tableName,
      ENTERPRISE_IDENTITY_TABLE_NAME: stores.enterpriseIdentityTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME: stores.tenantAdministrationTable.tableName,
      PROJECT_DIRECTORY_TABLE_NAME: stores.projectDirectoryTable.tableName,
      WORKSPACE_ACCESS_TABLE_NAME: stores.workspaceAccessTable.tableName,
      WORK_ITEMS_TABLE_NAME: stores.workItemsTable.tableName,
      PLANNING_TABLE_NAME: stores.planningTable.tableName,
      COGNITO_USER_POOL_ID: parameters.cognitoUserPoolId.valueAsString,
      SYSTEM_ADMIN_GROUPS: parameters.systemAdminGroups.valueAsString,
    },
  });
  bindRuntimeControls(input.runtimeControls, worker, 'notification-schedule');
  worker.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [stores.notificationsTable.tableArn],
  }));
  worker.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'], resources: [`${stores.notificationsTable.tableArn}/index/SlackDeliveryIndex`],
  }));
  for (const table of [stores.enterpriseIdentityTable, stores.tenantAdministrationTable, stores.workspaceAccessTable, stores.workItemsTable, stores.planningTable]) {
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:Query'], resources: [table.tableArn] }));
  }
  worker.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [stores.projectDirectoryTable.tableArn] }));
  worker.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminListGroupsForUser'], resources: [parameters.cognitoUserPoolArn] }));
  worker.addToRolePolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [scope.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: 'mukuroji/automation-webhooks/*/slack/*', arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
  }));
  new events.Rule(scope, 'SlackNotificationSchedule', {
    schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    targets: [new targets.LambdaFunction(worker)],
  });
  new cloudwatch.Alarm(scope, 'SlackNotificationDlqAlarm', {
    alarmDescription: 'Slack delivery failures require destination repair or queue replay.',
    metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
    threshold: 1, evaluationPeriods: 1, datapointsToAlarm: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'SlackNotificationErrorsAlarm', {
    alarmDescription: 'Slack notification worker failures, including delivery destination failures.',
    metric: worker.metricErrors({ period: cdk.Duration.minutes(5) }),
    threshold: 1, evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
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
}
