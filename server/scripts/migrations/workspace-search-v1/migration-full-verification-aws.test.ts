import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  TransactionCanceledException,
  type AttributeValue,
  type GetItemCommand,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createWorkspaceSearchMigrationAppliedRoot,
  createWorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationCompleteApplySeal,
} from './migration-apply-seal'
import {
  createWorkspaceSearchMigrationExecutionBoundary,
  parseWorkspaceSearchMigrationExecutionBoundary,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createWorkspaceSearchMigrationCheckpointExecutionState,
  reconstructWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationExecutionStateV2,
} from './migration-execution-state'
import {
  createWorkspaceSearchMigrationFullVerificationPlan,
  reduceWorkspaceSearchMigrationFullVerificationSourcePage,
  reduceWorkspaceSearchMigrationFullVerificationTargetPage,
  type WorkspaceSearchMigrationFullVerificationPlan,
  type WorkspaceSearchMigrationFullVerificationProgress,
  type WorkspaceSearchMigrationFullVerificationResult,
} from './migration-full-verification'
import {
  createAwsWorkspaceSearchMigrationFullVerificationPort,
  createWorkspaceSearchMigrationFullVerificationVerifiedRootConditionCheck,
  workspaceSearchMigrationFullVerificationPageTransactionIndex,
  workspaceSearchMigrationFullVerificationPublishTransactionIndex,
  type WorkspaceSearchMigrationFullVerificationAwsPort,
} from './migration-full-verification-aws'
import {
  createWorkspaceSearchMigrationFullVerificationPersistenceState,
  createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot,
  parseWorkspaceSearchMigrationFullVerificationPageReceipt,
  parseWorkspaceSearchMigrationFullVerificationPersistenceState,
  parseWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  serializeWorkspaceSearchMigrationFullVerificationPersistenceState,
  serializeWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  type WorkspaceSearchMigrationFullVerificationPageReceipt,
  type WorkspaceSearchMigrationFullVerificationPersistenceState,
  type WorkspaceSearchMigrationFullVerificationVerifiedRoot,
} from './migration-full-verification-persistence'
import type {
  WorkspaceSearchMigrationPlanArtifactReplayResult,
  WorkspaceSearchMigrationPlanManifestHead,
} from './migration-plan-artifact'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'
import {
  createEmptyWorkspaceSearchMigrationTraversal,
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationCheckpointLocation,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'
import type {
  WorkspaceSearchMigrationVerificationResultArtifact,
  WorkspaceSearchMigrationVerificationResultArtifactReference,
} from './migration-verification-result-aws'

const runId = 'full-verification-aws-run'
const ownerId = 'verification-owner'
const openedAt = '2026-07-29T00:30:00.000Z'
const closedAt = '2026-07-29T01:00:00.000Z'
const admittedAt = '2026-07-29T01:16:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const evaluatedAt = '2026-07-29T01:19:00.000Z'
const createdAt = '2026-07-29T01:19:30.000Z'
const applySealCreatedAt = '2026-07-29T01:19:36.000Z'
const appliedAt = '2026-07-29T01:19:37.000Z'
const retainUntil = '2026-09-01T00:00:00.000Z'

/** Complete exact static and immutable verification fixture. */
type VerificationAwsFixture = {
  /** Complete measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact canonical empty plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Pure empty-plan verification expectation. */
  readonly plan: WorkspaceSearchMigrationFullVerificationPlan
  /** Exact empty plan replay returned lazily. */
  readonly replay: WorkspaceSearchMigrationPlanArtifactReplayResult
  /** Exact closed writer-fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact fresh current authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Exact terminal apply seal. */
  readonly applySeal: WorkspaceSearchMigrationCompleteApplySeal
  /** Exact immutable applied root. */
  readonly appliedRoot: WorkspaceSearchMigrationAppliedRoot
}

/** Strong fake reader accepted by one receipt-chain operation. */
type VerificationReceiptReader = (
  command: GetItemCommand,
) => Promise<GetItemCommandOutput>

/** Complete receipt-chain operation supplied by the adapter. */
type VerificationReceiptChainOperation = (
  readItem: VerificationReceiptReader,
) => Promise<void>

/** Fake transport strategy for invoking one receipt-chain operation. */
type VerificationReceiptChainRunner = (
  operation: VerificationReceiptChainOperation,
  readItem: VerificationReceiptReader,
) => Promise<void>

/** In-memory transport and gateway controls for one adapter. */
type VerificationAwsHarness = {
  /** Adapter under test. */
  readonly port: WorkspaceSearchMigrationFullVerificationAwsPort
  /** Harness-local current authority used by fake reads and commands. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Durable migration-state rows keyed by physical sort key. */
  readonly rows: Map<string, Readonly<Record<string, AttributeValue>>>
  /** Fixed-order transactions observed by the fake transport. */
  readonly transactions: TransactWriteItemsCommand[]
  /** Number of exact plan replays. */
  readonly planReplayCount: () => number
  /** Fresh authority evaluation times returned in call order. */
  readonly authorityEvaluatedAts: readonly string[]
  /** Trusted adapter clock samples returned in call order. */
  readonly clockReadings: readonly string[]
  /** Selects transaction behavior for the next call. */
  setTransactionMode(
    mode:
      | { readonly kind: 'success' }
      | { readonly kind: 'response-loss' }
      | { readonly kind: 'partial-state-only' }
      | {
          readonly kind: 'cancel'
          readonly failedIndex: number
          readonly count: number
        },
  ): void
  /** Replaces the exact plan replay returned before lazy initialization. */
  setPlanReplay(
    replay: WorkspaceSearchMigrationPlanArtifactReplayResult,
  ): void
  /**
   * Replaces how the fake transport invokes receipt-chain operations.
   *
   * @param runner - Exact callback invocation strategy for later reads.
   */
  setReceiptChainRunner(
    runner: VerificationReceiptChainRunner,
  ): void
  /** Replaces exact result replay output to test substitution rejection. */
  substituteResultArtifact(): void
  /** Self-rehashes the verified root with a substituted receipt time. */
  substituteVerifiedRootReceiptTime(): void
  /**
   * Deletes one durable receipt by its successor revision.
   *
   * @param successorRevision - Positive receipt successor revision.
   */
  deleteReceipt(successorRevision: number): void
  /** Returns every successfully persisted page state in revision order. */
  readonly states:
    readonly WorkspaceSearchMigrationFullVerificationPersistenceState[]
  /** Returns every successfully persisted page receipt in revision order. */
  readonly receipts:
    readonly WorkspaceSearchMigrationFullVerificationPageReceipt[]
}

/** Optional clock and authority controls for one in-memory adapter. */
type VerificationAwsHarnessOptions = {
  /** Epoch used immediately before the first trusted clock sample. */
  readonly initialClockAt?: string
  /** Whether authority timestamps and validity windows follow the clock. */
  readonly renewAuthorityAtClock?: boolean
  /** Optional raw failure thrown by lazy plan replay. */
  readonly planReplayError?: unknown
}

/** Minimal source of the current authority used by command fixtures. */
type VerificationAuthoritySource = {
  /** Exact fresh current authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
}

describe('Workspace Search migration full-verification AWS adapter', () => {
  test('persists first and later pages in fixed transactions and publishes an exact verified root', async () => {
    const fixture = createFixture()
    const harness = createHarness(fixture, true)

    let state = await harness.port.saveVerificationPage(
      createPageCommand(fixture, 0, 'project-directory'),
    )
    expect(state).toMatchObject({
      revision: 1,
      predecessorKind: 'applied-root',
      predecessorDigest: fixture.appliedRoot.rootDigest,
    })
    expect(
      transactionItems(harness.transactions[0]).length,
    ).toBe(
      workspaceSearchMigrationFullVerificationPageTransactionIndex
        .count,
    )
    expect(
      transactionItems(harness.transactions[0])[
        workspaceSearchMigrationFullVerificationPageTransactionIndex
          .verificationState
      ]?.Put?.ConditionExpression,
    ).toContain('attribute_not_exists')
    const rollbackStartGuard = transactionItems(
      harness.transactions[0],
    )[
      workspaceSearchMigrationFullVerificationPageTransactionIndex
        .rollbackStart
    ]?.ConditionCheck
    expect(rollbackStartGuard?.ConditionExpression).toBe(
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    )
    expect(rollbackStartGuard?.Key?.recordKey?.S).toMatch(
      /^rollback-start\/v1\/[0-9a-f]{64}$/u,
    )
    const firstReceipt = harness.receipts[0]
    const firstAuthorityEvaluatedAt =
      harness.authorityEvaluatedAts[0]
    const firstTransactionAt = harness.clockReadings[0]
    if (
      firstReceipt === undefined ||
      firstAuthorityEvaluatedAt === undefined ||
      firstTransactionAt === undefined
    ) {
      throw new Error('Expected first-page chronology evidence.')
    }
    expect(firstReceipt.committedAt).toBe(firstTransactionAt)
    expect(Date.parse(firstReceipt.committedAt)).toBeGreaterThanOrEqual(
      Date.parse(firstAuthorityEvaluatedAt),
    )
    const remaining:
      readonly WorkspaceSearchMigrationCheckpointLocation[] = [
        'work-items',
        'collaboration',
        'documents',
        'target',
        'target',
      ]
    for (const location of remaining) {
      state = await harness.port.saveVerificationPage(
        createPageCommand(fixture, state.revision, location),
      )
    }
    expect(state.revision).toBe(6)
    expect(
      transactionItems(harness.transactions[1])[
        workspaceSearchMigrationFullVerificationPageTransactionIndex
          .verificationState
      ]?.Put?.ConditionExpression,
    ).toContain('#field0')
    expect(harness.planReplayCount()).toBe(1)

    const read = await harness.port.readProgress()
    expect(read?.stateDigest).toBe(state.stateDigest)
    const root = await harness.port.publishVerified(
      createPublishCommand(fixture, state.revision),
    )
    expect(root).toMatchObject({
      appliedRootDigest: fixture.appliedRoot.rootDigest,
      terminalStateDigest: state.stateDigest,
      verificationResultDigest: expect.stringMatching(
        /^[0-9a-f]{64}$/u,
      ),
    })
    expect(
      transactionItems(harness.transactions.at(-1)).length,
    ).toBe(
      workspaceSearchMigrationFullVerificationPublishTransactionIndex
        .count,
    )
    expect(
      transactionItems(harness.transactions.at(-1))[
        workspaceSearchMigrationFullVerificationPublishTransactionIndex
          .rollbackStart
      ]?.ConditionCheck?.Key?.recordKey?.S,
    ).toBe(rollbackStartGuard?.Key?.recordKey?.S)
    const conditionRoot = await harness.port.readVerifiedRoot()
    if (conditionRoot === undefined) {
      throw new Error('Expected strict verified root reread.')
    }
    expect(conditionRoot.verifiedRootDigest).toBe(root.verifiedRootDigest)
    const verifiedResult = await harness.port.readVerifiedResult()
    if (verifiedResult === undefined) {
      throw new Error('Expected strict verified result replay.')
    }
    expect(verifiedResult).toMatchObject({
      status: 'pass',
      resultDigest: root.verificationResultDigest,
      expectedTargetPresentBindings:
        verifiedResult.observedTargetPresentBindings,
    })

    const rootItem = transactionItems(harness.transactions.at(-1))[
      workspaceSearchMigrationFullVerificationPublishTransactionIndex
        .verifiedRoot
    ]?.Put?.Item
    if (rootItem === undefined) {
      throw new Error('Expected immutable verified-root item.')
    }
    expect(conditionRoot.runId).toBe(fixture.executionRun.runId)
    expect(conditionRoot.configurationHash).toBe(fixture.configurationHash)
    expect(conditionRoot.sealedPlanningAuthorityDigest).toBe(
      fixture.executionRun.binding.sealedPlanningAuthorityDigest,
    )
    expect(conditionRoot.planDigest).toBe(
      fixture.executionRun.binding.planDigest,
    )
    expect(conditionRoot.tableIds).toEqual(
      fixture.executionRun.binding.tableIds,
    )
    const condition =
      createWorkspaceSearchMigrationFullVerificationVerifiedRootConditionCheck({
        stateTable: fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
        root: conditionRoot,
      })
    expect(condition).toEqual(
      createExpectedFullRowCondition(
        fixture.configuration.tables['migration-state'].tableName,
        rootItem,
      ),
    )

    const foreign = createFixture('foreign-verified-root-condition')
    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRootConditionCheck({
        stateTable: fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        executionRun: foreign.executionRun,
        root: conditionRoot,
      })
    ).toThrow()
    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRootConditionCheck({
        stateTable: fixture.configuration.tables['migration-state'],
        configurationHash: digest('foreign-configuration'),
        executionRun: fixture.executionRun,
        root: conditionRoot,
      })
    ).toThrow()
    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRootConditionCheck({
        stateTable: {
          ...fixture.configuration.tables['migration-state'],
          tableId: 'foreign-state-table-id',
        },
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
        root: conditionRoot,
      })
    ).toThrow()
    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRootConditionCheck({
        stateTable: fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
        root: {
          ...conditionRoot,
          verifiedRootDigest: digest('tampered-verified-root'),
        },
      })
    ).toThrow()
  })

  test('recovers exact state and receipt after response loss but rejects partial durability', async () => {
    const fixture = createFixture()
    const recovered = createHarness(fixture)
    recovered.setTransactionMode({ kind: 'response-loss' })
    const state = await recovered.port.saveVerificationPage(
      createPageCommand(fixture, 0, 'project-directory'),
    )
    expect(state.revision).toBe(1)
    expect(recovered.receipts).toHaveLength(1)

    const partial = createHarness(fixture)
    partial.setTransactionMode({ kind: 'partial-state-only' })
    const failure = await captureFailure(() =>
      partial.port.saveVerificationPage(
        createPageCommand(fixture, 0, 'project-directory'),
      )
    )
    expect(failure.code).toBe('INVALID_STATE')
    expect(failure.message).toBe('INVALID_STATE')
  })

  test('rejects stale revision, location retry, and completed-cursor replay', async () => {
    const fixture = createFixture()
    const harness = createHarness(fixture, true)
    let state = await harness.port.saveVerificationPage(
      createPageCommand(fixture, 0, 'project-directory'),
    )
    const wrongLocation = await captureFailure(() =>
      harness.port.saveVerificationPage(
        createPageCommand(fixture, 0, 'work-items'),
      )
    )
    expect(wrongLocation.code).toBe('INVALID_STATE')

    for (const location of [
      'work-items',
      'collaboration',
      'documents',
      'target',
      'target',
    ] satisfies readonly WorkspaceSearchMigrationCheckpointLocation[]) {
      state = await harness.port.saveVerificationPage(
        createPageCommand(fixture, state.revision, location),
      )
    }
    const staleCursor = await captureFailure(() =>
      harness.port.saveVerificationPage(
        createPageCommand(fixture, 4, 'target'),
      )
    )
    expect(staleCursor.code).toBe('INVALID_STATE')
  })

  test('fails closed on a forged terminal state and on plan or applied-root replay substitution', async () => {
    const fixture = createFixture()
    const forged = createHarness(fixture)
    const first = await forged.port.saveVerificationPage(
      createPageCommand(fixture, 0, 'project-directory'),
    )
    overwriteStateWithForgedSuccessor(forged, fixture, first)
    const forgedFailure = await captureFailure(() =>
      forged.port.readProgress()
    )
    expect(forgedFailure.code).toBe('INVALID_STATE')

    const planFixture = createFixture()
    const planHarness = createHarness(planFixture)
    planHarness.setPlanReplay({
      ...planFixture.replay,
      planSeal: {
        ...planFixture.planSeal,
        planDigest: digest('substituted-plan-root'),
      },
    })
    const planFailure = await captureFailure(() =>
      planHarness.port.readProgress()
    )
    expect(planFailure.code).toBe('INVALID_STATE')

    const rootFixture = createFixture()
    const foreignFixture = createFixture('foreign-run')
    const rootHarness = createHarness(
      rootFixture,
      false,
      foreignFixture.appliedRoot,
    )
    const rootFailure = await captureFailure(() =>
      rootHarness.port.readProgress()
    )
    expect(rootFailure.code).toBe('INVALID_STATE')
  })

  test('rejects verified-root result substitution during public read', async () => {
    const fixture = createFixture()
    const harness = createHarness(fixture, true)
    let state:
      WorkspaceSearchMigrationFullVerificationPersistenceState
      | undefined
    for (const location of [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
      'target',
    ] satisfies readonly WorkspaceSearchMigrationCheckpointLocation[]) {
      state = await harness.port.saveVerificationPage(
        createPageCommand(fixture, state?.revision ?? 0, location),
      )
    }
    if (state === undefined) throw new Error('Expected terminal state.')
    await harness.port.publishVerified(
      createPublishCommand(fixture, state.revision),
    )
    harness.substituteResultArtifact()
    const failure = await captureFailure(() =>
      harness.port.readVerifiedRoot()
    )
    expect(failure.code).toBe('INVALID_STATE')
    const resultFailure = await captureFailure(() =>
      harness.port.readVerifiedResult()
    )
    expect(resultFailure.code).toBe('INVALID_STATE')
  })

  test('rejects a self-rehashed verified-root receipt-time substitution', async () => {
    const fixture = createFixture()
    const harness = createHarness(fixture, true)
    let state:
      WorkspaceSearchMigrationFullVerificationPersistenceState
      | undefined
    for (const location of [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
      'target',
    ] satisfies readonly WorkspaceSearchMigrationCheckpointLocation[]) {
      state = await harness.port.saveVerificationPage(
        createPageCommand(fixture, state?.revision ?? 0, location),
      )
    }
    if (state === undefined) throw new Error('Expected terminal state.')
    await harness.port.publishVerified(
      createPublishCommand(fixture, state.revision),
    )
    harness.substituteVerifiedRootReceiptTime()

    const failure = await captureFailure(() =>
      harness.port.readVerifiedRoot()
    )
    expect(failure.code).toBe('INVALID_STATE')
  })

  test('does not let the instance cache mask a missing historical receipt', async () => {
    const fixture = createFixture()
    const harness = createHarness(fixture, true)
    let state:
      WorkspaceSearchMigrationFullVerificationPersistenceState
      | undefined
    for (const location of [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
      'target',
    ] satisfies readonly WorkspaceSearchMigrationCheckpointLocation[]) {
      state = await harness.port.saveVerificationPage(
        createPageCommand(fixture, state?.revision ?? 0, location),
      )
    }
    if (state === undefined) throw new Error('Expected terminal state.')
    expect(
      (await harness.port.readProgress())?.stateDigest,
    ).toBe(state.stateDigest)
    const root = await harness.port.publishVerified(
      createPublishCommand(fixture, state.revision),
    )
    expect(
      (await harness.port.readVerifiedRoot())?.verifiedRootDigest,
    ).toBe(root.verifiedRootDigest)

    harness.deleteReceipt(2)
    const readProgressFailure = await captureFailure(() =>
      harness.port.readProgress()
    )
    expect(readProgressFailure.code).toBe('INVALID_STATE')
    const readRootFailure = await captureFailure(() =>
      harness.port.readVerifiedRoot()
    )
    expect(readRootFailure.code).toBe('INVALID_STATE')
    const publicationFailure = await captureFailure(() =>
      harness.port.publishVerified(
        createPublishCommand(fixture, state.revision),
      )
    )
    expect(publicationFailure.code).toBe('INVALID_STATE')
  })

  test('fails closed when receipt-chain transport skips or repeats validation', async () => {
    for (const runner of [
      async () => {},
      async (
        operation: VerificationReceiptChainOperation,
        readItem: VerificationReceiptReader,
      ) => {
        await operation(readItem)
        try {
          await operation(readItem)
        } catch {
          // The adapter must still reject a swallowed repeated callback.
        }
      },
    ] satisfies readonly VerificationReceiptChainRunner[]) {
      const fixture = createFixture()
      const harness = createHarness(fixture)
      await harness.port.saveVerificationPage(
        createPageCommand(fixture, 0, 'project-directory'),
      )
      harness.setReceiptChainRunner(runner)

      const failure = await captureFailure(() =>
        harness.port.readProgress()
      )

      expect(failure.code).toBe('INVALID_STATE')
      expect(failure.message).toBe('INVALID_STATE')
    }
  })

  test('fails closed when receipt-chain transport returns before validation completes', async () => {
    const fixture = createFixture()
    const harness = createHarness(fixture)
    await harness.port.saveVerificationPage(
      createPageCommand(fixture, 0, 'project-directory'),
    )
    let releaseRead: (() => void) | undefined
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let markReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let pendingValidation: Promise<void> | undefined
    harness.setReceiptChainRunner(
      async (operation, readItem) => {
        pendingValidation = operation(async (command) => {
          markReadStarted?.()
          await readGate
          return readItem(command)
        })
        await readStarted
      },
    )

    const failure = await captureFailure(() =>
      harness.port.readProgress()
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(failure.message).toBe('INVALID_STATE')
    releaseRead?.()
    if (pendingValidation === undefined) {
      throw new Error('Expected pending receipt-chain validation.')
    }
    await pendingValidation
  })

  test('rejects publication without the minimum shared retention headroom', async () => {
    const expectedVerifiedAt =
      Date.parse(retainUntil) -
      WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS +
      1
    const fixture = createFixture()
    const originalAuthority =
      structuredClone(fixture.currentAuthority)
    const harness = createHarness(
      fixture,
      true,
      fixture.appliedRoot,
      {
        initialClockAt: new Date(
          expectedVerifiedAt - 7_000,
        ).toISOString(),
        renewAuthorityAtClock: true,
      },
    )
    expect(fixture.currentAuthority).toEqual(originalAuthority)
    expect(
      harness.currentAuthority
        .maintenanceEvidencePointerRevision,
    ).toBe(
      originalAuthority.maintenanceEvidencePointerRevision + 1,
    )
    expect(
      harness.currentAuthority
        .maintenanceEvidenceReceiptDigest,
    ).not.toBe(
      originalAuthority.maintenanceEvidenceReceiptDigest,
    )
    let state:
      WorkspaceSearchMigrationFullVerificationPersistenceState
      | undefined
    for (const location of [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
      'target',
    ] satisfies readonly WorkspaceSearchMigrationCheckpointLocation[]) {
      state = await harness.port.saveVerificationPage(
        createPageCommand(
          harness,
          state?.revision ?? 0,
          location,
        ),
      )
    }
    if (state === undefined) throw new Error('Expected terminal state.')

    const failure = await captureFailure(() =>
      harness.port.publishVerified(
        createPublishCommand(harness, state.revision),
      )
    )
    expect(failure.code).toBe('INVALID_STATE')
    expect(harness.clockReadings.at(-1)).toBe(
      new Date(expectedVerifiedAt).toISOString(),
    )
    expect(harness.transactions).toHaveLength(6)
  })

  test('maps fixed cancellation positions without leaking raw error text', async () => {
    const cases = [
      {
        index:
          workspaceSearchMigrationFullVerificationPageTransactionIndex
            .lease,
        expected: 'LEASE_LOST',
      },
      {
        index:
          workspaceSearchMigrationFullVerificationPageTransactionIndex
            .pointer,
        expected: 'INVALID_MAINTENANCE_EVIDENCE',
      },
      {
        index:
          workspaceSearchMigrationFullVerificationPageTransactionIndex
            .appliedRoot,
        expected: 'INVALID_STATE',
      },
      {
        index:
          workspaceSearchMigrationFullVerificationPageTransactionIndex
            .rollbackStart,
        expected: 'INVALID_STATE',
      },
      {
        index:
          workspaceSearchMigrationFullVerificationPageTransactionIndex
            .pageReceipt,
        expected: 'INVALID_STATE',
      },
    ] satisfies readonly {
      readonly index: number
      readonly expected:
        WorkspaceSearchMigrationFailure['code']
    }[]
    for (const entry of cases) {
      const fixture = createFixture()
      const harness = createHarness(fixture)
      harness.setTransactionMode({
        kind: 'cancel',
        failedIndex: entry.index,
        count:
          workspaceSearchMigrationFullVerificationPageTransactionIndex
            .count,
      })
      const failure = await captureFailure(() =>
        harness.port.saveVerificationPage(
          createPageCommand(fixture, 0, 'project-directory'),
        )
      )
      expect(failure.code).toBe(entry.expected)
      expect(failure.message).not.toContain('tenant-secret')
    }
  })

  test('contains hostile dependency errors behind the stable public boundary', async () => {
    const constructorFixture = createFixture()
    let constructorReads = 0
    const hostileConstructorError =
      new Error('tenant-secret-constructor')
    Object.defineProperty(
      hostileConstructorError,
      'constructor',
      {
        get() {
          constructorReads += 1
          throw new Error('tenant-secret-constructor-accessor')
        },
      },
    )
    const constructorHarness = createHarness(
      constructorFixture,
      false,
      constructorFixture.appliedRoot,
      { planReplayError: hostileConstructorError },
    )
    const constructorFailure = await captureFailure(() =>
      constructorHarness.port.saveVerificationPage(
        createPageCommand(
          constructorFixture,
          0,
          'project-directory',
        ),
      )
    )
    expect(constructorFailure.code).toBe('INVALID_STATE')
    expect(constructorFailure.message).toBe('INVALID_STATE')
    expect(constructorReads).toBe(0)

    const proxyFixture = createFixture()
    let proxyTrapReads = 0
    const hostileProxyError = new Proxy(
      new Error('tenant-secret-proxy'),
      {
        getPrototypeOf() {
          proxyTrapReads += 1
          throw new Error('tenant-secret-proxy-trap')
        },
      },
    )
    const proxyHarness = createHarness(
      proxyFixture,
      false,
      proxyFixture.appliedRoot,
      { planReplayError: hostileProxyError },
    )
    const proxyFailure = await captureFailure(() =>
      proxyHarness.port.saveVerificationPage(
        createPageCommand(proxyFixture, 0, 'project-directory'),
      )
    )
    expect(proxyFailure.code).toBe('INVALID_STATE')
    expect(proxyFailure.message).toBe('INVALID_STATE')
    expect(proxyTrapReads).toBe(0)
  })
})

/**
 * Creates one complete internally correlated empty-plan fixture.
 *
 * @param selectedRunId - Run identifier used by every immutable root.
 * @returns Exact measured, admission, plan, apply-seal, and root material.
 */
function createFixture(
  selectedRunId = runId,
): VerificationAwsFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const planDigest = createEmptyWorkspaceSearchPlanDigest()
  const planSeal: WorkspaceSearchPlanSeal = {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest,
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt: '2026-07-29T01:17:00.000Z',
  }
  const plan =
    createWorkspaceSearchMigrationFullVerificationPlan({
      planSeal,
      operations: [],
    })
  const writerFence = createWriterFenceBinding(configuration)
  const closeAuthority = {
    configurationHash,
    runId: selectedRunId,
    ownerId,
    leaseFenceToken: 7,
    maintenanceEvidenceReceiptDigest: digest('close-receipt'),
    maintenanceEvidencePointerRevision: 10,
  }
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    writerFence,
    new Date(openedAt),
  )
  const closedWriterFenceRecord =
    createWorkspaceSearchWriterFenceClosedSuccessor(
      open,
      closeAuthority,
      new Date(closedAt),
    )
  const closedBoundary =
    createWorkspaceSearchMigrationExecutionBoundary({
      runId: selectedRunId,
      configurationHash,
      tableIds: writerFence.tableIds,
      closedWriterFenceRecord,
    })
  const maintenanceReceipt = createMaintenanceReceipt(selectedRunId)
  const maintenanceReceiptDigest =
    createMigrationDigest(maintenanceReceipt)
  const boundaryFields = {
    kind: closedBoundary.kind,
    boundaryVersion: closedBoundary.boundaryVersion,
    migrationId: closedBoundary.migrationId,
    migrationVersion: closedBoundary.migrationVersion,
    runId: closedBoundary.runId,
    configurationHash: closedBoundary.configurationHash,
    tableIds: closedBoundary.tableIds,
    closedWriterFenceRecordDigest:
      closedBoundary.closedWriterFenceRecordDigest,
    closedAt: closedBoundary.closedAt,
    closeAuthority: closedBoundary.closeAuthority,
    phase: 'planning-admitted',
    revision: 2,
    planningAdmission: {
      ownerId,
      leaseFenceToken: 7,
      maintenanceEvidenceReceiptDigest: maintenanceReceiptDigest,
      maintenanceEvidencePointerRevision: 11,
      maintenanceEvidenceDigest: maintenanceReceipt.evidenceDigest,
      maintenanceEvidenceLocator:
        maintenanceReceipt.evidenceLocator,
      runtimeRevision: maintenanceReceipt.runtimeRevision,
      drainStartedAt: closedAt,
      drainCompletedAt: '2026-07-29T01:15:00.000Z',
      admittedAt,
    },
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    'boundaryDigest'
  >
  const executionBoundary = {
    ...boundaryFields,
    boundaryDigest: createMigrationDigest(boundaryFields),
  }
  parseWorkspaceSearchMigrationExecutionBoundary(
    serializeWorkspaceSearchMigrationExecutionBoundary(
      executionBoundary,
    ),
  )
  const sealedPlanningAuthority = createSealedAuthority(
    configuration,
    configurationHash,
    plan,
    planSeal,
    maintenanceReceiptDigest,
    selectedRunId,
  )
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
      sealedPlanningAuthority,
    ),
  )
  const currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority = {
      configurationHash,
      stateTableId:
        configuration.tables['migration-state'].tableId,
      lease: {
        runId: selectedRunId,
        ownerId,
        fenceToken: 7,
        heartbeatAt: evaluatedAt,
        expiresAt: '2026-07-29T01:20:00.000Z',
      },
    maintenanceEvidenceReceiptDigest: maintenanceReceiptDigest,
      maintenanceEvidencePointerRevision: 11,
      maintenanceEvidenceReceipt: maintenanceReceipt,
      evaluatedAt,
    }
  createWorkspaceSearchMigrationRunState({
    runId: selectedRunId,
    lease: currentAuthority.lease,
    ownerId,
    configurationHash,
    configuration,
    maintenanceEvidenceReceipt: maintenanceReceipt,
    dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSeal,
    planSealReference: {
      objectKey:
        sealedPlanningAuthority.planSealReference.objectKey,
      versionId:
        sealedPlanningAuthority.planSealReference.versionId,
      contentDigest:
        sealedPlanningAuthority.planSealReference.contentDigest,
    },
    createdAt,
  })
  requireFixtureAdmissionCorrelation(
    configuration,
    configurationHash,
    executionBoundary,
    sealedPlanningAuthority,
    planSeal,
    currentAuthority,
  )
  const executionRun =
    createWorkspaceSearchMigrationExecutionRun({
      executionBoundary,
      sealedPlanningAuthority,
      planSeal,
      configuration,
      configurationHash,
      currentAuthority,
      createdAt,
    })
  const terminalExecutionState = createTerminalApplyState(
    executionRun,
    currentAuthority,
  )
  const applySeal = createWorkspaceSearchMigrationCompleteApplySeal({
    admission: executionRun,
    predecessor: terminalExecutionState,
    sealedPlanningAuthority,
    createdAt: applySealCreatedAt,
  })
  const sealBytes = new TextEncoder().encode(
    serializeCanonicalJson(applySeal),
  )
  const sealReference = {
    scope: 'complete-plan',
    objectKey:
      `workspace-search/v1/apply-seals/${digestBytes(sealBytes)}.json`,
    versionId: 'apply-seal-version',
    contentDigest: digestBytes(sealBytes),
    byteLength: sealBytes.byteLength,
    retainUntil,
  } satisfies WorkspaceSearchMigrationAppliedRoot['sealReference']
  const appliedRoot = createWorkspaceSearchMigrationAppliedRoot({
    admission: executionRun,
    predecessor: terminalExecutionState,
    sealedPlanningAuthority,
    seal: applySeal,
    sealReference,
    currentAuthority,
    committedAt: appliedAt,
  })
  const manifestHead: WorkspaceSearchMigrationPlanManifestHead = {
    kind: 'workspace-search-migration-plan-manifest-head',
    artifactVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    planDigest,
    planSealContentDigest:
      sealedPlanningAuthority.planSealReference.contentDigest,
    planOperationCount: 0,
    planSegmentCount: 0,
    manifestPageCount: 0,
    terminalSegmentReference: null,
    terminalManifestPageReference: null,
  }
  return {
    configuration,
    configurationHash,
    planSeal,
    plan,
    replay: {
      planSeal,
      manifestHead,
      operations: [],
    },
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    currentAuthority,
    applySeal,
    appliedRoot,
  }
}

