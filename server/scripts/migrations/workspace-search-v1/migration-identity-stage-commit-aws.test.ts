import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureWorkspaceSearchMigrationRehearsalChildMutationObservation,
  createWorkspaceSearchMigrationRehearsalStageChildMaterial,
} from './migration-rehearsal-stage-child-material'
import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandOutput,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  GetBucketTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { STSClient } from '@aws-sdk/client-sts'
import { createMigrationDigest } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
} from './migration-rehearsal-rate-evidence'
import type {
  WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'
import {
  commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation,
  createAwsWorkspaceSearchMigrationRateManagedSession,
  type CommitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput,
} from './migration-identity-aws'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
  type WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import type {
  WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
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
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  createWorkspaceSearchMigrationRehearsalStageReservationAwsStore,
  createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND,
  type WorkspaceSearchMigrationRehearsalStageHead,
  type WorkspaceSearchMigrationRehearsalStageReservationAwsTransport,
} from './migration-rehearsal-stage-reservation-aws'

/** Exact resources matching the reusable authenticated stage fixture. */
const requested: WorkspaceSearchMigrationRequestedResources = {
  account: '111111111111',
  region: 'us-east-1',
  profile: 'migration-stage-commit-test',
  commit: 'a'.repeat(40),
  tables: {
    'project-directory': 'commit-project-directory',
    'work-items': 'commit-work-items',
    collaboration: 'commit-collaboration',
    documents: 'commit-documents',
    'workspace-search': 'commit-workspace-search',
    'migration-state': 'commit-migration-state',
  },
  journalBucket: 'commit-journal-bucket',
  journalKeyArn:
    'arn:aws:kms:us-east-1:111111111111:key/' +
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}

/** Exact reviewed rate policy bound into the authenticated manifest. */
const ratePolicy: WorkspaceSearchMigrationDescribeTableRatePolicy = {
  policyVersion: 'b'.repeat(64),
  maximumAttemptsPerWindow: 1_000,
  maximumAttemptsPerLifecycle: 2_000,
  checkpointPageAttemptCapacity: 182,
  windowMilliseconds: 1_000,
  minimumAttemptIntervalMilliseconds: 1,
  minimumPageIntervalMilliseconds: 1,
  maximumAdmissionWaitMilliseconds: 5_000,
  throttleBackoffInitialMilliseconds: 1,
  throttleBackoffMaximumMilliseconds: 1,
}

/** Stable trusted commit instant inside both permit and reservation. */
const commitTime = '2026-08-02T00:25:00.000Z'

/** Returns one deterministic lowercase SHA-256 digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Returns the durable lease identity represented by one fixture observation. */
function readFixtureLeaseIdentityDigest(
  observation: WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
): string {
  return observation.kind === 'acquired'
    ? observation.successorLeaseIdentityDigest
    : observation.currentLeaseIdentityDigest
}

/** Explicit conditional cancellation understood by the durable store. */
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

/** In-memory exact-predecessor stage row shared with mocked SDK clients. */
class StageCommitStateHarness
  implements WorkspaceSearchMigrationRehearsalStageReservationAwsTransport {
  /** Ordered remote preflight and state operations. */
  readonly events: string[] = []

  /** Whether the next installed transaction loses its response. */
  loseNextWriteResponse = false

  /** Whether response loss exposes another valid durable revision. */
  driftNextResponseLossRevision = false

  /** Whether the next strong read has an outcome-uncertain failure. */
  failNextReadUncertain = false

  /** Current single durable stage-head row. */
  private item: Readonly<Record<string, AttributeValue>> | undefined

  /** Immutable commit journal rows keyed by deterministic record key. */
  private readonly journalItems =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Clears setup events before the standalone factory is invoked. */
  resetEvents(): void {
    this.events.length = 0
  }

  /**
   * Strongly reads the current exact stage-head row.
   *
   * @param command - Adapter-owned consistent point read.
   * @returns Detached current item or an absent response.
   */
  async getRehearsalStageReservation(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    if (
      command.input.TableName !== requested.tables['migration-state'] ||
      command.input.ConsistentRead !== true ||
      command.input.Key?.recordKey?.S?.startsWith(
        'rehearsal-suite/v2/',
      ) !== true
    ) throw new Error('unexpected-stage-read')
    this.events.push('stage-read')
    if (this.failNextReadUncertain) {
      this.failNextReadUncertain = false
      throw new Error('uncertain-stage-read')
    }
    const recordKey = command.input.Key?.recordKey?.S
    const selected = recordKey?.endsWith('/root') === true
      ? this.item
      : recordKey === undefined
      ? undefined
      : this.journalItems.get(recordKey)
    return {
      $metadata: {},
      ...(selected === undefined
        ? {}
        : { Item: structuredClone(selected) }),
    }
  }

  /**
   * Applies one absent or exact-predecessor stage-head transaction.
   *
   * @param command - Adapter-owned single-Put transaction.
   * @returns Empty success unless the response is intentionally lost.
   */
  async transactWriteRehearsalStageReservation(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    const transactions = command.input.TransactItems
    const put = transactions?.[0]?.Put
    const journalPut = transactions?.[1]?.Put
    if (
      (transactions?.length !== 1 && transactions?.length !== 2) ||
      put?.TableName !== requested.tables['migration-state'] ||
      put.Item?.kind?.S !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_HEAD_KIND ||
      typeof put.ConditionExpression !== 'string'
    ) throw new Error('unexpected-stage-write')
    if (transactions.length === 2) {
      const journalRecordKey = journalPut?.Item?.recordKey?.S
      if (
        journalPut?.TableName !== requested.tables['migration-state'] ||
        journalPut.Item === undefined ||
        journalRecordKey === undefined ||
        this.journalItems.has(journalRecordKey)
      ) throw new ConditionalTransactionFailure()
    }
    if (put.ConditionExpression.startsWith('attribute_not_exists')) {
      if (this.item !== undefined) throw new ConditionalTransactionFailure()
    } else if (
      this.item?.stateDigest?.S !==
        put.ExpressionAttributeValues?.[':expectedStateDigest']?.S ||
      this.item?.stateRevision?.N !==
        put.ExpressionAttributeValues?.[':expectedStateRevision']?.N ||
      this.item?.stateWriteNonce?.S !==
        put.ExpressionAttributeValues?.[':expectedStateWriteNonce']?.S
    ) {
      throw new ConditionalTransactionFailure()
    }
    this.events.push('stage-write')
    this.item = structuredClone(put.Item)
    if (journalPut?.Item !== undefined) {
      const journalRecordKey = journalPut.Item.recordKey?.S
      if (journalRecordKey === undefined) {
        throw new Error('missing-journal-record-key')
      }
      this.journalItems.set(
        journalRecordKey,
        structuredClone(journalPut.Item),
      )
    }
    if (this.loseNextWriteResponse) {
      this.loseNextWriteResponse = false
      if (this.driftNextResponseLossRevision) {
        this.driftNextResponseLossRevision = false
        const currentRevision = Number(this.item.stateRevision?.N)
        if (!Number.isSafeInteger(currentRevision)) {
          throw new Error('invalid-current-revision')
        }
        this.item = Object.freeze({
          ...this.item,
          stateRevision: { N: String(currentRevision + 1) },
        })
      }
      throw new Error('lost-stage-transaction-response')
    }
    return { $metadata: {} }
  }
}

/** Complete standalone fixture with one already claimed stage. */
type StandaloneStageCommitFixture = {
  /** Authentic permit, manifest, selection, and shared key. */
  readonly material:
    WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture
  /** Exact reservation currently active in the durable harness. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Authenticated receipt bound to the exact claim revision. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Publication-authenticated prepared local commit intent. */
  readonly commitIntent: WorkspaceSearchMigrationRehearsalStageCommitIntent
  /** Genuine process-local parent authorization capability. */
  readonly parentAuthorization:
    WorkspaceSearchMigrationRehearsalStageParentAuthorization
  /** Genuine unconsumed cleanup capability retained through AWS preflight. */
  readonly runtimeKeyCleanupAuthorization: Awaited<ReturnType<
    typeof cleanupWorkspaceSearchMigrationRehearsalRuntimeKey
  >>
  /** Independently reminted exact cleanup cap for one response-loss retry. */
  readonly runtimeKeyCleanupRetryAuthorization: Awaited<ReturnType<
    typeof cleanupWorkspaceSearchMigrationRehearsalRuntimeKey
  >>
  /** Secret-free head returned by the successful setup claim. */
  readonly claimedHead: WorkspaceSearchMigrationRehearsalStageHead
  /** Durable state used by the mocked standalone AWS transport. */
  readonly harness: StageCommitStateHarness
}

/**
 * Creates one authentic receipt bound to the claimed stage-one reservation.
 *
 * @param material - Authenticated selection and manifest fixture.
 * @param reservation - Exact active durable reservation.
 * @param claimRevision - Durable revision returned by the claim.
 * @returns HMAC-authenticated generic-success receipt.
 */
function createStageReceipt(
  material: WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  reservation: WorkspaceSearchMigrationRehearsalStageReservation,
  claimRevision: number,
  processLifecycle:
    WorkspaceSearchMigrationRehearsalStageReceipt['processLifecycle'],
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const entry = material.selection.entry
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
      manifestDigest: material.selection.manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
      permitDigest: material.manifest.permitDigest,
      commit: material.manifest.commit,
      requestedResourcesBinding:
        material.manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        material.manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities:
        material.manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        material.manifest.integrityResourceIdentityDigest,
      configurationBindingDigest:
        material.manifest.configurationBindingDigest,
      policyVersion: material.manifest.policyVersion,
      runLocatorDigest: digest('run-locator'),
      attemptOrdinal: entry.attemptOrdinal,
      attemptLocatorDigest: digest('attempt-locator'),
      ownerLocatorDigest: digest('owner-locator'),
      leaseIdentityDigest: readFixtureLeaseIdentityDigest(
        material.leaseAcquisitionObservation,
      ),
      leaseObservation: material.leaseAcquisitionObservation,
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest: closedWriterFenceRecordDigest,
      previousStageReceiptDigest: null,
      stageReservationDigest: createMigrationDigest(reservation),
      stageReservationClaimRevision: claimRevision,
      stageReservationCommitRevision: claimRevision + 1,
      stageReservationAbandonmentCount: 0,
      stageReservationAbandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
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
            material.authenticationKey,
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
    signingKey: material.authenticationKey,
  })
}

