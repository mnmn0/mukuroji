import type { FileAttachmentTargetType, FileScanStatus } from '@mukuroji/contracts'
import { isAllowedFileContentType, normalizeFileContentType } from './file-content-type'

/** Stable failure categories emitted by file metadata integrity checks. */
export type FileIntegrityFailureCode =
  | 'FILE_CURRENT_VERSION_MISSING'
  | 'FILE_DELETION_STATE_MISMATCH'
  | 'FILE_ITEM_INVALID'
  | 'FILE_OBJECT_CONTENT_TYPE_MISMATCH'
  | 'FILE_OBJECT_DELETED_MISMATCH'
  | 'FILE_OBJECT_KEY_MISMATCH'
  | 'FILE_OBJECT_MISSING'
  | 'FILE_OBJECT_OBSERVATION_DUPLICATE'
  | 'FILE_OBJECT_OBSERVATION_INVALID'
  | 'FILE_OBJECT_ORPHANED'
  | 'FILE_OBJECT_SCAN_STATUS_MISMATCH'
  | 'FILE_OBJECT_SIZE_MISMATCH'
  | 'FILE_OBJECT_UPLOAD_STATE_MISMATCH'
  | 'FILE_OBJECT_VERSION_ID_MISMATCH'
  | 'FILE_OBJECT_VERSION_STATE_MISMATCH'
  | 'FILE_RECORD_KEY_MISMATCH'
  | 'FILE_SCOPE_INVALID'
  | 'FILE_SCOPE_KEY_MISMATCH'
  | 'FILE_TARGET_INVALID'
  | 'FILE_TARGET_MISMATCH'
  | 'FILE_VERSION_DUPLICATE'
  | 'FILE_VERSION_INVALID'
  | 'FILE_VERSION_SEQUENCE_MISMATCH'

/** Cross-domain checker failure categories exposed in secret-free evidence. */
export type FileMetadataIntegrityFailureCode =
  | 'FILE_METADATA_OBJECT_MISMATCH'
  | 'FILE_METADATA_OBJECT_MISSING'
  | 'FILE_METADATA_REFERENCE_MISSING'
  | 'FILE_METADATA_TENANT_MISMATCH'

/** Upload lifecycle tag values written by the File object adapter. */
export type FileIntegrityUploadState = 'completed' | 'pending'

/** A validated process-local reference from a file metadata row to an object version. */
export type FileIntegrityReference = {
  /** Raw DynamoDB partition key, retained only inside the checker process. */
  scopeKey: string
  /** Raw DynamoDB sort key, retained only inside the checker process. */
  recordKey: string
  /** Raw Workspace identifier, retained only inside the checker process. */
  workspaceId: string
  /** Raw Team identifier, retained only inside the checker process. */
  teamId: string
  /** Attachment target category. */
  targetType: FileAttachmentTargetType
  /** Raw attachment target identifier, retained only inside the checker process. */
  targetId: string
  /** Validated parent resource category used for cross-domain existence checks. */
  parentTargetType: 'project' | 'work-item'
  /** Raw validated parent resource identifier, retained only inside the checker process. */
  parentTargetId: string
  /** Raw File identifier, retained only inside the checker process. */
  fileId: string
  /** Raw File version identifier, retained only inside the checker process. */
  versionId: string
  /** Whether this reference is the File row's current version. */
  currentVersion: boolean
  /** Raw canonical object key, retained only inside the checker process. */
  objectKey: string
  /** Immutable object version identifier after upload verification. */
  objectVersionId?: string
  /** Expected object size in bytes. */
  sizeBytes: number
  /** Expected object media type. */
  contentType: string
  /** Expected malware scan state. */
  scanStatus: FileScanStatus
  /** Whether the owning File row is soft deleted. */
  deleted: boolean
  /** Retention deadline for a soft-deleted row. */
  retentionUntil?: string
}

/** Exact object metadata observed by the read-only S3 adapter. */
export type FileIntegrityObjectObservation = {
  /** Exact object key read from storage. */
  objectKey: string
  /** Exact immutable object version identifier read from storage. */
  objectVersionId: string
  /** Observed object size in bytes. */
  sizeBytes: number
  /** Observed object media type. */
  contentType: string
  /** Observed malware scan state. */
  scanStatus: FileScanStatus
  /** Observed `mukuroji-upload` lifecycle tag. */
  uploadState: FileIntegrityUploadState
  /** Whether the immutable object version carries the deleted quarantine marker. */
  deleted: boolean
}

