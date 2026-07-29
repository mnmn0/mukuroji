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
  encodeWorkspaceSearchWriterFenceRecord,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceAuthority,
  type WorkspaceSearchWriterFenceClosedRecord,
  type WorkspaceSearchWriterFenceOpenRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMaintenanceEvidenceFileDigest,
  MAINTENANCE_EVIDENCE_MAX_BYTES,
  maintenanceRuntimeControlSurfaces,
  type WorkspaceSearchMaintenanceEvidence,
} from './maintenance-evidence'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationExecutionBoundaryPort,
  createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck,
  type AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput,
  type WorkspaceSearchMigrationExecutionBoundaryAwsPort,
  type WorkspaceSearchMigrationExecutionBoundaryAwsTransport,
  workspaceSearchMigrationExecutionBoundaryTransactionIndex,
} from './migration-execution-boundary-aws'
import {
  serializeWorkspaceSearchMigrationExecutionBoundary,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_BOUNDARY_MAX_BYTES,
} from './migration-execution-boundary'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'

const runId = 'execution-boundary-aws-run'
const ownerId = 'execution-boundary-aws-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const openedAt = '2026-07-29T00:30:00.000Z'
const closedAt = '2026-07-29T01:01:00.000Z'
const drainStartedAt = closedAt
const drainCompletedAt = '2026-07-29T01:16:00.000Z'
const admittedAt = '2026-07-29T01:16:10.000Z'

