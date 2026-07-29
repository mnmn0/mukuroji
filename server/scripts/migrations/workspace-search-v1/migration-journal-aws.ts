import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createJournalHeadDigest,
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchJournalReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  type WorkspaceSearchMigrationImmutableArtifactAwsPort,
  type WorkspaceSearchMigrationImmutableArtifactReference,
} from './migration-immutable-artifact-aws'
import {
  parseWorkspaceSearchJournalSegment,
  serializeWorkspaceSearchJournalSegment,
  WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES,
} from './migration-journal'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
import { hasOnlyPairedSurrogates } from './migration-value-guards'

/** Immutable-object role reserved for forward-apply journal segments. */
export const WORKSPACE_SEARCH_MIGRATION_APPLY_JOURNAL_SEGMENT_ROLE =
  'apply-journal-segments'

const retentionDayMilliseconds = 24 * 60 * 60 * 1_000
const journalRetentionMarginDays = 1
const maximumJournalVersionIdLength = 1_024
const maximumJournalDataDepth = 64
const maximumJournalDataNodes = 500_000

/**
 * Stable raw-value-free failure for an invalid journal storage boundary.
 */
export class WorkspaceSearchMigrationJournalAwsError extends Error {
  /** Secret-free machine-readable journal storage failure code. */
  readonly code = 'INVALID_MIGRATION_JOURNAL_STORAGE'

  /** Creates one stable journal storage failure. */
  constructor() {
    super('INVALID_MIGRATION_JOURNAL_STORAGE')
    this.name = 'WorkspaceSearchMigrationJournalAwsError'
  }
}

/**
 * Trusted adapter clock used to derive a fresh Object Lock deadline.
 *
 * @returns Current adapter time.
 */
export type WorkspaceSearchMigrationJournalAwsClock = () => Date

/**
 * Dependencies and exact measured identity for one run-scoped journal gateway.
 */
export type CreateAwsWorkspaceSearchMigrationJournalGatewayInput = {
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Operator-selected run bound into every segment and object namespace. */
  readonly runId: string
  /** Codec-agnostic immutable object port from the measured AWS session. */
  readonly immutableArtifactPort:
    WorkspaceSearchMigrationImmutableArtifactAwsPort
  /** Trusted adapter clock used before each journal write. */
  readonly clock: WorkspaceSearchMigrationJournalAwsClock
}

/**
 * Run-scoped exact-version journal storage operations.
 */
export interface WorkspaceSearchMigrationJournalAwsGateway {
  /**
   * Validates and stores one canonical immutable apply journal segment.
   *
   * @param segment - Exact preimage segment for one planned mutation.
   * @returns Rich immutable reference and its journal-chain head.
   */
  writeJournalSegment(
    segment: WorkspaceSearchJournalSegment,
  ): Promise<WorkspaceSearchJournalReference>

  /**
   * Reads one exact immutable version and verifies its complete rich reference.
   *
   * @param reference - Exact immutable journal reference selected by a receipt.
   * @returns Detached strictly parsed canonical journal segment.
   */
  readJournalSegment(
    reference: WorkspaceSearchJournalReference,
  ): Promise<WorkspaceSearchJournalSegment>
}

/**
 * Detached immutable-object methods retained without later property reads.
 */
type PreparedJournalImmutablePort = {
  /**
   * Invokes one immutable object write.
   *
   * @param input - Fully detached immutable object write input.
   * @returns Untrusted storage result for strict gateway validation.
   */
  readonly write: (
    input: Parameters<
      WorkspaceSearchMigrationImmutableArtifactAwsPort[
        'writeImmutableArtifact'
      ]
    >[0],
  ) => Promise<unknown>
  /**
   * Invokes one exact immutable object read.
   *
   * @param input - Fully detached exact-version read input.
   * @returns Untrusted bytes for strict gateway validation.
   */
  readonly read: (
    input: Parameters<
      WorkspaceSearchMigrationImmutableArtifactAwsPort[
        'readImmutableArtifact'
      ]
    >[0],
  ) => Promise<unknown>
}

/**
 * Detached, validated construction material for one gateway.
 */
type PreparedJournalGatewayInput = {
  /** Detached exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of the detached measured configuration. */
  readonly configurationHash: string
  /** Safe operator-selected run identifier. */
  readonly runId: string
  /** Detached immutable object method closures. */
  readonly immutableArtifactPort: PreparedJournalImmutablePort
  /** Detached clock invocation returning an exact epoch millisecond. */
  readonly clock: () => number
}

