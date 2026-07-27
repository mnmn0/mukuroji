import { describe, expect, test } from 'bun:test'
import {
  type AttributeValue,
  GetItemCommand,
  type GetItemCommandOutput,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationSourceEvidencePort,
  type WorkspaceSearchMigrationSourceEvidenceAwsRequest,
  type WorkspaceSearchMigrationSourceEvidenceAwsTransport,
  type WorkspaceSearchMigrationSourceEvidenceScanner,
} from './migration-source-evidence-aws'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
  type WorkspaceSearchMigrationSourceEvidencePurpose,
} from './migration-source-evidence'
import type {
  WorkspaceSearchMigrationSourceScanReadInput,
} from './migration-source-scan-aws'
import {
  reduceWorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPage,
  type WorkspaceSearchMigrationSourceScanPageResult,
} from './migration-source-scan-page'

/** One transaction failure injected before or after the atomic write. */
type TransactionFault = {
  /** Whether the fake applies the transaction before throwing. */
  readonly timing: 'after-commit' | 'before-commit'
  /** Arbitrary raw failure that must not escape the adapter boundary. */
  readonly error: unknown
  /** Optional concurrent work run after the atomic commit and before failure. */
  readonly afterCommit?: () => Promise<void>
}

/** One pending source Scan owned by the concurrency test. */
type PendingSourceScan = {
  /** Detached exact Scan input observed by the fake. */
  readonly input: WorkspaceSearchMigrationSourceScanReadInput
  /** Resolves the pending Scan with one reduced page. */
  readonly resolve: (
    value: WorkspaceSearchMigrationSourceScanPageResult,
  ) => void
  /** Rejects the pending Scan with an arbitrary raw failure. */
  readonly reject: (reason: unknown) => void
}

/**
 * Condition-aware in-memory implementation of the narrow DynamoDB transport.
 */
