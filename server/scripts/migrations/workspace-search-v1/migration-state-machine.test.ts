import { describe, expect, test } from 'bun:test'
import {
  createTeamWorkspaceSearchDocument,
  createWorkItemWorkspaceSearchDocument,
  createWorkspaceSearchDocumentRecordKey,
  type WorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  decodeAttributeMapToNativeRecord,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createAbsentMigrationItemDigest,
} from './migration-journal'
import { mapWorkspaceSearchMigrationRow } from './migration-mapper'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  createWorkspaceSearchOperationId,
  type DynamoAttributeMap,
  MigrationDigestAccumulator,
  type EncodedMigrationItemSnapshot,
  type MigrationItemSnapshot,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchApplySealReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchOperationMarker,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchPlanSeal,
  type WorkspaceSearchPlanSealReference,
  type WorkspaceSearchRollbackReceipt,
  type WorkspaceSearchVerificationEvidence,
  type WorkspaceSearchVerificationEvidenceReference,
  workspaceSearchMigrationSourceNames,
  zeroHexDigest,
} from './migration-contract'
import { maintenanceRuntimeControlSurfaces } from './maintenance-evidence'
import {
  type AcquireWorkspaceSearchMigrationLeaseInput,
  type HeartbeatWorkspaceSearchMigrationLeaseInput,
  type PersistWorkspaceSearchMigrationRunInput,
  type WorkspaceSearchApplyOperationCommandEvent,
  type WorkspaceSearchMaintenanceEvidenceRenewalCommandEvent,
  type WorkspaceSearchMigrationCheckpointCommandInput,
  type WorkspaceSearchMigrationCommandInput,
  type WorkspaceSearchMigrationLeaseClaim,
  type WorkspaceSearchMigrationStateEvent,
  type WorkspaceSearchApplyOperationRecordedEvent,
  type WorkspaceSearchMaintenanceEvidenceRenewedEvent,
  createEmptyWorkspaceSearchMigrationCheckpoint,
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMaintenanceEvidenceReceipt,
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchMigrationRunState,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
  type WorkspaceSearchMigrationAuthority,
  type WorkspaceSearchMigrationStateMachinePort,
  type WorkspaceSearchMigrationTransitionInput,
  type WorkspaceSearchPlannedOperation,
  type WorkspaceSearchRollbackOperationRecordedEvent,
  type WorkspaceSearchRollbackOperationCommandEvent,
  type WorkspaceSearchVerificationStartedEvent,
  createWorkspaceSearchApplyOperationRecordedEvent,
  createWorkspaceSearchRollbackOperationRecordedEvent,
  reduceWorkspaceSearchMigrationRunState,
  validateWorkspaceSearchMigrationCheckpoint,
  validateWorkspaceSearchMigrationRunState,
  WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'

/** One-shot persistence race injected immediately before an atomic commit. */
type CommitFault =
  | 'expire-lease'
  | 'source-drift'
  | 'take-over-lease'
  | 'target-drift'
  | 'throw-after-commit'
  | 'throw-before-commit'

/** Secret-free error used to emulate an ambiguous adapter response. */
class TestAdapterFailure extends Error {
  /**
   * Creates a deterministic adapter failure.
   *
   * @param message - Test-only failure description.
   */
  constructor(message: string) {
    super(message)
    this.name = 'TestAdapterFailure'
  }
}

/**
 * Clones one test value without sharing mutable maps, byte arrays, or objects.
 *
 * @param value - Value to detach.
 * @returns Structurally independent clone.
 */
function cloneValue<Value>(value: Value): Value {
  return structuredClone(value)
}

/** Production-shaped primary keys indexed by migration table role. */
const migrationTableKeys: Record<
  MigrationTableIdentity['role'],
  MigrationTableIdentity['key']
> = {
  'project-directory': [
    { name: 'directoryId', role: 'HASH', type: 'S' },
    { name: 'entryKey', role: 'RANGE', type: 'S' },
  ],
  'work-items': [
    { name: 'directoryTeamId', role: 'HASH', type: 'S' },
    { name: 'issueId', role: 'RANGE', type: 'S' },
  ],
  collaboration: [
    { name: 'entityKey', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ],
  documents: [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ],
  'workspace-search': [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ],
  'migration-state': [
    { name: 'migrationId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ],
}

/**
 * Creates the exact table identity required by a migration configuration.
 *
 * @param role - Stable migration table role.
 * @returns Production-shaped table identity.
 */
function createTableIdentity(
  role: MigrationTableIdentity['role'],
): MigrationTableIdentity {
  return {
    role,
    tableName: `mukuroji-${role}`,
    tableArn: `arn:aws:dynamodb:ap-northeast-1:123456789012:table/mukuroji-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-07-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key: migrationTableKeys[role],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest(`kms:${role}`),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-25T03:59:00.000Z',
    },
  }
}

/**
 * Creates one complete measured configuration fixture.
 *
 * @returns Configuration accepted by the state-machine factory.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createTableIdentity('project-directory'),
      'work-items': createTableIdentity('work-items'),
      collaboration: createTableIdentity('collaboration'),
      documents: createTableIdentity('documents'),
      'workspace-search': createTableIdentity('workspace-search'),
      'migration-state': createTableIdentity('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates a valid active fenced lease.
 *
 * @param fenceToken - Monotonic test fence.
 * @param ownerId - Current lease owner.
 * @returns Active lease spanning all normal fixture transitions.
 */
function createLease(
  fenceToken = 1,
  ownerId = 'operator-one',
): WorkspaceSearchMigrationLease {
  return {
    runId: 'run-2026-07-25',
    ownerId,
    fenceToken,
    heartbeatAt: '2026-07-25T04:00:00.000Z',
    expiresAt: '2026-07-25T04:01:00.000Z',
  }
}

/**
 * Serializes complete disabled-surface evidence as exact untrusted bytes.
 *
 * @param drainStartedAt - Beginning of the zero-writer drain interval.
 * @param drainCompletedAt - End of the zero-writer drain interval.
 * @param observedAt - Current disabled observation time for every surface.
 * @param locator - Secret-free external change-record locator.
 * @returns Exact UTF-8 JSON bytes accepted by the strict parser.
 */
function createMaintenanceEvidenceBytes(
  drainStartedAt = '2026-07-25T03:40:50.000Z',
  drainCompletedAt = '2026-07-25T03:55:50.000Z',
  observedAt = '2026-07-25T03:55:50.000Z',
  locator = 'change:OPS-2026',
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    locator,
    runtimeMode: 'disabled',
    runtimeRevision: 42,
    drainStartedAt,
    drainCompletedAt,
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: 42,
      observedAt,
    })),
  }))
}

/**
 * Creates fresh evidence from exact bytes already bound to one lease fence.
 *
 * @param lease - Lease whose fence owns the receipt.
 * @returns Receipt fresh through normal fixture transitions.
 */
function createEvidenceReceipt(
  lease: WorkspaceSearchMigrationLease,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return createWorkspaceSearchMaintenanceEvidenceReceipt({
    runId: lease.runId,
    lease,
    evidenceBytes: createMaintenanceEvidenceBytes(),
    validatedAt: '2026-07-25T04:00:01.000Z',
  })
}

/**
 * Creates one immutable plan seal and its exact reference.
 *
 * @param runId - Run owning the plan.
 * @param configurationHash - Reviewed configuration digest.
 * @param dryRunEvidenceDigest - Exact reviewed dry-run evidence digest.
 * @param planDigest - Exact Merkle root.
 * @param planOperationCount - Exact leaf count.
 * @returns Canonical plan seal and reference.
 */
function createPlanSeal(
  runId: string,
  configurationHash: string,
  dryRunEvidenceDigest: string,
  planDigest: string,
  planOperationCount: number,
): {
  /** Canonical immutable plan seal. */
  seal: WorkspaceSearchPlanSeal
  /** Exact immutable plan-seal reference. */
  reference: WorkspaceSearchPlanSealReference
} {
  const seal: WorkspaceSearchPlanSeal = {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    runId,
    configurationHash,
    dryRunEvidenceDigest,
    planningSnapshotDigest: createMigrationDigest('planning-snapshot'),
    planDigest,
    planOperationCount,
    sourceOperationCount: planOperationCount,
    orphanOperationCount: 0,
    createdAt: '2026-07-25T04:00:00.000Z',
  }
  return {
    seal,
    reference: {
      objectKey: `workspace-search/v1/${runId}/plan-seal.json`,
      versionId: 'plan-seal-version',
      contentDigest: createMigrationDigest(seal),
    },
  }
}

/**
 * Encodes a native item snapshot for an immutable journal segment.
 *
 * @param snapshot - Exact native target state.
 * @returns Lossless JSON-safe snapshot.
 */
function encodeSnapshot(
  snapshot: MigrationItemSnapshot,
): EncodedMigrationItemSnapshot {
  if (!snapshot.exists) {
    return {
      exists: false,
      digest: snapshot.digest,
    }
  }
  return {
    exists: true,
    item: encodeAttributeMap(snapshot.item),
    digest: snapshot.digest,
  }
}

/**
 * Encodes the compact canonical document fixture as low-level attributes.
 *
 * @param document - Server-normalized search projection.
 * @returns Exact canonical DynamoDB item.
 */
function encodeSearchDocument(
  document: WorkspaceSearchDocument,
): DynamoAttributeMap {
  return {
    schemaVersion: { N: String(document.schemaVersion) },
    projectionDigest: { S: document.projectionDigest },
    workspaceId: { S: document.workspaceId },
    recordKey: { S: document.recordKey },
    entryType: { S: document.entryType },
    entityType: { S: document.entityType },
    entityId: { S: document.entityId },
    title: { S: document.title },
    ...(document.subtitle === undefined
      ? {}
      : { subtitle: { S: document.subtitle } }),
    url: { S: document.url },
    ...(document.sourceRevision === undefined
      ? {}
      : { sourceRevision: { N: String(document.sourceRevision) } }),
    ...(document.teamId === undefined
      ? {}
      : { teamId: { S: document.teamId } }),
  }
}

/**
 * Creates one immutable plan entry with exact source and target conditions.
 *
 * @param configuration - Measured run configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param planSequence - Stable one-based plan position.
 * @param noOp - Whether before and after are exactly equal.
 * @returns Exact operation before plan membership is attached.
 */
function createOperation(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  planSequence: number,
  noOp = false,
): WorkspaceSearchMigrationOperation {
  const suffix = `${planSequence}`
  const teamId = `team-${suffix}`
  const sourceKey = {
    directoryId: { S: 'workspace-1' },
    entryKey: {
      S: `${String(planSequence).padStart(6, '0')}#000000#TEAM#${teamId}`,
    },
  }
  const sourceItem = {
    ...sourceKey,
    entryType: { S: 'team' },
    teamId: { S: teamId },
    teamSortOrder: { N: suffix },
    nameJa: { S: '' },
    nameEn: { S: `After ${suffix}` },
  }
  const targetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: {
      S: createWorkspaceSearchDocumentRecordKey(
        'team',
        `team/${teamId}`,
      ),
    },
  }
  const afterDocument = createTeamWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId,
    title: `After ${suffix}`,
  })
  const beforeDocument = noOp
    ? afterDocument
    : createTeamWorkspaceSearchDocument({
        workspaceId: 'workspace-1',
        teamId,
        title: `Before ${suffix}`,
      })
  const beforeItem = encodeSearchDocument(beforeDocument)
  const afterItem = encodeSearchDocument(afterDocument)
  const sourceKeyDigest = createAttributeMapDigest(sourceKey)
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const operation: WorkspaceSearchMigrationOperation = {
    operationId: createWorkspaceSearchOperationId({
      configurationHash,
      sourceTableId:
        configuration.tables['project-directory'].tableId,
      sourceKeyDigest,
      targetKeyDigest,
    }),
    sourceCondition: {
      exists: true,
      source: 'project-directory',
      tableId: configuration.tables['project-directory'].tableId,
      tableName: configuration.tables['project-directory'].tableName,
      key: sourceKey,
      keyDigest: sourceKeyDigest,
      item: sourceItem,
      itemDigest: createAttributeMapDigest(sourceItem),
    },
    targetKey,
    targetKeyDigest,
    before: {
      exists: true,
      item: beforeItem,
      digest: createAttributeMapDigest(beforeItem),
    },
    after: {
      exists: true,
      item: afterItem,
      digest: createAttributeMapDigest(afterItem),
    },
    entityType: 'team',
  }
  return operation
}

/**
 * Creates a revision-one state and one- or two-leaf reviewed plan fixture.
 *
 * @param noOps - Per-plan-position no-op selection.
 * @returns State, exact plan entries, and immutable plan seal.
 */
