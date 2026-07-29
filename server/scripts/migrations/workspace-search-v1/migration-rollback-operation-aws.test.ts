import { createHash } from 'node:crypto'
import {
  TransactionCanceledException,
  type AttributeValue,
  type GetItemCommand,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createWorkspaceSearchDocumentRecordKey,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeAttributeMap,
  encodeUnknownAttributeMap,
} from './dynamodb-attribute-codec'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createWorkspaceSearchMigrationApplyReceiptAwsBinding,
  type WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
  type WorkspaceSearchMigrationApplyReceiptAwsBinding,
  type WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
} from './migration-apply-receipt-aws'
import {
  parseWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationCompleteApplySealReference,
} from './migration-apply-seal'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  type MigrationItemSnapshot,
  type EncodedMigrationItemSnapshot,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchJournalReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTraversalProgress,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  zeroHexDigest,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createAbsentMigrationItemDigest,
  decodeWorkspaceSearchJournalRestorationMaterial,
  serializeWorkspaceSearchJournalSegment,
} from './migration-journal'
import type {
  WorkspaceSearchMigrationJournalAwsGateway,
} from './migration-journal-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createAwsWorkspaceSearchMigrationRollbackOperationPort,
  createWorkspaceSearchMigrationRollbackStartSentinelAbsentConditionCheck,
  type WorkspaceSearchMigrationRollbackOperationAwsPort,
  workspaceSearchMigrationRollbackFinishTransactionIndex,
  workspaceSearchMigrationRollbackOperationTransactionIndex,
  workspaceSearchMigrationRollbackStartTransactionIndex,
} from './migration-rollback-operation-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
  validateWorkspaceSearchMigrationRunState,
} from './migration-state-machine'

const runId = 'rollback-operation-aws-test'
const ownerId = 'rollback-operation-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const openedAt = '2026-07-29T00:30:00.000Z'
const closedAt = '2026-07-29T01:00:00.000Z'
const admittedAt = '2026-07-29T01:16:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const createdAt = '2026-07-29T01:19:30.000Z'
const appliedAt = '2026-07-29T01:20:00.000Z'
const rollbackClockStart = '2026-07-29T01:21:00.000Z'
const retainUntil = '2026-08-30T01:00:00.000Z'

/**
 * One forward apply receipt and its exact immutable journal bytes.
 */
type ForwardJournalLink = {
  /** Exact immutable journal segment. */
  readonly segment: WorkspaceSearchJournalSegment
  /** Exact durable forward apply receipt. */
  readonly receipt: WorkspaceSearchOperationReceipt
  /** Exact decoded pre-apply target snapshot. */
  readonly before: MigrationItemSnapshot
  /** Exact decoded post-apply target snapshot. */
  readonly after: MigrationItemSnapshot
  /** Exact decoded physical target key. */
  readonly targetKey: Readonly<Record<string, AttributeValue>>
}

/**
 * Complete internally correlated rollback adapter fixture.
 */
type RollbackOperationFixture = {
  /** Complete measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Exact closed writer-fence record. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact revision-two planning-admitted boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact complete applied root. */
  readonly appliedRoot: WorkspaceSearchMigrationAppliedRoot
  /** Exact applied pure run state represented by the root. */
  readonly appliedState: WorkspaceSearchMigrationRunState
  /** Fresh authority returned before rollback transactions. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Forward journal links in increasing sequence order. */
  readonly links: readonly ForwardJournalLink[]
}

/**
 * One fake transaction scheduled between individually strong point reads.
 */
type ScheduledStrongReadTransaction = {
  /** Exact transaction whose atomic effects become visible. */
  readonly transaction: TransactWriteItemsCommand
  /** Number of additional point-read snapshots before the commit. */
  remainingReads: number
}

/**
 * In-memory low-level transport and exact-version capability controller.
 */
class RollbackOperationHarness {
  /** Exact static fixture used by narrow readers. */
  private readonly fixture: RollbackOperationFixture

  /** Fresh current authority returned by the narrow reader. */
  private currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority

  /** Current low-level items indexed by table and canonical key. */
  private readonly items =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Exact immutable journal segments indexed by object version. */
  private readonly journals =
    new Map<string, WorkspaceSearchJournalSegment>()

  /** Monotonically advancing trusted clock. */
  private nextClockEpoch = Date.parse(rollbackClockStart)

  /** Next raw transaction failure when selected by a test. */
  nextTransactionError: unknown

  /** Whether selected failure happens after durable transaction effects. */
  commitBeforeTransactionError = false

  /** Logical winner committed immediately before the selected send error. */
  winningTransactionBeforeError:
    TransactWriteItemsCommand | undefined

  /** Optional target-race hook executed immediately before the next send. */
  beforeNextTransaction: (() => void) | undefined

  /** Atomic transaction scheduled between strong point-read responses. */
  private scheduledStrongReadTransaction:
    ScheduledStrongReadTransaction | undefined

  /** Number of measured-incarnation preparations. */
  prepareCount = 0

  /** Complete attempted fixed-order transactions. */
  readonly transactions: TransactWriteItemsCommand[] = []

  /** Narrow fresh-authority reader. */
  readonly authorityPort = {
    /**
     * Returns the exact current fixture authority.
     *
     * @returns Fresh detached current authority.
     */
    readAuthority: async () =>
      structuredClone(this.currentAuthority),
  }

  /** Narrow complete-applied-root reader. */
  readonly appliedRootReader = {
    /**
     * Returns the exact immutable complete applied root.
     *
     * @returns Fresh detached applied root.
     */
    readAppliedRoot: async () =>
      structuredClone(this.fixture.appliedRoot),
  }

  /** Narrow applied run-state reconstruction reader. */
  readonly applyRunStateReader = {
    /**
     * Returns the exact applied pure run state.
     *
     * @returns Fresh detached applied state.
     */
    readRunState: async () =>
      structuredClone(this.fixture.appliedState),
  }

  /** Exact-version immutable journal gateway. */
  readonly journalGateway: WorkspaceSearchMigrationJournalAwsGateway = {
    /**
     * Rejects writes because rollback only reads forward journals.
     *
     * @returns Never returns.
     */
    writeJournalSegment: async () => {
      throw new Error('Unexpected rollback test journal write.')
    },
    /**
     * Reads one exact fixture journal object version.
     *
     * @param reference - Exact forward apply reference.
     * @returns Fresh detached journal segment.
     */
    readJournalSegment: async (reference) => {
      const segment = this.journals.get(
        journalStorageKey(reference),
      )
      if (segment === undefined) {
        throw new Error('Missing exact rollback test journal.')
      }
      return structuredClone(segment)
    },
  }

  /** Narrow measured rollback transport. */
  readonly transport = {
    /**
     * Strongly reads one exact current low-level item.
     *
     * @param command - Adapter-owned GetItem command.
     * @returns Raw low-level item response.
     */
    getRollbackItem: async (
      command: GetItemCommand,
    ): Promise<GetItemCommandOutput> => {
      const tableName = command.input.TableName
      const key = command.input.Key
      if (tableName === undefined || key === undefined) {
        throw new Error('Malformed rollback test GetItem.')
      }
      const item = this.items.get(storageKey(tableName, key))
      this.advanceScheduledStrongReadTransaction()
      return item === undefined
        ? { $metadata: {} }
        : {
            $metadata: {},
            Item: cloneAttributeMap(item),
          }
    },
    /**
     * Records one successful measured-incarnation preparation.
     */
    prepareRollbackWrite: async (): Promise<void> => {
      this.prepareCount += 1
    },
    /**
     * Applies or fails one fixed-order rollback transaction.
     *
     * @param command - Adapter-owned transaction command.
     * @returns Empty successful low-level output.
     */
    transactWriteRollback: async (
      command: TransactWriteItemsCommand,
    ): Promise<TransactWriteItemsCommandOutput> => {
      this.transactions.push(command)
      const beforeSend = this.beforeNextTransaction
      this.beforeNextTransaction = undefined
      beforeSend?.()
      const selectedError = this.nextTransactionError
      this.nextTransactionError = undefined
      const winningTransaction =
        this.winningTransactionBeforeError
      this.winningTransactionBeforeError = undefined
      if (
        selectedError !== undefined &&
        winningTransaction !== undefined
      ) {
        this.applyTransaction(winningTransaction)
        throw selectedError
      }
      if (
        selectedError !== undefined &&
        !this.commitBeforeTransactionError
      ) {
        throw selectedError
      }
      this.applyTransaction(command)
      if (selectedError !== undefined) throw selectedError
      return { $metadata: {} }
    },
  }

  /** Adapter-owned trusted clock. */
  readonly clock = (): Date => {
    const current = new Date(this.nextClockEpoch)
    this.nextClockEpoch += 1_000
    return current
  }

  /**
   * Creates one initialized harness and seeds forward evidence and targets.
   *
   * @param fixture - Complete correlated rollback fixture.
   * @param applyBinding - Exact official apply-receipt binding.
   */
  constructor(
    fixture: RollbackOperationFixture,
    applyBinding: WorkspaceSearchMigrationApplyReceiptAwsBinding,
  ) {
    this.fixture = fixture
    this.currentAuthority =
      structuredClone(fixture.currentAuthority)
    for (const link of fixture.links) {
      this.journals.set(
        journalStorageKey(link.receipt.journal),
        structuredClone(link.segment),
      )
      if (link.after.exists) {
        this.putItem(
          fixture.configuration.tables['workspace-search'].tableName,
          link.after.item,
        )
      }
      const projection = createApplyProjection(link.receipt)
      this.seedApplyCondition(
        applyBinding.createJournalSequenceConditionCheck(
          projection,
        ),
      )
      this.seedApplyCondition(
        applyBinding.createOperationMarkerConditionCheck(
          projection,
        ),
      )
    }
  }

  /**
   * Selects the next trusted clock instant.
   *
   * @param at - Exact canonical clock instant.
   */
  setClock(at: string): void {
    this.nextClockEpoch = Date.parse(at)
  }

  /**
   * Moves current authority around one selected valid transaction instant.
   *
   * @param at - Exact canonical transaction instant.
   */
  setAuthorityAt(at: string): void {
    const milliseconds = Date.parse(at)
    this.currentAuthority = {
      ...this.currentAuthority,
      lease: {
        ...this.currentAuthority.lease,
        heartbeatAt:
          new Date(milliseconds - 30_000).toISOString(),
        expiresAt:
          new Date(milliseconds + 30_000).toISOString(),
      },
      evaluatedAt:
        new Date(milliseconds - 1_000).toISOString(),
    }
  }

  /**
   * Strongly reads one current target snapshot for assertions.
   *
   * @param link - Forward journal link selecting the target.
   * @returns Exact current item or undefined.
   */
  readTarget(
    link: ForwardJournalLink,
  ): Readonly<Record<string, AttributeValue>> | undefined {
    const tableName =
      this.fixture.configuration.tables['workspace-search'].tableName
    const item = this.items.get(
      storageKey(tableName, link.targetKey),
    )
    return item === undefined ? undefined : cloneAttributeMap(item)
  }

