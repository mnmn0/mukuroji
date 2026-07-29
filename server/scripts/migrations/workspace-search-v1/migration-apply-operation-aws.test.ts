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
  type MigrationItemSnapshot,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createAwsWorkspaceSearchMigrationApplyOperationPort,
  type WorkspaceSearchMigrationApplyOperationAuthorityPort,
  type WorkspaceSearchMigrationApplyOperationAwsPort,
  type WorkspaceSearchMigrationApplyOperationAwsTransport,
  workspaceSearchMigrationApplyOperationTransactionIndex,
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
  serializeWorkspaceSearchJournalSegment,
} from './migration-journal'
import type {
  WorkspaceSearchMigrationJournalAwsGateway,
} from './migration-journal-aws'
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
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
  type WorkspaceSearchApplyOperationCommandEvent,
  type WorkspaceSearchMigrationCommandInput,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'
import {
  createWorkspaceSearchMigrationAbsentSnapshot,
  createWorkspaceSearchMigrationDocumentSnapshot,
} from './migration-target-snapshot'

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
const freshRetainUntil = '2026-08-30T00:00:00.000Z'

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

  /** Retention returned by the immutable journal gateway. */
  journalRetainUntil = freshRetainUntil

  /** Optional synchronous effect during the final all-six preparation. */
  prepareEffect: (() => void) | undefined

  /** Ordered high-level dependency operations. */
  readonly events: string[] = []

  /** Strong read commands observed by the fake transport. */
  readonly reads: GetItemCommand[] = []

  /** Fixed-order transactions observed by the fake transport. */
  readonly transactions: TransactWriteItemsCommand[] = []

  /** Canonical segments uploaded before a mutating transaction. */
  readonly uploadedJournalSegments: WorkspaceSearchJournalSegment[] = []

  /** Number of rejected caller accessors invoked. */
  callerAccessorReads = 0

  /** Plain current-authority dependency accepted by the adapter factory. */
  readonly authorityPort:
    WorkspaceSearchMigrationApplyOperationAuthorityPort

  /** Plain immutable journal dependency accepted by the adapter factory. */
  readonly journalGateway: WorkspaceSearchMigrationJournalAwsGateway

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
        const table = findTableByName(
          this.fixture.configuration,
          put.TableName,
        )
        this.seedItem(
          table,
          extractTableKey(table, put.Item),
          put.Item,
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
    'uploads journals before fixed twelve-item Put and Delete transactions and reconciles exact durability',
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
        for (let index = 0; index <= 6; index += 1) {
          expect(items[index]?.ConditionCheck).toBeDefined()
        }
        expect(items[7]?.Put?.Item?.kind?.S).toBe(
          'workspace-search-migration-execution-state-record',
        )
        expect(items[7]?.Put?.Item?.revision?.N).toBe('2')
        expect(items[8]?.ConditionCheck?.TableName).toBe(
          fixture.configuration.tables['project-directory'].tableName,
        )
        expect(items[8]?.ConditionCheck?.ConditionExpression)
          .toBeDefined()
        if (variant === 'put') {
          expect(items[9]?.Put?.TableName).toBe(
            fixture.configuration.tables['workspace-search'].tableName,
          )
          expect(items[9]?.Put?.ConditionExpression).toBeDefined()
          expect(items[9]?.Delete).toBeUndefined()
        } else {
          expect(items[9]?.Delete?.TableName).toBe(
            fixture.configuration.tables['workspace-search'].tableName,
          )
          expect(items[9]?.Delete?.ConditionExpression).toBeDefined()
          expect(items[9]?.Put).toBeUndefined()
        }
        expect(items[10]?.Put?.Item?.kind?.S).toBe(
          'workspace-search-migration-apply-operation-marker',
        )
        expect(items[11]?.Put?.Item?.kind?.S).toBe(
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
    'commits a true no-op as eleven items with a target check and no journal sequence',
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
      expect(items[9]?.ConditionCheck?.TableName).toBe(
        fixture.configuration.tables['workspace-search'].tableName,
      )
      expect(items[9]?.Put).toBeUndefined()
      expect(items[9]?.Delete).toBeUndefined()
      expect(items[10]?.Put?.Item?.kind?.S).toBe(
        'workspace-search-migration-apply-operation-marker',
      )
      expect(items[11]).toBeUndefined()
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
      expect(reconstructionReads).toHaveLength(2)
      expect(
        reconstructionReads.every(
          (command) => command.input.ConsistentRead === true,
        ),
      ).toBe(true)

      const revisionThree = await port.commitApplyOperation(
        createApplyCommand(
          fixture,
          secondPlannedOperation,
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
      expect(secondItems[11]?.Put?.Item?.sequence?.N).toBe('2')

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
})

/**
 * Creates one compact internally correlated apply fixture.
 *
 * @param variant - Target Put, Delete, or true no-op behavior.
 * @param operationCount - One- or two-operation sealed plan size.
 * @returns Complete exact static adapter material and plan entries.
 */
function createApplyFixture(
  variant: ApplyOperationVariant,
  operationCount: 1 | 2 = 1,
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
  if (firstLeaf === undefined) {
    throw new Error('Expected at least one plan leaf.')
  }
  const secondLeaf = leaves[1]
  const planDigest = secondLeaf === undefined
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
  if (plannedOperation === undefined) {
    throw new Error('Expected one primary planned operation.')
  }
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
    plannedOperation,
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
    transport: harness.transport,
    clock: harness.clock,
  })
}

/**
 * Creates one detached caller command without journal evidence.
 *
 * @param fixture - Exact admitted operation and lease authority.
 * @param plannedOperation - Exact selected plan member.
 * @param expectedRevision - Exact predecessor run revision.
 * @returns Detached apply request.
 */
function createApplyCommand(
  fixture: ApplyOperationFixture,
  plannedOperation = fixture.plannedOperation,
  expectedRevision = 1,
): WorkspaceSearchMigrationCommandInput<
  WorkspaceSearchApplyOperationCommandEvent
> {
  const authority = fixture.currentAuthority
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
  operationCount: 1 | 2,
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
 * @returns Exact version-two compact authority.
 */
function createSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
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
  return {
    ...fields,
    authorityDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates one compact terminal evidence head.
 *
 * @param chain - Canonical evidence-chain role.
 * @returns Exact terminal head.
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
 * Creates one fixed-position conditional transaction cancellation.
 *
 * @param failedIndex - ConditionCheck or Put index that failed.
 * @returns Raw DynamoDB cancellation.
 */
function createCancellation(
  failedIndex: number,
): TransactionCanceledException {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'tenant-secret-cancellation',
    CancellationReasons: Array.from(
      {
        length:
          workspaceSearchMigrationApplyOperationTransactionIndex
            .mutationCount,
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
