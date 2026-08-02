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
  /** Dead-letter queue for tenant lifecycle and retention stream failures. */
  readonly tenantOperationDlq: sqs.Queue;
  /** Stream-only worker that starts operations and reconciles retention. */
  readonly tenantOperationFunction: lambdaNodejs.NodejsFunction;
  /** Proof ingress restricted to export-owned workflow steps. */
  readonly tenantExportCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Proof ingress restricted to Workspace access revocation. */
  readonly tenantAccessCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Proof ingress restricted to deleted-member anonymization. */
  readonly tenantIdentityCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Proof ingress restricted to tenant data deletion. */
  readonly tenantDataCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Proof ingress restricted to tenant secret deletion. */
  readonly tenantSecretsCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Proof ingress restricted to final closure verification. */
  readonly tenantVerificationCapabilityFunction: lambdaNodejs.NodejsFunction;
};

/** Immutable configuration for one IAM-addressable lifecycle capability. */
type TenantOperationCapabilitySpec = {
  /** Stable CDK construct identifier. */
  readonly id: string;
  /** Stable executor identity stored in audit history. */
  readonly executorId: string;
  /** Comma-separated workflow steps owned by this function ARN. */
  readonly allowedSteps: string;
  /** Operational function description. */
  readonly description: string;
};

/**
 * Builds the stream-only tenant lifecycle starter and reconciliation worker.
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
        'Trusted tenant lifecycle executor and audit-retention reconciliation worker.',
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
        eventName: lambda.FilterRule.isEqual('INSERT'),
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
  tenantOperationFunction.addEventSource(
    new lambdaEventSources.DynamoEventSource(auditEventsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      bisectBatchOnError: true,
      parallelizationFactor: 1,
      retryAttempts: 10,
      reportBatchItemFailures: true,
      filters: [lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.isEqual('INSERT'),
      })],
      onFailure: new lambdaEventSources.SqsDlq(tenantOperationDlq),
    }),
  );
  auditEventsTable.grantStreamRead(tenantOperationFunction);
  const capabilityInput = {
    auditEventsTable,
    lambdaBuildPaths: input.lambdaBuildPaths,
    runtimeControls: input.runtimeControls,
    tenantAdministrationTable,
  };
  const tenantExportCapabilityFunction =
    buildTenantOperationCapabilityFunction(scope, capabilityInput, {
      id: 'TenantExportCapabilityFunction',
      executorId: 'executor:tenant-export',
      allowedSteps: 'snapshot,prepare-artifact,verify-artifact,export',
      description: 'Accepts evidence only for tenant export workflow steps.',
    });
  const tenantAccessCapabilityFunction =
    buildTenantOperationCapabilityFunction(scope, capabilityInput, {
      id: 'TenantAccessCapabilityFunction',
      executorId: 'executor:tenant-access-revocation',
      allowedSteps: 'revoke-access',
      description: 'Accepts evidence only for tenant access revocation.',
    });
  const tenantIdentityCapabilityFunction =
    buildTenantOperationCapabilityFunction(scope, capabilityInput, {
      id: 'TenantIdentityCapabilityFunction',
      executorId: 'executor:tenant-member-anonymization',
      allowedSteps: 'anonymize-members',
      description: 'Accepts evidence only for deleted-member anonymization.',
    });
  const tenantDataCapabilityFunction =
    buildTenantOperationCapabilityFunction(scope, capabilityInput, {
      id: 'TenantDataCapabilityFunction',
      executorId: 'executor:tenant-data-deletion',
      allowedSteps: 'delete-data',
      description: 'Accepts evidence only for tenant data deletion.',
    });
  const tenantSecretsCapabilityFunction =
    buildTenantOperationCapabilityFunction(scope, capabilityInput, {
      id: 'TenantSecretsCapabilityFunction',
      executorId: 'executor:tenant-secret-deletion',
      allowedSteps: 'delete-secrets',
      description: 'Accepts evidence only for tenant secret deletion.',
    });
  const tenantVerificationCapabilityFunction =
    buildTenantOperationCapabilityFunction(scope, capabilityInput, {
      id: 'TenantVerificationCapabilityFunction',
      executorId: 'executor:tenant-closure-verification',
      allowedSteps: 'verify',
      description: 'Accepts evidence only for final tenant closure verification.',
    });
  new cloudwatch.Alarm(scope, 'TenantOperationDlqAlarm', {
    alarmDescription:
      'Detects tenant lifecycle or audit-retention records that exhausted bounded retries.',
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
  return {
    tenantAccessCapabilityFunction,
    tenantDataCapabilityFunction,
    tenantExportCapabilityFunction,
    tenantIdentityCapabilityFunction,
    tenantOperationDlq,
    tenantOperationFunction,
    tenantSecretsCapabilityFunction,
    tenantVerificationCapabilityFunction,
  };
}

/** Inputs shared by every lifecycle proof-ingress function. */
type TenantOperationCapabilityFunctionInput = {
  /** Immutable audit event table. */
  readonly auditEventsTable: DataStoreResources['auditEventsTable'];
  /** Stable Lambda build paths. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Dynamic operational controls. */
  readonly runtimeControls: RuntimeControlResources;
  /** Tenant lifecycle state table. */
  readonly tenantAdministrationTable: DataStoreResources['tenantAdministrationTable'];
};

/**
 * Builds one function ARN whose environment binds it to a disjoint step set.
 *
 * @param scope - Stack that owns the proof-ingress function.
 * @param input - Shared tables, build paths, and runtime controls.
 * @param spec - Immutable capability identity and allowed steps.
 * @returns A narrow-IAM direct invocation boundary.
 */
function buildTenantOperationCapabilityFunction(
  scope: cdk.Stack,
  input: TenantOperationCapabilityFunctionInput,
  spec: TenantOperationCapabilitySpec,
): lambdaNodejs.NodejsFunction {
  const {
    depsLockFilePath,
    projectRoot,
    serverHandlersDirectory,
  } = input.lambdaBuildPaths;
  const capabilityFunction = new lambdaNodejs.NodejsFunction(scope, spec.id, {
    entry: path.join(
      serverHandlersDirectory,
      'tenant-operation-execution-handler.ts',
    ),
    handler: 'capabilityHandler',
    runtime: lambda.Runtime.NODEJS_22_X,
    tracing: lambda.Tracing.ACTIVE,
    depsLockFilePath,
    projectRoot,
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    reservedConcurrentExecutions: 1,
    description: spec.description,
    bundling: {
      bundleAwsSDK: true,
      minify: true,
      sourceMap: true,
      target: 'node22',
    },
    environment: {
      AUDIT_EVENTS_TABLE_NAME: input.auditEventsTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME:
        input.tenantAdministrationTable.tableName,
      TENANT_OPERATION_ALLOWED_STEPS: spec.allowedSteps,
      TENANT_OPERATION_EXECUTOR_ID: spec.executorId,
    },
  });
  bindRuntimeControls(
    input.runtimeControls,
    capabilityFunction,
    'tenant-operation-execution',
  );
  input.tenantAdministrationTable.grants.readWriteData(capabilityFunction);
  input.auditEventsTable.grants.readWriteData(capabilityFunction);
  return capabilityFunction;
}
