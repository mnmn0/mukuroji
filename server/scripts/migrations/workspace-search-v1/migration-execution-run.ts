import { createHash } from 'node:crypto'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isCanonicalTimestamp,
  isHexDigest,
  MigrationDigestAccumulator,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationTableRole,
  type WorkspaceSearchPlanSeal,
  type WorkspaceSearchPlanSealReference,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  parseWorkspaceSearchPlanSeal,
  serializeWorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
} from './migration-artifacts'
import {
  parseWorkspaceSearchMigrationExecutionBoundary,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import type {
  WorkspaceSearchMigrationImmutableArtifactReference,
} from './migration-immutable-artifact-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningCurrentAuthority,
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchMigrationTraversal,
  createWorkspaceSearchMigrationRunState,
  validateWorkspaceSearchMaintenanceEvidenceReceipt,
  validateWorkspaceSearchMigrationLease,
  validateWorkspaceSearchMigrationRunState,
} from './migration-state-machine'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/**
 * Maximum canonical bytes accepted for one revision-one execution run.
 *
 * The bound leaves substantial room below DynamoDB's item ceiling for
 * adapter-owned key, discriminator, and condition attributes.
 */
export const WORKSPACE_SEARCH_MIGRATION_EXECUTION_RUN_MAX_BYTES =
  256 * 1024

const maximumTextLength = 1_024
const retentionDayMilliseconds = 24 * 60 * 60 * 1_000
const planSealRole = 'plan-seals'
const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
  ...workspaceSearchMigrationSourceNames,
  'workspace-search',
  'migration-state',
]

/**
 * Stable raw-value-free failure raised for an invalid execution run.
 */
export class WorkspaceSearchMigrationExecutionRunError extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_MIGRATION_EXECUTION_RUN'

  /** Creates one stable execution-run failure. */
  constructor() {
    super('INVALID_MIGRATION_EXECUTION_RUN')
    this.name = 'WorkspaceSearchMigrationExecutionRunError'
  }
}

/**
 * Exact current authority identity consumed by execution-run admission.
 */
export type WorkspaceSearchMigrationExecutionRunAuthorityBinding = {
  /** Lease owner condition-checked when the run is created. */
  readonly ownerId: string
  /** Lease takeover fence condition-checked when the run is created. */
  readonly fenceToken: number
  /** Current maintenance-evidence pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the exact immutable current maintenance receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Adapter-owned time at which this authority was strongly evaluated. */
  readonly evaluatedAt: string
}

/**
 * Immutable authority and artifact binding for one admitted execution run.
 */
export type WorkspaceSearchMigrationExecutionRunBinding = {
  /** Execution-run binding discriminator. */
  readonly kind: 'workspace-search-migration-execution-run-binding'
  /** Execution-run binding schema version. */
  readonly bindingVersion: 1
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
  /** Digest of the exact revision-two planning-admitted boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the exact closed application-writer fence row. */
  readonly closedWriterFenceRecordDigest: string
  /** Digest of the exact version-two sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Merkle root of the exact ordered operation plan. */
  readonly planDigest: string
  /** Exact number of operations in the sealed plan. */
  readonly planOperationCount: number
  /** Rich exact-version reference to the canonical plan seal. */
  readonly planSealReference:
    WorkspaceSearchMigrationImmutableArtifactReference
  /** Exact current authority consumed by the creation transaction. */
  readonly currentAuthority:
    WorkspaceSearchMigrationExecutionRunAuthorityBinding
  /** Canonical time at which post-close planning was admitted. */
  readonly planningAdmittedAt: string
  /** Canonical time at which the planning authority was sealed. */
  readonly sealedAt: string
  /** Adapter-owned canonical execution-run creation time. */
  readonly createdAt: string
  /** Digest of every preceding immutable binding field. */
  readonly bindingDigest: string
}

/**
 * Revision-one durable execution envelope containing an initial applying state.
 *
 * Version one deliberately accepts only the cursor-free initial state. A
 * later mutable-state codec must introduce an explicit lossless DynamoDB
 * AttributeValue encoding before scan cursors can be persisted in this form.
 */
