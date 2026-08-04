import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { types as nodeUtilTypes } from 'node:util'
import { isHexDigest } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalRateRecorder,
  recoverWorkspaceSearchMigrationRehearsalRateContinuation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_KEY_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalRateRecorder,
} from './migration-rehearsal-rate-evidence'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Maximum exact bytes accepted for one runtime-owned canonical record. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_RUNTIME_RECORD_MAX_BYTES =
  4 * 1_024

const segmentLocatorDomain =
  'mukuroji-workspace-search-migration-rehearsal-rate-runtime/v1/segment\0'
const ownerOnlyFileMode = 0o600
const maximumRuntimePathLength = 4_096

/** Stable raw-value-free runtime failure categories. */
export type WorkspaceSearchMigrationRehearsalRateRuntimeFailureCode =
  | 'DURABILITY_FAILED'
  | 'FILE_BOUNDARY_FAILED'
  | 'INVALID_ARGUMENT'
  | 'RUNTIME_CLOSED'

/** Stable failure raised by the process-local durable rate boundary. */
export class WorkspaceSearchMigrationRehearsalRateRuntimeError extends Error {
  /** Machine-readable failure containing no path, key, or record bytes. */
  readonly code: WorkspaceSearchMigrationRehearsalRateRuntimeFailureCode

  /**
   * Creates one redacted process-local runtime failure.
   *
   * @param code - Stable raw-value-free failure category.
   */
  constructor(code: WorkspaceSearchMigrationRehearsalRateRuntimeFailureCode) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalRateRuntimeError'
    this.code = code
  }
}

/** Exclusive append-only segment file owned by one child process. */
export interface WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile {
  /**
   * Appends exactly one complete record and resolves only after file fsync.
   *
   * @param canonicalRecordBytes - Exact canonical JSON plus one trailing LF.
   */
  appendRecordDurably(canonicalRecordBytes: Uint8Array): Promise<void>

  /** Closes the segment descriptor exactly once. */
  close(): Promise<void>
}

/** Injectable process and filesystem effects for one runtime instance. */
export type WorkspaceSearchMigrationRehearsalRateRuntimeDependencies = {
  /** Exclusively creates one mode-0600 no-follow append-only segment file. */
  readonly openSegmentFileExclusive: (
    path: string,
  ) => Promise<WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile>
  /** Reads one stable owner-only predecessor without following symlinks. */
  readonly readPreviousSegmentFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>
  /** Returns fresh process-local entropy used only for an opaque locator. */
  readonly createSegmentEntropy: () => Uint8Array
  /** Returns a trusted native Date anchor for the process segment. */
  readonly wallClock: () => Date
  /** Returns a non-negative integral process-monotonic clock value. */
  readonly monotonicClock: () => number
}

/** Exact reviewed binding and file selection for one child process segment. */
export type CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput = {
  /** New output file that must not already exist. */
  readonly segmentFile: string
  /** Optional preceding process segment read-only file. */
  readonly previousSegmentFile?: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly expectedPolicyVersion: string
  /** Reviewed measured non-production configuration digest. */
  readonly expectedConfigurationBindingDigest: string
  /** Same secure 32-byte permit/evidence key used by the rehearsal session. */
  readonly authenticationKey: Uint8Array
}

/** Process-local durable recorder lifecycle installed into the AWS session. */
export interface WorkspaceSearchMigrationRehearsalRateRuntime {
  /** Fail-closed recorder that replaces the optional telemetry rate recorder. */
  readonly recorder: WorkspaceSearchMigrationRehearsalRateRecorder

  /**
   * Waits for every queued observation to reach an fsynced record boundary.
   *
   * @returns Exact confirmed process-segment metadata.
   */
  flush(): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment>

  /** Flushes, zeroizes recorder key ownership, and closes the segment file. */
  close(): Promise<void>
}