/** Inputs for one pure File row and object metadata integrity check. */
export type FileMetadataIntegrityCheckInput = {
  /** Canonical timestamp that fixes tombstone expiry evaluation for this check. */
  checkedAt: string
  /** Untrusted DynamoDB File row. */
  item: unknown
  /** Exact object observations collected for the bounded check scope. */
  objects: readonly FileIntegrityObjectObservation[]
}

/** Secret-free evidence summary for one File row integrity check. */
export type FileMetadataIntegrityResult = {
  /** Whether no deterministic integrity failure was detected. */
  ok: boolean
  /** Number of strictly parsed File versions. */
  checkedVersionCount: number
  /** Number of strictly parsed object observations. */
  checkedObjectCount: number
  /** Sorted unique stable failure categories without raw identifiers. */
  failureCodes: FileMetadataIntegrityFailureCode[]
}

/** A stable parse or consistency failure without raw row data in its message. */
export class FileIntegrityFailure extends Error {
  /** Stable machine-readable failure category. */
  readonly code: FileIntegrityFailureCode

  /**
   * Creates a file integrity failure.
   *
   * @param code - Stable failure category.
   */
  constructor(code: FileIntegrityFailureCode) {
    super(code)
    this.name = 'FileIntegrityFailure'
    this.code = code
  }
}

/** Strictly parsed fields needed from one stored File version. */
type ParsedFileVersion = {
  /** File version identifier. */
  id: string
  /** Monotonic version number. */
  number: number
  /** Canonical display file name used in the object key. */
  fileName: string
  /** Expected object media type. */
  contentType: string
  /** Expected object size in bytes. */
  sizeBytes: number
  /** Expected malware scan state. */
  scanStatus: FileScanStatus
  /** Canonical object key. */
  objectKey: string
  /** Immutable object version identifier after upload verification. */
  objectVersionId?: string
  /** Timestamp at which the immutable object version was verified. */
  verifiedAt?: string
}

/** Strictly parsed fields needed from one stored File row. */
type ParsedFileItem = {
  /** DynamoDB partition key. */
  scopeKey: string
  /** DynamoDB sort key. */
  recordKey: string
  /** Workspace identifier. */
  workspaceId: string
  /** Team identifier. */
  teamId: string
  /** Optional parent Work Item identifier. */
  issueId?: string
  /** Optional parent Project identifier. */
  projectId?: string
  /** File identifier. */
  fileId: string
  /** Attachment target category. */
  targetType: FileAttachmentTargetType
  /** Attachment target identifier. */
  targetId: string
  /** Stored File versions. */
  versions: ParsedFileVersion[]
  /** Current File version identifier. */
  currentVersionId: string
  /** Optional soft-delete timestamp. */
  deletedAt?: string
  /** Optional retention deadline. */
  retentionUntil?: string
  /** Optional DynamoDB TTL epoch seconds. */
  expiresAt?: number
}

const OBJECT_OBSERVATION_KEYS = new Set<string>([
  'objectKey',
  'objectVersionId',
  'sizeBytes',
  'contentType',
  'scanStatus',
  'uploadState',
  'deleted',
])

/**
 * Strictly parses a private File row and returns validated process-local object references.
 *
 * The returned values intentionally contain raw identifiers so an in-process adapter can perform
 * exact reads. They must not be serialized as external evidence; use
 * {@link checkFileMetadataIntegrity} for the evidence-safe result.
 *
 * @param item - Untrusted DynamoDB File row.
 * @returns Validated references in stored version order.
 * @throws {FileIntegrityFailure} When a row field or cross-field invariant is invalid.
 */
