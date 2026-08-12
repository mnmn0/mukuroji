import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  serializeCanonicalJson,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationFullVerificationResult,
} from './migration-full-verification'
import {
  parseWorkspaceSearchMigrationFullVerificationResultArtifact,
  serializeWorkspaceSearchMigrationFullVerificationResultArtifact,
  type WorkspaceSearchMigrationFullVerificationResultArtifactReference,
  validateWorkspaceSearchMigrationFullVerificationResultArtifactReference,
  WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RESULT_MAX_BYTES,
} from './migration-full-verification-persistence'
import type {
  WorkspaceSearchMigrationImmutableArtifactAwsPort,
  WorkspaceSearchMigrationImmutableArtifactReference,
} from './migration-immutable-artifact-aws'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/**
 * Stable object namespace for immutable full-verification result envelopes.
 */
export const WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_OBJECT_KEY_PREFIX =
  'workspace-search/v1/verification-result-artifacts/v1'

/** Immutable-object role reserved for full-verification result envelopes. */
export const WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_ROLE =
  'verification-results'

/**
 * Maximum canonical bytes accepted for one verification-result envelope.
 */
export const WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_MAX_BYTES =
  WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RESULT_MAX_BYTES +
  16 * 1024

const maximumVersionIdLength = 1_024
const maximumResultGraphDepth = 64
const maximumResultGraphNodes = 100_000

/**
 * Mutable budget for rejecting active, cyclic, or unbounded result graphs.
 */
type ResultGraphInspectionBudget = {
  /** Number of ordinary object or array nodes inspected. */
  nodes: number
  /** Nodes currently on the active traversal path. */
  readonly active: WeakSet<object>
  /** Nodes whose complete descendants were already inspected. */
  readonly visited: WeakSet<object>
}

/**
 * Stable raw-value-free failure for an invalid verification-result boundary.
 */
export class WorkspaceSearchMigrationVerificationResultAwsError
  extends Error {
  /** Secret-free machine-readable result-storage failure code. */
  readonly code = 'INVALID_MIGRATION_VERIFICATION_RESULT_STORAGE'

  /** Creates one stable verification-result storage failure. */
  constructor() {
    super('INVALID_MIGRATION_VERIFICATION_RESULT_STORAGE')
    this.name = 'WorkspaceSearchMigrationVerificationResultAwsError'
  }
}

/**
 * Immutable content-addressed envelope for one successful full verification.
 *
 * Operational completion time deliberately remains outside this evidence:
 * retries over the same applied root and semantic result must reproduce the
 * same canonical bytes.
 */
export type WorkspaceSearchMigrationVerificationResultArtifact = {
  /** Verification-result artifact discriminator. */
  readonly kind:
    'workspace-search-migration-verification-result-artifact'
  /** Verification-result artifact schema version. */
  readonly artifactVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Digest of the immutable applied phase root being verified. */
  readonly appliedRootDigest: string
  /** Semantic digest carried by the exact full-verification result. */
  readonly verificationResultDigest: string
  /** Exact detached successful full-verification result. */
  readonly verificationResult:
    WorkspaceSearchMigrationFullVerificationResult
  /** Digest of every preceding canonical envelope field. */
  readonly envelopeDigest: string
}

/**
 * Gateway-facing alias of the persistence-owned rich semantic reference.
 */
export type WorkspaceSearchMigrationVerificationResultArtifactReference =
  WorkspaceSearchMigrationFullVerificationResultArtifactReference

/**
 * Measured identity and storage dependency for one result gateway.
 */
export type CreateAwsWorkspaceSearchMigrationVerificationResultGatewayInput = {
  /** Operator-selected run bound into the object namespace. */
  readonly runId: string
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Digest of the immutable applied phase root being verified. */
  readonly appliedRootDigest: string
  /** Measured codec-agnostic immutable object port. */
  readonly immutableArtifactPort:
    WorkspaceSearchMigrationImmutableArtifactAwsPort
}

/**
 * Exact successful result and shared retention selected for one upload.
 */
export type WriteWorkspaceSearchMigrationVerificationResultArtifactInput = {
  /** Exact successful result emitted by the pure full-verification kernel. */
  readonly verificationResult:
    WorkspaceSearchMigrationFullVerificationResult
  /** Caller-fixed shared canonical COMPLIANCE retention deadline. */
  readonly retainUntil: string
}