/** Detached validated runtime input retained across filesystem awaits. */
type PreparedRuntimeInput = {
  /** New output segment path. */
  readonly segmentFile: string
  /** Optional read-only predecessor path. */
  readonly previousSegmentFile?: string
  /** Reviewed policy digest. */
  readonly expectedPolicyVersion: string
  /** Reviewed configuration digest. */
  readonly expectedConfigurationBindingDigest: string
  /** Runtime-owned temporary authentication-key copy. */
  readonly authenticationKey: Uint8Array
}

/** Detached validated runtime dependencies. */
type PreparedRuntimeDependencies = {
  /** Detached exclusive output opener. */
  readonly openSegmentFileExclusive:
    WorkspaceSearchMigrationRehearsalRateRuntimeDependencies[
      'openSegmentFileExclusive'
    ]
  /** Detached stable predecessor reader. */
  readonly readPreviousSegmentFile:
    WorkspaceSearchMigrationRehearsalRateRuntimeDependencies[
      'readPreviousSegmentFile'
    ]
  /** Detached entropy source. */
  readonly createSegmentEntropy:
    WorkspaceSearchMigrationRehearsalRateRuntimeDependencies[
      'createSegmentEntropy'
    ]
  /** Detached trusted wall clock. */
  readonly wallClock:
    WorkspaceSearchMigrationRehearsalRateRuntimeDependencies['wallClock']
  /** Detached trusted monotonic clock. */
  readonly monotonicClock:
    WorkspaceSearchMigrationRehearsalRateRuntimeDependencies[
      'monotonicClock'
    ]
}

/** Stable file identity checked before and after one predecessor read. */
type SecureRateFileIdentity = {
  /** Device identifier. */
  readonly device: number
  /** Inode identifier. */
  readonly inode: number
  /** Exact file byte length. */
  readonly size: number
  /** Exact permission bits. */
  readonly mode: number
  /** Exact owning user identifier. */
  readonly userId: number
  /** Exact hard-link count. */
  readonly linkCount: number
  /** Last-modification timestamp. */
  readonly modifiedAtMilliseconds: number
  /** Metadata-change timestamp. */
  readonly changedAtMilliseconds: number
}

const runtimeGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failRateRuntime('INVALID_ARGUMENT'),
)

/** Default real filesystem and process effects for an executed child. */
const defaultRateRuntimeDependencies:
  WorkspaceSearchMigrationRehearsalRateRuntimeDependencies = Object.freeze({
    openSegmentFileExclusive:
      openWorkspaceSearchMigrationRehearsalRateSegmentFileExclusive,
    readPreviousSegmentFile:
      readWorkspaceSearchMigrationRehearsalPreviousRateSegmentFile,
    createSegmentEntropy: (): Uint8Array => new Uint8Array(randomBytes(32)),
    wallClock: (): Date => new Date(),
    monotonicClock: (): number => Math.floor(performance.now()),
  })

/**
 * Creates one process-local durable HMAC rate segment before AWS composition.
 *
 * @param input - Exact new file, predecessor, reviewed bindings, and key.
 * @param dependencies - Injectable secure filesystem, clocks, and entropy.
 * @returns Runtime whose recorder must replace the optional telemetry recorder.
 */