class InMemorySourceEvidenceAwsTransport
  implements WorkspaceSearchMigrationSourceEvidenceAwsTransport {
  /** Every strongly consistent point-read command in call order. */
  readonly getCommands: GetItemCommand[] = []

  /** Every attempted atomic page/head transaction in call order. */
  readonly transactionCommands: TransactWriteItemsCommand[] = []

  /** Durable low-level rows keyed by deterministic recordKey. */
  private readonly items =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** One-shot raw GetItem failure. */
  private getFailure: unknown

  /** One-shot transaction failure and commit timing. */
  private transactionFault: TransactionFault | undefined

  /**
   * Injects one raw read failure.
   *
   * @param error - Arbitrary value thrown by the next GetItem.
   */
  failNextGet(error: unknown): void {
    this.getFailure = error
  }

  /**
   * Injects one raw transaction failure.
   *
   * @param fault - Failure value and whether the write commits first.
   */
  failNextTransaction(fault: TransactionFault): void {
    this.transactionFault = fault
  }

  /**
   * Returns detached durable items for assertions.
   *
   * @returns Current atomic page and head records.
   */
  readStoredItems(): readonly Readonly<Record<string, AttributeValue>>[] {
    return [...this.items.values()].map((item) => structuredClone(item))
  }

  /**
   * Replaces one existing durable item with an exact test-owned fixture.
   *
   * @param item - Complete low-level row carrying its deterministic record key.
   */
  replaceStoredItem(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    const recordKey = readStringAttribute(item, 'recordKey')
    if (!this.items.has(recordKey)) {
      throw new Error('Expected one existing durable item.')
    }
    this.items.set(recordKey, structuredClone(item))
  }

  /**
   * Strongly reads one exact deterministic evidence record.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Detached low-level item when it exists.
   */
  async getSourceEvidence(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> {
    this.getCommands.push(command)
    if (this.getFailure !== undefined) {
      const error = this.getFailure
      this.getFailure = undefined
      throw error
    }
    const recordKey = readCommandRecordKey(command)
    const item = this.items.get(recordKey)
    return {
      $metadata: {},
      ...(item === undefined ? {} : { Item: structuredClone(item) }),
    }
  }

  /**
   * Evaluates both Put conditions before atomically installing both rows.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Empty successful DynamoDB response.
   */
  async transactWriteSourceEvidence(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> {
    this.transactionCommands.push(command)
    const fault = this.transactionFault
    this.transactionFault = undefined
    if (fault?.timing === 'before-commit') throw fault.error

    this.applyTransaction(command)
    if (fault?.timing === 'after-commit') {
      await fault.afterCommit?.()
      throw fault.error
    }
    return { $metadata: {} }
  }

  /**
   * Applies one page/head transaction with a condition-aware atomic boundary.
   *
   * @param command - Exact two-Put transaction.
   */
  private applyTransaction(command: TransactWriteItemsCommand): void {
    const entries = command.input.TransactItems
    const pagePut = entries?.[0]?.Put
    const headPut = entries?.[1]?.Put
    const pageItem = pagePut?.Item
    const headItem = headPut?.Item
    if (
      entries?.length !== 2 ||
      pagePut === undefined ||
      headPut === undefined ||
      pageItem === undefined ||
      headItem === undefined
    ) {
      throw new Error('Expected one atomic page/head transaction.')
    }
    const pageRecordKey = readStringAttribute(pageItem, 'recordKey')
    const headRecordKey = readStringAttribute(headItem, 'recordKey')
    const currentPage = this.items.get(pageRecordKey)
    const currentHead = this.items.get(headRecordKey)
    const pageIsAbsent = currentPage === undefined
    const headMatches = headPut.ExpressionAttributeValues === undefined
      ? currentHead === undefined
      : currentHead !== undefined &&
        conditionValuesMatch(
          currentHead,
          headPut.ExpressionAttributeNames,
          headPut.ExpressionAttributeValues,
        )
    if (!pageIsAbsent || !headMatches) {
      throw new Error('ConditionalCheckFailed')
    }

    this.items.set(pageRecordKey, structuredClone(pageItem))
    this.items.set(headRecordKey, structuredClone(headItem))
  }
}

/**
 * Reduces a fixed sequence of exact source pages as the adapter requests them.
 */
class SequencedSourceEvidenceScanner
  implements WorkspaceSearchMigrationSourceEvidenceScanner {
  /** Every detached Scan input received from the adapter. */
  readonly inputs: WorkspaceSearchMigrationSourceScanReadInput[] = []

  /** Exact pages returned in sequence. */
  private readonly pages: readonly WorkspaceSearchMigrationSourceScanPage[]

  /**
   * Creates a scanner with a finite page sequence.
   *
   * @param pages - Exact low-level source pages.
   */
  constructor(
    pages: readonly WorkspaceSearchMigrationSourceScanPage[],
  ) {
    this.pages = pages
  }

  /**
   * Reduces the next page against the adapter-owned predecessor checkpoint.
   *
   * @param input - Measured source context and durable predecessor.
   * @returns Bound digest-only page result.
   */
  async scanSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPageResult> {
    const index = this.inputs.length
    this.inputs.push(structuredClone(input))
    const page = this.pages[index]
    if (page === undefined) {
      throw new Error('The scanner was called after its terminal page.')
    }
    return reduceWorkspaceSearchMigrationSourceScanPage({
      ...input,
      page: structuredClone(page),
    })
  }
}

/**
 * Holds source Scans until a concurrency test supplies each exact result.
 */
class DeferredSourceEvidenceScanner
  implements WorkspaceSearchMigrationSourceEvidenceScanner {
  /** Every pending Scan, in invocation order. */
  private readonly pending: PendingSourceScan[] = []

  /**
   * Returns the number of adapter calls waiting for resolution.
   *
   * @returns Pending Scan count.
   */
  pendingCount(): number {
    return this.pending.length
  }

  /**
   * Records one pending source Scan.
   *
   * @param input - Measured source context and durable predecessor.
   * @returns Promise resolved explicitly by the test.
   */
  scanSourcePage(
    input: WorkspaceSearchMigrationSourceScanReadInput,
  ): Promise<WorkspaceSearchMigrationSourceScanPageResult> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        input: structuredClone(input),
        resolve,
        reject,
      })
    })
  }

  /**
   * Resolves one pending Scan by reducing an exact page against its predecessor.
   *
   * @param index - Pending invocation index.
   * @param page - Exact low-level page supplied to that invocation.
   */
  resolvePage(
    index: number,
    page: WorkspaceSearchMigrationSourceScanPage,
  ): void {
    const pending = this.pending[index]
    if (pending === undefined) {
      throw new Error('Expected one pending source Scan.')
    }
    pending.resolve(reduceWorkspaceSearchMigrationSourceScanPage({
      ...pending.input,
      page: structuredClone(page),
    }))
  }

  /**
   * Rejects one pending Scan with an arbitrary raw failure.
   *
   * @param index - Pending invocation index.
   * @param error - Raw failure supplied to the adapter boundary.
   */
  rejectScan(index: number, error: unknown): void {
    const pending = this.pending[index]
    if (pending === undefined) {
      throw new Error('Expected one pending source Scan.')
    }
    pending.reject(error)
  }
}

