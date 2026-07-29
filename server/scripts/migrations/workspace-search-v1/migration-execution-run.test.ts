import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRun,
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type CreateWorkspaceSearchMigrationExecutionRunInput,
  type WorkspaceSearchMigrationExecutionRun,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_RUN_MAX_BYTES,
  WorkspaceSearchMigrationExecutionRunError,
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
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
} from './migration-state-machine'

const runId = 'execution-run-contract-test'
const ownerId = 'execution-run-owner'
const configurationTime = '2026-07-29T00:00:00.000Z'
const closedAt = '2026-07-29T01:00:00.000Z'
const admittedAt = '2026-07-29T01:16:00.000Z'
const planCreatedAt = '2026-07-29T01:17:00.000Z'
const sealedAt = '2026-07-29T01:18:00.000Z'
const evaluatedAt = '2026-07-29T01:19:30.000Z'
const createdAt = '2026-07-29T01:20:00.000Z'
const retainUntil = '2026-08-30T00:00:00.000Z'

/**
 * Complete correlated pure execution-run fixture.
 */
type ExecutionRunFixture = {
  /** Exact creator input. */
  readonly input: CreateWorkspaceSearchMigrationExecutionRunInput
  /** Exact measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact planning-admitted boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact strict plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Exact compact sealed authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact current execution-admission authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
}

describe('Workspace Search migration execution-run contract', () => {
  test('creates and round-trips one exact initial applying run', () => {
    const fixture = createFixture()
    const inputSnapshot = structuredClone(fixture.input)
    const executionRun =
      createWorkspaceSearchMigrationExecutionRun(fixture.input)
    const bytes =
      serializeWorkspaceSearchMigrationExecutionRun(executionRun)

    expect(
      parseWorkspaceSearchMigrationExecutionRun(bytes),
    ).toEqual(executionRun)
    expect(fixture.input).toEqual(inputSnapshot)
    expect(executionRun).toMatchObject({
      runId,
      configurationHash: fixture.configurationHash,
      revision: 1,
      status: 'applying',
      binding: {
        executionBoundaryDigest:
          fixture.executionBoundary.boundaryDigest,
        closedWriterFenceRecordDigest:
          fixture.executionBoundary
            .closedWriterFenceRecordDigest,
        sealedPlanningAuthorityDigest:
          fixture.sealedPlanningAuthority.authorityDigest,
        planDigest: fixture.planSeal.planDigest,
        planOperationCount: 0,
        currentAuthority: {
          ownerId,
          fenceToken: 7,
          maintenanceEvidencePointerRevision: 13,
          maintenanceEvidenceReceiptDigest:
            fixture.currentAuthority
              .maintenanceEvidenceReceiptDigest,
          evaluatedAt,
        },
        planningAdmittedAt: admittedAt,
        sealedAt,
        createdAt,
      },
      runState: {
        revision: 1,
        status: 'applying',
        appliedOperationCount: 0,
        journalSequence: 0,
        createdAt,
        updatedAt: createdAt,
      },
    })
    expect(executionRun.stateDigest).toBe(
      createMigrationDigest(executionRun.runState),
    )
    expect(executionRun.binding.bindingDigest).toBe(
      digestBinding(executionRun),
    )
    expect(executionRun.executionRunDigest).toBe(
      digestExecutionRun(executionRun),
    )
  })

  test('rejects noncanonical, extra, tampered, and oversized data', () => {
    const executionRun =
      createWorkspaceSearchMigrationExecutionRun(
        createFixture().input,
      )
    const canonical =
      serializeWorkspaceSearchMigrationExecutionRun(executionRun)
    const noncanonical = new TextEncoder().encode(
      ` ${new TextDecoder().decode(canonical)}`,
    )
    expectExecutionRunFailure(() =>
      parseWorkspaceSearchMigrationExecutionRun(noncanonical)
    )

    const extended = structuredClone(executionRun)
    Reflect.set(extended, 'tenant-secret-extra', true)
    expectExecutionRunFailure(() =>
      serializeWorkspaceSearchMigrationExecutionRun(extended)
    )

    const tampered = structuredClone(executionRun)
    Reflect.set(tampered.runState, 'planDigest', digest('tampered-plan'))
    expectExecutionRunFailure(() =>
      serializeWorkspaceSearchMigrationExecutionRun(tampered)
    )

    expectExecutionRunFailure(() =>
      parseWorkspaceSearchMigrationExecutionRun(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_EXECUTION_RUN_MAX_BYTES + 1,
        ),
      )
    )
  })

  test('rejects recomputed digests over cross-bound TableId and authority-time tampering', () => {
    const executionRun =
      createWorkspaceSearchMigrationExecutionRun(
        createFixture().input,
      )
    const tableIdTamper = structuredClone(executionRun)
    Reflect.set(
      tableIdTamper.binding.tableIds,
      'documents',
      'replacement-documents-table-id',
    )
    Reflect.set(
      tableIdTamper.binding,
      'bindingDigest',
      digestBinding(tableIdTamper),
    )
    Reflect.set(
      tableIdTamper,
      'executionRunDigest',
      digestExecutionRun(tableIdTamper),
    )
    expectExecutionRunFailure(() =>
      parseWorkspaceSearchMigrationExecutionRun(
        encodeCanonicalJson(tableIdTamper),
      )
    )

    const authorityTimeTamper = structuredClone(executionRun)
    Reflect.set(
      authorityTimeTamper.binding.currentAuthority,
      'evaluatedAt',
      '2026-07-29T01:18:30.000Z',
    )
    Reflect.set(
      authorityTimeTamper.binding,
      'bindingDigest',
      digestBinding(authorityTimeTamper),
    )
    Reflect.set(
      authorityTimeTamper,
      'executionRunDigest',
      digestExecutionRun(authorityTimeTamper),
    )
    expectExecutionRunFailure(() =>
      parseWorkspaceSearchMigrationExecutionRun(
        encodeCanonicalJson(authorityTimeTamper),
      )
    )
  })

  test('rejects cross-run, configuration, TableId, root, and plan-reference mismatches', () => {
    const fixture = createFixture()
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        executionBoundary: createExecutionBoundary(
          'another-execution-run',
          fixture.configurationHash,
          createTableIds(fixture.configuration),
        ),
      })
    )
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        configurationHash: digest('another-configuration'),
      })
    )
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        executionBoundary: createExecutionBoundary(
          runId,
          fixture.configurationHash,
          {
            ...createTableIds(fixture.configuration),
            documents: 'replacement-documents-table-id',
          },
        ),
      })
    )
    const foreignRoot = createSealedAuthority(
      digest('foreign-root-configuration'),
      createTableIds(fixture.configuration),
      fixture.planSeal,
      fixture.sealedPlanningAuthority.currentAuthority
        .maintenanceEvidenceReceiptDigest,
    )
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        sealedPlanningAuthority: foreignRoot,
      })
    )
    const mismatchedReferenceRoot = withPlanSealReferenceDigest(
      fixture.sealedPlanningAuthority,
      digest('foreign-plan-seal-bytes'),
    )
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        sealedPlanningAuthority: mismatchedReferenceRoot,
      })
    )
  })

  test('rejects invalid temporal chains including a root newer than current evaluation', () => {
    const fixture = createFixture()
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        createdAt: '2026-07-29T01:17:30.000Z',
      })
    )
    const earlyPlan = {
      ...fixture.planSeal,
      createdAt: '2026-07-29T00:59:59.000Z',
    }
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        planSeal: earlyPlan,
        sealedPlanningAuthority: createSealedAuthority(
          fixture.configurationHash,
          createTableIds(fixture.configuration),
          earlyPlan,
          fixture.sealedPlanningAuthority.currentAuthority
            .maintenanceEvidenceReceiptDigest,
        ),
      })
    )
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        sealedPlanningAuthority: createSealedAuthority(
          fixture.configurationHash,
          createTableIds(fixture.configuration),
          fixture.planSeal,
          fixture.sealedPlanningAuthority.currentAuthority
            .maintenanceEvidenceReceiptDigest,
          '2026-07-29T01:19:45.000Z',
        ),
      })
    )
  })

  test('rejects stale root-authority rollback and permits a newer takeover fence', () => {
    const fixture = createFixture()
    const stalePointerAuthority = createCurrentAuthority(
      fixture.configurationHash,
      fixture.configuration,
      7,
      ownerId,
      11,
    )
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        currentAuthority: stalePointerAuthority,
      })
    )
    const staleAuthority = createCurrentAuthority(
      fixture.configurationHash,
      fixture.configuration,
      6,
      'stale-execution-owner',
      99,
    )
    expectExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        currentAuthority: staleAuthority,
      })
    )

    const takeoverAuthority = createCurrentAuthority(
      fixture.configurationHash,
      fixture.configuration,
      8,
      'takeover-execution-owner',
      1,
    )
    const takeover =
      createWorkspaceSearchMigrationExecutionRun({
        ...fixture.input,
        currentAuthority: takeoverAuthority,
      })
    expect(takeover.binding.currentAuthority).toMatchObject({
      ownerId: 'takeover-execution-owner',
      fenceToken: 8,
      maintenanceEvidencePointerRevision: 1,
    })
  })

  test('detaches caller input and maps hostile access to a raw-value-free error', () => {
    const fixture = createFixture()
    const executionRun =
      createWorkspaceSearchMigrationExecutionRun(fixture.input)
    fixture.configuration.profile = 'mutated-after-creation'
    fixture.currentAuthority.maintenanceEvidenceReceipt
      .evidenceLocator = 'tenant-secret-mutated-locator'
    expect(executionRun.runState.configuration.profile).toBe(
      'production-operator',
    )
    expect(
      executionRun.runState.maintenanceEvidenceLocator,
    ).not.toContain('tenant-secret')

    const proxied = new Proxy(fixture.input, {
      ownKeys() {
        throw new Error('tenant-secret-proxy')
      },
    })
    const failure = captureExecutionRunFailure(() =>
      createWorkspaceSearchMigrationExecutionRun(proxied)
    )
    expect(failure.code).toBe('INVALID_MIGRATION_EXECUTION_RUN')
    expect(failure.message).toBe('INVALID_MIGRATION_EXECUTION_RUN')
    expect(failure.message).not.toContain('tenant-secret')
  })

  test('accepts only the cursor-free revision-one applying state shape', () => {
    const executionRun =
      createWorkspaceSearchMigrationExecutionRun(
        createFixture().input,
      )
    const withCursor = structuredClone(executionRun)
    Reflect.set(withCursor.runState.apply.target, 'cursor', {
      workspaceId: { S: 'tenant-secret-workspace' },
    })
    Reflect.set(
      withCursor,
      'stateDigest',
      createMigrationDigest(withCursor.runState),
    )
    Reflect.set(
      withCursor,
      'executionRunDigest',
      digestExecutionRun(withCursor),
    )
    expectExecutionRunFailure(() =>
      serializeWorkspaceSearchMigrationExecutionRun(withCursor)
    )

    const laterRevision = structuredClone(executionRun)
    Reflect.set(laterRevision.runState, 'revision', 2)
    Reflect.set(laterRevision, 'revision', 2)
    Reflect.set(
      laterRevision,
      'stateDigest',
      createMigrationDigest(laterRevision.runState),
    )
    expectExecutionRunFailure(() =>
      serializeWorkspaceSearchMigrationExecutionRun(laterRevision)
    )
  })
})

/**
 * Creates one compact internally correlated pure fixture.
 *
 * @returns Complete execution-run creator fixture.
 */
function createFixture(): ExecutionRunFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const tableIds = createTableIds(configuration)
  const executionBoundary = createExecutionBoundary(
    runId,
    configurationHash,
    tableIds,
  )
  const planSeal = createPlanSeal(configurationHash)
  const sealedReceiptDigest = digest('sealed-current-receipt')
  const sealedPlanningAuthority = createSealedAuthority(
    configurationHash,
    tableIds,
    planSeal,
    sealedReceiptDigest,
  )
  const currentAuthority = createCurrentAuthority(
    configurationHash,
    configuration,
    7,
    ownerId,
    13,
  )
  return {
    input: {
      executionBoundary,
      sealedPlanningAuthority,
      planSeal,
      configuration,
      configurationHash,
      currentAuthority,
      createdAt,
    },
    configuration,
    configurationHash,
    executionBoundary,
    planSeal,
    sealedPlanningAuthority,
    currentAuthority,
  }
}