export function parseFileIntegrityReferences(item: unknown): FileIntegrityReference[] {
  const parsed = parseFileItem(item)
  validateFileScope(parsed)
  validateFileTarget(parsed)
  validateFileVersions(parsed)
  validateFileDeletion(parsed)

  const deleted = parsed.deletedAt !== undefined
  const parentTargetType = parsed.projectId ? 'project' : 'work-item'
  const parentTargetId = parsed.projectId ?? parsed.issueId
  if (!parentTargetId) {
    throw new FileIntegrityFailure('FILE_SCOPE_INVALID')
  }
  return parsed.versions.map((version) => {
    const expectedObjectKey = createCanonicalObjectKey(
      parsed.workspaceId,
      parsed.fileId,
      version.id,
      version.fileName,
    )
    if (version.objectKey !== expectedObjectKey) {
      throw new FileIntegrityFailure('FILE_OBJECT_KEY_MISMATCH')
    }
    validateObjectVersionState(version)
    return {
      scopeKey: parsed.scopeKey,
      recordKey: parsed.recordKey,
      workspaceId: parsed.workspaceId,
      teamId: parsed.teamId,
      targetType: parsed.targetType,
      targetId: parsed.targetId,
      parentTargetType,
      parentTargetId,
      fileId: parsed.fileId,
      versionId: version.id,
      currentVersion: version.id === parsed.currentVersionId,
      objectKey: version.objectKey,
      ...(version.objectVersionId ? { objectVersionId: version.objectVersionId } : {}),
      sizeBytes: version.sizeBytes,
      contentType: version.contentType,
      scanStatus: version.scanStatus,
      deleted,
      ...(parsed.retentionUntil ? { retentionUntil: parsed.retentionUntil } : {}),
    }
  })
}

/**
 * Compares one untrusted File row with exact object observations.
 *
 * @param input - File row and exact object observations for its bounded scope.
 * @returns A deterministic evidence-safe result containing only counts and failure codes.
 */
export function checkFileMetadataIntegrity(
  input: FileMetadataIntegrityCheckInput,
): FileMetadataIntegrityResult {
  const checkedAt = readCheckedAt(input.checkedAt)
  let references: FileIntegrityReference[]
  try {
    references = parseFileIntegrityReferences(input.item)
  } catch (error) {
    if (error instanceof FileIntegrityFailure) {
      return createIntegrityResult(0, 0, [error.code])
    }
    throw error
  }

  if (isExpiredTombstone(references, checkedAt)) {
    return createIntegrityResult(references.length, 0, [])
  }

  let observations: FileIntegrityObjectObservation[]
  try {
    observations = input.objects.map(parseObjectObservation)
  } catch (error) {
    if (error instanceof FileIntegrityFailure) {
      return createIntegrityResult(references.length, 0, [error.code])
    }
    throw error
  }

  const failures = new Set<FileIntegrityFailureCode>()
  const observationsByObjectKey = new Map<string, FileIntegrityObjectObservation[]>()
  const observationIdentities = new Set<string>()
  for (const observation of observations) {
    const identity = createObjectIdentity(observation.objectKey, observation.objectVersionId)
    if (observationIdentities.has(identity)) {
      failures.add('FILE_OBJECT_OBSERVATION_DUPLICATE')
    }
    observationIdentities.add(identity)
    const candidates = observationsByObjectKey.get(observation.objectKey) ?? []
    candidates.push(observation)
    observationsByObjectKey.set(observation.objectKey, candidates)
  }

  const consumedObservations = new Set<FileIntegrityObjectObservation>()
  for (const reference of references) {
    const candidates = observationsByObjectKey.get(reference.objectKey) ?? []
    if (!reference.objectVersionId) {
      for (const candidate of candidates) {
        consumedObservations.add(candidate)
      }
      continue
    }
    const exactCandidates = candidates.filter((candidate) =>
      candidate.objectVersionId === reference.objectVersionId
    )
    const exact = exactCandidates[0]
    if (!exact) {
      if (candidates.length === 0) {
        failures.add('FILE_OBJECT_MISSING')
      } else {
        failures.add('FILE_OBJECT_VERSION_ID_MISMATCH')
        for (const candidate of candidates) {
          consumedObservations.add(candidate)
        }
      }
      continue
    }
    for (const candidate of exactCandidates) {
      consumedObservations.add(candidate)
    }
    compareObjectMetadata(reference, exact, failures)
  }

  if (observations.some((observation) => !consumedObservations.has(observation))) {
    failures.add('FILE_OBJECT_ORPHANED')
  }

  return createIntegrityResult(references.length, observations.length, [...failures])
}

/**
 * Strictly parses the relevant File row fields without depending on the persistence type.
 *
 * @param value - Untrusted File row.
 * @returns Parsed fields required for integrity validation.
 */
