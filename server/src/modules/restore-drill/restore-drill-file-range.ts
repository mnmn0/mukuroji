import { createHmac, timingSafeEqual } from 'node:crypto'
import { FILE_UPLOAD_MAX_SIZE_BYTES } from '../file-upload-policy'

/** Exact byte count verified by one resumable File verification step. */
export const RESTORE_DRILL_FILE_RANGE_SIZE_BYTES = 16 * 1_024 * 1_024

/** Production File upload ceiling accepted by the restore drill. */
export const RESTORE_DRILL_FILE_MAXIMUM_BYTES = FILE_UPLOAD_MAX_SIZE_BYTES

/** Stable failures emitted by the pure File range checkpoint boundary. */
export type RestoreDrillFileRangeFailureCode =
  | 'CHECKPOINT_INVALID'
  | 'RANGE_DIGEST_MISMATCH'
  | 'RANGE_INPUT_INVALID'

/** Raw-value-free failure raised by File range checkpoint validation. */
export class RestoreDrillFileRangeFailure extends Error {
  /** Stable machine-readable failure category. */
  readonly code: RestoreDrillFileRangeFailureCode

  /**
   * Creates a File range checkpoint failure without retaining input data.
   *
   * @param code - Stable failure category.
   */
  constructor(code: RestoreDrillFileRangeFailureCode) {
    super(code)
    this.name = 'RestoreDrillFileRangeFailure'
    this.code = code
  }
}

/** Exact source and destination identity bound into every range checkpoint. */
export type RestoreDrillFileRangeBinding = {
  /** Exact immutable destination bucket. */
  readonly destinationBucketName: string
  /** Exact immutable destination S3 VersionId. */
  readonly destinationObjectVersionId: string
  /** Stable digest binding the copy namespace to one drill. */
  readonly drillDigest: string
  /** File-domain version identifier shared by source and isolated metadata. */
  readonly fileVersionId: string
  /** Canonical object key shared by source and destination. */
  readonly objectKey: string
  /** Exact immutable source bucket. */
  readonly sourceBucketName: string
  /** Exact immutable source S3 VersionId. */
  readonly sourceObjectVersionId: string
  /** Exact complete object byte count. */
  readonly totalBytes: number
}

/** Compact authenticated progress for one exact File source/destination pair. */
export type RestoreDrillFileRangeCheckpoint = {
  /** HMAC binding the checkpoint to the exact physical and portable identities. */
  readonly bindingDigest: string
  /** HMAC chain over every verified range digest in byte order. */
  readonly chainDigest: string
  /** HMAC authenticating every retained checkpoint field. */
  readonly checkpointMac: string
  /** Fixed checkpoint contract version. */
  readonly checkpointVersion: 1
  /** Discriminator preventing unrelated state records from substitution. */
  readonly kind: 'restore-drill-file-range-checkpoint'
  /** First unverified byte offset. */
  readonly nextOffset: number
  /** Number of complete fixed-order ranges represented by the chain. */
  readonly rangeCount: number
  /** Exact complete object byte count. */
  readonly totalBytes: number
}

/** Exact inclusive S3 byte range selected for one invocation. */
export type RestoreDrillFileRangeWindow = {
  /** Inclusive final byte offset. */
  readonly end: number
  /** Exact number of bytes in this range. */
  readonly length: number
  /** Canonical S3 Range request header. */
  readonly rangeHeader: string
  /** Inclusive first byte offset. */
  readonly start: number
}

/** Input for advancing one authenticated File range chain. */
export type AdvanceRestoreDrillFileRangeInput = {
  /** Exact source/destination identity expected by the checkpoint. */
  readonly binding: RestoreDrillFileRangeBinding
  /** Current authenticated checkpoint. */
  readonly checkpoint: RestoreDrillFileRangeCheckpoint
  /** Independently streamed destination range SHA-256. */
  readonly destinationRangeSha256: string
  /** Invocation-local 32-byte HMAC key. */
  readonly digestKey: Uint8Array
  /** Independently streamed source range SHA-256. */
  readonly sourceRangeSha256: string
  /** Exact range selected from the current checkpoint. */
  readonly window: RestoreDrillFileRangeWindow
}

