import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { LambdaBuildPaths } from '../../config/lambda-build-paths';
import type { StackParameters } from '../../config/stack-parameters';
import type { DataStoreResources } from '../data-stores';
import type { FileStorageResources } from '../file-storage';
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
  /** File storage whose tenant prefix is exported and deleted. */
  readonly fileStorage: FileStorageResources;
  /** Identity parameters required for session revocation. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls shared by application runtimes. */
  readonly runtimeControls: RuntimeControlResources;
  /** Retained secret containing the shared Workspace audit pseudonym key. */
  readonly workspaceAuditPseudonymSecret: secretsmanager.ISecret;
  /**
   * Deploys the tenant export and closure resource owners, their queues, and the export bucket.
   * Without them the worker only reconciles audit retention.
   */
  readonly lifecycleEnabled: boolean;
}

/** Resource owners, queues, and the export bucket that run tenant export and closure. */
export type TenantLifecycleResources = {
  /** Private, versioned bucket containing expiring tenant export artifacts. */
  readonly tenantExportBucket: s3.Bucket;
  /** Resource owner that creates and verifies export artifacts. */
  readonly tenantExportCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Resource owner that revokes tenant access and active sessions. */
  readonly tenantAccessCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Resource owner that anonymizes deleted tenant members. */
  readonly tenantIdentityCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Resource owner that deletes tenant business data. */
  readonly tenantDataCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Resource owner that deletes tenant credentials and secrets. */
  readonly tenantSecretsCapabilityFunction: lambdaNodejs.NodejsFunction;
  /** Resource owner that verifies tenant closure completion. */
  readonly tenantVerificationCapabilityFunction: lambdaNodejs.NodejsFunction;
};

/** Trusted tenant operation worker resources. */
export type TenantOperationWorkerResources = {
  /** Dead-letter queue for tenant lifecycle and retention stream failures. */
  readonly tenantOperationDlq: sqs.Queue;
  /** Stream-only worker that starts operations and reconciles retention. */
  readonly tenantOperationFunction: lambdaNodejs.NodejsFunction;
  /** Export and closure resources, present only when the lifecycle module is deployed. */
  readonly tenantLifecycle: TenantLifecycleResources | undefined;
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
  /** Capability-isolated resource-owner implementation. */
  readonly owner: 'export' | 'access' | 'identity' | 'data' | 'secrets' | 'verification';
  /** Durable queue consumed only by this owner. */
  readonly queue: sqs.Queue;
};

/** Queue each lifecycle resource owner consumes, keyed by the environment name the starter reads. */
type TenantLifecycleQueues = {
  readonly TENANT_EXPORT_EXECUTION_QUEUE_URL: sqs.Queue;
  readonly TENANT_ACCESS_EXECUTION_QUEUE_URL: sqs.Queue;
  readonly TENANT_IDENTITY_EXECUTION_QUEUE_URL: sqs.Queue;
  readonly TENANT_DATA_EXECUTION_QUEUE_URL: sqs.Queue;
  readonly TENANT_SECRETS_EXECUTION_QUEUE_URL: sqs.Queue;
  readonly TENANT_VERIFICATION_EXECUTION_QUEUE_URL: sqs.Queue;
};

/**
 * Builds the stream-only tenant lifecycle starter and reconciliation worker.
 *
 * @param scope - Stack scope that owns the worker.
 * @param input - Data stores, build paths, runtime controls, and the lifecycle switch.
 * @returns Worker Lambda, retained dead-letter queue, and the optional lifecycle resources.
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
  const lifecycleQueues = input.lifecycleEnabled
    ? buildTenantLifecycleQueues(scope, tenantOperationDlq)
    : undefined;
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
      description: input.lifecycleEnabled
        ? 'Trusted tenant lifecycle executor and audit-retention reconciliation worker.'
        : 'Trusted audit-retention reconciliation worker.',
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
        ...Object.fromEntries(
          Object.entries(lifecycleQueues ?? {}).map(([name, queue]) => [name, queue.queueUrl]),
        ),
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
  for (const queue of Object.values(lifecycleQueues ?? {})) {
    queue.grants.sendMessages(tenantOperationFunction);
  }
  const retentionJobFilter = lambda.FilterCriteria.filter({
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
  });
  // Operation records start export and closure, so they reach the worker only when the
  // resource owners that run them are deployed.
  const operationFilter = lambda.FilterCriteria.filter({
    eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
    dynamodb: {
      NewImage: {
        kind: { S: lambda.FilterRule.isEqual('operation') },
        recordKey: { S: lambda.FilterRule.beginsWith('OPERATION#') },
      },
    },
  });
  tenantOperationFunction.addEventSource(
    new lambdaEventSources.DynamoEventSource(tenantAdministrationTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 1,
      bisectBatchOnError: true,
      parallelizationFactor: 1,
      retryAttempts: 10,
      reportBatchItemFailures: true,
      filters: lifecycleQueues
        ? [operationFilter, retentionJobFilter]
        : [retentionJobFilter],
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
    tenantOperationDlq,
    tenantOperationFunction,
    tenantLifecycle: lifecycleQueues
      ? buildTenantLifecycleOwners(scope, input, lifecycleQueues)
      : undefined,
  };
}

/**
 * Creates one retained execution queue per lifecycle resource owner.
 *
 * @param scope - Stack scope that owns the queues.
 * @param tenantOperationDlq - Shared lifecycle dead-letter queue for exhausted messages.
 * @returns Queues keyed by the environment name the starter reads.
 */
