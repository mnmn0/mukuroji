import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isWorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationCommittedPrefixApplySeal,
  readWorkspaceSearchMigrationCommittedPrefixApplySealReference,
  serializeWorkspaceSearchMigrationCommittedPrefixApplySeal,
  WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_MAX_BYTES,
  type WorkspaceSearchMigrationCommittedPrefixApplySealReference,
} from './migration-committed-prefix-apply-seal'
import type {
  ReadWorkspaceSearchMigrationImmutableArtifactInput,
  WorkspaceSearchMigrationImmutableArtifactAwsPort,
  WorkspaceSearchMigrationImmutableArtifactReference,
  WriteWorkspaceSearchMigrationImmutableArtifactInput,
} from './migration-immutable-artifact-aws'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
import {
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'
import {
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Immutable-object role reserved for committed-prefix apply seals. */
export const WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE =
  'committed-prefix-apply-seals'

const retentionDayMilliseconds = 24 * 60 * 60 * 1_000
const maximumAdditionalRetentionDays = 1
const maximumTextLength = 8_192
const maximumVersionIdLength = 1_024

/**
 * Stable raw-value-free failure for the committed-prefix seal storage boundary.
 */
export class WorkspaceSearchMigrationCommittedPrefixApplySealAwsError
  extends Error {
  /** Secret-free machine-readable storage failure code. */
  readonly code =
    'INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_STORAGE'

  /** Creates one stable committed-prefix seal storage failure. */
  constructor() {
    super(
      'INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_STORAGE',
    )
    this.name =
      'WorkspaceSearchMigrationCommittedPrefixApplySealAwsError'
  }
}

/**
 * Trusted clock used to validate the seal-anchored retention horizon.
 *
 * @returns Current adapter time.
 */
export type WorkspaceSearchMigrationCommittedPrefixApplySealAwsClock =
  () => Date

/**
 * Exact measured identity and dependencies for one committed-prefix gateway.
 */
export type CreateAwsWorkspaceSearchMigrationCommittedPrefixApplySealGatewayInput =
  {
    /** Exact measured migration configuration. */
    readonly configuration: WorkspaceSearchMigrationConfiguration
    /** Digest of the exact measured migration configuration. */
    readonly configurationHash: string
    /** Operator-selected run bound into the object namespace. */
    readonly runId: string
    /** Measured codec-agnostic immutable object port. */
    readonly immutableArtifactPort:
      WorkspaceSearchMigrationImmutableArtifactAwsPort
    /** Trusted adapter clock evaluated before every seal write or retry. */
    readonly clock:
      WorkspaceSearchMigrationCommittedPrefixApplySealAwsClock
  }

/**
 * Strict write input containing only the pure committed-prefix seal.
 */
export type WriteWorkspaceSearchMigrationCommittedPrefixApplySealInput = {
  /** Exact canonical pure committed-prefix seal. */
  readonly seal: WorkspaceSearchApplySeal
}

/**
 * Run-scoped exact-version committed-prefix apply-seal storage capability.
 */
export interface WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway {
  /**
   * Stores one strict canonical committed-prefix apply seal.
   *
   * @param input - Exact pure committed-prefix seal.
   * @returns Rich exact-version immutable seal reference.
   */
  writeCommittedPrefixApplySeal(
    input:
      WriteWorkspaceSearchMigrationCommittedPrefixApplySealInput,
  ): Promise<WorkspaceSearchMigrationCommittedPrefixApplySealReference>

  /**
   * Reads one exact immutable committed-prefix apply-seal version.
   *
   * @param reference - Rich exact-version seal reference.
   * @returns Detached strict pure committed-prefix apply seal.
   */
  readCommittedPrefixApplySeal(
    reference:
      WorkspaceSearchMigrationCommittedPrefixApplySealReference,
  ): Promise<WorkspaceSearchApplySeal>
}

/**
 * Detached immutable-object methods retained without mutable property reads.
 */
type PreparedImmutableArtifactPort = {
  /** Detached immutable object write. */
  readonly write: (
    input: WriteWorkspaceSearchMigrationImmutableArtifactInput,
  ) => Promise<unknown>
  /** Detached exact-version immutable object read. */
  readonly read: (
    input: ReadWorkspaceSearchMigrationImmutableArtifactInput,
  ) => Promise<unknown>
}

/**
 * Fully detached material for one immutable committed-prefix seal write.
 */
type PreparedCommittedPrefixSealWrite = {
  /** Exact canonical seal bytes. */
  readonly bytes: Uint8Array
  /** Lowercase SHA-256 of the canonical bytes. */
  readonly contentDigest: string
  /** Deterministic seal-anchored Object Lock deadline. */
  readonly retainUntil: string
}

/**
 * Exact expectations for one generic immutable storage response.
 */
type StoredReferenceExpectation = {
  /** Expected run-scoped object-key prefix. */
  readonly objectKeyPrefix: string
  /** Expected exact content digest. */
  readonly contentDigest: string
  /** Expected exact body length. */
  readonly byteLength: number
  /** Expected exact Object Lock deadline. */
  readonly retainUntil: string
}

/**
 * Creates one gateway bound to a measured run and immutable object port.
 *
 * @param input - Measured configuration, run, storage, and clock.
 * @returns Run-scoped exact-version committed-prefix seal gateway.
 */
export function createAwsWorkspaceSearchMigrationCommittedPrefixApplySealGateway(
  input:
    CreateAwsWorkspaceSearchMigrationCommittedPrefixApplySealGatewayInput,
): WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway {
  return runCommittedPrefixApplySealAwsBoundary(() => {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'clock',
      'configuration',
      'configurationHash',
      'immutableArtifactPort',
      'runId',
    ])
    const configuration =
      detachWorkspaceSearchMigrationPlanningConfiguration(
        readOwn(record, 'configuration'),
      )
    const configurationHash = readDigest(
      readOwn(record, 'configurationHash'),
    )
    if (
      createWorkspaceSearchConfigurationHash(configuration) !==
        configurationHash
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'CONFIGURATION_HASH_MISMATCH',
        'CONFIGURATION_HASH_MISMATCH',
      )
    }
    const runId = readIdentifier(readOwn(record, 'runId'))
    const immutableArtifactPort = snapshotImmutableArtifactPort(
      readOwn(record, 'immutableArtifactPort'),
    )
    const clock = snapshotClock(readOwn(record, 'clock'))
    const objectKeyPrefix =
      `${configuration.journalPrefix}/runs/${runId}/${configurationHash}`
    const metadata = Object.freeze({
      'mukuroji-apply-seal-kind':
        'workspace-search-committed-prefix-apply-seal-v1',
      'mukuroji-apply-seal-run-id': runId,
      'mukuroji-apply-seal-configuration-sha256':
        configurationHash,
    })

    return {
      writeCommittedPrefixApplySeal: (writeInput) =>
        runCommittedPrefixApplySealAwsAsyncBoundary(async () => {
          const prepared = prepareCommittedPrefixSealWrite(
            writeInput,
            configuration,
            runId,
            configurationHash,
            clock,
          )
          const stored = await immutableArtifactPort.write({
            role:
              WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE,
            objectKeyPrefix,
            bytes: prepared.bytes,
            metadata,
            retainUntil: prepared.retainUntil,
          })
          const reference = readStoredReference(stored, {
            objectKeyPrefix,
            contentDigest: prepared.contentDigest,
            byteLength: prepared.bytes.byteLength,
            retainUntil: prepared.retainUntil,
          })
          return readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
            {
              scope: 'committed-prefix',
              ...reference,
            },
          )
        }),
      readCommittedPrefixApplySeal: (reference) =>
        runCommittedPrefixApplySealAwsAsyncBoundary(async () => {
          const expected =
            readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
              reference,
            )
          requireReferencePath(expected, objectKeyPrefix)
          const candidate = await immutableArtifactPort.read({
            role:
              WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE,
            objectKeyPrefix,
            reference: {
              objectKey: expected.objectKey,
              versionId: expected.versionId,
              contentDigest: expected.contentDigest,
              byteLength: expected.byteLength,
              retainUntil: expected.retainUntil,
            },
            metadata,
          })
          const bytes = snapshotBytes(candidate)
          if (
            bytes.byteLength !== expected.byteLength ||
            digestBytes(bytes) !== expected.contentDigest
          ) {
            return failCommittedPrefixApplySealAws()
          }
          const seal =
            parseWorkspaceSearchMigrationCommittedPrefixApplySeal(
              bytes,
            )
          requireSealIdentity(seal, runId, configurationHash)
          return seal
        }),
    }
  })
}