export type WorkspaceSearchMigrationExecutionRun = {
  /** Execution-run envelope discriminator. */
  readonly kind: 'workspace-search-migration-execution-run'
  /** Execution-run envelope schema version. */
  readonly executionRunVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Initial optimistic-concurrency revision. */
  readonly revision: 1
  /** Initial state-machine status. */
  readonly status: 'applying'
  /** Immutable admission authority and artifact binding. */
  readonly binding: WorkspaceSearchMigrationExecutionRunBinding
  /** Exact validated revision-one state-machine value. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Digest of the complete canonical initial state. */
  readonly stateDigest: string
  /** Digest of every preceding envelope field. */
  readonly executionRunDigest: string
}

/**
 * Exact material required to admit one initial execution run.
 */
export type CreateWorkspaceSearchMigrationExecutionRunInput = {
  /** Exact revision-two planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact compact version-two sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact strict canonical plan seal referenced by the sealed authority. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Exact fresh current lease, pointer, and receipt authority. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned canonical creation and commit-evaluation time. */
  readonly createdAt: string
}

/**
 * Creates one immutable revision-one execution run from admitted planning.
 *
 * @param input - Exact boundary, sealed root, plan, configuration, and current authority.
 * @returns Detached canonical initial applying execution run.
 */
export function createWorkspaceSearchMigrationExecutionRun(
  input: CreateWorkspaceSearchMigrationExecutionRunInput,
): WorkspaceSearchMigrationExecutionRun {
  return atExecutionRunBoundary(() => {
    requireExactKeys(requireRecord(input), [
      'configuration',
      'configurationHash',
      'createdAt',
      'currentAuthority',
      'executionBoundary',
      'planSeal',
      'sealedPlanningAuthority',
    ])
    const executionBoundary =
      readPlanningAdmittedExecutionBoundary(input.executionBoundary)
    const sealedPlanningAuthority =
      readSealedPlanningAuthority(input.sealedPlanningAuthority)
    const planSeal = readPlanSeal(input.planSeal)
    const configuration =
      detachWorkspaceSearchMigrationPlanningConfiguration(
        input.configuration,
      )
    const configurationHash = readDigest(input.configurationHash)
    const currentAuthority = readPrePlanAuthority(
      input.currentAuthority,
    )
    const createdAt = readTimestamp(input.createdAt)
    const runId = executionBoundary.runId
    const tableIds = createTableIds(configuration)

    requireAdmissionCorrelation(
      runId,
      configuration,
      configurationHash,
      tableIds,
      executionBoundary,
      sealedPlanningAuthority,
      planSeal,
      currentAuthority,
      createdAt,
    )

    const legacyPlanSealReference: WorkspaceSearchPlanSealReference = {
      objectKey: sealedPlanningAuthority.planSealReference.objectKey,
      versionId: sealedPlanningAuthority.planSealReference.versionId,
      contentDigest:
        sealedPlanningAuthority.planSealReference.contentDigest,
    }
    const runState = createWorkspaceSearchMigrationRunState({
      runId,
      lease: currentAuthority.lease,
      ownerId: currentAuthority.lease.ownerId,
      configurationHash,
      configuration,
      maintenanceEvidenceReceipt:
        currentAuthority.maintenanceEvidenceReceipt,
      dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
      planDigest: planSeal.planDigest,
      planOperationCount: planSeal.planOperationCount,
      planSeal,
      planSealReference: legacyPlanSealReference,
      createdAt,
    })
    const bindingFields = {
      kind: 'workspace-search-migration-execution-run-binding',
      bindingVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId,
      configurationHash,
      tableIds,
      executionBoundaryDigest: executionBoundary.boundaryDigest,
      closedWriterFenceRecordDigest:
        executionBoundary.closedWriterFenceRecordDigest,
      sealedPlanningAuthorityDigest:
        sealedPlanningAuthority.authorityDigest,
      planDigest: planSeal.planDigest,
      planOperationCount: planSeal.planOperationCount,
      planSealReference: sealedPlanningAuthority.planSealReference,
      currentAuthority: createAuthorityBinding(currentAuthority),
      planningAdmittedAt:
        executionBoundary.planningAdmission.admittedAt,
      sealedAt: sealedPlanningAuthority.sealedAt,
      createdAt,
    } satisfies Omit<
      WorkspaceSearchMigrationExecutionRunBinding,
      'bindingDigest'
    >
    const binding = {
      ...bindingFields,
      bindingDigest: createMigrationDigest(bindingFields),
    }
    const stateDigest = createMigrationDigest(runState)
    const envelopeFields = {
      kind: 'workspace-search-migration-execution-run',
      executionRunVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId,
      configurationHash,
      revision: 1,
      status: 'applying',
      binding,
      runState,
      stateDigest,
    } satisfies Omit<
      WorkspaceSearchMigrationExecutionRun,
      'executionRunDigest'
    >
    const executionRun = {
      ...envelopeFields,
      executionRunDigest: createMigrationDigest(envelopeFields),
    }
    void encodeCanonicalExecutionRun(executionRun)
    return executionRun
  })
}

