import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  resolveLambdaHandlerEntry,
  type LambdaBuildPaths,
} from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import {
  bindWorkspaceSearchWriterFence,
  configureWorkspaceSearchWriterFence,
  type WorkspaceSearchWriterFenceResources,
} from '../../policies/workspace-search-writer-fence';
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';
import type { WorkerChannels } from './channels';

/**
 * Inputs required by connector synchronization and polling workers.
 */
export interface ConnectorWorkerInput {
  /** Shared data stores used by connector polling and synchronization. */
  readonly dataStores: DataStoreResources;
  /** Stable paths used to bundle connector Lambdas. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters used for connector authorization and audit behavior. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Connector queues and dead-letter queues. */
  readonly workerChannels: WorkerChannels;
  /** Exact source, target, and state tables protected by the writer fence. */
  readonly workspaceSearchWriterFence: WorkspaceSearchWriterFenceResources;
}

/**
 * Restricts a KMS grant to one developer platform envelope encryption purpose.
 *
 * @param grant Grant whose principal and resource statements are constrained.
 * @param purpose Developer platform encryption context purpose accepted by the grant.
 * @returns Nothing.
 */
function restrictKmsGrantToDeveloperPlatformPurpose(
  grant: iam.Grant,
  purpose: 'connector' | 'platform-state',
): void {
  for (const statement of [
    ...grant.principalStatements,
    ...grant.resourceStatements,
  ]) {
    statement.addConditions({
      StringEquals: {
        'kms:EncryptionContext:mukuroji:purpose': purpose,
        'kms:EncryptionContext:mukuroji:service': 'developer-platform',
      },
    });
  }
}

/**
 * Builds connector synchronization and scheduled polling workers with their alarms.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared stores, parameters, queues, and Lambda build paths.
 * @returns Nothing.
 */
