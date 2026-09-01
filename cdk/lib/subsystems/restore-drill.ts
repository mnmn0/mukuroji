import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctionsTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import {
  resolveLambdaHandlerEntry,
  type LambdaBuildPaths,
} from '../config/lambda-build-paths';
import type { DataStoreResources } from './data-stores';
import type { FileStorageResources } from './file-storage';

const evidenceRetentionDays = 400;
const evidenceDigestEncryptionPurpose = 'restore-drill-evidence-digest-v1';
const restoreTableNamePrefix = 'mukuroji-restore-drill-';
const metricNamespace = 'Mukuroji/RestoreDrill';
// Leaves more than 10,000 Standard Workflow history events for failure finalization.
const runnerWorkflowPollBudget = 1_200;
const approvalRunAttributeNames = [
  'approvalDigest',
  'approvalObjectKey',
  'approvedAt',
  'cleanupAttemptCount',
  'cleanupEffectIndex',
  'cleanupExecutionArn',
  'cleanupExecutionName',
  'cleanupPolicyVersion',
  'cleanupStartedAt',
  'deadlineAt',
  'digestKeyEnvelope',
  'drillId',
  'failureCodes',
  'kind',
  'outcome',
  'phase',
  'recordKey',
  'resourceDigest',
  'restorePoint',
  'resultDigest',
  'resultEvidenceKey',
  'resultOutcome',
  'revision',
  'runnerExecutionArn',
  'runVersion',
  'scopeKey',
  'startedAt',
  'updatedAt',
  'verificationCompletedAt',
];
const approvalControlAttributeNames = [
  'activeDrillId',
  'recordKey',
  'scopeKey',
];
const cleanupProgressAttributeNames = [
  'kind',
  'payloadJson',
  'recordKey',
  'scopeKey',
];
const cleanupRunMutableAttributeNames = [
  'approvalDigest',
  'approvalObjectKey',
  'approvedAt',
  'cleanupAttemptCount',
  'cleanupEffectIndex',
  'cleanupExecutionArn',
  'cleanupExecutionName',
  'cleanupStartedAt',
  'outcome',
  'phase',
  'recordKey',
  'revision',
  'scopeKey',
  'updatedAt',
];
const cleanupControlMutableAttributeNames = [
  'activeDrillId',
  'recordKey',
  'revision',
  'scopeKey',
];

/**
 * Existing resources and immutable configuration consumed by restore-drill infrastructure.
 */
export interface RestoreDrillInput {
  /** Existing data-owner IAM role exclusively authorized to approve cleanup. */
  readonly cleanupApproverRoleArn: cdk.CfnParameter;
  /** Existing application tables, of which exactly seven are eligible restore sources. */
  readonly dataStores: DataStoreResources;
  /** Existing versioned file storage inspected only through exact object versions. */
  readonly fileStorage: FileStorageResources;
  /** Stable paths used to bundle restore-drill Lambda handlers. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Revision used to replace the retained restore-only pseudonym secret. */
  readonly apiRuntimeConfigurationRevision: cdk.CfnParameter;
  /** NoEcho HMAC key stored in Secrets Manager instead of a Lambda environment variable. */
  readonly workspaceAuditPseudonymKey: cdk.CfnParameter;
}

/**
 * Isolated restore-drill orchestration, evidence, state, and operator resources.
 */
export type RestoreDrillResources = Readonly<{
  /** Role used only by the approval-gated cleanup Lambda. */
  readonly cleanupRole: iam.Role;
  /** Unattached policy that can record approval and start only the cleanup workflow. */
  readonly cleanupApprovalPolicy: iam.ManagedPolicy;
  /** Standard workflow that removes approved isolated resources and records the result. */
  readonly cleanupWorkflow: stepfunctions.StateMachine;
  /** Append-only Object Lock bucket containing secret-free drill evidence. */
  readonly evidenceBucket: s3.Bucket;
  /** Customer-managed key that encrypts restore-drill evidence. */
  readonly evidenceKey: kms.Key;
  /** Role used only by the restore-drill runner Lambda. */
  readonly runnerRole: iam.Role;
  /** Temporary isolated object and DynamoDB export bucket. */
  readonly scratchBucket: s3.Bucket;
  /** Customer-managed key that encrypts isolated scratch objects. */
  readonly scratchKey: kms.Key;
  /** Retained dead-letter queue for cadence and timeout-finalizer deliveries. */
  readonly scheduleDlq: sqs.Queue;
  /** Protected durable run, checkpoint, and cleanup state. */
  readonly stateTable: dynamodb.Table;
  /** Standard restore workflow started by the daily cadence scanner. */
  readonly workflow: stepfunctions.StateMachine;
}>;

/**
 * Adds append-only and encryption enforcement to the evidence bucket.
 *
 * @param bucket Evidence bucket protected by the policy.
 * @param key Customer-managed key required for every evidence upload.
 */
function configureEvidenceBucketPolicy(bucket: s3.Bucket, key: kms.Key): void {
  const immutableObjectArns = [
    bucket.arnForObjects('approvals/v1/runs/*'),
    bucket.arnForObjects('evidence/v1/*'),
  ];
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyRestoreDrillEvidenceDeletion',
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    resources: [bucket.arnForObjects('*')],
  }));
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyUnconditionalRestoreDrillEvidenceUploads',
    actions: ['s3:PutObject'],
    conditions: {
      Null: {
        's3:if-none-match': 'true',
      },
    },
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    resources: immutableObjectArns,
  }));
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyNonExclusiveRestoreDrillEvidenceUploads',
    actions: ['s3:PutObject'],
    conditions: {
      StringNotEquals: {
        's3:if-none-match': '*',
      },
    },
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    resources: immutableObjectArns,
  }));
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyNonKmsRestoreDrillEvidenceUploads',
    actions: ['s3:PutObject'],
    conditions: {
      StringNotEquals: {
        's3:x-amz-server-side-encryption': 'aws:kms',
      },
    },
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    resources: immutableObjectArns,
  }));
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyWrongRestoreDrillEvidenceKey',
    actions: ['s3:PutObject'],
    conditions: {
      StringNotEquals: {
        's3:x-amz-server-side-encryption-aws-kms-key-id': key.keyArn,
      },
    },
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    resources: immutableObjectArns,
  }));

  const bucketPolicy = bucket.policy;
  if (!bucketPolicy) {
    throw new Error('Restore-drill evidence bucket policy was not created.');
  }
  bucketPolicy.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
}

