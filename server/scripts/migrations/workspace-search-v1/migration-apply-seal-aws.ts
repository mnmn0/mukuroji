import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createWorkspaceSearchConfigurationHash,
  isWorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationCompleteApplySeal,
  readWorkspaceSearchMigrationCompleteApplySealReference,
  serializeWorkspaceSearchMigrationCompleteApplySeal,
  WORKSPACE_SEARCH_MIGRATION_APPLY_SEAL_DOCUMENT_MAX_BYTES,
  type WorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationCompleteApplySealReference,
} from './migration-apply-seal'
import type {
  WorkspaceSearchMigrationImmutableArtifactAwsPort,
  WorkspaceSearchMigrationImmutableArtifactReference,
} from './migration-immutable-artifact-aws'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'

/** Legacy immutable-object role reserved for version-one apply seals. */
export const WORKSPACE_SEARCH_MIGRATION_COMPLETE_APPLY_SEAL_ROLE =
  'apply-seals'

/** Immutable-object role reserved for version-two complete apply seals. */
export const WORKSPACE_SEARCH_MIGRATION_COMPLETE_APPLY_SEAL_V2_ROLE =
  'apply-seals-v2'

/** Maximum canonical bytes accepted for one complete apply seal. */
export const WORKSPACE_SEARCH_MIGRATION_COMPLETE_APPLY_SEAL_MAX_BYTES =
  WORKSPACE_SEARCH_MIGRATION_APPLY_SEAL_DOCUMENT_MAX_BYTES

const retentionDayMilliseconds = 24 * 60 * 60 * 1_000
const applySealRetentionMarginDays = 1
const maximumVersionIdLength = 1_024

/**
 * Stable raw-value-free failure for an invalid apply-seal storage boundary.
 */
export class WorkspaceSearchMigrationApplySealAwsError extends Error {
  /** Secret-free machine-readable apply-seal storage failure code. */
  readonly code = 'INVALID_MIGRATION_APPLY_SEAL_STORAGE'

  /** Creates one stable apply-seal storage failure. */
  constructor() {
    super('INVALID_MIGRATION_APPLY_SEAL_STORAGE')
    this.name = 'WorkspaceSearchMigrationApplySealAwsError'
  }
}

/**
 * Trusted clock used to derive a fresh Object Lock retention deadline.
 *
 * @returns Current adapter time.
 */
export type WorkspaceSearchMigrationApplySealAwsClock = () => Date

/**
 * Exact measured identity and dependencies for one apply-seal gateway.
 */
export type CreateAwsWorkspaceSearchMigrationApplySealGatewayInput = {
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Operator-selected run bound into the object namespace. */
  readonly runId: string
  /** Measured codec-agnostic immutable object port. */
  readonly immutableArtifactPort:
    WorkspaceSearchMigrationImmutableArtifactAwsPort
  /** Trusted adapter clock used before every seal write. */
  readonly clock: WorkspaceSearchMigrationApplySealAwsClock
}

/**
 * Run-scoped exact-version complete apply-seal storage capability.
 */
export interface WorkspaceSearchMigrationApplySealAwsGateway {
  /**
   * Stores one strict canonical complete-plan apply seal.
   *
   * @param seal - Exact adapter-owned complete apply seal.
   * @returns Rich exact-version immutable seal reference.
   */
  writeCompleteApplySeal(
    seal: WorkspaceSearchMigrationCompleteApplySeal,
  ): Promise<WorkspaceSearchMigrationCompleteApplySealReference>

  /**
   * Reads one exact immutable complete-plan apply seal version.
   *
   * @param reference - Rich exact-version seal reference.
   * @returns Detached strict complete apply seal.
   */
  readCompleteApplySeal(
    reference: WorkspaceSearchMigrationCompleteApplySealReference,
  ): Promise<WorkspaceSearchMigrationCompleteApplySeal>
}

/**
 * Detached immutable-object methods retained without mutable property reads.
 */
type PreparedImmutableArtifactPort = {
  /** Detached immutable object write. */
  readonly write: (
    input: Parameters<
      WorkspaceSearchMigrationImmutableArtifactAwsPort[
        'writeImmutableArtifact'
      ]
    >[0],
  ) => Promise<unknown>
  /** Detached exact-version immutable object read. */
  readonly read: (
    input: Parameters<
      WorkspaceSearchMigrationImmutableArtifactAwsPort[
        'readImmutableArtifact'
      ]
    >[0],
  ) => Promise<unknown>
}