/**
 * Mutable traversal budget used only while rejecting hostile data graphs.
 */
type JournalDataTraversalBudget = {
  /** Remaining object or array nodes accepted by the preflight. */
  remainingNodes: number
}

/**
 * Creates one gateway bound to an exact measured run and immutable object port.
 *
 * @param input - Measured configuration, run identity, storage, and clock.
 * @returns Run-scoped exact-version journal gateway.
 */
export function createAwsWorkspaceSearchMigrationJournalGateway(
  input: CreateAwsWorkspaceSearchMigrationJournalGatewayInput,
): WorkspaceSearchMigrationJournalAwsGateway {
  return runJournalAwsBoundary(() => {
    const record = requireJournalRecord(input)
    requireExactJournalKeys(record, [
      'clock',
      'configuration',
      'configurationHash',
      'immutableArtifactPort',
      'runId',
    ])
    const configuration =
      detachWorkspaceSearchMigrationPlanningConfiguration(
        readRequiredJournalData(record, 'configuration'),
      )
    const configurationHash =
      readRequiredJournalData(record, 'configurationHash')
    if (
      !isHexDigest(configurationHash) ||
      createWorkspaceSearchConfigurationHash(configuration) !==
        configurationHash
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'CONFIGURATION_HASH_MISMATCH',
        'CONFIGURATION_HASH_MISMATCH',
      )
    }
    const runId = readJournalRunId(
      readRequiredJournalData(record, 'runId'),
    )
    const immutableArtifactPort = snapshotJournalImmutablePort(
      readRequiredJournalData(record, 'immutableArtifactPort'),
    )
    const clock = snapshotJournalClock(
      readRequiredJournalData(record, 'clock'),
    )
    return new AwsWorkspaceSearchMigrationJournalGateway({
      configuration,
      configurationHash,
      runId,
      immutableArtifactPort,
      clock,
    })
  })
}

/**
 * Concrete run-scoped journal adapter over the immutable object core.
 */
