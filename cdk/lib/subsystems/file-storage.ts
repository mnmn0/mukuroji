import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import {
  resolveCdkLambdaHandlerEntry,
  type LambdaBuildPaths,
} from '../config/lambda-build-paths';

/** Fixed object key reserved for the immutable file-bucket incarnation marker. */
export const FILE_BUCKET_INCARNATION_MARKER_KEY =
  'system/data-integrity/file-bucket-incarnation/v1.json';

/** Immutable identity attributes of the deployed file bucket incarnation. */
export type FileBucketIncarnationMarker = {
  /** Base64-encoded SHA-256 checksum of the exact marker version. */
  readonly checksumSha256: string;
  /** Fixed marker object key. */
  readonly key: string;
  /** Marker body size in bytes, represented by a CloudFormation string token. */
  readonly size: string;
  /** Opaque exact S3 object version identifier. */
  readonly versionId: string;
};

/**
 * Configuration required to build durable file storage resources.
 */
export type FileStorageConfiguration = {
  /** CORS origins allowed to use direct browser transfers. */
  readonly allowedOrigins: string[];
  /** File proofing metadata table created by the data-store subsystem. */
  readonly fileProofingTable: dynamodb.Table;
  /** Stable source paths used to bundle the marker provider Lambda. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /** Number of days deleted file versions are retained. */
  readonly retentionDays: cdk.CfnParameter;
  /** Maximum accepted age for presigned download requests. */
  readonly downloadUrlTtlSeconds: cdk.CfnParameter;
  /** Maximum accepted age for presigned upload requests. */
  readonly uploadUrlTtlSeconds: cdk.CfnParameter;
};

/**
 * Durable file storage resources shared by the API and background workers.
 */
export type FileStorageResources = {
  /** DynamoDB table that stores file proofing metadata. */
  readonly fileProofingTable: dynamodb.Table;
  /** Versioned bucket that stores workspace files. */
  readonly fileBucket: s3.Bucket;
  /** Exact immutable marker that identifies this file-bucket incarnation. */
  readonly fileBucketIncarnationMarker: FileBucketIncarnationMarker;
  /** GuardDuty malware protection plan for workspace files. */
  readonly malwareProtectionPlan: guardduty.CfnMalwareProtectionPlan;
  /** IAM role assumed by GuardDuty malware protection. */
  readonly malwareProtectionRole: iam.Role;
  /** Versioned bucket that stores Work Item import sources. */
  readonly workItemImportBucket: s3.Bucket;
};

/**
 * Builds durable file storage, import storage, and malware scanning resources.
 *
 * @param scope Stack scope used directly to preserve existing construct paths.
 * @param configuration File retention, transfer, and CORS configuration.
 * @returns File storage resources consumed by API and worker builders.
 */