/**
 * Serializes one strict initial execution run as bounded canonical UTF-8 JSON.
 *
 * @param value - Candidate revision-one execution run.
 * @returns Exact canonical JSON bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationExecutionRun(
  value: WorkspaceSearchMigrationExecutionRun,
): Uint8Array {
  return atExecutionRunBoundary(() =>
    encodeCanonicalExecutionRun(readExecutionRun(value))
  )
}

/**
 * Parses one exact canonical initial execution-run document.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict revision-one applying execution run.
 */
export function parseWorkspaceSearchMigrationExecutionRun(
  bytes: Uint8Array,
): WorkspaceSearchMigrationExecutionRun {
  return atExecutionRunBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot)
    } catch {
      return failExecutionRun()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failExecutionRun()
    }
    const executionRun = readExecutionRun(parsed)
    const canonical = encodeCanonicalExecutionRun(executionRun)
    if (!equalBytes(snapshot, canonical)) return failExecutionRun()
    return executionRun
  })
}

/**
 * Detaches and validates one exact planning-admitted boundary.
 *
 * @param value - Candidate boundary.
 * @returns Strict canonical planning-admitted boundary.
 */
function readPlanningAdmittedExecutionBoundary(
  value: WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  const boundary = parseWorkspaceSearchMigrationExecutionBoundary(
    serializeWorkspaceSearchMigrationExecutionBoundary(value),
  )
  if (
    boundary.phase !== 'planning-admitted' ||
    boundary.revision !== 2
  ) {
    return failExecutionRun()
  }
  return boundary
}

/**
 * Detaches and validates one exact version-two sealed planning root.
 *
 * @param value - Candidate sealed root.
 * @returns Strict canonical version-two root.
 */
function readSealedPlanningAuthority(
  value: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(value),
  )
}

/**
 * Detaches and validates one strict canonical plan seal.
 *
 * @param value - Candidate plan seal.
 * @returns Strict canonical plan seal.
 */
function readPlanSeal(
  value: WorkspaceSearchPlanSeal,
): WorkspaceSearchPlanSeal {
  return parseWorkspaceSearchPlanSeal(
    serializeWorkspaceSearchPlanSeal(value),
  )
}

/**
 * Correlates every authority and artifact consumed by run admission.
 *
 * @param runId - Run selected by the planning-admitted boundary.
 * @param configuration - Exact detached measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - All six TableIds derived from the configuration.
 * @param boundary - Exact planning-admitted execution boundary.
 * @param sealedRoot - Exact sealed planning authority.
 * @param planSeal - Exact canonical plan seal.
 * @param currentAuthority - Fresh authority consumed at creation.
 * @param createdAt - Adapter-owned creation time.
 */