describe('Workspace Search migration source evidence AWS adapter', () => {
  test('resumes a multi-page chain and never rescans a terminal head', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const firstItem = createIgnoredProjectDirectoryItem('page-1')
    const firstScanner = new SequencedSourceEvidenceScanner([{
      items: [firstItem],
      lastEvaluatedKey: createProjectDirectoryItemKey(firstItem),
    }])
    const firstPort = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner: firstScanner,
      transport,
    })

    const first = await firstPort.commitNextPage(request)
    expect(first).toMatchObject({
      pageSequence: 1,
      checkpoint: {
        completed: false,
        aggregate: {
          ignored: 1,
          pageCount: 1,
          scanned: 1,
        },
      },
    })

    const secondScanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('page-2')],
    }])
    const resumedPort = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner: secondScanner,
      transport,
    })
    const durableBeforeResume = await resumedPort.readProgress(request)
    expect(durableBeforeResume).toEqual(first)

    const completed = await resumedPort.commitNextPage(request)
    const transactionCount = transport.transactionCommands.length
    const scannerCount = secondScanner.inputs.length
    const repeated = await resumedPort.commitNextPage(request)
    const replay = await resumedPort.readCommittedEvidence(request)

    expect(secondScanner.inputs[0]?.previousCheckpoint).toEqual(
      first.checkpoint,
    )
    expect(completed).toMatchObject({
      pageSequence: 2,
      checkpoint: {
        completed: true,
        aggregate: {
          ignored: 2,
          pageCount: 2,
          scanned: 2,
        },
      },
    })
    expect(repeated).toEqual(completed)
    expect(replay.progress).toEqual(completed)
    expect(replay.sourceRows).toHaveLength(2)
    expect(replay.invalidRows).toHaveLength(0)
    expect(replay.sourceBindings).toHaveLength(0)
    expect(secondScanner.inputs).toHaveLength(scannerCount)
    expect(transport.transactionCommands).toHaveLength(transactionCount)
    expect(transport.readStoredItems()).toHaveLength(3)
  })

  test('atomically puts one immutable page and an exact CAS head', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const firstItem = createIgnoredProjectDirectoryItem('conditions-1')
    const scanner = new SequencedSourceEvidenceScanner([
      {
        items: [firstItem],
        lastEvaluatedKey: createProjectDirectoryItemKey(firstItem),
      },
      {
        items: [createIgnoredProjectDirectoryItem('conditions-2')],
      },
    ])
    const port = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner,
      transport,
    })

    await port.commitNextPage(request)
    await port.commitNextPage(request)

    const firstCommand = transport.transactionCommands[0]
    const secondCommand = transport.transactionCommands[1]
    const firstEntries = firstCommand?.input.TransactItems
    const secondEntries = secondCommand?.input.TransactItems
    const firstPagePut = firstEntries?.[0]?.Put
    const firstHeadPut = firstEntries?.[1]?.Put
    const secondPagePut = secondEntries?.[0]?.Put
    const secondHeadPut = secondEntries?.[1]?.Put

    expect(firstCommand).toBeInstanceOf(TransactWriteItemsCommand)
    expect(firstEntries).toHaveLength(2)
    expect(firstPagePut?.TableName)
      .toBe(configuration.tables['migration-state'].tableName)
    expect(firstHeadPut?.TableName)
      .toBe(configuration.tables['migration-state'].tableName)
    expect(firstPagePut?.ConditionExpression)
      .toBe(
        'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
      )
    expect(firstHeadPut?.ConditionExpression)
      .toBe(
        'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
      )
    expect(readStringAttribute(
      requireItem(firstPagePut?.Item),
      'kind',
    )).toBe('workspace-search-migration-source-evidence-page-record')
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'kind',
    )).toBe('workspace-search-migration-source-evidence-head')
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'purpose',
    )).toBe('planning')
    expect(readStringAttribute(
      requireItem(firstHeadPut?.Item),
      'source',
    )).toBe('project-directory')

    expect(secondPagePut?.ConditionExpression)
      .toBe(firstPagePut?.ConditionExpression)
    expect(secondHeadPut?.ConditionExpression).toContain('#revision = :revision')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#checkpointDigest = :checkpointDigest')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#headDigest = :headDigest')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#purpose = :purpose')
    expect(secondHeadPut?.ConditionExpression)
      .toContain('#sourceTableId = :sourceTableId')
    expect(secondHeadPut?.ExpressionAttributeValues).toMatchObject({
      ':revision': { N: '1' },
      ':purpose': { S: 'planning' },
      ':source': { S: 'project-directory' },
      ':sourceTableId': { S: 'table-id-project-directory' },
      ':stateTableId': { S: 'table-id-migration-state' },
      ':completed': { BOOL: false },
    })
    expect(firstCommand?.input.ClientRequestToken).toMatch(/^wsm1-[0-9a-f]{31}$/)
    expect(secondCommand?.input.ClientRequestToken)
      .toMatch(/^wsm1-[0-9a-f]{31}$/)
    expect(firstCommand?.input.ClientRequestToken)
      .not.toBe(secondCommand?.input.ClientRequestToken)
  })

  test('reconciles an exact commit after transaction response loss', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const scanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('response-loss')],
    }])
    const port = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner,
      transport,
    })
    const timeout = new Error('RAW-TRANSACTION-CANARY')
    timeout.name = 'TimeoutError'
    transport.failNextTransaction({
      timing: 'after-commit',
      error: timeout,
    })

    const result = await port.commitNextPage(request)

    expect(result).toMatchObject({
      pageSequence: 1,
      checkpoint: {
        completed: true,
        aggregate: { pageCount: 1, scanned: 1 },
      },
    })
    expect(transport.transactionCommands).toHaveLength(1)
    expect(transport.getCommands).toHaveLength(4)
    expect(transport.readStoredItems()).toHaveLength(2)
    expect(await port.readProgress(request)).toEqual(result)
  })

  test('reconciles an intended page after the durable head advances', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const firstItem = createIgnoredProjectDirectoryItem(
      'response-loss-advanced-1',
    )
    const firstPort = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner: new SequencedSourceEvidenceScanner([{
        items: [firstItem],
        lastEvaluatedKey: createProjectDirectoryItemKey(firstItem),
      }]),
      transport,
    })
    const advancingPort =
      createAwsWorkspaceSearchMigrationSourceEvidencePort({
        stateTableName: configuration.tables['migration-state'].tableName,
        scanner: new SequencedSourceEvidenceScanner([{
          items: [
            createIgnoredProjectDirectoryItem(
              'response-loss-advanced-2',
            ),
          ],
        }]),
        transport,
      })
    let advancedPageSequence = 0
    const timeout = new Error('RAW-ADVANCED-TRANSACTION-CANARY')
    timeout.name = 'TimeoutError'
    transport.failNextTransaction({
      timing: 'after-commit',
      error: timeout,
      afterCommit: async () => {
        const advanced = await advancingPort.commitNextPage(request)
        advancedPageSequence = advanced.pageSequence
      },
    })

    const recovered = await firstPort.commitNextPage(request)
    const durable = await firstPort.readProgress(request)

    expect(recovered).toMatchObject({
      pageSequence: 1,
      checkpoint: { completed: false },
    })
    expect(advancedPageSequence).toBe(2)
    expect(durable).toMatchObject({
      pageSequence: 2,
      checkpoint: {
        completed: true,
        aggregate: { pageCount: 2, scanned: 2 },
      },
    })
    expect(transport.transactionCommands).toHaveLength(2)
    expect(transport.readStoredItems()).toHaveLength(3)
  })

  test('rejects a terminal page that duplicates an earlier source key', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const duplicateItem =
      createIgnoredProjectDirectoryItem('cross-page-duplicate')
    const scanner = new SequencedSourceEvidenceScanner([
      {
        items: [duplicateItem],
        lastEvaluatedKey: createProjectDirectoryItemKey(duplicateItem),
      },
      {
        items: [duplicateItem],
      },
    ])
    const port = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner,
      transport,
    })

    const first = await port.commitNextPage(request)
    const failure = await captureMigrationFailure(
      () => port.commitNextPage(request),
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.transactionCommands).toHaveLength(1)
    expect(transport.readStoredItems()).toHaveLength(2)
    expect(await port.readProgress(request)).toEqual(first)
  })

  test('rejects an over-limit captured head before reading page records', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transport = new InMemorySourceEvidenceAwsTransport()
    const port = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner: new SequencedSourceEvidenceScanner([{
        items: [createIgnoredProjectDirectoryItem('over-limit')],
      }]),
      transport,
    })
    const completed = await port.commitNextPage(request)
    const head = transport.readStoredItems().find(
      (item) =>
        readStringAttribute(item, 'kind') ===
          'workspace-search-migration-source-evidence-head',
    )
    if (head === undefined) throw new Error('Expected one durable head.')
    const checkpointMap = readMapAttribute(head, 'checkpoint')
    const aggregateMap = readMapAttribute(checkpointMap, 'aggregate')
    const pageCount = 10_001
    const overLimitCheckpoint = {
      ...completed.checkpoint,
      aggregate: {
        ...completed.checkpoint.aggregate,
        pageCount,
      },
    }
    transport.replaceStoredItem({
      ...head,
      revision: { N: String(pageCount) },
      checkpointDigest: {
        S: createWorkspaceSearchMigrationSourceCheckpointDigest(
          overLimitCheckpoint,
        ),
      },
      checkpoint: {
        M: {
          ...checkpointMap,
          aggregate: {
            M: {
              ...aggregateMap,
              pageCount: { N: String(pageCount) },
            },
          },
        },
      },
    })
    const readsBeforeReplay = transport.getCommands.length

    const failure = await captureMigrationFailure(
      () => port.readCommittedEvidence(request),
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.getCommands).toHaveLength(readsBeforeReplay + 1)
  })

  test('reconciles identical concurrent successors and rejects a different one', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const sharedPage: WorkspaceSearchMigrationSourceScanPage = {
      items: [createIgnoredProjectDirectoryItem('same-successor')],
    }
    const identicalTransport = new InMemorySourceEvidenceAwsTransport()
    const identicalScanner = new DeferredSourceEvidenceScanner()
    const identicalPort =
      createAwsWorkspaceSearchMigrationSourceEvidencePort({
        stateTableName: configuration.tables['migration-state'].tableName,
        scanner: identicalScanner,
        transport: identicalTransport,
      })

    const identicalFirst = identicalPort.commitNextPage(request)
    const identicalSecond = identicalPort.commitNextPage(request)
    await waitForPendingScans(identicalScanner, 2)
    identicalScanner.resolvePage(0, sharedPage)
    const firstResult = await identicalFirst
    identicalScanner.resolvePage(1, sharedPage)
    const secondResult = await identicalSecond

    expect(secondResult).toEqual(firstResult)
    expect(identicalTransport.transactionCommands).toHaveLength(2)
    expect(identicalTransport.readStoredItems()).toHaveLength(2)

    const differentTransport = new InMemorySourceEvidenceAwsTransport()
    const differentScanner = new DeferredSourceEvidenceScanner()
    const differentPort =
      createAwsWorkspaceSearchMigrationSourceEvidencePort({
        stateTableName: configuration.tables['migration-state'].tableName,
        scanner: differentScanner,
        transport: differentTransport,
      })
    const differentFirst = differentPort.commitNextPage(request)
    const differentSecond = differentPort.commitNextPage(request)
    await waitForPendingScans(differentScanner, 2)
    differentScanner.resolvePage(0, {
      items: [createIgnoredProjectDirectoryItem('winner')],
    })
    await differentFirst
    differentScanner.resolvePage(1, {
      items: [createIgnoredProjectDirectoryItem('loser')],
    })
    const failure = await captureMigrationFailure(
      () => differentSecond,
    )

    expect(failure.code).toBe('AMBIGUOUS_OPERATION_UNRESOLVED')
    expect(failure.message).not.toContain('winner')
    expect(failure.message).not.toContain('loser')
    expect(differentTransport.readStoredItems()).toHaveLength(2)
  })

  test('classifies transient failures and redacts every raw error', async () => {
    const configuration = createConfiguration()
    const request = createRequest(configuration)
    const transientTransport = new InMemorySourceEvidenceAwsTransport()
    const transientScanner = new SequencedSourceEvidenceScanner([{
      items: [createIgnoredProjectDirectoryItem('transient')],
    }])
    const transientPort =
      createAwsWorkspaceSearchMigrationSourceEvidencePort({
        stateTableName: configuration.tables['migration-state'].tableName,
        scanner: transientScanner,
        transport: transientTransport,
      })
    const timeout = new Error('RAW-TIMEOUT-CANARY')
    timeout.name = 'TimeoutError'
    transientTransport.failNextTransaction({
      timing: 'before-commit',
      error: timeout,
    })

    const transientFailure = await captureMigrationFailure(
      () => transientPort.commitNextPage(request),
    )
    expect(transientFailure).toMatchObject({
      code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      message:
        'Workspace Search source evidence stopped safely (TRANSIENT_INFRASTRUCTURE_FAILURE).',
    })
    expect(transientFailure.message).not.toContain('RAW-TIMEOUT-CANARY')
    expect(transientTransport.readStoredItems()).toHaveLength(0)

    const rawTransport = new InMemorySourceEvidenceAwsTransport()
    const rawScanner = new DeferredSourceEvidenceScanner()
    const rawPort = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner: rawScanner,
      transport: rawTransport,
    })
    const pending = rawPort.commitNextPage(request)
    await waitForPendingScans(rawScanner, 1)
    rawScanner.rejectScan(
      0,
      new WorkspaceSearchMigrationFailure(
        'IDENTITY_MISMATCH',
        'RAW-SCANNER-CANARY',
      ),
    )
    const rawFailure = await captureMigrationFailure(() => pending)
    expect(rawFailure).toMatchObject({
      code: 'IDENTITY_MISMATCH',
      message:
        'Workspace Search source evidence stopped safely (IDENTITY_MISMATCH).',
    })
    expect(rawFailure.message).not.toContain('RAW-SCANNER-CANARY')

    const forgedCodeCanary = 'RAW-FORGED-CODE-CANARY'
    const forgedFailure = new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      'fixed test failure',
    )
    Object.defineProperty(forgedFailure, 'code', {
      value: forgedCodeCanary,
    })
    const forgedScanner = new DeferredSourceEvidenceScanner()
    const forgedPort = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner: forgedScanner,
      transport: new InMemorySourceEvidenceAwsTransport(),
    })
    const forgedPending = forgedPort.commitNextPage(request)
    await waitForPendingScans(forgedScanner, 1)
    forgedScanner.rejectScan(0, forgedFailure)
    const forgedCodeFailure = await captureMigrationFailure(
      () => forgedPending,
    )
    expect(forgedCodeFailure).toMatchObject({
      code: 'INVALID_STATE',
      message:
        'Workspace Search source evidence stopped safely (INVALID_STATE).',
    })
    expect(forgedCodeFailure.message).not.toContain(forgedCodeCanary)

    const readTransport = new InMemorySourceEvidenceAwsTransport()
    const readPort = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner: new SequencedSourceEvidenceScanner([]),
      transport: readTransport,
    })
    readTransport.failNextGet(new Error('RAW-GET-CANARY'))
    const readFailure = await captureMigrationFailure(
      () => readPort.readProgress(request),
    )
    expect(readFailure.code).toBe('INVALID_STATE')
    expect(readFailure.message).not.toContain('RAW-GET-CANARY')
  })

  test('isolates every dry-run and planning source chain', async () => {
    const configuration = createConfiguration()
    const purposes: readonly WorkspaceSearchMigrationSourceEvidencePurpose[] = [
      'dry-run',
      'planning',
    ]
    const transport = new InMemorySourceEvidenceAwsTransport()
    const scanner = new SequencedSourceEvidenceScanner(
      purposes.flatMap(() =>
        workspaceSearchMigrationSourceNames.map(() => ({ items: [] }))
      ),
    )
    const port = createAwsWorkspaceSearchMigrationSourceEvidencePort({
      stateTableName: configuration.tables['migration-state'].tableName,
      scanner,
      transport,
    })
    const committedKeys = new Set<string>()

    for (const purpose of purposes) {
      for (const source of workspaceSearchMigrationSourceNames) {
        const request = createRequest(
          configuration,
          purpose,
          source,
          'run-purpose-isolation',
        )
        const result = await port.commitNextPage(request)
        expect(result).toMatchObject({
          purpose,
          source,
          pageSequence: 1,
          checkpoint: { completed: true },
        })
        const command = transport.transactionCommands.at(-1)
        const entries = command?.input.TransactItems
        const pageKey = readStringAttribute(
          requireItem(entries?.[0]?.Put?.Item),
          'recordKey',
        )
        const headItem = requireItem(entries?.[1]?.Put?.Item)
        const headKey = readStringAttribute(headItem, 'recordKey')
        expect(readStringAttribute(headItem, 'purpose')).toBe(purpose)
        expect(readStringAttribute(headItem, 'source')).toBe(source)
        committedKeys.add(pageKey)
        committedKeys.add(headKey)
      }
    }

    expect(committedKeys).toHaveLength(16)
    expect(transport.readStoredItems()).toHaveLength(16)
    expect(scanner.inputs).toHaveLength(8)

    for (const purpose of purposes) {
      for (const source of workspaceSearchMigrationSourceNames) {
        const progress = await port.readProgress(createRequest(
          configuration,
          purpose,
          source,
          'run-purpose-isolation',
        ))
        expect(progress).toMatchObject({
          purpose,
          source,
          pageSequence: 1,
          checkpoint: { completed: true },
        })
      }
    }
  })
})