/**
 * Provides labeled fixture failures for execution-admission correlations.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param boundary - Exact admitted boundary.
 * @param authority - Exact sealed planning authority.
 * @param planSeal - Exact canonical plan seal.
 * @param current - Exact fresh current authority.
 */
function requireFixtureAdmissionCorrelation(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  boundary: WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
  authority: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  planSeal: WorkspaceSearchPlanSeal,
  current: WorkspaceSearchMigrationPrePlanAuthority,
): void {
  const expectedTableIds = createTableIds(configuration)
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    throw new Error('Fixture configuration hash mismatch.')
  }
  for (const role of Object.keys(expectedTableIds)) {
    const expected = expectedTableIds[
      readTableRole(role)
    ]
    if (
      boundary.tableIds[readTableRole(role)] !== expected ||
      authority.tableIds[readTableRole(role)] !== expected
    ) {
      throw new Error('Fixture TableId mismatch.')
    }
  }
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  if (
    authority.runId !== boundary.runId ||
    authority.runId !== planSeal.runId ||
    authority.runId !== current.lease.runId ||
    authority.configurationHash !== configurationHash ||
    planSeal.configurationHash !== configurationHash ||
    current.configurationHash !== configurationHash ||
    digestBytes(planSealBytes) !==
      authority.planSealReference.contentDigest ||
    planSealBytes.byteLength !==
      authority.planSealReference.byteLength ||
    authority.currentAuthority.ownerId !== current.lease.ownerId ||
    authority.currentAuthority.fenceToken !==
      current.lease.fenceToken ||
    authority.currentAuthority.maintenanceEvidencePointerRevision !==
      current.maintenanceEvidencePointerRevision ||
    authority.currentAuthority.maintenanceEvidenceReceiptDigest !==
      current.maintenanceEvidenceReceiptDigest
  ) {
    throw new Error('Fixture authority correlation mismatch.')
  }
  if (
    Date.parse(boundary.planningAdmission.admittedAt) >
      Date.parse(planSeal.createdAt) ||
    Date.parse(planSeal.createdAt) > Date.parse(authority.sealedAt) ||
    Date.parse(authority.sealedAt) > Date.parse(current.evaluatedAt) ||
    Date.parse(current.evaluatedAt) > Date.parse(createdAt)
  ) {
    throw new Error('Fixture admission timeline mismatch.')
  }
}

