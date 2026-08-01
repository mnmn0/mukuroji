import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import {
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeExportCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
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
  RESTORE_DRILL_AWS_TABLE_TARGETS,
  RestoreDrillAwsFailure,
  RestoreDrillDynamoAggregateAccumulator,
  consumeRestoreDrillExportData,
  createRestoreDrillAwsOperations,
  createRestoreDrillTargetTableName,
  parseRestoreDrillExportFilesManifest,
  parseRestoreDrillExportSummary,
  readRestoreDrillAwsCleanupConfiguration,
  verifyRestoreDrillExportManifestChecksum,
  verifyRestoreDrillFileVersionProof,
  type RestoreDrillAwsConfiguration,
  type RestoreDrillDynamoDbTransport,
  type RestoreDrillFileVersionProof,
  type RestoreDrillGetObjectOutput,
  type RestoreDrillKmsTransport,
  type RestoreDrillRecordedExportObjectVersion,
  type RestoreDrillRecordedScratchObjectVersion,
  type RestoreDrillRecordedRestoreTable,
  type RestoreDrillS3Transport,
  type RestoreDrillSourceFileVersion,
  type RestoreDrillSourceTableObservation,
  type RestoreDrillVerifyCreatedFileVersionResult,
} from './restore-drill-aws'
import {
  RESTORE_DRILL_FILE_RANGE_SIZE_BYTES,
  type RestoreDrillFileRangeCheckpoint,
} from './restore-drill-file-range'

const ACCOUNT_ID = '123456789012'
const REGION = 'ap-northeast-1'
const RESTORE_POINT = '2026-08-01T00:00:00.000Z'
const DRILL_ID = 'drill-20260801'
const SOURCE_VERSION_ID = 'source-version-1'
const DESTINATION_VERSION_ID = 'destination-version-1'
const OBJECT_KEY =
  'workspaces/workspace-1/files/file-1/version-1/design.pdf'
const FILE_PROOF_KEY = new Uint8Array(32).fill(17)

/** Creates structurally valid source and destination proof fixtures. */
function createRecordedFileProofs(): {
  /** Destination-role proof fixture. */
  readonly destinationProof: RestoreDrillFileVersionProof
  /** Source-role proof fixture. */
  readonly sourceProof: RestoreDrillFileVersionProof
} {
  const comparable: Pick<
    RestoreDrillFileVersionProof,
    'contentDigest' | 'metadataDigest' | 'physicalIdentityDigest' | 'proofVersion' |
      'tagsDigest'
  > = {
    contentDigest: 'a'.repeat(64),
    metadataDigest: 'b'.repeat(64),
    physicalIdentityDigest: 'f'.repeat(64),
    proofVersion: 1,
    tagsDigest: 'c'.repeat(64),
  }
  return {
    destinationProof: {
      ...comparable,
      proofMac: 'd'.repeat(64),
      role: 'destination',
    },
    sourceProof: {
      ...comparable,
      proofMac: 'e'.repeat(64),
      role: 'source',
    },
  }
}

/** Valid explicit resource fixture shared by adapter tests. */
const CONFIGURATION: RestoreDrillAwsConfiguration = {
  accountId: ACCOUNT_ID,
  region: REGION,
  restoreTablePrefix: 'mukuroji-restore-drill-',
  stateTableName: 'restore-drill-state',
  evidenceBucketName: 'restore-drill-evidence',
  evidenceKmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence-key`,
  auditPseudonymSecretArn:
    `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:audit-key`,
  metricNamespace: 'Mukuroji/RestoreDrill',
  scratchBucketName: 'restore-drill-scratch',
  scratchKmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/scratch-key`,
  sourceFileBucketName: 'mukuroji-files',
  sourceTables: {
    'table:audit-events': 'audit-events',
    'table:file-proofing': 'file-proofing',
    'table:project-directory': 'project-directory',
    'table:work-item-configuration': 'work-item-configuration',
    'table:work-items': 'work-items',
    'table:workspace-access': 'workspace-access',
  },
}

/** In-memory DynamoDB transport retaining exact commands. */
class FixtureDynamoDbTransport implements RestoreDrillDynamoDbTransport {
  /** Earliest PITR boundary returned by the fixture. */
  earliestRestorableDateTime = new Date('2026-07-01T00:00:00.000Z')

  /** Latest PITR boundary returned by the fixture. */
  latestRestorableDateTime = new Date(RESTORE_POINT)

  /** Exact delete commands. */
  readonly deletes: DeleteTableCommand[] = []

  /** Exact export commands. */
  readonly exports: ExportTableToPointInTimeCommand[] = []

  /** Exact restore commands. */
  readonly restores: RestoreTableToPointInTimeCommand[] = []

  /** Exact scan commands. */
  readonly scans: ScanCommand[] = []

  /** Exact strong read commands used to reconcile an ambiguous remap. */
  readonly gets: GetItemCommand[] = []

  /** Exact conditional update commands used to remap isolated File rows. */
  readonly updates: UpdateItemCommand[] = []

  /** Whether the next restore simulates response loss after creation. */
  restoreResponseLoss = false

  /** Optional DeleteTable failure timing used to exercise exact reconciliation. */
  deleteTableFailureMode?: 'before-apply' | 'response-lost-deleting' |
    'response-lost-missing'

  /** Whether the next File remap simulates response loss after applying the update. */
  updateResponseLoss = false

  /** Whether adoption returns a substituted source ARN. */
  adoptionSourceMismatch = false

  /** Optional service manifest pointer override used by identity tests. */
  exportManifestOverride?: string

  /** Whether the recorded restore table is absent. */
  restoreMissing = false

  /** Configured scan pages. */
  scanPages: ScanCommandOutput[] = []

  /** Source descriptor encryption transition returned by DescribeTable. */
  tableSseStatus: 'DISABLED' | 'DISABLING' | 'ENABLED' | 'ENABLING' | 'UPDATING' =
    'ENABLED'

  /** Source descriptor TTL lifecycle returned by DescribeTimeToLive. */
  tableTtlStatus: 'DISABLED' | 'DISABLING' | 'ENABLED' | 'ENABLING' = 'ENABLED'

  /** Last deterministic restore table description. */
  private restoreDescription?: NonNullable<DescribeTableCommandOutput['Table']>

  /** Current isolated File row returned during ambiguous-success reconciliation. */
  private currentFileItem?: Record<string, AttributeValue>

  /** Deletes one exact table and leaves it converging for the next poll. */
  async deleteTable(command: DeleteTableCommand): Promise<DeleteTableCommandOutput> {
    this.deletes.push(command)
    if (this.deleteTableFailureMode === 'before-apply') throw { name: 'TimeoutError' }
    if (this.deleteTableFailureMode === 'response-lost-deleting') {
      if (!this.restoreDescription) throw new Error('Expected a restore description.')
      this.restoreDescription = { ...this.restoreDescription, TableStatus: 'DELETING' }
      throw { name: 'TimeoutError' }
    }
    this.restoreMissing = true
    if (this.deleteTableFailureMode === 'response-lost-missing') {
      throw { name: 'TimeoutError' }
    }
    return { $metadata: {}, TableDescription: this.restoreDescription }
  }

  /** Returns an enabled fixed PITR window. */
  async describeContinuousBackups(
    _command: DescribeContinuousBackupsCommand,
  ): Promise<DescribeContinuousBackupsCommandOutput> {
    return {
      $metadata: {},
      ContinuousBackupsDescription: {
        ContinuousBackupsStatus: 'ENABLED',
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: 'ENABLED',
          EarliestRestorableDateTime: this.earliestRestorableDateTime,
          LatestRestorableDateTime: this.latestRestorableDateTime,
        },
      },
    }
  }

  /** Returns a completed exact export description from the last command. */
  async describeExport(
    command: DescribeExportCommand,
  ): Promise<DescribeExportCommandOutput> {
    const start = this.exports[0]
    if (!start) return { $metadata: {} }
    const description = createExportDescription(start, command.input.ExportArn)
    return {
      $metadata: {},
      ExportDescription: this.exportManifestOverride
        ? { ...description, ExportManifest: this.exportManifestOverride }
        : description,
    }
  }

  /** Returns source descriptors or the exact deterministic restore description. */
  async describeTable(command: DescribeTableCommand): Promise<DescribeTableCommandOutput> {
    const tableName = command.input.TableName ?? ''
    if (tableName.startsWith(CONFIGURATION.restoreTablePrefix)) {
      if (this.restoreMissing) throw { name: 'ResourceNotFoundException' }
      if (!this.restoreDescription) return { $metadata: {} }
      const restoreSummary = this.restoreDescription.RestoreSummary
      if (!restoreSummary) return { $metadata: {} }
      return {
        $metadata: {},
        Table: this.adoptionSourceMismatch
          ? {
              ...this.restoreDescription,
              RestoreSummary: {
                SourceTableArn:
                  `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/substituted`,
                SourceBackupArn: restoreSummary.SourceBackupArn,
                RestoreDateTime: restoreSummary.RestoreDateTime,
                RestoreInProgress: restoreSummary.RestoreInProgress,
              },
            }
          : this.restoreDescription,
      }
    }
    const table = createTableDescription(tableName)
    return {
      $metadata: {},
      Table: {
        ...table,
        SSEDescription: {
          ...table.SSEDescription,
          Status: this.tableSseStatus,
        },
      },
    }
  }

  /** Returns enabled TTL on `expiresAt`. */
  async describeTimeToLive(
    _command: DescribeTimeToLiveCommand,
  ): Promise<DescribeTimeToLiveCommandOutput> {
    return {
      $metadata: {},
      TimeToLiveDescription: {
        TimeToLiveStatus: this.tableTtlStatus,
        ...(this.tableTtlStatus === 'DISABLED' ? {} : { AttributeName: 'expiresAt' }),
      },
    }
  }

  /** Starts and echoes an exact idempotent export. */
  async exportTableToPointInTime(
    command: ExportTableToPointInTimeCommand,
  ): Promise<ExportTableToPointInTimeCommandOutput> {
    this.exports.push(command)
    return {
      $metadata: {},
      ExportDescription: createExportDescription(
        command,
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/work-items/export/export-1`,
      ),
    }
  }

  /** Starts a deterministic restore and optionally loses the response. */
  async restoreTableToPointInTime(
    command: RestoreTableToPointInTimeCommand,
  ): Promise<RestoreTableToPointInTimeCommandOutput> {
    this.restores.push(command)
    const tableName = command.input.TargetTableName ?? ''
    this.restoreDescription = {
      ...createTableDescription(tableName),
      TableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${tableName}`,
      TableId: 'restore-table-id',
      RestoreSummary: {
        SourceTableArn: command.input.SourceTableArn,
        RestoreDateTime: command.input.RestoreDateTime,
        RestoreInProgress: true,
      },
    }
    if (this.restoreResponseLoss) throw { name: 'TimeoutError' }
    return { $metadata: {}, TableDescription: this.restoreDescription }
  }

  /** Returns the next configured strongly consistent page. */
  async scan(command: ScanCommand): Promise<ScanCommandOutput> {
    this.scans.push(command)
    return this.scanPages.shift() ?? {
      $metadata: {}, Items: [], Count: 0, ScannedCount: 0,
    }
  }

  /** Returns the current isolated File row through one strong exact-key read. */
  async getItem(command: GetItemCommand): Promise<GetItemCommandOutput> {
    this.gets.push(command)
    return { $metadata: {}, Item: this.currentFileItem }
  }

  /** Applies one isolated File versions remap and optionally loses its response. */
  async updateItem(command: UpdateItemCommand): Promise<UpdateItemCommandOutput> {
    this.updates.push(command)
    const remappedVersions = command.input.ExpressionAttributeValues?.[':remappedVersions']
    if (remappedVersions === undefined) throw new Error('Expected remapped versions.')
    this.currentFileItem = {
      ...createRawFileRow(),
      versions: remappedVersions,
    }
    if (this.updateResponseLoss) throw { name: 'TimeoutError' }
    return { $metadata: {}, Attributes: this.currentFileItem }
  }
}