function parseFileItem(value: unknown): ParsedFileItem {
  if (!isRecord(value) || value.entryType !== 'file' || !Array.isArray(value.versions)) {
    throw new FileIntegrityFailure('FILE_ITEM_INVALID')
  }
  const scopeKey = readText(value.scopeKey, 'FILE_SCOPE_INVALID')
  const recordKey = readText(value.recordKey, 'FILE_ITEM_INVALID')
  const workspaceId = readText(value.workspaceId, 'FILE_SCOPE_INVALID')
  const teamId = readText(value.teamId, 'FILE_SCOPE_INVALID')
  const issueId = readOptionalText(value.issueId, 'FILE_SCOPE_INVALID')
  const projectId = readOptionalText(value.projectId, 'FILE_SCOPE_INVALID')
  const fileId = readText(value.fileId, 'FILE_ITEM_INVALID')
  const targetType = readTargetType(value.targetType)
  const targetId = readText(value.targetId, 'FILE_TARGET_INVALID')
  const currentVersionId = readText(value.currentVersionId, 'FILE_CURRENT_VERSION_MISSING')
  const deletedAt = readOptionalText(value.deletedAt, 'FILE_DELETION_STATE_MISMATCH')
  const retentionUntil = readOptionalText(value.retentionUntil, 'FILE_DELETION_STATE_MISMATCH')
  const expiresAt = readOptionalSafeInteger(value.expiresAt, 'FILE_DELETION_STATE_MISMATCH')
  const versions = value.versions.map(parseFileVersion)

  return {
    scopeKey,
    recordKey,
    workspaceId,
    teamId,
    ...(issueId ? { issueId } : {}),
    ...(projectId ? { projectId } : {}),
    fileId,
    targetType,
    targetId,
    versions,
    currentVersionId,
    ...(deletedAt ? { deletedAt } : {}),
    ...(retentionUntil ? { retentionUntil } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

/**
 * Strictly parses one stored File version.
 *
 * @param value - Untrusted version value.
 * @returns Parsed version fields.
 */
function parseFileVersion(value: unknown): ParsedFileVersion {
  if (!isRecord(value)) {
    throw new FileIntegrityFailure('FILE_VERSION_INVALID')
  }
  const id = readText(value.id, 'FILE_VERSION_INVALID')
  const number = readPositiveSafeInteger(value.number, 'FILE_VERSION_INVALID')
  const fileName = readFileName(value.fileName)
  const contentType = readContentType(value.contentType, 'FILE_VERSION_INVALID')
  const sizeBytes = readPositiveSafeInteger(value.sizeBytes, 'FILE_VERSION_INVALID')
  const scanStatus = readScanStatus(value.scanStatus, 'FILE_VERSION_INVALID')
  const objectKey = readText(value.objectKey, 'FILE_OBJECT_KEY_MISMATCH')
  const objectVersionId = readOptionalText(
    value.objectVersionId,
    'FILE_OBJECT_VERSION_STATE_MISMATCH',
  )
  const verifiedAt = readOptionalText(value.verifiedAt, 'FILE_OBJECT_VERSION_STATE_MISMATCH')
  if (verifiedAt && !isCanonicalTimestamp(verifiedAt)) {
    throw new FileIntegrityFailure('FILE_OBJECT_VERSION_STATE_MISMATCH')
  }
  return {
    id,
    number,
    fileName,
    contentType,
    sizeBytes,
    scanStatus,
    objectKey,
    ...(objectVersionId ? { objectVersionId } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
  }
}

/**
 * Strictly parses an exact object observation and rejects extra fields.
 *
 * @param value - Object observation supplied by the read-only adapter.
 * @returns Strictly parsed object observation.
 */
function parseObjectObservation(value: unknown): FileIntegrityObjectObservation {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== OBJECT_OBSERVATION_KEYS.size ||
    Object.keys(value).some((key) => !OBJECT_OBSERVATION_KEYS.has(key))
  ) {
    throw new FileIntegrityFailure('FILE_OBJECT_OBSERVATION_INVALID')
  }
  return {
    objectKey: readText(value.objectKey, 'FILE_OBJECT_OBSERVATION_INVALID'),
    objectVersionId: readText(value.objectVersionId, 'FILE_OBJECT_OBSERVATION_INVALID'),
    sizeBytes: readPositiveSafeInteger(value.sizeBytes, 'FILE_OBJECT_OBSERVATION_INVALID'),
    contentType: readContentType(value.contentType, 'FILE_OBJECT_OBSERVATION_INVALID'),
    scanStatus: readScanStatus(value.scanStatus, 'FILE_OBJECT_OBSERVATION_INVALID'),
    uploadState: readUploadState(value.uploadState),
    deleted: readBoolean(value.deleted, 'FILE_OBJECT_OBSERVATION_INVALID'),
  }
}

/**
 * Validates the canonical physical keys and parent scope.
 *
 * @param item - Strictly parsed File row.
 */
function validateFileScope(item: ParsedFileItem): void {
  const hasIssue = item.issueId !== undefined
  const hasProject = item.projectId !== undefined
  if (hasIssue === hasProject) {
    throw new FileIntegrityFailure('FILE_SCOPE_INVALID')
  }
  const expectedScopeKey = item.issueId
    ? `WORKSPACE#${item.workspaceId}#TEAM#${item.teamId}#WORKITEM#${item.issueId}`
    : `WORKSPACE#${item.workspaceId}#TEAM#${item.teamId}#PROJECT#${item.projectId}`
  if (item.scopeKey !== expectedScopeKey) {
    throw new FileIntegrityFailure('FILE_SCOPE_KEY_MISMATCH')
  }
  if (item.recordKey !== `FILE#${item.fileId}`) {
    throw new FileIntegrityFailure('FILE_RECORD_KEY_MISMATCH')
  }
}

/**
 * Validates attachment target ownership against the parent scope.
 *
 * @param item - Strictly parsed File row.
 */
function validateFileTarget(item: ParsedFileItem): void {
  if (item.targetType === 'work-item') {
    if (!item.issueId || item.projectId || item.targetId !== item.issueId) {
      throw new FileIntegrityFailure('FILE_TARGET_MISMATCH')
    }
    return
  }
  if (item.targetType === 'project') {
    if (!item.projectId || item.issueId || item.targetId !== item.projectId) {
      throw new FileIntegrityFailure('FILE_TARGET_MISMATCH')
    }
    return
  }
  if (!item.issueId || item.projectId) {
    throw new FileIntegrityFailure('FILE_TARGET_MISMATCH')
  }
}

/**
 * Validates version identity, numbering, and current-version linkage.
 *
 * @param item - Strictly parsed File row.
 */
function validateFileVersions(item: ParsedFileItem): void {
  if (item.versions.length === 0) {
    throw new FileIntegrityFailure('FILE_VERSION_INVALID')
  }
  const versionIds = new Set(item.versions.map((version) => version.id))
  const versionNumbers = new Set(item.versions.map((version) => version.number))
  if (versionIds.size !== item.versions.length || versionNumbers.size !== item.versions.length) {
    throw new FileIntegrityFailure('FILE_VERSION_DUPLICATE')
  }
  const expectedNumbers = item.versions.map((_, index) => index + 1)
  const actualNumbers = item.versions.map((version) => version.number).sort((left, right) => left - right)
  if (actualNumbers.some((number, index) => number !== expectedNumbers[index])) {
    throw new FileIntegrityFailure('FILE_VERSION_SEQUENCE_MISMATCH')
  }
  if (!versionIds.has(item.currentVersionId)) {
    throw new FileIntegrityFailure('FILE_CURRENT_VERSION_MISSING')
  }
}

/**
 * Validates soft-delete retention and TTL fields as one state transition.
 *
 * @param item - Strictly parsed File row.
 */
function validateFileDeletion(item: ParsedFileItem): void {
  if (!item.deletedAt) {
    if (item.retentionUntil !== undefined || item.expiresAt !== undefined) {
      throw new FileIntegrityFailure('FILE_DELETION_STATE_MISMATCH')
    }
    return
  }
  if (
    !item.retentionUntil || item.expiresAt === undefined ||
    !isCanonicalTimestamp(item.deletedAt) ||
    !isCanonicalTimestamp(item.retentionUntil)
  ) {
    throw new FileIntegrityFailure('FILE_DELETION_STATE_MISMATCH')
  }
  const deletedTime = Date.parse(item.deletedAt)
  const retentionTime = Date.parse(item.retentionUntil)
  if (
    retentionTime <= deletedTime ||
    item.expiresAt !== Math.floor(retentionTime / 1_000)
  ) {
    throw new FileIntegrityFailure('FILE_DELETION_STATE_MISMATCH')
  }
}

/**
 * Validates the relationship among immutable version identity, verification, and scan state.
 *
 * @param version - Strictly parsed stored File version.
 */
function validateObjectVersionState(version: ParsedFileVersion): void {
  const hasObjectVersion = version.objectVersionId !== undefined
  const hasVerification = version.verifiedAt !== undefined
  if (
    hasObjectVersion !== hasVerification ||
    (hasObjectVersion && version.scanStatus === 'pending') ||
    (!hasObjectVersion && version.scanStatus !== 'pending')
  ) {
    throw new FileIntegrityFailure('FILE_OBJECT_VERSION_STATE_MISMATCH')
  }
}

/**
 * Adds exact object metadata differences to a result-local failure set.
 *
 * @param reference - Expected File metadata reference.
 * @param observation - Exact observed object metadata.
 * @param failures - Mutable set of secret-free failure categories.
 */
function compareObjectMetadata(
  reference: FileIntegrityReference,
  observation: FileIntegrityObjectObservation,
  failures: Set<FileIntegrityFailureCode>,
): void {
  if (reference.sizeBytes !== observation.sizeBytes) {
    failures.add('FILE_OBJECT_SIZE_MISMATCH')
  }
  if (reference.contentType !== observation.contentType) {
    failures.add('FILE_OBJECT_CONTENT_TYPE_MISMATCH')
  }
  if (!isAllowedObservedScanStatus(reference.scanStatus, observation.scanStatus)) {
    failures.add('FILE_OBJECT_SCAN_STATUS_MISMATCH')
  }
  if (!isAllowedObservedUploadState(reference.scanStatus, observation)) {
    failures.add('FILE_OBJECT_UPLOAD_STATE_MISMATCH')
  }
  if (!isAllowedObservedDeletion(reference.deleted, observation.deleted)) {
    failures.add('FILE_OBJECT_DELETED_MISMATCH')
  }
}

/**
 * Accepts exact scan state or a terminal GuardDuty state observed before a scanning row converges.
 *
 * @param stored - Scan state persisted in the File row.
 * @param observed - Scan state observed on the exact immutable object version.
 * @returns Whether the pair is reachable under the File upload lifecycle.
 */
function isAllowedObservedScanStatus(stored: FileScanStatus, observed: FileScanStatus): boolean {
  if (stored === 'scanning') {
    return observed === 'scanning' || observed === 'available' ||
      observed === 'blocked' || observed === 'failed'
  }
  return stored === observed
}

/**
 * Validates upload tag ordering against stored and observed malware scan state.
 *
 * @param storedScanStatus - Scan state persisted in the File row.
 * @param observation - Exact object observation including upload lifecycle state.
 * @returns Whether the upload tag is reachable under the File upload lifecycle.
 */
function isAllowedObservedUploadState(
  storedScanStatus: FileScanStatus,
  observation: FileIntegrityObjectObservation,
): boolean {
  if (storedScanStatus === 'available') {
    return observation.scanStatus === 'available' && observation.uploadState === 'completed'
  }
  if (storedScanStatus === 'blocked' || storedScanStatus === 'failed') {
    return observation.uploadState === 'pending'
  }
  if (storedScanStatus === 'scanning') {
    return observation.scanStatus === 'available' || observation.uploadState === 'pending'
  }
  return false
}

/**
 * Validates the one-way deleted quarantine transition.
 *
 * A soft-delete row is committed before synchronous tagging and its durable audit consumer retry,
 * so both untagged and tagged objects are reachable while the tombstone is retained. A live row
 * can never legitimately point at an already quarantined immutable version.
 *
 * @param storedDeleted - Whether the File row is a soft-delete tombstone.
 * @param observedDeleted - Whether the object carries the deleted quarantine tag.
 * @returns Whether the pair is reachable under the File deletion lifecycle.
 */
function isAllowedObservedDeletion(
  storedDeleted: boolean,
  observedDeleted: boolean,
): boolean {
  return storedDeleted || !observedDeleted
}

/**
 * Constructs an evidence-safe result with deterministically ordered unique failures.
 *
 * @param checkedVersionCount - Number of strictly parsed versions.
 * @param checkedObjectCount - Number of strictly parsed object observations.
 * @param failureCodes - Detected failure categories.
 * @returns Secret-free integrity result.
 */
function createIntegrityResult(
  checkedVersionCount: number,
  checkedObjectCount: number,
  failureCodes: readonly FileIntegrityFailureCode[],
): FileMetadataIntegrityResult {
  const sortedCodes = [...new Set(failureCodes.map(mapEvidenceFailureCode))].sort()
  return {
    ok: sortedCodes.length === 0,
    checkedVersionCount,
    checkedObjectCount,
    failureCodes: sortedCodes,
  }
}

/**
 * Maps detailed process-local failures to the stable cross-domain evidence contract.
 *
 * @param code - Detailed process-local failure category.
 * @returns Stable secret-free cross-domain failure category.
 */
function mapEvidenceFailureCode(
  code: FileIntegrityFailureCode,
): FileMetadataIntegrityFailureCode {
  switch (code) {
    case 'FILE_SCOPE_INVALID':
    case 'FILE_SCOPE_KEY_MISMATCH':
    case 'FILE_TARGET_INVALID':
    case 'FILE_TARGET_MISMATCH':
      return 'FILE_METADATA_TENANT_MISMATCH'
    case 'FILE_OBJECT_MISSING':
      return 'FILE_METADATA_OBJECT_MISSING'
    case 'FILE_OBJECT_CONTENT_TYPE_MISMATCH':
    case 'FILE_OBJECT_DELETED_MISMATCH':
    case 'FILE_OBJECT_OBSERVATION_DUPLICATE':
    case 'FILE_OBJECT_OBSERVATION_INVALID':
    case 'FILE_OBJECT_SCAN_STATUS_MISMATCH':
    case 'FILE_OBJECT_SIZE_MISMATCH':
    case 'FILE_OBJECT_UPLOAD_STATE_MISMATCH':
    case 'FILE_OBJECT_VERSION_ID_MISMATCH':
      return 'FILE_METADATA_OBJECT_MISMATCH'
    case 'FILE_CURRENT_VERSION_MISSING':
    case 'FILE_DELETION_STATE_MISMATCH':
    case 'FILE_ITEM_INVALID':
    case 'FILE_OBJECT_KEY_MISMATCH':
    case 'FILE_OBJECT_ORPHANED':
    case 'FILE_OBJECT_VERSION_STATE_MISMATCH':
    case 'FILE_RECORD_KEY_MISMATCH':
    case 'FILE_VERSION_DUPLICATE':
    case 'FILE_VERSION_INVALID':
    case 'FILE_VERSION_SEQUENCE_MISMATCH':
      return 'FILE_METADATA_REFERENCE_MISSING'
  }
}

/**
 * Builds the canonical File object key from validated row fields.
 *
 * @param workspaceId - Workspace identifier.
 * @param fileId - File identifier.
 * @param versionId - File version identifier.
 * @param fileName - Canonical display file name.
 * @returns Canonical object key.
 */
function createCanonicalObjectKey(
  workspaceId: string,
  fileId: string,
  versionId: string,
  fileName: string,
): string {
  return [
    'workspaces',
    encodeURIComponent(workspaceId),
    'files',
    encodeURIComponent(fileId),
    encodeURIComponent(versionId),
    encodeURIComponent(fileName),
  ].join('/')
}

/**
 * Creates an unambiguous process-local object identity.
 *
 * @param objectKey - Exact object key.
 * @param objectVersionId - Exact immutable object version identifier.
 * @returns Process-local compound identity.
 */
function createObjectIdentity(objectKey: string, objectVersionId: string): string {
  return JSON.stringify([objectKey, objectVersionId])
}

/**
 * Parses the explicit check clock used for retention decisions.
 *
 * @param value - Caller-supplied canonical timestamp.
 * @returns Timestamp as epoch milliseconds.
 * @throws {TypeError} When the timestamp is not canonical ISO 8601.
 */
function readCheckedAt(value: unknown): number {
  if (typeof value !== 'string' || !isCanonicalTimestamp(value)) {
    throw new TypeError('File integrity checkedAt is invalid.')
  }
  return Date.parse(value)
}

/**
 * Determines whether a valid soft-delete tombstone is beyond its retention deadline.
 *
 * DynamoDB may retain an expired TTL row, so an expired tombstone contributes only row
 * invariants and no S3 existence, metadata, or orphan requirements.
 *
 * @param references - Validated references from one File row.
 * @param checkedAt - Explicit check clock in epoch milliseconds.
 * @returns Whether every reference belongs to the same expired soft-delete tombstone.
 */
function isExpiredTombstone(
  references: readonly FileIntegrityReference[],
  checkedAt: number,
): boolean {
  return references.length > 0 && references.every((reference) =>
    reference.deleted &&
    reference.retentionUntil !== undefined &&
    Date.parse(reference.retentionUntil) <= checkedAt
  )
}

/**
 * Reads a trimmed non-empty string.
 *
 * @param value - Untrusted value.
 * @param code - Failure emitted when the value is invalid.
 * @returns Validated string.
 */
function readText(value: unknown, code: FileIntegrityFailureCode): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new FileIntegrityFailure(code)
  }
  return value
}

/**
 * Reads an optional trimmed non-empty string.
 *
 * @param value - Untrusted optional value.
 * @param code - Failure emitted when a present value is invalid.
 * @returns Validated string or undefined.
 */
function readOptionalText(
  value: unknown,
  code: FileIntegrityFailureCode,
): string | undefined {
  return value === undefined ? undefined : readText(value, code)
}

/**
 * Reads a positive safe integer.
 *
 * @param value - Untrusted numeric value.
 * @param code - Failure emitted when the value is invalid.
 * @returns Validated positive safe integer.
 */
function readPositiveSafeInteger(value: unknown, code: FileIntegrityFailureCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new FileIntegrityFailure(code)
  }
  return value
}