/**
 * Narrows one Object.keys result to the complete fixture table-role union.
 *
 * @param value - Candidate role string.
 * @returns Exact supported role.
 */
function readTableRole(
  value: string,
): keyof ReturnType<typeof createTableIds> {
  if (
    value === 'project-directory' ||
    value === 'work-items' ||
    value === 'collaboration' ||
    value === 'documents' ||
    value === 'workspace-search' ||
    value === 'migration-state'
  ) {
    return value
  }
  throw new Error('Unknown fixture table role.')
}

/**
 * Creates one in-memory adapter with response-loss and corruption controls.
 *
 * @param fixture - Exact static and immutable verification material.
 * @param splitTarget - Whether target completion spans cursor and terminal pages.
 * @param appliedRootOverride - Optional substituted strong-read root.
 * @param options - Optional trusted clock and renewed-authority controls.
 * @returns Adapter and mutable fake transport controls.
 */
function createHarness(
  fixture: VerificationAwsFixture,
  splitTarget = false,
  appliedRootOverride = fixture.appliedRoot,
  options: VerificationAwsHarnessOptions = {},
): VerificationAwsHarness {
  const rows =
    new Map<string, Readonly<Record<string, AttributeValue>>>()
  const transactions: TransactWriteItemsCommand[] = []
  const authorityEvaluatedAts: string[] = []
  const clockReadings: string[] = []
  const states:
    WorkspaceSearchMigrationFullVerificationPersistenceState[] = []
  const receipts:
    WorkspaceSearchMigrationFullVerificationPageReceipt[] = []
  const resultArtifacts =
    new Map<string, WorkspaceSearchMigrationVerificationResultArtifact>()
  let substitutedArtifact:
    WorkspaceSearchMigrationVerificationResultArtifact | undefined
  let replay = fixture.replay
  let replayCount = 0
  let targetPageCount = 0
  let receiptChainRunner: VerificationReceiptChainRunner =
    async (operation, readItem) => {
      await operation(readItem)
    }
  let transactionMode:
    | { readonly kind: 'success' }
    | { readonly kind: 'response-loss' }
    | { readonly kind: 'partial-state-only' }
    | {
        readonly kind: 'cancel'
        readonly failedIndex: number
        readonly count: number
      } = { kind: 'success' }
  let clockMilliseconds = Date.parse(
    options.initialClockAt ??
      '2026-07-29T01:19:40.000Z',
  )
  let currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority =
      structuredClone(fixture.currentAuthority)
  if (options.renewAuthorityAtClock === true) {
    const current = currentAuthority
    const previousValidityWindow =
      Date.parse(current.maintenanceEvidenceReceipt.validUntil) -
      Date.parse(
        current.maintenanceEvidenceReceipt.oldestObservationAt,
      )
    const evaluatedAt =
      new Date(clockMilliseconds).toISOString()
    const oldestObservationAt = new Date(
      clockMilliseconds - 60_000,
    ).toISOString()
    const maintenanceEvidenceReceipt = {
      ...current.maintenanceEvidenceReceipt,
      evidenceDigest: digest(`renewed:${evaluatedAt}`),
      runtimeRevision:
        current.maintenanceEvidenceReceipt.runtimeRevision + 1,
      validatedAt: evaluatedAt,
      oldestObservationAt,
      validUntil: new Date(
        Date.parse(oldestObservationAt) +
          previousValidityWindow,
      ).toISOString(),
    }
    currentAuthority = {
      ...current,
      lease: {
        ...current.lease,
        heartbeatAt: evaluatedAt,
        expiresAt: new Date(
          clockMilliseconds + 60_000,
        ).toISOString(),
      },
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(maintenanceEvidenceReceipt),
      maintenanceEvidencePointerRevision:
        current.maintenanceEvidencePointerRevision + 1,
      maintenanceEvidenceReceipt,
      evaluatedAt,
    }
  }

  const planArtifactGateway = {
    async replayPlanArtifact() {
      replayCount += 1
      if (Object.hasOwn(options, 'planReplayError')) {
        throw options.planReplayError
      }
      return structuredClone(replay)
    },
  }
  const applySealGateway = {
    async readCompleteApplySeal() {
      return structuredClone(fixture.applySeal)
    },
  }
  const authorityPort = {
    async readAuthority() {
      const evaluatedAt =
        new Date(clockMilliseconds).toISOString()
      authorityEvaluatedAts.push(evaluatedAt)
      const current = structuredClone(currentAuthority)
      return {
        ...current,
        evaluatedAt,
      }
    },
  }
  const appliedRootReader = {
    async readAppliedRoot() {
      return structuredClone(appliedRootOverride)
    },
  }
  const pageScanner = {
    async scanVerificationPage(
      input: {
        readonly plan: WorkspaceSearchMigrationFullVerificationPlan
        readonly previousProgress:
          WorkspaceSearchMigrationFullVerificationProgress
        readonly location:
          WorkspaceSearchMigrationCheckpointLocation
      },
    ) {
      if (input.location === 'target') {
        targetPageCount += 1
        const useCursor = splitTarget && targetPageCount === 1
        const ignoredItem = {
          workspaceId: { S: 'workspace-1' },
          recordKey: { S: 'VIEW#cursor-1' },
          entryType: { S: 'saved-view' },
          payload: { S: 'fixture' },
        }
        return reduceWorkspaceSearchMigrationFullVerificationTargetPage({
          plan: input.plan,
          progress: input.previousProgress,
          configuration: fixture.configuration,
          configurationHash: fixture.configurationHash,
          page: {
            items: useCursor ? [ignoredItem] : [],
            ...(useCursor
              ? {
                  lastEvaluatedKey: {
                    workspaceId:
                      structuredClone(ignoredItem.workspaceId),
                    recordKey:
                      structuredClone(ignoredItem.recordKey),
                  },
                }
              : {}),
          },
        })
      }
      return reduceWorkspaceSearchMigrationFullVerificationSourcePage({
        plan: input.plan,
        progress: input.previousProgress,
        configuration: fixture.configuration,
        configurationHash: fixture.configurationHash,
        source: input.location,
        page: { items: [] },
      })
    },
  }
  const verificationResultGateway = {
    async writeVerificationResultArtifact(
      input: {
        readonly verificationResult:
          WorkspaceSearchMigrationFullVerificationResult
        readonly retainUntil: string
      },
    ) {
      const artifact = createResultArtifact(
        fixture,
        input.verificationResult,
      )
      const bytes = new TextEncoder().encode(
        serializeCanonicalJson(artifact),
      )
      const reference = {
        kind:
          'workspace-search-migration-verification-result-artifact-reference',
        artifactVersion: 1,
        runId: fixture.executionRun.runId,
        configurationHash: fixture.configurationHash,
        appliedRootDigest: fixture.appliedRoot.rootDigest,
        verificationResultDigest:
          input.verificationResult.resultDigest,
        envelopeDigest: artifact.envelopeDigest,
        objectKey:
          `workspace-search/v1/verification-results/${digestBytes(bytes)}.json`,
        versionId: 'verification-result-version',
        contentDigest: digestBytes(bytes),
        byteLength: bytes.byteLength,
        retainUntil: input.retainUntil,
      } satisfies WorkspaceSearchMigrationVerificationResultArtifactReference
      resultArtifacts.set(reference.objectKey, artifact)
      return reference
    },
    async replayVerificationResultArtifact(
      reference:
        WorkspaceSearchMigrationVerificationResultArtifactReference,
    ) {
      if (substitutedArtifact !== undefined) {
        return structuredClone(substitutedArtifact)
      }
      const artifact = resultArtifacts.get(reference.objectKey)
      if (artifact === undefined) {
        throw new Error('Missing exact verification-result artifact.')
      }
      return structuredClone(artifact)
    },
  }

  /**
   * Reads one fake strongly consistent adapter row.
   *
   * @param command - Exact adapter-owned point read.
   * @returns Detached configured row or an empty response.
   */
  const getVerificationItem = async (command: GetItemCommand) => {
    const key = command.input.Key?.recordKey?.S
    if (key === undefined) throw new Error('Missing test record key.')
    const item = rows.get(key)
    return item === undefined
      ? { $metadata: {} }
      : { $metadata: {}, Item: structuredClone(item) }
  }
  const transport = {
    getVerificationItem,
    /** Runs a complete fake receipt-chain read in one scope. */
    async runVerificationReceiptChainRead(
      operation: VerificationReceiptChainOperation,
    ) {
      await receiptChainRunner(operation, getVerificationItem)
    },
    async prepareVerificationWrite() {},
    async transactWriteVerification(
      command: TransactWriteItemsCommand,
    ) {
      transactions.push(command)
      if (transactionMode.kind === 'cancel') {
        throw createCancellation(
          transactionMode.failedIndex,
          transactionMode.count,
        )
      }
      const puts = transactionItems(command)
        .flatMap((item) => item.Put === undefined ? [] : [item.Put])
      if (transactionMode.kind === 'partial-state-only') {
        const first = puts[0]
        if (first !== undefined) persistPut(rows, first.Item)
        throw new Error('tenant-secret-partial-response')
      }
      for (const put of puts) {
        persistPut(rows, put.Item)
        captureSemanticWrite(put.Item, states, receipts)
      }
      if (transactionMode.kind === 'response-loss') {
        transactionMode = { kind: 'success' }
        throw new Error('tenant-secret-timeout')
      }
      transactionMode = { kind: 'success' }
      return { $metadata: {} }
    },
  }
  const port =
    createAwsWorkspaceSearchMigrationFullVerificationPort({
      configuration: fixture.configuration,
      configurationHash: fixture.configurationHash,
      executionBoundary: fixture.executionBoundary,
      sealedPlanningAuthority: fixture.sealedPlanningAuthority,
      closedWriterFenceRecord: fixture.closedWriterFenceRecord,
      executionRun: fixture.executionRun,
      authorityPort,
      planArtifactGateway,
      applySealGateway,
      verificationResultGateway,
      appliedRootReader,
      pageScanner,
      transport,
      clock: () => {
        clockMilliseconds += 1_000
        const reading = new Date(clockMilliseconds)
        clockReadings.push(reading.toISOString())
        return reading
      },
    })
  return {
    port,
    currentAuthority: structuredClone(currentAuthority),
    rows,
    transactions,
    planReplayCount: () => replayCount,
    authorityEvaluatedAts,
    clockReadings,
    setTransactionMode: (mode) => {
      transactionMode = mode
    },
    setPlanReplay: (nextReplay) => {
      replay = nextReplay
    },
    setReceiptChainRunner: (runner) => {
      receiptChainRunner = runner
    },
    substituteResultArtifact: () => {
      const artifact = resultArtifacts.values().next().value
      if (artifact === undefined) {
        throw new Error('Expected one stored result artifact.')
      }
      const substitutedFields = {
        kind: artifact.kind,
        artifactVersion: artifact.artifactVersion,
        migrationId: artifact.migrationId,
        migrationVersion: artifact.migrationVersion,
        runId: artifact.runId,
        configurationHash: artifact.configurationHash,
        appliedRootDigest: digest('substituted-applied-root'),
        verificationResultDigest:
          artifact.verificationResultDigest,
        verificationResult: artifact.verificationResult,
      } satisfies Omit<
        WorkspaceSearchMigrationVerificationResultArtifact,
        'envelopeDigest'
      >
      substitutedArtifact = {
        ...substitutedFields,
        envelopeDigest: createMigrationDigest(substitutedFields),
      }
    },
    substituteVerifiedRootReceiptTime: () => {
      overwriteVerifiedRootReceiptTime(rows)
    },
    deleteReceipt: (successorRevision) => {
      for (const [key, item] of rows) {
        if (
          item.kind?.S ===
            'workspace-search-migration-full-verification-page-receipt-record' &&
          item.successorRevision?.N === String(successorRevision)
        ) {
          rows.delete(key)
          return
        }
      }
      throw new Error('Expected one durable page receipt.')
    },
    states,
    receipts,
  }
}