function requireAdmissionCorrelation(
  runId: string,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  boundary: WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
  sealedRoot: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  planSeal: WorkspaceSearchPlanSeal,
  currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  createdAt: string,
): void {
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash ||
    sealedRoot.runId !== runId ||
    planSeal.runId !== runId ||
    boundary.configurationHash !== configurationHash ||
    sealedRoot.configurationHash !== configurationHash ||
    planSeal.configurationHash !== configurationHash ||
    !sameTableIds(boundary.tableIds, tableIds) ||
    !sameTableIds(sealedRoot.tableIds, tableIds) ||
    currentAuthority.configurationHash !== configurationHash ||
    currentAuthority.stateTableId !== tableIds['migration-state'] ||
    currentAuthority.lease.runId !== runId ||
    currentAuthority.maintenanceEvidenceReceipt.runId !== runId
  ) {
    return failExecutionRun()
  }
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealReference = sealedRoot.planSealReference
  if (
    digestBytes(planSealBytes) !== planSealReference.contentDigest ||
    planSealBytes.byteLength !== planSealReference.byteLength ||
    planSeal.planDigest !== sealedRoot.planDigest ||
    planSeal.planOperationCount !== sealedRoot.planOperationCount ||
    planSeal.sourceOperationCount !== sealedRoot.sourceOperationCount ||
    planSeal.orphanOperationCount !== sealedRoot.orphanOperationCount ||
    planSeal.planningSnapshotDigest !==
      sealedRoot.planningSnapshotDigest
  ) {
    return failExecutionRun()
  }
  const admittedAt = Date.parse(
    boundary.planningAdmission.admittedAt,
  )
  const planCreatedAt = Date.parse(planSeal.createdAt)
  const sealedAt = Date.parse(sealedRoot.sealedAt)
  const evaluatedAt = Date.parse(currentAuthority.evaluatedAt)
  const creationTime = Date.parse(createdAt)
  if (
    admittedAt > planCreatedAt ||
    planCreatedAt > sealedAt ||
    sealedAt > evaluatedAt ||
    evaluatedAt > creationTime ||
    sealedAt > creationTime
  ) {
    return failExecutionRun()
  }
  requireExecutionRunRetentionHeadroom(
    configuration,
    planSealReference.retainUntil,
    createdAt,
  )
  requireAuthorityIsCurrentSuccessor(
    sealedRoot.currentAuthority,
    currentAuthority,
  )
}

/**
 * Requires one full measured retention interval after run admission.
 *
 * The immutable writer permits at most one additional retention day, so this
 * also bounds planning, sealing, and admission delay to that existing margin.
 *
 * @param configuration - Exact measured migration configuration.
 * @param retainUntil - Shared immutable graph retention deadline.
 * @param createdAt - Execution-run admission time.
 */
function requireExecutionRunRetentionHeadroom(
  configuration: WorkspaceSearchMigrationConfiguration,
  retainUntil: string,
  createdAt: string,
): void {
  const minimumRetentionMilliseconds =
    configuration.journal.defaultRetentionDays *
    retentionDayMilliseconds
  const retentionHeadroomMilliseconds =
    Date.parse(retainUntil) - Date.parse(createdAt)
  if (
    !Number.isSafeInteger(minimumRetentionMilliseconds) ||
    minimumRetentionMilliseconds <= 0 ||
    !Number.isSafeInteger(retentionHeadroomMilliseconds) ||
    retentionHeadroomMilliseconds < minimumRetentionMilliseconds
  ) {
    return failExecutionRun()
  }
}

/**
 * Rejects an authority older than the one committed into the sealed root.
 *
 * A higher takeover fence may select a different owner and a fresh pointer.
 * Within the same fence, owner and pointer progression remain monotonic.
 *
 * @param sealed - Authority committed by sealed planning.
 * @param current - Authority consumed by execution admission.
 */
function requireAuthorityIsCurrentSuccessor(
  sealed: WorkspaceSearchMigrationSealedPlanningCurrentAuthority,
  current: WorkspaceSearchMigrationPrePlanAuthority,
): void {
  const lease = current.lease
  if (lease.fenceToken > sealed.fenceToken) return
  if (
    lease.fenceToken !== sealed.fenceToken ||
    lease.ownerId !== sealed.ownerId ||
    current.maintenanceEvidencePointerRevision <
      sealed.maintenanceEvidencePointerRevision ||
    (
      current.maintenanceEvidencePointerRevision ===
        sealed.maintenanceEvidencePointerRevision &&
      current.maintenanceEvidenceReceiptDigest !==
        sealed.maintenanceEvidenceReceiptDigest
    )
  ) {
    return failExecutionRun()
  }
}

/**
 * Projects the current authority tuple fixed by execution admission.
 *
 * @param authority - Strict current pre-plan authority.
 * @returns Compact immutable execution-run authority binding.
 */
