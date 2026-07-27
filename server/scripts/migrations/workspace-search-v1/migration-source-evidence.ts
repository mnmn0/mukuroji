import { createHash } from 'node:crypto'
import {
  decodeAttributeMap,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  isHexDigest,
  type MigrationDigestState,
  MigrationDigestAccumulator,
  type MigrationScanAggregate,
  type MigrationSourceCheckpoint,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type WorkspaceSearchMigrationSourceName,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  zeroHexDigest,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationSourceOwnershipBinding,
  WorkspaceSearchMigrationSourceScanRowEvidence,
} from './migration-planner'
import type {
  WorkspaceSearchMigrationInvalidSourceScanRowEvidence,
  WorkspaceSearchMigrationSourceScanPageResult,
} from './migration-source-scan-page'
import {
  createEmptyWorkspaceSearchMigrationCheckpoint,
  validateWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/** Maximum exact UTF-8 size accepted for one source evidence page. */
export const WORKSPACE_SEARCH_MIGRATION_SOURCE_EVIDENCE_MAX_BYTES =
  2 * 1024 * 1024

/** Version of checkpoint and progress digest preimages. */
const sourceEvidenceDigestVersion = 1

/** Secret-free content-addressed namespace for planning source artifacts. */
const sourceArtifactObjectKeyPrefix =
  'workspace-search/v1/source-artifacts/v1'

/** Independent pre-plan scan purpose bound to one evidence chain. */
export type WorkspaceSearchMigrationSourceEvidencePurpose =
  | 'dry-run'
  | 'planning'

/** Immutable identity shared by every page in one source evidence chain. */
export type WorkspaceSearchMigrationSourceEvidenceIdentity = {
  /** Independent scan purpose. */
  readonly purpose: WorkspaceSearchMigrationSourceEvidencePurpose
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Logical source table being scanned. */
  readonly source: WorkspaceSearchMigrationSourceName
  /** Immutable physical source DynamoDB TableId. */
  readonly sourceTableId: string
  /** Immutable physical migration-state DynamoDB TableId. */
  readonly stateTableId: string
}

/** Exact durable authority bound into one planning evidence page. */
export type WorkspaceSearchMigrationPlanningAuthorityBinding = {
  /** Operator lease owner that authorized this page. */
  readonly ownerId: string
  /** Positive fencing token of the authorizing global lease. */
  readonly fenceToken: number
  /** Positive revision of the selected maintenance-evidence pointer. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest addressing the selected immutable maintenance-evidence receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
}

/** Exact immutable S3 version containing one ordered raw source segment. */
export type WorkspaceSearchMigrationPlanningSourceArtifactReference = {
  /** Deterministic secret-free content-addressed object key. */
  readonly objectKey: string
  /** Exact immutable S3 VersionId returned for the stored segment. */
  readonly versionId: string
  /** SHA-256 digest of the exact canonical segment bytes. */
  readonly contentDigest: string
}

/**
 * Fields shared by dry-run and planning source evidence pages.
 */
type WorkspaceSearchMigrationSourceEvidencePageBase = {
  /** Evidence document discriminator. */
  readonly kind: 'workspace-search-source-evidence-page'
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Versioned migration behavior. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected run identifier. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Logical source table being scanned. */
  readonly source: WorkspaceSearchMigrationSourceName
  /** Immutable physical source DynamoDB TableId. */
  readonly sourceTableId: string
  /** Immutable physical migration-state DynamoDB TableId. */
  readonly stateTableId: string
  /** One-based page position in this exact evidence chain. */
  readonly pageSequence: number
  /** Digest of the preceding page, or the zero digest for page one. */
  readonly previousEvidenceDigest: string
  /** Digest of the exact predecessor checkpoint. */
  readonly previousCheckpointDigest: string
  /** Cumulative checkpoint after this page. */
  readonly checkpoint: MigrationSourceCheckpoint
  /** Mapped and ignored row evidence emitted by the page reducer. */
  readonly sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[]
  /** Invalid digest-only row evidence emitted by the page reducer. */
  readonly invalidRows:
    readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[]
  /** Exact mapped-source ownership bindings emitted by the page reducer. */
  readonly sourceBindings:
    readonly WorkspaceSearchMigrationSourceOwnershipBinding[]
}

/** Version-one non-authoritative dry-run source evidence page. */
type WorkspaceSearchMigrationDryRunSourceEvidencePage =
  WorkspaceSearchMigrationSourceEvidencePageBase & {
    /** Dry-run evidence schema version. */
    readonly evidenceVersion: 1
    /** Non-authoritative dry-run scan purpose. */
    readonly purpose: 'dry-run'
  }

/** Legacy version-two authority-bound planning source evidence page. */
type WorkspaceSearchMigrationLegacyPlanningSourceEvidencePage =
  WorkspaceSearchMigrationSourceEvidencePageBase & {
    /** Legacy authority-only planning evidence schema version. */
    readonly evidenceVersion: 2
    /** Authoritative planning scan purpose. */
    readonly purpose: 'planning'
    /** Exact durable pre-plan authority used for this page. */
    readonly planningAuthority:
      WorkspaceSearchMigrationPlanningAuthorityBinding
  }

/** Version-three authority and immutable-artifact-bound planning page. */
type WorkspaceSearchMigrationPlanningSourceEvidencePage =
  WorkspaceSearchMigrationSourceEvidencePageBase & {
    /** Lossless artifact-bound planning evidence schema version. */
    readonly evidenceVersion: 3
    /** Authoritative planning scan purpose. */
    readonly purpose: 'planning'
    /** Exact durable pre-plan authority used for this page. */
    readonly planningAuthority:
      WorkspaceSearchMigrationPlanningAuthorityBinding
    /** Ordered immutable S3 versions containing every raw Scan item. */
    readonly sourceArtifacts:
      readonly WorkspaceSearchMigrationPlanningSourceArtifactReference[]
  }

/**
 * Canonical digest-only row evidence plus the exact resume checkpoint for one
 * committed source Scan page.
 */
export type WorkspaceSearchMigrationSourceEvidencePage =
  | WorkspaceSearchMigrationDryRunSourceEvidencePage
  | WorkspaceSearchMigrationLegacyPlanningSourceEvidencePage
  | WorkspaceSearchMigrationPlanningSourceEvidencePage

/** Durable head state required to resume one exact source evidence chain. */
export type WorkspaceSearchMigrationSourceEvidenceProgress =
  WorkspaceSearchMigrationSourceEvidenceIdentity & {
    /** Number of pages already committed. */
    readonly pageSequence: number
    /** Digest of the latest committed page, or zero before page one. */
    readonly evidenceDigest: string
    /** Exact cumulative checkpoint at the chain head. */
    readonly checkpoint: MigrationSourceCheckpoint
  }

/** Input used to derive the only valid successor evidence page. */
export type CreateWorkspaceSearchMigrationSourceEvidencePageInput = {
  /** Immutable evidence-chain identity. */
  readonly identity: WorkspaceSearchMigrationSourceEvidenceIdentity
  /** Per-page authority, required only for planning evidence. */
  readonly planningAuthority:
    WorkspaceSearchMigrationPlanningAuthorityBinding | null
  /** Ordered immutable raw-source segments, required only for planning v3. */
  readonly sourceArtifacts:
    readonly WorkspaceSearchMigrationPlanningSourceArtifactReference[] | null
  /** Exact durable predecessor progress. */
  readonly previousProgress: WorkspaceSearchMigrationSourceEvidenceProgress
  /** Detached reducer result for the page read from that predecessor. */
  readonly pageResult: WorkspaceSearchMigrationSourceScanPageResult
}

/** Complete replay output with globally validated digest-only row evidence. */
export type WorkspaceSearchMigrationSourceEvidenceReplayResult = {
  /** Reconstructed final chain head. */
  readonly progress: WorkspaceSearchMigrationSourceEvidenceProgress
  /** Every mapped or ignored row across the chain. */
  readonly sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[]
  /** Every invalid row across the chain. */
  readonly invalidRows:
    readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[]
  /** Every mapped ownership binding across the chain. */
  readonly sourceBindings:
    readonly WorkspaceSearchMigrationSourceOwnershipBinding[]
}

/** Stable raw-value-free failure raised for invalid source evidence. */
export class WorkspaceSearchMigrationSourceEvidenceError extends Error {
  /** Secret-free machine-readable evidence failure code. */
  readonly code = 'INVALID_SOURCE_EVIDENCE'

  /** Creates one stable source-evidence failure. */
  constructor() {
    super('INVALID_SOURCE_EVIDENCE')
    this.name = 'WorkspaceSearchMigrationSourceEvidenceError'
  }
}

/**
 * Creates the untouched head for one new pre-plan source evidence chain.
 *
 * @param identity - Immutable scan and storage identity.
 * @returns Canonical zero-page progress.
 */
export function createInitialWorkspaceSearchMigrationSourceEvidenceProgress(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
): WorkspaceSearchMigrationSourceEvidenceProgress {
  return runEvidenceBoundary(() => {
    const validated = readIdentity(identity)
    return {
      ...validated,
      pageSequence: 0,
      evidenceDigest: zeroHexDigest(),
      checkpoint: createEmptyWorkspaceSearchMigrationCheckpoint(),
    }
  })
}

/**
 * Creates one successor page from its exact progress and reducer result.
 *
 * @param input - Identity, durable predecessor, and bound reducer result.
 * @returns Detached canonical successor evidence.
 */
export function createWorkspaceSearchMigrationSourceEvidencePage(
  input: CreateWorkspaceSearchMigrationSourceEvidencePageInput,
): WorkspaceSearchMigrationSourceEvidencePage {
  return runEvidenceBoundary(() => {
    const identity = readIdentity(input.identity)
    const previous = readProgress(encodeProgress(input.previousProgress))
    requireSameIdentity(identity, previous)
    const pageBase: WorkspaceSearchMigrationSourceEvidencePageBase = {
      kind: 'workspace-search-source-evidence-page',
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: identity.runId,
      configurationHash: identity.configurationHash,
      source: identity.source,
      sourceTableId: identity.sourceTableId,
      stateTableId: identity.stateTableId,
      pageSequence: previous.pageSequence + 1,
      previousEvidenceDigest: previous.evidenceDigest,
      previousCheckpointDigest:
        createCheckpointDigestUnchecked(previous.checkpoint),
      checkpoint: cloneCheckpoint(input.pageResult.checkpoint),
      sourceRows: readSourceRows(input.pageResult.sourceRows),
      invalidRows: readInvalidRows(input.pageResult.invalidRows),
      sourceBindings: readSourceBindings(input.pageResult.sourceBindings),
    }
    let page: WorkspaceSearchMigrationSourceEvidencePage
    if (identity.purpose === 'dry-run') {
      if (
        input.planningAuthority !== null ||
        input.sourceArtifacts !== null
      ) {
        return failEvidence()
      }
      page = {
        ...pageBase,
        evidenceVersion: 1,
        purpose: 'dry-run',
      }
    } else {
      page = {
        ...pageBase,
        evidenceVersion: 3,
        purpose: 'planning',
        planningAuthority:
          readPlanningAuthorityBinding(input.planningAuthority),
        sourceArtifacts:
          readPlanningSourceArtifactReferences(input.sourceArtifacts),
      }
    }
    validateSuccessor(previous, page)
    return page
  })
}

/**
 * Advances one source evidence head after validating an exact successor page.
 *
 * @param previous - Exact current progress.
 * @param page - Candidate successor evidence.
 * @returns New detached progress.
 */
export function advanceWorkspaceSearchMigrationSourceEvidenceProgress(
  previous: WorkspaceSearchMigrationSourceEvidenceProgress,
  page: WorkspaceSearchMigrationSourceEvidencePage,
): WorkspaceSearchMigrationSourceEvidenceProgress {
  return runEvidenceBoundary(() => {
    const validatedPrevious = readProgress(encodeProgress(previous))
    const validatedPage = readRawPage(page)
    validateSuccessor(validatedPrevious, validatedPage)
    return {
      purpose: validatedPage.purpose,
      runId: validatedPage.runId,
      configurationHash: validatedPage.configurationHash,
      source: validatedPage.source,
      sourceTableId: validatedPage.sourceTableId,
      stateTableId: validatedPage.stateTableId,
      pageSequence: validatedPage.pageSequence,
      evidenceDigest: createPageDigestUnchecked(validatedPage),
      checkpoint: cloneCheckpoint(validatedPage.checkpoint),
    }
  })
}

/**
 * Replays a complete or partial evidence chain from its canonical initial head.
 *
 * @param identity - Expected immutable evidence identity.
 * @param pages - Ordered exact page documents.
 * @returns Final progress and globally validated row evidence.
 */
export function replayWorkspaceSearchMigrationSourceEvidencePages(
  identity: WorkspaceSearchMigrationSourceEvidenceIdentity,
  pages: readonly WorkspaceSearchMigrationSourceEvidencePage[],
): WorkspaceSearchMigrationSourceEvidenceReplayResult {
  return runEvidenceBoundary(() => {
    if (!hasCanonicalDenseArrayShape(pages)) return failEvidence()
    let progress =
      createInitialWorkspaceSearchMigrationSourceEvidenceProgress(identity)
    const sourceRows: WorkspaceSearchMigrationSourceScanRowEvidence[] = []
    const invalidRows:
      WorkspaceSearchMigrationInvalidSourceScanRowEvidence[] = []
    const sourceBindings:
      WorkspaceSearchMigrationSourceOwnershipBinding[] = []
    const sourceKeys = new Set<string>()
    const targetKeys = new Set<string>()
    let planningEvidenceVersion: 2 | 3 | undefined
    for (const candidate of pages) {
      const page = readRawPage(candidate)
      if (page.purpose === 'planning') {
        if (
          planningEvidenceVersion !== undefined &&
          planningEvidenceVersion !== page.evidenceVersion
        ) {
          return failEvidence()
        }
        planningEvidenceVersion = page.evidenceVersion
      }
      progress = advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        progress,
        page,
      )
      for (const row of [...page.sourceRows, ...page.invalidRows]) {
        if (sourceKeys.has(row.sourceKeyDigest)) return failEvidence()
        sourceKeys.add(row.sourceKeyDigest)
      }
      for (const binding of page.sourceBindings) {
        if (targetKeys.has(binding.targetKeyDigest)) return failEvidence()
        targetKeys.add(binding.targetKeyDigest)
      }
      sourceRows.push(...page.sourceRows)
      invalidRows.push(...page.invalidRows)
      sourceBindings.push(...page.sourceBindings)
    }
    validateGlobalAggregate(
      progress.checkpoint,
      sourceRows,
      invalidRows,
      sourceBindings,
    )
    return { progress, sourceRows, invalidRows, sourceBindings }
  })
}

/**
 * Serializes one evidence page into strict canonical UTF-8 JSON bytes.
 *
 * @param page - Candidate raw source evidence page.
 * @returns Exact canonical bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationSourceEvidencePage(
  page: WorkspaceSearchMigrationSourceEvidencePage,
): Uint8Array {
  return runEvidenceBoundary(() => encodeCanonicalPage(readRawPage(page)))
}

/**
 * Parses one exact canonical source evidence page.
 *
 * @param bytes - Untrusted bounded UTF-8 bytes.
 * @returns Detached validated evidence page.
 */
export function parseWorkspaceSearchMigrationSourceEvidencePage(
  bytes: Uint8Array,
): WorkspaceSearchMigrationSourceEvidencePage {
  return runEvidenceBoundary(() => {
    const parsed = parseJson(bytes)
    const page = readEncodedPage(parsed)
    const canonical = encodeCanonicalPage(page)
    if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
      return failEvidence()
    }
    return page
  })
}

