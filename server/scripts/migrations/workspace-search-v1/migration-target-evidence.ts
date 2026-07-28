import { createHash } from 'node:crypto'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  isHexDigest,
  type MigrationDigestState,
  MigrationDigestAccumulator,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  zeroHexDigest,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationObservedTargetBinding,
  WorkspaceSearchMigrationTargetScanRowEvidence,
} from './migration-planner'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
  type WorkspaceSearchMigrationPlanningTargetArtifactAuthority,
  type WorkspaceSearchMigrationPlanningTargetArtifactReference,
} from './migration-target-artifact'
import {
  createEmptyWorkspaceSearchMigrationTargetScanCheckpoint,
  type WorkspaceSearchMigrationTargetScanAggregate,
  type WorkspaceSearchMigrationTargetScanCheckpoint,
  validateWorkspaceSearchMigrationTargetScanCheckpoint,
} from './migration-target-scan-context'
import type {
  WorkspaceSearchMigrationInvalidTargetScanRowEvidence,
  WorkspaceSearchMigrationTargetScanPageResult,
} from './migration-target-scan-page'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Maximum exact UTF-8 size accepted for one target evidence page. */
export const WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES =
  2 * 1024 * 1024

/** Version of target checkpoint and progress digest preimages. */
const targetEvidenceDigestVersion = 1

/**
 * Immutable identity shared by every page in one authoritative target chain.
 */
export type WorkspaceSearchMigrationTargetEvidenceIdentity = {
  /** Authoritative planning purpose. */
  readonly purpose: 'planning'
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Immutable physical Workspace Search target DynamoDB TableId. */
  readonly targetTableId: string
  /** Immutable physical migration-state DynamoDB TableId. */
  readonly stateTableId: string
}

/**
 * Canonical digest-only row evidence, exact checkpoint, authority, and immutable
 * artifact references for one committed target Scan page.
 */
export type WorkspaceSearchMigrationTargetEvidencePage = {
  /** Evidence document discriminator. */
  readonly kind: 'workspace-search-target-evidence-page'
  /** First authoritative target-evidence schema version. */
  readonly evidenceVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Versioned migration behavior. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Authoritative planning purpose. */
  readonly purpose: 'planning'
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Immutable physical Workspace Search target DynamoDB TableId. */
  readonly targetTableId: string
  /** Immutable physical migration-state DynamoDB TableId. */
  readonly stateTableId: string
  /** One-based page position in this exact evidence chain. */
  readonly pageSequence: number
  /** Digest of the preceding page, or the zero digest for page one. */
  readonly previousEvidenceDigest: string
  /** Digest of the exact predecessor target checkpoint. */
  readonly previousCheckpointDigest: string
  /** Cumulative target checkpoint after this page. */
  readonly checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint
  /** Owned and ignored target-row evidence emitted by the page reducer. */
  readonly targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[]
  /** Invalid digest-only target-row evidence emitted by the page reducer. */
  readonly invalidRows:
    readonly WorkspaceSearchMigrationInvalidTargetScanRowEvidence[]
  /** Exact preimage bindings emitted for migration-owned target rows. */
  readonly observedTargetBindings:
    readonly WorkspaceSearchMigrationObservedTargetBinding[]
  /** Exact durable pre-plan authority used for this page. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningTargetArtifactAuthority
  /** Ordered immutable S3 versions containing every raw target Scan item. */
  readonly targetArtifacts:
    readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[]
}

/**
 * Durable head state required to resume one exact target evidence chain.
 */
export type WorkspaceSearchMigrationTargetEvidenceProgress =
  WorkspaceSearchMigrationTargetEvidenceIdentity & {
    /** Number of target pages already committed. */
    readonly pageSequence: number
    /** Digest of the latest committed page, or zero before page one. */
    readonly evidenceDigest: string
    /** Exact cumulative target checkpoint at the chain head. */
    readonly checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint
  }

/**
 * Input used to derive the only valid successor target evidence page.
 */
export type CreateWorkspaceSearchMigrationTargetEvidencePageInput = {
  /** Immutable target evidence-chain identity. */
  readonly identity: WorkspaceSearchMigrationTargetEvidenceIdentity
  /** Exact authority atomically revalidated when this page is committed. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningTargetArtifactAuthority
  /** Ordered immutable raw-target artifact segments for this exact page. */
  readonly targetArtifacts:
    readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[]
  /** Exact durable predecessor progress. */
  readonly previousProgress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Detached reducer result for the page read from that predecessor. */
  readonly pageResult: WorkspaceSearchMigrationTargetScanPageResult
}

/**
 * Complete replay output with globally validated target-row evidence.
 */
export type WorkspaceSearchMigrationTargetEvidenceReplayResult = {
  /** Reconstructed final target evidence head. */
  readonly progress: WorkspaceSearchMigrationTargetEvidenceProgress
  /** Every owned or ignored target row across the chain. */
  readonly targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[]
  /** Every invalid target row across the chain. */
  readonly invalidRows:
    readonly WorkspaceSearchMigrationInvalidTargetScanRowEvidence[]
  /** Every observed migration-owned target preimage across the chain. */
  readonly observedTargetBindings:
    readonly WorkspaceSearchMigrationObservedTargetBinding[]
}

/**
 * Stable raw-value-free failure raised for invalid target evidence.
 */