  /**
   * Replaces one target with an arbitrary strict item.
   *
   * @param link - Forward journal link selecting the target.
   * @param item - Replacement low-level item.
   */
  replaceTarget(
    link: ForwardJournalLink,
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    const tableName =
      this.fixture.configuration.tables['workspace-search'].tableName
    this.putItem(tableName, item)
  }

  /**
   * Replaces one exact journal version with substituted valid bytes.
   *
   * @param reference - Exact version selected by the apply receipt.
   * @param segment - Replacement strict segment.
   */
  replaceJournal(
    reference: WorkspaceSearchJournalReference,
    segment: WorkspaceSearchJournalSegment,
  ): void {
    this.journals.set(
      journalStorageKey(reference),
      structuredClone(segment),
    )
  }

  /**
   * Replaces one hidden operation-marker row with a strict projection.
   *
   * @param binding - Exact official apply receipt binding.
   * @param projection - Replacement marker projection.
   */
  replaceApplyMarkerProjection(
    binding: WorkspaceSearchMigrationApplyReceiptAwsBinding,
    projection:
      WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
  ): void {
    this.seedApplyCondition(
      binding.createOperationMarkerConditionCheck(projection),
    )
  }

  /**
   * Schedules one atomic transaction between upcoming point-read responses.
   *
   * @param transaction - Exact already-built transaction to apply.
   * @param afterReads - Positive number of read snapshots before visibility.
   */
  scheduleTransactionAfterStrongReads(
    transaction: TransactWriteItemsCommand,
    afterReads: number,
  ): void {
    if (!Number.isSafeInteger(afterReads) || afterReads < 1) {
      throw new Error('Invalid rollback test read schedule.')
    }
    this.scheduledStrongReadTransaction = {
      transaction,
      remainingReads: afterReads,
    }
  }

  /**
   * Deletes the durable row written by one captured transaction Put.
   *
   * @param item - Captured fixed-position transaction item.
   */
  deletePutRow(item: TransactWriteItem): void {
    const put = item.Put
    if (
      put === undefined ||
      put.TableName === undefined ||
      put.Item === undefined
    ) {
      throw new Error('Expected one rollback test Put.')
    }
    const table = Object.values(this.fixture.configuration.tables)
      .find((candidate) => candidate.tableName === put.TableName)
    if (table === undefined) {
      throw new Error('Unknown rollback fixture table.')
    }
    const key: Record<string, AttributeValue> = {}
    for (const descriptor of table.key) {
      const value = put.Item[descriptor.name]
      if (value === undefined) {
        throw new Error('Missing rollback fixture Put key.')
      }
      key[descriptor.name] = structuredClone(value)
    }
    this.items.delete(storageKey(put.TableName, key))
  }

  /**
   * Seeds one deterministic full-verification conflict row.
   *
   * @param condition - Exact absent conflict ConditionCheck.
   */
  seedConditionKey(condition: TransactWriteItem): void {
    const check = condition.ConditionCheck
    if (check === undefined) {
      throw new Error('Expected one test ConditionCheck.')
    }
    const tableName = check.TableName
    if (tableName === undefined) {
      throw new Error('Expected one test condition table.')
    }
    this.putItem(tableName, {
      ...cloneAttributeMap(check.Key),
      blocker: { S: 'verification-progress' },
    })
  }

  /**
   * Applies every Put and Delete in one fake atomic transaction.
   *
   * @param command - Exact transaction command.
   */
  private applyTransaction(
    command: TransactWriteItemsCommand,
  ): void {
    const items = command.input.TransactItems
    if (items === undefined) {
      throw new Error('Missing rollback transaction items.')
    }
    for (const item of items) {
      if (item.Put !== undefined) {
        const tableName = item.Put.TableName
        const putItem = item.Put.Item
        if (tableName === undefined || putItem === undefined) {
          throw new Error('Missing rollback Put material.')
        }
        this.putItem(tableName, putItem)
      } else if (item.Delete !== undefined) {
        const tableName = item.Delete.TableName
        const key = item.Delete.Key
        if (tableName === undefined || key === undefined) {
          throw new Error('Missing rollback Delete material.')
        }
        this.items.delete(
          storageKey(tableName, key),
        )
      }
    }
  }

  /**
   * Advances and applies one transaction after its selected read boundary.
   */
  private advanceScheduledStrongReadTransaction(): void {
    const scheduled = this.scheduledStrongReadTransaction
    if (scheduled === undefined) return
    scheduled.remainingReads -= 1
    if (scheduled.remainingReads !== 0) return
    this.scheduledStrongReadTransaction = undefined
    this.applyTransaction(scheduled.transaction)
  }

  /**
   * Seeds one complete hidden apply row reconstructed from its condition.
   *
   * @param item - Official full-controlled-row ConditionCheck.
   */
  private seedApplyCondition(item: TransactWriteItem): void {
    const condition = item.ConditionCheck
    if (
      condition === undefined ||
      condition.TableName === undefined ||
      condition.ExpressionAttributeNames === undefined ||
      condition.ExpressionAttributeValues === undefined
    ) {
      throw new Error('Expected complete apply row condition.')
    }
    const row: Record<string, AttributeValue> = {
      ...cloneAttributeMap(condition.Key),
    }
    for (
      let index = 0;
      index < Object.keys(
        condition.ExpressionAttributeNames,
      ).length;
      index += 1
    ) {
      const name =
        condition.ExpressionAttributeNames[`#field${index}`]
      const value =
        condition.ExpressionAttributeValues[`:value${index}`]
      if (name === undefined || value === undefined) {
        throw new Error('Malformed apply row condition fixture.')
      }
      row[name] = structuredClone(value)
    }
    this.putItem(condition.TableName, row)
  }

  /**
   * Stores one strict low-level item under its measured primary key.
   *
   * @param tableName - Exact physical table name.
   * @param item - Complete low-level item.
   */
  private putItem(
    tableName: string,
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    const table = Object.values(this.fixture.configuration.tables)
      .find((candidate) => candidate.tableName === tableName)
    if (table === undefined) {
      throw new Error('Unknown rollback fixture table.')
    }
    const key: Record<string, AttributeValue> = {}
    for (const descriptor of table.key) {
      const value = item[descriptor.name]
      if (value === undefined) {
        throw new Error('Missing rollback fixture key field.')
      }
      key[descriptor.name] = structuredClone(value)
    }
    this.items.set(
      storageKey(tableName, key),
      cloneAttributeMap(item),
    )
  }
}

