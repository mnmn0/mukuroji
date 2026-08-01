import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import {
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeExportCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ExportTableToPointInTimeCommand,
  GetItemCommand,
  RestoreTableToPointInTimeCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DeleteTableCommandOutput,
  type DescribeContinuousBackupsCommandOutput,
  type DescribeExportCommandOutput,
  type DescribeTableCommandOutput,
  type DescribeTimeToLiveCommandOutput,
  type ExportTableToPointInTimeCommandOutput,
  type GetItemCommandOutput,
  type RestoreTableToPointInTimeCommandOutput,
  type ScanCommandOutput,
  type UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  type DecryptCommandOutput,
  type EncryptCommandOutput,
} from '@aws-sdk/client-kms'
import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectAttributesCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListPartsCommand,
  S3Client,
  type AbortMultipartUploadCommandOutput,
  type CopyObjectCommandOutput,
  type DeleteObjectCommandOutput,
  type GetObjectAttributesCommandOutput,
  type GetObjectTaggingCommandOutput,
  type HeadObjectCommandOutput,
  type ListMultipartUploadsCommandOutput,
  type ListObjectVersionsCommandOutput,
  type ListPartsCommandOutput,
} from '@aws-sdk/client-s3'
import {
  parseFileIntegrityReferences,
  type FileIntegrityReference,
} from '../files'
import {
  RESTORE_DRILL_TABLE_TARGETS,
  RestoreDrillKeyedMultisetDigestAccumulator,
  type RestoreDrillKeyedMultisetDigestCheckpoint,
  type RestoreDrillMultisetDigest,
  type RestoreDrillTableTarget,
} from './restore-drill'
import {
  RESTORE_DRILL_FILE_MAXIMUM_BYTES,
  RestoreDrillFileRangeFailure,
  advanceRestoreDrillFileRangeCheckpoint,
  createRestoreDrillFileRangeCheckpoint,
  selectRestoreDrillFileRangeWindow,
  type RestoreDrillFileRangeBinding,
  type RestoreDrillFileRangeCheckpoint,
  type RestoreDrillFileRangeWindow,
} from './restore-drill-file-range'

export type { RestoreDrillFileRangeCheckpoint } from './restore-drill-file-range'

/** Auxiliary File Proofing row kinds that do not own immutable object versions. */
const FILE_PROOFING_AUXILIARY_ENTRY_TYPES = new Set([
  'annotation',
  'approval',
  'approval-summary',
  'download',
  'file-approval-index',
  'reviewer-approval',
])

/** Maximum UTF-8 bytes accepted for one DynamoDB export JSON record. */
const RESTORE_DRILL_EXPORT_JSON_LINE_MAXIMUM_BYTES = 1_048_576

/** One of the six fixed DynamoDB datasets included in a restore drill. */
export type RestoreDrillAwsTableTarget = RestoreDrillTableTarget

/** Stable logical order for every DynamoDB dataset included in a restore drill. */
export const RESTORE_DRILL_AWS_TABLE_TARGETS: readonly RestoreDrillAwsTableTarget[] =
  RESTORE_DRILL_TABLE_TARGETS

/** Complete logical-to-physical source table allowlist. */
export type RestoreDrillSourceTableNames = {
  /** Audit Events source table. */
  readonly 'table:audit-events': string
  /** File Proofing metadata source table. */
  readonly 'table:file-proofing': string
  /** Project Directory source table. */
  readonly 'table:project-directory': string
  /** Work Item Configuration source table. */
  readonly 'table:work-item-configuration': string
  /** Work Items source table. */
  readonly 'table:work-items': string
  /** Workspace Access source table. */
  readonly 'table:workspace-access': string
}

/** Explicit AWS resources available to the isolated restore drill adapter. */
export type RestoreDrillAwsConfiguration = {
  /** Twelve-digit account that must own the scratch bucket. */
  readonly accountId: string
  /** Existing audit pseudonym secret ARN retained for runner composition. */
  readonly auditPseudonymSecretArn: string
  /** Evidence bucket address retained for composition but never accepted by cleanup. */
  readonly evidenceBucketName: string
  /** Customer-managed KMS key encrypting evidence and per-run digest keys. */
  readonly evidenceKmsKeyArn: string
  /** CloudWatch namespace receiving restore drill objective metrics. */
  readonly metricNamespace: string
  /** AWS Region containing every configured resource. */
  readonly region: string
  /** Prefix used to derive deterministic isolated restore table names. */
  readonly restoreTablePrefix: string
  /** Versioned source bucket containing exact immutable File objects. */
  readonly sourceFileBucketName: string
  /** Complete fixed source table allowlist. */
  readonly sourceTables: RestoreDrillSourceTableNames
  /** Versioned isolated bucket containing exports and copied File versions. */
  readonly scratchBucketName: string
  /** Customer-managed KMS key used for every scratch object. */
  readonly scratchKmsKeyArn: string
  /** Durable state table address retained only by the orchestrator composition. */
  readonly stateTableName: string
}

/** Stable adapter failure codes that never contain raw AWS data. */
export type RestoreDrillAwsFailureCode =
  | 'AWS_RESPONSE_INVALID'
  | 'CHECKPOINT_INVALID'
  | 'CLEANUP_IDENTITY_MISMATCH'
  | 'CONFIGURATION_INVALID'
  | 'EXPORT_FAILED'
  | 'EXPORT_CHECKSUM_MISMATCH'
  | 'EXPORT_IDENTITY_MISMATCH'
  | 'EXPORT_LIMIT_EXCEEDED'
  | 'FILE_COPY_CHECKSUM_MISMATCH'
  | 'FILE_COPY_IDENTITY_MISMATCH'
  | 'FILE_COPY_METADATA_MISMATCH'
  | 'FILE_COPY_TAG_MISMATCH'
  | 'FILE_ROW_INVALID'
  | 'RESTORE_IDENTITY_MISMATCH'
  | 'RESTORE_START_FAILED'
  | 'SOURCE_PITR_INVALID'
  | 'TABLE_DESCRIPTOR_INVALID'
  | 'UNEXPECTED_AWS_FAILURE'

/** Raw-value-free failure raised at the AWS adapter boundary. */
export class RestoreDrillAwsFailure extends Error {
  /** Stable machine-readable failure category. */
  readonly code: RestoreDrillAwsFailureCode

  /**
   * Creates a raw-value-free AWS adapter failure.
   *
   * @param code - Stable failure category.
   */
  constructor(code: RestoreDrillAwsFailureCode) {
    super(code)
    this.name = 'RestoreDrillAwsFailure'
    this.code = code
  }
}

/** Canonical key component captured from a DynamoDB descriptor. */
export type RestoreDrillKeySchemaElement = {
  /** Attribute name. */
  readonly attributeName: string
  /** Partition or sort key role. */
  readonly keyType: 'HASH' | 'RANGE'
}

/** Canonical scalar attribute definition captured from a DynamoDB descriptor. */
export type RestoreDrillAttributeDefinition = {
  /** Attribute name. */
  readonly attributeName: string
  /** DynamoDB scalar attribute type. */
  readonly attributeType: 'B' | 'N' | 'S'
}

/** Canonical secondary-index projection captured from a DynamoDB descriptor. */
export type RestoreDrillIndexProjection = {
  /** Sorted projected non-key attributes. */
  readonly nonKeyAttributes: readonly string[]
  /** DynamoDB projection mode. */
  readonly projectionType: 'ALL' | 'INCLUDE' | 'KEYS_ONLY'
}

/** Canonical global secondary-index descriptor. */
export type RestoreDrillGlobalSecondaryIndex = {
  /** Index name. */
  readonly indexName: string
  /** Complete key schema. */
  readonly keySchema: readonly RestoreDrillKeySchemaElement[]
  /** Complete projection. */
  readonly projection: RestoreDrillIndexProjection
  /** Operational readiness state, accepted only when ACTIVE. */
  readonly status: 'ACTIVE'
}

/** Canonical DynamoDB table descriptor used for source/restore comparison. */
export type RestoreDrillTableDescriptor = {
  /** Sorted table scalar attribute definitions. */
  readonly attributeDefinitions: readonly RestoreDrillAttributeDefinition[]
  /** Billing mode observed on the table. */
  readonly billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED'
  /** Sorted global secondary indexes. */
  readonly globalSecondaryIndexes: readonly RestoreDrillGlobalSecondaryIndex[]
  /** Approximate item count reported by DynamoDB. */
  readonly itemCount: number
  /** Complete base-table key schema. */
  readonly keySchema: readonly RestoreDrillKeySchemaElement[]
  /** KMS key ARN when DynamoDB reports one. */
  readonly kmsMasterKeyArn?: string
  /** DynamoDB server-side encryption type. */
  readonly sseType: 'AES256' | 'KMS'
  /** Canonical encryption readiness accepted only after ENABLED is observed or implied. */
  readonly sseStatus: 'ENABLED'
  /** Stable table identifier. */
  readonly tableId: string
  /** Whether TTL is enabled or enabling. */
  readonly ttlEnabled: boolean
  /** TTL attribute when TTL is enabled. */
  readonly ttlAttribute?: string
  /** Stable TTL lifecycle state accepted only after transitions complete. */
  readonly ttlStatus: 'DISABLED' | 'ENABLED'
}

/** One source table's exact PITR window and descriptor observation. */
export type RestoreDrillSourceTableObservation = {
  /** Earliest point DynamoDB permits restoring. */
  readonly earliestRestorableAt: string
  /** Latest point DynamoDB permits restoring. */
  readonly latestRestorableAt: string
  /** Exact source table ARN used by restore and export requests. */
  readonly sourceTableArn: string
  /** Logical allowlisted table target. */
  readonly target: RestoreDrillAwsTableTarget
  /** Canonical source descriptor. */
  readonly descriptor: RestoreDrillTableDescriptor
}

/** Exact recorded identity for a table created by this drill. */
export type RestoreDrillRecordedRestoreTable = {
  /** Discriminator preventing source tables from entering cleanup APIs. */
  readonly kind: 'restore-table'
  /** Restore point bound to the table creation. */
  readonly restorePoint: string
  /** Source ARN echoed by DynamoDB RestoreSummary. */
  readonly sourceTableArn: string
  /** Stable target table identifier. */
  readonly tableId: string
  /** Exact target table ARN. */
  readonly tableArn: string
  /** Deterministically derived target table name. */
  readonly tableName: string
  /** Logical dataset restored into this table. */
  readonly target: RestoreDrillAwsTableTarget
}

/** Result of starting or exactly adopting one table restore. */
export type RestoreDrillStartRestoreResult = {
  /** Whether a pre-existing exact restore was adopted after ambiguous start failure. */
  readonly adopted: boolean
  /** Exact isolated table identity. */
  readonly table: RestoreDrillRecordedRestoreTable
}

/** Poll result for one exact table restore. */
export type RestoreDrillRestorePollResult = {
  /** Canonical descriptor once the table becomes active. */
  readonly descriptor?: RestoreDrillTableDescriptor
  /** Whether the exact restore is complete. */
  readonly status: 'completed' | 'pending'
}

/** Resumable exact table cleanup reconciliation result. */
export type RestoreDrillTableCleanupResult = {
  /** Whether exact absence is confirmed or deletion is still converging. */
  readonly status: 'completed' | 'pending'
}

/** Exact export identity needed for deterministic polling and manifest reads. */
export type RestoreDrillRecordedExport = {
  /** Idempotency token bound to drill, table, and restore point. */
  readonly clientToken: string
  /** Exact DynamoDB export ARN. */
  readonly exportArn: string
  /** Restore point exported from the source table. */
  readonly exportPoint: string
  /** Discriminator for export records. */
  readonly kind: 'table-export'
  /** Exact scratch prefix selected for the export. */
  readonly scratchPrefix: string
  /** Exact source table ARN. */
  readonly sourceTableArn: string
  /** Exact stable source table identifier. */
  readonly sourceTableId: string
  /** Logical dataset being exported. */
  readonly target: RestoreDrillAwsTableTarget
}

/** Poll result for one exact table export. */
export type RestoreDrillExportPollResult = {
  /** Exact manifest-summary key after successful completion. */
  readonly manifestKey?: string
  /** Approximate exported item count reported by DynamoDB. */
  readonly itemCount?: number
  /** Whether the exact export is still running, completed, or failed. */
  readonly status: 'completed' | 'failed' | 'pending'
}

/** Narrow DynamoDB transport used by restore drill primitives. */
export interface RestoreDrillDynamoDbTransport {
  /** Sends an adapter-owned exact table deletion. */
  deleteTable(command: DeleteTableCommand): Promise<DeleteTableCommandOutput>
  /** Reads one source PITR window. */
  describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput>
  /** Polls one exact export. */
  describeExport(command: DescribeExportCommand): Promise<DescribeExportCommandOutput>
  /** Reads one exact source or restore table descriptor. */
  describeTable(command: DescribeTableCommand): Promise<DescribeTableCommandOutput>
  /** Reads one exact table TTL descriptor. */
  describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput>
  /** Starts one idempotent point-in-time export. */
  exportTableToPointInTime(
    command: ExportTableToPointInTimeCommand,
  ): Promise<ExportTableToPointInTimeCommandOutput>
  /** Starts one isolated point-in-time table restore. */
  restoreTableToPointInTime(
    command: RestoreTableToPointInTimeCommand,
  ): Promise<RestoreTableToPointInTimeCommandOutput>
  /** Reads one bounded strongly consistent restore table page. */
  scan(command: ScanCommand): Promise<ScanCommandOutput>
  /** Strongly reads one exact isolated File row for response-loss reconciliation. */
  getItem(command: GetItemCommand): Promise<GetItemCommandOutput>
  /** Conditionally updates one exact isolated File row. */
  updateItem(command: UpdateItemCommand): Promise<UpdateItemCommandOutput>
}

