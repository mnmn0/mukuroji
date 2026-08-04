import {
  type AttributeValue,
  type QueryCommand,
  type QueryCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  MigrationDigestAccumulator,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationApplyAuditBindingInput,
  WorkspaceSearchMigrationApplyAuthorityAuditRecord,
  WorkspaceSearchMigrationApplyMarkerAuditRecord,
} from './migration-apply-operation-aws'
import {
  createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity,
  createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
} from './migration-execution-authority-adoption'
import {
  collectWorkspaceSearchMigrationRehearsalReconciliationAws,
  type CollectWorkspaceSearchMigrationRehearsalReconciliationAwsInput,
  type WorkspaceSearchMigrationRehearsalExpectedAuthority,
  type WorkspaceSearchMigrationRehearsalExpectedMarker,
  type WorkspaceSearchMigrationRehearsalReconciliationAwsGuards,
  type WorkspaceSearchMigrationRehearsalReconciliationAwsLimits,
  type WorkspaceSearchMigrationRehearsalReconciliationAwsTransport,
  type WorkspaceSearchMigrationRehearsalReconciliationRowParsers,
  type WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_AUTHORITY_ADOPTION_KEY_PREFIX,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX,
} from './migration-rehearsal-reconciliation-aws'

const checkedAt = '2026-08-02T03:00:00.000Z'
const runId = 'reconciliation-aws-test'
const stateTableName = 'migration-state-table'

