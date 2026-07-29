import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTraversalProgress,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  zeroHexDigest,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationAppliedRootConditionCheck,
  createWorkspaceSearchMigrationAppliedRootRecord,
  parseWorkspaceSearchMigrationAppliedRootRecord,
  parseWorkspaceSearchMigrationAppliedRootStrongReadOutput,
  type WorkspaceSearchMigrationAppliedRootAwsBindingInput,
} from './migration-applied-root-aws'
import {
  parseWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationCompleteApplySealReference,
} from './migration-apply-seal'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRunBinding,
} from './migration-execution-run'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationRunState,
} from './migration-state-machine'

const runId = 'applied-root-aws-test'
const ownerId = 'applied-root-owner'
const createdAt = '2026-07-29T01:20:00.000Z'
const committedAt = '2026-07-29T01:21:00.000Z'
const retainUntil = '2026-08-30T01:20:00.000Z'

/**
 * Complete correlated applied-root persistence fixture.
 */
type AppliedRootAwsFixture = {
  /** Exact measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the measured configuration. */
  readonly configurationHash: string
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact immutable applied phase root. */
  readonly root: WorkspaceSearchMigrationAppliedRoot
}

describe('Workspace Search applied-root AWS persistence boundary', () => {
  test(
    'round-trips the exact row and pairs every condition field with its canonical value',
    () => {
      const fixture = createFixture()
      const binding = createBinding(fixture)
      const input = { ...binding, root: fixture.root }
      const record =
        createWorkspaceSearchMigrationAppliedRootRecord(input)

      expect(
        parseWorkspaceSearchMigrationAppliedRootRecord({
          ...binding,
          item: record,
        }),
      ).toEqual(fixture.root)

      const condition =
        createWorkspaceSearchMigrationAppliedRootConditionCheck(
          input,
        ).ConditionCheck
      if (
        condition === undefined ||
        condition.ExpressionAttributeNames === undefined ||
        condition.ExpressionAttributeValues === undefined ||
        condition.ConditionExpression === undefined
      ) {
        throw new Error('Expected one complete applied-root condition.')
      }
      const controlled = Object.entries(record).filter(
        ([name]) =>
          name !== 'migrationId' && name !== 'recordKey',
      )
      expect(condition.ConditionExpression).toBe(
        controlled.map(
          (_, index) => `#field${index} = :value${index}`,
        ).join(' AND '),
      )
      for (
        let index = 0;
        index < controlled.length;
        index += 1
      ) {
        const entry = controlled[index]
        if (entry === undefined) {
          throw new Error('Expected one controlled root field.')
        }
        const [name, value] = entry
        expect(
          condition.ExpressionAttributeNames[`#field${index}`],
        ).toBe(name)
        expect(
          condition.ExpressionAttributeValues[`:value${index}`],
        ).toEqual(value)
      }
    },
  )

  test(
    'rejects configuration, table-incarnation, and execution-run drift',
    () => {
      const fixture = createFixture()
      const binding = createBinding(fixture)
      const record =
        createWorkspaceSearchMigrationAppliedRootRecord({
          ...binding,
          root: fixture.root,
        })

      expect(
        captureFailure(() =>
          parseWorkspaceSearchMigrationAppliedRootRecord({
            ...binding,
            configurationHash: digest('foreign-configuration'),
            item: record,
          })
        ).code,
      ).toBe('CONFIGURATION_DRIFT')
      expect(
        captureFailure(() =>
          parseWorkspaceSearchMigrationAppliedRootRecord({
            ...binding,
            stateTable: {
              ...binding.stateTable,
              tableId: 'foreign-migration-state-table-id',
            },
            item: record,
          })
        ).code,
      ).toBe('CONFIGURATION_DRIFT')

      const foreignRun = createExecutionRun(
        fixture.configuration,
        fixture.configurationHash,
        'foreign-applied-root-run',
      )
      expect(
        captureFailure(() =>
          parseWorkspaceSearchMigrationAppliedRootRecord({
            ...binding,
            executionRun: foreignRun,
            item: record,
          })
        ).code,
      ).toBe('INVALID_STATE')
    },
  )

  test(
    'rejects tampered root bytes, Proxy output, and accessors without invoking them',
    () => {
      const fixture = createFixture()
      const binding = createBinding(fixture)
      const record =
        createWorkspaceSearchMigrationAppliedRootRecord({
          ...binding,
          root: fixture.root,
        })
      const rootBytes = record.rootBytes?.B
      if (rootBytes === undefined) {
        throw new Error('Expected canonical applied-root bytes.')
      }
      const corruptedBytes = new Uint8Array(rootBytes)
      corruptedBytes[0] = (corruptedBytes[0] ?? 0) ^ 0xff
      expect(
        captureFailure(() =>
          parseWorkspaceSearchMigrationAppliedRootRecord({
            ...binding,
            item: {
              ...record,
              rootBytes: { B: corruptedBytes },
            },
          })
        ).code,
      ).toBe('INVALID_STATE')

      let proxyTrapReads = 0
      const proxyOutput = new Proxy({}, {
        get: () => {
          proxyTrapReads += 1
          return undefined
        },
      })
      expect(
        captureFailure(() =>
          parseWorkspaceSearchMigrationAppliedRootStrongReadOutput({
            ...binding,
            output: proxyOutput,
          })
        ).code,
      ).toBe('INVALID_STATE')
      expect(proxyTrapReads).toBe(0)

      let accessorReads = 0
      const accessorOutput = {}
      Object.defineProperty(accessorOutput, 'Item', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessorReads += 1
          return record
        },
      })
      expect(
        captureFailure(() =>
          parseWorkspaceSearchMigrationAppliedRootStrongReadOutput({
            ...binding,
            output: accessorOutput,
          })
        ).code,
      ).toBe('INVALID_STATE')
      expect(accessorReads).toBe(0)
    },
  )
})