function createAuthorityBinding(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationExecutionRunAuthorityBinding {
  return {
    ownerId: authority.lease.ownerId,
    fenceToken: authority.lease.fenceToken,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
    evaluatedAt: authority.evaluatedAt,
  }
}

/**
 * Reads and validates one strict execution-run envelope.
 *
 * @param value - Candidate runtime or parsed execution run.
 * @returns Detached strict revision-one execution run.
 */
function readExecutionRun(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'binding',
    'configurationHash',
    'executionRunDigest',
    'executionRunVersion',
    'kind',
    'migrationId',
    'migrationVersion',
    'revision',
    'runId',
    'runState',
    'stateDigest',
    'status',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-execution-run' ||
    readOwn(record, 'executionRunVersion') !== 1 ||
    readOwn(record, 'migrationId') !== WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'revision') !== 1 ||
    readOwn(record, 'status') !== 'applying'
  ) {
    return failExecutionRun()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const binding = readBinding(readOwn(record, 'binding'))
  const runState = readInitialRunState(readOwn(record, 'runState'))
  const stateDigest = readDigest(readOwn(record, 'stateDigest'))
  if (
    binding.runId !== runId ||
    binding.configurationHash !== configurationHash ||
    runState.runId !== runId ||
    runState.configurationHash !== configurationHash ||
    runState.revision !== 1 ||
    runState.status !== 'applying' ||
    !sameTableIds(
      binding.tableIds,
      createTableIds(runState.configuration),
    ) ||
    binding.planDigest !== runState.planDigest ||
    binding.planOperationCount !== runState.planOperationCount ||
    binding.planSealReference.objectKey !==
      runState.planSealReference.objectKey ||
    binding.planSealReference.versionId !==
      runState.planSealReference.versionId ||
    binding.planSealReference.contentDigest !==
      runState.planSealReference.contentDigest ||
    binding.currentAuthority.fenceToken !==
      runState.maintenanceEvidenceReceipt.fenceToken ||
    binding.currentAuthority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(runState.maintenanceEvidenceReceipt) ||
    Date.parse(binding.currentAuthority.evaluatedAt) <
      Date.parse(
        runState.maintenanceEvidenceReceipt.validatedAt,
      ) ||
    binding.createdAt !== runState.createdAt ||
    binding.createdAt !== runState.updatedAt ||
    stateDigest !== createMigrationDigest(runState)
  ) {
    return failExecutionRun()
  }
  requireExecutionRunRetentionHeadroom(
    runState.configuration,
    binding.planSealReference.retainUntil,
    binding.createdAt,
  )
  const fields = {
    kind: 'workspace-search-migration-execution-run',
    executionRunVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    revision: 1,
    status: 'applying',
    binding,
    runState,
    stateDigest,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRun,
    'executionRunDigest'
  >
  const executionRunDigest = readDigest(
    readOwn(record, 'executionRunDigest'),
  )
  if (executionRunDigest !== createMigrationDigest(fields)) {
    return failExecutionRun()
  }
  return { ...fields, executionRunDigest }
}

/**
 * Reads and validates one immutable admission binding.
 *
 * @param value - Candidate binding.
 * @returns Detached strict binding.
 */
function readBinding(
  value: unknown,
): WorkspaceSearchMigrationExecutionRunBinding {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'bindingDigest',
    'bindingVersion',
    'closedWriterFenceRecordDigest',
    'configurationHash',
    'createdAt',
    'currentAuthority',
    'executionBoundaryDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'planDigest',
    'planOperationCount',
    'planSealReference',
    'planningAdmittedAt',
    'runId',
    'sealedAt',
    'sealedPlanningAuthorityDigest',
    'tableIds',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-execution-run-binding' ||
    readOwn(record, 'bindingVersion') !== 1 ||
    readOwn(record, 'migrationId') !== WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failExecutionRun()
  }
  const fields = {
    kind: 'workspace-search-migration-execution-run-binding',
    bindingVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    executionBoundaryDigest: readDigest(
      readOwn(record, 'executionBoundaryDigest'),
    ),
    closedWriterFenceRecordDigest: readDigest(
      readOwn(record, 'closedWriterFenceRecordDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    planOperationCount: readNonNegativeSafeInteger(
      readOwn(record, 'planOperationCount'),
    ),
    planSealReference: readRichPlanSealReference(
      readOwn(record, 'planSealReference'),
    ),
    currentAuthority: readAuthorityBinding(
      readOwn(record, 'currentAuthority'),
    ),
    planningAdmittedAt: readTimestamp(
      readOwn(record, 'planningAdmittedAt'),
    ),
    sealedAt: readTimestamp(readOwn(record, 'sealedAt')),
    createdAt: readTimestamp(readOwn(record, 'createdAt')),
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRunBinding,
    'bindingDigest'
  >
  if (
    Date.parse(fields.planningAdmittedAt) >
      Date.parse(fields.sealedAt) ||
    Date.parse(fields.sealedAt) >
      Date.parse(fields.currentAuthority.evaluatedAt) ||
    Date.parse(fields.currentAuthority.evaluatedAt) >
      Date.parse(fields.createdAt) ||
    Date.parse(fields.planSealReference.retainUntil) <=
      Date.parse(fields.createdAt)
  ) {
    return failExecutionRun()
  }
  const bindingDigest = readDigest(readOwn(record, 'bindingDigest'))
  if (bindingDigest !== createMigrationDigest(fields)) {
    return failExecutionRun()
  }
  return { ...fields, bindingDigest }
}

/**
 * Reads one compact execution-run authority identity.
 *
 * @param value - Candidate authority binding.
 * @returns Detached strict authority binding.
 */
function readAuthorityBinding(
  value: unknown,
): WorkspaceSearchMigrationExecutionRunAuthorityBinding {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'evaluatedAt',
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  return {
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    evaluatedAt: readTimestamp(readOwn(record, 'evaluatedAt')),
  }
}

/**
 * Reads one strict cursor-free initial run state.
 *
 * @param value - Candidate initial state.
 * @returns Detached validated revision-one applying state.
 */
function readInitialRunState(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'appliedOperationCount',
    'apply',
    'applyMarkerDigestState',
    'configuration',
    'configurationHash',
    'createdAt',
    'dryRunEvidenceDigest',
    'journalHeadDigest',
    'journalSequence',
    'maintenanceEvidenceDigest',
    'maintenanceEvidenceLocator',
    'maintenanceEvidenceReceipt',
    'planDigest',
    'planOperationCount',
    'planSealReference',
    'revision',
    'runId',
    'status',
    'updatedAt',
  ])
  if (
    readOwn(record, 'revision') !== 1 ||
    readOwn(record, 'status') !== 'applying' ||
    readOwn(record, 'appliedOperationCount') !== 0 ||
    readOwn(record, 'journalSequence') !== 0
  ) {
    return failExecutionRun()
  }
  const emptyMarkerState =
    new MigrationDigestAccumulator().exportState()
  const emptyTraversal =
    createEmptyWorkspaceSearchMigrationTraversal()
  requireExactJsonValue(
    readOwn(record, 'applyMarkerDigestState'),
    emptyMarkerState,
  )
  requireExactJsonValue(readOwn(record, 'apply'), emptyTraversal)
  const state: WorkspaceSearchMigrationRunState = {
    runId: readIdentifier(readOwn(record, 'runId')),
    revision: 1,
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    configuration:
      detachWorkspaceSearchMigrationPlanningConfiguration(
        readOwn(record, 'configuration'),
      ),
    maintenanceEvidenceDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceDigest'),
    ),
    maintenanceEvidenceLocator: readBoundedText(
      readOwn(record, 'maintenanceEvidenceLocator'),
    ),
    maintenanceEvidenceReceipt: readMaintenanceEvidenceReceipt(
      readOwn(record, 'maintenanceEvidenceReceipt'),
    ),
    dryRunEvidenceDigest: readDigest(
      readOwn(record, 'dryRunEvidenceDigest'),
    ),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    planOperationCount: readNonNegativeSafeInteger(
      readOwn(record, 'planOperationCount'),
    ),
    planSealReference: readLegacyPlanSealReference(
      readOwn(record, 'planSealReference'),
    ),
    status: 'applying',
    appliedOperationCount: 0,
    applyMarkerDigestState: emptyMarkerState,
    journalSequence: 0,
    journalHeadDigest: readDigest(
      readOwn(record, 'journalHeadDigest'),
    ),
    apply: emptyTraversal,
    createdAt: readTimestamp(readOwn(record, 'createdAt')),
    updatedAt: readTimestamp(readOwn(record, 'updatedAt')),
  }
  validateWorkspaceSearchMigrationRunState(state)
  return state
}

