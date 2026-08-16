import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import {
  bindWorkspaceSearchWriterFence,
  type WorkspaceSearchWriterFenceResources,
} from '../../policies/workspace-search-writer-fence';
import {
  grantPlanningRevisionFenceAccess,
} from '../../policies/planning-revision-fence';
import type { DataStoreResources } from '../data-stores';
import type { FileStorageResources } from '../file-storage';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';

/**
 * Inputs required by automation event and schedule workers.
 */
export interface AutomationWorkerInput {
  /** Shared data stores used to evaluate and apply automation rules. */
  readonly dataStores: DataStoreResources;
  /** File proofing metadata used by automation actions. */
  readonly fileStorage: FileStorageResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters used for secrets, authorization, and retention. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Exact source, target, and state tables protected by the writer fence. */
  readonly workspaceSearchWriterFence: WorkspaceSearchWriterFenceResources;
}

/**
 * Automation worker resources exposed through stack outputs.
 */
export type AutomationWorkerResources = {
  /** Dead-letter queue for audit-driven automation failures. */
  readonly automationEventDlq: sqs.Queue;
  /** Dead-letter queue for recurring automation failures. */
  readonly automationScheduleDlq: sqs.Queue;
};

/**
 * Builds audit-driven and scheduled automation workers with alarms.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared data stores, file metadata, parameters, and Lambda build paths.
 * @returns Automation dead-letter queues used by stack outputs.
 */