class AwsWorkspaceSearchMigrationJournalGateway
implements WorkspaceSearchMigrationJournalAwsGateway {
  /** Detached exact measured migration configuration. */
  private readonly configuration: WorkspaceSearchMigrationConfiguration

  /** Exact measured-configuration digest bound to this gateway. */
  private readonly configurationHash: string

  /** Operator-selected run bound to this gateway. */
  private readonly runId: string

  /** Run and configuration scoped immutable object prefix. */
  private readonly objectKeyPrefix: string

  /** Fixed nonsecret metadata expected on every journal object. */
  private readonly metadata: Readonly<Record<string, string>>

  /** Measured immutable single-object storage port. */
  private readonly immutableArtifactPort: PreparedJournalImmutablePort

  /** Detached trusted adapter clock. */
  private readonly clock: () => number

  /**
   * Creates one gateway from fully detached validated construction material.
   *
   * @param input - Exact prepared measured identity and dependencies.
   */
  constructor(input: PreparedJournalGatewayInput) {
    this.configuration = input.configuration
    this.configurationHash = input.configurationHash
    this.runId = input.runId
    this.objectKeyPrefix =
      `${input.configuration.journalPrefix}/runs/${input.runId}/${input.configurationHash}`
    this.metadata = createJournalMetadata(
      input.runId,
      input.configurationHash,
    )
    this.immutableArtifactPort = input.immutableArtifactPort
    this.clock = input.clock
  }

  /**
   * Validates and stores one canonical immutable apply journal segment.
   *
   * @param segment - Exact preimage segment for one planned mutation.
   * @returns Rich immutable reference and its journal-chain head.
   */
  async writeJournalSegment(
    segment: WorkspaceSearchJournalSegment,
  ): Promise<WorkspaceSearchJournalReference> {
    return runJournalAwsAsyncBoundary(async () => {
      requireJournalSegmentDataBoundary(segment)
      const serialized =
        serializeWorkspaceSearchJournalSegment(segment)
      const detachedSegment =
        parseWorkspaceSearchJournalSegment(serialized)
      this.requireSegmentIdentity(detachedSegment)
      const bytes = new TextEncoder().encode(serialized)
      const contentDigest = digestJournalBytes(bytes)
      const retainUntil = this.createFreshRetentionDeadline()
      const stored = await this.immutableArtifactPort.write({
        role: WORKSPACE_SEARCH_MIGRATION_APPLY_JOURNAL_SEGMENT_ROLE,
        objectKeyPrefix: this.objectKeyPrefix,
        bytes,
        metadata: this.metadata,
        retainUntil,
      })
      const reference = readImmutableJournalReference(
        stored,
        this.objectKeyPrefix,
        {
          contentDigest,
          byteLength: bytes.byteLength,
          retainUntil,
        },
      )
      const headDigest = createJournalHeadDigest({
        previousHeadDigest: detachedSegment.previousHeadDigest,
        sequence: detachedSegment.sequence,
        operationId: detachedSegment.operationId,
        contentDigest: reference.contentDigest,
        versionId: reference.versionId,
      })
      return {
        ...reference,
        headDigest,
      }
    })
  }

  /**
   * Reads one exact immutable version and verifies its complete rich reference.
   *
   * @param reference - Exact immutable journal reference selected by a receipt.
   * @returns Detached strictly parsed canonical journal segment.
   */
  async readJournalSegment(
    reference: WorkspaceSearchJournalReference,
  ): Promise<WorkspaceSearchJournalSegment> {
    return runJournalAwsAsyncBoundary(async () => {
      const expected = readRichJournalReference(
        reference,
        this.objectKeyPrefix,
      )
      const bytesCandidate =
        await this.immutableArtifactPort.read({
          role: WORKSPACE_SEARCH_MIGRATION_APPLY_JOURNAL_SEGMENT_ROLE,
          objectKeyPrefix: this.objectKeyPrefix,
          reference: {
            objectKey: expected.objectKey,
            versionId: expected.versionId,
            contentDigest: expected.contentDigest,
            byteLength: expected.byteLength,
            retainUntil: expected.retainUntil,
          },
          metadata: this.metadata,
        })
      const bytes = snapshotJournalBytes(bytesCandidate)
      if (
        bytes.byteLength !== expected.byteLength ||
        digestJournalBytes(bytes) !== expected.contentDigest
      ) {
        return failJournalAws()
      }
      const segment = parseWorkspaceSearchJournalSegment(
        decodeJournalBytes(bytes),
      )
      this.requireSegmentIdentity(segment)
      const headDigest = createJournalHeadDigest({
        previousHeadDigest: segment.previousHeadDigest,
        sequence: segment.sequence,
        operationId: segment.operationId,
        contentDigest: expected.contentDigest,
        versionId: expected.versionId,
      })
      if (headDigest !== expected.headDigest) {
        return failJournalAws()
      }
      return segment
    })
  }

  /**
   * Requires one strict segment to match this measured run identity.
   *
   * @param segment - Detached strict canonical journal segment.
   */
  private requireSegmentIdentity(
    segment: WorkspaceSearchJournalSegment,
  ): void {
    if (
      segment.runId !== this.runId ||
      segment.configurationHash !== this.configurationHash
    ) {
      return failJournalAws()
    }
  }

  /**
   * Derives a fresh default-retention deadline plus the one-day safety margin.
   *
   * @returns Canonical UTC COMPLIANCE retention deadline.
   */
  private createFreshRetentionDeadline(): string {
    const retentionDays =
      this.configuration.journal.defaultRetentionDays +
      journalRetentionMarginDays
    const retentionMilliseconds =
      retentionDays * retentionDayMilliseconds
    const nowEpochMilliseconds = this.clock()
    const retainUntilEpochMilliseconds =
      nowEpochMilliseconds + retentionMilliseconds
    if (
      !Number.isSafeInteger(retentionDays) ||
      retentionDays <= journalRetentionMarginDays ||
      !Number.isSafeInteger(retentionMilliseconds) ||
      retentionMilliseconds <= 0 ||
      !Number.isSafeInteger(retainUntilEpochMilliseconds)
    ) {
      return failJournalAws()
    }
    try {
      return new Date(retainUntilEpochMilliseconds).toISOString()
    } catch {
      return failJournalAws()
    }
  }
}

/**
 * Creates fixed nonsecret metadata for one run-scoped journal namespace.
 *
 * @param runId - Safe operator-selected run identifier.
 * @param configurationHash - Exact measured-configuration digest.
 * @returns Frozen exact metadata expected on writes and reads.
 */
function createJournalMetadata(
  runId: string,
  configurationHash: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'mukuroji-journal-kind': 'workspace-search-preimage-segment-v1',
    'mukuroji-journal-run-id': runId,
    'mukuroji-journal-configuration-sha256': configurationHash,
  })
}

/**
 * Snapshots the immutable-object port without retaining mutable methods.
 *
 * @param value - Candidate measured immutable-object port.
 * @returns Detached method closures.
 */