function createRunFixture(
  noOps: readonly boolean[],
): {
  /** Valid revision-one applying state. */
  state: WorkspaceSearchMigrationRunState
  /** Exact immutable plan rows in stable order. */
  plans: readonly WorkspaceSearchPlannedOperation[]
  /** Canonical reviewed plan seal. */
  planSeal: WorkspaceSearchPlanSeal
  /** Exact immutable plan-seal reference. */
  planSealReference: WorkspaceSearchPlanSealReference
} {
  if (noOps.length > 2) {
    throw new TestAdapterFailure('The compact fixture supports at most two leaves.')
  }
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const operations = noOps.map((noOp, index) =>
    createOperation(configuration, configurationHash, index + 1, noOp)
  )
  const operationDigests = operations.map((operation) =>
    createWorkspaceSearchMigrationOperationDigest(operation)
  )
  const leaves = operationDigests.map((operationDigest, index) =>
    createWorkspaceSearchPlanLeafDigest({
      planSequence: index + 1,
      operationDigest,
    })
  )
  let planDigest = createEmptyWorkspaceSearchPlanDigest()
  if (leaves.length === 1) {
    planDigest = leaves[0] ?? planDigest
  } else if (leaves.length === 2) {
    planDigest = createWorkspaceSearchPlanNodeDigest(
      leaves[0] ?? zeroHexDigest(),
      leaves[1] ?? zeroHexDigest(),
    )
  }
  const planEvidence = createPlanSeal(
    'run-2026-07-25',
    configurationHash,
    createMigrationDigest('dry-run-evidence'),
    planDigest,
    noOps.length,
  )
  const lease = createLease()
  const state = createWorkspaceSearchMigrationRunState({
    runId: lease.runId,
    lease,
    ownerId: lease.ownerId,
    configuration,
    configurationHash,
    maintenanceEvidenceReceipt: createEvidenceReceipt(lease),
    dryRunEvidenceDigest: planEvidence.seal.dryRunEvidenceDigest,
    planDigest,
    planOperationCount: noOps.length,
    planSeal: planEvidence.seal,
    planSealReference: planEvidence.reference,
    createdAt: '2026-07-25T04:00:01.000Z',
  })
  const plans = operations.map((operation, index) => {
    const sibling = leaves[index === 0 ? 1 : 0]
    return {
      runId: state.runId,
      configurationHash,
      planDigest,
      planSequence: index + 1,
      operationDigest: operationDigests[index] ?? zeroHexDigest(),
      membershipProof: sibling === undefined
        ? []
        : [{
            side: index === 0 ? 'right' : 'left',
            digest: sibling,
          }],
      operation,
    } satisfies WorkspaceSearchPlannedOperation
  })
  return {
    state,
    plans,
    planSeal: planEvidence.seal,
    planSealReference: planEvidence.reference,
  }
}

/**
 * Creates an adapter-bound initial-run request without caller-owned state.
 *
 * @param fixture - Canonical expected state and immutable plan evidence.
 * @param lease - Exact active lease claim.
 * @param maintenanceEvidenceBytes - Exact untrusted evidence file bytes.
 * @returns Initial persistence command reconstructed inside the adapter.
 */
function createPersistRunInput(
  fixture: ReturnType<typeof createRunFixture>,
  lease: WorkspaceSearchMigrationLeaseClaim,
  maintenanceEvidenceBytes = createMaintenanceEvidenceBytes(),
): PersistWorkspaceSearchMigrationRunInput {
  return {
    runId: fixture.state.runId,
    lease,
    configurationHash: fixture.state.configurationHash,
    configuration: fixture.state.configuration,
    maintenanceEvidenceBytes,
    dryRunEvidenceDigest: fixture.state.dryRunEvidenceDigest,
    planDigest: fixture.state.planDigest,
    planOperationCount: fixture.state.planOperationCount,
    planSeal: fixture.planSeal,
    planSealReference: fixture.planSealReference,
  }
}

/**
 * Creates a caller command without predicting adapter authority or timestamps.
 *
 * @param state - Current run before the operation commits.
 * @param plannedOperation - Exact sealed plan entry.
 * @param preparedAt - Time at which immutable journal bytes were uploaded.
 * @returns Apply command and optional journal evidence that must be durable first.
 */
function createApplyCommand(
  state: WorkspaceSearchMigrationRunState,
  plannedOperation: WorkspaceSearchPlannedOperation,
  preparedAt: string,
): WorkspaceSearchApplyOperationCommandEvent {
  const operation = plannedOperation.operation
  if (operation.before.digest === operation.after.digest) {
    return {
      kind: 'apply-operation-requested',
      plannedOperation,
    }
  }

  const sequence = state.journalSequence + 1
  const segment: WorkspaceSearchJournalSegment = {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    runId: state.runId,
    configurationHash: state.configurationHash,
    sequence,
    preparedFenceToken: state.maintenanceEvidenceReceipt.fenceToken,
    operationId: operation.operationId,
    sourceDigest: operation.sourceCondition.exists
      ? operation.sourceCondition.itemDigest
      : undefined,
    previousHeadDigest: state.journalHeadDigest,
    targetKey: encodeAttributeMap(operation.targetKey),
    targetKeyDigest: operation.targetKeyDigest,
    before: encodeSnapshot(operation.before),
    after: encodeSnapshot(operation.after),
    createdAt: preparedAt,
  }
  const contentDigest = createMigrationDigest(segment)
  const versionId = `journal-version-${sequence}`
  return {
    kind: 'apply-operation-requested',
    plannedOperation,
    journal: {
      segment,
      reference: {
        objectKey:
          `workspace-search/v1/${state.runId}/segments/` +
          `${String(sequence).padStart(12, '0')}.json`,
        versionId,
        contentDigest,
        headDigest: createJournalHeadDigest({
          previousHeadDigest: state.journalHeadDigest,
          sequence,
          operationId: operation.operationId,
          contentDigest,
          versionId,
        }),
      },
    },
  }
}

/**
 * Creates an immutable apply seal and its exact external reference.
 *
 * @param state - State whose apply chain is sealed.
 * @param scope - Complete plan or committed prefix.
 * @param createdAt - Canonical seal time.
 * @returns Seal document and matching immutable reference.
 */
function createApplySeal(
  state: WorkspaceSearchMigrationRunState,
  scope: WorkspaceSearchApplySeal['scope'],
  createdAt: string,
): {
  /** Canonical immutable seal. */
  seal: WorkspaceSearchApplySeal
  /** Exact immutable object reference. */
  reference: WorkspaceSearchApplySealReference
} {
  const markerDigest = MigrationDigestAccumulator.fromState(
    state.applyMarkerDigestState,
  ).digest()
  const seal: WorkspaceSearchApplySeal = {
    kind: 'workspace-search-apply-seal',
    sealVersion: 1,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    runId: state.runId,
    configurationHash: state.configurationHash,
    scope,
    planDigest: state.planDigest,
    planOperationCount: state.planOperationCount,
    journalSequence: state.journalSequence,
    journalHeadDigest: state.journalHeadDigest,
    markerCount: state.appliedOperationCount,
    applyMarkerAggregateDigest: markerDigest,
    createdAt,
  }
  return {
    seal,
    reference: {
      scope,
      objectKey: `workspace-search/v1/${state.runId}/${scope}-seal.json`,
      versionId: `${scope}-seal-version`,
      contentDigest: createMigrationDigest(seal),
    },
  }
}

/**
 * Decodes one journal snapshot back to the exact native target representation.
 *
 * @param snapshot - Losslessly encoded snapshot.
 * @returns Exact native snapshot.
 */
function decodeSnapshot(
  snapshot: EncodedMigrationItemSnapshot,
): MigrationItemSnapshot {
  if (!snapshot.exists) {
    return {
      exists: false,
      digest: snapshot.digest,
    }
  }
  return {
    exists: true,
    item: decodeAttributeMap(snapshot.item),
    digest: snapshot.digest,
  }
}

/**
 * Condition-aware in-memory implementation of the state-machine persistence port.
 *
 * The fake evaluates all durable conditions before cloning any transactional
 * writes. It intentionally exposes seed and fault controls only to tests.
 */
