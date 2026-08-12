import { types as nodeUtilTypes } from 'node:util'
import {
  readWorkspaceSearchWriterFenceClosedRecord,
  type WorkspaceSearchWriterFenceAuthority,
  type WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  MINIMUM_MAINTENANCE_DRAIN_SECONDS,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationTableRole,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  MAINTENANCE_EVIDENCE_MAX_AGE_SECONDS,
  MAINTENANCE_EVIDENCE_MAX_BYTES,
  parseMaintenanceEvidence,
  type WorkspaceSearchMaintenanceEvidence,
} from './maintenance-evidence'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  assertWorkspaceSearchMigrationLeaseAuthority,
  validateWorkspaceSearchMaintenanceEvidenceReceipt,
} from './migration-state-machine'
import {
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Maximum canonical bytes accepted for one execution boundary. */
export const WORKSPACE_SEARCH_MIGRATION_EXECUTION_BOUNDARY_MAX_BYTES =
  64 * 1024

const maximumIdentifierLength = 256
const maximumTableIdLength = 1_024
const minimumDrainMilliseconds =
  MINIMUM_MAINTENANCE_DRAIN_SECONDS * 1_000
const maintenanceEvidenceValidityMilliseconds =
  MAINTENANCE_EVIDENCE_MAX_AGE_SECONDS * 1_000
const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
  ...workspaceSearchMigrationSourceNames,
  'workspace-search',
  'migration-state',
]

/**
 * Stable raw-value-free failure raised for an invalid execution boundary.
 */
export class WorkspaceSearchMigrationExecutionBoundaryError extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_MIGRATION_EXECUTION_BOUNDARY'

  /** Creates one stable execution-boundary failure. */
  constructor() {
    super('INVALID_MIGRATION_EXECUTION_BOUNDARY')
    this.name = 'WorkspaceSearchMigrationExecutionBoundaryError'
  }
}

/**
 * Fields shared by every execution-boundary phase.
 */
type WorkspaceSearchMigrationExecutionBoundaryBase = {
  /** Stable execution-boundary document discriminator. */
  readonly kind: 'workspace-search-migration-execution-boundary'
  /** Execution-boundary schema version. */
  readonly boundaryVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical DynamoDB table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Digest of the exact closed application-writer fence row. */
  readonly closedWriterFenceRecordDigest: string
  /** Canonical UTC time committed by the exact closed fence row. */
  readonly closedAt: string
  /** Exact lease and maintenance authority that closed the writer fence. */
  readonly closeAuthority: WorkspaceSearchWriterFenceAuthority
}

/**
 * Initial durable boundary committed atomically with writer-fence close.
 */
export type WorkspaceSearchMigrationClosedExecutionBoundary =
  WorkspaceSearchMigrationExecutionBoundaryBase & {
    /** Closed phase permits only post-close drain admission. */
    readonly phase: 'closed'
    /** Initial immutable close-boundary revision. */
    readonly revision: 1
    /** Digest of every preceding canonical boundary field. */
    readonly boundaryDigest: string
  }

/**
 * Exact post-close evidence commitment admitted before planning begins.
 */
export type WorkspaceSearchMigrationExecutionPlanningAdmission = {
  /** Lease owner whose exact current authority admitted planning. */
  readonly ownerId: string
  /** Exact lease takeover fence that admitted planning. */
  readonly leaseFenceToken: number
  /** Digest of the complete immutable maintenance-evidence receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Exact optimistic revision of the receipt pointer admitted for planning. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the exact raw maintenance-evidence bytes. */
  readonly maintenanceEvidenceDigest: string
  /** Secret-free external locator copied from the admitted evidence. */
  readonly maintenanceEvidenceLocator: string
  /** Runtime-control revision shared by every admitted surface. */
  readonly runtimeRevision: number
  /** Raw-evidence-derived beginning of the post-close zero-writer drain. */
  readonly drainStartedAt: string
  /** Raw-evidence-derived completion of the post-close zero-writer drain. */
  readonly drainCompletedAt: string
  /** Adapter-owned canonical UTC time linearized by the admission transaction. */
  readonly admittedAt: string
}

/**
 * Successor boundary proving planning may start after a complete closed drain.
 */
export type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary =
  WorkspaceSearchMigrationExecutionBoundaryBase & {
    /** Planning-admitted phase permits creation of new-run evidence heads. */
    readonly phase: 'planning-admitted'
    /** Single immutable successor revision. */
    readonly revision: 2
    /** Exact post-close maintenance-evidence commitment. */
    readonly planningAdmission:
      WorkspaceSearchMigrationExecutionPlanningAdmission
    /** Digest of every preceding canonical boundary field. */
    readonly boundaryDigest: string
  }