describe('Workspace Search rollback AWS operation adapter', () => {
  test(
    'restores delete, replace, and recreate shapes in strict reverse order',
    async () => {
      const context = createTestContext()
      let state = await context.port.beginRollback({
        expectedRevision:
          context.fixture.appliedState.revision,
        lease: createLeaseClaim(context.fixture),
      })

      const startItems = requireTransactionItems(
        requireArrayEntry(context.harness.transactions, 0),
      )
      expect(startItems).toHaveLength(
        workspaceSearchMigrationRollbackStartTransactionIndex.count,
      )
      expect(
        startItems[
          workspaceSearchMigrationRollbackStartTransactionIndex
            .verificationState
        ]?.ConditionCheck,
      ).toBeDefined()
      expect(
        startItems[
          workspaceSearchMigrationRollbackStartTransactionIndex
            .verifiedRoot
        ]?.ConditionCheck,
      ).toBeDefined()

      const reverseExpectations: readonly {
        readonly sequence: number
        readonly targetKind: 'Delete' | 'Put'
      }[] = [
        { sequence: 3, targetKind: 'Put' },
        { sequence: 2, targetKind: 'Put' },
        { sequence: 1, targetKind: 'Delete' },
      ]
      for (const expectation of reverseExpectations) {
        const predecessorRevision = state.revision
        state = await context.port.commitRollbackOperation({
          expectedRevision: predecessorRevision,
          lease: createLeaseClaim(context.fixture),
        })
        expect(state.nextSequence).toBe(expectation.sequence - 1)
        const link = requireArrayEntry(
          context.fixture.links,
          expectation.sequence - 1,
        )
        expect(context.harness.readTarget(link)).toEqual(
          link.before.exists ? link.before.item : undefined,
        )
        const transaction = requireArrayEntry(
          context.harness.transactions,
          context.harness.transactions.length - 1,
        )
        const items = requireTransactionItems(transaction)
        expect(items).toHaveLength(
          workspaceSearchMigrationRollbackOperationTransactionIndex.count,
        )
        expect(
          items[
            workspaceSearchMigrationRollbackOperationTransactionIndex
              .applySequence
          ]?.ConditionCheck,
        ).toBeDefined()
        expect(
          items[
            workspaceSearchMigrationRollbackOperationTransactionIndex
              .applyMarker
          ]?.ConditionCheck,
        ).toBeDefined()
        const target = items[
          workspaceSearchMigrationRollbackOperationTransactionIndex
            .target
        ]
        expect(
          expectation.targetKind === 'Put'
            ? target?.Put
            : target?.Delete,
        ).toBeDefined()
      }

      const root = await context.port.finishRollback({
        expectedRevision: state.revision,
        lease: createLeaseClaim(context.fixture),
      })
      expect(root.terminalState.status).toBe('rolled-back')
      expect(root.terminalReceipt?.sequence).toBe(1)
      expect(
        (await context.port.readRollbackState())?.status,
      ).toBe('rolled-back')
      expect(
        (await context.port.readRolledBackRoot())?.rootDigest,
      ).toBe(root.rootDigest)
      const finishItems = requireTransactionItems(
        requireArrayEntry(
          context.harness.transactions,
          context.harness.transactions.length - 1,
        ),
      )
      expect(finishItems).toHaveLength(
        workspaceSearchMigrationRollbackFinishTransactionIndex.count,
      )
      expect(
        finishItems[
          workspaceSearchMigrationRollbackFinishTransactionIndex
            .rollbackState
        ]?.Put,
      ).toBeDefined()
    },
    15_000,
  )

  test(
    'reconciles response loss, restart, later progress, and finish races',
    async () => {
      const context = createTestContext()
      context.harness.nextTransactionError =
        new Error('tenant-secret-begin-response-loss')
      context.harness.commitBeforeTransactionError = true
      const initial = await context.port.beginRollback({
        expectedRevision:
          context.fixture.appliedState.revision,
        lease: createLeaseClaim(context.fixture),
      })

      const restarted = createRollbackPort(
        context.fixture,
        context.harness,
        context.applyBinding,
      )
      expect(
        (
          await restarted.beginRollback({
            expectedRevision:
              context.fixture.appliedState.revision,
            lease: createLeaseClaim(context.fixture),
          })
        ).stateDigest,
      ).toBe(initial.stateDigest)

      context.harness.nextTransactionError =
        new Error('tenant-secret-step-response-loss')
      const afterThird = await restarted.commitRollbackOperation({
        expectedRevision: initial.revision,
        lease: createLeaseClaim(context.fixture),
      })
      const afterSecond =
        await restarted.commitRollbackOperation({
          expectedRevision: afterThird.revision,
          lease: createLeaseClaim(context.fixture),
        })
      const oldRetry =
        await restarted.commitRollbackOperation({
          expectedRevision: initial.revision,
          lease: createLeaseClaim(context.fixture),
        })
      expect(oldRetry.stateDigest).toBe(afterSecond.stateDigest)

      const afterFirst =
        await restarted.commitRollbackOperation({
          expectedRevision: afterSecond.revision,
          lease: createLeaseClaim(context.fixture),
        })
      context.harness.nextTransactionError =
        new Error('tenant-secret-finish-response-loss')
      const root = await restarted.finishRollback({
        expectedRevision: afterFirst.revision,
        lease: createLeaseClaim(context.fixture),
      })

      const retryAfterFinish =
        await restarted.commitRollbackOperation({
          expectedRevision: initial.revision,
          lease: createLeaseClaim(context.fixture),
        })
      expect(retryAfterFinish.status).toBe('rolled-back')
      expect(
        (
          await restarted.finishRollback({
            expectedRevision: afterFirst.revision,
            lease: createLeaseClaim(context.fixture),
          })
        ).rootDigest,
      ).toBe(root.rootDigest)
    },
    15_000,
  )

  test('rejects publicly observable rollback row atomicity corruption', async () => {
    const missingState = createTestContext()
    await missingState.port.beginRollback({
      expectedRevision:
        missingState.fixture.appliedState.revision,
      lease: createLeaseClaim(missingState.fixture),
    })
    const startItems = requireTransactionItems(
      requireArrayEntry(missingState.harness.transactions, 0),
    )
    missingState.harness.deletePutRow(
      requireTransactionItem(
        startItems[
          workspaceSearchMigrationRollbackStartTransactionIndex
            .rollbackState
        ],
      ),
    )
    expect(
      (
        await captureMigrationFailure(() =>
          missingState.port.readRollbackState()
        )
      ).code,
    ).toBe('INVALID_STATE')

    const missingReceipt = createTestContext()
    const initial = await missingReceipt.port.beginRollback({
      expectedRevision:
        missingReceipt.fixture.appliedState.revision,
      lease: createLeaseClaim(missingReceipt.fixture),
    })
    await missingReceipt.port.commitRollbackOperation({
      expectedRevision: initial.revision,
      lease: createLeaseClaim(missingReceipt.fixture),
    })
    const operationItems = requireTransactionItems(
      requireArrayEntry(missingReceipt.harness.transactions, 1),
    )
    missingReceipt.harness.deletePutRow(
      requireTransactionItem(
        operationItems[
          workspaceSearchMigrationRollbackOperationTransactionIndex
            .rollbackReceipt
        ],
      ),
    )
    expect(
      (
        await captureMigrationFailure(() =>
          missingReceipt.port.readRollbackReceipt(3)
        )
      ).code,
    ).toBe('INVALID_STATE')

    const missingRoot = createTestContext()
    let rolling = await missingRoot.port.beginRollback({
      expectedRevision:
        missingRoot.fixture.appliedState.revision,
      lease: createLeaseClaim(missingRoot.fixture),
    })
    for (let remaining = 3; remaining > 0; remaining -= 1) {
      rolling = await missingRoot.port.commitRollbackOperation({
        expectedRevision: rolling.revision,
        lease: createLeaseClaim(missingRoot.fixture),
      })
    }
    await missingRoot.port.finishRollback({
      expectedRevision: rolling.revision,
      lease: createLeaseClaim(missingRoot.fixture),
    })
    const finishItems = requireTransactionItems(
      requireArrayEntry(missingRoot.harness.transactions, 4),
    )
    missingRoot.harness.deletePutRow(
      requireTransactionItem(
        finishItems[
          workspaceSearchMigrationRollbackFinishTransactionIndex
            .rolledBackRoot
        ],
      ),
    )
    expect(
      (
        await captureMigrationFailure(() =>
          missingRoot.port.readRolledBackRoot()
        )
      ).code,
    ).toBe('INVALID_STATE')
    expect(
      (
        await captureMigrationFailure(() =>
          missingRoot.port.readRollbackState()
        )
      ).code,
    ).toBe('INVALID_STATE')

    const missingTerminalState = createTestContext()
    let terminalPredecessor =
      await missingTerminalState.port.beginRollback({
        expectedRevision:
          missingTerminalState.fixture.appliedState.revision,
        lease: createLeaseClaim(missingTerminalState.fixture),
      })
    for (let remaining = 3; remaining > 0; remaining -= 1) {
      terminalPredecessor =
        await missingTerminalState.port.commitRollbackOperation({
          expectedRevision: terminalPredecessor.revision,
          lease: createLeaseClaim(missingTerminalState.fixture),
        })
    }
    await missingTerminalState.port.finishRollback({
      expectedRevision: terminalPredecessor.revision,
      lease: createLeaseClaim(missingTerminalState.fixture),
    })
    const terminalItems = requireTransactionItems(
      requireArrayEntry(
        missingTerminalState.harness.transactions,
        4,
      ),
    )
    missingTerminalState.harness.deletePutRow(
      requireTransactionItem(
        terminalItems[
          workspaceSearchMigrationRollbackFinishTransactionIndex
            .rollbackState
        ],
      ),
    )
    expect(
      (
        await captureMigrationFailure(() =>
          missingTerminalState.port.readRolledBackRoot()
        )
      ).code,
    ).toBe('INVALID_STATE')
    expect(
      (
        await captureMigrationFailure(() =>
          missingTerminalState.port.readRollbackReceipt(1)
        )
      ).code,
    ).toBe('INVALID_STATE')
  }, 20_000)

  test('rejects target drift before prepare or transaction write', async () => {
    const context = createTestContext()
    const state = await context.port.beginRollback({
      expectedRevision: context.fixture.appliedState.revision,
      lease: createLeaseClaim(context.fixture),
    })
    const next = requireArrayEntry(context.fixture.links, 2)
    context.harness.replaceTarget(next, {
      ...next.targetKey,
      entryType: { S: 'search-document' },
      title: { S: 'tenant-secret-drift' },
    })
    const transactionCount = context.harness.transactions.length
    const prepareCount = context.harness.prepareCount

    const failure = await captureMigrationFailure(() =>
      context.port.commitRollbackOperation({
        expectedRevision: state.revision,
        lease: createLeaseClaim(context.fixture),
      })
    )
    expect(failure.code).toBe('ROLLBACK_TARGET_DRIFT')
    expect(context.harness.transactions).toHaveLength(
      transactionCount,
    )
    expect(context.harness.prepareCount).toBe(prepareCount)
    expect(failure.message).not.toContain('tenant-secret')
  })

  test('rejects exact-version journal and marker-row substitution', async () => {
    const journalContext = createTestContext()
    const journalState = await journalContext.port.beginRollback({
      expectedRevision:
        journalContext.fixture.appliedState.revision,
      lease: createLeaseClaim(journalContext.fixture),
    })
    const selected = requireArrayEntry(
      journalContext.fixture.links,
      2,
    )
    journalContext.harness.replaceJournal(
      selected.receipt.journal,
      requireArrayEntry(
        journalContext.fixture.links,
        1,
      ).segment,
    )
    expect(
      (
        await captureMigrationFailure(() =>
          journalContext.port.commitRollbackOperation({
            expectedRevision: journalState.revision,
            lease: createLeaseClaim(journalContext.fixture),
          })
        )
      ).code,
    ).toBe('INVALID_JOURNAL')

    const rowContext = createTestContext()
    const rowState = await rowContext.port.beginRollback({
      expectedRevision: rowContext.fixture.appliedState.revision,
      lease: createLeaseClaim(rowContext.fixture),
    })
    const projection = createApplyProjection(
      requireArrayEntry(rowContext.fixture.links, 2).receipt,
    )
    rowContext.harness.replaceApplyMarkerProjection(
      rowContext.applyBinding,
      {
        ...projection,
        successorExecutionStateDigest:
          digest('substituted-successor-state'),
      },
    )
    expect(
      (
        await captureMigrationFailure(() =>
          rowContext.port.commitRollbackOperation({
            expectedRevision: rowState.revision,
            lease: createLeaseClaim(rowContext.fixture),
          })
        )
      ).code,
    ).toBe('INVALID_STATE')
    expect(rowContext.harness.transactions).toHaveLength(1)
  })

  test(
    'accepts timestamp-independent logical winners for overlapping retries',
    async () => {
      const winner = createTestContext()
      winner.harness.setClock('2026-07-29T01:21:05.000Z')
      const winnerInitial = await winner.port.beginRollback({
        expectedRevision: winner.fixture.appliedState.revision,
        lease: createLeaseClaim(winner.fixture),
      })
      const winnerBeginTransaction = requireArrayEntry(
        winner.harness.transactions,
        0,
      )

      const context = createTestContext()
      context.harness.setClock('2026-07-29T01:21:06.000Z')
      context.harness.winningTransactionBeforeError =
        winnerBeginTransaction
      context.harness.nextTransactionError = createCancellation(
        workspaceSearchMigrationRollbackStartTransactionIndex.startRoot,
        workspaceSearchMigrationRollbackStartTransactionIndex.count,
      )
      let state = await context.port.beginRollback({
        expectedRevision: context.fixture.appliedState.revision,
        lease: createLeaseClaim(context.fixture),
      })
      expect(state.stateDigest).toBe(winnerInitial.stateDigest)
      expect(state.runState.updatedAt).toBe(
        '2026-07-29T01:21:05.000Z',
      )

      context.harness.setClock('2026-07-29T01:21:10.000Z')
      context.harness.nextTransactionError = createCancellation(
        workspaceSearchMigrationRollbackOperationTransactionIndex
          .rollbackState,
        workspaceSearchMigrationRollbackOperationTransactionIndex.count,
      )
      expect(
        (
          await captureMigrationFailure(() =>
            context.port.commitRollbackOperation({
              expectedRevision: state.revision,
              lease: createLeaseClaim(context.fixture),
            })
          )
        ).code,
      ).toBe('INVALID_STATE')
      const winnerStepTransaction = requireArrayEntry(
        context.harness.transactions,
        context.harness.transactions.length - 1,
      )

      context.harness.setClock('2026-07-29T01:21:11.000Z')
      context.harness.winningTransactionBeforeError =
        winnerStepTransaction
      context.harness.nextTransactionError = createCancellation(
        workspaceSearchMigrationRollbackOperationTransactionIndex
          .rollbackState,
        workspaceSearchMigrationRollbackOperationTransactionIndex.count,
      )
      state = await context.port.commitRollbackOperation({
        expectedRevision: state.revision,
        lease: createLeaseClaim(context.fixture),
      })
      expect(state.runState.updatedAt).toBe(
        '2026-07-29T01:21:10.000Z',
      )

      while (state.nextSequence > 0) {
        state = await context.port.commitRollbackOperation({
          expectedRevision: state.revision,
          lease: createLeaseClaim(context.fixture),
        })
      }

      context.harness.setClock('2026-07-29T01:21:20.000Z')
      context.harness.setAuthorityAt(
        '2026-07-29T01:21:20.000Z',
      )
      context.harness.nextTransactionError = createCancellation(
        workspaceSearchMigrationRollbackFinishTransactionIndex
          .rolledBackRoot,
        workspaceSearchMigrationRollbackFinishTransactionIndex.count,
      )
      expect(
        (
          await captureMigrationFailure(() =>
            context.port.finishRollback({
              expectedRevision: state.revision,
              lease: createLeaseClaim(context.fixture),
            })
          )
        ).code,
      ).toBe('INVALID_STATE')
      const winnerFinishTransaction = requireArrayEntry(
        context.harness.transactions,
        context.harness.transactions.length - 1,
      )

      context.harness.setClock('2026-07-29T01:21:21.000Z')
      context.harness.winningTransactionBeforeError =
        winnerFinishTransaction
      context.harness.nextTransactionError = createCancellation(
        workspaceSearchMigrationRollbackFinishTransactionIndex
          .rolledBackRoot,
        workspaceSearchMigrationRollbackFinishTransactionIndex.count,
      )
      const root = await context.port.finishRollback({
        expectedRevision: state.revision,
        lease: createLeaseClaim(context.fixture),
      })
      expect(root.finishedAt).toBe('2026-07-29T01:21:20.000Z')
      expect(root.rollbackStartedAt).toBe(
        '2026-07-29T01:21:05.000Z',
      )
    },
    15_000,
  )

  test('rereads a coherent snapshot when a transaction lands between point reads', async () => {
    const context = createTestContext()
    let state = await context.port.beginRollback({
      expectedRevision: context.fixture.appliedState.revision,
      lease: createLeaseClaim(context.fixture),
    })
    while (state.nextSequence > 0) {
      state = await context.port.commitRollbackOperation({
        expectedRevision: state.revision,
        lease: createLeaseClaim(context.fixture),
      })
    }
    context.harness.nextTransactionError = createCancellation(
      workspaceSearchMigrationRollbackFinishTransactionIndex
        .rolledBackRoot,
      workspaceSearchMigrationRollbackFinishTransactionIndex.count,
    )
    await captureMigrationFailure(() =>
      context.port.finishRollback({
        expectedRevision: state.revision,
        lease: createLeaseClaim(context.fixture),
      })
    )
    const finishTransaction = requireArrayEntry(
      context.harness.transactions,
      context.harness.transactions.length - 1,
    )
    context.harness.scheduleTransactionAfterStrongReads(
      finishTransaction,
      2,
    )

    const terminalState = await context.port.readRollbackState()
    expect(terminalState?.status).toBe('rolled-back')
    expect(
      (await context.port.readRolledBackRoot())?.rootDigest,
    ).toBeDefined()
  }, 15_000)

  test('condition-checks the independently measured target TTL name during a race', async () => {
    const ttlAttribute = 'purgeAfterEpoch'
    const context = createTestContext(
      3,
      retainUntil,
      { targetTtlAttribute: ttlAttribute },
    )
    let state = await context.port.beginRollback({
      expectedRevision: context.fixture.appliedState.revision,
      lease: createLeaseClaim(context.fixture),
    })
    state = await context.port.commitRollbackOperation({
      expectedRevision: state.revision,
      lease: createLeaseClaim(context.fixture),
    })
    const link = requireArrayEntry(context.fixture.links, 1)
    context.harness.beforeNextTransaction = () => {
      const current = context.harness.readTarget(link)
      if (current === undefined) {
        throw new Error('Missing rollback TTL-race target.')
      }
      context.harness.replaceTarget(link, {
        ...current,
        [ttlAttribute]: { N: '1780000000' },
      })
    }
    context.harness.nextTransactionError = createCancellation(
      workspaceSearchMigrationRollbackOperationTransactionIndex.target,
      workspaceSearchMigrationRollbackOperationTransactionIndex.count,
    )

    const failure = await captureMigrationFailure(() =>
      context.port.commitRollbackOperation({
        expectedRevision: state.revision,
        lease: createLeaseClaim(context.fixture),
      })
    )
    expect(failure.code).toBe('ROLLBACK_TARGET_DRIFT')
    const transaction = requireArrayEntry(
      context.harness.transactions,
      context.harness.transactions.length - 1,
    )
    const target = requireTransactionItem(
      requireTransactionItems(transaction)[
        workspaceSearchMigrationRollbackOperationTransactionIndex.target
      ],
    )
    const attributeNames =
      target.Put?.ExpressionAttributeNames ??
      target.Delete?.ExpressionAttributeNames
    expect(Object.values(attributeNames ?? {})).toContain(ttlAttribute)
  })

  test('rejects hostile clock and transaction-error Proxies before traps', async () => {
    const returned = createTestContext()
    const returnedProxyClock = (): Date =>
      new Proxy(new Date(rollbackClockStart), {
        getPrototypeOf: () => {
          throw new Error('tenant-secret-clock-prototype')
        },
      })
    const returnedPort = createRollbackPort(
      returned.fixture,
      returned.harness,
      returned.applyBinding,
      returnedProxyClock,
    )
    const returnedFailure = await captureMigrationFailure(() =>
      returnedPort.beginRollback({
        expectedRevision: returned.fixture.appliedState.revision,
        lease: createLeaseClaim(returned.fixture),
      })
    )
    expect(returnedFailure.code).toBe('INVALID_STATE')
    expect(returnedFailure.message).not.toContain('tenant-secret')

    const thrown = createTestContext()
    const thrownProxyClock = (): Date => {
      throw new Proxy(new Error('tenant-secret-clock-throw'), {
        getPrototypeOf: () => {
          throw new Error('tenant-secret-clock-trap')
        },
      })
    }
    const thrownPort = createRollbackPort(
      thrown.fixture,
      thrown.harness,
      thrown.applyBinding,
      thrownProxyClock,
    )
    const thrownFailure = await captureMigrationFailure(() =>
      thrownPort.beginRollback({
        expectedRevision: thrown.fixture.appliedState.revision,
        lease: createLeaseClaim(thrown.fixture),
      })
    )
    expect(thrownFailure.code).toBe('INVALID_STATE')
    expect(thrownFailure.message).not.toContain('tenant-secret')

    const transaction = createTestContext()
    transaction.harness.nextTransactionError =
      new Proxy(new Error('tenant-secret-transaction-proxy'), {
        getPrototypeOf: () => {
          throw new Error('tenant-secret-transaction-trap')
        },
      })
    const transactionFailure =
      await captureMigrationFailure(() =>
        transaction.port.beginRollback({
          expectedRevision:
            transaction.fixture.appliedState.revision,
          lease: createLeaseClaim(transaction.fixture),
        })
      )
    expect(transactionFailure.code).toBe(
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
    expect(transactionFailure.message).not.toContain('tenant-secret')
  })

  test('classifies every fixed rollback-start cancellation index stably', async () => {
    const index =
      workspaceSearchMigrationRollbackStartTransactionIndex
    for (
      let failedIndex = 0;
      failedIndex < index.count;
      failedIndex += 1
    ) {
      const context = createTestContext()
      context.harness.nextTransactionError =
        createCancellation(failedIndex, index.count)
      const failure = await captureMigrationFailure(() =>
        context.port.beginRollback({
          expectedRevision:
            context.fixture.appliedState.revision,
          lease: createLeaseClaim(context.fixture),
        })
      )
      const expectedCode: WorkspaceSearchMigrationFailureCode =
        failedIndex === index.lease
          ? 'LEASE_LOST'
          : failedIndex === index.pointer ||
              failedIndex === index.receipt
            ? 'INVALID_MAINTENANCE_EVIDENCE'
            : 'INVALID_STATE'
      expect(failure.code).toBe(expectedCode)
      expect(failure.message).not.toContain('tenant-secret')
      expect(context.harness.transactions).toHaveLength(1)
      expect(await context.port.readRollbackState()).toBeUndefined()
    }
  }, 20_000)

  test('classifies every fixed reverse cancellation index stably', async () => {
    const index =
      workspaceSearchMigrationRollbackOperationTransactionIndex
    for (
      let failedIndex = 0;
      failedIndex < index.count;
      failedIndex += 1
    ) {
      const context = createTestContext()
      const state = await context.port.beginRollback({
        expectedRevision:
          context.fixture.appliedState.revision,
        lease: createLeaseClaim(context.fixture),
      })
      context.harness.nextTransactionError =
        createCancellation(failedIndex, index.count)
      const failure = await captureMigrationFailure(() =>
        context.port.commitRollbackOperation({
          expectedRevision: state.revision,
          lease: createLeaseClaim(context.fixture),
        })
      )
      const expectedCode: WorkspaceSearchMigrationFailureCode =
        failedIndex === index.lease
          ? 'LEASE_LOST'
          : failedIndex === index.pointer ||
              failedIndex === index.receipt
            ? 'INVALID_MAINTENANCE_EVIDENCE'
            : failedIndex === index.target
              ? 'ROLLBACK_TARGET_DRIFT'
              : 'INVALID_STATE'
      expect(failure.code).toBe(expectedCode)
      expect(failure.message).not.toContain('tenant-secret')
    }
  }, 20_000)

  test('classifies every fixed rollback-finish cancellation index stably', async () => {
    const index =
      workspaceSearchMigrationRollbackFinishTransactionIndex
    for (
      let failedIndex = 0;
      failedIndex < index.count;
      failedIndex += 1
    ) {
      const context = createTestContext()
      let state = await context.port.beginRollback({
        expectedRevision:
          context.fixture.appliedState.revision,
        lease: createLeaseClaim(context.fixture),
      })
      for (let sequence = 3; sequence > 0; sequence -= 1) {
        state = await context.port.commitRollbackOperation({
          expectedRevision: state.revision,
          lease: createLeaseClaim(context.fixture),
        })
      }
      context.harness.nextTransactionError =
        createCancellation(failedIndex, index.count)
      const failure = await captureMigrationFailure(() =>
        context.port.finishRollback({
          expectedRevision: state.revision,
          lease: createLeaseClaim(context.fixture),
        })
      )
      const expectedCode: WorkspaceSearchMigrationFailureCode =
        failedIndex === index.lease
          ? 'LEASE_LOST'
          : failedIndex === index.pointer ||
              failedIndex === index.receipt
            ? 'INVALID_MAINTENANCE_EVIDENCE'
            : 'INVALID_STATE'
      expect(failure.code).toBe(expectedCode)
      expect(failure.message).not.toContain('tenant-secret')
      expect(context.harness.transactions).toHaveLength(5)
      expect(await context.port.readRolledBackRoot()).toBeUndefined()
      expect(
        (await context.port.readRollbackState())?.status,
      ).toBe('rolling-back')
    }
  }, 30_000)

  test('prefers integrity cancellation over transient pressure', async () => {
    const mixed = createTestContext()
    const mixedState = await mixed.port.beginRollback({
      expectedRevision: mixed.fixture.appliedState.revision,
      lease: createLeaseClaim(mixed.fixture),
    })
    const operationIndex =
      workspaceSearchMigrationRollbackOperationTransactionIndex
    mixed.harness.nextTransactionError =
      createCancellationWithCodes(
        Array.from(
          { length: operationIndex.count },
          (_, index) =>
            index === operationIndex.executionRun
              ? 'ConditionalCheckFailed'
              : index === operationIndex.target
                ? 'TransactionConflict'
                : 'None',
        ),
      )
    const mixedFailure = await captureMigrationFailure(() =>
      mixed.port.commitRollbackOperation({
        expectedRevision: mixedState.revision,
        lease: createLeaseClaim(mixed.fixture),
      })
    )
    expect(mixedFailure.code).toBe('INVALID_STATE')
    expect(mixedFailure.message).not.toContain('tenant-secret')

    const transient = createTestContext()
    const transientState = await transient.port.beginRollback({
      expectedRevision:
        transient.fixture.appliedState.revision,
      lease: createLeaseClaim(transient.fixture),
    })
    transient.harness.nextTransactionError =
      createCancellationWithCodes(
        Array.from(
          { length: operationIndex.count },
          (_, index) =>
            index === operationIndex.target
              ? 'TransactionConflict'
              : 'None',
        ),
      )
    expect(
      (
        await captureMigrationFailure(() =>
          transient.port.commitRollbackOperation({
            expectedRevision: transientState.revision,
            lease: createLeaseClaim(transient.fixture),
          })
        )
      ).code,
    ).toBe('TRANSIENT_INFRASTRUCTURE_FAILURE')
  })

  test('finishes zero-mutation apply and rejects exact retention boundary', async () => {
    const zero = createTestContext(0)
    const rolling = await zero.port.beginRollback({
      expectedRevision: zero.fixture.appliedState.revision,
      lease: createLeaseClaim(zero.fixture),
    })
    const root = await zero.port.finishRollback({
      expectedRevision: rolling.revision,
      lease: createLeaseClaim(zero.fixture),
    })
    expect(root.terminalReceipt).toBeNull()
    expect(root.terminalState.restored).toBe(0)

    const boundary = createTestContext(
      3,
      '2026-07-29T01:21:10.000Z',
    )
    const failure = await captureMigrationFailure(() =>
      boundary.port.beginRollback({
        expectedRevision:
          boundary.fixture.appliedState.revision,
        lease: createLeaseClaim(boundary.fixture),
      })
    )
    expect(failure.code).toBe('INVALID_JOURNAL')
    expect(boundary.harness.transactions).toHaveLength(0)
  })

  test('blocks verification winner and exposes matching rollback sentinel', async () => {
    const probe = createTestContext()
    const sentinel =
      createWorkspaceSearchMigrationRollbackStartSentinelAbsentConditionCheck({
        stateTable:
          probe.fixture.configuration.tables['migration-state'],
        configurationHash: probe.fixture.configurationHash,
        executionRun: probe.fixture.executionRun,
      })
    await probe.port.beginRollback({
      expectedRevision: probe.fixture.appliedState.revision,
      lease: createLeaseClaim(probe.fixture),
    })
    const startPut = requireTransactionItem(
      requireTransactionItems(
        requireArrayEntry(probe.harness.transactions, 0),
      )[
        workspaceSearchMigrationRollbackStartTransactionIndex
          .startRoot
      ],
    ).Put
    expect(sentinel.ConditionCheck?.Key).toEqual(
      startPut === undefined || startPut.Item === undefined
        ? undefined
        : readMigrationStateItemKey(startPut.Item),
    )

    const context = createTestContext()
    context.harness.seedConditionKey(
      createVerificationConflictCondition(context.fixture),
    )
    const failure = await captureMigrationFailure(() =>
      context.port.beginRollback({
        expectedRevision:
          context.fixture.appliedState.revision,
        lease: createLeaseClaim(context.fixture),
      })
    )
    expect(failure.code).toBe('INVALID_STATE')
    expect(context.harness.transactions).toHaveLength(0)
    expect(sentinel.ConditionCheck?.Key).toBeDefined()

    for (const raceIndex of [
      workspaceSearchMigrationRollbackStartTransactionIndex
        .verificationState,
      workspaceSearchMigrationRollbackStartTransactionIndex
        .verifiedRoot,
    ]) {
      const raced = createTestContext()
      raced.harness.nextTransactionError = createCancellation(
        raceIndex,
        workspaceSearchMigrationRollbackStartTransactionIndex
          .count,
      )
      expect(
        (
          await captureMigrationFailure(() =>
            raced.port.beginRollback({
              expectedRevision:
                raced.fixture.appliedState.revision,
              lease: createLeaseClaim(raced.fixture),
            })
          )
        ).code,
      ).toBe('INVALID_STATE')
      expect(raced.harness.transactions).toHaveLength(1)
      expect(
        await raced.port.readRollbackState(),
      ).toBeUndefined()
    }
  })

  test('rejects a foreign apply-receipt capability at construction', () => {
    const fixture = createRollbackFixture(3)
    const applyBinding =
      createWorkspaceSearchMigrationApplyReceiptAwsBinding({
        stateTable:
          fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      })
    const harness = new RollbackOperationHarness(
      fixture,
      applyBinding,
    )
    const foreignFixture = createRollbackFixture(3, retainUntil, {
      runId: 'foreign-rollback-run',
    })
    const foreign =
      createWorkspaceSearchMigrationApplyReceiptAwsBinding({
        stateTable:
          foreignFixture.configuration.tables['migration-state'],
        configurationHash: foreignFixture.configurationHash,
        executionRun: foreignFixture.executionRun,
      })
    expect(() =>
      createRollbackPort(fixture, harness, foreign)
    ).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
  })
})

/**
 * Complete port, harness, binding, and static fixture for one test.
 */
type RollbackTestContext = {
  /** Complete correlated static fixture. */
  readonly fixture: RollbackOperationFixture
  /** Official run-bound apply-receipt capability. */
  readonly applyBinding:
    WorkspaceSearchMigrationApplyReceiptAwsBinding
  /** In-memory narrow dependency controller. */
  readonly harness: RollbackOperationHarness
  /** Standalone rollback port under test. */
  readonly port: WorkspaceSearchMigrationRollbackOperationAwsPort
}

/**
 * Optional fixture identity overrides.
 */
type RollbackFixtureOptions = {
  /** Alternate admitted run identifier. */
  readonly runId?: string
  /** Alternate enabled Workspace Search TTL attribute. */
  readonly targetTtlAttribute?: string
}

/**
 * Creates one complete initialized rollback adapter context.
 *
 * @param mutationCount - Supported zero- or three-mutation apply.
 * @param journalRetainUntil - Exact journal-chain retention deadline.
 * @param options - Optional measured fixture overrides.
 * @returns Complete port and in-memory dependencies.
 */
function createTestContext(
  mutationCount: 0 | 3 = 3,
  journalRetainUntil: string = retainUntil,
  options: RollbackFixtureOptions = {},
): RollbackTestContext {
  const fixture = createRollbackFixture(
    mutationCount,
    journalRetainUntil,
    options,
  )
  const applyBinding =
    createWorkspaceSearchMigrationApplyReceiptAwsBinding({
      stateTable:
        fixture.configuration.tables['migration-state'],
      configurationHash: fixture.configurationHash,
      executionRun: fixture.executionRun,
    })
  const harness = new RollbackOperationHarness(
    fixture,
    applyBinding,
  )
  return {
    fixture,
    applyBinding,
    harness,
    port: createRollbackPort(fixture, harness, applyBinding),
  }
}

/**
 * Creates one adapter from exact fixture and harness capabilities.
 *
 * @param fixture - Complete exact rollback fixture.
 * @param harness - In-memory narrow dependency controller.
 * @param applyBinding - Exact apply-receipt capability.
 * @returns Standalone rollback port.
 */
function createRollbackPort(
  fixture: RollbackOperationFixture,
  harness: RollbackOperationHarness,
  applyBinding: WorkspaceSearchMigrationApplyReceiptAwsBinding,
  clock: () => Date = harness.clock,
): WorkspaceSearchMigrationRollbackOperationAwsPort {
  return createAwsWorkspaceSearchMigrationRollbackOperationPort({
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    executionBoundary: fixture.executionBoundary,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    closedWriterFenceRecord: fixture.closedWriterFenceRecord,
    executionRun: fixture.executionRun,
    authorityPort: harness.authorityPort,
    appliedRootReader: harness.appliedRootReader,
    applyRunStateReader: harness.applyRunStateReader,
    journalGateway: harness.journalGateway,
    applyReceiptBinding: applyBinding,
    transport: harness.transport,
    clock,
  })
}

/**
 * Creates one complete internally correlated complete-apply fixture.
 *
 * @param mutationCount - Supported zero- or three-mutation apply.
 * @param journalRetainUntil - Exact immutable journal retention deadline.
 * @param options - Optional alternate run identity.
 * @returns Complete exact static and forward evidence.
 */
function createRollbackFixture(
  mutationCount: 0 | 3,
  journalRetainUntil: string = retainUntil,
  options: RollbackFixtureOptions = {},
): RollbackOperationFixture {
  const selectedRunId = options.runId ?? runId
  const configuration = createConfiguration(
    options.targetTtlAttribute,
  )
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const maintenanceReceipt = createMaintenanceReceipt(
    selectedRunId,
  )
  const planSeal = createPlanSeal(
    selectedRunId,
    configurationHash,
    mutationCount,
  )
  const writerFence = createWriterFenceBinding(configuration)
  const closeAuthority = {
    configurationHash,
    runId: selectedRunId,
    ownerId,
    leaseFenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      digest(`close-maintenance-receipt:${selectedRunId}`),
    maintenanceEvidencePointerRevision: 11,
  }
  const open =
    createWorkspaceSearchWriterFenceInitialOpenRecord(
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
  const receiptDigest = createMigrationDigest(maintenanceReceipt)
  const executionBoundary = createAdmittedBoundary(
    closedBoundary,
    maintenanceReceipt,
    receiptDigest,
  )
  const sealedPlanningAuthority = createSealedAuthority(
    selectedRunId,
    configurationHash,
    writerFence.tableIds,
    planSeal,
    receiptDigest,
    retainUntil,
  )
  const admissionAuthority = createCurrentAuthority({
    selectedRunId,
    configuration,
    configurationHash,
    receipt: maintenanceReceipt,
    evaluatedAt: '2026-07-29T01:19:29.000Z',
    heartbeatAt: '2026-07-29T01:19:00.000Z',
    expiresAt: '2026-07-29T01:20:00.000Z',
  })
  const executionRun =
    createWorkspaceSearchMigrationExecutionRun({
      executionBoundary,
      sealedPlanningAuthority,
      planSeal,
      configuration,
      configurationHash,
      currentAuthority: admissionAuthority,
      createdAt,
    })
  const links = mutationCount === 0
    ? []
    : createJournalChain({
        selectedRunId,
        configurationHash,
        maintenanceReceipt,
        retainUntil: journalRetainUntil,
      })
  const markerAccumulator = new MigrationDigestAccumulator()
  for (const link of links) {
    markerAccumulator.add(createMigrationDigest(link.receipt))
  }
  const terminalApplyingState: WorkspaceSearchMigrationRunState = {
    ...executionRun.runState,
    revision: 1 + mutationCount + 5,
    appliedOperationCount: mutationCount,
    applyMarkerDigestState: markerAccumulator.exportState(),
    journalSequence: mutationCount,
    journalHeadDigest: mutationCount === 0
      ? zeroHexDigest()
      : requireArrayEntry(links, mutationCount - 1)
          .receipt.journal.headDigest,
    apply: createTerminalTraversal(mutationCount),
    updatedAt: '2026-07-29T01:19:50.000Z',
  }
  validateWorkspaceSearchMigrationRunState(terminalApplyingState)
  const seal = createCompleteApplySeal({
    selectedRunId,
    executionRun,
    sealedPlanningAuthority,
    predecessor: terminalApplyingState,
    markerAccumulator,
    mutationCount,
    retainUntil: journalRetainUntil,
  })
  const sealReference = createCompleteSealReference(
    selectedRunId,
    seal,
    journalRetainUntil,
  )
  const appliedState: WorkspaceSearchMigrationRunState = {
    ...terminalApplyingState,
    revision: terminalApplyingState.revision + 1,
    status: 'applied',
    applySeal: {
      scope: 'complete-plan',
      objectKey: sealReference.objectKey,
      versionId: sealReference.versionId,
      contentDigest: sealReference.contentDigest,
    },
    updatedAt: appliedAt,
  }
  validateWorkspaceSearchMigrationRunState(appliedState)
  const appliedRoot = createAppliedRoot({
    selectedRunId,
    executionRun,
    seal,
    sealReference,
    appliedState,
    mutationCount,
    retainUntil: journalRetainUntil,
  })
  const currentAuthority = createCurrentAuthority({
    selectedRunId,
    configuration,
    configurationHash,
    receipt: maintenanceReceipt,
    evaluatedAt: '2026-07-29T01:20:59.000Z',
    heartbeatAt: '2026-07-29T01:20:30.000Z',
    expiresAt: '2026-07-29T01:21:30.000Z',
  })
  return {
    configuration,
    configurationHash,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    appliedRoot,
    appliedState,
    currentAuthority,
    links,
  }
}

/**
 * Creates the revision-two planning-admitted boundary.
 *
 * @param closed - Exact revision-one closed boundary.
 * @param receipt - Exact current maintenance receipt.
 * @param receiptDigest - Digest of the exact receipt.
 * @returns Exact revision-two planning-admitted boundary.
 */
function createAdmittedBoundary(
  closed: ReturnType<
    typeof createWorkspaceSearchMigrationExecutionBoundary
  >,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  receiptDigest: string,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  const fields = {
    kind: closed.kind,
    boundaryVersion: closed.boundaryVersion,
    migrationId: closed.migrationId,
    migrationVersion: closed.migrationVersion,
    runId: closed.runId,
    configurationHash: closed.configurationHash,
    tableIds: closed.tableIds,
    closedWriterFenceRecordDigest:
      closed.closedWriterFenceRecordDigest,
    closedAt: closed.closedAt,
    closeAuthority: closed.closeAuthority,
    phase: 'planning-admitted',
    revision: 2,
    planningAdmission: {
      ownerId,
      leaseFenceToken: 7,
      maintenanceEvidenceReceiptDigest: receiptDigest,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceDigest: receipt.evidenceDigest,
      maintenanceEvidenceLocator: receipt.evidenceLocator,
      runtimeRevision: receipt.runtimeRevision,
      drainStartedAt: closedAt,
      drainCompletedAt: '2026-07-29T01:15:00.000Z',
      admittedAt,
    },
  } satisfies Omit<
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
    'boundaryDigest'
  >
  return {
    ...fields,
    boundaryDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates one strict compact version-two sealed planning authority.
 *
 * @param selectedRunId - Exact admitted run identifier.
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - All six exact table incarnations.
 * @param planSeal - Exact strict plan seal.
 * @param receiptDigest - Current maintenance receipt digest.
 * @param artifactRetainUntil - Exact immutable artifact deadline.
 * @returns Detached strict sealed planning authority.
 */
function createSealedAuthority(
  selectedRunId: string,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
  artifactRetainUntil: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const planManifestDigest =
    digest(`plan-manifest:${selectedRunId}`)
  const provenanceManifestDigest =
    digest(`provenance-manifest:${selectedRunId}`)
  const fields = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    tableIds,
    planSealReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealDigest}.artifact`,
      versionId: 'plan-seal-version',
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil: artifactRetainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${planManifestDigest}.artifact`,
      versionId: 'plan-manifest-version',
      contentDigest: planManifestDigest,
      byteLength: 1,
      retainUntil: artifactRetainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        `workspace-search/v1/planning-provenance-artifacts/v1/` +
        `${selectedRunId}/${configurationHash}/manifest-heads/` +
        `${provenanceManifestDigest}.artifact`,
      versionId: 'provenance-manifest-version',
      contentDigest: provenanceManifestDigest,
      byteLength: 1,
      retainUntil: artifactRetainUntil,
    },
    planDigest: planSeal.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: planSeal.sourceOperationCount,
    orphanOperationCount: planSeal.orphanOperationCount,
    planOperationCount: planSeal.planOperationCount,
    planningAuthorityProvenanceDigest:
      digest(`planning-provenance:${selectedRunId}`),
    historicalReceiptBindingDigest:
      digest(`historical-receipt:${selectedRunId}`),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createEvidenceHead('project-directory'),
      createEvidenceHead('work-items'),
      createEvidenceHead('collaboration'),
      createEvidenceHead('documents'),
      createEvidenceHead('workspace-search'),
    ],
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest: receiptDigest,
    },
    sealedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    'authorityDigest'
  >
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2({
      ...fields,
      authorityDigest: createMigrationDigest(fields),
    }),
  )
}

