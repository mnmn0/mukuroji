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

const triageWakeIndexName = 'triage-wake-index';
const triageWakeShardCount = 8;
const triageScheduleBatchSize = 100;

/**
 * Inputs required by the scheduled Triage wake-up worker.
 */
export interface TriageScheduleWorkerInput {
  /** Request Intake single-table store that also owns Triage entries and receipts. */
  readonly dataStores: DataStoreResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Stack parameters used for immutable audit retention. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
}

/**
 * Scheduled Triage resources exposed through stack outputs.
 */
export type TriageScheduleWorkerResources = {
  /** Dead-letter queue for exhausted Triage schedule invocations. */
  readonly triageScheduleDlq: sqs.Queue;
  /** Lambda that processes due snooze, SLA, and escalation wake-ups. */
  readonly triageScheduleFunction: lambdaNodejs.NodejsFunction;
};

/**
 * Builds the bounded Triage wake-up worker, EventBridge rule, and failure alarms.
 *
 * @param scope - Stack scope used directly to preserve stable construct paths.
 * @param input - Request Intake store, runtime controls, and Lambda build paths.
 * @returns The Triage schedule Lambda and its retained dead-letter queue.
 */
export function buildTriageScheduleWorker(
  scope: cdk.Stack,
  input: TriageScheduleWorkerInput,
): TriageScheduleWorkerResources {
  const { auditEventsTable, requestIntakeTable } = input.dataStores;
  const { auditRetentionDays } = input.parameters;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } =
    input.lambdaBuildPaths;
  const triageWakeIndexArn = cdk.Stack.of(scope).formatArn({
    service: 'dynamodb',
    resource: 'table',
    resourceName:
      `${requestIntakeTable.tableName}/index/${triageWakeIndexName}`,
  });

  const triageScheduleDlq = new sqs.Queue(scope, 'TriageScheduleDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const triageScheduleFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'TriageScheduleFunction',
    {
      entry: path.join(serverHandlersDirectory, 'triage-schedule-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      description:
        'Processes due Triage snooze and SLA wake-ups with revision-fenced receipts.',
      onFailure: new lambdaDestinations.SqsDestination(triageScheduleDlq),
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
        MUKUROJI_RUNTIME_ROLE: 'triage-schedule-worker',
        REQUEST_INTAKE_TABLE_NAME: requestIntakeTable.tableName,
        TRIAGE_SCHEDULE_BATCH_SIZE: String(triageScheduleBatchSize),
        TRIAGE_WAKE_INDEX_NAME: triageWakeIndexName,
        TRIAGE_WAKE_SHARD_COUNT: String(triageWakeShardCount),
      },
    },
  );
  bindRuntimeControls(
    input.runtimeControls,
    triageScheduleFunction,
    'triage-schedule',
  );
  triageScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [triageWakeIndexArn],
  }));
  triageScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [requestIntakeTable.tableArn],
  }));
  triageScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
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
  triageScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem'],
    resources: [auditEventsTable.tableArn],
    conditions: {
      'ForAnyValue:StringEquals': {
        'dynamodb:EnclosingOperation': ['TransactWriteItems'],
      },
    },
  }));

  new cloudwatch.Alarm(scope, 'TriageScheduleDlqAlarm', {
    alarmDescription:
      'Detects Triage wake processing failures after asynchronous retries.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: triageScheduleDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new cloudwatch.Alarm(scope, 'TriageScheduleDestinationFailureAlarm', {
    alarmDescription:
      'Detects failures while Lambda delivers Triage schedule failures to the DLQ.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: triageScheduleFunction.metric('DestinationDeliveryFailures', {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new events.Rule(scope, 'TriageScheduleRule', {
    description: 'Checks due Triage snooze and SLA wake-ups every minute.',
    schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    targets: [new eventsTargets.LambdaFunction(triageScheduleFunction)],
  });

  return {
    triageScheduleDlq,
    triageScheduleFunction,
  };
}