/**
 * Grants a role append-only evidence writes with all required request headers.
 *
 * @param role Restore-drill execution role receiving the bounded write grant.
 * @param bucket Evidence bucket containing the fixed v1 prefix.
 * @param key Customer-managed evidence key.
 * @param objectPattern Exact immutable evidence object pattern owned by the role.
 */
function grantEvidenceWriter(
  role: iam.Role,
  bucket: s3.Bucket,
  key: kms.Key,
  objectPattern: string,
): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:PutObject'],
    conditions: {
      StringEquals: {
        's3:if-none-match': '*',
        's3:x-amz-server-side-encryption': 'aws:kms',
        's3:x-amz-server-side-encryption-aws-kms-key-id': key.keyArn,
      },
    },
    resources: [bucket.arnForObjects(objectPattern)],
  }));
}

/**
 * Grants direct evidence-digest envelope cryptography for one exact purpose.
 *
 * @param role Restore-drill role receiving the bounded direct KMS grant.
 * @param key Customer-managed evidence key.
 * @param actions Exact direct KMS data-plane actions required by the role.
 */
function grantEvidenceDigestCryptography(
  role: iam.Role,
  key: kms.Key,
  actions: readonly string[],
): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [...actions],
    conditions: {
      StringEquals: {
        'kms:EncryptionContext:purpose': evidenceDigestEncryptionPurpose,
      },
    },
    resources: [key.keyArn],
  }));
}

/**
 * Grants evidence-bucket SSE-KMS operations only through the regional S3 service.
 *
 * @param role Restore-drill role receiving the bounded S3-mediated KMS grant.
 * @param bucket Evidence bucket whose bucket-key context must be present.
 * @param key Customer-managed evidence key.
 */
function grantEvidenceBucketCryptography(
  role: iam.Role,
  bucket: s3.Bucket,
  key: kms.Key,
): void {
  const stack = cdk.Stack.of(role);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
    conditions: {
      StringEquals: {
        'kms:EncryptionContext:aws:s3:arn': bucket.bucketArn,
        'kms:ViaService': cdk.Fn.join('', [
          's3.',
          stack.region,
          '.',
          stack.urlSuffix,
        ]),
      },
    },
    resources: [key.keyArn],
  }));
}

/**
 * Adds one single-datapoint operational alarm.
 *
 * @param scope Stack that owns the alarm.
 * @param id Stable construct identifier.
 * @param description Operator-facing remediation signal.
 * @param metric Metric evaluated by the alarm.
 * @param threshold Breach threshold.
 * @param comparison Comparison applied to the threshold.
 */
function addOperationalAlarm(
  scope: cdk.Stack,
  id: string,
  description: string,
  metric: cloudwatch.IMetric,
  threshold: number,
  comparison = cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
): void {
  new cloudwatch.Alarm(scope, id, {
    alarmDescription: description,
    comparisonOperator: comparison,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric,
    threshold,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}

/**
 * Creates the custom metric contract emitted by the restore runner.
 *
 * @param metricName Exact metric name emitted by the handler.
 * @param statistic CloudWatch aggregation used for alarm evaluation.
 * @returns Metric scoped to the isolated restore-drill service.
 */
function restoreDrillMetric(
  metricName: string,
  statistic: string,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    dimensionsMap: { Service: 'mukuroji-restore-drill' },
    metricName,
    namespace: metricNamespace,
    period: cdk.Duration.minutes(5),
    statistic,
  });
}

/**
 * Creates the bounded physical cleanup workflow name without a resource reference.
 *
 * @param scope Stack whose deployment identity scopes the workflow name.
 * @returns Stable Step Functions name safe to reuse in exact IAM execution ARNs.
 */
export function createRestoreDrillCleanupWorkflowName(scope: cdk.Stack): string {
  return `${cdk.Names.uniqueResourceName(scope, {
    allowedSpecialCharacters: '-',
    maxLength: 48,
    separator: '-',
  })}-restore-drill-cleanup`;
}

/**
 * Builds isolated, scheduled DynamoDB and S3 restore validation infrastructure.
 *
 * The daily schedule only performs a durable due check. The handler starts a
 * drill at 89 days, emits an overdue metric at 90 days, and uses a conditional
 * state write to prevent overlapping runs. Production resources are never
 * exposed to cleanup or application runtime roles.
 *
 * @param scope Stack that owns the restore-drill control plane.
 * @param input Existing sources, Lambda paths, and secret parameters.
 * @returns Isolated restore, evidence, cleanup, and approval resources.
 */