/**
 * Creates one compact terminal planning evidence head.
 *
 * @param chain - Exact evidence-chain role.
 * @returns Exact terminal evidence head.
 */
function createEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
) {
  return {
    chain,
    progressDigest: digest(`progress:${chain}`),
    pageCount: 1,
    terminalEvidenceDigest: digest(`evidence:${chain}`),
    terminalCheckpointDigest: digest(`checkpoint:${chain}`),
  }
}

/**
 * Exact material for one fresh current authority fixture.
 */
type CreateCurrentAuthorityInput = {
  /** Exact selected run identifier. */
  readonly selectedRunId: string
  /** Complete measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact current maintenance receipt. */
  readonly receipt: WorkspaceSearchMaintenanceEvidenceReceipt
  /** Adapter evaluation time. */
  readonly evaluatedAt: string
  /** Exact lease heartbeat time. */
  readonly heartbeatAt: string
  /** Exact lease expiry time. */
  readonly expiresAt: string
}

/**
 * Creates one exact fresh pre-plan authority.
 *
 * @param input - Run, table, receipt, and lease window.
 * @returns Exact fresh current authority.
 */
function createCurrentAuthority(
  input: CreateCurrentAuthorityInput,
): WorkspaceSearchMigrationPrePlanAuthority {
  return {
    configurationHash: input.configurationHash,
    stateTableId:
      input.configuration.tables['migration-state'].tableId,
    lease: {
      runId: input.selectedRunId,
      ownerId,
      fenceToken: 7,
      heartbeatAt: input.heartbeatAt,
      expiresAt: input.expiresAt,
    },
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(input.receipt),
    maintenanceEvidencePointerRevision: 12,
    maintenanceEvidenceReceipt: input.receipt,
    evaluatedAt: input.evaluatedAt,
  }
}

