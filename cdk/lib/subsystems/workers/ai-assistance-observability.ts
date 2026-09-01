import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { DataStoreResources } from '../data-stores';

/** Inputs required by the durable AI assistance observation worker. */
export type AiAssistanceObservabilityWorkerInput = {
  /** Full reviewed application commit SHA attached to projected metrics. */
  readonly applicationCommitSha: string;
  /** Shared table whose terminal AI rows drive operational metrics. */
  readonly dataStores: DataStoreResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
};

/** Resources exposed by the durable AI assistance observation worker. */
export type AiAssistanceObservabilityWorkerResources = {
  /** Retained dead-letter queue for terminal records that exhaust stream retries. */
  readonly aiAssistanceObservabilityDlq: sqs.Queue;
  /** Stream Lambda that projects terminal AI records into content-free EMF. */
  readonly aiAssistanceObservabilityFunction: lambdaNodejs.NodejsFunction;
};

/**
 * Builds the at-least-once AI assistance observability stream projection.
 *
 * DynamoDB terminal mutations are conditionally committed once, while stream
 * retries can rarely emit a duplicate metric after a successful invocation
 * response is lost.
 *
 * @param scope Stack scope used directly to preserve stable construct paths.
 * @param input Workspace table and Lambda build paths.
 * @returns Stream worker and retained failure queue resources.
 */
export function buildAiAssistanceObservabilityWorker(
  scope: cdk.Stack,
  input: AiAssistanceObservabilityWorkerInput,
): AiAssistanceObservabilityWorkerResources {
  const { workspaceSearchTable } = input.dataStores;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } =
    input.lambdaBuildPaths;
  const aiAssistanceObservabilityDlq = new sqs.Queue(
    scope,
    'AiAssistanceObservabilityDlq',
    {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retentionPeriod: cdk.Duration.days(14),
    },
  );
  const aiAssistanceObservabilityLogGroup = new logs.LogGroup(
    scope,
    'AiAssistanceObservabilityLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const aiAssistanceObservabilityFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'AiAssistanceObservabilityFunction',
    {
      entry: path.join(
        serverHandlersDirectory,
        'ai-assistance-observability-handler.ts',
      ),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description:
        'Projects terminal AI assistance records into content-free operational metrics.',
      logGroup: aiAssistanceObservabilityLogGroup,
      environment: {
        MUKUROJI_APPLICATION_COMMIT_SHA: input.applicationCommitSha,
      },
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    },
  );

  aiAssistanceObservabilityFunction.addEventSource(
    new lambdaEventSources.DynamoEventSource(workspaceSearchTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      bisectBatchOnError: true,
      enabled: true,
      parallelizationFactor: 1,
      retryAttempts: 3,
      reportBatchItemFailures: true,
      filters: [
        lambda.FilterCriteria.filter({
          eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
          dynamodb: {
            NewImage: {
              recordType: {
                S: lambda.FilterRule.isEqual(
                  'ai-assistance-generation-idempotency',
                ),
              },
              status: {
                S: lambda.FilterRule.or('completed', 'failed'),
              },
            },
          },
        }),
        lambda.FilterCriteria.filter({
          eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
          dynamodb: {
            NewImage: {
              recordType: {
                S: lambda.FilterRule.isEqual('ai-assistance-generation'),
              },
              generation: {
                M: {
                  decision: {
                    M: {
                      outcome: {
                        S: lambda.FilterRule.or('approved', 'rejected'),
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ],
      onFailure: new lambdaEventSources.SqsDlq(aiAssistanceObservabilityDlq),
    }),
  );
  workspaceSearchTable.grantStreamRead(aiAssistanceObservabilityFunction);

  new cloudwatch.Alarm(
    scope,
    'AiAssistanceObservabilityProjectionFailureAlarm',
    {
      alarmDescription:
        'Detects terminal AI records returned for partial-batch observability retry.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: new cloudwatch.Metric({
        namespace: 'Mukuroji/AIAssistance',
        metricName: 'ProjectionFailureCount',
        dimensionsMap: {
          Service: 'mukuroji-ai-assistance',
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );

  new cloudwatch.Alarm(
    scope,
    'AiAssistanceObservabilityFunctionErrorAlarm',
    {
      alarmDescription:
        'Detects AI assistance observability worker invocation failures.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: aiAssistanceObservabilityFunction.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  new cloudwatch.Alarm(
    scope,
    'AiAssistanceObservabilityFunctionThrottleAlarm',
    {
      alarmDescription:
        'Detects throttled AI assistance observability worker invocations.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: aiAssistanceObservabilityFunction.metricThrottles({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  new cloudwatch.Alarm(
    scope,
    'AiAssistanceObservabilityIteratorAgeAlarm',
    {
      alarmDescription:
        'Detects AI assistance observability stream projection lag of five minutes or more.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: aiAssistanceObservabilityFunction.metric('IteratorAge', {
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: cdk.Duration.minutes(5).toMilliseconds(),
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  new cloudwatch.Alarm(scope, 'AiAssistanceObservabilityDlqAlarm', {
    alarmDescription:
      'Detects terminal AI assistance records that exhausted observability stream retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: aiAssistanceObservabilityDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return {
    aiAssistanceObservabilityDlq,
    aiAssistanceObservabilityFunction,
  };
}