class InMemoryMigrationStateMachinePort
implements WorkspaceSearchMigrationStateMachinePort {
  /** Current durable fenced lease. */
  private lease: WorkspaceSearchMigrationLease | undefined
  /** Current durable run row. */
  private state: WorkspaceSearchMigrationRunState | undefined
  /** Immutable plan entries keyed by one-based sequence. */
  private readonly plans = new Map<number, WorkspaceSearchPlannedOperation>()
  /** Immutable plan seals keyed by exact content digest. */
  private readonly planSeals = new Map<string, WorkspaceSearchPlanSeal>()
  /** Immutable maintenance receipts keyed by exact receipt digest. */
  private readonly maintenanceReceipts =
    new Map<string, WorkspaceSearchMaintenanceEvidenceReceipt>()
  /** Immutable verification evidence keyed by exact content digest. */
  private readonly verificationEvidence =
    new Map<string, WorkspaceSearchVerificationEvidence>()
  /** Immutable apply seals keyed by exact content digest. */
  private readonly applySeals = new Map<string, WorkspaceSearchApplySeal>()
  /** Exact source snapshots keyed by source family and key digest. */
  private readonly sources = new Map<string, MigrationItemSnapshot>()
  /** Exact target snapshots keyed by target-key digest. */
  private targets = new Map<string, MigrationItemSnapshot>()
  /** Durable apply markers keyed by stable operation ID. */
  private markers = new Map<string, WorkspaceSearchOperationMarker>()
  /** Durable mutation receipts keyed by journal sequence. */
  private applyReceipts = new Map<number, WorkspaceSearchOperationReceipt>()
  /** Durable rollback receipts keyed by journal sequence. */
  private rollbackReceipts = new Map<number, WorkspaceSearchRollbackReceipt>()
  /** Immutable journal segments keyed by exact content digest. */
  private readonly journal = new Map<string, WorkspaceSearchJournalSegment>()
  /** One-shot failure consumed by the next commit operation. */
  private fault: CommitFault | undefined
  /** Adapter-owned trusted clock captured immediately before each commit. */
  private clock = '2026-07-25T04:00:01.000Z'

  /**
   * Seeds one exact active lease.
   *
   * @param lease - Lease to persist.
   */
  seedLease(lease: WorkspaceSearchMigrationLease): void {
    this.lease = cloneValue(lease)
  }

  /**
   * Seeds one immutable plan row and its planned source/target states.
   *
   * @param planned - Exact plan entry.
   */
  seedPlan(planned: WorkspaceSearchPlannedOperation): void {
    this.plans.set(planned.planSequence, cloneValue(planned))
    const source = planned.operation.sourceCondition
    const sourceKey = this.sourceMapKey(source.source, source.keyDigest)
    if (source.exists) {
      this.sources.set(sourceKey, {
        exists: true,
        item: cloneValue(source.item),
        digest: source.itemDigest,
      })
    } else {
      this.sources.delete(sourceKey)
    }
    this.writeTargetSnapshot(
      this.targets,
      planned.operation.targetKeyDigest,
      planned.operation.before,
    )
  }

  /**
   * Seeds the exact immutable plan-seal object version.
   *
   * @param seal - Canonical reviewed plan seal.
   */
  seedPlanSeal(seal: WorkspaceSearchPlanSeal): void {
    this.planSeals.set(createMigrationDigest(seal), cloneValue(seal))
  }

  /**
   * Stores immutable verification evidence before its state transition.
   *
   * @param evidence - Canonical complete verification evidence.
   */
  persistVerificationEvidence(
    evidence: WorkspaceSearchVerificationEvidence,
  ): void {
    this.verificationEvidence.set(
      createMigrationDigest(evidence),
      cloneValue(evidence),
    )
  }

  /**
   * Stores an immutable apply seal before its state transition.
   *
   * @param seal - Canonical complete-plan or committed-prefix seal.
   */
  persistApplySeal(seal: WorkspaceSearchApplySeal): void {
    this.applySeals.set(createMigrationDigest(seal), cloneValue(seal))
  }

  /**
   * Stores an immutable segment before a mutating transaction.
   *
   * @param segment - Exact preimage segment.
   */
  persistJournalSegment(segment: WorkspaceSearchJournalSegment): void {
    this.journal.set(createMigrationDigest(segment), cloneValue(segment))
  }

  /**
   * Arms one one-shot commit fault.
   *
   * @param fault - Race or response failure to inject.
   */
  injectFault(fault: CommitFault): void {
    this.fault = fault
  }

  /**
   * Advances the adapter-owned trusted clock.
   *
   * @param at - Canonical time captured by the next adapter operation.
   */
  setClock(at: string): void {
    this.clock = at
  }

  /**
   * Returns the exact current lease identity without exposing adapter time.
   *
   * @returns Current lease claim.
   */
  currentLeaseClaim(): WorkspaceSearchMigrationLeaseClaim {
    if (!this.lease) {
      throw new TestAdapterFailure('No lease was seeded.')
    }
    return {
      runId: this.lease.runId,
      ownerId: this.lease.ownerId,
      fenceToken: this.lease.fenceToken,
    }
  }

  /**
   * Reads an exact target snapshot for assertions.
   *
   * @param targetKeyDigest - Stable target-key digest.
   * @returns Current exact present or absent state.
   */
  readTargetSnapshot(targetKeyDigest: string): MigrationItemSnapshot {
    const snapshot = this.targets.get(targetKeyDigest)
    return snapshot
      ? cloneValue(snapshot)
      : {
          exists: false,
          digest: createAbsentMigrationItemDigest(),
        }
  }

  /**
   * Restores an exact target snapshot after a deliberately injected drift.
   *
   * @param targetKeyDigest - Stable target-key digest.
   * @param snapshot - Exact target state to seed.
   */
  seedTargetSnapshot(
    targetKeyDigest: string,
    snapshot: MigrationItemSnapshot,
  ): void {
    this.writeTargetSnapshot(this.targets, targetKeyDigest, snapshot)
  }

  /**
   * Acquires an absent lease or takes over an expired lease.
   *
   * @param input - Requested owner and exclusive window.
   * @returns Newly durable fenced lease.
   */
  acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    const current = this.lease
    if (
      current &&
      Date.parse(this.clock) < Date.parse(current.expiresAt)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'LEASE_CONFLICT',
        'The migration lease is still active.',
      )
    }
    const lease: WorkspaceSearchMigrationLease = {
      runId: input.runId,
      ownerId: input.ownerId,
      fenceToken: (current?.fenceToken ?? 0) + 1,
      heartbeatAt: this.clock,
      expiresAt: new Date(
        Date.parse(this.clock) +
          WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
      ).toISOString(),
    }
    this.lease = cloneValue(lease)
    return Promise.resolve(cloneValue(lease))
  }

  /**
   * Extends only the exact current active lease.
   *
   * @param input - Exact lease and requested heartbeat.
   * @returns Extended durable lease.
   */
  heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    const authority = this.createAuthorityFromClaim(input.lease)
    this.requireExactLease(authority)
    if (!this.lease) throw new TestAdapterFailure('Expected a durable lease.')
    const next: WorkspaceSearchMigrationLease = {
      ...this.lease,
      heartbeatAt: this.clock,
      expiresAt: new Date(
        Date.parse(this.clock) +
          WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
      ).toISOString(),
    }
    this.lease = cloneValue(next)
    return Promise.resolve(cloneValue(next))
  }

  /**
   * Strongly reads one run.
   *
   * @param runId - Expected run identifier.
   * @returns Detached current state, when present.
   */
  readRunState(
    runId: string,
  ): Promise<WorkspaceSearchMigrationRunState | undefined> {
    if (!this.state || this.state.runId !== runId) {
      return Promise.resolve(undefined)
    }
    return Promise.resolve(cloneValue(this.state))
  }

  /**
   * Strongly reads one immutable maintenance evidence receipt.
   *
   * @param runId - Receipt owner.
   * @param receiptDigest - Digest of the exact receipt.
   * @returns Exact historical receipt, when present.
   */
  readMaintenanceEvidenceReceipt(
    runId: string,
    receiptDigest: string,
  ): Promise<WorkspaceSearchMaintenanceEvidenceReceipt | undefined> {
    const receipt = this.maintenanceReceipts.get(receiptDigest)
    if (!receipt || receipt.runId !== runId) return Promise.resolve(undefined)
    return Promise.resolve(cloneValue(receipt))
  }

  /**
   * Parses exact evidence bytes and creates an absent run under live authority.
   *
   * @param input - Sealed plan, exact evidence bytes, and authority claim.
   * @returns Canonical durable initial state.
   */
  createRunState(
    input: PersistWorkspaceSearchMigrationRunInput,
  ): Promise<WorkspaceSearchMigrationRunState> {
    if (this.state) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The migration run already exists.',
      )
    }
    const authority = this.createAuthorityFromClaim(input.lease)
    this.requireExactLease(authority)
    const planSeal = this.planSeals.get(
      input.planSealReference.contentDigest,
    )
    if (
      !planSeal ||
      createMigrationDigest(planSeal) !==
        input.planSealReference.contentDigest ||
      createMigrationDigest(planSeal) !== createMigrationDigest(input.planSeal)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The immutable reviewed plan seal is missing.',
      )
    }
    const maintenanceEvidenceReceipt =
      createWorkspaceSearchMaintenanceEvidenceReceipt({
        runId: input.runId,
        lease: authority.lease,
        evidenceBytes: input.maintenanceEvidenceBytes,
        validatedAt: authority.at,
      })
    const state = createWorkspaceSearchMigrationRunState({
      runId: input.runId,
      lease: authority.lease,
      ownerId: authority.ownerId,
      configurationHash: input.configurationHash,
      configuration: input.configuration,
      maintenanceEvidenceReceipt,
      dryRunEvidenceDigest: input.dryRunEvidenceDigest,
      planDigest: input.planDigest,
      planOperationCount: input.planOperationCount,
      planSeal: input.planSeal,
      planSealReference: input.planSealReference,
      createdAt: authority.at,
    })
    this.state = cloneValue(state)
    this.maintenanceReceipts.set(
      createMigrationDigest(maintenanceEvidenceReceipt),
      cloneValue(maintenanceEvidenceReceipt),
    )
    return Promise.resolve(cloneValue(state))
  }

  /**
   * Reads one exact immutable plan-seal object version.
   *
   * @param reference - Exact immutable plan-seal reference.
   * @returns Canonical reviewed plan seal.
   */
  readPlanSeal(
    reference: WorkspaceSearchPlanSealReference,
  ): Promise<WorkspaceSearchPlanSeal> {
    const seal = this.planSeals.get(reference.contentDigest)
    if (!seal) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The immutable plan seal is missing.',
      )
    }
    return Promise.resolve(cloneValue(seal))
  }

  /**
   * Reads one exact immutable verification-evidence object version.
   *
   * @param reference - Exact immutable verification reference.
   * @returns Canonical full verification evidence.
   */
  readVerificationEvidence(
    reference: WorkspaceSearchVerificationEvidenceReference,
  ): Promise<WorkspaceSearchVerificationEvidence> {
    const evidence = this.verificationEvidence.get(reference.contentDigest)
    if (!evidence) {
      throw new WorkspaceSearchMigrationFailure(
        'VERIFY_FAILED',
        'The immutable verification evidence is missing.',
      )
    }
    return Promise.resolve(cloneValue(evidence))
  }

  /**
   * Strongly reads one immutable plan row.
   *
   * @param runId - Plan owner.
   * @param planSequence - One-based plan position.
   * @returns Exact planned operation, when present.
   */
  readPlannedOperation(
    runId: string,
    planSequence: number,
  ): Promise<WorkspaceSearchPlannedOperation | undefined> {
    const planned = this.plans.get(planSequence)
    if (!planned || planned.runId !== runId) return Promise.resolve(undefined)
    return Promise.resolve(cloneValue(planned))
  }

  /**
   * Strongly reads one durable apply marker.
   *
   * @param runId - Marker owner.
   * @param operationId - Stable operation ID.
   * @returns Exact marker, when present.
   */
  readOperationMarker(
    runId: string,
    operationId: string,
  ): Promise<WorkspaceSearchOperationMarker | undefined> {
    const marker = this.markers.get(operationId)
    if (!marker || marker.runId !== runId) return Promise.resolve(undefined)
    return Promise.resolve(cloneValue(marker))
  }

  /**
   * Strongly reads one forward apply receipt.
   *
   * @param runId - Receipt owner.
   * @param sequence - Journal sequence.
   * @returns Exact receipt, when present.
   */
  readApplyReceipt(
    runId: string,
    sequence: number,
  ): Promise<WorkspaceSearchOperationReceipt | undefined> {
    const receipt = this.applyReceipts.get(sequence)
    if (!receipt || receipt.runId !== runId) return Promise.resolve(undefined)
    return Promise.resolve(cloneValue(receipt))
  }

  /**
   * Strongly reads one reverse receipt.
   *
   * @param runId - Receipt owner.
   * @param sequence - Reversed journal sequence.
   * @returns Exact receipt, when present.
   */
  readRollbackReceipt(
    runId: string,
    sequence: number,
  ): Promise<WorkspaceSearchRollbackReceipt | undefined> {
    const receipt = this.rollbackReceipts.get(sequence)
    if (!receipt || receipt.runId !== runId) return Promise.resolve(undefined)
    return Promise.resolve(cloneValue(receipt))
  }

  /**
   * Commits one apply marker and optional exact target mutation atomically.
   *
   * @param input - Fenced apply transition.
   * @returns Next durable run state.
   */
  commitApplyOperation(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchApplyOperationCommandEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState> {
    const current = this.requireCurrentState(input.expectedRevision)
    const authority = this.createAuthorityFromClaim(input.lease)
    const event = createWorkspaceSearchApplyOperationRecordedEvent(
      current,
      authority,
      input.event,
    )
    const transition: WorkspaceSearchMigrationTransitionInput<
      WorkspaceSearchApplyOperationRecordedEvent
    > = {
      current,
      expectedRevision: input.expectedRevision,
      authority,
      event,
    }
    const fault = this.consumeFaultBeforeConditions(
      transition.authority,
      input.event.plannedOperation.operation,
    )
    if (fault === 'throw-before-commit') {
      throw new TestAdapterFailure('Failure before apply commit.')
    }
    this.requireTransitionAuthority(transition, true)
    this.requireExactPlan(input.event.plannedOperation)
    this.requireExactSource(input.event.plannedOperation.operation)
    this.requireExactTarget(
      input.event.plannedOperation.operation.before,
      input.event.plannedOperation.operation.targetKeyDigest,
      'TARGET_DRIFT',
    )
    if (this.markers.has(event.marker.operationId)) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The apply marker already exists.',
      )
    }
    if (event.marker.kind === 'workspace-search-operation-applied') {
      const segment = event.journalSegment
      if (
        !segment ||
        !this.journal.has(event.marker.journal.contentDigest)
      ) {
        throw new WorkspaceSearchMigrationFailure(
          'INVALID_JOURNAL',
          'The immutable journal segment is not durable.',
        )
      }
    }

    const nextState = reduceWorkspaceSearchMigrationRunState(transition)
    const nextTargets = this.cloneSnapshotMap(this.targets)
    const nextMarkers = new Map(this.markers)
    const nextApplyReceipts = new Map(this.applyReceipts)
    this.writeTargetSnapshot(
      nextTargets,
      input.event.plannedOperation.operation.targetKeyDigest,
      input.event.plannedOperation.operation.after,
    )
    nextMarkers.set(
      event.marker.operationId,
      cloneValue(event.marker),
    )
    if (event.marker.kind === 'workspace-search-operation-applied') {
      nextApplyReceipts.set(
        event.marker.sequence,
        cloneValue(event.marker),
      )
    }
    this.targets = nextTargets
    this.markers = nextMarkers
    this.applyReceipts = nextApplyReceipts
    this.state = cloneValue(nextState)
    if (fault === 'throw-after-commit') {
      return Promise.reject(
        new TestAdapterFailure('Failure after apply commit.'),
      )
    }
    return Promise.resolve(cloneValue(nextState))
  }

  /**
   * Saves one condition-checked apply checkpoint.
   *
   * @param input - Exact checkpoint transition.
   * @returns Next durable state.
   */
  saveApplyCheckpoint(
    input: WorkspaceSearchMigrationCheckpointCommandInput,
  ): Promise<WorkspaceSearchMigrationRunState> {
    const current = this.requireCurrentState(input.expectedRevision)
    return this.commitStateOnly({
      expectedRevision: input.expectedRevision,
      lease: input.lease,
      event: {
        kind: 'apply-checkpoint-recorded',
        location: input.location,
        checkpoint: this.createObservedCheckpoint(current, input.location),
      },
    }, true)
  }

  /**
   * Renews evidence while only lease authority is required.
   *
   * @param input - Evidence renewal transition.
   * @returns Next durable state.
   */
  renewMaintenanceEvidence(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchMaintenanceEvidenceRenewalCommandEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState> {
    const current = this.requireCurrentState(input.expectedRevision)
    const authority = this.createAuthorityFromClaim(input.lease)
    const receipt = createWorkspaceSearchMaintenanceEvidenceReceipt({
      runId: current.runId,
      lease: authority.lease,
      evidenceBytes: input.event.evidenceBytes,
      validatedAt: authority.at,
    })
    const transition: WorkspaceSearchMigrationTransitionInput<
      WorkspaceSearchMaintenanceEvidenceRenewedEvent
    > = {
      current,
      expectedRevision: input.expectedRevision,
      authority,
      event: {
        kind: 'maintenance-evidence-renewed',
        receipt,
      },
    }
    this.requireTransitionAuthority(transition, false)
    const next = reduceWorkspaceSearchMigrationRunState(transition)
    this.maintenanceReceipts.set(
      createMigrationDigest(receipt),
      cloneValue(receipt),
    )
    this.state = cloneValue(next)
    return Promise.resolve(cloneValue(next))
  }

  /**
   * Seals a completely applied plan.
   *
   * @param input - Apply-seal transition.
   * @returns Next durable state.
   */
  sealApply(
    input: Parameters<
      WorkspaceSearchMigrationStateMachinePort['sealApply']
    >[0],
  ): Promise<WorkspaceSearchMigrationRunState> {
    this.requireDurableApplySeal(
      input.event.seal,
      input.event.reference,
    )
    return this.commitStateOnly(input, true)
  }

  /**
   * Starts independent verification.
   *
   * @param input - Verification-start transition.
   * @returns Next durable state.
   */
  beginVerification(
    input: Parameters<
      WorkspaceSearchMigrationStateMachinePort['beginVerification']
    >[0],
  ): Promise<WorkspaceSearchMigrationRunState> {
    return this.commitStateOnly(input, true)
  }

  /**
   * Saves one independent verification checkpoint.
   *
   * @param input - Verification checkpoint transition.
   * @returns Next durable state.
   */
  saveVerificationCheckpoint(
    input: WorkspaceSearchMigrationCheckpointCommandInput,
  ): Promise<WorkspaceSearchMigrationRunState> {
    const current = this.requireCurrentState(input.expectedRevision)
    return this.commitStateOnly({
      expectedRevision: input.expectedRevision,
      lease: input.lease,
      event: {
        kind: 'verification-checkpoint-recorded',
        location: input.location,
        checkpoint: this.createObservedCheckpoint(current, input.location),
      },
    }, true)
  }

  /**
   * Records complete independent verification evidence.
   *
   * @param input - Verification-pass transition.
   * @returns Next durable state.
   */
  completeVerification(
    input: Parameters<
      WorkspaceSearchMigrationStateMachinePort['completeVerification']
    >[0],
  ): Promise<WorkspaceSearchMigrationRunState> {
    const durable = this.verificationEvidence.get(
      input.event.reference.contentDigest,
    )
    if (
      !durable ||
      createMigrationDigest(durable) !== createMigrationDigest(input.event.evidence)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'VERIFY_FAILED',
        'The immutable verification evidence is missing.',
      )
    }
    return this.commitStateOnly(input, true)
  }

  /**
   * Starts reverse rollback from a complete or partial seal.
   *
   * @param input - Rollback-start transition.
   * @returns Next durable state.
   */
  beginRollback(
    input: Parameters<
      WorkspaceSearchMigrationStateMachinePort['beginRollback']
    >[0],
  ): Promise<WorkspaceSearchMigrationRunState> {
    this.requireDurableApplySeal(
      input.event.seal,
      input.event.reference,
    )
    return this.commitStateOnly(input, true)
  }

  /**
   * Restores one exact preimage and reverse marker atomically.
   *
   * @param input - Fenced reverse transition.
   * @returns Next durable state.
   */
  commitRollbackOperation(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchRollbackOperationCommandEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState> {
    const current = this.requireCurrentState(input.expectedRevision)
    const authority = this.createAuthorityFromClaim(input.lease)
    const event = createWorkspaceSearchRollbackOperationRecordedEvent(
      current,
      authority,
      input.event,
    )
    const transition: WorkspaceSearchMigrationTransitionInput<
      WorkspaceSearchRollbackOperationRecordedEvent
    > = {
      current,
      expectedRevision: input.expectedRevision,
      authority,
      event,
    }
    const fault = this.consumeFaultBeforeConditions(
      transition.authority,
      undefined,
      input.event.journalSegment.after,
      input.event.journalSegment.targetKeyDigest,
    )
    if (fault === 'throw-before-commit') {
      throw new TestAdapterFailure('Failure before rollback commit.')
    }
    this.requireTransitionAuthority(transition, true)
    const durableApply = this.applyReceipts.get(input.event.applyReceipt.sequence)
    const durableJournal = this.journal.get(
      input.event.applyReceipt.journal.contentDigest,
    )
    if (
      !durableApply ||
      createMigrationDigest(durableApply) !==
        createMigrationDigest(input.event.applyReceipt) ||
      !durableJournal ||
      createMigrationDigest(durableJournal) !==
        createMigrationDigest(input.event.journalSegment)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_JOURNAL',
        'Rollback evidence differs from durable apply evidence.',
      )
    }
    this.requireExactTarget(
      decodeSnapshot(input.event.journalSegment.after),
      input.event.journalSegment.targetKeyDigest,
      'ROLLBACK_TARGET_DRIFT',
    )
    if (this.rollbackReceipts.has(event.receipt.sequence)) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The rollback receipt already exists.',
      )
    }

    const nextState = reduceWorkspaceSearchMigrationRunState(transition)
    const nextTargets = this.cloneSnapshotMap(this.targets)
    const nextReceipts = new Map(this.rollbackReceipts)
    this.writeTargetSnapshot(
      nextTargets,
      input.event.journalSegment.targetKeyDigest,
      decodeSnapshot(input.event.journalSegment.before),
    )
    nextReceipts.set(
      event.receipt.sequence,
      cloneValue(event.receipt),
    )
    this.targets = nextTargets
    this.rollbackReceipts = nextReceipts
    this.state = cloneValue(nextState)
    if (fault === 'throw-after-commit') {
      return Promise.reject(
        new TestAdapterFailure('Failure after rollback commit.'),
      )
    }
    return Promise.resolve(cloneValue(nextState))
  }

  /**
   * Marks rollback complete at the zero journal root.
   *
   * @param input - Rollback-finish transition.
   * @returns Terminal durable state.
   */
  finishRollback(
    input: Parameters<
      WorkspaceSearchMigrationStateMachinePort['finishRollback']
    >[0],
  ): Promise<WorkspaceSearchMigrationRunState> {
    return this.commitStateOnly(input, true)
  }

  /**
   * Persists one state-only optimistic transition.
   *
   * @param input - Exact transition.
   * @param requireFreshEvidence - Whether maintenance freshness is required.
   * @returns Next detached durable state.
   */
  private commitStateOnly<
    Event extends Exclude<
      WorkspaceSearchMigrationStateEvent,
      WorkspaceSearchMaintenanceEvidenceRenewedEvent
    >,
  >(
    input: Pick<
      WorkspaceSearchMigrationCommandInput,
      'expectedRevision' | 'lease'
    > & { event: Event },
    requireFreshEvidence: boolean,
  ): Promise<WorkspaceSearchMigrationRunState> {
    const transition = this.createTransition(input)
    this.requireTransitionAuthority(transition, requireFreshEvidence)
    const next = reduceWorkspaceSearchMigrationRunState(transition)
    this.state = cloneValue(next)
    return Promise.resolve(cloneValue(next))
  }

  /**
   * Adds the adapter-owned trusted clock to one caller command.
   *
   * @param input - Command carrying no caller-controlled commit time.
   * @returns Pure reducer transition captured immediately before conditions.
   */
  private createTransition<
    Event extends Exclude<
      WorkspaceSearchMigrationStateEvent,
      WorkspaceSearchMaintenanceEvidenceRenewedEvent
    >,
  >(
    input: Pick<
      WorkspaceSearchMigrationCommandInput,
      'expectedRevision' | 'lease'
    > & { event: Event },
  ): WorkspaceSearchMigrationTransitionInput<Event> {
    return {
      current: this.requireCurrentState(input.expectedRevision),
      expectedRevision: input.expectedRevision,
      authority: this.createAuthorityFromClaim(input.lease),
      event: input.event,
    }
  }

  /**
   * Strongly reads the exact durable state for one optimistic command.
   *
   * @param expectedRevision - Revision the caller observed before the command.
   * @returns Detached durable state at that exact revision.
   */
  private requireCurrentState(
    expectedRevision: number,
  ): WorkspaceSearchMigrationRunState {
    if (!this.state || this.state.revision !== expectedRevision) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The durable run revision changed.',
      )
    }
    return cloneValue(this.state)
  }

  /**
   * Resolves one exact lease claim against the adapter-owned clock.
   *
   * @param claim - Caller-observed durable lease identity.
   * @returns Exact durable lease and trusted commit time.
   */
  private createAuthorityFromClaim(
    claim: WorkspaceSearchMigrationLeaseClaim,
  ): WorkspaceSearchMigrationAuthority {
    if (!this.lease) {
      throw new WorkspaceSearchMigrationFailure(
        'LEASE_LOST',
        'The durable lease is missing.',
      )
    }
    return {
      lease: {
        ...cloneValue(this.lease),
        runId: claim.runId,
        ownerId: claim.ownerId,
        fenceToken: claim.fenceToken,
      },
      ownerId: claim.ownerId,
      at: this.clock,
    }
  }

  /**
   * Validates stored revision, lease, and optionally fresh evidence.
   *
   * @param input - Candidate optimistic transition.
   * @param requireFreshEvidence - Whether the receipt must still be current.
   */
  private requireTransitionAuthority(
    input: WorkspaceSearchMigrationTransitionInput,
    requireFreshEvidence: boolean,
  ): void {
    if (
      !this.state ||
      this.state.runId !== input.current.runId ||
      this.state.revision !== input.expectedRevision ||
      input.current.revision !== input.expectedRevision ||
      createMigrationDigest(this.state) !== createMigrationDigest(input.current)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The durable run state changed.',
      )
    }
    this.requireExactLease(input.authority)
    if (
      createMigrationDigest(this.state.maintenanceEvidenceReceipt) !==
      createMigrationDigest(input.current.maintenanceEvidenceReceipt)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_MAINTENANCE_EVIDENCE',
        'The durable evidence receipt changed.',
      )
    }
    if (
      requireFreshEvidence &&
      (
        Date.parse(input.authority.at) <
          Date.parse(this.state.maintenanceEvidenceReceipt.validatedAt) ||
        Date.parse(this.state.maintenanceEvidenceReceipt.validUntil) -
          Date.parse(input.authority.at) <
            WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
      )
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_MAINTENANCE_EVIDENCE',
        'The durable evidence receipt is stale.',
      )
    }
  }

  /**
   * Validates the exact durable lease tuple and exclusive expiry.
   *
   * @param authority - Caller-observed authority.
   */
  private requireExactLease(
    authority: WorkspaceSearchMigrationAuthority,
  ): void {
    const lease = this.lease
    if (
      !lease ||
      lease.runId !== authority.lease.runId ||
      lease.ownerId !== authority.ownerId ||
      lease.ownerId !== authority.lease.ownerId ||
      lease.fenceToken !== authority.lease.fenceToken ||
      lease.heartbeatAt !== authority.lease.heartbeatAt ||
      lease.expiresAt !== authority.lease.expiresAt ||
      Date.parse(authority.at) < Date.parse(lease.heartbeatAt) ||
      Date.parse(lease.expiresAt) - Date.parse(authority.at) <
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'LEASE_LOST',
        'The exact durable lease is no longer active.',
      )
    }
  }

  /**
   * Requires one supplied apply seal to match durable immutable bytes.
   *
   * @param seal - Candidate canonical seal.
   * @param reference - Exact external object version.
   */
  private requireDurableApplySeal(
    seal: WorkspaceSearchApplySeal,
    reference: WorkspaceSearchApplySealReference,
  ): void {
    const durable = this.applySeals.get(reference.contentDigest)
    if (
      !durable ||
      createMigrationDigest(durable) !== createMigrationDigest(seal)
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The immutable apply seal is missing.',
      )
    }
  }

  /**
   * Validates exact sealed-plan membership.
   *
   * @param planned - Candidate plan row.
   */
  private requireExactPlan(planned: WorkspaceSearchPlannedOperation): void {
    const durable = this.plans.get(planned.planSequence)
    if (
      !durable ||
      durable.runId !== planned.runId ||
      durable.planDigest !== planned.planDigest ||
      durable.operationDigest !== planned.operationDigest
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The sealed plan entry changed.',
      )
    }
  }

  /**
   * Validates the live source against its exact planned condition.
   *
   * @param operation - Operation owning the source CAS.
   */
  private requireExactSource(
    operation: WorkspaceSearchMigrationOperation,
  ): void {
    const source = operation.sourceCondition
    const durable = this.sources.get(
      this.sourceMapKey(source.source, source.keyDigest),
    )
    const expectedDigest = source.exists
      ? source.itemDigest
      : createAbsentMigrationItemDigest()
    const durableDigest = durable?.digest ?? createAbsentMigrationItemDigest()
    if (durableDigest !== expectedDigest) {
      throw new WorkspaceSearchMigrationFailure(
        'SOURCE_DRIFT',
        'The exact planned source state changed.',
      )
    }
  }

  /**
   * Validates one live target snapshot against an exact expected state.
   *
   * @param expected - Expected present or absent target.
   * @param targetKeyDigest - Stable target map key.
   * @param code - Apply or rollback drift classification.
   */
  private requireExactTarget(
    expected: MigrationItemSnapshot,
    targetKeyDigest: string,
    code: 'ROLLBACK_TARGET_DRIFT' | 'TARGET_DRIFT',
  ): void {
    const durable = this.targets.get(targetKeyDigest)
    const durableDigest = durable?.digest ?? createAbsentMigrationItemDigest()
    if (durableDigest !== expected.digest) {
      throw new WorkspaceSearchMigrationFailure(
        code,
        'The exact planned target state changed.',
      )
    }
  }

  /**
   * Applies and consumes a one-shot race before persistence conditions execute.
   *
   * @param authority - Authority supplying the commit time.
   * @param operation - Apply operation, when committing forward.
   * @param rollbackAfter - Expected post-apply snapshot, when reversing.
   * @param rollbackTargetKeyDigest - Reverse target key.
   * @returns Consumed fault.
   */
  private consumeFaultBeforeConditions(
    authority: WorkspaceSearchMigrationAuthority,
    operation?: WorkspaceSearchMigrationOperation,
    rollbackAfter?: EncodedMigrationItemSnapshot,
    rollbackTargetKeyDigest?: string,
  ): CommitFault | undefined {
    const fault = this.fault
    this.fault = undefined
    if (fault === 'expire-lease' && this.lease) {
      this.lease = {
        ...this.lease,
        expiresAt: authority.at,
      }
    } else if (fault === 'take-over-lease' && this.lease) {
      this.lease = {
        ...this.lease,
        ownerId: 'operator-takeover',
        fenceToken: this.lease.fenceToken + 1,
        heartbeatAt: authority.at,
        expiresAt: new Date(
          Date.parse(authority.at) +
            WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
        ).toISOString(),
      }
    } else if (fault === 'source-drift' && operation) {
      const source = operation.sourceCondition
      const driftedItem = { drifted: { S: 'source' } }
      this.sources.set(
        this.sourceMapKey(source.source, source.keyDigest),
        {
          exists: true,
          item: driftedItem,
          digest: createAttributeMapDigest(driftedItem),
        },
      )
    } else if (fault === 'target-drift') {
      const key = operation?.targetKeyDigest ?? rollbackTargetKeyDigest
      const expected = operation?.before ??
        (rollbackAfter ? decodeSnapshot(rollbackAfter) : undefined)
      if (key && expected) {
        const item: DynamoAttributeMap = expected.exists
          ? Object.assign({}, expected.item, {
              drifted: { S: 'target' },
            })
          : {
              workspaceId: { S: 'workspace-1' },
              recordKey: { S: 'DOCUMENT#work-item#drifted' },
            }
        this.targets.set(key, {
          exists: true,
          item,
          digest: createAttributeMapDigest(item),
        })
      }
    }
    return fault
  }

  /**
   * Derives one completed checkpoint from adapter-owned in-memory table rows.
   *
   * @param state - Exact durable state whose next page is scanned.
   * @param location - Source or target table selected by the command.
   * @returns Complete one-page checkpoint bound to every observed row digest.
   */
  private createObservedCheckpoint(
    state: WorkspaceSearchMigrationRunState,
    location: WorkspaceSearchMigrationCheckpointCommandInput['location'],
  ): MigrationSourceCheckpoint {
    const traversal = state.status === 'verifying'
      ? state.verification
      : state.apply
    if (!traversal) {
      throw new TestAdapterFailure('Expected scan traversal state.')
    }
    const previous = location === 'target'
      ? traversal.target
      : traversal.sources[location]
    if (
      previous.completed ||
      previous.aggregate.pageCount !== 0 ||
      previous.cursor !== undefined
    ) {
      throw new WorkspaceSearchMigrationFailure(
        'INVALID_STATE',
        'The compact adapter already consumed this table scan.',
      )
    }

    const keyAccumulator = MigrationDigestAccumulator.fromState(
      previous.keyDigestState,
    )
    const contentAccumulator = MigrationDigestAccumulator.fromState(
      previous.contentDigestState,
    )
    const aggregate = { ...previous.aggregate, pageCount: 1 }

    if (location === 'target') {
      for (const [targetKeyDigest, snapshot] of this.targets) {
        keyAccumulator.add(targetKeyDigest)
        contentAccumulator.add(snapshot.digest)
        aggregate.scanned += 1
        aggregate.mapped += 1
        aggregate.projected += 1
      }
    } else {
      const prefix = `${location}:`
      for (const [storageKey, snapshot] of this.sources) {
        if (!storageKey.startsWith(prefix) || !snapshot.exists) continue
        keyAccumulator.add(storageKey.slice(prefix.length))
        contentAccumulator.add(snapshot.digest)
        aggregate.scanned += 1
        try {
          const mapped = mapWorkspaceSearchMigrationRow(
            location,
            decodeAttributeMapToNativeRecord(snapshot.item),
          )
          if (mapped.classification === 'mapped') {
            aggregate.mapped += 1
            if (mapped.operation.action === 'put') {
              aggregate.projected += 1
            } else {
              aggregate.deleted += 1
            }
          } else if (mapped.classification === 'ignored') {
            aggregate.ignored += 1
          } else {
            aggregate.invalid += 1
          }
        } catch {
          aggregate.invalid += 1
        }
      }
    }

    aggregate.keyDigest = keyAccumulator.digest()
    aggregate.contentDigest = contentAccumulator.digest()
    return {
      completed: true,
      aggregate,
      keyDigestState: keyAccumulator.exportState(),
      contentDigestState: contentAccumulator.exportState(),
    }
  }

  /**
   * Creates a detached snapshot map for an atomic transaction candidate.
   *
   * @param source - Current snapshot map.
   * @returns Fully detached candidate map.
   */
  private cloneSnapshotMap(
    source: ReadonlyMap<string, MigrationItemSnapshot>,
  ): Map<string, MigrationItemSnapshot> {
    const clone = new Map<string, MigrationItemSnapshot>()
    for (const [key, snapshot] of source) {
      clone.set(key, cloneValue(snapshot))
    }
    return clone
  }

  /**
   * Writes one present or absent snapshot into a candidate map.
   *
   * @param map - Transaction candidate target map.
   * @param key - Target-key digest.
   * @param snapshot - Exact next state.
   */
  private writeTargetSnapshot(
    map: Map<string, MigrationItemSnapshot>,
    key: string,
    snapshot: MigrationItemSnapshot,
  ): void {
    if (snapshot.exists) {
      map.set(key, cloneValue(snapshot))
    } else {
      map.delete(key)
    }
  }

  /**
   * Creates the test storage key for one source condition.
   *
   * @param source - Source family.
   * @param keyDigest - Exact source key digest.
   * @returns Collision-free map key.
   */
  private sourceMapKey(
    source: WorkspaceSearchMigrationSourceName,
    keyDigest: string,
  ): string {
    return `${source}:${keyDigest}`
  }
}