describe('Workspace Search migration execution-boundary AWS adapter', () => {
  test('creates an exact planning-admitted boundary condition check', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt, admittedAt]),
    )
    await port.close(fixture.closeAuthority)
    const admitted = await port.admitPlanning(
      fixture.admissionInput,
    )
    const admittedItem = requirePutItem(
      requirePut(
        requireTransactionItems(
          requireTransaction(transport.transactions[1]),
        )[9],
      ),
    )
    const stateTable = structuredClone(
      fixture.configuration.tables['migration-state'],
    )
    const boundary = structuredClone(admitted)
    const conditionItem =
      createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck({
        stateTable,
        configurationHash: fixture.configurationHash,
        boundary,
      })
    const condition = requireConditionCheck(conditionItem)
    const detachedCondition = structuredClone(conditionItem)

    expect(condition.TableName).toBe(stateTable.tableName)
    expect(condition.Key).toEqual({
      migrationId: admittedItem.migrationId,
      recordKey: admittedItem.recordKey,
    })
    expect(condition.ConditionExpression).toBe([
      '#field0 = :field0',
      '#field1 = :field1',
      '#field2 = :field2',
      '#field3 = :field3',
      '#field4 = :field4',
      '#field5 = :field5',
      '#field6 = :field6',
      '#field7 = :field7',
      '#field8 = :field8',
      '#field9 = :field9',
      '#field10 = :field10',
      '#field11 = :field11',
    ].join(' AND '))
    expect(condition.ExpressionAttributeNames).toEqual({
      '#field0': 'migrationId',
      '#field1': 'recordKey',
      '#field2': 'kind',
      '#field3': 'version',
      '#field4': 'stateTableId',
      '#field5': 'configurationHash',
      '#field6': 'runId',
      '#field7': 'phase',
      '#field8': 'revision',
      '#field9': 'closedWriterFenceRecordDigest',
      '#field10': 'boundaryDigest',
      '#field11': 'boundaryBytes',
    })
    expect(condition.ExpressionAttributeValues).toEqual({
      ':field0': admittedItem.migrationId,
      ':field1': admittedItem.recordKey,
      ':field2': admittedItem.kind,
      ':field3': admittedItem.version,
      ':field4': admittedItem.stateTableId,
      ':field5': admittedItem.configurationHash,
      ':field6': admittedItem.runId,
      ':field7': admittedItem.phase,
      ':field8': admittedItem.revision,
      ':field9': admittedItem.closedWriterFenceRecordDigest,
      ':field10': admittedItem.boundaryDigest,
      ':field11': admittedItem.boundaryBytes,
    })
    expect(
      condition.ExpressionAttributeValues?.[':field11'],
    ).toEqual({
      B: serializeWorkspaceSearchMigrationExecutionBoundary(
        admitted,
      ),
    })
    expect(condition.ReturnValuesOnConditionCheckFailure).toBe('NONE')

    Reflect.set(stateTable, 'tableName', 'mutated-state-table')
    Reflect.set(
      boundary.planningAdmission,
      'admittedAt',
      '2026-07-29T02:00:00.000Z',
    )
    expect(conditionItem).toEqual(detachedCondition)
  })

  test('rejects a valid closed revision-one boundary', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt, admittedAt]),
    )
    const closed = await port.close(fixture.closeAuthority)
    const admitted = await port.admitPlanning(
      fixture.admissionInput,
    )
    const wrongPhase = structuredClone(admitted)
    Reflect.set(wrongPhase, 'phase', closed.phase)
    Reflect.set(wrongPhase, 'revision', closed.revision)
    Reflect.set(
      wrongPhase,
      'boundaryDigest',
      closed.boundaryDigest,
    )
    Reflect.deleteProperty(wrongPhase, 'planningAdmission')

    const failure = captureSynchronousMigrationFailure(() =>
      createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck({
        stateTable:
          fixture.configuration.tables['migration-state'],
        configurationHash: fixture.configurationHash,
        boundary: wrongPhase,
      })
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(failure.message).toBe(
      'Workspace Search migration execution boundary operation failed.',
    )
  })

  test('rejects configuration, state-table, and internal run drift', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt, admittedAt]),
    )
    await port.close(fixture.closeAuthority)
    const admitted = await port.admitPlanning(
      fixture.admissionInput,
    )
    const stateTable =
      fixture.configuration.tables['migration-state']
    const mismatchedStateTable = structuredClone(stateTable)
    Reflect.set(
      mismatchedStateTable,
      'tableId',
      'other-migration-state-table-id',
    )

    for (const input of [
      {
        stateTable,
        configurationHash:
          createMigrationDigest('other-configuration'),
        boundary: admitted,
      },
      {
        stateTable: mismatchedStateTable,
        configurationHash: fixture.configurationHash,
        boundary: admitted,
      },
    ]) {
      const failure = captureSynchronousMigrationFailure(() =>
        createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
          input,
        )
      )
      expect(failure.code).toBe('CONFIGURATION_DRIFT')
    }

    const runMismatch = structuredClone(admitted)
    Reflect.set(
      runMismatch.closeAuthority,
      'runId',
      'other-execution-boundary-run',
    )
    const runFailure = captureSynchronousMigrationFailure(() =>
      createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck({
        stateTable,
        configurationHash: fixture.configurationHash,
        boundary: runMismatch,
      })
    )
    expect(runFailure.code).toBe('INVALID_ARGUMENT')
  })

  test('commits close and admission in the same fixed ten-item order', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt, admittedAt]),
    )

    const closed = await port.close(fixture.closeAuthority)
    expect(closed).toMatchObject({
      phase: 'closed',
      revision: 1,
      closedAt,
    })
    const closeCommand = requireTransaction(
      transport.transactions[0],
    )
    const closeItems = requireTransactionItems(closeCommand)
    expect(closeItems).toHaveLength(
      workspaceSearchMigrationExecutionBoundaryTransactionIndex.count,
    )
    expect(
      new Set(closeItems.map(createTransactionItemIdentity)).size,
    ).toBe(closeItems.length)
    expect(requirePut(closeItems[3]).Item).toHaveProperty(
      'canonicalBytes',
    )
    for (let index = 4; index <= 8; index += 1) {
      expect(requireConditionCheck(closeItems[index]).TableName).toBe(
        fixture.configuration.tables['migration-state'].tableName,
      )
    }
    const closeBoundaryPut = requirePut(closeItems[9])
    expect(closeBoundaryPut.ConditionExpression).toBe(
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    )
    expect(
      Object.keys(requirePutItem(closeBoundaryPut)).sort(),
    ).toEqual([
      'boundaryBytes',
      'boundaryDigest',
      'closedWriterFenceRecordDigest',
      'configurationHash',
      'kind',
      'migrationId',
      'phase',
      'recordKey',
      'revision',
      'runId',
      'stateTableId',
      'version',
    ])

    const admitted = await port.admitPlanning(
      fixture.admissionInput,
    )
    expect(admitted).toMatchObject({
      phase: 'planning-admitted',
      revision: 2,
      planningAdmission: {
        admittedAt,
        drainStartedAt,
        drainCompletedAt,
      },
    })
    const admissionCommand = requireTransaction(
      transport.transactions[1],
    )
    const admissionItems =
      requireTransactionItems(admissionCommand)
    expect(admissionItems).toHaveLength(
      workspaceSearchMigrationExecutionBoundaryTransactionIndex.count,
    )
    expect(
      new Set(admissionItems.map(createTransactionItemIdentity)).size,
    ).toBe(admissionItems.length)
    expect(requireConditionCheck(admissionItems[3])).toBeDefined()
    const admissionBoundaryPut = requirePut(admissionItems[9])
    expect(admissionBoundaryPut.ConditionExpression).toContain(
      '#field0 = :field0',
    )
    expect(admissionBoundaryPut.ExpressionAttributeValues).toHaveProperty(
      ':field11',
    )
    expect(await port.read(runId)).toEqual(admitted)
    expect(
      transport.reads.every((command) =>
        command.input.ConsistentRead === true
      ),
    ).toBe(true)
  })

  test('reconciles response loss and recovers both transitions after restart', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    transport.nextTransactionError =
      new Error('tenant-secret-close-response')
    transport.commitBeforeTransactionError = true
    const closePort = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt]),
    )

    const closed = await closePort.close(fixture.closeAuthority)
    expect(closed.phase).toBe('closed')
    const transactionCountAfterClose =
      transport.transactions.length
    const closeRetryPort = createExecutionBoundaryPort(
      fixture,
      transport,
      createThrowingClock(),
    )
    expect(
      await closeRetryPort.close(fixture.closeAuthority),
    ).toEqual(closed)
    expect(transport.transactions).toHaveLength(
      transactionCountAfterClose,
    )

    transport.nextTransactionError =
      new Error('tenant-secret-admission-response')
    transport.commitBeforeTransactionError = true
    const admissionPort = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([admittedAt]),
    )
    const admitted = await admissionPort.admitPlanning(
      fixture.admissionInput,
    )
    expect(admitted.phase).toBe('planning-admitted')
    const transactionCountAfterAdmission =
      transport.transactions.length
    const admissionRetryPort = createExecutionBoundaryPort(
      fixture,
      transport,
      createThrowingClock(),
    )
    const freshRetryInput =
      createFreshAdmissionRetryInput(fixture.admissionInput)
    expect(
      await admissionRetryPort.admitPlanning(
        freshRetryInput,
      ),
    ).toEqual(admitted)
    expect(transport.transactions).toHaveLength(
      transactionCountAfterAdmission,
    )
  })

  test('stabilizes a boundary revision across concurrent planning admission', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt, admittedAt]),
    )
    await port.close(fixture.closeAuthority)
    const closedBoundaryItem = structuredClone(
      requirePutItem(
        requirePut(
          requireTransactionItems(
            requireTransaction(transport.transactions[0]),
          )[9],
        ),
      ),
    )
    const admitted = await port.admitPlanning(
      fixture.admissionInput,
    )
    const admittedBoundaryItem = structuredClone(
      requirePutItem(
        requirePut(
          requireTransactionItems(
            requireTransaction(transport.transactions[1]),
          )[9],
        ),
      ),
    )
    transport.installItem(closedBoundaryItem)
    const readsBefore = transport.reads.length
    let admissionInjected = false
    transport.readEffect = (command) => {
      if (
        readCommandRecordKey(command) !==
          fixture.openFence.recordKey
      ) {
        return
      }
      admissionInjected = true
      transport.readEffect = undefined
      transport.installItem(admittedBoundaryItem)
    }

    expect(await port.read(runId)).toEqual(admitted)
    expect(admissionInjected).toBe(true)
    expect(transport.reads).toHaveLength(readsBefore + 6)
  })

  test('rejects a fresh retry whose stable admission projection changed', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt, admittedAt]),
    )
    await port.close(fixture.closeAuthority)
    await port.admitPlanning(fixture.admissionInput)
    const fresh = createFreshAdmissionRetryInput(
      fixture.admissionInput,
    )
    const mismatched: AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput =
      {
        currentAuthority: {
          ...fresh.currentAuthority,
          maintenanceEvidencePointerRevision:
            fresh.currentAuthority
              .maintenanceEvidencePointerRevision + 1,
        },
        maintenanceEvidenceBytes: fresh.maintenanceEvidenceBytes,
      }
    const retryPort = createExecutionBoundaryPort(
      fixture,
      transport,
      createThrowingClock(),
    )

    const failure = await captureMigrationFailure(() =>
      retryPort.admitPlanning(mismatched)
    )
    expect(failure.code).toBe('INVALID_STATE')
  })

  test('maps every fixed conditional family after proving the predecessor remains', async () => {
    const cases: readonly {
      readonly index: number
      readonly expected:
        | 'INVALID_MAINTENANCE_EVIDENCE'
        | 'INVALID_STATE'
        | 'LEASE_LOST'
    }[] = [
      { index: 0, expected: 'LEASE_LOST' },
      { index: 1, expected: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 2, expected: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 3, expected: 'INVALID_STATE' },
      { index: 4, expected: 'INVALID_STATE' },
      { index: 5, expected: 'INVALID_STATE' },
      { index: 6, expected: 'INVALID_STATE' },
      { index: 7, expected: 'INVALID_STATE' },
      { index: 8, expected: 'INVALID_STATE' },
      { index: 9, expected: 'INVALID_STATE' },
    ]

    for (const candidate of cases) {
      const fixture = createExecutionBoundaryAwsFixture()
      const transport = new RecordingExecutionBoundaryTransport(
        fixture.openFence,
      )
      transport.nextTransactionError = createCancellation(
        candidate.index,
        workspaceSearchMigrationExecutionBoundaryTransactionIndex.count,
      )
      const port = createExecutionBoundaryPort(
        fixture,
        transport,
        createSequencedClock([closedAt]),
      )
      const failure = await captureMigrationFailure(() =>
        port.close(fixture.closeAuthority)
      )
      expect(failure.code).toBe(candidate.expected)
      expect(failure.message).toBe(
        'Workspace Search migration execution boundary operation failed.',
      )
    }
  })

  test('rejects a closed-fence-only irreversible state from public read', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const closedFence =
      createWorkspaceSearchWriterFenceClosedSuccessor(
        fixture.openFence,
        createCloseFenceAuthority(fixture.closeAuthority),
        new Date(closedAt),
      )
    const transport = new RecordingExecutionBoundaryTransport(
      closedFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createThrowingClock(),
    )

    const failure = await captureMigrationFailure(() =>
      port.read(runId)
    )
    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.reads).toHaveLength(9)
  })

  test('rejects caller proxies before I/O without exposing thrown values', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt]),
    )
    const proxy = new Proxy(fixture.closeAuthority, {
      get() {
        throw new Error('tenant-secret-proxy')
      },
    })

    const failure = await captureMigrationFailure(() =>
      port.close(proxy)
    )
    expect(failure.code).toBe('INVALID_ARGUMENT')
    expect(failure.message).not.toContain('tenant-secret-proxy')
    expect(transport.reads).toHaveLength(0)
    expect(transport.transactions).toHaveLength(0)
  })

  test('rejects oversized or shared evidence before copy-dependent I/O', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createThrowingClock(),
    )
    const oversized:
      AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput = {
        currentAuthority: fixture.admissionInput.currentAuthority,
        maintenanceEvidenceBytes:
          new Uint8Array(MAINTENANCE_EVIDENCE_MAX_BYTES + 1),
      }

    const shared:
      AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput = {
        currentAuthority: fixture.admissionInput.currentAuthority,
        maintenanceEvidenceBytes:
          new Uint8Array(new SharedArrayBuffer(8)),
      }

    for (const input of [oversized, shared]) {
      const failure = await captureMigrationFailure(() =>
        port.admitPlanning(input)
      )
      expect(failure.code).toBe('INVALID_ARGUMENT')
    }
    expect(transport.reads).toHaveLength(0)
    expect(transport.transactions).toHaveLength(0)
  })

  test('rejects oversized durable boundary bytes before the fence read', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transport = new RecordingExecutionBoundaryTransport(
      fixture.openFence,
    )
    const port = createExecutionBoundaryPort(
      fixture,
      transport,
      createSequencedClock([closedAt]),
    )
    await port.close(fixture.closeAuthority)
    const closeItems = requireTransactionItems(
      requireTransaction(transport.transactions[0]),
    )
    const oversizedBoundaryItem = structuredClone(
      requirePutItem(requirePut(closeItems[9])),
    )
    Reflect.set(oversizedBoundaryItem, 'boundaryBytes', {
      B: new Uint8Array(
        WORKSPACE_SEARCH_MIGRATION_EXECUTION_BOUNDARY_MAX_BYTES + 1,
      ),
    })
    transport.installItem(oversizedBoundaryItem)
    const readsBeforeFailure = transport.reads.length

    const failure = await captureMigrationFailure(() =>
      port.read(runId)
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.reads).toHaveLength(readsBeforeFailure + 1)
  })

  test('escalates managed post-transaction transient failures to ambiguous', async () => {
    const fixture = createExecutionBoundaryAwsFixture()
    const transactionTransport =
      new RecordingExecutionBoundaryTransport(fixture.openFence)
    transactionTransport.nextTransactionError =
      new WorkspaceSearchMigrationFailure(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
        'tenant-secret-managed-guard',
      )
    const transactionPort = createExecutionBoundaryPort(
      fixture,
      transactionTransport,
      createSequencedClock([closedAt]),
    )

    const transactionFailure = await captureMigrationFailure(() =>
      transactionPort.close(fixture.closeAuthority)
    )
    expect(transactionFailure.code).toBe(
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
    expect(transactionFailure.message).not.toContain('tenant-secret')
    expect(transactionTransport.reads).toHaveLength(3)

    const reconciliationTransport =
      new RecordingExecutionBoundaryTransport(fixture.openFence)
    reconciliationTransport.nextReadErrorAfterTransaction =
      new WorkspaceSearchMigrationFailure(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
        'tenant-secret-reconciliation',
      )
    const reconciliationPort = createExecutionBoundaryPort(
      fixture,
      reconciliationTransport,
      createSequencedClock([closedAt]),
    )

    const reconciliationFailure = await captureMigrationFailure(() =>
      reconciliationPort.close(fixture.closeAuthority)
    )
    expect(reconciliationFailure.code).toBe(
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
    expect(reconciliationFailure.message).not.toContain(
      'tenant-secret',
    )
  })
})