/**
 * Creates one complete correlated persistence fixture.
 *
 * @returns Exact measured configuration, execution run, and applied root.
 */
function createFixture(): AppliedRootAwsFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const executionRun = createExecutionRun(
    configuration,
    configurationHash,
    runId,
  )
  return {
    configuration,
    configurationHash,
    executionRun,
    root: createAppliedRoot(
      executionRun,
      configurationHash,
      createTableIds(configuration),
    ),
  }
}

/**
 * Creates the exact admitted-run binding used by public helpers.
 *
 * @param fixture - Complete correlated test fixture.
 * @returns Exact applied-root AWS binding.
 */
function createBinding(
  fixture: AppliedRootAwsFixture,
): WorkspaceSearchMigrationAppliedRootAwsBindingInput {
  return {
    stateTable:
      fixture.configuration.tables['migration-state'],
    configurationHash: fixture.configurationHash,
    executionRun: fixture.executionRun,
  }
}

/**
 * Creates one internally consistent revision-one execution admission.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param selectedRunId - Operator-selected run identifier.
 * @returns Detached strict execution-run envelope.
 */
function createExecutionRun(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  selectedRunId: string,
): WorkspaceSearchMigrationExecutionRun {
  const planSeal = createPlanSeal(
    selectedRunId,
    configurationHash,
  )
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const planSealReference = {
    objectKey:
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealDigest}.artifact`,
    versionId: 'plan-seal-version',
    contentDigest: planSealDigest,
    byteLength: planSealBytes.byteLength,
    retainUntil,
  }
  const receipt = createMaintenanceReceipt(selectedRunId)
  const lease = {
    runId: selectedRunId,
    ownerId,
    fenceToken: 7,
    heartbeatAt: '2026-07-29T01:19:30.000Z',
    expiresAt: '2026-07-29T01:20:30.000Z',
  }
  const runState = createWorkspaceSearchMigrationRunState({
    runId: selectedRunId,
    lease,
    ownerId,
    configurationHash,
    configuration,
    maintenanceEvidenceReceipt: receipt,
    dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSeal,
    planSealReference: {
      objectKey: planSealReference.objectKey,
      versionId: planSealReference.versionId,
      contentDigest: planSealReference.contentDigest,
    },
    createdAt,
  })
  const bindingFields = {
    kind: 'workspace-search-migration-execution-run-binding',
    bindingVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    tableIds: createTableIds(configuration),
    executionBoundaryDigest: digest(
      `execution-boundary:${selectedRunId}`,
    ),
    closedWriterFenceRecordDigest: digest(
      `closed-fence:${selectedRunId}`,
    ),
    sealedPlanningAuthorityDigest: digest(
      `sealed-authority:${selectedRunId}`,
    ),
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSealReference,
    currentAuthority: {
      ownerId,
      fenceToken: lease.fenceToken,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(receipt),
      evaluatedAt: '2026-07-29T01:19:45.000Z',
    },
    planningAdmittedAt: '2026-07-29T01:18:00.000Z',
    sealedAt: '2026-07-29T01:19:00.000Z',
    createdAt,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRunBinding,
    'bindingDigest'
  >
  const binding: WorkspaceSearchMigrationExecutionRunBinding = {
    ...bindingFields,
    bindingDigest: createMigrationDigest(bindingFields),
  }
  const envelopeFields = {
    kind: 'workspace-search-migration-execution-run',
    executionRunVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    revision: 1,
    status: 'applying',
    binding,
    runState,
    stateDigest: createMigrationDigest(runState),
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRun,
    'executionRunDigest'
  >
  const executionRun: WorkspaceSearchMigrationExecutionRun = {
    ...envelopeFields,
    executionRunDigest: createMigrationDigest(envelopeFields),
  }
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(executionRun),
  )
}

/**
 * Creates one strict empty plan seal.
 *
 * @param selectedRunId - Operator-selected run identifier.
 * @param configurationHash - Reviewed configuration digest.
 * @returns Exact canonical zero-operation plan seal.
 */
function createPlanSeal(
  selectedRunId: string,
  configurationHash: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest: createEmptyWorkspaceSearchPlanDigest(),
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt: '2026-07-29T01:17:00.000Z',
  }
}

/**
 * Creates one fresh exact-window maintenance receipt.
 *
 * @param selectedRunId - Operator-selected run identifier.
 * @returns Exact maintenance receipt bound to fence seven.
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
    validatedAt: '2026-07-29T01:19:00.000Z',
    oldestObservationAt: '2026-07-29T01:16:00.000Z',
    validUntil: '2026-07-29T01:21:00.001Z',
  }
}

/**
 * Creates one internally consistent immutable applied root.
 *
 * @param executionRun - Exact immutable execution admission.
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - All six exact physical table incarnations.
 * @returns Detached strict applied root.
 */
function createAppliedRoot(
  executionRun: WorkspaceSearchMigrationExecutionRun,
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
): WorkspaceSearchMigrationAppliedRoot {
  const apply = createTerminalTraversal()
  const markerAccumulator = new MigrationDigestAccumulator()
  const sealFields = {
    kind: 'workspace-search-migration-complete-apply-seal',
    sealVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    scope: 'complete-plan',
    runId: executionRun.runId,
    configurationHash,
    executionRunDigest: executionRun.executionRunDigest,
    executionRunBindingDigest:
      executionRun.binding.bindingDigest,
    sealedPlanningAuthorityDigest:
      executionRun.binding.sealedPlanningAuthorityDigest,
    tableIds,
    planSealReference:
      executionRun.binding.planSealReference,
    planDigest: executionRun.binding.planDigest,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    planOperationCount: 0,
    predecessorRevision: 6,
    predecessorExecutionStateDigest:
      digest('predecessor-execution-state'),
    predecessorRunStateDigest: digest('predecessor-run-state'),
    markerCount: 0,
    applyMarkerDigestState: markerAccumulator.exportState(),
    applyMarkerAggregateDigest: markerAccumulator.digest(),
    journalSequence: 0,
    journalHeadDigest: zeroHexDigest(),
    apply,
    applyTraversalDigest: createMigrationDigest(apply),
    createdAt,
  } satisfies Omit<
    WorkspaceSearchMigrationCompleteApplySeal,
    'sealDigest'
  >
  const seal: WorkspaceSearchMigrationCompleteApplySeal = {
    ...sealFields,
    sealDigest: createMigrationDigest(sealFields),
  }
  const sealBytes =
    serializeWorkspaceSearchMigrationCompleteApplySeal(seal)
  const sealReference = {
    scope: 'complete-plan',
    objectKey:
      `workspace-search/v1/apply-seals/${digestBytes(sealBytes)}.artifact`,
    versionId: 'apply-seal-version',
    contentDigest: createMigrationDigest(seal),
    byteLength: sealBytes.byteLength,
    retainUntil,
  } satisfies WorkspaceSearchMigrationCompleteApplySealReference
  const rootFields = {
    kind: 'workspace-search-migration-applied-root',
    rootVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    stateTableId: tableIds['migration-state'],
    configurationHash,
    runId: executionRun.runId,
    executionRunDigest: executionRun.executionRunDigest,
    predecessorRevision: seal.predecessorRevision,
    predecessorExecutionStateDigest:
      seal.predecessorExecutionStateDigest,
    predecessorRunStateDigest:
      seal.predecessorRunStateDigest,
    seal,
    sealReference,
    authority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        executionRun.binding.currentAuthority
          .maintenanceEvidenceReceiptDigest,
      evaluatedAt:
        executionRun.binding.currentAuthority.evaluatedAt,
    },
    successorRevision: 7,
    status: 'applied',
    successorRunStateDigest: digest('successor-run-state'),
    committedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationAppliedRoot,
    'rootDigest'
  >
  const root: WorkspaceSearchMigrationAppliedRoot = {
    ...rootFields,
    rootDigest: createMigrationDigest(rootFields),
  }
  return parseWorkspaceSearchMigrationAppliedRoot(
    serializeWorkspaceSearchMigrationAppliedRoot(root),
  )
}

/**
 * Creates five independent empty terminal verification checkpoints.
 *
 * @returns Complete cursor-free terminal traversal.
 */
function createTerminalTraversal():
WorkspaceSearchMigrationTraversalProgress {
  return {
    sources: {
      'project-directory': createTerminalCheckpoint(),
      'work-items': createTerminalCheckpoint(),
      collaboration: createTerminalCheckpoint(),
      documents: createTerminalCheckpoint(),
    },
    target: createTerminalCheckpoint(),
  }
}

/**
 * Creates one empty completed checkpoint after one bounded page.
 *
 * @returns Exact zero-row terminal checkpoint.
 */
function createTerminalCheckpoint(): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  return {
    completed: true,
    aggregate: {
      scanned: 0,
      mapped: 0,
      ignored: 0,
      invalid: 0,
      projected: 0,
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
 * @returns Complete source table identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured target or migration-state table.
 *
 * @param role - Supporting table role.
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
 * @param key - Exact base-table key schema.
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
 * Captures one expected stable migration failure.
 *
 * @param operation - Synchronous operation expected to fail.
 * @returns Exact public migration failure.
 */
function captureFailure(
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
  throw new Error('Expected one migration failure.')
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
 * Computes one exact byte-sequence digest.
 *
 * @param bytes - Exact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
