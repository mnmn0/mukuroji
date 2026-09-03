import type {
  AttributeValue,
  ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import type {
  GetObjectAttributesCommandOutput,
  GetObjectTaggingCommandOutput,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import type {
  CrossDomainIntegrityInvocationDeadline,
  CrossDomainIntegrityObservationMode,
  CrossDomainIntegrityResourceAttestation,
  CrossDomainIntegrityFileBucketMarkerAttestation,
  CrossDomainIntegrityResourceIdentity,
  CrossDomainIntegrityRole,
} from './cross-domain-integrity-checker'
import type {
  CrossDomainIntegrityTableNames,
  CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-page-contract'

/** SDK-independent logical table contracts retained for script compatibility. */
export type {
  CrossDomainIntegrityTableNames,
  CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-page-contract'
/** Dataset-role contract retained for operator-script compatibility. */
export type { CrossDomainIntegrityRole } from './cross-domain-integrity-checker'

/** Logical S3 target whose physical bucket must be supplied exactly once. */
export type CrossDomainIntegrityBucketTarget = 'file'

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
   * Measures all six table incarnations and one exact File bucket marker.
   *
   * @param marker - Exact infrastructure-emitted marker version expectation.
   * @param signal - Invocation-wide cancellation for the eight finite reads.
   * @returns Strict private immutable resource-attestation snapshot.
   */
  readonly measureResourceAttestation?: (
    marker: CrossDomainIntegrityFileBucketMarkerAttestation,
    signal?: AbortSignal,
  ) => Promise<CrossDomainIntegrityResourceAttestation>

  /**
   * Reads attributes for one exact allowlisted S3 object version.
   *
   * @param reference - Exact bucket, key, and VersionId reference.
   * @param signal - Invocation-wide cancellation for this finite request.
   * @returns S3 object-attributes response.
   */
  getObjectAttributes(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ): Promise<GetObjectAttributesCommandOutput>

  /**
   * Reads tags for one exact allowlisted S3 object version.
   *
   * @param reference - Exact bucket, key, and VersionId reference.
   * @param signal - Invocation-wide cancellation for this finite request.
   * @returns S3 object-tagging response.
   */
  getObjectTagging(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ): Promise<GetObjectTaggingCommandOutput>

  /**
   * Reads headers for one exact allowlisted S3 object version.
   *
   * @param reference - Exact bucket, key, and VersionId reference.
   * @param signal - Invocation-wide cancellation for this finite request.
   * @returns S3 HEAD response.
   */
  headObject(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ): Promise<HeadObjectCommandOutput>

  /**
   * Reads and validates the AWS account bound to the explicit profile.
   *
   * @param signal - Invocation-wide cancellation for this finite request.
   * @returns Twelve-digit caller account identifier.
   */
  readCallerAccount(signal?: AbortSignal): Promise<string>

  /**
   * Reads endpoint Work Item Types with strongly consistent exact-key reads.
   *
   * @param workspaceId - Workspace owning the endpoint rows.
   * @param teamId - Team owning the endpoint rows.
   * @param workItemIds - Endpoint Work Item IDs to resolve.
   * @param signal - Invocation-wide cancellation for these finite requests.
   * @returns A map containing the non-deleted canonical endpoint Type IDs.
   */
  readonly readWorkItemTypes?: (
    workspaceId: string,
    teamId: string,
    workItemIds: readonly string[],
    signal?: AbortSignal,
  ) => Promise<ReadonlyMap<string, string>>

  /**
   * Reads one bounded, unfiltered, strongly consistent DynamoDB page.
   *
   * @param target - Logical table target.
   * @param exclusiveStartKey - Opaque cursor returned by the preceding page.
   * @param signal - Invocation-wide cancellation for this finite request.
   * @returns DynamoDB scan response.
   */
  scanPage(
    target: CrossDomainIntegrityTableTarget,
    exclusiveStartKey?: Record<string, AttributeValue>,
    signal?: AbortSignal,
  ): Promise<ScanCommandOutput>
}

/** One-shot trusted completion seam for an actual live checker bridge. */
export type CrossDomainIntegrityLiveRuntimeBridge = {
  /** Trusted wall-clock sample immediately before bridge invocation. */
  readonly startedAt: string
  /**
   * Samples the trusted wall clock after all external reads finish.
   *
   * @returns Canonical completion timestamp exactly once.
   */
  readonly sampleCompletedAt: () => string
}

/** Input supplied to the cross-domain core composition bridge. */
export type CrossDomainIntegrityCheckBridgeInput = {
  /** Existing 32-byte Workspace Audit pseudonym key retained only for this invocation. */
  readonly auditPseudonymKey: Uint8Array
  /** Canonical UTC timestamp shared by paired source and restore checks. */
  readonly checkedAt: string
  /** Logical observation or an actual-runtime migration rehearsal check. */
  readonly observationMode?: CrossDomainIntegrityObservationMode
  /** Required one-shot trusted completion seam for actual live mode. */
  readonly liveRuntime?: CrossDomainIntegrityLiveRuntimeBridge
  /** Dedicated HMAC key retained only for the invocation lifetime. */
  readonly digestKey: Uint8Array
  /** Non-resettable total deadline shared by every raw and normalized read. */
  readonly deadline: CrossDomainIntegrityInvocationDeadline
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
  /** Required private immutable snapshot for an actual live rehearsal. */
  readonly resourceAttestation?: CrossDomainIntegrityResourceAttestation
  /** Required immutable identity scheme for an actual live rehearsal. */
  readonly resourceIdentityScheme?:
    CrossDomainIntegrityResourceAttestation['scheme']
  /** Keyed digest binding evidence to the exact account, Region, tables, and bucket. */
  readonly resourceIdentityDigest: string
  /** Source or isolated-restore dataset role. */
  readonly role: CrossDomainIntegrityRole
}