function snapshotJournalImmutablePort(
  value: unknown,
): PreparedJournalImmutablePort {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failJournalAws()
  }
  const writeMethod = readJournalDataMethod(
    value,
    'writeImmutableArtifact',
  )
  const readMethod = readJournalDataMethod(
    value,
    'readImmutableArtifact',
  )
  return {
    write: (input) =>
      Promise.resolve(Reflect.apply(writeMethod, value, [input])),
    read: (input) =>
      Promise.resolve(Reflect.apply(readMethod, value, [input])),
  }
}

/**
 * Reads one inherited data method without invoking accessors.
 *
 * @param value - Validated non-proxy receiver.
 * @param name - Required method name.
 * @returns Exact callable data property.
 */
function readJournalDataMethod(
  value: object | Function,
  name: string,
): Function {
  let current: object | null = value
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) return failJournalAws()
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failJournalAws()
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
  }
  return failJournalAws()
}

/**
 * Detaches one trusted clock without retaining a mutable owner object.
 *
 * @param value - Candidate adapter-owned clock function.
 * @returns Safe invocation returning an exact epoch millisecond.
 */
function snapshotJournalClock(value: unknown): () => number {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failJournalAws()
  }
  return () => {
    const result: unknown = Reflect.apply(value, undefined, [])
    if (nodeUtilTypes.isProxy(result) || !nodeUtilTypes.isDate(result)) {
      return failJournalAws()
    }
    let epochMilliseconds: number
    try {
      epochMilliseconds = Date.prototype.getTime.call(result)
    } catch {
      return failJournalAws()
    }
    if (
      !Number.isSafeInteger(epochMilliseconds) ||
      !Number.isFinite(epochMilliseconds)
    ) {
      return failJournalAws()
    }
    return epochMilliseconds
  }
}

/**
 * Validates a safe operator-selected run identifier.
 *
 * @param value - Candidate run identifier.
 * @returns Safe run identifier.
 */
function readJournalRunId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failJournalAws()
  }
  return value
}

/**
 * Requires one plain non-array, non-proxy data record.
 *
 * @param value - Candidate record.
 * @returns Safe object for descriptor-only reads.
 */
function requireJournalRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failJournalAws()
  }
  return value
}

/**
 * Requires exactly the declared enumerable own data properties.
 *
 * @param value - Validated record.
 * @param expected - Exact required property set.
 */
function requireExactJournalKeys(
  value: object,
  expected: readonly string[],
): void {
  const keys = readJournalOwnDataKeys(value).sort()
  const expectedKeys = [...expected].sort()
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return failJournalAws()
  }
}

/**
 * Reads all enumerable own string data-property keys.
 *
 * @param value - Validated non-proxy record.
 * @returns Exact enumerable data-property keys.
 */
function readJournalOwnDataKeys(value: object): string[] {
  const ownKeys = Reflect.ownKeys(value)
  const keys = Object.keys(value)
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length
  ) {
    return failJournalAws()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failJournalAws()
    }
  }
  return keys
}

/**
 * Reads one required enumerable own data property.
 *
 * @param value - Validated record.
 * @param key - Required property name.
 * @returns Exact untrusted data value.
 */
function readRequiredJournalData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failJournalAws()
  }
  return descriptor.value
}

/**
 * Rejects proxies, accessors, cycles, sparse arrays, and exotic JSON objects.
 *
 * @param segment - Caller-owned journal segment.
 */
function requireJournalSegmentDataBoundary(
  segment: WorkspaceSearchJournalSegment,
): void {
  requireJournalDataGraph(
    segment,
    0,
    new Set<object>(),
    { remainingNodes: maximumJournalDataNodes },
  )
}

/**
 * Traverses one bounded JSON-compatible data graph without invoking accessors.
 *
 * @param value - Current caller-owned graph value.
 * @param depth - Current object nesting depth.
 * @param ancestors - Active ancestors used to reject cycles.
 * @param budget - Remaining bounded object-node budget.
 */
function requireJournalDataGraph(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  budget: JournalDataTraversalBudget,
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    depth > maximumJournalDataDepth ||
    budget.remainingNodes <= 0 ||
    ancestors.has(value)
  ) {
    return failJournalAws()
  }
  budget.remainingNodes -= 1
  ancestors.add(value)
  if (Array.isArray(value)) {
    requireJournalArrayData(value, depth, ancestors, budget)
  } else {
    requireJournalObjectData(value, depth, ancestors, budget)
  }
  ancestors.delete(value)
}