/**
 * Creates a durable run fixture with its lease, plan seal, and plan rows.
 *
 * @param noOps - Per-plan-position no-op selection.
 * @returns Condition-aware port and detached fixture evidence.
 */
async function createPersistedRun(
  noOps: readonly boolean[],
): Promise<{
  /** Condition-aware persistence fake. */
  port: InMemoryMigrationStateMachinePort
  /** Current revision-one run state. */
  state: WorkspaceSearchMigrationRunState
  /** Exact immutable plan rows. */
  plans: readonly WorkspaceSearchPlannedOperation[]
  /** Canonical immutable plan seal. */
  planSeal: WorkspaceSearchPlanSeal
  /** Exact immutable plan reference. */
  planSealReference: WorkspaceSearchPlanSealReference
}> {
  const fixture = createRunFixture(noOps)
  const port = new InMemoryMigrationStateMachinePort()
  port.seedLease(createLease())
  port.seedPlanSeal(fixture.planSeal)
  for (const planned of fixture.plans) port.seedPlan(planned)
  port.setClock(fixture.state.createdAt)
  const state = await port.createRunState(createPersistRunInput(
    fixture,
    port.currentLeaseClaim(),
  ))
  if (
    createMigrationDigest(state) !== createMigrationDigest(fixture.state)
  ) {
    throw new TestAdapterFailure(
      'Adapter-owned run creation differs from the canonical fixture.',
    )
  }
  return {
    port,
    state,
    plans: fixture.plans,
    planSeal: fixture.planSeal,
    planSealReference: fixture.planSealReference,
  }
}

