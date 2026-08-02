import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { DataStoreResources } from '../data-stores';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';

/** Inputs required to build the trusted tenant operation executor. */
export interface TenantOperationWorkerInput {
  /** Tenant lifecycle and audit data stores. */
  readonly dataStores: DataStoreResources;
  /** Stable paths used to bundle the worker Lambda. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
}

/** Trusted tenant operation worker resources. */
export type TenantOperationWorkerResources = {
  /** Dead-letter queue for tenant operation stream failures. */
  readonly tenantOperationDlq: sqs.Queue;
  /** IAM-invokable worker that accepts capability evidence. */
  readonly tenantOperationFunction: lambdaNodejs.NodejsFunction;
};

/**
 * Builds the stream-started, IAM-invokable tenant lifecycle executor.
 *
 * @param scope - Stack scope that owns the worker.
 * @param input - Data stores, build paths, and runtime controls.
 * @returns Worker Lambda and retained dead-letter queue.
 */
export function buildTenantOperationWorker(
  scope: cdk.Stack,
  input: TenantOperationWorkerInput,
): TenantOperationWorkerResources {
  const {
    auditEventsTable,
    tenantAdministrationTable,
  } = input.dataStores;
  const {
    depsLockFilePath,
    projectRoot,
    serverHandlersDirectory,
  } = input.lambdaBuildPaths;
  const tenantOperationDlq = new sqs.Queue(scope, 'TenantOperationDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const tenantOperationFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'TenantOperationFunction',
    {
      entry: path.join(
        serverHandlersDirectory,
        'tenant-operation-execution-handler.ts',
      ),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath,
      projectRoot,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      reservedConcurrentExecutions: 2,
      description:
        'Trusted executor boundary for evidence-backed tenant export and closure transitions.',
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
        TENANT_ADMINISTRATION_TABLE_NAME:
          tenantAdministrationTable.tableName,
      },
    },
  );
  bindRuntimeControls(
    input.runtimeControls,
    tenantOperationFunction,
    'tenant-operation-execution',
  );
  tenantAdministrationTable.grants.readWriteData(tenantOperationFunction);
  auditEventsTable.grants.readWriteData(tenantOperationFunction);
  tenantOperationFunction.addEventSource(
    new lambdaEventSources.DynamoEventSource(tenantAdministrationTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 1,
      bisectBatchOnError: true,
      parallelizationFactor: 1,
      retryAttempts: 10,
      reportBatchItemFailures: true,
      filters: [lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
        dynamodb: {
          NewImage: {
            kind: { S: lambda.FilterRule.isEqual('operation') },
            recordKey: { S: lambda.FilterRule.beginsWith('OPERATION#') },
          },
        },
      }), lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
        dynamodb: {
          NewImage: {
            kind: { S: lambda.FilterRule.isEqual('retention-job') },
            recordKey: { S: lambda.FilterRule.isEqual('RETENTION_JOB') },
            status: {
              S: lambda.FilterRule.or(
                lambda.FilterRule.isEqual('pending'),
                lambda.FilterRule.isEqual('running'),
              ),
            },
          },
        },
      })],
      onFailure: new lambdaEventSources.SqsDlq(tenantOperationDlq),
    }),
  );
  tenantAdministrationTable.grantStreamRead(tenantOperationFunction);
  new cloudwatch.Alarm(scope, 'TenantOperationDlqAlarm', {
    alarmDescription:
      'Detects tenant lifecycle transitions that exhausted bounded retries.',
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: tenantOperationDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  return { tenantOperationDlq, tenantOperationFunction };
}