/** Result of advancing one authenticated File range chain. */
export type AdvanceRestoreDrillFileRangeResult = {
  /** Whether every object byte is now represented by the chain. */
  readonly complete: boolean
  /** Deterministic next checkpoint, suitable for response-loss replay. */
  readonly checkpoint: RestoreDrillFileRangeCheckpoint
}

/**
 * Creates the initial authenticated range checkpoint for one exact File copy.
 *
 * @param binding - Exact portable and physical File identities.
 * @param digestKey - Invocation-local 32-byte HMAC key.
 * @returns Empty authenticated range chain.
 */
export function createRestoreDrillFileRangeCheckpoint(
  binding: RestoreDrillFileRangeBinding,
  digestKey: Uint8Array,
): RestoreDrillFileRangeCheckpoint {
  validateBinding(binding)
  validateDigestKey(digestKey)
  const bindingDigest = calculateBindingDigest(binding, digestKey)
  const withoutMac: Omit<RestoreDrillFileRangeCheckpoint, 'checkpointMac'> = {
    bindingDigest,
    chainDigest: createHmac('sha256', digestKey)
      .update('mukuroji-restore-drill-file-range-chain-initial-v1\0', 'utf8')
      .update(bindingDigest, 'utf8')
      .update('\0', 'utf8')
      .update(String(binding.totalBytes), 'utf8')
      .digest('hex'),
    checkpointVersion: 1,
    kind: 'restore-drill-file-range-checkpoint',
    nextOffset: 0,
    rangeCount: 0,
    totalBytes: binding.totalBytes,
  }
  return withCheckpointMac(withoutMac, digestKey)
}

/**
 * Authenticates a checkpoint and selects its one exact next S3 byte range.
 *
 * @param binding - Exact portable and physical File identities.
 * @param checkpoint - Untrusted durable range checkpoint.
 * @param digestKey - Invocation-local 32-byte HMAC key.
 * @returns Exact inclusive range to stream during this invocation.
 */
export function selectRestoreDrillFileRangeWindow(
  binding: RestoreDrillFileRangeBinding,
  checkpoint: RestoreDrillFileRangeCheckpoint,
  digestKey: Uint8Array,
): RestoreDrillFileRangeWindow {
  validateCheckpoint(binding, checkpoint, digestKey)
  if (checkpoint.nextOffset >= checkpoint.totalBytes) {
    throw new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID')
  }
  const start = checkpoint.nextOffset
  const end = Math.min(
    checkpoint.totalBytes - 1,
    start + RESTORE_DRILL_FILE_RANGE_SIZE_BYTES - 1,
  )
  return {
    end,
    length: end - start + 1,
    rangeHeader: `bytes=${start}-${end}`,
    start,
  }
}

/**
 * Adds one independently matched source/destination range to the authenticated chain.
 *
 * @param input - Exact binding, checkpoint, range, and independently observed digests.
 * @returns Deterministic next checkpoint and completion state.
 */