/**
 * Strict two-phase dormant execution boundary.
 */
export type WorkspaceSearchMigrationExecutionBoundary =
  | WorkspaceSearchMigrationClosedExecutionBoundary
  | WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary

/**
 * Input used to create the initial closed execution boundary.
 */
export type CreateWorkspaceSearchMigrationExecutionBoundaryInput = {
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six independently measured physical DynamoDB TableIds. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Exact canonical closed writer-fence record committed with the boundary. */
  readonly closedWriterFenceRecord: WorkspaceSearchWriterFenceClosedRecord
}

/**
 * Input used to admit post-close planning.
 */
export type AdmitWorkspaceSearchMigrationExecutionBoundaryPlanningInput = {
  /** Exact closed predecessor; admitted boundaries cannot transition again. */
  readonly current: WorkspaceSearchMigrationClosedExecutionBoundary
  /** Exact strongly resolved current lease, pointer, and receipt authority. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned canonical UTC time used by the atomic admission commit. */
  readonly admittedAt: string
  /** Exact raw evidence bytes whose drain interval is committed. */
  readonly maintenanceEvidenceBytes: Uint8Array
}

/**
 * Input used to recover an already durable planning admission.
 */
export type RecoverWorkspaceSearchMigrationExecutionBoundaryPlanningAdmissionInput = {
  /** Exact durable revision-two boundary being recovered. */
  readonly current:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Fresh current authority evaluated at its own current instant. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Exact raw evidence bytes committed by the durable admission. */
  readonly maintenanceEvidenceBytes: Uint8Array
}

/**
 * Creates the revision-one boundary for one exact closed writer fence.
 *
 * The function validates the complete writer-fence record before projecting
 * its digest, timestamp, authority, and measured TableIds.
 *
 * @param input - Exact run, configuration, TableIds, and closed fence.
 * @returns Detached canonical closed execution boundary.
 */
export function createWorkspaceSearchMigrationExecutionBoundary(
  input: CreateWorkspaceSearchMigrationExecutionBoundaryInput,
): WorkspaceSearchMigrationClosedExecutionBoundary {
  return atExecutionBoundary(() => {
    requireExactKeys(requireRecord(input), [
      'closedWriterFenceRecord',
      'configurationHash',
      'runId',
      'tableIds',
    ])
    const runId = readIdentifier(input.runId)
    const configurationHash = readDigest(input.configurationHash)
    const tableIds = readTableIds(input.tableIds)
    const closedFence =
      readWorkspaceSearchWriterFenceClosedRecord(
        input.closedWriterFenceRecord,
      )
    const closeAuthority = readCloseAuthority(closedFence.authority)
    const closedFenceTableIds = readTableIds(
      closedFence.binding.tableIds,
    )
    if (
      closeAuthority.runId !== runId ||
      closeAuthority.configurationHash !== configurationHash ||
      !sameTableIds(tableIds, closedFenceTableIds)
    ) {
      return failExecutionBoundary()
    }

    return finalizeClosedBoundary({
      kind: 'workspace-search-migration-execution-boundary',
      boundaryVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId,
      configurationHash,
      tableIds,
      closedWriterFenceRecordDigest: readDigest(
        closedFence.recordDigest,
      ),
      closedAt: readTimestamp(closedFence.closedAt),
      closeAuthority,
      phase: 'closed',
      revision: 1,
    })
  })
}

/**
 * Admits planning after validating an exact post-close maintenance drain.
 *
 * The predecessor is never mutated. Exact evidence bytes are reparsed at the
 * receipt validation time, correlated with every receipt field derived from
 * those bytes, and then reduced to the compact admission commitment.
 *
 * @param input - Closed predecessor, current receipt, pointer, and raw bytes.
 * @returns Detached canonical planning-admitted successor.
 */
