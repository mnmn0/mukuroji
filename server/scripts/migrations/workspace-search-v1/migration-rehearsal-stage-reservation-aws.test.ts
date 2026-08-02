import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type {
  AttributeValue,
  GetItemCommand,
  GetItemCommandOutput,
  TransactWriteItemsCommand,
  TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  captureWorkspaceSearchMigrationRehearsalChildMutationObservation,
  createWorkspaceSearchMigrationRehearsalStageChildMaterial,
} from './migration-rehearsal-stage-child-material'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  serializeCanonicalJson,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
} from './migration-rehearsal-rate-evidence'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence,
  finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence,
  readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding,
} from './migration-rehearsal-reconciliation-audit'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalStageManifest,
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageCommitEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
  type WorkspaceSearchMigrationRehearsalStageCommitEvidence,
} from './migration-rehearsal-stage-commit-evidence'
import {
  createWorkspaceSearchMigrationRehearsalStageCommitIntent,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION,
  type WorkspaceSearchMigrationRehearsalStageCommitIntent,
} from './migration-rehearsal-stage-commit-intent'
import {
  authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization,
  createWorkspaceSearchMigrationRehearsalStageParentAuthentication,
  readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  type WorkspaceSearchMigrationRehearsalStageParentAuthorization,
} from './migration-rehearsal-stage-finalizer'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture,
  type AuthenticWorkspaceSearchMigrationRehearsalTargetPreimageCommitGateFixture,
} from './migration-rehearsal-suite-finalizer.test-fixture'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence,
  finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence,
  readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding,
  type WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
} from './migration-rehearsal-target-audit'
import {
  createWorkspaceSearchMigrationRehearsalStageReservationAbandonment,
} from './migration-rehearsal-stage-reservation-abandonment'
import {
  createWorkspaceSearchMigrationRehearsalStageReservationAwsStore,
  createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest,
  readWorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
  WorkspaceSearchMigrationRehearsalStageReservationAwsError,
  type CommitWorkspaceSearchMigrationRehearsalStageReservationInput,
  type WorkspaceSearchMigrationRehearsalStageHead,
  type WorkspaceSearchMigrationRehearsalStageReservationAwsTransport,
} from './migration-rehearsal-stage-reservation-aws'

/** Canonical initial reservation creation time. */
const reservedAt = '2026-08-02T00:00:00.000Z'

/** Canonical ordinary reservation expiry. */
const expiresAt = '2026-08-02T00:30:00.000Z'

/** Exact test migration-state table name. */
const stateTableName = 'mukuroji-migration-state-non-production'

/** Stable deterministic test digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Explicit DynamoDB conditional transaction failure used by the fake. */
class ConditionalTransactionFailure extends Error {
  /** Sole low-level transaction cancellation reason. */
  readonly CancellationReasons = Object.freeze([
    Object.freeze({ Code: 'ConditionalCheckFailed' }),
  ])

  /** Creates one explicit conditional cancellation. */
  constructor() {
    super('conditional')
    this.name = 'TransactionCanceledException'
  }
}

