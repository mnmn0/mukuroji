import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';
import type { WorkerChannels } from './channels';

/** Inputs of the Slack ingest worker. */
export interface SlackIngestWorkerInput {
  /** Shared data stores; the worker writes only the Developer Platform table. */
  readonly dataStores: DataStoreResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Slack ingest queue and its dead-letter queue. */
  readonly workerChannels: WorkerChannels;
}

/**
 * Builds the Slack channel ingest worker (#828, ADR 0113). It applies Slack events, loads the
 * earlier messages of newly mapped channels one page per job, and deletes the messages of
 * unmapped channels. Until an operator creates the `mukuroji/slack-ingest` secret, the API
 * queues nothing and the worker stays idle at no cost.
 *
 * @param scope - Stack scope used directly to keep construct paths stable.
 * @param input - Table, queues, runtime controls, and build paths.
 */
export function buildSlackIngestWorker(
  scope: cdk.Stack,
  input: SlackIngestWorkerInput,
): void {
  const { developerPlatformTable } = input.dataStores;
  const { slackIngestDlq, slackIngestQueue } = input.workerChannels;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;

  const logGroup = new logs.LogGroup(scope, 'SlackIngestLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.ONE_MONTH,
  });
  const slackIngestFunction = new lambdaNodejs.NodejsFunction(scope, 'SlackIngestFunction', {
    entry: path.join(serverHandlersDirectory, 'slack-ingest-handler.ts'),
    handler: 'slackIngestHandler',
    runtime: lambda.Runtime.NODEJS_22_X,
    tracing: lambda.Tracing.ACTIVE,
    depsLockFilePath,
    projectRoot,
    timeout: cdk.Duration.minutes(2),
    memorySize: 256,
    description: 'Applies Slack events and loads mapped channel history into the Developer Platform table.',
    logGroup,
    // A history load queues its next page and a 429 queues the same job again. The chain stays
    // bounded: a load stops at 2,000 messages or when its mapping changes, and the redrive
    // policy moves a failing job to the DLQ.
    recursiveLoop: lambda.RecursiveLoop.ALLOW,
    bundling: {
      bundleAwsSDK: true,
      minify: true,
      sourceMap: true,
      target: 'node22',
    },
    environment: {
      DEVELOPER_PLATFORM_TABLE_NAME: developerPlatformTable.tableName,
      MUKUROJI_RUNTIME_ROLE: 'slack-ingest-worker',
      SLACK_INGEST_QUEUE_URL: slackIngestQueue.queueUrl,
    },
  });
  bindRuntimeControls(input.runtimeControls, slackIngestFunction, 'slack-ingest');
  slackIngestFunction.addEventSource(new lambdaEventSources.SqsEventSource(slackIngestQueue, {
    batchSize: 1,
    reportBatchItemFailures: true,
  }));
  slackIngestQueue.grants.consumeMessages(slackIngestFunction);
  slackIngestQueue.grants.sendMessages(slackIngestFunction);
  slackIngestFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:BatchWriteItem',
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ],
    resources: [developerPlatformTable.tableArn],
  }));
  slackIngestFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [scope.formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'mukuroji/slack-ingest-??????',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })],
  }));

  new cloudwatch.Alarm(scope, 'SlackIngestDlqAlarm', {
    alarmDescription: 'Detects Slack ingest jobs that exhausted their queue attempts.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: slackIngestDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