export async function createWorkspaceSearchMigrationRehearsalRateRuntime(
  input: CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
  dependencies:
    WorkspaceSearchMigrationRehearsalRateRuntimeDependencies =
      defaultRateRuntimeDependencies,
): Promise<WorkspaceSearchMigrationRehearsalRateRuntime> {
  return await runRateRuntimeAsyncBoundary(async () => {
    const preparedInput = prepareRuntimeInput(input)
    const preparedDependencies = prepareRuntimeDependencies(dependencies)
    let segmentFile:
      WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile | undefined
    let rateRecorder: WorkspaceSearchMigrationRehearsalRateRecorder | undefined
    try {
      const continuation = preparedInput.previousSegmentFile === undefined
        ? undefined
        : recoverWorkspaceSearchMigrationRehearsalRateContinuation({
            previousSegmentBytes:
              await preparedDependencies.readPreviousSegmentFile(
                preparedInput.previousSegmentFile,
                WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
              ),
            authenticationKey: preparedInput.authenticationKey,
            expectedPolicyVersion: preparedInput.expectedPolicyVersion,
            expectedConfigurationBindingDigest:
              preparedInput.expectedConfigurationBindingDigest,
          })
      const anchor = readRuntimeAnchors(preparedDependencies)
      const segmentOrdinal = continuation?.segmentOrdinal ?? 0
      const segmentLocatorDigest = createSegmentLocatorDigest(
        preparedDependencies.createSegmentEntropy(),
        preparedInput,
        segmentOrdinal,
        anchor.anchorUtc,
      )
      segmentFile = await preparedDependencies.openSegmentFileExclusive(
        preparedInput.segmentFile,
      )
      const activeSegmentFile = segmentFile
      rateRecorder =
        await createWorkspaceSearchMigrationRehearsalRateRecorder({
          segmentLocatorDigest,
          segmentOrdinal,
          previousSegmentDigest:
            continuation?.previousSegmentDigest ?? null,
          previousRecordMac: continuation?.previousRecordMac ?? null,
          firstEventSequence: continuation?.firstEventSequence ?? 1,
          anchorUtc: anchor.anchorUtc,
          monotonicAnchorMilliseconds: anchor.monotonicAnchorMilliseconds,
          policyVersion: preparedInput.expectedPolicyVersion,
          configurationBindingDigest:
            preparedInput.expectedConfigurationBindingDigest,
          authenticationKey: preparedInput.authenticationKey,
          appendDurably: async (bytes): Promise<void> => {
            await activeSegmentFile.appendRecordDurably(bytes)
          },
        })
      if (continuation?.pendingAttempt !== null &&
        continuation?.pendingAttempt !== undefined) {
        await rateRecorder.appendForfeitedAttempt({
          attemptSequence: continuation.pendingAttempt.attemptSequence,
          phase: continuation.pendingAttempt.phase,
          observedAtMilliseconds: anchor.monotonicAnchorMilliseconds,
        })
      }
      const activeRateRecorder = rateRecorder
      segmentFile = undefined
      rateRecorder = undefined
      return new DurableWorkspaceSearchMigrationRehearsalRateRuntime(
        activeRateRecorder,
        activeSegmentFile,
      )
    } catch (error: unknown) {
      if (rateRecorder !== undefined) {
        try {
          await rateRecorder.close()
        } catch {
          // Preserve the primary stable construction failure.
        }
      }
      if (segmentFile !== undefined) {
        try {
          await segmentFile.close()
        } catch {
          // Preserve the primary stable construction failure.
        }
      }
      throw error
    } finally {
      preparedInput.authenticationKey.fill(0)
    }
  })
}