/**
 * Creates one strict planning-admitted execution boundary.
 *
 * @param selectedRunId - Run fixed by the boundary.
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - All six physical table incarnations.
 * @returns Exact revision-two boundary.
 */
function createExecutionBoundary(
  selectedRunId: string,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  const closeReceiptDigest = digest('close-maintenance-receipt')
  const fields = {
    kind: 'workspace-search-migration-execution-boundary',
    boundaryVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    tableIds,
    closedWriterFenceRecordDigest: digest('closed-writer-fence'),
    closedAt,
    closeAuthority: {
      configurationHash,
      runId: selectedRunId,
      ownerId,
      leaseFenceToken: 7,
      maintenanceEvidenceReceiptDigest: closeReceiptDigest,
      maintenanceEvidencePointerRevision: 11,
    },
    phase: 'planning-admitted',
    revision: 2,
    planningAdmission: {
      ownerId,
      leaseFenceToken: 7,
      maintenanceEvidenceReceiptDigest:
        digest('planning-admission-receipt'),
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceDigest:
        digest('planning-admission-evidence'),
      maintenanceEvidenceLocator:
        'workspace-search/v1/maintenance/planning.json',
      runtimeRevision: 41,
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
 * Creates one strict empty plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @returns Exact canonical empty plan seal.
 */
function createPlanSeal(
  configurationHash: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest: createEmptyWorkspaceSearchPlanDigest(),
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt: planCreatedAt,
  }
}

/**
 * Creates one strict compact sealed planning authority.
 *
 * @param configurationHash - Configuration digest stored by the root.
 * @param tableIds - All six TableIds stored by the root.
 * @param planSeal - Exact referenced plan seal.
 * @param receiptDigest - Receipt digest fixed by sealed planning.
 * @param rootSealedAt - Optional root publication time.
 * @returns Exact version-two compact authority.
 */
function createSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
  rootSealedAt = sealedAt,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const planManifestDigest = digest('plan-manifest')
  const provenanceManifestDigest = digest('provenance-manifest')
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
      versionId: 'plan-seal-version-1',
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${planManifestDigest}.artifact`,
      versionId: 'plan-manifest-version-1',
      contentDigest: planManifestDigest,
      byteLength: 1,
      retainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
          `workspace-search/v1/planning-provenance-artifacts/v1/${runId}/${configurationHash}`,
          'manifest-heads',
          provenanceManifestDigest,
        ),
      versionId: 'provenance-manifest-version-1',
      contentDigest: provenanceManifestDigest,
      byteLength: 1,
      retainUntil,
    },
    planDigest: planSeal.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: planSeal.sourceOperationCount,
    orphanOperationCount: planSeal.orphanOperationCount,
    planOperationCount: planSeal.planOperationCount,
    planningAuthorityProvenanceDigest:
      digest('planning-authority-provenance'),
    historicalReceiptBindingDigest:
      digest('historical-receipt-binding'),
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
    sealedAt: rootSealedAt,
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
 * Replaces a root's plan-seal digest while retaining standalone validity.
 *
 * @param current - Existing strict sealed root.
 * @param contentDigest - Replacement exact-byte digest.
 * @returns Re-digested root with a mismatched plan-seal reference.
 */
function withPlanSealReferenceDigest(
  current: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  contentDigest: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const fields = {
    kind: current.kind,
    authorityVersion: current.authorityVersion,
    migrationId: current.migrationId,
    migrationVersion: current.migrationVersion,
    runId: current.runId,
    configurationHash: current.configurationHash,
    tableIds: current.tableIds,
    planSealReference: {
      ...current.planSealReference,
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${contentDigest}.artifact`,
      contentDigest,
    },
    planManifestHeadReference:
      current.planManifestHeadReference,
    planningProvenanceManifestHeadReference:
      current.planningProvenanceManifestHeadReference,
    planDigest: current.planDigest,
    planningSnapshotDigest: current.planningSnapshotDigest,
    sourceOperationCount: current.sourceOperationCount,
    orphanOperationCount: current.orphanOperationCount,
    planOperationCount: current.planOperationCount,
    planningAuthorityProvenanceDigest:
      current.planningAuthorityProvenanceDigest,
    historicalReceiptBindingDigest:
      current.historicalReceiptBindingDigest,
    historicalReceiptCount: current.historicalReceiptCount,
    evidenceHeads: current.evidenceHeads,
    currentAuthority: current.currentAuthority,
    sealedAt: current.sealedAt,
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
 * Creates one fresh current pre-plan authority.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param configuration - Exact measured configuration.
 * @param fenceToken - Current lease fence.
 * @param selectedOwnerId - Current lease owner.
 * @param pointerRevision - Current receipt pointer revision.
 * @returns Exact fresh current authority.
 */
function createCurrentAuthority(
  configurationHash: string,
  configuration: WorkspaceSearchMigrationConfiguration,
  fenceToken: number,
  selectedOwnerId: string,
  pointerRevision: number,
): WorkspaceSearchMigrationPrePlanAuthority {
  const receipt = createMaintenanceReceipt(fenceToken)
  return {
    configurationHash,
    stateTableId:
      configuration.tables['migration-state'].tableId,
    lease: {
      runId,
      ownerId: selectedOwnerId,
      fenceToken,
      heartbeatAt: evaluatedAt,
      expiresAt: '2026-07-29T01:20:30.000Z',
    },
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(receipt),
    maintenanceEvidencePointerRevision: pointerRevision,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt,
  }
}

/**
 * Creates one fresh exact-window maintenance receipt.
 *
 * @param fenceToken - Lease fence bound to the receipt.
 * @returns Exact fresh receipt.
 */
function createMaintenanceReceipt(
  fenceToken: number,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest(`maintenance:${fenceToken}`),
    evidenceLocator:
      `workspace-search/v1/maintenance/fence-${fenceToken}.json`,
    runtimeRevision: 41,
    fenceToken,
    validatedAt: '2026-07-29T01:19:00.000Z',
    oldestObservationAt: '2026-07-29T01:16:00.000Z',
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
 * @returns Complete source table identity.
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
 * @returns Complete supporting table identity.
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
 * Creates all six exact TableIds from measured configuration.
 *
 * @param configuration - Complete measured configuration.
 * @returns Fixed-role physical table incarnations.
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
 * Recomputes one binding digest without its digest field.
 *
 * @param executionRun - Complete execution run.
 * @returns Expected binding digest.
 */
function digestBinding(
  executionRun: WorkspaceSearchMigrationExecutionRun,
): string {
  const binding = executionRun.binding
  return createMigrationDigest({
    kind: binding.kind,
    bindingVersion: binding.bindingVersion,
    migrationId: binding.migrationId,
    migrationVersion: binding.migrationVersion,
    runId: binding.runId,
    configurationHash: binding.configurationHash,
    tableIds: binding.tableIds,
    executionBoundaryDigest: binding.executionBoundaryDigest,
    closedWriterFenceRecordDigest:
      binding.closedWriterFenceRecordDigest,
    sealedPlanningAuthorityDigest:
      binding.sealedPlanningAuthorityDigest,
    planDigest: binding.planDigest,
    planOperationCount: binding.planOperationCount,
    planSealReference: binding.planSealReference,
    currentAuthority: binding.currentAuthority,
    planningAdmittedAt: binding.planningAdmittedAt,
    sealedAt: binding.sealedAt,
    createdAt: binding.createdAt,
  })
}

/**
 * Recomputes one execution-run digest without its digest field.
 *
 * @param executionRun - Complete execution run.
 * @returns Expected envelope digest.
 */
function digestExecutionRun(
  executionRun: WorkspaceSearchMigrationExecutionRun,
): string {
  return createMigrationDigest({
    kind: executionRun.kind,
    executionRunVersion: executionRun.executionRunVersion,
    migrationId: executionRun.migrationId,
    migrationVersion: executionRun.migrationVersion,
    runId: executionRun.runId,
    configurationHash: executionRun.configurationHash,
    revision: executionRun.revision,
    status: executionRun.status,
    binding: executionRun.binding,
    runState: executionRun.runState,
    stateDigest: executionRun.stateDigest,
  })
}

/**
 * Encodes one candidate graph as canonical JSON bytes without contract validation.
 *
 * @param value - Candidate graph, including deliberately recomputed tampering.
 * @returns Canonical UTF-8 bytes accepted by the strict parser boundary.
 */
function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Captures the stable public execution-run error.
 *
 * @param operation - Expected failing operation.
 * @returns Stable execution-run failure.
 */
function captureExecutionRunFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationExecutionRunError {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationExecutionRunError) {
      return error
    }
    throw error
  }
  throw new Error('Expected execution-run failure.')
}

/**
 * Expects one operation to fail at the stable execution-run boundary.
 *
 * @param operation - Expected failing operation.
 */
function expectExecutionRunFailure(operation: () => unknown): void {
  const failure = captureExecutionRunFailure(operation)
  expect(failure.code).toBe('INVALID_MIGRATION_EXECUTION_RUN')
  expect(failure.message).toBe('INVALID_MIGRATION_EXECUTION_RUN')
}

/**
 * Computes one stable fixture digest from text.
 *
 * @param value - Stable fixture text.
 * @returns Lowercase SHA-256 digest.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Computes one exact byte-sequence digest.
 *
 * @param bytes - Exact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