/**
 * Digests the exact canonical bytes of one evidence page.
 *
 * @param page - Candidate source evidence page.
 * @returns Lowercase SHA-256 page digest.
 */
export function createWorkspaceSearchMigrationSourceEvidencePageDigest(
  page: WorkspaceSearchMigrationSourceEvidencePage,
): string {
  return runEvidenceBoundary(() => createPageDigestUnchecked(readRawPage(page)))
}

/**
 * Digests one exact checkpoint using its lossless cursor representation.
 *
 * @param checkpoint - Candidate cumulative checkpoint.
 * @returns Lowercase SHA-256 checkpoint digest.
 */
export function createWorkspaceSearchMigrationSourceCheckpointDigest(
  checkpoint: MigrationSourceCheckpoint,
): string {
  return runEvidenceBoundary(() =>
    createCheckpointDigestUnchecked(cloneCheckpoint(checkpoint))
  )
}

/**
 * Creates a stable CAS fingerprint for one exact progress head.
 *
 * @param progress - Candidate source evidence progress.
 * @returns Lowercase SHA-256 progress digest.
 */
export function createWorkspaceSearchMigrationSourceEvidenceProgressDigest(
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
): string {
  return runEvidenceBoundary(() => {
    const value = readProgress(encodeProgress(progress))
    return digestCanonical({
      kind: 'workspace-search-source-evidence-progress',
      digestVersion: sourceEvidenceDigestVersion,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      purpose: value.purpose,
      runId: value.runId,
      configurationHash: value.configurationHash,
      source: value.source,
      sourceTableId: value.sourceTableId,
      stateTableId: value.stateTableId,
      pageSequence: value.pageSequence,
      evidenceDigest: value.evidenceDigest,
      checkpoint: encodeCheckpoint(value.checkpoint),
    })
  })
}