/**
 * Completes every clean apply checkpoint through the persistence port.
 *
 * @param port - Condition-aware persistence fake.
 * @param initial - State before checkpoint completion.
 * @param at - Trusted commit time.
 * @returns State with a complete clean apply traversal.
 */
async function completeApplyTraversal(
  port: InMemoryMigrationStateMachinePort,
  initial: WorkspaceSearchMigrationRunState,
  at: string,
): Promise<WorkspaceSearchMigrationRunState> {
  let state = initial
  const locations: readonly (
    | WorkspaceSearchMigrationSourceName
    | 'target'
  )[] = [...workspaceSearchMigrationSourceNames, 'target']
  for (const location of locations) {
    port.setClock(at)
    state = await port.saveApplyCheckpoint({
      expectedRevision: state.revision,
      lease: port.currentLeaseClaim(),
      location,
    })
  }
  return state
}

/**
 * Completes every clean independent verification checkpoint.
 *
 * @param port - Condition-aware persistence fake.
 * @param initial - Verifying state.
 * @param at - Trusted commit time.
 * @returns State with complete verification traversal.
 */
async function completeVerificationTraversal(
  port: InMemoryMigrationStateMachinePort,
  initial: WorkspaceSearchMigrationRunState,
  at: string,
): Promise<WorkspaceSearchMigrationRunState> {
  let state = initial
  const locations: readonly (
    | WorkspaceSearchMigrationSourceName
    | 'target'
  )[] = [...workspaceSearchMigrationSourceNames, 'target']
  for (const location of locations) {
    port.setClock(at)
    state = await port.saveVerificationCheckpoint({
      expectedRevision: state.revision,
      lease: port.currentLeaseClaim(),
      location,
    })
  }
  return state
}

/**
 * Commits one planned apply operation, persisting its journal first when needed.
 *
 * @param port - Condition-aware persistence fake.
 * @param state - Current applying state.
 * @param planned - Exact immutable plan entry.
 * @param at - Trusted commit time.
 * @param preparedAt - Earlier caller-controlled journal preparation time.
 * @returns Next durable run state and exact event evidence.
 */
async function commitPlannedOperation(
  port: InMemoryMigrationStateMachinePort,
  state: WorkspaceSearchMigrationRunState,
  planned: WorkspaceSearchPlannedOperation,
  at: string,
  preparedAt = at,
): Promise<{
  /** Next durable run state. */
  state: WorkspaceSearchMigrationRunState
  /** Exact committed apply event. */
  event: WorkspaceSearchApplyOperationRecordedEvent
}> {
  const command = createApplyCommand(state, planned, preparedAt)
  if (command.journal) {
    port.persistJournalSegment(command.journal.segment)
  }
  port.setClock(at)
  const next = await port.commitApplyOperation({
    expectedRevision: state.revision,
    lease: port.currentLeaseClaim(),
    event: command,
  })
  const marker = await port.readOperationMarker(
    state.runId,
    planned.operation.operationId,
  )
  if (!marker) {
    throw new TestAdapterFailure('Expected durable apply marker.')
  }
  const event: WorkspaceSearchApplyOperationRecordedEvent = {
    kind: 'apply-operation-recorded',
    plannedOperation: planned,
    marker,
    ...(command.journal === undefined
      ? {}
      : { journalSegment: command.journal.segment }),
  }
  return { state: next, event }
}

/**
 * Creates a caller rollback command without predicting a reverse receipt.
 *
 * @param applyReceipt - Durable forward mutation receipt.
 * @param journalSegment - Exact immutable preimage bytes.
 * @returns Caller payload whose receipt is built by the adapter.
 */
function createRollbackCommand(
  applyReceipt: WorkspaceSearchOperationReceipt,
  journalSegment: WorkspaceSearchJournalSegment,
): WorkspaceSearchRollbackOperationCommandEvent {
  return {
    kind: 'rollback-operation-requested',
    applyReceipt,
    journalSegment,
  }
}

/**
 * Requires one operation event to contain mutation receipt and journal evidence.
 *
 * @param event - Candidate apply event.
 * @returns Narrowed mutation evidence.
 */
function requireMutationEvidence(
  event: WorkspaceSearchApplyOperationRecordedEvent,
): {
  /** Durable forward mutation receipt. */
  receipt: WorkspaceSearchOperationReceipt
  /** Exact immutable preimage segment. */
  segment: WorkspaceSearchJournalSegment
} {
  if (
    event.marker.kind !== 'workspace-search-operation-applied' ||
    !event.journalSegment
  ) {
    throw new TestAdapterFailure('Expected mutating apply evidence.')
  }
  return {
    receipt: event.marker,
    segment: event.journalSegment,
  }
}

