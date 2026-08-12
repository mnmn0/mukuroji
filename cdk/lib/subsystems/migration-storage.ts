import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type {
  WorkspaceSearchMigrationDeploymentTrustRoot,
} from '../config/workspace-search-migration-deployment-targets';

const minimumJournalRetentionDays = 30;
const maximumJournalRetentionDays = 31;
const minimumRehearsalEvidenceRetentionDays = 365;
const maximumRehearsalEvidenceRetentionDays = 366;

/** Stable tag key carrying the Workspace Search migration environment attestation. */
export const WORKSPACE_SEARCH_MIGRATION_ENVIRONMENT_TAG_KEY =
  'mukuroji:workspace-search-migration-environment';

/** Stable tag key carrying the exact reviewed deployment account. */
export const WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_ACCOUNT_TAG_KEY =
  'mukuroji:workspace-search-migration-deployment-account';

/** Stable tag key carrying the exact reviewed deployment Region. */
export const WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_REGION_TAG_KEY =
  'mukuroji:workspace-search-migration-deployment-region';

/** Stable tag key carrying the source-controlled deployment target identifier. */
export const WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_TAG_KEY =
  'mukuroji:workspace-search-migration-deployment-target';

/** Stable tag key carrying the versioned deployment trust-root digest. */
export const WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_TAG_KEY =
  'mukuroji:workspace-search-migration-deployment-trust-root';

/** Stable tag key carrying the deployment trust schema version. */
export const WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION_TAG_KEY =
  'mukuroji:workspace-search-migration-deployment-trust-version';

/** Stable tag key carrying only a digest of the protected production account. */
export const WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY =
  'mukuroji:workspace-search-migration-production-account-sha256';

/**
 * Existing application tables used by the Workspace Search maintenance migration.
 */
export type MigrationStorageInput = {
  /** Work Item collaboration rows projected into Workspace Search. */
  readonly collaborationTable: dynamodb.ITable;
  /** Current Document rows projected into Workspace Search. */
  readonly documentsTable: dynamodb.ITable;
  /** Team and Project directory rows projected into Workspace Search. */
  readonly projectDirectoryTable: dynamodb.ITable;
  /** Canonical Work Item rows projected into Workspace Search. */
  readonly workItemsTable: dynamodb.ITable;
  /** Workspace Search projection target. */
  readonly workspaceSearchTable: dynamodb.ITable;
  /** Validated source-controlled deployment trust root recorded on resources. */
  readonly deploymentTrustRoot:
    WorkspaceSearchMigrationDeploymentTrustRoot;
};

/**
 * Durable storage and operator permissions for Workspace Search maintenance migrations.
 */
export type MigrationStorageResources = {
  /** Write-once encrypted preimage journal bucket. */
  readonly workspaceSearchMigrationJournalBucket: s3.Bucket;
  /** Customer-managed key that encrypts migration journal objects. */
  readonly workspaceSearchMigrationJournalKey: kms.Key;
  /** Least-privilege permissions attached explicitly to an approved operator principal. */
  readonly workspaceSearchMigrationOperatorPolicy: iam.ManagedPolicy;
  /** Non-production-only retention extension attached alongside the operator policy. */
  readonly workspaceSearchMigrationRehearsalEvidencePolicy: iam.ManagedPolicy;
  /** Deployment condition guarding the rehearsal-only evidence policy and output. */
  readonly workspaceSearchMigrationRehearsalEvidenceCondition: cdk.CfnCondition;
  /** Durable checkpoint, lease, operation-marker, and verification state table. */
  readonly workspaceSearchMigrationStateTable: dynamodb.Table;
};

/**
 * Creates retained state and write-once journal storage for Workspace Search migrations.
 *
 * The migration remains an explicitly invoked maintenance operation. This subsystem does
 * not attach the operator policy to a principal and does not run migration code during deploy.
 *
 * @param scope Stack that owns the migration resources.
 * @param input Existing source and target tables constrained by the operator policy.
 * @returns Durable migration resources and the unattached operator managed policy.
 */