/** In-memory exact-predecessor migration-state transport for focused tests. */
class MemoryStageReservationTransport
  implements WorkspaceSearchMigrationRehearsalStageReservationAwsTransport {
  /** Current single durable row. */
  private item: Readonly<Record<string, AttributeValue>> | undefined

  /** Immutable non-root journal rows keyed by their deterministic record key. */
  private readonly journalItems =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Whether the next transaction has an outcome-uncertain failure. */
  failNextWriteUncertain = false

  /** Whether the next installed transaction loses its response. */
  loseNextWriteResponse = false

  /** Whether response loss exposes a valid but nonmatching write nonce. */
  driftNextResponseLossWriteNonce = false

  /** Number of strongly consistent reads observed. */
  consistentReadCount = 0

  /**
   * Seeds one strictly encoded later-stage active head for special-gate tests.
   *
   * @param reservation - Exact authenticated reservation owning the slot.
   * @param receipt - Exact prospective receipt defining claim continuity.
   */
  seedClaimedStage(
    reservation: WorkspaceSearchMigrationRehearsalStageReservation,
    receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  ): void {
    if (this.item !== undefined) throw new Error('Head is already seeded.')
    const stateTableLocationBindingDigest =
      createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
        stateTableName,
        requestedResourcesBinding:
          reservation.requestedResourcesBinding,
      })
    const recordKeyBindingDigest = createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-suite-key',
      version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
      stateTableLocationBindingDigest,
      permitDigest: reservation.permitDigest,
      requestedResourcesBinding:
        reservation.requestedResourcesBinding,
    })
    const state = Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
      stateVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
      manifestDigest: reservation.manifestDigest,
      permitDigest: reservation.permitDigest,
      requestedResourcesBinding:
        reservation.requestedResourcesBinding,
      completedStageOrdinal: reservation.stageOrdinal - 1,
      headReceiptDigest: reservation.previousStageReceiptDigest,
      activeReservation: Object.freeze({
        reservationDigest: createMigrationDigest(reservation),
        manifestEntryDigest: reservation.manifestEntryDigest,
        previousStageReceiptDigest:
          reservation.previousStageReceiptDigest,
        expectedPreviousRateSegment:
          reservation.expectedPreviousRateSegment,
        expectedCurrentRateSegmentOrdinal:
          reservation.expectedCurrentRateSegmentOrdinal,
        expectedTargetPreimageArtifactContentDigest:
          reservation.expectedTargetPreimageArtifactContentDigest,
        stageOrdinal: reservation.stageOrdinal,
        nonceDigest: reservation.nonceDigest,
        reservedAt: reservation.reservedAt,
        expiresAt: reservation.expiresAt,
      }),
      abandonmentCount: receipt.stageReservationAbandonmentCount,
      abandonmentRootDigest:
        receipt.stageReservationAbandonmentRootDigest,
      lastAbandonedAt: null,
    })
    const stateJson = serializeCanonicalJson(state)
    const recordKey =
      `rehearsal-suite/v2/${recordKeyBindingDigest}/root`
    this.item = Object.freeze({
      kind: { S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND },
      manifestDigest: { S: reservation.manifestDigest },
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      permitDigest: { S: reservation.permitDigest },
      recordKey: { S: recordKey },
      recordVersion: {
        N: String(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION),
      },
      requestedResourcesBinding: {
        S: reservation.requestedResourcesBinding,
      },
      stateDigest: {
        S: createMigrationDigest({
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
          version:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
          stateTableLocationBindingDigest,
          state,
        }),
      },
      stateJson: { S: stateJson },
      stateRevision: {
        N: String(receipt.stageReservationClaimRevision),
      },
      stateTableLocationBindingDigest: {
        S: stateTableLocationBindingDigest,
      },
      stateWriteNonce: { S: digest('seeded-special-stage-write-nonce') },
    })
  }

  /**
   * Seeds one inactive committed head and its exact immutable commit journal.
   *
   * @param reservation - Reservation consumed by the committed receipt.
   * @param receipt - Runtime-authenticated receipt at the seeded head.
   * @param commitEvidence - Publication-authenticated immutable commit proof.
   */
  seedCommittedStage(
    reservation: WorkspaceSearchMigrationRehearsalStageReservation,
    receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
    commitEvidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
  ): void {
    if (this.item !== undefined) throw new Error('Head is already seeded.')
    const stateTableLocationBindingDigest =
      createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
        stateTableName,
        requestedResourcesBinding:
          reservation.requestedResourcesBinding,
      })
    const recordKeyBindingDigest = createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-suite-key',
      version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
      stateTableLocationBindingDigest,
      permitDigest: reservation.permitDigest,
      requestedResourcesBinding:
        reservation.requestedResourcesBinding,
    })
    const namespace = `rehearsal-suite/v2/${recordKeyBindingDigest}`
    const state = Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
      stateVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
      manifestDigest: reservation.manifestDigest,
      permitDigest: reservation.permitDigest,
      requestedResourcesBinding:
        reservation.requestedResourcesBinding,
      completedStageOrdinal: receipt.stageOrdinal,
      headReceiptDigest: createMigrationDigest(receipt),
      activeReservation: null,
      abandonmentCount: receipt.stageReservationAbandonmentCount,
      abandonmentRootDigest:
        receipt.stageReservationAbandonmentRootDigest,
      lastAbandonedAt: null,
    })
    const stateJson = serializeCanonicalJson(state)
    const rootRecordKey = `${namespace}/root`
    this.item = Object.freeze({
      kind: { S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND },
      manifestDigest: { S: reservation.manifestDigest },
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      permitDigest: { S: reservation.permitDigest },
      recordKey: { S: rootRecordKey },
      recordVersion: {
        N: String(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION),
      },
      requestedResourcesBinding: {
        S: reservation.requestedResourcesBinding,
      },
      stateDigest: {
        S: createMigrationDigest({
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
          version:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_VERSION,
          stateTableLocationBindingDigest,
          state,
        }),
      },
      stateJson: { S: stateJson },
      stateRevision: {
        N: String(receipt.stageReservationCommitRevision),
      },
      stateTableLocationBindingDigest: {
        S: stateTableLocationBindingDigest,
      },
      stateWriteNonce: { S: digest('seeded-committed-stage-write-nonce') },
    })
    const journalRecordKey =
      `${namespace}/stage/${receipt.stageOrdinal}/commit`
    this.journalItems.set(journalRecordKey, Object.freeze({
      abandonmentCount: {
        N: String(receipt.stageReservationAbandonmentCount),
      },
      abandonmentRootDigest: {
        S: receipt.stageReservationAbandonmentRootDigest,
      },
      commitAdmittedAt: { S: commitEvidence.commitAdmittedAt },
      commitEvidenceDigest: { S: createMigrationDigest(commitEvidence) },
      commitEvidenceJson: { S: serializeCanonicalJson(commitEvidence) },
      commitRevision: {
        N: String(receipt.stageReservationCommitRevision),
      },
      kind: {
        S: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_KIND,
      },
      manifestDigest: { S: reservation.manifestDigest },
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      parentAuthenticationDigest: {
        S: commitEvidence.parentAuthenticationDigest,
      },
      parentAuthorizationBindingDigest: {
        S: commitEvidence.parentAuthorizationBindingDigest,
      },
      permitDigest: { S: reservation.permitDigest },
      publicationKeyDigest: { S: commitEvidence.publicationKeyDigest },
      receiptDigest: { S: createMigrationDigest(receipt) },
      recordKey: { S: journalRecordKey },
      recordVersion: {
        N: String(
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_JOURNAL_VERSION,
        ),
      },
      requestedResourcesBinding: {
        S: reservation.requestedResourcesBinding,
      },
      stageOrdinal: { N: String(receipt.stageOrdinal) },
      stageReservationClaimRevision: {
        N: String(receipt.stageReservationClaimRevision),
      },
      stageReservationDigest: { S: createMigrationDigest(reservation) },
      stateTableLocationBindingDigest: {
        S: stateTableLocationBindingDigest,
      },
    }))
  }

  /**
   * Strongly reads the current row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Detached current item or an absent result.
   */
  async getRehearsalStageReservation(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    if (
      command.input.TableName !== stateTableName ||
      command.input.ConsistentRead !== true
    ) throw new Error('Unexpected strong-read input.')
    this.consistentReadCount += 1
    const recordKey = command.input.Key?.recordKey?.S
    if (recordKey === undefined) throw new Error('Missing record key.')
    const selected = recordKey.endsWith('/root')
      ? this.item
      : this.journalItems.get(recordKey)
    return {
      $metadata: {},
      ...(selected === undefined ? {} : { Item: cloneItem(selected) }),
    }
  }

  /**
   * Applies one absent or exact-state-digest conditional Put.
   *
   * @param command - Adapter-owned single-Put transaction.
   * @returns Empty successful low-level response.
   */
  async transactWriteRehearsalStageReservation(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    if (this.failNextWriteUncertain) {
      this.failNextWriteUncertain = false
      throw new Error('uncertain transport')
    }
    const transactions = command.input.TransactItems
    const put = transactions?.[0]?.Put
    const journalPut = transactions?.[1]?.Put
    if (
      (transactions?.length !== 1 && transactions?.length !== 2) ||
      put === undefined ||
      put.TableName !== stateTableName ||
      put.Item === undefined ||
      typeof put.ConditionExpression !== 'string'
    ) throw new Error('Unexpected transaction input.')
    if (transactions.length === 2) {
      const journalRecordKey = journalPut?.Item?.recordKey?.S
      if (
        journalPut === undefined ||
        journalPut.TableName !== stateTableName ||
        journalPut.Item === undefined ||
        journalRecordKey === undefined ||
        journalPut.ConditionExpression?.startsWith(
          'attribute_not_exists',
        ) !== true ||
        this.journalItems.has(journalRecordKey)
      ) throw new ConditionalTransactionFailure()
    }
    if (put.ConditionExpression.startsWith('attribute_not_exists')) {
      if (this.item !== undefined) throw new ConditionalTransactionFailure()
    } else {
      const expectedDigest =
        put.ExpressionAttributeValues?.[':expectedStateDigest']?.S
      const expectedRevision =
        put.ExpressionAttributeValues?.[':expectedStateRevision']?.N
      const expectedWriteNonce =
        put.ExpressionAttributeValues?.[':expectedStateWriteNonce']?.S
      if (
        expectedDigest === undefined ||
        expectedRevision === undefined ||
        expectedWriteNonce === undefined ||
        this.item?.stateDigest?.S !== expectedDigest ||
        this.item.stateRevision?.N !== expectedRevision ||
        this.item.stateWriteNonce?.S !== expectedWriteNonce
      ) throw new ConditionalTransactionFailure()
    }
    this.item = cloneItem(put.Item)
    if (journalPut?.Item !== undefined) {
      const journalRecordKey = journalPut.Item.recordKey?.S
      if (journalRecordKey === undefined) {
        throw new Error('Missing journal record key.')
      }
      this.journalItems.set(journalRecordKey, cloneItem(journalPut.Item))
    }
    if (this.loseNextWriteResponse) {
      this.loseNextWriteResponse = false
      if (this.driftNextResponseLossWriteNonce) {
        this.driftNextResponseLossWriteNonce = false
        this.item = Object.freeze({
          ...this.item,
          stateWriteNonce: { S: digest('different-write-nonce') },
        })
      }
      throw new Error('lost transaction response')
    }
    return { $metadata: {} }
  }

  /** Corrupts the nested state without updating its authenticated digest. */
  corruptStateJson(): void {
    const current = this.item
    if (current === undefined) throw new Error('Missing current item.')
    this.item = Object.freeze({
      ...current,
      stateJson: { S: '{}' },
    })
  }

  /** Returns the number of immutable transition journal rows. */
  journalCount(): number {
    return this.journalItems.size
  }

  /** Corrupts one immutable commit row without updating its evidence digest. */
  corruptCommitEvidenceJson(): void {
    const entry = [...this.journalItems.entries()].find(([recordKey]) =>
      recordKey.endsWith('/commit')
    )
    if (entry === undefined) throw new Error('Missing commit journal row.')
    const [recordKey, item] = entry
    this.journalItems.set(recordKey, Object.freeze({
      ...item,
      commitEvidenceJson: { S: '{}' },
    }))
  }

  /** Removes one commit row to simulate an impossible partial transaction. */
  removeCommitJournal(): void {
    const recordKey = [...this.journalItems.keys()].find((candidate) =>
      candidate.endsWith('/commit')
    )
    if (recordKey === undefined) throw new Error('Missing commit journal row.')
    this.journalItems.delete(recordKey)
  }
}

/**
 * Detaches one low-level item through the production attribute codec.
 *
 * @param item - Low-level DynamoDB item to detach.
 * @returns Fresh validated low-level item.
 */
function cloneItem(
  item: Readonly<Record<string, AttributeValue>>,
): Readonly<Record<string, AttributeValue>> {
  return decodeAttributeMap(encodeUnknownAttributeMap(item))
}

/**
 * Creates one authentic fresh stage-one reservation.
 *
 * @param fixture - Authenticated manifest selection fixture.
 * @param fill - Distinct raw nonce byte.
 * @param creationTime - Canonical reservation creation time.
 * @param expiryTime - Canonical exclusive expiry time.
 * @returns Authenticated exact selection-bound reservation.
 */
function createReservation(
  fixture: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  fill: number,
  creationTime = reservedAt,
  expiryTime = expiresAt,
): WorkspaceSearchMigrationRehearsalStageReservation {
  return createWorkspaceSearchMigrationRehearsalStageReservation({
    selection: fixture.selection,
    nonce: new Uint8Array(32).fill(fill),
    reservedAt: creationTime,
    expiresAt: expiryTime,
    expectedPreviousRateSegment: null,
    expectedCurrentRateSegmentOrdinal: 0,
    expectedTargetPreimageArtifactContentDigest: null,
    signingKey: fixture.authenticationKey,
  })
}

/**
 * Creates one valid persisted generic-success receipt for stage one.
 *
 * @param fixture - Authenticated stage-one selection fixture.
 * @param reservation - Exact durable reservation owning the receipt.
 * @param claimRevision - Durable head revision returned by its claim.
 * @returns HMAC-authenticated close-replan receipt.
 */