export class WorkspaceSearchMigrationTargetEvidenceError extends Error {
  /** Secret-free machine-readable target-evidence failure code. */
  readonly code = 'INVALID_TARGET_EVIDENCE'

  /**
   * Creates one fresh stable target-evidence failure.
   */
  constructor() {
    super('INVALID_TARGET_EVIDENCE')
    this.name = 'WorkspaceSearchMigrationTargetEvidenceError'
  }
}

/**
 * Creates the untouched head for one new planning target evidence chain.
 *
 * @param identity - Immutable scan and storage identity.
 * @returns Canonical zero-page target progress.
 */
export function createInitialWorkspaceSearchMigrationTargetEvidenceProgress(
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
): WorkspaceSearchMigrationTargetEvidenceProgress {
  return runTargetEvidenceBoundary(() => {
    const validated = readStandaloneIdentity(identity)
    return {
      ...validated,
      pageSequence: 0,
      evidenceDigest: zeroHexDigest(),
      checkpoint:
        createEmptyWorkspaceSearchMigrationTargetScanCheckpoint(
          validated.configurationHash,
        ),
    }
  })
}

/**
 * Creates one target successor page from exact progress and reducer evidence.
 *
 * @param input - Identity, durable predecessor, authority, artifacts, and result.
 * @returns Detached canonical successor target evidence.
 */
export function createWorkspaceSearchMigrationTargetEvidencePage(
  input: CreateWorkspaceSearchMigrationTargetEvidencePageInput,
): WorkspaceSearchMigrationTargetEvidencePage {
  return runTargetEvidenceBoundary(() => {
    const inputRecord = requireRecord(input)
    requireExactKeys(inputRecord, [
      'identity',
      'pageResult',
      'planningAuthority',
      'previousProgress',
      'targetArtifacts',
    ])
    const identity = readStandaloneIdentity(inputRecord.identity)
    const previous = readProgress(encodeProgress(input.previousProgress))
    requireSameIdentity(identity, previous)
    const pageResult = readPageResult(input.pageResult)
    const page: WorkspaceSearchMigrationTargetEvidencePage = {
      kind: 'workspace-search-target-evidence-page',
      evidenceVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      purpose: 'planning',
      runId: identity.runId,
      configurationHash: identity.configurationHash,
      targetTableId: identity.targetTableId,
      stateTableId: identity.stateTableId,
      pageSequence: previous.pageSequence + 1,
      previousEvidenceDigest: previous.evidenceDigest,
      previousCheckpointDigest:
        createCheckpointDigestUnchecked(previous.checkpoint),
      checkpoint: pageResult.checkpoint,
      targetRows: pageResult.targetRows,
      invalidRows: pageResult.invalidRows,
      observedTargetBindings: pageResult.observedTargetBindings,
      planningAuthority:
        readPlanningAuthority(inputRecord.planningAuthority),
      targetArtifacts:
        readPlanningTargetArtifactReferences(inputRecord.targetArtifacts),
    }
    validateSuccessor(previous, page)
    return page
  })
}

/**
 * Advances one target evidence head after validating an exact successor page.
 *
 * @param previous - Exact current target progress.
 * @param page - Candidate successor evidence.
 * @returns New detached target progress.
 */
export function advanceWorkspaceSearchMigrationTargetEvidenceProgress(
  previous: WorkspaceSearchMigrationTargetEvidenceProgress,
  page: WorkspaceSearchMigrationTargetEvidencePage,
): WorkspaceSearchMigrationTargetEvidenceProgress {
  return runTargetEvidenceBoundary(() => {
    const validatedPrevious = readProgress(encodeProgress(previous))
    const validatedPage = readRawPage(page)
    validateSuccessor(validatedPrevious, validatedPage)
    return {
      purpose: 'planning',
      runId: validatedPage.runId,
      configurationHash: validatedPage.configurationHash,
      targetTableId: validatedPage.targetTableId,
      stateTableId: validatedPage.stateTableId,
      pageSequence: validatedPage.pageSequence,
      evidenceDigest: createPageDigestUnchecked(validatedPage),
      checkpoint: cloneCheckpoint(validatedPage.checkpoint),
    }
  })
}

/**
 * Replays a complete or partial target chain from its canonical initial head.
 *
 * @param identity - Expected immutable target evidence identity.
 * @param pages - Ordered exact target page documents.
 * @returns Final progress and globally validated target-row evidence.
 */