/**
 * Complete valid AWS adapter fixture.
 */
type ExecutionBoundaryAwsFixture = {
  /** Complete measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the measured configuration. */
  readonly configurationHash: string
  /** Fresh authority used for the atomic close. */
  readonly closeAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Exact initial open writer-fence row. */
  readonly openFence: WorkspaceSearchWriterFenceOpenRecord
  /** Fresh authority and bytes used for planning admission. */
  readonly admissionInput:
    AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput
}

/**
 * Creates one internally correlated adapter fixture.
 *
 * @returns Complete measured configuration, fence, and authorities.
 */
function createExecutionBoundaryAwsFixture():
  ExecutionBoundaryAwsFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const closeReceipt = createCloseMaintenanceReceipt()
  const closeAuthority: WorkspaceSearchMigrationPrePlanAuthority = {
    configurationHash,
    stateTableId:
      configuration.tables['migration-state'].tableId,
    lease: {
      runId,
      ownerId,
      fenceToken: 7,
      heartbeatAt: '2026-07-29T01:00:15.000Z',
      expiresAt: '2026-07-29T01:01:15.000Z',
    },
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(closeReceipt),
    maintenanceEvidencePointerRevision: 11,
    maintenanceEvidenceReceipt: closeReceipt,
    evaluatedAt: '2026-07-29T01:00:30.000Z',
  }
  const binding = createWriterFenceBinding(configuration)
  const openFence =
    createWorkspaceSearchWriterFenceInitialOpenRecord(
      binding,
      new Date(openedAt),
    )
  return {
    configuration,
    configurationHash,
    closeAuthority,
    openFence,
    admissionInput: createAdmissionInput(
      configuration,
      configurationHash,
      closeAuthority,
    ),
  }
}