/**
 * Reads and detaches one source evidence identity.
 *
 * @param value - Candidate identity-bearing value.
 * @returns Validated immutable identity.
 */
function readIdentity(
  value: unknown,
): WorkspaceSearchMigrationSourceEvidenceIdentity {
  const record = requireRecord(value)
  const runIdValue = record.runId
  if (typeof runIdValue !== 'string') return failEvidence()
  let runId: string
  try {
    runId = requireMigrationIdentifier(runIdValue, 'Run ID')
  } catch {
    return failEvidence()
  }
  return {
    purpose: readPurpose(record.purpose),
    runId,
    configurationHash: readDigest(record.configurationHash),
    source: readSource(record.source),
    sourceTableId: readNonBlankText(record.sourceTableId),
    stateTableId: readNonBlankText(record.stateTableId),
  }
}

/**
 * Reads and detaches one exact planning-authority binding.
 *
 * @param value - Candidate authority binding.
 * @returns Validated immutable authority binding.
 */
function readPlanningAuthorityBinding(
  value: unknown,
): WorkspaceSearchMigrationPlanningAuthorityBinding {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  const ownerIdValue = record.ownerId
  if (typeof ownerIdValue !== 'string') return failEvidence()
  let ownerId: string
  try {
    ownerId = requireMigrationIdentifier(ownerIdValue, 'Owner ID')
  } catch {
    return failEvidence()
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
 * Reads one complete ordered immutable artifact-reference set.
 *
 * @param value - Candidate reference array from a planning v3 page.
 * @returns Detached exact S3-version references.
 */
function readPlanningSourceArtifactReferences(
  value: unknown,
): readonly WorkspaceSearchMigrationPlanningSourceArtifactReference[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length === 0 ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failEvidence()
  }
  const objectKeys = new Set<string>()
  const references:
    WorkspaceSearchMigrationPlanningSourceArtifactReference[] = []
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
      WorkspaceSearchMigrationPlanningSourceArtifactReference = {
        objectKey: readNonBlankText(record.objectKey),
        versionId: readNonBlankText(record.versionId),
        contentDigest,
      }
    if (
      reference.objectKey !==
        `${sourceArtifactObjectKeyPrefix}/${contentDigest}.json` ||
      objectKeys.has(reference.objectKey)
    ) {
      return failEvidence()
    }
    objectKeys.add(reference.objectKey)
    references.push(reference)
  }
  return references
}