export function buildMigrationStorage(
  scope: cdk.Stack,
  input: MigrationStorageInput,
): MigrationStorageResources {
  const workspaceSearchMigrationStateTable = new dynamodb.Table(
    scope,
    'WorkspaceSearchMigrationStateTable',
    {
      partitionKey: {
        name: 'migrationId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'recordKey',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      deletionProtection: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
  );
  applyMigrationDeploymentTrustTags(
    workspaceSearchMigrationStateTable,
    input.deploymentTrustRoot,
  );

  const workspaceSearchMigrationJournalAccessLogsBucket = new s3.Bucket(
    scope,
    'WorkspaceSearchMigrationJournalAccessLogsBucket',
    {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{
        expiration: cdk.Duration.days(90),
        id: 'ExpireMigrationJournalAccessLogs',
        noncurrentVersionExpiration: cdk.Duration.days(90),
      }],
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    },
  );
  applyMigrationDeploymentTrustTags(
    workspaceSearchMigrationJournalAccessLogsBucket,
    input.deploymentTrustRoot,
  );

  const workspaceSearchMigrationJournalKey = new kms.Key(
    scope,
    'WorkspaceSearchMigrationJournalKey',
    {
      description:
        'Encrypts lossless Workspace Search migration preimage journal segments.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
  );
  applyMigrationDeploymentTrustTags(
    workspaceSearchMigrationJournalKey,
    input.deploymentTrustRoot,
  );

  const workspaceSearchMigrationJournalBucket = new s3.Bucket(
    scope,
    'WorkspaceSearchMigrationJournalBucket',
    {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      bucketKeyEnabled: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: workspaceSearchMigrationJournalKey,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(
        cdk.Duration.days(minimumJournalRetentionDays),
      ),
      objectLockEnabled: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket:
        workspaceSearchMigrationJournalAccessLogsBucket,
      serverAccessLogsPrefix: 'workspace-search-migration-journal/',
      versioned: true,
    },
  );
  applyMigrationDeploymentTrustTags(
    workspaceSearchMigrationJournalBucket,
    input.deploymentTrustRoot,
  );

  const journalObjectArn =
    workspaceSearchMigrationJournalBucket.arnForObjects(
      'workspace-search/v1/*',
    );
  const rehearsalEvidenceObjectArn =
    workspaceSearchMigrationJournalBucket.arnForObjects(
      'workspace-search/v1/rehearsal/evidence-*',
    );

  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyJournalObjectDeletion',
      actions: [
        's3:DeleteObject',
        's3:DeleteObjectVersion',
      ],
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      resources: [
        workspaceSearchMigrationJournalBucket.arnForObjects('*'),
      ],
    }),
  );
  // Keep the explicit missing-header deny as defense in depth even though the
  // nonexclusive-value deny also rejects a missing If-None-Match condition.
  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyUnconditionalJournalUploads',
      actions: ['s3:PutObject'],
      conditions: {
        Null: {
          's3:if-none-match': 'true',
        },
      },
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      resources: [journalObjectArn],
    }),
  );
  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyNonExclusiveJournalUploads',
      actions: ['s3:PutObject'],
      conditions: {
        StringNotEquals: {
          's3:if-none-match': '*',
        },
      },
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      resources: [journalObjectArn],
    }),
  );
  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyNonKmsJournalUploads',
      actions: ['s3:PutObject'],
      conditions: {
        StringNotEquals: {
          's3:x-amz-server-side-encryption': 'aws:kms',
        },
      },
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      resources: [journalObjectArn],
    }),
  );
  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyWrongJournalKeyUploads',
      actions: ['s3:PutObject'],
      conditions: {
        StringNotEquals: {
          's3:x-amz-server-side-encryption-aws-kms-key-id':
            workspaceSearchMigrationJournalKey.keyArn,
        },
      },
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      resources: [journalObjectArn],
    }),
  );
  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyShortJournalRetention',
      actions: ['s3:PutObjectRetention'],
      conditions: {
        NumericLessThan: {
          's3:object-lock-remaining-retention-days':
            minimumJournalRetentionDays,
        },
      },
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      resources: [journalObjectArn],
    }),
  );
  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyLongJournalRetention',
      actions: ['s3:PutObjectRetention'],
      conditions: {
        NumericGreaterThan: {
          's3:object-lock-remaining-retention-days':
            maximumJournalRetentionDays,
        },
      },
      effect: iam.Effect.DENY,
      notResources: [rehearsalEvidenceObjectArn],
      principals: [new iam.AnyPrincipal()],
    }),
  );
  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyShortRehearsalEvidenceRetention',
      actions: ['s3:PutObjectRetention'],
      conditions: {
        NumericLessThan: {
          's3:object-lock-remaining-retention-days':
            minimumRehearsalEvidenceRetentionDays,
        },
      },
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      resources: [rehearsalEvidenceObjectArn],
    }),
  );
  workspaceSearchMigrationJournalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyLongRehearsalEvidenceRetention',
      actions: ['s3:PutObjectRetention'],
      conditions: {
        NumericGreaterThan: {
          's3:object-lock-remaining-retention-days':
            maximumRehearsalEvidenceRetentionDays,
        },
      },
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      resources: [rehearsalEvidenceObjectArn],
    }),
  );

  const journalBucketPolicy = workspaceSearchMigrationJournalBucket.policy;
  const journalAccessLogsBucketPolicy =
    workspaceSearchMigrationJournalAccessLogsBucket.policy;
  if (!journalBucketPolicy || !journalAccessLogsBucketPolicy) {
    throw new Error('Migration journal bucket policies were not created.');
  }
  journalBucketPolicy.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  journalAccessLogsBucketPolicy.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const sourceTableArns = [
    input.projectDirectoryTable.tableArn,
    input.workItemsTable.tableArn,
    input.collaborationTable.tableArn,
    input.documentsTable.tableArn,
  ];
  const targetAndStateTableArns = [
    input.workspaceSearchTable.tableArn,
    workspaceSearchMigrationStateTable.tableArn,
  ];
  const transactionCondition = {
    'ForAnyValue:StringEquals': {
      'dynamodb:EnclosingOperation': ['TransactWriteItems'],
    },
  };
  const kmsViaS3Conditions = {
    StringEquals: {
      'kms:CallerAccount': cdk.Stack.of(scope).account,
      'kms:EncryptionContext:aws:s3:arn':
        workspaceSearchMigrationJournalBucket.bucketArn,
      'kms:ViaService':
        `s3.${cdk.Stack.of(scope).region}.${cdk.Stack.of(scope).urlSuffix}`,
    },
  };

  const workspaceSearchMigrationOperatorPolicy = new iam.ManagedPolicy(
    scope,
    'WorkspaceSearchMigrationOperatorPolicy',
    {
      description:
        'Least-privilege data-plane access for reviewed Workspace Search migration runs.',
      statements: [
        new iam.PolicyStatement({
          actions: [
            'dynamodb:DescribeContinuousBackups',
            'dynamodb:DescribeTable',
            'dynamodb:DescribeTimeToLive',
            'dynamodb:Scan',
          ],
          resources: sourceTableArns,
        }),
        new iam.PolicyStatement({
          actions: [
            'dynamodb:DescribeContinuousBackups',
            'dynamodb:DescribeTable',
            'dynamodb:DescribeTimeToLive',
          ],
          resources: targetAndStateTableArns,
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:ConditionCheckItem'],
          conditions: transactionCondition,
          resources: sourceTableArns,
        }),
        new iam.PolicyStatement({
          actions: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:Scan',
          ],
          resources: targetAndStateTableArns,
        }),
        new iam.PolicyStatement({
          actions: [
            'dynamodb:ConditionCheckItem',
            'dynamodb:DeleteItem',
            'dynamodb:PutItem',
          ],
          conditions: transactionCondition,
          resources: [input.workspaceSearchTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: [
            'dynamodb:ConditionCheckItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
          ],
          conditions: transactionCondition,
          resources: [workspaceSearchMigrationStateTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: [
            's3:GetBucketLogging',
            's3:GetBucketObjectLockConfiguration',
            's3:GetBucketVersioning',
            's3:GetEncryptionConfiguration',
          ],
          resources: [workspaceSearchMigrationJournalBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          conditions: {
            StringLike: {
              's3:prefix': [
                'workspace-search/v1',
                'workspace-search/v1/*',
              ],
            },
          },
          resources: [workspaceSearchMigrationJournalBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          actions: [
            's3:GetObject',
            's3:GetObjectRetention',
            's3:GetObjectVersion',
          ],
          resources: [journalObjectArn],
        }),
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          conditions: {
            StringEquals: {
              's3:if-none-match': '*',
              's3:x-amz-server-side-encryption': 'aws:kms',
              's3:x-amz-server-side-encryption-aws-kms-key-id':
                workspaceSearchMigrationJournalKey.keyArn,
            },
          },
          resources: [journalObjectArn],
        }),
        new iam.PolicyStatement({
          actions: ['s3:PutObjectRetention'],
          conditions: {
            NumericGreaterThanEquals: {
              's3:object-lock-remaining-retention-days':
                minimumJournalRetentionDays,
            },
            NumericLessThanEquals: {
              's3:object-lock-remaining-retention-days':
                maximumJournalRetentionDays,
            },
            StringEquals: {
              's3:object-lock-mode': 'COMPLIANCE',
            },
          },
          resources: [journalObjectArn],
        }),
        new iam.PolicyStatement({
          actions: [
            'kms:Decrypt',
            'kms:GenerateDataKey',
          ],
          conditions: kmsViaS3Conditions,
          resources: [workspaceSearchMigrationJournalKey.keyArn],
        }),
        new iam.PolicyStatement({
          actions: ['kms:DescribeKey'],
          resources: [workspaceSearchMigrationJournalKey.keyArn],
        }),
      ],
    },
  );

  const workspaceSearchMigrationRehearsalEvidenceCondition =
    new cdk.CfnCondition(
      scope,
      'WorkspaceSearchMigrationRehearsalEvidenceNonProduction',
      {
        expression: cdk.Fn.conditionEquals(
          input.deploymentTrustRoot.rehearsalEnabled
            ? input.deploymentTrustRoot.environment
            : 'production-disabled',
          'non-production',
        ),
      },
    );
  const workspaceSearchMigrationRehearsalEvidencePolicy =
    new iam.ManagedPolicy(
      scope,
      'WorkspaceSearchMigrationRehearsalEvidencePolicy',
      {
        description:
          'Unattached non-production-only permission to extend immutable rehearsal evidence retention.',
        statements: [
          new iam.PolicyStatement({
            actions: ['s3:GetBucketTagging'],
            resources: [workspaceSearchMigrationJournalBucket.bucketArn],
          }),
          new iam.PolicyStatement({
            actions: ['s3:PutObjectRetention'],
            conditions: {
              NumericGreaterThanEquals: {
                's3:object-lock-remaining-retention-days':
                  minimumRehearsalEvidenceRetentionDays,
              },
              NumericLessThanEquals: {
                's3:object-lock-remaining-retention-days':
                  maximumRehearsalEvidenceRetentionDays,
              },
              StringEquals: {
                's3:object-lock-mode': 'COMPLIANCE',
              },
            },
            resources: [rehearsalEvidenceObjectArn],
          }),
        ],
      },
    );
  const rehearsalEvidencePolicyResource =
    workspaceSearchMigrationRehearsalEvidencePolicy.node.defaultChild;
  if (!(rehearsalEvidencePolicyResource instanceof iam.CfnManagedPolicy)) {
    throw new Error(
      'Migration rehearsal evidence policy has no CloudFormation resource.',
    );
  }
  rehearsalEvidencePolicyResource.cfnOptions.condition =
    workspaceSearchMigrationRehearsalEvidenceCondition;
  applyMigrationDeploymentTrustTags(
    workspaceSearchMigrationRehearsalEvidencePolicy,
    input.deploymentTrustRoot,
  );

  return {
    workspaceSearchMigrationJournalBucket,
    workspaceSearchMigrationJournalKey,
    workspaceSearchMigrationOperatorPolicy,
    workspaceSearchMigrationRehearsalEvidenceCondition,
    workspaceSearchMigrationRehearsalEvidencePolicy,
    workspaceSearchMigrationStateTable,
  };
}