/**
 * Run- and applied-root-scoped immutable verification-result operations.
 */
export interface WorkspaceSearchMigrationVerificationResultAwsGateway {
  /**
   * Stores or reconciles one deterministic verification-result envelope.
   *
   * @param input - Exact result and caller-fixed shared retention deadline.
   * @returns Rich exact-version immutable artifact reference.
   */
  writeVerificationResultArtifact(
    input: WriteWorkspaceSearchMigrationVerificationResultArtifactInput,
  ): Promise<WorkspaceSearchMigrationVerificationResultArtifactReference>

  /**
   * Replays one exact immutable verification-result artifact version.
   *
   * @param reference - Rich exact-version artifact reference.
   * @returns Detached strict semantic envelope.
   */
  replayVerificationResultArtifact(
    reference:
      WorkspaceSearchMigrationVerificationResultArtifactReference,
  ): Promise<WorkspaceSearchMigrationVerificationResultArtifact>
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
 * Exact adapter-owned expectation for a generic immutable reference.
 */
type StoredReferenceExpectation = {
  /** Expected run-scoped object-key prefix. */
  readonly objectKeyPrefix: string
  /** Expected exact content digest. */
  readonly contentDigest: string
  /** Expected exact body length. */
  readonly byteLength: number
  /** Expected caller-fixed Object Lock deadline. */
  readonly retainUntil: string
}

/**
 * Creates one gateway bound to a measured run and immutable applied root.
 *
 * @param input - Measured run, configuration, root, and immutable storage.
 * @returns Run-scoped exact-version verification-result gateway.
 */
export function createAwsWorkspaceSearchMigrationVerificationResultGateway(
  input: CreateAwsWorkspaceSearchMigrationVerificationResultGatewayInput,
): WorkspaceSearchMigrationVerificationResultAwsGateway {
  return runVerificationResultAwsBoundary(() => {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'appliedRootDigest',
      'configurationHash',
      'immutableArtifactPort',
      'runId',
    ])
    const runId = readIdentifier(readOwn(record, 'runId'))
    const configurationHash = readDigest(
      readOwn(record, 'configurationHash'),
    )
    const appliedRootDigest = readDigest(
      readOwn(record, 'appliedRootDigest'),
    )
    const immutableArtifactPort = snapshotImmutableArtifactPort(
      readOwn(record, 'immutableArtifactPort'),
    )
    const objectKeyPrefix =
      `${WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_OBJECT_KEY_PREFIX}` +
      `/runs/${runId}/${configurationHash}/${appliedRootDigest}`

    return {
      writeVerificationResultArtifact: (writeInput) =>
        runVerificationResultAwsAsyncBoundary(async () => {
          const writeRecord = requireRecord(writeInput)
          requireExactKeys(writeRecord, [
            'retainUntil',
            'verificationResult',
          ])
          const verificationResult = readVerificationResult(
            readOwn(writeRecord, 'verificationResult'),
          )
          requireResultGatewayIdentity(
            verificationResult,
            runId,
            configurationHash,
          )
          const retainUntil = readTimestamp(
            readOwn(writeRecord, 'retainUntil'),
          )
          const artifact = createVerificationResultArtifact(
            verificationResult,
            appliedRootDigest,
          )
          const bytes = serializeVerificationResultArtifact(artifact)
          const contentDigest = digestBytes(bytes)
          const metadata = createStorageMetadata(artifact)
          const stored = await immutableArtifactPort.write({
            role:
              WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_ROLE,
            objectKeyPrefix,
            bytes,
            metadata,
            retainUntil,
          })
          const reference = readStoredReference(stored, {
            objectKeyPrefix,
            contentDigest,
            byteLength: bytes.byteLength,
            retainUntil,
          })
          return createRichReference(artifact, reference)
        }),
      replayVerificationResultArtifact: (reference) =>
        runVerificationResultAwsAsyncBoundary(async () => {
          const expected = readRichReference(reference)
          requireReferenceGatewayIdentity(
            expected,
            runId,
            configurationHash,
            appliedRootDigest,
            objectKeyPrefix,
          )
          const metadata = createStorageMetadataFromReference(
            expected,
          )
          const candidate = await immutableArtifactPort.read({
            role:
              WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_ROLE,
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
            return failVerificationResultAws()
          }
          const artifact = parseVerificationResultArtifact(bytes)
          requireArtifactMatchesReference(artifact, expected)
          requireResultGatewayIdentity(
            artifact.verificationResult,
            runId,
            configurationHash,
          )
          return artifact
        }),
    }
  })
}