/**
 * Reads and validates one source evidence progress head.
 *
 * @param value - Candidate progress.
 * @returns Detached validated progress.
 */
function readProgress(
  value: unknown,
): WorkspaceSearchMigrationSourceEvidenceProgress {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'checkpoint',
    'configurationHash',
    'evidenceDigest',
    'pageSequence',
    'purpose',
    'runId',
    'source',
    'sourceTableId',
    'stateTableId',
  ])
  const identity = readIdentity(record)
  const pageSequence = readNonNegativeSafeInteger(record.pageSequence)
  const evidenceDigest = readDigest(record.evidenceDigest)
  const checkpoint = readCheckpoint(record.checkpoint)
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  if (
    pageSequence !== checkpoint.aggregate.pageCount ||
    (pageSequence === 0) !== (evidenceDigest === zeroHexDigest()) ||
    (pageSequence === 0) !==
      (createCheckpointDigestUnchecked(checkpoint) ===
        createCheckpointDigestUnchecked(
          createEmptyWorkspaceSearchMigrationCheckpoint(),
        ))
  ) {
    return failEvidence()
  }
  return {
    ...identity,
    pageSequence,
    evidenceDigest,
    checkpoint,
  }
}

/**
 * Projects a typed page onto the evidence schema before strict validation.
 *
 * Projection deliberately drops runtime-only properties so serialization and
 * hashing cannot accidentally retain caller data outside the evidence schema.
 *
 * @param value - Candidate typed page.
 * @returns Detached validated page.
 */
function readRawPage(
  value: WorkspaceSearchMigrationSourceEvidencePage,
): WorkspaceSearchMigrationSourceEvidencePage {
  return readEncodedPage(encodePage(value))
}

/**
 * Reads one strict encoded evidence page.
 *
 * @param value - Candidate JSON-safe evidence page.
 * @returns Detached validated page.
 */
