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
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createAwsWorkspaceSearchMigrationExecutionRunPort,
  type WorkspaceSearchMigrationExecutionRunAwsPort,
  type WorkspaceSearchMigrationExecutionRunAwsTransport,
  workspaceSearchMigrationExecutionRunTransactionIndex,
} from './migration-execution-run-aws'
import {
  createWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRunBinding,
} from './migration-execution-run'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  createWorkspaceSearchMigrationPlanningProvenanceObjectKey,
} from './migration-planning-provenance-manifest'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  type WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
} from './migration-state-machine'

const runId = 'execution-run-aws-test'
const ownerId = 'execution-run-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const openedAt = '2026-07-29T00:30:00.000Z'
const closedAt = '2026-07-29T01:00:00.000Z'
const admittedAt = '2026-07-29T01:16:00.000Z'
const planCreatedAt = '2026-07-29T01:17:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const evaluatedAt = '2026-07-29T01:19:00.000Z'
const createdAt = '2026-07-29T01:19:30.000Z'
const retainUntil = '2026-08-30T00:00:00.000Z'

describe('Workspace Search migration execution-run AWS adapter', () => {
  test('commits and strongly reads one fixed seven-item execution admission', async () => {
    const fixture = createExecutionRunAwsFixture()
    const transport = new RecordingExecutionRunTransport()
    const port = createExecutionRunPort(fixture, transport)

    const created = await port.create(fixture.currentAuthority)
    expect(created).toMatchObject({
      runId,
      revision: 1,
      status: 'applying',
      binding: {
        executionBoundaryDigest:
          fixture.executionBoundary.boundaryDigest,
        sealedPlanningAuthorityDigest:
          fixture.sealedPlanningAuthority.authorityDigest,
      },
    })
    const command = requireTransaction(transport.transactions[0])
    const items = requireTransactionItems(command)
    expect(items).toHaveLength(
      workspaceSearchMigrationExecutionRunTransactionIndex.count,
    )
    for (let index = 0; index < 6; index += 1) {
      expect(requireConditionCheck(items[index]).TableName).toBe(
        fixture.configuration.tables['migration-state'].tableName,
      )
    }
    expect(
      requireConditionCheck(items[3]).ConditionExpression,
    ).toBe(
      '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest',
    )
    expect(
      requireConditionCheck(items[4]).ExpressionAttributeValues,
    ).toHaveProperty(':field11')
    expect(
      requireConditionCheck(items[5]).ExpressionAttributeNames,
    ).toHaveProperty('#rootBytes', 'rootBytes')
    const put = requirePut(items[6])
    expect(put.ConditionExpression).toBe(
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    )
    expect(Object.keys(requirePutItem(put)).sort()).toEqual([
      'bindingDigest',
      'configurationHash',
      'executionRunBytes',
      'executionRunDigest',
      'kind',
      'migrationId',
      'recordKey',
      'revision',
      'runId',
      'stateDigest',
      'stateTableId',
      'status',
      'version',
    ])
    expect(await port.read(runId)).toEqual(created)
    expect(
      transport.reads.every((read) =>
        read.input.ConsistentRead === true
      ),
    ).toBe(true)
    expect(command.input.ClientRequestToken).toHaveLength(36)
  })

  test('recovers exact response loss and rejects a foreign durable admission', async () => {
    const fixture = createExecutionRunAwsFixture()
    const transport = new RecordingExecutionRunTransport()
    transport.nextTransactionError =
      new Error('tenant-secret-response-loss')
    transport.commitBeforeTransactionError = true
    const port = createExecutionRunPort(fixture, transport)

    const recovered = await port.create(fixture.currentAuthority)
    expect(recovered.status).toBe('applying')
    expect(transport.reads).toHaveLength(2)

    const foreignFixture = createExecutionRunAwsFixture(
      'foreign-plan',
    )
    const foreignTransport = new RecordingExecutionRunTransport()
    const foreignPort = createExecutionRunPort(
      foreignFixture,
      foreignTransport,
    )
    await foreignPort.create(foreignFixture.currentAuthority)
    const foreignItem = structuredClone(
      requirePutItem(
        requirePut(
          requireTransactionItems(
            requireTransaction(foreignTransport.transactions[0]),
          )[6],
        ),
      ),
    )
    const conflictTransport = new RecordingExecutionRunTransport()
    conflictTransport.nextTransactionError =
      new Error('tenant-secret-foreign-response')
    conflictTransport.replacementItemAfterTransaction = foreignItem
    const conflictPort = createExecutionRunPort(
      fixture,
      conflictTransport,
    )
    const failure = await captureMigrationFailure(() =>
      conflictPort.create(fixture.currentAuthority)
    )
    expect(failure.code).toBe('INVALID_STATE')
    expect(failure.message).not.toContain('tenant-secret')
  })

  test('maps every fixed conditional cancellation position', async () => {
    const expected: readonly WorkspaceSearchMigrationFailureCode[] = [
      'LEASE_LOST',
      'INVALID_MAINTENANCE_EVIDENCE',
      'INVALID_MAINTENANCE_EVIDENCE',
      'INVALID_STATE',
      'INVALID_STATE',
      'INVALID_STATE',
      'INVALID_STATE',
    ]
    for (let index = 0; index < expected.length; index += 1) {
      const fixture = createExecutionRunAwsFixture()
      const transport = new RecordingExecutionRunTransport()
      transport.nextTransactionError =
        createCancellation(index)
      const port = createExecutionRunPort(fixture, transport)

      const failure = await captureMigrationFailure(() =>
        port.create(fixture.currentAuthority)
      )
      expect(failure.code).toBe(expected[index])
      expect(transport.reads).toHaveLength(2)
    }
  })

  test('strictly rejects tampered durable rows and construction drift', async () => {
    const fixture = createExecutionRunAwsFixture()
    const transport = new RecordingExecutionRunTransport()
    const port = createExecutionRunPort(fixture, transport)
    await port.create(fixture.currentAuthority)
    transport.mutateState((item) => {
      item.unexpected = { S: 'tenant-secret-extra' }
    })
    const readFailure = await captureMigrationFailure(() =>
      port.read(runId)
    )
    expect(readFailure.code).toBe('INVALID_STATE')
    expect(readFailure.message).not.toContain('tenant-secret')

    const mismatchedPlan: WorkspaceSearchPlanSeal = {
      ...fixture.planSeal,
      dryRunEvidenceDigest: digest('different-dry-run'),
    }
    const constructionFailure = captureSynchronousMigrationFailure(
      () =>
        createAwsWorkspaceSearchMigrationExecutionRunPort({
          ...createExecutionRunPortInput(
            fixture,
            new RecordingExecutionRunTransport(),
          ),
          planSeal: mismatchedPlan,
        }),
    )
    expect(constructionFailure.code).toBe('INVALID_ARGUMENT')
  })

  test('rejects redigested static-binding tampering on read and reconciliation', async () => {
    const fixture = createExecutionRunAwsFixture()
    const transport = new RecordingExecutionRunTransport()
    const port = createExecutionRunPort(fixture, transport)
    const created = await port.create(fixture.currentAuthority)
    const durableItem = structuredClone(
      requirePutItem(
        requirePut(
          requireTransactionItems(
            requireTransaction(transport.transactions[0]),
          )[workspaceSearchMigrationExecutionRunTransactionIndex
            .executionRun],
        ),
      ),
    )

    const timestampTampering =
      redigestExecutionRunWithBinding(
        created,
        {
          ...withoutBindingDigest(created.binding),
          planningAdmittedAt: '2026-07-29T01:15:59.000Z',
        },
        created.runState,
      )
    transport.mutateState((item) => {
      installExecutionRunState(item, timestampTampering)
    })
    const readFailure = await captureMigrationFailure(() =>
      port.read(runId)
    )
    expect(readFailure.code).toBe('INVALID_STATE')

    const sealedTimestampTampering =
      redigestExecutionRunWithBinding(
        created,
        {
          ...withoutBindingDigest(created.binding),
          sealedAt: '2026-07-29T01:18:01.000Z',
        },
        created.runState,
      )
    transport.mutateState((item) => {
      installExecutionRunState(item, sealedTimestampTampering)
    })
    const sealedTimestampFailure =
      await captureMigrationFailure(() => port.read(runId))
    expect(sealedTimestampFailure.code).toBe('INVALID_STATE')

    const dryRunTamperedState = {
      ...created.runState,
      dryRunEvidenceDigest: digest('different-dry-run'),
    }
    const dryRunTampering =
      redigestExecutionRunWithBinding(
        created,
        withoutBindingDigest(created.binding),
        dryRunTamperedState,
      )
    transport.mutateState((item) => {
      installExecutionRunState(item, dryRunTampering)
    })
    const dryRunReadFailure =
      await captureMigrationFailure(() => port.read(runId))
    expect(dryRunReadFailure.code).toBe('INVALID_STATE')

    const dryRunConflictTransport =
      new RecordingExecutionRunTransport()
    dryRunConflictTransport.nextTransactionError =
      new Error('tenant-secret-dry-run-response')
    dryRunConflictTransport.replacementItemAfterTransaction = {
      ...durableItem,
      ...createExecutionRunStateAttributes(dryRunTampering),
    }
    const dryRunConflictPort = createExecutionRunPort(
      fixture,
      dryRunConflictTransport,
    )
    const dryRunReconciliationFailure =
      await captureMigrationFailure(() =>
        dryRunConflictPort.create(fixture.currentAuthority)
      )
    expect(dryRunReconciliationFailure.code).toBe('INVALID_STATE')
    expect(dryRunReconciliationFailure.message).not.toContain(
      'tenant-secret',
    )

    const regressedReceipt = {
      ...created.runState.maintenanceEvidenceReceipt,
      fenceToken:
        created.binding.currentAuthority.fenceToken - 1,
    }
    const regressedRunState = {
      ...created.runState,
      maintenanceEvidenceReceipt: regressedReceipt,
    }
    const authorityRollback =
      redigestExecutionRunWithBinding(
        created,
        {
          ...withoutBindingDigest(created.binding),
          currentAuthority: {
            ...created.binding.currentAuthority,
            fenceToken: regressedReceipt.fenceToken,
            maintenanceEvidencePointerRevision: 1,
            maintenanceEvidenceReceiptDigest:
              createMigrationDigest(regressedReceipt),
          },
        },
        regressedRunState,
      )
    const conflictTransport =
      new RecordingExecutionRunTransport()
    conflictTransport.nextTransactionError =
      new Error('tenant-secret-redigested-response')
    conflictTransport.replacementItemAfterTransaction = {
      ...durableItem,
      ...createExecutionRunStateAttributes(authorityRollback),
    }
    const conflictPort = createExecutionRunPort(
      fixture,
      conflictTransport,
    )
    const reconciliationFailure =
      await captureMigrationFailure(() =>
        conflictPort.create(fixture.currentAuthority)
      )
    expect(reconciliationFailure.code).toBe('INVALID_STATE')
    expect(reconciliationFailure.message).not.toContain(
      'tenant-secret',
    )
  })

  test('rejects stale authority before I/O and snapshots caller input', async () => {
    const fixture = createExecutionRunAwsFixture()
    const staleAuthority: WorkspaceSearchMigrationPrePlanAuthority = {
      ...fixture.currentAuthority,
      lease: {
        ...fixture.currentAuthority.lease,
        heartbeatAt: '2026-07-29T01:18:30.000Z',
        expiresAt: '2026-07-29T01:19:30.000Z',
      },
      maintenanceEvidenceReceipt: {
        ...fixture.currentAuthority.maintenanceEvidenceReceipt,
        validUntil: '2026-07-29T01:19:30.000Z',
      },
    }
    const transport = new RecordingExecutionRunTransport()
    const stalePort = createExecutionRunPort(
      fixture,
      transport,
      () => new Date(createdAt),
    )
    const staleFailure = await captureMigrationFailure(() =>
      stalePort.create(staleAuthority)
    )
    expect(staleFailure.code).toBe('INVALID_ARGUMENT')
    expect(transport.reads).toHaveLength(0)

    const mutationFixture = createExecutionRunAwsFixture()
    const authority = structuredClone(
      mutationFixture.currentAuthority,
    )
    const mutationTransport =
      new RecordingExecutionRunTransport()
    mutationTransport.firstReadEffect = () => {
      Reflect.set(authority.lease, 'ownerId', 'mutated-owner')
      Reflect.set(
        authority,
        'maintenanceEvidencePointerRevision',
        999,
      )
    }
    const mutationPort = createExecutionRunPort(
      mutationFixture,
      mutationTransport,
    )
    const created = await mutationPort.create(authority)
    expect(created.binding.currentAuthority.ownerId).toBe(ownerId)
    expect(
      created.binding.currentAuthority
        .maintenanceEvidencePointerRevision,
    ).toBe(12)
  })

  test('revalidates commit headroom after transport preparation', async () => {
    const fixture = createExecutionRunAwsFixture()
    const transport = new RecordingExecutionRunTransport()
    const port = createExecutionRunPort(
      fixture,
      transport,
      createSequencedClock([
        createdAt,
        '2026-07-29T01:19:56.000Z',
      ]),
    )

    const failure = await captureMigrationFailure(() =>
      port.create(fixture.currentAuthority)
    )
    expect(failure.code).toBe('INVALID_ARGUMENT')
    expect(transport.reads).toHaveLength(1)
    expect(transport.transactions).toHaveLength(0)
  })

  test('revalidates immutable retention headroom after transport preparation', async () => {
    const fixture = createExecutionRunAwsFixture(
      'retention-headroom',
      '2026-08-28T01:19:31.000Z',
    )
    const transport = new RecordingExecutionRunTransport()
    const port = createExecutionRunPort(
      fixture,
      transport,
      createSequencedClock([
        createdAt,
        '2026-07-29T01:19:32.000Z',
      ]),
    )

    const failure = await captureMigrationFailure(() =>
      port.create(fixture.currentAuthority)
    )
    expect(failure.code).toBe('INVALID_ARGUMENT')
    expect(transport.reads).toHaveLength(1)
    expect(transport.transactions).toHaveLength(0)
  })

  test('rejects a regressing commit clock before transaction construction', async () => {
    const fixture = createExecutionRunAwsFixture()
    const transport = new RecordingExecutionRunTransport()
    const port = createExecutionRunPort(
      fixture,
      transport,
      createSequencedClock([
        createdAt,
        '2026-07-29T01:19:20.000Z',
      ]),
    )

    const failure = await captureMigrationFailure(() =>
      port.create(fixture.currentAuthority)
    )
    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.reads).toHaveLength(1)
    expect(transport.transactions).toHaveLength(0)
  })

  test('passes managed guard failures through without reconciliation', async () => {
    const fixture = createExecutionRunAwsFixture()
    const prepareTransport = new RecordingExecutionRunTransport()
    prepareTransport.prepareError =
      new WorkspaceSearchMigrationFailure(
        'CONFIGURATION_DRIFT',
        'tenant-secret-prepare',
      )
    const preparePort = createExecutionRunPort(
      fixture,
      prepareTransport,
    )
    const prepareFailure = await captureMigrationFailure(() =>
      preparePort.create(fixture.currentAuthority)
    )
    expect(prepareFailure.code).toBe('CONFIGURATION_DRIFT')
    expect(prepareTransport.reads).toHaveLength(1)
    expect(prepareTransport.transactions).toHaveLength(0)

    const transactionTransport =
      new RecordingExecutionRunTransport()
    transactionTransport.nextTransactionError =
      new WorkspaceSearchMigrationFailure(
        'TRANSIENT_INFRASTRUCTURE_FAILURE',
        'tenant-secret-post-send-guard',
      )
    const transactionPort = createExecutionRunPort(
      fixture,
      transactionTransport,
    )
    const transactionFailure = await captureMigrationFailure(() =>
      transactionPort.create(fixture.currentAuthority)
    )
    expect(transactionFailure.code).toBe(
      'TRANSIENT_INFRASTRUCTURE_FAILURE',
    )
    expect(transactionTransport.reads).toHaveLength(1)
    expect(transactionFailure.message).not.toContain('tenant-secret')
  })
})