/**
 * Creates one fresh maintenance receipt bound to fence seven.
 *
 * @param selectedRunId - Exact admitted run identifier.
 * @returns Exact maintenance receipt.
 */
function createMaintenanceReceipt(
  selectedRunId: string,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId: selectedRunId,
    evidenceDigest:
      digest(`maintenance-evidence:${selectedRunId}`),
    evidenceLocator:
      'workspace-search/v1/maintenance/current.json',
    runtimeRevision: 41,
    fenceToken: 7,
    validatedAt: '2026-07-29T01:18:30.000Z',
    oldestObservationAt: '2026-07-29T01:18:00.000Z',
    validUntil: '2026-07-29T01:23:00.001Z',
  }
}

/**
 * Creates one strict plan seal for zero or three forward mutations.
 *
 * @param selectedRunId - Exact admitted run identifier.
 * @param configurationHash - Reviewed configuration digest.
 * @param mutationCount - Zero or three planned mutations.
 * @returns Exact strict plan seal.
 */
function createPlanSeal(
  selectedRunId: string,
  configurationHash: string,
  mutationCount: 0 | 3,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    dryRunEvidenceDigest:
      digest(`dry-run:${selectedRunId}`),
    planningSnapshotDigest:
      digest(`planning-snapshot:${selectedRunId}`),
    planDigest: mutationCount === 0
      ? createEmptyWorkspaceSearchPlanDigest()
      : digest(`three-operation-plan:${selectedRunId}`),
    planOperationCount: mutationCount,
    sourceOperationCount: mutationCount,
    orphanOperationCount: 0,
    createdAt: '2026-07-29T01:17:00.000Z',
  }
}