/**
 * Detaches and validates one strict committed-prefix seal write.
 *
 * @param input - Candidate strict write input.
 * @param configuration - Detached measured configuration.
 * @param runId - Gateway-bound run identifier.
 * @param configurationHash - Gateway-bound configuration digest.
 * @param clock - Detached trusted clock used to validate retention freshness.
 * @returns Fully detached write material.
 */
function prepareCommittedPrefixSealWrite(
  input: WriteWorkspaceSearchMigrationCommittedPrefixApplySealInput,
  configuration: WorkspaceSearchMigrationConfiguration,
  runId: string,
  configurationHash: string,
  clock: () => number,
): PreparedCommittedPrefixSealWrite {
  const record = requireRecord(input)
  requireExactKeys(record, ['seal'])
  const sealValue = readOwn(record, 'seal')
  if (!isApplySealCandidate(sealValue)) {
    return failCommittedPrefixApplySealAws()
  }
  const bytes =
    serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
      sealValue,
    )
  const seal =
    parseWorkspaceSearchMigrationCommittedPrefixApplySeal(bytes)
  requireSealIdentity(seal, runId, configurationHash)
  const retainUntil = createFreshRetentionDeadline(
    configuration,
    seal.createdAt,
    clock,
  )
  return {
    bytes,
    contentDigest: digestBytes(bytes),
    retainUntil,
  }
}