/** Narrow S3 transport used by isolated File copy, export, and cleanup primitives. */
export interface RestoreDrillS3Transport {
  /** Aborts one exact incomplete multipart upload. */
  abortMultipartUpload(
    command: AbortMultipartUploadCommand,
  ): Promise<AbortMultipartUploadCommandOutput>
  /** Copies one exact immutable source version into the scratch bucket. */
  copyObject(command: CopyObjectCommand): Promise<CopyObjectCommandOutput>
  /** Permanently removes one exact recorded scratch object version. */
  deleteObject(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>
  /** Streams one exact object version. */
  getObject(command: GetObjectCommand): Promise<RestoreDrillGetObjectOutput>
  /** Reads non-body attributes for one exact object version. */
  getObjectAttributes(
    command: GetObjectAttributesCommand,
  ): Promise<GetObjectAttributesCommandOutput>
  /** Reads all tags on one exact object version. */
  getObjectTagging(
    command: GetObjectTaggingCommand,
  ): Promise<GetObjectTaggingCommandOutput>
  /** Reads metadata for one exact object version. */
  headObject(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>
  /** Lists incomplete uploads under one drill-owned export prefix. */
  listMultipartUploads(
    command: ListMultipartUploadsCommand,
  ): Promise<ListMultipartUploadsCommandOutput>
  /** Lists exact versions for one canonical scratch key during response-loss reconciliation. */
  listObjectVersions(
    command: ListObjectVersionsCommand,
  ): Promise<ListObjectVersionsCommandOutput>
  /** Reconciles whether one exact multipart upload still exists. */
  listParts(command: ListPartsCommand): Promise<ListPartsCommandOutput>
}

/** Narrow exact-version object response exposing only fields consumed by this adapter. */
export type RestoreDrillGetObjectOutput = {
  /** Untrusted SDK streaming body narrowed at runtime. */
  readonly Body?: unknown
  /** Exact inclusive byte range and complete length echoed by S3. */
  readonly ContentRange?: string
  /** Exact response byte length echoed by S3. */
  readonly ContentLength?: number
  /** Exact immutable VersionId echoed by S3. */
  readonly VersionId?: string
}

/** Narrow KMS transport used only for per-run digest-key envelopes. */
export interface RestoreDrillKmsTransport {
  /** Decrypts one drill-bound digest key envelope. */
  decrypt(command: DecryptCommand): Promise<DecryptCommandOutput>
  /** Encrypts one new drill-bound digest key. */
  encrypt(command: EncryptCommand): Promise<EncryptCommandOutput>
}

/** Dependencies used to construct the isolated restore drill AWS operations. */
export type CreateRestoreDrillAwsOperationsInput = {
  /** Explicit resource allowlists and isolation settings. */
  readonly configuration: RestoreDrillAwsConfiguration
  /** Narrow DynamoDB command transport. */
  readonly dynamodb: RestoreDrillDynamoDbTransport
  /** Narrow KMS envelope transport. */
  readonly kms?: RestoreDrillKmsTransport
  /** Narrow S3 command transport. */
  readonly s3: RestoreDrillS3Transport
  /** Optional lifecycle hook owned by concrete client composition. */
  readonly close?: () => void
}

/** Input for one deterministic source-table restore start. */
export type RestoreDrillStartRestoreInput = {
  /** Stable drill identifier used only through a deterministic digest. */
  readonly drillId: string
  /** Canonical restore point shared by all six tables. */
  readonly restorePoint: string
  /** Previously measured source observation. */
  readonly source: RestoreDrillSourceTableObservation
}

/** Input for one deterministic source-table export start. */
export type RestoreDrillStartExportInput = {
  /** Stable drill identifier used only through a deterministic digest. */
  readonly drillId: string
  /** Canonical export point shared by all six tables. */
  readonly exportPoint: string
  /** Previously measured source observation. */
  readonly source: RestoreDrillSourceTableObservation
}

/** Ciphertext-only envelope for one random per-run evidence digest key. */
export type RestoreDrillDigestKeyEnvelope = {
  /** Base64-encoded KMS ciphertext, never plaintext key bytes. */
  readonly ciphertextBase64: string
  /** Discriminator preventing unrelated ciphertext from entering the decrypt port. */
  readonly kind: 'restore-drill-digest-key'
  /** Evidence KMS key ARN that encrypted the envelope. */
  readonly kmsKeyArn: string
}

/** Exact immutable source File object selected from a strictly parsed File row. */
export type RestoreDrillSourceFileVersion = {
  /** Expected object media type from the File row. */
  readonly contentType: string
  /** Canonical object key, preserved unchanged in the isolated bucket. */
  readonly objectKey: string
  /** Exact immutable source S3 VersionId. */
  readonly objectVersionId: string
  /** File-domain version identifier used only for isolated row remapping. */
  readonly versionId: string
  /** Expected object byte length from the File row. */
  readonly sizeBytes: number
}

/** Exact scratch object version created or adopted before content verification. */
export type RestoreDrillCreatedScratchObjectVersion = {
  /** Scratch bucket fixed by adapter configuration. */
  readonly bucketName: string
  /** Stable drill digest binding the record to one copy namespace. */
  readonly drillDigest: string
  /** Discriminator preventing source or evidence objects from entering cleanup. */
  readonly kind: 'scratch-object-version'
  /** Canonical key preserved unchanged from the source File row. */
  readonly objectKey: string
  /** Newly created immutable destination VersionId. */
  readonly objectVersionId: string
  /** File-domain version identifier remapped in the isolated row. */
  readonly versionId: string
}

/** Complete scratch-version delta created or adopted for one durable File copy intent. */
export type RestoreDrillCreatedScratchObjectVersions = {
  /** Every post-baseline VersionId that must remain in the durable cleanup scope. */
  readonly createdCopies: readonly RestoreDrillCreatedScratchObjectVersion[]
  /** Deterministically selected version that alone proceeds to verification and row remapping. */
  readonly selectedCopy: RestoreDrillCreatedScratchObjectVersion
}

/** Role-bound keyed proof of one independently observed immutable File version. */
export type RestoreDrillFileVersionProof = {
  /** Comparable HMAC of the complete streamed content and portable File identity. */
  readonly contentDigest: string
  /** Comparable HMAC of every portable copied header and user metadata field. */
  readonly metadataDigest: string
  /** Role-bound HMAC of the exact physical bucket, key, and immutable VersionId. */
  readonly physicalIdentityDigest: string
  /** Role- and physical-version-bound HMAC authenticating the comparable digests. */
  readonly proofMac: string
  /** Fixed proof contract version. */
  readonly proofVersion: 1
  /** Observation role preventing source and destination proof substitution. */
  readonly role: 'destination' | 'source'
  /** Comparable HMAC of the complete canonical exact-version tag set. */
  readonly tagsDigest: string
}

/** Exact scratch object version whose source and destination were independently verified. */
export type RestoreDrillRecordedScratchObjectVersion =
  RestoreDrillCreatedScratchObjectVersion & {
    /** Independently observed destination proof without a plaintext content digest. */
    readonly destinationProof: RestoreDrillFileVersionProof
    /** Independently observed source proof without a plaintext content digest. */
    readonly sourceProof: RestoreDrillFileVersionProof
  }

/** Exact scratch version created by one recorded DynamoDB export. */
export type RestoreDrillRecordedExportObjectVersion = {
  /** Scratch bucket fixed by adapter configuration. */
  readonly bucketName: string
  /** Digest binding the cleanup record to one exact export ARN. */
  readonly exportArnDigest: string
  /** Discriminator preventing File, source, or evidence versions from substitution. */
  readonly kind: 'export-object-version'
  /** Exact export object key under the recorded scratch prefix. */
  readonly objectKey: string
  /** Exact immutable scratch VersionId. */
  readonly objectVersionId: string
  /** Exact recorded export prefix. */
  readonly scratchPrefix: string
}

/** Exact incomplete multipart upload created below one drill-owned export prefix. */
export type RestoreDrillRecordedMultipartUpload = {
  /** Scratch bucket fixed by adapter configuration. */
  readonly bucketName: string
  /** Discriminator preventing completed versions from entering MPU cleanup. */
  readonly kind: 'scratch-multipart-upload'
  /** Exact drill-owned scratch object key. */
  readonly objectKey: string
  /** Exact immutable multipart upload identifier. */
  readonly uploadId: string
}

/** Opaque resumable cursor for one exact S3 multipart-upload listing page. */
export type RestoreDrillMultipartUploadCursor = {
  /** Exact next object-key marker returned by S3. */
  readonly keyMarker: string
  /** Exact next upload identifier marker returned by S3. */
  readonly uploadIdMarker: string
}

/** One bounded page of exact incomplete multipart uploads. */
export type RestoreDrillMultipartUploadPage = {
  /** Exact uploads present in this page. */
  readonly uploads: readonly RestoreDrillRecordedMultipartUpload[]
  /** Opaque continuation absent on the terminal page. */
  readonly nextCursor?: RestoreDrillMultipartUploadCursor
}

/** Resumable exact multipart-upload cleanup reconciliation result. */
export type RestoreDrillMultipartUploadCleanupResult = {
  /** Whether exact absence is confirmed or abort convergence requires another invocation. */
  readonly status: 'absent' | 'pending'
}

/** Opaque resumable cursor for one exact S3 ListObjectVersions page. */
export type RestoreDrillExportObjectVersionCursor = {
  /** Exact next key marker returned by S3. */
  readonly keyMarker: string
  /** Exact next VersionId marker returned by S3. */
  readonly versionIdMarker: string
}

/** One bounded page of exact export-created scratch versions. */
export type RestoreDrillExportObjectVersionPage = {
  /** Exact continuation to persist after this page, absent when listing is complete. */
  readonly nextCursor?: RestoreDrillExportObjectVersionCursor
  /** At most 1,000 exact versions to durably record before continuing. */
  readonly versions: readonly RestoreDrillRecordedExportObjectVersion[]
}

/** One bounded strongly consistent page from the isolated File Proofing table. */
export type RestoreDrillFileScanPage = {
  /** Opaque low-level continuation retained only inside the durable adapter boundary. */
  readonly nextKey?: Readonly<Record<string, AttributeValue>>
  /** Strictly parsed File row work, absent for auxiliary or empty rows. */
  readonly row?: RestoreDrillFileRowWork
}

/** Process-local File row material used to copy and conditionally remap object versions. */
export type RestoreDrillFileRowWork = {
  /** Exact original low-level DynamoDB item used for a conditional versions update. */
  readonly originalItem: Readonly<Record<string, AttributeValue>>
  /** Positive optimistic revision from the isolated File row. */
  readonly revision: number
  /** Exact table partition and sort keys. */
  readonly rowKey: Readonly<Record<string, AttributeValue>>
  /** Strict immutable object-version references in stored order. */
  readonly versions: readonly RestoreDrillSourceFileVersion[]
}

/** Input for one exact immutable File object copy. */
export type RestoreDrillCopyFileVersionInput = {
  /** Stable drill identifier used only through a deterministic digest. */
  readonly drillId: string
  /** Durable exact destination baseline captured before the first copy attempt. */
  readonly preexistingScratchVersionIds: readonly string[]
  /** Strict exact-version source reference. */
  readonly source: RestoreDrillSourceFileVersion
}

/** Input for verifying one already durable scratch object identity. */
export type RestoreDrillVerifyCreatedFileVersionInput = {
  /** Authenticated progress from the preceding bounded range, absent on the first range. */
  readonly checkpoint?: RestoreDrillFileRangeCheckpoint
  /** Exact created or adopted scratch object identity. */
  readonly copy: RestoreDrillCreatedScratchObjectVersion
  /** Invocation-local 32-byte HMAC key used to redact retained comparison evidence. */
  readonly digestKey: Uint8Array
  /** Stable drill identifier bound into the created copy identity. */
  readonly drillId: string
  /** Strict exact-version source reference. */
  readonly source: RestoreDrillSourceFileVersion
}

/** Bounded result of one exact-version File verification range. */
export type RestoreDrillVerifyCreatedFileVersionResult =
  | {
    /** Authenticated progress to persist before reading another range. */
    readonly checkpoint: RestoreDrillFileRangeCheckpoint
    /** Discriminator for an incomplete exact-version verification. */
    readonly status: 'pending'
  }
  | {
    /** Final independently authenticated source and destination proof. */
    readonly version: RestoreDrillRecordedScratchObjectVersion
    /** Discriminator for a complete exact-version verification. */
    readonly status: 'completed'
  }

/** Durable File scan checkpoint committed separately by the state-only CAS port. */
export type RestoreDrillFileRemapCheckpoint = {
  /** Whether the isolated File table scan reached its terminal page. */
  readonly complete: boolean
  /** Opaque next key retained only in the state table, when another row remains. */
  readonly nextKey?: Readonly<Record<string, AttributeValue>>
  /** Expected durable state revision used for compare-and-swap. */
  readonly stateRevision: number
}

/** Input for one isolated File row compare-and-swap after durable copy intent persistence. */
export type RestoreDrillCommitFileRemapInput = {
  /** Exact verified scratch copies for every source object version. */
  readonly copies: readonly RestoreDrillRecordedScratchObjectVersion[]
  /** Stable drill identifier selecting one state row. */
  readonly drillId: string
  /** Exact isolated File row work. */
  readonly row: RestoreDrillFileRowWork
  /** Exact isolated File Proofing restore identity. */
  readonly table: RestoreDrillRecordedRestoreTable
}

/** Result of one isolated File row remap CAS or exact response-loss adoption. */
export type RestoreDrillFileRemapResult = {
  /** Whether the current invocation committed or adopted the exact prior update. */
  readonly status: 'adopted' | 'committed'
}

/** Bounds applied while streaming one DynamoDB export manifest or data object. */
export type RestoreDrillExportStreamLimits = {
  /** Maximum uncompressed bytes accepted from one object. */
  readonly maxBytes: number
  /** Maximum data files or exported items accepted from one object. */
  readonly maxRecords: number
}

/** One strictly parsed DynamoDB export data file reference. */
export type RestoreDrillExportDataFile = {
  /** Expected number of newline-delimited items in the data file. */
  readonly itemCount: number
  /** Base64-encoded MD5 of the exact gzip data object. */
  readonly md5Checksum: string
  /** Exact object key under the recorded export prefix. */
  readonly objectKey: string
}

/** Strict bounded DynamoDB JSON export manifest. */
export type RestoreDrillExportManifest = {
  /** Data files in manifest order. */
  readonly dataFiles: readonly RestoreDrillExportDataFile[]
  /** Sum of manifest item counts. */
  readonly itemCount: number
  /** Number of export data files, used as partition-count evidence. */
  readonly partitionCount: number
}

/** Strict identity-bound DynamoDB export manifest summary. */
export type RestoreDrillExportSummary = {
  /** Exact exported item count. */
  readonly itemCount: number
  /** Exact manifest-files object key. */
  readonly manifestFilesObjectKey: string
  /** Fixed DynamoDB JSON output format. */
  readonly outputFormat: 'DYNAMODB_JSON'
  /** Stable source table identifier echoed by the manifest. */
  readonly sourceTableId: string
}

/** Secret-free aggregate produced from export data or isolated restore Scan pages. */
export type RestoreDrillDynamoAggregateEvidence = {
  /** Order-independent keyed digest of normalized complete items. */
  readonly content: RestoreDrillMultisetDigest
  /** Order-independent keyed digest of exact primary keys. */
  readonly keys: RestoreDrillMultisetDigest
  /** Count of unique keyed partition values. */
  readonly logicalPartitionCount: number
  /** Exact item multiplicity. */
  readonly recordCount: number
}

/** Compact authenticated aggregate state emitted for one durable verification unit. */
export type RestoreDrillDynamoAggregateCheckpoint = {
  /** Authenticated compact normalized-content multiset state. */
  readonly content: RestoreDrillKeyedMultisetDigestCheckpoint
  /** HMAC binding target, schema, aggregate states, and partition digests. */
  readonly checkpointMac: string
  /** Fixed checkpoint contract version. */
  readonly checkpointVersion: 1
  /** Authenticated compact exact-key multiset state. */
  readonly keys: RestoreDrillKeyedMultisetDigestCheckpoint
  /** HMAC fingerprint of the canonical base-table key schema. */
  readonly keySchemaDigest: string
  /** Keyed unique logical-partition digests in lexical order. */
  readonly partitionDigests: readonly string[]
  /** Exact item multiplicity represented by both aggregate states. */
  readonly recordCount: number
  /** Logical table target controlling portable item normalization. */
  readonly target: RestoreDrillAwsTableTarget
}

/** Input for one bounded strongly consistent restore aggregate Scan page. */
export type RestoreDrillScanAggregatePageInput = {
  /** Process-local keyed aggregate accumulator. */
  readonly accumulator: RestoreDrillDynamoAggregateAccumulator
  /** Opaque preceding scan checkpoint. */
  readonly exclusiveStartKey?: Readonly<Record<string, AttributeValue>>
  /** Fixed page size between 1 and 1,000. */
  readonly limit: number
  /** Exact isolated restore table identity. */
  readonly table: RestoreDrillRecordedRestoreTable
}

/** Result of one bounded restore aggregate Scan page. */
export type RestoreDrillScanAggregatePageResult = {
  /** Number of items added to the process-local accumulator. */
  readonly itemCount: number
  /** Opaque exact next checkpoint, absent at the terminal page. */
  readonly nextKey?: Readonly<Record<string, AttributeValue>>
}

/** Callback that may use plaintext digest bytes only for its invocation lifetime. */
export interface RestoreDrillDigestKeyConsumer<Result> {
  /**
   * Uses one mutable 32-byte plaintext key before the adapter zeroizes it.
   *
   * @param digestKey - Process-local plaintext digest key.
   * @returns Callback result that must not contain the key bytes.
   */
  (digestKey: Uint8Array): Promise<Result>
}

/** Isolated AWS data-plane operations used by the durable restore drill orchestrator. */
export interface RestoreDrillAwsOperations {
  /** Releases concrete AWS SDK client resources when this adapter owns them. */
  close(): void

  /**
   * Collects PITR windows and canonical descriptors for all six fixed source tables.
   *
   * @returns Observations in stable logical target order.
   */
  collectSourceTableObservations(): Promise<readonly RestoreDrillSourceTableObservation[]>

  /**
   * Creates and KMS-encrypts one random per-run digest key.
   *
   * @param drillId - Stable drill identifier bound into KMS encryption context.
   * @returns Ciphertext-only durable envelope.
   */
  createDigestKeyEnvelope(drillId: string): Promise<RestoreDrillDigestKeyEnvelope>

  /**
   * Creates or exactly adopts every immutable File object version before verification.
   *
   * @param input - Drill binding, durable pre-copy baseline, and strict source reference.
   * @returns Complete created-version delta and one deterministic verification selection.
   */
  createOrAdoptFileVersion(
    input: RestoreDrillCopyFileVersionInput,
  ): Promise<RestoreDrillCreatedScratchObjectVersions>

  /**
   * Re-lists the exact post-baseline scratch VersionId delta without creating a copy.
   *
   * @param input - Drill binding, durable pre-copy baseline, and strict source reference.
   * @returns Every currently observable created-version identity, possibly empty.
   */
  reconcileCreatedFileVersions(
    input: RestoreDrillCopyFileVersionInput,
  ): Promise<readonly RestoreDrillCreatedScratchObjectVersion[]>

  /**
   * Verifies portable metadata, tags, and one resumable content range of a durable copy.
   *
   * @param input - Exact durable copy identity and immutable source reference.
   * @returns Durable next-range progress or the final independently verified version.
   */
  verifyCreatedFileVersion(
    input: RestoreDrillVerifyCreatedFileVersionInput,
  ): Promise<RestoreDrillVerifyCreatedFileVersionResult>

  /**
   * Conditionally remaps one isolated File row after its copy intent is durable.
   *
   * @param input - Exact row, copies, and isolated table identity.
   * @returns Whether this invocation committed or adopted the exact remap.
   */
  commitFileRemap(
    input: RestoreDrillCommitFileRemapInput,
  ): Promise<RestoreDrillFileRemapResult>

  /**
   * Deletes one exact recorded isolated table after reconciling its immutable identity.
   *
   * @param table - Exact restore table identity issued by this adapter.
   */
  deleteRecordedRestoreTable(
    table: RestoreDrillRecordedRestoreTable,
    drillId: string,
  ): Promise<RestoreDrillTableCleanupResult>

  /**
   * Deletes one exact recorded scratch object version and reconciles absence.
   *
   * @param version - Exact scratch version issued by the copy operation.
   */
  deleteRecordedScratchObjectVersion(
    version: RestoreDrillCreatedScratchObjectVersion,
    drillId: string,
  ): Promise<void>

  /**
   * Deletes one exact recorded DynamoDB export object version and reconciles absence.
   *
   * @param version - Exact export-created scratch version.
   */
  deleteRecordedExportObjectVersion(
    version: RestoreDrillRecordedExportObjectVersion,
    drillId: string,
  ): Promise<void>

  /**
   * Aborts one exact recorded incomplete multipart upload and reconciles its absence.
   *
   * @param upload - Exact drill-owned multipart upload recorded before approval.
   * @returns Whether absence is proven or another abort reconciliation is required.
   */
  abortRecordedMultipartUpload(
    upload: RestoreDrillRecordedMultipartUpload,
    drillId: string,
  ): Promise<RestoreDrillMultipartUploadCleanupResult>

  /**
   * Captures the exact scratch-key VersionId baseline before a durable copy intent is written.
   *
   * @param source - Strict source reference whose canonical key is preserved.
   * @returns Sorted exact VersionIds already present for that key.
   */
  listScratchObjectVersionIds(
    source: RestoreDrillSourceFileVersion,
  ): Promise<readonly string[]>

  /**
   * Enumerates every exact version created below one recorded DynamoDB export prefix.
   *
   * @param exportRecord - Exact identity-bound export.
   * @returns Exact scratch versions suitable for durable cleanup recording.
   */
  listRecordedExportObjectVersions(
    exportRecord: RestoreDrillRecordedExport,
  ): Promise<readonly RestoreDrillRecordedExportObjectVersion[]>

  /**
   * Lists one resumable page of exact versions below a recorded DynamoDB export prefix.
   *
   * @param exportRecord - Exact identity-bound export.
   * @param cursor - Exact preceding page cursor.
   * @returns Bounded versions and a continuation suitable for durable CAS persistence.
   */
  listRecordedExportObjectVersionPage(
    exportRecord: RestoreDrillRecordedExport,
    cursor?: RestoreDrillExportObjectVersionCursor,
  ): Promise<RestoreDrillExportObjectVersionPage>

  /**
   * Lists one resumable page of incomplete uploads below one exact drill prefix.
   *
   * @param prefix - Exact `restore-drill/<drill-digest>/` prefix.
   * @param cursor - Exact preceding page cursor.
   * @returns Bounded upload identities and a durable continuation.
   */
  listRecordedMultipartUploadPage(
    prefix: string,
    cursor?: RestoreDrillMultipartUploadCursor,
  ): Promise<RestoreDrillMultipartUploadPage>

  /**
   * Polls one exact table export.
   *
   * @param exportRecord - Exact export identity returned by the start operation.
   * @returns Secret-free status and bounded completion metadata.
   */
  pollTableExport(
    exportRecord: RestoreDrillRecordedExport,
  ): Promise<RestoreDrillExportPollResult>

  /**
   * Polls one exact isolated table restore.
   *
   * @param table - Exact restore identity returned by the start operation.
   * @returns Pending state or completed canonical descriptor.
   */
  pollTableRestore(
    table: RestoreDrillRecordedRestoreTable,
  ): Promise<RestoreDrillRestorePollResult>

  /**
   * Reads one strongly consistent Limit=1 File Proofing scan page.
   *
   * @param table - Exact isolated File Proofing restore identity.
   * @param exclusiveStartKey - Opaque preceding checkpoint.
   * @returns Strict process-local File row work and exact next checkpoint.
   */
  scanFileProofingPage(
    table: RestoreDrillRecordedRestoreTable,
    exclusiveStartKey?: Readonly<Record<string, AttributeValue>>,
  ): Promise<RestoreDrillFileScanPage>

  /**
   * Adds one bounded strongly consistent isolated table page to a keyed accumulator.
   *
   * @param input - Exact table, page bound, checkpoint, and process-local accumulator.
   * @returns Page count and exact next checkpoint.
   */
  scanRestoreAggregatePage(
    input: RestoreDrillScanAggregatePageInput,
  ): Promise<RestoreDrillScanAggregatePageResult>

  /**
   * Starts an idempotent point-in-time export into the KMS-protected scratch prefix.
   *
   * @param input - Drill, common point, and measured source identity.
   * @returns Exact export identity for later polling.
   */
  startTableExport(input: RestoreDrillStartExportInput): Promise<RestoreDrillRecordedExport>

  /**
   * Starts or exactly adopts one deterministic isolated point-in-time restore.
   *
   * @param input - Drill, common point, and measured source identity.
   * @returns Exact restore identity and adoption evidence.
   */
  startTableRestore(
    input: RestoreDrillStartRestoreInput,
  ): Promise<RestoreDrillStartRestoreResult>

  /**
   * Decrypts, supplies, and always zeroizes one drill-bound digest key.
   *
   * @param drillId - Stable drill identifier bound into KMS encryption context.
   * @param envelope - Ciphertext-only envelope.
   * @param consumer - Bounded callback using the plaintext key in memory.
   * @returns Callback result after plaintext zeroization.
   */
  withDigestKey<Result>(
    drillId: string,
    envelope: RestoreDrillDigestKeyEnvelope,
    consumer: RestoreDrillDigestKeyConsumer<Result>,
  ): Promise<Result>
}

/** Handler action dispatched by the durable restore drill state machine. */
export type RestoreDrillAwsAction = 'advance' | 'cleanup'

/** Stable externally serializable restore drill action result. */
export type RestoreDrillAwsActionResult = {
  /** Stable drill identifier, never a source resource identifier. */
  readonly drillId: string
  /** Secret-free terminal or resumable outcome. */
  readonly status:
    | 'awaiting-cleanup-approval'
    | 'completed'
    | 'failed'
    | 'not-due'
    | 'pending'
  /** Delay before a resumable action should be delivered again. */
  readonly waitSeconds?: number
}

/** Strict outer request accepted by the restore drill Lambda composition. */
export type RestoreDrillAwsActionRequest = {
  /** Durable state-machine action. */
  readonly action: RestoreDrillAwsAction
  /** Untrusted schedule event or drill continuation payload. */
  readonly event: unknown
}

/** Kernel-owned durable driver composed with the narrow AWS operations. */
export interface RestoreDrillAwsActionDriver {
  /**
   * Advances a scheduled or active drill without exposing raw AWS values.
   *
   * @param event - Untrusted schedule or continuation event.
   * @param operations - Isolated AWS data-plane operations.
   * @returns Stable action result.
   */
  advance(
    event: unknown,
    operations: RestoreDrillAwsOperations,
  ): Promise<RestoreDrillAwsActionResult>

  /**
   * Advances approval-gated cleanup without widening cleanup targets.
   *
   * @param event - Untrusted drill continuation event.
   * @param operations - Isolated AWS data-plane operations.
   * @returns Stable action result.
   */
  cleanup(
    event: unknown,
    operations: RestoreDrillAwsOperations,
  ): Promise<RestoreDrillAwsActionResult>
}

/** Environment map read by the concrete AWS composition factory. */
export type RestoreDrillEnvironment = Readonly<Record<string, string | undefined>>

/** Concrete operations plus the validated non-secret configuration used to build them. */
export type RestoreDrillAwsEnvironmentComposition = {
  /** Validated explicit AWS resource configuration. */
  readonly configuration: RestoreDrillAwsConfiguration
  /** Concrete official AWS SDK v3 operations. */
  readonly operations: RestoreDrillAwsOperations
}

/** Minimal environment-backed resource configuration authorized for cleanup. */
export type RestoreDrillAwsCleanupConfiguration = {
  /** Twelve-digit account derived from the evidence KMS ARN. */
  readonly accountId: string
  /** Evidence bucket retained for cleanup evidence composition. */
  readonly evidenceBucketName: string
  /** Evidence KMS key used to decrypt the per-run digest key. */
  readonly evidenceKmsKeyArn: string
  /** CloudWatch metric namespace. */
  readonly metricNamespace: string
  /** AWS Region. */
  readonly region: string
  /** Isolated versioned scratch bucket. */
  readonly scratchBucketName: string
  /** Durable restore drill state table. */
  readonly stateTableName: string
  /** Prefix restricting every deletable DynamoDB table. */
  readonly restoreTablePrefix: string
}

/** Narrow operations available to the approval-gated cleanup handler. */
export interface RestoreDrillAwsCleanupOperations {
  /** Aborts one exact drill-owned multipart upload and reconciles absence. */
  abortRecordedMultipartUpload(
    upload: RestoreDrillRecordedMultipartUpload,
    drillId: string,
  ): Promise<RestoreDrillMultipartUploadCleanupResult>
  /** Releases concrete AWS SDK clients. */
  close(): void
  /** Deletes one exact export-created scratch object version. */
  deleteRecordedExportObjectVersion(
    version: RestoreDrillRecordedExportObjectVersion,
    drillId: string,
  ): Promise<void>
  /** Deletes one exact File-copy scratch object version. */
  deleteRecordedScratchObjectVersion(
    version: RestoreDrillCreatedScratchObjectVersion,
    drillId: string,
  ): Promise<void>
  /** Starts or reconciles deletion of one exact isolated restore table. */
  deleteRecordedRestoreTable(
    table: RestoreDrillRecordedRestoreTable,
    drillId: string,
  ): Promise<RestoreDrillTableCleanupResult>
  /** Lists one bounded page of exact drill-owned incomplete uploads. */
  listRecordedMultipartUploadPage(
    prefix: string,
    cursor?: RestoreDrillMultipartUploadCursor,
  ): Promise<RestoreDrillMultipartUploadPage>
  /** Decrypts and always zeroizes one drill-bound digest key. */
  withDigestKey<Result>(
    drillId: string,
    envelope: RestoreDrillDigestKeyEnvelope,
    consumer: RestoreDrillDigestKeyConsumer<Result>,
  ): Promise<Result>
}

/** Cleanup-only environment composition without production source addresses. */
export type RestoreDrillAwsCleanupEnvironmentComposition = {
  /** Validated minimal cleanup resource configuration. */
  readonly configuration: RestoreDrillAwsCleanupConfiguration
  /** Narrow cleanup-only operations. */
  readonly operations: RestoreDrillAwsCleanupOperations
}

/**
 * Creates isolated restore drill operations over narrow injectable transports.
 *
 * @param input - Explicit resource allowlists and command transports.
 * @returns AWS data-plane operations that never accept arbitrary source names.
 */
export function createRestoreDrillAwsOperations(
  input: CreateRestoreDrillAwsOperationsInput,
): RestoreDrillAwsOperations {
  validateConfiguration(input.configuration)
  return new DefaultRestoreDrillAwsOperations(input)
}

/**
 * Creates concrete official AWS SDK v3 operations from explicit environment addresses.
 *
 * @param environment - Environment map, defaulting to the Lambda process environment.
 * @returns Validated configuration and closeable AWS operations.
 */
export function createRestoreDrillAwsOperationsFromEnvironment(
  environment: RestoreDrillEnvironment = process.env,
): RestoreDrillAwsEnvironmentComposition {
  const configuration = readRestoreDrillAwsConfiguration(environment)
  const dynamodbClient = new DynamoDBClient({ region: configuration.region })
  const kmsClient = new KMSClient({ region: configuration.region })
  const s3Client = new S3Client({ region: configuration.region })
  const transport = new OfficialRestoreDrillAwsTransport(
    dynamodbClient,
    kmsClient,
    s3Client,
  )
  const operations = createRestoreDrillAwsOperations({
    configuration,
    dynamodb: transport,
    kms: transport,
    s3: transport,
    close: () => transport.close(),
  })
  return { configuration, operations }
}

/**
 * Creates cleanup-only official AWS SDK operations without requiring source resource addresses.
 *
 * @param environment - Cleanup Lambda environment map.
 * @returns Minimal validated configuration and narrow cleanup operations.
 */
export function createRestoreDrillAwsCleanupOperationsFromEnvironment(
  environment: RestoreDrillEnvironment = process.env,
): RestoreDrillAwsCleanupEnvironmentComposition {
  const configuration = readRestoreDrillAwsCleanupConfiguration(environment)
  const internalConfiguration = createCleanupRestrictedFullConfiguration(configuration)
  const dynamodbClient = new DynamoDBClient({ region: configuration.region })
  const kmsClient = new KMSClient({ region: configuration.region })
  const s3Client = new S3Client({ region: configuration.region })
  const transport = new OfficialRestoreDrillAwsTransport(
    dynamodbClient,
    kmsClient,
    s3Client,
  )
  const operations: RestoreDrillAwsCleanupOperations =
    new DefaultRestoreDrillAwsOperations({
      configuration: internalConfiguration,
      dynamodb: transport,
      kms: transport,
      s3: transport,
      close: () => transport.close(),
    })
  return { configuration, operations }
}

/**
 * Creates the narrow handler API used by schedule and continuation invocations.
 *
 * The kernel driver owns strict event parsing, durable phase dispatch, failure evidence, and
 * cleanup approval validation. This factory owns only concrete AWS client composition.
 *
 * @param driver - Durable kernel driver.
 * @param environment - Explicit Lambda environment map.
 * @returns One action handler returning only secret-free bounded results.
 */
export function createRestoreDrillAwsActionHandlerFromEnvironment(
  driver: RestoreDrillAwsActionDriver,
  environment: RestoreDrillEnvironment = process.env,
): (request: RestoreDrillAwsActionRequest) => Promise<RestoreDrillAwsActionResult> {
  const composition = createRestoreDrillAwsOperationsFromEnvironment(environment)
  /** Dispatches one already structurally parsed outer request. */
  return async (request) => {
    if (request.action === 'advance') {
      return driver.advance(request.event, composition.operations)
    }
    return driver.cleanup(request.event, composition.operations)
  }
}

/** Concrete isolated restore operations over injected narrow AWS command transports. */
class DefaultRestoreDrillAwsOperations implements RestoreDrillAwsOperations {
  /** Validated explicit AWS resource configuration. */
  private readonly configuration: RestoreDrillAwsConfiguration

  /** Narrow DynamoDB command transport. */
  private readonly dynamodb: RestoreDrillDynamoDbTransport

  /** Optional narrow KMS envelope transport. */
  private readonly kms?: RestoreDrillKmsTransport

  /** Narrow S3 command transport reserved for File and export primitives. */
  private readonly s3: RestoreDrillS3Transport

  /** Optional lifecycle hook for concrete SDK composition. */
  private readonly closeOwnedTransport?: () => void

  /**
   * Creates isolated operations over already validated configuration.
   *
   * @param input - Explicit configuration and command transports.
   */
  constructor(input: CreateRestoreDrillAwsOperationsInput) {
    this.configuration = input.configuration
    this.dynamodb = input.dynamodb
    this.kms = input.kms
    this.s3 = input.s3
    this.closeOwnedTransport = input.close
  }

  /** Releases concrete SDK clients when the composition supplied a lifecycle hook. */
  close(): void {
    this.closeOwnedTransport?.()
  }

  /** Collects all six source PITR windows and table descriptors in stable order. */
  async collectSourceTableObservations(): Promise<readonly RestoreDrillSourceTableObservation[]> {
    const observations: RestoreDrillSourceTableObservation[] = []
    for (const target of RESTORE_DRILL_AWS_TABLE_TARGETS) {
      observations.push(await this.collectSourceTableObservation(target))
    }
    return observations
  }

  /** Creates a KMS-encrypted random 32-byte key and zeroizes plaintext immediately. */
  async createDigestKeyEnvelope(drillId: string): Promise<RestoreDrillDigestKeyEnvelope> {
    createDrillDigest(drillId)
    const kms = this.requireKms()
    const plaintext = randomBytes(32)
    try {
      let output: EncryptCommandOutput
      try {
        output = await kms.encrypt(new EncryptCommand({
          KeyId: this.configuration.evidenceKmsKeyArn,
          Plaintext: plaintext,
          EncryptionContext: createDigestKeyEncryptionContext(drillId),
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        }))
      } catch {
        throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
      }
      if (
        !(output.CiphertextBlob instanceof Uint8Array) ||
        output.CiphertextBlob.length === 0 ||
        output.KeyId !== this.configuration.evidenceKmsKeyArn ||
        output.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT'
      ) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      return {
        kind: 'restore-drill-digest-key',
        kmsKeyArn: this.configuration.evidenceKmsKeyArn,
        ciphertextBase64: Buffer.from(output.CiphertextBlob).toString('base64'),
      }
    } finally {
      plaintext.fill(0)
    }
  }

  /** Creates or exactly adopts every immutable File object version before verification. */
  async createOrAdoptFileVersion(
    input: RestoreDrillCopyFileVersionInput,
  ): Promise<RestoreDrillCreatedScratchObjectVersions> {
    const drillDigest = createDrillDigest(input.drillId)
    requireSourceFileVersion(input.source)
    const baseline = readVersionIdBaseline(input.preexistingScratchVersionIds)
    const sourceHead = await this.headExactObject(
      this.configuration.sourceFileBucketName,
      input.source.objectKey,
      input.source.objectVersionId,
    )
    const sourceTags = await this.readExactObjectTags(
      this.configuration.sourceFileBucketName,
      input.source.objectKey,
      input.source.objectVersionId,
    )
    requireSourceFileMetadata(input.source, sourceHead)
    requireMalwareTag(sourceTags)

    const currentVersions = await this.listScratchObjectVersionIds(input.source)
    const existingCandidates = currentVersions.filter(
      (versionId) => !baseline.has(versionId),
    )
    if (existingCandidates.length > 0) {
      return createScratchCopyResult(
        this.configuration,
        drillDigest,
        input.source,
        existingCandidates,
      )
    }
    try {
      const copyOutput = await this.s3.copyObject(new CopyObjectCommand({
        Bucket: this.configuration.scratchBucketName,
        Key: input.source.objectKey,
        CopySource: createCopySource(
          this.configuration.sourceFileBucketName,
          input.source.objectKey,
          input.source.objectVersionId,
        ),
        ExpectedBucketOwner: this.configuration.accountId,
        ExpectedSourceBucketOwner: this.configuration.accountId,
        MetadataDirective: 'COPY',
        TaggingDirective: 'COPY',
        ...(sourceHead.WebsiteRedirectLocation
          ? { WebsiteRedirectLocation: sourceHead.WebsiteRedirectLocation }
          : {}),
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.configuration.scratchKmsKeyArn,
      }))
      const returnedVersionId = copyOutput.VersionId
      if (
        copyOutput.CopySourceVersionId !== input.source.objectVersionId ||
        typeof returnedVersionId !== 'string' ||
        returnedVersionId.length === 0 ||
        copyOutput.ServerSideEncryption !== 'aws:kms' ||
        copyOutput.SSEKMSKeyId !== this.configuration.scratchKmsKeyArn ||
        baseline.has(returnedVersionId)
      ) {
        throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
      }
    } catch {
      // Reconcile exclusively from the durable pre-copy baseline below. A lost or
      // malformed response must not hide any VersionId created by an SDK retry.
    }
    const versionsAfterCopy = await this.listScratchObjectVersionIds(input.source)
    const candidates = versionsAfterCopy.filter(
      (versionId) => !baseline.has(versionId),
    )
    return createScratchCopyResult(
      this.configuration,
      drillDigest,
      input.source,
      candidates,
    )
  }

  /** Re-lists the exact post-baseline scratch VersionId delta without CopyObject. */
  async reconcileCreatedFileVersions(
    input: RestoreDrillCopyFileVersionInput,
  ): Promise<readonly RestoreDrillCreatedScratchObjectVersion[]> {
    const drillDigest = createDrillDigest(input.drillId)
    requireSourceFileVersion(input.source)
    const baseline = readVersionIdBaseline(input.preexistingScratchVersionIds)
    const currentVersions = await this.listScratchObjectVersionIds(input.source)
    return createScratchCopyIdentities(
      this.configuration,
      drillDigest,
      input.source,
      currentVersions.filter((versionId) => !baseline.has(versionId)),
    )
  }

  /** Advances one exact bounded range of an already durable File copy. */
  async verifyCreatedFileVersion(
    input: RestoreDrillVerifyCreatedFileVersionInput,
  ): Promise<RestoreDrillVerifyCreatedFileVersionResult> {
    requireSourceFileVersion(input.source)
    requireCreatedScratchObjectVersion(input.copy, this.configuration)
    if (input.digestKey.byteLength !== 32) {
      throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
    }
    if (
      input.copy.drillDigest !== createDrillDigest(input.drillId) ||
      input.copy.objectKey !== input.source.objectKey ||
      input.copy.versionId !== input.source.versionId
    ) {
      throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
    }
    const rangeBinding = createFileRangeBinding(input, this.configuration)
    let rangeCheckpoint: RestoreDrillFileRangeCheckpoint
    let rangeWindow: RestoreDrillFileRangeWindow
    try {
      rangeCheckpoint = input.checkpoint === undefined
        ? createRestoreDrillFileRangeCheckpoint(rangeBinding, input.digestKey)
        : input.checkpoint
      rangeWindow = selectRestoreDrillFileRangeWindow(
        rangeBinding,
        rangeCheckpoint,
        input.digestKey,
      )
    } catch (error: unknown) {
      throw mapFileRangeFailure(error)
    }
    const sourceHead = await this.headExactObject(
      this.configuration.sourceFileBucketName,
      input.source.objectKey,
      input.source.objectVersionId,
    )
    const sourceTags = await this.readExactObjectTags(
      this.configuration.sourceFileBucketName,
      input.source.objectKey,
      input.source.objectVersionId,
    )
    requireSourceFileMetadata(input.source, sourceHead)
    requireMalwareTag(sourceTags)
    const destinationHead = await this.headExactObject(
      input.copy.bucketName,
      input.copy.objectKey,
      input.copy.objectVersionId,
    )
    const destinationTags = await this.readExactObjectTags(
      input.copy.bucketName,
      input.copy.objectKey,
      input.copy.objectVersionId,
    )
    if (
      destinationHead.ServerSideEncryption !== 'aws:kms' ||
      destinationHead.SSEKMSKeyId !== this.configuration.scratchKmsKeyArn
    ) {
      throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
    }
    requireMatchingObjectMetadata(sourceHead, destinationHead)
    requireMatchingObjectTags(sourceTags, destinationTags)
    const [sourceRangeSha256, destinationRangeSha256] = await Promise.all([
      this.streamExactObjectRangeSha256(
        this.configuration.sourceFileBucketName,
        input.source.objectKey,
        input.source.objectVersionId,
        input.source.sizeBytes,
        rangeWindow,
      ),
      this.streamExactObjectRangeSha256(
        input.copy.bucketName,
        input.copy.objectKey,
        input.copy.objectVersionId,
        input.source.sizeBytes,
        rangeWindow,
      ),
    ])
    let advancedRange: ReturnType<typeof advanceRestoreDrillFileRangeCheckpoint>
    try {
      advancedRange = advanceRestoreDrillFileRangeCheckpoint({
        binding: rangeBinding,
        checkpoint: rangeCheckpoint,
        destinationRangeSha256,
        digestKey: input.digestKey,
        sourceRangeSha256,
        window: rangeWindow,
      })
    } catch (error: unknown) {
      throw mapFileRangeFailure(error)
    }
    if (!advancedRange.complete) {
      return { checkpoint: advancedRange.checkpoint, status: 'pending' }
    }
    const sourceProof = createFileVersionProof(
      input.digestKey,
      'source',
      input.source,
      this.configuration.sourceFileBucketName,
      input.source.objectVersionId,
      advancedRange.checkpoint.chainDigest,
      sourceHead,
      sourceTags,
    )
    const destinationProof = createFileVersionProof(
      input.digestKey,
      'destination',
      input.source,
      input.copy.bucketName,
      input.copy.objectVersionId,
      advancedRange.checkpoint.chainDigest,
      destinationHead,
      destinationTags,
    )
    return {
      status: 'completed',
      version: {
        ...input.copy,
        destinationProof,
        sourceProof,
      },
    }
  }

  /** CAS-remaps one isolated File row after its exact copy intent is durable. */
  async commitFileRemap(
    input: RestoreDrillCommitFileRemapInput,
  ): Promise<RestoreDrillFileRemapResult> {
    requireRecordedRestoreTable(input.table, this.configuration)
    if (input.table.target !== 'table:file-proofing') {
      throw new RestoreDrillAwsFailure('RESTORE_IDENTITY_MISMATCH')
    }
    const remappedItem = createRemappedFileItem(input, this.configuration)
    const originalVersions = input.row.originalItem.versions
    if (originalVersions === undefined) {
      throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
    }
    const remappedVersions = remappedItem.versions
    if (remappedVersions === undefined) {
      throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
    }
    try {
      const output = await this.dynamodb.updateItem(new UpdateItemCommand({
        TableName: input.table.tableName,
        Key: cloneAttributeMap(input.row.rowKey, 'FILE_ROW_INVALID'),
        UpdateExpression: 'SET #versions = :remappedVersions',
        ConditionExpression:
          '#revision = :expectedRevision AND #versions = :expectedVersions',
        ExpressionAttributeNames: {
          '#revision': 'revision',
          '#versions': 'versions',
        },
        ExpressionAttributeValues: {
          ':expectedRevision': { N: String(input.row.revision) },
          ':expectedVersions': originalVersions,
          ':remappedVersions': remappedVersions,
        },
        ReturnValues: 'ALL_NEW',
      }))
      requireExactRemappedFileState(
        output.Attributes,
        input.row.revision,
        remappedVersions,
      )
      return { status: 'committed' }
    } catch {
      let output: GetItemCommandOutput
      try {
        output = await this.dynamodb.getItem(new GetItemCommand({
          TableName: input.table.tableName,
          Key: cloneAttributeMap(input.row.rowKey, 'FILE_ROW_INVALID'),
          ConsistentRead: true,
        }))
      } catch {
        throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
      }
      requireExactRemappedFileState(output.Item, input.row.revision, remappedVersions)
      return { status: 'adopted' }
    }
  }

  /** Deletes an exact restore table only after immutable identity reconciliation. */
  async deleteRecordedRestoreTable(
    table: RestoreDrillRecordedRestoreTable,
    drillId: string,
  ): Promise<RestoreDrillTableCleanupResult> {
    requireCleanupRestoreTable(table, drillId, this.configuration)
    requireRecordedRestoreTable(table, this.configuration)
    let output: DescribeTableCommandOutput
    try {
      output = await this.dynamodb.describeTable(new DescribeTableCommand({
        TableName: table.tableName,
      }))
    } catch (error) {
      if (isAwsErrorNamed(error, 'ResourceNotFoundException')) return { status: 'completed' }
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    requireExactRestoreIdentity(output, table)
    if (output.Table?.TableStatus === 'DELETING') return { status: 'pending' }
    try {
      await this.dynamodb.deleteTable(new DeleteTableCommand({
        TableName: table.tableName,
      }))
    } catch (error) {
      if (isAwsErrorNamed(error, 'ResourceNotFoundException')) return { status: 'completed' }
      let reconciled: DescribeTableCommandOutput
      try {
        reconciled = await this.dynamodb.describeTable(new DescribeTableCommand({
          TableName: table.tableName,
        }))
      } catch (reconciliationError) {
        if (isAwsErrorNamed(reconciliationError, 'ResourceNotFoundException')) {
          return { status: 'completed' }
        }
        throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
      }
      requireExactRestoreIdentity(reconciled, table)
      if (reconciled.Table?.TableStatus === 'DELETING') return { status: 'pending' }
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    return { status: 'pending' }
  }

  /** Deletes one exact recorded scratch version and reconciles its absence. */
  async deleteRecordedScratchObjectVersion(
    version: RestoreDrillCreatedScratchObjectVersion,
    drillId: string,
  ): Promise<void> {
    requireCleanupScratchObjectVersion(version, drillId)
    requireCreatedScratchObjectVersion(version, this.configuration)
    try {
      await this.s3.deleteObject(new DeleteObjectCommand({
        Bucket: version.bucketName,
        Key: version.objectKey,
        VersionId: version.objectVersionId,
        ExpectedBucketOwner: this.configuration.accountId,
      }))
    } catch {
      // DeleteObject has an ambiguous result; the exact-version attributes read below is authoritative.
    }
    try {
      await this.s3.getObjectAttributes(new GetObjectAttributesCommand({
        Bucket: version.bucketName,
        Key: version.objectKey,
        VersionId: version.objectVersionId,
        ExpectedBucketOwner: this.configuration.accountId,
        ObjectAttributes: ['ObjectSize'],
      }))
    } catch (error) {
      if (isMissingS3Object(error)) return
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }

  /** Deletes one exact export-created scratch version and reconciles absence. */
  async deleteRecordedExportObjectVersion(
    version: RestoreDrillRecordedExportObjectVersion,
    drillId: string,
  ): Promise<void> {
    requireCleanupExportObjectVersion(version, drillId)
    requireRecordedExportObjectVersion(version, this.configuration)
    try {
      await this.s3.deleteObject(new DeleteObjectCommand({
        Bucket: version.bucketName,
        Key: version.objectKey,
        VersionId: version.objectVersionId,
        ExpectedBucketOwner: this.configuration.accountId,
      }))
    } catch {
      // DeleteObject has an ambiguous result; the exact-version attributes read below is authoritative.
    }
    try {
      await this.s3.getObjectAttributes(new GetObjectAttributesCommand({
        Bucket: version.bucketName,
        Key: version.objectKey,
        VersionId: version.objectVersionId,
        ExpectedBucketOwner: this.configuration.accountId,
        ObjectAttributes: ['ObjectSize'],
      }))
    } catch (error) {
      if (isMissingS3Object(error)) return
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }

  /** Aborts one exact recorded multipart upload and proves exact UploadId absence. */
  async abortRecordedMultipartUpload(
    upload: RestoreDrillRecordedMultipartUpload,
    drillId: string,
  ): Promise<RestoreDrillMultipartUploadCleanupResult> {
    requireCleanupMultipartUpload(upload, drillId)
    requireRecordedMultipartUpload(upload, this.configuration)
    try {
      await this.s3.abortMultipartUpload(new AbortMultipartUploadCommand({
        Bucket: upload.bucketName,
        Key: upload.objectKey,
        UploadId: upload.uploadId,
        ExpectedBucketOwner: this.configuration.accountId,
      }))
    } catch (error) {
      if (isAwsErrorNamed(error, 'NoSuchUpload')) return { status: 'absent' }
    }
    try {
      await this.s3.listParts(new ListPartsCommand({
        Bucket: upload.bucketName,
        Key: upload.objectKey,
        UploadId: upload.uploadId,
        MaxParts: 1,
        ExpectedBucketOwner: this.configuration.accountId,
      }))
    } catch (error) {
      if (isAwsErrorNamed(error, 'NoSuchUpload')) return { status: 'absent' }
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    return { status: 'pending' }
  }

  /** Lists all exact scratch VersionIds for one canonical File object key. */
  async listScratchObjectVersionIds(
    source: RestoreDrillSourceFileVersion,
  ): Promise<readonly string[]> {
    requireSourceFileVersion(source)
    const versionIds = new Set<string>()
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined
    for (let page = 0; page < 10; page += 1) {
      let output: ListObjectVersionsCommandOutput
      try {
        output = await this.s3.listObjectVersions(new ListObjectVersionsCommand({
          Bucket: this.configuration.scratchBucketName,
          Prefix: source.objectKey,
          MaxKeys: 1_000,
          ExpectedBucketOwner: this.configuration.accountId,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
        }))
      } catch {
        throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
      }
      for (const version of output.Versions ?? []) {
        if (version.Key !== source.objectKey) continue
        if (
          typeof version.VersionId !== 'string' ||
          version.VersionId.length === 0 ||
          versionIds.has(version.VersionId)
        ) {
          throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
        }
        versionIds.add(version.VersionId)
      }
      if (output.IsTruncated !== true) {
        return [...versionIds].sort(compareUtf8Ordinal)
      }
      if (
        typeof output.NextKeyMarker !== 'string' ||
        output.NextKeyMarker.length === 0 ||
        typeof output.NextVersionIdMarker !== 'string' ||
        output.NextVersionIdMarker.length === 0
      ) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      keyMarker = output.NextKeyMarker
      versionIdMarker = output.NextVersionIdMarker
    }
    throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
  }

  /** Lists every exact immutable version below one recorded export prefix. */
  async listRecordedExportObjectVersions(
    exportRecord: RestoreDrillRecordedExport,
  ): Promise<readonly RestoreDrillRecordedExportObjectVersion[]> {
    const versions: RestoreDrillRecordedExportObjectVersion[] = []
    const identities = new Set<string>()
    let cursor: RestoreDrillExportObjectVersionCursor | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = await this.listRecordedExportObjectVersionPage(exportRecord, cursor)
      for (const version of result.versions) {
        const identity = `${version.objectKey}\u0000${version.objectVersionId}`
        if (identities.has(identity) || versions.length >= 10_000) {
          throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
        }
        identities.add(identity)
        versions.push(version)
      }
      if (!result.nextCursor) return versions
      cursor = result.nextCursor
    }
    throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
  }

  /** Lists one bounded resumable page of export-created scratch versions. */
  async listRecordedExportObjectVersionPage(
    exportRecord: RestoreDrillRecordedExport,
    cursor?: RestoreDrillExportObjectVersionCursor,
  ): Promise<RestoreDrillExportObjectVersionPage> {
    requireRecordedExport(exportRecord, this.configuration)
    requireExportObjectVersionCursor(cursor)
    const exportArnDigest = createHexDigest(`export-arn\u0000${exportRecord.exportArn}`)
    const prefix = `${exportRecord.scratchPrefix}/`
    if (
      cursor &&
      (
        !cursor.keyMarker.startsWith(prefix) ||
        !isSafeS3ObjectKey(cursor.keyMarker)
      )
    ) {
      throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
    }
    let output: ListObjectVersionsCommandOutput
    try {
      output = await this.s3.listObjectVersions(new ListObjectVersionsCommand({
        Bucket: this.configuration.scratchBucketName,
        Prefix: prefix,
        MaxKeys: 1_000,
        ExpectedBucketOwner: this.configuration.accountId,
        ...(cursor
          ? { KeyMarker: cursor.keyMarker, VersionIdMarker: cursor.versionIdMarker }
          : {}),
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    if ((output.DeleteMarkers?.length ?? 0) > 0 || (output.Versions?.length ?? 0) > 1_000) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    const versions: RestoreDrillRecordedExportObjectVersion[] = []
    const identities = new Set<string>()
    for (const version of output.Versions ?? []) {
      if (
        typeof version.Key !== 'string' ||
        !version.Key.startsWith(prefix) ||
        !isSafeS3ObjectKey(version.Key) ||
        typeof version.VersionId !== 'string' ||
        version.VersionId.length === 0
      ) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      const identity = `${version.Key}\u0000${version.VersionId}`
      if (identities.has(identity)) throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      identities.add(identity)
      versions.push({
        kind: 'export-object-version',
        bucketName: this.configuration.scratchBucketName,
        scratchPrefix: exportRecord.scratchPrefix,
        exportArnDigest,
        objectKey: version.Key,
        objectVersionId: version.VersionId,
      })
    }
    if (output.IsTruncated !== true) return { versions }
    if (
      typeof output.NextKeyMarker !== 'string' ||
      output.NextKeyMarker.length === 0 ||
      !output.NextKeyMarker.startsWith(prefix) ||
      !isSafeS3ObjectKey(output.NextKeyMarker) ||
      typeof output.NextVersionIdMarker !== 'string' ||
      output.NextVersionIdMarker.length === 0 ||
      (
        cursor !== undefined &&
        output.NextKeyMarker === cursor.keyMarker &&
        output.NextVersionIdMarker === cursor.versionIdMarker
      )
    ) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    return {
      versions,
      nextCursor: {
        keyMarker: output.NextKeyMarker,
        versionIdMarker: output.NextVersionIdMarker,
      },
    }
  }

  /** Lists one bounded resumable page of incomplete uploads under one drill prefix. */
  async listRecordedMultipartUploadPage(
    prefix: string,
    cursor?: RestoreDrillMultipartUploadCursor,
  ): Promise<RestoreDrillMultipartUploadPage> {
    requireMultipartUploadPrefix(prefix)
    requireMultipartUploadCursor(prefix, cursor)
    let output: ListMultipartUploadsCommandOutput
    try {
      output = await this.s3.listMultipartUploads(new ListMultipartUploadsCommand({
        Bucket: this.configuration.scratchBucketName,
        Prefix: prefix,
        MaxUploads: 1_000,
        ExpectedBucketOwner: this.configuration.accountId,
        ...(cursor
          ? {
              KeyMarker: cursor.keyMarker,
              UploadIdMarker: cursor.uploadIdMarker,
            }
          : {}),
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    if (
      (output.Uploads?.length ?? 0) > 1_000 ||
      (output.CommonPrefixes?.length ?? 0) > 0
    ) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    const uploads: RestoreDrillRecordedMultipartUpload[] = []
    const identities = new Set<string>()
    for (const upload of output.Uploads ?? []) {
      if (
        typeof upload.Key !== 'string' ||
        !upload.Key.startsWith(prefix) ||
        !isSafeS3ObjectKey(upload.Key) ||
        typeof upload.UploadId !== 'string' ||
        upload.UploadId.length === 0 ||
        upload.UploadId.length > 1_024
      ) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      const identity = `${upload.Key}\u0000${upload.UploadId}`
      if (identities.has(identity)) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      identities.add(identity)
      uploads.push({
        bucketName: this.configuration.scratchBucketName,
        kind: 'scratch-multipart-upload',
        objectKey: upload.Key,
        uploadId: upload.UploadId,
      })
    }
    if (output.IsTruncated !== true) return { uploads }
    if (
      typeof output.NextKeyMarker !== 'string' ||
      !output.NextKeyMarker.startsWith(prefix) ||
      !isSafeS3ObjectKey(output.NextKeyMarker) ||
      typeof output.NextUploadIdMarker !== 'string' ||
      output.NextUploadIdMarker.length === 0 ||
      output.NextUploadIdMarker.length > 1_024 ||
      (
        cursor !== undefined &&
        output.NextKeyMarker === cursor.keyMarker &&
        output.NextUploadIdMarker === cursor.uploadIdMarker
      )
    ) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    return {
      uploads,
      nextCursor: {
        keyMarker: output.NextKeyMarker,
        uploadIdMarker: output.NextUploadIdMarker,
      },
    }
  }

  /** Polls one exact export and returns stable state only. */
  async pollTableExport(
    exportRecord: RestoreDrillRecordedExport,
  ): Promise<RestoreDrillExportPollResult> {
    requireRecordedExport(exportRecord, this.configuration)
    let output: DescribeExportCommandOutput
    try {
      output = await this.dynamodb.describeExport(new DescribeExportCommand({
        ExportArn: exportRecord.exportArn,
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    const description = requireExactExportDescription(
      output.ExportDescription,
      exportRecord,
      this.configuration,
    )
    if (description.ExportStatus === 'FAILED') return { status: 'failed' }
    if (description.ExportStatus === 'IN_PROGRESS') return { status: 'pending' }
    if (description.ExportStatus !== 'COMPLETED') {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    if (
      typeof description.ExportManifest !== 'string' ||
      description.ExportManifest.length === 0 ||
      !Number.isSafeInteger(description.ItemCount) ||
      description.ItemCount === undefined ||
      description.ItemCount < 0
    ) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    return {
      status: 'completed',
      manifestKey: normalizeFullExportObjectKey(
        description.ExportManifest,
        exportRecord,
        'manifest-summary',
      ),
      itemCount: description.ItemCount,
    }
  }

  /** Polls one exact restore and emits its canonical descriptor at ACTIVE. */
  async pollTableRestore(
    table: RestoreDrillRecordedRestoreTable,
  ): Promise<RestoreDrillRestorePollResult> {
    requireRecordedRestoreTable(table, this.configuration)
    let output: DescribeTableCommandOutput
    try {
      output = await this.dynamodb.describeTable(new DescribeTableCommand({
        TableName: table.tableName,
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    requireExactRestoreIdentity(output, table)
    if (output.Table?.TableStatus === 'CREATING') return { status: 'pending' }
    if (output.Table?.TableStatus !== 'ACTIVE') {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    const ttl = await this.readTimeToLive(table.tableName)
    return {
      status: 'completed',
      descriptor: parseTableDescriptor(output, ttl),
    }
  }

  /** Reads one strongly consistent bounded File Proofing restore page. */
  async scanFileProofingPage(
    table: RestoreDrillRecordedRestoreTable,
    exclusiveStartKey?: Readonly<Record<string, AttributeValue>>,
  ): Promise<RestoreDrillFileScanPage> {
    requireRecordedRestoreTable(table, this.configuration)
    if (table.target !== 'table:file-proofing') {
      throw new RestoreDrillAwsFailure('RESTORE_IDENTITY_MISMATCH')
    }
    const startKey = exclusiveStartKey === undefined
      ? undefined
      : cloneAttributeMap(exclusiveStartKey, 'CHECKPOINT_INVALID')
    let output: ScanCommandOutput
    try {
      output = await this.dynamodb.scan(new ScanCommand({
        TableName: table.tableName,
        ConsistentRead: true,
        Limit: 1,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    const items = output.Items ?? []
    if (items.length > 1 || output.Count !== items.length || output.ScannedCount !== items.length) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    const nextKey = output.LastEvaluatedKey === undefined
      ? undefined
      : cloneAttributeMap(output.LastEvaluatedKey, 'CHECKPOINT_INVALID')
    const item = items[0]
    if (!item) return nextKey ? { nextKey } : {}
    const native = decodeAttributeMap(item)
    const entryType = native.entryType
    if (typeof entryType !== 'string') {
      throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
    }
    if (FILE_PROOFING_AUXILIARY_ENTRY_TYPES.has(entryType)) {
      return nextKey ? { nextKey } : {}
    }
    if (entryType !== 'file') {
      throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
    }
    const row = createFileRowWork(item, native)
    return nextKey ? { row, nextKey } : { row }
  }

  /** Adds one bounded strongly consistent isolated restore page to a keyed accumulator. */
  async scanRestoreAggregatePage(
    input: RestoreDrillScanAggregatePageInput,
  ): Promise<RestoreDrillScanAggregatePageResult> {
    requireRecordedRestoreTable(input.table, this.configuration)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
    }
    const startKey = input.exclusiveStartKey === undefined
      ? undefined
      : cloneAttributeMap(input.exclusiveStartKey, 'CHECKPOINT_INVALID')
    let output: ScanCommandOutput
    try {
      output = await this.dynamodb.scan(new ScanCommand({
        TableName: input.table.tableName,
        ConsistentRead: true,
        Limit: input.limit,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    const items = output.Items ?? []
    if (
      items.length > input.limit ||
      output.Count !== items.length ||
      output.ScannedCount !== items.length
    ) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    for (const item of items) input.accumulator.add(item)
    const nextKey = output.LastEvaluatedKey === undefined
      ? undefined
      : cloneAttributeMap(output.LastEvaluatedKey, 'CHECKPOINT_INVALID')
    if (
      startKey !== undefined &&
      nextKey !== undefined &&
      serializeAttributeMap(startKey) === serializeAttributeMap(nextKey)
    ) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    return nextKey ? { itemCount: items.length, nextKey } : { itemCount: items.length }
  }

  /** Starts an idempotent exact point-in-time export into scratch storage. */
  async startTableExport(
    input: RestoreDrillStartExportInput,
  ): Promise<RestoreDrillRecordedExport> {
    validateSourceObservation(input.source, this.configuration)
    const exportPoint = readCanonicalTimestamp(input.exportPoint)
    const drillDigest = createDrillDigest(input.drillId)
    const clientToken = createHexDigest(
      `export\u0000${input.drillId}\u0000${input.source.target}\u0000${exportPoint}`,
    )
    const scratchPrefix = `restore-drill/${drillDigest}/${input.source.target}/export`
    let output: ExportTableToPointInTimeCommandOutput
    try {
      output = await this.dynamodb.exportTableToPointInTime(
        new ExportTableToPointInTimeCommand({
          TableArn: input.source.sourceTableArn,
          ExportTime: new Date(exportPoint),
          ClientToken: clientToken,
          S3Bucket: this.configuration.scratchBucketName,
          S3BucketOwner: this.configuration.accountId,
          S3Prefix: scratchPrefix,
          S3SseAlgorithm: 'KMS',
          S3SseKmsKeyId: this.configuration.scratchKmsKeyArn,
          ExportFormat: 'DYNAMODB_JSON',
          ExportType: 'FULL_EXPORT',
        }),
      )
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    const exportArn = output.ExportDescription?.ExportArn
    if (typeof exportArn !== 'string' || exportArn.length === 0) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    const record: RestoreDrillRecordedExport = {
      kind: 'table-export',
      target: input.source.target,
      sourceTableArn: input.source.sourceTableArn,
      sourceTableId: input.source.descriptor.tableId,
      exportPoint,
      clientToken,
      scratchPrefix,
      exportArn,
    }
    requireExactExportDescription(output.ExportDescription, record, this.configuration)
    return record
  }

  /** Starts a deterministic restore or adopts only an exact matching ambiguous success. */
  async startTableRestore(
    input: RestoreDrillStartRestoreInput,
  ): Promise<RestoreDrillStartRestoreResult> {
    validateSourceObservation(input.source, this.configuration)
    const restorePoint = readCanonicalTimestamp(input.restorePoint)
    const tableName = createRestoreTableName(
      this.configuration.restoreTablePrefix,
      input.drillId,
      input.source.target,
    )
    try {
      const output = await this.dynamodb.restoreTableToPointInTime(
        new RestoreTableToPointInTimeCommand({
          SourceTableArn: input.source.sourceTableArn,
          TargetTableName: tableName,
          RestoreDateTime: new Date(restorePoint),
        }),
      )
      return {
        adopted: false,
        table: parseStartedRestore(
          output,
          input.source.target,
          input.source.sourceTableArn,
          restorePoint,
          tableName,
        ),
      }
    } catch {
      return {
        adopted: true,
        table: await this.adoptExactRestore(
          input.source.target,
          input.source.sourceTableArn,
          restorePoint,
          tableName,
        ),
      }
    }
  }

  /** Decrypts, supplies, and zeroizes one exact drill-bound digest key. */
  async withDigestKey<Result>(
    drillId: string,
    envelope: RestoreDrillDigestKeyEnvelope,
    consumer: RestoreDrillDigestKeyConsumer<Result>,
  ): Promise<Result> {
    createDrillDigest(drillId)
    requireDigestKeyEnvelope(envelope, this.configuration.evidenceKmsKeyArn)
    const kms = this.requireKms()
    let output: DecryptCommandOutput
    try {
      output = await kms.decrypt(new DecryptCommand({
        CiphertextBlob: Buffer.from(envelope.ciphertextBase64, 'base64'),
        KeyId: this.configuration.evidenceKmsKeyArn,
        EncryptionContext: createDigestKeyEncryptionContext(drillId),
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    if (
      !(output.Plaintext instanceof Uint8Array) ||
      output.Plaintext.length !== 32 ||
      output.KeyId !== this.configuration.evidenceKmsKeyArn ||
      output.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT'
    ) {
      output.Plaintext?.fill(0)
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    const plaintext = output.Plaintext
    try {
      return await consumer(plaintext)
    } finally {
      plaintext.fill(0)
    }
  }

  /** Collects one allowlisted source table observation. */
  private async collectSourceTableObservation(
    target: RestoreDrillAwsTableTarget,
  ): Promise<RestoreDrillSourceTableObservation> {
    const tableName = this.configuration.sourceTables[target]
    let backups: DescribeContinuousBackupsCommandOutput
    let table: DescribeTableCommandOutput
    let ttl: DescribeTimeToLiveCommandOutput
    try {
      ;[backups, table, ttl] = await Promise.all([
        this.dynamodb.describeContinuousBackups(new DescribeContinuousBackupsCommand({
          TableName: tableName,
        })),
        this.dynamodb.describeTable(new DescribeTableCommand({ TableName: tableName })),
        this.dynamodb.describeTimeToLive(new DescribeTimeToLiveCommand({ TableName: tableName })),
      ])
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    const pitr = backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
    const sourceTableArn = table.Table?.TableArn
    if (
      pitr?.PointInTimeRecoveryStatus !== 'ENABLED' ||
      !(pitr.EarliestRestorableDateTime instanceof Date) ||
      !(pitr.LatestRestorableDateTime instanceof Date) ||
      !Number.isFinite(pitr.EarliestRestorableDateTime.getTime()) ||
      !Number.isFinite(pitr.LatestRestorableDateTime.getTime()) ||
      pitr.EarliestRestorableDateTime.getTime() > pitr.LatestRestorableDateTime.getTime() ||
      typeof sourceTableArn !== 'string' ||
      sourceTableArn.length === 0
    ) {
      throw new RestoreDrillAwsFailure('SOURCE_PITR_INVALID')
    }
    const parsedArn = parseDynamoDbTableArn(sourceTableArn)
    if (
      parsedArn.accountId !== this.configuration.accountId ||
      parsedArn.region !== this.configuration.region ||
      parsedArn.tableName !== tableName ||
      table.Table?.TableName !== tableName
    ) {
      throw new RestoreDrillAwsFailure('SOURCE_PITR_INVALID')
    }
    return {
      target,
      sourceTableArn,
      earliestRestorableAt: pitr.EarliestRestorableDateTime.toISOString(),
      latestRestorableAt: pitr.LatestRestorableDateTime.toISOString(),
      descriptor: parseTableDescriptor(table, ttl),
    }
  }

  /** Reads one table TTL response through a raw-error replacement boundary. */
  private async readTimeToLive(tableName: string): Promise<DescribeTimeToLiveCommandOutput> {
    try {
      return await this.dynamodb.describeTimeToLive(
        new DescribeTimeToLiveCommand({ TableName: tableName }),
      )
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
  }

  /** Reconciles an ambiguous restore call against exact immutable restore summary fields. */
  private async adoptExactRestore(
    target: RestoreDrillAwsTableTarget,
    sourceTableArn: string,
    restorePoint: string,
    tableName: string,
  ): Promise<RestoreDrillRecordedRestoreTable> {
    let output: DescribeTableCommandOutput
    try {
      output = await this.dynamodb.describeTable(new DescribeTableCommand({
        TableName: tableName,
      }))
    } catch {
      throw new RestoreDrillAwsFailure('RESTORE_START_FAILED')
    }
    return parseAdoptedRestore(output, target, sourceTableArn, restorePoint, tableName)
  }

  /** Reads exact-version object headers through the stable failure boundary. */
  private async headExactObject(
    bucketName: string,
    objectKey: string,
    objectVersionId: string,
  ): Promise<HeadObjectCommandOutput> {
    let output: HeadObjectCommandOutput
    try {
      output = await this.s3.headObject(new HeadObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        VersionId: objectVersionId,
        ExpectedBucketOwner: this.configuration.accountId,
        ChecksumMode: 'ENABLED',
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    if (output.VersionId !== objectVersionId) {
      throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
    }
    return output
  }

  /** Reads exact-version object tags through the stable failure boundary. */
  private async readExactObjectTags(
    bucketName: string,
    objectKey: string,
    objectVersionId: string,
  ): Promise<GetObjectTaggingCommandOutput> {
    let output: GetObjectTaggingCommandOutput
    try {
      output = await this.s3.getObjectTagging(new GetObjectTaggingCommand({
        Bucket: bucketName,
        Key: objectKey,
        VersionId: objectVersionId,
        ExpectedBucketOwner: this.configuration.accountId,
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    if (output.VersionId !== objectVersionId || !Array.isArray(output.TagSet)) {
      throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
    }
    return output
  }

  /** Streams and hashes one exact inclusive object-version byte range. */
  private async streamExactObjectRangeSha256(
    bucketName: string,
    objectKey: string,
    objectVersionId: string,
    totalBytes: number,
    window: RestoreDrillFileRangeWindow,
  ): Promise<string> {
    let output: RestoreDrillGetObjectOutput
    try {
      output = await this.s3.getObject(new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        VersionId: objectVersionId,
        ExpectedBucketOwner: this.configuration.accountId,
        ChecksumMode: 'ENABLED',
        Range: window.rangeHeader,
      }))
    } catch {
      throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
    }
    if (
      output.VersionId !== objectVersionId ||
      output.ContentLength !== window.length ||
      output.ContentRange !== `bytes ${window.start}-${window.end}/${totalBytes}` ||
      !isAsyncByteStream(output.Body)
    ) {
      throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
    }
    return hashByteStream(output.Body, window.length)
  }

  /** Returns the configured KMS transport or fails before plaintext is created. */
  private requireKms(): RestoreDrillKmsTransport {
    if (!this.kms) throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
    return this.kms
  }
}

/** Official AWS SDK v3 transport shared by concrete DynamoDB and S3 operations. */
class OfficialRestoreDrillAwsTransport implements
  RestoreDrillDynamoDbTransport,
  RestoreDrillKmsTransport,
  RestoreDrillS3Transport {
  /** Concrete DynamoDB SDK client. */
  private readonly dynamodbClient: DynamoDBClient

  /** Concrete KMS SDK client. */
  private readonly kmsClient: KMSClient

  /** Concrete S3 SDK client. */
  private readonly s3Client: S3Client

  /**
   * Creates a narrow transport over concrete official SDK clients.
   *
   * @param dynamodbClient - Concrete DynamoDB client.
   * @param kmsClient - Concrete KMS client.
   * @param s3Client - Concrete S3 client.
   */
  constructor(
    dynamodbClient: DynamoDBClient,
    kmsClient: KMSClient,
    s3Client: S3Client,
  ) {
    this.dynamodbClient = dynamodbClient
    this.kmsClient = kmsClient
    this.s3Client = s3Client
  }

  /** Sends one exact S3 AbortMultipartUpload command. */
  abortMultipartUpload(
    command: AbortMultipartUploadCommand,
  ): Promise<AbortMultipartUploadCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact KMS Decrypt command. */
  decrypt(command: DecryptCommand): Promise<DecryptCommandOutput> {
    return this.kmsClient.send(command)
  }

  /** Sends one exact S3 CopyObject command. */
  copyObject(command: CopyObjectCommand): Promise<CopyObjectCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact S3 DeleteObject command. */
  deleteObject(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact DynamoDB DeleteTable command. */
  deleteTable(command: DeleteTableCommand): Promise<DeleteTableCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact DynamoDB DescribeContinuousBackups command. */
  describeContinuousBackups(
    command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact DynamoDB DescribeExport command. */
  describeExport(command: DescribeExportCommand): Promise<DescribeExportCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact DynamoDB DescribeTable command. */
  describeTable(command: DescribeTableCommand): Promise<DescribeTableCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact DynamoDB DescribeTimeToLive command. */
  describeTimeToLive(
    command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact DynamoDB ExportTableToPointInTime command. */
  exportTableToPointInTime(
    command: ExportTableToPointInTimeCommand,
  ): Promise<ExportTableToPointInTimeCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact KMS Encrypt command. */
  encrypt(command: EncryptCommand): Promise<EncryptCommandOutput> {
    return this.kmsClient.send(command)
  }

  /** Sends one exact S3 GetObject command. */
  getObject(command: GetObjectCommand): Promise<RestoreDrillGetObjectOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact S3 GetObjectAttributes command. */
  getObjectAttributes(
    command: GetObjectAttributesCommand,
  ): Promise<GetObjectAttributesCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact S3 GetObjectTagging command. */
  getObjectTagging(
    command: GetObjectTaggingCommand,
  ): Promise<GetObjectTaggingCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact S3 HeadObject command. */
  headObject(command: HeadObjectCommand): Promise<HeadObjectCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact S3 ListMultipartUploads command. */
  listMultipartUploads(
    command: ListMultipartUploadsCommand,
  ): Promise<ListMultipartUploadsCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact S3 ListObjectVersions command. */
  listObjectVersions(
    command: ListObjectVersionsCommand,
  ): Promise<ListObjectVersionsCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact S3 ListParts command. */
  listParts(command: ListPartsCommand): Promise<ListPartsCommandOutput> {
    return this.s3Client.send(command)
  }

  /** Sends one exact DynamoDB RestoreTableToPointInTime command. */
  restoreTableToPointInTime(
    command: RestoreTableToPointInTimeCommand,
  ): Promise<RestoreTableToPointInTimeCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact DynamoDB Scan command. */
  scan(command: ScanCommand): Promise<ScanCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact strongly consistent DynamoDB GetItem command. */
  getItem(command: GetItemCommand): Promise<GetItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Sends one exact conditional DynamoDB UpdateItem command. */
  updateItem(command: UpdateItemCommand): Promise<UpdateItemCommandOutput> {
    return this.dynamodbClient.send(command)
  }

  /** Releases both concrete AWS SDK clients. */
  close(): void {
    this.dynamodbClient.destroy()
    this.kmsClient.destroy()
    this.s3Client.destroy()
  }
}

/**
 * Reads and validates every explicit restore drill environment address.
 *
 * @param environment - Lambda environment map.
 * @returns Complete fixed resource configuration.
 */
export function readRestoreDrillAwsConfiguration(
  environment: RestoreDrillEnvironment,
): RestoreDrillAwsConfiguration {
  const evidenceKmsKeyArn = readEnvironmentValue(environment, 'EVIDENCE_KEY_ARN')
  const accountId = readAccountIdFromArn(evidenceKmsKeyArn)
  const configuration: RestoreDrillAwsConfiguration = {
    accountId,
    region: readEnvironmentValue(environment, 'AWS_REGION'),
    restoreTablePrefix: readEnvironmentValue(
      environment,
      'TARGET_TABLE_PREFIX',
    ),
    stateTableName: readEnvironmentValue(environment, 'STATE_TABLE_NAME'),
    evidenceBucketName: readEnvironmentValue(
      environment,
      'EVIDENCE_BUCKET_NAME',
    ),
    evidenceKmsKeyArn,
    auditPseudonymSecretArn: readEnvironmentValue(
      environment,
      'AUDIT_PSEUDONYM_SECRET_ARN',
    ),
    metricNamespace: readEnvironmentValue(environment, 'METRIC_NAMESPACE'),
    scratchBucketName: readEnvironmentValue(
      environment,
      'SCRATCH_BUCKET_NAME',
    ),
    scratchKmsKeyArn: readEnvironmentValue(
      environment,
      'SCRATCH_KEY_ARN',
    ),
    sourceFileBucketName: readEnvironmentValue(
      environment,
      'FILE_BUCKET_NAME',
    ),
    sourceTables: {
      'table:work-items': readEnvironmentValue(
        environment,
        'WORK_ITEMS_TABLE_NAME',
      ),
      'table:work-item-configuration': readEnvironmentValue(
        environment,
        'WORK_ITEM_CONFIGURATION_TABLE_NAME',
      ),
      'table:project-directory': readEnvironmentValue(
        environment,
        'PROJECT_DIRECTORY_TABLE_NAME',
      ),
      'table:workspace-access': readEnvironmentValue(
        environment,
        'WORKSPACE_ACCESS_TABLE_NAME',
      ),
      'table:audit-events': readEnvironmentValue(
        environment,
        'AUDIT_EVENTS_TABLE_NAME',
      ),
      'table:file-proofing': readEnvironmentValue(
        environment,
        'FILE_PROOFING_TABLE_NAME',
      ),
    },
  }
  validateConfiguration(configuration)
  return configuration
}

/**
 * Reads and validates the cleanup Lambda's intentionally source-free environment.
 *
 * @param environment - Cleanup Lambda environment map.
 * @returns Minimal cleanup configuration.
 */
export function readRestoreDrillAwsCleanupConfiguration(
  environment: RestoreDrillEnvironment,
): RestoreDrillAwsCleanupConfiguration {
  const evidenceKmsKeyArn = readEnvironmentValue(environment, 'EVIDENCE_KEY_ARN')
  const configuration: RestoreDrillAwsCleanupConfiguration = {
    accountId: readAccountIdFromArn(evidenceKmsKeyArn),
    region: readEnvironmentValue(environment, 'AWS_REGION'),
    evidenceBucketName: readEnvironmentValue(environment, 'EVIDENCE_BUCKET_NAME'),
    evidenceKmsKeyArn,
    metricNamespace: readEnvironmentValue(environment, 'METRIC_NAMESPACE'),
    scratchBucketName: readEnvironmentValue(environment, 'SCRATCH_BUCKET_NAME'),
    stateTableName: readEnvironmentValue(environment, 'STATE_TABLE_NAME'),
    restoreTablePrefix: readEnvironmentValue(environment, 'TARGET_TABLE_PREFIX'),
  }
  if (
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(configuration.region) ||
    !isBucketName(configuration.evidenceBucketName) ||
    !isBucketName(configuration.scratchBucketName) ||
    configuration.evidenceBucketName === configuration.scratchBucketName ||
    !isDynamoDbTableName(configuration.stateTableName) ||
    !/^[A-Za-z0-9_.-]{3,80}$/.test(configuration.restoreTablePrefix) ||
    !isKmsArn(
      configuration.evidenceKmsKeyArn,
      configuration.region,
      configuration.accountId,
    ) ||
    !/^[A-Za-z0-9_.\-/]{1,255}$/.test(configuration.metricNamespace)
  ) {
    throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
  }
  return configuration
}

/**
 * Creates inaccessible sentinels for runner-only fields hidden behind the cleanup interface.
 *
 * The cleanup IAM role still contains no production source permissions, and the returned public
 * interface exposes only exact recorded deletions and digest-key decryption.
 *
 * @param cleanup - Validated minimal cleanup configuration.
 * @returns Internal configuration consumed only by shared cleanup method implementations.
 */
function createCleanupRestrictedFullConfiguration(
  cleanup: RestoreDrillAwsCleanupConfiguration,
): RestoreDrillAwsConfiguration {
  return {
    ...cleanup,
    auditPseudonymSecretArn:
      `arn:aws:secretsmanager:${cleanup.region}:${cleanup.accountId}:secret:cleanup-not-authorized`,
    sourceFileBucketName: 'cleanup-source-not-authorized',
    scratchKmsKeyArn: cleanup.evidenceKmsKeyArn,
    sourceTables: {
      'table:audit-events': 'cleanup-audit-events-not-authorized',
      'table:file-proofing': 'cleanup-file-proofing-not-authorized',
      'table:project-directory': 'cleanup-project-directory-not-authorized',
      'table:work-item-configuration': 'cleanup-work-item-configuration-not-authorized',
      'table:work-items': 'cleanup-work-items-not-authorized',
      'table:workspace-access': 'cleanup-workspace-access-not-authorized',
    },
  }
}

/**
 * Reads one mandatory non-empty environment value.
 *
 * @param environment - Environment map.
 * @param name - Exact variable name.
 * @returns Trimmed value.
 */
function readEnvironmentValue(
  environment: RestoreDrillEnvironment,
  name: string,
): string {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
  }
  return value.trim()
}

/**
 * Extracts the expected AWS account from an already explicit resource ARN.
 *
 * @param arn - Candidate AWS ARN.
 * @returns Twelve-digit account identifier.
 */
function readAccountIdFromArn(arn: string): string {
  const parts = arn.split(':')
  const accountId = parts[4]
  if (parts[0] !== 'arn' || parts[1] !== 'aws' || !accountId || !/^\d{12}$/.test(accountId)) {
    throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
  }
  return accountId
}

/**
 * Validates resource allowlists before any AWS request is constructed.
 *
 * @param configuration - Explicit restore drill configuration.
 */
function validateConfiguration(configuration: RestoreDrillAwsConfiguration): void {
  const tableNames = RESTORE_DRILL_AWS_TABLE_TARGETS.map(
    (target) => configuration.sourceTables[target],
  )
  const uniqueTableNames = new Set(tableNames)
  if (
    !/^\d{12}$/.test(configuration.accountId) ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(configuration.region) ||
    !/^[A-Za-z0-9_.-]{3,80}$/.test(configuration.restoreTablePrefix) ||
    uniqueTableNames.size !== RESTORE_DRILL_AWS_TABLE_TARGETS.length ||
    tableNames.some((name) => !isDynamoDbTableName(name)) ||
    !isDynamoDbTableName(configuration.stateTableName) ||
    !isBucketName(configuration.evidenceBucketName) ||
    !isBucketName(configuration.scratchBucketName) ||
    !isBucketName(configuration.sourceFileBucketName) ||
    configuration.scratchBucketName === configuration.sourceFileBucketName ||
    configuration.evidenceBucketName === configuration.scratchBucketName ||
    configuration.evidenceBucketName === configuration.sourceFileBucketName ||
    tableNames.includes(configuration.stateTableName) ||
    !isKmsArn(configuration.evidenceKmsKeyArn, configuration.region, configuration.accountId) ||
    !isKmsArn(configuration.scratchKmsKeyArn, configuration.region, configuration.accountId) ||
    !isSecretArn(
      configuration.auditPseudonymSecretArn,
      configuration.region,
      configuration.accountId,
    ) ||
    !/^[A-Za-z0-9_.\-/]{1,255}$/.test(configuration.metricNamespace)
  ) {
    throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
  }
}

/**
 * Checks a DynamoDB table name against the service's bounded portable syntax.
 *
 * @param value - Candidate table name.
 * @returns Whether the value is a valid table name.
 */
function isDynamoDbTableName(value: string): boolean {
  return value.length >= 3 && value.length <= 255 && /^[A-Za-z0-9_.-]+$/.test(value)
}

/**
 * Checks an S3 bucket name against the general-purpose DNS-compatible syntax.
 *
 * @param value - Candidate bucket name.
 * @returns Whether the value is a bounded DNS-compatible name.
 */
function isBucketName(value: string): boolean {
  return value.length >= 3 && value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(value) &&
    !value.includes('..')
}

/**
 * Checks a KMS key ARN against the configured account and Region.
 *
 * @param value - Candidate key ARN.
 * @param region - Expected Region.
 * @param accountId - Expected account.
 * @returns Whether the ARN selects a key in the expected account and Region.
 */
function isKmsArn(value: string, region: string, accountId: string): boolean {
  return value.startsWith(`arn:aws:kms:${region}:${accountId}:key/`) &&
    value.length > `arn:aws:kms:${region}:${accountId}:key/`.length
}

/**
 * Checks a Secrets Manager ARN against the configured account and Region.
 *
 * @param value - Candidate secret ARN.
 * @param region - Expected Region.
 * @param accountId - Expected account.
 * @returns Whether the ARN selects a secret in the expected account and Region.
 */
function isSecretArn(value: string, region: string, accountId: string): boolean {
  return value.startsWith(`arn:aws:secretsmanager:${region}:${accountId}:secret:`) &&
    value.length > `arn:aws:secretsmanager:${region}:${accountId}:secret:`.length
}

/**
 * Parses one strict canonical table descriptor from independent AWS responses.
 *
 * @param tableOutput - Exact DescribeTable response.
 * @param ttlOutput - Exact DescribeTimeToLive response.
 * @returns Detached canonical descriptor.
 */
function parseTableDescriptor(
  tableOutput: DescribeTableCommandOutput,
  ttlOutput: DescribeTimeToLiveCommandOutput,
): RestoreDrillTableDescriptor {
  const table = tableOutput.Table
  const ttl = ttlOutput.TimeToLiveDescription
  if (
    table === undefined ||
    typeof table.TableId !== 'string' ||
    table.TableId.length === 0 ||
    !Number.isSafeInteger(table.ItemCount) ||
    table.ItemCount === undefined ||
    table.ItemCount < 0 ||
    !Array.isArray(table.AttributeDefinitions) ||
    !Array.isArray(table.KeySchema) ||
    table.TableStatus !== 'ACTIVE' ||
    ttl === undefined
  ) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  const billingMode = table.BillingModeSummary?.BillingMode ?? 'PROVISIONED'
  if (billingMode !== 'PAY_PER_REQUEST' && billingMode !== 'PROVISIONED') {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  const sseDescription = table.SSEDescription
  const sseType = sseDescription?.SSEType ?? 'AES256'
  const kmsMasterKeyArn = sseDescription?.KMSMasterKeyArn
  if (
    (sseType !== 'AES256' && sseType !== 'KMS') ||
    (sseDescription !== undefined && sseDescription.Status !== 'ENABLED') ||
    (sseType === 'KMS' && (
      sseDescription?.Status !== 'ENABLED' ||
      typeof kmsMasterKeyArn !== 'string' ||
      kmsMasterKeyArn.length === 0
    )) ||
    (sseType === 'AES256' && kmsMasterKeyArn !== undefined)
  ) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  const attributeDefinitions = table.AttributeDefinitions.map(parseAttributeDefinition)
    .sort(compareAttributeDefinitions)
  const keySchema = table.KeySchema.map(parseKeySchemaElement)
  const globalSecondaryIndexes = (table.GlobalSecondaryIndexes ?? [])
    .map(parseGlobalSecondaryIndex)
    .sort(compareGlobalSecondaryIndexes)
  const ttlStatus = ttl.TimeToLiveStatus
  if (
    (ttlStatus !== 'ENABLED' && ttlStatus !== 'DISABLED') ||
    (ttlStatus === 'ENABLED' && (
      typeof ttl.AttributeName !== 'string' ||
      ttl.AttributeName.length === 0
    )) ||
    (ttlStatus === 'DISABLED' && ttl.AttributeName !== undefined)
  ) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  const ttlEnabled = ttlStatus === 'ENABLED'
  return {
    tableId: table.TableId,
    itemCount: table.ItemCount,
    billingMode,
    sseType,
    sseStatus: 'ENABLED',
    attributeDefinitions,
    keySchema,
    globalSecondaryIndexes,
    ttlEnabled,
    ttlStatus,
    ...(ttlEnabled && ttl.AttributeName ? { ttlAttribute: ttl.AttributeName } : {}),
    ...(typeof kmsMasterKeyArn === 'string'
      ? { kmsMasterKeyArn }
      : {}),
  }
}

/**
 * Parses one strict DynamoDB scalar attribute definition.
 *
 * @param value - Raw SDK descriptor element.
 * @returns Detached canonical definition.
 */
function parseAttributeDefinition(value: unknown): RestoreDrillAttributeDefinition {
  if (!isRecord(value)) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  const attributeName = value.AttributeName
  const attributeType = value.AttributeType
  if (
    typeof attributeName !== 'string' ||
    attributeName.length === 0 ||
    (attributeType !== 'B' && attributeType !== 'N' && attributeType !== 'S')
  ) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  return { attributeName, attributeType }
}

/**
 * Parses one strict DynamoDB key schema element.
 *
 * @param value - Raw SDK schema element.
 * @returns Detached canonical schema element.
 */
function parseKeySchemaElement(value: unknown): RestoreDrillKeySchemaElement {
  if (!isRecord(value)) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  const attributeName = value.AttributeName
  const keyType = value.KeyType
  if (
    typeof attributeName !== 'string' ||
    attributeName.length === 0 ||
    (keyType !== 'HASH' && keyType !== 'RANGE')
  ) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  return { attributeName, keyType }
}

/**
 * Parses one strict DynamoDB global secondary index descriptor.
 *
 * @param value - Raw SDK index descriptor.
 * @returns Detached canonical index descriptor.
 */
function parseGlobalSecondaryIndex(value: unknown): RestoreDrillGlobalSecondaryIndex {
  if (!isRecord(value) || !Array.isArray(value.KeySchema) || !isRecord(value.Projection)) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  const indexName = value.IndexName
  const projectionType = value.Projection.ProjectionType
  const status = value.IndexStatus
  const rawNonKeyAttributes = value.Projection.NonKeyAttributes ?? []
  if (
    typeof indexName !== 'string' ||
    indexName.length === 0 ||
    status !== 'ACTIVE' ||
    (projectionType !== 'ALL' &&
      projectionType !== 'INCLUDE' &&
      projectionType !== 'KEYS_ONLY') ||
    !Array.isArray(rawNonKeyAttributes) ||
    rawNonKeyAttributes.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  }
  const nonKeyAttributes: string[] = []
  for (const entry of rawNonKeyAttributes) {
    if (typeof entry !== 'string') {
      throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
    }
    nonKeyAttributes.push(entry)
  }
  nonKeyAttributes.sort(compareUtf8Ordinal)
  return {
    indexName,
    status,
    keySchema: value.KeySchema.map(parseKeySchemaElement),
    projection: { projectionType, nonKeyAttributes },
  }
}

/** Sorts canonical attribute definitions by name and then scalar type. */
function compareAttributeDefinitions(
  left: RestoreDrillAttributeDefinition,
  right: RestoreDrillAttributeDefinition,
): number {
  return compareUtf8Ordinal(
    `${left.attributeName}\u0000${left.attributeType}`,
    `${right.attributeName}\u0000${right.attributeType}`,
  )
}

/** Sorts canonical global secondary indexes by name. */
function compareGlobalSecondaryIndexes(
  left: RestoreDrillGlobalSecondaryIndex,
  right: RestoreDrillGlobalSecondaryIndex,
): number {
  return compareUtf8Ordinal(left.indexName, right.indexName)
}

/**
 * Validates one strict source File object-version reference.
 *
 * @param source - Candidate strict File reference.
 */
function requireSourceFileVersion(source: RestoreDrillSourceFileVersion): void {
  if (
    typeof source.objectKey !== 'string' ||
    !source.objectKey.startsWith('workspaces/') ||
    !isSafeS3ObjectKey(source.objectKey) ||
    typeof source.objectVersionId !== 'string' ||
    source.objectVersionId.length === 0 ||
    typeof source.versionId !== 'string' ||
    source.versionId.length === 0 ||
    typeof source.contentType !== 'string' ||
    source.contentType.length === 0 ||
    !Number.isSafeInteger(source.sizeBytes) ||
    source.sizeBytes < 1 ||
    source.sizeBytes > RESTORE_DRILL_FILE_MAXIMUM_BYTES
  ) {
    throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
  }
}

/**
 * Creates the exact source/destination identity bound into range progress.
 *
 * @param input - Validated exact copy verification input.
 * @param configuration - Fixed source and scratch bucket configuration.
 * @returns Process-local range checkpoint binding.
 */
function createFileRangeBinding(
  input: RestoreDrillVerifyCreatedFileVersionInput,
  configuration: RestoreDrillAwsConfiguration,
): RestoreDrillFileRangeBinding {
  return {
    destinationBucketName: input.copy.bucketName,
    destinationObjectVersionId: input.copy.objectVersionId,
    drillDigest: input.copy.drillDigest,
    fileVersionId: input.source.versionId,
    objectKey: input.source.objectKey,
    sourceBucketName: configuration.sourceFileBucketName,
    sourceObjectVersionId: input.source.objectVersionId,
    totalBytes: input.source.sizeBytes,
  }
}

/** Maps pure range failures back to stable AWS adapter categories. */
function mapFileRangeFailure(error: unknown): RestoreDrillAwsFailure {
  if (
    error instanceof RestoreDrillFileRangeFailure &&
    error.code === 'RANGE_DIGEST_MISMATCH'
  ) {
    return new RestoreDrillAwsFailure('FILE_COPY_CHECKSUM_MISMATCH')
  }
  if (error instanceof RestoreDrillFileRangeFailure) {
    return new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
  }
  return new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
}

/**
 * Validates a durable exact VersionId baseline for response-loss reconciliation.
 *
 * @param values - Candidate pre-copy scratch VersionIds.
 * @returns Unique baseline set.
 */
function readVersionIdBaseline(values: readonly string[]): Set<string> {
  if (!Array.isArray(values) || values.length > 10_000) {
    throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
  }
  const baseline = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || baseline.has(value)) {
      throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
    }
    baseline.add(value)
  }
  return baseline
}

/**
 * Materializes one complete post-baseline copy delta with deterministic selection.
 *
 * @param configuration - Fixed scratch bucket configuration.
 * @param drillDigest - Stable digest binding every cleanup identity to one drill.
 * @param source - Strict immutable source File version.
 * @param destinationVersionIds - Every newly observed scratch VersionId.
 * @returns All cleanup identities and the ordinally first verification identity.
 */
function createScratchCopyResult(
  configuration: RestoreDrillAwsConfiguration,
  drillDigest: string,
  source: RestoreDrillSourceFileVersion,
  destinationVersionIds: readonly string[],
): RestoreDrillCreatedScratchObjectVersions {
  if (destinationVersionIds.length === 0) {
    throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
  }
  const createdCopies = createScratchCopyIdentities(
    configuration,
    drillDigest,
    source,
    destinationVersionIds,
  )
  const selectedCopy = createdCopies[0]
  if (!selectedCopy) {
    throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
  }
  return { createdCopies, selectedCopy }
}

/**
 * Materializes a canonical possibly-empty post-baseline VersionId delta.
 *
 * @param configuration - Fixed scratch bucket configuration.
 * @param drillDigest - Stable digest binding every cleanup identity to one drill.
 * @param source - Strict immutable source File version.
 * @param destinationVersionIds - Every newly observed scratch VersionId.
 * @returns Canonically ordered exact cleanup identities.
 */
function createScratchCopyIdentities(
  configuration: RestoreDrillAwsConfiguration,
  drillDigest: string,
  source: RestoreDrillSourceFileVersion,
  destinationVersionIds: readonly string[],
): readonly RestoreDrillCreatedScratchObjectVersion[] {
  return [...destinationVersionIds]
    .sort(compareUtf8Ordinal)
    .map((objectVersionId): RestoreDrillCreatedScratchObjectVersion => ({
      kind: 'scratch-object-version',
      bucketName: configuration.scratchBucketName,
      drillDigest,
      objectKey: source.objectKey,
      objectVersionId,
      versionId: source.versionId,
    }))
}

/**
 * Verifies source S3 headers against strict File row metadata.
 *
 * @param source - Strict File row reference.
 * @param head - Exact source HEAD response.
 */
function requireSourceFileMetadata(
  source: RestoreDrillSourceFileVersion,
  head: HeadObjectCommandOutput,
): void {
  if (head.ContentLength !== source.sizeBytes || head.ContentType !== source.contentType) {
    throw new RestoreDrillAwsFailure('FILE_COPY_METADATA_MISMATCH')
  }
}

/**
 * Creates an exact encoded CopySource containing the immutable source VersionId.
 *
 * @param bucketName - Fixed source bucket.
 * @param objectKey - Canonical object key.
 * @param objectVersionId - Exact immutable source version.
 * @returns S3 CopySource request value.
 */
function createCopySource(
  bucketName: string,
  objectKey: string,
  objectVersionId: string,
): string {
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
  return `${encodeURIComponent(bucketName)}/${encodedKey}?versionId=${encodeURIComponent(objectVersionId)}`
}

/**
 * Requires the malware classification tag needed by the File integrity contract.
 *
 * @param tagging - Exact-version object tags.
 */
function requireMalwareTag(tagging: GetObjectTaggingCommandOutput): void {
  const tags = readCanonicalTags(tagging)
  if (!tags.some((tag) => tag.startsWith('GuardDutyMalwareScanStatus\u0000'))) {
    throw new RestoreDrillAwsFailure('FILE_COPY_TAG_MISMATCH')
  }
}

/**
 * Compares every portable object header copied by S3.
 *
 * @param source - Exact source HEAD response.
 * @param destination - Exact destination HEAD response.
 */
function requireMatchingObjectMetadata(
  source: HeadObjectCommandOutput,
  destination: HeadObjectCommandOutput,
): void {
  if (
    source.ContentLength !== destination.ContentLength ||
    source.ContentType !== destination.ContentType ||
    source.CacheControl !== destination.CacheControl ||
    source.ContentDisposition !== destination.ContentDisposition ||
    source.ContentEncoding !== destination.ContentEncoding ||
    source.ContentLanguage !== destination.ContentLanguage ||
    source.Expires?.getTime() !== destination.Expires?.getTime() ||
    source.WebsiteRedirectLocation !== destination.WebsiteRedirectLocation ||
    canonicalStringRecord(source.Metadata) !== canonicalStringRecord(destination.Metadata) ||
    !copiedChecksumsMatch(source, destination)
  ) {
    throw new RestoreDrillAwsFailure('FILE_COPY_METADATA_MISMATCH')
  }
}

/**
 * Creates comparable keyed evidence plus a role-bound authenticity MAC.
 *
 * @param digestKey - Invocation-local evidence HMAC key.
 * @param role - Independently observed source or destination role.
 * @param source - Portable File identity shared by both observations.
 * @param bucketName - Exact physical bucket observed for the role.
 * @param objectVersionId - Exact physical immutable VersionId observed for the role.
 * @param contentChainDigest - Keyed ordered chain over every independently matched range.
 * @param head - Exact-version portable object headers.
 * @param tagging - Exact-version complete tag response.
 * @returns Secret-free independently authenticated comparison proof.
 */
function createFileVersionProof(
  digestKey: Uint8Array,
  role: 'destination' | 'source',
  source: RestoreDrillSourceFileVersion,
  bucketName: string,
  objectVersionId: string,
  contentChainDigest: string,
  head: HeadObjectCommandOutput,
  tagging: GetObjectTaggingCommandOutput,
): RestoreDrillFileVersionProof {
  const portableIdentity = JSON.stringify({
    objectKey: source.objectKey,
    versionId: source.versionId,
  })
  const contentDigest = createHmac('sha256', digestKey)
    .update('restore-drill-file-portable-content-v1\0', 'utf8')
    .update(portableIdentity, 'utf8')
    .update('\0', 'utf8')
    .update(contentChainDigest, 'utf8')
    .digest('hex')
  const metadataDigest = createHmac('sha256', digestKey)
    .update('restore-drill-file-portable-metadata-v1\0', 'utf8')
    .update(portableIdentity, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify({
      cacheControl: head.CacheControl ?? null,
      contentDisposition: head.ContentDisposition ?? null,
      contentEncoding: head.ContentEncoding ?? null,
      contentLanguage: head.ContentLanguage ?? null,
      contentLength: head.ContentLength ?? null,
      contentType: head.ContentType ?? null,
      expiresAt: head.Expires?.toISOString() ?? null,
      metadata: canonicalStringRecord(head.Metadata),
      websiteRedirectLocation: head.WebsiteRedirectLocation ?? null,
    }), 'utf8')
    .digest('hex')
  const tagsDigest = createHmac('sha256', digestKey)
    .update('restore-drill-file-portable-tags-v1\0', 'utf8')
    .update(portableIdentity, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(readCanonicalTags(tagging)), 'utf8')
    .digest('hex')
  const physicalIdentityDigest = createHmac('sha256', digestKey)
    .update(`restore-drill-file-${role}-physical-identity-v1\0`, 'utf8')
    .update(JSON.stringify({
      bucketName,
      objectKey: source.objectKey,
      objectVersionId,
    }), 'utf8')
    .digest('hex')
  const proofWithoutMac: Omit<RestoreDrillFileVersionProof, 'proofMac'> = {
    contentDigest,
    metadataDigest,
    physicalIdentityDigest,
    proofVersion: 1,
    role,
    tagsDigest,
  }
  return {
    ...proofWithoutMac,
    proofMac: calculateFileVersionProofMac(proofWithoutMac, digestKey),
  }
}

/**
 * Verifies a retained role-bound File proof before it contributes to aggregate evidence.
 *
 * @param proof - Untrusted durable proof.
 * @param digestKey - Invocation-local 32-byte evidence HMAC key.
 * @returns Whether the complete proof MAC is authentic.
 */
export function verifyRestoreDrillFileVersionProof(
  proof: RestoreDrillFileVersionProof,
  digestKey: Uint8Array,
): boolean {
  if (digestKey.byteLength !== 32 || !isFileVersionProof(proof, proof.role)) return false
  const expected = calculateFileVersionProofMac(proof, digestKey)
  return timingSafeEqual(Buffer.from(proof.proofMac, 'hex'), Buffer.from(expected, 'hex'))
}

/** Calculates the role-separated MAC over every retained File proof field. */
function calculateFileVersionProofMac(
  proof: Omit<RestoreDrillFileVersionProof, 'proofMac'>,
  digestKey: Uint8Array,
): string {
  return createHmac('sha256', digestKey)
    .update(`restore-drill-file-${proof.role}-proof-v1\0`, 'utf8')
    .update(JSON.stringify({
      contentDigest: proof.contentDigest,
      metadataDigest: proof.metadataDigest,
      physicalIdentityDigest: proof.physicalIdentityDigest,
      proofVersion: proof.proofVersion,
      role: proof.role,
      tagsDigest: proof.tagsDigest,
    }), 'utf8')
    .digest('hex')
}

/**
 * Applies S3 CopyObject checksum semantics without treating generated checksums as user metadata.
 *
 * @param source - Exact source HEAD response.
 * @param destination - Exact destination HEAD response.
 * @returns Whether source checksums were preserved or S3 added only its documented default.
 */
function copiedChecksumsMatch(
  source: HeadObjectCommandOutput,
  destination: HeadObjectCommandOutput,
): boolean {
  const sourceHasChecksum = source.ChecksumCRC32 !== undefined ||
    source.ChecksumCRC32C !== undefined ||
    source.ChecksumCRC64NVME !== undefined ||
    source.ChecksumMD5 !== undefined ||
    source.ChecksumSHA1 !== undefined ||
    source.ChecksumSHA256 !== undefined ||
    source.ChecksumSHA512 !== undefined ||
    source.ChecksumXXHASH3 !== undefined ||
    source.ChecksumXXHASH64 !== undefined ||
    source.ChecksumXXHASH128 !== undefined
  if (sourceHasChecksum) {
    return (source.ChecksumCRC32 !== undefined) ===
        (destination.ChecksumCRC32 !== undefined) &&
      (source.ChecksumCRC32C !== undefined) ===
        (destination.ChecksumCRC32C !== undefined) &&
      (source.ChecksumCRC64NVME !== undefined) ===
        (destination.ChecksumCRC64NVME !== undefined) &&
      (source.ChecksumMD5 !== undefined) ===
        (destination.ChecksumMD5 !== undefined) &&
      (source.ChecksumSHA1 !== undefined) ===
        (destination.ChecksumSHA1 !== undefined) &&
      (source.ChecksumSHA256 !== undefined) ===
        (destination.ChecksumSHA256 !== undefined) &&
      (source.ChecksumSHA512 !== undefined) ===
        (destination.ChecksumSHA512 !== undefined) &&
      (source.ChecksumXXHASH3 !== undefined) ===
        (destination.ChecksumXXHASH3 !== undefined) &&
      (source.ChecksumXXHASH64 !== undefined) ===
        (destination.ChecksumXXHASH64 !== undefined) &&
      (source.ChecksumXXHASH128 !== undefined) ===
        (destination.ChecksumXXHASH128 !== undefined)
  }
  const destinationHasNoChecksum = destination.ChecksumCRC32 === undefined &&
    destination.ChecksumCRC32C === undefined &&
    destination.ChecksumCRC64NVME === undefined &&
    destination.ChecksumMD5 === undefined &&
    destination.ChecksumSHA1 === undefined &&
    destination.ChecksumSHA256 === undefined &&
    destination.ChecksumSHA512 === undefined &&
    destination.ChecksumXXHASH3 === undefined &&
    destination.ChecksumXXHASH64 === undefined &&
    destination.ChecksumXXHASH128 === undefined &&
    destination.ChecksumType === undefined
  const destinationHasDefaultChecksum =
    destination.ChecksumCRC32 === undefined &&
    destination.ChecksumCRC32C === undefined &&
    typeof destination.ChecksumCRC64NVME === 'string' &&
    destination.ChecksumCRC64NVME.length > 0 &&
    destination.ChecksumMD5 === undefined &&
    destination.ChecksumSHA1 === undefined &&
    destination.ChecksumSHA256 === undefined &&
    destination.ChecksumSHA512 === undefined &&
    destination.ChecksumXXHASH3 === undefined &&
    destination.ChecksumXXHASH64 === undefined &&
    destination.ChecksumXXHASH128 === undefined &&
    destination.ChecksumType === 'FULL_OBJECT'
  return destinationHasNoChecksum || destinationHasDefaultChecksum
}

/**
 * Compares complete exact-version S3 tag sets.
 *
 * @param source - Exact source tag response.
 * @param destination - Exact destination tag response.
 */
function requireMatchingObjectTags(
  source: GetObjectTaggingCommandOutput,
  destination: GetObjectTaggingCommandOutput,
): void {
  const sourceTags = readCanonicalTags(source)
  const destinationTags = readCanonicalTags(destination)
  if (JSON.stringify(sourceTags) !== JSON.stringify(destinationTags)) {
    throw new RestoreDrillAwsFailure('FILE_COPY_TAG_MISMATCH')
  }
}

/**
 * Canonicalizes one complete S3 tag set and rejects duplicates or malformed tags.
 *
 * @param tagging - Exact tagging response.
 * @returns Sorted key/value strings.
 */
function readCanonicalTags(tagging: GetObjectTaggingCommandOutput): string[] {
  if (!Array.isArray(tagging.TagSet)) {
    throw new RestoreDrillAwsFailure('FILE_COPY_TAG_MISMATCH')
  }
  const tags: string[] = []
  const keys = new Set<string>()
  for (const tag of tagging.TagSet) {
    if (
      typeof tag.Key !== 'string' ||
      tag.Key.length === 0 ||
      typeof tag.Value !== 'string' ||
      keys.has(tag.Key)
    ) {
      throw new RestoreDrillAwsFailure('FILE_COPY_TAG_MISMATCH')
    }
    keys.add(tag.Key)
    tags.push(`${tag.Key}\u0000${tag.Value}`)
  }
  tags.sort(compareUtf8Ordinal)
  return tags
}

/**
 * Canonicalizes optional string metadata without trusting inherited properties.
 *
 * @param value - SDK metadata map.
 * @returns Stable JSON text.
 */
function canonicalStringRecord(value: Record<string, string> | undefined): string {
  if (!value) return '{}'
  const entries = Object.entries(value).sort(compareStringEntries)
  return JSON.stringify(entries)
}

/** Sorts string-record entries by key and value. */
function compareStringEntries(
  left: [string, string],
  right: [string, string],
): number {
  return compareUtf8Ordinal(
    `${left[0]}\u0000${left[1]}`,
    `${right[0]}\u0000${right[1]}`,
  )
}

/**
 * Checks whether an SDK body is an asynchronous byte stream.
 *
 * @param value - Unknown SDK body.
 * @returns Whether the body exposes an async byte iterator.
 */
function isAsyncByteStream(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
}

/**
 * Streams bytes into SHA-256 without retaining object content.
 *
 * @param stream - Exact object byte stream.
 * @param expectedBytes - Exact byte count authenticated by metadata and the File row.
 * @returns Lowercase hexadecimal SHA-256.
 */
async function hashByteStream(
  stream: AsyncIterable<Uint8Array>,
  expectedBytes: number,
): Promise<string> {
  const hash = createHash('sha256')
  let observedBytes = 0
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        throw new RestoreDrillAwsFailure('FILE_COPY_CHECKSUM_MISMATCH')
      }
      observedBytes += chunk.byteLength
      if (observedBytes > expectedBytes) {
        throw new RestoreDrillAwsFailure('FILE_COPY_CHECKSUM_MISMATCH')
      }
      hash.update(chunk)
    }
  } catch (error: unknown) {
    if (error instanceof RestoreDrillAwsFailure) throw error
    throw new RestoreDrillAwsFailure('UNEXPECTED_AWS_FAILURE')
  }
  if (observedBytes !== expectedBytes) {
    throw new RestoreDrillAwsFailure('FILE_COPY_CHECKSUM_MISMATCH')
  }
  return hash.digest('hex')
}

/**
 * Validates one opaque S3 key without rejecting legal consecutive dots in a segment.
 *
 * @param value - Candidate exact S3 object key or key marker.
 * @returns Whether the value is bounded and contains no traversal or separator ambiguity.
 */
function isSafeS3ObjectKey(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 1_024 ||
    value.includes('\u0000') ||
    value.includes('\\')
  ) {
    return false
  }
  return value.split('/').every(
    (segment) => segment !== '.' && segment !== '..',
  )
}

/**
 * Builds process-local work for one strictly parsed File metadata row.
 *
 * @param item - Exact low-level isolated row.
 * @param native - Strictly decoded native row.
 * @returns File row work containing only exact object versions.
 */
function createFileRowWork(
  item: Readonly<Record<string, AttributeValue>>,
  native: Record<string, unknown>,
): RestoreDrillFileRowWork {
  let references: FileIntegrityReference[]
  try {
    references = parseFileIntegrityReferences(native)
  } catch {
    throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
  }
  const revision = native.revision
  if (!Number.isSafeInteger(revision) || typeof revision !== 'number' || revision < 1) {
    throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
  }
  const versions: RestoreDrillSourceFileVersion[] = []
  for (const reference of references) {
    if (reference.objectVersionId) {
      versions.push(createSourceFileVersion(reference))
    }
  }
  const scopeKey = item.scopeKey
  const recordKey = item.recordKey
  if (scopeKey?.S === undefined || recordKey?.S === undefined) {
    throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
  }
  return {
    revision,
    versions,
    originalItem: cloneAttributeMap(item, 'FILE_ROW_INVALID'),
    rowKey: {
      scopeKey: { S: scopeKey.S },
      recordKey: { S: recordKey.S },
    },
  }
}

/**
 * Converts one strictly parsed File reference into a copy input.
 *
 * @param reference - Strict File reference containing an immutable object VersionId.
 * @returns Exact source File version.
 */
function createSourceFileVersion(
  reference: FileIntegrityReference,
): RestoreDrillSourceFileVersion {
  if (!reference.objectVersionId) {
    throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
  }
  return {
    versionId: reference.versionId,
    objectKey: reference.objectKey,
    objectVersionId: reference.objectVersionId,
    contentType: reference.contentType,
    sizeBytes: reference.sizeBytes,
  }
}

/**
 * Creates the isolated File item with only physical object VersionIds remapped.
 *
 * @param input - Exact row, copies, and target identity.
 * @param configuration - Fixed scratch configuration.
 * @returns Low-level replacement item.
 */
function createRemappedFileItem(
  input: RestoreDrillCommitFileRemapInput,
  configuration: RestoreDrillAwsConfiguration,
): Record<string, AttributeValue> {
  if (input.copies.length !== input.row.versions.length) {
    throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
  }
  const copyVersions = new Map<string, string>()
  const sourceVersions = new Map<string, RestoreDrillSourceFileVersion>()
  for (const source of input.row.versions) {
    if (sourceVersions.has(source.versionId)) {
      throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
    }
    sourceVersions.set(source.versionId, source)
  }
  const expectedDrillDigest = createDrillDigest(input.drillId)
  for (const copy of input.copies) {
    requireRecordedScratchObjectVersion(copy, configuration)
    const source = sourceVersions.get(copy.versionId)
    if (
      copy.drillDigest !== expectedDrillDigest ||
      copyVersions.has(copy.versionId) ||
      source === undefined ||
      copy.objectKey !== source.objectKey
    ) {
      throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
    }
    copyVersions.set(copy.versionId, copy.objectVersionId)
  }
  for (const source of input.row.versions) {
    if (!copyVersions.has(source.versionId)) {
      throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
    }
  }
  const remappedItem = cloneAttributeMap(input.row.originalItem, 'FILE_ROW_INVALID')
  const originalVersions = remappedItem.versions?.L
  if (!Array.isArray(originalVersions)) {
    throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
  }
  const remappedVersions: AttributeValue[] = []
  const consumedCopies = new Set<string>()
  for (const value of originalVersions) {
    const version = cloneAttributeValue(value, 'FILE_ROW_INVALID')
    const versionId = version.M?.id?.S
    if (typeof versionId !== 'string') {
      throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
    }
    const destinationVersionId = copyVersions.get(versionId)
    if (destinationVersionId && version.M) {
      version.M.objectVersionId = { S: destinationVersionId }
      consumedCopies.add(versionId)
    }
    remappedVersions.push(version)
  }
  if (consumedCopies.size !== copyVersions.size) {
    throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
  }
  remappedItem.versions = { L: remappedVersions }
  return remappedItem
}

/**
 * Verifies one update response or strong reconciliation read against the exact remap.
 *
 * @param item - Returned isolated File row attributes.
 * @param expectedRevision - Original logical revision, intentionally unchanged by physical remap.
 * @param expectedVersions - Exact versions containing only destination VersionId substitutions.
 */
function requireExactRemappedFileState(
  item: Readonly<Record<string, AttributeValue>> | undefined,
  expectedRevision: number,
  expectedVersions: AttributeValue,
): void {
  if (
    item?.revision?.N !== String(expectedRevision) ||
    item.versions === undefined ||
    serializeAttributeValue(item.versions) !== serializeAttributeValue(expectedVersions)
  ) {
    throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
  }
}

/**
 * Validates a structurally supplied scratch cleanup identity.
 *
 * @param version - Candidate exact scratch version.
 * @param configuration - Fixed scratch configuration.
 */
function requireCreatedScratchObjectVersion(
  version: RestoreDrillCreatedScratchObjectVersion,
  configuration: RestoreDrillAwsConfiguration,
): void {
  if (
    version.kind !== 'scratch-object-version' ||
    version.bucketName !== configuration.scratchBucketName ||
    !/^[a-f0-9]{16}$/.test(version.drillDigest) ||
    !version.objectKey.startsWith('workspaces/') ||
    !isSafeS3ObjectKey(version.objectKey) ||
    version.objectVersionId.length === 0 ||
    version.versionId.length === 0
  ) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
}

/**
 * Validates a structurally supplied verified scratch copy.
 *
 * @param version - Candidate verified scratch version.
 * @param configuration - Fixed scratch configuration.
 */
function requireRecordedScratchObjectVersion(
  version: RestoreDrillRecordedScratchObjectVersion,
  configuration: RestoreDrillAwsConfiguration,
): void {
  requireCreatedScratchObjectVersion(version, configuration)
  if (
    !isFileVersionProof(version.sourceProof, 'source') ||
    !isFileVersionProof(version.destinationProof, 'destination') ||
    version.sourceProof.contentDigest !== version.destinationProof.contentDigest ||
    version.sourceProof.metadataDigest !== version.destinationProof.metadataDigest ||
    version.sourceProof.tagsDigest !== version.destinationProof.tagsDigest ||
    version.sourceProof.proofMac === version.destinationProof.proofMac
  ) {
    throw new RestoreDrillAwsFailure('FILE_COPY_IDENTITY_MISMATCH')
  }
}

/**
 * Validates one secret-free File proof for its required observation role.
 *
 * @param proof - Candidate proof supplied through a durable boundary.
 * @param role - Required source or destination observation role.
 * @returns Whether every fixed proof field is structurally valid.
 */
function isFileVersionProof(
  proof: RestoreDrillFileVersionProof,
  role: RestoreDrillFileVersionProof['role'],
): boolean {
  return proof.proofVersion === 1 &&
    proof.role === role &&
    /^[a-f0-9]{64}$/.test(proof.contentDigest) &&
    /^[a-f0-9]{64}$/.test(proof.metadataDigest) &&
    /^[a-f0-9]{64}$/.test(proof.physicalIdentityDigest) &&
    /^[a-f0-9]{64}$/.test(proof.tagsDigest) &&
    /^[a-f0-9]{64}$/.test(proof.proofMac)
}

/**
 * Validates a structurally supplied export-created scratch cleanup identity.
 *
 * @param version - Candidate export object version.
 * @param configuration - Fixed scratch configuration.
 */
function requireRecordedExportObjectVersion(
  version: RestoreDrillRecordedExportObjectVersion,
  configuration: RestoreDrillAwsConfiguration,
): void {
  if (
    version.kind !== 'export-object-version' ||
    version.bucketName !== configuration.scratchBucketName ||
    !version.objectKey.startsWith(`${version.scratchPrefix}/`) ||
    !version.scratchPrefix.startsWith('restore-drill/') ||
    !isSafeS3ObjectKey(version.objectKey) ||
    !isSafeS3ObjectKey(version.scratchPrefix) ||
    version.objectVersionId.length === 0 ||
    !/^[a-f0-9]{64}$/.test(version.exportArnDigest)
  ) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
}

/**
 * Validates one structurally supplied incomplete multipart upload identity.
 *
 * @param upload - Candidate exact incomplete upload.
 * @param configuration - Fixed scratch configuration.
 */
function requireRecordedMultipartUpload(
  upload: RestoreDrillRecordedMultipartUpload,
  configuration: RestoreDrillAwsConfiguration,
): void {
  if (
    upload.kind !== 'scratch-multipart-upload' ||
    upload.bucketName !== configuration.scratchBucketName ||
    !/^restore-drill\/[a-f0-9]{16}\//.test(upload.objectKey) ||
    !isSafeS3ObjectKey(upload.objectKey) ||
    typeof upload.uploadId !== 'string' ||
    upload.uploadId.length === 0 ||
    upload.uploadId.length > 1_024
  ) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
}

/**
 * Binds one table deletion to the exact drill-derived physical name.
 *
 * @param table - Candidate restore table.
 * @param drillId - Stable owning drill identifier.
 * @param configuration - Fixed restore namespace.
 */
function requireCleanupRestoreTable(
  table: RestoreDrillRecordedRestoreTable,
  drillId: string,
  configuration: RestoreDrillAwsConfiguration,
): void {
  const expectedName = createRestoreDrillTargetTableName(
    configuration.restoreTablePrefix,
    drillId,
    table.target,
  )
  if (
    table.tableName !== expectedName ||
    table.tableArn !==
      `arn:aws:dynamodb:${configuration.region}:${configuration.accountId}:table/${expectedName}`
  ) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
}

/**
 * Binds one copied File version deletion to the exact owning drill digest.
 *
 * @param version - Candidate copied File version.
 * @param drillId - Stable owning drill identifier.
 */
function requireCleanupScratchObjectVersion(
  version: RestoreDrillCreatedScratchObjectVersion,
  drillId: string,
): void {
  if (version.drillDigest !== createDrillDigest(drillId)) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
}

/**
 * Binds one export-object deletion to an exact target prefix owned by the drill.
 *
 * @param version - Candidate export object version.
 * @param drillId - Stable owning drill identifier.
 */
function requireCleanupExportObjectVersion(
  version: RestoreDrillRecordedExportObjectVersion,
  drillId: string,
): void {
  const drillRoot = `restore-drill/${createDrillDigest(drillId)}/`
  const exactPrefix = RESTORE_DRILL_AWS_TABLE_TARGETS.some(
    (target) => version.scratchPrefix === `${drillRoot}${target}/export`,
  )
  if (!exactPrefix) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
}

/**
 * Binds one multipart abort to the exact owning drill prefix.
 *
 * @param upload - Candidate incomplete upload.
 * @param drillId - Stable owning drill identifier.
 */
function requireCleanupMultipartUpload(
  upload: RestoreDrillRecordedMultipartUpload,
  drillId: string,
): void {
  if (!upload.objectKey.startsWith(`restore-drill/${createDrillDigest(drillId)}/`)) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
}

/**
 * Validates one exact common drill prefix used for incomplete-upload inventory.
 *
 * @param prefix - Candidate common prefix.
 */
function requireMultipartUploadPrefix(prefix: string): void {
  if (!/^restore-drill\/[a-f0-9]{16}\/$/.test(prefix)) {
    throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
  }
}

/**
 * Validates an optional multipart-upload listing continuation.
 *
 * @param prefix - Exact common drill prefix.
 * @param cursor - Candidate opaque continuation.
 */
function requireMultipartUploadCursor(
  prefix: string,
  cursor: RestoreDrillMultipartUploadCursor | undefined,
): void {
  if (cursor === undefined) return
  if (
    typeof cursor.keyMarker !== 'string' ||
    !cursor.keyMarker.startsWith(prefix) ||
    !isSafeS3ObjectKey(cursor.keyMarker) ||
    typeof cursor.uploadIdMarker !== 'string' ||
    cursor.uploadIdMarker.length === 0 ||
    cursor.uploadIdMarker.length > 1_024
  ) {
    throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
  }
}

/**
 * Validates one optional exact S3 version-list continuation.
 *
 * @param cursor - Candidate continuation cursor.
 */
function requireExportObjectVersionCursor(
  cursor: RestoreDrillExportObjectVersionCursor | undefined,
): void {
  if (cursor === undefined) return
  if (
    typeof cursor.keyMarker !== 'string' ||
    cursor.keyMarker.length === 0 ||
    cursor.keyMarker.length > 1_024 ||
    typeof cursor.versionIdMarker !== 'string' ||
    cursor.versionIdMarker.length === 0 ||
    cursor.versionIdMarker.length > 1_024
  ) {
    throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
  }
}

/**
 * Recognizes stable S3 exact-version absence without exposing raw error data.
 *
 * @param error - Unknown caught value.
 * @returns Whether S3 reports exact-version absence.
 */
function isMissingS3Object(error: unknown): boolean {
  return isAwsErrorNamed(error, 'NoSuchKey') ||
    isAwsErrorNamed(error, 'NoSuchVersion') ||
    isAwsErrorNamed(error, 'NotFound')
}

/** Process-local keyed, order-independent accumulator shared by export and restore reads. */
export class RestoreDrillDynamoAggregateAccumulator {
  /** Order-independent normalized item accumulator. */
  private readonly contentAccumulator: RestoreDrillKeyedMultisetDigestAccumulator

  /** Private copy used only to count keyed logical partitions. */
  private readonly digestKey: Uint8Array

  /** Order-independent exact primary-key accumulator. */
  private readonly keyAccumulator: RestoreDrillKeyedMultisetDigestAccumulator

  /** Ordered primary key attribute names. */
  private readonly keySchema: readonly RestoreDrillKeySchemaElement[]

  /** Keyed digest binding compact checkpoints to the exact key schema. */
  private readonly keySchemaDigest: string

  /** Maximum exact number of items accepted before finalization. */
  private readonly maxItemCount: number

  /** Keyed digests of unique partition key values. */
  private readonly partitionDigests = new Set<string>()

  /** Logical table target controlling portable physical-ID normalization. */
  private readonly target: RestoreDrillAwsTableTarget

  /** Exact number of items added. */
  private recordCount = 0

  /** Cached evidence after all process-local key material is zeroized. */
  private finalizedEvidence?: RestoreDrillDynamoAggregateEvidence

  /** Whether an unfinished aggregate has been explicitly zeroized. */
  private disposed = false

  /**
   * Creates an empty per-table aggregate.
   *
   * @param digestKey - Exactly 32 bytes of in-memory HMAC key material.
   * @param target - Logical table target.
   * @param keySchema - Exact base-table key schema.
   * @param maxItemCount - Positive bound on retained element digests.
   */
  constructor(
    digestKey: Uint8Array,
    target: RestoreDrillAwsTableTarget,
    keySchema: readonly RestoreDrillKeySchemaElement[],
    maxItemCount = 1_000_000,
  ) {
    if (
      digestKey.byteLength !== 32 ||
      !RESTORE_DRILL_AWS_TABLE_TARGETS.includes(target) ||
      !isValidAggregateKeySchema(keySchema) ||
      !Number.isSafeInteger(maxItemCount) ||
      maxItemCount < 1
    ) {
      throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
    }
    this.digestKey = Uint8Array.from(digestKey)
    this.target = target
    this.keySchema = keySchema.map((element) => ({ ...element }))
    this.keySchemaDigest = createHmac('sha256', this.digestKey)
      .update('restore-drill-aggregate-key-schema-v1\0', 'utf8')
      .update(JSON.stringify(this.keySchema), 'utf8')
      .digest('hex')
    this.maxItemCount = maxItemCount
    this.contentAccumulator = new RestoreDrillKeyedMultisetDigestAccumulator(
      digestKey,
      `restore-drill-${target.replace(':', '-')}-content-v1`,
      maxItemCount,
    )
    this.keyAccumulator = new RestoreDrillKeyedMultisetDigestAccumulator(
      digestKey,
      `restore-drill-${target.replace(':', '-')}-keys-v1`,
      maxItemCount,
    )
  }

  /**
   * Adds one exact low-level item after portable File VersionId normalization.
   *
   * @param item - Untrusted low-level DynamoDB item.
   */
  add(item: Readonly<Record<string, AttributeValue>>): void {
    if (this.disposed || this.finalizedEvidence || this.recordCount >= this.maxItemCount) {
      throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
    }
    const exactItem = cloneAttributeMap(item, 'AWS_RESPONSE_INVALID')
    const key = selectAggregateKey(exactItem, this.keySchema)
    const partition = selectAggregatePartitionKey(exactItem, this.keySchema)
    const normalized = normalizePortableItem(exactItem, this.target)
    this.keyAccumulator.add(serializeAttributeMap(key))
    this.contentAccumulator.add(serializeAttributeMap(normalized))
    this.partitionDigests.add(
      createHmac('sha256', this.digestKey)
        .update('restore-drill-logical-partition-v1\u0000', 'utf8')
        .update(serializeAttributeMap(partition), 'utf8')
        .digest('hex'),
    )
    this.recordCount += 1
  }

  /**
   * Merges one authenticated compact durable unit into this accumulator.
   *
   * @param checkpoint - Untrusted compact state for the same target and key schema.
   */
  mergeCheckpoint(checkpoint: RestoreDrillDynamoAggregateCheckpoint): void {
    if (
      this.disposed ||
      this.finalizedEvidence ||
      checkpoint.checkpointVersion !== 1 ||
      checkpoint.target !== this.target ||
      checkpoint.keySchemaDigest !== this.keySchemaDigest ||
      !Number.isSafeInteger(checkpoint.recordCount) ||
      checkpoint.recordCount < 0 ||
      checkpoint.recordCount + this.recordCount > this.maxItemCount ||
      checkpoint.content.itemCount !== checkpoint.recordCount ||
      checkpoint.keys.itemCount !== checkpoint.recordCount ||
      !Array.isArray(checkpoint.partitionDigests) ||
      checkpoint.partitionDigests.length > checkpoint.recordCount ||
      checkpoint.partitionDigests.some((digest) => !/^[a-f0-9]{64}$/.test(digest)) ||
      !isSortedUniqueStrings(checkpoint.partitionDigests) ||
      checkpoint.checkpointMac !== this.calculateCheckpointMac(checkpoint)
    ) {
      throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
    }
    this.contentAccumulator.mergeCheckpoint(checkpoint.content)
    this.keyAccumulator.mergeCheckpoint(checkpoint.keys)
    for (const digest of checkpoint.partitionDigests) this.partitionDigests.add(digest)
    this.recordCount += checkpoint.recordCount
  }

  /**
   * Returns compact authenticated state for the current bounded unit.
   *
   * @param includePartitionDigests - Whether to include exact unique partition digests.
   * @returns Detached secret-free checkpoint suitable for durable storage.
   */
  checkpoint(includePartitionDigests = true): RestoreDrillDynamoAggregateCheckpoint {
    if (this.disposed || this.finalizedEvidence) {
      throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
    }
    const checkpointWithoutMac: Omit<
      RestoreDrillDynamoAggregateCheckpoint,
      'checkpointMac'
    > = {
      content: this.contentAccumulator.checkpoint(),
      checkpointVersion: 1,
      keys: this.keyAccumulator.checkpoint(),
      keySchemaDigest: this.keySchemaDigest,
      partitionDigests: includePartitionDigests
        ? [...this.partitionDigests].sort(compareUtf8Ordinal)
        : [],
      recordCount: this.recordCount,
      target: this.target,
    }
    return {
      ...checkpointWithoutMac,
      checkpointMac: this.calculateCheckpointMac(checkpointWithoutMac),
    }
  }

  /**
   * Detaches the currently buffered opaque partition tokens for durable streaming.
   *
   * Repeated logical partitions may be emitted again after a drain; the durable
   * token ledger is responsible for idempotent set semantics.
   *
   * @returns Lexically ordered unique tokens observed since the preceding drain.
   */
  drainPartitionDigests(): readonly string[] {
    if (this.disposed || this.finalizedEvidence) {
      throw new RestoreDrillAwsFailure('CHECKPOINT_INVALID')
    }
    const digests = [...this.partitionDigests].sort(compareUtf8Ordinal)
    this.partitionDigests.clear()
    return digests
  }

  /**
   * Returns secret-free evidence without exposing raw keys or items.
   *
   * @returns Current exact aggregate.
   */
  finalize(logicalPartitionCount = this.partitionDigests.size): RestoreDrillDynamoAggregateEvidence {
    if (this.finalizedEvidence) return cloneAggregateEvidence(this.finalizedEvidence)
    if (
      this.disposed ||
      !Number.isSafeInteger(logicalPartitionCount) ||
      logicalPartitionCount < 0 ||
      logicalPartitionCount > this.recordCount
    ) throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    const evidence: RestoreDrillDynamoAggregateEvidence = {
      content: this.contentAccumulator.finalize(),
      keys: this.keyAccumulator.finalize(),
      logicalPartitionCount,
      recordCount: this.recordCount,
    }
    this.dispose()
    this.finalizedEvidence = evidence
    return cloneAggregateEvidence(evidence)
  }

  /** Calculates the outer target- and schema-bound compact-checkpoint MAC. */
  private calculateCheckpointMac(
    checkpoint: Omit<RestoreDrillDynamoAggregateCheckpoint, 'checkpointMac'>,
  ): string {
    return createHmac('sha256', this.digestKey)
      .update('restore-drill-dynamo-aggregate-checkpoint-v1\0', 'utf8')
      .update(checkpoint.target, 'utf8')
      .update('\0', 'utf8')
      .update(checkpoint.keySchemaDigest, 'utf8')
      .update('\0', 'utf8')
      .update(JSON.stringify(checkpoint.content), 'utf8')
      .update('\0', 'utf8')
      .update(JSON.stringify(checkpoint.keys), 'utf8')
      .update('\0', 'utf8')
      .update(String(checkpoint.recordCount), 'utf8')
      .update('\0', 'utf8')
      .update(checkpoint.partitionDigests.join('\n'), 'utf8')
      .digest('hex')
  }

  /** Clears all process-local digest material after a failed or abandoned aggregation. */
  dispose(): void {
    this.digestKey.fill(0)
    this.contentAccumulator.dispose()
    this.keyAccumulator.dispose()
    this.partitionDigests.clear()
    this.disposed = true
  }
}

/**
 * Detaches cached aggregate evidence from caller mutation.
 *
 * @param evidence - Cached secret-free evidence.
 * @returns Fresh detached evidence.
 */
function cloneAggregateEvidence(
  evidence: RestoreDrillDynamoAggregateEvidence,
): RestoreDrillDynamoAggregateEvidence {
  return {
    content: { ...evidence.content },
    keys: { ...evidence.keys },
    logicalPartitionCount: evidence.logicalPartitionCount,
    recordCount: evidence.recordCount,
  }
}

/**
 * Parses a bounded newline-delimited DynamoDB export manifest.
 *
 * @param body - Manifest byte stream.
 * @param limits - Strict uncompressed byte and data-file bounds.
 * @param recorded - Exact full-export identity that owns every data key.
 * @param configuration - Fixed scratch bucket and KMS configuration.
 * @returns Exact data-file vector and partition count.
 */
export async function parseRestoreDrillExportFilesManifest(
  body: AsyncIterable<Uint8Array>,
  limits: RestoreDrillExportStreamLimits,
  recorded: RestoreDrillRecordedExport,
  configuration: RestoreDrillAwsConfiguration,
): Promise<RestoreDrillExportManifest> {
  validateStreamLimits(limits)
  requireRecordedExport(recorded, configuration)
  const dataFiles: RestoreDrillExportDataFile[] = []
  const objectKeys = new Set<string>()
  let itemCount = 0
  try {
    for await (const line of readBoundedUtf8Lines(body, limits.maxBytes, false)) {
      if (line.length === 0) continue
      if (dataFiles.length >= limits.maxRecords) {
        throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
      }
      const value: unknown = JSON.parse(line)
      if (!isRecord(value)) throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      const objectKey = value.dataFileS3Key
      const count = value.itemCount
      const etag = value.etag
      const md5Checksum = value.md5Checksum
      const normalizedObjectKey = normalizeFullExportObjectKey(
        objectKey,
        recorded,
        'data',
      )
      if (
        !hasExactKeys(value, ['dataFileS3Key', 'etag', 'itemCount', 'md5Checksum']) ||
        typeof etag !== 'string' ||
        etag.length === 0 ||
        etag.length > 1_024 ||
        typeof md5Checksum !== 'string' ||
        !isBase64Md5(md5Checksum) ||
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      if (objectKeys.has(normalizedObjectKey)) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      objectKeys.add(normalizedObjectKey)
      itemCount += count
      if (!Number.isSafeInteger(itemCount)) {
        throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
      }
      dataFiles.push({
        objectKey: normalizedObjectKey,
        itemCount: count,
        md5Checksum,
      })
    }
  } catch (error) {
    if (error instanceof RestoreDrillAwsFailure) throw error
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  }
  if (dataFiles.length === 0) {
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  }
  return { dataFiles, itemCount, partitionCount: dataFiles.length }
}

/**
 * Parses the JSON manifest-summary object and binds it to the exact recorded export.
 *
 * @param body - Manifest-summary byte stream.
 * @param maxBytes - Strict object size bound.
 * @param recorded - Exact export identity returned by DynamoDB.
 * @param configuration - Fixed scratch bucket and KMS configuration.
 * @returns Strict manifest-files pointer and item count.
 */
export async function parseRestoreDrillExportSummary(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  recorded: RestoreDrillRecordedExport,
  configuration: RestoreDrillAwsConfiguration,
): Promise<RestoreDrillExportSummary> {
  requireRecordedExport(recorded, configuration)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
    throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
  }
  try {
    const text = await readBoundedUtf8Object(body, maxBytes)
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    const manifestFilesObjectKey = normalizeFullExportObjectKey(
      value.manifestFilesS3Key,
      recorded,
      'manifest-files',
    )
    const itemCount = value.itemCount
    if (
      value.version !== '2020-06-30' ||
      value.exportArn !== recorded.exportArn ||
      value.tableArn !== recorded.sourceTableArn ||
      value.tableId !== recorded.sourceTableId ||
      value.exportTime !== recorded.exportPoint ||
      value.s3Bucket !== configuration.scratchBucketName ||
      value.s3Prefix !== recorded.scratchPrefix ||
      value.s3SseAlgorithm !== 'KMS' ||
      value.s3SseKmsKeyId !== configuration.scratchKmsKeyArn ||
      value.outputFormat !== 'DYNAMODB_JSON' ||
      typeof itemCount !== 'number' ||
      !Number.isSafeInteger(itemCount) ||
      itemCount < 0
    ) {
      throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
    }
    return {
      itemCount,
      manifestFilesObjectKey,
      outputFormat: 'DYNAMODB_JSON',
      sourceTableId: recorded.sourceTableId,
    }
  } catch (error) {
    if (error instanceof RestoreDrillAwsFailure) throw error
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  }
}

/**
 * Authenticates exact manifest bytes against DynamoDB's adjacent MD5 checksum object.
 *
 * @param body - Exact manifest object stream.
 * @param checksumBody - Adjacent `.checksum` object stream.
 * @param maxBytes - Maximum manifest bytes retained before parsing.
 * @returns Single-use one-chunk byte stream containing the authenticated manifest.
 */
export async function verifyRestoreDrillExportManifestChecksum(
  body: AsyncIterable<Uint8Array>,
  checksumBody: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<AsyncIterable<Uint8Array>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 67_108_864) {
    throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
  }
  let manifestBytes: Uint8Array
  let checksumBytes: Uint8Array
  try {
    ;[manifestBytes, checksumBytes] = await Promise.all([
      readBoundedBytes(body, maxBytes),
      readBoundedBytes(checksumBody, 128),
    ])
  } catch (error: unknown) {
    if (error instanceof RestoreDrillAwsFailure) throw error
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  }
  try {
    const checksumText = new TextDecoder('utf-8', { fatal: true })
      .decode(checksumBytes)
      .replace(/\r?\n$/, '')
    const digest = createHash('md5').update(manifestBytes).digest()
    const matches = (
      /^[a-f0-9]{32}$/.test(checksumText) &&
      digest.toString('hex') === checksumText
    ) || (
      isBase64Md5(checksumText) &&
      digest.toString('base64') === checksumText
    )
    digest.fill(0)
    if (!matches) {
      throw new RestoreDrillAwsFailure('EXPORT_CHECKSUM_MISMATCH')
    }
  } catch (error: unknown) {
    manifestBytes.fill(0)
    if (error instanceof RestoreDrillAwsFailure) throw error
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  } finally {
    checksumBytes.fill(0)
  }
  return singleUseOwnedByteStream(manifestBytes)
}

/**
 * Normalizes one service-emitted full-export pointer below the exact ExportId.
 *
 * @param value - Untrusted relative or scratch-prefix-qualified object key.
 * @param recorded - Exact full-export identity.
 * @param kind - Expected manifest or data-object shape.
 * @returns Exact scratch-bucket object key.
 */
function normalizeFullExportObjectKey(
  value: unknown,
  recorded: RestoreDrillRecordedExport,
  kind: 'data' | 'manifest-files' | 'manifest-summary',
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.split('/').some((segment) =>
      segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
  }
  const exportArnPrefix = `${recorded.sourceTableArn}/export/`
  if (!recorded.exportArn.startsWith(exportArnPrefix)) {
    throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
  }
  const exportId = recorded.exportArn.slice(exportArnPrefix.length)
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(exportId)) {
    throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
  }
  const relativePrefix = `AWSDynamoDB/${exportId}/`
  const qualifiedPrefix = `${recorded.scratchPrefix}/${relativePrefix}`
  const normalized = value.startsWith(relativePrefix)
    ? `${recorded.scratchPrefix}/${value}`
    : value
  if (!normalized.startsWith(qualifiedPrefix)) {
    throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
  }
  if (kind === 'manifest-summary') {
    if (normalized !== `${qualifiedPrefix}manifest-summary.json`) {
      throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
    }
    return normalized
  }
  if (kind === 'manifest-files') {
    if (normalized !== `${qualifiedPrefix}manifest-files.json`) {
      throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
    }
    return normalized
  }
  const filename = normalized.slice(`${qualifiedPrefix}data/`.length)
  if (
    !normalized.startsWith(`${qualifiedPrefix}data/`) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}\.json\.gz$/.test(filename)
  ) {
    throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
  }
  return normalized
}

/**
 * Checks that one untrusted JSON object has exactly the expected own keys.
 *
 * @param value - Parsed JSON object.
 * @param expectedKeys - Complete expected key vector.
 * @returns Whether no key is absent or extra.
 */
function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareUtf8Ordinal)
  const expected = [...expectedKeys].sort(compareUtf8Ordinal)
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
}

/**
 * Reads an exact byte stream into a bounded owned buffer.
 *
 * @param body - Untrusted object stream.
 * @param maxBytes - Maximum accepted bytes.
 * @returns Owned exact bytes.
 */
async function readBoundedBytes(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
  }
  const chunks: Uint8Array[] = []
  let byteCount = 0
  try {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      byteCount += chunk.byteLength
      if (!Number.isSafeInteger(byteCount) || byteCount > maxBytes) {
        throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
      }
      chunks.push(Uint8Array.from(chunk))
    }
    const bytes = new Uint8Array(byteCount)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
      chunk.fill(0)
    }
    return bytes
  } catch (error: unknown) {
    for (const chunk of chunks) chunk.fill(0)
    if (error instanceof RestoreDrillAwsFailure) throw error
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  }
}

/**
 * Exposes owned authenticated bytes exactly once and clears them after consumption.
 *
 * @param bytes - Owned authenticated bytes.
 * @returns Single-use one-chunk stream.
 */
async function* singleUseOwnedByteStream(
  bytes: Uint8Array,
): AsyncGenerator<Uint8Array> {
  try {
    yield bytes
  } finally {
    bytes.fill(0)
  }
}

/**
 * Streams bounded gzip-compressed DynamoDB JSON export data into an aggregate.
 *
 * @param body - Gzip-compressed newline-delimited export data.
 * @param limits - Strict uncompressed byte and item bounds.
 * @param accumulator - Process-local keyed aggregate accumulator.
 * @param partitionSink - Optional durable sink called with at most 25 opaque tokens.
 * @returns Number of items consumed from this data file.
 */
export async function consumeRestoreDrillExportData(
  body: AsyncIterable<Uint8Array>,
  limits: RestoreDrillExportStreamLimits,
  accumulator: RestoreDrillDynamoAggregateAccumulator,
  expectedMd5Checksum: string,
  partitionSink?: (digests: readonly string[]) => Promise<void>,
): Promise<number> {
  validateStreamLimits(limits)
  if (!isBase64Md5(expectedMd5Checksum)) {
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  }
  let itemCount = 0
  let partitionSinkFailure: unknown
  try {
    const verifiedBody = verifyMd5ByteStream(body, expectedMd5Checksum)
    for await (const line of readBoundedUtf8Lines(verifiedBody, limits.maxBytes, true)) {
      if (line.length === 0) continue
      if (itemCount >= limits.maxRecords) {
        throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
      }
      const value: unknown = JSON.parse(line)
      if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.Item)) {
        throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
      }
      accumulator.add(cloneAttributeMap(value.Item, 'AWS_RESPONSE_INVALID'))
      itemCount += 1
      if (partitionSink && itemCount % 25 === 0) {
        const digests = accumulator.drainPartitionDigests()
        if (digests.length > 0) {
          try {
            await partitionSink(digests)
          } catch (error: unknown) {
            partitionSinkFailure = error
            throw error
          }
        }
      }
    }
    if (partitionSink) {
      const digests = accumulator.drainPartitionDigests()
      if (digests.length > 0) {
        try {
          await partitionSink(digests)
        } catch (error: unknown) {
          partitionSinkFailure = error
          throw error
        }
      }
    }
  } catch (error: unknown) {
    if (partitionSinkFailure !== undefined && error === partitionSinkFailure) throw error
    if (error instanceof RestoreDrillAwsFailure) throw error
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  }
  return itemCount
}

/**
 * Validates one aggregate key schema containing exactly one HASH and at most one RANGE key.
 *
 * @param keySchema - Candidate canonical key schema.
 * @returns Whether it is a valid base-table schema.
 */
function isValidAggregateKeySchema(
  keySchema: readonly RestoreDrillKeySchemaElement[],
): boolean {
  return (keySchema.length === 1 || keySchema.length === 2) &&
    keySchema.filter((entry) => entry.keyType === 'HASH').length === 1 &&
    keySchema.filter((entry) => entry.keyType === 'RANGE').length <= 1 &&
    new Set(keySchema.map((entry) => entry.attributeName)).size === keySchema.length
}

/**
 * Selects the exact complete primary key from one item.
 *
 * @param item - Exact low-level item.
 * @param keySchema - Canonical key schema.
 * @returns Detached exact key map.
 */
function selectAggregateKey(
  item: Readonly<Record<string, AttributeValue>>,
  keySchema: readonly RestoreDrillKeySchemaElement[],
): Record<string, AttributeValue> {
  const key: Record<string, AttributeValue> = {}
  for (const element of keySchema) {
    const value = item[element.attributeName]
    if (value === undefined) throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    Object.defineProperty(key, element.attributeName, {
      configurable: true,
      enumerable: true,
      value: cloneAttributeValue(value, 'AWS_RESPONSE_INVALID'),
      writable: true,
    })
  }
  return key
}

/**
 * Selects the exact partition key from one item.
 *
 * @param item - Exact low-level item.
 * @param keySchema - Canonical key schema.
 * @returns Detached exact partition key map.
 */
function selectAggregatePartitionKey(
  item: Readonly<Record<string, AttributeValue>>,
  keySchema: readonly RestoreDrillKeySchemaElement[],
): Record<string, AttributeValue> {
  const partition = keySchema.find((entry) => entry.keyType === 'HASH')
  if (!partition) throw new RestoreDrillAwsFailure('TABLE_DESCRIPTOR_INVALID')
  const value = item[partition.attributeName]
  if (value === undefined) throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  return { [partition.attributeName]: cloneAttributeValue(value, 'AWS_RESPONSE_INVALID') }
}

/**
 * Removes only dataset-local File object VersionIds before paired aggregate comparison.
 *
 * @param item - Exact detached low-level item.
 * @param target - Logical table target.
 * @returns Portable normalized item.
 */
function normalizePortableItem(
  item: Readonly<Record<string, AttributeValue>>,
  target: RestoreDrillAwsTableTarget,
): Record<string, AttributeValue> {
  const normalized = cloneAttributeMap(item, 'AWS_RESPONSE_INVALID')
  if (target !== 'table:file-proofing') return normalized
  const versions = normalized.versions
  if (versions?.L === undefined) return normalized
  const portableVersions: AttributeValue[] = []
  for (const version of versions.L) {
    const cloned = cloneAttributeValue(version, 'AWS_RESPONSE_INVALID')
    if (cloned.M === undefined) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    const portableMap: Record<string, AttributeValue> = {}
    for (const [name, value] of Object.entries(cloned.M)) {
      if (name !== 'objectVersionId') {
        Object.defineProperty(portableMap, name, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        })
      }
    }
    portableVersions.push({ M: portableMap })
  }
  normalized.versions = { L: portableVersions }
  return normalized
}

/**
 * Validates strict stream bounds.
 *
 * @param limits - Candidate uncompressed byte and record limits.
 */
function validateStreamLimits(limits: RestoreDrillExportStreamLimits): void {
  if (
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1 ||
    limits.maxBytes > 1_073_741_824 ||
    !Number.isSafeInteger(limits.maxRecords) ||
    limits.maxRecords < 1 ||
    limits.maxRecords > 10_000_000
  ) {
    throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
  }
}

/**
 * Checks the canonical base64 representation of a 16-byte MD5 digest.
 *
 * @param value - Candidate checksum.
 * @returns Whether the checksum is canonical base64 MD5.
 */
function isBase64Md5(value: string): boolean {
  return /^[A-Za-z0-9+/]{22}==$/.test(value) &&
    Buffer.from(value, 'base64').byteLength === 16
}

/**
 * Streams exact bytes while validating the final compressed-object MD5.
 *
 * @param body - Exact compressed S3 object stream.
 * @param expectedMd5Checksum - Canonical manifest checksum.
 * @returns Tee stream that fails after EOF when the checksum differs.
 */
async function* verifyMd5ByteStream(
  body: AsyncIterable<Uint8Array>,
  expectedMd5Checksum: string,
): AsyncGenerator<Uint8Array> {
  const hash = createHash('md5')
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    hash.update(chunk)
    yield chunk
  }
  if (hash.digest('base64') !== expectedMd5Checksum) {
    throw new RestoreDrillAwsFailure('EXPORT_CHECKSUM_MISMATCH')
  }
}

/**
 * Reads one bounded UTF-8 JSON object without accepting trailing byte streams.
 *
 * @param body - Exact object byte stream.
 * @param maxBytes - Maximum object bytes.
 * @returns Decoded UTF-8 text.
 */
async function readBoundedUtf8Object(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let byteCount = 0
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    byteCount += chunk.byteLength
    if (byteCount > maxBytes) throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Decodes a bounded UTF-8 newline stream with optional gzip decompression.
 *
 * @param body - Raw byte stream.
 * @param maxBytes - Maximum uncompressed bytes.
 * @param gzip - Whether to apply gzip decompression.
 * @returns Async iterable of complete lines without newline delimiters.
 */
async function* readBoundedUtf8Lines(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  gzip: boolean,
): AsyncGenerator<string> {
  const decodedBody: AsyncIterable<unknown> = gzip
    ? createGzipDecodedStream(body)
    : body
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffered = ''
  let byteCount = 0
  for await (const rawChunk of decodedBody) {
    if (!(rawChunk instanceof Uint8Array)) {
      throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
    }
    byteCount += rawChunk.byteLength
    if (byteCount > maxBytes) throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
    buffered += decoder.decode(rawChunk, { stream: true })
    let newlineIndex = buffered.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, '')
      if (
        Buffer.byteLength(line, 'utf8') >
          Math.min(maxBytes, RESTORE_DRILL_EXPORT_JSON_LINE_MAXIMUM_BYTES)
      ) {
        throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
      }
      yield line
      buffered = buffered.slice(newlineIndex + 1)
      newlineIndex = buffered.indexOf('\n')
    }
    if (
      Buffer.byteLength(buffered, 'utf8') >
        Math.min(maxBytes, RESTORE_DRILL_EXPORT_JSON_LINE_MAXIMUM_BYTES)
    ) {
      throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
    }
  }
  buffered += decoder.decode()
  if (buffered.length > 0) {
    const line = buffered.replace(/\r$/, '')
    if (
      Buffer.byteLength(line, 'utf8') >
        Math.min(maxBytes, RESTORE_DRILL_EXPORT_JSON_LINE_MAXIMUM_BYTES)
    ) {
      throw new RestoreDrillAwsFailure('EXPORT_LIMIT_EXCEEDED')
    }
    yield line
  }
}

/**
 * Creates a gzip decoder that forwards source iterator failures to the decoded stream.
 *
 * @param body - Compressed source byte stream.
 * @returns Decoded Node stream with source errors propagated.
 */
function createGzipDecodedStream(body: AsyncIterable<Uint8Array>): Readable {
  const source = Readable.from(body)
  const decoder = createGunzip()
  /** Forwards a source iterator error into the consumer-facing decoded stream. */
  const forwardError = (error: Error): void => {
    decoder.destroy(error)
  }
  source.on('error', forwardError)
  return source.pipe(decoder)
}

/**
 * Clones and strictly validates one low-level DynamoDB attribute map.
 *
 * @param value - Untrusted map.
 * @param failureCode - Stable failure emitted on malformed input.
 * @returns Detached low-level map.
 */
function cloneAttributeMap(
  value: unknown,
  failureCode: RestoreDrillAwsFailureCode,
): Record<string, AttributeValue> {
  if (!isRecord(value)) throw new RestoreDrillAwsFailure(failureCode)
  const result: Record<string, AttributeValue> = {}
  for (const [name, attribute] of Object.entries(value)) {
    if (name.length === 0) throw new RestoreDrillAwsFailure(failureCode)
    Object.defineProperty(result, name, {
      configurable: true,
      enumerable: true,
      value: cloneAttributeValue(attribute, failureCode),
      writable: true,
    })
  }
  return result
}

/**
 * Clones and strictly validates one low-level DynamoDB attribute value.
 *
 * @param value - Untrusted attribute value.
 * @param failureCode - Stable failure emitted on malformed input.
 * @returns Detached low-level attribute value.
 */
function cloneAttributeValue(
  value: unknown,
  failureCode: RestoreDrillAwsFailureCode,
): AttributeValue {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new RestoreDrillAwsFailure(failureCode)
  }
  if (typeof value.S === 'string') return { S: value.S }
  if (typeof value.N === 'string' && isDynamoNumber(value.N)) return { N: value.N }
  if (typeof value.BOOL === 'boolean') return { BOOL: value.BOOL }
  if (value.NULL === true) return { NULL: true }
  if (value.B instanceof Uint8Array) return { B: Uint8Array.from(value.B) }
  if (typeof value.B === 'string') {
    return { B: decodeCanonicalBase64(value.B, failureCode) }
  }
  if (Array.isArray(value.SS) && value.SS.every((entry) => typeof entry === 'string')) {
    return { SS: [...value.SS] }
  }
  if (Array.isArray(value.NS) && value.NS.every(
    (entry) => typeof entry === 'string' && isDynamoNumber(entry),
  )) {
    return { NS: [...value.NS] }
  }
  if (Array.isArray(value.BS) && value.BS.every(
    (entry) => entry instanceof Uint8Array || typeof entry === 'string',
  )) {
    const values: Uint8Array[] = []
    for (const entry of value.BS) {
      values.push(entry instanceof Uint8Array
        ? Uint8Array.from(entry)
        : decodeCanonicalBase64(entry, failureCode))
    }
    return { BS: values }
  }
  if (Array.isArray(value.L)) {
    return { L: value.L.map((entry) => cloneAttributeValue(entry, failureCode)) }
  }
  if (isRecord(value.M)) return { M: cloneAttributeMap(value.M, failureCode) }
  throw new RestoreDrillAwsFailure(failureCode)
}

/**
 * Decodes one canonical padded base64 value emitted by DynamoDB export JSON.
 *
 * @param value - Untrusted base64 text.
 * @param failureCode - Stable failure emitted on malformed input.
 * @returns Detached decoded bytes.
 */
function decodeCanonicalBase64(
  value: string,
  failureCode: RestoreDrillAwsFailureCode,
): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new RestoreDrillAwsFailure(failureCode)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new RestoreDrillAwsFailure(failureCode)
  }
  return Uint8Array.from(decoded)
}

/**
 * Checks one canonical DynamoDB number string without converting its precision.
 *
 * @param value - Candidate DynamoDB number.
 * @returns Whether the value uses canonical accepted number syntax.
 */
function isDynamoNumber(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(value)
}

/**
 * Decodes one low-level map for strict domain parsing of File rows.
 *
 * @param value - Exact low-level map.
 * @returns Detached native record.
 */
function decodeAttributeMap(
  value: Readonly<Record<string, AttributeValue>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, attribute] of Object.entries(value)) {
    Object.defineProperty(result, name, {
      configurable: true,
      enumerable: true,
      value: decodeAttributeValue(attribute),
      writable: true,
    })
  }
  return result
}

/**
 * Decodes one validated low-level value for File domain parsing.
 *
 * @param value - Low-level attribute value.
 * @returns Detached native value.
 */
function decodeAttributeValue(value: AttributeValue): unknown {
  const cloned = cloneAttributeValue(value, 'FILE_ROW_INVALID')
  if (cloned.S !== undefined) return cloned.S
  if (cloned.N !== undefined) {
    const number = Number(cloned.N)
    if (!Number.isSafeInteger(number) && !Number.isFinite(number)) {
      throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
    }
    return number
  }
  if (cloned.BOOL !== undefined) return cloned.BOOL
  if (cloned.NULL === true) return null
  if (cloned.B !== undefined) return Uint8Array.from(cloned.B)
  if (cloned.SS !== undefined) return [...cloned.SS]
  if (cloned.NS !== undefined) return cloned.NS.map(Number)
  if (cloned.BS !== undefined) return cloned.BS.map((entry) => Uint8Array.from(entry))
  if (cloned.L !== undefined) return cloned.L.map(decodeAttributeValue)
  if (cloned.M !== undefined) return decodeAttributeMap(cloned.M)
  throw new RestoreDrillAwsFailure('FILE_ROW_INVALID')
}

/**
 * Serializes one exact low-level map with recursively sorted map keys.
 *
 * @param value - Exact low-level map.
 * @returns Canonical JSON text.
 */
function serializeAttributeMap(
  value: Readonly<Record<string, AttributeValue>>,
): string {
  const entries = Object.entries(value).sort(compareAttributeEntries)
  return `{${entries.map(([name, attribute]) =>
    `${JSON.stringify(name)}:${serializeAttributeValue(attribute)}`).join(',')}}`
}

/** Sorts low-level attribute-map entries by attribute name. */
function compareAttributeEntries(
  left: [string, AttributeValue],
  right: [string, AttributeValue],
): number {
  return compareUtf8Ordinal(left[0], right[0])
}

/**
 * Compares strings by their UTF-8 bytes without consulting process locale.
 *
 * @param left - Left string.
 * @param right - Right string.
 * @returns Negative, zero, or positive ordinal comparison.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Checks that a string vector is strictly increasing in canonical UTF-8 order.
 *
 * @param values - Candidate canonical string vector.
 * @returns Whether every value is unique and strictly ordered.
 */
function isSortedUniqueStrings(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined) return false
    if (compareUtf8Ordinal(previous, current) >= 0) return false
  }
  return true
}

/**
 * Serializes one exact low-level attribute value without numeric precision loss.
 *
 * @param value - Low-level attribute value.
 * @returns Canonical JSON fragment.
 */
function serializeAttributeValue(value: AttributeValue): string {
  const cloned = cloneAttributeValue(value, 'AWS_RESPONSE_INVALID')
  if (cloned.S !== undefined) return `{"S":${JSON.stringify(cloned.S)}}`
  if (cloned.N !== undefined) return `{"N":${JSON.stringify(cloned.N)}}`
  if (cloned.BOOL !== undefined) return `{"BOOL":${cloned.BOOL ? 'true' : 'false'}}`
  if (cloned.NULL === true) return '{"NULL":true}'
  if (cloned.B !== undefined) {
    return `{"B":${JSON.stringify(Buffer.from(cloned.B).toString('base64'))}}`
  }
  if (cloned.SS !== undefined) {
    return `{"SS":${JSON.stringify([...cloned.SS].sort(compareUtf8Ordinal))}}`
  }
  if (cloned.NS !== undefined) {
    return `{"NS":${JSON.stringify([...cloned.NS].sort(compareUtf8Ordinal))}}`
  }
  if (cloned.BS !== undefined) {
    const binaries = cloned.BS
      .map((entry) => Buffer.from(entry).toString('base64'))
      .sort(compareUtf8Ordinal)
    return `{"BS":${JSON.stringify(binaries)}}`
  }
  if (cloned.L !== undefined) {
    return `{"L":[${cloned.L.map(serializeAttributeValue).join(',')}]}`
  }
  if (cloned.M !== undefined) return `{"M":${serializeAttributeMap(cloned.M)}}`
  throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
}


/**
 * Parses and verifies a successful RestoreTableToPointInTime response.
 *
 * @param output - Raw restore response.
 * @param target - Logical dataset target.
 * @param sourceTableArn - Exact source ARN.
 * @param restorePoint - Exact requested restore point.
 * @param tableName - Deterministic target name.
 * @returns Exact recorded restore identity.
 */
function parseStartedRestore(
  output: RestoreTableToPointInTimeCommandOutput,
  target: RestoreDrillAwsTableTarget,
  sourceTableArn: string,
  restorePoint: string,
  tableName: string,
): RestoreDrillRecordedRestoreTable {
  return parseRestoreDescription(
    output.TableDescription,
    target,
    sourceTableArn,
    restorePoint,
    tableName,
  )
}

/**
 * Parses and verifies a DescribeTable response used for ambiguous-success adoption.
 *
 * @param output - Raw table response.
 * @param target - Logical dataset target.
 * @param sourceTableArn - Exact source ARN.
 * @param restorePoint - Exact requested restore point.
 * @param tableName - Deterministic target name.
 * @returns Exact recorded restore identity.
 */
function parseAdoptedRestore(
  output: DescribeTableCommandOutput,
  target: RestoreDrillAwsTableTarget,
  sourceTableArn: string,
  restorePoint: string,
  tableName: string,
): RestoreDrillRecordedRestoreTable {
  return parseRestoreDescription(
    output.Table,
    target,
    sourceTableArn,
    restorePoint,
    tableName,
  )
}

/**
 * Parses exact immutable restore identity and RestoreSummary binding fields.
 *
 * @param description - Raw table description.
 * @param target - Logical dataset target.
 * @param sourceTableArn - Exact source ARN.
 * @param restorePoint - Exact requested restore point.
 * @param tableName - Deterministic target name.
 * @returns Exact recorded restore identity.
 */
function parseRestoreDescription(
  description: DescribeTableCommandOutput['Table'],
  target: RestoreDrillAwsTableTarget,
  sourceTableArn: string,
  restorePoint: string,
  tableName: string,
): RestoreDrillRecordedRestoreTable {
  if (
    description?.TableName !== tableName ||
    typeof description.TableArn !== 'string' ||
    description.TableArn.length === 0 ||
    typeof description.TableId !== 'string' ||
    description.TableId.length === 0 ||
    description.RestoreSummary?.SourceTableArn !== sourceTableArn ||
    !(description.RestoreSummary.RestoreDateTime instanceof Date) ||
    description.RestoreSummary.RestoreDateTime.getTime() !== new Date(restorePoint).getTime()
  ) {
    throw new RestoreDrillAwsFailure('RESTORE_IDENTITY_MISMATCH')
  }
  const targetArn = parseDynamoDbTableArn(description.TableArn)
  if (targetArn.tableName !== tableName) {
    throw new RestoreDrillAwsFailure('RESTORE_IDENTITY_MISMATCH')
  }
  return {
    kind: 'restore-table',
    target,
    sourceTableArn,
    restorePoint,
    tableName,
    tableArn: description.TableArn,
    tableId: description.TableId,
  }
}

/**
 * Verifies that a current table description still names the exact recorded restore.
 *
 * @param output - Current DescribeTable response.
 * @param recorded - Exact recorded identity.
 */
function requireExactRestoreIdentity(
  output: DescribeTableCommandOutput,
  recorded: RestoreDrillRecordedRestoreTable,
): void {
  const current = parseAdoptedRestore(
    output,
    recorded.target,
    recorded.sourceTableArn,
    recorded.restorePoint,
    recorded.tableName,
  )
  if (current.tableArn !== recorded.tableArn || current.tableId !== recorded.tableId) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
}

/**
 * Validates a structurally supplied restore table before it can reach cleanup.
 *
 * @param table - Candidate recorded restore table.
 * @param prefix - Configured deterministic target prefix.
 */
function requireRecordedRestoreTable(
  table: RestoreDrillRecordedRestoreTable,
  configuration: RestoreDrillAwsConfiguration,
): void {
  const expectedPrefix = configuration.restoreTablePrefix.endsWith('-')
    ? configuration.restoreTablePrefix
    : `${configuration.restoreTablePrefix}-`
  if (
    table.kind !== 'restore-table' ||
    !RESTORE_DRILL_AWS_TABLE_TARGETS.includes(table.target) ||
    typeof table.tableName !== 'string' ||
    !table.tableName.startsWith(expectedPrefix) ||
    typeof table.tableArn !== 'string' ||
    typeof table.tableId !== 'string' ||
    typeof table.sourceTableArn !== 'string'
  ) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
  const targetArn = parseDynamoDbTableArn(table.tableArn)
  const sourceArn = parseDynamoDbTableArn(table.sourceTableArn)
  if (
    targetArn.accountId !== configuration.accountId ||
    targetArn.region !== configuration.region ||
    targetArn.tableName !== table.tableName ||
    sourceArn.accountId !== configuration.accountId ||
    sourceArn.region !== configuration.region
  ) {
    throw new RestoreDrillAwsFailure('CLEANUP_IDENTITY_MISMATCH')
  }
  readCanonicalTimestamp(table.restorePoint)
}

/**
 * Verifies exact export request identity against a raw DynamoDB description.
 *
 * @param description - Raw export description.
 * @param recorded - Expected export identity.
 * @param configuration - Explicit scratch resource configuration.
 */
function requireExactExportDescription(
  description: DescribeExportCommandOutput['ExportDescription'],
  recorded: RestoreDrillRecordedExport,
  configuration: RestoreDrillAwsConfiguration,
): NonNullable<DescribeExportCommandOutput['ExportDescription']> {
  if (
    description === undefined ||
    description.ExportArn !== recorded.exportArn ||
    description.TableArn !== recorded.sourceTableArn ||
    description.TableId !== recorded.sourceTableId ||
    !(description.ExportTime instanceof Date) ||
    description.ExportTime.getTime() !== new Date(recorded.exportPoint).getTime() ||
    description.ClientToken !== recorded.clientToken ||
    description.S3Bucket !== configuration.scratchBucketName ||
    description.S3Prefix !== recorded.scratchPrefix ||
    description.S3SseAlgorithm !== 'KMS' ||
    description.S3SseKmsKeyId !== configuration.scratchKmsKeyArn ||
    description.ExportFormat !== 'DYNAMODB_JSON' ||
    (description.ExportType !== undefined && description.ExportType !== 'FULL_EXPORT')
  ) {
    throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
  }
  return description
}

/**
 * Validates one structurally supplied export record against fixed scratch configuration.
 *
 * @param record - Candidate exact export identity.
 * @param configuration - Fixed scratch configuration.
 */
function requireRecordedExport(
  record: RestoreDrillRecordedExport,
  configuration: RestoreDrillAwsConfiguration,
): void {
  if (
    record.kind !== 'table-export' ||
    !RESTORE_DRILL_AWS_TABLE_TARGETS.includes(record.target) ||
    !/^[a-f0-9]{64}$/.test(record.clientToken) ||
    typeof record.exportArn !== 'string' ||
    record.exportArn.length === 0 ||
    typeof record.sourceTableArn !== 'string' ||
    record.sourceTableArn.length === 0 ||
    typeof record.sourceTableId !== 'string' ||
    record.sourceTableId.length === 0 ||
    !record.scratchPrefix.startsWith('restore-drill/') ||
    record.scratchPrefix.includes('..') ||
    configuration.scratchBucketName.length === 0
  ) {
    throw new RestoreDrillAwsFailure('EXPORT_IDENTITY_MISMATCH')
  }
  readCanonicalTimestamp(record.exportPoint)
}

/**
 * Validates a measured source observation against the fixed logical allowlist.
 *
 * @param source - Candidate source observation.
 * @param configuration - Fixed source table allowlist.
 */
function validateSourceObservation(
  source: RestoreDrillSourceTableObservation,
  configuration: RestoreDrillAwsConfiguration,
): void {
  const sourceArn = parseDynamoDbTableArn(source.sourceTableArn)
  if (
    !RESTORE_DRILL_AWS_TABLE_TARGETS.includes(source.target) ||
    sourceArn.accountId !== configuration.accountId ||
    sourceArn.region !== configuration.region ||
    sourceArn.tableName !== configuration.sourceTables[source.target]
  ) {
    throw new RestoreDrillAwsFailure('RESTORE_IDENTITY_MISMATCH')
  }
  readCanonicalTimestamp(source.earliestRestorableAt)
  readCanonicalTimestamp(source.latestRestorableAt)
}

/** Strict components of one DynamoDB base-table ARN. */
type ParsedDynamoDbTableArn = {
  /** Twelve-digit owning account. */
  readonly accountId: string
  /** AWS Region. */
  readonly region: string
  /** Exact physical base-table name without export or index suffixes. */
  readonly tableName: string
}

/**
 * Strictly parses a DynamoDB base-table ARN and rejects suffix substitution.
 *
 * @param value - Candidate table ARN.
 * @returns Exact account, Region, and table name.
 */
function parseDynamoDbTableArn(value: string): ParsedDynamoDbTableArn {
  const parts = value.split(':')
  const resource = parts[5]
  if (
    parts.length !== 6 ||
    parts[0] !== 'arn' ||
    parts[1] !== 'aws' ||
    parts[2] !== 'dynamodb' ||
    !parts[3] ||
    !parts[4] ||
    !/^\d{12}$/.test(parts[4]) ||
    !resource ||
    !resource.startsWith('table/')
  ) {
    throw new RestoreDrillAwsFailure('RESTORE_IDENTITY_MISMATCH')
  }
  const tableName = resource.slice('table/'.length)
  if (!isDynamoDbTableName(tableName) || tableName.includes('/')) {
    throw new RestoreDrillAwsFailure('RESTORE_IDENTITY_MISMATCH')
  }
  return { accountId: parts[4], region: parts[3], tableName }
}

/**
 * Derives a deterministic isolated target table name without exposing the drill identifier.
 *
 * @param prefix - Configured isolated table prefix.
 * @param drillId - Stable drill identifier.
 * @param target - Logical table target.
 * @returns Portable DynamoDB target table name.
 */
export function createRestoreDrillTargetTableName(
  prefix: string,
  drillId: string,
  target: RestoreDrillAwsTableTarget,
): string {
  return createRestoreTableName(prefix, drillId, target)
}

/**
 * Derives a deterministic isolated target table name after strict validation.
 *
 * @param prefix - Configured isolated table prefix.
 * @param drillId - Stable drill identifier.
 * @param target - Logical table target.
 * @returns Portable DynamoDB target table name.
 */
function createRestoreTableName(
  prefix: string,
  drillId: string,
  target: RestoreDrillAwsTableTarget,
): string {
  if (
    !/^[A-Za-z0-9_.-]{3,80}$/.test(prefix) ||
    !RESTORE_DRILL_AWS_TABLE_TARGETS.includes(target)
  ) {
    throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
  }
  const drillDigest = createDrillDigest(drillId)
  const logicalName = target.startsWith('table:') ? target.slice('table:'.length) : ''
  const separator = prefix.endsWith('-') ? '' : '-'
  const name = `${prefix}${separator}${drillDigest}-${logicalName}`
  if (!isDynamoDbTableName(name)) {
    throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
  }
  return name
}

/**
 * Creates a short deterministic drill digest used only in isolated resource addresses.
 *
 * @param drillId - Stable drill identifier.
 * @returns Sixteen-character lowercase hexadecimal digest.
 */
function createDrillDigest(drillId: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(drillId)) {
    throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
  }
  return createHexDigest(`drill\u0000${drillId}`).slice(0, 16)
}

/**
 * Creates one SHA-256 hexadecimal digest.
 *
 * @param value - Domain-separated UTF-8 input.
 * @returns Lowercase hexadecimal digest.
 */
function createHexDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Reads one exact canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Canonical timestamp.
 */
function readCanonicalTimestamp(value: string): string {
  const parsed = new Date(value)
  if (
    typeof value !== 'string' ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new RestoreDrillAwsFailure('AWS_RESPONSE_INVALID')
  }
  return value
}

/**
 * Checks an unknown caught value for one stable AWS error name.
 *
 * @param error - Unknown caught value.
 * @param name - Exact SDK error name.
 * @returns Whether the value exposes only the expected stable name.
 */
function isAwsErrorNamed(error: unknown, name: string): boolean {
  return isRecord(error) && error.name === name
}

/**
 * Checks whether an unknown value is a non-null record.
 *
 * @param value - Unknown value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates the exact encryption context binding a digest key to one drill.
 *
 * @param drillId - Stable drill identifier.
 * @returns Fixed context map sent to both Encrypt and Decrypt.
 */
function createDigestKeyEncryptionContext(drillId: string): Record<string, string> {
  return {
    purpose: 'restore-drill-evidence-digest-v1',
    drillIdDigest: createHexDigest(`digest-key\u0000${drillId}`),
  }
}

/**
 * Validates one ciphertext-only digest key envelope.
 *
 * @param envelope - Candidate envelope.
 * @param expectedKmsKeyArn - Exact configured KMS key ARN.
 */
function requireDigestKeyEnvelope(
  envelope: RestoreDrillDigestKeyEnvelope,
  expectedKmsKeyArn: string,
): void {
  if (
    envelope.kind !== 'restore-drill-digest-key' ||
    envelope.kmsKeyArn !== expectedKmsKeyArn ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertextBase64) ||
    envelope.ciphertextBase64.length > 16_384
  ) {
    throw new RestoreDrillAwsFailure('CONFIGURATION_INVALID')
  }
}