/** Creates one standalone fixture after an actual durable stage claim. */
async function createStandaloneFixture(): Promise<StandaloneStageCommitFixture> {
  const material =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
      requestedResourcesBinding:
        createWorkspaceSearchMigrationRequestedResourcesBinding(requested),
      configurationBindingDigest: 'c'.repeat(64),
      policyVersion: ratePolicy.policyVersion,
    })
  const reservation =
    createWorkspaceSearchMigrationRehearsalStageReservation({
      selection: material.selection,
      nonce: new Uint8Array(32).fill(0x61),
      reservedAt: '2026-08-02T00:05:00.000Z',
      expiresAt: '2026-08-02T00:30:00.000Z',
      expectedPreviousRateSegment: null,
      expectedCurrentRateSegmentOrdinal: 0,
      expectedTargetPreimageArtifactContentDigest: null,
      signingKey: material.authenticationKey,
    })
  const harness = new StageCommitStateHarness()
  const store =
    createWorkspaceSearchMigrationRehearsalStageReservationAwsStore({
      binding: {
        stateTableName: requested.tables['migration-state'],
        requestedResourcesBinding:
          material.requestedResourcesBinding,
      },
      manifest: material.manifest,
      manifestVerificationKey: material.authenticationKey,
      transport: harness,
    })
  const claimedHead = await store.claim({
    reservation,
    selection: material.selection,
    previousReceipt: null,
    observedAt: '2026-08-02T00:06:00.000Z',
    verificationKey: material.authenticationKey,
    publicationVerificationKey:
      material.publicationAuthenticationKey,
  })
  const capturedObservation =
    captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
      selection: material.selection,
      authenticationKey: material.authenticationKey,
      observation: material.observation,
    })
  const childMaterial =
    createWorkspaceSearchMigrationRehearsalStageChildMaterial({
      selection: material.selection,
      observation: capturedObservation,
      committedRateSegment: material.committedRateSegment,
      stageReservation: reservation,
      claimedStageHead: claimedHead,
      leaseAcquisitionObservation: material.leaseAcquisitionObservation,
      authenticationKey: material.authenticationKey,
    })
  const materialDigest = createMigrationDigest(childMaterial)
  const materialEvidence = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-child-material-evidence',
    evidenceVersion: 1,
    material: childMaterial,
    materialDigest,
    observedAt: '2026-08-02T00:20:00.000Z',
  })
  const lifecycle = Object.freeze({
    lifecycleVersion: 1,
    manifestDigest: material.selection.manifestDigest,
    manifestEntryDigest: createMigrationDigest(material.selection.entry),
    previousStageReceiptDigest:
      material.selection.previousStageReceiptDigest,
    stageOrdinal: material.selection.entry.ordinal,
    scenario: material.selection.entry.scenario,
    command: material.selection.entry.command,
    attemptOrdinal: material.selection.entry.attemptOrdinal,
    expectedOutcome: material.selection.entry.expectedOutcome,
    materialDigest,
    stdoutSha256: digest('identity-stage-commit-stdout'),
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
    'mukuroji-identity-stage-commit-cleanup-',
  ))
  let cleanupClockIndex = 0
  const cleanupTimes = Object.freeze([
    new Date('2026-08-02T00:22:10.000Z'),
    new Date('2026-08-02T00:22:20.000Z'),
  ])
  let runtimeKeyCleanupAuthorization: Awaited<ReturnType<
    typeof cleanupWorkspaceSearchMigrationRehearsalRuntimeKey
  >>
  let runtimeKeyCleanupRetryAuthorization: Awaited<ReturnType<
    typeof cleanupWorkspaceSearchMigrationRehearsalRuntimeKey
  >>
  try {
    await writeFile(
      join(
        cleanupDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ),
      material.authenticationKey,
      { mode: 0o600 },
    )
    runtimeKeyCleanupAuthorization =
      await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
        evidenceDirectory: cleanupDirectory,
        reservation,
        selection: material.selection,
        expectedRuntimeKey: material.authenticationKey,
        publicationAuthenticationKey:
          material.publicationAuthenticationKey,
        now: (): Date => {
          const value = cleanupTimes[cleanupClockIndex]
          cleanupClockIndex += 1
          if (value === undefined) {
            throw new Error('Unexpected cleanup clock read.')
          }
          return value
        },
      })
    runtimeKeyCleanupRetryAuthorization =
      await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
        evidenceDirectory: cleanupDirectory,
        reservation,
        selection: material.selection,
        expectedRuntimeKey: material.authenticationKey,
        publicationAuthenticationKey:
          material.publicationAuthenticationKey,
        now: (): Date => {
          throw new Error('Recovered cleanup must not sample a clock.')
        },
      })
  } finally {
    await rm(cleanupDirectory, { force: true, recursive: true })
  }
  const parentAuthentication =
    createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
      selection: material.selection,
      materialKind: 'success',
      persistedMaterialEvidence: materialEvidence,
      persistedLifecycleEvidence: lifecycleEvidence,
      runtimeAuthenticationKey: new Uint8Array(material.authenticationKey),
      publicationAuthenticationKey:
        new Uint8Array(material.publicationAuthenticationKey),
      runtimeKeyCleanupAuthorization,
    })
  const parentAuthorization =
    authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization({
      selection: material.selection,
      materialKind: 'success',
      persistedMaterialEvidence: materialEvidence,
      persistedLifecycleEvidence: lifecycleEvidence,
      parentAuthentication,
      runtimeAuthenticationKey: new Uint8Array(material.authenticationKey),
      publicationAuthenticationKey:
        new Uint8Array(material.publicationAuthenticationKey),
    })
  const receipt = createStageReceipt(
    material,
    reservation,
    claimedHead.revision,
    Object.freeze({
      lifecycleDigest,
      runnerStartedAt: lifecycle.runnerStartedAt,
      receiptObservedAt: lifecycle.materialObservedAt,
      receiptPersistedAt: lifecycle.materialPersistedAt,
      parentDecisionRecordedAt: null,
      processExitedAt: lifecycle.processExitedAt,
      exitClass: 'successful-no-fault',
    }),
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
        manifestDigest: material.selection.manifestDigest,
        permitDigest: material.manifest.permitDigest,
        requestedResourcesBinding: material.requestedResourcesBinding,
        stateTableLocationBindingDigest:
          createWorkspaceSearchMigrationRehearsalStageStateTableLocationBindingDigest({
            stateTableName: requested.tables['migration-state'],
            requestedResourcesBinding: material.requestedResourcesBinding,
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
          manifestDigest: receipt.manifestDigest,
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
          permitExpiresAt: material.permit.expiresAt,
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
        preparedAt: '2026-08-02T00:24:00.000Z',
        intentStatus: 'prepared',
      }),
      signingKey: material.publicationAuthenticationKey,
    })
  harness.resetEvents()
  return Object.freeze({
    material,
    reservation,
    receipt,
    commitIntent,
    parentAuthorization,
    runtimeKeyCleanupAuthorization,
    runtimeKeyCleanupRetryAuthorization,
    claimedHead,
    harness,
  })
}

