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
  createTeamWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createAttributeMapDigest,
} from './dynamodb-attribute-codec'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  createWorkspaceSearchOperationId,
  MigrationDigestAccumulator,
  type MigrationItemSnapshot,
  type MigrationSourceCheckpoint,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationApplyCheckpointReceipt,
} from './migration-apply-checkpoint-receipt'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createAwsWorkspaceSearchMigrationApplyOperationPort,
  createWorkspaceSearchMigrationApplyPredecessorAwsBinding,
  type WorkspaceSearchMigrationApplyCheckpointScanner,
  type WorkspaceSearchMigrationApplyOperationAuthorityPort,
  type WorkspaceSearchMigrationApplyOperationAwsPort,
  type WorkspaceSearchMigrationApplyOperationAwsTransport,
  type WorkspaceSearchMigrationApplySealCommandInput,
  workspaceSearchMigrationApplyCheckpointTransactionIndex,
  workspaceSearchMigrationApplyOperationTransactionIndex,
  workspaceSearchMigrationApplySealTransactionIndex,
} from './migration-apply-operation-aws'
import {
  createWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRunAdmissionRecord,
} from './migration-execution-run-aws'
import {
  createWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  parseWorkspaceSearchMigrationExecutionState,
} from './migration-execution-state'
import {
  serializeWorkspaceSearchJournalSegment,
} from './migration-journal'
import type {
  WorkspaceSearchMigrationJournalAwsGateway,
} from './migration-journal-aws'
import type {
  WorkspaceSearchMigrationApplySealAwsGateway,
} from './migration-apply-seal-aws'
import {
  createAwsWorkspaceSearchMigrationApplySealGateway,
} from './migration-apply-seal-aws'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
} from './migration-rollback-key'
import type {
  WorkspaceSearchMigrationImmutableArtifactAwsPort,
} from './migration-immutable-artifact-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  createWorkspaceSearchMigrationPlanningProvenanceObjectKey,
} from './migration-planning-provenance-manifest'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createEmptyWorkspaceSearchMigrationTraversal,
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
  type WorkspaceSearchApplyOperationCommandEvent,
  type WorkspaceSearchMigrationCheckpointCommandInput,
  type WorkspaceSearchMigrationCheckpointLocation,
  type WorkspaceSearchMigrationCommandInput,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationAbsentSnapshot,
  createWorkspaceSearchMigrationDocumentSnapshot,
} from './migration-target-snapshot'
import {
  createWorkspaceSearchMigrationCompleteApplySeal,
  parseWorkspaceSearchMigrationAppliedRoot,
  parseWorkspaceSearchMigrationCompleteApplySeal,
  serializeWorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationCompleteApplySeal,
} from './migration-apply-seal'
import {
  createWorkspaceSearchMigrationAppliedRootConditionCheck,
  createWorkspaceSearchMigrationAppliedRootKey,
  createWorkspaceSearchMigrationAppliedRootRecord,
  createWorkspaceSearchMigrationAppliedRootStrongReadCommand,
  createWorkspaceSearchMigrationApplyRunBindingDigest,
  parseWorkspaceSearchMigrationAppliedRootRecord,
  parseWorkspaceSearchMigrationAppliedRootStrongReadOutput,
} from './migration-applied-root-aws'

const runId = 'apply-operation-aws-test'
const ownerId = 'apply-operation-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const openedAt = '2026-07-29T00:30:00.000Z'
const closedAt = '2026-07-29T01:00:00.000Z'
const admittedAt = '2026-07-29T01:16:00.000Z'
const planCreatedAt = '2026-07-29T01:17:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const evaluatedAt = '2026-07-29T01:19:00.000Z'
const createdAt = '2026-07-29T01:19:30.000Z'
const freshRetainUntil = '2026-08-29T00:00:00.000Z'

/**
 * Target transition selected by one compact apply fixture.
 */
type ApplyOperationVariant = 'delete' | 'no-op' | 'put'

/**
 * Complete internally correlated apply-operation fixture.
 */
type ApplyOperationFixture = {
  /** Complete measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Exact closed writer-fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact compact immutable sealed planning root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Fresh authority returned before each transaction. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Single strict planned operation admitted by the fixture. */
  readonly plannedOperation: WorkspaceSearchPlannedOperation
  /** All strict planned operations admitted by the fixture. */
  readonly plannedOperations:
    readonly WorkspaceSearchPlannedOperation[]
}

/**
 * In-memory controller behind plain object-form adapter dependencies.
 */
class ApplyOperationHarness {
  /** Exact static fixture whose table identities route all reads and writes. */
  private readonly fixture: ApplyOperationFixture

  /** Current low-level items indexed by measured table and canonical key. */
  private readonly items =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** Monotonically advancing trusted clock epoch. */
  private nextClockEpoch = Date.parse('2026-07-29T01:19:31.000Z')

  /** Next raw transaction failure, when selected by a test. */
  nextTransactionError: unknown

  /** Whether writes become durable before the selected raw failure. */
  commitBeforeTransactionError = false

  /** Whether the mutation-only sequence row is omitted from fake durability. */
  omitSequenceOnCommit = false

  /** Whether the checkpoint receipt row is omitted from fake durability. */
  omitCheckpointReceiptOnCommit = false

  /** Whether the immutable applied-root row is omitted from fake durability. */
  omitAppliedRootOnCommit = false

  /** Optional valid concurrent applied-root row substituted at commit. */
  appliedRootReplacementOnCommit:
    Readonly<Record<string, AttributeValue>> | undefined

  /** Retention returned by the immutable journal gateway. */
  journalRetainUntil = freshRetainUntil

  /** Optional synchronous effect during the final all-six preparation. */
  prepareEffect: (() => void) | undefined

  /** Whether a competing rollback-start sentinel exists at transaction time. */
  private rollbackStartSentinelExists = false

  /** Optional test-owned implementation behind the checkpoint scanner. */
  checkpointScanImplementation:
    WorkspaceSearchMigrationApplyCheckpointScanner[
      'scanApplyCheckpointPage'
    ] | undefined

  /** Ordered high-level dependency operations. */
  readonly events: string[] = []

  /** Strong read commands observed by the fake transport. */
  readonly reads: GetItemCommand[] = []

  /** Fixed-order transactions observed by the fake transport. */
  readonly transactions: TransactWriteItemsCommand[] = []

  /** Canonical segments uploaded before a mutating transaction. */
  readonly uploadedJournalSegments: WorkspaceSearchJournalSegment[] = []

  /** Canonical complete apply seals uploaded before root publication. */
  readonly uploadedApplySeals:
    WorkspaceSearchMigrationCompleteApplySeal[] = []

  /** Optional exact-object read replacement used by corruption tests. */
  applySealReadReplacement:
    WorkspaceSearchMigrationCompleteApplySeal | undefined

  /** Detached checkpoint scan requests observed by the fake scanner. */
  readonly checkpointScans:
    Parameters<
      WorkspaceSearchMigrationApplyCheckpointScanner[
        'scanApplyCheckpointPage'
      ]
    >[0][] = []

  /** Number of rejected caller accessors invoked. */
  callerAccessorReads = 0

  /** Plain current-authority dependency accepted by the adapter factory. */
  readonly authorityPort:
    WorkspaceSearchMigrationApplyOperationAuthorityPort

  /** Plain immutable journal dependency accepted by the adapter factory. */
  readonly journalGateway: WorkspaceSearchMigrationJournalAwsGateway

  /** Plain immutable complete apply-seal dependency accepted by the factory. */
  readonly applySealGateway:
    WorkspaceSearchMigrationApplySealAwsGateway

  /** Plain one-page checkpoint scanner accepted by the adapter factory. */
  readonly checkpointScanner:
    WorkspaceSearchMigrationApplyCheckpointScanner

  /** Plain DynamoDB dependency accepted by the adapter factory. */
  readonly transport: WorkspaceSearchMigrationApplyOperationAwsTransport

  /** Adapter-owned advancing test clock. */
  readonly clock: () => Date

  /**
   * Creates one fake dependency graph and seeds planned source and target state.
   *
   * @param fixture - Exact static apply binding and operation.
   */
  constructor(fixture: ApplyOperationFixture) {
    this.fixture = fixture
    for (const plannedOperation of fixture.plannedOperations) {
      const operation = plannedOperation.operation
      this.seedSnapshot(
        fixture.configuration.tables[
          operation.sourceCondition.source
        ],
        operation.sourceCondition.key,
        sourceSnapshot(operation),
      )
      this.seedSnapshot(
        fixture.configuration.tables['workspace-search'],
        operation.targetKey,
        operation.before,
      )
    }
    const stateTable =
      fixture.configuration.tables['migration-state']
    const executionRunRecord =
      createWorkspaceSearchMigrationExecutionRunAdmissionRecord({
        stateTable,
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      })
    this.seedItem(
      stateTable,
      extractTableKey(stateTable, executionRunRecord),
      executionRunRecord,
    )
    this.authorityPort = {
      readAuthority: async () => {
        this.events.push('authority')
        return structuredClone(this.fixture.currentAuthority)
      },
    }
    this.journalGateway = {
      writeJournalSegment: async (segment) => {
        this.events.push('journal')
        const detached = structuredClone(segment)
        this.uploadedJournalSegments.push(detached)
        const serialized =
          serializeWorkspaceSearchJournalSegment(detached)
        const contentDigest = createMigrationDigest(detached)
        const versionId =
          `journal-version-${this.uploadedJournalSegments.length}`
        return {
          objectKey:
            `workspace-search/v1/runs/${runId}/apply-journal-segments/${contentDigest}.artifact`,
          versionId,
          contentDigest,
          byteLength: new TextEncoder().encode(serialized).byteLength,
          retainUntil: this.journalRetainUntil,
          headDigest: createJournalHeadDigest({
            previousHeadDigest: detached.previousHeadDigest,
            sequence: detached.sequence,
            operationId: detached.operationId,
            contentDigest,
            versionId,
          }),
        }
      },
      readJournalSegment: async (reference) => {
        const segment = this.uploadedJournalSegments.find(
          (candidate) =>
            createMigrationDigest(candidate) ===
              reference.contentDigest,
        )
        if (segment === undefined) {
          throw new WorkspaceSearchMigrationFailure(
            'INVALID_JOURNAL',
            'Missing test journal segment.',
          )
        }
        return structuredClone(segment)
      },
    }
    this.applySealGateway = {
      writeCompleteApplySeal: async (seal) => {
        this.events.push('apply-seal-write')
        const detached = structuredClone(seal)
        this.uploadedApplySeals.push(detached)
        const bytes =
          serializeWorkspaceSearchMigrationCompleteApplySeal(detached)
        const contentDigest = createMigrationDigest(detached)
        return {
          scope: 'complete-plan',
          objectKey:
            `workspace-search/v1/runs/${runId}/${this.fixture.configurationHash}/apply-seals/${contentDigest}.artifact`,
          versionId:
            `apply-seal-version-${this.uploadedApplySeals.length}`,
          contentDigest,
          byteLength: bytes.byteLength,
          retainUntil: freshRetainUntil,
        }
      },
      readCompleteApplySeal: async (reference) => {
        this.events.push('apply-seal-read')
        if (this.applySealReadReplacement !== undefined) {
          return structuredClone(this.applySealReadReplacement)
        }
        const seal = this.uploadedApplySeals.find(
          (candidate) =>
            createMigrationDigest(candidate) ===
              reference.contentDigest,
        )
        if (seal === undefined) {
          throw new WorkspaceSearchMigrationFailure(
            'INVALID_STATE',
            'Missing test complete apply seal.',
          )
        }
        return structuredClone(seal)
      },
    }
    this.checkpointScanner = {
      scanApplyCheckpointPage: async (input) => {
        this.events.push('checkpoint-scan')
        const detached = structuredClone(input)
        this.checkpointScans.push(detached)
        const implementation = this.checkpointScanImplementation
        return implementation === undefined
          ? createTerminalEmptyCheckpointPage(
              detached.previousCheckpoint,
            )
          : implementation(detached)
      },
    }
    this.transport = {
      getApplyItem: async (command) => this.get(command),
      prepareApplyWrite: async () => {
        this.events.push('prepare')
        this.prepareEffect?.()
      },
      transactWriteApply: async (command) =>
        this.transact(command),
    }
    this.clock = () => {
      const current = this.nextClockEpoch
      this.nextClockEpoch += 1_000
      return new Date(current)
    }
  }

  /**
   * Replaces the current source item with drifted content.
   *
   * @param item - Exact drifted source item.
   */
  replaceSourceItem(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    const operation = this.fixture.plannedOperation.operation
    const table =
      this.fixture.configuration.tables[
        operation.sourceCondition.source
      ]
    this.seedItem(table, operation.sourceCondition.key, item)
  }

  /**
   * Replaces the current target item with drifted content.
   *
   * @param item - Exact drifted target item.
   */
  replaceTargetItem(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    const operation = this.fixture.plannedOperation.operation
    this.seedItem(
      this.fixture.configuration.tables['workspace-search'],
      operation.targetKey,
      item,
    )
  }

  /**
   * Replaces or removes the immutable execution-run admission row.
   *
   * @param item - Complete replacement row, or undefined for absence.
   */
  replaceExecutionRunAdmission(
    item: Readonly<Record<string, AttributeValue>> | undefined,
  ): void {
    const stateTable =
      this.fixture.configuration.tables['migration-state']
    const expected =
      createWorkspaceSearchMigrationExecutionRunAdmissionRecord({
        stateTable,
        configurationHash: this.fixture.configurationHash,
        executionRun: this.fixture.executionRun,
      })
    const key = extractTableKey(stateTable, expected)
    if (item === undefined) {
      this.items.delete(storageKey(stateTable.tableName, key))
      return
    }
    this.seedItem(stateTable, key, item)
  }

  /**
   * Advances the trusted adapter clock without performing dependency I/O.
   *
   * @param milliseconds - Positive test-only clock increment.
   */
  advanceClock(milliseconds: number): void {
    this.nextClockEpoch += milliseconds
  }

  /**
   * Makes the deterministic rollback-start sentinel win later transactions.
   */
  commitRollbackStartSentinel(): void {
    this.rollbackStartSentinelExists = true
  }

  /**
   * Returns whether one record kind is present in the durable fake store.
   *
   * @param kind - Exact adapter-owned record discriminator.
   * @returns Whether a committed item with that kind exists.
   */
  hasDurableRecordKind(kind: string): boolean {
    for (const item of this.items.values()) {
      if (item.kind?.S === kind) return true
    }
    return false
  }

  /**
   * Reads the current target item for the fixture's first operation.
   *
   * @returns Detached exact target item, or undefined when absent.
   */
  readTargetItem():
    Readonly<Record<string, AttributeValue>> | undefined {
    const table =
      this.fixture.configuration.tables['workspace-search']
    const key = this.fixture.plannedOperation.operation.targetKey
    const item = this.items.get(storageKey(table.tableName, key))
    return item === undefined ? undefined : structuredClone(item)
  }

  /**
   * Seeds one complete state-table record from a prior transaction.
   *
   * @param item - Exact durable state-table item.
   */
  seedStateRecord(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    this.seedItem(
      this.fixture.configuration.tables['migration-state'],
      extractTableKey(
        this.fixture.configuration.tables['migration-state'],
        item,
      ),
      item,
    )
  }

  /**
   * Finds the first transaction Put with one exact record kind.
   *
   * @param kind - Exact adapter-owned record kind.
   * @returns Detached durable record or undefined.
   */
  findTransactionRecord(
    kind: string,
  ): Readonly<Record<string, AttributeValue>> | undefined {
    for (const transaction of this.transactions) {
      for (const item of requireTransactionItems(transaction)) {
        const put = item.Put
        if (
          put !== undefined &&
          put.Item !== undefined &&
          put.Item.kind?.S === kind
        ) {
          return structuredClone(put.Item)
        }
      }
    }
    return undefined
  }