export function replayWorkspaceSearchMigrationTargetEvidencePages(
  identity: WorkspaceSearchMigrationTargetEvidenceIdentity,
  pages: readonly WorkspaceSearchMigrationTargetEvidencePage[],
): WorkspaceSearchMigrationTargetEvidenceReplayResult {
  return runTargetEvidenceBoundary(() => {
    if (!hasCanonicalDenseArrayShape(pages)) return failTargetEvidence()
    let progress =
      createInitialWorkspaceSearchMigrationTargetEvidenceProgress(identity)
    const targetRows: WorkspaceSearchMigrationTargetScanRowEvidence[] = []
    const invalidRows:
      WorkspaceSearchMigrationInvalidTargetScanRowEvidence[] = []
    const observedTargetBindings:
      WorkspaceSearchMigrationObservedTargetBinding[] = []
    const targetKeys = new Set<string>()
    const boundTargetKeys = new Set<string>()
    for (const candidate of pages) {
      const page = readRawPage(candidate)
      progress = advanceWorkspaceSearchMigrationTargetEvidenceProgress(
        progress,
        page,
      )
      for (const row of [...page.targetRows, ...page.invalidRows]) {
        if (targetKeys.has(row.targetKeyDigest)) return failTargetEvidence()
        targetKeys.add(row.targetKeyDigest)
      }
      for (const binding of page.observedTargetBindings) {
        if (boundTargetKeys.has(binding.targetKeyDigest)) {
          return failTargetEvidence()
        }
        boundTargetKeys.add(binding.targetKeyDigest)
      }
      targetRows.push(...page.targetRows)
      invalidRows.push(...page.invalidRows)
      observedTargetBindings.push(...page.observedTargetBindings)
    }
    validateGlobalAggregate(
      progress.checkpoint,
      targetRows,
      invalidRows,
      observedTargetBindings,
    )
    return {
      progress,
      targetRows,
      invalidRows,
      observedTargetBindings,
    }
  })
}

/**
 * Serializes one target evidence page into strict canonical UTF-8 JSON bytes.
 *
 * @param page - Candidate raw target evidence page.
 * @returns Exact canonical bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationTargetEvidencePage(
  page: WorkspaceSearchMigrationTargetEvidencePage,
): Uint8Array {
  return runTargetEvidenceBoundary(() =>
    encodeCanonicalPage(readRawPage(page))
  )
}

/**
 * Parses one exact canonical target evidence page.
 *
 * @param bytes - Untrusted bounded UTF-8 bytes.
 * @returns Detached validated target evidence page.
 */
export function parseWorkspaceSearchMigrationTargetEvidencePage(
  bytes: Uint8Array,
): WorkspaceSearchMigrationTargetEvidencePage {
  return runTargetEvidenceBoundary(() => {
    const parsed = parseJson(bytes)
    const page = readEncodedPage(parsed)
    const canonical = encodeCanonicalPage(page)
    if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
      return failTargetEvidence()
    }
    return page
  })
}

/**
 * Digests the exact canonical bytes of one target evidence page.
 *
 * @param page - Candidate target evidence page.
 * @returns Lowercase SHA-256 page digest.
 */
export function createWorkspaceSearchMigrationTargetEvidencePageDigest(
  page: WorkspaceSearchMigrationTargetEvidencePage,
): string {
  return runTargetEvidenceBoundary(() =>
    createPageDigestUnchecked(readRawPage(page))
  )
}

/**
 * Digests one exact target checkpoint using its lossless cursor representation.
 *
 * @param checkpoint - Candidate cumulative target checkpoint.
 * @returns Lowercase SHA-256 checkpoint digest.
 */
export function createWorkspaceSearchMigrationTargetCheckpointDigest(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): string {
  return runTargetEvidenceBoundary(() =>
    createCheckpointDigestUnchecked(cloneCheckpoint(checkpoint))
  )
}

/**
 * Creates a stable CAS fingerprint for one exact target progress head.
 *
 * @param progress - Candidate target evidence progress.
 * @returns Lowercase SHA-256 progress digest.
 */
export function createWorkspaceSearchMigrationTargetEvidenceProgressDigest(
  progress: WorkspaceSearchMigrationTargetEvidenceProgress,
): string {
  return runTargetEvidenceBoundary(() => {
    const value = readProgress(encodeProgress(progress))
    return digestCanonical({
      kind: 'workspace-search-target-evidence-progress',
      digestVersion: targetEvidenceDigestVersion,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      purpose: value.purpose,
      runId: value.runId,
      configurationHash: value.configurationHash,
      targetTableId: value.targetTableId,
      stateTableId: value.stateTableId,
      pageSequence: value.pageSequence,
      evidenceDigest: value.evidenceDigest,
      checkpoint: encodeCheckpoint(value.checkpoint),
    })
  })
}

/**
 * Reads one standalone identity with no extra runtime fields.
 *
 * @param value - Candidate exact target identity.
 * @returns Detached validated identity.
 */
function readStandaloneIdentity(
  value: unknown,
): WorkspaceSearchMigrationTargetEvidenceIdentity {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'purpose',
    'runId',
    'stateTableId',
    'targetTableId',
  ])
  return readIdentity(record)
}

/**
 * Reads target identity fields from a larger strict schema record.
 *
 * @param record - Exact record carrying target identity fields.
 * @returns Detached validated identity.
 */
function readIdentity(
  record: Readonly<Record<string, unknown>>,
): WorkspaceSearchMigrationTargetEvidenceIdentity {
  if (record.purpose !== 'planning') return failTargetEvidence()
  const runIdValue = record.runId
  if (typeof runIdValue !== 'string') return failTargetEvidence()
  let runId: string
  try {
    runId = requireMigrationIdentifier(runIdValue, 'Run ID')
  } catch {
    return failTargetEvidence()
  }
  const configurationHash = readDigest(record.configurationHash)
  const targetTableId = readNonBlankText(record.targetTableId)
  const stateTableId = readNonBlankText(record.stateTableId)
  if (targetTableId === stateTableId) return failTargetEvidence()
  return {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId,
    stateTableId,
  }
}

/**
 * Reads one exact planning-authority binding.
 *
 * @param value - Candidate authority binding.
 * @returns Detached validated authority binding.
 */
function readPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationPlanningTargetArtifactAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  const ownerIdValue = record.ownerId
  if (typeof ownerIdValue !== 'string') return failTargetEvidence()
  let ownerId: string
  try {
    ownerId = requireMigrationIdentifier(ownerIdValue, 'Owner ID')
  } catch {
    return failTargetEvidence()
  }
  return {
    ownerId,
    fenceToken: readPositiveSafeInteger(record.fenceToken),
    maintenanceEvidencePointerRevision:
      readPositiveSafeInteger(record.maintenanceEvidencePointerRevision),
    maintenanceEvidenceReceiptDigest:
      readDigest(record.maintenanceEvidenceReceiptDigest),
  }
}

/**
 * Reads one complete ordered immutable target artifact-reference set.
 *
 * @param value - Candidate reference array from an evidence page.
 * @returns Detached exact S3-version references.
 */
function readPlanningTargetArtifactReferences(
  value: unknown,
): readonly WorkspaceSearchMigrationPlanningTargetArtifactReference[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length === 0 ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetEvidence()
  }
  const objectKeys = new Set<string>()
  const references:
    WorkspaceSearchMigrationPlanningTargetArtifactReference[] = []
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index]
    const record = requireRecord(candidate)
    requireExactKeys(record, [
      'contentDigest',
      'objectKey',
      'versionId',
    ])
    const contentDigest = readDigest(record.contentDigest)
    const reference:
      WorkspaceSearchMigrationPlanningTargetArtifactReference = {
        objectKey: readNonBlankText(record.objectKey),
        versionId: readNonBlankText(record.versionId),
        contentDigest,
      }
    if (
      reference.objectKey !==
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          contentDigest,
        ) ||
      reference.versionId === 'null' ||
      objectKeys.has(reference.objectKey)
    ) {
      return failTargetEvidence()
    }
    objectKeys.add(reference.objectKey)
    references.push(reference)
  }
  return references
}

/**
 * Reads and validates one target evidence progress head.
 *
 * @param value - Candidate progress.
 * @returns Detached validated progress.
 */
function readProgress(
  value: unknown,
): WorkspaceSearchMigrationTargetEvidenceProgress {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'checkpoint',
    'configurationHash',
    'evidenceDigest',
    'pageSequence',
    'purpose',
    'runId',
    'stateTableId',
    'targetTableId',
  ])
  const identity = readIdentity(record)
  const pageSequence = readNonNegativeSafeInteger(record.pageSequence)
  const evidenceDigest = readDigest(record.evidenceDigest)
  const checkpoint = readCheckpoint(record.checkpoint)
  const initialCheckpoint =
    createEmptyWorkspaceSearchMigrationTargetScanCheckpoint(
      identity.configurationHash,
    )
  if (
    checkpoint.configurationHash !== identity.configurationHash ||
    pageSequence !== checkpoint.aggregate.pageCount ||
    (pageSequence === 0) !== (evidenceDigest === zeroHexDigest()) ||
    (pageSequence === 0) !==
      (
        createCheckpointDigestUnchecked(checkpoint) ===
          createCheckpointDigestUnchecked(initialCheckpoint)
      )
  ) {
    return failTargetEvidence()
  }
  return {
    ...identity,
    pageSequence,
    evidenceDigest,
    checkpoint,
  }
}

/**
 * Projects a typed page onto the exact evidence schema before validation.
 *
 * @param value - Candidate typed target evidence page.
 * @returns Detached validated page.
 */
function readRawPage(
  value: WorkspaceSearchMigrationTargetEvidencePage,
): WorkspaceSearchMigrationTargetEvidencePage {
  return readEncodedPage(encodePage(value))
}

/**
 * Reads one strict encoded target evidence page.
 *
 * @param value - Candidate JSON-safe target evidence page.
 * @returns Detached validated page.
 */
function readEncodedPage(
  value: unknown,
): WorkspaceSearchMigrationTargetEvidencePage {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'checkpoint',
    'configurationHash',
    'evidenceVersion',
    'invalidRows',
    'kind',
    'migrationId',
    'migrationVersion',
    'observedTargetBindings',
    'pageSequence',
    'planningAuthority',
    'previousCheckpointDigest',
    'previousEvidenceDigest',
    'purpose',
    'runId',
    'stateTableId',
    'targetArtifacts',
    'targetRows',
    'targetTableId',
  ])
  if (
    record.kind !== 'workspace-search-target-evidence-page' ||
    record.evidenceVersion !== 1 ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failTargetEvidence()
  }
  const identity = readIdentity(record)
  const checkpoint = readCheckpoint(record.checkpoint)
  const pageSequence = readPositiveSafeInteger(record.pageSequence)
  if (
    checkpoint.configurationHash !== identity.configurationHash ||
    checkpoint.aggregate.pageCount !== pageSequence
  ) {
    return failTargetEvidence()
  }
  const targetRows = readTargetRows(record.targetRows)
  const invalidRows = readInvalidRows(record.invalidRows)
  const observedTargetBindings =
    readObservedTargetBindings(record.observedTargetBindings)
  validatePageEvidenceShape(
    targetRows,
    invalidRows,
    observedTargetBindings,
  )
  return {
    kind: 'workspace-search-target-evidence-page',
    evidenceVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    ...identity,
    pageSequence,
    previousEvidenceDigest: readDigest(record.previousEvidenceDigest),
    previousCheckpointDigest: readDigest(record.previousCheckpointDigest),
    checkpoint,
    targetRows,
    invalidRows,
    observedTargetBindings,
    planningAuthority: readPlanningAuthority(record.planningAuthority),
    targetArtifacts:
      readPlanningTargetArtifactReferences(record.targetArtifacts),
  }
}