export function buildRestoreDrill(
  scope: cdk.Stack,
  input: RestoreDrillInput,
): RestoreDrillResources {
  const cleanupWorkflowName = createRestoreDrillCleanupWorkflowName(scope);
  const sourceTables = [
    input.dataStores.workItemsTable,
    input.dataStores.workItemConfigurationTable,
    input.dataStores.projectDirectoryTable,
    input.dataStores.workspaceAccessTable,
    input.dataStores.auditEventsTable,
    input.dataStores.fileProofingTable,
    input.dataStores.customersTable,
  ];
  const sourceTableArns = sourceTables.map((table) => table.tableArn);
  const sourceExportArns = sourceTables.map((table) => scope.formatArn({
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    resource: 'table',
    resourceName: `${table.tableName}/export/*`,
    service: 'dynamodb',
  }));
  const restoreTableArn = scope.formatArn({
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    resource: 'table',
    resourceName: `${restoreTableNamePrefix}*`,
    service: 'dynamodb',
  });

  const stateTable = new dynamodb.Table(scope, 'RestoreDrillStateTable', {
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    deletionProtection: true,
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    partitionKey: { name: 'scopeKey', type: dynamodb.AttributeType.STRING },
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    sortKey: { name: 'recordKey', type: dynamodb.AttributeType.STRING },
  });

  const scratchKey = new kms.Key(scope, 'RestoreDrillScratchKey', {
    description: 'Encrypts isolated restore-drill exports and exact-version file copies.',
    enableKeyRotation: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const scratchBucket = new s3.Bucket(scope, 'RestoreDrillScratchBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    bucketKeyEnabled: true,
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: scratchKey,
    enforceSSL: true,
    minimumTLSVersion: 1.2,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    versioned: true,
  });

  const evidenceAccessLogsBucket = new s3.Bucket(
    scope,
    'RestoreDrillEvidenceAccessLogsBucket',
    {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{
        expiration: cdk.Duration.days(evidenceRetentionDays),
        id: 'ExpireRestoreDrillEvidenceAccessLogs',
        noncurrentVersionExpiration: cdk.Duration.days(evidenceRetentionDays),
      }],
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    },
  );
  const evidenceKey = new kms.Key(scope, 'RestoreDrillEvidenceKey', {
    description: 'Encrypts immutable secret-free restore-drill evidence.',
    enableKeyRotation: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const evidenceBucket = new s3.Bucket(scope, 'RestoreDrillEvidenceBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    bucketKeyEnabled: true,
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: evidenceKey,
    enforceSSL: true,
    minimumTLSVersion: 1.2,
    objectLockDefaultRetention: s3.ObjectLockRetention.compliance(
      cdk.Duration.days(evidenceRetentionDays),
    ),
    objectLockEnabled: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    serverAccessLogsBucket: evidenceAccessLogsBucket,
    serverAccessLogsPrefix: 'restore-drill-evidence/',
    versioned: true,
  });
  configureEvidenceBucketPolicy(evidenceBucket, evidenceKey);
  const evidenceAccessLogsPolicy = evidenceAccessLogsBucket.policy;
  if (!evidenceAccessLogsPolicy) {
    throw new Error('Restore-drill evidence access-log policy was not created.');
  }
  evidenceAccessLogsPolicy.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const secretNamePrefix = cdk.Names.uniqueResourceName(scope, {
    allowedSpecialCharacters: '-',
    maxLength: 32,
    separator: '-',
  });
  const workspaceAuditPseudonymSecret = new secretsmanager.Secret(
    scope,
    'RestoreDrillWorkspaceAuditPseudonymSecret',
    {
      description:
        'Revision-bound Workspace audit pseudonym key consumed only by restore validation.',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      secretName: cdk.Fn.join('-', [
        secretNamePrefix,
        'restore-drill-audit-v1',
        input.apiRuntimeConfigurationRevision.valueAsString,
      ]),
      secretStringValue: cdk.SecretValue.unsafePlainText(
        input.workspaceAuditPseudonymKey.valueAsString,
      ),
    },
  );

  const runnerRole = new iam.Role(scope, 'RestoreDrillRunnerRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description:
      'Runs isolated restore validation without production writes or cleanup access.',
  });
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:DescribeContinuousBackups',
      'dynamodb:DescribeTable',
      'dynamodb:DescribeTimeToLive',
      'dynamodb:ExportTableToPointInTime',
      'dynamodb:RestoreTableToPointInTime',
    ],
    resources: sourceTableArns,
  }));
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:DescribeExport'],
    resources: sourceExportArns,
  }));
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:BatchWriteItem',
      'dynamodb:DeleteItem',
      'dynamodb:DescribeTable',
      'dynamodb:DescribeTimeToLive',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:UpdateItem',
    ],
    resources: [restoreTableArn],
  }));
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:TransactWriteItems',
      'dynamodb:UpdateItem',
    ],
    conditions: {
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': [
          'CONTROL',
          'RESTORE_DRILL#*',
          'RESTORE_DRILL_LEDGER#*',
        ],
      },
    },
    resources: [stateTable.tableArn],
  }));
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      's3:GetObjectVersion',
      's3:GetObjectVersionAttributes',
      's3:GetObjectVersionTagging',
    ],
    resources: [input.fileStorage.fileBucket.arnForObjects('workspaces/*')],
  }));
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetBucketVersioning', 's3:GetEncryptionConfiguration'],
    resources: [input.fileStorage.fileBucket.bucketArn, scratchBucket.bucketArn],
  }));
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      's3:ListBucket',
      's3:ListBucketMultipartUploads',
      's3:ListBucketVersions',
    ],
    conditions: {
      StringLike: {
        's3:prefix': ['restore-drill/*', 'workspaces/*'],
      },
    },
    resources: [scratchBucket.bucketArn],
  }));
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      's3:AbortMultipartUpload',
      's3:GetObjectVersion',
      's3:GetObjectVersionAttributes',
      's3:GetObjectVersionTagging',
      's3:PutObject',
      's3:PutObjectAcl',
      's3:PutObjectTagging',
    ],
    resources: [
      scratchBucket.arnForObjects('restore-drill/*'),
      scratchBucket.arnForObjects('workspaces/*'),
    ],
  }));
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudwatch:PutMetricData'],
    conditions: { StringEquals: { 'cloudwatch:namespace': metricNamespace } },
    resources: ['*'],
  }));
  scratchKey.grants.encryptDecrypt(runnerRole);
  workspaceAuditPseudonymSecret.grantRead(runnerRole);
  grantEvidenceWriter(
    runnerRole,
    evidenceBucket,
    evidenceKey,
    'evidence/v1/runs/*/result.json',
  );
  runnerRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:GetObjectRetention', 's3:GetObjectVersion'],
    resources: [evidenceBucket.arnForObjects('evidence/v1/runs/*/result.json')],
  }));
  grantEvidenceDigestCryptography(
    runnerRole,
    evidenceKey,
    ['kms:Decrypt', 'kms:Encrypt'],
  );
  grantEvidenceBucketCryptography(runnerRole, evidenceBucket, evidenceKey);

  const cleanupRole = new iam.Role(scope, 'RestoreDrillCleanupRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description:
      'Removes only approval-gated restore-drill tables and scratch objects.',
  });
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:DeleteTable', 'dynamodb:DescribeTable'],
    resources: [restoreTableArn],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    conditions: {
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': [
          'CONTROL',
          'RESTORE_DRILL_CLEANUP#*',
          'RESTORE_DRILL_LEDGER#*',
        ],
      },
    },
    resources: [stateTable.tableArn],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    conditions: {
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': approvalRunAttributeNames,
      },
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['RESTORE_DRILL#*'],
      },
      StringEquals: {
        'dynamodb:Select': 'SPECIFIC_ATTRIBUTES',
      },
    },
    resources: [stateTable.tableArn],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query'],
    conditions: {
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['RESTORE_DRILL_LEDGER#*'],
      },
    },
    resources: [stateTable.tableArn],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem'],
    conditions: {
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': cleanupProgressAttributeNames,
      },
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['RESTORE_DRILL_CLEANUP#*'],
      },
    },
    resources: [stateTable.tableArn],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    conditions: {
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': cleanupRunMutableAttributeNames,
      },
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['RESTORE_DRILL#*'],
      },
    },
    resources: [stateTable.tableArn],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    conditions: {
      'ForAllValues:StringEquals': {
        'dynamodb:Attributes': cleanupControlMutableAttributeNames,
        'dynamodb:LeadingKeys': ['CONTROL'],
      },
    },
    resources: [stateTable.tableArn],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucketMultipartUploads'],
    conditions: {
      StringLike: {
        's3:prefix': ['restore-drill/*', 'workspaces/*'],
      },
    },
    resources: [scratchBucket.bucketArn],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      's3:AbortMultipartUpload',
      's3:DeleteObjectVersion',
      's3:GetObjectVersionAttributes',
      's3:ListMultipartUploadParts',
    ],
    resources: [
      scratchBucket.arnForObjects('restore-drill/*'),
      scratchBucket.arnForObjects('workspaces/*'),
    ],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudwatch:PutMetricData'],
    conditions: { StringEquals: { 'cloudwatch:namespace': metricNamespace } },
    resources: ['*'],
  }));
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['states:DescribeExecution'],
    resources: [scope.formatArn({
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      resource: 'execution',
      resourceName: `${cleanupWorkflowName}:restore-cleanup-*`,
      service: 'states',
    })],
  }));
  grantEvidenceWriter(
    cleanupRole,
    evidenceBucket,
    evidenceKey,
    'evidence/v1/runs/*/cleanup.json',
  );
  cleanupRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:GetObjectRetention', 's3:GetObjectVersion'],
    resources: [
      evidenceBucket.arnForObjects('approvals/v1/runs/*'),
      evidenceBucket.arnForObjects('evidence/v1/runs/*/cleanup.json'),
      evidenceBucket.arnForObjects('evidence/v1/runs/*/result.json'),
    ],
  }));
  grantEvidenceDigestCryptography(cleanupRole, evidenceKey, ['kms:Decrypt']);
  grantEvidenceBucketCryptography(cleanupRole, evidenceBucket, evidenceKey);

  const runnerLogGroup = new logs.LogGroup(scope, 'RestoreDrillRunnerLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.ONE_YEAR,
  });
  runnerLogGroup.grants.write(runnerRole);
  const runnerFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'RestoreDrillRunnerFunction',
    {
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      depsLockFilePath: input.lambdaBuildPaths.depsLockFilePath,
      description:
        'Advances durable isolated DynamoDB and exact-version S3 restore drills.',
      entry: resolveLambdaHandlerEntry(
        input.lambdaBuildPaths,
        'restore-drill-handler.ts',
      ),
      environment: {
        AUDIT_EVENTS_TABLE_NAME: input.dataStores.auditEventsTable.tableName,
        AUDIT_PSEUDONYM_SECRET_ARN: workspaceAuditPseudonymSecret.secretArn,
        EVIDENCE_BUCKET_NAME: evidenceBucket.bucketName,
        EVIDENCE_KEY_ARN: evidenceKey.keyArn,
        FILE_BUCKET_NAME: input.fileStorage.fileBucket.bucketName,
        FILE_PROOFING_TABLE_NAME: input.dataStores.fileProofingTable.tableName,
        CUSTOMERS_TABLE_NAME: input.dataStores.customersTable.tableName,
        METRIC_NAMESPACE: metricNamespace,
        PROJECT_DIRECTORY_TABLE_NAME:
          input.dataStores.projectDirectoryTable.tableName,
        SCRATCH_BUCKET_NAME: scratchBucket.bucketName,
        SCRATCH_KEY_ARN: scratchKey.keyArn,
        STATE_TABLE_NAME: stateTable.tableName,
        TARGET_TABLE_PREFIX: restoreTableNamePrefix,
        WORKSPACE_ACCESS_TABLE_NAME:
          input.dataStores.workspaceAccessTable.tableName,
        WORK_ITEM_CONFIGURATION_TABLE_NAME:
          input.dataStores.workItemConfigurationTable.tableName,
        WORK_ITEMS_TABLE_NAME: input.dataStores.workItemsTable.tableName,
      },
      handler: 'handler',
      logGroup: runnerLogGroup,
      memorySize: 2_048,
      projectRoot: input.lambdaBuildPaths.projectRoot,
      role: runnerRole,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(15),
      tracing: lambda.Tracing.ACTIVE,
    },
  );

  const cleanupLogGroup = new logs.LogGroup(scope, 'RestoreDrillCleanupLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.ONE_YEAR,
  });
  cleanupLogGroup.grants.write(cleanupRole);
  const cleanupFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'RestoreDrillCleanupFunction',
    {
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      depsLockFilePath: input.lambdaBuildPaths.depsLockFilePath,
      description:
        'Advances approval-gated cleanup of isolated restore-drill resources.',
      entry: resolveLambdaHandlerEntry(
        input.lambdaBuildPaths,
        'restore-drill-handler.ts',
      ),
      environment: {
        AUTHORIZED_APPROVER_ROLE_ARN:
          input.cleanupApproverRoleArn.valueAsString,
        CLEANUP_WORKFLOW_NAME: cleanupWorkflowName,
        EVIDENCE_BUCKET_NAME: evidenceBucket.bucketName,
        EVIDENCE_KEY_ARN: evidenceKey.keyArn,
        METRIC_NAMESPACE: metricNamespace,
        SCRATCH_BUCKET_NAME: scratchBucket.bucketName,
        STATE_TABLE_NAME: stateTable.tableName,
        TARGET_TABLE_PREFIX: restoreTableNamePrefix,
      },
      handler: 'cleanupHandler',
      logGroup: cleanupLogGroup,
      memorySize: 512,
      projectRoot: input.lambdaBuildPaths.projectRoot,
      role: cleanupRole,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(15),
      tracing: lambda.Tracing.ACTIVE,
    },
  );

  const workflowLogGroup = new logs.LogGroup(scope, 'RestoreDrillWorkflowLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.ONE_YEAR,
  });
  const workflowSucceeded = new stepfunctions.Succeed(
    scope,
    'RestoreDrillAwaitingCleanupApproval',
  );
  const workflowNotDue = new stepfunctions.Succeed(scope, 'RestoreDrillNotDue');
  const workflowFailed = new stepfunctions.Fail(scope, 'RestoreDrillFailed', {
    cause: 'Restore drill failed; inspect immutable evidence and remediation state.',
  });
  const workflowUnexpectedStatus = new stepfunctions.Fail(
    scope,
    'RestoreDrillUnexpectedStatus',
    { cause: 'Restore drill handler returned an unsupported status.' },
  );
  const initialFailureFinalizer = new stepfunctionsTasks.LambdaInvoke(
    scope,
    'FinalizeRestoreDrillInitialTaskFailure',
    {
      lambdaFunction: runnerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'finalize-failure',
        runnerExecutionArn:
          stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.finalizer',
    },
  );
  const waitForInitialFailureFinalizer = new stepfunctions.Wait(
    scope,
    'WaitForRestoreDrillInitialFailureFinalizer',
    {
      time: stepfunctions.WaitTime.secondsPath('$.finalizer.waitSeconds'),
    },
  );
  waitForInitialFailureFinalizer.next(initialFailureFinalizer);
  const chooseInitialFailureFinalizerStatus = new stepfunctions.Choice(
    scope,
    'ChooseRestoreDrillInitialFailureFinalizerStatus',
  );
  initialFailureFinalizer.next(chooseInitialFailureFinalizerStatus);
  chooseInitialFailureFinalizerStatus
    .when(
      stepfunctions.Condition.stringEquals('$.finalizer.status', 'pending'),
      waitForInitialFailureFinalizer,
    )
    .when(
      stepfunctions.Condition.stringEquals(
        '$.finalizer.status',
        'awaiting-cleanup-approval',
      ),
      workflowFailed,
    )
    .otherwise(workflowFailed);
  const pollFailureFinalizer = new stepfunctionsTasks.LambdaInvoke(
    scope,
    'FinalizeRestoreDrillPollTaskFailure',
    {
      lambdaFunction: runnerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'finalize-failure',
        drillId: stepfunctions.JsonPath.stringAt('$.result.drillId'),
        runnerExecutionArn:
          stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.finalizer',
    },
  );
  const waitForPollFailureFinalizer = new stepfunctions.Wait(
    scope,
    'WaitForRestoreDrillPollFailureFinalizer',
    {
      time: stepfunctions.WaitTime.secondsPath('$.finalizer.waitSeconds'),
    },
  );
  waitForPollFailureFinalizer.next(pollFailureFinalizer);
  const choosePollFailureFinalizerStatus = new stepfunctions.Choice(
    scope,
    'ChooseRestoreDrillPollFailureFinalizerStatus',
  );
  pollFailureFinalizer.next(choosePollFailureFinalizerStatus);
  choosePollFailureFinalizerStatus
    .when(
      stepfunctions.Condition.stringEquals('$.finalizer.status', 'pending'),
      waitForPollFailureFinalizer,
    )
    .when(
      stepfunctions.Condition.stringEquals(
        '$.finalizer.status',
        'awaiting-cleanup-approval',
      ),
      workflowFailed,
    )
    .otherwise(workflowFailed);
  const pollBudgetFailureFinalizer = new stepfunctionsTasks.LambdaInvoke(
    scope,
    'FinalizeRestoreDrillPollBudgetExhaustion',
    {
      lambdaFunction: runnerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'finalize-poll-budget-exceeded',
        drillId: stepfunctions.JsonPath.stringAt('$.result.drillId'),
        runnerExecutionArn:
          stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.finalizer',
    },
  );
  const waitForPollBudgetFailureFinalizer = new stepfunctions.Wait(
    scope,
    'WaitForRestoreDrillPollBudgetFinalizer',
    {
      time: stepfunctions.WaitTime.secondsPath('$.finalizer.waitSeconds'),
    },
  );
  waitForPollBudgetFailureFinalizer.next(pollBudgetFailureFinalizer);
  const waitForPollBudgetFinalizerServiceRecovery = new stepfunctions.Wait(
    scope,
    'WaitForRestoreDrillPollBudgetFinalizerServiceRecovery',
    {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(1)),
    },
  );
  waitForPollBudgetFinalizerServiceRecovery.next(pollBudgetFailureFinalizer);
  pollBudgetFailureFinalizer.addCatch(
    waitForPollBudgetFinalizerServiceRecovery,
    {
      errors: ['States.ALL'],
      resultPath: '$.error',
    },
  );
  const choosePollBudgetFailureFinalizerStatus = new stepfunctions.Choice(
    scope,
    'ChooseRestoreDrillPollBudgetFinalizerStatus',
  );
  pollBudgetFailureFinalizer.next(choosePollBudgetFailureFinalizerStatus);
  choosePollBudgetFailureFinalizerStatus
    .when(
      stepfunctions.Condition.stringEquals('$.finalizer.status', 'pending'),
      waitForPollBudgetFailureFinalizer,
    )
    .when(
      stepfunctions.Condition.stringEquals(
        '$.finalizer.status',
        'awaiting-cleanup-approval',
      ),
      workflowFailed,
    )
    .otherwise(workflowFailed);
  const advanceRestoreDrill = new stepfunctionsTasks.LambdaInvoke(
    scope,
    'AdvanceRestoreDrill',
    {
      lambdaFunction: runnerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'advance',
        event: stepfunctions.JsonPath.objectAt('$.scheduledEvent'),
        runnerExecutionArn:
          stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.result',
    },
  );
  advanceRestoreDrill.addCatch(initialFailureFinalizer, {
    errors: ['States.ALL'],
    resultPath: '$.error',
  });
  const pollRestoreDrill = new stepfunctionsTasks.LambdaInvoke(
    scope,
    'PollRestoreDrill',
    {
      lambdaFunction: runnerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'advance',
        drillId: stepfunctions.JsonPath.stringAt('$.result.drillId'),
        runnerExecutionArn:
          stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.result',
    },
  );
  pollRestoreDrill.addCatch(pollFailureFinalizer, {
    errors: ['States.ALL'],
    resultPath: '$.error',
  });
  const waitForRestore = new stepfunctions.Wait(scope, 'WaitForRestoreDrill', {
    time: stepfunctions.WaitTime.secondsPath('$.result.waitSeconds'),
  });
  waitForRestore.next(pollRestoreDrill);
  const incrementRestorePollCount = new stepfunctions.Pass(
    scope,
    'IncrementRestoreDrillPollCount',
    {
      parameters: {
        pollCount: stepfunctions.JsonPath.mathAdd(
          stepfunctions.JsonPath.numberAt('$.pollCount'),
          1,
        ),
        result: stepfunctions.JsonPath.objectAt('$.result'),
      },
    },
  );
  incrementRestorePollCount.next(waitForRestore);
  const chooseRestoreStatus = new stepfunctions.Choice(
    scope,
    'ChooseRestoreDrillStatus',
  );
  pollRestoreDrill.next(chooseRestoreStatus);
  chooseRestoreStatus
    .when(
      stepfunctions.Condition.and(
        stepfunctions.Condition.stringEquals('$.result.status', 'pending'),
        stepfunctions.Condition.numberLessThan(
          '$.pollCount',
          runnerWorkflowPollBudget,
        ),
      ),
      incrementRestorePollCount,
    )
    .when(
      stepfunctions.Condition.stringEquals('$.result.status', 'pending'),
      pollBudgetFailureFinalizer,
    )
    .when(
      stepfunctions.Condition.stringEquals(
        '$.result.status',
        'awaiting-cleanup-approval',
      ),
      workflowSucceeded,
    )
    .when(
      stepfunctions.Condition.stringEquals('$.result.status', 'not-due'),
      workflowNotDue,
    )
    .when(
      stepfunctions.Condition.stringEquals('$.result.status', 'failed'),
      workflowFailed,
    )
    .otherwise(workflowUnexpectedStatus);
  advanceRestoreDrill.next(chooseRestoreStatus);
  const initializeRestorePollBudget = new stepfunctions.Pass(
    scope,
    'InitializeRestoreDrillPollBudget',
    {
      parameters: {
        pollCount: 0,
        scheduledEvent: stepfunctions.JsonPath.objectAt('$'),
      },
    },
  );
  initializeRestorePollBudget.next(advanceRestoreDrill);

  const workflow = new stepfunctions.StateMachine(scope, 'RestoreDrillWorkflow', {
    definitionBody: stepfunctions.DefinitionBody.fromChainable(
      initializeRestorePollBudget,
    ),
    logs: {
      destination: workflowLogGroup,
      includeExecutionData: false,
      level: stepfunctions.LogLevel.ERROR,
    },
    stateMachineType: stepfunctions.StateMachineType.STANDARD,
    timeout: cdk.Duration.minutes(270),
    tracingEnabled: true,
  });

  const timeoutFinalizerLogGroup = new logs.LogGroup(
    scope,
    'RestoreDrillTimeoutFinalizerWorkflowLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.ONE_YEAR,
    },
  );
  const timeoutFinalizerSucceeded = new stepfunctions.Succeed(
    scope,
    'RestoreDrillTimeoutFinalizerCompleted',
  );
  const timeoutFinalizerFailed = new stepfunctions.Fail(
    scope,
    'RestoreDrillTimeoutFinalizerFailed',
    {
      cause:
        'Timed-out restore drill could not be sealed into immutable failure evidence.',
    },
  );
  const finalizeTimedOutRestoreDrill = new stepfunctionsTasks.LambdaInvoke(
    scope,
    'FinalizeTimedOutRestoreDrill',
    {
      lambdaFunction: runnerFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'finalize-failure',
        runnerExecutionArn:
          stepfunctions.JsonPath.stringAt('$.runnerExecutionArn'),
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.result',
    },
  );
  finalizeTimedOutRestoreDrill.addCatch(timeoutFinalizerFailed, {
    errors: ['States.ALL'],
    resultPath: '$.error',
  });
  const waitForTimeoutFinalizer = new stepfunctions.Wait(
    scope,
    'WaitForRestoreDrillTimeoutFinalizer',
    { time: stepfunctions.WaitTime.secondsPath('$.result.waitSeconds') },
  );
  waitForTimeoutFinalizer.next(finalizeTimedOutRestoreDrill);
  const chooseTimeoutFinalizerStatus = new stepfunctions.Choice(
    scope,
    'ChooseRestoreDrillTimeoutFinalizerStatus',
  );
  finalizeTimedOutRestoreDrill.next(chooseTimeoutFinalizerStatus);
  chooseTimeoutFinalizerStatus
    .when(
      stepfunctions.Condition.stringEquals('$.result.status', 'pending'),
      waitForTimeoutFinalizer,
    )
    .when(
      stepfunctions.Condition.stringEquals(
        '$.result.status',
        'awaiting-cleanup-approval',
      ),
      timeoutFinalizerSucceeded,
    )
    .otherwise(timeoutFinalizerFailed);
  const timeoutFinalizerWorkflow = new stepfunctions.StateMachine(
    scope,
    'RestoreDrillTimeoutFinalizerWorkflow',
    {
      definitionBody: stepfunctions.DefinitionBody.fromChainable(
        finalizeTimedOutRestoreDrill,
      ),
      logs: {
        destination: timeoutFinalizerLogGroup,
        includeExecutionData: false,
        level: stepfunctions.LogLevel.ERROR,
      },
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
    },
  );

  const cleanupWorkflowLogGroup = new logs.LogGroup(
    scope,
    'RestoreDrillCleanupWorkflowLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.ONE_YEAR,
    },
  );
  const cleanupSucceeded = new stepfunctions.Succeed(
    scope,
    'RestoreDrillCleanupCompleted',
  );
  const cleanupFailed = new stepfunctions.Fail(scope, 'RestoreDrillCleanupFailed', {
    cause: 'Approved restore-drill cleanup failed; investigate before retrying.',
  });
  const cleanupUnexpectedStatus = new stepfunctions.Fail(
    scope,
    'RestoreDrillCleanupUnexpectedStatus',
    { cause: 'Cleanup handler returned an unsupported status.' },
  );
  const advanceCleanup = new stepfunctionsTasks.LambdaInvoke(
    scope,
    'AdvanceRestoreDrillCleanup',
    {
      lambdaFunction: cleanupFunction,
      payload: stepfunctions.TaskInput.fromObject({
        action: 'cleanup',
        approvalObjectKey: stepfunctions.JsonPath.stringAt(
          '$.approvalObjectKey',
        ),
        drillId: stepfunctions.JsonPath.stringAt('$.drillId'),
        cleanupExecutionArn:
          stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
        cleanupExecutionName:
          stepfunctions.JsonPath.stringAt('$$.Execution.Name'),
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.result',
    },
  );
  advanceCleanup.addCatch(cleanupFailed, {
    errors: ['States.ALL'],
    resultPath: '$.error',
  });
  const waitForCleanup = new stepfunctions.Wait(scope, 'WaitForRestoreDrillCleanup', {
    time: stepfunctions.WaitTime.secondsPath('$.result.waitSeconds'),
  });
  waitForCleanup.next(advanceCleanup);
  const chooseCleanupStatus = new stepfunctions.Choice(
    scope,
    'ChooseRestoreDrillCleanupStatus',
  );
  advanceCleanup.next(chooseCleanupStatus);
  chooseCleanupStatus
    .when(
      stepfunctions.Condition.stringEquals('$.result.status', 'pending'),
      waitForCleanup,
    )
    .when(
      stepfunctions.Condition.stringEquals('$.result.status', 'completed'),
      cleanupSucceeded,
    )
    .when(
      stepfunctions.Condition.stringEquals('$.result.status', 'failed'),
      cleanupFailed,
    )
    .otherwise(cleanupUnexpectedStatus);
  const cleanupWorkflow = new stepfunctions.StateMachine(
    scope,
    'RestoreDrillCleanupWorkflow',
    {
      definitionBody: stepfunctions.DefinitionBody.fromChainable(advanceCleanup),
      logs: {
        destination: cleanupWorkflowLogGroup,
        includeExecutionData: false,
        level: stepfunctions.LogLevel.ERROR,
      },
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(4),
      tracingEnabled: true,
      stateMachineName: cleanupWorkflowName,
    },
  );

  const cleanupApprovalPolicy = new iam.ManagedPolicy(
    scope,
    'RestoreDrillCleanupApprovalPolicy',
    {
      description:
        'Unattached approval receipt and cleanup-start access for isolated restore drills.',
      statements: [
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem'],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
            'ForAllValues:StringEquals': {
              'dynamodb:Attributes': approvalControlAttributeNames,
              'dynamodb:LeadingKeys': ['CONTROL'],
            },
            StringEquals: {
              'dynamodb:Select': 'SPECIFIC_ATTRIBUTES',
            },
          },
          resources: [stateTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem'],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
            'ForAllValues:StringEquals': {
              'dynamodb:Attributes': approvalRunAttributeNames,
            },
            'ForAllValues:StringLike': {
              'dynamodb:LeadingKeys': ['RESTORE_DRILL#*'],
            },
            StringEquals: {
              'dynamodb:Select': 'SPECIFIC_ATTRIBUTES',
            },
          },
          resources: [stateTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
            StringEquals: {
              'kms:EncryptionContext:purpose':
                evidenceDigestEncryptionPurpose,
            },
          },
          resources: [evidenceKey.keyArn],
        }),
        new iam.PolicyStatement({
          actions: [
            's3:GetObject',
            's3:GetObjectRetention',
            's3:GetObjectVersion',
          ],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
          },
          resources: [
            evidenceBucket.arnForObjects('approvals/v1/runs/*'),
            evidenceBucket.arnForObjects('evidence/v1/runs/*'),
          ],
        }),
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
            StringEquals: {
              's3:if-none-match': '*',
              's3:x-amz-server-side-encryption': 'aws:kms',
              's3:x-amz-server-side-encryption-aws-kms-key-id':
                evidenceKey.keyArn,
            },
          },
          resources: [evidenceBucket.arnForObjects('approvals/v1/runs/*')],
        }),
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
            StringEquals: {
              'kms:EncryptionContext:aws:s3:arn': evidenceBucket.bucketArn,
              'kms:ViaService': cdk.Fn.join('', [
                's3.',
                scope.region,
                '.',
                scope.urlSuffix,
              ]),
            },
          },
          resources: [evidenceKey.keyArn],
        }),
        new iam.PolicyStatement({
          actions: ['states:StartExecution'],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
          },
          resources: [cleanupWorkflow.stateMachineArn],
        }),
        new iam.PolicyStatement({
          actions: ['states:ListExecutions'],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
          },
          resources: [cleanupWorkflow.stateMachineArn],
        }),
        new iam.PolicyStatement({
          actions: ['states:DescribeExecution'],
          conditions: {
            ArnEquals: {
              'aws:PrincipalArn': input.cleanupApproverRoleArn.valueAsString,
            },
          },
          resources: [scope.formatArn({
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            resource: 'execution',
            resourceName: `${cleanupWorkflow.stateMachineName}:*`,
            service: 'states',
          })],
        }),
      ],
    },
  );

  const scheduleDlq = new sqs.Queue(scope, 'RestoreDrillScheduleDlq', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retentionPeriod: cdk.Duration.days(14),
  });
  const scheduleRule = new events.Rule(scope, 'RestoreDrillScheduleRule', {
    description:
      'Checks restore-drill cadence daily and starts a due run at 89 days.',
    schedule: events.Schedule.rate(cdk.Duration.days(1)),
    targets: [new eventsTargets.SfnStateMachine(workflow, {
      deadLetterQueue: scheduleDlq,
      maxEventAge: cdk.Duration.hours(24),
      retryAttempts: 2,
    })],
  });
  new events.Rule(scope, 'RestoreDrillTimeoutFinalizerRule', {
    description:
      'Finalizes immutable failure evidence after the restore workflow fails or times out.',
    eventPattern: {
      detail: {
        stateMachineArn: [workflow.stateMachineArn],
        status: ['FAILED', 'TIMED_OUT'],
      },
      detailType: ['Step Functions Execution Status Change'],
      source: ['aws.states'],
    },
    targets: [new eventsTargets.SfnStateMachine(timeoutFinalizerWorkflow, {
      deadLetterQueue: scheduleDlq,
      input: events.RuleTargetInput.fromObject({
        action: 'finalize-failure',
        runnerExecutionArn:
          events.EventField.fromPath('$.detail.executionArn'),
      }),
      maxEventAge: cdk.Duration.hours(24),
      retryAttempts: 2,
    })],
  });

  addOperationalAlarm(
    scope,
    'RestoreDrillWorkflowFailureAlarm',
    'Detects restore-drill workflow failures requiring evidence review and remediation.',
    workflow.metricFailed({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillWorkflowTimeoutAlarm',
    'Detects the four-and-a-half-hour hard timeout after the runner missed its four-hour RTO deadline and finalization allowance.',
    workflow.metricTimedOut({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillTimeoutFinalizerWorkflowFailureAlarm',
    'Detects failure to seal immutable evidence for a failed or timed-out restore drill.',
    timeoutFinalizerWorkflow.metricFailed({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillTimeoutFinalizerWorkflowTimeoutAlarm',
    'Detects timeout while sealing immutable evidence for a failed or timed-out restore drill.',
    timeoutFinalizerWorkflow.metricTimedOut({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillCleanupWorkflowFailureAlarm',
    'Detects approval-gated cleanup workflow failures.',
    cleanupWorkflow.metricFailed({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillCleanupWorkflowTimeoutAlarm',
    'Detects approval-gated cleanup workflow timeouts.',
    cleanupWorkflow.metricTimedOut({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillRpoAlarm',
    'Detects a measured restore point objective greater than five minutes.',
    restoreDrillMetric('RpoSeconds', 'Maximum'),
    300,
    cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillRtoAlarm',
    'Detects a measured restore time objective greater than four hours.',
    restoreDrillMetric('RtoSeconds', 'Maximum'),
    14_400,
    cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillFailureAlarm',
    'Detects any sealed terminal restore-drill failure requiring evidence review and remediation.',
    restoreDrillMetric('DrillFailureCount', 'Sum'),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillIntegrityAlarm',
    'Detects DynamoDB, exact-version S3, metadata, or cross-domain integrity differences.',
    restoreDrillMetric('IntegrityFailureCount', 'Sum'),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillCadenceOverdueAlarm',
    'Detects that no successful verified restore drill exists within 90 days.',
    restoreDrillMetric('CadenceOverdueCount', 'Sum'),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillCleanupOverdueAlarm',
    'Detects isolated restore resources still awaiting approved cleanup.',
    restoreDrillMetric('CleanupOverdueCount', 'Sum'),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillScheduleDlqAlarm',
    'Detects cadence checks or hard-timeout finalizers that exhausted delivery retries.',
    scheduleDlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    1,
  );
  addOperationalAlarm(
    scope,
    'RestoreDrillScheduleFailureAlarm',
    'Detects EventBridge failures while starting the daily restore-drill due check.',
    new cloudwatch.Metric({
      dimensionsMap: { RuleName: scheduleRule.ruleName },
      metricName: 'FailedInvocations',
      namespace: 'AWS/Events',
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    1,
  );

  return {
    cleanupApprovalPolicy,
    cleanupRole,
    cleanupWorkflow,
    evidenceBucket,
    evidenceKey,
    runnerRole,
    scheduleDlq,
    scratchBucket,
    scratchKey,
    stateTable,
    workflow,
  };
}