/** Counts exact standalone SDK client cleanup. */
type StageCommitDestroyCounts = {
  /** DynamoDB client destroy count. */
  dynamodb: number
  /** S3 client destroy count. */
  s3: number
  /** STS client destroy count. */
  sts: number
}

/** Supported authenticated preflight drift injected by the SDK mock. */
type StageCommitPreflightDrift =
  | 'none'
  | 'caller'
  | 'deployment-trust-tag'
  | 'environment-tag'
  | 'production-account-tag'

/** Scoped SDK prototype mock for one standalone commit test. */
class StageCommitAwsMock {
  /** Exact state harness receiving all allowed DynamoDB operations. */
  private readonly harness: StageCommitStateHarness

  /** Authenticated fixture supplying expected caller and journal tags. */
  private readonly material:
    WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture

  /** Preflight mismatch selected for this invocation. */
  drift: StageCommitPreflightDrift = 'none'

  /** Optional synchronous mutation performed inside the first STS send. */
  onStsSend: (() => void) | undefined

  /** Exact client cleanup counts observed during the scoped run. */
  readonly destroyCounts: StageCommitDestroyCounts = {
    dynamodb: 0,
    s3: 0,
    sts: 0,
  }

  /**
   * Creates one scoped mock bound to a durable fixture.
   *
   * @param fixture - Authentic material and shared state harness.
   */
  constructor(fixture: StandaloneStageCommitFixture) {
    this.harness = fixture.harness
    this.material = fixture.material
  }