  /**
   * Finds the last transaction Put with one exact record kind.
   *
   * @param kind - Exact adapter-owned record kind.
   * @returns Detached latest durable record or undefined.
   */
  findLastTransactionRecord(
    kind: string,
  ): Readonly<Record<string, AttributeValue>> | undefined {
    for (
      let transactionIndex = this.transactions.length - 1;
      transactionIndex >= 0;
      transactionIndex -= 1
    ) {
      const transaction = this.transactions[transactionIndex]
      if (transaction === undefined) continue
      const items = requireTransactionItems(transaction)
      for (
        let itemIndex = items.length - 1;
        itemIndex >= 0;
        itemIndex -= 1
      ) {
        const item = items[itemIndex]
        const put = item?.Put
        if (
          put?.Item !== undefined &&
          put.Item.kind?.S === kind
        ) {
          return structuredClone(put.Item)
        }
      }
    }
    return undefined
  }

  /**
   * Strongly reads one current low-level item.
   *
   * @param command - Adapter-owned strongly consistent GetItem.
   * @returns Current item or absence.
   */
  private async get(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.events.push('read')
    this.reads.push(command)
    const tableName = command.input.TableName
    const key = command.input.Key
    if (tableName === undefined || key === undefined) {
      throw new Error('Expected a complete strong read command.')
    }
    const item = this.items.get(storageKey(tableName, key))
    return item === undefined
      ? { $metadata: {} }
      : { $metadata: {}, Item: structuredClone(item) }
  }

  /**
   * Records, optionally commits, and optionally fails one apply transaction.
   *
   * @param command - Fixed-order adapter transaction.
   * @returns Empty successful DynamoDB response.
   */
  private async transact(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.events.push('transact')
    this.transactions.push(command)
    const items = requireTransactionItems(command)
    const stateTable =
      this.fixture.configuration.tables['migration-state']
    const rollbackStartKey =
      createWorkspaceSearchMigrationRollbackConflictRecordKeys({
        stateTableId: stateTable.tableId,
        configurationHash: this.fixture.configurationHash,
        runId: this.fixture.executionRun.runId,
        executionRunDigest:
          this.fixture.executionRun.executionRunDigest,
      }).start
    const rollbackStartIndex = items.findIndex((item) =>
      item.ConditionCheck?.Key?.recordKey?.S === rollbackStartKey
    )
    if (this.rollbackStartSentinelExists) {
      const condition = items[rollbackStartIndex]?.ConditionCheck
      const names = condition?.ExpressionAttributeNames
      if (
        rollbackStartIndex < 0 ||
        condition === undefined ||
        condition.TableName !== stateTable.tableName ||
        condition.Key?.migrationId?.S !==
          WORKSPACE_SEARCH_MIGRATION_ID ||
        condition.Key?.recordKey?.S !== rollbackStartKey ||
        condition.ConditionExpression !==
          'attribute_not_exists(#migrationId) AND ' +
            'attribute_not_exists(#recordKey)' ||
        names?.['#migrationId'] !== 'migrationId' ||
        names?.['#recordKey'] !== 'recordKey' ||
        Object.keys(names).length !== 2
      ) {
        throw new Error(
          'Expected an exact rollback-start absence condition.',
        )
      }
      throw createConditionalCancellation(
        rollbackStartIndex,
        items.length,
      )
    }
    const error = this.nextTransactionError
    this.nextTransactionError = undefined
    if (error !== undefined && !this.commitBeforeTransactionError) {
      throw error
    }
    this.applyTransaction(command)
    if (error !== undefined) throw error
    return { $metadata: {} }
  }

  /**
   * Applies only transaction writes to the in-memory exact-key store.
   *
   * @param command - Complete fixed-order transaction.
   */
  private applyTransaction(command: TransactWriteItemsCommand): void {
    for (const item of requireTransactionItems(command)) {
      const put = item.Put
      if (
        put !== undefined &&
        put.TableName !== undefined &&
        put.Item !== undefined
      ) {
        const kind = put.Item.kind?.S
        if (
          this.omitSequenceOnCommit &&
          kind === 'workspace-search-migration-apply-journal-sequence'
        ) {
          continue
        }
        if (
          this.omitCheckpointReceiptOnCommit &&
          kind ===
            'workspace-search-migration-apply-checkpoint-receipt'
        ) {
          continue
        }
        if (
          this.omitAppliedRootOnCommit &&
          kind === 'workspace-search-migration-applied-root-record'
        ) {
          continue
        }
        const durableItem =
          kind === 'workspace-search-migration-applied-root-record' &&
            this.appliedRootReplacementOnCommit !== undefined
            ? this.appliedRootReplacementOnCommit
            : put.Item
        const table = findTableByName(
          this.fixture.configuration,
          put.TableName,
        )
        this.seedItem(
          table,
          extractTableKey(table, durableItem),
          durableItem,
        )
      }
      const deletion = item.Delete
      if (
        deletion?.TableName !== undefined &&
        deletion.Key !== undefined
      ) {
        this.items.delete(
          storageKey(deletion.TableName, deletion.Key),
        )
      }
    }
  }

  /**
   * Seeds or removes one exact snapshot.
   *
   * @param table - Exact measured table.
   * @param key - Exact physical key.
   * @param snapshot - Present or absent snapshot.
   */
  private seedSnapshot(
    table: MigrationTableIdentity,
    key: Readonly<Record<string, AttributeValue>>,
    snapshot: MigrationItemSnapshot,
  ): void {
    if (!snapshot.exists) {
      this.items.delete(storageKey(table.tableName, key))
      return
    }
    this.seedItem(table, key, snapshot.item)
  }

  /**
   * Seeds one complete item under one exact measured key.
   *
   * @param table - Exact measured table.
   * @param key - Exact physical key.
   * @param item - Complete exact low-level item.
   */
  private seedItem(
    table: MigrationTableIdentity,
    key: Readonly<Record<string, AttributeValue>>,
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    this.items.set(
      storageKey(table.tableName, key),
      structuredClone(item),
    )
  }
}