/**
 * Creates a complete evidence request for one purpose and source.
 *
 * @param configuration - Exact measured migration configuration.
 * @param purpose - Independent dry-run or planning chain.
 * @param source - Fixed source-table role.
 * @param runId - Operator-selected run identifier.
 * @returns Complete adapter request.
 */
function createRequest(
  configuration: WorkspaceSearchMigrationConfiguration,
  purpose: WorkspaceSearchMigrationSourceEvidencePurpose = 'planning',
  source: WorkspaceSearchMigrationSourceName = 'project-directory',
  runId = 'run-source-evidence',
): WorkspaceSearchMigrationSourceEvidenceAwsRequest {
  return {
    runId,
    purpose,
    configuration,
    configurationHash:
      createWorkspaceSearchConfigurationHash(configuration),
    source,
  }
}

/**
 * Waits a bounded number of microtasks for concurrent Scans to be recorded.
 *
 * @param scanner - Deferred scanner under test.
 * @param expected - Required pending invocation count.
 */
async function waitForPendingScans(
  scanner: DeferredSourceEvidenceScanner,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (scanner.pendingCount() >= expected) return
    await Promise.resolve()
  }
  throw new Error('Timed out waiting for pending source Scans.')
}

/**
 * Captures one public fixed-code migration failure.
 *
 * @param operation - Asynchronous adapter call expected to fail.
 * @returns Exact public failure.
 */