/**
 * Creates one strict empty-plan sealed planning authority.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param plan - Exact plan-derived verification expectation.
 * @param planSeal - Exact canonical empty plan seal.
 * @param receiptDigest - Current immutable maintenance receipt digest.
 * @param selectedRunId - Fixture run identifier.
 * @returns Exact immutable version-two planning authority.
 */
function createSealedAuthority(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  plan: WorkspaceSearchMigrationFullVerificationPlan,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
  selectedRunId: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const empty = createEmptyWorkspaceSearchMigrationTraversal()
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planManifestDigest = digest('plan-manifest')
  const provenanceDigest = digest('provenance-manifest')
  const fields = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    tableIds: createTableIds(configuration),
    planSealReference: {
      objectKey:
        `workspace-search/v1/plan-artifacts/v1/plan-seals/${digestBytes(planSealBytes)}.artifact`,
      versionId: 'plan-seal-version',
      contentDigest: digestBytes(planSealBytes),
      byteLength: planSealBytes.byteLength,
      retainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `workspace-search/v1/plan-artifacts/v1/manifest-heads/${planManifestDigest}.artifact`,
      versionId: 'plan-manifest-version',
      contentDigest: planManifestDigest,
      byteLength: 1,
      retainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        `workspace-search/v1/planning-provenance-artifacts/v1/${selectedRunId}/${configurationHash}/manifest-heads/${provenanceDigest}.artifact`,
      versionId: 'provenance-version',
      contentDigest: provenanceDigest,
      byteLength: 1,
      retainUntil,
    },
    planDigest: plan.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    planOperationCount: 0,
    planningAuthorityProvenanceDigest: digest('provenance'),
    historicalReceiptBindingDigest: digest('historical-receipt'),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createEvidenceHead('project-directory', empty.sources['project-directory']),
      createEvidenceHead('work-items', empty.sources['work-items']),
      createEvidenceHead('collaboration', empty.sources.collaboration),
      createEvidenceHead('documents', empty.sources.documents),
      createEvidenceHead('workspace-search', empty.target),
    ],
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 11,
      maintenanceEvidenceReceiptDigest: receiptDigest,
    },
    sealedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    'authorityDigest'
  >
  return {
    ...fields,
    authorityDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates one compact terminal planning evidence head.
 *
 * @param chain - Canonical source or target evidence-chain role.
 * @param previous - Exact fresh empty checkpoint.
 * @returns Exact one-page terminal evidence commitment.
 */
function createEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
  previous: MigrationSourceCheckpoint,
) {
  const terminal = createTerminalEmptyCheckpoint(previous)
  return {
    chain,
    progressDigest: digest(`progress:${chain}`),
    pageCount: 1,
    terminalEvidenceDigest: digest(`evidence:${chain}`),
    terminalCheckpointDigest:
      createWorkspaceSearchMigrationSourceCheckpointDigest(terminal),
  }
}