/**
 * Creates the exact post-close admission authority and evidence bytes.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param closeAuthority - Authority that owns the close.
 * @returns Exact current authority and raw drain evidence.
 */
function createAdmissionInput(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  closeAuthority: WorkspaceSearchMigrationPrePlanAuthority,
): AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput {
  const runtimeRevision = 41
  const evidence: WorkspaceSearchMaintenanceEvidence = {
    schemaVersion: 1,
    locator: 'change:OPS-39',
    runtimeMode: 'disabled',
    runtimeRevision,
    drainStartedAt,
    drainCompletedAt,
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: runtimeRevision,
      observedAt: drainCompletedAt,
    })),
  }
  const maintenanceEvidenceBytes = new TextEncoder().encode(
    serializeCanonicalJson(evidence),
  )
  const receipt: WorkspaceSearchMaintenanceEvidenceReceipt = {
    runId,
    evidenceDigest: createMaintenanceEvidenceFileDigest(
      maintenanceEvidenceBytes,
    ),
    evidenceLocator: evidence.locator,
    runtimeRevision,
    fenceToken: closeAuthority.lease.fenceToken,
    validatedAt: '2026-07-29T01:16:05.000Z',
    oldestObservationAt: drainCompletedAt,
    validUntil: '2026-07-29T01:21:00.001Z',
  }
  return {
    currentAuthority: {
      configurationHash,
      stateTableId:
        configuration.tables['migration-state'].tableId,
      lease: {
        runId,
        ownerId,
        fenceToken: closeAuthority.lease.fenceToken,
        heartbeatAt: drainCompletedAt,
        expiresAt: '2026-07-29T01:17:00.000Z',
      },
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(receipt),
      maintenanceEvidencePointerRevision:
        closeAuthority.maintenanceEvidencePointerRevision + 1,
      maintenanceEvidenceReceipt: receipt,
      evaluatedAt: receipt.validatedAt,
    },
    maintenanceEvidenceBytes,
  }
}