async function captureMigrationFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (error instanceof WorkspaceSearchMigrationFailure) return error
  }
  throw new Error('Expected a Workspace Search migration failure.')
}

/**
 * Reads the deterministic record key from one GetItem command.
 *
 * @param command - Adapter-owned strongly consistent read.
 * @returns Exact state-table sort key.
 */
function readCommandRecordKey(command: GetItemCommand): string {
  const key = command.input.Key
  if (key === undefined) throw new Error('Expected one GetItem key.')
  return readStringAttribute(key, 'recordKey')
}

/**
 * Requires one optional transaction item for test inspection.
 *
 * @param item - Candidate low-level DynamoDB item.
 * @returns Complete item.
 */
function requireItem(
  item: Record<string, AttributeValue> | undefined,
): Record<string, AttributeValue> {
  if (item === undefined) {
    throw new Error('Expected one complete transaction item.')
  }
  return item
}

/**
 * Reads one exact string attribute from a low-level item.
 *
 * @param item - Low-level DynamoDB item.
 * @param name - Required attribute name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = item[name]
  if (
    attribute === undefined ||
    attribute.S === undefined ||
    Object.keys(attribute).length !== 1
  ) {
    throw new Error(`Expected exact string attribute ${name}.`)
  }
  return attribute.S
}

/**
 * Reads one exact map attribute from a low-level item.
 *
 * @param item - Low-level DynamoDB item or nested map.
 * @param name - Required attribute name.
 * @returns Exact nested attribute map.
 */
function readMapAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Readonly<Record<string, AttributeValue>> {
  const attribute = item[name]
  if (
    attribute === undefined ||
    attribute.M === undefined ||
    Object.keys(attribute).length !== 1
  ) {
    throw new Error(`Expected exact map attribute ${name}.`)
  }
  return attribute.M
}

/**
 * Checks every expression value against the corresponding current attribute.
 *
 * @param current - Current durable head.
 * @param names - Expression attribute-name aliases.
 * @param values - Expected predecessor values.
 * @returns Whether the exact predecessor CAS matches.
 */
function conditionValuesMatch(
  current: Readonly<Record<string, AttributeValue>>,
  names: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, AttributeValue>>,
): boolean {
  if (names === undefined) return false
  for (const [valueToken, expected] of Object.entries(values)) {
    const nameToken = `#${valueToken.slice(1)}`
    const attributeName = names[nameToken]
    const actual = attributeName === undefined
      ? undefined
      : current[attributeName]
    if (
      actual === undefined ||
      !attributeValuesEqual(actual, expected)
    ) {
      return false
    }
  }
  return true
}

/**
 * Compares two low-level values including binary content.
 *
 * @param left - Current durable value.
 * @param right - Exact condition operand.
 * @returns Whether their detached structures match.
 */
function attributeValuesEqual(
  left: AttributeValue,
  right: AttributeValue,
): boolean {
  return Bun.deepEquals(structuredClone(left), structuredClone(right))
}

