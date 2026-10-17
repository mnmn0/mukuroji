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
import type { FileStorageResources } from '../file-storage';
import {
  bindRuntimeControls,
  type RuntimeControlResources,
} from '../runtime-controls';
import type { WorkerChannels } from './channels';

/**
 * Inputs required by the asynchronous audit export worker.
 */
export interface AuditExportWorkerInput {
  /** Shared data stores; the worker reads only the audit events table. */
  readonly dataStores: DataStoreResources;
  /** File storage resources containing the audit export bucket. */
  readonly fileStorage: FileStorageResources;
  /** Stable build paths for Lambda bundling. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Audit export queue and dead-letter queue. */
  readonly workerChannels: WorkerChannels;
}

/**
 * Builds the worker that writes asynchronous audit exports one part at a time.
 *
 * @param scope Stack scope used directly to keep construct paths stable.
 * @param input Audit table, export bucket, queues, and Lambda build paths.
 */
export function buildAuditExportWorker(
  scope: cdk.Stack,
  input: AuditExportWorkerInput,
): void {
  const { auditEventsTable, tenantAdministrationTable } = input.dataStores;
  const { auditExportBucket } = input.fileStorage;
  const { auditExportDlq, auditExportQueue } = input.workerChannels;
  const { depsLockFilePath, projectRoot, serverHandlersDirectory } = input.lambdaBuildPaths;

  const logGroup = new logs.LogGroup(scope, 'AuditExportWorkerLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.THREE_MONTHS,
  });
  const workerFunction = new lambdaNodejs.NodejsFunction(scope, 'AuditExportWorkerFunction', {
    entry: path.join(serverHandlersDirectory, 'audit-export-worker-handler.ts'),
    handler: 'auditExportWorkerHandler',
    runtime: lambda.Runtime.NODEJS_22_X,
    tracing: lambda.Tracing.ACTIVE,
    depsLockFilePath,
    projectRoot,
    timeout: cdk.Duration.minutes(5),
    memorySize: 1024,
    description: 'Writes asynchronous audit exports one NDJSON part per queue message.',
    logGroup,
    bundling: {
      bundleAwsSDK: true,
      minify: true,
      sourceMap: true,
      target: 'node22',
    },
    environment: {
      AUDIT_EVENTS_TABLE_NAME: auditEventsTable.tableName,
      AUDIT_EXPORT_BUCKET_NAME: auditExportBucket.bucketName,
      AUDIT_EXPORT_QUEUE_URL: auditExportQueue.queueUrl,
      MUKUROJI_RUNTIME_ROLE: 'audit-export-worker',
      TENANT_ADMINISTRATION_TABLE_NAME: tenantAdministrationTable.tableName,
    },
  });
  bindRuntimeControls(input.runtimeControls, workerFunction, 'audit-export');
  workerFunction.addEventSource(new lambdaEventSources.SqsEventSource(auditExportQueue, {
    batchSize: 1,
    reportBatchItemFailures: true,
  }));
  auditExportQueue.grants.consumeMessages(workerFunction);
  auditExportQueue.grants.sendMessages(workerFunction);
  workerFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [auditEventsTable.tableArn, `${auditEventsTable.tableArn}/index/*`],
  }));
  workerFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [auditExportBucket.arnForObjects('audit-exports/*')],
  }));
  // Without ListBucket, S3 answers a missing job.json with 403 instead of NoSuchKey, and a
  // step for an expired or closed job would retry into the DLQ instead of being skipped.
  workerFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket'],
    resources: [auditExportBucket.bucketArn],
    conditions: {
      StringLike: {
        's3:prefix': ['audit-exports/*'],
      },
    },
  }));
  // Steps stop for closing or closed tenants so exports cannot outlive tenant closure.
  workerFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [tenantAdministrationTable.tableArn],
  }));

  new cloudwatch.Alarm(scope, 'AuditExportDlqAlarm', {
    alarmDescription: 'Detects audit export steps that exhausted their queue attempts.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: auditExportDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  // Surfaces a backlog well before queued jobs cross the 24-hour processing deadline. A step
  // message is delayed by at most 900 s, so an hour-old message means real backlog.
  new cloudwatch.Alarm(scope, 'AuditExportQueueAgeAlarm', {
    alarmDescription: 'Detects audit export steps waiting in the queue for an hour.',
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: auditExportQueue.metricApproximateAgeOfOldestMessage({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: cdk.Duration.hours(1).toSeconds(),
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
