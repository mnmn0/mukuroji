import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
} from '../../data-integrity/cross-domain-integrity'
import type {
  AttributeValue,
  GetItemCommand,
  GetItemCommandOutput,
  TransactWriteItemsCommand,
  TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  createMigrationDigest,
  serializeCanonicalJson,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import {
  verifyWorkspaceSearchMigrationRehearsalStageCommitEvidenceChain,
  readWorkspaceSearchMigrationRehearsalStageCommitChainAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN_KIND,
  WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError,
} from './migration-rehearsal-stage-commit-evidence-chain'
import {
  createWorkspaceSearchMigrationRehearsalStageCommitEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
  type WorkspaceSearchMigrationRehearsalStageCommitEvidence,
} from './migration-rehearsal-stage-commit-evidence'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import type {
  WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-fault-observation'
import {
  createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest,
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalFaultStageEvidence,
  type WorkspaceSearchMigrationRehearsalStageEvidence,
  type WorkspaceSearchMigrationRehearsalStageLeaseObservation,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
  type WorkspaceSearchMigrationRehearsalStageReceiptClaims,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  createWorkspaceSearchMigrationRehearsalStageReservationAbandonment,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_VERSION,
  type WorkspaceSearchMigrationRehearsalStageReservationAbandonment,
} from './migration-rehearsal-stage-reservation-abandonment'
import type {
  WorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding,
  WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair,
  WorkspaceSearchMigrationRehearsalVerifiedIntegrityCollectorResult,
} from './migration-rehearsal-reconciliation-audit'
import {
  createWorkspaceSearchMigrationRehearsalStageReservationAwsStore,
  createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest,
  readWorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding,
  readWorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
  type WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorization,
  type WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization,
  type WorkspaceSearchMigrationRehearsalStageDurabilityRecovery,
  type WorkspaceSearchMigrationRehearsalStageReservationAwsTransport,
} from './migration-rehearsal-stage-reservation-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'

/** Complete authentic inputs and detached artifacts for chain tests. */
type StageCommitEvidenceChainFixture = {
  /** Shared exact authentication key used by every artifact. */
  readonly verificationKey: Uint8Array
  /** Parent-only key authenticating durable commit evidence. */
  readonly publicationVerificationKey: Uint8Array
  /** Authenticated short-lived permit owning the complete suite. */
  readonly permit:
    WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture['permit']
  /** Authenticated reviewed complete 36-stage manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Authenticated receipts in exact global ordinal order. */
  readonly receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[]
  /** Authenticated commit evidence records in the same exact order. */
  readonly evidences:
    readonly WorkspaceSearchMigrationRehearsalStageCommitEvidence[]
  /** Exact strong-read durability capabilities in global order. */
  readonly durabilityAuthorizations:
    readonly WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization[]
  /** Exact strong-read abandonment-set capability, including explicit zero. */
  readonly abandonmentDurabilityAuthorization:
    WorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorization
  /** Exact signed reservation/abandonment pairs recovered from durable rows. */
  readonly reservationAbandonments:
    readonly StageCommitRecoveryAbandonmentPair[]
}

/** One authentic local pair expected to have an immutable durable row. */
type StageCommitRecoveryAbandonmentPair = {
  /** Runtime-authenticated abandoned reservation. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Parent-authenticated transition for that exact reservation. */
  readonly abandonment:
    WorkspaceSearchMigrationRehearsalStageReservationAbandonment
}

/** Returns one deterministic lowercase SHA-256 digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Recreates the canonical physical-resource vector from the shared fixture. */
function fixtureIntegrityResourceIdentities() {
  return CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) => ({
    target,
    identityDigest: createMigrationDigest({
      label: `fixture-integrity-resource:${index}:${target}`,
    }),
  }))
}

/** Physical table name used only by the in-memory strong-read fixture. */
const stageCommitChainStateTableName = 'migration-state-test'

/** Minimal read-only transport serving exact root and immutable row items. */
class StageCommitChainRecoveryTransport implements
  WorkspaceSearchMigrationRehearsalStageReservationAwsTransport {
  /** Exact low-level items indexed by deterministic adapter record key. */
  private readonly items:
    ReadonlyMap<string, Readonly<Record<string, AttributeValue>>>

  /** Creates one finite immutable in-memory strong-read transport. */
  constructor(
    items: ReadonlyMap<
      string,
      Readonly<Record<string, AttributeValue>>
    >,
  ) {
    this.items = items
  }

  /** Returns the exact item addressed by one consistent adapter read. */
  async getRehearsalStageReservation(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    if (command.input.ConsistentRead !== true) {
      throw new Error('Expected a strong read.')
    }
    const key = command.input.Key?.recordKey
    const recordKey = key !== undefined && 'S' in key ? key.S : undefined
    if (recordKey === undefined) {
      return Object.freeze({ $metadata: Object.freeze({}) })
    }
    const item = this.items.get(recordKey)
    return item === undefined
      ? Object.freeze({ $metadata: Object.freeze({}) })
      : Object.freeze({
          $metadata: Object.freeze({}),
          Item: item,
        })
  }

  /** Rejects writes because the chain fixture exercises recovery only. */
  async transactWriteRehearsalStageReservation(
    _command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    throw new Error('Unexpected write in recovery-only fixture.')
  }
}

/** Derives deterministic store namespace and location bindings for a fixture. */
function createStageCommitChainStoreBinding(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
): {
  /** Deterministic immutable row namespace. */
  readonly recordNamespace: string
  /** Deterministic suite-root key. */
  readonly rootRecordKey: string
  /** Authenticated physical location binding. */
  readonly stateTableLocationBindingDigest: string
} {
  const stateTableLocationBindingDigest =
    createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
      stateTableName: stageCommitChainStateTableName,
      requestedResourcesBinding: manifest.requestedResourcesBinding,
    })
  const recordKeyBindingDigest = createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-suite-key',
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
    stateTableLocationBindingDigest,
    permitDigest: manifest.permitDigest,
    requestedResourcesBinding: manifest.requestedResourcesBinding,
  })
  const recordNamespace = `rehearsal-suite/v2/${recordKeyBindingDigest}`
  return Object.freeze({
    recordNamespace,
    rootRecordKey: `${recordNamespace}/root`,
    stateTableLocationBindingDigest,
  })
}

/** Creates the exact terminal root item bracketing all immutable row reads. */
function createStageCommitChainRootItem(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  terminalReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  binding: ReturnType<typeof createStageCommitChainStoreBinding>,
): Readonly<Record<string, AttributeValue>> {
  const manifestDigest = createMigrationDigest(manifest)
  const state = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
    stateVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
    manifestDigest,
    permitDigest: manifest.permitDigest,
    requestedResourcesBinding: manifest.requestedResourcesBinding,
    completedStageOrdinal: terminalReceipt.stageOrdinal,
    headReceiptDigest: createMigrationDigest(terminalReceipt),
    activeReservation: null,
    abandonmentCount: terminalReceipt.stageReservationAbandonmentCount,
    abandonmentRootDigest:
      terminalReceipt.stageReservationAbandonmentRootDigest,
    lastAbandonedAt:
      terminalReceipt.stageReservationAbandonmentCount === 0
        ? null
        : stageTimestamp(2, 0),
  })
  const stateJson = serializeCanonicalJson(state)
  return Object.freeze({
    kind: { S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND },
    manifestDigest: { S: manifestDigest },
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    permitDigest: { S: manifest.permitDigest },
    recordKey: { S: binding.rootRecordKey },
    recordVersion: {
      N: String(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION),
    },
    requestedResourcesBinding: { S: manifest.requestedResourcesBinding },
    stateDigest: { S: createMigrationDigest({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
      version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
      stateTableLocationBindingDigest:
        binding.stateTableLocationBindingDigest,
      state,
    }) },
    stateJson: { S: stateJson },
    stateRevision: {
      N: String(terminalReceipt.stageReservationCommitRevision),
    },
    stateTableLocationBindingDigest: {
      S: binding.stateTableLocationBindingDigest,
    },
    stateWriteNonce: { S: createMigrationDigest(terminalReceipt) },
  })
}

/** Creates one exact immutable commit-journal item for recovery. */
function createStageCommitChainJournalItem(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  evidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  recordKey: string,
  binding: ReturnType<typeof createStageCommitChainStoreBinding>,
): Readonly<Record<string, AttributeValue>> {
  return Object.freeze({
    abandonmentCount: {
      N: String(receipt.stageReservationAbandonmentCount),
    },
    abandonmentRootDigest: {
      S: receipt.stageReservationAbandonmentRootDigest,
    },
    commitAdmittedAt: { S: evidence.commitAdmittedAt },
    commitEvidenceDigest: { S: createMigrationDigest(evidence) },
    commitEvidenceJson: { S: serializeCanonicalJson(evidence) },
    commitRevision: { N: String(receipt.stageReservationCommitRevision) },
    kind: {
      S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_KIND,
    },
    manifestDigest: { S: createMigrationDigest(manifest) },
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    parentAuthenticationDigest: {
      S: evidence.parentAuthenticationDigest,
    },
    parentAuthorizationBindingDigest: {
      S: evidence.parentAuthorizationBindingDigest,
    },
    permitDigest: { S: manifest.permitDigest },
    publicationKeyDigest: { S: evidence.publicationKeyDigest },
    receiptDigest: { S: createMigrationDigest(receipt) },
    recordKey: { S: recordKey },
    recordVersion: {
      N: String(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_VERSION,
      ),
    },
    requestedResourcesBinding: { S: manifest.requestedResourcesBinding },
    stageOrdinal: { N: String(receipt.stageOrdinal) },
    stageReservationClaimRevision: {
      N: String(receipt.stageReservationClaimRevision),
    },
    stageReservationDigest: { S: receipt.stageReservationDigest },
    stateTableLocationBindingDigest: {
      S: binding.stateTableLocationBindingDigest,
    },
  })
}