export function admitWorkspaceSearchMigrationExecutionBoundaryPlanning(
  input: AdmitWorkspaceSearchMigrationExecutionBoundaryPlanningInput,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  return atExecutionBoundary(() => {
    requireExactKeys(requireRecord(input), [
      'admittedAt',
      'current',
      'currentAuthority',
      'maintenanceEvidenceBytes',
    ])
    const current = readExecutionBoundary(
      input.current,
    )
    if (current.phase !== 'closed') return failExecutionBoundary()
    const currentAuthority = readPrePlanAuthority(
      input.currentAuthority,
    )
    const admittedAt = readTimestamp(input.admittedAt)
    if (
      currentAuthority.configurationHash !== current.configurationHash ||
      currentAuthority.stateTableId !==
        current.tableIds['migration-state'] ||
      currentAuthority.lease.runId !== current.runId ||
      Date.parse(currentAuthority.evaluatedAt) > Date.parse(admittedAt)
    ) {
      return failExecutionBoundary()
    }
    assertWorkspaceSearchMigrationLeaseAuthority(
      current.runId,
      {
        lease: currentAuthority.lease,
        ownerId: currentAuthority.lease.ownerId,
        at: admittedAt,
      },
    )
    const receipt = currentAuthority.maintenanceEvidenceReceipt
    validateWorkspaceSearchMaintenanceEvidenceReceipt(
      receipt,
      current.runId,
      currentAuthority.lease.fenceToken,
      admittedAt,
    )
    const evidenceBytes = copyBoundedBytes(
      input.maintenanceEvidenceBytes,
      MAINTENANCE_EVIDENCE_MAX_BYTES,
    )
    const parsed = parseMaintenanceEvidence(evidenceBytes, {
      now: new Date(admittedAt),
    })
    requireReceiptMatchesEvidence(receipt, parsed.evidence, parsed.fileSha256)

    const drainStartedAt = readTimestamp(
      parsed.evidence.drainStartedAt,
    )
    const drainCompletedAt = readTimestamp(
      parsed.evidence.drainCompletedAt,
    )
    if (
      currentAuthority.maintenanceEvidencePointerRevision <=
        current.closeAuthority.maintenanceEvidencePointerRevision ||
      receipt.fenceToken < current.closeAuthority.leaseFenceToken ||
      Date.parse(drainStartedAt) < Date.parse(current.closedAt) ||
      Date.parse(drainCompletedAt) > Date.parse(admittedAt)
    ) {
      return failExecutionBoundary()
    }

    return finalizePlanningAdmittedBoundary({
      kind: current.kind,
      boundaryVersion: current.boundaryVersion,
      migrationId: current.migrationId,
      migrationVersion: current.migrationVersion,
      runId: current.runId,
      configurationHash: current.configurationHash,
      tableIds: current.tableIds,
      closedWriterFenceRecordDigest:
        current.closedWriterFenceRecordDigest,
      closedAt: current.closedAt,
      closeAuthority: current.closeAuthority,
      phase: 'planning-admitted',
      revision: 2,
      planningAdmission: {
        ownerId: currentAuthority.lease.ownerId,
        leaseFenceToken: currentAuthority.lease.fenceToken,
        maintenanceEvidenceReceiptDigest:
          currentAuthority.maintenanceEvidenceReceiptDigest,
        maintenanceEvidencePointerRevision:
          currentAuthority.maintenanceEvidencePointerRevision,
        maintenanceEvidenceDigest: receipt.evidenceDigest,
        maintenanceEvidenceLocator: receipt.evidenceLocator,
        runtimeRevision: receipt.runtimeRevision,
        drainStartedAt,
        drainCompletedAt,
        admittedAt,
      },
    })
  })
}

/**
 * Recovers an already durable planning admission under fresh current authority.
 *
 * Recovery validates lease and receipt freshness at the authority's current
 * `evaluatedAt`, while comparing only stable admission fields to the durable
 * boundary. It never rewinds a newer heartbeat or evaluation time to the
 * original `admittedAt`.
 *
 * @param input - Durable admission, fresh authority, and exact raw evidence.
 * @returns Detached exact durable planning-admitted boundary.
 */