describe('Workspace Search migration apply-operation AWS adapter', () => {
  test(
    'uploads journals before fixed thirteen-item Put and Delete transactions and reconciles exact durability',
    async () => {
      const variants: readonly ApplyOperationVariant[] = [
        'put',
        'delete',
      ]
      for (const variant of variants) {
        const fixture = createApplyFixture(variant)
        const harness = new ApplyOperationHarness(fixture)
        const port = createApplyPort(fixture, harness)
        const next = await port.commitApplyOperation(
          createApplyCommand(fixture),
        )

        expect(next).toMatchObject({
          revision: 2,
          appliedOperationCount: 1,
          journalSequence: 1,
          status: 'applying',
        })
        expect(harness.uploadedJournalSegments).toHaveLength(1)
        expect(harness.events.indexOf('journal')).toBeLessThan(
          harness.events.indexOf('prepare'),
        )
        expect(harness.events.indexOf('prepare')).toBeLessThan(
          harness.events.indexOf('transact'),
        )
        const transaction = requireTransaction(
          harness.transactions[0],
        )
        const items = requireTransactionItems(transaction)
        expect(items).toHaveLength(
          workspaceSearchMigrationApplyOperationTransactionIndex
            .mutationCount,
        )
        for (let index = 0; index <= 7; index += 1) {
          expect(items[index]?.ConditionCheck).toBeDefined()
        }
        const rollbackKeys =
          createWorkspaceSearchMigrationRollbackConflictRecordKeys({
            stateTableId:
              fixture.configuration.tables['migration-state'].tableId,
            configurationHash: fixture.configurationHash,
            runId: fixture.executionRun.runId,
            executionRunDigest:
              fixture.executionRun.executionRunDigest,
          })
        expect(
          items[
            workspaceSearchMigrationApplyOperationTransactionIndex
              .rollbackStart
          ]?.ConditionCheck?.Key?.recordKey?.S,
        ).toBe(rollbackKeys.start)
        expect(
          items[
            workspaceSearchMigrationApplyOperationTransactionIndex
              .executionState
          ]?.Put?.Item?.kind?.S,
        ).toBe(
          'workspace-search-migration-execution-state-record',
        )
        expect(
          items[
            workspaceSearchMigrationApplyOperationTransactionIndex
              .executionState
          ]?.Put?.Item?.revision?.N,
        ).toBe('2')
        expect(
          items[
            workspaceSearchMigrationApplyOperationTransactionIndex
              .source
          ]?.ConditionCheck?.TableName,
        ).toBe(
          fixture.configuration.tables['project-directory'].tableName,
        )
        expect(
          items[
            workspaceSearchMigrationApplyOperationTransactionIndex
              .source
          ]?.ConditionCheck?.ConditionExpression,
        )
          .toBeDefined()
        if (variant === 'put') {
          expect(
            items[
              workspaceSearchMigrationApplyOperationTransactionIndex
                .target
            ]?.Put?.TableName,
          ).toBe(
            fixture.configuration.tables['workspace-search'].tableName,
          )
          expect(
            items[
              workspaceSearchMigrationApplyOperationTransactionIndex
                .target
            ]?.Put?.ConditionExpression,
          ).toBeDefined()
          expect(
            items[
              workspaceSearchMigrationApplyOperationTransactionIndex
                .target
            ]?.Delete,
          ).toBeUndefined()
        } else {
          expect(
            items[
              workspaceSearchMigrationApplyOperationTransactionIndex
                .target
            ]?.Delete?.TableName,
          ).toBe(
            fixture.configuration.tables['workspace-search'].tableName,
          )
          expect(
            items[
              workspaceSearchMigrationApplyOperationTransactionIndex
                .target
            ]?.Delete?.ConditionExpression,
          ).toBeDefined()
          expect(
            items[
              workspaceSearchMigrationApplyOperationTransactionIndex
                .target
            ]?.Put,
          ).toBeUndefined()
        }
        expect(
          items[
            workspaceSearchMigrationApplyOperationTransactionIndex
              .operationMarker
          ]?.Put?.Item?.kind?.S,
        ).toBe(
          'workspace-search-migration-apply-operation-marker',
        )
        expect(
          items[
            workspaceSearchMigrationApplyOperationTransactionIndex
              .journalSequence
          ]?.Put?.Item?.kind?.S,
        ).toBe(
          'workspace-search-migration-apply-journal-sequence',
        )
        expect(
          harness.reads.every(
            (command) => command.input.ConsistentRead === true,
          ),
        ).toBe(true)
        expect(await port.readRunState()).toEqual(next)
        expect(
          await port.readOperationMarker(
            fixture.plannedOperation.operation.operationId,
          ),
        ).toMatchObject({
          kind: 'workspace-search-operation-applied',
          sequence: 1,
        })
        expect(await port.readApplyReceipt(1)).toMatchObject({
          kind: 'workspace-search-operation-applied',
          sequence: 1,
        })
      }
    },
  )

  test(
    'commits a true no-op as twelve items with a target check and no journal sequence',
    async () => {
      const fixture = createApplyFixture('no-op')
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      const next = await port.commitApplyOperation(
        createApplyCommand(fixture),
      )
      const items = requireTransactionItems(
        requireTransaction(harness.transactions[0]),
      )

      expect(next.revision).toBe(2)
      expect(next.appliedOperationCount).toBe(1)
      expect(next.journalSequence).toBe(0)
      expect(harness.uploadedJournalSegments).toEqual([])
      expect(items).toHaveLength(
        workspaceSearchMigrationApplyOperationTransactionIndex.noOpCount,
      )
      expect(
        items[
          workspaceSearchMigrationApplyOperationTransactionIndex
            .target
        ]?.ConditionCheck?.TableName,
      ).toBe(
        fixture.configuration.tables['workspace-search'].tableName,
      )
      expect(
        items[
          workspaceSearchMigrationApplyOperationTransactionIndex
            .target
        ]?.Put,
      ).toBeUndefined()
      expect(
        items[
          workspaceSearchMigrationApplyOperationTransactionIndex
            .target
        ]?.Delete,
      ).toBeUndefined()
      expect(
        items[
          workspaceSearchMigrationApplyOperationTransactionIndex
            .operationMarker
        ]?.Put?.Item?.kind?.S,
      ).toBe(
        'workspace-search-migration-apply-operation-marker',
      )
      expect(
        items[
          workspaceSearchMigrationApplyOperationTransactionIndex
            .journalSequence
        ],
      ).toBeUndefined()
      expect(
        await port.readOperationMarker(
          fixture.plannedOperation.operation.operationId,
        ),
      ).toMatchObject({
        kind: 'workspace-search-operation-already-current',
      })
      expect(await port.readApplyReceipt(1)).toBeUndefined()
    },
  )

  test(
    'reconstructs revision two and commits a second mutation with exact predecessor CAS',
    async () => {
      const fixture = createApplyFixture('put', 2)
      const secondPlannedOperation = fixture.plannedOperations[1]
      if (secondPlannedOperation === undefined) {
        throw new Error('Expected a second planned operation.')
      }
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)

      const revisionTwo = await port.commitApplyOperation(
        createApplyCommand(fixture),
      )
      expect(revisionTwo).toMatchObject({
        revision: 2,
        appliedOperationCount: 1,
        journalSequence: 1,
      })
      const firstItems = requireTransactionItems(
        requireTransaction(harness.transactions[0]),
      )
      expect(firstItems).toHaveLength(
        workspaceSearchMigrationApplyOperationTransactionIndex
          .mutationCount,
      )
      const firstStatePut = firstItems[
        workspaceSearchMigrationApplyOperationTransactionIndex
          .executionState
      ]?.Put
      if (firstStatePut?.Item === undefined) {
        throw new Error('Expected the revision-two state Put.')
      }
      expect(firstStatePut.Item.revision?.N).toBe('2')

      const readStart = harness.reads.length
      const reconstructedRevisionTwo = await port.readRunState()
      expect(reconstructedRevisionTwo).toEqual(revisionTwo)
      const reconstructionReads = harness.reads.slice(readStart)
      expect(reconstructionReads).toHaveLength(3)
      expect(
        reconstructionReads.every(
          (command) => command.input.ConsistentRead === true,
        ),
      ).toBe(true)

      const revisionThree = await port.commitApplyOperation(
        createApplyCommand(
          fixture,
          1,
          2,
        ),
      )
      expect(revisionThree).toMatchObject({
        revision: 3,
        appliedOperationCount: 2,
        journalSequence: 2,
      })
      expect(harness.transactions).toHaveLength(2)
      expect(harness.uploadedJournalSegments).toHaveLength(2)
      expect(harness.uploadedJournalSegments[1]).toMatchObject({
        sequence: 2,
        operationId:
          secondPlannedOperation.operation.operationId,
      })

      const secondItems = requireTransactionItems(
        requireTransaction(harness.transactions[1]),
      )
      expect(secondItems).toHaveLength(
        workspaceSearchMigrationApplyOperationTransactionIndex
          .mutationCount,
      )
      const secondStatePut = secondItems[
        workspaceSearchMigrationApplyOperationTransactionIndex
          .executionState
      ]?.Put
      if (
        secondStatePut?.Item === undefined ||
        secondStatePut.ConditionExpression === undefined ||
        secondStatePut.ExpressionAttributeNames === undefined ||
        secondStatePut.ExpressionAttributeValues === undefined
      ) {
        throw new Error(
          'Expected a complete revision-three state Put and predecessor CAS.',
        )
      }
      expect(secondStatePut.Item.revision?.N).toBe('3')
      const predecessorNames =
        secondStatePut.ExpressionAttributeNames
      const predecessorValues =
        secondStatePut.ExpressionAttributeValues
      expect(
        Object.values(predecessorNames).sort(),
      ).toEqual(Object.keys(firstStatePut.Item).sort())
      expect(Object.keys(predecessorValues)).toHaveLength(
        Object.keys(firstStatePut.Item).length,
      )
      for (
        const [nameToken, attributeName] of
        Object.entries(predecessorNames)
      ) {
        const tokenIndex = nameToken.slice(2)
        const valueToken = `:v${tokenIndex}`
        expect(predecessorValues[valueToken]).toEqual(
          firstStatePut.Item[attributeName],
        )
        expect(secondStatePut.ConditionExpression).toContain(
          `${nameToken} = ${valueToken}`,
        )
      }
      expect(
        secondItems[
          workspaceSearchMigrationApplyOperationTransactionIndex
            .journalSequence
        ]?.Put?.Item?.sequence?.N,
      ).toBe('2')

      const firstReceipt = await port.readApplyReceipt(1)
      const secondReceipt = await port.readApplyReceipt(2)
      expect(firstReceipt).toMatchObject({
        sequence: 1,
        operationId:
          fixture.plannedOperation.operation.operationId,
      })
      expect(secondReceipt).toMatchObject({
        sequence: 2,
        operationId:
          secondPlannedOperation.operation.operationId,
      })
    },
  )

  test(
    'adopts an exact committed marker, state, sequence, and target after response loss',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      harness.nextTransactionError =
        new Error('tenant-secret-response-loss')
      harness.commitBeforeTransactionError = true
      const port = createApplyPort(fixture, harness)

      const next = await port.commitApplyOperation(
        createApplyCommand(fixture),
      )
      expect(next).toMatchObject({
        revision: 2,
        appliedOperationCount: 1,
        journalSequence: 1,
      })
      expect(harness.transactions).toHaveLength(1)
      expect(await port.readApplyReceipt(1)).toMatchObject({
        operationId: fixture.plannedOperation.operation.operationId,
      })
    },
  )

  test(
    'adopts an exact no-op marker and state after response loss without a journal sequence',
    async () => {
      const fixture = createApplyFixture('no-op')
      const harness = new ApplyOperationHarness(fixture)
      harness.nextTransactionError =
        new Error('tenant-secret-no-op-response-loss')
      harness.commitBeforeTransactionError = true
      const port = createApplyPort(fixture, harness)

      const next = await port.commitApplyOperation(
        createApplyCommand(fixture),
      )

      expect(next).toMatchObject({
        revision: 2,
        appliedOperationCount: 1,
        journalSequence: 0,
      })
      expect(harness.transactions).toHaveLength(1)
      expect(harness.uploadedJournalSegments).toEqual([])
      expect(
        await port.readOperationMarker(
          fixture.plannedOperation.operation.operationId,
        ),
      ).toMatchObject({
        kind: 'workspace-search-operation-already-current',
      })
      expect(await port.readApplyReceipt(1)).toBeUndefined()
    },
  )

  test(
    'maps every fixed conditional cancellation position',
    async () => {
      const cases: readonly {
        /** Fixed transaction index selected by the test. */
        readonly index: number
        /** Stable expected public failure code. */
        readonly code: WorkspaceSearchMigrationFailureCode
      }[] = [
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex.lease,
          code: 'LEASE_LOST',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex.pointer,
          code: 'INVALID_MAINTENANCE_EVIDENCE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex.receipt,
          code: 'INVALID_MAINTENANCE_EVIDENCE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex
              .writerFence,
          code: 'INVALID_STATE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex
              .executionBoundary,
          code: 'INVALID_STATE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex
              .sealedPlanningAuthority,
          code: 'INVALID_STATE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex
              .executionRun,
          code: 'INVALID_STATE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex
              .rollbackStart,
          code: 'INVALID_STATE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex.source,
          code: 'SOURCE_DRIFT',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex.target,
          code: 'TARGET_DRIFT',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex
              .executionState,
          code: 'INVALID_STATE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex
              .operationMarker,
          code: 'INVALID_STATE',
        },
        {
          index:
            workspaceSearchMigrationApplyOperationTransactionIndex
              .journalSequence,
          code: 'INVALID_STATE',
        },
      ]
      expect(cases).toHaveLength(
        workspaceSearchMigrationApplyOperationTransactionIndex
          .mutationCount,
      )
      for (const entry of cases) {
        const fixture = createApplyFixture('put')
        const harness = new ApplyOperationHarness(fixture)
        harness.nextTransactionError =
          createCancellation(entry.index)
        const port = createApplyPort(fixture, harness)
        const failure = await captureMigrationFailure(() =>
          port.commitApplyOperation(createApplyCommand(fixture))
        )
        expect(failure.code).toBe(entry.code)
      }
    },
  )

  test(
    'stops mutating and no-op apply writes after rollback start wins the transaction race',
    async () => {
      const variants: readonly ApplyOperationVariant[] = [
        'put',
        'no-op',
      ]
      for (const variant of variants) {
        const fixture = createApplyFixture(variant)
        const harness = new ApplyOperationHarness(fixture)
        const port = createApplyPort(fixture, harness)
        const targetBefore = harness.readTargetItem()
        harness.commitRollbackStartSentinel()

        const firstFailure = await captureMigrationFailure(() =>
          port.commitApplyOperation(createApplyCommand(fixture))
        )
        const retryFailure = await captureMigrationFailure(() =>
          port.commitApplyOperation(createApplyCommand(fixture))
        )

        expect(firstFailure.code).toBe('INVALID_STATE')
        expect(retryFailure.code).toBe('INVALID_STATE')
        expect(await port.readRunState()).toMatchObject({
          revision: 1,
          status: 'applying',
          appliedOperationCount: 0,
        })
        expect(harness.readTargetItem()).toEqual(targetBefore)
        expect(
          harness.hasDurableRecordKind(
            'workspace-search-migration-execution-state-record',
          ),
        ).toBe(false)
        expect(
          harness.hasDurableRecordKind(
            'workspace-search-migration-apply-operation-marker',
          ),
        ).toBe(false)
        expect(
          harness.hasDurableRecordKind(
            'workspace-search-migration-apply-journal-sequence',
          ),
        ).toBe(false)
        expect(harness.uploadedJournalSegments).toHaveLength(
          variant === 'no-op' ? 0 : 2,
        )
      }
    },
  )

  test(
    'stops checkpoint and complete-seal publication after rollback start wins',
    async () => {
      const checkpointFixture = createApplyFixture('put')
      const checkpointHarness =
        new ApplyOperationHarness(checkpointFixture)
      const checkpointPort = createApplyPort(
        checkpointFixture,
        checkpointHarness,
      )
      const operationState =
        await checkpointPort.commitApplyOperation(
          createApplyCommand(checkpointFixture),
        )
      checkpointHarness.commitRollbackStartSentinel()

      const checkpointFailure = await captureMigrationFailure(() =>
        checkpointPort.saveApplyCheckpoint(
          createCheckpointCommand(
            checkpointFixture,
            'project-directory',
            operationState.revision,
          ),
        )
      )
      const checkpointRetry = await captureMigrationFailure(() =>
        checkpointPort.saveApplyCheckpoint(
          createCheckpointCommand(
            checkpointFixture,
            'project-directory',
            operationState.revision,
          ),
        )
      )

      expect(checkpointFailure.code).toBe('INVALID_STATE')
      expect(checkpointRetry.code).toBe('INVALID_STATE')
      expect(await checkpointPort.readRunState()).toEqual(
        operationState,
      )
      expect(
        checkpointHarness.hasDurableRecordKind(
          'workspace-search-migration-apply-checkpoint-receipt',
        ),
      ).toBe(false)

      const sealFixture = createApplyFixture('put', 0)
      const sealHarness = new ApplyOperationHarness(sealFixture)
      const sealPort = createApplyPort(sealFixture, sealHarness)
      const terminal = await completeApplyCheckpoints(
        sealFixture,
        sealPort,
        1,
      )
      sealHarness.commitRollbackStartSentinel()

      const sealFailure = await captureMigrationFailure(() =>
        sealPort.sealApply(
          createApplySealCommand(
            sealFixture,
            terminal.revision,
          ),
        )
      )
      const sealRetry = await captureMigrationFailure(() =>
        sealPort.sealApply(
          createApplySealCommand(
            sealFixture,
            terminal.revision,
          ),
        )
      )

      expect(sealFailure.code).toBe('INVALID_STATE')
      expect(sealRetry.code).toBe('INVALID_STATE')
      expect(await sealPort.readRunState()).toEqual(terminal)
      expect(
        sealHarness.hasDurableRecordKind(
          'workspace-search-migration-applied-root-record',
        ),
      ).toBe(false)
      expect(sealHarness.uploadedApplySeals).toHaveLength(2)
    },
    15_000,
  )

  test(
    'rejects source and target drift before journal upload or transaction send',
    async () => {
      const sourceFixture = createApplyFixture('put')
      const sourceHarness = new ApplyOperationHarness(sourceFixture)
      const source = sourceFixture.plannedOperation.operation
        .sourceCondition
      if (!source.exists) {
        throw new Error('Expected a present source fixture.')
      }
      sourceHarness.replaceSourceItem({
        ...source.item,
        nameEn: { S: 'drifted-source' },
      })
      const sourceFailure = await captureMigrationFailure(() =>
        createApplyPort(sourceFixture, sourceHarness)
          .commitApplyOperation(createApplyCommand(sourceFixture))
      )
      expect(sourceFailure.code).toBe('SOURCE_DRIFT')
      expect(sourceHarness.uploadedJournalSegments).toEqual([])
      expect(sourceHarness.transactions).toEqual([])

      const targetFixture = createApplyFixture('put')
      const targetHarness = new ApplyOperationHarness(targetFixture)
      const before = targetFixture.plannedOperation.operation.before
      if (!before.exists) {
        throw new Error('Expected a present target fixture.')
      }
      targetHarness.replaceTargetItem({
        ...before.item,
        title: { S: 'drifted-target' },
      })
      const targetFailure = await captureMigrationFailure(() =>
        createApplyPort(targetFixture, targetHarness)
          .commitApplyOperation(createApplyCommand(targetFixture))
      )
      expect(targetFailure.code).toBe('TARGET_DRIFT')
      expect(targetHarness.uploadedJournalSegments).toEqual([])
      expect(targetHarness.transactions).toEqual([])
    },
  )

  test(
    'rejects caller journal evidence, proxies, and accessors before dependency I/O',
    async () => {
      const fixture = createApplyFixture('put')
      const commands:
        WorkspaceSearchMigrationCommandInput<
          WorkspaceSearchApplyOperationCommandEvent
        >[] = []
      const withJournal = createApplyCommand(fixture)
      withJournal.event.journal = undefined
      commands.push(withJournal)
      commands.push(new Proxy(createApplyCommand(fixture), {}))
      const proxiedPlan = createApplyCommand(fixture)
      proxiedPlan.event.plannedOperation =
        new Proxy(proxiedPlan.event.plannedOperation, {})
      commands.push(proxiedPlan)

      for (const command of commands) {
        const harness = new ApplyOperationHarness(fixture)
        const failure = await captureMigrationFailure(() =>
          createApplyPort(fixture, harness)
            .commitApplyOperation(command)
        )
        expect(failure.code).toBe('INVALID_ARGUMENT')
        expect(harness.events).toEqual([])
      }

      const accessorHarness = new ApplyOperationHarness(fixture)
      const accessorCommand = createApplyCommand(fixture)
      Object.defineProperty(accessorCommand, 'expectedRevision', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessorHarness.callerAccessorReads += 1
          return 1
        },
      })
      const accessorFailure = await captureMigrationFailure(() =>
        createApplyPort(fixture, accessorHarness)
          .commitApplyOperation(accessorCommand)
      )
      expect(accessorFailure.code).toBe('INVALID_ARGUMENT')
      expect(accessorHarness.callerAccessorReads).toBe(0)
      expect(accessorHarness.events).toEqual([])
    },
  )

  test(
    'fails closed for stale revision, foreign marker, missing sequence, and insufficient retention',
    async () => {
      const staleFixture = createApplyFixture('put')
      const staleHarness = new ApplyOperationHarness(staleFixture)
      const staleCommand = createApplyCommand(staleFixture)
      staleCommand.expectedRevision = 2
      const staleFailure = await captureMigrationFailure(() =>
        createApplyPort(staleFixture, staleHarness)
          .commitApplyOperation(staleCommand)
      )
      expect(staleFailure.code).toBe('INVALID_STATE')
      expect(staleHarness.transactions).toEqual([])

      const committedFixture = createApplyFixture('put')
      const committedHarness =
        new ApplyOperationHarness(committedFixture)
      await createApplyPort(committedFixture, committedHarness)
        .commitApplyOperation(createApplyCommand(committedFixture))
      const marker = committedHarness.findTransactionRecord(
        'workspace-search-migration-apply-operation-marker',
      )
      if (marker === undefined) {
        throw new Error('Expected one durable marker fixture.')
      }
      const foreignMarker = {
        ...marker,
        predecessorRevision: { N: '2' },
        successorRevision: { N: '3' },
      }
      const foreignFixture = createApplyFixture('put')
      const foreignHarness = new ApplyOperationHarness(foreignFixture)
      foreignHarness.seedStateRecord(foreignMarker)
      const foreignFailure = await captureMigrationFailure(() =>
        createApplyPort(foreignFixture, foreignHarness)
          .commitApplyOperation(createApplyCommand(foreignFixture))
      )
      expect(foreignFailure.code).toBe('INVALID_STATE')
      expect(foreignHarness.transactions).toEqual([])

      const sequenceFixture = createApplyFixture('put')
      const sequenceHarness = new ApplyOperationHarness(sequenceFixture)
      sequenceHarness.omitSequenceOnCommit = true
      const sequenceFailure = await captureMigrationFailure(() =>
        createApplyPort(sequenceFixture, sequenceHarness)
          .commitApplyOperation(createApplyCommand(sequenceFixture))
      )
      expect(sequenceFailure.code).toBe('INVALID_STATE')

      const retentionFixture = createApplyFixture('put')
      const retentionHarness =
        new ApplyOperationHarness(retentionFixture)
      retentionHarness.journalRetainUntil =
        '2026-08-28T01:19:33.000Z'
      const retentionFailure = await captureMigrationFailure(() =>
        createApplyPort(retentionFixture, retentionHarness)
          .commitApplyOperation(createApplyCommand(retentionFixture))
      )
      expect(retentionFailure.code).toBe('INVALID_JOURNAL')
      expect(retentionHarness.uploadedJournalSegments).toHaveLength(1)
      expect(retentionHarness.transactions).toEqual([])
    },
  )

  test(
    'rechecks authority time after all-six preparation before constructing the transaction',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      harness.prepareEffect = () => {
        harness.advanceClock(2 * 60 * 1_000)
      }

      const failure = await captureMigrationFailure(() =>
        createApplyPort(fixture, harness)
          .commitApplyOperation(createApplyCommand(fixture))
      )

      expect(failure.code).toBe('LEASE_LOST')
      expect(harness.events).toContain('prepare')
      expect(harness.transactions).toEqual([])
    },
  )

  test(
    'requires an exact immutable execution admission on every effective-state read',
    async () => {
      const missingFixture = createApplyFixture('put')
      const missingHarness =
        new ApplyOperationHarness(missingFixture)
      missingHarness.replaceExecutionRunAdmission(undefined)

      const missingFailure = await captureMigrationFailure(() =>
        createApplyPort(missingFixture, missingHarness)
          .readRunState()
      )
      expect(missingFailure.code).toBe('INVALID_STATE')

      const tamperedFixture = createApplyFixture('put')
      const tamperedHarness =
        new ApplyOperationHarness(tamperedFixture)
      const stateTable =
        tamperedFixture.configuration.tables['migration-state']
      const admission =
        createWorkspaceSearchMigrationExecutionRunAdmissionRecord({
          stateTable,
          configurationHash: tamperedFixture.configurationHash,
          executionRun: tamperedFixture.executionRun,
        })
      tamperedHarness.replaceExecutionRunAdmission({
        ...admission,
        unexpected: { S: 'redigested-foreign-field' },
      })

      const tamperedFailure = await captureMigrationFailure(() =>
        createApplyPort(tamperedFixture, tamperedHarness)
          .commitApplyOperation(createApplyCommand(tamperedFixture))
      )
      expect(tamperedFailure.code).toBe('INVALID_STATE')
      expect(tamperedHarness.transactions).toEqual([])
    },
  )

  test(
    'persists a source checkpoint as fixed ten-item receipt and v2 state after every operation is durable',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      await port.commitApplyOperation(createApplyCommand(fixture))
      const checkpointEventStart = harness.events.length

      const next = await port.saveApplyCheckpoint(
        createCheckpointCommand(fixture, 'project-directory', 2),
      )

      expect(next).toMatchObject({
        revision: 3,
        appliedOperationCount: 1,
        status: 'applying',
      })
      expect(
        next.apply.sources['project-directory'],
      ).toMatchObject({
        completed: true,
        aggregate: {
          scanned: 0,
          pageCount: 1,
        },
      })
      expect(harness.checkpointScans).toEqual([
        {
          location: 'project-directory',
          previousCheckpoint:
            fixture.executionRun.runState.apply.sources[
              'project-directory'
            ],
        },
      ])
      const transaction = requireTransaction(
        harness.transactions[1],
      )
      const items = requireTransactionItems(transaction)
      expect(items).toHaveLength(
        workspaceSearchMigrationApplyCheckpointTransactionIndex.count,
      )
      for (let index = 0; index <= 7; index += 1) {
        expect(items[index]?.ConditionCheck).toBeDefined()
      }
      const statePut = items[
        workspaceSearchMigrationApplyCheckpointTransactionIndex
          .executionState
      ]?.Put
      const receiptPut = items[
        workspaceSearchMigrationApplyCheckpointTransactionIndex
          .checkpointReceipt
      ]?.Put
      if (
        statePut?.Item === undefined ||
        receiptPut?.Item === undefined
      ) {
        throw new Error(
          'Expected fixed-position checkpoint state and receipt Puts.',
        )
      }
      expect(statePut.Item).toMatchObject({
        kind: {
          S: 'workspace-search-migration-execution-state-record',
        },
        revision: { N: '3' },
      })
      expect(statePut.ConditionExpression).toBeDefined()
      const state = parseWorkspaceSearchMigrationExecutionState(
        requireBinaryAttribute(statePut.Item, 'executionStateBytes'),
      )
      if (state.executionStateVersion !== 2) {
        throw new Error('Expected traversal-capable execution state.')
      }
      expect(state.apply).toEqual(next.apply)
      expect(receiptPut.Item).toMatchObject({
        kind: {
          S: 'workspace-search-migration-apply-checkpoint-receipt',
        },
        location: { S: 'project-directory' },
        predecessorRevision: { N: '2' },
        successorRevision: { N: '3' },
      })
      expect(receiptPut.ConditionExpression).toContain(
        'attribute_not_exists',
      )
      const receipt =
        parseWorkspaceSearchMigrationApplyCheckpointReceipt(
          requireBinaryAttribute(receiptPut.Item, 'receiptBytes'),
        )
      expect(receipt).toMatchObject({
        location: 'project-directory',
        predecessorKind: 'mutable-execution-state',
        predecessorRevision: 2,
        successorRevision: 3,
      })
      expect(receipt.successorExecutionStateDigest).toBe(
        state.executionStateDigest,
      )
      expect(receipt.successorRunStateDigest).toBe(
        state.runStateDigest,
      )
      const checkpointEvents = harness.events.slice(
        checkpointEventStart,
      )
      expect(
        checkpointEvents.indexOf('checkpoint-scan'),
      ).toBeLessThan(checkpointEvents.indexOf('prepare'))
      expect(
        checkpointEvents.indexOf('prepare'),
      ).toBeLessThan(checkpointEvents.indexOf('transact'))
    },
  )

  test(
    'advances a zero-operation admission directly into v2 checkpoint state',
    async () => {
      const fixture = createApplyFixture('put', 0)
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)

      const next = await port.saveApplyCheckpoint(
        createCheckpointCommand(fixture, 'work-items', 1),
      )

      expect(next).toMatchObject({
        revision: 2,
        planOperationCount: 0,
        appliedOperationCount: 0,
        status: 'applying',
      })
      expect(harness.transactions).toHaveLength(1)
      expect(harness.uploadedJournalSegments).toEqual([])
      const items = requireTransactionItems(
        requireTransaction(harness.transactions[0]),
      )
      expect(items).toHaveLength(
        workspaceSearchMigrationApplyCheckpointTransactionIndex.count,
      )
      const statePut = items[
        workspaceSearchMigrationApplyCheckpointTransactionIndex
          .executionState
      ]?.Put
      const receiptPut = items[
        workspaceSearchMigrationApplyCheckpointTransactionIndex
          .checkpointReceipt
      ]?.Put
      if (
        statePut?.Item === undefined ||
        receiptPut?.Item === undefined
      ) {
        throw new Error('Expected zero-plan checkpoint transaction Puts.')
      }
      expect(statePut.ConditionExpression).toContain(
        'attribute_not_exists',
      )
      const state = parseWorkspaceSearchMigrationExecutionState(
        requireBinaryAttribute(statePut.Item, 'executionStateBytes'),
      )
      expect(state.executionStateVersion).toBe(2)
      const receipt =
        parseWorkspaceSearchMigrationApplyCheckpointReceipt(
          requireBinaryAttribute(receiptPut.Item, 'receiptBytes'),
        )
      expect(receipt).toMatchObject({
        location: 'work-items',
        predecessorKind: 'execution-run-admission',
        predecessorRevision: 1,
        predecessorExecutionStateDigest:
          fixture.executionRun.executionRunDigest,
        successorRevision: 2,
      })
    },
  )

  test(
    'continues v2 progress across locations and multiple pages',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      await port.commitApplyOperation(createApplyCommand(fixture))
      harness.checkpointScanImplementation = async ({
        location,
        previousCheckpoint,
      }) => createCheckpointPage(
        previousCheckpoint,
        location,
        previousCheckpoint.aggregate.pageCount + 1,
        location === 'target' &&
          previousCheckpoint.aggregate.pageCount === 1,
      )

      const documents = await port.saveApplyCheckpoint(
        createCheckpointCommand(fixture, 'documents', 2),
      )
      const firstTarget = await port.saveApplyCheckpoint(
        createCheckpointCommand(fixture, 'target', 3),
      )
      const terminalTarget = await port.saveApplyCheckpoint(
        createCheckpointCommand(fixture, 'target', 4),
      )

      expect(documents).toMatchObject({
        revision: 3,
        apply: {
          sources: {
            documents: {
              completed: false,
              aggregate: { scanned: 1, pageCount: 1 },
            },
          },
        },
      })
      expect(firstTarget).toMatchObject({
        revision: 4,
        apply: {
          target: {
            completed: false,
            aggregate: { scanned: 1, pageCount: 1 },
          },
        },
      })
      expect(terminalTarget).toMatchObject({
        revision: 5,
        apply: {
          sources: {
            documents: {
              completed: false,
              aggregate: { scanned: 1, pageCount: 1 },
            },
          },
          target: {
            completed: true,
            aggregate: { scanned: 2, pageCount: 2 },
          },
        },
      })
      expect(
        harness.checkpointScans.map((scan) => scan.location),
      ).toEqual(['documents', 'target', 'target'])
      expect(harness.checkpointScans[2]?.previousCheckpoint).toEqual(
        firstTarget.apply.target,
      )
      for (const transaction of harness.transactions.slice(1)) {
        const stateItem = requireTransactionItems(transaction)[
          workspaceSearchMigrationApplyCheckpointTransactionIndex
            .executionState
        ]?.Put?.Item
        if (stateItem === undefined) {
          throw new Error('Expected one v2 checkpoint state Put.')
        }
        expect(
          parseWorkspaceSearchMigrationExecutionState(
            requireBinaryAttribute(
              stateItem,
              'executionStateBytes',
            ),
          ).executionStateVersion,
        ).toBe(2)
      }
    },
  )

  test(
    'returns an already-terminal checkpoint without another scan or transaction',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      await port.commitApplyOperation(createApplyCommand(fixture))
      const terminal = await port.saveApplyCheckpoint(
        createCheckpointCommand(fixture, 'collaboration', 2),
      )
      const scanCount = harness.checkpointScans.length
      const transactionCount = harness.transactions.length

      const unchanged = await port.saveApplyCheckpoint(
        createCheckpointCommand(fixture, 'collaboration', 3),
      )

      expect(unchanged).toEqual(terminal)
      expect(harness.checkpointScans).toHaveLength(scanCount)
      expect(harness.transactions).toHaveLength(transactionCount)
    },
  )

  test(
    'rejects checkpoint progress until every planned operation is durable',
    async () => {
      const fixture = createApplyFixture('put', 2)
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      await port.commitApplyOperation(createApplyCommand(fixture))

      const failure = await captureMigrationFailure(() =>
        port.saveApplyCheckpoint(
          createCheckpointCommand(fixture, 'documents', 2),
        )
      )

      expect(failure.code).toBe('INVALID_STATE')
      expect(harness.checkpointScans).toEqual([])
      expect(harness.transactions).toHaveLength(1)
    },
  )

  test(
    'reconciles an exact checkpoint receipt after response loss and a process retry',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      const firstPort = createApplyPort(fixture, harness)
      await firstPort.commitApplyOperation(
        createApplyCommand(fixture),
      )
      harness.nextTransactionError =
        new Error('tenant-secret-checkpoint-response-loss')
      harness.commitBeforeTransactionError = true
      const command = createCheckpointCommand(
        fixture,
        'project-directory',
        2,
      )

      const reconciled = await firstPort.saveApplyCheckpoint(command)

      expect(reconciled).toMatchObject({ revision: 3 })
      expect(harness.transactions).toHaveLength(2)
      expect(harness.checkpointScans).toHaveLength(1)
      const receiptRecord = harness.findLastTransactionRecord(
        'workspace-search-migration-apply-checkpoint-receipt',
      )
      if (receiptRecord === undefined) {
        throw new Error('Expected one durable checkpoint receipt.')
      }
      const receipt =
        parseWorkspaceSearchMigrationApplyCheckpointReceipt(
          requireBinaryAttribute(receiptRecord, 'receiptBytes'),
        )
      expect(receipt).toMatchObject({
        location: 'project-directory',
        predecessorRevision: 2,
        successorRevision: 3,
      })

      const restartedPort = createApplyPort(fixture, harness)
      const retried = await restartedPort.saveApplyCheckpoint(
        structuredClone(command),
      )

      expect(retried).toEqual(reconciled)
      expect(harness.transactions).toHaveLength(2)
      expect(harness.checkpointScans).toHaveLength(1)
    },
  )

  test(
    'reconciles an old checkpoint receipt against a later v2 state without another write',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      await port.commitApplyOperation(createApplyCommand(fixture))
      const oldCommand = createCheckpointCommand(
        fixture,
        'project-directory',
        2,
      )
      const committed = await port.saveApplyCheckpoint(oldCommand)
      expect(committed.revision).toBe(3)
      const later = await port.saveApplyCheckpoint(
        createCheckpointCommand(fixture, 'documents', 3),
      )
      expect(later.revision).toBe(4)
      const scanCount = harness.checkpointScans.length
      const transactionCount = harness.transactions.length

      const reconciled = await port.saveApplyCheckpoint(
        structuredClone(oldCommand),
      )

      expect(reconciled).toEqual(later)
      expect(harness.checkpointScans).toHaveLength(scanCount)
      expect(harness.transactions).toHaveLength(transactionCount)
    },
  )

  test(
    'fails closed for stale and concurrently superseded checkpoint state',
    async () => {
      const staleFixture = createApplyFixture('put')
      const staleHarness = new ApplyOperationHarness(staleFixture)
      const stalePort = createApplyPort(staleFixture, staleHarness)
      await stalePort.commitApplyOperation(
        createApplyCommand(staleFixture),
      )
      const staleFailure = await captureMigrationFailure(() =>
        stalePort.saveApplyCheckpoint(
          createCheckpointCommand(
            staleFixture,
            'project-directory',
            1,
          ),
        )
      )
      expect(staleFailure.code).toBe('INVALID_STATE')
      expect(staleHarness.checkpointScans).toEqual([])
      expect(staleHarness.transactions).toHaveLength(1)

      const concurrentFixture = createApplyFixture('put')
      const concurrentHarness =
        new ApplyOperationHarness(concurrentFixture)
      const concurrentPort = createApplyPort(
        concurrentFixture,
        concurrentHarness,
      )
      await concurrentPort.commitApplyOperation(
        createApplyCommand(concurrentFixture),
      )
      let nested = false
      concurrentHarness.checkpointScanImplementation = async (
        input,
      ) => {
        if (!nested) {
          nested = true
          const nestedState =
            await concurrentPort.saveApplyCheckpoint(
              createCheckpointCommand(
                concurrentFixture,
                'target',
                2,
              ),
            )
          expect(nestedState.revision).toBe(3)
          return createCheckpointPage(
            input.previousCheckpoint,
            input.location,
            1,
            true,
          )
        }
        return createTerminalEmptyCheckpointPage(
          input.previousCheckpoint,
        )
      }

      const concurrentFailure = await captureMigrationFailure(() =>
        concurrentPort.saveApplyCheckpoint(
          createCheckpointCommand(
            concurrentFixture,
            'documents',
            2,
          ),
        )
      )

      expect(concurrentFailure.code).toBe('INVALID_STATE')
      expect(
        concurrentHarness.checkpointScans.map(
          (scan) => scan.location,
        ),
      ).toEqual(['documents', 'target'])
      expect(concurrentHarness.transactions).toHaveLength(2)
      expect(await concurrentPort.readRunState()).toMatchObject({
        revision: 3,
        apply: { target: { completed: true } },
      })
    },
  )

  test(
    'rejects corrupt and absent checkpoint receipts after apparent durability',
    async () => {
      const corruptFixture = createApplyFixture('put')
      const corruptHarness =
        new ApplyOperationHarness(corruptFixture)
      const corruptPort = createApplyPort(
        corruptFixture,
        corruptHarness,
      )
      await corruptPort.commitApplyOperation(
        createApplyCommand(corruptFixture),
      )
      const command = createCheckpointCommand(
        corruptFixture,
        'documents',
        2,
      )
      await corruptPort.saveApplyCheckpoint(command)
      const receiptRecord = corruptHarness.findLastTransactionRecord(
        'workspace-search-migration-apply-checkpoint-receipt',
      )
      if (receiptRecord === undefined) {
        throw new Error('Expected one checkpoint receipt to corrupt.')
      }
      corruptHarness.seedStateRecord({
        ...receiptRecord,
        receiptDigest: { S: digest('corrupt-checkpoint-receipt') },
      })
      const transactionCount = corruptHarness.transactions.length

      const corruptFailure = await captureMigrationFailure(() =>
        corruptPort.saveApplyCheckpoint(structuredClone(command))
      )

      expect(corruptFailure.code).toBe('INVALID_STATE')
      expect(corruptHarness.transactions).toHaveLength(
        transactionCount,
      )

      const absentFixture = createApplyFixture('put')
      const absentHarness = new ApplyOperationHarness(absentFixture)
      const absentPort = createApplyPort(absentFixture, absentHarness)
      await absentPort.commitApplyOperation(
        createApplyCommand(absentFixture),
      )
      absentHarness.omitCheckpointReceiptOnCommit = true

      const absentFailure = await captureMigrationFailure(() =>
        absentPort.saveApplyCheckpoint(
          createCheckpointCommand(
            absentFixture,
            'collaboration',
            2,
          ),
        )
      )

      expect(absentFailure.code).toBe('INVALID_STATE')
      expect(absentHarness.transactions).toHaveLength(2)
      expect(await absentPort.readRunState()).toMatchObject({
        revision: 3,
        apply: {
          sources: {
            collaboration: { completed: true },
          },
        },
      })
    },
  )

  test(
    'maps all ten checkpoint cancellation positions',
    async () => {
      const index =
        workspaceSearchMigrationApplyCheckpointTransactionIndex
      const cases: readonly {
        /** Fixed checkpoint transaction index selected by the test. */
        readonly failedIndex: number
        /** Stable expected public failure code. */
        readonly code: WorkspaceSearchMigrationFailureCode
      }[] = [
        { failedIndex: index.lease, code: 'LEASE_LOST' },
        {
          failedIndex: index.pointer,
          code: 'INVALID_MAINTENANCE_EVIDENCE',
        },
        {
          failedIndex: index.receipt,
          code: 'INVALID_MAINTENANCE_EVIDENCE',
        },
        { failedIndex: index.writerFence, code: 'INVALID_STATE' },
        {
          failedIndex: index.executionBoundary,
          code: 'INVALID_STATE',
        },
        {
          failedIndex: index.sealedPlanningAuthority,
          code: 'INVALID_STATE',
        },
        { failedIndex: index.executionRun, code: 'INVALID_STATE' },
        { failedIndex: index.rollbackStart, code: 'INVALID_STATE' },
        { failedIndex: index.executionState, code: 'INVALID_STATE' },
        {
          failedIndex: index.checkpointReceipt,
          code: 'INVALID_STATE',
        },
      ]
      expect(cases).toHaveLength(index.count)
      for (const entry of cases) {
        const fixture = createApplyFixture('put')
        const harness = new ApplyOperationHarness(fixture)
        const port = createApplyPort(fixture, harness)
        await port.commitApplyOperation(createApplyCommand(fixture))
        harness.nextTransactionError =
          createCheckpointCancellation(entry.failedIndex)

        const failure = await captureMigrationFailure(() =>
          port.saveApplyCheckpoint(
            createCheckpointCommand(
              fixture,
              'project-directory',
              2,
            ),
          )
        )

        expect(failure.code).toBe(entry.code)
        expect(harness.transactions).toHaveLength(2)
      }
    },
  )

  test(
    'rejects hostile and invalid checkpoint scanner output before transaction send',
    async () => {
      const factories: readonly ((
        previous: MigrationSourceCheckpoint,
      ) => MigrationSourceCheckpoint)[] = [
        (previous) =>
          new Proxy(createTerminalEmptyCheckpointPage(previous), {}),
        (previous) => {
          const invalid = createTerminalEmptyCheckpointPage(previous)
          return {
            ...invalid,
            aggregate: {
              ...invalid.aggregate,
              scanned: invalid.aggregate.scanned + 1,
            },
          }
        },
        (previous) => {
          const invalid = createCheckpointPage(
            previous,
            'project-directory',
            1,
            false,
          )
          return {
            ...invalid,
            cursor: {
              workspaceId: { S: 'wrong-key-schema' },
              recordKey: { S: 'wrong-key-schema' },
            },
          }
        },
      ]
      for (const factory of factories) {
        const fixture = createApplyFixture('put')
        const harness = new ApplyOperationHarness(fixture)
        const port = createApplyPort(fixture, harness)
        await port.commitApplyOperation(createApplyCommand(fixture))
        harness.checkpointScanImplementation = async ({
          previousCheckpoint,
        }) => factory(previousCheckpoint)

        const failure = await captureMigrationFailure(() =>
          port.saveApplyCheckpoint(
            createCheckpointCommand(
              fixture,
              'project-directory',
              2,
            ),
          )
        )

        expect(failure.code).toBe('INVALID_STATE')
        expect(harness.transactions).toHaveLength(1)
      }

      const accessorFixture = createApplyFixture('put')
      const accessorHarness =
        new ApplyOperationHarness(accessorFixture)
      const accessorPort = createApplyPort(
        accessorFixture,
        accessorHarness,
      )
      await accessorPort.commitApplyOperation(
        createApplyCommand(accessorFixture),
      )
      accessorHarness.checkpointScanImplementation = async ({
        previousCheckpoint,
      }) => {
        const page = createTerminalEmptyCheckpointPage(
          previousCheckpoint,
        )
        Object.defineProperty(page, 'completed', {
          configurable: true,
          enumerable: true,
          get: () => {
            accessorHarness.callerAccessorReads += 1
            return true
          },
        })
        return page
      }

      const accessorFailure = await captureMigrationFailure(() =>
        accessorPort.saveApplyCheckpoint(
          createCheckpointCommand(
            accessorFixture,
            'project-directory',
            2,
          ),
        )
      )

      expect(accessorFailure.code).toBe('INVALID_STATE')
      expect(accessorHarness.callerAccessorReads).toBe(0)
      expect(accessorHarness.transactions).toHaveLength(1)
    },
  )

  test(
    'publishes one fixed ten-item applied root and prefers it across restart and receipt retries',
    async () => {
      const fixture = createApplyFixture('put', 0)
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        1,
      )
      expect(terminal).toMatchObject({
        revision: 6,
        status: 'applying',
        appliedOperationCount: 0,
      })
      const eventStart = harness.events.length

      const applied = await port.sealApply(
        createApplySealCommand(fixture, terminal.revision),
      )

      expect(applied).toMatchObject({
        revision: 7,
        status: 'applied',
        applySeal: {
          scope: 'complete-plan',
          contentDigest:
            harness.uploadedApplySeals[0] === undefined
              ? undefined
              : createMigrationDigest(
                  harness.uploadedApplySeals[0],
                ),
        },
      })
      expect(harness.uploadedApplySeals).toHaveLength(1)
      const uploadedSeal = harness.uploadedApplySeals[0]
      if (uploadedSeal === undefined) {
        throw new Error('Expected one uploaded production seal.')
      }
      let storedBytes: Uint8Array | undefined
      let returnSharedBytes = false
      const immutableArtifactPort:
        WorkspaceSearchMigrationImmutableArtifactAwsPort = {
          writeImmutableArtifact: async (input) => {
            storedBytes = Uint8Array.from(input.bytes)
            const contentDigest = createHash('sha256')
              .update(input.bytes)
              .digest('hex')
            return {
              objectKey:
                `${input.objectKeyPrefix}/${input.role}/${contentDigest}.artifact`,
              versionId: 'real-gateway-version',
              contentDigest,
              byteLength: input.bytes.byteLength,
              retainUntil: input.retainUntil,
            }
          },
          readImmutableArtifact: async () => {
            if (storedBytes === undefined) {
              throw new Error('Expected stored test seal bytes.')
            }
            if (returnSharedBytes) {
              const shared = new Uint8Array(
                new SharedArrayBuffer(storedBytes.byteLength),
              )
              shared.set(storedBytes)
              return shared
            }
            return Uint8Array.from(storedBytes)
          },
        }
      const realGateway =
        createAwsWorkspaceSearchMigrationApplySealGateway({
          configuration: fixture.configuration,
          configurationHash: fixture.configurationHash,
          runId,
          immutableArtifactPort,
          clock: () => new Date('2026-07-29T01:19:50.000Z'),
        })
      const realReference =
        await realGateway.writeCompleteApplySeal(uploadedSeal)
      expect(
        await realGateway.readCompleteApplySeal(realReference),
      ).toEqual(uploadedSeal)
      const sharedSealBytes = new Uint8Array(
        new SharedArrayBuffer(
          serializeWorkspaceSearchMigrationCompleteApplySeal(
            uploadedSeal,
          ).byteLength,
        ),
      )
      sharedSealBytes.set(
        serializeWorkspaceSearchMigrationCompleteApplySeal(
          uploadedSeal,
        ),
      )
      expect(() =>
        parseWorkspaceSearchMigrationCompleteApplySeal(
          sharedSealBytes,
        )
      ).toThrow('INVALID_MIGRATION_APPLY_SEAL')
      returnSharedBytes = true
      await expect(
        realGateway.readCompleteApplySeal(realReference),
      ).rejects.toMatchObject({
        code: 'INVALID_MIGRATION_APPLY_SEAL_STORAGE',
      })
      returnSharedBytes = false
      await expect(
        realGateway.readCompleteApplySeal({
          ...realReference,
          objectKey:
            `workspace-search/v1/runs/${runId}/${fixture.configurationHash}/wrong/${realReference.contentDigest}.artifact`,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_MIGRATION_APPLY_SEAL_STORAGE',
      })
      expect(harness.transactions).toHaveLength(6)
      const transaction = requireTransaction(
        harness.transactions[5],
      )
      const items = requireTransactionItems(transaction)
      expect(items).toHaveLength(
        workspaceSearchMigrationApplySealTransactionIndex.count,
      )
      for (let index = 0; index <= 8; index += 1) {
        expect(items[index]?.ConditionCheck).toBeDefined()
      }
      const executionStateCondition = items[
        workspaceSearchMigrationApplySealTransactionIndex
          .executionState
      ]?.ConditionCheck
      const rootPut = items[
        workspaceSearchMigrationApplySealTransactionIndex
          .appliedRoot
      ]?.Put
      if (
        executionStateCondition === undefined ||
        rootPut?.Item === undefined
      ) {
        throw new Error(
          'Expected exact terminal-state condition and applied-root Put.',
        )
      }
      expect(
        Object.values(
          executionStateCondition.ExpressionAttributeNames ?? {},
        ),
      ).toContain('executionStateBytes')
      expect(rootPut.ConditionExpression).toContain(
        'attribute_not_exists',
      )
      expect(rootPut.Item).toMatchObject({
        kind: {
          S: 'workspace-search-migration-applied-root-record',
        },
        predecessorRevision: { N: '6' },
        successorRevision: { N: '7' },
        status: { S: 'applied' },
      })
      const root = parseWorkspaceSearchMigrationAppliedRoot(
        requireBinaryAttribute(rootPut.Item, 'rootBytes'),
      )
      expect(root).toMatchObject({
        predecessorRevision: 6,
        predecessorExecutionStateDigest:
          harness.findLastTransactionRecord(
            'workspace-search-migration-execution-state-record',
          )?.executionStateDigest?.S,
        successorRevision: 7,
        status: 'applied',
      })
      const appliedRootBinding = {
        stateTable:
          fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      }
      const appliedRootInput = {
        ...appliedRootBinding,
        root,
      }
      expect(
        createWorkspaceSearchMigrationAppliedRootRecord(
          appliedRootInput,
        ),
      ).toEqual(rootPut.Item)
      const appliedRootKey =
        createWorkspaceSearchMigrationAppliedRootKey(
          appliedRootBinding,
        )
      const strongRead =
        createWorkspaceSearchMigrationAppliedRootStrongReadCommand(
          appliedRootBinding,
        )
      expect(strongRead.input).toEqual({
        TableName:
          fixture.configuration.tables['migration-state']
            .tableName,
        ConsistentRead: true,
        Key: appliedRootKey,
      })
      expect(
        parseWorkspaceSearchMigrationAppliedRootStrongReadOutput({
          ...appliedRootBinding,
          output: { Item: rootPut.Item },
        }),
      ).toEqual(root)
      expect(
        parseWorkspaceSearchMigrationAppliedRootStrongReadOutput({
          ...appliedRootBinding,
          output: {},
        }),
      ).toBeUndefined()
      expect(
        parseWorkspaceSearchMigrationAppliedRootRecord({
          ...appliedRootBinding,
          item: rootPut.Item,
        }),
      ).toEqual(root)
      const appliedRootCondition =
        createWorkspaceSearchMigrationAppliedRootConditionCheck(
          appliedRootInput,
        ).ConditionCheck
      if (appliedRootCondition === undefined) {
        throw new Error(
          'Expected one exact applied-root condition check.',
        )
      }
      const controlledAttributes = Object.keys(rootPut.Item)
        .filter(
          (name) =>
            name !== 'migrationId' && name !== 'recordKey',
        )
        .sort()
      expect(appliedRootCondition.TableName).toBe(
        fixture.configuration.tables['migration-state']
          .tableName,
      )
      expect(appliedRootCondition.Key).toEqual(appliedRootKey)
      expect(
        Object.values(
          appliedRootCondition.ExpressionAttributeNames ?? {},
        ).sort(),
      ).toEqual(controlledAttributes)
      expect(
        Object.values(
          appliedRootCondition.ExpressionAttributeNames ?? {},
        ),
      ).toContain('rootBytes')
      expect(
        Object.keys(
          appliedRootCondition.ExpressionAttributeValues ?? {},
        ),
      ).toHaveLength(controlledAttributes.length)
      const corruptedRootRecord = {
        ...structuredClone(rootPut.Item),
        rootDigest: { S: digest('corrupted-applied-root') },
      }
      expect(
        captureSynchronousMigrationFailure(() =>
          parseWorkspaceSearchMigrationAppliedRootRecord({
            ...appliedRootBinding,
            item: corruptedRootRecord,
          })
        ).code,
      ).toBe('INVALID_STATE')
      const extendedRootRecord = {
        ...structuredClone(rootPut.Item),
        unexpected: { S: 'forbidden' },
      }
      expect(
        captureSynchronousMigrationFailure(() =>
          parseWorkspaceSearchMigrationAppliedRootRecord({
            ...appliedRootBinding,
            item: extendedRootRecord,
          })
        ).code,
      ).toBe('INVALID_STATE')
      const sealEvents = harness.events.slice(eventStart)
      expect(sealEvents.indexOf('apply-seal-write')).toBeLessThan(
        sealEvents.indexOf('prepare'),
      )
      expect(sealEvents.indexOf('prepare')).toBeLessThan(
        sealEvents.indexOf('transact'),
      )

      const transactionCount = harness.transactions.length
      const restarted = createApplyPort(fixture, harness)
      expect(
        await restarted.sealApply(
          createApplySealCommand(fixture, terminal.revision),
        ),
      ).toEqual(applied)
      expect(harness.uploadedApplySeals).toHaveLength(1)
      expect(harness.transactions).toHaveLength(transactionCount)

      expect(
        await restarted.saveApplyCheckpoint(
          createCheckpointCommand(
            fixture,
            'project-directory',
            1,
          ),
        ),
      ).toEqual(applied)
      const newCheckpointFailure =
        await captureMigrationFailure(() =>
          restarted.saveApplyCheckpoint(
            createCheckpointCommand(
              fixture,
              'project-directory',
              applied.revision,
            ),
          )
        )
      expect(newCheckpointFailure.code).toBe('INVALID_STATE')
      expect(harness.transactions).toHaveLength(transactionCount)
    },
  )

  test(
    'seals one mutating run with marker, journal, target, and shared retention evidence',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      harness.checkpointScanImplementation = async ({
        location,
        previousCheckpoint,
      }) =>
        location === 'project-directory' || location === 'target'
          ? createTerminalMappedCheckpoint(
              previousCheckpoint,
              location,
              1,
            )
          : createTerminalEmptyCheckpointPage(previousCheckpoint)
      const port = createApplyPort(fixture, harness)
      const applying = await port.commitApplyOperation(
        createApplyCommand(fixture),
      )
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        applying.revision,
      )

      const applied = await port.sealApply(
        createApplySealCommand(fixture, terminal.revision),
      )

      expect(applied).toMatchObject({
        revision: 8,
        status: 'applied',
        appliedOperationCount: 1,
        journalSequence: 1,
      })
      expect(harness.uploadedApplySeals).toHaveLength(1)
      expect(harness.uploadedApplySeals[0]).toMatchObject({
        markerCount: 1,
        journalSequence: 1,
        minimumJournalRetainUntil: freshRetainUntil,
        apply: {
          sources: {
            'project-directory': {
              aggregate: { mapped: 1, projected: 1 },
            },
          },
          target: {
            aggregate: { mapped: 1, projected: 1, deleted: 0 },
          },
        },
      })
      const rootRecord = harness.findLastTransactionRecord(
        'workspace-search-migration-applied-root-record',
      )
      if (rootRecord === undefined) {
        throw new Error('Expected one durable applied root.')
      }
      const root = parseWorkspaceSearchMigrationAppliedRoot(
        requireBinaryAttribute(rootRecord, 'rootBytes'),
      )
      expect(root.sealReference.retainUntil).toBe(
        fixture.sealedPlanningAuthority.planSealReference
          .retainUntil,
      )
      expect(root.minimumJournalRetainUntil).toBe(
        freshRetainUntil,
      )
      expect(harness.transactions).toHaveLength(7)
    },
  )

  test(
    'seals a source deletion after verifying that no owned target remains',
    async () => {
      const fixture = createApplyFixture('delete')
      const harness = new ApplyOperationHarness(fixture)
      harness.checkpointScanImplementation = async ({
        location,
        previousCheckpoint,
      }) => {
        if (location === 'project-directory') {
          return createTerminalDeletedSourceCheckpoint(
            previousCheckpoint,
            location,
          )
        }
        return createTerminalEmptyCheckpointPage(previousCheckpoint)
      }
      const port = createApplyPort(fixture, harness)
      const applying = await port.commitApplyOperation(
        createApplyCommand(fixture),
      )
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        applying.revision,
      )

      const applied = await port.sealApply(
        createApplySealCommand(fixture, terminal.revision),
      )

      expect(applied).toMatchObject({
        revision: 8,
        status: 'applied',
        appliedOperationCount: 1,
        journalSequence: 1,
      })
      expect(harness.uploadedApplySeals).toHaveLength(1)
      expect(harness.uploadedApplySeals[0]).toMatchObject({
        sourceOperationCount: 1,
        apply: {
          sources: {
            'project-directory': {
              aggregate: {
                mapped: 1,
                projected: 0,
                deleted: 1,
              },
            },
          },
          target: {
            aggregate: {
              mapped: 0,
              projected: 0,
              deleted: 0,
            },
          },
        },
      })
    },
  )

  test(
    'preserves lease loss when authority expires after seal upload and all-six preparation',
    async () => {
      const fixture = createApplyFixture('no-op', 0)
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        1,
      )
      const transactionCount = harness.transactions.length
      harness.prepareEffect = () => {
        harness.advanceClock(30_000)
      }

      const failure = await captureMigrationFailure(() =>
        port.sealApply(
          createApplySealCommand(fixture, terminal.revision),
        )
      )

      expect(failure.code).toBe('LEASE_LOST')
      expect(harness.uploadedApplySeals).toHaveLength(1)
      expect(harness.events).toContain('prepare')
      expect(harness.transactions).toHaveLength(transactionCount)
    },
  )

  test(
    'rejects a terminal target cardinality mismatch before seal upload',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      harness.checkpointScanImplementation = async ({
        location,
        previousCheckpoint,
      }) =>
        location === 'project-directory'
          ? createTerminalMappedCheckpoint(
              previousCheckpoint,
              location,
              1,
            )
          : createTerminalEmptyCheckpointPage(previousCheckpoint)
      const port = createApplyPort(fixture, harness)
      const applying = await port.commitApplyOperation(
        createApplyCommand(fixture),
      )
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        applying.revision,
      )

      const failure = await captureMigrationFailure(() =>
        port.sealApply(
          createApplySealCommand(fixture, terminal.revision),
        )
      )

      expect(failure.code).toBe('INVALID_STATE')
      expect(harness.uploadedApplySeals).toEqual([])
      expect(harness.transactions).toHaveLength(6)
    },
  )

  test(
    'rejects publication when journal evidence expires before the shared horizon',
    async () => {
      const fixture = createApplyFixture('put')
      const harness = new ApplyOperationHarness(fixture)
      harness.journalRetainUntil = '2026-08-28T23:00:00.000Z'
      harness.checkpointScanImplementation = async ({
        location,
        previousCheckpoint,
      }) =>
        location === 'project-directory' || location === 'target'
          ? createTerminalMappedCheckpoint(
              previousCheckpoint,
              location,
              1,
            )
          : createTerminalEmptyCheckpointPage(previousCheckpoint)
      const port = createApplyPort(fixture, harness)
      const applying = await port.commitApplyOperation(
        createApplyCommand(fixture),
      )
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        applying.revision,
      )

      const failure = await captureMigrationFailure(() =>
        port.sealApply(
          createApplySealCommand(fixture, terminal.revision),
        )
      )

      expect(failure.code).toBe('INVALID_STATE')
      expect(harness.uploadedApplySeals).toHaveLength(1)
      expect(harness.transactions).toHaveLength(6)
    },
  )

  test(
    'rejects complete sealing before every clean terminal checkpoint',
    async () => {
      const fixture = createApplyFixture('put', 0)
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)

      const failure = await captureMigrationFailure(() =>
        port.sealApply(createApplySealCommand(fixture, 1))
      )

      expect(failure.code).toBe('INVALID_STATE')
      expect(harness.uploadedApplySeals).toEqual([])
      expect(harness.transactions).toEqual([])
    },
  )

  test(
    'recovers a committed applied root after response loss and process restart',
    async () => {
      const fixture = createApplyFixture('put', 0)
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        1,
      )
      harness.nextTransactionError = createApplySealCancellation(
        workspaceSearchMigrationApplySealTransactionIndex
          .appliedRoot,
      )
      harness.commitBeforeTransactionError = true

      const applied = await port.sealApply(
        createApplySealCommand(fixture, terminal.revision),
      )

      expect(applied).toMatchObject({
        revision: terminal.revision + 1,
        status: 'applied',
      })
      expect(harness.uploadedApplySeals).toHaveLength(1)
      const transactionCount = harness.transactions.length
      const restarted = createApplyPort(fixture, harness)
      expect(
        await restarted.sealApply(
          createApplySealCommand(fixture, terminal.revision),
        ),
      ).toEqual(applied)
      expect(harness.uploadedApplySeals).toHaveLength(1)
      expect(harness.transactions).toHaveLength(transactionCount)
    },
  )

  test(
    'returns ambiguous when an acknowledged seal transaction has no durable root',
    async () => {
      const fixture = createApplyFixture('put', 0)
      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        1,
      )
      harness.omitAppliedRootOnCommit = true

      const failure = await captureMigrationFailure(() =>
        port.sealApply(
          createApplySealCommand(fixture, terminal.revision),
        )
      )

      expect(failure.code).toBe(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
      expect(harness.uploadedApplySeals).toHaveLength(1)
      expect(await port.readRunState()).toMatchObject({
        revision: terminal.revision,
        status: 'applying',
      })
    },
  )

  test(
    'accepts a concurrent valid root winner with the exact same predecessor',
    async () => {
      const fixture = createApplyFixture('put', 0)
      const winnerHarness = new ApplyOperationHarness(fixture)
      const winnerPort = createApplyPort(fixture, winnerHarness)
      const winnerTerminal = await completeApplyCheckpoints(
        fixture,
        winnerPort,
        1,
      )
      winnerHarness.advanceClock(5_000)
      const winnerState = await winnerPort.sealApply(
        createApplySealCommand(
          fixture,
          winnerTerminal.revision,
        ),
      )
      const winnerRootRecord =
        winnerHarness.findLastTransactionRecord(
          'workspace-search-migration-applied-root-record',
        )
      const winnerSeal = winnerHarness.uploadedApplySeals[0]
      if (
        winnerRootRecord === undefined ||
        winnerSeal === undefined
      ) {
        throw new Error('Expected a concurrent valid root winner.')
      }

      const harness = new ApplyOperationHarness(fixture)
      const port = createApplyPort(fixture, harness)
      const terminal = await completeApplyCheckpoints(
        fixture,
        port,
        1,
      )
      harness.appliedRootReplacementOnCommit = winnerRootRecord
      harness.applySealReadReplacement = winnerSeal
      harness.nextTransactionError = createApplySealCancellation(
        workspaceSearchMigrationApplySealTransactionIndex
          .appliedRoot,
      )
      harness.commitBeforeTransactionError = true

      const reconciled = await port.sealApply(
        createApplySealCommand(fixture, terminal.revision),
      )

      expect(reconciled).toEqual(winnerState)
      expect(harness.uploadedApplySeals).toHaveLength(1)
      expect(harness.transactions).toHaveLength(6)
    },
  )

  test(
    'rejects tampered applied-root rows and mismatched exact seal bytes',
    async () => {
      const rootFixture = createApplyFixture('put', 0)
      const rootHarness = new ApplyOperationHarness(rootFixture)
      const rootPort = createApplyPort(rootFixture, rootHarness)
      const rootTerminal = await completeApplyCheckpoints(
        rootFixture,
        rootPort,
        1,
      )
      await rootPort.sealApply(
        createApplySealCommand(
          rootFixture,
          rootTerminal.revision,
        ),
      )
      const rootRecord = rootHarness.findLastTransactionRecord(
        'workspace-search-migration-applied-root-record',
      )
      if (rootRecord === undefined) {
        throw new Error('Expected one durable applied-root row.')
      }
      rootHarness.seedStateRecord({
        ...rootRecord,
        rootDigest: { S: digest('tampered-applied-root') },
      })
      const rootFailure = await captureMigrationFailure(() =>
        rootPort.readRunState()
      )
      expect(rootFailure.code).toBe('INVALID_STATE')

      const sealFixture = createApplyFixture('put', 0)
      const sealHarness = new ApplyOperationHarness(sealFixture)
      const sealPort = createApplyPort(sealFixture, sealHarness)
      const sealTerminal = await completeApplyCheckpoints(
        sealFixture,
        sealPort,
        1,
      )
      await sealPort.sealApply(
        createApplySealCommand(
          sealFixture,
          sealTerminal.revision,
        ),
      )
      const predecessorRecord =
        sealHarness.findLastTransactionRecord(
          'workspace-search-migration-execution-state-record',
        )
      if (predecessorRecord === undefined) {
        throw new Error('Expected one terminal predecessor row.')
      }
      const predecessor =
        parseWorkspaceSearchMigrationExecutionState(
          requireBinaryAttribute(
            predecessorRecord,
            'executionStateBytes',
          ),
        )
      if (predecessor.executionStateVersion !== 2) {
        throw new Error('Expected one terminal v2 predecessor.')
      }
      sealHarness.applySealReadReplacement =
        createWorkspaceSearchMigrationCompleteApplySeal({
          admission: sealFixture.executionRun,
          predecessor,
          sealedPlanningAuthority:
            sealFixture.sealedPlanningAuthority,
          createdAt: '2026-07-29T01:19:59.000Z',
        })

      const sealFailure = await captureMigrationFailure(() =>
        sealPort.readRunState()
      )

      expect(sealFailure.code).toBe('INVALID_STATE')
    },
  )

  test(
    'maps every fixed complete apply-seal cancellation position',
    async () => {
      const index = workspaceSearchMigrationApplySealTransactionIndex
      const cases: readonly {
        /** Fixed complete apply-seal transaction index. */
        readonly failedIndex: number
        /** Stable expected public failure code. */
        readonly code: WorkspaceSearchMigrationFailureCode
      }[] = [
        { failedIndex: index.lease, code: 'LEASE_LOST' },
        {
          failedIndex: index.pointer,
          code: 'INVALID_MAINTENANCE_EVIDENCE',
        },
        {
          failedIndex: index.receipt,
          code: 'INVALID_MAINTENANCE_EVIDENCE',
        },
        { failedIndex: index.writerFence, code: 'INVALID_STATE' },
        {
          failedIndex: index.executionBoundary,
          code: 'INVALID_STATE',
        },
        {
          failedIndex: index.sealedPlanningAuthority,
          code: 'INVALID_STATE',
        },
        { failedIndex: index.executionRun, code: 'INVALID_STATE' },
        { failedIndex: index.rollbackStart, code: 'INVALID_STATE' },
        { failedIndex: index.executionState, code: 'INVALID_STATE' },
        { failedIndex: index.appliedRoot, code: 'INVALID_STATE' },
      ]
      expect(cases).toHaveLength(index.count)
      for (const entry of cases) {
        const fixture = createApplyFixture('put', 0)
        const harness = new ApplyOperationHarness(fixture)
        const port = createApplyPort(fixture, harness)
        const terminal = await completeApplyCheckpoints(
          fixture,
          port,
          1,
        )
        harness.nextTransactionError =
          createApplySealCancellation(entry.failedIndex)

        const failure = await captureMigrationFailure(() =>
          port.sealApply(
            createApplySealCommand(
              fixture,
              terminal.revision,
            ),
          )
        )

        expect(failure.code).toBe(entry.code)
        expect(harness.uploadedApplySeals).toHaveLength(1)
        expect(harness.transactions).toHaveLength(6)
      }
    },
    15_000,
  )
})