function createStageReceipt(
  fixture: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  claimRevision: number,
  processLifecycle:
    WorkspaceSearchMigrationRehearsalStageReceipt['processLifecycle'] =
      Object.freeze({
        lifecycleDigest: digest('process-lifecycle'),
        runnerStartedAt: '2026-08-02T00:09:00.000Z',
        receiptObservedAt: '2026-08-02T00:20:00.000Z',
        receiptPersistedAt: '2026-08-02T00:21:00.000Z',
        parentDecisionRecordedAt: null,
        processExitedAt: '2026-08-02T00:22:00.000Z',
        exitClass: 'successful-no-fault',
      }),
  abandonmentCount = 0,
  abandonmentRootDigest =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const entry = fixture.selection.entry
  const closedWriterFenceRecordDigest = digest('closed-writer-fence')
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
      serializedOutputLineDigest: digest('serialized-output-line'),
      manifestDigest: fixture.selection.manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
      permitDigest: fixture.manifest.permitDigest,
      commit: fixture.manifest.commit,
      requestedResourcesBinding:
        fixture.manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        fixture.manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities:
        fixture.manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        fixture.manifest.integrityResourceIdentityDigest,
      configurationBindingDigest:
        fixture.manifest.configurationBindingDigest,
      policyVersion: fixture.manifest.policyVersion,
      runLocatorDigest: digest('run-locator'),
      attemptOrdinal: entry.attemptOrdinal,
      attemptLocatorDigest: digest('attempt-locator'),
      ownerLocatorDigest: digest('owner-locator'),
      leaseIdentityDigest: digest('lease-identity'),
      leaseObservation: Object.freeze({
        kind: 'acquired',
        predecessorLeaseIdentityDigest: null,
        predecessorLeaseExpiresAt: null,
        acquiredAt: '2026-08-02T00:09:30.000Z',
        successorLeaseIdentityDigest: digest('lease-identity'),
        successorLeaseExpiresAt: '2026-08-02T01:09:30.000Z',
      }),
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest: closedWriterFenceRecordDigest,
      previousStageReceiptDigest: null,
      stageReservationDigest: createMigrationDigest(reservation),
      stageReservationClaimRevision: claimRevision,
      stageReservationCommitRevision: claimRevision + 1,
      stageReservationAbandonmentCount: abandonmentCount,
      stageReservationAbandonmentRootDigest:
        abandonmentRootDigest,
      startedAt: '2026-08-02T00:10:00.000Z',
      completedAt: '2026-08-02T00:20:00.000Z',
      processLifecycle,
      outcome: entry.expectedOutcome,
      faultReceiptDigest: null,
      faultBoundary: null,
      predecessorLeaseExpiresAt: null,
      takeoverAcquiredAt: null,
      reconciledAt: null,
      evidence: Object.freeze({
        kind: 'planning-sealed',
        executionBoundaryDigest: digest('execution-boundary'),
        closedWriterFenceRecordDigest,
        sealedPlanningAuthorityDigest: digest('sealed-authority'),
        planDigest: digest('plan'),
        sealedPlanOperationCount: 2,
        sourceOperationCount: 1,
        orphanOperationCount: 1,
        closedAt: '2026-08-02T00:11:00.000Z',
        drainStartedAt: '2026-08-02T00:12:00.000Z',
        drainCompletedAt: '2026-08-02T00:13:00.000Z',
        admittedAt: '2026-08-02T00:14:00.000Z',
        planCreatedAt: '2026-08-02T00:15:00.000Z',
        sealedAt: '2026-08-02T00:16:00.000Z',
      }),
      rateSegment: Object.freeze({
        authenticationKeyFingerprint:
          createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
            fixture.authenticationKey,
          ),
        segmentLocatorDigest: digest('segment-locator'),
        segmentOrdinal: 0,
        firstEventSequence: 1,
        eventCount: 0,
        firstCommittedEventSequence: null,
        lastCommittedEventSequence: null,
        terminalRecordMac: digest('segment-terminal-mac'),
        segmentDigest: digest('segment'),
      }),
    },
    signingKey: fixture.authenticationKey,
  })
}

/** Genuine parent-authorized commit inputs for one claimed stage. */
type StageCommitArtifacts = {
  /** Runtime-authenticated receipt for the claimed reservation. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Publication-authenticated local prepared intent. */
  readonly commitIntent: WorkspaceSearchMigrationRehearsalStageCommitIntent
  /** Genuine process-local parent authorization capability. */
  readonly parentAuthorization:
    WorkspaceSearchMigrationRehearsalStageParentAuthorization
  /** Genuine cleanup capability whose binding is persisted by the parent. */
  readonly runtimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization
}