/**
 * Complete internally correlated execution-run AWS fixture.
 */
type ExecutionRunAwsFixture = {
  /** Complete measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact configuration. */
  readonly configurationHash: string
  /** Exact closed writer-fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact strict plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Exact compact immutable sealed root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact current authority used for execution admission. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
}

/**
 * Creates one compact internally correlated adapter fixture.
 *
 * @param variant - Optional stable plan-reference variant.
 * @param graphRetainUntil - Optional shared graph retention deadline.
 * @returns Complete adapter fixture.
 */
function createExecutionRunAwsFixture(
  variant = 'default-plan',
  graphRetainUntil = retainUntil,
): ExecutionRunAwsFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
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
  const receipt = createMaintenanceReceipt(variant)
  const receiptDigest = createMigrationDigest(receipt)
  const currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority = {
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
      drainStartedAt: '2026-07-29T01:00:00.000Z',
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
  const planSeal = createPlanSeal(
    configurationHash,
    variant,
  )
  const sealedPlanningAuthority =
    createCompactSealedAuthority(
      configurationHash,
      writerFence.tableIds,
      planSeal,
      receiptDigest,
      variant,
      graphRetainUntil,
    )
  return {
    configuration,
    configurationHash,
    closedWriterFenceRecord,
    executionBoundary,
    planSeal,
    sealedPlanningAuthority,
    currentAuthority,
  }
}

/**
 * Creates a strict empty plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param variant - Stable fixture variant.
 * @returns Exact plan seal.
 */
function createPlanSeal(
  configurationHash: string,
  variant: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest(`dry-run:${variant}`),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest: createEmptyWorkspaceSearchPlanDigest(),
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt: planCreatedAt,
  }
}