function readEncodedPage(
  value: unknown,
): WorkspaceSearchMigrationSourceEvidencePage {
  const record = requireRecord(value)
  const identity = readIdentity(record)
  const commonKeys = [
    'checkpoint',
    'configurationHash',
    'evidenceVersion',
    'invalidRows',
    'kind',
    'migrationId',
    'migrationVersion',
    'pageSequence',
    'previousCheckpointDigest',
    'previousEvidenceDigest',
    'purpose',
    'runId',
    'source',
    'sourceBindings',
    'sourceRows',
    'sourceTableId',
    'stateTableId',
  ]
  requireExactKeys(
    record,
    identity.purpose === 'dry-run'
      ? commonKeys
      : record.evidenceVersion === 3
        ? [...commonKeys, 'planningAuthority', 'sourceArtifacts']
        : [...commonKeys, 'planningAuthority'],
  )
  if (
    record.kind !== 'workspace-search-source-evidence-page' ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION ||
    (identity.purpose === 'dry-run'
      ? record.evidenceVersion !== 1
      : record.evidenceVersion !== 2 &&
        record.evidenceVersion !== 3)
  ) {
    return failEvidence()
  }
  const checkpoint = readCheckpoint(record.checkpoint)
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  const pageSequence = readPositiveSafeInteger(record.pageSequence)
  if (checkpoint.aggregate.pageCount !== pageSequence) return failEvidence()
  const sourceRows = readSourceRows(record.sourceRows)
  const invalidRows = readInvalidRows(record.invalidRows)
  const sourceBindings = readSourceBindings(record.sourceBindings)
  validatePageEvidenceShape(sourceRows, invalidRows, sourceBindings)
  const pageBase: WorkspaceSearchMigrationSourceEvidencePageBase = {
    kind: 'workspace-search-source-evidence-page',
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: identity.runId,
    configurationHash: identity.configurationHash,
    source: identity.source,
    sourceTableId: identity.sourceTableId,
    stateTableId: identity.stateTableId,
    pageSequence,
    previousEvidenceDigest: readDigest(record.previousEvidenceDigest),
    previousCheckpointDigest: readDigest(record.previousCheckpointDigest),
    checkpoint,
    sourceRows,
    invalidRows,
    sourceBindings,
  }
  if (identity.purpose === 'dry-run') {
    return {
      ...pageBase,
      evidenceVersion: 1,
      purpose: 'dry-run',
    }
  }
  const planningAuthority =
    readPlanningAuthorityBinding(record.planningAuthority)
  if (record.evidenceVersion === 2) {
    return {
      ...pageBase,
      evidenceVersion: 2,
      purpose: 'planning',
      planningAuthority,
    }
  }
  return {
    ...pageBase,
    evidenceVersion: 3,
    purpose: 'planning',
    planningAuthority,
    sourceArtifacts:
      readPlanningSourceArtifactReferences(record.sourceArtifacts),
  }
}

/**
 * Encodes one evidence page into a JSON-safe lossless value.
 *
 * @param page - Raw evidence page.
 * @returns JSON-safe evidence document.
 */
function encodePage(page: WorkspaceSearchMigrationSourceEvidencePage) {
  const encoded = {
    kind: page.kind,
    evidenceVersion: page.evidenceVersion,
    migrationId: page.migrationId,
    migrationVersion: page.migrationVersion,
    purpose: page.purpose,
    runId: page.runId,
    configurationHash: page.configurationHash,
    source: page.source,
    sourceTableId: page.sourceTableId,
    stateTableId: page.stateTableId,
    pageSequence: page.pageSequence,
    previousEvidenceDigest: page.previousEvidenceDigest,
    previousCheckpointDigest: page.previousCheckpointDigest,
    checkpoint: encodeCheckpoint(page.checkpoint),
    sourceRows: page.sourceRows.map((row) => ({
      classification: row.classification,
      sourceKeyDigest: row.sourceKeyDigest,
      sourceItemDigest: row.sourceItemDigest,
    })),
    invalidRows: page.invalidRows.map((row) => ({
      classification: row.classification,
      sourceKeyDigest: row.sourceKeyDigest,
      sourceItemDigest: row.sourceItemDigest,
      reasonCode: row.reasonCode,
    })),
    sourceBindings: page.sourceBindings.map((binding) => ({
      sourceKeyDigest: binding.sourceKeyDigest,
      sourceItemDigest: binding.sourceItemDigest,
      targetKeyDigest: binding.targetKeyDigest,
      targetAction: binding.targetAction,
    })),
  }
  if (page.purpose === 'dry-run') return encoded
  const planningEncoded = {
    ...encoded,
    planningAuthority: {
      ownerId: page.planningAuthority.ownerId,
      fenceToken: page.planningAuthority.fenceToken,
      maintenanceEvidencePointerRevision:
        page.planningAuthority.maintenanceEvidencePointerRevision,
      maintenanceEvidenceReceiptDigest:
        page.planningAuthority.maintenanceEvidenceReceiptDigest,
    },
  }
  if (page.evidenceVersion === 2) return planningEncoded
  return {
    ...planningEncoded,
    sourceArtifacts: page.sourceArtifacts.map((reference) => ({
      objectKey: reference.objectKey,
      versionId: reference.versionId,
      contentDigest: reference.contentDigest,
    })),
  }
}

/**
 * Encodes one raw progress head into its strict JSON-safe representation.
 *
 * @param progress - Raw progress head.
 * @returns JSON-safe progress head.
 */
function encodeProgress(
  progress: WorkspaceSearchMigrationSourceEvidenceProgress,
) {
  return {
    purpose: progress.purpose,
    runId: progress.runId,
    configurationHash: progress.configurationHash,
    source: progress.source,
    sourceTableId: progress.sourceTableId,
    stateTableId: progress.stateTableId,
    pageSequence: progress.pageSequence,
    evidenceDigest: progress.evidenceDigest,
    checkpoint: encodeCheckpoint(progress.checkpoint),
  }
}

/**
 * Encodes one checkpoint with a lossless tagged cursor.
 *
 * @param checkpoint - Raw cumulative checkpoint.
 * @returns JSON-safe checkpoint.
 */