export function buildAutomationWorkers(
  scope: cdk.Stack,
  input: AutomationWorkerInput,
): AutomationWorkerResources {
  const {
    auditEventsTable,
    automationTable,
    collaborationTable,
    planningTable,
    projectDirectoryTable,
    teamIssueEventsTable,
    tenantAdministrationTable,
    workItemConfigurationTable,
    workItemsTable,
    workspaceAccessTable,
    workspaceSearchTable,
  } = input.dataStores;
  const { fileProofingTable } = input.fileStorage;
  const {
    auditRetentionDays,
    automationInboundWebhookSecretArn,
    automationInboundWebhookSecretPrefix,
    automationWebhookSecretArn,
    automationWebhookSecretPrefix,
    cognitoUserPoolArn,
    cognitoUserPoolClientId,
    cognitoUserPoolId,
    systemAdminGroups,
  } = input.parameters;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;

  const automationEventDlq = new sqs.Queue(scope, 'AutomationEventDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const automationEventFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'AutomationEventFunction',
    {
      entry: path.join(serverHandlersDirectory, 'automation-event-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      description: 'Executes versioned automation rules from durable audit outbox events.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        AUTOMATION_TABLE_NAME: automationTable.tableName,
        AUTOMATION_WEBHOOK_SECRET_PREFIX: automationWebhookSecretPrefix,
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        COLLABORATION_TABLE_NAME: collaborationTable.tableName,
        COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'automation-event-worker',
        MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        PLANNING_TABLE_NAME: planningTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
        WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
      },
    },
  );
  bindWorkspaceSearchWriterFence(
    input.workspaceSearchWriterFence,
    automationEventFunction,
  );
  bindRuntimeControls(
    input.runtimeControls,
    automationEventFunction,
    'automation-event',
  );
  automationEventFunction.addEventSource(
    new lambdaEventSources.DynamoEventSource(auditEventsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      bisectBatchOnError: true,
      retryAttempts: 3,
      reportBatchItemFailures: true,
      onFailure: new lambdaEventSources.SqsDlq(automationEventDlq),
    }),
  );
  auditEventsTable.grantStreamRead(automationEventFunction);
  automationTable.grants.readWriteData(automationEventFunction);
  collaborationTable.grants.readWriteData(automationEventFunction);
  auditEventsTable.grants.readWriteData(automationEventFunction);
  fileProofingTable.grants.readWriteData(automationEventFunction);
  projectDirectoryTable.grants.readData(automationEventFunction);
  teamIssueEventsTable.grants.readWriteData(automationEventFunction);
  workItemsTable.grants.readWriteData(automationEventFunction);
  planningTable.grants.readData(automationEventFunction);
  grantPlanningRevisionFenceAccess(planningTable, automationEventFunction);
  workItemConfigurationTable.grants.readData(automationEventFunction);
  workspaceAccessTable.grants.readData(automationEventFunction);
  automationEventFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [tenantAdministrationTable.tableArn],
  }));
  if (!automationEventFunction.role) {
    throw new Error('Automation event Lambda execution role was not created.');
  }
  automationEventFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'AutomationEventTransactWritePolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem'],
        resources: [
          automationTable.tableArn,
          fileProofingTable.tableArn,
          workItemConfigurationTable.tableArn,
          workItemsTable.tableArn,
          workspaceSearchTable.tableArn,
        ],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
      })],
    },
  ));
  automationEventFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
    ],
    resources: [cognitoUserPoolArn],
  }));
  automationEventFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'AutomationEventWebhookSecretPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [automationWebhookSecretArn],
      })],
    },
  ));

  new cloudwatch.Alarm(scope, 'AutomationEventDlqAlarm', {
    alarmDescription: 'Detects automation outbox records that exhausted stream retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: automationEventDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  const automationScheduleDlq = new sqs.Queue(scope, 'AutomationScheduleDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const automationScheduleFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'AutomationScheduleFunction',
    {
      entry: path.join(serverHandlersDirectory, 'automation-schedule-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      description: 'Materializes timezone-aware recurring Work Items with durable receipts.',
      onFailure: new lambdaDestinations.SqsDestination(automationScheduleDlq),
      retryAttempts: 2,
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX: automationInboundWebhookSecretPrefix,
        AUTOMATION_TABLE_NAME: automationTable.tableName,
        AUTOMATION_WEBHOOK_SECRET_PREFIX: automationWebhookSecretPrefix,
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        COLLABORATION_TABLE_NAME: collaborationTable.tableName,
        COGNITO_CLIENT_ID: cognitoUserPoolClientId.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'automation-schedule-worker',
        MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        PLANNING_TABLE_NAME: planningTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
        WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
      },
    },
  );
  bindWorkspaceSearchWriterFence(
    input.workspaceSearchWriterFence,
    automationScheduleFunction,
  );
  bindRuntimeControls(
    input.runtimeControls,
    automationScheduleFunction,
    'automation-schedule',
  );
  automationTable.grants.readWriteData(automationScheduleFunction);
  collaborationTable.grants.readWriteData(automationScheduleFunction);
  auditEventsTable.grants.readWriteData(automationScheduleFunction);
  fileProofingTable.grants.readWriteData(automationScheduleFunction);
  projectDirectoryTable.grants.readData(automationScheduleFunction);
  teamIssueEventsTable.grants.readWriteData(automationScheduleFunction);
  workItemsTable.grants.readWriteData(automationScheduleFunction);
  planningTable.grants.readData(automationScheduleFunction);
  grantPlanningRevisionFenceAccess(planningTable, automationScheduleFunction);
  workItemConfigurationTable.grants.readData(automationScheduleFunction);
  workspaceAccessTable.grants.readData(automationScheduleFunction);
  automationScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [tenantAdministrationTable.tableArn],
  }));
  if (!automationScheduleFunction.role) {
    throw new Error('Automation schedule Lambda execution role was not created.');
  }
  automationScheduleFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'AutomationScheduleTransactWritePolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem'],
        resources: [
          automationTable.tableArn,
          fileProofingTable.tableArn,
          workItemConfigurationTable.tableArn,
          workItemsTable.tableArn,
          workspaceSearchTable.tableArn,
        ],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:EnclosingOperation': ['TransactWriteItems'],
          },
        },
      })],
    },
  ));
  automationScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
    ],
    resources: [cognitoUserPoolArn],
  }));
  automationScheduleFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'AutomationScheduleWebhookSecretPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [automationWebhookSecretArn],
      })],
    },
  ));
  automationScheduleFunction.role.attachInlinePolicy(new iam.Policy(
    scope,
    'AutomationScheduleInboundWebhookSecretCleanupPolicy',
    {
      statements: [new iam.PolicyStatement({
        actions: ['secretsmanager:DeleteSecret'],
        resources: [automationInboundWebhookSecretArn],
      })],
    },
  ));

  new cloudwatch.Alarm(scope, 'AutomationScheduleDlqAlarm', {
    alarmDescription:
      'Detects recurring Work materialization failures after asynchronous retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: automationScheduleDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new events.Rule(scope, 'AutomationScheduleRule', {
    description: 'Checks timezone-aware recurring Work definitions every minute.',
    schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    targets: [new eventsTargets.LambdaFunction(automationScheduleFunction)],
  });

  return {
    automationEventDlq,
    automationScheduleDlq,
  };
}
