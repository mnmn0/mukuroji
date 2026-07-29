import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import {
  bindWorkspaceSearchWriterFence,
  type WorkspaceSearchWriterFenceResources,
} from '../../policies/workspace-search-writer-fence';
import type { DataStoreResources } from '../data-stores';
import type { FileStorageResources } from '../file-storage';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';
import type { WorkerChannels } from './channels';

/**
 * Inputs required by the durable Work Item import worker.
 */
export interface WorkItemImportWorkerInput {
  /** Shared data stores used while importing Work Items. */
  readonly dataStores: DataStoreResources;
  /** File storage resources containing import sources. */
  readonly fileStorage: FileStorageResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters used for authorization and audit behavior. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Durable import queue and dead-letter queue. */
  readonly workerChannels: WorkerChannels;
  /** Exact source, target, and state tables protected by the writer fence. */
  readonly workspaceSearchWriterFence: WorkspaceSearchWriterFenceResources;
}

/**
 * Builds the resumable Work Item import worker and its operational alarm.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared tables, storage, queue, parameters, and Lambda build paths.
 */
export function buildWorkItemImportWorker(
  scope: cdk.Stack,
  input: WorkItemImportWorkerInput,
): void {
  const {
    auditEventsTable,
    developerPlatformTable,
    enterpriseIdentityTable,
    planningTable,
    projectDirectoryTable,
    teamIssueEventsTable,
    workItemConfigurationTable,
    workItemsTable,
    workspaceAccessTable,
    workspaceSearchTable,
  } = input.dataStores;
  const { workItemImportBucket } = input.fileStorage;
  const {
    auditRetentionDays,
    cognitoUserPoolArn,
    cognitoUserPoolId,
    enterpriseIdentityTokenHashSecret,
    systemAdminGroups,
  } = input.parameters;
  const { workItemImportDlq, workItemImportQueue } = input.workerChannels;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;

  const workItemImportLogGroup = new logs.LogGroup(
    scope,
    'WorkItemImportLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const workItemImportFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'WorkItemImportFunction',
    {
      entry: path.join(serverHandlersDirectory, 'work-item-import.handler.ts'),
      handler: 'workItemImportHandler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      description: 'Processes durable Work Item imports with resumable row receipts.',
      logGroup: workItemImportLogGroup,
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        COGNITO_USER_POOL_ID: cognitoUserPoolId.valueAsString,
        DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
        ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
        ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET:
          enterpriseIdentityTokenHashSecret.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'work-item-import-worker',
        MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
        MUKUROJI_TEAM_ISSUES_TABLE: workItemsTable.tableName,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME:
          'WebhookAuthorizationIndex',
        PLANNING_TABLE_NAME: planningTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
        WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
        WORK_ITEM_IMPORT_BUCKET_NAME: workItemImportBucket.bucketName,
        WORK_ITEM_IMPORT_QUEUE_URL: workItemImportQueue.queueUrl,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
      },
    },
  );
  bindWorkspaceSearchWriterFence(
    input.workspaceSearchWriterFence,
    workItemImportFunction,
  );
  bindRuntimeControls(
    input.runtimeControls,
    workItemImportFunction,
    'work-item-import',
  );
  workItemImportFunction.addEventSource(
    new lambdaEventSources.SqsEventSource(workItemImportQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }),
  );
  workItemImportQueue.grants.consumeMessages(workItemImportFunction);
  developerPlatformTable.grants.readWriteData(workItemImportFunction);
  workItemsTable.grants.readWriteData(workItemImportFunction);
  teamIssueEventsTable.grants.readWriteData(workItemImportFunction);
  auditEventsTable.grants.readWriteData(workItemImportFunction);
  projectDirectoryTable.grants.readData(workItemImportFunction);
  workspaceAccessTable.grants.readData(workItemImportFunction);
  workItemImportFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [
      planningTable.tableArn,
      enterpriseIdentityTable.tableArn,
    ],
  }));
  workItemConfigurationTable.grants.readData(workItemImportFunction);
  workspaceSearchTable.grants.readWriteData(workItemImportFunction);
  workItemImportFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:ConditionCheckItem'],
    resources: [
      workspaceAccessTable.tableArn,
      planningTable.tableArn,
      enterpriseIdentityTable.tableArn,
      workItemConfigurationTable.tableArn,
    ],
    conditions: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
  }));
  workItemImportFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      's3:DeleteObjectVersion',
      's3:GetObject',
      's3:GetObjectVersion',
    ],
    resources: [workItemImportBucket.arnForObjects('work-item-imports/*')],
  }));
  workItemImportFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
    ],
    resources: [cognitoUserPoolArn],
  }));

  new cloudwatch.Alarm(scope, 'WorkItemImportDlqAlarm', {
    alarmDescription: 'Detects Work Item imports that exhausted resumable queue attempts.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: workItemImportDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