/**
 * Version-specific immutable storage route for one complete apply seal.
 */
type ApplySealStorageBinding = {
  /** Complete apply-seal schema accepted by this route. */
  readonly sealVersion:
    WorkspaceSearchMigrationCompleteApplySeal['sealVersion']
  /** Immutable artifact role embedded in the object key. */
  readonly role: string
  /** Exact object metadata required on writes and reads. */
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Creates one gateway bound to a measured run and immutable object port.
 *
 * @param input - Measured configuration, run, storage, and clock.
 * @returns Run-scoped exact-version apply-seal gateway.
 */
export function createAwsWorkspaceSearchMigrationApplySealGateway(
  input: CreateAwsWorkspaceSearchMigrationApplySealGatewayInput,
): WorkspaceSearchMigrationApplySealAwsGateway {
  return runApplySealAwsBoundary(() => {
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
    return {
      writeCompleteApplySeal: (seal) =>
        runApplySealAwsAsyncBoundary(async () => {
          const bytes =
            serializeWorkspaceSearchMigrationCompleteApplySeal(seal)
          const detached =
            parseWorkspaceSearchMigrationCompleteApplySeal(bytes)
          requireSealIdentity(detached, runId, configurationHash)
          const storage = createApplySealStorageBinding(
            detached.sealVersion,
            runId,
            configurationHash,
          )
          const contentDigest = digestBytes(bytes)
          const retainUntil = requireSharedRetentionDeadline(
            configuration,
            detached.planSealReference.retainUntil,
            clock,
          )
          const stored = await immutableArtifactPort.write({
            role: storage.role,
            objectKeyPrefix,
            bytes,
            metadata: storage.metadata,
            retainUntil,
          })
          const reference = readStoredReference(stored, {
            objectKeyPrefix,
            role: storage.role,
            contentDigest,
            byteLength: bytes.byteLength,
            retainUntil,
          })
          return readWorkspaceSearchMigrationCompleteApplySealReference({
            scope: 'complete-plan',
            ...reference,
          })
        }),
      readCompleteApplySeal: (reference) =>
        runApplySealAwsAsyncBoundary(async () => {
          const expected =
            readWorkspaceSearchMigrationCompleteApplySealReference(
              reference,
            )
          const storage = readApplySealStorageBinding(
            expected,
            objectKeyPrefix,
            runId,
            configurationHash,
          )
          const candidate = await immutableArtifactPort.read({
            role: storage.role,
            objectKeyPrefix,
            reference: {
              objectKey: expected.objectKey,
              versionId: expected.versionId,
              contentDigest: expected.contentDigest,
              byteLength: expected.byteLength,
              retainUntil: expected.retainUntil,
            },
            metadata: storage.metadata,
          })
          const bytes = snapshotBytes(candidate)
          if (
            bytes.byteLength !== expected.byteLength ||
            digestBytes(bytes) !== expected.contentDigest
          ) {
            return failApplySealAws()
          }
          const seal =
            parseWorkspaceSearchMigrationCompleteApplySeal(bytes)
          if (seal.sealVersion !== storage.sealVersion) {
            return failApplySealAws()
          }
          requireSealIdentity(seal, runId, configurationHash)
          return seal
        }),
    }
  })
}

/**
 * Creates the immutable storage route for one strict seal schema.
 *
 * @param sealVersion - Complete apply-seal schema version.
 * @param runId - Gateway-bound run identifier.
 * @param configurationHash - Gateway-bound configuration digest.
 * @returns Exact role and metadata for the selected schema.
 */
function createApplySealStorageBinding(
  sealVersion:
    WorkspaceSearchMigrationCompleteApplySeal['sealVersion'],
  runId: string,
  configurationHash: string,
): ApplySealStorageBinding {
  const role = sealVersion === 1
    ? WORKSPACE_SEARCH_MIGRATION_COMPLETE_APPLY_SEAL_ROLE
    : WORKSPACE_SEARCH_MIGRATION_COMPLETE_APPLY_SEAL_V2_ROLE
  return {
    sealVersion,
    role,
    metadata: Object.freeze({
      'mukuroji-apply-seal-kind':
        `workspace-search-complete-apply-seal-v${sealVersion}`,
      'mukuroji-apply-seal-run-id': runId,
      'mukuroji-apply-seal-configuration-sha256':
        configurationHash,
    }),
  }
}

/**
 * Selects a legacy or version-two route from one exact object key.
 *
 * @param reference - Exact rich complete-plan reference.
 * @param objectKeyPrefix - Gateway-bound run/configuration prefix.
 * @param runId - Gateway-bound run identifier.
 * @param configurationHash - Gateway-bound configuration digest.
 * @returns Storage route encoded by the content-addressed object key.
 */
function readApplySealStorageBinding(
  reference: WorkspaceSearchMigrationCompleteApplySealReference,
  objectKeyPrefix: string,
  runId: string,
  configurationHash: string,
): ApplySealStorageBinding {
  const legacy = createApplySealStorageBinding(
    1,
    runId,
    configurationHash,
  )
  if (hasReferencePath(reference, objectKeyPrefix, legacy.role)) {
    return legacy
  }
  const current = createApplySealStorageBinding(
    2,
    runId,
    configurationHash,
  )
  if (hasReferencePath(reference, objectKeyPrefix, current.role)) {
    return current
  }
  return failApplySealAws()
}

/**
 * Requires a strict seal to remain in this gateway's run namespace.
 *
 * @param seal - Detached strict complete apply seal.
 * @param runId - Gateway-bound run identifier.
 * @param configurationHash - Gateway-bound configuration digest.
 */
function requireSealIdentity(
  seal: WorkspaceSearchMigrationCompleteApplySeal,
  runId: string,
  configurationHash: string,
): void {
  if (
    seal.runId !== runId ||
    seal.configurationHash !== configurationHash
  ) {
    return failApplySealAws()
  }
}

/**
 * Optional exact expectations for one generic immutable reference.
 */
type StoredReferenceExpectation = {
  /** Expected run-scoped object-key prefix. */
  readonly objectKeyPrefix: string
  /** Expected version-specific immutable artifact role. */
  readonly role: string
  /** Expected exact content digest. */
  readonly contentDigest: string
  /** Expected exact body length. */
  readonly byteLength: number
  /** Expected exact Object Lock deadline. */
  readonly retainUntil: string
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
      scope: 'complete-plan',
      ...reference,
    },
    expected.objectKeyPrefix,
    expected.role,
  )
  if (
    reference.contentDigest !== expected.contentDigest ||
    reference.byteLength !== expected.byteLength ||
    reference.retainUntil !== expected.retainUntil
  ) {
    return failApplySealAws()
  }
  return reference
}