export function advanceRestoreDrillFileRangeCheckpoint(
  input: AdvanceRestoreDrillFileRangeInput,
): AdvanceRestoreDrillFileRangeResult {
  validateCheckpoint(input.binding, input.checkpoint, input.digestKey)
  const expectedWindow = selectRestoreDrillFileRangeWindow(
    input.binding,
    input.checkpoint,
    input.digestKey,
  )
  if (
    input.window.start !== expectedWindow.start ||
    input.window.end !== expectedWindow.end ||
    input.window.length !== expectedWindow.length ||
    input.window.rangeHeader !== expectedWindow.rangeHeader ||
    !isSha256(input.sourceRangeSha256) ||
    !isSha256(input.destinationRangeSha256)
  ) {
    throw new RestoreDrillFileRangeFailure('RANGE_INPUT_INVALID')
  }
  if (!safeDigestEqual(input.sourceRangeSha256, input.destinationRangeSha256)) {
    throw new RestoreDrillFileRangeFailure('RANGE_DIGEST_MISMATCH')
  }
  const nextOffset = input.window.end + 1
  const rangeCount = input.checkpoint.rangeCount + 1
  const withoutMac: Omit<RestoreDrillFileRangeCheckpoint, 'checkpointMac'> = {
    bindingDigest: input.checkpoint.bindingDigest,
    chainDigest: createHmac('sha256', input.digestKey)
      .update('mukuroji-restore-drill-file-range-chain-step-v1\0', 'utf8')
      .update(input.checkpoint.chainDigest, 'utf8')
      .update('\0', 'utf8')
      .update(String(input.window.start), 'utf8')
      .update('\0', 'utf8')
      .update(String(input.window.end), 'utf8')
      .update('\0source\0', 'utf8')
      .update(input.sourceRangeSha256, 'utf8')
      .update('\0destination\0', 'utf8')
      .update(input.destinationRangeSha256, 'utf8')
      .digest('hex'),
    checkpointVersion: 1,
    kind: 'restore-drill-file-range-checkpoint',
    nextOffset,
    rangeCount,
    totalBytes: input.checkpoint.totalBytes,
  }
  return {
    complete: nextOffset === input.checkpoint.totalBytes,
    checkpoint: withCheckpointMac(withoutMac, input.digestKey),
  }
}

/** Validates one exact File identity binding. */
function validateBinding(binding: RestoreDrillFileRangeBinding): void {
  if (
    typeof binding !== 'object' ||
    binding === null ||
    Array.isArray(binding) ||
    !isBoundedText(binding.destinationBucketName, 63) ||
    !isBoundedText(binding.destinationObjectVersionId, 1_024) ||
    typeof binding.drillDigest !== 'string' ||
    !/^[a-f0-9]{16}$/.test(binding.drillDigest) ||
    !isBoundedText(binding.fileVersionId, 256) ||
    !isBoundedText(binding.objectKey, 1_024) ||
    !isBoundedText(binding.sourceBucketName, 63) ||
    binding.sourceBucketName === binding.destinationBucketName ||
    !isBoundedText(binding.sourceObjectVersionId, 1_024) ||
    !Number.isSafeInteger(binding.totalBytes) ||
    binding.totalBytes < 1 ||
    binding.totalBytes > RESTORE_DRILL_FILE_MAXIMUM_BYTES
  ) {
    throw new RestoreDrillFileRangeFailure('RANGE_INPUT_INVALID')
  }
}

/** Validates one invocation-local HMAC key. */
function validateDigestKey(digestKey: Uint8Array): void {
  if (!(digestKey instanceof Uint8Array) || digestKey.byteLength !== 32) {
    throw new RestoreDrillFileRangeFailure('RANGE_INPUT_INVALID')
  }
}