/**
 * Reads an optional safe integer.
 *
 * @param value - Untrusted optional numeric value.
 * @param code - Failure emitted when a present value is invalid.
 * @returns Validated safe integer or undefined.
 */
function readOptionalSafeInteger(
  value: unknown,
  code: FileIntegrityFailureCode,
): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new FileIntegrityFailure(code)
  }
  return value
}

/**
 * Reads a boolean.
 *
 * @param value - Untrusted value.
 * @param code - Failure emitted when the value is invalid.
 * @returns Validated boolean.
 */
function readBoolean(value: unknown, code: FileIntegrityFailureCode): boolean {
  if (typeof value !== 'boolean') {
    throw new FileIntegrityFailure(code)
  }
  return value
}

/**
 * Reads a canonical stored file name.
 *
 * @param value - Untrusted file name.
 * @returns Validated file name.
 */
function readFileName(value: unknown): string {
  const fileName = readText(value, 'FILE_VERSION_INVALID')
  const hasInvalidCharacter = [...fileName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return character === '/' || character === '\\' || codePoint < 32 || codePoint === 127
  })
  if (
    fileName.length > 255 || fileName === '.' || fileName === '..' ||
    hasInvalidCharacter
  ) {
    throw new FileIntegrityFailure('FILE_VERSION_INVALID')
  }
  return fileName
}