/**
 * Advances only volatile lease and evaluation times for a new-process retry.
 *
 * @param input - Original exact admission input.
 * @returns Fresh authority retaining the same stable admission projection.
 */
function createFreshAdmissionRetryInput(
  input: AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput,
): AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput {
  return {
    currentAuthority: {
      ...input.currentAuthority,
      lease: {
        ...input.currentAuthority.lease,
        heartbeatAt: '2026-07-29T01:16:20.000Z',
        expiresAt: '2026-07-29T01:17:20.000Z',
      },
      evaluatedAt: '2026-07-29T01:16:30.000Z',
    },
    maintenanceEvidenceBytes:
      new Uint8Array(input.maintenanceEvidenceBytes),
  }
}

/**
 * Creates one fresh close-time maintenance receipt.
 *
 * @returns Canonical receipt fixture.
 */
function createCloseMaintenanceReceipt():
  WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('close-maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/execution-boundary.json',
    runtimeRevision: 7,
    fenceToken: 7,
    validatedAt: '2026-07-29T01:00:30.000Z',
    oldestObservationAt: '2026-07-29T00:59:00.000Z',
    validUntil: '2026-07-29T01:04:00.001Z',
  }
}

/**
 * Creates a complete measured migration configuration.
 *
 * @returns Stable measured configuration.
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
      'workspace-search':
        createSupportingTable('workspace-search'),
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
 * Creates the shared writer-fence binding for one configuration.
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
 * In-memory transport that applies only adapter-owned Put items.
 */