/** Creates genuine parent authorization and a distinct prepared intent. */
async function createStageCommitArtifacts(
  fixture: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  claimedHead: WorkspaceSearchMigrationRehearsalStageHead,
  preparedAt = '2026-08-02T00:22:30.000Z',
): Promise<StageCommitArtifacts> {
  const observation =
    captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
      selection: fixture.selection,
      authenticationKey: fixture.authenticationKey,
      observation: fixture.observation,
    })
  const material = createWorkspaceSearchMigrationRehearsalStageChildMaterial({
    selection: fixture.selection,
    observation,
    committedRateSegment: fixture.committedRateSegment,
    stageReservation: reservation,
    claimedStageHead: claimedHead,
    leaseAcquisitionObservation: fixture.leaseAcquisitionObservation,
    authenticationKey: fixture.authenticationKey,
  })
  const materialDigest = createMigrationDigest(material)
  const materialEvidence = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-child-material-evidence',
    evidenceVersion: 1,
    material,
    materialDigest,
    observedAt: '2026-08-02T00:20:00.000Z',
  })
  const lifecycle = Object.freeze({
    lifecycleVersion: 1,
    manifestDigest: fixture.selection.manifestDigest,
    manifestEntryDigest: createMigrationDigest(fixture.selection.entry),
    previousStageReceiptDigest:
      fixture.selection.previousStageReceiptDigest,
    stageOrdinal: fixture.selection.entry.ordinal,
    scenario: fixture.selection.entry.scenario,
    command: fixture.selection.entry.command,
    attemptOrdinal: fixture.selection.entry.attemptOrdinal,
    expectedOutcome: fixture.selection.entry.expectedOutcome,
    materialDigest,
    stdoutSha256: digest('store-parent-stdout'),
    runnerStartedAt: '2026-08-02T00:09:00.000Z',
    materialObservedAt: materialEvidence.observedAt,
    materialPersistedAt: '2026-08-02T00:21:00.000Z',
    processExitedAt: '2026-08-02T00:22:00.000Z',
    exitClass: 'successful-no-fault',
  })
  const lifecycleDigest = createMigrationDigest(lifecycle)
  const lifecycleEvidence = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
    lifecycle,
    lifecycleSha256: lifecycleDigest,
  })
  const cleanupDirectory = await mkdtemp(join(
    tmpdir(),
    'mukuroji-stage-commit-cleanup-',
  ))
  let cleanupClockIndex = 0
  const cleanupTimes = Object.freeze([
    new Date('2026-08-02T00:22:10.000Z'),
    new Date('2026-08-02T00:22:20.000Z'),
  ])
  let runtimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization
  try {
    await writeFile(
      join(
        cleanupDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ),
      fixture.authenticationKey,
      { mode: 0o600 },
    )
    runtimeKeyCleanupAuthorization =
      await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
        evidenceDirectory: cleanupDirectory,
        reservation,
        selection: fixture.selection,
        expectedRuntimeKey: fixture.authenticationKey,
        publicationAuthenticationKey:
          fixture.publicationAuthenticationKey,
        now: (): Date => {
          const value = cleanupTimes[cleanupClockIndex]
          cleanupClockIndex += 1
          if (value === undefined) {
            throw new Error('Unexpected cleanup clock read.')
          }
          return value
        },
      })
  } finally {
    await rm(cleanupDirectory, { force: true, recursive: true })
  }
  const parentAuthentication =
    createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
      selection: fixture.selection,
      materialKind: 'success',
      persistedMaterialEvidence: materialEvidence,
      persistedLifecycleEvidence: lifecycleEvidence,
      runtimeAuthenticationKey: new Uint8Array(fixture.authenticationKey),
      publicationAuthenticationKey:
        new Uint8Array(fixture.publicationAuthenticationKey),
      runtimeKeyCleanupAuthorization,
    })
  const parentAuthorization =
    authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization({
      selection: fixture.selection,
      materialKind: 'success',
      persistedMaterialEvidence: materialEvidence,
      persistedLifecycleEvidence: lifecycleEvidence,
      parentAuthentication,
      runtimeAuthenticationKey: new Uint8Array(fixture.authenticationKey),
      publicationAuthenticationKey:
        new Uint8Array(fixture.publicationAuthenticationKey),
    })
  const processLifecycle = Object.freeze({
    lifecycleDigest,
    runnerStartedAt: lifecycle.runnerStartedAt,
    receiptObservedAt: lifecycle.materialObservedAt,
    receiptPersistedAt: lifecycle.materialPersistedAt,
    parentDecisionRecordedAt: null,
    processExitedAt: lifecycle.processExitedAt,
    exitClass: 'successful-no-fault',
  })
  const receipt = createStageReceipt(
    fixture,
    reservation,
    claimedHead.revision,
    processLifecycle,
    claimedHead.abandonmentCount,
    claimedHead.abandonmentRootDigest,
  )
  const receiptDigest = createMigrationDigest(receipt)
  const parentBinding =
    readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding(
      parentAuthorization,
    )
  const recoveryDeadlineAt = new Date(
    Date.parse(reservation.expiresAt) +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  ).toISOString()
  const commitIntent =
    createWorkspaceSearchMigrationRehearsalStageCommitIntent({
      claims: Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND,
      intentVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION,
      stage: 'non-production',
      manifestDigest: fixture.selection.manifestDigest,
      permitDigest: fixture.manifest.permitDigest,
      requestedResourcesBinding: fixture.requestedResourcesBinding,
      stateTableLocationBindingDigest:
        createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
          stateTableName,
          requestedResourcesBinding: fixture.requestedResourcesBinding,
        }),
      publicationKeyDigest: parentBinding.publicationKeyDigest,
      parentAuthenticationDigest: parentBinding.parentAuthenticationDigest,
      parentAuthorizationBindingDigest: createMigrationDigest(parentBinding),
      stageOrdinal: receipt.stageOrdinal,
      stageReservationDigest: createMigrationDigest(reservation),
      stageReservationClaimRevision:
        receipt.stageReservationClaimRevision,
      receiptDigest,
      commitRevision: receipt.stageReservationCommitRevision,
      expectedHead: Object.freeze({
        manifestDigest: fixture.selection.manifestDigest,
        completedStageOrdinal: receipt.stageOrdinal,
        headReceiptDigest: receiptDigest,
        activeReservationDigest: null,
        activeStageOrdinal: null,
        activeExpiresAt: null,
        abandonmentCount: receipt.stageReservationAbandonmentCount,
        abandonmentRootDigest:
          receipt.stageReservationAbandonmentRootDigest,
        revision: receipt.stageReservationCommitRevision,
      }),
      commitGate: Object.freeze({ kind: 'none' }),
      recoveryAuthorization: Object.freeze({
        reservationExpiresAt: reservation.expiresAt,
        permitExpiresAt: fixture.permit.expiresAt,
        recoveryDeadlineAt,
        receiptCompletedAt: receipt.completedAt,
        processExitedAt: receipt.processLifecycle.processExitedAt,
        materialEvidenceDigest: parentBinding.materialEvidenceDigest,
        boundaryMaterialEvidenceDigest:
          parentBinding.boundaryMaterialEvidenceDigest,
        materialDigest: parentBinding.materialDigest,
        claimedStageHeadDigest: parentBinding.claimedStageHeadDigest,
        lifecycleEvidenceDigest: parentBinding.lifecycleEvidenceDigest,
        lifecycleDigest: parentBinding.lifecycleDigest,
        runtimeKeyCleanupAuthorizationBindingDigest:
          parentBinding.runtimeKeyCleanupAuthorization
            .authorizationBindingDigest,
        cleanupIntentDigest:
          parentBinding.runtimeKeyCleanupAuthorization.cleanupIntentDigest,
        cleanupCompletionDigest:
          parentBinding.runtimeKeyCleanupAuthorization
            .cleanupCompletionDigest,
        cleanupPreparedAt:
          parentBinding.runtimeKeyCleanupAuthorization.preparedAt,
        cleanupCompletedAt:
          parentBinding.runtimeKeyCleanupAuthorization.completedAt,
      }),
      preparedAt,
      intentStatus: 'prepared',
    }),
      signingKey: fixture.publicationAuthenticationKey,
    })
  return Object.freeze({
    receipt,
    commitIntent,
    parentAuthorization,
    runtimeKeyCleanupAuthorization,
  })
}

/** Creates the committed bytes deterministically installed by the store. */
function createExpectedCommitEvidence(
  fixture: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  intent: WorkspaceSearchMigrationRehearsalStageCommitIntent,
  commitAdmittedAt = '2026-08-02T00:23:00.000Z',
): WorkspaceSearchMigrationRehearsalStageCommitEvidence {
  return createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
    claims: Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
      evidenceVersion: 1,
      stage: 'non-production',
      manifestDigest: intent.manifestDigest,
      permitDigest: intent.permitDigest,
      requestedResourcesBinding: intent.requestedResourcesBinding,
      stateTableLocationBindingDigest:
        intent.stateTableLocationBindingDigest,
      publicationKeyDigest: intent.publicationKeyDigest,
      parentAuthenticationDigest: intent.parentAuthenticationDigest,
      parentAuthorizationBindingDigest:
        intent.parentAuthorizationBindingDigest,
      stageOrdinal: intent.stageOrdinal,
      stageReservationDigest: intent.stageReservationDigest,
      stageReservationClaimRevision:
        intent.stageReservationClaimRevision,
      receiptDigest: intent.receiptDigest,
      commitRevision: intent.commitRevision,
      head: intent.expectedHead,
      commitGate: intent.commitGate,
      recoveryAuthorization: intent.recoveryAuthorization,
      admissionMode: Date.parse(commitAdmittedAt) <
          Date.parse(intent.recoveryAuthorization.reservationExpiresAt)
        ? 'ordinary'
        : 'bounded-recovery',
      commitAdmittedAt,
      durableStatus: 'committed',
    }),
    signingKey: fixture.publicationAuthenticationKey,
  })
}

/** Creates one complete direct-store commit input and its expected artifacts. */
async function createStoreCommitInput(
  fixture: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  claimedHead: WorkspaceSearchMigrationRehearsalStageHead,
  reservationAbandonments: readonly unknown[] = Object.freeze([]),
  preparedAt = '2026-08-02T00:22:30.000Z',
  commitDispatchAt = '2026-08-02T00:23:00.000Z',
): Promise<Readonly<{
  /** Genuine authenticated local artifacts. */
  readonly artifacts: StageCommitArtifacts
  /** Exact direct-store commit input. */
  readonly input: CommitWorkspaceSearchMigrationRehearsalStageReservationInput
}>> {
  const artifacts = await createStageCommitArtifacts(
    fixture,
    reservation,
    claimedHead,
    preparedAt,
  )
  return Object.freeze({
    artifacts,
    input: Object.freeze({
      reservation,
      selection: fixture.selection,
      receipt: artifacts.receipt,
      previousReceipt: null,
      reservationAbandonments,
      parentAuthorization: artifacts.parentAuthorization,
      commitIntent: artifacts.commitIntent,
      runtimeKeyCleanupAuthorization:
        artifacts.runtimeKeyCleanupAuthorization,
      commitGateAuthorization: null,
      commitDispatchAt,
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey:
        fixture.publicationAuthenticationKey,
    }),
  })
}

/** Genuine parent-authorized abandonment inputs for one claimed stage. */
type StageAbandonmentArtifacts = {
  /** Publication-authenticated exact abandonment transition. */
  readonly abandonment: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageReservationAbandonment
  >
  /** Genuine cleanup capability consumed by abandonment CAS admission. */
  readonly runtimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization
}

/** Creates an independent cleanup cap and exact-deadline abandonment. */
async function createStageAbandonmentArtifacts(
  fixture: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  claimedHead: WorkspaceSearchMigrationRehearsalStageHead,
  abandonedAt: string,
): Promise<StageAbandonmentArtifacts> {
  const cleanupDirectory = await mkdtemp(join(
    tmpdir(),
    'mukuroji-stage-race-abandon-cleanup-',
  ))
  let cleanupTimeIndex = 0
  const reservationExpiresMilliseconds = Date.parse(reservation.expiresAt)
  const cleanupTimes = Object.freeze([
    new Date(reservationExpiresMilliseconds - 2_000),
    new Date(reservationExpiresMilliseconds - 1_000),
  ])
  let runtimeKeyCleanupAuthorization:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization
  try {
    await writeFile(
      join(
        cleanupDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ),
      fixture.authenticationKey,
      { mode: 0o600 },
    )
    runtimeKeyCleanupAuthorization =
      await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
        evidenceDirectory: cleanupDirectory,
        reservation,
        selection: fixture.selection,
        expectedRuntimeKey: fixture.authenticationKey,
        publicationAuthenticationKey:
          fixture.publicationAuthenticationKey,
        now: (): Date => {
          const value = cleanupTimes[cleanupTimeIndex]
          cleanupTimeIndex += 1
          if (value === undefined) {
            throw new Error('Unexpected cleanup clock read.')
          }
          return value
        },
      })
  } finally {
    await rm(cleanupDirectory, { force: true, recursive: true })
  }
  const cleanupBinding =
    readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
      runtimeKeyCleanupAuthorization,
    )
  return Object.freeze({
    abandonment:
      createWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
        reservation,
        selection: fixture.selection,
        reservationClaimRevision: claimedHead.revision,
        previousAbandonmentCount: claimedHead.abandonmentCount,
        previousAbandonmentRootDigest:
          claimedHead.abandonmentRootDigest,
        abandonedAt,
        runtimeKeyCleanupCompletionDigest:
          cleanupBinding.cleanupCompletionDigest,
        runtimeVerificationKey: fixture.authenticationKey,
        publicationSigningKey: fixture.publicationAuthenticationKey,
      }),
    runtimeKeyCleanupAuthorization,
  })
}