/**
 * Minimally narrows one candidate before the strict seal codec consumes it.
 *
 * @param value - Candidate pure apply seal.
 * @returns Whether the strict codec may inspect the value.
 */
function isApplySealCandidate(
  value: unknown,
): value is WorkspaceSearchApplySeal {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Requires a strict seal to remain in this gateway's run namespace.
 *
 * @param seal - Detached strict committed-prefix seal.
 * @param runId - Gateway-bound run identifier.
 * @param configurationHash - Gateway-bound configuration digest.
 */
function requireSealIdentity(
  seal: WorkspaceSearchApplySeal,
  runId: string,
  configurationHash: string,
): void {
  if (
    seal.scope !== 'committed-prefix' ||
    seal.runId !== runId ||
    seal.configurationHash !== configurationHash
  ) {
    return failCommittedPrefixApplySealAws()
  }
}

/**
 * Validates one generic immutable reference returned by storage.
 *
 * @param value - Untrusted storage result.
 * @param expected - Exact adapter-owned write expectation.
 * @returns Detached generic immutable reference.
 */
function readStoredReference(
  value: unknown,
  expected: StoredReferenceExpectation,
): WorkspaceSearchMigrationImmutableArtifactReference {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const reference: WorkspaceSearchMigrationImmutableArtifactReference = {
    objectKey: readText(readOwn(record, 'objectKey')),
    versionId: readVersionId(readOwn(record, 'versionId')),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
    byteLength: readPositiveSafeInteger(
      readOwn(record, 'byteLength'),
    ),
    retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
  }
  requireReferencePath(
    {
      scope: 'committed-prefix',
      ...reference,
    },
    expected.objectKeyPrefix,
  )
  if (
    reference.contentDigest !== expected.contentDigest ||
    reference.byteLength !== expected.byteLength ||
    reference.retainUntil !== expected.retainUntil
  ) {
    return failCommittedPrefixApplySealAws()
  }
  return reference
}

/**
 * Requires one reference to use the content-addressed prefix-seal namespace.
 *
 * @param reference - Exact rich committed-prefix reference.
 * @param objectKeyPrefix - Gateway-bound run/configuration prefix.
 */
function requireReferencePath(
  reference:
    WorkspaceSearchMigrationCommittedPrefixApplySealReference,
  objectKeyPrefix: string,
): void {
  if (
    reference.objectKey !==
      `${objectKeyPrefix}/${WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_ROLE}/${reference.contentDigest}.artifact`
  ) {
    return failCommittedPrefixApplySealAws()
  }
}

/**
 * Creates a deterministic committed-prefix seal retention horizon.
 *
 * The pure seal may be created long after the admitted plan and is retained
 * independently for the configured default period plus the one-day immutable
 * artifact margin. Anchoring the deadline to the immutable seal creation time
 * makes a response-loss retry byte-for-byte identical while the one-day margin
 * leaves a bounded restart window. Journal versions keep their own deadlines
 * and are checked separately by rollback start and reverse-step adapters.
 *
 * @param configuration - Detached measured configuration.
 * @param sealCreatedAt - Exact canonical seal creation time.
 * @param clock - Detached trusted clock.
 * @returns Deterministic canonical Object Lock deadline.
 */
function createFreshRetentionDeadline(
  configuration: WorkspaceSearchMigrationConfiguration,
  sealCreatedAt: string,
  clock: () => number,
): string {
  const now = clock()
  const createdAt = Date.parse(sealCreatedAt)
  const defaultRetentionDuration =
    configuration.journal.defaultRetentionDays *
    retentionDayMilliseconds
  const retentionDuration =
    (configuration.journal.defaultRetentionDays +
      maximumAdditionalRetentionDays) *
    retentionDayMilliseconds
  const retainUntilEpoch = createdAt + retentionDuration
  const retentionHeadroom = retainUntilEpoch - now
  if (
    !Number.isSafeInteger(defaultRetentionDuration) ||
    defaultRetentionDuration <= 0 ||
    !Number.isSafeInteger(retentionDuration) ||
    retentionDuration <= defaultRetentionDuration ||
    retentionDuration <=
      WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS ||
    !Number.isSafeInteger(retainUntilEpoch) ||
    createdAt > now ||
    !Number.isSafeInteger(retentionHeadroom) ||
    retentionHeadroom <
      defaultRetentionDuration +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS ||
    retentionHeadroom > retentionDuration
  ) {
    return failCommittedPrefixApplySealAws()
  }
  let retainUntil: string
  try {
    retainUntil = new Date(retainUntilEpoch).toISOString()
  } catch {
    return failCommittedPrefixApplySealAws()
  }
  return readTimestamp(retainUntil)
}

/**
 * Snapshots immutable object methods without retaining mutable properties.
 *
 * @param value - Candidate immutable object port.
 * @returns Detached exact method closures.
 */
function snapshotImmutableArtifactPort(
  value: unknown,
): PreparedImmutableArtifactPort {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failCommittedPrefixApplySealAws()
  }
  const write = readMethod(value, 'writeImmutableArtifact')
  const read = readMethod(value, 'readImmutableArtifact')
  return {
    write: (input) => Promise.resolve(write(input)),
    read: (input) => Promise.resolve(read(input)),
  }
}