/**
 * Requires one caller apply command to contain immutable journal evidence.
 *
 * @param event - Candidate caller command.
 * @returns Exact segment and reference uploaded before the command.
 */
function requireMutationCommandJournal(
  event: WorkspaceSearchApplyOperationCommandEvent,
): NonNullable<WorkspaceSearchApplyOperationCommandEvent['journal']> {
  if (!event.journal) {
    throw new TestAdapterFailure('Expected mutating command journal evidence.')
  }
  return event.journal
}

/**
 * Asserts that one async or synchronously-throwing adapter call fails safely.
 *
 * @param call - Deferred adapter operation.
 * @param code - Expected stable migration failure code.
 */
async function expectMigrationFailure(
  call: () => Promise<unknown>,
  code: WorkspaceSearchMigrationFailure['code'],
): Promise<void> {
  try {
    await call()
  } catch (error: unknown) {
    if (!(error instanceof WorkspaceSearchMigrationFailure)) throw error
    expect(error.code).toBe(code)
    return
  }
  throw new TestAdapterFailure(`Expected ${code}.`)
}

/**
 * Asserts that one synchronous call fails with an exact migration code.
 *
 * @param call - Deferred synchronous operation.
 * @param code - Expected stable migration failure code.
 */
function expectSyncMigrationFailure(
  call: () => unknown,
  code: WorkspaceSearchMigrationFailure['code'],
): void {
  try {
    call()
  } catch (error: unknown) {
    if (!(error instanceof WorkspaceSearchMigrationFailure)) throw error
    expect(error.code).toBe(code)
    return
  }
  throw new TestAdapterFailure(`Expected ${code}.`)
}

/**
 * Asserts that one injected adapter response failure is observable.
 *
 * @param call - Deferred adapter operation.
 */
async function expectAdapterFailure(
  call: () => Promise<unknown>,
): Promise<void> {
  try {
    await call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(TestAdapterFailure)
    return
  }
  throw new TestAdapterFailure('Expected an adapter failure.')
}