/** Concrete fail-closed recorder and output-file lifecycle. */
class DurableWorkspaceSearchMigrationRehearsalRateRuntime
  implements WorkspaceSearchMigrationRehearsalRateRuntime {
  /** Recorder installed into the managed rate controller. */
  readonly recorder: WorkspaceSearchMigrationRehearsalRateRecorder

  /** Exclusive process-local output file. */
  readonly #segmentFile:
    WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile

  /** Whether close has already completed or started. */
  #closed = false

  /**
   * Creates one runtime around an initialized fsynced segment header.
   *
   * @param recorder - HMAC recorder whose header is already durable.
   * @param segmentFile - Exclusive append-only output file.
   */
  constructor(
    recorder: WorkspaceSearchMigrationRehearsalRateRecorder,
    segmentFile: WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile,
  ) {
    this.recorder = recorder
    this.#segmentFile = segmentFile
  }

  /** Returns the exact confirmed durable process-segment prefix. */
  async flush(): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment> {
    if (this.#closed) return failRateRuntime('RUNTIME_CLOSED')
    try {
      return await this.recorder.flush()
    } catch {
      return failRateRuntime('DURABILITY_FAILED')
    }
  }

  /** Flushes, zeroizes recorder ownership, and closes the output descriptor. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    let failed = false
    try {
      await this.recorder.flush()
    } catch {
      failed = true
    }
    try {
      await this.recorder.close()
    } catch {
      failed = true
    }
    try {
      await this.#segmentFile.close()
    } catch {
      failed = true
    }
    if (failed) return failRateRuntime('DURABILITY_FAILED')
  }
}

/** Real mode-0600 O_EXCL/O_NOFOLLOW/O_APPEND segment-file implementation. */
class NodeWorkspaceSearchMigrationRehearsalRateSegmentFile
  implements WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile {
  /** Open native file handle retained only by this writer. */
  readonly #file: Awaited<ReturnType<typeof open>>

  /** Stable failure after any partial or unconfirmed append. */
  #failed = false

  /** Whether the native descriptor has been closed. */
  #closed = false

  /**
   * Retains one already validated exclusive output descriptor.
   *
   * @param file - Newly created owner-only append descriptor.
   */
  constructor(file: Awaited<ReturnType<typeof open>>) {
    this.#file = file
  }

  /** Appends one complete canonical record and fsyncs it before resolving. */
  async appendRecordDurably(canonicalRecordBytes: Uint8Array): Promise<void> {
    if (this.#closed || this.#failed) {
      return failRateRuntime('DURABILITY_FAILED')
    }
    const bytes = copyCanonicalRuntimeRecord(canonicalRecordBytes)
    try {
      let offset = 0
      while (offset < bytes.byteLength) {
        const result = await this.#file.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          null,
        )
        if (result.bytesWritten <= 0) {
          return failRateRuntime('DURABILITY_FAILED')
        }
        offset += result.bytesWritten
      }
      await this.#file.sync()
    } catch {
      this.#failed = true
      return failRateRuntime('DURABILITY_FAILED')
    }
  }

  /** Syncs and closes the descriptor exactly once. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    let failed = this.#failed
    try {
      await this.#file.sync()
    } catch {
      failed = true
    }
    try {
      await this.#file.close()
    } catch {
      failed = true
    }
    if (failed) return failRateRuntime('DURABILITY_FAILED')
  }
}

/**
 * Exclusively creates one owner-only no-follow append segment and fsyncs its
 * parent directory entry before returning.
 *
 * @param path - Exact new process-segment output path.
 * @returns Exclusive append-only segment writer.
 */
export async function openWorkspaceSearchMigrationRehearsalRateSegmentFileExclusive(
  path: string,
): Promise<WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile> {
  const safePath = readRuntimePath(path)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let directory: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(
      safePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      ownerOnlyFileMode,
    )
    requireSecureRateFileIdentity(
      await file.stat(),
      0,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
      true,
    )
    directory = await open(
      dirname(safePath),
      constants.O_RDONLY | constants.O_DIRECTORY,
    )
    await directory.sync()
    await directory.close()
    directory = undefined
    const writer = new NodeWorkspaceSearchMigrationRehearsalRateSegmentFile(
      file,
    )
    file = undefined
    return writer
  } catch {
    if (directory !== undefined) {
      try {
        await directory.close()
      } catch {
        // Preserve the stable file-boundary failure.
      }
    }
    if (file !== undefined) {
      try {
        await file.close()
      } catch {
        // Preserve the stable file-boundary failure.
      }
    }
    return failRateRuntime('FILE_BOUNDARY_FAILED')
  }
}

/**
 * Reads one stable mode-0600 predecessor through O_NOFOLLOW and exact fstat
 * identity checks before and after the bounded read.
 *
 * @param path - Explicit read-only predecessor segment path.
 * @param maximumBytes - Inclusive exact byte ceiling.
 * @returns Detached stable predecessor bytes.
 */
export async function readWorkspaceSearchMigrationRehearsalPreviousRateSegmentFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const safePath = readRuntimePath(path)
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
  ) {
    return failRateRuntime('INVALID_ARGUMENT')
  }
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(safePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = requireSecureRateFileIdentity(
      await file.stat(),
      1,
      maximumBytes,
      false,
    )
    const bytes = new Uint8Array(before.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await file.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      )
      if (result.bytesRead <= 0) return failRateRuntime('FILE_BOUNDARY_FAILED')
      offset += result.bytesRead
    }
    const after = requireSecureRateFileIdentity(
      await file.stat(),
      1,
      maximumBytes,
      false,
    )
    if (!secureRateFileIdentityEqual(before, after)) {
      return failRateRuntime('FILE_BOUNDARY_FAILED')
    }
    await file.close()
    file = undefined
    return bytes
  } catch {
    return failRateRuntime('FILE_BOUNDARY_FAILED')
  } finally {
    if (file !== undefined) {
      try {
        await file.close()
      } catch {
        // The stable read failure remains authoritative.
      }
    }
  }
}