/**
 * Reads and binds one inherited callable data property without accessors.
 *
 * @param receiver - Validated dependency receiver.
 * @param name - Required method name.
 * @returns One receiver-bound single-argument method.
 */
function readMethod(
  receiver: object,
  name: string,
): (argument: unknown) => unknown {
  let current: object | null = receiver
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      return failCommittedPrefixApplySealAws()
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failCommittedPrefixApplySealAws()
      }
      const method: unknown = descriptor.value
      if (typeof method !== 'function') {
        return failCommittedPrefixApplySealAws()
      }
      return (argument) =>
        Reflect.apply(method, receiver, [argument])
    }
    current = Object.getPrototypeOf(current)
  }
  return failCommittedPrefixApplySealAws()
}

/**
 * Snapshots a trusted Date-returning clock.
 *
 * @param value - Candidate clock.
 * @returns Detached epoch-millisecond clock.
 */
function snapshotClock(value: unknown): () => number {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failCommittedPrefixApplySealAws()
  }
  return () => {
    const result: unknown = Reflect.apply(value, undefined, [])
    if (
      nodeUtilTypes.isProxy(result) ||
      !nodeUtilTypes.isDate(result)
    ) {
      return failCommittedPrefixApplySealAws()
    }
    const epoch = Date.prototype.getTime.call(result)
    if (!Number.isSafeInteger(epoch)) {
      return failCommittedPrefixApplySealAws()
    }
    return epoch
  }
}

/**
 * Copies one bounded Uint8Array returned by immutable storage.
 *
 * @param value - Candidate exact bytes.
 * @returns Detached exact bytes.
 */
function snapshotBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failCommittedPrefixApplySealAws()
  }
  const buffer = readIntrinsicBuffer(value)
  const byteLength = readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_MAX_BYTES
  ) {
    return failCommittedPrefixApplySealAws()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failCommittedPrefixApplySealAws()
  }
  return copy
}

/**
 * Reads one Uint8Array's intrinsic backing buffer without own accessors.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic ArrayBuffer or SharedArrayBuffer.
 */
function readIntrinsicBuffer(value: Uint8Array): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
        typedArrayPrototype,
        'buffer',
      )
  if (descriptor?.get === undefined) {
    return failCommittedPrefixApplySealAws()
  }
  try {
    const result: unknown = Reflect.apply(descriptor.get, value, [])
    if (
      !nodeUtilTypes.isArrayBuffer(result) &&
      !nodeUtilTypes.isSharedArrayBuffer(result)
    ) {
      return failCommittedPrefixApplySealAws()
    }
    return result
  } catch {
    return failCommittedPrefixApplySealAws()
  }
}