function encodeCheckpoint(checkpoint: MigrationSourceCheckpoint) {
  return {
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
 * Reads one strict encoded checkpoint.
 *
 * @param value - Candidate checkpoint.
 * @returns Detached lossless checkpoint.
 */
function readCheckpoint(value: unknown): MigrationSourceCheckpoint {
  const record = requireRecord(value)
  if (record.completed !== true && record.completed !== false) {
    return failEvidence()
  }
  const hasCursor = Object.prototype.hasOwnProperty.call(record, 'cursor')
  requireExactKeys(
    record,
    hasCursor
      ? [
          'aggregate',
          'completed',
          'contentDigestState',
          'cursor',
          'keyDigestState',
        ]
      : [
          'aggregate',
          'completed',
          'contentDigestState',
          'keyDigestState',
        ],
  )
  const checkpoint: MigrationSourceCheckpoint = {
    completed: record.completed,
    ...(hasCursor ? { cursor: decodeAttributeMap(record.cursor) } : {}),
    aggregate: readAggregate(record.aggregate),
    keyDigestState: readDigestState(record.keyDigestState),
    contentDigestState: readDigestState(record.contentDigestState),
  }
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  return checkpoint
}

/**
 * Clones one checkpoint through its strict lossless representation.
 *
 * @param checkpoint - Candidate checkpoint.
 * @returns Detached validated checkpoint.
 */
function cloneCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
): MigrationSourceCheckpoint {
  return readCheckpoint(encodeCheckpoint(checkpoint))
}

/**
 * Reads one cumulative scan aggregate.
 *
 * @param value - Candidate aggregate.
 * @returns Validated aggregate.
 */
function readAggregate(value: unknown): MigrationScanAggregate {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'contentDigest',
    'deleted',
    'ignored',
    'invalid',
    'keyDigest',
    'mapped',
    'pageCount',
    'projected',
    'scanned',
  ])
  const aggregate: MigrationScanAggregate = {
    scanned: readNonNegativeSafeInteger(record.scanned),
    mapped: readNonNegativeSafeInteger(record.mapped),
    ignored: readNonNegativeSafeInteger(record.ignored),
    invalid: readNonNegativeSafeInteger(record.invalid),
    projected: readNonNegativeSafeInteger(record.projected),
    deleted: readNonNegativeSafeInteger(record.deleted),
    keyDigest: readDigest(record.keyDigest),
    contentDigest: readDigest(record.contentDigest),
    pageCount: readNonNegativeSafeInteger(record.pageCount),
  }
  if (
    aggregate.mapped + aggregate.ignored + aggregate.invalid !==
      aggregate.scanned ||
    aggregate.projected + aggregate.deleted !== aggregate.mapped
  ) {
    return failEvidence()
  }
  return aggregate
}

/**
 * Reads one restorable digest accumulator state.
 *
 * @param value - Candidate state.
 * @returns Validated state.
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
 * Reads bounded mapped and ignored source row evidence.
 *
 * @param value - Candidate row array.
 * @returns Detached validated rows.
 */
function readSourceRows(
  value: unknown,
): readonly WorkspaceSearchMigrationSourceScanRowEvidence[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failEvidence()
  }
  return value.map((candidate) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, [
      'classification',
      'sourceItemDigest',
      'sourceKeyDigest',
    ])
    if (
      record.classification !== 'ignored' &&
      record.classification !== 'mapped'
    ) {
      return failEvidence()
    }
    return {
      classification: record.classification,
      sourceKeyDigest: readDigest(record.sourceKeyDigest),
      sourceItemDigest: readDigest(record.sourceItemDigest),
    }
  })
}

/**
 * Reads bounded invalid source row evidence.
 *
 * @param value - Candidate invalid-row array.
 * @returns Detached validated invalid rows.
 */
function readInvalidRows(
  value: unknown,
): readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failEvidence()
  }
  return value.map((candidate) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, [
      'classification',
      'reasonCode',
      'sourceItemDigest',
      'sourceKeyDigest',
    ])
    if (record.classification !== 'invalid') return failEvidence()
    const reasonCode = readInvalidReason(record.reasonCode)
    return {
      classification: 'invalid',
      sourceKeyDigest: readDigest(record.sourceKeyDigest),
      sourceItemDigest: readDigest(record.sourceItemDigest),
      reasonCode,
    }
  })
}

/**
 * Reads bounded mapped-source ownership bindings.
 *
 * @param value - Candidate binding array.
 * @returns Detached validated bindings.
 */
function readSourceBindings(
  value: unknown,
): readonly WorkspaceSearchMigrationSourceOwnershipBinding[] {
  if (
    !hasCanonicalDenseArrayShape(value) ||
    value.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failEvidence()
  }
  return value.map((candidate) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, [
      'sourceItemDigest',
      'sourceKeyDigest',
      'targetAction',
      'targetKeyDigest',
    ])
    if (
      record.targetAction !== 'delete' &&
      record.targetAction !== 'put'
    ) {
      return failEvidence()
    }
    return {
      sourceKeyDigest: readDigest(record.sourceKeyDigest),
      sourceItemDigest: readDigest(record.sourceItemDigest),
      targetKeyDigest: readDigest(record.targetKeyDigest),
      targetAction: record.targetAction,
    }
  })
}

/**
 * Validates page-local row and mapped-binding relationships.
 *
 * @param sourceRows - Mapped and ignored row evidence.
 * @param invalidRows - Invalid row evidence.
 * @param bindings - Mapped ownership bindings.
 */
function validatePageEvidenceShape(
  sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationSourceOwnershipBinding[],
): void {
  if (
    sourceRows.length + invalidRows.length >
      WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failEvidence()
  }
  validateEvidenceRelationships(sourceRows, invalidRows, bindings)
}

/**
 * Validates row uniqueness and mapped-binding relationships at any scope.
 *
 * Page callers enforce the DynamoDB page-size limit separately, while complete
 * replay validation deliberately accepts the accumulated rows from many pages.
 *
 * @param sourceRows - Mapped and ignored row evidence.
 * @param invalidRows - Invalid row evidence.
 * @param bindings - Mapped ownership bindings.
 */