  /**
   * Runs one task with only STS, journal-tag, and stage-head SDK operations.
   *
   * @param task - Test callback invoking the standalone factory.
   * @returns Callback result after every SDK prototype is restored.
   */
  async run<Result>(task: () => Promise<Result>): Promise<Result> {
    const originalStsSend = STSClient.prototype.send
    const originalS3Send = S3Client.prototype.send
    const originalDynamoDbSend = DynamoDBClient.prototype.send
    const originalStsDestroy = STSClient.prototype.destroy
    const originalS3Destroy = S3Client.prototype.destroy
    const originalDynamoDbDestroy = DynamoDBClient.prototype.destroy
    Reflect.set(STSClient.prototype, 'send', (): unknown => {
      this.harness.events.push('sts')
      this.onStsSend?.()
      return Promise.resolve({
        $metadata: {},
        Account: this.material.permit.account,
        Arn: this.drift === 'caller'
          ? 'arn:aws:sts::111111111111:assumed-role/Other/session'
          : this.material.permit.callerArn,
        UserId: 'AROA12345678901234567:session',
      })
    })
    Reflect.set(
      S3Client.prototype,
      'send',
      (...callArguments: unknown[]): unknown => {
        if (!(callArguments[0] instanceof GetBucketTaggingCommand)) {
          return Promise.reject(new Error('unexpected-s3-command'))
        }
        this.harness.events.push('journal-tag')
        return Promise.resolve({
          $metadata: {},
          TagSet: [{
            Key: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ENVIRONMENT_TAG_KEY,
            Value: this.drift === 'environment-tag'
              ? 'production'
              : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_DEPLOYMENT_TRUST_ROOT_TAG_KEY,
            Value: this.drift === 'deployment-trust-tag'
              ? 'f'.repeat(64)
              : this.material.permit.deploymentTrustRootDigest,
          }, {
            Key:
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_TAG_KEY,
            Value:
              createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
                this.drift === 'production-account-tag'
                  ? '222222222222'
                  : this.material.permit.productionAccount,
              ),
          }],
        })
      },
    )
    Reflect.set(
      DynamoDBClient.prototype,
      'send',
      (...callArguments: unknown[]): unknown => {
        const command = callArguments[0]
        if (command instanceof GetItemCommand) {
          return this.harness.getRehearsalStageReservation(command)
        }
        if (command instanceof TransactWriteItemsCommand) {
          return this.harness.transactWriteRehearsalStageReservation(
            command,
          )
        }
        this.harness.events.push('unexpected-dynamodb')
        return Promise.reject(new Error('unexpected-dynamodb-command'))
      },
    )
    Reflect.set(DynamoDBClient.prototype, 'destroy', (): void => {
      this.destroyCounts.dynamodb += 1
    })
    Reflect.set(S3Client.prototype, 'destroy', (): void => {
      this.destroyCounts.s3 += 1
    })
    Reflect.set(STSClient.prototype, 'destroy', (): void => {
      this.destroyCounts.sts += 1
    })
    try {
      return await withStaticProfile(task)
    } finally {
      Reflect.set(STSClient.prototype, 'send', originalStsSend)
      Reflect.set(S3Client.prototype, 'send', originalS3Send)
      Reflect.set(
        DynamoDBClient.prototype,
        'send',
        originalDynamoDbSend,
      )
      Reflect.set(STSClient.prototype, 'destroy', originalStsDestroy)
      Reflect.set(S3Client.prototype, 'destroy', originalS3Destroy)
      Reflect.set(
        DynamoDBClient.prototype,
        'destroy',
        originalDynamoDbDestroy,
      )
    }
  }
}