/**
 * Creates a canonical semantic envelope without an operational timestamp.
 *
 * @param result - Detached strict successful full-verification result.
 * @param appliedRootDigest - Exact immutable applied root digest.
 * @returns Detached self-digested verification-result artifact.
 */
function createVerificationResultArtifact(
  result: WorkspaceSearchMigrationFullVerificationResult,
  appliedRootDigest: string,
): WorkspaceSearchMigrationVerificationResultArtifact {
  const common = {
    kind:
      'workspace-search-migration-verification-result-artifact',
    artifactVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: result.runId,
    configurationHash: result.configurationHash,
    appliedRootDigest,
    verificationResultDigest: result.resultDigest,
    verificationResult: result,
  } satisfies Omit<
    WorkspaceSearchMigrationVerificationResultArtifact,
    'envelopeDigest'
  >
  return readVerificationResultArtifact({
    ...common,
    envelopeDigest: createMigrationDigest(common),
  })
}

/**
 * Serializes one strict envelope as bounded canonical UTF-8 JSON.
 *
 * @param value - Candidate verification-result artifact.
 * @returns Exact bounded canonical bytes.
 */
function serializeVerificationResultArtifact(
  value: WorkspaceSearchMigrationVerificationResultArtifact,
): Uint8Array {
  const strict = readVerificationResultArtifact(value)
  const bytes = new TextEncoder().encode(serializeCanonicalJson(strict))
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_MAX_BYTES
  ) {
    return failVerificationResultAws()
  }
  return bytes
}

/**
 * Parses one exact canonical verification-result artifact document.
 *
 * @param value - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict semantic envelope.
 */
function parseVerificationResultArtifact(
  value: Uint8Array,
): WorkspaceSearchMigrationVerificationResultArtifact {
  const bytes = snapshotBytes(value)
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    parsed = JSON.parse(text)
  } catch {
    return failVerificationResultAws()
  }
  const artifact = readVerificationResultArtifact(parsed)
  const canonical = new TextEncoder().encode(
    serializeCanonicalJson(artifact),
  )
  if (!equalBytes(bytes, canonical)) {
    return failVerificationResultAws()
  }
  return artifact
}

/**
 * Reads and validates one complete semantic envelope.
 *
 * @param value - Candidate envelope.
 * @returns Detached strict envelope.
 */
function readVerificationResultArtifact(
  value: unknown,
): WorkspaceSearchMigrationVerificationResultArtifact {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'appliedRootDigest',
    'artifactVersion',
    'configurationHash',
    'envelopeDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'runId',
    'verificationResult',
    'verificationResultDigest',
  ])
  const kind = readOwn(record, 'kind')
  const artifactVersion = readOwn(record, 'artifactVersion')
  const migrationId = readOwn(record, 'migrationId')
  const migrationVersion = readOwn(record, 'migrationVersion')
  if (
    kind !==
      'workspace-search-migration-verification-result-artifact' ||
    artifactVersion !== 1 ||
    migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failVerificationResultAws()
  }
  const verificationResult = readVerificationResult(
    readOwn(record, 'verificationResult'),
  )
  const common = {
    kind,
    artifactVersion,
    migrationId,
    migrationVersion,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    appliedRootDigest: readDigest(
      readOwn(record, 'appliedRootDigest'),
    ),
    verificationResultDigest: readDigest(
      readOwn(record, 'verificationResultDigest'),
    ),
    verificationResult,
  } satisfies Omit<
    WorkspaceSearchMigrationVerificationResultArtifact,
    'envelopeDigest'
  >
  const envelopeDigest = readDigest(
    readOwn(record, 'envelopeDigest'),
  )
  if (
    common.runId !== verificationResult.runId ||
    common.configurationHash !==
      verificationResult.configurationHash ||
    common.verificationResultDigest !==
      verificationResult.resultDigest ||
    createMigrationDigest(common) !== envelopeDigest
  ) {
    return failVerificationResultAws()
  }
  return {
    ...common,
    envelopeDigest,
  }
}

/**
 * Validates and detaches one exact successful full-verification result.
 *
 * The persistence contract owns the canonical semantic result codec. This
 * gateway round-trips through that codec before constructing its root-bound
 * storage envelope.
 *
 * @param value - Candidate successful pure-kernel result.
 * @returns Detached strict successful result.
 */