/**
 * Creates one exact immutable abandonment-journal item for recovery.
 *
 * @param manifest - Authenticated reviewed full-suite manifest.
 * @param pair - Exact authenticated reservation/transition pair.
 * @param recordKey - Deterministic immutable row key.
 * @param binding - Deterministic store namespace and location binding.
 * @returns Frozen strict low-level DynamoDB item.
 */
function createStageAbandonmentChainJournalItem(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  pair: StageCommitRecoveryAbandonmentPair,
  recordKey: string,
  binding: ReturnType<typeof createStageCommitChainStoreBinding>,
): Readonly<Record<string, AttributeValue>> {
  const transitionJson = serializeCanonicalJson(pair.abandonment)
  return Object.freeze({
    kind: {
      S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_KIND,
    },
    manifestDigest: { S: createMigrationDigest(manifest) },
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    permitDigest: { S: manifest.permitDigest },
    recordKey: { S: recordKey },
    recordVersion: {
      N: String(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_ABANDONMENT_VERSION,
      ),
    },
    requestedResourcesBinding: { S: manifest.requestedResourcesBinding },
    stageOrdinal: { N: String(pair.abandonment.stageOrdinal) },
    stateTableLocationBindingDigest: {
      S: binding.stateTableLocationBindingDigest,
    },
    transitionDigest: { S: createMigrationDigest(pair.abandonment) },
    transitionJson: { S: transitionJson },
  })
}

/** Recovers branded capabilities through the real strict store parser. */
async function createStageCommitChainDurabilityAuthorizations(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
  evidences: readonly WorkspaceSearchMigrationRehearsalStageCommitEvidence[],
  reservationAbandonments:
    readonly StageCommitRecoveryAbandonmentPair[],
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  persistAbandonmentRows = true,
): Promise<
  WorkspaceSearchMigrationRehearsalStageDurabilityRecovery
> {
  const terminalReceipt = receipts.at(-1)
  if (terminalReceipt === undefined) throw new Error('Missing terminal receipt.')
  const binding = createStageCommitChainStoreBinding(manifest)
  const items = new Map<
    string,
    Readonly<Record<string, AttributeValue>>
  >()
  items.set(
    binding.rootRecordKey,
    createStageCommitChainRootItem(manifest, terminalReceipt, binding),
  )
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]
    const evidence = evidences[index]
    if (receipt === undefined || evidence === undefined) {
      throw new Error('Missing recovery fixture row.')
    }
    const recordKey =
      `${binding.recordNamespace}/stage/${receipt.stageOrdinal}/commit`
    items.set(recordKey, createStageCommitChainJournalItem(
      manifest,
      receipt,
      evidence,
      recordKey,
      binding,
    ))
  }
  for (const pair of persistAbandonmentRows ? reservationAbandonments : []) {
    const recordKey = `${binding.recordNamespace}/stage/` +
      `${pair.abandonment.stageOrdinal}/abandon/` +
      `${pair.abandonment.abandonmentCount}`
    items.set(recordKey, createStageAbandonmentChainJournalItem(
      manifest,
      pair,
      recordKey,
      binding,
    ))
  }
  const store = createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
    binding: {
      stateTableName: stageCommitChainStateTableName,
      requestedResourcesBinding: manifest.requestedResourcesBinding,
    },
    manifest,
    manifestVerificationKey: runtimeKey,
    transport: new StageCommitChainRecoveryTransport(items),
  })
  return await store.recoverCommitChain({
    receipts,
    reservationAbandonments,
    runtimeVerificationKey: runtimeKey,
    publicationVerificationKey: publicationKey,
  })
}

/**
 * Returns one canonical stage-relative timestamp.
 *
 * @param stageOrdinal - One-based global stage ordinal.
 * @param offsetSeconds - Exact offset inside the stage's one-minute window.
 * @returns Canonical millisecond-precision UTC timestamp.
 */
function stageTimestamp(
  stageOrdinal: number,
  offsetSeconds: number,
): string {
  return new Date(
    Date.UTC(2026, 7, 2) +
      (stageOrdinal - 1) * 60_000 +
      offsetSeconds * 1_000,
  ).toISOString()
}

/**
 * Returns the reviewed failpoint represented by one fault-stage entry.
 *
 * @param entry - Exact authenticated fault-bearing manifest entry.
 * @returns Scenario-specific runtime failpoint.
 */
function readFaultFailpoint(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence['failpoint'] {
  switch (entry.scenario) {
    case 'artifact-before-checkpoint-kill':
      return 'planning-page-artifact-uploaded-before-checkpoint-commit'
    case 'transaction-response-loss':
      return 'planning-page-transaction-response-lost'
    case 'lease-expiry-takeover':
      return 'lease-acquired-before-first-heartbeat'
    case 'cursor-before-commit-kill':
      return 'apply-checkpoint-cursor-captured-before-commit'
    case 'cursor-after-commit-kill':
      return 'apply-checkpoint-cursor-committed-before-return'
    case 'partial-apply-rollback':
      return 'apply-operation-committed-before-return'
    default:
      throw new Error('Unexpected non-fault scenario.')
  }
}

/**
 * Creates the complete normalized adapter observation for one fault stage.
 *
 * @param entry - Exact authenticated fault-bearing manifest entry.
 * @param leaseIdentityDigest - Stable lease identity owning the fault.
 * @returns Frozen failpoint-specific secret-free observation.
 */
function createFaultObservation(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  leaseIdentityDigest: string,
): WorkspaceSearchMigrationRehearsalFaultObservation {
  const failpoint = readFaultFailpoint(entry)
  const common = {
    leaseIdentityDigest,
  }
  if (
    failpoint ===
      'planning-page-artifact-uploaded-before-checkpoint-commit' ||
    failpoint === 'planning-page-transaction-response-lost'
  ) {
    const committed =
      failpoint === 'planning-page-transaction-response-lost'
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'planning-page',
      failpoint,
      durableAppliedOperationCount: 0,
      sealedPlanOperationCount: null,
      closedWriterFenceRecordDigest:
        digest(`closed-fence:${entry.scenario}`),
      durableHeadPosition: committed ? 'committed-successor' : 'predecessor',
      durableHeadPageSequence: committed ? 2 : 1,
      durableHeadEvidenceDigest: digest(`fault-head:${entry.scenario}`),
      durableHeadCheckpointDigest:
        digest(`fault-checkpoint:${entry.scenario}`),
      durableHeadProgressDigest:
        digest(`fault-progress:${entry.scenario}`),
      durableHeadCursorState: 'present',
      durableHeadCompleted: false,
      planningTarget: Object.freeze({
        kind: 'source',
        source: 'documents',
        pageSequence: 2,
        cursorState: 'present',
      }),
    })
  }
  if (
    failpoint === 'apply-checkpoint-cursor-captured-before-commit' ||
    failpoint === 'apply-checkpoint-cursor-committed-before-return'
  ) {
    const committed =
      failpoint === 'apply-checkpoint-cursor-committed-before-return'
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'apply-checkpoint',
      failpoint,
      durableAppliedOperationCount: 2,
      sealedPlanOperationCount: 2,
      closedWriterFenceRecordDigest:
        digest(`closed-fence:${entry.scenario}`),
      checkpointLocation: 'documents',
      durableStatePosition: committed ? 'committed-successor' : 'predecessor',
      durableStateRevision: entry.ordinal * 2,
      durableStateStatus: 'applying',
      durableRunStateDigest: digest(`fault-run-state:${entry.scenario}`),
      durableCheckpointDigest:
        digest(`fault-checkpoint:${entry.scenario}`),
      durableCheckpointPageSequence: committed ? 2 : 1,
      durableCheckpointCursorState: 'present',
      durableCheckpointCompleted: false,
    })
  }
  if (failpoint === 'apply-operation-committed-before-return') {
    const runStateDigest = digest(`fault-run-state:${entry.scenario}`)
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'apply-operation',
      failpoint,
      durableAppliedOperationCount: 1,
      sealedPlanOperationCount: 2,
      closedWriterFenceRecordDigest:
        digest(`closed-fence:${entry.scenario}`),
      returnedStateRevision: entry.ordinal * 2,
      returnedRunStateDigest: runStateDigest,
      returnedAppliedOperationCount: 1,
      returnedSealedPlanOperationCount: 2,
      durableStateRevision: entry.ordinal * 2,
      durableStateStatus: 'applying',
      durableRunStateDigest: runStateDigest,
    })
  }
  return Object.freeze({
    ...common,
    observationVersion: 1,
    kind: 'lease',
    failpoint,
    durableAppliedOperationCount: 0,
    sealedPlanOperationCount: null,
    closedWriterFenceRecordDigest: null,
  })
}

/**
 * Creates one strict cursor-free fault boundary for a reviewed fault stage.
 *
 * @param entry - Exact authenticated fault-bearing manifest entry.
 * @param leaseIdentityDigest - Stable lease identity owning the fault.
 * @returns Frozen individually valid fault-stage evidence.
 */