describe('Workspace Search apply predecessor AWS binding', () => {
  test('projects admission from exact absent strong reads and creates the absent state guard', () => {
    const fixture = createApplyFixture('put')
    const stateTable =
      fixture.configuration.tables['migration-state']
    const binding =
      createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
        stateTable,
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      })

    const executionStateRead =
      binding.createExecutionStateStrongReadCommand()
    const appliedRootRead =
      binding.createAppliedRootStrongReadCommand()
    expect(executionStateRead.input).toEqual({
      TableName: stateTable.tableName,
      ConsistentRead: true,
      Key: {
        migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
        recordKey: {
          S:
            `execution-state/v1/${
              createWorkspaceSearchMigrationApplyRunBindingDigest({
                stateTable,
                configurationHash: fixture.configurationHash,
                executionRun: fixture.executionRun,
              })
            }/state`,
        },
      },
    })
    expect(appliedRootRead.input).toEqual(
      createWorkspaceSearchMigrationAppliedRootStrongReadCommand({
        stateTable,
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      }).input,
    )

    const projection = binding.parseStrongReadOutputs(
      { $metadata: {} },
      { $metadata: {} },
    )
    expect(projection).toEqual({
      predecessor: { kind: 'execution-run-admission' },
      runState: fixture.executionRun.runState,
    })
    if (!Reflect.set(projection.runState, 'revision', 99)) {
      throw new Error('Expected a mutable detached run-state fixture.')
    }
    expect(
      binding.parseStrongReadOutputs({}, {}).runState.revision,
    ).toBe(fixture.executionRun.runState.revision)

    const condition =
      binding.createExecutionStateConditionCheck(
        projection.predecessor,
      ).ConditionCheck
    if (condition === undefined) {
      throw new Error('Expected one absent execution-state condition.')
    }
    expect(condition.TableName).toBe(stateTable.tableName)
    expect(condition.Key).toEqual(executionStateRead.input.Key)
    expect(condition.ConditionExpression).toBe(
      'attribute_not_exists(#a0) AND attribute_not_exists(#a1)',
    )
    expect(condition.ExpressionAttributeNames).toEqual({
      '#a0': 'migrationId',
      '#a1': 'recordKey',
    })
    expect(condition.ExpressionAttributeValues).toBeUndefined()
  })

  test('rejects malformed predecessor guard inputs without reading a Proxy', () => {
    const fixture = createApplyFixture('put')
    const binding =
      createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
        stateTable:
          fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      })
    let proxyReads = 0
    const hostileProxy = new Proxy({}, {
      get: () => {
        proxyReads += 1
        return 'tenant-secret'
      },
      getOwnPropertyDescriptor: () => {
        proxyReads += 1
        return undefined
      },
      ownKeys: () => {
        proxyReads += 1
        return []
      },
    })
    const malformedPredecessors: readonly unknown[] = [
      { kind: 'unknown-predecessor' },
      {
        kind: 'execution-run-admission',
        unexpected: true,
      },
      null,
      [],
      hostileProxy,
    ]

    for (const predecessor of malformedPredecessors) {
      expect(
        captureSynchronousMigrationFailure(() =>
          Reflect.apply(
            binding.createExecutionStateConditionCheck,
            binding,
            [predecessor],
          )
        ).code,
      ).toBe('INVALID_ARGUMENT')
    }
    expect(proxyReads).toBe(0)
  })

  test('projects legacy v1 and recreates the exact complete controlled row guard', async () => {
    const fixture = createApplyFixture('put')
    const harness = new ApplyOperationHarness(fixture)
    const successor = await createApplyPort(
      fixture,
      harness,
    ).commitApplyOperation(createApplyCommand(fixture))
    const stateRecord = harness.findLastTransactionRecord(
      'workspace-search-migration-execution-state-record',
    )
    if (stateRecord === undefined) {
      throw new Error('Expected one durable legacy execution-state row.')
    }
    const binding =
      createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
        stateTable:
          fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      })

    const projection = binding.parseStrongReadOutputs(
      { $metadata: {}, Item: stateRecord },
      { $metadata: {} },
    )
    expect(projection.runState).toEqual(successor)
    if (
      projection.predecessor.kind !==
        'mutable-execution-state'
    ) {
      throw new Error('Expected one mutable execution predecessor.')
    }
    expect(
      projection.predecessor.executionState.executionStateVersion,
    ).toBe(1)

    const condition =
      binding.createExecutionStateConditionCheck(
        projection.predecessor,
      )
    expect(reconstructConditionCheckedItem(condition)).toEqual(
      stateRecord,
    )

    const mismatchedDigestRecord = {
      ...structuredClone(stateRecord),
      runStateDigest: {
        S: digest('tampered-predecessor-run-state'),
      },
    }
    expect(
      captureSynchronousMigrationFailure(() =>
        binding.parseStrongReadOutputs(
          { Item: mismatchedDigestRecord },
          {},
        )
      ).code,
    ).toBe('INVALID_STATE')
    const extendedRecord = {
      ...structuredClone(stateRecord),
      unexpected: { S: 'forbidden' },
    }
    expect(
      captureSynchronousMigrationFailure(() =>
        binding.parseStrongReadOutputs(
          { Item: extendedRecord },
          {},
        )
      ).code,
    ).toBe('INVALID_STATE')

    const tamperedExecutionState = structuredClone(
      projection.predecessor.executionState,
    )
    if (
      !Reflect.set(
        tamperedExecutionState,
        'revision',
        tamperedExecutionState.revision + 1,
      )
    ) {
      throw new Error('Expected a mutable execution-state fixture.')
    }
    expect(
      captureSynchronousMigrationFailure(() =>
        binding.createExecutionStateConditionCheck({
          kind: 'mutable-execution-state',
          executionState: tamperedExecutionState,
        })
      ).code,
    ).toBe('INVALID_ARGUMENT')
  })

  test('projects traversal-capable v2 and preserves its canonical state row', async () => {
    const fixture = createApplyFixture('put', 0)
    const harness = new ApplyOperationHarness(fixture)
    harness.checkpointScanImplementation = async ({
      location,
      previousCheckpoint,
    }) => createCheckpointPage(
      previousCheckpoint,
      location,
      1,
      false,
    )
    const successor = await createApplyPort(
      fixture,
      harness,
    ).saveApplyCheckpoint(
      createCheckpointCommand(
        fixture,
        'project-directory',
        1,
      ),
    )
    const stateRecord = harness.findLastTransactionRecord(
      'workspace-search-migration-execution-state-record',
    )
    if (stateRecord === undefined) {
      throw new Error('Expected one durable v2 execution-state row.')
    }
    const binding =
      createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
        stateTable:
          fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      })

    const projection = binding.parseStrongReadOutputs(
      { Item: stateRecord },
      {},
    )
    expect(projection.runState).toEqual(successor)
    if (
      projection.predecessor.kind !==
        'mutable-execution-state'
    ) {
      throw new Error('Expected one mutable v2 predecessor.')
    }
    const executionState =
      projection.predecessor.executionState
    if (executionState.executionStateVersion !== 2) {
      throw new Error('Expected traversal-capable execution state.')
    }
    expect(
      executionState.apply.sources['project-directory'].cursor,
    ).toEqual(
      successor.apply.sources['project-directory'].cursor,
    )
    expect(
      reconstructConditionCheckedItem(
        binding.createExecutionStateConditionCheck(
          projection.predecessor,
        ),
      ),
    ).toEqual(stateRecord)
  })

  test('rejects an existing applied root and hostile table accessors', async () => {
    const fixture = createApplyFixture('put', 0)
    const harness = new ApplyOperationHarness(fixture)
    const port = createApplyPort(fixture, harness)
    const terminal = await completeApplyCheckpoints(
      fixture,
      port,
      1,
    )
    await port.sealApply(
      createApplySealCommand(fixture, terminal.revision),
    )
    const rootRecord = harness.findLastTransactionRecord(
      'workspace-search-migration-applied-root-record',
    )
    if (rootRecord === undefined) {
      throw new Error('Expected one complete applied-root row.')
    }
    const stateTable =
      fixture.configuration.tables['migration-state']
    const binding =
      createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
        stateTable,
        configurationHash: fixture.configurationHash,
        executionRun: fixture.executionRun,
      })
    expect(
      captureSynchronousMigrationFailure(() =>
        binding.parseStrongReadOutputs(
          {},
          { Item: rootRecord },
        )
      ).code,
    ).toBe('INVALID_STATE')

    let accessorReads = 0
    const accessorTable = structuredClone(stateTable)
    Object.defineProperty(accessorTable, 'tableName', {
      enumerable: true,
      get: () => {
        accessorReads += 1
        return stateTable.tableName
      },
    })
    expect(
      captureSynchronousMigrationFailure(() =>
        createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
          stateTable: accessorTable,
          configurationHash: fixture.configurationHash,
          executionRun: fixture.executionRun,
        })
      ).code,
    ).toBe('INVALID_ARGUMENT')
    expect(accessorReads).toBe(0)
  }, 15_000)
})