export function recoverWorkspaceSearchMigrationExecutionBoundaryPlanningAdmission(
  input:
    RecoverWorkspaceSearchMigrationExecutionBoundaryPlanningAdmissionInput,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  return atExecutionBoundary(() => {
    requireExactKeys(requireRecord(input), [
      'current',
      'currentAuthority',
      'maintenanceEvidenceBytes',
    ])
    const current = readExecutionBoundary(input.current)
    if (current.phase !== 'planning-admitted') {
      return failExecutionBoundary()
    }
    const currentAuthority = readPrePlanAuthority(
      input.currentAuthority,
    )
    const evaluatedAt = readTimestamp(currentAuthority.evaluatedAt)
    const admission = current.planningAdmission
    if (
      currentAuthority.configurationHash !== current.configurationHash ||
      currentAuthority.stateTableId !==
        current.tableIds['migration-state'] ||
      currentAuthority.lease.runId !== current.runId
    ) {
      return failExecutionBoundary()
    }
    assertWorkspaceSearchMigrationLeaseAuthority(
      current.runId,
      {
        lease: currentAuthority.lease,
        ownerId: currentAuthority.lease.ownerId,
        at: evaluatedAt,
      },
    )
    const receipt = currentAuthority.maintenanceEvidenceReceipt
    validateWorkspaceSearchMaintenanceEvidenceReceipt(
      receipt,
      current.runId,
      currentAuthority.lease.fenceToken,
      evaluatedAt,
    )
    const evidenceBytes = copyBoundedBytes(
      input.maintenanceEvidenceBytes,
      MAINTENANCE_EVIDENCE_MAX_BYTES,
    )
    const parsed = parseMaintenanceEvidence(evidenceBytes, {
      now: new Date(evaluatedAt),
    })
    requireReceiptMatchesEvidence(
      receipt,
      parsed.evidence,
      parsed.fileSha256,
    )
    const drainStartedAt = readTimestamp(
      parsed.evidence.drainStartedAt,
    )
    const drainCompletedAt = readTimestamp(
      parsed.evidence.drainCompletedAt,
    )
    if (
      currentAuthority.lease.ownerId !== admission.ownerId ||
      currentAuthority.lease.fenceToken !==
        admission.leaseFenceToken ||
      currentAuthority.maintenanceEvidenceReceiptDigest !==
        admission.maintenanceEvidenceReceiptDigest ||
      currentAuthority.maintenanceEvidencePointerRevision !==
        admission.maintenanceEvidencePointerRevision ||
      receipt.evidenceDigest !== admission.maintenanceEvidenceDigest ||
      receipt.evidenceLocator !== admission.maintenanceEvidenceLocator ||
      receipt.runtimeRevision !== admission.runtimeRevision ||
      drainStartedAt !== admission.drainStartedAt ||
      drainCompletedAt !== admission.drainCompletedAt
    ) {
      return failExecutionBoundary()
    }
    return current
  })
}

/**
 * Serializes one strict execution boundary as canonical UTF-8 JSON.
 *
 * @param value - Candidate closed or planning-admitted boundary.
 * @returns Exact canonical bounded bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationExecutionBoundary(
  value: WorkspaceSearchMigrationExecutionBoundary,
): Uint8Array {
  return atExecutionBoundary(() =>
    encodeCanonical(
      readExecutionBoundary(value),
    )
  )
}

/**
 * Parses exact canonical execution-boundary bytes.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict closed or planning-admitted boundary.
 */
export function parseWorkspaceSearchMigrationExecutionBoundary(
  bytes: Uint8Array,
): WorkspaceSearchMigrationExecutionBoundary {
  return atExecutionBoundary(() => {
    const snapshot = copyBoundedBytes(
      bytes,
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_BOUNDARY_MAX_BYTES,
    )
    let parsed: unknown
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        snapshot,
      )
      parsed = JSON.parse(text)
    } catch {
      return failExecutionBoundary()
    }
    const boundary = readExecutionBoundary(parsed)
    const canonical = encodeCanonical(boundary)
    if (!equalBytes(snapshot, canonical)) return failExecutionBoundary()
    return boundary
  })
}

/**
 * Validates one boundary and returns its canonical embedded digest.
 *
 * @param value - Candidate closed or planning-admitted boundary.
 * @returns Lowercase SHA-256 digest of every preceding canonical field.
 */
export function createWorkspaceSearchMigrationExecutionBoundaryDigest(
  value: WorkspaceSearchMigrationExecutionBoundary,
): string {
  return atExecutionBoundary(() =>
    readExecutionBoundary(value).boundaryDigest
  )
}

/**
 * Detaches one exact current pre-plan authority through the descriptor-safe
 * execution-boundary parser.
 *
 * This helper lets an AWS adapter snapshot caller-owned authority before its
 * first asynchronous read without duplicating the pure boundary's validation.
 *
 * @param value - Candidate current lease, pointer, and receipt authority.
 * @returns Detached internally correlated authority.
 */
export function detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthority {
  return atExecutionBoundary(() => readPrePlanAuthority(value))
}

/**
 * Reconstructs the unique revision-one predecessor of a strict execution
 * boundary.
 *
 * A planning-admitted boundary retains every close field, so response-loss
 * recovery can reproduce its canonical closed predecessor without trusting
 * adapter-owned duplicate state.
 *
 * @param value - Candidate closed or planning-admitted execution boundary.
 * @returns Detached canonical closed predecessor.
 */