/** Strictly snapshots caller input and copies its temporary key ownership. */
function prepareRuntimeInput(
  input: CreateWorkspaceSearchMigrationRehearsalRateRuntimeInput,
): PreparedRuntimeInput {
  const record = runtimeGuards.requireRecord(input)
  const keys = Object.keys(record)
  const hasPrevious = keys.includes('previousSegmentFile')
  runtimeGuards.requireExactKeys(record, [
    'authenticationKey',
    'expectedConfigurationBindingDigest',
    'expectedPolicyVersion',
    'segmentFile',
    ...(hasPrevious ? ['previousSegmentFile'] : []),
  ])
  const authenticationKey = copyRuntimeAuthenticationKey(
    runtimeGuards.readOwn(record, 'authenticationKey'),
  )
  return {
    segmentFile: readRuntimePath(runtimeGuards.readOwn(record, 'segmentFile')),
    ...(hasPrevious
      ? {
          previousSegmentFile: readRuntimePath(
            runtimeGuards.readOwn(record, 'previousSegmentFile'),
          ),
        }
      : {}),
    expectedPolicyVersion: readRuntimeDigest(
      runtimeGuards.readOwn(record, 'expectedPolicyVersion'),
    ),
    expectedConfigurationBindingDigest: readRuntimeDigest(
      runtimeGuards.readOwn(record, 'expectedConfigurationBindingDigest'),
    ),
    authenticationKey,
  }
}

/** Snapshots direct dependency methods before the first filesystem await. */
function prepareRuntimeDependencies(
  dependencies: WorkspaceSearchMigrationRehearsalRateRuntimeDependencies,
): PreparedRuntimeDependencies {
  const record = runtimeGuards.requireRecord(dependencies)
  runtimeGuards.requireExactKeys(record, [
    'createSegmentEntropy',
    'monotonicClock',
    'openSegmentFileExclusive',
    'readPreviousSegmentFile',
    'wallClock',
  ])
  const openSegmentFileExclusive = readRuntimeFunction(
    runtimeGuards.readOwn(record, 'openSegmentFileExclusive'),
  )
  const readPreviousSegmentFile = readRuntimeFunction(
    runtimeGuards.readOwn(record, 'readPreviousSegmentFile'),
  )
  const createSegmentEntropy = readRuntimeFunction(
    runtimeGuards.readOwn(record, 'createSegmentEntropy'),
  )
  const wallClock = readRuntimeFunction(
    runtimeGuards.readOwn(record, 'wallClock'),
  )
  const monotonicClock = readRuntimeFunction(
    runtimeGuards.readOwn(record, 'monotonicClock'),
  )
  return Object.freeze({
    openSegmentFileExclusive: async (path) => {
      const value: unknown = await Reflect.apply(
        openSegmentFileExclusive,
        undefined,
        [path],
      )
      return readRuntimeSegmentFile(value)
    },
    readPreviousSegmentFile: async (path, maximumBytes) => {
      const value: unknown = await Reflect.apply(
        readPreviousSegmentFile,
        undefined,
        [path, maximumBytes],
      )
      return copyRuntimeBytes(value, maximumBytes)
    },
    createSegmentEntropy: () => {
      const value: unknown = Reflect.apply(
        createSegmentEntropy,
        undefined,
        [],
      )
      return copyRuntimeEntropy(value)
    },
    wallClock: () => {
      const value: unknown = Reflect.apply(wallClock, undefined, [])
      if (nodeUtilTypes.isProxy(value) || !nodeUtilTypes.isDate(value)) {
        return failRateRuntime('INVALID_ARGUMENT')
      }
      return new Date(Date.prototype.getTime.call(value))
    },
    monotonicClock: () => {
      const value: unknown = Reflect.apply(monotonicClock, undefined, [])
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        return failRateRuntime('INVALID_ARGUMENT')
      }
      return value
    },
  })
}