/**
 * Creates one compact internally correlated apply fixture.
 *
 * @param variant - Target Put, Delete, or true no-op behavior.
 * @param operationCount - Zero-, one-, or two-operation sealed plan size.
 * @returns Complete exact static adapter material and plan entries.
 */
function createApplyFixture(
  variant: ApplyOperationVariant,
  operationCount: 0 | 1 | 2 = 1,
): ApplyOperationFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const operations = Array.from(
    { length: operationCount },
    (_, index) =>
      createOperation(
        configuration,
        configurationHash,
        index === 0 ? variant : 'put',
        index + 1,
      ),
  )
  const operationDigests = operations.map((operation) =>
    createWorkspaceSearchMigrationOperationDigest(operation)
  )
  const leaves = operationDigests.map(
    (operationDigest, index) =>
      createWorkspaceSearchPlanLeafDigest({
        planSequence: index + 1,
        operationDigest,
      }),
  )
  const firstLeaf = leaves[0]
  const secondLeaf = leaves[1]
  const planDigest = firstLeaf === undefined
    ? createEmptyWorkspaceSearchPlanDigest()
    : secondLeaf === undefined
      ? firstLeaf
      : createWorkspaceSearchPlanNodeDigest(firstLeaf, secondLeaf)
  const plannedOperations = operations.map((operation, index) => {
    const operationDigest = operationDigests[index]
    if (operationDigest === undefined) {
      throw new Error('Expected one operation digest per plan entry.')
    }
    const sibling = leaves[index === 0 ? 1 : 0]
    return {
      runId,
      configurationHash,
      planDigest,
      planSequence: index + 1,
      operationDigest,
      membershipProof: sibling === undefined
        ? []
        : [{
            side: index === 0 ? 'right' : 'left',
            digest: sibling,
          }],
      operation,
    } satisfies WorkspaceSearchPlannedOperation
  })
  const plannedOperation = plannedOperations[0]
  const sourceProjectedCount = operations.filter(
    ({ after }) => after.exists,
  ).length
  const planSeal = createPlanSeal(
    configurationHash,
    planDigest,
    operationCount,
  )
  const writerFence = createWriterFenceBinding(configuration)
  const closeAuthority = {
    configurationHash,
    runId,
    ownerId,
    leaseFenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      digest('close-maintenance-receipt'),
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
      runId,
      configurationHash,
      tableIds: writerFence.tableIds,
      closedWriterFenceRecord,
    })
  const receipt = createMaintenanceReceipt()
  const receiptDigest = createMigrationDigest(receipt)
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
  const executionBoundary = {
    ...boundaryFields,
    boundaryDigest: createMigrationDigest(boundaryFields),
  }
  const sealedPlanningAuthority = createSealedAuthority(
    configurationHash,
    writerFence.tableIds,
    planSeal,
    receiptDigest,
    sourceProjectedCount,
  )
  const currentAuthority: WorkspaceSearchMigrationPrePlanAuthority = {
    configurationHash,
    stateTableId:
      configuration.tables['migration-state'].tableId,
    lease: {
      runId,
      ownerId,
      fenceToken: 7,
      heartbeatAt: evaluatedAt,
      expiresAt: '2026-07-29T01:20:00.000Z',
    },
    maintenanceEvidenceReceiptDigest: receiptDigest,
    maintenanceEvidencePointerRevision: 12,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt,
  }
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
  return {
    configuration,
    configurationHash,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    currentAuthority,
    get plannedOperation() {
      if (plannedOperation === undefined) {
        throw new Error(
          'Expected the fixture to contain a sealed-plan operation.',
        )
      }
      return plannedOperation
    },
    plannedOperations,
  }
}