/**
 * Advances the empty admitted run through all five terminal apply checkpoints.
 *
 * @param admission - Exact immutable execution admission.
 * @param currentAuthority - Exact active lease authority.
 * @returns Exact terminal traversal-capable execution state.
 */
function createTerminalApplyState(
  admission: WorkspaceSearchMigrationExecutionRun,
  currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationExecutionStateV2 {
  const locations:
    readonly WorkspaceSearchMigrationCheckpointLocation[] = [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
    ]
  let predecessor:
    WorkspaceSearchMigrationExecutionStateV2 | undefined
  for (let index = 0; index < locations.length; index += 1) {
    const location = locations[index]
    if (location === undefined) {
      throw new Error('Expected one apply checkpoint location.')
    }
    const current = predecessor === undefined
      ? admission.runState
      : reconstructWorkspaceSearchMigrationRunState(
          admission,
          predecessor,
        )
    const previous = location === 'target'
      ? current.apply.target
      : current.apply.sources[location]
    predecessor =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        ...(predecessor === undefined ? {} : { predecessor }),
        authority: {
          lease: currentAuthority.lease,
          ownerId,
          at: new Date(
            Date.parse('2026-07-29T01:19:31.000Z') +
              index * 1_000,
          ).toISOString(),
        },
        location,
        checkpoint: createTerminalEmptyCheckpoint(previous),
      })
  }
  if (predecessor === undefined) {
    throw new Error('Expected terminal execution state.')
  }
  return predecessor
}

