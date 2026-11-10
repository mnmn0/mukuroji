import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import {
  grantPlanningRevisionFenceAccess,
} from '../../policies/planning-revision-fence';
import type { DataStoreResources } from '../data-stores';
import type { FileStorageResources } from '../file-storage';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';
import type { ScheduledJobGrant } from './scheduled-jobs';

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
}

/**
 * Automation worker resources exposed through stack outputs.
 */
export type AutomationWorkerResources = {
  /** Dead-letter queue for audit-driven automation failures. */
  readonly automationEventDlq: sqs.Queue;
};

/**
 * Builds the audit-driven automation worker with alarms.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared data stores, file metadata, parameters, and Lambda build paths.
 * @returns The automation event dead-letter queue used by stack outputs.
 */
export function buildAutomationWorkers(
  scope: cdk.Stack,
  input: AutomationWorkerInput,
): AutomationWorkerResources {
  const {
    auditEventsTable,
    automationTable,
    collaborationTable,
    customersTable,
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
        CUSTOMERS_TABLE_NAME: customersTable.tableName,
        COGNITO_CLIENT_ID: cognitoUserPoolClientId,
        COGNITO_USER_POOL_ID: cognitoUserPoolId,
        FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'automation-event-worker',
        PLANNING_TABLE_NAME: planningTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
        TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
        TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
        WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
        WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
      },
    },
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
  customersTable.grants.readWriteData(automationEventFunction);
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
          collaborationTable.tableArn,
          customersTable.tableArn,
          fileProofingTable.tableArn,
          projectDirectoryTable.tableArn,
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

  return {
    automationEventDlq,
  };
}

/**
 * Defines the every-minute job that materializes timezone-aware recurring Work with durable
 * receipts.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Shared data stores, file metadata, and parameters.
 * @returns Environment and grants the job adds to the scheduled-jobs Lambda.
 */
export function defineAutomationScheduleJob(
  scope: cdk.Stack,
  input: Pick<AutomationWorkerInput, 'dataStores' | 'fileStorage' | 'parameters'>,
): ScheduledJobGrant {
  const {
    auditEventsTable,
    automationTable,
    collaborationTable,
    customersTable,
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

  return {
    id: 'AutomationSchedule',
    runtimeScope: 'automation-schedule',
    environment: {
      AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX: automationInboundWebhookSecretPrefix,
      AUTOMATION_TABLE_NAME: automationTable.tableName,
      AUTOMATION_WEBHOOK_SECRET_PREFIX: automationWebhookSecretPrefix,
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
      COLLABORATION_TABLE_NAME: collaborationTable.tableName,
      CUSTOMERS_TABLE_NAME: customersTable.tableName,
      COGNITO_CLIENT_ID: cognitoUserPoolClientId,
      COGNITO_USER_POOL_ID: cognitoUserPoolId,
      FILE_PROOFING_TABLE_NAME: fileProofingTable.tableName,
      PLANNING_TABLE_NAME: planningTable.tableName,
      PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
      SYSTEM_ADMIN_GROUPS: systemAdminGroups.valueAsString,
      TEAM_ISSUE_EVENTS_TABLE_NAME: teamIssueEventsTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
      WORK_ITEM_CONFIGURATION_TABLE_NAME: workItemConfigurationTable.tableName,
      WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
      WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      WORKSPACE_SEARCH_TABLE_NAME: workspaceSearchTable.tableName,
    },
    grant: (grantee, role) => {
      automationTable.grants.readWriteData(grantee);
      collaborationTable.grants.readWriteData(grantee);
      customersTable.grants.readWriteData(grantee);
      auditEventsTable.grants.readWriteData(grantee);
      fileProofingTable.grants.readWriteData(grantee);
      projectDirectoryTable.grants.readData(grantee);
      teamIssueEventsTable.grants.readWriteData(grantee);
      workItemsTable.grants.readWriteData(grantee);
      planningTable.grants.readData(grantee);
      grantPlanningRevisionFenceAccess(planningTable, grantee);
      workItemConfigurationTable.grants.readData(grantee);
      workspaceAccessTable.grants.readData(grantee);
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [tenantAdministrationTable.tableArn],
      }));
      role.attachInlinePolicy(new iam.Policy(
        scope,
        'AutomationScheduleTransactWritePolicy',
        {
          statements: [new iam.PolicyStatement({
            actions: ['dynamodb:ConditionCheckItem'],
            resources: [
              automationTable.tableArn,
              collaborationTable.tableArn,
              customersTable.tableArn,
              fileProofingTable.tableArn,
              projectDirectoryTable.tableArn,
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
      grantee.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminListGroupsForUser',
        ],
        resources: [cognitoUserPoolArn],
      }));
      role.attachInlinePolicy(new iam.Policy(
        scope,
        'AutomationScheduleWebhookSecretPolicy',
        {
          statements: [new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [automationWebhookSecretArn],
          })],
        },
      ));
      role.attachInlinePolicy(new iam.Policy(
        scope,
        'AutomationScheduleInboundWebhookSecretCleanupPolicy',
        {
          statements: [new iam.PolicyStatement({
            actions: ['secretsmanager:DeleteSecret'],
            resources: [automationInboundWebhookSecretArn],
          })],
        },
      ));
    },
  };
}