/**
 * Traverses one dense ordinary array through exact own data descriptors.
 *
 * @param value - Caller-owned array node.
 * @param depth - Current object nesting depth.
 * @param ancestors - Active ancestors used to reject cycles.
 * @param budget - Remaining bounded object-node budget.
 */
function requireJournalArrayData(
  value: unknown[],
  depth: number,
  ancestors: Set<object>,
  budget: JournalDataTraversalBudget,
): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return failJournalAws()
  }
  const ownKeys = Reflect.ownKeys(value)
  const enumerableKeys = Object.keys(value)
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== enumerableKeys.length + 1 ||
    !ownKeys.includes('length') ||
    enumerableKeys.length !== value.length
  ) {
    return failJournalAws()
  }
  for (let index = 0; index < enumerableKeys.length; index += 1) {
    const key = String(index)
    if (enumerableKeys[index] !== key) return failJournalAws()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failJournalAws()
    }
    requireJournalDataGraph(
      descriptor.value,
      depth + 1,
      ancestors,
      budget,
    )
  }
}

/**
 * Traverses one ordinary object through exact own data descriptors.
 *
 * @param value - Caller-owned object node.
 * @param depth - Current object nesting depth.
 * @param ancestors - Active ancestors used to reject cycles.
 * @param budget - Remaining bounded object-node budget.
 */
function requireJournalObjectData(
  value: object,
  depth: number,
  ancestors: Set<object>,
  budget: JournalDataTraversalBudget,
): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return failJournalAws()
  }
  const keys = readJournalOwnDataKeys(value)
  for (const key of keys) {
    requireJournalDataGraph(
      readRequiredJournalData(value, key),
      depth + 1,
      ancestors,
      budget,
    )
  }
}

/**
 * Optional exact fields required while validating one immutable reference.
 */
type JournalReferenceExpectation = {
  /** Exact expected content digest, when already known. */
  readonly contentDigest?: string
  /** Exact expected byte length, when already known. */
  readonly byteLength?: number
  /** Exact expected retention deadline, when already known. */
  readonly retainUntil?: string
}

/**
 * Validates and detaches one immutable journal object reference.
 *
 * @param value - Candidate exact immutable reference.
 * @param objectKeyPrefix - Expected run-scoped object-key prefix.
 * @param expectation - Optional exact digest, length, and retention fields.
 * @returns Detached strict immutable object reference.
 */
function readImmutableJournalReference(
  value: unknown,
  objectKeyPrefix: string,
  expectation: JournalReferenceExpectation = {},
): WorkspaceSearchMigrationImmutableArtifactReference {
  const record = requireJournalRecord(value)
  requireExactJournalKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const objectKey = readRequiredJournalData(record, 'objectKey')
  const versionId = readRequiredJournalData(record, 'versionId')
  const contentDigest =
    readRequiredJournalData(record, 'contentDigest')
  const byteLength = readRequiredJournalData(record, 'byteLength')
  const retainUntil = readRequiredJournalData(record, 'retainUntil')
  if (
    typeof objectKey !== 'string' ||
    typeof versionId !== 'string' ||
    versionId.length === 0 ||
    versionId.length > maximumJournalVersionIdLength ||
    versionId !== versionId.trim() ||
    versionId === 'null' ||
    !hasOnlyPairedSurrogates(versionId) ||
    !isHexDigest(contentDigest) ||
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES ||
    !isCanonicalTimestamp(retainUntil) ||
    objectKey !==
      `${objectKeyPrefix}/${WORKSPACE_SEARCH_MIGRATION_APPLY_JOURNAL_SEGMENT_ROLE}/${contentDigest}.artifact` ||
    (
      expectation.contentDigest !== undefined &&
      contentDigest !== expectation.contentDigest
    ) ||
    (
      expectation.byteLength !== undefined &&
      byteLength !== expectation.byteLength
    ) ||
    (
      expectation.retainUntil !== undefined &&
      retainUntil !== expectation.retainUntil
    )
  ) {
    return failJournalAws()
  }
  return {
    objectKey,
    versionId,
    contentDigest,
    byteLength,
    retainUntil,
  }
}

/**
 * Validates and detaches one complete rich journal reference.
 *
 * @param value - Candidate exact rich reference.
 * @param objectKeyPrefix - Expected run-scoped object-key prefix.
 * @returns Detached strict rich journal reference.
 */