/**
 * Requires one reference to use the content-addressed apply-seal namespace.
 *
 * @param reference - Exact rich complete-plan reference.
 * @param objectKeyPrefix - Gateway-bound run/configuration prefix.
 * @param role - Version-specific immutable artifact role.
 */
function requireReferencePath(
  reference: WorkspaceSearchMigrationCompleteApplySealReference,
  objectKeyPrefix: string,
  role: string,
): void {
  if (
    reference.objectKey !==
      `${objectKeyPrefix}/${role}/${reference.contentDigest}.artifact`
  ) {
    return failApplySealAws()
  }
}

/**
 * Checks one exact content-addressed reference path without throwing.
 *
 * @param reference - Exact rich complete-plan reference.
 * @param objectKeyPrefix - Gateway-bound run/configuration prefix.
 * @param role - Candidate version-specific immutable artifact role.
 * @returns Whether the object key selects the candidate route.
 */
function hasReferencePath(
  reference: WorkspaceSearchMigrationCompleteApplySealReference,
  objectKeyPrefix: string,
  role: string,
): boolean {
  return reference.objectKey ===
    `${objectKeyPrefix}/${role}/${reference.contentDigest}.artifact`
}

/**
 * Requires the shared planning-graph retention horizon to remain writable.
 *
 * @param configuration - Detached measured configuration.
 * @param retainUntil - Shared immutable planning-graph deadline.
 * @param clock - Detached trusted clock.
 * @returns The exact shared deadline for the apply-seal object.
 */