function validateEvidenceRelationships(
  sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationSourceOwnershipBinding[],
): void {
  const mappedRows = sourceRows.filter(
    (row) => row.classification === 'mapped',
  )
  if (bindings.length !== mappedRows.length) return failEvidence()
  const bindingBySourceKey = new Map<
    string,
    WorkspaceSearchMigrationSourceOwnershipBinding
  >()
  for (const binding of bindings) {
    if (bindingBySourceKey.has(binding.sourceKeyDigest)) return failEvidence()
    bindingBySourceKey.set(binding.sourceKeyDigest, binding)
  }
  for (const row of mappedRows) {
    const binding = bindingBySourceKey.get(row.sourceKeyDigest)
    if (
      binding === undefined ||
      binding.sourceItemDigest !== row.sourceItemDigest
    ) {
      return failEvidence()
    }
  }
  const pageKeys = new Set<string>()
  for (const row of [...sourceRows, ...invalidRows]) {
    if (pageKeys.has(row.sourceKeyDigest)) return failEvidence()
    pageKeys.add(row.sourceKeyDigest)
  }
  const targetKeys = new Set<string>()
  for (const binding of bindings) {
    if (targetKeys.has(binding.targetKeyDigest)) return failEvidence()
    targetKeys.add(binding.targetKeyDigest)
  }
}

/**
 * Validates one page against its exact durable predecessor.
 *
 * @param previous - Exact durable predecessor progress.
 * @param page - Candidate successor page.
 */
function validateSuccessor(
  previous: WorkspaceSearchMigrationSourceEvidenceProgress,
  page: WorkspaceSearchMigrationSourceEvidencePage,
): void {
  requireSameIdentity(previous, page)
  if (
    previous.checkpoint.completed ||
    page.pageSequence !== previous.pageSequence + 1 ||
    page.checkpoint.aggregate.pageCount !== page.pageSequence ||
    page.previousEvidenceDigest !== previous.evidenceDigest ||
    page.previousCheckpointDigest !==
      createCheckpointDigestUnchecked(previous.checkpoint)
  ) {
    return failEvidence()
  }
  validateWorkspaceSearchMigrationCheckpoint(
    page.checkpoint,
    previous.checkpoint,
  )
  validatePageDelta(
    previous.checkpoint,
    page.checkpoint,
    page.sourceRows,
    page.invalidRows,
    page.sourceBindings,
  )
}

/**
 * Reproduces one cumulative checkpoint transition from row evidence.
 *
 * @param previous - Predecessor checkpoint.
 * @param checkpoint - Candidate successor checkpoint.
 * @param sourceRows - Mapped and ignored row evidence.
 * @param invalidRows - Invalid row evidence.
 * @param bindings - Mapped ownership bindings.
 */
function validatePageDelta(
  previous: MigrationSourceCheckpoint,
  checkpoint: MigrationSourceCheckpoint,
  sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationSourceOwnershipBinding[],
): void {
  validatePageEvidenceShape(sourceRows, invalidRows, bindings)
  validateAggregateDelta(
    previous,
    checkpoint,
    sourceRows,
    invalidRows,
    bindings,
  )
}

/**
 * Reproduces one checkpoint transition from an already validated row set.
 *
 * @param previous - Predecessor checkpoint.
 * @param checkpoint - Candidate successor checkpoint.
 * @param sourceRows - Mapped and ignored row evidence.
 * @param invalidRows - Invalid row evidence.
 * @param bindings - Mapped ownership bindings.
 */
function validateAggregateDelta(
  previous: MigrationSourceCheckpoint,
  checkpoint: MigrationSourceCheckpoint,
  sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationSourceOwnershipBinding[],
): void {
  const mappedRows = sourceRows.filter(
    (row) => row.classification === 'mapped',
  )
  const ignoredRows = sourceRows.filter(
    (row) => row.classification === 'ignored',
  )
  if (
    checkpoint.aggregate.scanned - previous.aggregate.scanned !==
      sourceRows.length + invalidRows.length ||
    checkpoint.aggregate.mapped - previous.aggregate.mapped !==
      mappedRows.length ||
    checkpoint.aggregate.ignored - previous.aggregate.ignored !==
      ignoredRows.length ||
    checkpoint.aggregate.invalid - previous.aggregate.invalid !==
      invalidRows.length ||
    bindings.length !== mappedRows.length
  ) {
    return failEvidence()
  }

  const bindingBySourceKey = new Map<
    string,
    WorkspaceSearchMigrationSourceOwnershipBinding
  >()
  let projected = 0
  let deleted = 0
  for (const binding of bindings) {
    bindingBySourceKey.set(binding.sourceKeyDigest, binding)
    if (binding.targetAction === 'put') projected += 1
    else deleted += 1
  }
  for (const row of mappedRows) {
    const binding = bindingBySourceKey.get(row.sourceKeyDigest)
    if (
      binding === undefined ||
      binding.sourceItemDigest !== row.sourceItemDigest
    ) {
      return failEvidence()
    }
  }
  if (
    checkpoint.aggregate.projected - previous.aggregate.projected !==
      projected ||
    checkpoint.aggregate.deleted - previous.aggregate.deleted !== deleted
  ) {
    return failEvidence()
  }

  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previous.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previous.contentDigestState,
  )
  for (const row of [...sourceRows, ...invalidRows]) {
    keyAccumulator.add(row.sourceKeyDigest)
    contentAccumulator.add(row.sourceItemDigest)
  }
  if (
    digestCanonical(keyAccumulator.exportState()) !==
      digestCanonical(checkpoint.keyDigestState) ||
    digestCanonical(contentAccumulator.exportState()) !==
      digestCanonical(checkpoint.contentDigestState) ||
    keyAccumulator.digest() !== checkpoint.aggregate.keyDigest ||
    contentAccumulator.digest() !== checkpoint.aggregate.contentDigest
  ) {
    return failEvidence()
  }
}

/**
 * Validates the final aggregate against every replayed row and binding.
 *
 * @param checkpoint - Final replayed checkpoint.
 * @param sourceRows - All mapped and ignored rows.
 * @param invalidRows - All invalid rows.
 * @param bindings - All mapped ownership bindings.
 */