/** Reads one direct non-Proxy dependency function. */
function readRuntimeFunction(value: unknown): (...values: never[]) => unknown {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failRateRuntime('INVALID_ARGUMENT')
  }
  return (...values: never[]): unknown =>
    Reflect.apply(value, undefined, values)
}

/** Reads and snapshots one injected segment-file capability. */
function readRuntimeSegmentFile(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failRateRuntime('FILE_BOUNDARY_FAILED')
  }
  const appendDescriptor = readInheritedRuntimeMethod(
    value,
    'appendRecordDurably',
  )
  const closeDescriptor = readInheritedRuntimeMethod(value, 'close')
  const result: WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile = {
    appendRecordDurably: async (bytes: Uint8Array): Promise<void> => {
      await Reflect.apply(appendDescriptor, value, [bytes])
    },
    close: async (): Promise<void> => {
      await Reflect.apply(closeDescriptor, value, [])
    },
  }
  return Object.freeze(result)
}

/** Reads one inherited data method without invoking accessors or Proxy traps. */
function readInheritedRuntimeMethod(
  receiver: object,
  name: string,
): (...values: never[]) => unknown {
  let current: object | null = receiver
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      return failRateRuntime('FILE_BOUNDARY_FAILED')
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failRateRuntime('FILE_BOUNDARY_FAILED')
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
  }
  return failRateRuntime('FILE_BOUNDARY_FAILED')
}

/** Reads exact trusted wall and monotonic anchors from one dependency snapshot. */
function readRuntimeAnchors(dependencies: PreparedRuntimeDependencies): {
  /** Canonical UTC process anchor. */
  readonly anchorUtc: string
  /** Matching process-monotonic anchor. */
  readonly monotonicAnchorMilliseconds: number
} {
  const wall = dependencies.wallClock()
  const epoch = Date.prototype.getTime.call(wall)
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    return failRateRuntime('INVALID_ARGUMENT')
  }
  return Object.freeze({
    anchorUtc: new Date(epoch).toISOString(),
    monotonicAnchorMilliseconds: dependencies.monotonicClock(),
  })
}

/** Creates one unpredictable digest-only process-segment locator. */
function createSegmentLocatorDigest(
  entropyValue: Uint8Array,
  input: PreparedRuntimeInput,
  segmentOrdinal: number,
  anchorUtc: string,
): string {
  try {
    return createHash('sha256')
      .update(segmentLocatorDomain, 'utf8')
      .update(entropyValue)
      .update('\0', 'utf8')
      .update(input.expectedPolicyVersion, 'utf8')
      .update('\0', 'utf8')
      .update(input.expectedConfigurationBindingDigest, 'utf8')
      .update('\0', 'utf8')
      .update(String(segmentOrdinal), 'utf8')
      .update('\0', 'utf8')
      .update(anchorUtc, 'utf8')
      .digest('hex')
  } finally {
    entropyValue.fill(0)
  }
}

/** Copies one exact non-shared 32-byte authentication key. */
function copyRuntimeAuthenticationKey(value: unknown): Uint8Array {
  const bytes = copyRuntimeBytes(
    value,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_KEY_BYTES,
  )
  if (bytes.byteLength !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_KEY_BYTES) {
    bytes.fill(0)
    return failRateRuntime('INVALID_ARGUMENT')
  }
  return bytes
}