export function createWorkspaceSearchMigrationClosedExecutionBoundaryPredecessor(
  value: WorkspaceSearchMigrationExecutionBoundary,
): WorkspaceSearchMigrationClosedExecutionBoundary {
  return atExecutionBoundary(() => {
    const current = readExecutionBoundary(value)
    if (current.phase === 'closed') return current
    return finalizeClosedBoundary({
      kind: current.kind,
      boundaryVersion: current.boundaryVersion,
      migrationId: current.migrationId,
      migrationVersion: current.migrationVersion,
      runId: current.runId,
      configurationHash: current.configurationHash,
      tableIds: current.tableIds,
      closedWriterFenceRecordDigest:
        current.closedWriterFenceRecordDigest,
      closedAt: current.closedAt,
      closeAuthority: current.closeAuthority,
      phase: 'closed',
      revision: 1,
    })
  })
}

/**
 * Canonical fields used before attaching a closed-boundary digest.
 */
type ClosedExecutionBoundaryFields =
  Omit<WorkspaceSearchMigrationClosedExecutionBoundary, 'boundaryDigest'>

/**
 * Canonical fields used before attaching a planning-admitted digest.
 */
type PlanningAdmittedExecutionBoundaryFields = Omit<
  WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
  'boundaryDigest'
>

/**
 * Attaches and validates the digest of a closed boundary.
 *
 * @param fields - Strict revision-one fields.
 * @returns Detached closed boundary with its canonical digest.
 */
function finalizeClosedBoundary(
  fields: ClosedExecutionBoundaryFields,
): WorkspaceSearchMigrationClosedExecutionBoundary {
  const boundary = {
    ...fields,
    boundaryDigest: createMigrationDigest(fields),
  }
  void encodeCanonical(boundary)
  return boundary
}

/**
 * Attaches and validates the digest of a planning-admitted boundary.
 *
 * @param fields - Strict revision-two fields.
 * @returns Detached planning-admitted boundary with its canonical digest.
 */
function finalizePlanningAdmittedBoundary(
  fields: PlanningAdmittedExecutionBoundaryFields,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  const boundary = {
    ...fields,
    boundaryDigest: createMigrationDigest(fields),
  }
  void encodeCanonical(boundary)
  return boundary
}

/**
 * Reads one strict execution boundary and verifies its embedded digest.
 *
 * @param value - Candidate runtime or parsed boundary.
 * @returns Detached strict execution boundary.
 */
function readExecutionBoundary(
  value: unknown,
): WorkspaceSearchMigrationExecutionBoundary {
  const record = requireRecord(value)
  const phase = readOwn(record, 'phase')
  const revision = readOwn(record, 'revision')
  if (phase === 'closed' && revision === 1) {
    requireExactKeys(record, [
      'boundaryDigest',
      'boundaryVersion',
      'closeAuthority',
      'closedAt',
      'closedWriterFenceRecordDigest',
      'configurationHash',
      'kind',
      'migrationId',
      'migrationVersion',
      'phase',
      'revision',
      'runId',
      'tableIds',
    ])
    const fields = readBoundaryBase(record)
    const closedFields: ClosedExecutionBoundaryFields = {
      ...fields,
      phase: 'closed',
      revision: 1,
    }
    const boundaryDigest = readDigest(
      readOwn(record, 'boundaryDigest'),
    )
    if (boundaryDigest !== createMigrationDigest(closedFields)) {
      return failExecutionBoundary()
    }
    return { ...closedFields, boundaryDigest }
  }
  if (phase === 'planning-admitted' && revision === 2) {
    requireExactKeys(record, [
      'boundaryDigest',
      'boundaryVersion',
      'closeAuthority',
      'closedAt',
      'closedWriterFenceRecordDigest',
      'configurationHash',
      'kind',
      'migrationId',
      'migrationVersion',
      'phase',
      'planningAdmission',
      'revision',
      'runId',
      'tableIds',
    ])
    const fields = readBoundaryBase(record)
    const planningFields: PlanningAdmittedExecutionBoundaryFields = {
      ...fields,
      phase: 'planning-admitted',
      revision: 2,
      planningAdmission: readPlanningAdmission(
        readOwn(record, 'planningAdmission'),
        fields.closedAt,
        fields.closeAuthority,
      ),
    }
    const boundaryDigest = readDigest(
      readOwn(record, 'boundaryDigest'),
    )
    if (boundaryDigest !== createMigrationDigest(planningFields)) {
      return failExecutionBoundary()
    }
    return { ...planningFields, boundaryDigest }
  }
  return failExecutionBoundary()
}

/**
 * Reads and correlates fields shared by both phases.
 *
 * @param record - Candidate boundary record.
 * @returns Detached strict shared fields.
 */