/**
 * Reads one strict current pre-plan authority aggregate.
 *
 * @param value - Candidate authority.
 * @returns Detached validated lease, pointer, receipt, and evaluation time.
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
  const lease = readLease(readOwn(record, 'lease'))
  const receipt = readMaintenanceEvidenceReceipt(
    readOwn(record, 'maintenanceEvidenceReceipt'),
  )
  const authority: WorkspaceSearchMigrationPrePlanAuthority = {
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    stateTableId: readBoundedText(readOwn(record, 'stateTableId')),
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
  validateWorkspaceSearchMigrationLease(lease)
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt,
    lease.runId,
    lease.fenceToken,
    authority.evaluatedAt,
  )
  if (
    receipt.runId !== lease.runId ||
    receipt.fenceToken !== lease.fenceToken ||
    authority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(receipt)
  ) {
    return failExecutionRun()
  }
  return authority
}

/**
 * Reads one strict fenced lease.
 *
 * @param value - Candidate lease.
 * @returns Detached lease.
 */
function readLease(value: unknown): WorkspaceSearchMigrationLease {
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
 * Reads one strict maintenance-evidence receipt.
 *
 * @param value - Candidate receipt.
 * @returns Detached receipt.
 */
function readMaintenanceEvidenceReceipt(
  value: unknown,
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
  return {
    runId: readIdentifier(readOwn(record, 'runId')),
    evidenceDigest: readDigest(readOwn(record, 'evidenceDigest')),
    evidenceLocator: readBoundedText(
      readOwn(record, 'evidenceLocator'),
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
}

/**
 * Reads one rich immutable plan-seal reference.
 *
 * @param value - Candidate rich reference.
 * @returns Detached strict reference.
 */
function readRichPlanSealReference(
  value: unknown,
): WorkspaceSearchMigrationImmutableArtifactReference {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const reference = {
    objectKey: readBoundedText(readOwn(record, 'objectKey')),
    versionId: readBoundedText(readOwn(record, 'versionId')),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
    byteLength: readPositiveSafeInteger(
      readOwn(record, 'byteLength'),
    ),
    retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
  }
  if (
    reference.versionId === 'null' ||
    reference.byteLength >
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES ||
    reference.objectKey !==
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/${planSealRole}/${reference.contentDigest}.artifact`
  ) {
    return failExecutionRun()
  }
  return reference
}

/**
 * Reads one legacy exact-version plan-seal reference.
 *
 * @param value - Candidate legacy reference.
 * @returns Detached strict reference.
 */
function readLegacyPlanSealReference(
  value: unknown,
): WorkspaceSearchPlanSealReference {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'contentDigest',
    'objectKey',
    'versionId',
  ])
  const reference = {
    objectKey: readBoundedText(readOwn(record, 'objectKey')),
    versionId: readBoundedText(readOwn(record, 'versionId')),
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
  }
  if (
    reference.versionId === 'null' ||
    reference.objectKey !==
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/${planSealRole}/${reference.contentDigest}.artifact`
  ) {
    return failExecutionRun()
  }
  return reference
}

/**
 * Creates all six exact TableIds from measured configuration.
 *
 * @param configuration - Strict measured migration configuration.
 * @returns Fixed-role physical table incarnations.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory': readTableId(
      configuration.tables['project-directory'],
    ),
    'work-items': readTableId(configuration.tables['work-items']),
    collaboration: readTableId(configuration.tables.collaboration),
    documents: readTableId(configuration.tables.documents),
    'workspace-search': readTableId(
      configuration.tables['workspace-search'],
    ),
    'migration-state': readTableId(
      configuration.tables['migration-state'],
    ),
  }
}

/**
 * Reads one bounded physical TableId.
 *
 * @param table - Strict measured table identity.
 * @returns Exact bounded TableId.
 */
function readTableId(table: MigrationTableIdentity): string {
  return readBoundedText(table.tableId)
}

/**
 * Reads one fixed-role TableId record.
 *
 * @param value - Candidate TableId record.
 * @returns Detached fixed-role TableIds.
 */
function readTableIds(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  const record = requireRecord(value)
  requireExactKeys(record, tableRoles)
  return {
    'project-directory': readBoundedText(
      readOwn(record, 'project-directory'),
    ),
    'work-items': readBoundedText(readOwn(record, 'work-items')),
    collaboration: readBoundedText(readOwn(record, 'collaboration')),
    documents: readBoundedText(readOwn(record, 'documents')),
    'workspace-search': readBoundedText(
      readOwn(record, 'workspace-search'),
    ),
    'migration-state': readBoundedText(
      readOwn(record, 'migration-state'),
    ),
  }
}

/**
 * Compares all six fixed-role physical table incarnations.
 *
 * @param left - First TableId record.
 * @param right - Second TableId record.
 * @returns Whether every role matches exactly.
 */
function sameTableIds(
  left: WorkspaceSearchMigrationSealedPlanningTableIds,
  right: WorkspaceSearchMigrationSealedPlanningTableIds,
): boolean {
  return tableRoles.every((role) => left[role] === right[role])
}

/**
 * Requires a candidate JSON graph to equal one canonical expected graph.
 *
 * @param actual - Candidate graph.
 * @param expected - Exact canonical expected graph.
 */
function requireExactJsonValue(
  actual: unknown,
  expected: unknown,
): void {
  if (
    expected === null ||
    typeof expected === 'boolean' ||
    typeof expected === 'number' ||
    typeof expected === 'string'
  ) {
    if (actual !== expected) return failExecutionRun()
    return
  }
  if (Array.isArray(expected)) {
    if (
      !Array.isArray(actual) ||
      !hasCanonicalDenseArrayShape(actual) ||
      actual.length !== expected.length
    ) {
      return failExecutionRun()
    }
    for (let index = 0; index < expected.length; index += 1) {
      requireExactJsonValue(actual[index], expected[index])
    }
    return
  }
  const expectedRecord = requireRecord(expected)
  const actualRecord = requireRecord(actual)
  const keys = Object.keys(expectedRecord)
  requireExactKeys(actualRecord, keys)
  for (const key of keys) {
    requireExactJsonValue(
      readOwn(actualRecord, key),
      readOwn(expectedRecord, key),
    )
  }
}

/**
 * Reads one plain record.
 *
 * @param value - Candidate value.
 * @returns Plain string-keyed record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failExecutionRun()
  return value
}

/**
 * Checks whether one value is a plain string-keyed record.
 *
 * @param value - Candidate value.
 * @returns Whether the candidate has a supported plain-record prototype.
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
 * Requires exactly the listed own enumerable data properties.
 *
 * @param record - Candidate record.
 * @param expected - Complete expected field names.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    return failExecutionRun()
  }
  for (const key of wanted) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      return failExecutionRun()
    }
  }
}

/**
 * Reads one own data property without invoking accessors.
 *
 * @param record - Validated record.
 * @param key - Exact property name.
 * @returns Own property value.
 */
function readOwn(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failExecutionRun()
  }
  return descriptor.value
}

/**
 * Reads one safe migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string') return failExecutionRun()
  requireMigrationIdentifier(value, 'Execution run identifier')
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failExecutionRun()
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failExecutionRun()
  return value
}

/**
 * Reads one bounded nonempty Unicode string.
 *
 * @param value - Candidate string.
 * @returns Validated string.
 */
function readBoundedText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumTextLength ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failExecutionRun()
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
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
    return failExecutionRun()
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
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    return failExecutionRun()
  }
  return value
}