/**
 * Inputs used to build three linked forward journals.
 */
type CreateJournalChainInput = {
  /** Exact selected run identifier. */
  readonly selectedRunId: string
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact maintenance receipt used by apply. */
  readonly maintenanceReceipt:
    WorkspaceSearchMaintenanceEvidenceReceipt
  /** Exact immutable retention deadline. */
  readonly retainUntil: string
}

/**
 * Creates three exact journal links covering all restoration shapes.
 *
 * @param input - Run, configuration, authority, and retention.
 * @returns Three forward links in increasing sequence order.
 */
function createJournalChain(
  input: CreateJournalChainInput,
): readonly ForwardJournalLink[] {
  const first = createJournalLink({
    ...input,
    sequence: 1,
    previousHeadDigest: zeroHexDigest(),
    entityId: 'document-create',
    before: createAbsentSnapshot(),
    after: createPresentSnapshot(
      'document-create',
      'Created by apply',
    ),
  })
  const second = createJournalLink({
    ...input,
    sequence: 2,
    previousHeadDigest: first.receipt.journal.headDigest,
    entityId: 'document-replace',
    before: createPresentSnapshot(
      'document-replace',
      'Before apply',
    ),
    after: createPresentSnapshot(
      'document-replace',
      'After apply',
    ),
  })
  const third = createJournalLink({
    ...input,
    sequence: 3,
    previousHeadDigest: second.receipt.journal.headDigest,
    entityId: 'document-delete',
    before: createPresentSnapshot(
      'document-delete',
      'Deleted by apply',
    ),
    after: createAbsentSnapshot(),
  })
  return [first, second, third]
}