function readVerificationResult(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationResult {
  try {
    inspectPassiveResultGraph(
      value,
      {
        nodes: 0,
        active: new WeakSet<object>(),
        visited: new WeakSet<object>(),
      },
      0,
    )
    const candidateBytes = new TextEncoder().encode(
      serializeCanonicalJson(value),
    )
    if (
      candidateBytes.byteLength <= 0 ||
      candidateBytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RESULT_MAX_BYTES
    ) {
      return failVerificationResultAws()
    }
    const result =
      parseWorkspaceSearchMigrationFullVerificationResultArtifact(
        candidateBytes,
      )
    const canonicalBytes =
      serializeWorkspaceSearchMigrationFullVerificationResultArtifact(
        result,
      )
    if (!equalBytes(candidateBytes, canonicalBytes)) {
      return failVerificationResultAws()
    }
    return result
  } catch {
    return failVerificationResultAws()
  }
}

/**
 * Rejects active behavior, cycles, exotic objects, and unbounded graphs before
 * generic canonical serialization can observe caller-controlled properties.
 *
 * @param value - Current candidate graph value.
 * @param budget - Shared bounded traversal budget.
 * @param depth - Current ordinary object/array nesting depth.
 */
function inspectPassiveResultGraph(
  value: unknown,
  budget: ResultGraphInspectionBudget,
  depth: number,
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return failVerificationResultAws()
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    depth > maximumResultGraphDepth ||
    budget.active.has(value)
  ) {
    return failVerificationResultAws()
  }
  if (budget.visited.has(value)) return
  budget.nodes += 1
  if (budget.nodes > maximumResultGraphNodes) {
    return failVerificationResultAws()
  }
  budget.active.add(value)
  if (Array.isArray(value)) {
    if (!hasCanonicalDenseArrayShape(value)) {
      return failVerificationResultAws()
    }
    for (const candidate of value) {
      inspectPassiveResultGraph(candidate, budget, depth + 1)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return failVerificationResultAws()
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return failVerificationResultAws()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return failVerificationResultAws()
      }
      inspectPassiveResultGraph(
        descriptor.value,
        budget,
        depth + 1,
      )
    }
  }
  budget.active.delete(value)
  budget.visited.add(value)
}

/**
 * Ensures a full result belongs to this run/configuration gateway.
 *
 * @param result - Strict full-verification result.
 * @param runId - Gateway-bound run identifier.
 * @param configurationHash - Gateway-bound configuration digest.
 */
function requireResultGatewayIdentity(
  result: WorkspaceSearchMigrationFullVerificationResult,
  runId: string,
  configurationHash: string,
): void {
  if (
    result.runId !== runId ||
    result.configurationHash !== configurationHash
  ) {
    return failVerificationResultAws()
  }
}

/**
 * Creates immutable-object metadata bound to one exact envelope.
 *
 * @param artifact - Strict semantic envelope.
 * @returns Exact nonsecret immutable-object metadata.
 */
function createStorageMetadata(
  artifact: WorkspaceSearchMigrationVerificationResultArtifact,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'mukuroji-verification-result-kind':
      'workspace-search-full-verification-result-v1',
    'mukuroji-verification-run-id': artifact.runId,
    'mukuroji-verification-configuration-sha256':
      artifact.configurationHash,
    'mukuroji-verification-applied-root-sha256':
      artifact.appliedRootDigest,
    'mukuroji-verification-result-sha256':
      artifact.verificationResultDigest,
    'mukuroji-verification-envelope-sha256':
      artifact.envelopeDigest,
  })
}

/**
 * Reconstructs exact metadata from one strict rich reference.
 *
 * @param reference - Strict rich artifact reference.
 * @returns Exact nonsecret immutable-object metadata.
 */
function createStorageMetadataFromReference(
  reference: WorkspaceSearchMigrationVerificationResultArtifactReference,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'mukuroji-verification-result-kind':
      'workspace-search-full-verification-result-v1',
    'mukuroji-verification-run-id': reference.runId,
    'mukuroji-verification-configuration-sha256':
      reference.configurationHash,
    'mukuroji-verification-applied-root-sha256':
      reference.appliedRootDigest,
    'mukuroji-verification-result-sha256':
      reference.verificationResultDigest,
    'mukuroji-verification-envelope-sha256':
      reference.envelopeDigest,
  })
}