/** Copies one bounded non-shared byte vector. */
function copyRuntimeBytes(value: unknown, maximumBytes: number): Uint8Array {
  if (nodeUtilTypes.isProxy(value) || !nodeUtilTypes.isUint8Array(value)) {
    return failRateRuntime('INVALID_ARGUMENT')
  }
  const buffer = runtimeGuards.readIntrinsicBuffer(value)
  const byteLength = runtimeGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength > maximumBytes
  ) {
    return failRateRuntime('INVALID_ARGUMENT')
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failRateRuntime('INVALID_ARGUMENT')
  }
  return copy
}

/** Copies one exact 32-byte entropy source result. */
function copyRuntimeEntropy(value: unknown): Uint8Array {
  const entropy = copyRuntimeBytes(value, 32)
  if (entropy.byteLength !== 32) {
    entropy.fill(0)
    return failRateRuntime('INVALID_ARGUMENT')
  }
  return entropy
}

/** Copies and validates one exact complete canonical record. */
function copyCanonicalRuntimeRecord(value: Uint8Array): Uint8Array {
  const bytes = copyRuntimeBytes(
    value,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_RUNTIME_RECORD_MAX_BYTES,
  )
  if (
    bytes.at(-1) !== 0x0a ||
    bytes.slice(0, -1).includes(0x0a) ||
    bytes.includes(0x0d)
  ) {
    return failRateRuntime('DURABILITY_FAILED')
  }
  return bytes
}

/** Reads one conservative nonempty process-local path. */
function readRuntimePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumRuntimePathLength ||
    value.includes('\0') ||
    value !== value.trim()
  ) {
    return failRateRuntime('INVALID_ARGUMENT')
  }
  return value
}

/** Reads one conventional lowercase SHA-256 digest. */
function readRuntimeDigest(value: unknown): string {
  if (!isHexDigest(value)) return failRateRuntime('INVALID_ARGUMENT')
  return value
}

/** Requires one secure ordinary file identity and returns its stable fields. */
function requireSecureRateFileIdentity(
  status: Stats,
  minimumBytes: number,
  maximumBytes: number,
  requireEmpty: boolean,
): SecureRateFileIdentity {
  const currentUserId = readCurrentUserId()
  if (
    !status.isFile() ||
    status.uid !== currentUserId ||
    (status.mode & 0o777) !== ownerOnlyFileMode ||
    status.nlink !== 1 ||
    !Number.isSafeInteger(status.size) ||
    status.size < minimumBytes ||
    status.size > maximumBytes ||
    (requireEmpty && status.size !== 0)
  ) {
    return failRateRuntime('FILE_BOUNDARY_FAILED')
  }
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    size: status.size,
    mode: status.mode,
    userId: status.uid,
    linkCount: status.nlink,
    modifiedAtMilliseconds: status.mtimeMs,
    changedAtMilliseconds: status.ctimeMs,
  })
}

/** Reads the current POSIX user identifier required by owner-only files. */
function readCurrentUserId(): number {
  if (typeof process.getuid !== 'function') {
    return failRateRuntime('FILE_BOUNDARY_FAILED')
  }
  const userId = process.getuid()
  if (!Number.isSafeInteger(userId) || userId < 0) {
    return failRateRuntime('FILE_BOUNDARY_FAILED')
  }
  return userId
}

/** Compares every predecessor identity field across its bounded read. */
function secureRateFileIdentityEqual(
  left: SecureRateFileIdentity,
  right: SecureRateFileIdentity,
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.userId === right.userId &&
    left.linkCount === right.linkCount &&
    left.modifiedAtMilliseconds === right.modifiedAtMilliseconds &&
    left.changedAtMilliseconds === right.changedAtMilliseconds
}

/** Runs one asynchronous operation behind the stable runtime error boundary. */
async function runRateRuntimeAsyncBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationRehearsalRateRuntimeError) {
      throw new WorkspaceSearchMigrationRehearsalRateRuntimeError(error.code)
    }
    throw new WorkspaceSearchMigrationRehearsalRateRuntimeError(
      'INVALID_ARGUMENT',
    )
  }
}

/** Raises one stable raw-value-free runtime failure. */
function failRateRuntime(
  code: WorkspaceSearchMigrationRehearsalRateRuntimeFailureCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalRateRuntimeError(code)
}