/**
 * Creates one terminal zero-row checkpoint after an exact predecessor.
 *
 * @param previous - Exact incomplete predecessor checkpoint.
 * @returns Exact one-page completed checkpoint.
 */
function createTerminalEmptyCheckpoint(
  previous: MigrationSourceCheckpoint,
): MigrationSourceCheckpoint {
  if (previous.completed) {
    throw new Error('Expected incomplete checkpoint.')
  }
  return {
    completed: true,
    aggregate: {
      ...structuredClone(previous.aggregate),
      pageCount: previous.aggregate.pageCount + 1,
    },
    keyDigestState: structuredClone(previous.keyDigestState),
    contentDigestState: structuredClone(
      previous.contentDigestState,
    ),
  }
}

/**
 * Creates one semantic result envelope matching the production gateway.
 *
 * @param fixture - Exact immutable verification fixture.
 * @param result - Exact successful pure result.
 * @returns Deterministic semantic result envelope.
 */
function createResultArtifact(
  fixture: VerificationAwsFixture,
  result: WorkspaceSearchMigrationFullVerificationResult,
): WorkspaceSearchMigrationVerificationResultArtifact {
  const fields = {
    kind: 'workspace-search-migration-verification-result-artifact',
    artifactVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: fixture.executionRun.runId,
    configurationHash: fixture.configurationHash,
    appliedRootDigest: fixture.appliedRoot.rootDigest,
    verificationResultDigest: result.resultDigest,
    verificationResult: result,
  } satisfies Omit<
    WorkspaceSearchMigrationVerificationResultArtifact,
    'envelopeDigest'
  >
  return {
    ...fields,
    envelopeDigest: createMigrationDigest(fields),
  }
}