/** Creates the exact standalone public input for one fixture. */
function createCommitInput(
  fixture: StandaloneStageCommitFixture,
  clockTime = commitTime,
  runtimeKeyCleanupAuthorization =
    fixture.runtimeKeyCleanupAuthorization,
): CommitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservationInput {
  return {
    requested: structuredClone(requested),
    ratePolicy: structuredClone(ratePolicy),
    permit: structuredClone(fixture.material.permit),
    permitVerificationKey: new Uint8Array(
      fixture.material.authenticationKey,
    ),
    permitClock: () => new Date(clockTime),
    stageReservationCommit: {
      reservation: structuredClone(fixture.reservation),
      selection: structuredClone(fixture.material.selection),
      receipt: structuredClone(fixture.receipt),
      previousReceipt: null,
      reservationAbandonments: Object.freeze([]),
      parentAuthorization: fixture.parentAuthorization,
      commitIntent: structuredClone(fixture.commitIntent),
      runtimeKeyCleanupAuthorization:
        runtimeKeyCleanupAuthorization,
      commitGateAuthorization: null,
      runtimeKey: new Uint8Array(fixture.material.authenticationKey),
      publicationKey:
        new Uint8Array(fixture.material.publicationAuthenticationKey),
    },
  }
}

/** Runs with a private static profile selected only by this test. */
async function withStaticProfile<Result>(
  task: () => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(
    join(tmpdir(), 'mukuroji-stage-commit-profile-'),
  )
  const credentialsFile = join(directory, 'credentials')
  const configFile = join(directory, 'config')
  await writeFile(
    credentialsFile,
    `[${requested.profile}]\n` +
      'aws_access_key_id = stage-commit-access-key\n' +
      'aws_secret_access_key = stage-commit-secret-key\n',
    { mode: 0o600 },
  )
  await writeFile(configFile, '', { mode: 0o600 })
  const previousCredentialsFile =
    process.env.AWS_SHARED_CREDENTIALS_FILE
  const previousConfigFile = process.env.AWS_CONFIG_FILE
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile
  process.env.AWS_CONFIG_FILE = configFile
  try {
    return await task()
  } finally {
    if (previousCredentialsFile === undefined) {
      delete process.env.AWS_SHARED_CREDENTIALS_FILE
    } else {
      process.env.AWS_SHARED_CREDENTIALS_FILE = previousCredentialsFile
    }
    if (previousConfigFile === undefined) {
      delete process.env.AWS_CONFIG_FILE
    } else {
      process.env.AWS_CONFIG_FILE = previousConfigFile
    }
    await rm(directory, { recursive: true, force: true })
  }
}