describe('migration rehearsal reconciliation AWS collector', () => {
  test('queries both prefixes strongly, paginates, filters foreign runs, and clears raw buffers', async () => {
    const markerKey =
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}001`
    const foreignKey =
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}000`
    const authorityKey =
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_AUTHORITY_ADOPTION_KEY_PREFIX}001`
    const markerDigest = digest('marker-1')
    const markerRecord = createMarkerRecord(
      markerKey,
      'operation-1',
      1,
      digest('plan-operation-1'),
      markerDigest,
    )
    const authorityRecord = createAuthorityRecord(authorityKey, 1)
    const expectedMarkers = [expectedMarker(markerRecord)]
    const expectedAuthorities = [expectedAuthority(authorityRecord)]
    const foreignBuffer = new Uint8Array([1, 2, 3])
    const markerBuffer = new Uint8Array([4, 5, 6])
    const authorityBuffer = new Uint8Array([7, 8, 9])
    const pages = [
      queryPage([queryItem(foreignKey, foreignBuffer)], foreignKey),
      queryPage([queryItem(markerKey, markerBuffer)]),
      queryPage([queryItem(authorityKey, authorityBuffer)]),
    ]
    const commands: QueryCommand[] = []
    const requestSignals: AbortSignal[] = []
    const parserBindings: WorkspaceSearchMigrationApplyAuditBindingInput[] = []
    const terminal = terminalBinding(expectedMarkers.length)
    const guardCounts = { terminal: 0, incarnations: 0 }
    const input = collectorInput({
      expectedMarkers,
      expectedMarkerAggregateDigest: aggregateDigest(markerDigest),
      expectedAuthorities,
      terminal,
      parsers: rowParsers(
        new Map([[markerKey, markerRecord]]),
        new Map([[authorityKey, authorityRecord]]),
        parserBindings,
      ),
      transport: queuedTransport(pages, commands, requestSignals),
      guards: stableGuards(terminal, guardCounts),
    })

    const result = await
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(input)

    expect(result.markerSummary).toEqual({
      expectedCount: 1,
      expectedAggregateDigest: aggregateDigest(markerDigest),
      observedCount: 1,
      observedAggregateDigest: aggregateDigest(markerDigest),
      matchedCount: 1,
      duplicateCount: 0,
      missingCount: 0,
      unexpectedCount: 0,
    })
    expect(result.authoritySummary).toMatchObject({
      expectedCount: 1,
      observedCount: 1,
      matchedCount: 1,
      missingCount: 0,
      orphanCount: 0,
    })
    expect(result.authoritySummary.observedChainDigest).toBe(
      result.authoritySummary.expectedChainDigest,
    )
    expect(commands.map((command) => command.input)).toEqual([
      expectedQueryInput(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX,
      ),
      expectedQueryInput(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX,
        foreignKey,
      ),
      expectedQueryInput(
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_AUTHORITY_ADOPTION_KEY_PREFIX,
      ),
    ])
    expect(requestSignals).toHaveLength(3)
    expect(requestSignals.every((signal) => !signal.aborted)).toBe(true)
    expect(guardCounts).toEqual({ terminal: 8, incarnations: 8 })
    expect(parserBindings.length).toBe(3)
    expect(parserBindings[0]).not.toBe(input.auditBinding)
    expect([...foreignBuffer]).toEqual([0, 0, 0])
    expect([...markerBuffer]).toEqual([0, 0, 0])
    expect([...authorityBuffer]).toEqual([0, 0, 0])
  })

  test('classifies duplicate, missing, and unexpected marker rows from strict projections', async () => {
    const firstPlanDigest = digest('plan-operation-1')
    const secondPlanDigest = digest('plan-operation-2')
    const firstMarkerDigest = digest('marker-1')
    const secondExpectedMarkerDigest = digest('marker-2-expected')
    const keys = [1, 2, 3].map((position) =>
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}00${position}`
    )
    const first = createMarkerRecord(
      keys[0] ?? '',
      'operation-1',
      1,
      firstPlanDigest,
      firstMarkerDigest,
    )
    const duplicate = createMarkerRecord(
      keys[1] ?? '',
      'operation-1',
      1,
      firstPlanDigest,
      digest('marker-1-duplicate'),
    )
    const unexpected = createMarkerRecord(
      keys[2] ?? '',
      'operation-unexpected',
      99,
      digest('unexpected-plan-operation'),
      digest('marker-unexpected'),
    )
    const expectedMarkers: readonly WorkspaceSearchMigrationRehearsalExpectedMarker[] = [
      expectedMarker(first),
      {
        operationId: 'operation-2',
        planSequence: 2,
        planOperationDigest: secondPlanDigest,
      },
    ]
    const records = new Map([
      [first.recordKey, first],
      [duplicate.recordKey, duplicate],
      [unexpected.recordKey, unexpected],
    ])
    const terminal = terminalBinding(expectedMarkers.length)
    const result = await
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(
        collectorInput({
          expectedMarkers,
          expectedMarkerAggregateDigest: aggregateDigest(
            firstMarkerDigest,
            secondExpectedMarkerDigest,
          ),
          expectedAuthorities: [],
          terminal,
          parsers: rowParsers(records, new Map()),
          transport: queuedTransport([
            queryPage(keys.map((key) => queryItem(key))),
            queryPage([]),
          ]),
          guards: stableGuards(
            terminal,
            { terminal: 0, incarnations: 0 },
          ),
        }),
      )

    expect(result.markerSummary).toMatchObject({
      expectedCount: 2,
      observedCount: 3,
      matchedCount: 1,
      duplicateCount: 1,
      missingCount: 1,
      unexpectedCount: 1,
    })
  })

  test('counts strict foreign-run rows against resource budgets and clears every received buffer', async () => {
    const foreignKey =
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}000`
    const markerKey =
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}001`
    const markerRecord = createMarkerRecord(
      markerKey,
      'operation-1',
      1,
      digest('plan-operation-1'),
      digest('marker-1'),
    )
    const foreignBuffer = new Uint8Array([11, 12])
    const markerBuffer = new Uint8Array([13, 14])
    const terminal = terminalBinding(1)
    const input = collectorInput({
      expectedMarkers: [expectedMarker(markerRecord)],
      expectedMarkerAggregateDigest: aggregateDigest(markerRecord.markerDigest),
      expectedAuthorities: [],
      terminal,
      parsers: rowParsers(
        new Map([[markerKey, markerRecord]]),
        new Map(),
      ),
      transport: queuedTransport([
        queryPage([queryItem(foreignKey, foreignBuffer)], foreignKey),
        queryPage([queryItem(markerKey, markerBuffer)]),
      ]),
      guards: stableGuards(
        terminal,
        { terminal: 0, incarnations: 0 },
      ),
      limits: { maximumItems: 1 },
    })

    await expect(
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(input),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect([...foreignBuffer]).toEqual([0, 0])
    expect([...markerBuffer]).toEqual([0, 0])
  })

  test('rejects a cursor that is not the last returned row and clears the invalid page', async () => {
    const markerKey =
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}001`
    const wrongCursor =
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}002`
    const markerBuffer = new Uint8Array([21, 22])
    const markerRecord = createMarkerRecord(
      markerKey,
      'operation-1',
      1,
      digest('plan-operation-1'),
      digest('marker-1'),
    )
    const terminal = terminalBinding(1)
    const input = collectorInput({
      expectedMarkers: [expectedMarker(markerRecord)],
      expectedMarkerAggregateDigest: aggregateDigest(markerRecord.markerDigest),
      expectedAuthorities: [],
      terminal,
      parsers: rowParsers(
        new Map([[markerKey, markerRecord]]),
        new Map(),
      ),
      transport: queuedTransport([
        queryPage([queryItem(markerKey, markerBuffer)], wrongCursor),
      ]),
      guards: stableGuards(
        terminal,
        { terminal: 0, incarnations: 0 },
      ),
    })

    await expect(
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(input),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect([...markerBuffer]).toEqual([0, 0])
  })

  test('rejects a writer-owned projection whose record key differs from the Query row', async () => {
    const markerKey =
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}001`
    const markerRecord = createMarkerRecord(
      `${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_OPERATION_MARKER_KEY_PREFIX}other`,
      'operation-1',
      1,
      digest('plan-operation-1'),
      digest('marker-1'),
    )
    const markerBuffer = new Uint8Array([31])
    const terminal = terminalBinding(1)
    const input = collectorInput({
      expectedMarkers: [expectedMarker(markerRecord)],
      expectedMarkerAggregateDigest: aggregateDigest(markerRecord.markerDigest),
      expectedAuthorities: [],
      terminal,
      parsers: rowParsers(
        new Map([[markerKey, markerRecord]]),
        new Map(),
      ),
      transport: queuedTransport([
        queryPage([queryItem(markerKey, markerBuffer)]),
      ]),
      guards: stableGuards(
        terminal,
        { terminal: 0, incarnations: 0 },
      ),
    })

    await expect(
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(input),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect([...markerBuffer]).toEqual([0])
  })

  test('revalidates terminal identity after a Query transport failure', async () => {
    const terminal = terminalBinding(0)
    const guardCounts = { terminal: 0, incarnations: 0 }
    const transport: WorkspaceSearchMigrationRehearsalReconciliationAwsTransport = {
      queryStatePage: () => Promise.reject(new Error('raw transport failure')),
    }
    const input = collectorInput({
      expectedMarkers: [],
      expectedMarkerAggregateDigest: aggregateDigest(),
      expectedAuthorities: [],
      terminal,
      parsers: rowParsers(new Map(), new Map()),
      transport,
      guards: stableGuards(terminal, guardCounts),
    })

    await expect(
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(input),
    ).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    expect(guardCounts).toEqual({ terminal: 3, incarnations: 3 })
  })

  test('fails closed when the terminal binding changes before the first Query', async () => {
    const terminal = terminalBinding(0)
    const guardCounts = { terminal: 0, incarnations: 0 }
    const commands: QueryCommand[] = []
    const guards = changingTerminalGuards(terminal, guardCounts)
    const input = collectorInput({
      expectedMarkers: [],
      expectedMarkerAggregateDigest: aggregateDigest(),
      expectedAuthorities: [],
      terminal,
      parsers: rowParsers(new Map(), new Map()),
      transport: queuedTransport([queryPage([])], commands),
      guards,
    })

    await expect(
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(input),
    ).rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })
    expect(commands).toHaveLength(0)
    expect(guardCounts).toEqual({ terminal: 2, incarnations: 2 })
  })

  test('enforces a per-request timeout and aborts the request-local signal', async () => {
    const terminal = terminalBinding(0)
    const guardCounts = { terminal: 0, incarnations: 0 }
    let requestWasAborted = false
    const transport: WorkspaceSearchMigrationRehearsalReconciliationAwsTransport = {
      queryStatePage: (_command, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            requestWasAborted = true
            reject(new Error('request aborted'))
          }, { once: true })
        }),
    }
    const input = collectorInput({
      expectedMarkers: [],
      expectedMarkerAggregateDigest: aggregateDigest(),
      expectedAuthorities: [],
      terminal,
      parsers: rowParsers(new Map(), new Map()),
      transport,
      guards: stableGuards(terminal, guardCounts),
      limits: {
        requestTimeoutMilliseconds: 5,
        maximumDurationMilliseconds: 100,
      },
    })

    await expect(
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(input),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(requestWasAborted).toBe(true)
    expect(guardCounts).toEqual({ terminal: 3, incarnations: 3 })
  })

  test('propagates caller cancellation through the in-flight Query', async () => {
    const terminal = terminalBinding(0)
    const controller = new AbortController()
    let requestWasAborted = false
    const transport: WorkspaceSearchMigrationRehearsalReconciliationAwsTransport = {
      queryStatePage: (_command, signal) => {
        queueMicrotask(() => controller.abort())
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            requestWasAborted = true
            reject(new Error('request aborted'))
          }, { once: true })
        })
      },
    }
    const input = collectorInput({
      expectedMarkers: [],
      expectedMarkerAggregateDigest: aggregateDigest(),
      expectedAuthorities: [],
      terminal,
      parsers: rowParsers(new Map(), new Map()),
      transport,
      guards: stableGuards(
        terminal,
        { terminal: 0, incarnations: 0 },
      ),
      signal: controller.signal,
    })

    await expect(
      collectWorkspaceSearchMigrationRehearsalReconciliationAws(input),
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(requestWasAborted).toBe(true)
  })
})

/** Creates one stable lowercase SHA-256 fixture digest. */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/** Creates the order-independent aggregate used by apply-marker seals. */
function aggregateDigest(...digests: readonly string[]): string {
  const accumulator = new MigrationDigestAccumulator()
  for (const value of digests) accumulator.add(value)
  return accumulator.digest()
}

/** Creates one minimal strict no-op marker audit projection. */
function createMarkerRecord(
  recordKey: string,
  operationId: string,
  planSequence: number,
  planOperationDigest: string,
  markerDigest: string,
): WorkspaceSearchMigrationApplyMarkerAuditRecord {
  return {
    recordKey,
    marker: {
      kind: 'workspace-search-operation-already-current',
      markerVersion: 1,
      runId,
      configurationHash: digest('configuration'),
      operationId,
      planSequence,
      planOperationDigest,
      targetKeyDigest: digest(`target:${operationId}`),
      afterDigest: digest(`after:${operationId}`),
      fenceToken: 7,
      maintenanceEvidenceReceiptDigest: digest('maintenance-receipt'),
      recordedAt: checkedAt,
    },
    predecessorRevision: planSequence,
    successorRevision: planSequence + 1,
    successorExecutionStateDigest: digest(`successor:${operationId}`),
    markerDigest,
  }
}

/** Creates one strict immutable authority-adoption audit projection. */
function createAuthorityRecord(
  recordKey: string,
  renewalCount: number,
): WorkspaceSearchMigrationApplyAuthorityAuditRecord {
  const maintenanceEvidenceReceiptDigest = digest(
    `maintenance-receipt:${renewalCount}`,
  )
  const commandIdentity =
    createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity({
      stateTableId: 'state-table-id',
      configurationHash: digest('configuration'),
      runId,
      executionRunDigest: digest('execution-run'),
      expectedRevision: renewalCount,
      authorityClaim: {
        lease: {
          runId,
          ownerId: 'reconciliation-owner',
          fenceToken: 7,
        },
        maintenanceEvidenceReceiptDigest,
        maintenanceEvidencePointerRevision: renewalCount,
      },
    })
  const receipt =
    createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt({
      commandIdentity,
      predecessorKind: renewalCount === 1
        ? 'execution-run-admission'
        : 'mutable-execution-state',
      ...(renewalCount === 1
        ? {}
        : {
            predecessorExecutionStateVersion: 3,
            predecessorMaintenanceEvidenceRenewalCount: renewalCount - 1,
          }),
      predecessorExecutionStateDigest: renewalCount === 1
        ? commandIdentity.executionRunDigest
        : digest(`authority-predecessor:${renewalCount}`),
      predecessorRunStateDigest: digest(
        `authority-predecessor-state:${renewalCount}`,
      ),
      successorRevision: renewalCount + 1,
      successorExecutionStateDigest: digest(
        `authority-successor:${renewalCount}`,
      ),
      successorRunStateDigest: digest(
        `authority-successor-state:${renewalCount}`,
      ),
      maintenanceEvidenceRenewalCount: renewalCount,
      currentAuthority: {
        ownerId: 'reconciliation-owner',
        fenceToken: 7,
        maintenanceEvidencePointerRevision: renewalCount,
        maintenanceEvidenceReceiptDigest,
        evaluatedAt: checkedAt,
      },
      committedAt: checkedAt,
    })
  return { recordKey, receipt }
}

/** Projects the plan identity expected by the marker comparator. */
function expectedMarker(
  record: WorkspaceSearchMigrationApplyMarkerAuditRecord,
): WorkspaceSearchMigrationRehearsalExpectedMarker {
  return {
    operationId: record.marker.operationId,
    planSequence: record.marker.planSequence,
    planOperationDigest: record.marker.planOperationDigest,
  }
}

/** Projects the immutable identity expected by the authority comparator. */
function expectedAuthority(
  record: WorkspaceSearchMigrationApplyAuthorityAuditRecord,
): WorkspaceSearchMigrationRehearsalExpectedAuthority {
  return {
    maintenanceEvidenceRenewalCount:
      record.receipt.maintenanceEvidenceRenewalCount,
    receiptDigest: record.receipt.receiptDigest,
  }
}

/** Creates one exact immutable terminal binding for the expected prefix. */
function terminalBinding(
  appliedOperationCount: number,
): WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding {
  return {
    configurationBindingDigest: digest('configuration-binding'),
    sealedPlanningAuthorityDigest: digest('sealed-planning-authority'),
    executionRunDigest: digest('execution-run'),
    planDigest: digest('plan'),
    applyBoundaryDigest: digest('apply-boundary'),
    terminalRootKind: 'verified',
    terminalRootVersion: 2,
    terminalRootDigest: digest('terminal-root'),
    sealedPlanOperationCount: appliedOperationCount,
    appliedOperationCount,
    terminalAt: checkedAt,
  }
}

/** Creates one raw base-table row with an optional cleanup-observable buffer. */
function queryItem(
  recordKey: string,
  binary?: Uint8Array,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
    ...(binary === undefined ? {} : { privateBytes: { B: binary } }),
  }
}

/** Creates one no-filter Query response with an optional exact cursor. */
function queryPage(
  items: readonly Readonly<Record<string, AttributeValue>>[],
  lastEvaluatedRecordKey?: string,
): QueryCommandOutput {
  return {
    $metadata: {},
    Items: [...items],
    Count: items.length,
    ScannedCount: items.length,
    ...(lastEvaluatedRecordKey === undefined
      ? {}
      : {
          LastEvaluatedKey: {
            migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
            recordKey: { S: lastEvaluatedRecordKey },
          },
        }),
  }
}

/** Creates the exact Query input owned by the collector. */
function expectedQueryInput(
  prefix: string,
  cursor?: string,
): QueryCommand['input'] {
  return {
    TableName: stateTableName,
    ConsistentRead: true,
    ScanIndexForward: true,
    Limit: WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
    KeyConditionExpression:
      '#migrationId = :migrationId AND begins_with(#recordKey, :recordKeyPrefix)',
    ExpressionAttributeNames: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
    ExpressionAttributeValues: {
      ':migrationId': { S: WORKSPACE_SEARCH_MIGRATION_ID },
      ':recordKeyPrefix': { S: prefix },
    },
    ...(cursor === undefined
      ? {}
      : {
          ExclusiveStartKey: {
            migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
            recordKey: { S: cursor },
          },
        }),
  }
}

/** Creates deterministic writer-owned parser fakes keyed by Query sort key. */
function rowParsers(
  markers: ReadonlyMap<string, WorkspaceSearchMigrationApplyMarkerAuditRecord>,
  authorities: ReadonlyMap<
    string,
    WorkspaceSearchMigrationApplyAuthorityAuditRecord
  >,
  observedBindings: WorkspaceSearchMigrationApplyAuditBindingInput[] = [],
): WorkspaceSearchMigrationRehearsalReconciliationRowParsers {
  return {
    parseMarker: (binding, item) => {
      observedBindings.push(binding)
      return markers.get(readQueryRecordKey(item))
    },
    parseAuthority: (binding, item) => {
      observedBindings.push(binding)
      return authorities.get(readQueryRecordKey(item))
    },
  }
}

/** Reads the exact string sort key from one test-owned low-level item. */
function readQueryRecordKey(
  item: Readonly<Record<string, AttributeValue>>,
): string {
  const attribute = item.recordKey
  if (
    attribute === undefined ||
    !('S' in attribute) ||
    typeof attribute.S !== 'string'
  ) throw new Error('Expected a string recordKey fixture.')
  return attribute.S
}

/** Creates a queue-backed Query transport and records exact commands. */
function queuedTransport(
  pages: readonly QueryCommandOutput[],
  commands: QueryCommand[] = [],
  signals: AbortSignal[] = [],
): WorkspaceSearchMigrationRehearsalReconciliationAwsTransport {
  let index = 0
  return {
    queryStatePage: (command, signal) => {
      commands.push(command)
      signals.push(signal)
      const page = pages[index]
      index += 1
      return page === undefined
        ? Promise.reject(new Error('Unexpected Query page request.'))
        : Promise.resolve(page)
    },
  }
}

/** Creates stable strong terminal and six-incarnation guards. */
function stableGuards(
  terminal: WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
  counts: { terminal: number; incarnations: number },
): WorkspaceSearchMigrationRehearsalReconciliationAwsGuards {
  return {
    readTerminalBinding: () => {
      counts.terminal += 1
      return Promise.resolve(structuredClone(terminal))
    },
    requireCurrentTableIncarnations: () => {
      counts.incarnations += 1
      return Promise.resolve()
    },
  }
}

/** Creates guards whose second terminal read proves identity drift. */
function changingTerminalGuards(
  terminal: WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding,
  counts: { terminal: number; incarnations: number },
): WorkspaceSearchMigrationRehearsalReconciliationAwsGuards {
  return {
    readTerminalBinding: () => {
      counts.terminal += 1
      return Promise.resolve(counts.terminal === 1
        ? structuredClone(terminal)
        : {
            ...terminal,
            terminalRootDigest: digest('changed-terminal-root'),
          })
    },
    requireCurrentTableIncarnations: () => {
      counts.incarnations += 1
      return Promise.resolve()
    },
  }
}

/** Creates one complete collector input with reviewed small test budgets. */
function collectorInput(options: {
  readonly expectedMarkers:
    readonly WorkspaceSearchMigrationRehearsalExpectedMarker[]
  readonly expectedMarkerAggregateDigest: string
  readonly expectedAuthorities:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
  readonly terminal:
    WorkspaceSearchMigrationRehearsalReconciliationTerminalBinding
  readonly parsers:
    WorkspaceSearchMigrationRehearsalReconciliationRowParsers
  readonly transport:
    WorkspaceSearchMigrationRehearsalReconciliationAwsTransport
  readonly guards:
    WorkspaceSearchMigrationRehearsalReconciliationAwsGuards
  readonly limits?:
    Partial<WorkspaceSearchMigrationRehearsalReconciliationAwsLimits>
  readonly signal?: AbortSignal
}): CollectWorkspaceSearchMigrationRehearsalReconciliationAwsInput {
  const limits = {
    maximumPages: 10,
    maximumItems: 100,
    maximumBytes: 1_024 * 1_024,
    requestTimeoutMilliseconds: 1_000,
    maximumDurationMilliseconds: 10_000,
    ...options.limits,
  }
  return {
    stateTableName,
    expectedTerminalBinding: options.terminal,
    expectedMarkers: options.expectedMarkers,
    expectedMarkerAggregateDigest:
      options.expectedMarkerAggregateDigest,
    expectedAuthorities: options.expectedAuthorities,
    auditBinding: auditBindingFixture(),
    parsers: options.parsers,
    transport: options.transport,
    guards: options.guards,
    limits,
    clock: () => new Date(checkedAt),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

/** Creates a six-object binding stub consumed only by injected parser fakes. */
function auditBindingFixture(): WorkspaceSearchMigrationApplyAuditBindingInput {
  const candidate: unknown = {
    closedWriterFenceRecord: {},
    configuration: {},
    configurationHash: digest('configuration'),
    executionBoundary: {},
    executionRun: {},
    sealedPlanningAuthority: {},
  }
  if (!isAuditBindingFixture(candidate)) {
    throw new Error('Expected a plain six-object audit binding fixture.')
  }
  return candidate
}

/** Narrows the deliberately opaque binding used by writer-codec test doubles. */
function isAuditBindingFixture(
  value: unknown,
): value is WorkspaceSearchMigrationApplyAuditBindingInput {
  if (!isPlainRecord(value)) return false
  if (Object.keys(value).sort().join(',') !== [
    'closedWriterFenceRecord',
    'configuration',
    'configurationHash',
    'executionBoundary',
    'executionRun',
    'sealedPlanningAuthority',
  ].join(',')) return false
  return isPlainRecord(value.closedWriterFenceRecord) &&
    isPlainRecord(value.configuration) &&
    typeof value.configurationHash === 'string' &&
    isPlainRecord(value.executionBoundary) &&
    isPlainRecord(value.executionRun) &&
    isPlainRecord(value.sealedPlanningAuthority)
}

/** Checks one ordinary test-fixture record without invoking accessors. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
