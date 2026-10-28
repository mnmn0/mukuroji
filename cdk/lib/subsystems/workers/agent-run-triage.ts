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
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';

/** Wake shards of new Triage entries; must match the Triage schedule worker. */
const triageWakeShardCount = 8;

/**
 * Inputs required by the worker that files failed and stalled Agent Runs to Triage.
 */
export interface AgentRunTriageWorkerInput {
  /** Agent Runs, Work Items, Request Intake, audit, and tenant tables. */
  readonly dataStores: DataStoreResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters used for immutable audit retention. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
}

/**
 * Agent Run triage resources exposed through stack outputs.
 */
export type AgentRunTriageWorkerResources = {
  /** Dead-letter queue for exhausted sweep invocations. */
  readonly agentRunTriageDlq: sqs.Queue;
  /** Lambda that files failed and stalled runs to Triage. */
  readonly agentRunTriageFunction: lambdaNodejs.NodejsFunction;
};

/**
 * Builds the scheduled worker that files failed and stalled Agent Runs of opted-in Teams to Triage,
 * with its EventBridge rule and failure alarms.
 *
 * @param scope - Stack scope used directly to preserve stable construct paths.
 * @param input - Data stores, runtime controls, and Lambda build paths.
 * @returns The worker Lambda and its retained dead-letter queue.
 */
export function buildAgentRunTriageWorker(
  scope: cdk.Stack,
  input: AgentRunTriageWorkerInput,
): AgentRunTriageWorkerResources {
  const {
    agentRunsTable,
    auditEventsTable,
    projectDirectoryTable,
    requestIntakeTable,
    tenantAdministrationTable,
    workItemsTable,
    workspaceAccessTable,
  } = input.dataStores;
  const { auditRetentionDays } = input.parameters;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } =
    input.lambdaBuildPaths;

  const agentRunTriageDlq = new sqs.Queue(scope, 'AgentRunTriageDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const agentRunTriageFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'AgentRunTriageFunction',
    {
      entry: path.join(serverHandlersDirectory, 'agent-run-triage-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      description:
        'Files failed and stalled Agent Runs of opted-in Teams to Triage, one entry per run.',
      onFailure: new lambdaDestinations.SqsDestination(agentRunTriageDlq),
      retryAttempts: 2,
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        AGENT_RUNS_TABLE_NAME: agentRunsTable.tableName,
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        AUDIT_RETENTION_DAYS: auditRetentionDays.valueAsString,
        MUKUROJI_PROJECT_DIRECTORY_TABLE: projectDirectoryTable.tableName,
        MUKUROJI_RUNTIME_ROLE: 'agent-run-triage-worker',
        REQUEST_INTAKE_TABLE_NAME: requestIntakeTable.tableName,
        TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
        PROJECT_DIRECTORY_TABLE_NAME: projectDirectoryTable.tableName,
        TRIAGE_WAKE_SHARD_COUNT: String(triageWakeShardCount),
        WORK_ITEMS_TABLE_NAME: workItemsTable.tableName,
        WORKSPACE_ACCESS_TABLE_NAME: workspaceAccessTable.tableName,
      },
    },
  );
  bindRuntimeControls(
    input.runtimeControls,
    agentRunTriageFunction,
    'agent-run-triage',
  );
  agentRunTriageFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [
      `${agentRunsTable.tableArn}/index/AgentRunTriageIndex`,
      `${agentRunsTable.tableArn}/index/ActiveRunIndex`,
    ],
  }));
  // Strong reads of runs and settings, the outbox removal, and the stall mark.
  agentRunTriageFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [agentRunsTable.tableArn],
  }));
  agentRunTriageFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [
      workItemsTable.tableArn,
      tenantAdministrationTable.tableArn,
      workspaceAccessTable.tableArn,
    ],
  }));
  // Admission fences the Team, Project, and routed owners with the same checks as the API.
  agentRunTriageFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [projectDirectoryTable.tableArn],
  }));
  agentRunTriageFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:ConditionCheckItem'],
    resources: [projectDirectoryTable.tableArn, workspaceAccessTable.tableArn],
    conditions: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
  }));
  // Triage admission reads the source claim and Team configuration, then writes the entry,
  // claim, receipt, and audit event in one transaction.
  agentRunTriageFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [requestIntakeTable.tableArn],
  }));
  agentRunTriageFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:ConditionCheckItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ],
    resources: [requestIntakeTable.tableArn],
    conditions: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
  }));
  agentRunTriageFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem'],
    resources: [auditEventsTable.tableArn],
    conditions: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
  }));

  new cloudwatch.Alarm(scope, 'AgentRunTriageDlqAlarm', {
    alarmDescription:
      'Detects Agent Run triage filing failures after asynchronous retries.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: agentRunTriageDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new cloudwatch.Alarm(scope, 'AgentRunTriageDestinationFailureAlarm', {
    alarmDescription:
      'Detects failures while Lambda delivers Agent Run triage failures to the DLQ.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: agentRunTriageFunction.metric('DestinationDeliveryFailures', {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new events.Rule(scope, 'AgentRunTriageRule', {
    description: 'Files failed and stalled Agent Runs to Triage every minute.',
    schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    targets: [new eventsTargets.LambdaFunction(agentRunTriageFunction)],
  });

  return {
    agentRunTriageDlq,
    agentRunTriageFunction,
  };
}