describe('standalone non-production rehearsal stage commit AWS factory', () => {
  test('commits after identity preflight without rate or DescribeTable I/O', async () => {
    const fixture = await createStandaloneFixture()
    const input = createCommitInput(fixture)
    const rawPermit = input.permit
    const rawReservation = input.stageReservationCommit.reservation
    const rawSelection = input.stageReservationCommit.selection
    const rawReceipt = input.stageReservationCommit.receipt
    const rawRuntimeKey = input.stageReservationCommit.runtimeKey
    const rawPublicationKey = input.stageReservationCommit.publicationKey
    const rawPermitKey = input.permitVerificationKey
    const mock = new StageCommitAwsMock(fixture)
    mock.onStsSend = () => {
      if (typeof rawPermit === 'object' && rawPermit !== null) {
        Reflect.set(rawPermit, 'account', '222222222222')
      }
      if (typeof rawReservation === 'object' && rawReservation !== null) {
        Reflect.set(rawReservation, 'expiresAt', '2026-08-02T00:24:00.000Z')
      }
      if (typeof rawSelection === 'object' && rawSelection !== null) {
        const entry = Reflect.get(rawSelection, 'entry')
        if (typeof entry === 'object' && entry !== null) {
          Reflect.set(entry, 'command', 'release')
        }
      }
      if (typeof rawReceipt === 'object' && rawReceipt !== null) {
        Reflect.set(rawReceipt, 'completedAt', '2026-08-02T00:26:00.000Z')
      }
      rawRuntimeKey.fill(0)
      rawPublicationKey.fill(0)
      rawPermitKey.fill(0)
      Reflect.set(input.requested.tables, 'migration-state', 'substituted')
      Reflect.set(input.ratePolicy, 'policyVersion', 'd'.repeat(64))
      Reflect.set(
        input,
        'permitClock',
        () => new Date('2026-08-02T01:00:00.000Z'),
      )
    }
    const result = await mock.run(async () =>
      await commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
        input,
      ))
    expect(result).toMatchObject({
      transportObservation: 'transaction-returned',
      head: {
        manifestDigest: fixture.material.selection.manifestDigest,
        completedStageOrdinal: 1,
        headReceiptDigest: createMigrationDigest(fixture.receipt),
        activeReservationDigest: null,
        activeStageOrdinal: null,
        activeExpiresAt: null,
        abandonmentCount: fixture.receipt.stageReservationAbandonmentCount,
        abandonmentRootDigest:
          fixture.receipt.stageReservationAbandonmentRootDigest,
        revision: fixture.receipt.stageReservationCommitRevision,
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.head)).toBe(true)
    expect(fixture.harness.events).toEqual([
      'sts',
      'journal-tag',
      'stage-read',
      'stage-write',
      'stage-read',
    ])
    expect(fixture.harness.events).not.toContain('unexpected-dynamodb')
    expect(mock.destroyCounts).toEqual({ dynamodb: 1, s3: 1, sts: 1 })
    expect(rawRuntimeKey).toEqual(new Uint8Array(32))
    expect(rawPublicationKey).toEqual(new Uint8Array(32))
    expect(rawPermitKey).toEqual(new Uint8Array(32))
  })

  test('recovers an exact response-loss successor and exact committed replay', async () => {
    const fixture = await createStandaloneFixture()
    const input = createCommitInput(fixture)
    const mock = new StageCommitAwsMock(fixture)
    fixture.harness.loseNextWriteResponse = true
    await mock.run(async () => {
      await expect(
        commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
          input,
        ),
      ).resolves.toMatchObject({
        transportObservation: 'exact-strong-read-reconciled',
        head: {
          headReceiptDigest: createMigrationDigest(fixture.receipt),
          revision: fixture.receipt.stageReservationCommitRevision,
        },
      })
      const replayOffset = fixture.harness.events.length
      const retryInput = createCommitInput(
        fixture,
        commitTime,
        fixture.runtimeKeyCleanupRetryAuthorization,
      )
      await expect(
        commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
          retryInput,
        ),
      ).resolves.toMatchObject({
        transportObservation: 'exact-strong-read-reconciled',
        head: {
          headReceiptDigest: createMigrationDigest(fixture.receipt),
          revision: fixture.receipt.stageReservationCommitRevision,
        },
      })
      expect(fixture.harness.events.slice(replayOffset)).toEqual([
        'sts',
        'journal-tag',
        'stage-read',
        'stage-read',
      ])
    })
    expect(fixture.harness.events.slice(0, 5)).toEqual([
      'sts',
      'journal-tag',
      'stage-read',
      'stage-write',
      'stage-read',
    ])
    expect(mock.destroyCounts).toEqual({ dynamodb: 2, s3: 2, sts: 2 })
  })

  test('keeps a wrong response-loss revision outcome uncertain', async () => {
    const fixture = await createStandaloneFixture()
    const mock = new StageCommitAwsMock(fixture)
    fixture.harness.loseNextWriteResponse = true
    fixture.harness.driftNextResponseLossRevision = true
    await mock.run(async () => {
      await expect(
        commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
          createCommitInput(fixture),
        ),
      ).rejects.toMatchObject({
        code: 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN',
      })
    })
    expect(fixture.harness.events).toEqual([
      'sts',
      'journal-tag',
      'stage-read',
      'stage-write',
      'stage-read',
    ])
    expect(mock.destroyCounts).toEqual({ dynamodb: 1, s3: 1, sts: 1 })
  })

  test('does not reconcile uncertainty that occurred before transaction send', async () => {
    const fixture = await createStandaloneFixture()
    const input = createCommitInput(fixture)
    const mock = new StageCommitAwsMock(fixture)
    await mock.run(async () => {
      await commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
        input,
      )
      const retryOffset = fixture.harness.events.length
      fixture.harness.failNextReadUncertain = true
      const retryInput = createCommitInput(
        fixture,
        commitTime,
        fixture.runtimeKeyCleanupRetryAuthorization,
      )
      await expect(
        commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
          retryInput,
        ),
      ).rejects.toMatchObject({
        code: 'STAGE_RESERVATION_TRANSPORT_UNCERTAIN',
      })
      expect(fixture.harness.events.slice(retryOffset)).toEqual([
        'sts',
        'journal-tag',
        'stage-read',
      ])
    })
    expect(mock.destroyCounts).toEqual({ dynamodb: 2, s3: 2, sts: 2 })
  })

  test('admits an authenticated dispatch at exact reservation expiry', async () => {
    const fixture = await createStandaloneFixture()
    const mock = new StageCommitAwsMock(fixture)
    await mock.run(async () => {
      await expect(
        commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
          createCommitInput(fixture, '2026-08-02T00:30:00.000Z'),
        ),
      ).resolves.toMatchObject({
        commitEvidence: {
          admissionMode: 'bounded-recovery',
          commitAdmittedAt: '2026-08-02T00:30:00.000Z',
        },
      })
    })
    expect(fixture.harness.events).toEqual([
      'sts',
      'journal-tag',
      'stage-read',
      'stage-write',
      'stage-read',
    ])
    expect(mock.destroyCounts).toEqual({ dynamodb: 1, s3: 1, sts: 1 })
  })

  test('rejects a new dispatch after the inclusive recovery deadline', async () => {
    const fixture = await createStandaloneFixture()
    const mock = new StageCommitAwsMock(fixture)
    await mock.run(async () => {
      await expect(
        commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
          createCommitInput(fixture, '2026-08-02T00:45:00.001Z'),
        ),
      ).rejects.toMatchObject({ code: 'STAGE_RESERVATION_CONFLICT' })
    })
    expect(fixture.harness.events).toEqual([
      'sts',
      'journal-tag',
    ])
    expect(mock.destroyCounts).toEqual({ dynamodb: 1, s3: 1, sts: 1 })
  })

  test('rejects permit expiry before constructing AWS clients', async () => {
    const fixture = await createStandaloneFixture()
    const mock = new StageCommitAwsMock(fixture)
    await expect(
      mock.run(async () =>
        await commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
          createCommitInput(fixture, '2026-08-02T02:30:00.000Z'),
        )),
    ).rejects.toMatchObject({
      code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
    })
    expect(fixture.harness.events).toEqual([])
    expect(mock.destroyCounts).toEqual({ dynamodb: 0, s3: 0, sts: 0 })
  })

  test('rejects caller and journal-tag mismatch before state I/O', async () => {
    const driftCases: readonly StageCommitPreflightDrift[] = [
      'caller',
      'deployment-trust-tag',
      'environment-tag',
      'production-account-tag',
    ]
    for (const drift of driftCases) {
      const fixture = await createStandaloneFixture()
      const mock = new StageCommitAwsMock(fixture)
      mock.drift = drift
      await mock.run(async () => {
        await expect(
          commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
            createCommitInput(fixture),
          ),
        ).rejects.toMatchObject({
          code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
        })
      })
      expect(fixture.harness.events).toEqual(
        drift === 'caller' ? ['sts'] : ['sts', 'journal-tag'],
      )
      expect(mock.destroyCounts).toEqual({ dynamodb: 1, s3: 1, sts: 1 })
    }
  })

  test('zeroizes the retained commit key after remote preflight failure', async () => {
    const fixture = await createStandaloneFixture()
    const input = createCommitInput(fixture)
    const callerRuntimeKey = input.stageReservationCommit.runtimeKey
    const callerPublicationKey = input.stageReservationCommit.publicationKey
    const expectedCallerRuntimeKey = new Uint8Array(callerRuntimeKey)
    const expectedCallerPublicationKey = new Uint8Array(callerPublicationKey)
    const originalFill = Uint8Array.prototype.fill
    let zeroizationCount = 0
    let zeroizationsAtSts = 0
    Reflect.set(
      Uint8Array.prototype,
      'fill',
      function (
        this: Uint8Array,
        ...callArguments: unknown[]
      ): unknown {
        const result = Reflect.apply(originalFill, this, callArguments)
        if (
          callArguments[0] === 0 &&
          this.byteLength === 32 &&
          Array.from(this).every((value) => value === 0)
        ) zeroizationCount += 1
        return result
      },
    )
    try {
      const mock = new StageCommitAwsMock(fixture)
      mock.drift = 'caller'
      mock.onStsSend = () => {
        zeroizationsAtSts = zeroizationCount
      }
      await expect(
        mock.run(async () =>
          await commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
            input,
          )),
      ).rejects.toMatchObject({
        code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
      })
      expect(zeroizationCount).toBeGreaterThan(zeroizationsAtSts)
      expect(callerRuntimeKey).toEqual(expectedCallerRuntimeKey)
      expect(callerPublicationKey).toEqual(expectedCallerPublicationKey)
      expect(mock.destroyCounts).toEqual({ dynamodb: 1, s3: 1, sts: 1 })
    } finally {
      Reflect.set(Uint8Array.prototype, 'fill', originalFill)
    }
  })

  test('rejects permit, policy, and split-key substitution before AWS', async () => {
    const cases: readonly (
      'permit' | 'policy' | 'runtime-key' | 'publication-key'
    )[] = [
      'permit',
      'policy',
      'runtime-key',
      'publication-key',
    ]
    for (const drift of cases) {
      const fixture = await createStandaloneFixture()
      const input = createCommitInput(fixture)
      if (drift === 'permit') {
        if (typeof input.permit === 'object' && input.permit !== null) {
          Reflect.set(input.permit, 'commit', 'f'.repeat(40))
        }
      } else if (drift === 'policy') {
        Reflect.set(input.ratePolicy, 'policyVersion', 'd'.repeat(64))
      } else if (drift === 'runtime-key') {
        input.stageReservationCommit.runtimeKey.fill(0x62)
      } else {
        input.stageReservationCommit.publicationKey.fill(0x62)
      }
      const mock = new StageCommitAwsMock(fixture)
      await expect(
        mock.run(async () =>
          await commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
            input,
          )),
      ).rejects.toBeInstanceOf(Error)
      expect(fixture.harness.events).toEqual([])
      expect(mock.destroyCounts).toEqual({ dynamodb: 0, s3: 0, sts: 0 })
    }
  })

  test('rejects accessor input without invoking it or starting AWS', async () => {
    const fixture = await createStandaloneFixture()
    let getterReads = 0
    const exact = createCommitInput(fixture)
    const accessorInput = {
      requested: exact.requested,
      ratePolicy: exact.ratePolicy,
      permit: exact.permit,
      permitVerificationKey: exact.permitVerificationKey,
      permitClock: exact.permitClock,
      get stageReservationCommit() {
        getterReads += 1
        return exact.stageReservationCommit
      },
    }
    const mock = new StageCommitAwsMock(fixture)
    await expect(
      mock.run(async () =>
        await commitAwsWorkspaceSearchMigrationNonProductionRehearsalStageReservation(
          accessorInput,
        )),
    ).rejects.toMatchObject({
      code: 'NON_PRODUCTION_REHEARSAL_GUARD_FAILED',
    })
    expect(getterReads).toBe(0)
    expect(fixture.harness.events).toEqual([])
    expect(mock.destroyCounts).toEqual({ dynamodb: 0, s3: 0, sts: 0 })
  })

  test('rejects a production commit capability without reading its getter', async () => {
    let getterReads = 0
    const productionInput = {
      requested,
      ratePolicy,
      bootstrapRateCheckpoint: true,
      recoverInterruptedCleanup: false,
      recoverInterruptedAttempt: false,
      get stageReservationCommit() {
        getterReads += 1
        return Object.freeze({})
      },
    }
    await expect(
      createAwsWorkspaceSearchMigrationRateManagedSession(productionInput),
    ).rejects.toBeInstanceOf(Error)
    expect(getterReads).toBe(0)
  })
})