/**
 * Creates one recognized non-target Project Directory item.
 *
 * @param identifier - Unique physical key suffix.
 * @returns Exact low-level ignored source item.
 */
function createIgnoredProjectDirectoryItem(
  identifier: string,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: `WORKSPACE_MEMBER#${identifier}` },
    entryType: { S: 'workspace-member' },
    payload: { S: 'fixture' },
  }
}

/**
 * Extracts the exact Project Directory key from one fixture item.
 *
 * @param item - Complete source item.
 * @returns Detached composite primary key.
 */
function createProjectDirectoryItemKey(
  item: DynamoAttributeMap,
): DynamoAttributeMap {
  const directoryId = item.directoryId
  const entryKey = item.entryKey
  if (directoryId === undefined || entryKey === undefined) {
    throw new Error('Expected a complete Project Directory key.')
  }
  return structuredClone({ directoryId, entryKey })
}

/**
 * Creates a complete measured migration configuration.
 *
 * @returns Exact configuration bound to every test request.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
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
      'workspace-search': createSupportTable('workspace-search'),
      'migration-state': createSupportTable('migration-state'),
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
 * Creates one complete measured source table identity.
 *
 * @param role - Logical source role.
 * @returns Stable source identity fixture.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
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
    key: sourceKeyDescriptors(role),
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: false,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? createMigrationDigest('documents-key')
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
 * Creates one complete target or state table identity.
 *
 * @param role - Non-source migration table role.
 * @returns Stable supporting table identity fixture.
 */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
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
    key: role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest(`${role}-key`),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns the exact measured key schema for one source role.
 *
 * @param role - Logical source role.
 * @returns Ordered partition and optional sort key descriptors.
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