/**
 * Exact inputs used to create one forward journal link.
 */
type CreateJournalLinkInput = CreateJournalChainInput & {
  /** Positive forward sequence. */
  readonly sequence: number
  /** Exact predecessor journal head. */
  readonly previousHeadDigest: string
  /** Stable target entity identifier. */
  readonly entityId: string
  /** Exact pre-apply snapshot shape. */
  readonly before: MigrationItemSnapshot
  /** Exact post-apply snapshot shape. */
  readonly after: MigrationItemSnapshot
}

/**
 * Creates one exact immutable journal and correlated apply receipt.
 *
 * @param input - Exact sequence, target transition, and authority.
 * @returns Complete decoded and durable forward link.
 */
function createJournalLink(
  input: CreateJournalLinkInput,
): ForwardJournalLink {
  const targetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: {
      S: createWorkspaceSearchDocumentRecordKey(
        'document',
        input.entityId,
      ),
    },
  }
  const before = bindSnapshotToKey(input.before, targetKey)
  const after = bindSnapshotToKey(input.after, targetKey)
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const operationId =
    digest(`operation:${input.selectedRunId}:${input.sequence}`)
  const segment: WorkspaceSearchJournalSegment = {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: input.selectedRunId,
    configurationHash: input.configurationHash,
    sequence: input.sequence,
    preparedFenceToken: 7,
    operationId,
    previousHeadDigest: input.previousHeadDigest,
    targetKey: encodeAttributeMap(targetKey),
    targetKeyDigest,
    before: encodeSnapshot(before),
    after: encodeSnapshot(after),
    createdAt:
      `2026-07-29T01:19:4${input.sequence}.000Z`,
  }
  const text = serializeWorkspaceSearchJournalSegment(segment)
  const contentDigest = digestText(text)
  const versionId = `journal-version-${input.sequence}`
  const journal: WorkspaceSearchJournalReference = {
    objectKey:
      `workspace-search/v1/runs/${input.selectedRunId}/segments/` +
      `${String(input.sequence).padStart(12, '0')}.json`,
    versionId,
    contentDigest,
    byteLength: new TextEncoder().encode(text).byteLength,
    retainUntil: input.retainUntil,
    headDigest: createJournalHeadDigest({
      previousHeadDigest: input.previousHeadDigest,
      sequence: input.sequence,
      operationId,
      contentDigest,
      versionId,
    }),
  }
  const receipt: WorkspaceSearchOperationReceipt = {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId: input.selectedRunId,
    configurationHash: input.configurationHash,
    operationId,
    planSequence: input.sequence,
    planOperationDigest:
      digest(`plan-operation:${input.selectedRunId}:${input.sequence}`),
    sequence: input.sequence,
    targetKeyDigest,
    beforeDigest: before.digest,
    afterDigest: after.digest,
    fenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(input.maintenanceReceipt),
    journal,
    committedAt:
      `2026-07-29T01:19:5${input.sequence}.000Z`,
  }
  return {
    segment,
    receipt,
    before,
    after,
    targetKey,
  }
}

/**
 * Creates an absent target snapshot.
 *
 * @returns Exact canonical absent snapshot.
 */
function createAbsentSnapshot(): MigrationItemSnapshot {
  return {
    exists: false,
    digest: createAbsentMigrationItemDigest(),
  }
}

/**
 * Creates one present target payload before its physical key is bound.
 *
 * @param entityId - Stable target entity identifier.
 * @param title - Exact fixture title.
 * @returns Present low-level snapshot.
 */
function createPresentSnapshot(
  entityId: string,
  title: string,
): MigrationItemSnapshot {
  const item = {
    entryType: { S: 'search-document' },
    entityType: { S: 'document' },
    entityId: { S: entityId },
    title: { S: title },
  }
  return {
    exists: true,
    item,
    digest: createAttributeMapDigest(item),
  }
}

/**
 * Adds the exact target key and recomputes one present snapshot digest.
 *
 * @param snapshot - Present or absent fixture snapshot.
 * @param key - Exact physical target key.
 * @returns Exact key-bound snapshot.
 */
function bindSnapshotToKey(
  snapshot: MigrationItemSnapshot,
  key: Readonly<Record<string, AttributeValue>>,
): MigrationItemSnapshot {
  if (!snapshot.exists) return snapshot
  const item = {
    ...cloneAttributeMap(key),
    ...cloneAttributeMap(snapshot.item),
  }
  return {
    exists: true,
    item,
    digest: createAttributeMapDigest(item),
  }
}

/**
 * Losslessly encodes one native snapshot for immutable journal bytes.
 *
 * @param snapshot - Exact native target snapshot.
 * @returns Exact JSON-safe encoded snapshot.
 */
function encodeSnapshot(
  snapshot: MigrationItemSnapshot,
): EncodedMigrationItemSnapshot {
  return snapshot.exists
    ? {
        exists: true,
        item: encodeAttributeMap(snapshot.item),
        digest: snapshot.digest,
      }
    : {
        exists: false,
        digest: snapshot.digest,
      }
}

/**
 * Exact material used to create a complete production apply seal.
 */
type CreateCompleteApplySealInput = {
  /** Exact selected run identifier. */
  readonly selectedRunId: string
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact immutable sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact terminal applying predecessor. */
  readonly predecessor: WorkspaceSearchMigrationRunState
  /** Exact forward marker accumulator. */
  readonly markerAccumulator: MigrationDigestAccumulator
  /** Zero or three forward mutations. */
  readonly mutationCount: 0 | 3
  /** Exact minimum journal retention deadline. */
  readonly retainUntil: string
}

/**
 * Creates one strict complete production apply seal.
 *
 * @param input - Exact admission, predecessor, marker, and retention material.
 * @returns Exact complete apply seal.
 */