function readBoundaryBase(
  record: object,
): WorkspaceSearchMigrationExecutionBoundaryBase {
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-execution-boundary' ||
    readOwn(record, 'boundaryVersion') !== 1 ||
    readOwn(record, 'migrationId') !== WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failExecutionBoundary()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const closeAuthority = readCloseAuthority(
    readOwn(record, 'closeAuthority'),
  )
  if (
    closeAuthority.runId !== runId ||
    closeAuthority.configurationHash !== configurationHash
  ) {
    return failExecutionBoundary()
  }
  return {
    kind: 'workspace-search-migration-execution-boundary',
    boundaryVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    closedWriterFenceRecordDigest: readDigest(
      readOwn(record, 'closedWriterFenceRecordDigest'),
    ),
    closedAt: readTimestamp(readOwn(record, 'closedAt')),
    closeAuthority,
  }
}

/**
 * Reads one exact post-close planning admission.
 *
 * @param value - Candidate admission record.
 * @param closedAt - Exact writer-fence close time.
 * @param closeAuthority - Authority that committed the close.
 * @returns Detached strict admission.
 */
function readPlanningAdmission(
  value: unknown,
  closedAt: string,
  closeAuthority: WorkspaceSearchWriterFenceAuthority,
): WorkspaceSearchMigrationExecutionPlanningAdmission {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'admittedAt',
    'drainCompletedAt',
    'drainStartedAt',
    'leaseFenceToken',
    'maintenanceEvidenceDigest',
    'maintenanceEvidenceLocator',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
    'runtimeRevision',
  ])
  const pointerRevision = readPositiveSafeInteger(
    readOwn(record, 'maintenanceEvidencePointerRevision'),
  )
  const leaseFenceToken = readPositiveSafeInteger(
    readOwn(record, 'leaseFenceToken'),
  )
  const drainStartedAt = readTimestamp(
    readOwn(record, 'drainStartedAt'),
  )
  const drainCompletedAt = readTimestamp(
    readOwn(record, 'drainCompletedAt'),
  )
  const admittedAt = readTimestamp(readOwn(record, 'admittedAt'))
  if (
    pointerRevision <=
      closeAuthority.maintenanceEvidencePointerRevision ||
    leaseFenceToken < closeAuthority.leaseFenceToken ||
    Date.parse(drainStartedAt) < Date.parse(closedAt) ||
    Date.parse(drainCompletedAt) - Date.parse(drainStartedAt) <
      minimumDrainMilliseconds ||
    Date.parse(drainCompletedAt) > Date.parse(admittedAt)
  ) {
    return failExecutionBoundary()
  }
  return {
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    leaseFenceToken,
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    maintenanceEvidencePointerRevision: pointerRevision,
    maintenanceEvidenceDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceDigest'),
    ),
    maintenanceEvidenceLocator: readBoundedText(
      readOwn(record, 'maintenanceEvidenceLocator'),
      maximumIdentifierLength,
    ),
    runtimeRevision: readPositiveSafeInteger(
      readOwn(record, 'runtimeRevision'),
    ),
    drainStartedAt,
    drainCompletedAt,
    admittedAt,
  }
}

/**
 * Reads one exact close authority.
 *
 * @param value - Candidate writer-fence authority.
 * @returns Detached strict authority.
 */
function readCloseAuthority(
  value: unknown,
): WorkspaceSearchWriterFenceAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'leaseFenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
    'runId',
  ])
  return {
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    runId: readIdentifier(readOwn(record, 'runId')),
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    leaseFenceToken: readPositiveSafeInteger(
      readOwn(record, 'leaseFenceToken'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
  }
}

/**
 * Reads and correlates one exact current pre-plan authority aggregate.
 *
 * @param value - Candidate strongly resolved authority.
 * @returns Detached strict lease, pointer, receipt, and evaluation time.
 */
function readPrePlanAuthority(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'configurationHash',
    'evaluatedAt',
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceipt',
    'maintenanceEvidenceReceiptDigest',
    'stateTableId',
  ])
  const lease = readMigrationLease(readOwn(record, 'lease'))
  const receipt = readMaintenanceEvidenceReceipt(
    readOwn(record, 'maintenanceEvidenceReceipt'),
    lease.runId,
  )
  const authority: WorkspaceSearchMigrationPrePlanAuthority = {
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    stateTableId: readBoundedText(
      readOwn(record, 'stateTableId'),
      maximumTableIdLength,
    ),
    lease,
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt: readTimestamp(readOwn(record, 'evaluatedAt')),
  }
  if (
    authority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(receipt) ||
    receipt.fenceToken !== lease.fenceToken
  ) {
    return failExecutionBoundary()
  }
  assertWorkspaceSearchMigrationLeaseAuthority(
    lease.runId,
    {
      lease,
      ownerId: lease.ownerId,
      at: authority.evaluatedAt,
    },
  )
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt,
    lease.runId,
    lease.fenceToken,
    authority.evaluatedAt,
  )
  return authority
}