export function buildFileStorage(
  scope: cdk.Stack,
  configuration: FileStorageConfiguration,
): FileStorageResources {
  const fileBucket = new s3.Bucket(scope, 'FileBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    cors: [{
      allowedHeaders: [
        'content-length',
        'content-type',
        'if-none-match',
        'x-amz-checksum-*',
        'x-amz-meta-*',
        'x-amz-server-side-encryption',
        'x-amz-tagging',
      ],
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
      allowedOrigins: configuration.allowedOrigins,
      exposedHeaders: ['ETag', 'x-amz-checksum-sha256', 'x-amz-version-id'],
      maxAge: 600,
    }],
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    eventBridgeEnabled: true,
    lifecycleRules: [
      {
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        id: 'AbortIncompleteUploads',
      },
      {
        expiration: cdk.Duration.days(1),
        id: 'ExpireAbandonedUploads',
        tagFilters: { 'mukuroji-upload': 'pending' },
      },
      {
        expiration: cdk.Duration.days(1),
        id: 'ExpireDeletedCurrentObjects',
        tagFilters: { 'mukuroji-deleted': 'true' },
      },
      {
        id: 'ExpireDeletedFileVersions',
        noncurrentVersionExpiration: cdk.Duration.days(configuration.retentionDays.valueAsNumber),
      },
      {
        expiredObjectDeleteMarker: true,
        id: 'DeleteExpiredMarkers',
      },
    ],
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    versioned: true,
  });

  const markerLogGroup = new logs.LogGroup(
    scope,
    'FileBucketIncarnationMarkerLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const markerFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'FileBucketIncarnationMarkerFunction',
    {
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      depsLockFilePath: configuration.lambdaBuildPaths.depsLockFilePath,
      description:
        'Creates or reconciles the immutable file-bucket incarnation marker.',
      entry: resolveCdkLambdaHandlerEntry(
        configuration.lambdaBuildPaths,
        'file-bucket-incarnation-marker-handler.ts',
      ),
      handler: 'handler',
      logGroup: markerLogGroup,
      memorySize: 256,
      projectRoot: configuration.lambdaBuildPaths.projectRoot,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
    },
  );
  markerFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:GetBucketVersioning'],
    resources: [fileBucket.bucketArn],
  }));
  markerFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      's3:GetObject',
      's3:GetObjectVersion',
      's3:PutObject',
    ],
    resources: [fileBucket.arnForObjects(FILE_BUCKET_INCARNATION_MARKER_KEY)],
  }));
  const markerFunctionRole = markerFunction.role;
  if (!markerFunctionRole) {
    throw new Error('Marker function did not create an execution role.');
  }

  fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'FileBucketIncarnationMarkerCannotBeDeleted',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: [fileBucket.arnForObjects(FILE_BUCKET_INCARNATION_MARKER_KEY)],
  }));
  fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'OnlyFileBucketIncarnationMarkerProviderCanPut',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObject'],
    resources: [fileBucket.arnForObjects(FILE_BUCKET_INCARNATION_MARKER_KEY)],
    conditions: {
      ArnNotEquals: {
        'aws:PrincipalArn': markerFunctionRole.roleArn,
      },
    },
  }));
  fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'FileBucketIncarnationMarkerRequiresCreateOnlyPut',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObject'],
    resources: [fileBucket.arnForObjects(FILE_BUCKET_INCARNATION_MARKER_KEY)],
    conditions: {
      StringNotEquals: {
        's3:if-none-match': '*',
      },
    },
  }));
  if (!fileBucket.policy) {
    throw new Error('File bucket policy was not created for the marker boundary.');
  }

  const markerProviderLogGroup = new logs.LogGroup(
    scope,
    'FileBucketIncarnationMarkerProviderLogGroup',
    {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.THREE_MONTHS,
    },
  );
  const markerProvider = new customResources.Provider(
    scope,
    'FileBucketIncarnationMarkerProvider',
    {
      logGroup: markerProviderLogGroup,
      onEventHandler: markerFunction,
    },
  );
  const markerResource = new cdk.CustomResource(
    scope,
    'FileBucketIncarnationMarker',
    {
      properties: {
        BucketName: fileBucket.bucketName,
        ExpectedAccount: scope.account,
        MarkerKey: FILE_BUCKET_INCARNATION_MARKER_KEY,
      },
      resourceType: 'Custom::FileBucketIncarnationMarker',
      serviceToken: markerProvider.serviceToken,
    },
  );
  markerResource.node.addDependency(fileBucket.policy);
  const fileBucketIncarnationMarker: FileBucketIncarnationMarker = {
    checksumSha256: markerResource.getAttString('ChecksumSHA256'),
    key: markerResource.getAttString('Key'),
    size: markerResource.getAttString('Size'),
    versionId: markerResource.getAttString('VersionId'),
  };

  const workItemImportAccessLogsBucket = new s3.Bucket(
    scope,
    'WorkItemImportAccessLogsBucket',
    {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{
        expiration: cdk.Duration.days(90),
        id: 'ExpireImportAccessLogs',
        noncurrentVersionExpiration: cdk.Duration.days(90),
      }],
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    },
  );
  const workItemImportBucket = new s3.Bucket(scope, 'WorkItemImportBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    lifecycleRules: [
      {
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        id: 'AbortIncompleteImportSources',
      },
      {
        expiration: cdk.Duration.days(15),
        id: 'ExpireImportSources',
        noncurrentVersionExpiration: cdk.Duration.days(15),
      },
      {
        expiredObjectDeleteMarker: true,
        id: 'DeleteExpiredImportSourceMarkers',
      },
    ],
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    serverAccessLogsBucket: workItemImportAccessLogsBucket,
    serverAccessLogsPrefix: 'work-item-import/',
    versioned: true,
  });

  const malwareProtectionRole = new iam.Role(scope, 'FileMalwareProtectionRole', {
    assumedBy: new iam.ServicePrincipal('malware-protection-plan.guardduty.amazonaws.com'),
    description: 'Allows GuardDuty Malware Protection to scan and tag mukuroji files.',
  });
  const guardDutyManagedRuleArn = cdk.Stack.of(scope).formatArn({
    service: 'events',
    resource: 'rule',
    resourceName: 'DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*',
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  const malwareProtectionPolicy = new iam.Policy(scope, 'FileMalwareProtectionPolicy', {
    statements: [
      new iam.PolicyStatement({
        actions: ['events:DeleteRule', 'events:PutRule', 'events:PutTargets', 'events:RemoveTargets'],
        resources: [guardDutyManagedRuleArn],
        conditions: {
          StringLike: {
            'events:ManagedBy': 'malware-protection-plan.guardduty.amazonaws.com',
          },
        },
      }),
      new iam.PolicyStatement({
        actions: ['events:DescribeRule', 'events:ListTargetsByRule'],
        resources: [guardDutyManagedRuleArn],
      }),
      new iam.PolicyStatement({
        actions: [
          's3:GetObjectTagging',
          's3:GetObjectVersionTagging',
          's3:PutObjectTagging',
          's3:PutObjectVersionTagging',
        ],
        resources: [
          fileBucket.arnForObjects('malware-protection-resource-validation-object'),
          fileBucket.arnForObjects('workspaces/*'),
        ],
      }),
      new iam.PolicyStatement({
        actions: ['s3:GetBucketNotification', 's3:PutBucketNotification'],
        resources: [fileBucket.bucketArn],
      }),
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [fileBucket.arnForObjects('malware-protection-resource-validation-object')],
      }),
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [fileBucket.bucketArn],
      }),
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [
          fileBucket.arnForObjects('malware-protection-resource-validation-object'),
          fileBucket.arnForObjects('workspaces/*'),
        ],
      }),
    ],
  });
  malwareProtectionRole.attachInlinePolicy(malwareProtectionPolicy);

  const malwareProtectionPlan = new guardduty.CfnMalwareProtectionPlan(
    scope,
    'FileMalwareProtectionPlan',
    {
      actions: {
        tagging: {
          status: 'ENABLED',
        },
      },
      protectedResource: {
        s3Bucket: {
          bucketName: fileBucket.bucketName,
          objectPrefixes: ['workspaces/'],
        },
      },
      role: malwareProtectionRole.roleArn,
    },
  );
  malwareProtectionPlan.node.addDependency(fileBucket);
  malwareProtectionPlan.node.addDependency(malwareProtectionPolicy);

  fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'OnlyGuardDutyCanUploadScanStatus',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObject'],
    resources: [fileBucket.arnForObjects('workspaces/*')],
    conditions: {
      ArnNotEquals: {
        'aws:PrincipalArn': malwareProtectionRole.roleArn,
      },
      'ForAnyValue:StringEquals': {
        's3:RequestObjectTagKeys': 'GuardDutyMalwareScanStatus',
      },
    },
  }));
  fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'OnlyGuardDutyCanSetScanStatus',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
    resources: [fileBucket.arnForObjects('workspaces/*')],
    conditions: {
      ArnNotEquals: {
        'aws:PrincipalArn': malwareProtectionRole.roleArn,
      },
      Null: {
        's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'true',
        's3:RequestObjectTag/GuardDutyMalwareScanStatus': 'false',
      },
    },
  }));
  fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'GuardDutyScanStatusCannotBeChanged',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
    resources: [fileBucket.arnForObjects('workspaces/*')],
    conditions: {
      ArnNotEquals: {
        'aws:PrincipalArn': malwareProtectionRole.roleArn,
      },
      Null: {
        's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'false',
      },
      StringNotEquals: {
        's3:RequestObjectTag/GuardDutyMalwareScanStatus':
          '${s3:ExistingObjectTag/GuardDutyMalwareScanStatus}',
      },
    },
  }));
  fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'RejectStalePresignedFileUploads',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObject'],
    resources: [fileBucket.arnForObjects('workspaces/*')],
    conditions: {
      NumericGreaterThan: {
        's3:signatureAge': cdk.Fn.join('', [
          configuration.uploadUrlTtlSeconds.valueAsString,
          '000',
        ]),
      },
    },
  }));
  fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'RejectStalePresignedFileDownloads',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:GetObject', 's3:GetObjectVersion'],
    resources: [fileBucket.arnForObjects('workspaces/*')],
    conditions: {
      NumericGreaterThan: {
        's3:signatureAge': cdk.Fn.join('', [
          configuration.downloadUrlTtlSeconds.valueAsString,
          '000',
        ]),
      },
    },
  }));

  return {
    fileProofingTable: configuration.fileProofingTable,
    fileBucket,
    fileBucketIncarnationMarker,
    malwareProtectionPlan,
    malwareProtectionRole,
    workItemImportBucket,
  };
}