function createFaultEvidence(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  leaseIdentityDigest: string,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence {
  const failpoint = readFaultFailpoint(entry)
  const applyOperation =
    failpoint === 'apply-operation-committed-before-return'
  const applyCheckpoint =
    failpoint === 'apply-checkpoint-cursor-captured-before-commit' ||
    failpoint === 'apply-checkpoint-cursor-committed-before-return'
  const faultObservation = createFaultObservation(entry, leaseIdentityDigest)
  return Object.freeze({
    kind: 'fault-boundary',
    failpoint,
    targetDigest: digest(`fault-target:${entry.scenario}`),
    faultReceiptDigest: digest(`fault-receipt:${entry.scenario}`),
    faultObservationDigest: createMigrationDigest(faultObservation),
    faultObservation,
    leaseIdentityDigest,
    appliedOperationCount: applyOperation ? 1 : applyCheckpoint ? 2 : 0,
    sealedPlanOperationCount:
      applyOperation || applyCheckpoint ? 2 : null,
    targetPreimageArtifactContentDigest: applyOperation
      ? digest(`target-preimage:${entry.scenario}`)
      : null,
    reachedAt: stageTimestamp(entry.ordinal, 1),
  })
}

/** Creates one exact digest-only independently authenticated integrity result. */
function createReconciliationIntegrityResult(
  scenario: WorkspaceSearchMigrationRehearsalStageManifestEntry['scenario'],
  label: 'after' | 'before' | 'verified',
  checkedAt: string,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding {
  return Object.freeze({
    checkedAt,
    contentDigest: digest(`integrity-content:${scenario}:${label}`),
    byteLength: 128,
    resultDigest: digest(`integrity-result:${scenario}:${label}`),
    resultMac: digest(`integrity-mac:${scenario}:${label}`),
    runtimeProvenance: Object.freeze({
      kind:
        'mukuroji-cross-domain-integrity-rehearsal-live-provenance',
      version: 1,
      mode: 'migration-rehearsal-live',
      startedAt: checkedAt,
      completedAt: checkedAt,
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    }),
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    resourceIdentities: fixtureIntegrityResourceIdentities(),
    integrityAggregateDigest: digest(`integrity-aggregate:${scenario}`),
    resourceIdentityDigest: digest('integrity-resource-identity'),
  })
}

/** Creates one deterministic verified auxiliary rate segment. */
function createVerifiedRateSegment(
  predecessor: WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
  label: string,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const firstEventSequence =
    predecessor.firstEventSequence + predecessor.eventCount
  return Object.freeze({
    authenticationKeyFingerprint: predecessor.authenticationKeyFingerprint,
    segmentLocatorDigest: digest(`aux-rate-locator:${label}`),
    segmentOrdinal: predecessor.segmentOrdinal + 1,
    firstEventSequence,
    eventCount: 1,
    firstCommittedEventSequence: firstEventSequence,
    lastCommittedEventSequence: firstEventSequence,
    terminalRecordMac: digest(`aux-rate-mac:${label}`),
    segmentDigest: digest(`aux-rate-segment:${label}`),
  })
}

/** Creates one strict auxiliary rate binding from an immediate predecessor. */
function createAuxiliaryRateEvidence(
  predecessor: WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
  label: string,
  completedAt: string,
): WorkspaceSearchMigrationRehearsalRateSegmentEvidence {
  const successor = createVerifiedRateSegment(predecessor, label)
  const aggregate = Object.freeze({
    version: 1,
    policyVersion: digest('policy'),
    attemptCount: 1,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  })
  return Object.freeze({
    authenticationKeyFingerprint: predecessor.authenticationKeyFingerprint,
    predecessor,
    successor,
    link: Object.freeze({
      previousSegmentDigest: predecessor.segmentDigest,
      previousRecordMac: predecessor.terminalRecordMac,
      firstEventSequence: successor.firstCommittedEventSequence ?? 1,
      policyVersion: digest('policy'),
      configurationBindingDigest: digest('configuration'),
    }),
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    completedAt,
  })
}

/**
 * Creates one strict terminal reconciliation expectation for a stage.
 *
 * @param entry - Exact terminal manifest entry.
 * @param applyBoundaryDigest - Admitted applied root or partial origin.
 * @param terminalRootDigest - Authoritative terminal root digest.
 * @param sealedPlanOperationCount - Exact sealed operation count.
 * @param appliedOperationCount - Exact applied operation count.
 * @param terminalRate - Child rate segment preceding restored or audit work.
 * @param planningReceipt - Scenario planning receipt for rollback preimages.
 * @returns Complete strict reconciliation context.
 */
function createReconciliationContext(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  applyBoundaryDigest: string,
  terminalRootDigest: string,
  sealedPlanOperationCount: number,
  appliedOperationCount: number,
  terminalRate: WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): WorkspaceSearchMigrationRehearsalReconciliationAuditContext {
  const scenario = entry.scenario
  const rollback = scenario === 'partial-apply-rollback' ||
    scenario === 'complete-apply-rollback'
  const partial = scenario === 'partial-apply-rollback'
  const terminalAt = stageTimestamp(entry.ordinal, 1)
  const checkedAt = stageTimestamp(entry.ordinal, 1.9)
  const core: WorkspaceSearchMigrationRehearsalReconciliationCoreContext =
    Object.freeze({
      scenario,
      runLocatorDigest: digest(`run:${scenario}`),
      configurationBindingDigest: digest('configuration'),
      sealedPlanningAuthorityDigest: digest(`authority:${scenario}`),
      executionRunDigest: digest(`execution-run:${scenario}`),
      planDigest: digest(`plan:${scenario}`),
      applyBoundaryDigest,
      terminalRootKind: rollback ? 'rolled-back' : 'verified',
      terminalRootVersion: partial ? 2 : 1,
      terminalRootDigest,
      sealedPlanOperationCount,
      appliedOperationCount,
      terminalAt,
      checkedAt,
    })
  const migrationContextDigest = createMigrationDigest({
    kind:
      'workspace-search-migration-rehearsal-terminal-integrity-migration-context',
    version: 1,
    ...core,
  })
  if (!rollback) {
    const result = createReconciliationIntegrityResult(
      scenario,
      'verified',
      stageTimestamp(entry.ordinal, 1.4),
    )
    const fields:
      WorkspaceSearchMigrationRehearsalVerifiedIntegrityCollectorResult =
        Object.freeze({
          kind: 'verified-result',
          status: 'pass',
          failureCount: 0,
          completedAt: stageTimestamp(entry.ordinal, 1.6),
          result,
          terminalRootDigest,
          integrityAggregateDigest:
            digest(`integrity-aggregate:${scenario}`),
        })
    return Object.freeze({
      ...core,
      integrity: Object.freeze({
        ...fields,
        resultContextDigest: createMigrationDigest({
          domain:
            'workspace-search-migration-rehearsal-terminal-integrity-result-context',
          version: 1,
          scenario,
          migrationContextDigest,
          ...fields,
        }),
        migrationContextDigest,
      }),
      targetAudits: null,
    })
  }
  const purpose = partial ? 'partial-rollback' : 'complete-rollback'
  const before = createReconciliationIntegrityResult(
    scenario,
    'before',
    stageTimestamp(planningReceipt.stageOrdinal, 1.5),
  )
  const after = createReconciliationIntegrityResult(
    scenario,
    'after',
    stageTimestamp(entry.ordinal, 1.4),
  )
  const startedAt = stageTimestamp(planningReceipt.stageOrdinal, 1.4)
  const applyStartedAt = stageTimestamp(planningReceipt.stageOrdinal, 2)
  const completedAt = stageTimestamp(entry.ordinal, 1.6)
  const comparisonDigest = createMigrationDigest({
    purpose,
    beforeResultDigest: before.resultDigest,
    afterResultDigest: after.resultDigest,
    comparison: Object.freeze({
      kind:
        'mukuroji-cross-domain-integrity-migration-rehearsal-comparison',
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      status: 'pass',
    }),
  })
  const targetAggregateDigest = digest(`target-aggregate:${scenario}`)
  const preimageRate = createAuxiliaryRateEvidence(
    planningReceipt.rateSegment,
    `target-preimage:${scenario}`,
    stageTimestamp(planningReceipt.stageOrdinal, 1.8),
  )
  const restoredRate = createAuxiliaryRateEvidence(
    terminalRate,
    `target-restored:${scenario}`,
    stageTimestamp(entry.ordinal, 1.8),
  )
  const targetContextDigest = digest(`target-context:${scenario}`)
  const targetAudits:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair =
      Object.freeze({
        preimage: Object.freeze({
          purpose: `${purpose}-preimage`,
          contentDigest: digest(`target-preimage:${scenario}`),
          byteLength: 256,
          startedAt: stageTimestamp(planningReceipt.stageOrdinal, 1.6),
          observedAt: stageTimestamp(planningReceipt.stageOrdinal, 1.7),
          observationDigest:
            digest(`target-observation:${scenario}:preimage`),
          aggregateDigest: targetAggregateDigest,
          integrityBefore: before,
          contextDigest: targetContextDigest,
          rate: preimageRate,
        }),
        restored: Object.freeze({
          purpose: `${purpose}-restored`,
          contentDigest: digest(`target-rollback:${scenario}`),
          byteLength: 257,
          startedAt: stageTimestamp(entry.ordinal, 1.5),
          observedAt: stageTimestamp(entry.ordinal, 1.7),
          observationDigest: digest(`target-observation:${scenario}`),
          aggregateDigest: targetAggregateDigest,
          integrityBefore: null,
          contextDigest: targetContextDigest,
          rate: restoredRate,
        }),
      })
  return Object.freeze({
    ...core,
    integrity: Object.freeze({
      kind: 'rollback-comparison',
      purpose,
      status: 'pass',
      failureCount: 0,
      startedAt,
      applyStartedAt,
      terminalAt,
      completedAt,
      before,
      after,
      comparisonDigest,
      comparisonContextDigest: createMigrationDigest({
        kind: 'workspace-search-migration-rehearsal-integrity-context',
        version: 1,
        purpose,
        startedAt,
        applyStartedAt,
        terminalAt,
        completedAt,
        before,
        after,
        comparisonDigest,
      }),
      terminalRootDigest,
      targetPreimageAggregateDigest: targetAggregateDigest,
      targetRestoredAggregateDigest: targetAggregateDigest,
      targetPreimageStatus: 'equal',
      migrationContextDigest,
    }),
    targetAudits,
  })
}

/**
 * Creates one individually valid non-fault stage evidence projection.
 *
 * @param entry - Exact authenticated manifest entry.
 * @param previousReceipt - Immediate command predecessor when present.
 * @param currentRateSegment - Exact child rate segment for this stage.
 * @param planningReceipt - Scenario planning receipt for terminal audits.
 * @returns Frozen evidence whose discriminator maps to the selected command.
 */
function createNonFaultEvidence(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
  currentRateSegment: WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
): WorkspaceSearchMigrationRehearsalStageEvidence {
  if (entry.command === 'close-replan') {
    return Object.freeze({
      kind: 'planning-sealed',
      executionBoundaryDigest: digest(`boundary:${entry.scenario}`),
      closedWriterFenceRecordDigest: digest(`closed-fence:${entry.scenario}`),
      sealedPlanningAuthorityDigest: digest(`authority:${entry.scenario}`),
      planDigest: digest(`plan:${entry.scenario}`),
      sealedPlanOperationCount: 2,
      sourceOperationCount: 1,
      orphanOperationCount: 1,
      closedAt: stageTimestamp(entry.ordinal, 0.1),
      drainStartedAt: stageTimestamp(entry.ordinal, 0.2),
      drainCompletedAt: stageTimestamp(entry.ordinal, 0.3),
      admittedAt: stageTimestamp(entry.ordinal, 0.4),
      planCreatedAt: stageTimestamp(entry.ordinal, 0.5),
      sealedAt: stageTimestamp(entry.ordinal, 0.6),
    })
  }
  if (entry.command === 'apply') {
    return Object.freeze({
      kind: 'apply-complete',
      executionRunDigest: digest(`execution-run:${entry.scenario}`),
      planDigest: digest(`plan:${entry.scenario}`),
      sealedPlanOperationCount: 2,
      appliedOperationCount: 2,
      appliedRootDigest: digest(`applied-root:${entry.scenario}`),
      targetPreimageArtifactContentDigest:
        entry.scenario === 'complete-apply-rollback'
          ? digest(`target-preimage:${entry.scenario}`)
          : null,
      appliedAt: stageTimestamp(entry.ordinal, 1),
    })
  }
  if (entry.command === 'release') {
    return Object.freeze({
      kind: 'released',
      terminalKind: 'verified',
      terminalPersistenceVersion: 1,
      terminalRootDigest: digest(`terminal-root:${entry.scenario}`),
      releasedWriterFenceRecordDigest:
        digest(`released-fence:${entry.scenario}`),
      releasedAt: stageTimestamp(entry.ordinal, 1),
    })
  }
  const partial = entry.command === 'rollback-partial'
  if (previousReceipt === undefined) {
    throw new Error('Missing terminal apply-boundary receipt.')
  }
  if (planningReceipt === undefined) {
    throw new Error('Missing terminal planning receipt.')
  }
  const rollback = partial || entry.command === 'rollback-complete'
  const expectedPurpose = partial
    ? 'partial-rollback'
    : entry.command === 'rollback-complete'
    ? 'complete-rollback'
    : 'verified'
  const terminalRootDigest = digest(`terminal-root:${entry.scenario}`)
  const targetPreimageArtifactContentDigest = rollback
    ? digest(`target-preimage:${entry.scenario}`)
    : null
  const targetRollbackArtifactContentDigest = rollback
    ? digest(`target-rollback:${entry.scenario}`)
    : null
  const targetRollbackObservationDigest = rollback
    ? digest(`target-observation:${entry.scenario}`)
    : null
  const applyBoundaryDigest = partial
    ? digest(`partial-origin:${entry.scenario}`)
    : previousReceipt.evidence.kind === 'apply-complete'
    ? previousReceipt.evidence.appliedRootDigest
    : (() => {
        throw new Error('Missing complete applied-root evidence.')
      })()
  const reconciliationContext = createReconciliationContext(
    entry,
    applyBoundaryDigest,
    terminalRootDigest,
    2,
    partial ? 1 : 2,
    currentRateSegment,
    planningReceipt,
  )
  const integrityBeforeResultDigest =
    reconciliationContext.integrity.kind === 'rollback-comparison'
      ? reconciliationContext.integrity.before.resultDigest
      : null
  const integrityAfterResultDigest =
    reconciliationContext.integrity.kind === 'rollback-comparison'
      ? reconciliationContext.integrity.after.resultDigest
      : reconciliationContext.integrity.result.resultDigest
  const integrityComparisonDigest =
    reconciliationContext.integrity.kind === 'rollback-comparison'
      ? reconciliationContext.integrity.comparisonDigest
      : null
  const integrityContextDigest =
    reconciliationContext.integrity.kind === 'rollback-comparison'
      ? reconciliationContext.integrity.comparisonContextDigest
      : reconciliationContext.integrity.resultContextDigest
  const reconciliationPredecessor = reconciliationContext.targetAudits === null
    ? currentRateSegment
    : reconciliationContext.targetAudits.restored.rate.successor
  const reconciliationRate = createAuxiliaryRateEvidence(
    reconciliationPredecessor,
    `reconciliation:${entry.scenario}`,
    stageTimestamp(entry.ordinal, 2),
  )
  return Object.freeze({
    kind: 'terminal',
    command: entry.command,
    terminalKind: entry.command === 'verify' ? 'verified' : 'rolled-back',
    terminalPersistenceVersion: partial ? 2 : 1,
    terminalRootDigest,
    executionBoundaryDigest: digest(`boundary:${entry.scenario}`),
    sealedPlanningAuthorityDigest: digest(`authority:${entry.scenario}`),
    executionRunDigest: digest(`execution-run:${entry.scenario}`),
    planDigest: digest(`plan:${entry.scenario}`),
    sealedPlanOperationCount: 2,
    appliedOperationCount: partial ? 1 : 2,
    integrityPurpose: expectedPurpose,
    integrityBeforeResultDigest,
    integrityAfterResultDigest,
    integrityComparisonDigest,
    integrityContextDigest,
    targetRollbackArtifactContentDigest,
    targetRollbackObservationDigest,
    duplicateApplyCount: 0,
    lostItemCount: 0,
    orphanAuthorityCount: 0,
    reconciliationContext,
    reconciliationArtifactBindingDigest:
      digest(`reconciliation-binding:${entry.scenario}`),
    reconciliationArtifactContentDigest:
      digest(`reconciliation-content:${entry.scenario}`),
    reconciliationArtifactByteLength: 4_096,
    reconciliationArtifactAuditDigest:
      digest(`reconciliation-artifact-audit:${entry.scenario}`),
    reconciliationRate,
    reconciliationAuditDigest:
      createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest({
        scenario: entry.scenario,
        terminalRootDigest,
        integrityContextDigest,
        targetPreimageArtifactContentDigest,
        targetRollbackArtifactContentDigest,
        targetRollbackObservationDigest,
        duplicateApplyCount: 0,
        lostItemCount: 0,
        orphanAuthorityCount: 0,
      }),
    terminalAt: stageTimestamp(entry.ordinal, 1),
  })
}

/**
 * Creates one exact trusted parent process lifecycle for a fixture receipt.
 *
 * @param entry - Exact authenticated manifest entry.
 * @returns Frozen outcome-compatible lifecycle within the stage window.
 */
function createProcessLifecycle(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalStageReceiptClaims['processLifecycle'] {
  const interrupted = entry.expectedOutcome === 'fault-reached'
  const responseLoss =
    entry.expectedOutcome === 'response-loss-reconciled'
  return Object.freeze({
    lifecycleDigest: digest(`lifecycle:${entry.ordinal}`),
    runnerStartedAt: stageTimestamp(entry.ordinal, 0),
    receiptObservedAt: stageTimestamp(entry.ordinal, interrupted ? 1 : 2),
    receiptPersistedAt: stageTimestamp(entry.ordinal, 3),
    parentDecisionRecordedAt: interrupted || responseLoss
      ? stageTimestamp(entry.ordinal, 4)
      : null,
    processExitedAt: stageTimestamp(entry.ordinal, 5),
    exitClass: interrupted
      ? 'confirmed-sigkill'
      : responseLoss
      ? 'successful-response-loss'
      : 'successful-no-fault',
  })
}

/**
 * Creates one authenticated receipt for an exact manifest stage.
 *
 * @param manifest - Authenticated reviewed full-suite manifest.
 * @param entry - Exact current manifest entry.
 * @param previousReceipt - Immediate authenticated receipt when present.
 * @param planningReceipt - Scenario planning receipt when already committed.
 * @param previousReceiptDigest - Exact preceding receipt digest or null.
 * @param leaseObservation - Exact current durable lease observation.
 * @param leaseIdentityDigest - Identity represented by the observation.
 * @param signingKey - Shared receipt authentication key.
 * @param rateSegmentOrdinal - Global child-segment ordinal after auxiliaries.
 * @param completedAt - Latest authenticated completion evidence timestamp.
 * @param runLocatorDigest - Restricted digest of the exact scenario run.
 * @param claimRevision - Durable revision that activated the reservation.
 * @param abandonmentCount - Cumulative parent-authenticated abandonment count.
 * @param abandonmentRootDigest - Cumulative parent-authenticated chain root.
 * @returns Frozen HMAC-authenticated stage receipt.
 */
function createReceipt(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
  previousReceiptDigest: string | null,
  leaseObservation: WorkspaceSearchMigrationRehearsalStageLeaseObservation,
  leaseIdentityDigest: string,
  signingKey: Uint8Array,
  rateSegmentOrdinal: number,
  completedAt: string,
  runLocatorDigest: string,
  claimRevision: number,
  abandonmentCount = 0,
  abandonmentRootDigest =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const manifestDigest = createMigrationDigest(manifest)
  const eventSequence = rateSegmentOrdinal + 1
  const rateSegment = Object.freeze({
    authenticationKeyFingerprint:
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        signingKey,
      ),
    segmentLocatorDigest: digest(`segment-locator:${entry.ordinal}`),
    segmentOrdinal: rateSegmentOrdinal,
    firstEventSequence: eventSequence,
    eventCount: 1,
    firstCommittedEventSequence: eventSequence,
    lastCommittedEventSequence: eventSequence,
    terminalRecordMac: digest(`segment-mac:${entry.ordinal}`),
    segmentDigest: digest(`segment:${entry.ordinal}`),
  })
  const faultBoundary = entry.faultPlanDigest === null
    ? null
    : createFaultEvidence(entry, leaseIdentityDigest)
  let evidence: WorkspaceSearchMigrationRehearsalStageEvidence
  if (entry.expectedOutcome === 'fault-reached') {
    if (faultBoundary === null) throw new Error('Missing fault boundary.')
    evidence = faultBoundary
  } else {
    evidence = createNonFaultEvidence(
      entry,
      previousReceipt,
      rateSegment,
      planningReceipt,
    )
  }
  const responseLoss =
    entry.expectedOutcome === 'response-loss-reconciled'
  const takeover = entry.expectedOutcome === 'takeover-completed'
  return createWorkspaceSearchMigrationRehearsalStageReceipt({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
      receiptVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
      stage: 'non-production',
      scenario: entry.scenario,
      stageOrdinal: entry.ordinal,
      scenarioStageOrdinal: entry.scenarioStageOrdinal,
      command: entry.command,
      controlArgumentsDigest: entry.controlArgumentsDigest,
      serializedOutputLineDigest: digest(`output:${entry.ordinal}`),
      manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
      permitDigest: manifest.permitDigest,
      commit: manifest.commit,
      requestedResourcesBinding: manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities: manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        manifest.integrityResourceIdentityDigest,
      configurationBindingDigest: manifest.configurationBindingDigest,
      policyVersion: manifest.policyVersion,
      runLocatorDigest,
      attemptOrdinal: entry.attemptOrdinal,
      attemptLocatorDigest:
        digest(`attempt:${entry.scenario}:${entry.attemptOrdinal}`),
      ownerLocatorDigest:
        digest(`owner:${entry.scenario}:${entry.attemptOrdinal}`),
      leaseIdentityDigest,
      leaseObservation,
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest: digest(`writer-fence:${entry.ordinal}`),
      previousStageReceiptDigest: previousReceiptDigest,
      stageReservationDigest: digest(`reservation:${entry.ordinal}`),
      stageReservationClaimRevision: claimRevision,
      stageReservationCommitRevision: claimRevision + 1,
      stageReservationAbandonmentCount: abandonmentCount,
      stageReservationAbandonmentRootDigest: abandonmentRootDigest,
      startedAt: stageTimestamp(entry.ordinal, 0),
      completedAt,
      processLifecycle: createProcessLifecycle(entry),
      outcome: entry.expectedOutcome,
      faultReceiptDigest: faultBoundary?.faultReceiptDigest ??
        (takeover ? digest(`fault-receipt:${entry.scenario}`) : null),
      faultBoundary,
      predecessorLeaseExpiresAt: takeover
        ? stageTimestamp(entry.ordinal, 0)
        : null,
      takeoverAcquiredAt: takeover
        ? stageTimestamp(entry.ordinal, 1)
        : null,
      reconciledAt: responseLoss
        ? stageTimestamp(entry.ordinal, 2.5)
        : null,
      evidence,
      rateSegment,
    },
    signingKey,
  })
}

/** Creates the exact command-specific compact gate for one fixture receipt. */
function createCommitGate(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): WorkspaceSearchMigrationRehearsalStageCommitEvidence['commitGate'] {
  if (
    receipt.evidence.kind === 'planning-sealed' &&
    (receipt.scenario === 'partial-apply-rollback' ||
      receipt.scenario === 'complete-apply-rollback')
  ) {
    const purpose = receipt.scenario === 'partial-apply-rollback'
      ? 'partial-rollback-preimage'
      : 'complete-rollback-preimage'
    const rate = createAuxiliaryRateEvidence(
      receipt.rateSegment,
      `target-preimage:${receipt.scenario}`,
      stageTimestamp(receipt.stageOrdinal, 1.8),
    )
    return Object.freeze({
      kind: 'target-preimage',
      artifactBindingDigest:
        digest(`target-binding:${receipt.scenario}:preimage`),
      contentDigest: digest(`target-preimage:${receipt.scenario}`),
      byteLength: 256,
      purpose,
      contextDigest: digest(`target-context:${receipt.scenario}`),
      commitGateObservedAt: receipt.completedAt,
      observationDigest:
        digest(`target-observation:${receipt.scenario}:preimage`),
      aggregateDigest: digest(`target-aggregate:${receipt.scenario}`),
      rateSuccessor: rate.successor,
      rateAggregateDigest: rate.aggregateDigest,
      rateCompletedAt: rate.completedAt,
    })
  }
  if (receipt.evidence.kind === 'terminal') {
    return Object.freeze({
      kind: 'terminal-reconciliation',
      artifactBindingDigest:
        receipt.evidence.reconciliationArtifactBindingDigest,
      contentDigest:
        receipt.evidence.reconciliationArtifactContentDigest,
      byteLength: receipt.evidence.reconciliationArtifactByteLength,
      scenario: receipt.scenario,
      auditDigest: receipt.evidence.reconciliationArtifactAuditDigest,
      contextDigest:
        createMigrationDigest(receipt.evidence.reconciliationContext),
      rateSuccessor: receipt.evidence.reconciliationRate.successor,
      rateAggregateDigest:
        receipt.evidence.reconciliationRate.aggregateDigest,
      rateCompletedAt: receipt.evidence.reconciliationRate.completedAt,
    })
  }
  return Object.freeze({ kind: 'none' })
}

/**
 * Creates one exact canonical commit evidence for an authenticated receipt.
 *
 * @param manifestDigest - Digest of the exact authenticated manifest.
 * @param receipt - Authenticated receipt committed by this evidence.
 * @param signingKey - Shared commit-evidence authentication key.
 * @param commitAdmittedAt - Trusted pre-transaction admission timestamp.
 * @param commitRevision - Optional authenticated revision override.
 * @param commitGate - Optional authenticated gate override for negatives.
 * @returns Frozen HMAC-authenticated commit evidence.
 */
function createCommitEvidence(
  manifestDigest: string,
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  signingKey: Uint8Array,
  commitAdmittedAt: string,
  commitRevision = receipt.stageReservationCommitRevision,
  commitGate:
    WorkspaceSearchMigrationRehearsalStageCommitEvidence['commitGate'] =
      createCommitGate(receipt),
): WorkspaceSearchMigrationRehearsalStageCommitEvidence {
  const receiptDigest = createMigrationDigest(receipt)
  const reservationExpiresMilliseconds = Date.parse(commitAdmittedAt) + 2_000
  const recoveryDeadlineMilliseconds = reservationExpiresMilliseconds +
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS
  return createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
      evidenceVersion: 1,
      stage: 'non-production',
      manifestDigest,
      permitDigest: receipt.permitDigest,
      requestedResourcesBinding: receipt.requestedResourcesBinding,
      stateTableLocationBindingDigest:
        createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
          stateTableName: stageCommitChainStateTableName,
          requestedResourcesBinding: receipt.requestedResourcesBinding,
        }),
      publicationKeyDigest: createHash('sha256')
        .update(signingKey)
        .digest('hex'),
      parentAuthenticationDigest:
        digest(`parent-authentication:${receipt.stageOrdinal}`),
      parentAuthorizationBindingDigest:
        digest(`parent-authorization:${receipt.stageOrdinal}`),
      stageOrdinal: receipt.stageOrdinal,
      stageReservationDigest: receipt.stageReservationDigest,
      stageReservationClaimRevision:
        receipt.stageReservationClaimRevision,
      receiptDigest,
      commitRevision,
      head: Object.freeze({
        manifestDigest,
        completedStageOrdinal: receipt.stageOrdinal,
        headReceiptDigest: receiptDigest,
        activeReservationDigest: null,
        activeStageOrdinal: null,
        activeExpiresAt: null,
        abandonmentCount: receipt.stageReservationAbandonmentCount,
        abandonmentRootDigest:
          receipt.stageReservationAbandonmentRootDigest,
        revision: commitRevision,
      }),
      commitGate,
      recoveryAuthorization: Object.freeze({
        reservationExpiresAt:
          new Date(reservationExpiresMilliseconds).toISOString(),
        permitExpiresAt:
          new Date(recoveryDeadlineMilliseconds + 900_000).toISOString(),
        recoveryDeadlineAt:
          new Date(recoveryDeadlineMilliseconds).toISOString(),
        receiptCompletedAt: receipt.completedAt,
        processExitedAt: receipt.processLifecycle.processExitedAt,
        materialEvidenceDigest:
          digest(`material-evidence:${receipt.stageOrdinal}`),
        boundaryMaterialEvidenceDigest: null,
        materialDigest: digest(`material:${receipt.stageOrdinal}`),
        claimedStageHeadDigest:
          digest(`claimed-head:${receipt.stageOrdinal}`),
        lifecycleEvidenceDigest:
          digest(`lifecycle-evidence:${receipt.stageOrdinal}`),
        lifecycleDigest: receipt.processLifecycle.lifecycleDigest,
        runtimeKeyCleanupAuthorizationBindingDigest:
          digest(`cleanup-authorization:${receipt.stageOrdinal}`),
        cleanupIntentDigest:
          digest(`cleanup-intent:${receipt.stageOrdinal}`),
        cleanupCompletionDigest:
          digest(`cleanup-completion:${receipt.stageOrdinal}`),
        cleanupPreparedAt: receipt.processLifecycle.processExitedAt,
        cleanupCompletedAt: receipt.processLifecycle.processExitedAt,
      }),
      admissionMode: 'ordinary',
      commitAdmittedAt,
      durableStatus: 'committed',
    },
    signingKey,
  })
}