/**
 * Reads one exact durable fenced lease.
 *
 * @param value - Candidate lease record.
 * @returns Detached strict lease fields.
 */
function readMigrationLease(
  value: unknown,
): WorkspaceSearchMigrationLease {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'expiresAt',
    'fenceToken',
    'heartbeatAt',
    'ownerId',
    'runId',
  ])
  return {
    runId: readIdentifier(readOwn(record, 'runId')),
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    expiresAt: readTimestamp(readOwn(record, 'expiresAt')),
    heartbeatAt: readTimestamp(readOwn(record, 'heartbeatAt')),
  }
}

/**
 * Reads and validates one complete maintenance-evidence receipt.
 *
 * @param value - Candidate receipt.
 * @param runId - Run that must own the receipt.
 * @returns Detached strict receipt.
 */
function readMaintenanceEvidenceReceipt(
  value: unknown,
  runId: string,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'evidenceDigest',
    'evidenceLocator',
    'fenceToken',
    'oldestObservationAt',
    'runId',
    'runtimeRevision',
    'validatedAt',
    'validUntil',
  ])
  const receipt: WorkspaceSearchMaintenanceEvidenceReceipt = {
    runId: readIdentifier(readOwn(record, 'runId')),
    evidenceDigest: readDigest(readOwn(record, 'evidenceDigest')),
    evidenceLocator: readBoundedText(
      readOwn(record, 'evidenceLocator'),
      maximumIdentifierLength,
    ),
    runtimeRevision: readPositiveSafeInteger(
      readOwn(record, 'runtimeRevision'),
    ),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    validatedAt: readTimestamp(readOwn(record, 'validatedAt')),
    oldestObservationAt: readTimestamp(
      readOwn(record, 'oldestObservationAt'),
    ),
    validUntil: readTimestamp(readOwn(record, 'validUntil')),
  }
  validateWorkspaceSearchMaintenanceEvidenceReceipt(receipt, runId)
  return receipt
}

/**
 * Requires one receipt to reproduce every raw-evidence-derived field.
 *
 * @param receipt - Strict immutable receipt.
 * @param evidence - Strict evidence parsed from the exact source bytes.
 * @param evidenceDigest - SHA-256 digest of the exact source bytes.
 */
function requireReceiptMatchesEvidence(
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  evidence: WorkspaceSearchMaintenanceEvidence,
  evidenceDigest: string,
): void {
  let oldestObservationAt = evidence.drainCompletedAt
  for (const surface of evidence.surfaces) {
    if (Date.parse(surface.observedAt) < Date.parse(oldestObservationAt)) {
      oldestObservationAt = surface.observedAt
    }
  }
  const expectedValidUntil = new Date(
    Date.parse(oldestObservationAt) +
      maintenanceEvidenceValidityMilliseconds +
      1,
  ).toISOString()
  if (
    receipt.evidenceDigest !== evidenceDigest ||
    receipt.evidenceLocator !== evidence.locator ||
    receipt.runtimeRevision !== evidence.runtimeRevision ||
    receipt.oldestObservationAt !== oldestObservationAt ||
    receipt.validUntil !== expectedValidUntil
  ) {
    return failExecutionBoundary()
  }
}

/**
 * Reads all six exact and distinct physical TableIds.
 *
 * @param value - Candidate fixed-role TableId record.
 * @returns Detached strict TableIds.
 */
function readTableIds(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  const record = requireRecord(value)
  requireExactKeys(record, tableRoles)
  const tableIds: WorkspaceSearchMigrationSealedPlanningTableIds = {
    'project-directory': readBoundedText(
      readOwn(record, 'project-directory'),
      maximumTableIdLength,
    ),
    'work-items': readBoundedText(
      readOwn(record, 'work-items'),
      maximumTableIdLength,
    ),
    collaboration: readBoundedText(
      readOwn(record, 'collaboration'),
      maximumTableIdLength,
    ),
    documents: readBoundedText(
      readOwn(record, 'documents'),
      maximumTableIdLength,
    ),
    'workspace-search': readBoundedText(
      readOwn(record, 'workspace-search'),
      maximumTableIdLength,
    ),
    'migration-state': readBoundedText(
      readOwn(record, 'migration-state'),
      maximumTableIdLength,
    ),
  }
  if (new Set(Object.values(tableIds)).size !== tableRoles.length) {
    return failExecutionBoundary()
  }
  return tableIds
}

/**
 * Compares all six fixed physical TableIds.
 *
 * @param left - First TableId record.
 * @param right - Second TableId record.
 * @returns Whether every fixed role is identical.
 */