/**
 * Reads one Uint8Array's intrinsic byte length without own accessors.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic byte length.
 */
function readIntrinsicByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
        typedArrayPrototype,
        'byteLength',
      )
  if (descriptor?.get === undefined) {
    return failCommittedPrefixApplySealAws()
  }
  try {
    const result: unknown = Reflect.apply(descriptor.get, value, [])
    if (
      typeof result !== 'number' ||
      !Number.isSafeInteger(result)
    ) {
      return failCommittedPrefixApplySealAws()
    }
    return result
  } catch {
    return failCommittedPrefixApplySealAws()
  }
}

/**
 * Computes lowercase SHA-256 over exact canonical bytes.
 *
 * @param bytes - Exact immutable seal bytes.
 * @returns Lowercase hexadecimal digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Requires one ordinary non-array, non-proxy record.
 *
 * @param value - Candidate record.
 * @returns Validated record.
 */
function requireRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failCommittedPrefixApplySealAws()
  }
  return value
}

/**
 * Requires exactly the declared enumerable own data properties.
 *
 * @param value - Validated record.
 * @param expected - Exact key set.
 */
function requireExactKeys(
  value: object,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort()
  const ownKeys = Reflect.ownKeys(value)
  const expectedKeys = [...expected].sort()
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return failCommittedPrefixApplySealAws()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failCommittedPrefixApplySealAws()
    }
  }
}

/**
 * Reads one required enumerable own data property.
 *
 * @param value - Validated record.
 * @param key - Required property name.
 * @returns Exact untrusted value.
 */
function readOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failCommittedPrefixApplySealAws()
  }
  return descriptor.value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Exact digest.
 */
function readDigest(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value)
  ) {
    return failCommittedPrefixApplySealAws()
  }
  return value
}

/**
 * Reads one safe migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Exact identifier.
 */
function readIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failCommittedPrefixApplySealAws()
  }
  return value
}

/**
 * Reads one bounded nonempty safe string.
 *
 * @param value - Candidate text.
 * @returns Exact text.
 */
function readText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumTextLength ||
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failCommittedPrefixApplySealAws()
  }
  return value
}

/**
 * Reads one bounded S3 version identifier.
 *
 * @param value - Candidate version identifier.
 * @returns Exact version identifier.
 */
function readVersionId(value: unknown): string {
  const versionId = readText(value)
  if (
    versionId.length > maximumVersionIdLength ||
    versionId === 'null'
  ) {
    return failCommittedPrefixApplySealAws()
  }
  return versionId
}

/**
 * Reads one positive bounded byte length.
 *
 * @param value - Candidate number.
 * @returns Exact positive safe integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value >
      WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_MAX_BYTES
  ) {
    return failCommittedPrefixApplySealAws()
  }
  return value
}

/**
 * Reads one canonical UTC millisecond timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Exact timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failCommittedPrefixApplySealAws()
  }
  return value
}

/**
 * Runs one synchronous operation behind the stable storage boundary.
 *
 * @param operation - Exact synchronous operation.
 * @returns Successful result.
 */
function runCommittedPrefixApplySealAwsBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    return replaceCommittedPrefixApplySealAwsFailure(error)
  }
}

/**
 * Runs one asynchronous operation behind the stable storage boundary.
 *
 * @param operation - Exact asynchronous operation.
 * @returns Successful result.
 */
async function runCommittedPrefixApplySealAwsAsyncBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    return replaceCommittedPrefixApplySealAwsFailure(error)
  }
}

/**
 * Preserves trusted migration failures and replaces every raw failure.
 *
 * @param error - Unknown caught failure.
 * @returns Never returns.
 */
function replaceCommittedPrefixApplySealAwsFailure(
  error: unknown,
): never {
  if (
    !nodeUtilTypes.isProxy(error) &&
    error instanceof WorkspaceSearchMigrationFailure
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    if (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      isWorkspaceSearchMigrationFailureCode(descriptor.value)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        descriptor.value,
        descriptor.value,
      )
    }
  }
  throw new WorkspaceSearchMigrationCommittedPrefixApplySealAwsError()
}

/**
 * Raises the stable committed-prefix seal storage failure.
 *
 * @returns Never returns.
 */
function failCommittedPrefixApplySealAws(): never {
  throw new WorkspaceSearchMigrationCommittedPrefixApplySealAwsError()
}