/**
 * Encodes one target evidence page into a JSON-safe lossless value.
 *
 * @param page - Raw target evidence page.
 * @returns JSON-safe evidence document.
 */
function encodePage(page: WorkspaceSearchMigrationTargetEvidencePage) {
  return {
    kind: page.kind,
    evidenceVersion: page.evidenceVersion,
    migrationId: page.migrationId,
    migrationVersion: page.migrationVersion,
    purpose: page.purpose,
    runId: page.runId,
    configurationHash: page.configurationHash,
    targetTableId: page.targetTableId,
    stateTableId: page.stateTableId,
    pageSequence: page.pageSequence,
    previousEvidenceDigest: page.previousEvidenceDigest,
    previousCheckpointDigest: page.previousCheckpointDigest,
    checkpoint: encodeCheckpoint(page.checkpoint),
    targetRows: page.targetRows.map((row) => ({
      classification: row.classification,
      targetKeyDigest: row.targetKeyDigest,
      targetItemDigest: row.targetItemDigest,
    })),
    invalidRows: page.invalidRows.map((row) => ({
      classification: row.classification,
      targetKeyDigest: row.targetKeyDigest,
      targetItemDigest: row.targetItemDigest,
      reasonCode: row.reasonCode,
    })),
    observedTargetBindings: page.observedTargetBindings.map((binding) => ({
      targetKeyDigest: binding.targetKeyDigest,
      targetItemDigest: binding.targetItemDigest,
    })),
    planningAuthority: {
      ownerId: page.planningAuthority.ownerId,
      fenceToken: page.planningAuthority.fenceToken,
      maintenanceEvidencePointerRevision:
        page.planningAuthority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceReceiptDigest:
        page.planningAuthority.maintenanceEvidenceReceiptDigest,
    },
    targetArtifacts: page.targetArtifacts.map((reference) => ({
      objectKey: reference.objectKey,
      versionId: reference.versionId,
      contentDigest: reference.contentDigest,
    })),
  }
}

/**
 * Encodes one raw progress head into its strict JSON-safe representation.
 *
 * @param progress - Raw target progress head.
 * @returns JSON-safe target progress head.
 */
function encodeProgress(
  progress: WorkspaceSearchMigrationTargetEvidenceProgress,
) {
  return {
    purpose: progress.purpose,
    runId: progress.runId,
    configurationHash: progress.configurationHash,
    targetTableId: progress.targetTableId,
    stateTableId: progress.stateTableId,
    pageSequence: progress.pageSequence,
    evidenceDigest: progress.evidenceDigest,
    checkpoint: encodeCheckpoint(progress.checkpoint),
  }
}

/**
 * Encodes one target checkpoint with a lossless tagged cursor.
 *
 * @param checkpoint - Raw cumulative target checkpoint.
 * @returns JSON-safe target checkpoint.
 */
function encodeCheckpoint(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
) {
  return {
    configurationHash: checkpoint.configurationHash,
    completed: checkpoint.completed,
    ...(checkpoint.cursor === undefined
      ? {}
      : { cursor: encodeAttributeMap(checkpoint.cursor) }),
    aggregate: checkpoint.aggregate,
    keyDigestState: checkpoint.keyDigestState,
    contentDigestState: checkpoint.contentDigestState,
  }
}

/**
 * Reads one strict encoded target checkpoint.
 *
 * @param value - Candidate checkpoint.
 * @returns Detached lossless target checkpoint.
 */
function readCheckpoint(
  value: unknown,
): WorkspaceSearchMigrationTargetScanCheckpoint {
  const record = requireRecord(value)
  if (record.completed !== true && record.completed !== false) {
    return failTargetEvidence()
  }
  const hasCursor = Object.prototype.hasOwnProperty.call(record, 'cursor')
  requireExactKeys(
    record,
    hasCursor
      ? [
          'aggregate',
          'completed',
          'configurationHash',
          'contentDigestState',
          'cursor',
          'keyDigestState',
        ]
      : [
          'aggregate',
          'completed',
          'configurationHash',
          'contentDigestState',
          'keyDigestState',
        ],
  )
  const checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint = {
    configurationHash: readDigest(record.configurationHash),
    completed: record.completed,
    ...(hasCursor ? { cursor: decodeAttributeMap(record.cursor) } : {}),
    aggregate: readAggregate(record.aggregate),
    keyDigestState: readDigestState(record.keyDigestState),
    contentDigestState: readDigestState(record.contentDigestState),
  }
  validateWorkspaceSearchMigrationTargetScanCheckpoint(checkpoint)
  return checkpoint
}

/**
 * Clones one target checkpoint through its strict lossless representation.
 *
 * @param checkpoint - Candidate target checkpoint.
 * @returns Detached validated target checkpoint.
 */
function cloneCheckpoint(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): WorkspaceSearchMigrationTargetScanCheckpoint {
  return readCheckpoint(encodeCheckpoint(checkpoint))
}