/**
 * Creates one adapter over plain object-form harness dependencies.
 *
 * @param fixture - Exact static apply material.
 * @param harness - In-memory dependency controller.
 * @returns One-operation apply port.
 */
function createApplyPort(
  fixture: ApplyOperationFixture,
  harness: ApplyOperationHarness,
): WorkspaceSearchMigrationApplyOperationAwsPort {
  return createAwsWorkspaceSearchMigrationApplyOperationPort({
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    executionBoundary: fixture.executionBoundary,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    closedWriterFenceRecord: fixture.closedWriterFenceRecord,
    executionRun: fixture.executionRun,
    authorityPort: harness.authorityPort,
    journalGateway: harness.journalGateway,
    applySealGateway: harness.applySealGateway,
    checkpointScanner: harness.checkpointScanner,
    transport: harness.transport,
    clock: harness.clock,
  })
}

/**
 * Creates one detached caller command without journal evidence.
 *
 * @param fixture - Exact admitted operation and lease authority.
 * @param planOperationIndex - Zero-based index of the selected plan member.
 * @param expectedRevision - Exact predecessor run revision.
 * @returns Detached apply request.
 */
function createApplyCommand(
  fixture: ApplyOperationFixture,
  planOperationIndex = 0,
  expectedRevision = 1,
): WorkspaceSearchMigrationCommandInput<
  WorkspaceSearchApplyOperationCommandEvent
