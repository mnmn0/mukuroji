import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import {
  configureWorkspaceSearchWriterFence,
  type WorkspaceSearchWriterFenceResources,
} from '../../policies/workspace-search-writer-fence';
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';

/**
 * Inputs required by analytics and notification schedule workers.
 */
export interface ScheduleWorkerInput {
  /** Shared data stores read or written by scheduled processing. */
  readonly dataStores: DataStoreResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters used for authorization and retention. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Exact writer-client table configuration without writer state permissions. */
  readonly workspaceSearchWriterFence: WorkspaceSearchWriterFenceResources;
}

/**
 * Schedule worker resources exposed through stack outputs.
 */
export type ScheduleWorkerResources = {
  /** Dead-letter queue for analytics schedule failures. */
  readonly analyticsScheduleDlq: sqs.Queue;
  /** Dead-letter queue for notification schedule failures. */
  readonly notificationScheduleDlq: sqs.Queue;
};

/**
 * Builds analytics and notification schedule workers with alarms and EventBridge rules.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared data stores, parameters, and Lambda build paths.
 * @returns Schedule dead-letter queues used by stack outputs.
 */
export function buildScheduleWorkers(
  scope: cdk.Stack,
  input: ScheduleWorkerInput,
): ScheduleWorkerResources {
  const {
    analyticsTable,
    auditEventsTable,
    planningTable,
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
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;

  const analyticsScheduleDlq = new sqs.Queue(scope, 'AnalyticsScheduleDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const analyticsScheduleFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'AnalyticsScheduleFunction',
    {
      entry: path.join(serverHandlersDirectory, 'analytics-schedule-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      description:
        'Creates permission-safe in-app analytics snapshot delivery receipts on deterministic schedule occurrences.',
      onFailure: new lambdaDestinations.SqsDestination(analyticsScheduleDlq),
      retryAttempts: 2,
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        ANALYTICS_SCHEDULE_INDEX_NAME: 'ScheduleDueIndex',
        ANALYTICS_TABLE_NAME: analyticsTable.tableName,
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      },
    },
  );
  configureWorkspaceSearchWriterFence(
    input.workspaceSearchWriterFence,
    analyticsScheduleFunction,
  );
  bindRuntimeControls(
    input.runtimeControls,
    analyticsScheduleFunction,
    'analytics-schedule',
  );
  analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
    resources: [analyticsTable.tableArn],
  }));
  analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [`${analyticsTable.tableArn}/index/ScheduleDueIndex`],
  }));
  analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['cognito-idp:AdminListGroupsForUser'],
    resources: [cognitoUserPoolArn],
  }));
  analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [`${auditEventsTable.tableArn}/index/EntityOccurredAtIndex`],
  }));
  analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [projectDirectoryTable.tableArn, workItemsTable.tableArn],
  }));
  analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [workspaceAccessTable.tableArn],
  }));
  analyticsScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [tenantAdministrationTable.tableArn],
  }));

  new cloudwatch.Alarm(scope, 'AnalyticsScheduleDlqAlarm', {
    alarmDescription:
      'Detects analytics snapshot delivery failures after asynchronous retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: analyticsScheduleDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new cloudwatch.Alarm(scope, 'AnalyticsScheduleDestinationFailureAlarm', {
    alarmDescription:
      'Detects failures while Lambda delivers analytics schedule failures to the DLQ.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: analyticsScheduleFunction.metric('DestinationDeliveryFailures', {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new events.Rule(scope, 'AnalyticsScheduleRule', {
    description: 'Checks due saved analytics reports every five minutes.',
    schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    targets: [new eventsTargets.LambdaFunction(analyticsScheduleFunction)],
  });

  const notificationScheduleDlq = new sqs.Queue(scope, 'NotificationScheduleDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const notificationScheduleFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'NotificationScheduleFunction',
    {
      entry: path.join(serverHandlersDirectory, 'notification-schedule-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      description:
        'Emits deterministic Work Item and Planning health update notification events.',
      onFailure: new lambdaDestinations.SqsDestination(notificationScheduleDlq),
      retryAttempts: 2,
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        NOTIFICATION_SCHEDULE_MAX_PAGES: '1000',
        NOTIFICATION_SCHEDULE_SCAN_PAGE_SIZE: '100',
        PLANNING_TABLE_NAME: planningTable.tableName,
        PLANNING_UPDATE_SCHEDULE_INDEX_NAME: 'UpdateScheduleDueIndex',
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
      },
    },
  );
  bindRuntimeControls(
    input.runtimeControls,
    notificationScheduleFunction,
    'notification-schedule',
  );
  notificationScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [planningTable.tableArn],
  }));
  notificationScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [`${planningTable.tableArn}/index/UpdateScheduleDueIndex`],
  }));
  notificationScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
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
  projectDirectoryTable.grants.readData(notificationScheduleFunction);
  workItemsTable.grants.readData(notificationScheduleFunction);
  auditEventsTable.grants.writeData(notificationScheduleFunction);

  new cloudwatch.Alarm(scope, 'NotificationScheduleDlqAlarm', {
    alarmDescription:
      'Detects notification schedule failures after asynchronous retries, including scan page limit exhaustion.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: notificationScheduleDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new cloudwatch.Alarm(scope, 'NotificationScheduleDestinationFailureAlarm', {
    alarmDescription:
      'Detects failures while Lambda delivers notification schedule failures to the DLQ.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: notificationScheduleFunction.metric('DestinationDeliveryFailures', {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new events.Rule(scope, 'NotificationScheduleRule', {
    description:
      'Checks canonical Work Items and Planning update targets for scheduled notifications.',
    schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    targets: [new eventsTargets.LambdaFunction(notificationScheduleFunction)],
  });

  return {
    analyticsScheduleDlq,
    notificationScheduleDlq,
  };
}