function readRichJournalReference(
  value: unknown,
  objectKeyPrefix: string,
): WorkspaceSearchJournalReference {
  const record = requireJournalRecord(value)
  requireExactJournalKeys(record, [
    'byteLength',
    'contentDigest',
    'headDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const immutableReference = readImmutableJournalReference({
    objectKey: readRequiredJournalData(record, 'objectKey'),
    versionId: readRequiredJournalData(record, 'versionId'),
    contentDigest: readRequiredJournalData(record, 'contentDigest'),
    byteLength: readRequiredJournalData(record, 'byteLength'),
    retainUntil: readRequiredJournalData(record, 'retainUntil'),
  }, objectKeyPrefix)
  const headDigest = readRequiredJournalData(record, 'headDigest')
  if (!isHexDigest(headDigest)) return failJournalAws()
  return {
    ...immutableReference,
    headDigest,
  }
}

/**
 * Detaches one bounded immutable byte array without trusting subclasses.
 *
 * @param value - Candidate exact bytes returned by storage.
 * @returns Detached exact bytes.
 */
function snapshotJournalBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failJournalAws()
  }
  const byteLength = readIntrinsicJournalByteLength(value)
  const buffer = readIntrinsicJournalBuffer(value)
  if (
    isJournalSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength > WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES
  ) {
    return failJournalAws()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failJournalAws()
  }
  return copy
}

/**
 * Reads a Uint8Array intrinsic byte length.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic byte length.
 */
function readIntrinsicJournalByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'byteLength',
    )
  if (descriptor?.get === undefined) return failJournalAws()
  try {
    const byteLength: unknown = Reflect.apply(
      descriptor.get,
      value,
      [],
    )
    if (
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength)
    ) {
      return failJournalAws()
    }
    return byteLength
  } catch {
    return failJournalAws()
  }
}

/**
 * Reads a Uint8Array intrinsic backing buffer.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic backing buffer.
 */
function readIntrinsicJournalBuffer(value: Uint8Array): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'buffer',
    )
  if (descriptor?.get === undefined) return failJournalAws()
  try {
    const buffer: unknown = Reflect.apply(
      descriptor.get,
      value,
      [],
    )
    if (
      !(buffer instanceof ArrayBuffer) &&
      !isJournalSharedArrayBuffer(buffer)
    ) {
      return failJournalAws()
    }
    return buffer
  } catch {
    return failJournalAws()
  }
}

/**
 * Checks whether shared mutable memory backs one byte view.
 *
 * @param value - Candidate backing buffer.
 * @returns Whether the value is a real SharedArrayBuffer.
 */
function isJournalSharedArrayBuffer(
  value: unknown,
): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== 'undefined' &&
    value instanceof SharedArrayBuffer
}

/**
 * Decodes exact canonical UTF-8 without replacement characters.
 *
 * @param bytes - Detached exact journal bytes.
 * @returns Strictly decoded UTF-8 text.
 */
function decodeJournalBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failJournalAws()
  }
}

/**
 * Computes the lowercase SHA-256 digest of exact immutable bytes.
 *
 * @param bytes - Exact canonical journal bytes.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
function digestJournalBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Runs one synchronous public operation behind a stable error boundary.
 *
 * @param operation - Synchronous public operation.
 * @returns Exact successful result.
 */
function runJournalAwsBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    return replaceJournalAwsFailure(error)
  }
}

/**
 * Runs one asynchronous public operation behind a stable error boundary.
 *
 * @param operation - Asynchronous public operation.
 * @returns Exact successful result.
 */
async function runJournalAwsAsyncBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    return replaceJournalAwsFailure(error)
  }
}

/**
 * Preserves trusted migration failure codes and replaces every raw failure.
 *
 * @param error - Unknown caught boundary failure.
 * @returns Never returns.
 */
function replaceJournalAwsFailure(error: unknown): never {
  if (
    !nodeUtilTypes.isProxy(error) &&
    error instanceof WorkspaceSearchMigrationFailure
  ) {
    const codeDescriptor = Object.getOwnPropertyDescriptor(error, 'code')
    if (
      codeDescriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(codeDescriptor, 'value') &&
      isWorkspaceSearchMigrationFailureCode(codeDescriptor.value)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        codeDescriptor.value,
        codeDescriptor.value,
      )
    }
  }
  throw new WorkspaceSearchMigrationJournalAwsError()
}

/**
 * Raises the stable journal storage failure.
 *
 * @returns Never returns.
 */
function failJournalAws(): never {
  throw new WorkspaceSearchMigrationJournalAwsError()
}