> {
  const authority = fixture.currentAuthority
  const plannedOperation =
    fixture.plannedOperations[planOperationIndex]
  if (plannedOperation === undefined) {
    throw new Error(
      'Expected the apply command to select a sealed-plan operation.',
    )
  }
  return {
    expectedRevision,
    lease: {
      runId: authority.lease.runId,
      ownerId: authority.lease.ownerId,
      fenceToken: authority.lease.fenceToken,
    },
    event: {
      kind: 'apply-operation-requested',
      plannedOperation: structuredClone(plannedOperation),
    },
  }
}

/**
 * Creates one detached checkpoint command under the fixture lease.
 *
 * @param fixture - Exact admitted run and active lease authority.
 * @param location - Source or target traversal selected by the command.
 * @param expectedRevision - Exact durable predecessor revision.
 * @returns Detached checkpoint request.
 */
function createCheckpointCommand(
  fixture: ApplyOperationFixture,
  location: WorkspaceSearchMigrationCheckpointLocation,
  expectedRevision: number,
): WorkspaceSearchMigrationCheckpointCommandInput {
  const authority = fixture.currentAuthority
  return {
    expectedRevision,
    lease: {
      runId: authority.lease.runId,
      ownerId: authority.lease.ownerId,
      fenceToken: authority.lease.fenceToken,
    },
    location,
  }
}

/**
 * Creates one detached complete apply-seal command under the fixture lease.
 *
 * @param fixture - Exact admitted run and active lease authority.
 * @param expectedRevision - Exact terminal applying-state revision.
 * @returns Detached complete apply-seal request.
 */
function createApplySealCommand(
  fixture: ApplyOperationFixture,
  expectedRevision: number,
): WorkspaceSearchMigrationApplySealCommandInput {
  return {
    expectedRevision,
    lease: {
      runId: fixture.currentAuthority.lease.runId,
      ownerId: fixture.currentAuthority.lease.ownerId,
      fenceToken: fixture.currentAuthority.lease.fenceToken,
    },
  }
}

/**
 * Persists terminal clean checkpoints for all four sources and the target.
 *
 * @param fixture - Exact admitted apply fixture.
 * @param port - Apply adapter under test.
 * @param initialRevision - Revision before the first checkpoint.
 * @returns Exact terminal applying state.
 */
async function completeApplyCheckpoints(
  fixture: ApplyOperationFixture,
  port: WorkspaceSearchMigrationApplyOperationAwsPort,
  initialRevision: number,
): Promise<WorkspaceSearchMigrationRunState> {
  const locations:
    readonly WorkspaceSearchMigrationCheckpointLocation[] = [
      'project-directory',
      'work-items',
      'collaboration',
      'documents',
      'target',
    ]
  let state = await port.readRunState()
  for (
    let index = 0;
    index < locations.length;
    index += 1
  ) {
    const location = locations[index]
    if (location === undefined) {
      throw new Error('Expected one checkpoint location.')
    }
    state = await port.saveApplyCheckpoint(
      createCheckpointCommand(
        fixture,
        location,
        initialRevision + index,
      ),
    )
  }
  return state
}

/**
 * Creates one zero-row terminal page after an exact predecessor checkpoint.
 *
 * @param previous - Exact durable predecessor supplied by the adapter.
 * @returns Detached cumulative checkpoint after one bounded empty page.
 */
function createTerminalEmptyCheckpointPage(
  previous: MigrationSourceCheckpoint,
): MigrationSourceCheckpoint {
  if (
    previous.completed ||
    previous.aggregate.pageCount === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('Expected an incomplete bounded checkpoint.')
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
 * Creates one valid cumulative checkpoint after consuming one synthetic row.
 *
 * @param previous - Exact durable predecessor supplied by the adapter.
 * @param location - Source or target table whose cursor schema is required.
 * @param ordinal - Positive page identity used by digests and cursors.
 * @param completed - Whether this synthetic page exhausts the scan.
 * @returns Detached valid cumulative successor checkpoint.
 */
function createCheckpointPage(
  previous: MigrationSourceCheckpoint,
  location: WorkspaceSearchMigrationCheckpointLocation,
  ordinal: number,
  completed: boolean,
): MigrationSourceCheckpoint {
  if (
    previous.completed ||
    !Number.isSafeInteger(ordinal) ||
    ordinal <= 0 ||
    previous.aggregate.pageCount === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('Expected an incomplete bounded checkpoint page.')
  }
  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previous.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previous.contentDigestState,
  )
  keyAccumulator.add(digest(`checkpoint-key:${location}:${ordinal}`))
  contentAccumulator.add(
    digest(`checkpoint-content:${location}:${ordinal}`),
  )
  return {
    completed,
    ...(completed
      ? {}
      : { cursor: createCheckpointCursor(location, ordinal) }),
    aggregate: {
      scanned: previous.aggregate.scanned + 1,
      mapped: previous.aggregate.mapped + 1,
      ignored: previous.aggregate.ignored,
      invalid: previous.aggregate.invalid,
      projected: previous.aggregate.projected + 1,
      deleted: previous.aggregate.deleted,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: previous.aggregate.pageCount + 1,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Creates one exact physical LastEvaluatedKey for a checkpoint location.
 *
 * @param location - Source or target table selected by the scan.
 * @param ordinal - Positive page identity.
 * @returns Exact key schema for the selected measured table.
 */
function createCheckpointCursor(
  location: WorkspaceSearchMigrationCheckpointLocation,
  ordinal: number,
): Readonly<Record<string, AttributeValue>> {
  const suffix = String(ordinal).padStart(6, '0')
  if (location === 'project-directory') {
    return {
      directoryId: { S: 'workspace-1' },
      entryKey: { S: `${suffix}#checkpoint` },
    }
  }
  if (location === 'work-items') {
    return {
      directoryTeamId: { S: 'workspace-1#team-1' },
      issueId: { S: `issue-${suffix}` },
    }
  }
  if (location === 'collaboration') {
    return {
      entityKey: { S: 'workspace-1#team-1' },
      recordKey: { S: `record-${suffix}` },
    }
  }
  return {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: `record-${suffix}` },
  }
}

/**
 * Creates one source-present operation and selected target transition.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param variant - Put, Delete, or no-op target behavior.
 * @param ordinal - One-based unique Team identity.
 * @returns Canonical migration operation.
 */
function createOperation(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  variant: ApplyOperationVariant,
  ordinal = 1,
): WorkspaceSearchMigrationOperation {
  const teamId = `team-${ordinal}`
  const titleSuffix = ordinal === 1 ? 'team' : `team ${ordinal}`
  const sourceKey = {
    directoryId: { S: 'workspace-1' },
    entryKey: {
      S: `${String(ordinal).padStart(6, '0')}#000000#TEAM#${teamId}`,
    },
  }
  const sourceItem = {
    ...sourceKey,
    entryType: { S: 'team' },
    teamId: { S: teamId },
    teamSortOrder: { N: String(ordinal) },
    nameJa: { S: '' },
    nameEn: {
      S: variant === 'no-op'
        ? `Before ${titleSuffix}`
        : `After ${titleSuffix}`,
    },
    ...(variant === 'delete'
      ? { archivedAt: { S: '2026-07-25T01:00:00.000Z' } }
      : {}),
  }
  const before = createWorkspaceSearchMigrationDocumentSnapshot(
    createTeamWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId,
      title: `Before ${titleSuffix}`,
    }),
  )
  const after = variant === 'delete'
    ? createWorkspaceSearchMigrationAbsentSnapshot()
    : variant === 'no-op'
      ? before
      : createWorkspaceSearchMigrationDocumentSnapshot(
          createTeamWorkspaceSearchDocument({
            workspaceId: 'workspace-1',
            teamId,
            title: `After ${titleSuffix}`,
          }),
        )
  if (!before.exists) {
    throw new Error('Expected a present target before snapshot.')
  }
  const targetKey = {
    workspaceId: before.item.workspaceId,
    recordKey: before.item.recordKey,
  }
  const sourceKeyDigest = createAttributeMapDigest(sourceKey)
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const sourceCondition:
    WorkspaceSearchMigrationOperation['sourceCondition'] = {
      exists: true,
      source: 'project-directory',
      tableId:
        configuration.tables['project-directory'].tableId,
      tableName:
        configuration.tables['project-directory'].tableName,
      key: sourceKey,
      keyDigest: sourceKeyDigest,
      item: sourceItem,
      itemDigest: createAttributeMapDigest(sourceItem),
    }
  return {
    operationId: createWorkspaceSearchOperationId({
      configurationHash,
      sourceTableId:
        configuration.tables['project-directory'].tableId,
      sourceKeyDigest,
      targetKeyDigest,
    }),
    sourceCondition,
    targetKey,
    targetKeyDigest,
    before,
    after,
    entityType: 'team',
  }
}

/**
 * Creates one strict bounded-operation plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param planDigest - Exact plan root.
 * @param operationCount - Exact source-backed operation count.
 * @returns Canonical plan seal.
 */
function createPlanSeal(
  configurationHash: string,
  planDigest: string,
  operationCount: 0 | 1 | 2,
): WorkspaceSearchPlanSeal {
  const sourceOperationCount = operationCount
  const orphanOperationCount = 0
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest,
    planOperationCount: operationCount,
    sourceOperationCount,
    orphanOperationCount,
    createdAt: planCreatedAt,
  }
}