/**
 * Encodes one validated execution run and enforces its byte ceiling.
 *
 * @param value - Validated execution run.
 * @returns Canonical bounded UTF-8 bytes.
 */
function encodeCanonicalExecutionRun(
  value: WorkspaceSearchMigrationExecutionRun,
): Uint8Array {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value))
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_RUN_MAX_BYTES
  ) {
    return failExecutionRun()
  }
  return bytes
}

/**
 * Copies untrusted input after enforcing its finite byte bound.
 *
 * @param bytes - Candidate input bytes.
 * @returns Detached bounded bytes.
 */
function copyBoundedBytes(bytes: Uint8Array): Uint8Array {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_RUN_MAX_BYTES
  ) {
    return failExecutionRun()
  }
  return new Uint8Array(bytes)
}

/**
 * Compares two byte arrays without converting untrusted data to text.
 *
 * @param left - First byte array.
 * @param right - Second byte array.
 * @returns Whether both arrays are byte-for-byte identical.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Digests exact immutable artifact bytes.
 *
 * @param bytes - Exact canonical artifact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Maps every implementation failure to the stable public boundary error.
 *
 * @param operation - Contract operation.
 * @returns Successful operation result.
 */
function atExecutionRunBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationExecutionRunError) {
      throw error
    }
    throw new WorkspaceSearchMigrationExecutionRunError()
  }
}

/**
 * Raises the only public execution-run validation failure.
 *
 * @returns Never returns.
 */
function failExecutionRun(): never {
  throw new WorkspaceSearchMigrationExecutionRunError()
}