/**
 * Adds file quarantine policies that depend on trusted read-only roles.
 *
 * @param resources File resources that own the bucket policy.
 * @param apiFunction API Lambda whose role may read verified files.
 * @param restoreDrillRunnerRole Isolated drill role that must read exact
 * quarantined or deleted versions without receiving source write access.
 */
export function configureFileStorageApiBoundary(
  resources: FileStorageResources,
  apiFunction: lambdaNodejs.NodejsFunction,
  restoreDrillRunnerRole: iam.IRole,
): void {
  resources.fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'NoReadUnlessGuardDutyClean',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:GetObject', 's3:GetObjectVersion'],
    resources: [resources.fileBucket.arnForObjects('workspaces/*')],
    conditions: {
      ArnNotEquals: {
        'aws:PrincipalArn': [
          resources.malwareProtectionRole.roleArn,
          apiFunction.role!.roleArn,
          restoreDrillRunnerRole.roleArn,
        ],
      },
      StringNotEquals: {
        's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'NO_THREATS_FOUND',
      },
    },
  }));
  resources.fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DeletedObjectsCannotBeRead',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:GetObject', 's3:GetObjectVersion'],
    resources: [resources.fileBucket.arnForObjects('workspaces/*')],
    conditions: {
      ArnNotEquals: {
        'aws:PrincipalArn': restoreDrillRunnerRole.roleArn,
      },
      StringEquals: {
        's3:ExistingObjectTag/mukuroji-deleted': 'true',
      },
    },
  }));
  resources.fileBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DeletedObjectQuarantineCannotBeRemoved',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging'],
    resources: [resources.fileBucket.arnForObjects('workspaces/*')],
    conditions: {
      StringEquals: {
        's3:ExistingObjectTag/mukuroji-deleted': 'true',
      },
      StringNotEquals: {
        's3:RequestObjectTag/mukuroji-deleted': 'true',
      },
    },
  }));
}