/**
 * Creates one strict compact sealed planning authority.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - All six exact measured TableIds.
 * @param planSeal - Exact referenced plan seal.
 * @param receiptDigest - Current immutable receipt digest.
 * @param sourceProjectedCount - Source-backed targets remaining after apply.
 * @returns Exact version-two compact authority.
 */
function createSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
  sourceProjectedCount: number,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const planManifestDigest = digest('plan-manifest')
  const provenanceDigest = digest('provenance')
  const fields = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds,
    planSealReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealDigest}.artifact`,
      versionId: 'plan-seal-version',
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil: freshRetainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${planManifestDigest}.artifact`,
      versionId: 'plan-manifest-version',
      contentDigest: planManifestDigest,
      byteLength: 1,
      retainUntil: freshRetainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
          `workspace-search/v1/planning-provenance-artifacts/v1/${runId}/${configurationHash}`,
          'manifest-heads',
          provenanceDigest,
        ),
      versionId: 'provenance-version',
      contentDigest: provenanceDigest,
      byteLength: 1,
      retainUntil: freshRetainUntil,
    },
    planDigest: planSeal.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: planSeal.sourceOperationCount,
    orphanOperationCount: planSeal.orphanOperationCount,
    planOperationCount: planSeal.planOperationCount,
    planningAuthorityProvenanceDigest: digest('authority-provenance'),
    historicalReceiptBindingDigest: digest('receipt-binding'),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createEvidenceHead(
        'project-directory',
        planSeal.sourceOperationCount,
        sourceProjectedCount,
      ),
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
  return {
    ...fields,
    authorityDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates one compact terminal evidence head.
 *
 * @param chain - Canonical evidence-chain role.
 * @param mappedCount - Exact source-owned operation count for this chain.
 * @param projectedCount - Exact source targets present after apply.
 * @returns Exact terminal head.
 */
function createEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
  mappedCount = 0,
  projectedCount = mappedCount,
) {
  const empty = createEmptyWorkspaceSearchMigrationTraversal()
  const previous = chain === 'workspace-search'
    ? empty.target
    : empty.sources[chain]
  const mappedTerminal = mappedCount === 0
    ? createTerminalEmptyCheckpointPage(previous)
    : createTerminalMappedCheckpoint(
        previous,
        chain === 'workspace-search' ? 'target' : chain,
        mappedCount,
      )
  const terminal = projectedCount === mappedCount
    ? mappedTerminal
    : {
        ...mappedTerminal,
        aggregate: {
          ...mappedTerminal.aggregate,
          projected: projectedCount,
          deleted: mappedCount - projectedCount,
        },
      }
  return {
    chain,
    progressDigest: digest(`progress:${chain}`),
    pageCount: 1,
    terminalEvidenceDigest: digest(`evidence:${chain}`),
    terminalCheckpointDigest:
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        terminal,
      ),
  }
}

/**
 * Creates one terminal page containing an exact number of valid mapped rows.
 *
 * @param previous - Exact empty durable predecessor checkpoint.
 * @param location - Source or target scan location.
 * @param mappedCount - Positive number of valid owned rows in the page.
 * @returns Detached cumulative one-page terminal checkpoint.
 */
function createTerminalMappedCheckpoint(
  previous: MigrationSourceCheckpoint,
  location: WorkspaceSearchMigrationCheckpointLocation,
  mappedCount: number,
): MigrationSourceCheckpoint {
  if (
    previous.completed ||
    previous.aggregate.pageCount === Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(mappedCount) ||
    mappedCount <= 0
  ) {
    throw new Error('Expected a bounded mapped checkpoint page.')
  }
  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previous.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previous.contentDigestState,
  )
  for (let ordinal = 1; ordinal <= mappedCount; ordinal += 1) {
    keyAccumulator.add(
      digest(`checkpoint-key:${location}:${ordinal}`),
    )
    contentAccumulator.add(
      digest(`checkpoint-content:${location}:${ordinal}`),
    )
  }
  return {
    completed: true,
    aggregate: {
      scanned: previous.aggregate.scanned + mappedCount,
      mapped: previous.aggregate.mapped + mappedCount,
      ignored: previous.aggregate.ignored,
      invalid: previous.aggregate.invalid,
      projected: previous.aggregate.projected + mappedCount,
      deleted: previous.aggregate.deleted,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: previous.aggregate.pageCount + 1,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Creates one terminal source page whose mapped row deletes its target.
 *
 * @param previous - Exact empty durable predecessor checkpoint.
 * @param location - Source table selected by the scan.
 * @returns Detached cumulative one-page terminal checkpoint.
 */
function createTerminalDeletedSourceCheckpoint(
  previous: MigrationSourceCheckpoint,
  location: Exclude<
    WorkspaceSearchMigrationCheckpointLocation,
    'target'
  >,
): MigrationSourceCheckpoint {
  const checkpoint = createTerminalMappedCheckpoint(
    previous,
    location,
    1,
  )
  return {
    ...checkpoint,
    aggregate: {
      ...checkpoint.aggregate,
      projected: previous.aggregate.projected,
      deleted: previous.aggregate.deleted + 1,
    },
  }
}

/**
 * Creates the current immutable maintenance receipt.
 *
 * @returns Exact fresh receipt bound to fence seven.
 */
function createMaintenanceReceipt():
WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
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
 * @param role - Logical table role.
 * @param key - Exact base key schema.
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
 * Returns the source primary-key schema for one role.
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
    tableIds: {
      'project-directory':
        configuration.tables['project-directory'].tableId,
      'work-items': configuration.tables['work-items'].tableId,
      collaboration: configuration.tables.collaboration.tableId,
      documents: configuration.tables.documents.tableId,
      'workspace-search':
        configuration.tables['workspace-search'].tableId,
      'migration-state': state.tableId,
    },
  })
}

/**
 * Creates a planned source snapshot.
 *
 * @param operation - Exact planned migration operation.
 * @returns Present or absent source snapshot.
 */
function sourceSnapshot(
  operation: WorkspaceSearchMigrationOperation,
): MigrationItemSnapshot {
  const source = operation.sourceCondition
  if (!source.exists) return createWorkspaceSearchMigrationAbsentSnapshot()
  return {
    exists: true,
    item: source.item,
    digest: source.itemDigest,
  }
}

/**
 * Finds one measured table by exact physical name.
 *
 * @param configuration - Complete measured configuration.
 * @param tableName - Exact physical table name.
 * @returns Matching measured table.
 */
function findTableByName(
  configuration: WorkspaceSearchMigrationConfiguration,
  tableName: string,
): MigrationTableIdentity {
  for (const table of Object.values(configuration.tables)) {
    if (table.tableName === tableName) return table
  }
  throw new Error('Unknown test table name.')
}

/**
 * Extracts one exact primary key from a complete item.
 *
 * @param table - Exact measured table schema.
 * @param item - Complete low-level item.
 * @returns Exact key-only attribute map.
 */
function extractTableKey(
  table: MigrationTableIdentity,
  item: Readonly<Record<string, AttributeValue>>,
): Readonly<Record<string, AttributeValue>> {
  const key: Record<string, AttributeValue> = {}
  for (const attribute of table.key) {
    const value = item[attribute.name]
    if (value === undefined) {
      throw new Error('Missing test item key attribute.')
    }
    key[attribute.name] = structuredClone(value)
  }
  return key
}

/**
 * Creates one deterministic in-memory exact-key locator.
 *
 * @param tableName - Exact physical table name.
 * @param key - Exact low-level primary key.
 * @returns Stable table and key locator.
 */
function storageKey(
  tableName: string,
  key: Readonly<Record<string, AttributeValue>>,
): string {
  return `${tableName}\u0000${createAttributeMapDigest(key)}`
}

/**
 * Creates one fixed-position cancellation with an exact reason count.
 *
 * @param failedIndex - ConditionCheck or Put index that failed.
 * @param itemCount - Exact attempted transaction item count.
 * @returns Raw DynamoDB conditional cancellation.
 */
function createConditionalCancellation(
  failedIndex: number,
  itemCount: number,
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'tenant-secret-cancellation',
    CancellationReasons: Array.from(
      { length: itemCount },
      (_, index) => ({
        Code: index === failedIndex
          ? 'ConditionalCheckFailed'
          : 'None',
      }),
    ),
  })
}

/**
 * Creates one fixed-position conditional transaction cancellation.
 *
 * @param failedIndex - ConditionCheck or Put index that failed.
 * @returns Raw DynamoDB cancellation.
 */
function createCancellation(
  failedIndex: number,
): TransactionCanceledException {
  return createConditionalCancellation(
    failedIndex,
    workspaceSearchMigrationApplyOperationTransactionIndex
      .mutationCount,
  )
}

/**
 * Creates one fixed-position checkpoint transaction cancellation.
 *
 * @param failedIndex - ConditionCheck or Put index that failed.
 * @returns Raw DynamoDB cancellation with all ten reason slots.
 */
function createCheckpointCancellation(
  failedIndex: number,
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'tenant-secret-checkpoint-cancellation',
    CancellationReasons: Array.from(
      {
        length:
          workspaceSearchMigrationApplyCheckpointTransactionIndex.count,
      },
      (_, index) => ({
        Code: index === failedIndex
          ? 'ConditionalCheckFailed'
          : 'None',
      }),
    ),
  })
}

/**
 * Creates one fixed-position complete apply-seal cancellation.
 *
 * @param failedIndex - ConditionCheck or Put index that failed.
 * @returns Raw DynamoDB cancellation with all ten reason slots.
 */
function createApplySealCancellation(
  failedIndex: number,
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'tenant-secret-apply-seal-cancellation',
    CancellationReasons: Array.from(
      {
        length:
          workspaceSearchMigrationApplySealTransactionIndex.count,
      },
      (_, index) => ({
        Code: index === failedIndex
          ? 'ConditionalCheckFailed'
          : 'None',
      }),
    ),
  })
}

/**
 * Requires one recorded transaction.
 *
 * @param command - Candidate command.
 * @returns Exact transaction command.
 */
function requireTransaction(
  command: TransactWriteItemsCommand | undefined,
): TransactWriteItemsCommand {
  if (command === undefined) {
    throw new Error('Expected one transaction command.')
  }
  return command
}

/**
 * Requires one transaction's complete fixed item array.
 *
 * @param command - Exact transaction command.
 * @returns Complete transaction items.
 */
function requireTransactionItems(
  command: TransactWriteItemsCommand,
): readonly TransactWriteItem[] {
  const items = command.input.TransactItems
  if (items === undefined) {
    throw new Error('Expected complete transaction items.')
  }
  return items
}

/**
 * Reconstructs the complete item equality-bound by one present-row condition.
 *
 * @param item - Exact ConditionCheck produced by the predecessor capability.
 * @returns Complete detached row represented by every name/value equality.
 */
function reconstructConditionCheckedItem(
  item: TransactWriteItem,
): Readonly<Record<string, AttributeValue>> {
  const condition = item.ConditionCheck
  if (
    condition === undefined ||
    condition.ExpressionAttributeNames === undefined ||
    condition.ExpressionAttributeValues === undefined
  ) {
    throw new Error('Expected one exact present-row condition.')
  }
  const reconstructed: Record<string, AttributeValue> = {}
  const nameEntries = Object.entries(
    condition.ExpressionAttributeNames,
  )
  const expectedComparisons: string[] = []
  for (const [index, entry] of nameEntries.entries()) {
    const [nameToken, attributeName] = entry
    const expectedNameToken = `#a${index}`
    const valueToken = `:v${index}`
    if (nameToken !== expectedNameToken) {
      throw new Error('Expected canonical ordered condition names.')
    }
    const value = condition.ExpressionAttributeValues[valueToken]
    if (value === undefined) {
      throw new Error('Expected one value per controlled attribute.')
    }
    reconstructed[attributeName] = structuredClone(value)
    expectedComparisons.push(`${nameToken} = ${valueToken}`)
  }
  if (
    Object.keys(condition.ExpressionAttributeValues).length !==
      nameEntries.length ||
    condition.ConditionExpression !==
      expectedComparisons.join(' AND ')
  ) {
    throw new Error('Expected exact full-row equality comparisons.')
  }
  return reconstructed
}

/**
 * Requires one exact binary attribute from a complete low-level record.
 *
 * @param item - Exact low-level item.
 * @param attributeName - Required binary attribute name.
 * @returns Exact binary payload.
 */
function requireBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  attributeName: string,
): Uint8Array {
  const bytes = item[attributeName]?.B
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Expected one binary test record attribute.')
  }
  return bytes
}

/**
 * Captures one asynchronous migration failure.
 *
 * @param operation - Failing adapter operation.
 * @returns Exact public migration failure.
 */
async function captureMigrationFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) return error
    throw error
  }
  throw new Error('Expected a migration failure.')
}

/**
 * Captures one synchronous migration failure.
 *
 * @param operation - Failing synchronous boundary operation.
 * @returns Exact public migration failure.
 */
function captureSynchronousMigrationFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationFailure {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) return error
    throw error
  }
  throw new Error('Expected a migration failure.')
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