export function buildConnectorWorkers(
  scope: cdk.Stack,
  input: ConnectorWorkerInput,
): void {
  const {
    auditEventsTable,
    connectorRuntimeSecret,
    developerPlatformConnectorKey,
    developerPlatformStateKey,
    developerPlatformTable,
    enterpriseIdentityTable,
    planningTable,
    projectDirectoryTable,
    teamIssueEventsTable,
    tenantAdministrationTable,
    workItemConfigurationTable,
    workItemsTable,
    workspaceAccessTable,
    workspaceSearchTable,
  } = input.dataStores;
  const {
    auditRetentionDays,
    cognitoUserPoolArn,
    cognitoUserPoolId,
    enterpriseIdentityTokenHashSecret,
    systemAdminGroups,
  } = input.parameters;
  const {
    connectorPollDlq,
    connectorSyncDlq,
    connectorSyncQueue,
  } = input.workerChannels;
  const {
    depsLockFilePath,
    projectRoot,
  } = input.lambdaBuildPaths;

  const connectorSyncLogGroup = new logs.LogGroup(
    scope,
    'ConnectorSyncLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const connectorSyncFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'ConnectorSyncFunction',
    {
      entry: resolveLambdaHandlerEntry(input.lambdaBuildPaths, 'connector-handler.ts'),
      handler: 'queueHandler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      description:
        'Processes provider-neutral connector synchronization jobs with current Work Item RBAC.',
      logGroup: connectorSyncLogGroup,
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
        CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN:
          connectorRuntimeSecret.secretArn,
        CONNECTOR_SYNC_QUEUE_URL: connectorSyncQueue.queueUrl,
        DEVELOPER_PLATFORM_CONNECTOR_KMS_KEY_ID:
          developerPlatformConnectorKey.keyArn,
        DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
        DEVELOPER_PLATFORM_STATE_KMS_KEY_ID:
          developerPlatformStateKey.keyArn,
        DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
        ENTERPRISE_IDENTITY_TABLE_NAME: enterpriseIdentityTable.tableName,
        ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET:
          enterpriseIdentityTokenHashSecret.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'connector-queue-worker',
        MUKUROJI_SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        MUKUROJI_TEAM_ISSUE_EVENTS_TABLE: teamIssueEventsTable.tableName,
        MUKUROJI_TEAM_ISSUES_TABLE: workItemsTable.tableName,
        MUKUROJI_WORK_ITEMS_TABLE: workItemsTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        PLANNING_TABLE_NAME: planningTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TEAM_ISSUES_TABLE_NAME: workItemsTable.tableName,
        TENANT_ADMINISTRATION_TABLE_NAME:
          tenantAdministrationTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
        WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
      },
    },
  );
  bindWorkspaceSearchWriterFence(
    input.workspaceSearchWriterFence,
    connectorSyncFunction,
  );
  bindRuntimeControls(
    input.runtimeControls,
    connectorSyncFunction,
    'connector-sync',
  );
  connectorSyncFunction.addEventSource(
    new lambdaEventSources.SqsEventSource(connectorSyncQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }),
  );
  connectorSyncQueue.grants.consumeMessages(connectorSyncFunction);
  connectorSyncQueue.grants.sendMessages(connectorSyncFunction);
  connectorRuntimeSecret.grantRead(connectorSyncFunction);
  developerPlatformTable.grants.readWriteData(connectorSyncFunction);
  workItemsTable.grants.readWriteData(connectorSyncFunction);
  teamIssueEventsTable.grants.readWriteData(connectorSyncFunction);
  auditEventsTable.grants.readWriteData(connectorSyncFunction);
  projectDirectoryTable.grants.readData(connectorSyncFunction);
  workspaceAccessTable.grants.readData(connectorSyncFunction);
  connectorSyncFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [
      planningTable.tableArn,
      enterpriseIdentityTable.tableArn,
    ],
  }));
  connectorSyncFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [tenantAdministrationTable.tableArn],
  }));
  workItemConfigurationTable.grants.readData(connectorSyncFunction);
  restrictKmsGrantToDeveloperPlatformPurpose(
    developerPlatformConnectorKey.grants.actions(
      connectorSyncFunction,
      'kms:Decrypt',
      'kms:GenerateDataKey',
    ),
    'connector',
  );
  restrictKmsGrantToDeveloperPlatformPurpose(
    developerPlatformStateKey.grants.actions(
      connectorSyncFunction,
      'kms:Decrypt',
      'kms:GenerateDataKey',
    ),
    'platform-state',
  );
  connectorSyncFunction.addToRolePolicy(new iam.PolicyStatement({
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
  connectorSyncFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
    ],
    resources: [cognitoUserPoolArn],
  }));

  const connectorPollLogGroup = new logs.LogGroup(
    scope,
    'ConnectorPollLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const connectorPollFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'ConnectorPollFunction',
    {
      entry: resolveLambdaHandlerEntry(input.lambdaBuildPaths, 'connector-handler.ts'),
      handler: 'pollHandler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      description: 'Schedules bounded polling jobs for connected provider installations.',
      logGroup: connectorPollLogGroup,
      onFailure: new lambdaDestinations.SqsDestination(connectorPollDlq),
      retryAttempts: 2,
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        CONNECTOR_SYNC_QUEUE_URL: connectorSyncQueue.queueUrl,
        DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME: 'LookupKeyIndex',
        DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'connector-poll',
        TENANT_ADMINISTRATION_TABLE_NAME:
          tenantAdministrationTable.tableName,
      },
    },
  );
  configureWorkspaceSearchWriterFence(
    input.workspaceSearchWriterFence,
    connectorPollFunction,
  );
  bindRuntimeControls(
    input.runtimeControls,
    connectorPollFunction,
    'connector-poll',
  );
  connectorPollFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
    ],
    resources: [developerPlatformTable.tableArn],
  }));
  connectorPollFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [tenantAdministrationTable.tableArn],
  }));
  connectorPollFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [`${developerPlatformTable.tableArn}/index/LookupKeyIndex`],
  }));
  connectorSyncQueue.grants.sendMessages(connectorPollFunction);

  // EventBridge delivery failures and exhausted Lambda async invocations share this
  // operator-inspected DLQ. It has no automatic consumer, so both envelope formats
  // remain intact for diagnosis and the alarm below covers either failure path.
  new events.Rule(scope, 'ConnectorPollRule', {
    description: 'Schedules bounded connector polling for providers without push events.',
    schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    targets: [
      new eventsTargets.LambdaFunction(connectorPollFunction, {
        deadLetterQueue: connectorPollDlq,
        maxEventAge: cdk.Duration.hours(1),
        retryAttempts: 2,
      }),
    ],
  });

  new cloudwatch.Alarm(scope, 'ConnectorSyncDlqAlarm', {
    alarmDescription:
      'Detects connector projection or sync jobs that exhausted queue redrive retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: connectorSyncDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'ConnectorPollDlqAlarm', {
    alarmDescription:
      'Detects scheduled connector polling invocations that exhausted EventBridge retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: connectorPollDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'ConnectorSyncQueueAgeAlarm', {
    alarmDescription: 'Detects connector synchronization jobs delayed for 15 minutes.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: connectorSyncQueue.metricApproximateAgeOfOldestMessage({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: cdk.Duration.minutes(15).toSeconds(),
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