function createCompleteApplySeal(
  input: CreateCompleteApplySealInput,
): WorkspaceSearchMigrationCompleteApplySeal {
  const fields = {
    kind: 'workspace-search-migration-complete-apply-seal',
    sealVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    scope: 'complete-plan',
    runId: input.selectedRunId,
    configurationHash: input.executionRun.configurationHash,
    executionRunDigest:
      input.executionRun.executionRunDigest,
    executionRunBindingDigest:
      input.executionRun.binding.bindingDigest,
    sealedPlanningAuthorityDigest:
      input.sealedPlanningAuthority.authorityDigest,
    tableIds: input.executionRun.binding.tableIds,
    planSealReference:
      input.executionRun.binding.planSealReference,
    planDigest: input.predecessor.planDigest,
    sourceOperationCount: input.mutationCount,
    orphanOperationCount: 0,
    planOperationCount: input.mutationCount,
    predecessorRevision: input.predecessor.revision,
    predecessorExecutionStateDigest:
      digest(`terminal-execution-state:${input.selectedRunId}`),
    predecessorRunStateDigest:
      createMigrationDigest(input.predecessor),
    markerCount: input.mutationCount,
    applyMarkerDigestState:
      input.markerAccumulator.exportState(),
    applyMarkerAggregateDigest:
      input.markerAccumulator.digest(),
    journalSequence: input.mutationCount,
    journalHeadDigest: input.predecessor.journalHeadDigest,
    ...(input.mutationCount === 0
      ? {}
      : { minimumJournalRetainUntil: input.retainUntil }),
    apply: input.predecessor.apply,
    applyTraversalDigest:
      createMigrationDigest(input.predecessor.apply),
    createdAt: '2026-07-29T01:19:55.000Z',
  } satisfies Omit<
    WorkspaceSearchMigrationCompleteApplySeal,
    'sealDigest'
  >
  return {
    ...fields,
    sealDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates the rich exact-version reference for one complete apply seal.
 *
 * @param selectedRunId - Exact selected run identifier.
 * @param seal - Exact complete apply seal.
 * @param artifactRetainUntil - Exact immutable retention deadline.
 * @returns Exact strict seal reference.
 */
function createCompleteSealReference(
  selectedRunId: string,
  seal: WorkspaceSearchMigrationCompleteApplySeal,
  artifactRetainUntil: string,
): WorkspaceSearchMigrationCompleteApplySealReference {
  const bytes =
    serializeWorkspaceSearchMigrationCompleteApplySeal(seal)
  return {
    scope: 'complete-plan',
    objectKey:
      `workspace-search/v1/apply-seals/${selectedRunId}/` +
      `${digestBytes(bytes)}.artifact`,
    versionId: 'apply-seal-version',
    contentDigest: createMigrationDigest(seal),
    byteLength: bytes.byteLength,
    retainUntil: artifactRetainUntil,
  }
}

/**
 * Exact material used to construct an immutable applied root.
 */
type CreateAppliedRootInput = {
  /** Exact selected run identifier. */
  readonly selectedRunId: string
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact complete production apply seal. */
  readonly seal: WorkspaceSearchMigrationCompleteApplySeal
  /** Exact immutable complete-seal reference. */
  readonly sealReference:
    WorkspaceSearchMigrationCompleteApplySealReference
  /** Exact applied successor pure state. */
  readonly appliedState: WorkspaceSearchMigrationRunState
  /** Zero or three forward mutations. */
  readonly mutationCount: 0 | 3
  /** Exact minimum journal retention deadline. */
  readonly retainUntil: string
}

/**
 * Creates one strict immutable complete applied root.
 *
 * @param input - Exact admission, seal, successor, and retention material.
 * @returns Detached strict applied root.
 */
function createAppliedRoot(
  input: CreateAppliedRootInput,
): WorkspaceSearchMigrationAppliedRoot {
  const fields = {
    kind: 'workspace-search-migration-applied-root',
    rootVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    stateTableId:
      input.executionRun.binding.tableIds['migration-state'],
    configurationHash: input.executionRun.configurationHash,
    runId: input.selectedRunId,
    executionRunDigest:
      input.executionRun.executionRunDigest,
    predecessorRevision: input.seal.predecessorRevision,
    predecessorExecutionStateDigest:
      input.seal.predecessorExecutionStateDigest,
    predecessorRunStateDigest:
      input.seal.predecessorRunStateDigest,
    seal: input.seal,
    sealReference: input.sealReference,
    authority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        input.executionRun.binding.currentAuthority
          .maintenanceEvidenceReceiptDigest,
      evaluatedAt: '2026-07-29T01:19:59.000Z',
    },
    ...(input.mutationCount === 0
      ? {}
      : { minimumJournalRetainUntil: input.retainUntil }),
    successorRevision: input.appliedState.revision,
    status: 'applied',
    successorRunStateDigest:
      createMigrationDigest(input.appliedState),
    committedAt: appliedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationAppliedRoot,
    'rootDigest'
  >
  return parseWorkspaceSearchMigrationAppliedRoot(
    serializeWorkspaceSearchMigrationAppliedRoot({
      ...fields,
      rootDigest: createMigrationDigest(fields),
    }),
  )
}

/**
 * Creates one complete terminal apply traversal.
 *
 * @param mutationCount - Zero or three mapped rows.
 * @returns Exact completed traversal.
 */
function createTerminalTraversal(
  mutationCount: 0 | 3,
): WorkspaceSearchMigrationTraversalProgress {
  return {
    sources: {
      'project-directory':
        createTerminalCheckpoint(mutationCount),
      'work-items': createTerminalCheckpoint(0),
      collaboration: createTerminalCheckpoint(0),
      documents: createTerminalCheckpoint(0),
    },
    target: createTerminalCheckpoint(mutationCount),
  }
}

/**
 * Creates one cursor-free completed checkpoint.
 *
 * @param mapped - Zero or three mapped rows.
 * @returns Exact terminal checkpoint.
 */
function createTerminalCheckpoint(
  mapped: 0 | 3,
): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  for (let index = 0; index < mapped; index += 1) {
    keyAccumulator.add(digest(`checkpoint-key-${index}`))
    contentAccumulator.add(
      digest(`checkpoint-content-${index}`),
    )
  }
  return {
    completed: true,
    aggregate: {
      scanned: mapped,
      mapped,
      ignored: 0,
      invalid: 0,
      projected: mapped,
      deleted: 0,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: 1,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Creates one complete measured migration configuration.
 *
 * @param targetTtlAttribute - Optional enabled target TTL attribute.
 * @returns Stable exact measured configuration.
 */
function createConfiguration(
  targetTtlAttribute?: string,
):
WorkspaceSearchMigrationConfiguration {
  const targetTable = createSupportingTable('workspace-search')
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
      'project-directory':
        createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': targetTtlAttribute === undefined
        ? targetTable
        : {
            ...targetTable,
            ttl: {
              status: 'ENABLED',
              attribute: targetTtlAttribute,
            },
          },
      'migration-state':
        createSupportingTable('migration-state'),
    },
    journal: {
      bucketName:
        'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: configurationTime,
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
 * Creates one independently reconstructed writer-fence binding.
 *
 * @param configuration - Exact measured migration configuration.
 * @returns Exact six-table writer-fence binding.
 */
function createWriterFenceBinding(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchWriterFenceBinding {
  const stateTable = configuration.tables['migration-state']
  return createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTable.tableName,
    stateTableId: stateTable.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest({
        role: 'migration-state',
        tableName: stateTable.tableName,
        tableArn: stateTable.tableArn,
        tableId: stateTable.tableId,
        creationTime: stateTable.creationTime,
        account: stateTable.account,
        region: stateTable.region,
      }),
    tableIds: createTableIds(configuration),
  })
}

/**
 * Creates one measured source table identity.
 *
 * @param role - Exact source table role.
 * @returns Complete measured source identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured target or state table identity.
 *
 * @param role - Exact supporting table role.
 * @returns Complete measured supporting identity.
 */
function createSupportingTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
    true,
  )
}

/**
 * Creates one complete measured table identity.
 *
 * @param role - Logical migration table role.
 * @param key - Exact ordered base-table key.
 * @param deletionProtection - Measured deletion-protection status.
 * @returns Complete immutable table identity.
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
    creationTime: configurationTime,
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? digest('documents-key')
      : null,
    ttl: role === 'collaboration'
      ? { status: 'ENABLED', attribute: 'expiresAt' }
      : role === 'documents'
        ? { status: 'ENABLED', attribute: 'expiresAtEpoch' }
        : { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns the exact source primary-key descriptor.
 *
 * @param role - Exact source table role.
 * @returns Ordered physical key attributes.
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
 * Projects all six exact physical table identifiers.
 *
 * @param configuration - Complete measured configuration.
 * @returns Exact role-indexed table identifiers.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
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
 * Creates the exact caller lease claim for one fixture.
 *
 * @param fixture - Complete rollback fixture.
 * @returns Exact run, owner, and fence claim.
 */
function createLeaseClaim(
  fixture: RollbackOperationFixture,
): {
  /** Exact selected run identifier. */
  readonly runId: string
  /** Exact active owner identifier. */
  readonly ownerId: string
  /** Exact active takeover fence. */
  readonly fenceToken: number
} {
  return {
    runId: fixture.executionRun.runId,
    ownerId,
    fenceToken: 7,
  }
}

/**
 * Creates one strict hidden apply-row projection.
 *
 * @param receipt - Exact forward apply receipt.
 * @returns Correlated sequence and marker projection.
 */
function createApplyProjection(
  receipt: WorkspaceSearchOperationReceipt,
): WorkspaceSearchMigrationApplySequenceReceiptAwsProjection &
  WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection {
  return {
    receipt,
    predecessorRevision: receipt.sequence,
    successorRevision: receipt.sequence + 1,
    successorExecutionStateDigest:
      digest(`apply-successor:${receipt.sequence}`),
    markerDigest: createMigrationDigest(receipt),
  }
}

/**
 * Creates one deterministic verification-state conflict ConditionCheck.
 *
 * @param fixture - Complete exact rollback fixture.
 * @returns Absent deterministic verification-state guard.
 */
function createVerificationConflictCondition(
  fixture: RollbackOperationFixture,
): TransactWriteItem {
  const bindingDigest = createMigrationDigest({
    kind: 'workspace-search-full-verification-run-binding',
    version: 1,
    stateTableId:
      fixture.configuration.tables['migration-state'].tableId,
    configurationHash: fixture.configurationHash,
    runId: fixture.executionRun.runId,
    executionRunDigest: fixture.executionRun.executionRunDigest,
    sealedPlanningAuthorityDigest:
      fixture.sealedPlanningAuthority.authorityDigest,
  })
  return {
    ConditionCheck: {
      TableName:
        fixture.configuration.tables['migration-state'].tableName,
      Key: {
        migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
        recordKey: {
          S: `full-verification-state/v1/${bindingDigest}`,
        },
      },
      ConditionExpression: 'attribute_not_exists(#recordKey)',
      ExpressionAttributeNames: {
        '#recordKey': 'recordKey',
      },
    },
  }
}

/**
 * Reads the exact compound migration-state key from one item.
 *
 * @param item - Complete low-level state item.
 * @returns Exact compound key.
 */
function readMigrationStateItemKey(
  item: Readonly<Record<string, AttributeValue>>,
): Readonly<Record<string, AttributeValue>> {
  const migrationId = item.migrationId
  const recordKey = item.recordKey
  if (migrationId === undefined || recordKey === undefined) {
    throw new Error('Missing migration-state key fields.')
  }
  return cloneAttributeMap({ migrationId, recordKey })
}

/**
 * Creates one stable in-memory table and exact-key locator.
 *
 * @param tableName - Exact physical table name.
 * @param key - Exact low-level primary key.
 * @returns Stable storage locator.
 */
function storageKey(
  tableName: string,
  key: Readonly<Record<string, AttributeValue>>,
): string {
  return `${tableName}\u0000${createAttributeMapDigest(key)}`
}

/**
 * Creates one stable immutable journal version locator.
 *
 * @param reference - Exact rich journal reference.
 * @returns Stable object-version locator.
 */
function journalStorageKey(
  reference: WorkspaceSearchJournalReference,
): string {
  return `${reference.objectKey}\u0000${reference.versionId}`
}

/**
 * Losslessly detaches one low-level attribute map for the harness.
 *
 * @param value - Candidate strict item or key.
 * @returns Detached low-level map.
 */
function cloneAttributeMap(
  value: unknown,
): Readonly<Record<string, AttributeValue>> {
  return decodeAttributeMap(encodeUnknownAttributeMap(value))
}

/**
 * Returns one required array entry.
 *
 * @param values - Candidate readonly array.
 * @param index - Required zero-based position.
 * @returns Exact required value.
 */
function requireArrayEntry<Value>(
  values: readonly Value[],
  index: number,
): Value {
  const value = values[index]
  if (value === undefined) {
    throw new Error('Missing required rollback fixture entry.')
  }
  return value
}

/**
 * Returns one required transaction item.
 *
 * @param item - Candidate fixed-position transaction item.
 * @returns Exact transaction item.
 */
function requireTransactionItem(
  item: TransactWriteItem | undefined,
): TransactWriteItem {
  if (item === undefined) {
    throw new Error('Missing required rollback transaction item.')
  }
  return item
}

/**
 * Reads one transaction's complete fixed item array.
 *
 * @param command - Exact transaction command.
 * @returns Complete fixed-order items.
 */
function requireTransactionItems(
  command: TransactWriteItemsCommand,
): readonly TransactWriteItem[] {
  const items = command.input.TransactItems
  if (items === undefined) {
    throw new Error('Missing rollback transaction items.')
  }
  return items
}

/**
 * Creates one fixed-position conditional cancellation.
 *
 * @param failedIndex - Exact failed fixed position.
 * @param count - Exact transaction item count.
 * @returns Raw DynamoDB cancellation.
 */
function createCancellation(
  failedIndex: number,
  count: number,
): TransactionCanceledException {
  return createCancellationWithCodes(
    Array.from(
      { length: count },
      (_, index) =>
        index === failedIndex
          ? 'ConditionalCheckFailed'
          : 'None',
    ),
  )
}

/**
 * Creates one fixed-position cancellation from explicit reason codes.
 *
 * @param codes - Exact reason code at every transaction position.
 * @returns Raw DynamoDB cancellation.
 */
function createCancellationWithCodes(
  codes: readonly string[],
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'tenant-secret-cancellation',
    CancellationReasons: codes.map((Code) => ({ Code })),
  })
}

/**
 * Captures one expected public migration failure.
 *
 * @param operation - Asynchronous operation expected to fail.
 * @returns Exact stable public migration failure.
 */
async function captureMigrationFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) {
      return error
    }
    throw error
  }
  throw new Error('Expected one rollback migration failure.')
}

/**
 * Computes one stable fixture digest from text.
 *
 * @param value - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Computes one SHA-256 digest from exact UTF-8 text.
 *
 * @param value - Exact text.
 * @returns Lowercase SHA-256 digest.
 */
function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Computes one SHA-256 digest from exact bytes.
 *
 * @param value - Exact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

void decodeWorkspaceSearchJournalRestorationMaterial