function buildTenantLifecycleQueues(
  scope: cdk.Stack,
  tenantOperationDlq: sqs.Queue,
): TenantLifecycleQueues {
  /** Creates one retained queue with bounded redrive into the shared lifecycle DLQ. */
  const createExecutionQueue = (id: string) => new sqs.Queue(scope, id, {
    deadLetterQueue: {
      maxReceiveCount: 5,
      queue: tenantOperationDlq,
    },
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
    visibilityTimeout: cdk.Duration.minutes(15),
  });
  return {
    TENANT_EXPORT_EXECUTION_QUEUE_URL: createExecutionQueue('TenantExportExecutionQueue'),
    TENANT_ACCESS_EXECUTION_QUEUE_URL: createExecutionQueue('TenantAccessExecutionQueue'),
    TENANT_IDENTITY_EXECUTION_QUEUE_URL: createExecutionQueue('TenantIdentityExecutionQueue'),
    TENANT_DATA_EXECUTION_QUEUE_URL: createExecutionQueue('TenantDataExecutionQueue'),
    TENANT_SECRETS_EXECUTION_QUEUE_URL: createExecutionQueue('TenantSecretsExecutionQueue'),
    TENANT_VERIFICATION_EXECUTION_QUEUE_URL:
      createExecutionQueue('TenantVerificationExecutionQueue'),
  };
}

/**
 * Builds the export bucket and the six capability-isolated lifecycle resource owners.
 *
 * @param scope - Stack scope that owns the resources.
 * @param input - Worker inputs shared with the resource owners.
 * @param queues - Execution queue consumed by each owner.
 * @returns Export bucket and resource-owner functions.
 */
function buildTenantLifecycleOwners(
  scope: cdk.Stack,
  input: TenantOperationWorkerInput,
  queues: TenantLifecycleQueues,
): TenantLifecycleResources {
  const tenantExportBucket = new s3.Bucket(scope, 'TenantExportBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    lifecycleRules: [{
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      expiration: cdk.Duration.days(30),
      id: 'ExpireTenantExports',
      noncurrentVersionExpiration: cdk.Duration.days(30),
    }],
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    versioned: true,
  });
  const capabilityInput = {
    dataStores: input.dataStores,
    fileStorage: input.fileStorage,
    lambdaBuildPaths: input.lambdaBuildPaths,
    parameters: input.parameters,
    runtimeControls: input.runtimeControls,
    tenantExportBucket,
    tenantAdministrationTable: input.dataStores.tenantAdministrationTable,
    workspaceAuditPseudonymSecret: input.workspaceAuditPseudonymSecret,
  };
  return {
    tenantExportBucket,
    tenantExportCapabilityFunction:
      buildTenantOperationCapabilityFunction(scope, capabilityInput, {
        id: 'TenantExportCapabilityFunction',
        executorId: 'executor:tenant-export',
        allowedSteps: 'snapshot,prepare-artifact,verify-artifact,export',
        description: 'Creates and verifies redacted tenant export artifacts.',
        owner: 'export',
        queue: queues.TENANT_EXPORT_EXECUTION_QUEUE_URL,
      }),
    tenantAccessCapabilityFunction:
      buildTenantOperationCapabilityFunction(scope, capabilityInput, {
        id: 'TenantAccessCapabilityFunction',
        executorId: 'executor:tenant-access-revocation',
        allowedSteps: 'revoke-access',
        description: 'Revokes tenant access and active sessions during closure.',
        owner: 'access',
        queue: queues.TENANT_ACCESS_EXECUTION_QUEUE_URL,
      }),
    tenantIdentityCapabilityFunction:
      buildTenantOperationCapabilityFunction(scope, capabilityInput, {
        id: 'TenantIdentityCapabilityFunction',
        executorId: 'executor:tenant-member-anonymization',
        allowedSteps: 'anonymize-members',
        description: 'Anonymizes deleted tenant member identities during closure.',
        owner: 'identity',
        queue: queues.TENANT_IDENTITY_EXECUTION_QUEUE_URL,
      }),
    tenantDataCapabilityFunction:
      buildTenantOperationCapabilityFunction(scope, capabilityInput, {
        id: 'TenantDataCapabilityFunction',
        executorId: 'executor:tenant-data-deletion',
        allowedSteps: 'delete-data',
        description: 'Deletes tenant-owned business data during closure.',
        owner: 'data',
        queue: queues.TENANT_DATA_EXECUTION_QUEUE_URL,
      }),
    tenantSecretsCapabilityFunction:
      buildTenantOperationCapabilityFunction(scope, capabilityInput, {
        id: 'TenantSecretsCapabilityFunction',
        executorId: 'executor:tenant-secret-deletion',
        allowedSteps: 'delete-secrets',
        description: 'Deletes tenant-owned credentials and secrets during closure.',
        owner: 'secrets',
        queue: queues.TENANT_SECRETS_EXECUTION_QUEUE_URL,
      }),
    tenantVerificationCapabilityFunction:
      buildTenantOperationCapabilityFunction(scope, capabilityInput, {
        id: 'TenantVerificationCapabilityFunction',
        executorId: 'executor:tenant-closure-verification',
        allowedSteps: 'verify',
        description: 'Verifies tenant resources are absent before final closure.',
        owner: 'verification',
        queue: queues.TENANT_VERIFICATION_EXECUTION_QUEUE_URL,
      }),
  };
}