/** In-memory KMS transport with inspectable exact request and response identity. */
class FixtureKmsTransport implements RestoreDrillKmsTransport {
  /** Captured decrypt commands. */
  readonly decrypts: DecryptCommand[] = []

  /** Captured encrypt commands. */
  readonly encrypts: EncryptCommand[] = []

  /** Algorithm returned from Decrypt. */
  decryptAlgorithm: DecryptCommandOutput['EncryptionAlgorithm'] = 'SYMMETRIC_DEFAULT'

  /** Key ARN returned from Decrypt. */
  decryptKeyId: string | undefined = CONFIGURATION.evidenceKmsKeyArn

  /** Algorithm returned from Encrypt. */
  encryptAlgorithm: EncryptCommandOutput['EncryptionAlgorithm'] = 'SYMMETRIC_DEFAULT'

  /** Key ARN returned from Encrypt. */
  encryptKeyId: string | undefined = CONFIGURATION.evidenceKmsKeyArn

  /** Last mutable plaintext returned to the adapter. */
  lastPlaintext?: Uint8Array

  /** Returns one controlled plaintext response. */
  async decrypt(command: DecryptCommand): Promise<DecryptCommandOutput> {
    this.decrypts.push(command)
    this.lastPlaintext = new Uint8Array(32).fill(29)
    return {
      $metadata: {},
      Plaintext: this.lastPlaintext,
      KeyId: this.decryptKeyId,
      EncryptionAlgorithm: this.decryptAlgorithm,
    }
  }

  /** Returns one controlled ciphertext response. */
  async encrypt(command: EncryptCommand): Promise<EncryptCommandOutput> {
    this.encrypts.push(command)
    return {
      $metadata: {},
      CiphertextBlob: new Uint8Array([1, 2, 3, 4]),
      KeyId: this.encryptKeyId,
      EncryptionAlgorithm: this.encryptAlgorithm,
    }
  }
}

/** In-memory S3 transport with deterministic exact-version behavior. */
class FixtureS3Transport implements RestoreDrillS3Transport {
  /** Captured exact multipart abort commands. */
  readonly aborts: AbortMultipartUploadCommand[] = []

  /** Captured copy commands. */
  readonly copies: CopyObjectCommand[] = []

  /** Captured delete commands. */
  readonly deletes: DeleteObjectCommand[] = []

  /** Captured exact-version ranged GET commands. */
  readonly gets: GetObjectCommand[] = []

  /** Captured metadata-only exact-version existence checks. */
  readonly attributeReads: GetObjectAttributesCommand[] = []

  /** Scratch VersionIds currently present at the canonical key. */
  readonly scratchVersions: string[] = []

  /** Optional exact list pages consumed before default listing behavior. */
  readonly listPages: ListObjectVersionsCommandOutput[] = []

  /** Optional exact multipart listing pages consumed before default behavior. */
  readonly multipartListPages: ListMultipartUploadsCommandOutput[] = []

  /** Incomplete multipart uploads currently present in scratch. */
  readonly multipartUploads: Array<{ objectKey: string; uploadId: string }> = []

  /** Simulates CopyObject response loss after creating a version. */
  copyResponseLoss = false

  /** Optional DeleteObject failure timing used to exercise exact reconciliation. */
  deleteObjectFailureMode?: 'before-apply' | 'response-lost'

  /** Exact VersionIds one CopyObject call creates, including simulated SDK retries. */
  copyCreatedVersionIds: string[] = [DESTINATION_VERSION_ID]

  /** Makes destination tags differ from the source. */
  destinationTagMismatch = false

  /** Makes destination body bytes differ from the source. */
  destinationBodyMismatch = false

  /** Makes only the selected destination range differ from its source range. */
  destinationMismatchRangeStart?: number

  /** Makes destination expiration metadata differ from the source. */
  destinationExpiresMismatch = false

  /** Simulates S3 recomputing the same checksum algorithm during a multipart copy. */
  destinationChecksumValueMismatch = false

  /** Optional website redirect header present on the immutable source object. */
  sourceWebsiteRedirectLocation?: string

  /** Controls which exact HEAD responses expose the same stored checksum. */
  checksumPresence:
    | 'both'
    | 'destination-only'
    | 'legacy-default'
    | 'source-only' = 'both'

  /** Controls malformed or failing object-body streams returned by GetObject. */
  objectBodyMode: 'empty' | 'error' | 'normal' | 'oversized' | 'truncated' = 'normal'

  /** Exact complete object size echoed by HEAD and ranged GET responses. */
  objectSizeBytes = 7

  /** Generates bounded repeated chunks instead of retaining a complete large fixture body. */
  virtualRangeBody = false

  /** Optional malformed Content-Range response used by exact identity tests. */
  contentRangeOverride?: string

  /** Optional malformed ranged response length adjustment. */
  rangeContentLengthAdjustment = 0

  /** Optional substituted VersionId returned by ranged GET responses. */
  rangedVersionIdOverride?: string

  /** Keeps an aborted upload visible to simulate in-flight part convergence. */
  abortRemainsPending = false

  /** Error name returned when exact-version attributes cannot be read. */
  deletedVersionAttributeErrorName = 'NoSuchVersion'

  /** Exact versions deleted by cleanup. */
  private readonly deletedVersions = new Set<string>()

  /** Aborts one exact incomplete upload or reports that it is already absent. */
  async abortMultipartUpload(
    command: AbortMultipartUploadCommand,
  ): Promise<AbortMultipartUploadCommandOutput> {
    this.aborts.push(command)
    const index = this.multipartUploads.findIndex(
      (upload) =>
        upload.objectKey === command.input.Key &&
        upload.uploadId === command.input.UploadId,
    )
    if (index < 0) throw { name: 'NoSuchUpload' }
    if (!this.abortRemainsPending) this.multipartUploads.splice(index, 1)
    return { $metadata: {} }
  }

  /** Copies one version and optionally loses the response. */
  async copyObject(command: CopyObjectCommand): Promise<CopyObjectCommandOutput> {
    this.copies.push(command)
    this.scratchVersions.push(...this.copyCreatedVersionIds)
    if (this.copyResponseLoss) throw { name: 'TimeoutError' }
    const returnedVersionId = this.copyCreatedVersionIds.at(-1)
    if (!returnedVersionId) throw new Error('Expected one copy VersionId.')
    return {
      $metadata: {},
      CopySourceVersionId: SOURCE_VERSION_ID,
      VersionId: returnedVersionId,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: CONFIGURATION.scratchKmsKeyArn,
    }
  }