/**
 * Creates one complete authentic 36-stage receipt and commit-evidence chain.
 *
 * @param firstCompletedAtOffsetSeconds - Stage-one completion offset override.
 * @param firstRunLocatorDigest - Optional authenticated stage-one run drift.
 * @param firstClaimRevision - Optional authenticated stage-one claim revision.
 * @param abandonmentAtOrdinal - Optional stage preceded by abandonments.
 * @param abandonmentRootOverride - Optional forged cumulative root.
 * @param omitAbandonmentRevisions - Whether to forge the revision delta.
 * @param abandonmentTotal - Exact number of real transitions at that stage.
 * @returns Fresh detached artifacts sharing one authentication key.
 */
async function createFixture(
  firstCompletedAtOffsetSeconds = 2,
  firstRunLocatorDigest?: string,
  firstClaimRevision = 1,
  abandonmentAtOrdinal?: number,
  abandonmentRootOverride?: string,
  omitAbandonmentRevisions = false,
  abandonmentTotal = 1,
): Promise<StageCommitEvidenceChainFixture> {
  const base =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
  const verificationKey = new Uint8Array(base.authenticationKey)
  const publicationVerificationKey =
    new Uint8Array(base.publicationAuthenticationKey)
  const manifest = base.manifest
  const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
  const evidences: WorkspaceSearchMigrationRehearsalStageCommitEvidence[] = []
  const reservationAbandonments: StageCommitRecoveryAbandonmentPair[] = []
  const activeLeaseIdentities = new Map<string, string>()
  let previousReceiptDigest: string | null = null
  let previousCommitRevision = 0
  let nextRateSegmentOrdinal = 0
  let abandonmentCount = 0
  let abandonmentRootDigest =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST
  for (const entry of manifest.entries) {
    const priorReceipt = receipts.at(-1)
    const priorCommitGate = evidences.at(-1)?.commitGate
    const expectedPreviousRateSegment =
      entry.command === 'release' &&
        priorCommitGate?.kind === 'terminal-reconciliation'
        ? priorCommitGate.rateSuccessor
        : entry.command === 'apply' &&
            (entry.scenario === 'complete-apply-rollback' ||
              entry.scenario === 'partial-apply-rollback') &&
            priorCommitGate?.kind === 'target-preimage'
          ? priorCommitGate.rateSuccessor
          : priorReceipt?.rateSegment ?? null
    let abandonmentDelta = 0
    if (entry.ordinal === abandonmentAtOrdinal) {
      abandonmentDelta = abandonmentTotal
      const selection = Object.freeze({
        manifest,
        manifestDigest: createMigrationDigest(manifest),
        entry,
        previousStageReceiptDigest: previousReceiptDigest,
      })
      let abandonmentRevision = previousCommitRevision
      for (let index = 0; index < abandonmentDelta; index += 1) {
        const offset = -50 + index * 901.25
        const reservation =
          createWorkspaceSearchMigrationRehearsalStageReservation({
            selection,
            nonce: createHash('sha256')
              .update(`abandonment:${entry.ordinal}:${index}`, 'utf8')
              .digest(),
            reservedAt: stageTimestamp(entry.ordinal, offset),
            expiresAt: stageTimestamp(entry.ordinal, offset + 0.5),
            expectedPreviousRateSegment,
            expectedCurrentRateSegmentOrdinal:
              expectedPreviousRateSegment === null
                ? 0
                : expectedPreviousRateSegment.segmentOrdinal + 1,
            expectedTargetPreimageArtifactContentDigest:
              entry.command === 'apply' &&
                (entry.scenario === 'complete-apply-rollback' ||
                  entry.scenario === 'partial-apply-rollback') &&
                priorCommitGate?.kind === 'target-preimage'
                ? priorCommitGate.contentDigest
                : null,
            signingKey: verificationKey,
          })
        const abandonment =
          createWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
            reservation,
            selection,
            reservationClaimRevision: abandonmentRevision + 1,
            previousAbandonmentCount: abandonmentCount,
            previousAbandonmentRootDigest: abandonmentRootDigest,
            abandonedAt: stageTimestamp(entry.ordinal, offset + 900.5),
            runtimeKeyCleanupCompletionDigest: digest(
              `runtime-key-cleanup:${entry.ordinal}:${index}`,
            ),
            runtimeVerificationKey: verificationKey,
            publicationSigningKey: publicationVerificationKey,
          })
        reservationAbandonments.push(Object.freeze({
          reservation,
          abandonment,
        }))
        abandonmentRevision = abandonment.abandonmentRevision
        abandonmentCount = abandonment.abandonmentCount
        abandonmentRootDigest = abandonment.abandonmentRootDigest
      }
      abandonmentRootDigest = abandonmentRootOverride ??
        abandonmentRootDigest
    }
    const existingLeaseIdentity = activeLeaseIdentities.get(entry.scenario)
    const takeover = entry.expectedOutcome === 'takeover-completed'
    let leaseIdentityDigest: string
    let leaseObservation:
      WorkspaceSearchMigrationRehearsalStageLeaseObservation
    if (existingLeaseIdentity === undefined) {
      leaseIdentityDigest = digest(`lease:${entry.scenario}:1`)
      leaseObservation = Object.freeze({
        kind: 'acquired',
        predecessorLeaseIdentityDigest: null,
        predecessorLeaseExpiresAt: null,
        acquiredAt: stageTimestamp(entry.ordinal, 0),
        successorLeaseIdentityDigest: leaseIdentityDigest,
        successorLeaseExpiresAt: stageTimestamp(entry.ordinal, 3_600),
      })
    } else if (takeover) {
      leaseIdentityDigest = digest(`lease:${entry.scenario}:2`)
      leaseObservation = Object.freeze({
        kind: 'acquired',
        predecessorLeaseIdentityDigest: existingLeaseIdentity,
        predecessorLeaseExpiresAt: stageTimestamp(entry.ordinal, 0),
        acquiredAt: stageTimestamp(entry.ordinal, 1),
        successorLeaseIdentityDigest: leaseIdentityDigest,
        successorLeaseExpiresAt: stageTimestamp(entry.ordinal, 3_600),
      })
    } else {
      leaseIdentityDigest = existingLeaseIdentity
      leaseObservation = Object.freeze({
        kind: 'reused-active',
        currentLeaseIdentityDigest: leaseIdentityDigest,
        evaluatedAt: stageTimestamp(entry.ordinal, 0),
        currentLeaseExpiresAt: stageTimestamp(entry.ordinal, 3_600),
      })
    }
    activeLeaseIdentities.set(entry.scenario, leaseIdentityDigest)
    const planningReceipt = receipts.findLast(
      (candidate) =>
        candidate.scenario === entry.scenario &&
        candidate.evidence.kind === 'planning-sealed',
    )
    const receipt = createReceipt(
      manifest,
      entry,
      receipts.at(-1),
      planningReceipt,
      previousReceiptDigest,
      leaseObservation,
      leaseIdentityDigest,
      verificationKey,
      nextRateSegmentOrdinal,
      stageTimestamp(
        entry.ordinal,
        entry.ordinal === 1
          ? firstCompletedAtOffsetSeconds
          : entry.expectedOutcome === 'fault-reached'
          ? 1
          : entry.expectedOutcome === 'response-loss-reconciled'
          ? 3
          : 2,
      ),
      entry.ordinal === 1 && firstRunLocatorDigest !== undefined
        ? firstRunLocatorDigest
        : digest(`run:${entry.scenario}`),
      entry.ordinal === 1
        ? firstClaimRevision
        : previousCommitRevision +
          (omitAbandonmentRevisions ? 0 : abandonmentDelta * 2) + 1,
      abandonmentCount,
      abandonmentRootDigest,
    )
    const evidence = createCommitEvidence(
      createMigrationDigest(manifest),
      receipt,
      publicationVerificationKey,
      stageTimestamp(entry.ordinal, 6),
    )
    receipts.push(receipt)
    evidences.push(evidence)
    nextRateSegmentOrdinal += 1
    if (
      receipt.evidence.kind === 'planning-sealed' &&
      (receipt.scenario === 'partial-apply-rollback' ||
        receipt.scenario === 'complete-apply-rollback')
    ) nextRateSegmentOrdinal += 1
    if (receipt.evidence.kind === 'terminal') {
      nextRateSegmentOrdinal += receipt.evidence.command === 'verify' ? 1 : 2
    }
    previousReceiptDigest = createMigrationDigest(receipt)
    previousCommitRevision = receipt.stageReservationCommitRevision
  }
  const durabilityRecovery =
    await createStageCommitChainDurabilityAuthorizations(
      manifest,
      receipts,
      evidences,
      reservationAbandonments,
      verificationKey,
      publicationVerificationKey,
    )
  return Object.freeze({
    verificationKey,
    publicationVerificationKey,
    permit: base.permit,
    manifest,
    receipts: Object.freeze(receipts),
    evidences: Object.freeze(evidences),
    reservationAbandonments: Object.freeze(reservationAbandonments),
    durabilityAuthorizations: durabilityRecovery.commitAuthorizations,
    abandonmentDurabilityAuthorization:
      durabilityRecovery.abandonmentAuthorization,
  })
}