/**
 * Reads and validates one reducer result through its exact evidence fields.
 *
 * @param value - Candidate target page result.
 * @returns Detached exact target page result.
 */
function readPageResult(
  value: WorkspaceSearchMigrationTargetScanPageResult,
): WorkspaceSearchMigrationTargetScanPageResult {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'checkpoint',
    'invalidRows',
    'observedTargetBindings',
    'targetRows',
  ])
  const checkpoint = cloneCheckpoint(value.checkpoint)
  const targetRows = readTargetRows(record.targetRows)
  const invalidRows = readInvalidRows(record.invalidRows)
  const observedTargetBindings =
    readObservedTargetBindings(record.observedTargetBindings)
  validatePageEvidenceShape(
    targetRows,
    invalidRows,
    observedTargetBindings,
  )
  return {
    checkpoint,
    targetRows,
    invalidRows,
    observedTargetBindings,
  }
}

/**
 * Reads one cumulative target scan aggregate.
 *
 * @param value - Candidate aggregate.
 * @returns Validated target aggregate.
 */
function readAggregate(
  value: unknown,
): WorkspaceSearchMigrationTargetScanAggregate {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'contentDigest',
    'ignored',
    'invalid',
    'keyDigest',
    'owned',
    'pageCount',
    'scanned',
  ])
  const aggregate: WorkspaceSearchMigrationTargetScanAggregate = {
    scanned: readNonNegativeSafeInteger(record.scanned),
    owned: readNonNegativeSafeInteger(record.owned),
    ignored: readNonNegativeSafeInteger(record.ignored),
    invalid: readNonNegativeSafeInteger(record.invalid),
    keyDigest: readDigest(record.keyDigest),
    contentDigest: readDigest(record.contentDigest),
    pageCount: readNonNegativeSafeInteger(record.pageCount),
  }
  if (
    aggregate.owned + aggregate.ignored + aggregate.invalid !==
      aggregate.scanned
  ) {
    return failTargetEvidence()
  }
  return aggregate
}

/**
 * Reads one restorable digest accumulator state.
 *
 * @param value - Candidate state.
 * @returns Validated digest state.
 */
function readDigestState(value: unknown): MigrationDigestState {
  const record = requireRecord(value)
  requireExactKeys(record, ['count', 'sumHex', 'xorHex'])
  return {
    count: readNonNegativeSafeInteger(record.count),
    sumHex: readDigest(record.sumHex),
    xorHex: readDigest(record.xorHex),
  }
}

/**
 * Reads bounded owned and ignored target row evidence.
 *
 * @param value - Candidate target-row array.
 * @returns Detached validated rows.
 */
function readTargetRows(
  value: unknown,
): readonly WorkspaceSearchMigrationTargetScanRowEvidence[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetEvidence()
  }
  return value.map((candidate) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, [
      'classification',
      'targetItemDigest',
      'targetKeyDigest',
    ])
    if (
      record.classification !== 'ignored' &&
      record.classification !== 'owned'
    ) {
      return failTargetEvidence()
    }
    return {
      classification: record.classification,
      targetKeyDigest: readDigest(record.targetKeyDigest),
      targetItemDigest: readDigest(record.targetItemDigest),
    }
  })
}

/**
 * Reads bounded invalid target row evidence.
 *
 * @param value - Candidate invalid-row array.
 * @returns Detached validated invalid rows.
 */
function readInvalidRows(
  value: unknown,
): readonly WorkspaceSearchMigrationInvalidTargetScanRowEvidence[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetEvidence()
  }
  return value.map((candidate) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, [
      'classification',
      'reasonCode',
      'targetItemDigest',
      'targetKeyDigest',
    ])
    if (
      record.classification !== 'invalid' ||
      record.reasonCode !== 'INVALID_TARGET_ROW'
    ) {
      return failTargetEvidence()
    }
    return {
      classification: 'invalid',
      targetKeyDigest: readDigest(record.targetKeyDigest),
      targetItemDigest: readDigest(record.targetItemDigest),
      reasonCode: 'INVALID_TARGET_ROW',
    }
  })
}

/**
 * Reads bounded observed migration-owned target bindings.
 *
 * @param value - Candidate binding array.
 * @returns Detached validated target bindings.
 */
function readObservedTargetBindings(
  value: unknown,
): readonly WorkspaceSearchMigrationObservedTargetBinding[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetEvidence()
  }
  return value.map((candidate) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, [
      'targetItemDigest',
      'targetKeyDigest',
    ])
    return {
      targetKeyDigest: readDigest(record.targetKeyDigest),
      targetItemDigest: readDigest(record.targetItemDigest),
    }
  })
}

/**
 * Validates page-local row and observed-binding relationships.
 *
 * @param targetRows - Owned and ignored target-row evidence.
 * @param invalidRows - Invalid target-row evidence.
 * @param bindings - Migration-owned target preimage bindings.
 */
function validatePageEvidenceShape(
  targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidTargetScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationObservedTargetBinding[],
): void {
  if (
    targetRows.length + invalidRows.length >
      WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetEvidence()
  }
  validateEvidenceRelationships(targetRows, invalidRows, bindings)
}

/**
 * Validates target-row uniqueness and owned-binding relationships.
 *
 * @param targetRows - Owned and ignored target-row evidence.
 * @param invalidRows - Invalid target-row evidence.
 * @param bindings - Migration-owned target preimage bindings.
 */