/**
 * Builds one rich semantic reference from a generic storage reference.
 *
 * @param artifact - Exact stored semantic envelope.
 * @param reference - Validated generic immutable reference.
 * @returns Rich exact-version verification-result reference.
 */
function createRichReference(
  artifact: WorkspaceSearchMigrationVerificationResultArtifact,
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
): WorkspaceSearchMigrationVerificationResultArtifactReference {
  return {
    kind:
      'workspace-search-migration-verification-result-artifact-reference',
    artifactVersion: 1,
    runId: artifact.runId,
    configurationHash: artifact.configurationHash,
    appliedRootDigest: artifact.appliedRootDigest,
    verificationResultDigest: artifact.verificationResultDigest,
    envelopeDigest: artifact.envelopeDigest,
    objectKey: reference.objectKey,
    versionId: reference.versionId,
    contentDigest: reference.contentDigest,
    byteLength: reference.byteLength,
    retainUntil: reference.retainUntil,
  }
}

/**
 * Reads one strict rich verification-result artifact reference.
 *
 * @param value - Candidate rich reference.
 * @returns Detached strict rich reference.
 */
function readRichReference(
  value: unknown,
): WorkspaceSearchMigrationVerificationResultArtifactReference {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'appliedRootDigest',
    'artifactVersion',
    'byteLength',
    'configurationHash',
    'contentDigest',
    'envelopeDigest',
    'kind',
    'objectKey',
    'retainUntil',
    'runId',
    'verificationResultDigest',
    'versionId',
  ])
  const kind = readOwn(record, 'kind')
  const artifactVersion = readOwn(record, 'artifactVersion')
  if (
    kind !==
      'workspace-search-migration-verification-result-artifact-reference' ||
    artifactVersion !== 1
  ) {
    return failVerificationResultAws()
  }
  const reference:
    WorkspaceSearchMigrationVerificationResultArtifactReference = {
    kind,
    artifactVersion,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    appliedRootDigest: readDigest(
      readOwn(record, 'appliedRootDigest'),
    ),
    verificationResultDigest: readDigest(
      readOwn(record, 'verificationResultDigest'),
    ),
    envelopeDigest: readDigest(
      readOwn(record, 'envelopeDigest'),
    ),
    objectKey: readText(readOwn(record, 'objectKey')),
    versionId: readVersionId(readOwn(record, 'versionId')),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
    byteLength: readPositiveByteLength(
      readOwn(record, 'byteLength'),
    ),
    retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
  }
  try {
    return validateWorkspaceSearchMigrationFullVerificationResultArtifactReference(
      reference,
    )
  } catch {
    return failVerificationResultAws()
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
    byteLength: readPositiveByteLength(
      readOwn(record, 'byteLength'),
    ),
    retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
  }
  requireReferencePath(reference, expected.objectKeyPrefix)
  if (
    reference.contentDigest !== expected.contentDigest ||
    reference.byteLength !== expected.byteLength ||
    reference.retainUntil !== expected.retainUntil
  ) {
    return failVerificationResultAws()
  }
  return reference
}

/**
 * Requires one reference to remain within this gateway identity.
 *
 * @param reference - Strict rich reference.
 * @param runId - Gateway-bound run identifier.
 * @param configurationHash - Gateway-bound configuration digest.
 * @param appliedRootDigest - Gateway-bound applied-root digest.
 * @param objectKeyPrefix - Gateway-bound content-addressed prefix.
 */
function requireReferenceGatewayIdentity(
  reference: WorkspaceSearchMigrationVerificationResultArtifactReference,
  runId: string,
  configurationHash: string,
  appliedRootDigest: string,
  objectKeyPrefix: string,
): void {
  if (
    reference.runId !== runId ||
    reference.configurationHash !== configurationHash ||
    reference.appliedRootDigest !== appliedRootDigest
  ) {
    return failVerificationResultAws()
  }
  requireReferencePath(reference, objectKeyPrefix)
}

/**
 * Requires replayed envelope semantics to equal the rich reference.
 *
 * @param artifact - Strict replayed envelope.
 * @param reference - Strict rich reference used for the read.
 */