/** Verifies one fixture and reads its branded complete chain projection. */
function verifyFixture(
  fixture: StageCommitEvidenceChainFixture,
  durabilityAuthorizations: readonly unknown[] =
    fixture.durabilityAuthorizations,
  runtimeVerificationKey: Uint8Array = fixture.verificationKey,
  publicationVerificationKey: Uint8Array =
    fixture.publicationVerificationKey,
  abandonmentDurabilityAuthorization: unknown =
    fixture.abandonmentDurabilityAuthorization,
) {
  return readWorkspaceSearchMigrationRehearsalStageCommitChainAuthorizationBinding(
    verifyWorkspaceSearchMigrationRehearsalStageCommitEvidenceChain({
      permit: fixture.permit,
      manifest: fixture.manifest,
      receipts: fixture.receipts,
      durabilityAuthorizations,
      abandonmentDurabilityAuthorization:
        abandonmentDurabilityAuthorization,
      runtimeVerificationKey,
      publicationVerificationKey,
    }),
  )
}

/** Recovers fresh capabilities after replacing one or more evidence rows. */
async function recoverFixtureEvidences(
  fixture: StageCommitEvidenceChainFixture,
  evidences: readonly WorkspaceSearchMigrationRehearsalStageCommitEvidence[],
): Promise<
  readonly WorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorization[]