/**
 * Creates one strict compact sealed authority without staging its source graph.
 *
 * The standalone root parser intentionally validates the compact commitments,
 * while graph replay remains the publication adapter's responsibility.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - All six measured table identities.
 * @param planSeal - Exact strict plan seal.
 * @param receiptDigest - Current immutable receipt digest.
 * @param variant - Stable fixture variant.
 * @param graphRetainUntil - Shared graph retention deadline.
 * @returns Exact compact sealed authority.
 */
function createCompactSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
  variant: string,
  graphRetainUntil: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const planManifestDigest = digest(`plan-manifest:${variant}`)
  const provenanceDigest = digest(`provenance:${variant}`)
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
      versionId: `plan-seal-version-${variant}`,
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil: graphRetainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${planManifestDigest}.artifact`,
      versionId: `plan-manifest-version-${variant}`,
      contentDigest: planManifestDigest,
      byteLength: 1,
      retainUntil: graphRetainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
          `workspace-search/v1/planning-provenance-artifacts/v1/${runId}/${configurationHash}`,
          'manifest-heads',
          provenanceDigest,
        ),
      versionId: `provenance-version-${variant}`,
      contentDigest: provenanceDigest,
      byteLength: 1,
      retainUntil: graphRetainUntil,
    },
    planDigest: planSeal.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: planSeal.sourceOperationCount,
    orphanOperationCount: planSeal.orphanOperationCount,
    planOperationCount: planSeal.planOperationCount,
    planningAuthorityProvenanceDigest:
      digest(`authority-provenance:${variant}`),
    historicalReceiptBindingDigest:
      digest(`receipt-binding:${variant}`),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createEvidenceHead('project-directory', variant),
      createEvidenceHead('work-items', variant),
      createEvidenceHead('collaboration', variant),
      createEvidenceHead('documents', variant),
      createEvidenceHead('workspace-search', variant),
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
 * Creates one strict compact terminal evidence head.
 *
 * @param chain - Canonical evidence-chain role.
 * @param variant - Stable fixture variant.
 * @returns Exact compact evidence head.
 */
function createEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
  variant: string,
) {
  return {
    chain,
    progressDigest: digest(`progress:${chain}:${variant}`),
    pageCount: 1,
    terminalEvidenceDigest:
      digest(`evidence:${chain}:${variant}`),
    terminalCheckpointDigest:
      digest(`checkpoint:${chain}:${variant}`),
  }
}

/**
 * Creates one fresh maintenance-evidence receipt.
 *
 * @param variant - Stable fixture variant.
 * @returns Exact current receipt.
 */
function createMaintenanceReceipt(
  variant: string,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest(`maintenance:${variant}`),
    evidenceLocator:
      `workspace-search/v1/maintenance/${variant}.json`,
    runtimeRevision: 41,
    fenceToken: 7,
    validatedAt: evaluatedAt,
    oldestObservationAt: '2026-07-29T01:15:00.000Z',
    validUntil: '2026-07-29T01:20:00.001Z',
  }
}

/**
 * Creates a complete measured migration configuration.
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
      'project-directory':
        createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search':
        createSupportingTable('workspace-search'),
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
      collaboration:
        configuration.tables.collaboration.tableId,
      documents: configuration.tables.documents.tableId,
      'workspace-search':
        configuration.tables['workspace-search'].tableId,
      'migration-state': state.tableId,
    },
  })
}

/**
 * Creates one adapter with the fixture's exact immutable material.
 *
 * @param fixture - Exact adapter fixture.
 * @param transport - Recording test transport.
 * @param clock - Optional adapter-owned test clock.
 * @returns Execution-run port.
 */
function createExecutionRunPort(
  fixture: ExecutionRunAwsFixture,
  transport: RecordingExecutionRunTransport,
  clock: () => Date = createSequencedClock([
    createdAt,
    createdAt,
  ]),
): WorkspaceSearchMigrationExecutionRunAwsPort {
  return createAwsWorkspaceSearchMigrationExecutionRunPort(
    createExecutionRunPortInput(fixture, transport, clock),
  )
}

/**
 * Creates exact object-form standalone adapter construction input.
 *
 * @param fixture - Exact adapter fixture.
 * @param transport - Recording test transport.
 * @param clock - Optional adapter-owned test clock.
 * @returns Complete factory input.
 */
function createExecutionRunPortInput(
  fixture: ExecutionRunAwsFixture,
  transport: RecordingExecutionRunTransport,
  clock: () => Date = createSequencedClock([
    createdAt,
    createdAt,
  ]),
) {
  return {
    configuration: fixture.configuration,
    configurationHash: fixture.configurationHash,
    executionBoundary: fixture.executionBoundary,
    sealedPlanningAuthority:
      fixture.sealedPlanningAuthority,
    planSeal: fixture.planSeal,
    closedWriterFenceRecord:
      fixture.closedWriterFenceRecord,
    transport,
    clock,
  }
}

/**
 * In-memory transport that persists only the adapter-owned execution-run Put.
 */
class RecordingExecutionRunTransport
implements WorkspaceSearchMigrationExecutionRunAwsTransport {
  /** Strong read commands received by the transport. */
  readonly reads: GetItemCommand[] = []

  /** Transaction commands received by the transport. */
  readonly transactions: TransactWriteItemsCommand[] = []

  /** One-shot raw or public transaction failure. */
  nextTransactionError: unknown

  /** Whether the intended Put becomes durable before a raw failure. */
  commitBeforeTransactionError = false

  /** Optional valid or malformed replacement installed before failure. */
  replacementItemAfterTransaction:
    Readonly<Record<string, AttributeValue>> | undefined

  /** Optional managed preparation failure. */
  prepareError: unknown

  /** Optional caller mutation effect run during the first strong read. */
  firstReadEffect: (() => void) | undefined

  /** Exact durable execution-run row. */
  private state:
    Readonly<Record<string, AttributeValue>> | undefined

  /** Whether the first-read mutation hook has run. */
  private firstReadEffectRan = false

  /**
   * Strongly reads one exact execution-run state row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Current durable item or absence.
   */
  readonly getExecutionRunState = async (
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> => {
    this.reads.push(command)
    if (
      !this.firstReadEffectRan &&
      this.firstReadEffect !== undefined
    ) {
      this.firstReadEffectRan = true
      this.firstReadEffect()
    }
    return this.state === undefined
      ? { $metadata: {} }
      : {
          $metadata: {},
          Item: structuredClone(this.state),
        }
  }

  /**
   * Applies one optional managed preparation failure.
   */
  readonly prepareExecutionRunWrite = async (): Promise<void> => {
    if (this.prepareError !== undefined) {
      throw this.prepareError
    }
  }

  /**
   * Records and conditionally applies one execution-run Put.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Empty low-level success response.
   */
  readonly transactWriteExecutionRun = async (
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> => {
    this.transactions.push(command)
    const error = this.nextTransactionError
    this.nextTransactionError = undefined
    if (
      error === undefined ||
      this.commitBeforeTransactionError
    ) {
      this.commit(command)
    }
    if (this.replacementItemAfterTransaction !== undefined) {
      this.state = structuredClone(
        this.replacementItemAfterTransaction,
      )
      this.replacementItemAfterTransaction = undefined
    }
    if (error !== undefined) throw error
    return { $metadata: {} }
  }

  /**
   * Mutates the one durable row for strict-read tests.
   *
   * @param mutate - Focused item mutation.
   */
  mutateState(
    mutate: (item: Record<string, AttributeValue>) => void,
  ): void {
    if (this.state === undefined) {
      throw new Error('Expected durable execution-run state.')
    }
    const mutable = { ...structuredClone(this.state) }
    mutate(mutable)
    this.state = mutable
  }

  /**
   * Applies the transaction's one execution-run Put.
   *
   * @param command - Recorded transaction command.
   */
  private commit(command: TransactWriteItemsCommand): void {
    const item = requirePutItem(
      requirePut(
        requireTransactionItems(command)[
          workspaceSearchMigrationExecutionRunTransactionIndex
            .executionRun
        ],
      ),
    )
    this.state = structuredClone(item)
  }
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
          workspaceSearchMigrationExecutionRunTransactionIndex.count,
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
 * Creates a deterministic adapter clock sequence.
 *
 * @param timestamps - Ordered canonical timestamps.
 * @returns Clock consuming one timestamp per call.
 */
function createSequencedClock(
  timestamps: readonly string[],
): () => Date {
  const queue = [...timestamps]
  return () => {
    const next = queue.shift()
    if (next === undefined) {
      throw new Error('Unexpected test clock read.')
    }
    return new Date(next)
  }
}

/**
 * Removes the digest field from one strict execution-run binding.
 *
 * @param binding - Complete strict binding.
 * @returns Every digest input field.
 */
function withoutBindingDigest(
  binding: WorkspaceSearchMigrationExecutionRunBinding,
): Omit<
  WorkspaceSearchMigrationExecutionRunBinding,
  'bindingDigest'
> {
  const {
    bindingDigest: ignoredBindingDigest,
    ...bindingFields
  } = binding
  void ignoredBindingDigest
  return bindingFields
}

/**
 * Rebuilds all nested execution-run digests after controlled test tampering.
 *
 * @param state - Original strict execution run.
 * @param bindingFields - Replacement binding fields without their digest.
 * @param runState - Replacement state-machine value.
 * @returns Internally valid redigested execution-run envelope.
 */
function redigestExecutionRunWithBinding(
  state: WorkspaceSearchMigrationExecutionRun,
  bindingFields: Omit<
    WorkspaceSearchMigrationExecutionRunBinding,
    'bindingDigest'
  >,
  runState: WorkspaceSearchMigrationExecutionRun['runState'],
): WorkspaceSearchMigrationExecutionRun {
  const binding = {
    ...bindingFields,
    bindingDigest: createMigrationDigest(bindingFields),
  }
  const stateDigest = createMigrationDigest(runState)
  const {
    binding: ignoredBinding,
    executionRunDigest: ignoredExecutionRunDigest,
    runState: ignoredRunState,
    stateDigest: ignoredStateDigest,
    ...envelopeFields
  } = state
  void ignoredBinding
  void ignoredExecutionRunDigest
  void ignoredRunState
  void ignoredStateDigest
  const redigestedFields = {
    ...envelopeFields,
    binding,
    runState,
    stateDigest,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRun,
    'executionRunDigest'
  >
  return {
    ...redigestedFields,
    executionRunDigest: createMigrationDigest(
      redigestedFields,
    ),
  }
}

/**
 * Creates all persisted envelope attributes for one strict execution run.
 *
 * @param state - Strict redigested execution run.
 * @returns Exact low-level envelope attributes.
 */
function createExecutionRunStateAttributes(
  state: WorkspaceSearchMigrationExecutionRun,
): Readonly<Record<string, AttributeValue>> {
  return {
    bindingDigest: { S: state.binding.bindingDigest },
    stateDigest: { S: state.stateDigest },
    executionRunDigest: { S: state.executionRunDigest },
    executionRunBytes: {
      B: serializeWorkspaceSearchMigrationExecutionRun(state),
    },
  }
}

/**
 * Replaces all persisted envelope attributes on one mutable item.
 *
 * @param item - Mutable low-level durable row.
 * @param state - Strict redigested execution run.
 */
function installExecutionRunState(
  item: Record<string, AttributeValue>,
  state: WorkspaceSearchMigrationExecutionRun,
): void {
  const attributes = createExecutionRunStateAttributes(state)
  for (const [name, value] of Object.entries(attributes)) {
    item[name] = value
  }
}

/**
 * Requires one recorded transaction command.
 *
 * @param command - Candidate command.
 * @returns Exact command.
 */
function requireTransaction(
  command: TransactWriteItemsCommand | undefined,
): TransactWriteItemsCommand {
  if (command === undefined) {
    throw new Error('Expected transaction command.')
  }
  return command
}

/**
 * Requires the transaction's fixed item array.
 *
 * @param command - Exact transaction command.
 * @returns Fixed transaction items.
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
 * Requires one transaction ConditionCheck.
 *
 * @param item - Candidate transaction item.
 * @returns Exact ConditionCheck.
 */
function requireConditionCheck(
  item: TransactWriteItem | undefined,
): NonNullable<TransactWriteItem['ConditionCheck']> {
  if (item?.ConditionCheck === undefined) {
    throw new Error('Expected ConditionCheck.')
  }
  return item.ConditionCheck
}

/**
 * Requires one transaction Put.
 *
 * @param item - Candidate transaction item.
 * @returns Exact Put.
 */
function requirePut(
  item: TransactWriteItem | undefined,
): NonNullable<TransactWriteItem['Put']> {
  if (item?.Put === undefined) {
    throw new Error('Expected Put.')
  }
  return item.Put
}

/**
 * Requires one Put's complete item.
 *
 * @param put - Exact transaction Put.
 * @returns Complete low-level item.
 */
function requirePutItem(
  put: NonNullable<TransactWriteItem['Put']>,
): Readonly<Record<string, AttributeValue>> {
  if (put.Item === undefined) {
    throw new Error('Expected Put item.')
  }
  return put.Item
}

/**
 * Captures one asynchronous public migration failure.
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
    if (error instanceof WorkspaceSearchMigrationFailure) {
      return error
    }
    throw error
  }
  throw new Error('Expected WorkspaceSearchMigrationFailure.')
}

/**
 * Captures one synchronous public migration failure.
 *
 * @param operation - Failing construction operation.
 * @returns Exact public migration failure.
 */
function captureSynchronousMigrationFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationFailure {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) {
      return error
    }
    throw error
  }
  throw new Error('Expected WorkspaceSearchMigrationFailure.')
}

/**
 * Computes a stable fixture digest from text.
 *
 * @param value - Stable fixture text.
 * @returns Lowercase SHA-256 digest.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Computes the digest of exact bytes.
 *
 * @param bytes - Exact byte sequence.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