function validateGlobalAggregate(
  checkpoint: MigrationSourceCheckpoint,
  sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[],
  invalidRows:
    readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[],
  bindings: readonly WorkspaceSearchMigrationSourceOwnershipBinding[],
): void {
  const initial = createEmptyWorkspaceSearchMigrationCheckpoint()
  const syntheticCheckpoint: MigrationSourceCheckpoint = {
    ...cloneCheckpoint(checkpoint),
    aggregate: {
      ...checkpoint.aggregate,
      pageCount: 1,
    },
  }
  const syntheticInitial: MigrationSourceCheckpoint = {
    ...initial,
    aggregate: {
      ...initial.aggregate,
      pageCount: 0,
    },
  }
  validateEvidenceRelationships(sourceRows, invalidRows, bindings)
  validateAggregateDelta(
    syntheticInitial,
    syntheticCheckpoint,
    sourceRows,
    invalidRows,
    bindings,
  )
}

/**
 * Requires two identity-bearing values to represent one exact chain.
 *
 * @param expected - Expected chain identity.
 * @param actual - Candidate chain identity.
 */
function requireSameIdentity(
  expected: WorkspaceSearchMigrationSourceEvidenceIdentity,
  actual: WorkspaceSearchMigrationSourceEvidenceIdentity,
): void {
  if (
    expected.purpose !== actual.purpose ||
    expected.runId !== actual.runId ||
    expected.configurationHash !== actual.configurationHash ||
    expected.source !== actual.source ||
    expected.sourceTableId !== actual.sourceTableId ||
    expected.stateTableId !== actual.stateTableId
  ) {
    return failEvidence()
  }
}

/**
 * Computes one exact canonical page digest without wrapping nested calls.
 *
 * @param page - Validated page.
 * @returns Lowercase SHA-256 digest.
 */
function createPageDigestUnchecked(
  page: WorkspaceSearchMigrationSourceEvidencePage,
): string {
  return createHash('sha256').update(encodeCanonicalPage(page)).digest('hex')
}

/**
 * Computes one exact checkpoint digest without wrapping nested calls.
 *
 * @param checkpoint - Validated checkpoint.
 * @returns Lowercase SHA-256 digest.
 */
function createCheckpointDigestUnchecked(
  checkpoint: MigrationSourceCheckpoint,
): string {
  return digestCanonical({
    kind: 'workspace-search-source-evidence-checkpoint',
    digestVersion: sourceEvidenceDigestVersion,
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
 * Encodes a validated page into bounded canonical UTF-8 bytes.
 *
 * @param page - Validated page.
 * @returns Canonical bytes.
 */
function encodeCanonicalPage(
  page: WorkspaceSearchMigrationSourceEvidencePage,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(encodePage(page)),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > WORKSPACE_SEARCH_MIGRATION_SOURCE_EVIDENCE_MAX_BYTES
  ) {
    return failEvidence()
  }
  return bytes
}

/**
 * Parses bounded strict UTF-8 JSON bytes.
 *
 * @param bytes - Candidate bytes.
 * @returns Untrusted parsed JSON value.
 */
function parseJson(bytes: Uint8Array): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > WORKSPACE_SEARCH_MIGRATION_SOURCE_EVIDENCE_MAX_BYTES
  ) {
    return failEvidence()
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failEvidence()
  }
  try {
    return JSON.parse(text)
  } catch {
    return failEvidence()
  }
}

/**
 * Reads one independent evidence purpose.
 *
 * @param value - Candidate purpose.
 * @returns Validated purpose.
 */
function readPurpose(
  value: unknown,
): WorkspaceSearchMigrationSourceEvidencePurpose {
  if (value !== 'dry-run' && value !== 'planning') return failEvidence()
  return value
}

/**
 * Reads one exact source name.
 *
 * @param value - Candidate source name.
 * @returns Validated source name.
 */
function readSource(value: unknown): WorkspaceSearchMigrationSourceName {
  for (const source of workspaceSearchMigrationSourceNames) {
    if (value === source) return source
  }
  return failEvidence()
}

/**
 * Reads one stable invalid-row reason.
 *
 * @param value - Candidate reason.
 * @returns Validated reason.
 */
function readInvalidReason(
  value: unknown,
): WorkspaceSearchMigrationInvalidSourceScanRowEvidence['reasonCode'] {
  if (
    value === 'MALFORMED_PROJECT_DIRECTORY_TARGET' ||
    value === 'UNRECOGNIZED_PROJECT_DIRECTORY_ROW' ||
    value === 'MALFORMED_WORK_ITEM_TARGET' ||
    value === 'MALFORMED_COLLABORATION_TARGET' ||
    value === 'UNRECOGNIZED_COLLABORATION_ROW' ||
    value === 'MALFORMED_DOCUMENT_TARGET' ||
    value === 'UNRECOGNIZED_DOCUMENT_ROW' ||
    value === 'MAPPER_EXCEPTION'
  ) {
    return value
  }
  return failEvidence()
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failEvidence()
  return value
}

/**
 * Reads one nonblank bounded text value.
 *
 * @param value - Candidate text.
 * @returns Validated text.
 */
function readNonBlankText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value !== value.trim()
  ) {
    return failEvidence()
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
    return failEvidence()
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
  if (parsed === 0) return failEvidence()
  return parsed
}

/**
 * Reads one plain validation record.
 *
 * @param value - Candidate value.
 * @returns Plain string-keyed record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failEvidence()
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
    return failEvidence()
  }
}

/**
 * Runs a source-evidence operation behind a fixed raw-value-free boundary.
 *
 * @param operation - Evidence construction or validation work.
 * @returns Operation result.
 */
function runEvidenceBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationSourceEvidenceError()
  }
}

/**
 * Raises the stable source-evidence validation failure.
 *
 * @returns Never returns.
 */
function failEvidence(): never {
  throw new WorkspaceSearchMigrationSourceEvidenceError()
}