> {
  const recovery = await createStageCommitChainDurabilityAuthorizations(
    fixture.manifest,
    fixture.receipts,
    evidences,
    fixture.reservationAbandonments,
    fixture.verificationKey,
    fixture.publicationVerificationKey,
  )
  return recovery.commitAuthorizations
}

describe('authenticated rehearsal stage commit evidence chain', () => {
  test('projects all 36 exact bindings and the terminal inactive head', async () => {
    const fixture = await createFixture()
    const originalKey = new Uint8Array(fixture.verificationKey)
    const projection = verifyFixture(fixture)
    const abandonmentBinding =
      readWorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding(
        fixture.abandonmentDurabilityAuthorization,
      )
    const firstCommitBinding =
      readWorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding(
        fixture.durabilityAuthorizations[0],
      )

    expect(projection.kind).toBe(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_CHAIN_KIND,
    )
    expect(projection.stageCommitCount).toBe(36)
    expect(projection.stageCommits).toHaveLength(36)
    expect(projection.manifestDigest).toBe(
      createMigrationDigest(fixture.manifest),
    )
    expect(projection.permitIssuedAt).toBe(fixture.permit.issuedAt)
    expect(projection.permitExpiresAt).toBe(fixture.permit.expiresAt)
    expect(projection.terminal).toBe(projection.stageCommits[35])
    expect(projection.terminal.stageOrdinal).toBe(36)
    expect(projection.terminal.stageReservationClaimRevision).toBe(71)
    expect(projection.terminal.stageReservationCommitRevision).toBe(72)
    expect(projection.terminal.inactiveHead).toEqual({
      manifestDigest: projection.manifestDigest,
      completedStageOrdinal: 36,
      headReceiptDigest: createMigrationDigest(fixture.receipts[35]),
      activeReservationDigest: null,
      activeStageOrdinal: null,
      activeExpiresAt: null,
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      revision: 72,
    })
    expect(abandonmentBinding).toMatchObject({
      rows: [],
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      provenance: 'dynamodb-consistent-read',
    })
    expect(abandonmentBinding.terminalRootSnapshotDigest).toBe(
      firstCommitBinding.terminalRootSnapshotDigest,
    )
    for (let index = 0; index < projection.stageCommits.length; index += 1) {
      const binding = projection.stageCommits[index]
      const receipt = fixture.receipts[index]
      if (binding === undefined || receipt === undefined) {
        throw new Error('Missing projected stage binding.')
      }
      expect(binding).toMatchObject({
        stage: receipt.stage,
        manifestDigest: createMigrationDigest(fixture.manifest),
        scenario: receipt.scenario,
        stageOrdinal: index + 1,
        scenarioStageOrdinal: receipt.scenarioStageOrdinal,
        runLocatorDigest: receipt.runLocatorDigest,
        stageReservationDigest: receipt.stageReservationDigest,
        stageReservationClaimRevision:
          receipt.stageReservationClaimRevision,
        stageReservationCommitRevision:
          receipt.stageReservationCommitRevision,
        receiptDigest: createMigrationDigest(receipt),
      })
      expect(binding.inactiveHead.revision).toBe(
        receipt.stageReservationCommitRevision,
      )
    }
    const gates = fixture.evidences.map((evidence) => evidence.commitGate)
    expect(gates.filter((gate) => gate.kind === 'target-preimage'))
      .toHaveLength(2)
    expect(gates.filter((gate) => gate.kind === 'terminal-reconciliation'))
      .toHaveLength(8)
    expect(gates.filter((gate) => gate.kind === 'none')).toHaveLength(26)
    for (let index = 0; index < gates.length; index += 1) {
      const gate = gates[index]
      if (gate === undefined || gate.kind === 'none') continue
      const nextReceipt = fixture.receipts[index + 1]
      if (nextReceipt === undefined) {
        throw new Error('Missing special-gate child successor.')
      }
      expect(nextReceipt.rateSegment.segmentOrdinal).toBe(
        gate.rateSuccessor.segmentOrdinal + 1,
      )
    }
    expect(fixture.verificationKey).toEqual(originalKey)
  })

  test('rejects authenticated commit gates on the wrong receipt kind', async () => {
    const fixture = await createFixture()
    const rollbackPlanningIndex = fixture.receipts.findIndex(
      (receipt) =>
        receipt.scenario === 'complete-apply-rollback' &&
        receipt.evidence.kind === 'planning-sealed',
    )
    const terminalIndex = fixture.receipts.findIndex(
      (receipt) =>
        receipt.scenario === 'happy-path-verified' &&
        receipt.evidence.kind === 'terminal',
    )
    const ordinaryIndex = fixture.receipts.findIndex(
      (receipt) =>
        receipt.scenario === 'happy-path-verified' &&
        receipt.evidence.kind === 'apply-complete',
    )
    const targetGate = fixture.evidences[rollbackPlanningIndex]?.commitGate
    const terminalGate = fixture.evidences[terminalIndex]?.commitGate
    if (
      rollbackPlanningIndex < 0 ||
      terminalIndex < 0 ||
      ordinaryIndex < 0 ||
      targetGate?.kind !== 'target-preimage' ||
      terminalGate?.kind !== 'terminal-reconciliation'
    ) throw new Error('Missing special commit-gate fixtures.')
    const cases = Object.freeze([
      Object.freeze({
        index: rollbackPlanningIndex,
        gate: Object.freeze({ kind: 'none' as const }),
      }),
      Object.freeze({
        index: terminalIndex,
        gate: Object.freeze({ kind: 'none' as const }),
      }),
      Object.freeze({ index: ordinaryIndex, gate: targetGate }),
      Object.freeze({ index: ordinaryIndex, gate: terminalGate }),
    ])
    for (const testCase of cases) {
      const receipt = fixture.receipts[testCase.index]
      const existingEvidence = fixture.evidences[testCase.index]
      if (receipt === undefined || existingEvidence === undefined) {
        throw new Error('Missing gate mismatch receipt fixture.')
      }
      const replacement = createCommitEvidence(
        createMigrationDigest(fixture.manifest),
        receipt,
        fixture.publicationVerificationKey,
        existingEvidence.commitAdmittedAt,
        receipt.stageReservationCommitRevision,
        testCase.gate,
      )
      const evidences = [...fixture.evidences]
      evidences[testCase.index] = replacement
      const durabilityAuthorizations = await recoverFixtureEvidences(
        fixture,
        evidences,
      )
      expect(() => verifyFixture(
        fixture,
        durabilityAuthorizations,
      )).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError)
    }
  })

  test('accepts a target gate observed after receipt completion and before admission', async () => {
    const fixture = await createFixture()
    const targetIndex = fixture.evidences.findIndex(
      (evidence) => evidence.commitGate.kind === 'target-preimage',
    )
    const receipt = fixture.receipts[targetIndex]
    const existingEvidence = fixture.evidences[targetIndex]
    const targetGate = existingEvidence?.commitGate
    if (
      targetIndex < 0 ||
      receipt === undefined ||
      existingEvidence === undefined ||
      targetGate?.kind !== 'target-preimage'
    ) {
      throw new Error('Missing target commit-gate fixture.')
    }
    const replacement = createCommitEvidence(
      createMigrationDigest(fixture.manifest),
      receipt,
      fixture.publicationVerificationKey,
      existingEvidence.commitAdmittedAt,
      receipt.stageReservationCommitRevision,
      Object.freeze({
        ...targetGate,
        commitGateObservedAt: stageTimestamp(receipt.stageOrdinal, 4),
      }),
    )
    const evidences = [...fixture.evidences]
    evidences[targetIndex] = replacement
    const durabilityAuthorizations = await recoverFixtureEvidences(
      fixture,
      evidences,
    )

    expect(verifyFixture(
      fixture,
      durabilityAuthorizations,
    ).stageCommitCount).toBe(36)
  })

  test('accepts commit equality with the next stage start at timestamp precision', async () => {
    const fixture = await createFixture()
    const firstReceipt = fixture.receipts[0]
    const nextReceipt = fixture.receipts[1]
    if (firstReceipt === undefined || nextReceipt === undefined) {
      throw new Error('Missing fixture receipts.')
    }
    const equalityEvidence = createCommitEvidence(
      createMigrationDigest(fixture.manifest),
      firstReceipt,
      fixture.publicationVerificationKey,
      nextReceipt.startedAt,
    )
    const evidences = [...fixture.evidences]
    evidences[0] = equalityEvidence
    const durabilityAuthorizations = await recoverFixtureEvidences(
      fixture,
      evidences,
    )

    expect(verifyFixture(
      fixture,
      durabilityAuthorizations,
    ).stageCommitCount).toBe(36)
  })

  test('accounts for parent-authenticated abandonment revisions between commits', async () => {
    const fixture = await createFixture(2, undefined, 1, 2)
    const projection = verifyFixture(fixture)
    const expectedAbandonment = fixture.reservationAbandonments[0]
    if (expectedAbandonment === undefined) {
      throw new Error('Missing authentic abandonment fixture.')
    }

    expect(projection.stageCommits[1]).toMatchObject({
      stageReservationClaimRevision: 5,
      stageReservationCommitRevision: 6,
      stageReservationAbandonmentCount: 1,
      stageReservationAbandonmentRootDigest:
        expectedAbandonment.abandonment.abandonmentRootDigest,
    })
    expect(projection.terminal.inactiveHead.revision).toBe(74)
  })

  test('strongly brackets multiple and maximum abandonment row sets', async () => {
    for (const abandonmentTotal of [3, 36]) {
      const fixture = await createFixture(
        2,
        undefined,
        1,
        2,
        undefined,
        false,
        abandonmentTotal,
      )
      const projection = verifyFixture(fixture)
      const abandonmentBinding =
        readWorkspaceSearchMigrationRehearsalStageAbandonmentDurabilityAuthorizationBinding(
          fixture.abandonmentDurabilityAuthorization,
        )
      const terminalCommitBinding =
        readWorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding(
          fixture.durabilityAuthorizations[35],
        )
      expect(abandonmentBinding.rows).toHaveLength(abandonmentTotal)
      expect(abandonmentBinding.abandonmentCount).toBe(abandonmentTotal)
      expect(abandonmentBinding.terminalRootSnapshotDigest).toBe(
        terminalCommitBinding.terminalRootSnapshotDigest,
      )
      expect(projection.terminal.inactiveHead.abandonmentCount).toBe(
        abandonmentTotal,
      )
    }
  })

  test('rejects forged abandonment roots and missing abandonment revisions', async () => {
    await expect(createFixture(
      2,
      undefined,
      1,
      2,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
    )).rejects.toBeDefined()
    await expect(
      createFixture(2, undefined, 1, 2, undefined, true),
    ).rejects.toBeDefined()
  })

  test('rejects local-only abandonment pairs and requires the capability', async () => {
    const fixture = await createFixture(2, undefined, 1, 2)
    await expect(createStageCommitChainDurabilityAuthorizations(
      fixture.manifest,
      fixture.receipts,
      fixture.evidences,
      fixture.reservationAbandonments,
      fixture.verificationKey,
      fixture.publicationVerificationKey,
      false,
    )).rejects.toBeDefined()
    expect(() => verifyFixture(
      fixture,
      fixture.durabilityAuthorizations,
      fixture.verificationKey,
      fixture.publicationVerificationKey,
      fixture.reservationAbandonments,
    )).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError)
  })

  test('rejects a commit before future authenticated completion evidence', async () => {
    const fixture = await createFixture(7)
    expect(() =>
      verifyFixture(fixture)
    ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError)
  })

  test('rejects terminal durable admission at the permit expiry boundary', async () => {
    const fixture = await createFixture()
    const receipt = fixture.receipts[35]
    if (receipt === undefined) throw new Error('Missing terminal receipt.')
    const evidence = createCommitEvidence(
      createMigrationDigest(fixture.manifest),
      receipt,
      fixture.publicationVerificationKey,
      fixture.permit.expiresAt,
    )
    const evidences = [...fixture.evidences.slice(0, 35), evidence]
    const durabilityAuthorizations = await recoverFixtureEvidences(
      fixture,
      evidences,
    )

    expect(() =>
      verifyFixture(fixture, durabilityAuthorizations)
    ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError)
  })

  test('rejects authenticated time, revision, ordinal, and ordering drift', async () => {
    const timeDriftModes: readonly ('before-exit' | 'after-next-start')[] =
      Object.freeze(['before-exit', 'after-next-start'])
    for (const mode of timeDriftModes) {
      const fixture = await createFixture()
      const receipt = fixture.receipts[0]
      const next = fixture.receipts[1]
      if (receipt === undefined || next === undefined) {
        throw new Error('Missing receipts.')
      }
      const evidence = createCommitEvidence(
        createMigrationDigest(fixture.manifest),
        receipt,
        fixture.publicationVerificationKey,
        mode === 'before-exit'
          ? receipt.processLifecycle.processExitedAt
          : new Date(Date.parse(next.startedAt) + 1).toISOString(),
      )
      const capabilities = await recoverFixtureEvidences(
        fixture,
        Object.freeze([evidence, ...fixture.evidences.slice(1)]),
      )
      expect(() => verifyFixture(fixture, capabilities)).toThrow(
        WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError,
      )
    }
    const revisionFixture = await createFixture()
    const firstReceipt = revisionFixture.receipts[0]
    if (firstReceipt === undefined) throw new Error('Missing receipt.')
    const wrongRevisionEvidence = createCommitEvidence(
      createMigrationDigest(revisionFixture.manifest),
      firstReceipt,
      revisionFixture.publicationVerificationKey,
      stageTimestamp(1, 6),
      firstReceipt.stageReservationCommitRevision + 2,
    )
    await expect(recoverFixtureEvidences(
      revisionFixture,
      Object.freeze([
        wrongRevisionEvidence,
        ...revisionFixture.evidences.slice(1),
      ]),
    )).rejects.toBeDefined()
    const orderingFixture = await createFixture()
    expect(() => verifyFixture(orderingFixture, Object.freeze([
      orderingFixture.durabilityAuthorizations[1],
      orderingFixture.durabilityAuthorizations[0],
      ...orderingFixture.durabilityAuthorizations.slice(2),
    ]))).toThrow(
      WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError,
    )
  })

  test('rejects authenticated run-locator and reservation-chain drift', async () => {
    const runLocatorAttempt =
      await createFixture(2, digest('foreign-stage-one-run'))
    expect(() => verifyFixture(runLocatorAttempt)).toThrow(
      WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError,
    )
    await expect(createFixture(2, undefined, 3)).rejects.toBeDefined()
  })

  test('rejects wrong keys, local-only intent substitution, and accessors', async () => {
    const fixture = await createFixture()
    expect(() => verifyFixture(
      fixture,
      fixture.durabilityAuthorizations,
      new Uint8Array(32).fill(0x7f),
    )).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError)
    expect(() => verifyFixture(
      fixture,
      fixture.durabilityAuthorizations,
      fixture.verificationKey,
      new Uint8Array(32).fill(0x7f),
    )).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError)
    expect(() => verifyFixture(
      fixture,
      fixture.evidences,
    )).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError)

    let getterCalls = 0
    const accessorReceipts: unknown[] = [...fixture.receipts]
    Object.defineProperty(accessorReceipts, '0', {
      configurable: true,
      enumerable: true,
      get: (): unknown => {
        getterCalls += 1
        return fixture.receipts[0]
      },
    })
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageCommitEvidenceChain({
        permit: fixture.permit,
        manifest: fixture.manifest,
        receipts: accessorReceipts,
        durabilityAuthorizations: fixture.durabilityAuthorizations,
        abandonmentDurabilityAuthorization:
          fixture.abandonmentDurabilityAuthorization,
        runtimeVerificationKey: fixture.verificationKey,
        publicationVerificationKey: fixture.publicationVerificationKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceChainError)
    expect(getterCalls).toBe(0)
  })
})