/**
 * Applies the complete secret-free deployment trust binding to one resource.
 *
 * The protected production account is intentionally represented only by its
 * domain-separated digest. The deployment account and Region remain explicit
 * because CloudFormation independently asserts them for enabled rehearsal
 * targets.
 *
 * @param resource - Taggable migration resource owned by this subsystem.
 * @param trustRoot - Validated source-controlled deployment trust root.
 * @returns Nothing.
 */
function applyMigrationDeploymentTrustTags(
  resource: cdk.Resource,
  trustRoot: WorkspaceSearchMigrationDeploymentTrustRoot,
): void {
  const deploymentAccount = trustRoot.rehearsalEnabled
    ? trustRoot.deploymentAccount
    : cdk.Aws.ACCOUNT_ID;
  const deploymentRegion = trustRoot.rehearsalEnabled
    ? trustRoot.region
    : cdk.Aws.REGION;
  for (const [key, value] of [
    [WORKSPACE_SEARCH_MIGRATION_ENVIRONMENT_TAG_KEY, trustRoot.environment],
    [WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_ACCOUNT_TAG_KEY, deploymentAccount],
    [WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_REGION_TAG_KEY, deploymentRegion],
    [WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TARGET_TAG_KEY, trustRoot.targetId],
    [WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_ROOT_TAG_KEY, trustRoot.digest],
    [
      WORKSPACE_SEARCH_MIGRATION_DEPLOYMENT_TRUST_VERSION_TAG_KEY,
      String(trustRoot.version),
    ],
    [
      WORKSPACE_SEARCH_MIGRATION_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
      trustRoot.productionAccountDigest,
    ],
  ]) {
    cdk.Tags.of(resource).add(key, value);
  }
}