/**
 * Replaces the mutable state row with a self-digested unreceipted successor.
 *
 * @param harness - In-memory transport containing the first committed page.
 * @param fixture - Exact immutable plan and root fixture.
 * @param predecessor - Exact legitimate first state.
 */
function overwriteStateWithForgedSuccessor(
  harness: VerificationAwsHarness,
  fixture: VerificationAwsFixture,
  predecessor:
    WorkspaceSearchMigrationFullVerificationPersistenceState,
): void {
  const planBinding =
    createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding({
      runId: fixture.executionRun.runId,
      configurationHash: fixture.configurationHash,
      planDigest: fixture.plan.planDigest,
      verificationPlanDigest: fixture.plan.verificationPlanDigest,
      sealedPlanningAuthorityDigest:
        fixture.sealedPlanningAuthority.authorityDigest,
      planSealReference:
        fixture.sealedPlanningAuthority.planSealReference,
      planManifestHeadReference:
        fixture.sealedPlanningAuthority.planManifestHeadReference,
    })
  const forged =
    createWorkspaceSearchMigrationFullVerificationPersistenceState({
      planArtifactBinding: planBinding,
      tableIds: fixture.sealedPlanningAuthority.tableIds,
      appliedRootDigest: fixture.appliedRoot.rootDigest,
      revision: predecessor.revision + 1,
      predecessorKind: 'verification-state',
      predecessorDigest: predecessor.stateDigest,
      lastCommandDigest: digest('forged-command'),
      progress:
        decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot(
          predecessor.progress,
        ),
    })
  for (const [key, item] of harness.rows) {
    if (
      item.kind?.S ===
        'workspace-search-migration-full-verification-state-record'
    ) {
      harness.rows.set(key, {
        ...structuredClone(item),
        revision: { N: String(forged.revision) },
        lastCommandDigest: { S: forged.lastCommandDigest },
        stateDigest: { S: forged.stateDigest },
        stateBytes: {
          B:
            serializeWorkspaceSearchMigrationFullVerificationPersistenceState(
              forged,
            ),
        },
      })
      return
    }
  }
  throw new Error('Expected one durable verification state row.')
}

/**
 * Replaces the durable verified root with an internally self-rehashed root
 * carrying a different, still locally chronological terminal receipt time.
 *
 * @param rows - Mutable in-memory migration-state rows.
 */
