import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Read-only production resources inspected by the cross-domain integrity checker.
 */
export type CrossDomainIntegrityInput = {
  /** Canonical audit event rows checked against restored application resources. */
  readonly auditEventsTable: dynamodb.ITable;
  /** File metadata rows checked against exact versioned S3 objects. */
  readonly fileProofingTable: dynamodb.ITable;
  /** Versioned workspace file bucket inspected by exact object version. */
  readonly fileBucket: s3.IBucket;
  /** Fixed object key of the immutable file-bucket incarnation marker. */
  readonly fileBucketIncarnationMarkerKey: string;
  /** Exact marker version that the operator policy may read. */
  readonly fileBucketIncarnationMarkerVersionId: string;
  /** Team and Project relation graph used by canonical Work Items. */
  readonly projectDirectoryTable: dynamodb.ITable;
  /** Canonical Work Item rows whose configuration and relations are checked. */
  readonly workItemsTable: dynamodb.ITable;
  /** Workflow configuration rows referenced by canonical Work Items. */
  readonly workItemConfigurationTable: dynamodb.ITable;
  /** Workspace members and invitations referenced by application records. */
  readonly workspaceAccessTable: dynamodb.ITable;
};

/**
 * Unattached operator access exposed for reviewed integrity-check invocations.
 */
export type CrossDomainIntegrityResources = {
  /** Least-privilege read-only policy for source or isolated-restore checks. */
  readonly crossDomainIntegrityOperatorPolicy: iam.ManagedPolicy;
};

/**
 * Creates an unattached, read-only policy for the cross-domain integrity checker.
 *
 * The policy deliberately contains no write, restore, delete, or application
 * runtime permissions. An environment owner must attach it to a reviewed
 * operator principal for a bounded checker invocation.
 *
 * @param scope Stack that owns the read-only operator policy.
 * @param input Exact DynamoDB tables and versioned object prefix inspected.
 * @returns Unattached policy published through a stable stack output.
 */
export function buildCrossDomainIntegrityAccess(
  scope: cdk.Stack,
  input: CrossDomainIntegrityInput,
): CrossDomainIntegrityResources {
  const tableArns = [
    input.auditEventsTable.tableArn,
    input.fileProofingTable.tableArn,
    input.projectDirectoryTable.tableArn,
    input.workItemsTable.tableArn,
    input.workItemConfigurationTable.tableArn,
    input.workspaceAccessTable.tableArn,
  ];
  const fileObjectArn = input.fileBucket.arnForObjects('workspaces/*');
  const markerObjectArn = input.fileBucket.arnForObjects(
    input.fileBucketIncarnationMarkerKey,
  );

  const crossDomainIntegrityOperatorPolicy = new iam.ManagedPolicy(
    scope,
    'CrossDomainIntegrityOperatorPolicy',
    {
      description:
        'Read-only access for bounded source and isolated-restore cross-domain integrity checks.',
      statements: [
        new iam.PolicyStatement({
          actions: ['dynamodb:DescribeTable', 'dynamodb:Scan'],
          resources: tableArns,
        }),
        new iam.PolicyStatement({
          actions: ['s3:GetBucketVersioning'],
          resources: [input.fileBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          conditions: {
            StringLike: {
              's3:prefix': ['workspaces/*'],
            },
          },
          resources: [input.fileBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          actions: [
            's3:GetObjectVersion',
            's3:GetObjectVersionAttributes',
            's3:GetObjectVersionTagging',
          ],
          resources: [fileObjectArn],
        }),
        new iam.PolicyStatement({
          actions: [
            's3:GetObjectVersion',
            's3:GetObjectVersionAttributes',
          ],
          conditions: {
            StringEquals: {
              's3:VersionId': input.fileBucketIncarnationMarkerVersionId,
            },
          },
          resources: [markerObjectArn],
        }),
      ],
    },
  );

  return { crossDomainIntegrityOperatorPolicy };
}