/** Inputs shared by every lifecycle resource-owner function. */
type TenantOperationCapabilityFunctionInput = {
  /** Shared tenant-owned DynamoDB stores. */
  readonly dataStores: DataStoreResources;
  /** Tenant file storage used by export and deletion owners. */
  readonly fileStorage: FileStorageResources;
  /** Stable Lambda build paths. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Cognito identity configuration used by access revocation. */
  readonly parameters: StackParameters;
  /** Dynamic operational controls. */
  readonly runtimeControls: RuntimeControlResources;
  /** Private export artifact bucket. */
  readonly tenantExportBucket: s3.Bucket;
  /** Tenant lifecycle state table. */
  readonly tenantAdministrationTable: DataStoreResources['tenantAdministrationTable'];
  /** Retained secret containing the shared Workspace audit pseudonym key. */
  readonly workspaceAuditPseudonymSecret: secretsmanager.ISecret;
};

/**
 * Builds one function ARN whose environment binds it to a disjoint step set.
 *
 * @param scope - Stack that owns the resource-owner function.
 * @param input - Shared tables, build paths, and runtime controls.
 * @param spec - Immutable capability identity and allowed steps.
 * @returns A narrow-IAM queued resource-owner boundary.
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
    handler: 'resourceOwnerHandler',
    runtime: lambda.Runtime.NODEJS_22_X,
    tracing: lambda.Tracing.ACTIVE,
    depsLockFilePath,
    projectRoot,
    timeout: cdk.Duration.minutes(5),
    memorySize: 512,
    reservedConcurrentExecutions: 1,
    description: spec.description,
    bundling: {
      bundleAwsSDK: true,
      minify: true,
      sourceMap: true,
      target: 'node22',
    },
    environment: {
      ANALYTICS_TABLE_NAME: input.dataStores.analyticsTable.tableName,
      AUDIT_EVENTS_TABLE_NAME: input.dataStores.auditEventsTable.tableName,
      AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX:
        input.parameters.automationInboundWebhookSecretPrefix,
      AUTOMATION_TABLE_NAME: input.dataStores.automationTable.tableName,
      AUTOMATION_WEBHOOK_SECRET_PREFIX:
        input.parameters.automationWebhookSecretPrefix,
      CAPACITY_PLANNING_TABLE_NAME:
        input.dataStores.capacityPlanningTable.tableName,
      COGNITO_USER_POOL_ID: input.parameters.cognitoUserPoolId,
      COLLABORATION_TABLE_NAME: input.dataStores.collaborationTable.tableName,
      DEVELOPER_PLATFORM_TABLE_NAME:
        input.dataStores.developerPlatformTable.tableName,
      DOCUMENTS_TABLE_NAME: input.dataStores.documentsTable.tableName,
      ENTERPRISE_IDENTITY_TABLE_NAME:
        input.dataStores.enterpriseIdentityTable.tableName,
      FILE_BUCKET_NAME: input.fileStorage.fileBucket.bucketName,
      FILE_PROOFING_TABLE_NAME: input.dataStores.fileProofingTable.tableName,
      FOCUS_TABLE_NAME: input.dataStores.focusTable.tableName,
      TEAM_ISSUE_EVENTS_TABLE_NAME:
        input.dataStores.teamIssueEventsTable.tableName,
      NOTIFICATIONS_TABLE_NAME: input.dataStores.notificationsTable.tableName,
      PLANNING_TABLE_NAME: input.dataStores.planningTable.tableName,
      PUSH_SUBSCRIPTIONS_TABLE_NAME:
        input.dataStores.pushSubscriptionsTable.tableName,
      AGENT_RUNS_TABLE_NAME: input.dataStores.agentRunsTable.tableName,
      PROJECT_DIRECTORY_TABLE_NAME:
        input.dataStores.projectDirectoryTable.tableName,
      REALTIME_SESSIONS_TABLE_NAME:
        input.dataStores.realtimeSessionsTable.tableName,
      REQUEST_INTAKE_TABLE_NAME: input.dataStores.requestIntakeTable.tableName,
      CUSTOMERS_TABLE_NAME: input.dataStores.customersTable.tableName,
      TENANT_ADMINISTRATION_TABLE_NAME:
        input.tenantAdministrationTable.tableName,
      TENANT_EXPORT_BUCKET_NAME: input.tenantExportBucket.bucketName,
      TENANT_OPERATION_ALLOWED_STEPS: spec.allowedSteps,
      TENANT_OPERATION_EXECUTOR_ID: spec.executorId,
      TENANT_OPERATION_RESOURCE_OWNER: spec.owner,
      TENANT_OPERATION_RESOURCE_OWNER_QUEUE_URL: spec.queue.queueUrl,
      TENANT_OPERATION_PSEUDONYM_SECRET_ARN:
        input.workspaceAuditPseudonymSecret.secretArn,
      WORKSPACE_ACCESS_TABLE_NAME:
        input.dataStores.workspaceAccessTable.tableName,
      WORKSPACE_SEARCH_TABLE_NAME:
        input.dataStores.workspaceSearchTable.tableName,
      WORK_ITEM_CONFIGURATION_TABLE_NAME:
        input.dataStores.workItemConfigurationTable.tableName,
      WORK_ITEM_IMPORT_BUCKET_NAME:
        input.fileStorage.workItemImportBucket.bucketName,
      AUDIT_EXPORT_BUCKET_NAME:
        input.fileStorage.auditExportBucket.bucketName,
      WORK_ITEMS_TABLE_NAME: input.dataStores.workItemsTable.tableName,
    },
  });
  bindRuntimeControls(
    input.runtimeControls,
    capabilityFunction,
    'tenant-operation-execution',
  );
  capabilityFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ],
    resources: [input.tenantAdministrationTable.tableArn],
  }));
  capabilityFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem'],
    resources: [input.dataStores.auditEventsTable.tableArn],
  }));
  spec.queue.grants.consumeMessages(capabilityFunction);
  spec.queue.grants.sendMessages(capabilityFunction);
  input.workspaceAuditPseudonymSecret.grantRead(capabilityFunction);
  capabilityFunction.addEventSource(new lambdaEventSources.SqsEventSource(
    spec.queue,
    {
      batchSize: 1,
      reportBatchItemFailures: true,
    },
  ));
  grantTenantResourceOwner(capabilityFunction, input, spec.owner);
  return capabilityFunction;
}

/** Grants only the concrete stores owned or verified by one lifecycle capability. */
function grantTenantResourceOwner(
  target: lambdaNodejs.NodejsFunction,
  input: TenantOperationCapabilityFunctionInput,
  owner: TenantOperationCapabilitySpec['owner'],
): void {
  const stores = input.dataStores;
  const dataTables = [
    stores.workItemsTable,
    stores.teamIssueEventsTable,
    stores.workItemConfigurationTable,
    stores.automationTable,
    stores.planningTable,
    stores.capacityPlanningTable,
    stores.analyticsTable,
    stores.requestIntakeTable,
    stores.customersTable,
    stores.projectDirectoryTable,
    stores.documentsTable,
    stores.collaborationTable,
    stores.workspaceSearchTable,
    stores.notificationsTable,
    stores.focusTable,
    stores.pushSubscriptionsTable,
    stores.agentRunsTable,
    stores.realtimeSessionsTable,
    stores.fileProofingTable,
  ];
  const secretTables = [
    stores.developerPlatformTable,
    stores.enterpriseIdentityTable,
  ];
  const exportTables = [
    ...dataTables,
    ...secretTables,
    stores.auditEventsTable,
    stores.workspaceAccessTable,
  ];
  const workspaceFilePrefixes = [
    'workspaces/*/files/*',
    'workspaces/*/request-submissions/*',
  ];
  if (owner === 'export') {
    for (const table of exportTables) grantTableRead(target, table);
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [input.fileStorage.fileBucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': workspaceFilePrefixes,
        },
      },
    }));
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [input.fileStorage.fileBucket.arnForObjects('workspaces/*')],
    }));
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [input.fileStorage.workItemImportBucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': ['work-item-imports/*'],
        },
      },
    }));
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [
        input.fileStorage.workItemImportBucket.arnForObjects('work-item-imports/*'),
      ],
    }));
    grantAuditExportList(target, input.fileStorage.auditExportBucket, false);
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [input.fileStorage.auditExportBucket.arnForObjects('audit-exports/*')],
    }));
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [input.tenantExportBucket.arnForObjects('tenant-exports/*')],
    }));
    return;
  }
  if (owner === 'access') {
    grantTableRead(target, stores.workspaceAccessTable);
    grantTableReadWrite(target, stores.realtimeSessionsTable);
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminUserGlobalSignOut'],
      resources: [input.parameters.cognitoUserPoolArn],
    }));
    return;
  }
  if (owner === 'identity') {
    grantTableReadWrite(target, stores.workspaceAccessTable);
    return;
  }
  if (owner === 'data') {
    for (const table of dataTables) grantTableReadWrite(target, table);
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:ListBucketVersions'],
      resources: [input.fileStorage.fileBucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': workspaceFilePrefixes,
        },
      },
    }));
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [input.fileStorage.fileBucket.arnForObjects('workspaces/*')],
    }));
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:ListBucketVersions'],
      resources: [input.fileStorage.workItemImportBucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': ['work-item-imports/*'],
        },
      },
    }));
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [
        input.fileStorage.workItemImportBucket.arnForObjects('work-item-imports/*'),
      ],
    }));
    grantAuditExportList(target, input.fileStorage.auditExportBucket, true);
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [input.fileStorage.auditExportBucket.arnForObjects('audit-exports/*')],
    }));
    return;
  }
  if (owner === 'secrets') {
    for (const table of secretTables) grantTableReadWrite(target, table);
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));
    target.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:DeleteSecret'],
      resources: [
        input.parameters.automationWebhookSecretArn,
        input.parameters.automationInboundWebhookSecretArn,
      ],
    }));
    return;
  }
  for (const table of [...dataTables, ...secretTables]) {
    grantTableRead(target, table);
  }
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:ListSecrets'],
    resources: ['*'],
  }));
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket', 's3:ListBucketVersions'],
    resources: [input.fileStorage.fileBucket.bucketArn],
    conditions: {
      StringLike: {
        's3:prefix': workspaceFilePrefixes,
      },
    },
  }));
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket', 's3:ListBucketVersions'],
    resources: [input.fileStorage.workItemImportBucket.bucketArn],
    conditions: {
      StringLike: {
        's3:prefix': ['work-item-imports/*'],
      },
    },
  }));
  grantAuditExportList(target, input.fileStorage.auditExportBucket, true);
}

/**
 * Grants listing of the tenant audit export namespace.
 *
 * @param target Resource-owner Lambda that inspects audit exports.
 * @param bucket Audit export bucket.
 * @param includeVersions Whether object versions must also be listed.
 */
function grantAuditExportList(
  target: lambdaNodejs.NodejsFunction,
  bucket: s3.IBucket,
  includeVersions: boolean,
): void {
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: includeVersions ? ['s3:ListBucket', 's3:ListBucketVersions'] : ['s3:ListBucket'],
    resources: [bucket.bucketArn],
    conditions: {
      StringLike: {
        's3:prefix': ['audit-exports/*'],
      },
    },
  }));
}

/** Grants base-table reads without the unused all-index wildcard emitted by CDK grants. */
function grantTableRead(
  target: lambdaNodejs.NodejsFunction,
  table: dynamodb.ITable,
): void {
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:Scan',
    ],
    resources: [table.tableArn],
  }));
}

/** Grants only bounded base-table reads and item writes used by deletion owners. */
function grantTableReadWrite(
  target: lambdaNodejs.NodejsFunction,
  table: dynamodb.ITable,
): void {
  target.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:BatchWriteItem',
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:UpdateItem',
    ],
    resources: [table.tableArn],
  }));
}