/**
 * Reads a canonical lowercase media type without parameters.
 *
 * @param value - Untrusted media type.
 * @param code - Failure emitted when the media type is invalid.
 * @returns Validated canonical media type.
 */
function readContentType(value: unknown, code: FileIntegrityFailureCode): string {
  const contentType = readText(value, code)
  if (
    normalizeFileContentType(contentType) !== contentType ||
    !isAllowedFileContentType(contentType)
  ) {
    throw new FileIntegrityFailure(code)
  }
  return contentType
}

/**
 * Reads the canonical File upload lifecycle tag value.
 *
 * @param value - Untrusted upload tag value.
 * @returns Validated upload lifecycle state.
 */
function readUploadState(value: unknown): FileIntegrityUploadState {
  if (value !== 'pending' && value !== 'completed') {
    throw new FileIntegrityFailure('FILE_OBJECT_OBSERVATION_INVALID')
  }
  return value
}

/**
 * Reads a canonical File scan status.
 *
 * @param value - Untrusted scan status.
 * @param code - Failure emitted when the status is invalid.
 * @returns Validated scan status.
 */
function readScanStatus(value: unknown, code: FileIntegrityFailureCode): FileScanStatus {
  if (typeof value !== 'string' || !isFileScanStatus(value)) {
    throw new FileIntegrityFailure(code)
  }
  return value
}