class RecordingExecutionBoundaryTransport
implements WorkspaceSearchMigrationExecutionBoundaryAwsTransport {
  /** Strong read commands received by the transport. */
  readonly reads: GetItemCommand[] = []

  /** Transaction commands received by the transport. */
  readonly transactions: TransactWriteItemsCommand[] = []

  /** One-shot raw transaction error. */
  nextTransactionError: unknown

  /** Whether transaction Put items become durable before the error. */
  commitBeforeTransactionError = false

  /** One-shot public or raw read error armed after a transaction. */
  nextReadErrorAfterTransaction: unknown

  /** Optional test-owned effect invoked immediately before each item lookup. */
  readEffect: ((command: GetItemCommand) => void) | undefined

  /** Exact durable items indexed by their sort key. */
  private readonly items =
    new Map<string, Readonly<Record<string, AttributeValue>>>()

  /** One-shot public or raw strong-read error. */
  private nextReadError: unknown

  /**
   * Creates one transport with an exact current writer fence.
   *
   * @param fence - Initial open or closed writer-fence row.
   */
  constructor(
    fence:
      | WorkspaceSearchWriterFenceClosedRecord
      | WorkspaceSearchWriterFenceOpenRecord,
  ) {
    const item = encodeWorkspaceSearchWriterFenceRecord(fence)
    this.items.set(fence.recordKey, item)
  }

  /**
   * Installs one exact test-owned durable item by its record key.
   *
   * @param item - Low-level item exposed to subsequent strong reads.
   */
  installItem(
    item: Readonly<Record<string, AttributeValue>>,
  ): void {
    this.items.set(
      readRawItemRecordKey(item),
      structuredClone(item),
    )
  }

  /**
   * Strongly reads one exact in-memory row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Current item or absence.
   */
  readonly getExecutionBoundaryState = (
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> => {
    this.reads.push(command)
    this.readEffect?.(command)
    const error = this.nextReadError
    this.nextReadError = undefined
    if (error !== undefined) {
      return Promise.reject(error)
    }
    const item = this.items.get(readCommandRecordKey(command))
    return Promise.resolve(
      item === undefined
        ? { $metadata: {} }
        : { $metadata: {}, Item: structuredClone(item) },
    )
  }

  /**
   * Completes the final state-incarnation preparation.
   *
   * @returns Immediate completion.
   */
  readonly prepareExecutionBoundaryWrite = (): Promise<void> =>
    Promise.resolve()

  /**
   * Applies transaction Put items and raises any configured error.
   *
   * @param command - Adapter-owned exact transaction.
   * @returns Empty successful response.
   */
  readonly transactWriteExecutionBoundary = (
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> => {
    this.transactions.push(command)
    const error = this.nextTransactionError
    const shouldCommit =
      error === undefined || this.commitBeforeTransactionError
    if (shouldCommit) {
      for (const item of requireTransactionItems(command)) {
        if (item.Put !== undefined) {
          const rawItem = requirePutItem(item.Put)
          this.items.set(
            readRawItemRecordKey(rawItem),
            structuredClone(rawItem),
          )
        }
      }
    }
    this.nextTransactionError = undefined
    this.commitBeforeTransactionError = false
    this.nextReadError = this.nextReadErrorAfterTransaction
    this.nextReadErrorAfterTransaction = undefined
    return error === undefined
      ? Promise.resolve({ $metadata: {} })
      : Promise.reject(error)
  }
}

/**
 * Creates one measured adapter.
 *
 * @param fixture - Complete valid fixture.
 * @param transport - Recording transport.
 * @param clock - Trusted adapter clock.
 * @returns Durable execution-boundary port.
 */
function createExecutionBoundaryPort(
  fixture: ExecutionBoundaryAwsFixture,
  transport: WorkspaceSearchMigrationExecutionBoundaryAwsTransport,
  clock: () => Date,
): WorkspaceSearchMigrationExecutionBoundaryAwsPort {
  return createAwsWorkspaceSearchMigrationExecutionBoundaryPort(
    fixture.configuration,
    fixture.configurationHash,
    transport,
    clock,
  )
}

/**
 * Creates the exact close authority projected into a fence row.
 *
 * @param authority - Complete current pre-plan authority.
 * @returns Stable writer-fence authority.
 */
function createCloseFenceAuthority(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchWriterFenceAuthority {
  return {
    configurationHash: authority.configurationHash,
    runId: authority.lease.runId,
    ownerId: authority.lease.ownerId,
    leaseFenceToken: authority.lease.fenceToken,
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
  }
}

/**
 * Reads the exact record key from one GetItem command.
 *
 * @param command - Adapter-owned command.
 * @returns Exact DynamoDB sort-key string.
 */
function readCommandRecordKey(command: GetItemCommand): string {
  const value = command.input.Key?.recordKey
  if (typeof value?.S !== 'string') {
    throw new Error('Expected a string record key.')
  }
  return value.S
}

/**
 * Reads the exact record key from one low-level item.
 *
 * @param item - Complete low-level item.
 * @returns Exact DynamoDB sort-key string.
 */
function readRawItemRecordKey(
  item: Readonly<Record<string, AttributeValue>>,
): string {
  const value = item.recordKey
  if (typeof value?.S !== 'string') {
    throw new Error('Expected a string item record key.')
  }
  return value.S
}

/**
 * Requires one recorded transaction.
 *
 * @param command - Candidate recorded command.
 * @returns Exact recorded command.
 */
function requireTransaction(
  command: TransactWriteItemsCommand | undefined,
): TransactWriteItemsCommand {
  if (command === undefined) {
    throw new Error('Expected a transaction.')
  }
  return command
}

/**
 * Requires exact transaction items.
 *
 * @param command - Adapter-owned transaction.
 * @returns Exact ordered transaction items.
 */
function requireTransactionItems(
  command: TransactWriteItemsCommand,
): readonly TransactWriteItem[] {
  const items = command.input.TransactItems
  if (items === undefined) {
    throw new Error('Expected transaction items.')
  }
  return items
}

/**
 * Requires one transaction Put.
 *
 * @param item - Candidate transaction item.
 * @returns Exact Put input.
 */
function requirePut(
  item: TransactWriteItem | undefined,
): NonNullable<TransactWriteItem['Put']> {
  if (item?.Put === undefined) {
    throw new Error('Expected a Put item.')
  }
  return item.Put
}

/**
 * Requires one transaction ConditionCheck.
 *
 * @param item - Candidate transaction item.
 * @returns Exact ConditionCheck input.
 */
function requireConditionCheck(
  item: TransactWriteItem | undefined,
): NonNullable<TransactWriteItem['ConditionCheck']> {
  if (item?.ConditionCheck === undefined) {
    throw new Error('Expected a ConditionCheck item.')
  }
  return item.ConditionCheck
}

/**
 * Requires one complete Put item.
 *
 * @param put - Candidate transaction Put.
 * @returns Complete low-level item.
 */
function requirePutItem(
  put: NonNullable<TransactWriteItem['Put']>,
): Readonly<Record<string, AttributeValue>> {
  if (put.Item === undefined) {
    throw new Error('Expected a complete Put item.')
  }
  return put.Item
}

/**
 * Projects one transaction item to its exact DynamoDB table and primary key.
 *
 * @param item - Adapter-owned Put or ConditionCheck.
 * @returns Stable identity used to prove all ten items are distinct.
 */
function createTransactionItemIdentity(
  item: TransactWriteItem,
): string {
  const operation = item.ConditionCheck ?? item.Put
  const key = item.ConditionCheck?.Key ?? item.Put?.Item
  const tableName = operation?.TableName
  const migrationId = key?.migrationId?.S
  const recordKey = key?.recordKey?.S
  if (
    typeof tableName !== 'string' ||
    typeof migrationId !== 'string' ||
    typeof recordKey !== 'string'
  ) {
    throw new Error('Expected one exact migration-state item identity.')
  }
  return `${tableName}\u0000${migrationId}\u0000${recordKey}`
}

/**
 * Creates one conditional transaction cancellation.
 *
 * @param index - Failed transaction position.
 * @param count - Total transaction item count.
 * @returns Raw DynamoDB cancellation fixture.
 */
function createCancellation(
  index: number,
  count: number,
): TransactionCanceledException {
  const reasons = Array.from(
    { length: count },
    () => ({ Code: 'None' }),
  )
  const reason = reasons[index]
  if (reason === undefined) {
    throw new Error('Cancellation fixture index is invalid.')
  }
  reason.Code = 'ConditionalCheckFailed'
  return new TransactionCanceledException({
    $metadata: {},
    CancellationReasons: reasons,
    message: 'tenant-secret-cancellation',
  })
}

/**
 * Captures one expected public migration failure.
 *
 * @param operation - Expected failing async operation.
 * @returns Public stable migration failure.
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
  throw new Error('Expected migration failure.')
}

/**
 * Captures one expected synchronous public migration failure.
 *
 * @param operation - Expected failing synchronous operation.
 * @returns Public stable migration failure.
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
  throw new Error('Expected migration failure.')
}

/**
 * Creates one finite trusted clock sequence.
 *
 * @param timestamps - Exact returned timestamp sequence.
 * @returns Trusted finite clock.
 */
function createSequencedClock(
  timestamps: readonly string[],
): () => Date {
  let index = 0
  return () => {
    const timestamp = timestamps[index]
    index += 1
    if (timestamp === undefined) {
      throw new Error('Clock fixture exhausted.')
    }
    return new Date(timestamp)
  }
}

/**
 * Creates a clock that proves a recovery path never samples time.
 *
 * @returns Clock that always raises when invoked.
 */
function createThrowingClock(): () => Date {
  return () => {
    throw new Error('Recovery sampled an unexpected clock.')
  }
}

/**
 * Creates one deterministic fixture digest.
 *
 * @param label - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest(label)
}