function overwriteVerifiedRootReceiptTime(
  rows: Map<string, Readonly<Record<string, AttributeValue>>>,
): void {
  for (const [key, item] of rows) {
    if (
      item.kind?.S !==
        'workspace-search-migration-full-verification-verified-root-record'
    ) {
      continue
    }
    const rootBytes = item.rootBytes?.B
    if (!(rootBytes instanceof Uint8Array)) {
      throw new Error('Expected verified-root bytes.')
    }
    const root =
      parseWorkspaceSearchMigrationFullVerificationVerifiedRoot(
        rootBytes,
      )
    const {
      verifiedRootDigest: originalVerifiedRootDigest,
      ...originalFields
    } = root
    if (
      item.verifiedRootDigest?.S !== originalVerifiedRootDigest
    ) {
      throw new Error('Expected matching verified-root digest.')
    }
    const substitutedCommittedAt = new Date(
      Date.parse(root.terminalReceiptCommittedAt) - 1_000,
    ).toISOString()
    const substitutedFields = {
      ...originalFields,
      terminalReceiptCommittedAt: substitutedCommittedAt,
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationVerifiedRoot,
      'verifiedRootDigest'
    >
    const substitutedRoot = {
      ...substitutedFields,
      verifiedRootDigest:
        createMigrationDigest(substitutedFields),
    }
    rows.set(key, {
      ...structuredClone(item),
      verifiedRootDigest: {
        S: substitutedRoot.verifiedRootDigest,
      },
      rootBytes: {
        B:
          serializeWorkspaceSearchMigrationFullVerificationVerifiedRoot(
            substitutedRoot,
          ),
      },
    })
    return
  }
  throw new Error('Expected one durable verified-root row.')
}

/**
 * Captures semantic verification state and receipt writes for assertions.
 *
 * @param item - Complete low-level transaction Put item.
 * @param states - Mutable captured state list.
 * @param receipts - Mutable captured receipt list.
 */
function captureSemanticWrite(
  item: Readonly<Record<string, AttributeValue>> | undefined,
  states:
    WorkspaceSearchMigrationFullVerificationPersistenceState[],
  receipts: WorkspaceSearchMigrationFullVerificationPageReceipt[],
): void {
  if (item === undefined) {
    throw new Error('Expected complete transaction Put item.')
  }
  if (
    item.kind?.S ===
      'workspace-search-migration-full-verification-state-record'
  ) {
    const bytes = requireBinary(item, 'stateBytes')
    states.push(
      parsePersistenceState(bytes),
    )
  }
  if (
    item.kind?.S ===
      'workspace-search-migration-full-verification-page-receipt-record'
  ) {
    receipts.push(
      parseWorkspaceSearchMigrationFullVerificationPageReceipt(
        requireBinary(item, 'receiptBytes'),
      ),
    )
  }
}

/**
 * Parses one strict persistence state through its public codec.
 *
 * @param bytes - Exact canonical state bytes.
 * @returns Detached strict state.
 */
function parsePersistenceState(
  bytes: Uint8Array,
): WorkspaceSearchMigrationFullVerificationPersistenceState {
  return parseWorkspaceSearchMigrationFullVerificationPersistenceState(
    bytes,
  )
}

/**
 * Persists one complete fake transaction Put by its deterministic sort key.
 *
 * @param rows - Mutable in-memory migration-state rows.
 * @param item - Candidate complete low-level item.
 */
function persistPut(
  rows: Map<string, Readonly<Record<string, AttributeValue>>>,
  item: Readonly<Record<string, AttributeValue>> | undefined,
): void {
  const recordKey = item?.recordKey?.S
  if (item === undefined || recordKey === undefined) {
    throw new Error('Expected complete Put item and record key.')
  }
  rows.set(recordKey, structuredClone(item))
}

/**
 * Returns one transaction's exact item list.
 *
 * @param command - Candidate captured transaction.
 * @returns Complete fixed-order transaction items.
 */
function transactionItems(
  command: TransactWriteItemsCommand | undefined,
): readonly TransactWriteItem[] {
  const items = command?.input.TransactItems
  if (items === undefined) {
    throw new Error('Expected captured transaction items.')
  }
  return items
}

/**
 * Reconstructs the exact full-row equality condition for a canonical item.
 *
 * @param tableName - Exact measured state-table name.
 * @param item - Complete canonical immutable row.
 * @returns Expected full controlled-row ConditionCheck.
 */
function createExpectedFullRowCondition(
  tableName: string,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  const migrationId = item.migrationId
  const recordKey = item.recordKey
  if (migrationId === undefined || recordKey === undefined) {
    throw new Error('Expected canonical row key attributes.')
  }
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const clauses: string[] = []
  let index = 0
  for (const [name, value] of Object.entries(item)) {
    if (name === 'migrationId' || name === 'recordKey') continue
    names[`#field${index}`] = name
    values[`:value${index}`] = value
    clauses.push(`#field${index} = :value${index}`)
    index += 1
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { migrationId, recordKey },
      ConditionExpression: clauses.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Reads one exact binary attribute from a fake durable row.
 *
 * @param item - Complete low-level item.
 * @param name - Required binary attribute.
 * @returns Exact detached bytes.
 */
function requireBinary(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const value = item[name]?.B
  if (!(value instanceof Uint8Array)) {
    throw new Error('Expected binary test attribute.')
  }
  return value
}

/**
 * Creates one page command under the exact fixture lease.
 *
 * @param fixture - Exact current authority fixture.
 * @param expectedRevision - Exact predecessor revision.
 * @param location - Source or target location.
 * @returns Detached caller command.
 */
function createPageCommand(
  fixture: VerificationAuthoritySource,
  expectedRevision: number,
  location: WorkspaceSearchMigrationCheckpointLocation,
) {
  return {
    expectedRevision,
    authority: {
      lease: {
        runId: fixture.currentAuthority.lease.runId,
        ownerId: fixture.currentAuthority.lease.ownerId,
        fenceToken: fixture.currentAuthority.lease.fenceToken,
      },
      maintenanceEvidenceReceiptDigest:
        fixture.currentAuthority.maintenanceEvidenceReceiptDigest,
      maintenanceEvidencePointerRevision:
        fixture.currentAuthority.maintenanceEvidencePointerRevision,
    },
    location,
  }
}

/**
 * Creates one verified-publication command under the fixture lease.
 *
 * @param fixture - Exact current authority fixture.
 * @param expectedRevision - Exact terminal revision.
 * @returns Detached caller command.
 */
function createPublishCommand(
  fixture: VerificationAuthoritySource,
  expectedRevision: number,
) {
  return {
    expectedRevision,
    authority: {
      lease: {
        runId: fixture.currentAuthority.lease.runId,
        ownerId: fixture.currentAuthority.lease.ownerId,
        fenceToken: fixture.currentAuthority.lease.fenceToken,
      },
      maintenanceEvidenceReceiptDigest:
        fixture.currentAuthority.maintenanceEvidenceReceiptDigest,
      maintenanceEvidencePointerRevision:
        fixture.currentAuthority.maintenanceEvidencePointerRevision,
    },
  }
}

/**
 * Creates one fixed-position transaction cancellation.
 *
 * @param failedIndex - Zero-based failed transaction item index.
 * @param count - Exact fixed transaction item count.
 * @returns Raw DynamoDB transaction cancellation.
 */
function createCancellation(
  failedIndex: number,
  count: number,
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'tenant-secret-cancellation',
    CancellationReasons: Array.from(
      { length: count },
      (_, index) => ({
        Code: index === failedIndex
          ? 'ConditionalCheckFailed'
          : 'None',
      }),
    ),
  })
}

/**
 * Captures one public migration failure.
 *
 * @param operation - Expected failing async operation.
 * @returns Exact public migration failure.
 */
async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error: unknown) {
    if (isMigrationFailure(error)) return error
    throw error
  }
  throw new Error('Expected migration failure.')
}

/**
 * Narrows one candidate to the public migration failure class.
 *
 * @param value - Candidate caught value.
 * @returns Whether the value is a migration failure.
 */
function isMigrationFailure(
  value: unknown,
): value is WorkspaceSearchMigrationFailure {
  return value instanceof Error &&
    value.name === 'WorkspaceSearchMigrationFailure' &&
    'code' in value
}

/**
 * Creates the current immutable maintenance receipt.
 *
 * @param selectedRunId - Exact fixture run identifier.
 * @returns Fresh receipt bound to fence seven.
 */
function createMaintenanceReceipt(
  selectedRunId: string,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId: selectedRunId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/current.json',
    runtimeRevision: 41,
    fenceToken: 7,
    validatedAt: '2026-07-29T01:18:30.000Z',
    oldestObservationAt: admittedAt,
    validUntil: '2026-07-29T01:21:00.001Z',
  }
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable measured configuration.
 */
function createConfiguration():
WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': createSupportingTable('workspace-search'),
      'migration-state': createSupportingTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-01-01T00:00:00.000Z',
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
 * Creates one measured source table.
 *
 * @param role - Logical source role.
 * @returns Complete source identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured supporting table.
 *
 * @param role - Target or migration-state role.
 * @returns Complete supporting identity.
 */
function createSupportingTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    [
      {
        name: role === 'migration-state'
          ? 'migrationId'
          : 'workspaceId',
        role: 'HASH',
        type: 'S',
      },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ],
    true,
  )
}

/**
 * Creates one complete measured table identity.
 *
 * @param role - Logical table role.
 * @param key - Exact key schema.
 * @param deletionProtection - Measured protection status.
 * @returns Complete table identity.
 */
function createTable(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
  deletionProtection: boolean,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-29T00:00:00.000Z',
    },
  }
}

/**
 * Returns one source table's exact base-key schema.
 *
 * @param role - Logical source role.
 * @returns Ordered key descriptors.
 */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}

/**
 * Creates all six exact physical TableIds.
 *
 * @param configuration - Complete measured configuration.
 * @returns Exact role-indexed TableIds.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
) {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    collaboration: configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Creates the independently measured shared writer-fence binding.
 *
 * @param configuration - Complete measured configuration.
 * @returns Exact writer-fence binding.
 */
function createWriterFenceBinding(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchWriterFenceBinding {
  const state = configuration.tables['migration-state']
  return createWorkspaceSearchWriterFenceBinding({
    stateTableName: state.tableName,
    stateTableId: state.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest({
        role: 'migration-state',
        tableName: state.tableName,
        tableArn: state.tableArn,
        tableId: state.tableId,
        creationTime: state.creationTime,
        account: state.account,
        region: state.region,
      }),
    tableIds: createTableIds(configuration),
  })
}

/**
 * Computes one lowercase SHA-256 digest from stable text.
 *
 * @param value - Stable fixture text.
 * @returns Lowercase SHA-256 digest.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Computes one lowercase SHA-256 digest from exact bytes.
 *
 * @param bytes - Exact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