/** Authenticates every checkpoint field and its deterministic fixed-range progress. */
function validateCheckpoint(
  binding: RestoreDrillFileRangeBinding,
  checkpoint: RestoreDrillFileRangeCheckpoint,
  digestKey: Uint8Array,
): void {
  validateBinding(binding)
  validateDigestKey(digestKey)
  if (
    typeof checkpoint !== 'object' ||
    checkpoint === null ||
    Array.isArray(checkpoint)
  ) {
    throw new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID')
  }
  const keys = Object.keys(checkpoint).sort()
  const expectedKeys = [
    'bindingDigest',
    'chainDigest',
    'checkpointMac',
    'checkpointVersion',
    'kind',
    'nextOffset',
    'rangeCount',
    'totalBytes',
  ]
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    checkpoint.kind !== 'restore-drill-file-range-checkpoint' ||
    checkpoint.checkpointVersion !== 1 ||
    !isSha256(checkpoint.bindingDigest) ||
    !isSha256(checkpoint.chainDigest) ||
    !isSha256(checkpoint.checkpointMac) ||
    checkpoint.totalBytes !== binding.totalBytes ||
    !Number.isSafeInteger(checkpoint.rangeCount) ||
    checkpoint.rangeCount < 0 ||
    !Number.isSafeInteger(checkpoint.nextOffset)
  ) {
    throw new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID')
  }
  const expectedBindingDigest = calculateBindingDigest(binding, digestKey)
  const maximumRangeCount = Math.ceil(binding.totalBytes / RESTORE_DRILL_FILE_RANGE_SIZE_BYTES)
  const expectedNextOffset = Math.min(
    checkpoint.rangeCount * RESTORE_DRILL_FILE_RANGE_SIZE_BYTES,
    binding.totalBytes,
  )
  if (
    !safeDigestEqual(checkpoint.bindingDigest, expectedBindingDigest) ||
    checkpoint.rangeCount > maximumRangeCount ||
    checkpoint.nextOffset !== expectedNextOffset
  ) {
    throw new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID')
  }
  const expectedMac = calculateCheckpointMac(checkpoint, digestKey)
  if (!safeDigestEqual(checkpoint.checkpointMac, expectedMac)) {
    throw new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID')
  }
}

/** Calculates the opaque HMAC binding for one exact source/destination pair. */
function calculateBindingDigest(
  binding: RestoreDrillFileRangeBinding,
  digestKey: Uint8Array,
): string {
  return createHmac('sha256', digestKey)
    .update('mukuroji-restore-drill-file-range-binding-v1\0', 'utf8')
    .update(JSON.stringify({
      destinationBucketName: binding.destinationBucketName,
      destinationObjectVersionId: binding.destinationObjectVersionId,
      drillDigest: binding.drillDigest,
      fileVersionId: binding.fileVersionId,
      objectKey: binding.objectKey,
      sourceBucketName: binding.sourceBucketName,
      sourceObjectVersionId: binding.sourceObjectVersionId,
      totalBytes: binding.totalBytes,
    }), 'utf8')
    .digest('hex')
}

/** Adds an authentication MAC to detached checkpoint fields. */
function withCheckpointMac(
  checkpoint: Omit<RestoreDrillFileRangeCheckpoint, 'checkpointMac'>,
  digestKey: Uint8Array,
): RestoreDrillFileRangeCheckpoint {
  return {
    ...checkpoint,
    checkpointMac: calculateCheckpointMac(checkpoint, digestKey),
  }
}

/** Calculates the HMAC over every retained checkpoint field. */
function calculateCheckpointMac(
  checkpoint: Omit<RestoreDrillFileRangeCheckpoint, 'checkpointMac'>,
  digestKey: Uint8Array,
): string {
  return createHmac('sha256', digestKey)
    .update('mukuroji-restore-drill-file-range-checkpoint-v1\0', 'utf8')
    .update(JSON.stringify({
      bindingDigest: checkpoint.bindingDigest,
      chainDigest: checkpoint.chainDigest,
      checkpointVersion: checkpoint.checkpointVersion,
      kind: checkpoint.kind,
      nextOffset: checkpoint.nextOffset,
      rangeCount: checkpoint.rangeCount,
      totalBytes: checkpoint.totalBytes,
    }), 'utf8')
    .digest('hex')
}

/** Compares two already validated hexadecimal SHA-256 digests. */
function safeDigestEqual(left: string, right: string): boolean {
  if (!isSha256(left) || !isSha256(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Checks a lowercase hexadecimal SHA-256 digest. */
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Checks one non-empty UTF-8 value against a byte ceiling. */
function isBoundedText(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
}