function requireArtifactMatchesReference(
  artifact: WorkspaceSearchMigrationVerificationResultArtifact,
  reference: WorkspaceSearchMigrationVerificationResultArtifactReference,
): void {
  if (
    artifact.runId !== reference.runId ||
    artifact.configurationHash !== reference.configurationHash ||
    artifact.appliedRootDigest !== reference.appliedRootDigest ||
    artifact.verificationResultDigest !==
      reference.verificationResultDigest ||
    artifact.envelopeDigest !== reference.envelopeDigest
  ) {
    return failVerificationResultAws()
  }
}

/**
 * Requires one reference to use the content-addressed result namespace.
 *
 * @param reference - Exact generic or rich immutable reference.
 * @param objectKeyPrefix - Gateway-bound identity prefix.
 */
function requireReferencePath(
  reference: WorkspaceSearchMigrationImmutableArtifactReference,
  objectKeyPrefix: string,
): void {
  if (
    reference.objectKey !==
      `${objectKeyPrefix}/${WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_ROLE}/${reference.contentDigest}.artifact`
  ) {
    return failVerificationResultAws()
  }
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
    return failVerificationResultAws()
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
    if (nodeUtilTypes.isProxy(current)) {
      return failVerificationResultAws()
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failVerificationResultAws()
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
  }
  return failVerificationResultAws()
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
    return failVerificationResultAws()
  }
  const buffer = readIntrinsicBuffer(value)
  if (nodeUtilTypes.isSharedArrayBuffer(buffer)) {
    return failVerificationResultAws()
  }
  let copy: Uint8Array
  try {
    copy = new Uint8Array(value)
  } catch {
    return failVerificationResultAws()
  }
  if (
    copy.byteLength <= 0 ||
    copy.byteLength >
      WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_MAX_BYTES
  ) {
    return failVerificationResultAws()
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
    return failVerificationResultAws()
  }
  try {
    const result: unknown = Reflect.apply(descriptor.get, value, [])
    if (
      !nodeUtilTypes.isArrayBuffer(result) &&
      !nodeUtilTypes.isSharedArrayBuffer(result)
    ) {
      return failVerificationResultAws()
    }
    return result
  } catch {
    return failVerificationResultAws()
  }
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
    return failVerificationResultAws()
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return failVerificationResultAws()
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
    return failVerificationResultAws()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failVerificationResultAws()
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
    return failVerificationResultAws()
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
  if (!isHexDigest(value)) return failVerificationResultAws()
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
    return failVerificationResultAws()
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
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failVerificationResultAws()
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
    return failVerificationResultAws()
  }
  return versionId
}

/**
 * Reads one positive bounded canonical byte length.
 *
 * @param value - Candidate number.
 * @returns Exact positive safe integer.
 */
function readPositiveByteLength(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value >
      WORKSPACE_SEARCH_MIGRATION_VERIFICATION_RESULT_MAX_BYTES
  ) {
    return failVerificationResultAws()
  }
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Exact timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failVerificationResultAws()
  }
  return value
}

/**
 * Computes lowercase SHA-256 over exact canonical bytes.
 *
 * @param bytes - Exact immutable artifact bytes.
 * @returns Lowercase hexadecimal digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Compares two exact byte sequences without coercion.
 *
 * @param left - First exact byte sequence.
 * @param right - Second exact byte sequence.
 * @returns Whether byte lengths and values match.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Runs one synchronous operation behind the stable storage boundary.
 *
 * @param operation - Exact synchronous operation.
 * @returns Successful result.
 */
function runVerificationResultAwsBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    return replaceVerificationResultAwsFailure(error)
  }
}

/**
 * Runs one asynchronous operation behind the stable storage boundary.
 *
 * @param operation - Exact asynchronous operation.
 * @returns Successful result.
 */
async function runVerificationResultAwsAsyncBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    return replaceVerificationResultAwsFailure(error)
  }
}

/**
 * Preserves trusted migration failures and replaces every raw failure.
 *
 * @param error - Unknown caught failure.
 * @returns Never returns.
 */
function replaceVerificationResultAwsFailure(error: unknown): never {
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
  if (
    !nodeUtilTypes.isProxy(error) &&
    error instanceof WorkspaceSearchMigrationVerificationResultAwsError
  ) {
    throw new WorkspaceSearchMigrationVerificationResultAwsError()
  }
  throw new WorkspaceSearchMigrationVerificationResultAwsError()
}

/**
 * Raises the stable verification-result storage failure.
 *
 * @returns Never returns.
 */
function failVerificationResultAws(): never {
  throw new WorkspaceSearchMigrationVerificationResultAwsError()
}