function requireSharedRetentionDeadline(
  configuration: WorkspaceSearchMigrationConfiguration,
  retainUntil: string,
  clock: () => number,
): string {
  const minimumDuration =
    configuration.journal.defaultRetentionDays *
    retentionDayMilliseconds
  const maximumDuration =
    (configuration.journal.defaultRetentionDays +
      applySealRetentionMarginDays) *
    retentionDayMilliseconds
  const remainingDuration = Date.parse(retainUntil) - clock()
  if (
    !Number.isSafeInteger(minimumDuration) ||
    minimumDuration <= 0 ||
    !Number.isSafeInteger(maximumDuration) ||
    maximumDuration <= minimumDuration ||
    !Number.isSafeInteger(remainingDuration) ||
    remainingDuration < minimumDuration ||
    remainingDuration > maximumDuration
  ) {
    return failApplySealAws()
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
    return failApplySealAws()
  }
  const write = readMethod(value, 'writeImmutableArtifact')
  const read = readMethod(value, 'readImmutableArtifact')
  return {
    write: (input) =>
      Promise.resolve(Reflect.apply(write, value, [input])),
    read: (input) =>
      Promise.resolve(Reflect.apply(read, value, [input])),
  }
}

/**
 * Reads one inherited callable data property without invoking accessors.
 *
 * @param receiver - Validated dependency receiver.
 * @param name - Required method name.
 * @returns Exact callable data property.
 */
function readMethod(receiver: object, name: string): Function {
  let current: object | null = receiver
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) return failApplySealAws()
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failApplySealAws()
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
  }
  return failApplySealAws()
}

/**
 * Snapshots a trusted Date-returning clock.
 *
 * @param value - Candidate clock.
 * @returns Detached epoch-millisecond clock.
 */
function snapshotClock(value: unknown): () => number {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failApplySealAws()
  }
  return () => {
    const result: unknown = Reflect.apply(value, undefined, [])
    if (
      nodeUtilTypes.isProxy(result) ||
      !nodeUtilTypes.isDate(result)
    ) {
      return failApplySealAws()
    }
    const epoch = Date.prototype.getTime.call(result)
    if (!Number.isSafeInteger(epoch)) return failApplySealAws()
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
    return failApplySealAws()
  }
  const buffer = readIntrinsicBuffer(value)
  if (nodeUtilTypes.isSharedArrayBuffer(buffer)) {
    return failApplySealAws()
  }
  let copy: Uint8Array
  try {
    copy = new Uint8Array(value)
  } catch {
    return failApplySealAws()
  }
  if (
    copy.byteLength <= 0 ||
    copy.byteLength >
      WORKSPACE_SEARCH_MIGRATION_COMPLETE_APPLY_SEAL_MAX_BYTES
  ) {
    return failApplySealAws()
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
  if (descriptor?.get === undefined) return failApplySealAws()
  try {
    const result: unknown = Reflect.apply(descriptor.get, value, [])
    if (
      !nodeUtilTypes.isArrayBuffer(result) &&
      !nodeUtilTypes.isSharedArrayBuffer(result)
    ) {
      return failApplySealAws()
    }
    return result
  } catch {
    return failApplySealAws()
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
    return failApplySealAws()
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
    return failApplySealAws()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failApplySealAws()
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
    return failApplySealAws()
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
    return failApplySealAws()
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
    return failApplySealAws()
  }
  return value
}

/**
 * Reads one bounded nonempty string.
 *
 * @param value - Candidate text.
 * @returns Exact text.
 */
function readText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8_192 ||
    value !== value.trim()
  ) {
    return failApplySealAws()
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
    return failApplySealAws()
  }
  return versionId
}

/**
 * Reads one positive safe integer.
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
      WORKSPACE_SEARCH_MIGRATION_COMPLETE_APPLY_SEAL_MAX_BYTES
  ) {
    return failApplySealAws()
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
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      value,
    ) ||
    new Date(value).toISOString() !== value
  ) {
    return failApplySealAws()
  }
  return value
}

/**
 * Runs one synchronous operation behind the stable storage boundary.
 *
 * @param operation - Exact synchronous operation.
 * @returns Successful result.
 */
function runApplySealAwsBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    return replaceApplySealAwsFailure(error)
  }
}

/**
 * Runs one asynchronous operation behind the stable storage boundary.
 *
 * @param operation - Exact asynchronous operation.
 * @returns Successful result.
 */
async function runApplySealAwsAsyncBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    return replaceApplySealAwsFailure(error)
  }
}

/**
 * Preserves trusted migration failures and replaces every raw failure.
 *
 * @param error - Unknown caught failure.
 * @returns Never returns.
 */
function replaceApplySealAwsFailure(error: unknown): never {
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
  throw new WorkspaceSearchMigrationApplySealAwsError()
}

/**
 * Raises the stable apply-seal storage failure.
 *
 * @returns Never returns.
 */
function failApplySealAws(): never {
  throw new WorkspaceSearchMigrationApplySealAwsError()
}