/**
 * Creates one focused manifest-scoped store and its transport.
 *
 * @param fixture - Authenticated manifest fixture.
 * @returns Fresh store and in-memory transport.
 */
function createStore(
  fixture: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
) {
  const transport = new MemoryStageReservationTransport()
  const store =
    createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
      binding: {
        stateTableName,
        requestedResourcesBinding: fixture.requestedResourcesBinding,
      },
      manifest: fixture.manifest,
      manifestVerificationKey: fixture.authenticationKey,
      transport,
    })
  return Object.freeze({ store, transport })
}

/** Creates publication-authenticated planning evidence for one seeded journal. */
function createSeededTargetCommitEvidence(
  fixture:
    AuthenticWorkspaceSearchMigrationRehearsalTargetPreimageCommitGateFixture,
  binding: WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
): WorkspaceSearchMigrationRehearsalStageCommitEvidence {
  const receipt = fixture.receipt
  const reservation = fixture.reservation
  const receiptDigest = createMigrationDigest(receipt)
  const recoveryDeadlineAt = new Date(
    Date.parse(reservation.expiresAt) +
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  ).toISOString()
  const commitAdmittedAt = new Date(
    Date.parse(binding.commitGateObservedAt) + 1,
  ).toISOString()
  return createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
    claims: Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
      evidenceVersion: 1,
      stage: 'non-production',
      manifestDigest: fixture.selection.manifestDigest,
      permitDigest: reservation.permitDigest,
      requestedResourcesBinding:
        reservation.requestedResourcesBinding,
      stateTableLocationBindingDigest:
        createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
          stateTableName,
          requestedResourcesBinding:
            reservation.requestedResourcesBinding,
        }),
      publicationKeyDigest: reservation.publicationKeyDigest,
      parentAuthenticationDigest: digest('seeded-parent-authentication'),
      parentAuthorizationBindingDigest:
        digest('seeded-parent-authorization'),
      stageOrdinal: receipt.stageOrdinal,
      stageReservationDigest: createMigrationDigest(reservation),
      stageReservationClaimRevision:
        receipt.stageReservationClaimRevision,
      receiptDigest,
      commitRevision: receipt.stageReservationCommitRevision,
      head: Object.freeze({
        manifestDigest: fixture.selection.manifestDigest,
        completedStageOrdinal: receipt.stageOrdinal,
        headReceiptDigest: receiptDigest,
        activeReservationDigest: null,
        activeStageOrdinal: null,
        activeExpiresAt: null,
        abandonmentCount: receipt.stageReservationAbandonmentCount,
        abandonmentRootDigest:
          receipt.stageReservationAbandonmentRootDigest,
        revision: receipt.stageReservationCommitRevision,
      }),
      commitGate: Object.freeze({
        kind: 'target-preimage',
        artifactBindingDigest: binding.bindingDigest,
        contentDigest: binding.contentDigest,
        byteLength: binding.byteLength,
        purpose: binding.purpose,
        contextDigest: binding.contextDigest,
        commitGateObservedAt: binding.commitGateObservedAt,
        observationDigest: binding.observationDigest,
        aggregateDigest: binding.aggregateDigest,
        rateSuccessor: binding.rate.successor,
        rateAggregateDigest: binding.rate.aggregateDigest,
        rateCompletedAt: binding.rate.completedAt,
      }),
      recoveryAuthorization: Object.freeze({
        reservationExpiresAt: reservation.expiresAt,
        permitExpiresAt: new Date(
          Date.parse(recoveryDeadlineAt) + 60 * 60_000,
        ).toISOString(),
        recoveryDeadlineAt,
        receiptCompletedAt: receipt.completedAt,
        processExitedAt: receipt.processLifecycle.processExitedAt,
        materialEvidenceDigest: digest('seeded-material-evidence'),
        boundaryMaterialEvidenceDigest: null,
        materialDigest: digest('seeded-material'),
        claimedStageHeadDigest: digest('seeded-claimed-head'),
        lifecycleEvidenceDigest: digest('seeded-lifecycle-evidence'),
        lifecycleDigest: receipt.processLifecycle.lifecycleDigest,
        runtimeKeyCleanupAuthorizationBindingDigest:
          digest('seeded-cleanup-binding'),
        cleanupIntentDigest: digest('seeded-cleanup-intent'),
        cleanupCompletionDigest: digest('seeded-cleanup-completion'),
        cleanupPreparedAt: receipt.completedAt,
        cleanupCompletedAt: receipt.completedAt,
      }),
      admissionMode: 'ordinary',
      commitAdmittedAt,
      durableStatus: 'committed',
    }),
    signingKey: fixture.publicationAuthenticationKey,
  })
}

/** Creates an authentic rollback apply reservation around one candidate digest. */
function createRollbackApplyReservation(
  fixture:
    AuthenticWorkspaceSearchMigrationRehearsalTargetPreimageCommitGateFixture,
  binding: WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding,
  contentDigest: string,
  nonceByte: number,
): Readonly<{
  /** Exact apply selection following the planning receipt. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Runtime-authenticated reservation carrying the candidate digest. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
}> {
  const entry = fixture.selection.manifest.entries[fixture.receipt.stageOrdinal]
  if (
    entry === undefined ||
    entry.command !== 'apply' ||
    entry.scenario !== 'complete-apply-rollback'
  ) throw new Error('Expected complete rollback apply successor.')
  const selection: WorkspaceSearchMigrationRehearsalSelectedStage =
    Object.freeze({
      manifest: fixture.selection.manifest,
      manifestDigest: fixture.selection.manifestDigest,
      entry,
      previousStageReceiptDigest: createMigrationDigest(fixture.receipt),
    })
  const reservedAt = new Date(
    Date.parse(binding.commitGateObservedAt) + 2,
  ).toISOString()
  const expiresAt = new Date(Date.parse(reservedAt) + 10 * 60_000)
    .toISOString()
  const reservation =
    createWorkspaceSearchMigrationRehearsalStageReservation({
      selection,
      nonce: new Uint8Array(32).fill(nonceByte),
      reservedAt,
      expiresAt,
      expectedPreviousRateSegment: binding.rate.successor,
      expectedCurrentRateSegmentOrdinal:
        binding.rate.successor.segmentOrdinal + 1,
      expectedTargetPreimageArtifactContentDigest: contentDigest,
      signingKey: fixture.runtimeAuthenticationKey,
    })
  return Object.freeze({ selection, reservation })
}

/** Creates one store rooted at a seeded planning commit and immutable journal. */
function createSeededTargetCommitStore(
  fixture:
    AuthenticWorkspaceSearchMigrationRehearsalTargetPreimageCommitGateFixture,
  evidence: WorkspaceSearchMigrationRehearsalStageCommitEvidence,
): Readonly<{
  /** Exact durable store under test. */
  readonly store: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageReservationAwsStore
  >
  /** Mutable in-memory transport retaining the seeded rows. */
  readonly transport: MemoryStageReservationTransport
}> {
  const transport = new MemoryStageReservationTransport()
  transport.seedCommittedStage(
    fixture.reservation,
    fixture.receipt,
    evidence,
  )
  const store =
    createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
      binding: {
        stateTableName,
        requestedResourcesBinding:
          fixture.reservation.requestedResourcesBinding,
      },
      manifest: fixture.selection.manifest,
      manifestVerificationKey: fixture.runtimeAuthenticationKey,
      transport,
    })
  return Object.freeze({ store, transport })
}