function sameTableIds(
  left: WorkspaceSearchMigrationSealedPlanningTableIds,
  right: WorkspaceSearchMigrationSealedPlanningTableIds,
): boolean {
  return tableRoles.every((role) => left[role] === right[role])
}

/**
 * Reads one plain non-array, non-Proxy object.
 *
 * @param value - Candidate record.
 * @returns Object suitable for bounded reflection.
 */
function requireRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failExecutionBoundary()
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return failExecutionBoundary()
  }
  return value
}

/**
 * Requires exactly the declared enumerable own keys.
 *
 * @param value - Candidate object.
 * @param expected - Complete recognized keys.
 */
function requireExactKeys(
  value: object,
  expected: readonly string[],
): void {
  const keys = Reflect.ownKeys(value)
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key) => typeof key !== 'string')
  ) {
    return failExecutionBoundary()
  }
  const stringKeys = keys.filter(
    (key): key is string => typeof key === 'string',
  ).sort()
  if (
    stringKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failExecutionBoundary()
  }
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failExecutionBoundary()
    }
  }
}

/**
 * Reads one enumerable own data property without invoking accessors.
 *
 * @param value - Candidate object.
 * @param key - Required property name.
 * @returns Exact property value.
 */
function readOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failExecutionBoundary()
  }
  return descriptor.value
}

/**
 * Reads one strict bounded migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > maximumIdentifierLength) {
    return failExecutionBoundary()
  }
  try {
    return requireMigrationIdentifier(value, 'Migration identifier')
  } catch {
    return failExecutionBoundary()
  }
}

/**
 * Reads one nonblank bounded Unicode string.
 *
 * @param value - Candidate string.
 * @param maximumLength - Maximum UTF-16 code-unit length.
 * @returns Validated string.
 */
function readBoundedText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failExecutionBoundary()
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failExecutionBoundary()
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failExecutionBoundary()
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate number.
 * @returns Validated positive integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return failExecutionBoundary()
  }
  return value
}

/**
 * Encodes one validated boundary into bounded canonical UTF-8 bytes.
 *
 * @param value - Strict JSON-safe boundary.
 * @returns Exact canonical bytes.
 */
function encodeCanonical(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_BOUNDARY_MAX_BYTES
  ) {
    return failExecutionBoundary()
  }
  return bytes
}

/**
 * Copies one exact nonshared Uint8Array under a byte ceiling.
 *
 * @param value - Candidate byte view.
 * @param maximumBytes - Inclusive byte ceiling.
 * @returns Detached ordinary bytes.
 */
function copyBoundedBytes(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failExecutionBoundary()
  }
  const buffer = readIntrinsicUint8ArrayBuffer(value)
  const byteLength = readIntrinsicUint8ArrayByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength === 0 ||
    byteLength > maximumBytes
  ) {
    return failExecutionBoundary()
  }
  const copy = new Uint8Array(value)
  if (copy.byteLength !== byteLength) return failExecutionBoundary()
  return copy
}

/**
 * Reads a Uint8Array's intrinsic backing buffer.
 *
 * @param value - Non-Proxy Uint8Array.
 * @returns Intrinsic backing buffer.
 */
function readIntrinsicUint8ArrayBuffer(
  value: Uint8Array,
): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) return failExecutionBoundary()
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'buffer',
  )
  if (descriptor?.get === undefined) return failExecutionBoundary()
  const buffer: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    !nodeUtilTypes.isArrayBuffer(buffer) &&
    !nodeUtilTypes.isSharedArrayBuffer(buffer)
  ) {
    return failExecutionBoundary()
  }
  return buffer
}

/**
 * Reads a Uint8Array's intrinsic byte length.
 *
 * @param value - Non-Proxy Uint8Array.
 * @returns Intrinsic byte length.
 */
function readIntrinsicUint8ArrayByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) return failExecutionBoundary()
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
  )
  if (descriptor?.get === undefined) return failExecutionBoundary()
  const byteLength: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return failExecutionBoundary()
  }
  return byteLength
}

/**
 * Compares two exact byte sequences without coercion.
 *
 * @param left - First byte sequence.
 * @param right - Second byte sequence.
 * @returns Whether length and every byte are identical.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
}

/**
 * Runs one operation behind the stable redacted error boundary.
 *
 * @param operation - Validation or construction operation.
 * @returns Operation result.
 */
function atExecutionBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationExecutionBoundaryError()
  }
}

/**
 * Raises the stable execution-boundary failure.
 *
 * @returns Never returns.
 */
function failExecutionBoundary(): never {
  throw new WorkspaceSearchMigrationExecutionBoundaryError()
}