function validateEvidenceRelationships(
  targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidTargetScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationObservedTargetBinding[],
): void {
  const ownedRows = targetRows.filter(
    (row) => row.classification === 'owned',
  )
  if (bindings.length !== ownedRows.length) return failTargetEvidence()
  const bindingByTargetKey = new Map<
    string,
    WorkspaceSearchMigrationObservedTargetBinding
  >()
  for (const binding of bindings) {
    if (bindingByTargetKey.has(binding.targetKeyDigest)) {
      return failTargetEvidence()
    }
    bindingByTargetKey.set(binding.targetKeyDigest, binding)
  }
  for (const row of ownedRows) {
    const binding = bindingByTargetKey.get(row.targetKeyDigest)
    if (
      binding === undefined ||
      binding.targetItemDigest !== row.targetItemDigest
    ) {
      return failTargetEvidence()
    }
  }
  const targetKeys = new Set<string>()
  for (const row of [...targetRows, ...invalidRows]) {
    if (targetKeys.has(row.targetKeyDigest)) return failTargetEvidence()
    targetKeys.add(row.targetKeyDigest)
  }
}

/**
 * Validates one target page against its exact durable predecessor.
 *
 * @param previous - Exact durable predecessor progress.
 * @param page - Candidate target successor page.
 */
function validateSuccessor(
  previous: WorkspaceSearchMigrationTargetEvidenceProgress,
  page: WorkspaceSearchMigrationTargetEvidencePage,
): void {
  requireSameIdentity(previous, page)
  if (
    previous.checkpoint.completed ||
    page.pageSequence !== previous.pageSequence + 1 ||
    page.checkpoint.configurationHash !== page.configurationHash ||
    page.checkpoint.aggregate.pageCount !== page.pageSequence ||
    page.previousEvidenceDigest !== previous.evidenceDigest ||
    page.previousCheckpointDigest !==
      createCheckpointDigestUnchecked(previous.checkpoint)
  ) {
    return failTargetEvidence()
  }
  validateWorkspaceSearchMigrationTargetScanCheckpoint(
    page.checkpoint,
    previous.checkpoint,
  )
  validatePageDelta(
    previous.checkpoint,
    page.checkpoint,
    page.targetRows,
    page.invalidRows,
    page.observedTargetBindings,
  )
}

/**
 * Reproduces one cumulative target checkpoint transition from row evidence.
 *
 * @param previous - Predecessor target checkpoint.
 * @param checkpoint - Candidate successor target checkpoint.
 * @param targetRows - Owned and ignored row evidence.
 * @param invalidRows - Invalid row evidence.
 * @param bindings - Observed migration-owned target bindings.
 */
function validatePageDelta(
  previous: WorkspaceSearchMigrationTargetScanCheckpoint,
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
  targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidTargetScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationObservedTargetBinding[],
): void {
  validatePageEvidenceShape(targetRows, invalidRows, bindings)
  if (checkpoint.cursor !== undefined) {
    const cursorDigest = createAttributeMapDigest(checkpoint.cursor)
    const matchingRows = [...targetRows, ...invalidRows].filter(
      (row) => row.targetKeyDigest === cursorDigest,
    )
    if (matchingRows.length !== 1) return failTargetEvidence()
  }
  const ownedRows = targetRows.filter(
    (row) => row.classification === 'owned',
  )
  const ignoredRows = targetRows.filter(
    (row) => row.classification === 'ignored',
  )
  if (
    checkpoint.aggregate.scanned - previous.aggregate.scanned !==
      targetRows.length + invalidRows.length ||
    checkpoint.aggregate.owned - previous.aggregate.owned !==
      ownedRows.length ||
    checkpoint.aggregate.ignored - previous.aggregate.ignored !==
      ignoredRows.length ||
    checkpoint.aggregate.invalid - previous.aggregate.invalid !==
      invalidRows.length ||
    bindings.length !== ownedRows.length
  ) {
    return failTargetEvidence()
  }
  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previous.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previous.contentDigestState,
  )
  for (const row of [...targetRows, ...invalidRows]) {
    keyAccumulator.add(row.targetKeyDigest)
    contentAccumulator.add(row.targetItemDigest)
  }
  if (
    !digestStatesEqual(
      keyAccumulator.exportState(),
      checkpoint.keyDigestState,
    ) ||
    !digestStatesEqual(
      contentAccumulator.exportState(),
      checkpoint.contentDigestState,
    ) ||
    keyAccumulator.digest() !== checkpoint.aggregate.keyDigest ||
    contentAccumulator.digest() !== checkpoint.aggregate.contentDigest
  ) {
    return failTargetEvidence()
  }
}

/**
 * Validates the final checkpoint against every replayed target row and binding.
 *
 * @param checkpoint - Final replayed target checkpoint.
 * @param targetRows - All owned and ignored target rows.
 * @param invalidRows - All invalid target rows.
 * @param bindings - All observed migration-owned target bindings.
 */