describe('Workspace Search rehearsal durable stage reservation AWS store', () => {
  test('pins rollback apply claims to the planning journal preimage bytes', async () => {
    const fixture =
      createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture(
        'target-preimage',
      )
    if (fixture.kind !== 'target-preimage') {
      throw new Error('Expected target-preimage fixture.')
    }
    const authorization =
      finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
        fixture.finalizationInput,
        new Uint8Array(fixture.runtimeAuthenticationKey),
        new Uint8Array(fixture.publicationAuthenticationKey),
      )
    const binding =
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        authorization,
      )
    const evidence = createSeededTargetCommitEvidence(fixture, binding)
    const matching = createRollbackApplyReservation(
      fixture,
      binding,
      binding.contentDigest,
      0x31,
    )
    const substituted = createRollbackApplyReservation(
      fixture,
      binding,
      digest('substituted-authentic-preimage-bytes'),
      0x32,
    )

    const rejected = createSeededTargetCommitStore(fixture, evidence)
    await expect(rejected.store.claim({
      reservation: substituted.reservation,
      selection: substituted.selection,
      previousReceipt: fixture.receipt,
      observedAt: substituted.reservation.reservedAt,
      verificationKey: fixture.runtimeAuthenticationKey,
      publicationVerificationKey: fixture.publicationAuthenticationKey,
    })).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalStageReservationAwsError,
    )
    expect(await rejected.store.read()).toMatchObject({
      completedStageOrdinal: fixture.receipt.stageOrdinal,
      headReceiptDigest: createMigrationDigest(fixture.receipt),
      activeReservationDigest: null,
    })

    const accepted = createSeededTargetCommitStore(fixture, evidence)
    await expect(accepted.store.claim({
      reservation: matching.reservation,
      selection: matching.selection,
      previousReceipt: fixture.receipt,
      observedAt: matching.reservation.reservedAt,
      verificationKey: fixture.runtimeAuthenticationKey,
      publicationVerificationKey: fixture.publicationAuthenticationKey,
    })).resolves.toMatchObject({
      completedStageOrdinal: fixture.receipt.stageOrdinal,
      activeReservationDigest: createMigrationDigest(matching.reservation),
      activeStageOrdinal: matching.selection.entry.ordinal,
    })
  })

  test('authenticates and consumes genuine command-specific commit caps', () => {
    const targetFixture =
      createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture(
        'target-preimage',
      )
    if (targetFixture.kind !== 'target-preimage') {
      throw new Error('Expected target-preimage fixture.')
    }
    const targetAuthorization =
      finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
        targetFixture.finalizationInput,
        targetFixture.runtimeAuthenticationKey,
        targetFixture.publicationAuthenticationKey,
      )
    const targetBinding =
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        targetAuthorization,
      )
    expect(targetBinding.prospectivePlanningReceiptDigest).toBe(
      createMigrationDigest(targetFixture.receipt),
    )
    expect(targetBinding.expectedPlanningReceiptCompletedAt).toBe(
      targetFixture.receipt.completedAt,
    )
    expect(Date.parse(targetBinding.commitGateObservedAt)).toBeLessThan(
      Date.parse(targetFixture.reservation.expiresAt),
    )
    expect(
      consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        targetAuthorization,
      ),
    ).toEqual(targetBinding)

    const terminalFixture =
      createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture(
        'terminal-reconciliation',
      )
    if (
      terminalFixture.kind !== 'terminal-reconciliation' ||
      terminalFixture.receipt.evidence.kind !== 'terminal'
    ) throw new Error('Expected terminal-reconciliation fixture.')
    const terminalAuthorization =
      finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
        terminalFixture.finalizationInput,
        terminalFixture.runtimeAuthenticationKey,
        terminalFixture.publicationAuthenticationKey,
      )
    const terminalBinding =
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        terminalAuthorization,
      )
    expect(createMigrationDigest(terminalBinding)).toBe(
      terminalFixture.receipt.evidence
        .reconciliationArtifactBindingDigest,
    )
    expect(terminalBinding.rate.predecessor).toEqual(
      terminalFixture.receipt.rateSegment,
    )
    expect(Date.parse(terminalBinding.rate.completedAt)).toBeLessThan(
      Date.parse(terminalFixture.reservation.expiresAt),
    )
    expect(
      consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
        terminalAuthorization,
      ),
    ).toEqual(terminalBinding)
  })

  test('rejects missing, wrong-kind, cloned, proxied, and reused special caps', () => {
    const targetFixture =
      createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture(
        'target-preimage',
      )
    const terminalFixture =
      createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture(
        'terminal-reconciliation',
      )
    if (
      targetFixture.kind !== 'target-preimage' ||
      terminalFixture.kind !== 'terminal-reconciliation'
    ) throw new Error('Expected both special commit-gate fixtures.')
    const targetAuthorization =
      finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
        targetFixture.finalizationInput,
        targetFixture.runtimeAuthenticationKey,
        targetFixture.publicationAuthenticationKey,
      )
    const terminalAuthorization =
      finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
        terminalFixture.finalizationInput,
        terminalFixture.runtimeAuthenticationKey,
        terminalFixture.publicationAuthenticationKey,
      )

    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        null,
      )).toThrow()
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        null,
      )).toThrow()
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        terminalAuthorization,
      )).toThrow()
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        targetAuthorization,
      )).toThrow()
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        Object.freeze({ ...targetAuthorization }),
      )).toThrow()
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        new Proxy(targetAuthorization, {}),
      )).toThrow()
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        Object.freeze({ ...terminalAuthorization }),
      )).toThrow()
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        new Proxy(terminalAuthorization, {}),
      )).toThrow()

    consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
      targetAuthorization,
    )
    consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
      terminalAuthorization,
    )
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
        targetAuthorization,
      )).toThrow()
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        targetAuthorization,
      )).toThrow()
    expect(() =>
      readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
        terminalAuthorization,
      )).toThrow()
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
        terminalAuthorization,
      )).toThrow()
  })

  test('claims once, commits the persisted receipt, and rejects replay', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store, transport } = createStore(fixture)
    const reservation = createReservation(fixture, 1)
    const claimed = await store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    expect(claimed).toMatchObject({
      completedStageOrdinal: 0,
      activeStageOrdinal: 1,
      revision: 1,
    })
    await expect(store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:02:00.000Z',
      verificationKey: fixture.authenticationKey,
    })).resolves.toEqual(claimed)

    const wrongRevisionHead = Object.freeze({
      ...claimed,
      revision: claimed.revision + 1,
    })
    const wrongRevisionCommit = await createStoreCommitInput(
      fixture,
      reservation,
      wrongRevisionHead,
    )
    await expect(store.commit(wrongRevisionCommit.input))
      .rejects.toMatchObject({ code: 'INVALID_STAGE_RESERVATION_STATE' })
    const foreignReservation = createReservation(fixture, 42)
    const foreignHead = Object.freeze({
      ...claimed,
      activeReservationDigest: createMigrationDigest(foreignReservation),
      activeExpiresAt: foreignReservation.expiresAt,
    })
    const foreignCommit = await createStoreCommitInput(
      fixture,
      foreignReservation,
      foreignHead,
    )
    await expect(store.commit(foreignCommit.input))
      .rejects.toMatchObject({ code: 'STAGE_RESERVATION_CONFLICT' })

    const commit = await createStoreCommitInput(fixture, reservation, claimed)
    const receipt = commit.artifacts.receipt
    const committed = await store.commit(commit.input)
    expect(committed.transportObservation).toBe('transaction-returned')
    expect(committed.head).toEqual({
      manifestDigest: fixture.selection.manifestDigest,
      completedStageOrdinal: 1,
      headReceiptDigest: createMigrationDigest(receipt),
      activeReservationDigest: null,
      activeStageOrdinal: null,
      activeExpiresAt: null,
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      revision: 2,
    })
    await expect(store.commit(commit.input)).rejects.toMatchObject({
      code: 'INVALID_STAGE_RESERVATION_STATE',
    })
    expect(transport.consistentReadCount).toBeGreaterThanOrEqual(4)
  })

  test('allows exactly one concurrent sibling claim', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store } = createStore(fixture)
    const first = createReservation(fixture, 2)
    const second = createReservation(fixture, 3)
    const results = await Promise.allSettled([
      store.claim({
        reservation: first,
        selection: fixture.selection,
        observedAt: '2026-08-02T00:01:00.000Z',
        verificationKey: fixture.authenticationKey,
      }),
      store.claim({
        reservation: second,
        selection: fixture.selection,
        observedAt: '2026-08-02T00:01:00.000Z',
        verificationKey: fixture.authenticationKey,
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status !== 'rejected') {
      throw new Error('Expected one rejected sibling claim.')
    }
    expect(rejected.reason).toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalStageReservationAwsError,
    )
    expect(rejected.reason).toMatchObject({
      code: 'STAGE_RESERVATION_CONFLICT',
    })
  })

  test('selects one exact-deadline commit or abandonment through the same CAS', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store, transport } = createStore(fixture)
    const reservation = createReservation(fixture, 0x71)
    const claimed = await store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    const deadline = new Date(
      Date.parse(reservation.expiresAt) +
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
    ).toISOString()
    const commit = await createStoreCommitInput(
      fixture,
      reservation,
      claimed,
      Object.freeze([]),
      '2026-08-02T00:22:30.000Z',
      deadline,
    )
    const abandonment = await createStageAbandonmentArtifacts(
      fixture,
      reservation,
      claimed,
      deadline,
    )

    const results = await Promise.allSettled([
      store.commit(commit.input),
      store.abandon({
        reservation,
        selection: fixture.selection,
        abandonment: abandonment.abandonment,
        runtimeKeyCleanupAuthorization:
          abandonment.runtimeKeyCleanupAuthorization,
        observedAt: deadline,
        runtimeVerificationKey: fixture.authenticationKey,
        publicationVerificationKey:
          fixture.publicationAuthenticationKey,
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status !== 'rejected') {
      throw new Error('Expected one exact-deadline CAS loser.')
    }
    expect(rejected.reason).toMatchObject({
      code: 'STAGE_RESERVATION_CONFLICT',
    })
    const finalHead = await store.read()
    expect(finalHead).toMatchObject({
      activeReservationDigest: null,
      activeStageOrdinal: null,
      activeExpiresAt: null,
      revision: claimed.revision + 1,
    })
    expect([
      finalHead.completedStageOrdinal,
      finalHead.abandonmentCount,
    ]).toEqual(
      finalHead.completedStageOrdinal === 1 ? [1, 0] : [0, 1],
    )
    expect(transport.journalCount()).toBe(1)
  })

  test('rejects cloned and proxied cleanup caps before consuming the genuine cap', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store } = createStore(fixture)
    const reservation = createReservation(fixture, 101)
    const claimed = await store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    const commit = await createStoreCommitInput(fixture, reservation, claimed)
    await expect(store.commit(Object.freeze({
      ...commit.input,
      runtimeKeyCleanupAuthorization: structuredClone(
        commit.artifacts.runtimeKeyCleanupAuthorization,
      ),
    }))).rejects.toMatchObject({
      code: 'INVALID_STAGE_RESERVATION_STATE',
    })
    await expect(store.commit(Object.freeze({
      ...commit.input,
      runtimeKeyCleanupAuthorization: new Proxy(
        commit.artifacts.runtimeKeyCleanupAuthorization,
        Object.freeze({}),
      ),
    }))).rejects.toMatchObject({
      code: 'INVALID_STAGE_RESERVATION_STATE',
    })
    await expect(store.commit(commit.input)).resolves.toMatchObject({
      transportObservation: 'transaction-returned',
      head: { revision: claimed.revision + 1 },
    })
  })

  test('pins one manifest globally for the same permit and resources', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store, transport } = createStore(fixture)
    await store.claim({
      reservation: createReservation(fixture, 0x31),
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    const manifest = fixture.manifest
    const conflictingManifest =
      createWorkspaceSearchMigrationRehearsalStageManifest({
        claims: Object.freeze({
          kind: manifest.kind,
          manifestVersion: manifest.manifestVersion,
          stage: manifest.stage,
          commit: manifest.commit,
          permitDigest: manifest.permitDigest,
          evidenceKeyDigest: manifest.evidenceKeyDigest,
          publicationKeyDigest: manifest.publicationKeyDigest,
          deploymentTrustRootDigest:
            manifest.deploymentTrustRootDigest,
          requestedResourcesBinding:
            manifest.requestedResourcesBinding,
          integrityResourceIdentityScheme:
            manifest.integrityResourceIdentityScheme,
          integrityResourceIdentities:
            manifest.integrityResourceIdentities,
          integrityResourceIdentityDigest:
            manifest.integrityResourceIdentityDigest,
          configurationBindingDigest:
            manifest.configurationBindingDigest,
          policyVersion: manifest.policyVersion,
          reviewedAt: '2026-08-02T00:00:00.001Z',
          entries: manifest.entries,
        }),
        signingKey: fixture.authenticationKey,
      })
    const conflictingStore =
      createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
        binding: {
          stateTableName,
          requestedResourcesBinding: fixture.requestedResourcesBinding,
        },
        manifest: conflictingManifest,
        manifestVerificationKey: fixture.authenticationKey,
        transport,
      })

    await expect(conflictingStore.read()).rejects.toMatchObject({
      code: 'STAGE_RESERVATION_CONFLICT',
    })
  })

  test('reconciles only the exact claim successor after response loss', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const exact = createStore(fixture)
    const reservation = createReservation(fixture, 8)
    exact.transport.loseNextWriteResponse = true
    await expect(exact.store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })).resolves.toMatchObject({
      activeReservationDigest: createMigrationDigest(reservation),
      activeStageOrdinal: 1,
      revision: 1,
    })
    await expect(exact.store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:02:00.000Z',
      verificationKey: fixture.authenticationKey,
    })).resolves.toMatchObject({ revision: 1 })

    const drifted = createStore(fixture)
    drifted.transport.loseNextWriteResponse = true
    drifted.transport.driftNextResponseLossWriteNonce = true
    await expect(drifted.store.claim({
      reservation: createReservation(fixture, 9),
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })).rejects.toMatchObject({
      code: 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN',
    })
  })

  test('admits crossing-expiry recovery through the inclusive deadline only', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const cases = Object.freeze([
      Object.freeze({
        nonce: 3,
        preparedAt: '2026-08-02T00:22:30.000Z',
        dispatchAt: '2026-08-02T00:30:00.000Z',
        expected: 'bounded-recovery',
      }),
      Object.freeze({
        nonce: 4,
        preparedAt: '2026-08-02T00:22:30.000Z',
        dispatchAt: '2026-08-02T00:45:00.000Z',
        expected: 'bounded-recovery',
      }),
      Object.freeze({
        nonce: 5,
        preparedAt: '2026-08-02T00:22:30.000Z',
        dispatchAt: '2026-08-02T00:45:00.001Z',
        expected: 'conflict',
      }),
      Object.freeze({
        nonce: 6,
        preparedAt: '2026-08-02T00:31:00.000Z',
        dispatchAt: '2026-08-02T00:32:00.000Z',
        expected: 'bounded-recovery',
      }),
    ])
    for (const testCase of cases) {
      const { store } = createStore(fixture)
      const reservation = createReservation(fixture, testCase.nonce)
      const claimed = await store.claim({
        reservation,
        selection: fixture.selection,
        observedAt: '2026-08-02T00:01:00.000Z',
        verificationKey: fixture.authenticationKey,
      })
      const commit = await createStoreCommitInput(
        fixture,
        reservation,
        claimed,
        Object.freeze([]),
        testCase.preparedAt,
        testCase.dispatchAt,
      )
      if (testCase.expected === 'conflict') {
        await expect(store.commit(commit.input)).rejects.toMatchObject({
          code: 'STAGE_RESERVATION_CONFLICT',
        })
        expect((await store.read()).activeStageOrdinal).toBe(1)
        continue
      }
      await expect(store.commit(commit.input)).resolves.toMatchObject({
        commitEvidence: {
          admissionMode: testCase.expected,
          commitAdmittedAt: testCase.dispatchAt,
        },
      })
    }
  })

  test('atomically reconciles the exact head and immutable commit row after response loss', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store, transport } = createStore(fixture)
    const reservation = createReservation(fixture, 0x71)
    const claimed = await store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    const commit = await createStoreCommitInput(fixture, reservation, claimed)
    const receipt = commit.artifacts.receipt
    const commitEvidence = createExpectedCommitEvidence(
      fixture,
      commit.artifacts.commitIntent,
    )
    transport.loseNextWriteResponse = true

    await expect(store.commit(commit.input)).resolves.toMatchObject({
      transportObservation: 'exact-strong-read-reconciled',
      head: { completedStageOrdinal: 1, revision: 2 },
      commitEvidence,
    })
    expect(transport.journalCount()).toBe(1)
    const recovery = await store.recoverCommit({
      receipt,
      stageOrdinal: 1,
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey:
        fixture.publicationAuthenticationKey,
    })
    expect(
      readWorkspaceSearchMigrationRehearsalStageCommitDurabilityAuthorizationBinding(
        recovery,
      ),
    ).toMatchObject({
      commitEvidence,
      currentHead: { completedStageOrdinal: 1, revision: 2 },
    })
    await expect(store.recoverCommit({
      receipt,
      stageOrdinal: 1,
      runtimeVerificationKey: new Uint8Array(32).fill(0x72),
      publicationVerificationKey:
        fixture.publicationAuthenticationKey,
    })).rejects.toMatchObject({ code: 'INVALID_STAGE_RESERVATION_STATE' })
  })

  test('never accepts a head without its exact immutable commit row', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store, transport } = createStore(fixture)
    const reservation = createReservation(fixture, 0x73)
    const claimed = await store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    const commit = await createStoreCommitInput(fixture, reservation, claimed)
    const receipt = commit.artifacts.receipt
    await store.commit(commit.input)
    transport.removeCommitJournal()

    await expect(store.commit(commit.input)).rejects.toMatchObject({
      code: 'INVALID_STAGE_RESERVATION_STATE',
    })
    await expect(store.recoverCommit({
      receipt,
      stageOrdinal: 1,
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey:
        fixture.publicationAuthenticationKey,
    })).rejects.toMatchObject({ code: 'INVALID_STAGE_RESERVATION_STATE' })
  })

  test('rejects tampered immutable evidence and leaves no row on pre-commit uncertainty', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const uncertain = createStore(fixture)
    const reservation = createReservation(fixture, 0x74)
    const claimed = await uncertain.store.claim({
      reservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    const uncertainCommit = await createStoreCommitInput(
      fixture,
      reservation,
      claimed,
    )
    uncertain.transport.failNextWriteUncertain = true
    await expect(uncertain.store.commit(uncertainCommit.input))
      .rejects.toMatchObject({
      code: 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN',
      })
    expect(uncertain.transport.journalCount()).toBe(0)
    await expect(uncertain.store.read()).resolves.toMatchObject({
      activeStageOrdinal: 1,
      completedStageOrdinal: 0,
    })

    const committed = createStore(fixture)
    const committedReservation = createReservation(fixture, 0x75)
    const committedClaim = await committed.store.claim({
      reservation: committedReservation,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    const committedInput = await createStoreCommitInput(
      fixture,
      committedReservation,
      committedClaim,
    )
    const committedReceipt = committedInput.artifacts.receipt
    await committed.store.commit(committedInput.input)
    committed.transport.corruptCommitEvidenceJson()
    await expect(committed.store.recoverCommit({
      receipt: committedReceipt,
      stageOrdinal: 1,
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey:
        fixture.publicationAuthenticationKey,
    })).rejects.toMatchObject({ code: 'INVALID_STAGE_RESERVATION_STATE' })
  })

  test('requires parent-signed abandonment before replacement and fences the old token', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store, transport } = createStore(fixture)
    const expired = createReservation(
      fixture,
      4,
      reservedAt,
      '2026-08-02T00:05:00.000Z',
    )
    const originalClaim = await store.claim({
      reservation: expired,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    const takeover = createReservation(
      fixture,
      5,
      '2026-08-02T00:20:00.000Z',
      expiresAt,
    )
    await expect(store.claim({
      reservation: takeover,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:05:00.000Z',
      verificationKey: fixture.authenticationKey,
    })).rejects.toMatchObject({ code: 'STAGE_RESERVATION_CONFLICT' })
    await expect(store.claim({
      reservation: expired,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:23:00.000Z',
      verificationKey: fixture.authenticationKey,
    })).resolves.toEqual(originalClaim)
    const cleanupDirectory = await mkdtemp(join(
      tmpdir(),
      'mukuroji-stage-abandon-cleanup-',
    ))
    await writeFile(
      join(
        cleanupDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ),
      fixture.authenticationKey,
      { mode: 0o600 },
    )
    const cleanupTimes = [
      new Date('2026-08-02T00:04:59.000Z'),
      new Date('2026-08-02T00:04:59.500Z'),
    ]
    let cleanupTimeIndex = 0
    const runtimeKeyCleanupAuthorization =
      await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
        evidenceDirectory: cleanupDirectory,
        reservation: expired,
        selection: fixture.selection,
        expectedRuntimeKey: fixture.authenticationKey,
        publicationAuthenticationKey:
          fixture.publicationAuthenticationKey,
        now: (): Date => {
          const value = cleanupTimes[cleanupTimeIndex]
          cleanupTimeIndex += 1
          if (value === undefined) throw new Error('Unexpected cleanup clock read.')
          return value
        },
      })
    const cleanupBinding =
      readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
        runtimeKeyCleanupAuthorization,
      )
    const abandonment =
      createWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
        reservation: expired,
        selection: fixture.selection,
        reservationClaimRevision: originalClaim.revision,
        previousAbandonmentCount: originalClaim.abandonmentCount,
        previousAbandonmentRootDigest:
          originalClaim.abandonmentRootDigest,
        abandonedAt: '2026-08-02T00:20:00.000Z',
        runtimeKeyCleanupCompletionDigest:
          cleanupBinding.cleanupCompletionDigest,
        runtimeVerificationKey: fixture.authenticationKey,
        publicationSigningKey: fixture.publicationAuthenticationKey,
      })
    const readsBeforeRecoveryDeadline = transport.consistentReadCount
    await expect(store.abandon({
      reservation: expired,
      selection: fixture.selection,
      abandonment,
      runtimeKeyCleanupAuthorization,
      observedAt: '2026-08-02T00:19:59.999Z',
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey:
        fixture.publicationAuthenticationKey,
    })).rejects.toMatchObject({
      code: 'STAGE_RESERVATION_RECOVERY_REQUIRED',
    })
    expect(transport.consistentReadCount).toBe(readsBeforeRecoveryDeadline)
    await expect(store.abandon({
      reservation: expired,
      selection: fixture.selection,
      abandonment,
      runtimeKeyCleanupAuthorization,
      observedAt: '2026-08-02T00:20:00.000Z',
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey: fixture.authenticationKey,
    })).rejects.toMatchObject({ code: 'INVALID_STAGE_RESERVATION_STATE' })
    const readsBeforeForgedCleanup = transport.consistentReadCount
    for (const forgedCleanupAuthorization of [
      Object.freeze({ ...runtimeKeyCleanupAuthorization }),
      structuredClone(runtimeKeyCleanupAuthorization),
      new Proxy(runtimeKeyCleanupAuthorization, {}),
    ]) {
      await expect(store.abandon({
        reservation: expired,
        selection: fixture.selection,
        abandonment,
        runtimeKeyCleanupAuthorization: forgedCleanupAuthorization,
        observedAt: '2026-08-02T00:20:00.000Z',
        runtimeVerificationKey: fixture.authenticationKey,
        publicationVerificationKey:
          fixture.publicationAuthenticationKey,
      })).rejects.toMatchObject({ code: 'INVALID_STAGE_RESERVATION_STATE' })
    }
    expect(transport.consistentReadCount).toBe(readsBeforeForgedCleanup)
    transport.loseNextWriteResponse = true
    await expect(store.abandon({
      reservation: expired,
      selection: fixture.selection,
      abandonment,
      runtimeKeyCleanupAuthorization,
      observedAt: '2026-08-02T00:20:00.000Z',
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey:
        fixture.publicationAuthenticationKey,
    })).resolves.toMatchObject({
      activeReservationDigest: null,
      abandonmentCount: 1,
      abandonmentRootDigest: abandonment.abandonmentRootDigest,
      revision: 2,
    })
    const readsBeforeReplay = transport.consistentReadCount
    await expect(store.abandon({
      reservation: expired,
      selection: fixture.selection,
      abandonment,
      runtimeKeyCleanupAuthorization,
      observedAt: '2026-08-02T00:20:00.000Z',
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey:
        fixture.publicationAuthenticationKey,
    })).rejects.toMatchObject({ code: 'INVALID_STAGE_RESERVATION_STATE' })
    expect(transport.consistentReadCount).toBe(readsBeforeReplay)
    const claimed = await store.claim({
      reservation: takeover,
      selection: fixture.selection,
      observedAt: '2026-08-02T00:20:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    expect(claimed).toMatchObject({
      activeReservationDigest: createMigrationDigest(takeover),
      activeStageOrdinal: 1,
      abandonmentCount: 1,
      abandonmentRootDigest: abandonment.abandonmentRootDigest,
      revision: 3,
    })
    expect(transport.journalCount()).toBe(1)
    await rm(cleanupDirectory, { force: true, recursive: true })
  })

  test('fails closed on uncertain writes and authenticated-state drift', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const { store, transport } = createStore(fixture)
    transport.failNextWriteUncertain = true
    await expect(store.claim({
      reservation: createReservation(fixture, 6),
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })).rejects.toMatchObject({
      code: 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN',
    })

    await store.claim({
      reservation: createReservation(fixture, 7),
      selection: fixture.selection,
      observedAt: '2026-08-02T00:01:00.000Z',
      verificationKey: fixture.authenticationKey,
    })
    transport.corruptStateJson()
    await expect(store.read()).rejects.toMatchObject({
      code: 'INVALID_STAGE_RESERVATION_STATE',
    })
  })
})