  /** Permanently removes one exact version. */
  async deleteObject(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput> {
    this.deletes.push(command)
    if (this.deleteObjectFailureMode === 'before-apply') throw { name: 'TimeoutError' }
    if (command.input.VersionId) this.deletedVersions.add(command.input.VersionId)
    if (this.deleteObjectFailureMode === 'response-lost') throw { name: 'TimeoutError' }
    return { $metadata: {}, VersionId: command.input.VersionId }
  }

  /** Returns a deterministic exact-version body stream. */
  async getObject(command: GetObjectCommand): Promise<RestoreDrillGetObjectOutput> {
    this.gets.push(command)
    const destination = command.input.Bucket === CONFIGURATION.scratchBucketName
    const range = readFixtureRange(command.input.Range, this.objectSizeBytes)
    if (this.objectBodyMode === 'error') {
      return {
        VersionId: this.rangedVersionIdOverride ?? command.input.VersionId,
        ContentLength: range.length + this.rangeContentLengthAdjustment,
        ContentRange: this.contentRangeOverride ?? range.contentRange,
        Body: createFailingByteStream(),
      }
    }
    if (this.virtualRangeBody) {
      const mismatch = destination && (
        this.destinationBodyMismatch ||
        this.destinationMismatchRangeStart === range.start
      )
      return {
        VersionId: this.rangedVersionIdOverride ?? command.input.VersionId,
        ContentLength: range.length + this.rangeContentLengthAdjustment,
        ContentRange: this.contentRangeOverride ?? range.contentRange,
        Body: createRepeatedByteStream(range.length, mismatch ? 2 : 1),
      }
    }
    const bytes = this.objectBodyMode === 'empty'
      ? ''
      : this.objectBodyMode === 'truncated'
        ? 'pay'
        : this.objectBodyMode === 'oversized'
          ? 'payload!'
          : destination && this.destinationBodyMismatch
            ? 'tampered'
            : 'payload'
    return {
      VersionId: this.rangedVersionIdOverride ?? command.input.VersionId,
      ContentLength: range.length + this.rangeContentLengthAdjustment,
      ContentRange: this.contentRangeOverride ?? range.contentRange,
      Body: Readable.from([this.objectBodyMode === 'oversized'
        ? Buffer.from(bytes, 'utf8')
        : Buffer.from(bytes, 'utf8').subarray(range.start, range.end + 1)]),
    }
  }

  /** Returns metadata-only attributes or confirmed exact-version absence. */
  async getObjectAttributes(
    command: GetObjectAttributesCommand,
  ): Promise<GetObjectAttributesCommandOutput> {
    this.attributeReads.push(command)
    if (command.input.VersionId && this.deletedVersions.has(command.input.VersionId)) {
      throw {
        name: this.deletedVersionAttributeErrorName,
        $metadata: { httpStatusCode: 404 },
      }
    }
    return {
      $metadata: {},
      VersionId: command.input.VersionId,
      ObjectSize: this.objectSizeBytes,
    }
  }

  /** Returns complete exact-version tags. */
  async getObjectTagging(
    command: GetObjectTaggingCommand,
  ): Promise<GetObjectTaggingCommandOutput> {
    const destination = command.input.Bucket === CONFIGURATION.scratchBucketName
    return {
      $metadata: {},
      VersionId: command.input.VersionId,
      TagSet: [
        {
          Key: 'GuardDutyMalwareScanStatus',
          Value: destination && this.destinationTagMismatch
            ? 'THREATS_FOUND'
            : 'NO_THREATS_FOUND',
        },
        { Key: 'mukuroji-upload', Value: 'completed' },
      ],
    }
  }

  /** Returns portable exact-version metadata used by copy verification. */
  async headObject(command: HeadObjectCommand): Promise<HeadObjectCommandOutput> {
    if (command.input.VersionId && this.deletedVersions.has(command.input.VersionId)) {
      throw {
        name: this.deletedVersionAttributeErrorName,
        $metadata: { httpStatusCode: 404 },
      }
    }
    const destination = command.input.Bucket === CONFIGURATION.scratchBucketName
    const includeChecksum = this.checksumPresence === 'both' ||
      (this.checksumPresence === 'destination-only' && destination) ||
      (this.checksumPresence === 'source-only' && !destination)
    const includeDefaultChecksum =
      this.checksumPresence === 'legacy-default' && destination
    const checksumType: HeadObjectCommandOutput['ChecksumType'] = 'FULL_OBJECT'
    const websiteRedirectLocation = destination
      ? this.copies.at(-1)?.input.WebsiteRedirectLocation
      : this.sourceWebsiteRedirectLocation
    return {
      $metadata: {},
      VersionId: command.input.VersionId,
      ContentLength: this.objectSizeBytes,
      ContentType: 'application/pdf',
      Expires: new Date(destination && this.destinationExpiresMismatch
        ? '2027-01-02T00:00:00.000Z'
        : '2027-01-01T00:00:00.000Z'),
      WebsiteRedirectLocation: websiteRedirectLocation,
      ...(includeChecksum
        ? {
            ChecksumSHA256:
              destination && this.destinationChecksumValueMismatch
                ? 'recomputed-checksum'
                : 'stored-checksum',
            ChecksumType: checksumType,
          }
        : includeDefaultChecksum
          ? { ChecksumCRC64NVME: 'default-crc64', ChecksumType: checksumType }
        : {}),
      Metadata: { classification: 'internal' },
      ...(destination
        ? {
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: CONFIGURATION.scratchKmsKeyArn,
          }
        : {}),
    }
  }

  /** Lists incomplete uploads for the requested exact prefix. */
  async listMultipartUploads(
    command: ListMultipartUploadsCommand,
  ): Promise<ListMultipartUploadsCommandOutput> {
    const configured = this.multipartListPages.shift()
    if (configured) return configured
    return {
      $metadata: {},
      IsTruncated: false,
      Uploads: this.multipartUploads
        .filter((upload) => upload.objectKey.startsWith(command.input.Prefix ?? ''))
        .map((upload) => ({
          Key: upload.objectKey,
          UploadId: upload.uploadId,
        })),
    }
  }

  /** Lists exact versions for the requested key or prefix. */
  async listObjectVersions(
    command: ListObjectVersionsCommand,
  ): Promise<ListObjectVersionsCommandOutput> {
    const configured = this.listPages.shift()
    if (configured) return configured
    return {
      $metadata: {},
      IsTruncated: false,
      Versions: this.scratchVersions.map((versionId) => ({
        Key: command.input.Prefix,
        VersionId: versionId,
      })),
    }
  }

  /** Reports whether one exact incomplete upload still has an active identity. */
  async listParts(command: ListPartsCommand): Promise<ListPartsCommandOutput> {
    const upload = this.multipartUploads.find(
      (candidate) =>
        candidate.objectKey === command.input.Key &&
        candidate.uploadId === command.input.UploadId,
    )
    if (!upload) throw { name: 'NoSuchUpload' }
    return {
      $metadata: {},
      Bucket: command.input.Bucket,
      Key: command.input.Key,
      UploadId: command.input.UploadId,
      IsTruncated: false,
      Parts: [],
    }
  }
}

/** Exact parsed S3 range fixture. */
type FixtureRange = {
  /** Canonical Content-Range response. */
  readonly contentRange: string
  /** Inclusive final byte offset. */
  readonly end: number
  /** Exact selected byte count. */
  readonly length: number
  /** Inclusive first byte offset. */
  readonly start: number
}

/** Parses the adapter's required exact S3 Range request. */
function readFixtureRange(value: string | undefined, totalBytes: number): FixtureRange {
  const matched = /^bytes=(\d+)-(\d+)$/.exec(value ?? '')
  const start = Number(matched?.[1])
  const end = Number(matched?.[2])
  if (
    !matched ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= totalBytes
  ) throw new Error('Expected one exact bounded Range request.')
  return {
    contentRange: `bytes ${start}-${end}/${totalBytes}`,
    end,
    length: end - start + 1,
    start,
  }
}

/** Creates a bounded-memory byte stream for one arbitrarily large fixture range. */
function createRepeatedByteStream(
  byteLength: number,
  fillByte: number,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const chunk = Buffer.alloc(Math.min(byteLength, 64 * 1_024), fillByte)
      let remaining = byteLength
      while (remaining > 0) {
        const length = Math.min(remaining, chunk.byteLength)
        yield length === chunk.byteLength ? chunk : chunk.subarray(0, length)
        remaining -= length
      }
    },
  }
}

/** Creates an async byte stream that fails without exposing its raw error. */
function createFailingByteStream(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          throw new Error('fixture raw object stream failure')
        },
      }
    },
  }
}