function validateGlobalAggregate(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
  targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidTargetScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationObservedTargetBinding[],
): void {
  validateEvidenceRelationships(targetRows, invalidRows, bindings)
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  let owned = 0
  let ignored = 0
  for (const row of targetRows) {
    if (row.classification === 'owned') owned += 1
    else ignored += 1
    keyAccumulator.add(row.targetKeyDigest)
    contentAccumulator.add(row.targetItemDigest)
  }
  for (const row of invalidRows) {
    keyAccumulator.add(row.targetKeyDigest)
    contentAccumulator.add(row.targetItemDigest)
  }
  if (
    checkpoint.aggregate.scanned !==
      targetRows.length + invalidRows.length ||
    checkpoint.aggregate.owned !== owned ||
    checkpoint.aggregate.ignored !== ignored ||
    checkpoint.aggregate.invalid !== invalidRows.length ||
    bindings.length !== owned ||
    !digestStatesEqual(
      keyAccumulator.exportState(),
      checkpoint.keyDigestState,
    ) ||
    !digestStatesEqual(
      contentAccumulator.exportState(),
      checkpoint.contentDigestState,
    ) ||
    keyAccumulator.digest() !== checkpoint.aggregate.keyDigest ||
    contentAccumulator.digest() !== checkpoint.aggregate.contentDigest
  ) {
    return failTargetEvidence()
  }
}

/**
 * Compares two exact restorable digest accumulator states.
 *
 * @param left - First digest state.
 * @param right - Second digest state.
 * @returns Whether every state component is equal.
 */
function digestStatesEqual(
  left: MigrationDigestState,
  right: MigrationDigestState,
): boolean {
  return left.count === right.count &&
    left.sumHex === right.sumHex &&
    left.xorHex === right.xorHex
}

/**
 * Requires two identity-bearing values to represent one exact target chain.
 *
 * @param expected - Expected target chain identity.
 * @param actual - Candidate target chain identity.
 */
function requireSameIdentity(
  expected: WorkspaceSearchMigrationTargetEvidenceIdentity,
  actual: WorkspaceSearchMigrationTargetEvidenceIdentity,
): void {
  if (
    expected.purpose !== actual.purpose ||
    expected.runId !== actual.runId ||
    expected.configurationHash !== actual.configurationHash ||
    expected.targetTableId !== actual.targetTableId ||
    expected.stateTableId !== actual.stateTableId
  ) {
    return failTargetEvidence()
  }
}

/**
 * Computes one exact canonical target page digest without nested boundaries.
 *
 * @param page - Validated target evidence page.
 * @returns Lowercase SHA-256 digest.
 */
function createPageDigestUnchecked(
  page: WorkspaceSearchMigrationTargetEvidencePage,
): string {
  return createHash('sha256').update(encodeCanonicalPage(page)).digest('hex')
}

/**
 * Computes one exact target checkpoint digest without nested boundaries.
 *
 * @param checkpoint - Validated target checkpoint.
 * @returns Lowercase SHA-256 digest.
 */
function createCheckpointDigestUnchecked(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): string {
  return digestCanonical({
    kind: 'workspace-search-target-evidence-checkpoint',
    digestVersion: targetEvidenceDigestVersion,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    checkpoint: encodeCheckpoint(checkpoint),
  })
}

/**
 * Computes a canonical JSON digest.
 *
 * @param value - JSON-compatible value.
 * @returns Lowercase SHA-256 digest.
 */
function digestCanonical(value: unknown): string {
  return createHash('sha256')
    .update(serializeCanonicalJson(value))
    .digest('hex')
}

/**
 * Encodes a validated target page into bounded canonical UTF-8 bytes.
 *
 * @param page - Validated target evidence page.
 * @returns Canonical bytes.
 */
function encodeCanonicalPage(
  page: WorkspaceSearchMigrationTargetEvidencePage,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(encodePage(page)),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES
  ) {
    return failTargetEvidence()
  }
  return bytes
}

/**
 * Parses bounded strict UTF-8 JSON bytes.
 *
 * @param bytes - Candidate target evidence bytes.
 * @returns Untrusted parsed JSON value.
 */
function parseJson(bytes: Uint8Array): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > WORKSPACE_SEARCH_MIGRATION_TARGET_EVIDENCE_MAX_BYTES
  ) {
    return failTargetEvidence()
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failTargetEvidence()
  }
  try {
    return JSON.parse(text)
  } catch {
    return failTargetEvidence()
  }
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failTargetEvidence()
  return value
}

/**
 * Reads one nonblank bounded UTF-8 text value.
 *
 * @param value - Candidate text.
 * @returns Validated text.
 */
function readNonBlankText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failTargetEvidence()
  }
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failTargetEvidence()
  }
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  const parsed = readNonNegativeSafeInteger(value)
  if (parsed === 0) return failTargetEvidence()
  return parsed
}

/**
 * Reads one plain validation record.
 *
 * @param value - Candidate value.
 * @returns Plain string-keyed record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failTargetEvidence()
  return value
}

/**
 * Checks whether one value is a plain string-keyed record.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires a record to contain exactly the expected keys.
 *
 * @param record - Candidate record.
 * @param expected - Complete expected key set.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    return failTargetEvidence()
  }
}

/**
 * Runs target evidence work behind a fixed raw-value-free failure boundary.
 *
 * @param operation - Evidence construction or validation work.
 * @returns Operation result.
 */
function runTargetEvidenceBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationTargetEvidenceError()
  }
}

/**
 * Raises the stable target-evidence validation failure.
 *
 * @returns Never returns.
 */
function failTargetEvidence(): never {
  throw new WorkspaceSearchMigrationTargetEvidenceError()
}
