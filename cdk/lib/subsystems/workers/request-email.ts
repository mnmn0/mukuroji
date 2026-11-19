import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';

/**
 * Inputs required by asynchronous request email ingestion.
 */
export interface RequestEmailWorkerInput {
  /** Request intake data store written by email ingestion. */
  readonly dataStores: DataStoreResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Authentication secrets supplied as stack parameters. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
}

/**
 * Request email ingestion resources exposed through stack outputs.
 */
export type RequestEmailWorkerResources = {
  /** Dead-letter queue for failed email envelopes. */
  readonly requestEmailIngestionDlq: sqs.Queue;
  /** Lambda that validates and ingests email envelopes. */
  readonly requestEmailIngestionFunction: lambdaNodejs.NodejsFunction;
};

/**
 * Builds asynchronous request email ingestion and its failure alarms.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param input Request table, secrets, and Lambda build paths.
 * @returns Email ingestion resources used by stack outputs.
 */
export function buildRequestEmailWorker(
  scope: cdk.Stack,
  input: RequestEmailWorkerInput,
): RequestEmailWorkerResources {
  const { requestIntakeTable, tenantAdministrationTable } = input.dataStores;
  const { requestEmailWebhookSecret, requestTokenHashSecret } = input.parameters;
  if (!requestEmailWebhookSecret) {
    throw new Error('Request email ingestion requires the RequestEmailWebhookSecret parameter.');
  }
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;
  // NoEcho parameter values go into Secrets Manager, never into the Lambda
  // configuration; the worker reads them by ARN at cold start.
  const requestEmailWebhookKeySecret = new secretsmanager.Secret(
    scope,
    'RequestEmailWebhookKeySecret',
    {
      description: 'Request email envelope signing key read by the ingestion worker.',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      secretStringValue: cdk.SecretValue.cfnParameter(requestEmailWebhookSecret),
    },
  );
  const requestTokenHashKeySecret = new secretsmanager.Secret(
    scope,
    'RequestTokenHashKeySecret',
    {
      description: 'Request capability token HMAC key read by the ingestion worker.',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      secretStringValue: cdk.SecretValue.cfnParameter(requestTokenHashSecret),
    },
  );

  const requestEmailIngestionDlq = new sqs.Queue(scope, 'RequestEmailIngestionDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const requestEmailIngestionFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'RequestEmailIngestionFunction',
    {
      entry: path.join(serverHandlersDirectory, 'request-intake-email-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      description: 'Validates signed email envelopes and appends them to request intake threads.',
      onFailure: new lambdaDestinations.SqsDestination(requestEmailIngestionDlq),
      retryAttempts: 2,
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        // A rotated secret keeps its ARN, so the revision changes the function
        // configuration and replaces warm environments that cached the old value.
        MUKUROJI_WORKER_SECRET_REVISION:
          input.parameters.apiRuntimeConfigurationRevision.valueAsString,
        REQUEST_EMAIL_WEBHOOK_SECRET_SECRET_ARN:
          requestEmailWebhookKeySecret.secretArn,
        REQUEST_INTAKE_TABLE_NAME: requestIntakeTable.tableName,
        REQUEST_TOKEN_HASH_SECRET_SECRET_ARN: requestTokenHashKeySecret.secretArn,
        TENANT_ADMINISTRATION_TABLE_NAME:
          tenantAdministrationTable.tableName,
      },
    },
  );
  requestEmailWebhookKeySecret.grantRead(requestEmailIngestionFunction);
  requestTokenHashKeySecret.grantRead(requestEmailIngestionFunction);
  bindRuntimeControls(
    input.runtimeControls,
    requestEmailIngestionFunction,
    'request-intake-email',
  );
  requestEmailIngestionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [requestIntakeTable.tableArn],
    }),
  );
  requestEmailIngestionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [tenantAdministrationTable.tableArn],
    }),
  );
  requestEmailIngestionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:ConditionCheckItem'],
      resources: [tenantAdministrationTable.tableArn],
      conditions: {
        'ForAnyValue:StringEquals': {
          'dynamodb:EnclosingOperation': ['TransactWriteItems'],
        },
      },
    }),
  );
  requestEmailIngestionFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [requestIntakeTable.tableArn],
      conditions: {
        'ForAnyValue:StringEquals': {
          'dynamodb:EnclosingOperation': ['TransactWriteItems'],
        },
      },
    }),
  );

  new cloudwatch.Alarm(scope, 'RequestEmailIngestionDlqAlarm', {
    alarmDescription: 'Detects request intake email envelopes that exhausted asynchronous retries.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: requestEmailIngestionDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  new cloudwatch.Alarm(scope, 'RequestEmailIngestionDestinationFailureAlarm', {
    alarmDescription:
      'Detects failures while Lambda delivers request intake email failures to the DLQ.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: requestEmailIngestionFunction.metric('DestinationDeliveryFailures', {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  return {
    requestEmailIngestionDlq,
    requestEmailIngestionFunction,
  };
}