/**
 * Reads a canonical attachment target type.
 *
 * @param value - Untrusted attachment target type.
 * @returns Validated target type.
 */
function readTargetType(value: unknown): FileAttachmentTargetType {
  if (typeof value !== 'string' || !isFileTargetType(value)) {
    throw new FileIntegrityFailure('FILE_TARGET_INVALID')
  }
  return value
}

/**
 * Narrows a string to a canonical File scan status.
 *
 * @param value - String candidate.
 * @returns Whether the value is a File scan status.
 */
function isFileScanStatus(value: string): value is FileScanStatus {
  return value === 'pending' || value === 'scanning' || value === 'available' ||
    value === 'blocked' || value === 'failed'
}

/**
 * Narrows a string to a canonical File attachment target type.
 *
 * @param value - String candidate.
 * @returns Whether the value is a File attachment target type.
 */
function isFileTargetType(value: string): value is FileAttachmentTargetType {
  return value === 'work-item' || value === 'comment' || value === 'project'
}

/**
 * Determines whether a string is a canonical ISO 8601 timestamp.
 *
 * @param value - Timestamp candidate.
 * @returns Whether the value round-trips through the canonical ISO representation.
 */
function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

/**
 * Determines whether an unknown value is a non-array object record.
 *
 * @param value - Untrusted value.
 * @returns Whether the value supports string-keyed field reads.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