/** Creates one valid canonical source table description. */
function createTableDescription(tableName: string): NonNullable<DescribeTableCommandOutput['Table']> {
  return {
    TableName: tableName,
    TableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${tableName}`,
    TableId: `${tableName}-id`,
    TableStatus: 'ACTIVE',
    ItemCount: 1,
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    SSEDescription: {
      Status: 'ENABLED',
      SSEType: 'KMS',
      KMSMasterKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/table-key`,
    },
    AttributeDefinitions: [{ AttributeName: 'scopeKey', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'scopeKey', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [{
      IndexName: 'ByRecord',
      IndexStatus: 'ACTIVE',
      KeySchema: [{ AttributeName: 'scopeKey', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    }],
  }
}

/** Creates a raw exact export description from one captured command. */
function createExportDescription(
  command: ExportTableToPointInTimeCommand,
  exportArn: string | undefined,
): NonNullable<DescribeExportCommandOutput['ExportDescription']> {
  return {
    ExportArn: exportArn,
    ExportStatus: 'COMPLETED',
    ExportManifest: 'AWSDynamoDB/export-1/manifest-summary.json',
    TableArn: command.input.TableArn,
    TableId: 'work-items-id',
    ExportTime: command.input.ExportTime,
    ClientToken: command.input.ClientToken,
    S3Bucket: command.input.S3Bucket,
    S3BucketOwner: command.input.S3BucketOwner,
    S3Prefix: command.input.S3Prefix,
    S3SseAlgorithm: command.input.S3SseAlgorithm,
    S3SseKmsKeyId: command.input.S3SseKmsKeyId,
    ExportFormat: command.input.ExportFormat,
    ExportType: command.input.ExportType,
    ItemCount: 1,
  }
}

/** Creates one measured source observation for Work Items. */
function createSourceObservation(): RestoreDrillSourceTableObservation {
  return {
    target: 'table:work-items',
    sourceTableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/work-items`,
    earliestRestorableAt: '2026-07-01T00:00:00.000Z',
    latestRestorableAt: RESTORE_POINT,
    descriptor: {
      tableId: 'work-items-id',
      itemCount: 1,
      billingMode: 'PAY_PER_REQUEST',
      sseType: 'KMS',
      sseStatus: 'ENABLED',
      kmsMasterKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/table-key`,
      attributeDefinitions: [{ attributeName: 'scopeKey', attributeType: 'S' }],
      keySchema: [{ attributeName: 'scopeKey', keyType: 'HASH' }],
      globalSecondaryIndexes: [{
        indexName: 'ByRecord',
        status: 'ACTIVE',
        keySchema: [{ attributeName: 'scopeKey', keyType: 'HASH' }],
        projection: { projectionType: 'ALL', nonKeyAttributes: [] },
      }],
      ttlEnabled: true,
      ttlAttribute: 'expiresAt',
      ttlStatus: 'ENABLED',
    },
  }
}

/** Creates one exact recorded File Proofing restore identity. */
function createFileRestoreTable(): RestoreDrillRecordedRestoreTable {
  const tableName = createRestoreDrillTargetTableName(
    CONFIGURATION.restoreTablePrefix,
    DRILL_ID,
    'table:file-proofing',
  )
  return {
    kind: 'restore-table',
    target: 'table:file-proofing',
    tableName,
    tableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${tableName}`,
    tableId: 'restore-table-id',
    sourceTableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/file-proofing`,
    restorePoint: RESTORE_POINT,
  }
}

/** Creates one strict low-level File metadata row. */
function createRawFileRow(): Record<string, AttributeValue> {
  return {
    scopeKey: { S: 'WORKSPACE#workspace-1#TEAM#team-1#WORKITEM#issue-1' },
    recordKey: { S: 'FILE#file-1' },
    entryType: { S: 'file' },
    workspaceId: { S: 'workspace-1' },
    teamId: { S: 'team-1' },
    issueId: { S: 'issue-1' },
    fileId: { S: 'file-1' },
    revision: { N: '1' },
    pendingApprovalCount: { N: '0' },
    name: { S: 'design.pdf' },
    targetType: { S: 'work-item' },
    targetId: { S: 'issue-1' },
    versions: {
      L: [{
        M: {
          id: { S: 'version-1' },
          number: { N: '1' },
          fileName: { S: 'design.pdf' },
          contentType: { S: 'application/pdf' },
          sizeBytes: { N: '7' },
          scanStatus: { S: 'available' },
          previewKind: { S: 'pdf' },
          createdByMemberKey: { S: 'member-1' },
          createdAt: { S: '2026-08-01T00:00:00.000Z' },
          verifiedAt: { S: '2026-08-01T00:01:00.000Z' },
          objectKey: { S: OBJECT_KEY },
          objectVersionId: { S: SOURCE_VERSION_ID },
        },
      }],
    },
    currentVersionId: { S: 'version-1' },
    createdByMemberKey: { S: 'member-1' },
    guestAccess: { BOOL: false },
    createdAt: { S: '2026-08-01T00:00:00.000Z' },
    updatedAt: { S: '2026-08-01T00:01:00.000Z' },
  }
}

/**
 * Creates the strict source File reference represented by the fixture row.
 *
 * @param sizeBytes - Exact complete object size.
 * @returns Strict immutable source version.
 */
function createSourceFileVersion(sizeBytes = 7): RestoreDrillSourceFileVersion {
  return {
    versionId: 'version-1',
    objectKey: OBJECT_KEY,
    objectVersionId: SOURCE_VERSION_ID,
    sizeBytes,
    contentType: 'application/pdf',
  }
}

/** Returns the final recorded proof from one completed bounded verification result. */
function requireCompletedFileVerification(
  result: RestoreDrillVerifyCreatedFileVersionResult,
): RestoreDrillRecordedScratchObjectVersion {
  if (result.status !== 'completed') throw new Error('Expected completed File verification.')
  return result.version
}

/** Creates adapter operations with fresh injectable transports. */
function createFixture(): {
  /** In-memory DynamoDB transport. */
  dynamodb: FixtureDynamoDbTransport
  /** In-memory KMS transport. */
  kms: FixtureKmsTransport
  /** Isolated operations under test. */
  operations: ReturnType<typeof createRestoreDrillAwsOperations>
  /** In-memory S3 transport. */
  s3: FixtureS3Transport
} {
  const dynamodb = new FixtureDynamoDbTransport()
  const kms = new FixtureKmsTransport()
  const s3 = new FixtureS3Transport()
  return {
    dynamodb,
    kms,
    s3,
    operations: createRestoreDrillAwsOperations({
      configuration: CONFIGURATION,
      dynamodb,
      kms,
      s3,
    }),
  }
}

describe('restore drill AWS primitives', () => {
  test('collects exactly the six allowlisted PITR windows and descriptors', async () => {
    const fixture = createFixture()
    const observations = await fixture.operations.collectSourceTableObservations()

    expect(observations.map((entry) => entry.target)).toEqual(
      [...RESTORE_DRILL_AWS_TABLE_TARGETS],
    )
    expect(observations.every((entry) => entry.descriptor.ttlEnabled)).toBe(true)
    expect(observations.every(
      (entry) => entry.descriptor.globalSecondaryIndexes[0]?.status === 'ACTIVE',
    )).toBe(true)
  })

  test('rejects non-finite PITR boundaries with a stable adapter failure', async () => {
    const fixture = createFixture()
    fixture.dynamodb.earliestRestorableDateTime = new Date(Number.NaN)

    await expect(
      fixture.operations.collectSourceTableObservations(),
    ).rejects.toMatchObject({ code: 'SOURCE_PITR_INVALID' })
  })

  test('rejects a transitional table encryption descriptor', async () => {
    const fixture = createFixture()
    fixture.dynamodb.tableSseStatus = 'UPDATING'

    await expect(
      fixture.operations.collectSourceTableObservations(),
    ).rejects.toMatchObject({ code: 'TABLE_DESCRIPTOR_INVALID' })
  })

  test('rejects transitional table TTL descriptors', async () => {
    const statuses: Array<'DISABLING' | 'ENABLING'> = ['DISABLING', 'ENABLING']
    for (const status of statuses) {
      const fixture = createFixture()
      fixture.dynamodb.tableTtlStatus = status
      await expect(
        fixture.operations.collectSourceTableObservations(),
      ).rejects.toMatchObject({ code: 'TABLE_DESCRIPTOR_INVALID' })
    }
  })

  test('binds digest-key envelopes to the exact KMS key and zeroizes plaintext', async () => {
    const fixture = createFixture()
    const envelope = await fixture.operations.createDigestKeyEnvelope(DRILL_ID)

    expect(envelope).toEqual({
      kind: 'restore-drill-digest-key',
      kmsKeyArn: CONFIGURATION.evidenceKmsKeyArn,
      ciphertextBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
    })
    expect(fixture.kms.encrypts[0]?.input).toMatchObject({
      KeyId: CONFIGURATION.evidenceKmsKeyArn,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: {
        purpose: 'restore-drill-evidence-digest-v1',
      },
    })
    expect(
      fixture.kms.encrypts[0]?.input.EncryptionContext?.drillIdDigest,
    ).toMatch(/^[a-f0-9]{64}$/)

    let consumerPlaintext: Uint8Array | undefined
    const result = await fixture.operations.withDigestKey(
      DRILL_ID,
      envelope,
      async (plaintext) => {
        consumerPlaintext = plaintext
        expect([...plaintext]).toEqual(Array.from({ length: 32 }, () => 29))
        return 'consumed'
      },
    )
    expect(result).toBe('consumed')
    expect(fixture.kms.decrypts[0]?.input).toMatchObject({
      KeyId: CONFIGURATION.evidenceKmsKeyArn,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: fixture.kms.encrypts[0]?.input.EncryptionContext,
    })
    expect(consumerPlaintext === undefined ? [] : [...consumerPlaintext]).toEqual(
      Array.from({ length: 32 }, () => 0),
    )

    await expect(fixture.operations.withDigestKey(
      DRILL_ID,
      envelope,
      async () => {
        throw new Error('consumer failure')
      },
    )).rejects.toThrow('consumer failure')
    expect(fixture.kms.lastPlaintext === undefined
      ? []
      : [...fixture.kms.lastPlaintext]).toEqual(Array.from({ length: 32 }, () => 0))

    fixture.kms.decryptAlgorithm = 'RSAES_OAEP_SHA_256'
    await expect(fixture.operations.withDigestKey(
      DRILL_ID,
      envelope,
      async () => undefined,
    )).rejects.toMatchObject({ code: 'AWS_RESPONSE_INVALID' })
    expect(fixture.kms.lastPlaintext === undefined
      ? []
      : [...fixture.kms.lastPlaintext]).toEqual(Array.from({ length: 32 }, () => 0))

    const wrongEncryptFixture = createFixture()
    wrongEncryptFixture.kms.encryptKeyId =
      `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/substituted`
    await expect(
      wrongEncryptFixture.operations.createDigestKeyEnvelope(DRILL_ID),
    ).rejects.toMatchObject({ code: 'AWS_RESPONSE_INVALID' })
  })

  test('starts deterministic restores and adopts only an exact response-loss result', async () => {
    const fixture = createFixture()
    fixture.dynamodb.restoreResponseLoss = true

    const result = await fixture.operations.startTableRestore({
      drillId: DRILL_ID,
      restorePoint: RESTORE_POINT,
      source: createSourceObservation(),
    })

    expect(result.adopted).toBe(true)
    expect(result.table.tableName).toBe(
      createRestoreDrillTargetTableName(
        CONFIGURATION.restoreTablePrefix,
        DRILL_ID,
        'table:work-items',
      ),
    )
    expect(fixture.dynamodb.restores[0]?.input).toMatchObject({
      SourceTableArn: createSourceObservation().sourceTableArn,
      RestoreDateTime: new Date(RESTORE_POINT),
    })

    fixture.dynamodb.adoptionSourceMismatch = true
    await expect(fixture.operations.startTableRestore({
      drillId: DRILL_ID,
      restorePoint: RESTORE_POINT,
      source: createSourceObservation(),
    })).rejects.toMatchObject({ code: 'RESTORE_IDENTITY_MISMATCH' })
  })

  test('starts an exact KMS DynamoDB JSON export with a deterministic client token', async () => {
    const fixture = createFixture()
    const record = await fixture.operations.startTableExport({
      drillId: DRILL_ID,
      exportPoint: RESTORE_POINT,
      source: createSourceObservation(),
    })

    expect(record.clientToken).toMatch(/^[a-f0-9]{64}$/)
    expect(record.sourceTableId).toBe('work-items-id')
    expect(fixture.dynamodb.exports[0]?.input).toMatchObject({
      TableArn: createSourceObservation().sourceTableArn,
      ExportTime: new Date(RESTORE_POINT),
      S3Bucket: CONFIGURATION.scratchBucketName,
      S3SseAlgorithm: 'KMS',
      S3SseKmsKeyId: CONFIGURATION.scratchKmsKeyArn,
      ExportFormat: 'DYNAMODB_JSON',
      ExportType: 'FULL_EXPORT',
    })
    await expect(fixture.operations.pollTableExport(record)).resolves.toEqual({
      status: 'completed',
      manifestKey:
        `${record.scratchPrefix}/AWSDynamoDB/export-1/manifest-summary.json`,
      itemCount: 1,
    })

    fixture.dynamodb.exportManifestOverride =
      'AWSDynamoDB/substituted-export/manifest-summary.json'
    await expect(
      fixture.operations.pollTableExport(record),
    ).rejects.toMatchObject({ code: 'EXPORT_IDENTITY_MISMATCH' })
  })

  test('uses Limit=1 strong File scans and conditionally remaps only destination VersionId', async () => {
    const fixture = createFixture()
    const nextKey = { scopeKey: { S: 'next' }, recordKey: { S: 'next' } }
    fixture.dynamodb.scanPages.push({
      $metadata: {},
      Items: [createRawFileRow()],
      Count: 1,
      ScannedCount: 1,
      LastEvaluatedKey: nextKey,
    })
    const table = createFileRestoreTable()
    const page = await fixture.operations.scanFileProofingPage(table)
    expect(fixture.dynamodb.scans[0]?.input).toMatchObject({
      TableName: table.tableName,
      ConsistentRead: true,
      Limit: 1,
    })
    expect(page.nextKey).toEqual(nextKey)
    expect(page.row?.versions[0]?.objectVersionId).toBe(SOURCE_VERSION_ID)

    if (!page.row) throw new Error('Expected strict File row work.')
    const result = await fixture.operations.commitFileRemap({
      drillId: DRILL_ID,
      table,
      row: page.row,
      copies: [{
        kind: 'scratch-object-version',
        bucketName: CONFIGURATION.scratchBucketName,
        drillDigest: createHash('sha256')
          .update(`drill\u0000${DRILL_ID}`, 'utf8').digest('hex').slice(0, 16),
        objectKey: OBJECT_KEY,
        objectVersionId: DESTINATION_VERSION_ID,
        versionId: 'version-1',
        ...createRecordedFileProofs(),
      }],
    })
    expect(result).toEqual({ status: 'committed' })
    const update = fixture.dynamodb.updates[0]
    expect(update).toBeInstanceOf(UpdateItemCommand)
    expect(update?.input).toMatchObject({
      TableName: table.tableName,
      Key: page.row.rowKey,
      UpdateExpression: 'SET #versions = :remappedVersions',
      ConditionExpression:
        '#revision = :expectedRevision AND #versions = :expectedVersions',
      ReturnValues: 'ALL_NEW',
    })
    const remappedVersions =
      update?.input.ExpressionAttributeValues?.[':remappedVersions']
    expect(remappedVersions?.L?.[0]?.M?.objectVersionId?.S).toBe(
      DESTINATION_VERSION_ID,
    )
    expect(update?.input.ExpressionAttributeValues?.[':expectedRevision']?.N).toBe('1')
    expect(JSON.stringify(update?.input)).not.toContain(
      CONFIGURATION.stateTableName,
    )

    await expect(fixture.operations.commitFileRemap({
      drillId: DRILL_ID,
      table,
      row: page.row,
      copies: [{
        kind: 'scratch-object-version',
        bucketName: CONFIGURATION.scratchBucketName,
        drillDigest: createHash('sha256')
          .update(`drill\u0000${DRILL_ID}`, 'utf8').digest('hex').slice(0, 16),
        objectKey: 'workspaces/substituted/files/file/version/file.pdf',
        objectVersionId: DESTINATION_VERSION_ID,
        versionId: 'version-1',
        ...createRecordedFileProofs(),
      }],
    })).rejects.toMatchObject({ code: 'FILE_COPY_IDENTITY_MISMATCH' })
  })

  test('rejects a restore aggregate page that returns the supplied cursor unchanged', async () => {
    const fixture = createFixture()
    const table = (await fixture.operations.startTableRestore({
      drillId: DRILL_ID,
      restorePoint: RESTORE_POINT,
      source: createSourceObservation(),
    })).table
    const cursor = { scopeKey: { S: 'cursor' } }
    fixture.dynamodb.scanPages.push({
      $metadata: {},
      Count: 0,
      Items: [],
      LastEvaluatedKey: cursor,
      ScannedCount: 0,
    })
    const accumulator = new RestoreDrillDynamoAggregateAccumulator(
      new Uint8Array(32).fill(7),
      table.target,
      createSourceObservation().descriptor.keySchema,
    )
    try {
      await expect(fixture.operations.scanRestoreAggregatePage({
        accumulator,
        exclusiveStartKey: cursor,
        limit: 1_000,
        table,
      })).rejects.toMatchObject({ code: 'AWS_RESPONSE_INVALID' })
    } finally {
      accumulator.dispose()
    }
  })

  test('adopts an exact File remap after losing the conditional update response', async () => {
    const fixture = createFixture()
    fixture.dynamodb.updateResponseLoss = true
    fixture.dynamodb.scanPages.push({
      $metadata: {},
      Items: [createRawFileRow()],
      Count: 1,
      ScannedCount: 1,
    })
    const table = createFileRestoreTable()
    const page = await fixture.operations.scanFileProofingPage(table)
    if (!page.row) throw new Error('Expected strict File row work.')

    const result = await fixture.operations.commitFileRemap({
      drillId: DRILL_ID,
      table,
      row: page.row,
      copies: [{
        kind: 'scratch-object-version',
        bucketName: CONFIGURATION.scratchBucketName,
        drillDigest: createHash('sha256')
          .update(`drill\u0000${DRILL_ID}`, 'utf8').digest('hex').slice(0, 16),
        objectKey: OBJECT_KEY,
        objectVersionId: DESTINATION_VERSION_ID,
        versionId: 'version-1',
        ...createRecordedFileProofs(),
      }],
    })

    expect(result).toEqual({ status: 'adopted' })
    expect(fixture.dynamodb.gets[0]).toBeInstanceOf(GetItemCommand)
    expect(fixture.dynamodb.gets[0]?.input).toMatchObject({
      TableName: table.tableName,
      Key: page.row.rowKey,
      ConsistentRead: true,
    })
  })

  test('preserves canonical key, metadata, tags, and adopts one response-loss copy', async () => {
    const fixture = createFixture()
    fixture.s3.copyResponseLoss = true
    const createdResult = await fixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })
    const created = createdResult.selectedCopy
    const verification = await fixture.operations.verifyCreatedFileVersion({
      copy: created,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
    })
    const result = requireCompletedFileVerification(verification)

    expect(createdResult.createdCopies).toEqual([created])
    expect(result.objectKey).toBe(OBJECT_KEY)
    expect(result.objectVersionId).toBe(DESTINATION_VERSION_ID)
    expect(result.sourceProof.role).toBe('source')
    expect(result.destinationProof.role).toBe('destination')
    expect(result.sourceProof.contentDigest).toBe(result.destinationProof.contentDigest)
    expect(result.sourceProof.metadataDigest).toBe(result.destinationProof.metadataDigest)
    expect(result.sourceProof.tagsDigest).toBe(result.destinationProof.tagsDigest)
    expect(result.sourceProof.proofMac).not.toBe(result.destinationProof.proofMac)
    expect(verifyRestoreDrillFileVersionProof(result.sourceProof, FILE_PROOF_KEY)).toBe(true)
    expect(verifyRestoreDrillFileVersionProof({
      ...result.sourceProof,
      metadataDigest: '0'.repeat(64),
    }, FILE_PROOF_KEY)).toBe(false)
    expect(JSON.stringify(result)).not.toContain(
      createHash('sha256').update('payload').digest('hex'),
    )
    expect(fixture.s3.copies[0]?.input).toMatchObject({
      Bucket: CONFIGURATION.scratchBucketName,
      Key: OBJECT_KEY,
      MetadataDirective: 'COPY',
      TaggingDirective: 'COPY',
      ServerSideEncryption: 'aws:kms',
    })
    expect(fixture.s3.copies[0]?.input.CopySource).toContain(
      `versionId=${SOURCE_VERSION_ID}`,
    )
    expect(fixture.s3.gets.map((command) => command.input)).toEqual([
      expect.objectContaining({
        Bucket: CONFIGURATION.sourceFileBucketName,
        Key: OBJECT_KEY,
        Range: 'bytes=0-6',
        VersionId: SOURCE_VERSION_ID,
      }),
      expect.objectContaining({
        Bucket: CONFIGURATION.scratchBucketName,
        Key: OBJECT_KEY,
        Range: 'bytes=0-6',
        VersionId: DESTINATION_VERSION_ID,
      }),
    ])
  })

  test('resumes a valid File larger than 256 MiB one exact range per invocation', async () => {
    const fixture = createFixture()
    const totalBytes = 256 * 1_024 * 1_024 + 1
    fixture.s3.objectSizeBytes = totalBytes
    fixture.s3.virtualRangeBody = true
    const source = createSourceFileVersion(totalBytes)
    const copy = (await fixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      preexistingScratchVersionIds: [],
      source,
    })).selectedCopy
    let checkpoint: RestoreDrillFileRangeCheckpoint | undefined
    let completed: RestoreDrillRecordedScratchObjectVersion | undefined
    let invocationCount = 0
    while (!completed && invocationCount < 20) {
      const result = await fixture.operations.verifyCreatedFileVersion({
        ...(checkpoint ? { checkpoint } : {}),
        copy,
        digestKey: FILE_PROOF_KEY,
        drillId: DRILL_ID,
        source,
      })
      invocationCount += 1
      if (result.status === 'pending') checkpoint = result.checkpoint
      else completed = result.version
    }

    expect(completed?.objectVersionId).toBe(DESTINATION_VERSION_ID)
    expect(invocationCount).toBe(17)
    expect(fixture.s3.gets).toHaveLength(34)
    expect(fixture.s3.gets[0]?.input.Range).toBe(
      `bytes=0-${RESTORE_DRILL_FILE_RANGE_SIZE_BYTES - 1}`,
    )
    expect(fixture.s3.gets.at(-1)?.input.Range).toBe(
      `bytes=${totalBytes - 1}-${totalBytes - 1}`,
    )
  })

  test('replays lost range results and rejects checkpoint substitution', async () => {
    const fixture = createFixture()
    const totalBytes = RESTORE_DRILL_FILE_RANGE_SIZE_BYTES + 1
    fixture.s3.objectSizeBytes = totalBytes
    fixture.s3.virtualRangeBody = true
    const source = createSourceFileVersion(totalBytes)
    const copy = (await fixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      preexistingScratchVersionIds: [],
      source,
    })).selectedCopy
    const firstInput = {
      copy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source,
    }
    const first = await fixture.operations.verifyCreatedFileVersion(firstInput)
    const firstReplay = await fixture.operations.verifyCreatedFileVersion(firstInput)
    expect(first.status).toBe('pending')
    expect(firstReplay).toEqual(first)
    if (first.status !== 'pending') throw new Error('Expected a pending first range.')

    const finalInput = { ...firstInput, checkpoint: first.checkpoint }
    const final = await fixture.operations.verifyCreatedFileVersion(finalInput)
    const finalReplay = await fixture.operations.verifyCreatedFileVersion(finalInput)
    expect(final.status).toBe('completed')
    expect(finalReplay).toEqual(final)

    const getCountBeforeSubstitution = fixture.s3.gets.length
    await expect(fixture.operations.verifyCreatedFileVersion({
      ...finalInput,
      copy: { ...copy, objectVersionId: 'substituted-destination-version' },
    })).rejects.toMatchObject({ code: 'CHECKPOINT_INVALID' })
    expect(fixture.s3.gets).toHaveLength(getCountBeforeSubstitution)
    await expect(Reflect.apply(
      fixture.operations.verifyCreatedFileVersion,
      fixture.operations,
      [{ ...firstInput, checkpoint: null }],
    )).rejects.toMatchObject({ code: 'CHECKPOINT_INVALID' })
  })

  test('fails at the exact mismatching intermediate File range', async () => {
    const fixture = createFixture()
    const totalBytes = RESTORE_DRILL_FILE_RANGE_SIZE_BYTES * 2
    fixture.s3.objectSizeBytes = totalBytes
    fixture.s3.virtualRangeBody = true
    const source = createSourceFileVersion(totalBytes)
    const copy = (await fixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      preexistingScratchVersionIds: [],
      source,
    })).selectedCopy
    const first = await fixture.operations.verifyCreatedFileVersion({
      copy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source,
    })
    if (first.status !== 'pending') throw new Error('Expected a pending first range.')
    fixture.s3.destinationMismatchRangeStart = RESTORE_DRILL_FILE_RANGE_SIZE_BYTES

    await expect(fixture.operations.verifyCreatedFileVersion({
      checkpoint: first.checkpoint,
      copy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source,
    })).rejects.toMatchObject({ code: 'FILE_COPY_CHECKSUM_MISMATCH' })
    expect(fixture.s3.gets.at(-1)?.input.Range).toBe(
      `bytes=${RESTORE_DRILL_FILE_RANGE_SIZE_BYTES}-${totalBytes - 1}`,
    )
  })

  test('requires exact ranged Content-Range, length, VersionId, and total', async () => {
    const fixtures = [
      createFixture(),
      createFixture(),
      createFixture(),
    ]
    const contentRangeFixture = fixtures[0]
    const lengthFixture = fixtures[1]
    const versionFixture = fixtures[2]
    if (!contentRangeFixture || !lengthFixture || !versionFixture) {
      throw new Error('Expected exact ranged response fixtures.')
    }
    contentRangeFixture.s3.contentRangeOverride = 'bytes 0-6/8'
    lengthFixture.s3.rangeContentLengthAdjustment = 1
    versionFixture.s3.rangedVersionIdOverride = 'substituted-version'

    for (const fixture of fixtures) {
      const source = createSourceFileVersion()
      const copy = (await fixture.operations.createOrAdoptFileVersion({
        drillId: DRILL_ID,
        preexistingScratchVersionIds: [],
        source,
      })).selectedCopy
      await expect(fixture.operations.verifyCreatedFileVersion({
        copy,
        digestKey: FILE_PROOF_KEY,
        drillId: DRILL_ID,
        source,
      })).rejects.toMatchObject({ code: 'FILE_COPY_IDENTITY_MISMATCH' })
      expect(fixture.s3.gets.every(
        (command) => command.input.Range === 'bytes=0-6',
      )).toBe(true)
    }
  })

  test('returns every version created by response-loss retries before selecting one', async () => {
    const fixture = createFixture()
    fixture.s3.copyCreatedVersionIds = [
      'destination-version-2',
      DESTINATION_VERSION_ID,
    ]
    fixture.s3.copyResponseLoss = true

    const created = await fixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })

    expect(created.createdCopies.map((copy) => copy.objectVersionId)).toEqual([
      DESTINATION_VERSION_ID,
      'destination-version-2',
    ])
    expect(created.selectedCopy).toEqual(created.createdCopies[0])

    const adopted = await fixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })
    expect(adopted).toEqual(created)
    expect(fixture.s3.copies).toHaveLength(1)
  })

  test('purely re-lists every post-baseline version without issuing CopyObject', async () => {
    const fixture = createFixture()
    fixture.s3.scratchVersions.push('baseline-version', 'late-version-2', 'late-version-1')

    const versions = await fixture.operations.reconcileCreatedFileVersions({
      drillId: DRILL_ID,
      preexistingScratchVersionIds: ['baseline-version'],
      source: createSourceFileVersion(),
    })

    expect(versions.map((version) => version.objectVersionId)).toEqual([
      'late-version-1',
      'late-version-2',
    ])
    expect(fixture.s3.copies).toHaveLength(0)
  })

  test('fails closed on copied tag or streamed content mismatch', async () => {
    const tagFixture = createFixture()
    tagFixture.s3.destinationTagMismatch = true
    const tagCopy = (await tagFixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })).selectedCopy
    await expect(tagFixture.operations.verifyCreatedFileVersion({
      copy: tagCopy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
    })).rejects.toMatchObject({ code: 'FILE_COPY_TAG_MISMATCH' })
    const adoptedTagCopy = (await tagFixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })).selectedCopy
    expect(adoptedTagCopy).toEqual(tagCopy)
    expect(tagFixture.s3.copies).toHaveLength(1)

    const bodyFixture = createFixture()
    bodyFixture.s3.destinationBodyMismatch = true
    const bodyCopy = (await bodyFixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })).selectedCopy
    await expect(bodyFixture.operations.verifyCreatedFileVersion({
      copy: bodyCopy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
    })).rejects.toMatchObject({ code: 'FILE_COPY_CHECKSUM_MISMATCH' })
  })

  test('binds streamed bytes exactly to HEAD and redacts raw stream failures', async () => {
    const invalidBodyModes: Array<'empty' | 'oversized' | 'truncated'> = [
      'empty',
      'truncated',
      'oversized',
    ]
    for (const mode of invalidBodyModes) {
      const fixture = createFixture()
      fixture.s3.objectBodyMode = mode
      const copy = (await fixture.operations.createOrAdoptFileVersion({
        drillId: DRILL_ID,
        source: createSourceFileVersion(),
        preexistingScratchVersionIds: [],
      })).selectedCopy
      await expect(fixture.operations.verifyCreatedFileVersion({
        copy,
        digestKey: FILE_PROOF_KEY,
        drillId: DRILL_ID,
        source: createSourceFileVersion(),
      })).rejects.toMatchObject({ code: 'FILE_COPY_CHECKSUM_MISMATCH' })
    }

    const errorFixture = createFixture()
    errorFixture.s3.objectBodyMode = 'error'
    const errorCopy = (await errorFixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })).selectedCopy
    await expect(errorFixture.operations.verifyCreatedFileVersion({
      copy: errorCopy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
    })).rejects.toMatchObject({ code: 'UNEXPECTED_AWS_FAILURE' })
  })

  test('requires exact copied expiration and checksum metadata presence', async () => {
    const invalidChecksumPresence: Array<'destination-only' | 'source-only'> = [
      'destination-only',
      'source-only',
    ]
    for (const checksumPresence of invalidChecksumPresence) {
      const fixture = createFixture()
      fixture.s3.checksumPresence = checksumPresence
      const copy = (await fixture.operations.createOrAdoptFileVersion({
        drillId: DRILL_ID,
        source: createSourceFileVersion(),
        preexistingScratchVersionIds: [],
      })).selectedCopy
      await expect(fixture.operations.verifyCreatedFileVersion({
        copy,
        digestKey: FILE_PROOF_KEY,
        drillId: DRILL_ID,
        source: createSourceFileVersion(),
      })).rejects.toMatchObject({ code: 'FILE_COPY_METADATA_MISMATCH' })
    }

    const expiresFixture = createFixture()
    expiresFixture.s3.destinationExpiresMismatch = true
    const expiresCopy = (await expiresFixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })).selectedCopy
    await expect(expiresFixture.operations.verifyCreatedFileVersion({
      copy: expiresCopy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
    })).rejects.toMatchObject({ code: 'FILE_COPY_METADATA_MISMATCH' })

    const legacyFixture = createFixture()
    legacyFixture.s3.checksumPresence = 'legacy-default'
    const legacyCopy = (await legacyFixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })).selectedCopy
    await expect(legacyFixture.operations.verifyCreatedFileVersion({
      copy: legacyCopy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
    })).resolves.toMatchObject({
      status: 'completed',
      version: { objectVersionId: DESTINATION_VERSION_ID },
    })

    const recomputedFixture = createFixture()
    recomputedFixture.s3.destinationChecksumValueMismatch = true
    const recomputedCopy = (await recomputedFixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })).selectedCopy
    await expect(recomputedFixture.operations.verifyCreatedFileVersion({
      copy: recomputedCopy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
    })).resolves.toMatchObject({
      status: 'completed',
      version: { objectVersionId: DESTINATION_VERSION_ID },
    })

    const redirectFixture = createFixture()
    redirectFixture.s3.sourceWebsiteRedirectLocation = '/archived/design.pdf'
    const redirectCopy = (await redirectFixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
      preexistingScratchVersionIds: [],
    })).selectedCopy
    expect(redirectFixture.s3.copies[0]?.input.WebsiteRedirectLocation).toBe(
      '/archived/design.pdf',
    )
    await expect(redirectFixture.operations.verifyCreatedFileVersion({
      copy: redirectCopy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: createSourceFileVersion(),
    })).resolves.toMatchObject({
      status: 'completed',
      version: { objectVersionId: DESTINATION_VERSION_ID },
    })
  })

  test('accepts legal consecutive dots but rejects traversal path segments', async () => {
    const fixture = createFixture()
    const legalSource = {
      ...createSourceFileVersion(),
      objectKey:
        'workspaces/workspace-1/files/file-1/version-1/report..final.pdf',
    }
    const copy = (await fixture.operations.createOrAdoptFileVersion({
      drillId: DRILL_ID,
      source: legalSource,
      preexistingScratchVersionIds: [],
    })).selectedCopy
    await expect(fixture.operations.verifyCreatedFileVersion({
      copy,
      digestKey: FILE_PROOF_KEY,
      drillId: DRILL_ID,
      source: legalSource,
    })).resolves.toMatchObject({
      status: 'completed',
      version: { objectKey: legalSource.objectKey },
    })

    for (const objectKey of [
      'workspaces/workspace-1/../secret.pdf',
      'workspaces/workspace-1/./secret.pdf',
    ]) {
      await expect(fixture.operations.createOrAdoptFileVersion({
        drillId: DRILL_ID,
        source: { ...createSourceFileVersion(), objectKey },
        preexistingScratchVersionIds: [],
      })).rejects.toMatchObject({ code: 'FILE_ROW_INVALID' })
    }
  })

  test('binds export summary, verifies data MD5, and matches restore aggregate after VersionId normalization', async () => {
    const fixture = createFixture()
    const record = await fixture.operations.startTableExport({
      drillId: DRILL_ID,
      exportPoint: RESTORE_POINT,
      source: createSourceObservation(),
    })
    const summary = {
      version: '2020-06-30',
      exportArn: record.exportArn,
      tableArn: record.sourceTableArn,
      tableId: record.sourceTableId,
      exportTime: record.exportPoint,
      s3Bucket: CONFIGURATION.scratchBucketName,
      s3Prefix: record.scratchPrefix,
      s3SseAlgorithm: 'KMS',
      s3SseKmsKeyId: CONFIGURATION.scratchKmsKeyArn,
      manifestFilesS3Key:
        'AWSDynamoDB/export-1/manifest-files.json',
      itemCount: 1,
      outputFormat: 'DYNAMODB_JSON',
    }
    const parsedSummary = await parseRestoreDrillExportSummary(
      Readable.from([Buffer.from(JSON.stringify(summary))]),
      10_000,
      record,
      CONFIGURATION,
    )
    expect(parsedSummary.itemCount).toBe(1)
    expect(parsedSummary.manifestFilesObjectKey).toBe(
      `${record.scratchPrefix}/AWSDynamoDB/export-1/manifest-files.json`,
    )

    const exportItem = {
      binaryPayload: { B: Buffer.from('binary-payload').toString('base64') },
      binarySet: {
        BS: [
          Buffer.from('binary-a').toString('base64'),
          Buffer.from('binary-b').toString('base64'),
        ],
      },
      scopeKey: { S: 'scope-1' },
      versions: { L: [{ M: { id: { S: 'v1' }, objectVersionId: { S: 'source' } } }] },
    }
    const data = gzipSync(`${JSON.stringify({ Item: exportItem })}\n`)
    const md5 = createHash('md5').update(data).digest('base64')
    const manifestLine = JSON.stringify({
      etag: 'data-object-etag',
      itemCount: 1,
      md5Checksum: md5,
      dataFileS3Key: 'AWSDynamoDB/export-1/data/file-1.json.gz',
    })
    const manifestBytes = Buffer.from(`${manifestLine}\n`)
    const authenticatedManifest = await verifyRestoreDrillExportManifestChecksum(
      Readable.from([manifestBytes]),
      Readable.from([
        Buffer.from(`${createHash('md5').update(manifestBytes).digest('hex')}\n`),
      ]),
      10_000,
    )
    const manifest = await parseRestoreDrillExportFilesManifest(
      authenticatedManifest,
      { maxBytes: 10_000, maxRecords: 10 },
      record,
      CONFIGURATION,
    )
    expect(manifest.partitionCount).toBe(1)
    expect(manifest.dataFiles[0]?.objectKey).toBe(
      `${record.scratchPrefix}/AWSDynamoDB/export-1/data/file-1.json.gz`,
    )

    const key = new Uint8Array(32).fill(19)
    const sourceAggregate = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:file-proofing',
      [{ attributeName: 'scopeKey', keyType: 'HASH' }],
      10,
    )
    await consumeRestoreDrillExportData(
      Readable.from([data]),
      { maxBytes: 10_000, maxRecords: 10 },
      sourceAggregate,
      md5,
    )
    const restoreAggregate = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:file-proofing',
      [{ attributeName: 'scopeKey', keyType: 'HASH' }],
      10,
    )
    restoreAggregate.add({
      binaryPayload: { B: Uint8Array.from(Buffer.from('binary-payload')) },
      binarySet: {
        BS: [
          Uint8Array.from(Buffer.from('binary-a')),
          Uint8Array.from(Buffer.from('binary-b')),
        ],
      },
      scopeKey: { S: 'scope-1' },
      versions: {
        L: [{ M: { id: { S: 'v1' }, objectVersionId: { S: 'destination' } } }],
      },
    })
    expect(restoreAggregate.finalize()).toEqual(sourceAggregate.finalize())

    const wrongMd5 = Buffer.alloc(16, 7).toString('base64')
    const rejectedAggregate = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:file-proofing',
      [{ attributeName: 'scopeKey', keyType: 'HASH' }],
      10,
    )
    await expect(consumeRestoreDrillExportData(
      Readable.from([data]),
      { maxBytes: 10_000, maxRecords: 10 },
      rejectedAggregate,
      wrongMd5,
    )).rejects.toMatchObject({ code: 'EXPORT_CHECKSUM_MISMATCH' })

    await expect(verifyRestoreDrillExportManifestChecksum(
      Readable.from([manifestBytes]),
      Readable.from([Buffer.from(Buffer.alloc(16, 11).toString('base64'))]),
      10_000,
    )).rejects.toMatchObject({ code: 'EXPORT_CHECKSUM_MISMATCH' })

    const wrongExportLine = JSON.stringify({
      etag: 'data-object-etag',
      itemCount: 1,
      md5Checksum: md5,
      dataFileS3Key: 'AWSDynamoDB/substituted-export/data/file-1.json.gz',
    })
    await expect(parseRestoreDrillExportFilesManifest(
      Readable.from([Buffer.from(`${wrongExportLine}\n`)]),
      { maxBytes: 10_000, maxRecords: 10 },
      record,
      CONFIGURATION,
    )).rejects.toMatchObject({ code: 'EXPORT_IDENTITY_MISMATCH' })

    await expect(parseRestoreDrillExportFilesManifest(
      Readable.from([]),
      { maxBytes: 10_000, maxRecords: 10 },
      record,
      CONFIGURATION,
    )).rejects.toMatchObject({ code: 'AWS_RESPONSE_INVALID' })

    await expect(parseRestoreDrillExportFilesManifest(
      Readable.from([Buffer.from(`${manifestLine}\n${manifestLine}\n`)]),
      { maxBytes: 10_000, maxRecords: 10 },
      record,
      CONFIGURATION,
    )).rejects.toMatchObject({ code: 'AWS_RESPONSE_INVALID' })

    await expect(parseRestoreDrillExportFilesManifest(
      Readable.from([Buffer.alloc(1_048_577, 97)]),
      { maxBytes: 2_000_000, maxRecords: 10 },
      record,
      CONFIGURATION,
    )).rejects.toMatchObject({ code: 'EXPORT_LIMIT_EXCEEDED' })
  })

  test('preserves legal empty binary values and prototype-named attributes', async () => {
    const key = new Uint8Array(32).fill(23)
    const exportAggregate = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:work-items',
      [{ attributeName: 'scopeKey', keyType: 'HASH' }],
      10,
    )
    const emptyBinaryExport = gzipSync(
      '{"Item":{"emptyBinary":{"B":""},"scopeKey":{"S":"scope-1"}}}\n',
    )
    await consumeRestoreDrillExportData(
      Readable.from([emptyBinaryExport]),
      { maxBytes: 10_000, maxRecords: 10 },
      exportAggregate,
      createHash('md5').update(emptyBinaryExport).digest('base64'),
    )
    const restoreAggregate = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:work-items',
      [{ attributeName: 'scopeKey', keyType: 'HASH' }],
      10,
    )
    restoreAggregate.add({
      emptyBinary: { B: new Uint8Array() },
      scopeKey: { S: 'scope-1' },
    })
    expect(exportAggregate.finalize()).toEqual(restoreAggregate.finalize())

    const specialItem: Record<string, AttributeValue> = {
      scopeKey: { S: 'scope-2' },
    }
    Object.defineProperty(specialItem, '__proto__', {
      enumerable: true,
      value: { S: 'must-remain-in-the-digest' },
    })
    const withSpecialAttribute = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:work-items',
      [{ attributeName: 'scopeKey', keyType: 'HASH' }],
      10,
    )
    withSpecialAttribute.add(specialItem)
    const withoutSpecialAttribute = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:work-items',
      [{ attributeName: 'scopeKey', keyType: 'HASH' }],
      10,
    )
    withoutSpecialAttribute.add({ scopeKey: { S: 'scope-2' } })
    expect(withSpecialAttribute.finalize().content).not.toEqual(
      withoutSpecialAttribute.finalize().content,
    )

    const firstPrototypeKey: Record<string, AttributeValue> = {}
    Object.defineProperty(firstPrototypeKey, '__proto__', {
      enumerable: true,
      value: { S: 'first-key' },
    })
    const secondPrototypeKey: Record<string, AttributeValue> = {}
    Object.defineProperty(secondPrototypeKey, '__proto__', {
      enumerable: true,
      value: { S: 'second-key' },
    })
    const firstKeyAggregate = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:work-items',
      [{ attributeName: '__proto__', keyType: 'HASH' }],
      10,
    )
    firstKeyAggregate.add(firstPrototypeKey)
    const secondKeyAggregate = new RestoreDrillDynamoAggregateAccumulator(
      key,
      'table:work-items',
      [{ attributeName: '__proto__', keyType: 'HASH' }],
      10,
    )
    secondKeyAggregate.add(secondPrototypeKey)
    expect(firstKeyAggregate.finalize().keys).not.toEqual(
      secondKeyAggregate.finalize().keys,
    )
  })

  test('enumerates and deletes exact versions created below one export prefix', async () => {
    const fixture = createFixture()
    const record = await fixture.operations.startTableExport({
      drillId: DRILL_ID,
      exportPoint: RESTORE_POINT,
      source: createSourceObservation(),
    })
    const prefix = `${record.scratchPrefix}/`
    await expect(fixture.operations.listRecordedExportObjectVersionPage(
      record,
      {
        keyMarker: 'restore-drill/substituted/export/data.json.gz',
        versionIdMarker: 'substituted-version',
      },
    )).rejects.toMatchObject({ code: 'CHECKPOINT_INVALID' })
    fixture.s3.listPages.push({
      $metadata: {},
      IsTruncated: true,
      NextKeyMarker: 'restore-drill/substituted/export/data.json.gz',
      NextVersionIdMarker: 'substituted-version',
    })
    await expect(
      fixture.operations.listRecordedExportObjectVersionPage(record),
    ).rejects.toMatchObject({ code: 'AWS_RESPONSE_INVALID' })
    const stalledCursor = {
      keyMarker: `${prefix}manifest-summary.json`,
      versionIdMarker: 'export-version-1',
    }
    fixture.s3.listPages.push({
      $metadata: {},
      IsTruncated: true,
      NextKeyMarker: stalledCursor.keyMarker,
      NextVersionIdMarker: stalledCursor.versionIdMarker,
    })
    await expect(fixture.operations.listRecordedExportObjectVersionPage(
      record,
      stalledCursor,
    )).rejects.toMatchObject({ code: 'AWS_RESPONSE_INVALID' })
    fixture.s3.listPages.push(
      {
        $metadata: {},
        IsTruncated: true,
        Versions: [{ Key: `${prefix}manifest-summary.json`, VersionId: 'export-version-1' }],
        NextKeyMarker: `${prefix}manifest-summary.json`,
        NextVersionIdMarker: 'export-version-1',
      },
      {
        $metadata: {},
        IsTruncated: false,
        Versions: [{ Key: `${prefix}data/file.json.gz`, VersionId: 'export-version-2' }],
      },
    )

    const firstPage = await fixture.operations.listRecordedExportObjectVersionPage(record)
    expect(firstPage.nextCursor).toEqual({
      keyMarker: `${prefix}manifest-summary.json`,
      versionIdMarker: 'export-version-1',
    })
    if (!firstPage.nextCursor) throw new Error('Expected an export listing continuation.')
    const secondPage = await fixture.operations.listRecordedExportObjectVersionPage(
      record,
      firstPage.nextCursor,
    )
    expect(secondPage.nextCursor).toBeUndefined()

    fixture.s3.scratchVersions.push('export-version-1', 'export-version-2')

    const versions = await fixture.operations.listRecordedExportObjectVersions(record)
    expect(versions.map((entry) => entry.objectVersionId)).toEqual([
      'export-version-1',
      'export-version-2',
    ])
    const firstVersion = versions[0]
    if (!firstVersion) throw new Error('Expected one recorded export object version.')
    await fixture.operations.deleteRecordedExportObjectVersion(firstVersion, DRILL_ID)
    expect(fixture.s3.deletes[0]?.input).toMatchObject({
      Bucket: CONFIGURATION.scratchBucketName,
      Key: `${record.scratchPrefix}/`,
      VersionId: 'export-version-1',
    })
  })

  test('inventories and aborts exact drill-owned incomplete multipart uploads', async () => {
    const fixture = createFixture()
    const record = await fixture.operations.startTableExport({
      drillId: DRILL_ID,
      exportPoint: RESTORE_POINT,
      source: createSourceObservation(),
    })
    const drillPrefix = `${record.scratchPrefix.split('/').slice(0, 2).join('/')}/`
    const firstKey = `${record.scratchPrefix}/data/part-1`
    const secondKey = `${record.scratchPrefix}/data/part-2`
    fixture.s3.multipartListPages.push(
      {
        $metadata: {},
        IsTruncated: true,
        Uploads: [{ Key: firstKey, UploadId: 'upload-1' }],
        NextKeyMarker: firstKey,
        NextUploadIdMarker: 'upload-1',
      },
      {
        $metadata: {},
        IsTruncated: false,
        Uploads: [{ Key: secondKey, UploadId: 'upload-2' }],
      },
    )

    const firstPage = await fixture.operations.listRecordedMultipartUploadPage(
      drillPrefix,
    )
    expect(firstPage.uploads).toEqual([{
      bucketName: CONFIGURATION.scratchBucketName,
      kind: 'scratch-multipart-upload',
      objectKey: firstKey,
      uploadId: 'upload-1',
    }])
    expect(firstPage.nextCursor).toEqual({
      keyMarker: firstKey,
      uploadIdMarker: 'upload-1',
    })
    if (!firstPage.nextCursor) throw new Error('Expected multipart continuation.')
    const secondPage = await fixture.operations.listRecordedMultipartUploadPage(
      drillPrefix,
      firstPage.nextCursor,
    )
    expect(secondPage.uploads[0]?.uploadId).toBe('upload-2')
    expect(secondPage.nextCursor).toBeUndefined()

    fixture.s3.multipartUploads.push({
      objectKey: firstKey,
      uploadId: 'upload-1',
    })
    await expect(fixture.operations.abortRecordedMultipartUpload(
      firstPage.uploads[0]!,
      DRILL_ID,
    )).resolves.toEqual({ status: 'absent' })
    expect(fixture.s3.aborts[0]?.input).toMatchObject({
      Bucket: CONFIGURATION.scratchBucketName,
      Key: firstKey,
      UploadId: 'upload-1',
      ExpectedBucketOwner: ACCOUNT_ID,
    })
    await expect(fixture.operations.abortRecordedMultipartUpload(
      firstPage.uploads[0]!,
      DRILL_ID,
    )).resolves.toEqual({ status: 'absent' })

    fixture.s3.multipartUploads.push({
      objectKey: secondKey,
      uploadId: 'upload-2',
    })
    fixture.s3.abortRemainsPending = true
    await expect(fixture.operations.abortRecordedMultipartUpload(
      secondPage.uploads[0]!,
      DRILL_ID,
    )).resolves.toEqual({ status: 'pending' })
  })

  test('rejects stalled multipart cursors and does not treat a missing bucket as absence', async () => {
    const fixture = createFixture()
    const record = await fixture.operations.startTableExport({
      drillId: DRILL_ID,
      exportPoint: RESTORE_POINT,
      source: createSourceObservation(),
    })
    const drillPrefix = `${record.scratchPrefix.split('/').slice(0, 2).join('/')}/`
    const cursor = {
      keyMarker: `${record.scratchPrefix}/data/part`,
      uploadIdMarker: 'upload-1',
    }
    fixture.s3.multipartListPages.push({
      $metadata: {},
      IsTruncated: true,
      NextKeyMarker: cursor.keyMarker,
      NextUploadIdMarker: cursor.uploadIdMarker,
    })
    await expect(fixture.operations.listRecordedMultipartUploadPage(
      drillPrefix,
      cursor,
    )).rejects.toMatchObject({ code: 'AWS_RESPONSE_INVALID' })

    const version: RestoreDrillRecordedExportObjectVersion = {
      kind: 'export-object-version',
      bucketName: CONFIGURATION.scratchBucketName,
      scratchPrefix: record.scratchPrefix,
      exportArnDigest: createHash('sha256')
        .update(`export-arn\u0000${record.exportArn}`)
        .digest('hex'),
      objectKey: `${record.scratchPrefix}/data/file.json.gz`,
      objectVersionId: 'export-version-1',
    }
    fixture.s3.deletedVersionAttributeErrorName = 'NoSuchBucket'
    await expect(
      fixture.operations.deleteRecordedExportObjectVersion(version, DRILL_ID),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_AWS_FAILURE' })
  })

  test('reads cleanup configuration without production source addresses', () => {
    const configuration = readRestoreDrillAwsCleanupConfiguration({
      AWS_REGION: REGION,
      EVIDENCE_BUCKET_NAME: CONFIGURATION.evidenceBucketName,
      EVIDENCE_KEY_ARN: CONFIGURATION.evidenceKmsKeyArn,
      METRIC_NAMESPACE: CONFIGURATION.metricNamespace,
      SCRATCH_BUCKET_NAME: CONFIGURATION.scratchBucketName,
      STATE_TABLE_NAME: CONFIGURATION.stateTableName,
      TARGET_TABLE_PREFIX: CONFIGURATION.restoreTablePrefix,
    })

    expect(configuration).toEqual({
      accountId: ACCOUNT_ID,
      region: REGION,
      evidenceBucketName: CONFIGURATION.evidenceBucketName,
      evidenceKmsKeyArn: CONFIGURATION.evidenceKmsKeyArn,
      metricNamespace: CONFIGURATION.metricNamespace,
      scratchBucketName: CONFIGURATION.scratchBucketName,
      stateTableName: CONFIGURATION.stateTableName,
      restoreTablePrefix: CONFIGURATION.restoreTablePrefix,
    })
  })

  test('adopts only exact DeleteTable effects after a generic response loss', async () => {
    const missingFixture = createFixture()
    const missingTable = (await missingFixture.operations.startTableRestore({
      drillId: DRILL_ID,
      restorePoint: RESTORE_POINT,
      source: createSourceObservation(),
    })).table
    missingFixture.dynamodb.deleteTableFailureMode = 'response-lost-missing'
    await expect(missingFixture.operations.deleteRecordedRestoreTable(
      missingTable,
      DRILL_ID,
    )).resolves.toEqual({ status: 'completed' })

    const deletingFixture = createFixture()
    const deletingTable = (await deletingFixture.operations.startTableRestore({
      drillId: DRILL_ID,
      restorePoint: RESTORE_POINT,
      source: createSourceObservation(),
    })).table
    deletingFixture.dynamodb.deleteTableFailureMode = 'response-lost-deleting'
    await expect(deletingFixture.operations.deleteRecordedRestoreTable(
      deletingTable,
      DRILL_ID,
    )).resolves.toEqual({ status: 'pending' })

    const unchangedFixture = createFixture()
    const unchangedTable = (await unchangedFixture.operations.startTableRestore({
      drillId: DRILL_ID,
      restorePoint: RESTORE_POINT,
      source: createSourceObservation(),
    })).table
    unchangedFixture.dynamodb.deleteTableFailureMode = 'before-apply'
    await expect(unchangedFixture.operations.deleteRecordedRestoreTable(
      unchangedTable,
      DRILL_ID,
    )).rejects.toMatchObject({ code: 'UNEXPECTED_AWS_FAILURE' })
  })

  test('adopts exact-version DeleteObject response loss only after absence', async () => {
    const fixture = createFixture()
    const scratch: RestoreDrillRecordedScratchObjectVersion = {
      kind: 'scratch-object-version',
      bucketName: CONFIGURATION.scratchBucketName,
      drillDigest: createHash('sha256')
        .update(`drill\u0000${DRILL_ID}`).digest('hex').slice(0, 16),
      objectKey: OBJECT_KEY,
      objectVersionId: DESTINATION_VERSION_ID,
      versionId: 'version-1',
      ...createRecordedFileProofs(),
    }
    fixture.s3.deleteObjectFailureMode = 'response-lost'
    await expect(fixture.operations.deleteRecordedScratchObjectVersion(
      scratch,
      DRILL_ID,
    )).resolves.toBeUndefined()

    const exportRecord = await fixture.operations.startTableExport({
      drillId: DRILL_ID,
      exportPoint: RESTORE_POINT,
      source: createSourceObservation(),
    })
    const exported: RestoreDrillRecordedExportObjectVersion = {
      bucketName: CONFIGURATION.scratchBucketName,
      exportArnDigest: createHash('sha256')
        .update(`export-arn\u0000${exportRecord.exportArn}`)
        .digest('hex'),
      kind: 'export-object-version',
      objectKey: `${exportRecord.scratchPrefix}/data/file.json.gz`,
      objectVersionId: 'export-version-response-lost',
      scratchPrefix: exportRecord.scratchPrefix,
    }
    await expect(fixture.operations.deleteRecordedExportObjectVersion(
      exported,
      DRILL_ID,
    )).resolves.toBeUndefined()

    const unchangedFixture = createFixture()
    unchangedFixture.s3.deleteObjectFailureMode = 'before-apply'
    await expect(unchangedFixture.operations.deleteRecordedScratchObjectVersion(
      scratch,
      DRILL_ID,
    )).rejects.toMatchObject({ code: 'CLEANUP_IDENTITY_MISMATCH' })
  })

  test('deletes only exact recorded identities and reconciles table absence', async () => {
    const fixture = createFixture()
    fixture.dynamodb.restoreResponseLoss = true
    const started = await fixture.operations.startTableRestore({
      drillId: DRILL_ID,
      restorePoint: RESTORE_POINT,
      source: createSourceObservation(),
    })
    expect(await fixture.operations.deleteRecordedRestoreTable(
      started.table,
      DRILL_ID,
    )).toEqual({
      status: 'pending',
    })
    expect(await fixture.operations.deleteRecordedRestoreTable(
      started.table,
      DRILL_ID,
    )).toEqual({
      status: 'completed',
    })
    expect(fixture.dynamodb.deletes[0]?.input.TableName).toBe(started.table.tableName)

    const scratch: RestoreDrillRecordedScratchObjectVersion = {
      kind: 'scratch-object-version',
      bucketName: CONFIGURATION.scratchBucketName,
      drillDigest: createHash('sha256')
        .update(`drill\u0000${DRILL_ID}`).digest('hex').slice(0, 16),
      objectKey: OBJECT_KEY,
      objectVersionId: DESTINATION_VERSION_ID,
      versionId: 'version-1',
      ...createRecordedFileProofs(),
    }
    await fixture.operations.deleteRecordedScratchObjectVersion(scratch, DRILL_ID)
    expect(fixture.s3.deletes[0]?.input).toEqual({
      Bucket: CONFIGURATION.scratchBucketName,
      Key: OBJECT_KEY,
      VersionId: DESTINATION_VERSION_ID,
      ExpectedBucketOwner: ACCOUNT_ID,
    })
    expect(fixture.s3.attributeReads[0]?.input).toEqual({
      Bucket: CONFIGURATION.scratchBucketName,
      Key: OBJECT_KEY,
      VersionId: DESTINATION_VERSION_ID,
      ExpectedBucketOwner: ACCOUNT_ID,
      ObjectAttributes: ['ObjectSize'],
    })

    await expect(fixture.operations.deleteRecordedRestoreTable({
      ...started.table,
      tableName: CONFIGURATION.sourceTables['table:work-items'],
    }, DRILL_ID)).rejects.toBeInstanceOf(RestoreDrillAwsFailure)
    await expect(fixture.operations.deleteRecordedRestoreTable(
      started.table,
      'another-drill',
    )).rejects.toMatchObject({ code: 'CLEANUP_IDENTITY_MISMATCH' })
    await expect(fixture.operations.deleteRecordedScratchObjectVersion(
      scratch,
      'another-drill',
    )).rejects.toMatchObject({ code: 'CLEANUP_IDENTITY_MISMATCH' })
  })
})