describe('Workspace Search migration state machine', () => {
  test('fences active leases, expired takeovers, and exact heartbeats', async () => {
    const port = new InMemoryMigrationStateMachinePort()
    port.setClock('2026-07-25T04:00:00.000Z')
    const first = await port.acquireLease({
      runId: 'run-1',
      ownerId: 'owner-1',
    })
    expect(first.fenceToken).toBe(1)

    port.setClock('2026-07-25T04:00:01.000Z')
    await expectMigrationFailure(
      () => port.acquireLease({
        runId: 'run-1',
        ownerId: 'owner-2',
      }),
      'LEASE_CONFLICT',
    )

    port.setClock(first.expiresAt)
    const takeover = await port.acquireLease({
      runId: 'run-1',
      ownerId: 'owner-2',
    })
    expect(takeover.fenceToken).toBe(first.fenceToken + 1)
    await expectMigrationFailure(
      () => port.heartbeatLease({
        lease: {
          runId: first.runId,
          ownerId: first.ownerId,
          fenceToken: first.fenceToken,
        },
      }),
      'LEASE_LOST',
    )

    port.setClock('2026-07-25T04:01:10.000Z')
    const heartbeat = await port.heartbeatLease({
      lease: port.currentLeaseClaim(),
    })
    expect(heartbeat.heartbeatAt).toBe('2026-07-25T04:01:10.000Z')
    expect(Date.parse(heartbeat.expiresAt)).toBeGreaterThan(
      Date.parse(takeover.expiresAt),
    )
    expect(heartbeat.fenceToken).toBe(takeover.fenceToken)
  })

  test('re-reads durable state and constructs evidence receipts from strict bytes', async () => {
    const fixture = createRunFixture([])
    const port = new InMemoryMigrationStateMachinePort()
    port.seedLease(createLease())
    port.seedPlanSeal(fixture.planSeal)
    port.setClock(fixture.state.createdAt)
    const invalidEvidenceBytes = new TextEncoder().encode('{}')
    await expectMigrationFailure(
      () => port.createRunState(createPersistRunInput(
        fixture,
        port.currentLeaseClaim(),
        invalidEvidenceBytes,
      )),
      'INVALID_MAINTENANCE_EVIDENCE',
    )
    expect(await port.readRunState(fixture.state.runId)).toBeUndefined()

    const state = await port.createRunState(createPersistRunInput(
      fixture,
      port.currentLeaseClaim(),
    ))
    const forgedEvent: WorkspaceSearchVerificationStartedEvent = {
      kind: 'verification-started',
    }
    const forgedCommand = {
      current: {
        ...state,
        status: 'applied',
      },
      expectedRevision: state.revision,
      lease: port.currentLeaseClaim(),
      event: forgedEvent,
    }
    port.setClock('2026-07-25T04:00:10.000Z')
    await expectMigrationFailure(
      () => port.beginVerification(forgedCommand),
      'INVALID_STATE',
    )

    const originalReceiptDigest = createMigrationDigest(
      state.maintenanceEvidenceReceipt,
    )
    port.setClock('2026-07-25T04:00:41.000Z')
    await expectMigrationFailure(
      () => port.renewMaintenanceEvidence({
        expectedRevision: state.revision,
        lease: port.currentLeaseClaim(),
        event: {
          kind: 'maintenance-evidence-renewal-requested',
          evidenceBytes: invalidEvidenceBytes,
        },
      }),
      'INVALID_MAINTENANCE_EVIDENCE',
    )
    expect((await port.readRunState(state.runId))?.revision).toBe(state.revision)

    const renewed = await port.renewMaintenanceEvidence({
      expectedRevision: state.revision,
      lease: port.currentLeaseClaim(),
      event: {
        kind: 'maintenance-evidence-renewal-requested',
        evidenceBytes: createMaintenanceEvidenceBytes(
          '2026-07-25T03:45:00.000Z',
          '2026-07-25T04:00:00.000Z',
          '2026-07-25T04:00:30.000Z',
          'change:OPS-2026-RENEW',
        ),
      },
    })
    const renewedReceiptDigest = createMigrationDigest(
      renewed.maintenanceEvidenceReceipt,
    )
    expect(renewedReceiptDigest).not.toBe(originalReceiptDigest)
    expect(await port.readMaintenanceEvidenceReceipt(
      state.runId,
      originalReceiptDigest,
    )).toEqual(state.maintenanceEvidenceReceipt)
    expect(await port.readMaintenanceEvidenceReceipt(
      state.runId,
      renewedReceiptDigest,
    )).toEqual(renewed.maintenanceEvidenceReceipt)
  })

  test('binds run creation to the reviewed dry run and consistent plan counts', () => {
    const fixture = createRunFixture([true])
    const lease = createLease()
    const candidates: readonly WorkspaceSearchPlanSeal[] = [
      {
        ...fixture.planSeal,
        dryRunEvidenceDigest: createMigrationDigest('different-dry-run'),
      },
      {
        ...fixture.planSeal,
        planningSnapshotDigest: 'invalid-planning-snapshot-digest',
      },
      {
        ...fixture.planSeal,
        sourceOperationCount: fixture.planSeal.sourceOperationCount + 1,
      },
      {
        ...fixture.planSeal,
        planDigest: createEmptyWorkspaceSearchPlanDigest(),
      },
    ]

    for (const planSeal of candidates) {
      expectSyncMigrationFailure(
        () => createWorkspaceSearchMigrationRunState({
          runId: fixture.state.runId,
          lease,
          ownerId: lease.ownerId,
          configurationHash: fixture.state.configurationHash,
          configuration: fixture.state.configuration,
          maintenanceEvidenceReceipt:
            fixture.state.maintenanceEvidenceReceipt,
          dryRunEvidenceDigest: fixture.state.dryRunEvidenceDigest,
          planDigest: fixture.state.planDigest,
          planOperationCount: fixture.state.planOperationCount,
          planSeal,
          planSealReference: {
            ...fixture.planSealReference,
            contentDigest: createMigrationDigest(planSeal),
          },
          createdAt: fixture.state.createdAt,
        }),
        'INVALID_STATE',
      )
    }

    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationRunState({
        ...fixture.state,
        planDigest: createEmptyWorkspaceSearchPlanDigest(),
      }),
      'INVALID_STATE',
    )

    const emptyFixture = createRunFixture([])
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationRunState({
        ...emptyFixture.state,
        planDigest: createMigrationDigest('nonempty-plan-root'),
      }),
      'INVALID_STATE',
    )
  })

  test('parses exact evidence bytes, derives their deadline, and rejects invalid checkpoints', () => {
    const lease = createLease()
    const receipt = createWorkspaceSearchMaintenanceEvidenceReceipt({
      runId: lease.runId,
      lease,
      evidenceBytes: createMaintenanceEvidenceBytes(
        '2026-07-25T03:45:00.000Z',
        '2026-07-25T04:00:00.000Z',
        '2026-07-25T04:00:10.000Z',
      ),
      validatedAt: '2026-07-25T04:00:30.000Z',
    })
    expect(receipt.validUntil).toBe('2026-07-25T04:05:00.001Z')
    for (const invalidTimestampEvidenceBytes of [
      createMaintenanceEvidenceBytes(
        '2026-07-25T03:45:00.000Z',
        'not-a-timestamp',
        '2026-07-25T04:00:10.000Z',
      ),
      createMaintenanceEvidenceBytes(
        '2026-07-25T03:45:00.000Z',
        '2026-07-25T04:00:00.000Z',
        'not-a-timestamp',
      ),
    ]) {
      expectSyncMigrationFailure(
        () => createWorkspaceSearchMaintenanceEvidenceReceipt({
          runId: lease.runId,
          lease,
          evidenceBytes: invalidTimestampEvidenceBytes,
          validatedAt: '2026-07-25T04:00:30.000Z',
        }),
        'INVALID_MAINTENANCE_EVIDENCE',
      )
    }

    const empty = createEmptyWorkspaceSearchMigrationCheckpoint()
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationCheckpoint({
        ...empty,
        completed: true,
        cursor: { workspaceId: { S: 'unexpected' } },
      }),
      'INVALID_STATE',
    )
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationCheckpoint({
        ...empty,
        aggregate: {
          ...empty.aggregate,
          scanned: 1,
        },
      }),
      'INVALID_STATE',
    )
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationCheckpoint({
        ...empty,
        completed: true,
        aggregate: {
          ...empty.aggregate,
          pageCount: 2,
        },
      }, empty),
      'INVALID_STATE',
    )
    const firstPage: MigrationSourceCheckpoint = {
      ...empty,
      cursor: {
        workspaceId: { S: 'workspace-1' },
        recordKey: { S: 'cursor-1' },
      },
      aggregate: {
        ...empty.aggregate,
        pageCount: 1,
      },
    }
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationCheckpoint({
        ...firstPage,
        aggregate: {
          ...firstPage.aggregate,
          pageCount: 2,
        },
      }, firstPage),
      'INVALID_STATE',
    )

    const run = createRunFixture([]).state
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationRunState({
        ...run,
        maintenanceEvidenceReceipt: {
          ...run.maintenanceEvidenceReceipt,
          validUntil: new Date(
            Date.parse(run.maintenanceEvidenceReceipt.validUntil) + 1,
          ).toISOString(),
        },
      }),
      'INVALID_STATE',
    )
  })

  test('fails closed for cursor schema drift and noncanonical target projections', () => {
    const emptyPlan = createRunFixture([])
    const initialCheckpoint = createEmptyWorkspaceSearchMigrationCheckpoint()
    const wrongCursorCheckpoint: MigrationSourceCheckpoint = {
      ...initialCheckpoint,
      cursor: {
        workspaceId: { S: 'workspace-1' },
        wrongSortKey: { S: 'cursor' },
      },
      aggregate: {
        ...initialCheckpoint.aggregate,
        pageCount: 1,
      },
    }
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationRunState({
        ...emptyPlan.state,
        apply: {
          ...emptyPlan.state.apply,
          sources: {
            ...emptyPlan.state.apply.sources,
            'work-items': wrongCursorCheckpoint,
          },
        },
      }),
      'INVALID_STATE',
    )

    const incompletePlan = createRunFixture([true, true])
    const advancedCheckpoint: MigrationSourceCheckpoint = {
      ...initialCheckpoint,
      completed: true,
      aggregate: {
        ...initialCheckpoint.aggregate,
        pageCount: 1,
      },
    }
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationRunState({
        ...incompletePlan.state,
        apply: {
          ...incompletePlan.state.apply,
          sources: {
            ...incompletePlan.state.apply.sources,
            'project-directory': advancedCheckpoint,
          },
        },
      }),
      'INVALID_STATE',
    )

    const fixture = createRunFixture([false])
    const planned = fixture.plans[0]
    if (!planned || !planned.operation.after.exists) {
      throw new TestAdapterFailure('Expected one present target operation.')
    }
    const canonical = planned.operation.after.item
    const missingDigest = Object.fromEntries(
      Object.entries(canonical).filter(([key]) => key !== 'projectionDigest'),
    )
    const candidates: readonly DynamoAttributeMap[] = [
      missingDigest,
      {
        ...canonical,
        projectionDigest: { S: zeroHexDigest() },
      },
      {
        ...canonical,
        unexpected: { S: 'fail-closed' },
      },
    ]
    for (const item of candidates) {
      expectSyncMigrationFailure(
        () => createWorkspaceSearchMigrationOperationDigest({
          ...planned.operation,
          after: {
            exists: true,
            item,
            digest: createAttributeMapDigest(item),
          },
        }),
        'INVALID_STATE',
      )
    }
  })

  test('binds present sources to canonical mapping and limits absent sources to deletes', () => {
    const fixture = createRunFixture([false])
    const planned = fixture.plans[0]
    if (!planned || !planned.operation.sourceCondition.exists) {
      throw new TestAdapterFailure('Expected one present-source operation.')
    }
    const source = planned.operation.sourceCondition
    const crossWorkspaceTargetKey = {
      workspaceId: { S: 'workspace-2' },
      recordKey: {
        S: createWorkspaceSearchDocumentRecordKey('team', 'team/team-1'),
      },
    }
    const crossWorkspaceBefore = encodeSearchDocument(
      createTeamWorkspaceSearchDocument({
        workspaceId: 'workspace-2',
        teamId: 'team-1',
        title: 'Before 1',
      }),
    )
    const crossWorkspaceAfter = encodeSearchDocument(
      createTeamWorkspaceSearchDocument({
        workspaceId: 'workspace-2',
        teamId: 'team-1',
        title: 'After 1',
      }),
    )
    const crossWorkspaceTargetKeyDigest = createAttributeMapDigest(
      crossWorkspaceTargetKey,
    )
    const crossWorkspaceOperation: WorkspaceSearchMigrationOperation = {
      ...planned.operation,
      operationId: createWorkspaceSearchOperationId({
        configurationHash: planned.configurationHash,
        sourceTableId: source.tableId,
        sourceKeyDigest: source.keyDigest,
        targetKeyDigest: crossWorkspaceTargetKeyDigest,
      }),
      targetKey: crossWorkspaceTargetKey,
      targetKeyDigest: crossWorkspaceTargetKeyDigest,
      before: {
        exists: true,
        item: crossWorkspaceBefore,
        digest: createAttributeMapDigest(crossWorkspaceBefore),
      },
      after: {
        exists: true,
        item: crossWorkspaceAfter,
        digest: createAttributeMapDigest(crossWorkspaceAfter),
      },
    }
    expectSyncMigrationFailure(
      () => createWorkspaceSearchMigrationOperationDigest(
        crossWorkspaceOperation,
      ),
      'INVALID_STATE',
    )

    const absentSource:
      WorkspaceSearchMigrationOperation['sourceCondition'] = {
        exists: false,
        source: source.source,
        tableId: source.tableId,
        tableName: source.tableName,
        key: source.key,
        keyDigest: source.keyDigest,
      }
    expectSyncMigrationFailure(
      () => createWorkspaceSearchMigrationOperationDigest({
        ...planned.operation,
        sourceCondition: absentSource,
      }),
      'INVALID_STATE',
    )
    expectSyncMigrationFailure(
      () => createWorkspaceSearchMigrationOperationDigest({
        ...crossWorkspaceOperation,
        sourceCondition: absentSource,
        after: {
          exists: false,
          digest: createAbsentMigrationItemDigest(),
        },
      }),
      'INVALID_STATE',
    )
    expectSyncMigrationFailure(
      () => createWorkspaceSearchMigrationOperationDigest({
        ...planned.operation,
        sourceCondition: absentSource,
        after: {
          exists: false,
          digest: createAbsentMigrationItemDigest(),
        },
      }),
      'INVALID_STATE',
    )

    const orphanEntityId = 'team/team-1/issue/issue-1'
    const orphanTargetKey = {
      workspaceId: { S: 'workspace-1' },
      recordKey: {
        S: createWorkspaceSearchDocumentRecordKey(
          'work-item',
          orphanEntityId,
        ),
      },
    }
    const orphanBefore = encodeSearchDocument(
      createWorkItemWorkspaceSearchDocument({
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        issueId: 'issue-1',
        title: 'Orphan work item',
      }),
    )
    const orphanSourceKey = {
      directoryTeamId: { S: 'workspace-1#team#team-1' },
      issueId: { S: 'issue-1' },
    }
    const orphanSourceKeyDigest = createAttributeMapDigest(orphanSourceKey)
    const orphanTargetKeyDigest = createAttributeMapDigest(orphanTargetKey)
    const orphanOperation: WorkspaceSearchMigrationOperation = {
      operationId: createWorkspaceSearchOperationId({
        configurationHash: planned.configurationHash,
        sourceTableId: fixture.state.configuration.tables['work-items'].tableId,
        sourceKeyDigest: orphanSourceKeyDigest,
        targetKeyDigest: orphanTargetKeyDigest,
      }),
      sourceCondition: {
        exists: false,
        source: 'work-items',
        tableId: fixture.state.configuration.tables['work-items'].tableId,
        tableName: fixture.state.configuration.tables['work-items'].tableName,
        key: orphanSourceKey,
        keyDigest: orphanSourceKeyDigest,
      },
      targetKey: orphanTargetKey,
      targetKeyDigest: orphanTargetKeyDigest,
      before: {
        exists: true,
        item: orphanBefore,
        digest: createAttributeMapDigest(orphanBefore),
      },
      after: {
        exists: false,
        digest: createAbsentMigrationItemDigest(),
      },
      entityType: 'work-item',
    }
    expect(() => createWorkspaceSearchMigrationOperationDigest(
      orphanOperation,
    )).not.toThrow()
  })

  test('records an exact no-op marker without creating a journal link', async () => {
    const fixture = await createPersistedRun([true])
    const planned = fixture.plans[0]
    if (!planned) throw new TestAdapterFailure('Expected one plan row.')

    const result = await commitPlannedOperation(
      fixture.port,
      fixture.state,
      planned,
      '2026-07-25T04:00:05.000Z',
    )

    expect(result.event.marker.kind)
      .toBe('workspace-search-operation-already-current')
    expect(result.state.appliedOperationCount).toBe(1)
    expect(result.state.journalSequence).toBe(0)
    expect(result.state.journalHeadDigest).toBe(zeroHexDigest())
    expect(await fixture.port.readApplyReceipt(fixture.state.runId, 1))
      .toBeUndefined()
    expect(await fixture.port.readOperationMarker(
      fixture.state.runId,
      planned.operation.operationId,
    )).toEqual(result.event.marker)
    expect(fixture.port.readTargetSnapshot(planned.operation.targetKeyDigest))
      .toEqual(planned.operation.before)
  })

  test('starts post-apply traversal only after every plan operation is durable', async () => {
    const fixture = await createPersistedRun([true, true])
    fixture.port.setClock('2026-07-25T04:00:05.000Z')
    await expectMigrationFailure(
      () => fixture.port.saveApplyCheckpoint({
        expectedRevision: fixture.state.revision,
        lease: fixture.port.currentLeaseClaim(),
        location: 'project-directory',
      }),
      'INVALID_STATE',
    )
    expect((await fixture.port.readRunState(fixture.state.runId))?.revision)
      .toBe(fixture.state.revision)

    const firstPlan = fixture.plans[0]
    const secondPlan = fixture.plans[1]
    if (!firstPlan || !secondPlan) {
      throw new TestAdapterFailure('Expected two plan rows.')
    }
    const first = await commitPlannedOperation(
      fixture.port,
      fixture.state,
      firstPlan,
      '2026-07-25T04:00:10.000Z',
    )
    fixture.port.setClock('2026-07-25T04:00:15.000Z')
    await expectMigrationFailure(
      () => fixture.port.saveApplyCheckpoint({
        expectedRevision: first.state.revision,
        lease: fixture.port.currentLeaseClaim(),
        location: 'project-directory',
      }),
      'INVALID_STATE',
    )
    expect((await fixture.port.readRunState(fixture.state.runId))?.revision)
      .toBe(first.state.revision)

    const second = await commitPlannedOperation(
      fixture.port,
      first.state,
      secondPlan,
      '2026-07-25T04:00:20.000Z',
    )
    fixture.port.setClock('2026-07-25T04:00:25.000Z')
    const checkpointed = await fixture.port.saveApplyCheckpoint({
      expectedRevision: second.state.revision,
      lease: fixture.port.currentLeaseClaim(),
      location: 'project-directory',
    })
    expect(checkpointed.apply.sources['project-directory'].completed).toBe(
      true,
    )
  })

  test('requires journal durability, exposes response-loss markers, and rejects stale retries', async () => {
    const fixture = await createPersistedRun([false])
    const planned = fixture.plans[0]
    if (!planned) throw new TestAdapterFailure('Expected one plan row.')
    const event = createApplyCommand(
      fixture.state,
      planned,
      '2026-07-25T04:00:05.000Z',
    )
    const journal = requireMutationCommandJournal(event)
    fixture.port.setClock('2026-07-25T04:00:10.000Z')
    const input = {
      expectedRevision: fixture.state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event,
    }

    await expectMigrationFailure(
      () => fixture.port.commitApplyOperation(input),
      'INVALID_JOURNAL',
    )
    expect(await fixture.port.readOperationMarker(
      fixture.state.runId,
      planned.operation.operationId,
    )).toBeUndefined()

    fixture.port.persistJournalSegment(journal.segment)
    fixture.port.injectFault('throw-after-commit')
    await expectAdapterFailure(
      () => fixture.port.commitApplyOperation(input),
    )
    const reconciled = await fixture.port.readOperationMarker(
      fixture.state.runId,
      planned.operation.operationId,
    )
    expect(reconciled?.kind).toBe('workspace-search-operation-applied')
    if (reconciled?.kind !== 'workspace-search-operation-applied') {
      throw new TestAdapterFailure('Expected durable mutation receipt.')
    }
    expect(reconciled.committedAt).toBe('2026-07-25T04:00:10.000Z')
    expect(journal.segment.createdAt).toBe('2026-07-25T04:00:05.000Z')
    expect(reconciled.journal).toEqual(journal.reference)
    expect((await fixture.port.readRunState(fixture.state.runId))?.revision)
      .toBe(fixture.state.revision + 1)
    expect(fixture.port.readTargetSnapshot(planned.operation.targetKeyDigest))
      .toEqual(planned.operation.after)

    await expectMigrationFailure(
      () => fixture.port.commitApplyOperation(input),
      'INVALID_STATE',
    )
  })

  test('fails closed for lease, source, target, plan, evidence, and pre-commit races', async () => {
    const cases: readonly {
      /** Injected one-shot fault. */
      fault: CommitFault
      /** Stable expected failure code, absent for adapter failure. */
      code?: WorkspaceSearchMigrationFailure['code']
    }[] = [
      { fault: 'expire-lease', code: 'LEASE_LOST' },
      { fault: 'take-over-lease', code: 'LEASE_LOST' },
      { fault: 'source-drift', code: 'SOURCE_DRIFT' },
      { fault: 'target-drift', code: 'TARGET_DRIFT' },
      { fault: 'throw-before-commit' },
    ]
    for (const entry of cases) {
      const fixture = await createPersistedRun([false])
      const planned = fixture.plans[0]
      if (!planned) throw new TestAdapterFailure('Expected one plan row.')
      const event = createApplyCommand(
        fixture.state,
        planned,
        '2026-07-25T04:00:10.000Z',
      )
      const journal = requireMutationCommandJournal(event)
      fixture.port.persistJournalSegment(journal.segment)
      fixture.port.injectFault(entry.fault)
      fixture.port.setClock('2026-07-25T04:00:10.000Z')
      const call = () => fixture.port.commitApplyOperation({
        expectedRevision: fixture.state.revision,
        lease: fixture.port.currentLeaseClaim(),
        event,
      })
      if (entry.code) {
        await expectMigrationFailure(call, entry.code)
      } else {
        await expectAdapterFailure(call)
      }
      expect(await fixture.port.readOperationMarker(
        fixture.state.runId,
        planned.operation.operationId,
      )).toBeUndefined()
      expect((await fixture.port.readRunState(fixture.state.runId))?.revision)
        .toBe(fixture.state.revision)
    }

    const outOfOrder = await createPersistedRun([false, false])
    const secondPlan = outOfOrder.plans[1]
    if (!secondPlan) throw new TestAdapterFailure('Expected second plan row.')
    const secondPlanEvent = createApplyCommand(
      outOfOrder.state,
      secondPlan,
      '2026-07-25T04:00:10.000Z',
    )
    const secondPlanJournal = requireMutationCommandJournal(secondPlanEvent)
    outOfOrder.port.persistJournalSegment(secondPlanJournal.segment)
    outOfOrder.port.setClock('2026-07-25T04:00:10.000Z')
    await expectMigrationFailure(
      () => outOfOrder.port.commitApplyOperation({
        expectedRevision: outOfOrder.state.revision,
        lease: outOfOrder.port.currentLeaseClaim(),
        event: secondPlanEvent,
      }),
      'INVALID_STATE',
    )
    expect(await outOfOrder.port.readOperationMarker(
      outOfOrder.state.runId,
      secondPlan.operation.operationId,
    )).toBeUndefined()

    const stale = await createPersistedRun([false])
    const planned = stale.plans[0]
    if (!planned) throw new TestAdapterFailure('Expected one plan row.')
    const staleEvidenceEvent = createApplyCommand(
      stale.state,
      planned,
      '2026-07-25T04:00:41.000Z',
    )
    const staleJournal = requireMutationCommandJournal(staleEvidenceEvent)
    stale.port.persistJournalSegment(staleJournal.segment)
    stale.port.setClock('2026-07-25T04:00:41.000Z')
    await expectMigrationFailure(
      () => stale.port.commitApplyOperation({
        expectedRevision: stale.state.revision,
        lease: stale.port.currentLeaseClaim(),
        event: staleEvidenceEvent,
      }),
      'INVALID_MAINTENANCE_EVIDENCE',
    )

    const tamperedPlanEvent: WorkspaceSearchApplyOperationCommandEvent = {
      ...staleEvidenceEvent,
      plannedOperation: {
        ...planned,
        operationDigest: createMigrationDigest('tampered-plan-entry'),
      },
    }
    stale.port.setClock('2026-07-25T04:00:10.000Z')
    await expectMigrationFailure(
      () => stale.port.commitApplyOperation({
        expectedRevision: stale.state.revision,
        lease: stale.port.currentLeaseClaim(),
        event: tamperedPlanEvent,
      }),
      'INVALID_STATE',
    )
  })

  test('keeps verification checkpoints independent and anchors exact complete evidence', async () => {
    const fixture = await createPersistedRun([true])
    const planned = fixture.plans[0]
    if (!planned) throw new TestAdapterFailure('Expected one plan row.')
    let state = (
      await commitPlannedOperation(
        fixture.port,
        fixture.state,
        planned,
        '2026-07-25T04:00:10.000Z',
      )
    ).state
    state = await completeApplyTraversal(
      fixture.port,
      state,
      '2026-07-25T04:00:20.000Z',
    )
    const applyEvidence = createApplySeal(
      state,
      'complete-plan',
      '2026-07-25T04:00:20.000Z',
    )
    fixture.port.persistApplySeal(applyEvidence.seal)
    fixture.port.setClock('2026-07-25T04:00:20.000Z')
    state = await fixture.port.sealApply({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: {
        kind: 'apply-sealed',
        seal: applyEvidence.seal,
        reference: applyEvidence.reference,
      },
    })
    fixture.port.setClock('2026-07-25T04:00:30.000Z')
    state = await fixture.port.beginVerification({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: { kind: 'verification-started' },
    })
    expect(state.apply.target.completed).toBe(true)
    expect(state.verification?.target)
      .toEqual(createEmptyWorkspaceSearchMigrationCheckpoint())

    state = await completeVerificationTraversal(
      fixture.port,
      state,
      '2026-07-25T04:00:30.000Z',
    )
    if (!state.verification) {
      throw new TestAdapterFailure('Expected complete verification progress.')
    }
    expect(
      state.verification.sources['project-directory'].aggregate.scanned,
    ).toBe(1)
    expect(state.verification.target.aggregate.scanned).toBe(1)
    const evidence: WorkspaceSearchVerificationEvidence = {
      kind: 'workspace-search-verification-evidence',
      evidenceVersion: 1,
      migrationId: 'workspace-search-maintenance',
      migrationVersion: 1,
      runId: state.runId,
      configurationHash: state.configurationHash,
      planDigest: state.planDigest,
      planOperationCount: state.planOperationCount,
      applySealContentDigest: applyEvidence.reference.contentDigest,
      verification: state.verification,
      status: 'pass',
      completedAt: '2026-07-25T04:00:40.000Z',
    }
    const reference: WorkspaceSearchVerificationEvidenceReference = {
      objectKey:
        `workspace-search/v1/${state.runId}/verification-evidence.json`,
      versionId: 'verification-version',
      contentDigest: createMigrationDigest(evidence),
    }
    fixture.port.persistVerificationEvidence(evidence)
    fixture.port.setClock('2026-07-25T04:00:40.000Z')
    state = await fixture.port.completeVerification({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: {
        kind: 'verification-passed',
        evidence,
        reference,
      },
    })

    expect(state.status).toBe('verified')
    expect(state.verificationEvidenceReference).toEqual(reference)
    expect(await fixture.port.readVerificationEvidence(reference))
      .toEqual(evidence)
  })

  test('rolls back a sealed partial prefix and restores the exact canonical projection', async () => {
    const fixture = await createPersistedRun([false, false])
    const planned = fixture.plans[0]
    if (!planned) throw new TestAdapterFailure('Expected first plan row.')
    const applied = await commitPlannedOperation(
      fixture.port,
      fixture.state,
      planned,
      '2026-07-25T04:00:10.000Z',
    )
    const mutation = requireMutationEvidence(applied.event)
    const prefix = createApplySeal(
      applied.state,
      'committed-prefix',
      '2026-07-25T04:00:20.000Z',
    )
    fixture.port.persistApplySeal(prefix.seal)
    fixture.port.setClock('2026-07-25T04:00:20.000Z')
    let state = await fixture.port.beginRollback({
      expectedRevision: applied.state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: {
        kind: 'rollback-started',
        seal: prefix.seal,
        reference: prefix.reference,
      },
    })
    const emptyCheckpoint = createEmptyWorkspaceSearchMigrationCheckpoint()
    const advancedCheckpoint: MigrationSourceCheckpoint = {
      ...emptyCheckpoint,
      completed: true,
      aggregate: {
        ...emptyCheckpoint.aggregate,
        pageCount: 1,
      },
    }
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationRunState({
        ...state,
        apply: {
          ...state.apply,
          target: advancedCheckpoint,
        },
      }),
      'INVALID_STATE',
    )
    const reverseEvent = createRollbackCommand(
      mutation.receipt,
      mutation.segment,
    )
    const tamperedSegment: WorkspaceSearchJournalSegment = {
      ...mutation.segment,
      createdAt: '2026-07-25T03:59:59.000Z',
    }
    fixture.port.setClock('2026-07-25T04:00:30.000Z')
    await expectMigrationFailure(
      () => fixture.port.commitRollbackOperation({
        expectedRevision: state.revision,
        lease: fixture.port.currentLeaseClaim(),
        event: {
          ...reverseEvent,
          journalSegment: tamperedSegment,
        },
      }),
      'INVALID_JOURNAL',
    )
    expect(fixture.port.readTargetSnapshot(planned.operation.targetKeyDigest))
      .toEqual(planned.operation.after)

    fixture.port.setClock('2026-07-25T04:00:30.000Z')
    state = await fixture.port.commitRollbackOperation({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: reverseEvent,
    })
    fixture.port.setClock('2026-07-25T04:00:40.000Z')
    state = await fixture.port.finishRollback({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: { kind: 'rollback-finished' },
    })

    expect(state.status).toBe('rolled-back')
    expectSyncMigrationFailure(
      () => validateWorkspaceSearchMigrationRunState({
        ...state,
        apply: {
          ...state.apply,
          target: advancedCheckpoint,
        },
      }),
      'INVALID_STATE',
    )
    const restored = fixture.port.readTargetSnapshot(
      planned.operation.targetKeyDigest,
    )
    expect(restored).toEqual(planned.operation.before)
    if (!restored.exists) {
      throw new TestAdapterFailure('Expected restored present preimage.')
    }
    expect(restored.item.title).toEqual({ S: 'Before 1' })
    expect(restored.item.teamId).toEqual({ S: 'team-1' })
    if (!planned.operation.before.exists) {
      throw new TestAdapterFailure('Expected a present planned preimage.')
    }
    expect(restored.item.projectionDigest)
      .toEqual(planned.operation.before.item.projectionDigest)
  })

  test('requires strict reverse order and fails closed on rollback target drift', async () => {
    const fixture = await createPersistedRun([false, false])
    const firstPlan = fixture.plans[0]
    const secondPlan = fixture.plans[1]
    if (!firstPlan || !secondPlan) {
      throw new TestAdapterFailure('Expected two plan rows.')
    }
    const first = await commitPlannedOperation(
      fixture.port,
      fixture.state,
      firstPlan,
      '2026-07-25T04:00:10.000Z',
    )
    const second = await commitPlannedOperation(
      fixture.port,
      first.state,
      secondPlan,
      '2026-07-25T04:00:15.000Z',
    )
    const firstMutation = requireMutationEvidence(first.event)
    const secondMutation = requireMutationEvidence(second.event)
    let state = await completeApplyTraversal(
      fixture.port,
      second.state,
      '2026-07-25T04:00:20.000Z',
    )
    const applyEvidence = createApplySeal(
      state,
      'complete-plan',
      '2026-07-25T04:00:20.000Z',
    )
    fixture.port.persistApplySeal(applyEvidence.seal)
    fixture.port.setClock('2026-07-25T04:00:20.000Z')
    state = await fixture.port.sealApply({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: {
        kind: 'apply-sealed',
        seal: applyEvidence.seal,
        reference: applyEvidence.reference,
      },
    })
    fixture.port.setClock('2026-07-25T04:00:30.000Z')
    state = await fixture.port.beginRollback({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: {
        kind: 'rollback-started',
        seal: applyEvidence.seal,
        reference: applyEvidence.reference,
      },
    })

    const outOfOrder = createRollbackCommand(
      firstMutation.receipt,
      firstMutation.segment,
    )
    fixture.port.setClock('2026-07-25T04:00:35.000Z')
    await expectMigrationFailure(
      () => fixture.port.commitRollbackOperation({
        expectedRevision: state.revision,
        lease: fixture.port.currentLeaseClaim(),
        event: outOfOrder,
      }),
      'INVALID_STATE',
    )

    fixture.port.injectFault('target-drift')
    const secondReverse = createRollbackCommand(
      secondMutation.receipt,
      secondMutation.segment,
    )
    fixture.port.setClock('2026-07-25T04:00:36.000Z')
    await expectMigrationFailure(
      () => fixture.port.commitRollbackOperation({
        expectedRevision: state.revision,
        lease: fixture.port.currentLeaseClaim(),
        event: secondReverse,
      }),
      'ROLLBACK_TARGET_DRIFT',
    )

    fixture.port.seedTargetSnapshot(
      secondPlan.operation.targetKeyDigest,
      secondPlan.operation.after,
    )
    fixture.port.injectFault('throw-after-commit')
    fixture.port.setClock('2026-07-25T04:00:36.000Z')
    const reconciledSecond = createRollbackCommand(
      secondMutation.receipt,
      secondMutation.segment,
    )
    await expectAdapterFailure(
      () => fixture.port.commitRollbackOperation({
        expectedRevision: state.revision,
        lease: fixture.port.currentLeaseClaim(),
        event: reconciledSecond,
      }),
    )
    const reconciledRollback = await fixture.port.readRollbackReceipt(
      state.runId,
      secondMutation.receipt.sequence,
    )
    expect(reconciledRollback?.rolledBackAt)
      .toBe('2026-07-25T04:00:36.000Z')
    expect(reconciledRollback?.fenceToken)
      .toBe(fixture.port.currentLeaseClaim().fenceToken)
    const reconciledState = await fixture.port.readRunState(state.runId)
    if (!reconciledState) {
      throw new TestAdapterFailure('Expected state after rollback response loss.')
    }
    state = reconciledState

    fixture.port.setClock('2026-07-25T04:00:37.000Z')
    const firstReverse = createRollbackCommand(
      firstMutation.receipt,
      firstMutation.segment,
    )
    state = await fixture.port.commitRollbackOperation({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: firstReverse,
    })
    fixture.port.setClock('2026-07-25T04:00:40.000Z')
    state = await fixture.port.finishRollback({
      expectedRevision: state.revision,
      lease: fixture.port.currentLeaseClaim(),
      event: { kind: 'rollback-finished' },
    })

    expect(state.status).toBe('rolled-back')
    expect(fixture.port.readTargetSnapshot(firstPlan.operation.targetKeyDigest))
      .toEqual(firstPlan.operation.before)
    expect(fixture.port.readTargetSnapshot(secondPlan.operation.targetKeyDigest))
      .toEqual(secondPlan.operation.before)
  })
})
