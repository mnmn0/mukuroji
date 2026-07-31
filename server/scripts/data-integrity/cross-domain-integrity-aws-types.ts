import type {
  AttributeValue,
  ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import type {
  GetObjectAttributesCommandOutput,
  GetObjectTaggingCommandOutput,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import type { CrossDomainIntegrityResourceIdentity } from './cross-domain-integrity'

/** Source or isolated-restore dataset selected for one checker invocation. */
export type CrossDomainIntegrityRole = 'restore' | 'source'

/** Logical DynamoDB targets whose physical names must be supplied exactly once. */
export type CrossDomainIntegrityTableTarget =
  | 'audit-events'
  | 'file-proofing'
  | 'project-directory'
  | 'work-item-configuration'
  | 'work-items'
  | 'workspace-access'

/** Logical S3 target whose physical bucket must be supplied exactly once. */
export type CrossDomainIntegrityBucketTarget = 'file'

/** Complete physical DynamoDB table allowlist for one invocation. */
export type CrossDomainIntegrityTableNames = {
  /** Audit Events table name. */
  readonly 'audit-events': string
  /** File proofing metadata table name. */
  readonly 'file-proofing': string
  /** Project directory table name. */
  readonly 'project-directory': string
  /** Work Item configuration table name. */
  readonly 'work-item-configuration': string
  /** Work Items table name. */
  readonly 'work-items': string
  /** Workspace access table name. */
  readonly 'workspace-access': string
}

/** Complete physical S3 bucket allowlist for one invocation. */
export type CrossDomainIntegrityBucketNames = {
  /** File object bucket name. */
  readonly file: string
}

/** Explicit AWS connection and resource settings for the read-only adapter. */
export type CrossDomainIntegrityAwsReaderConfiguration = {
  /** Complete logical-to-physical bucket allowlist. */
  readonly buckets: CrossDomainIntegrityBucketNames
  /** Expected owner account for every selected AWS resource. */
  readonly expectedAccount: string
  /** Total allowed DynamoDB scan pages. */
  readonly maxPages: number
  /** Fixed DynamoDB Scan Limit. */
  readonly pageSize: number
  /** Shared-configuration profile name. */
  readonly profile: string
  /** AWS region. */
  readonly region: string
  /** Complete logical-to-physical table allowlist. */
  readonly tables: CrossDomainIntegrityTableNames
}

/** Exact immutable S3 object-version reference. */
export type CrossDomainIntegrityObjectVersionReference = {
  /** Logical allowlisted bucket target. */
  readonly bucket: CrossDomainIntegrityBucketTarget
  /** Exact object key obtained from verified data. */
  readonly key: string
  /** Exact non-empty S3 VersionId obtained from verified data. */
  readonly versionId: string
}

/** Closeable raw AWS read port available to the checker composition bridge. */
export interface CrossDomainIntegrityManagedAwsReadPort {
  /** Releases AWS SDK client resources. */
  close(): void

  /**
   * Reads attributes for one exact allowlisted S3 object version.
   *
   * @param reference - Exact bucket, key, and VersionId reference.
   * @returns S3 object-attributes response.
   */
  getObjectAttributes(
    reference: CrossDomainIntegrityObjectVersionReference,
  ): Promise<GetObjectAttributesCommandOutput>

  /**
   * Reads tags for one exact allowlisted S3 object version.
   *
   * @param reference - Exact bucket, key, and VersionId reference.
   * @returns S3 object-tagging response.
   */
  getObjectTagging(
    reference: CrossDomainIntegrityObjectVersionReference,
  ): Promise<GetObjectTaggingCommandOutput>

  /**
   * Reads headers for one exact allowlisted S3 object version.
   *
   * @param reference - Exact bucket, key, and VersionId reference.
   * @returns S3 HEAD response.
   */
  headObject(
    reference: CrossDomainIntegrityObjectVersionReference,
  ): Promise<HeadObjectCommandOutput>

  /**
   * Reads and validates the AWS account bound to the explicit profile.
   *
   * @returns Twelve-digit caller account identifier.
   */
  readCallerAccount(): Promise<string>

  /**
   * Reads one bounded, unfiltered, strongly consistent DynamoDB page.
   *
   * @param target - Logical table target.
   * @param exclusiveStartKey - Opaque cursor returned by the preceding page.
   * @returns DynamoDB scan response.
   */
  scanPage(
    target: CrossDomainIntegrityTableTarget,
    exclusiveStartKey?: Record<string, AttributeValue>,
  ): Promise<ScanCommandOutput>
}

/** Input supplied to the cross-domain core composition bridge. */
export type CrossDomainIntegrityCheckBridgeInput = {
  /** Existing 32-byte Workspace Audit pseudonym key retained only for this invocation. */
  readonly auditPseudonymKey: Uint8Array
  /** Canonical UTC timestamp shared by paired source and restore checks. */
  readonly checkedAt: string
  /** Dedicated HMAC key retained only for the invocation lifetime. */
  readonly digestKey: Uint8Array
  /** Total checker page bound. */
  readonly maxPages: number
  /** Total normalized item bound derived from the two scan bounds. */
  readonly maxItems: number
  /** Fixed page size. */
  readonly pageSize: number
  /** Raw allowlisted AWS reader used by an adapter that normalizes domain records. */
  readonly reader: CrossDomainIntegrityManagedAwsReadPort
  /** Stable digest binding evidence to the complete logical resource allowlist. */
  readonly resourceBindingDigest: string
  /** Canonical keyed identities for each exact physical resource. */
  readonly resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[]
  /** Keyed digest binding evidence to the exact account, Region, tables, and bucket. */
  readonly resourceIdentityDigest: string
  /** Source or isolated-restore dataset role. */
  readonly role: CrossDomainIntegrityRole
}
