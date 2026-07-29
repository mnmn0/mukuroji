import { types as nodeUtilTypes } from 'node:util'
import {
  GetItemCommand,
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactionConflictException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  isThrottlingError,
  isTransientError,
} from '@smithy/core/retry'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedConditionCheck,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  readWorkspaceSearchWriterFenceClosedRecord,
  WorkspaceSearchWriterFenceError,
  workspaceSearchWriterFenceTableRoles,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
  type WorkspaceSearchWriterFenceTableIds,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  parseWorkspaceSearchPlanSeal,
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck,
} from './migration-execution-boundary-aws'
import {
  detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary,
  parseWorkspaceSearchMigrationExecutionBoundary,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  WorkspaceSearchMigrationExecutionBoundaryError,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRun,
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_RUN_MAX_BYTES,
  WorkspaceSearchMigrationExecutionRunError,
  type WorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRunAuthorityBinding,
} from './migration-execution-run'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck,
} from './migration-sealed-planning-authority-aws'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  WorkspaceSearchMigrationSealedPlanningAuthorityV2Error,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'

const executionRunRecordKind =
  'workspace-search-migration-execution-run-state'
const executionRunRecordVersion = 1
const executionRunRecordKeyPrefix = 'execution-run/v1'
const executionRunTransactionItemCount = 7

/**
 * Fixed transaction and cancellation-reason positions for execution-run
 * admission.
 */
export const workspaceSearchMigrationExecutionRunTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two planning-admitted boundary condition. */
    executionBoundary: 4,
    /** Exact immutable sealed planning-authority root condition. */
    sealedPlanningAuthority: 5,
    /** Absent deterministic execution-run state Put. */
    executionRun: 6,
    /** Fixed transaction item count. */
    count: executionRunTransactionItemCount,
  })

/**
 * Exact immutable execution-run admission row required by later transactions.
 */
export type CreateWorkspaceSearchMigrationExecutionRunAdmissionConditionCheckInput =
  {
    /** Exact measured migration-state table identity. */
    readonly stateTable: MigrationTableIdentity
    /** Exact reviewed configuration digest. */
    readonly configurationHash: string
    /** Strict revision-one admission envelope read from durable storage. */
    readonly executionRun: WorkspaceSearchMigrationExecutionRun
  }

/**
 * Adapter-owned source of trusted execution-run commit time.
 *
 * @returns Current trusted adapter time.
 */
export type WorkspaceSearchMigrationExecutionRunAwsClock = () => Date

/**
 * Narrow migration-state transport used by execution-run admission.
 */
export interface WorkspaceSearchMigrationExecutionRunAwsTransport {
  /**
   * Strongly reads one exact execution-run state row.
   *
   * @param command - Adapter-owned strongly consistent GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getExecutionRunState(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes measured-incarnation guards immediately before commit.
   */
  prepareExecutionRunWrite(): Promise<void>

  /**
   * Commits one exact fixed-order seven-item admission transaction.
   *
   * @param command - Adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB response.
   */
  transactWriteExecutionRun(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Dependencies bound by one standalone execution-run AWS adapter.
 */
export type CreateWorkspaceSearchMigrationExecutionRunAwsPortInput = {
  /** Complete independently measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Exact revision-two planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning-authority version-two root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact strict canonical plan seal referenced by the sealed root. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Exact canonical closed writer-fence row fixed by the boundary. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Narrow state-table transport. */
  readonly transport: WorkspaceSearchMigrationExecutionRunAwsTransport
  /** Adapter-owned trusted clock. */
  readonly clock: WorkspaceSearchMigrationExecutionRunAwsClock
}

/**
 * Durable execution-run admission operations for one exact sealed plan.
 */
export interface WorkspaceSearchMigrationExecutionRunAwsPort {
  /**
   * Strongly reads the deterministic execution-run state.
   *
   * @param runId - Operator-selected migration run.
   * @returns Exact durable execution run or undefined when absent.
   */
  read(
    runId: string,
  ): Promise<WorkspaceSearchMigrationExecutionRun | undefined>

  /**
   * Atomically creates revision-one applying state under current authority.
   *
   * @param currentAuthority - Exact fresh lease, pointer, and receipt.
   * @returns Exact durable revision-one execution-run state.
   */
  create(
    currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchMigrationExecutionRun>
}

/**
 * Detached exact material retained by one execution-run adapter.
 */
type ExecutionRunAdapterBinding = {
  /** Complete detached measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed exact configuration digest. */
  readonly configurationHash: string
  /** Exact detached migration-state table identity. */
  readonly stateTable: MigrationTableIdentity
  /** Independently reconstructed six-table writer-fence binding. */
  readonly writerFence: WorkspaceSearchWriterFenceBinding
  /** Exact canonical closed writer-fence record. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable sealed planning-authority root. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact canonical plan seal. */
  readonly planSeal: WorkspaceSearchPlanSeal
  /** Digest of static material expected in every durable state. */
  readonly staticMaterialDigest: string
}

/**
 * Captured transport functions immune to later caller property replacement.
 */
type PreparedExecutionRunTransport = {
  /**
   * Strongly reads one exact state-table row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level response.
   */
  readonly get: (
    command: GetItemCommand,
  ) => Promise<GetItemCommandOutput>
  /** Runs the final measured-incarnation preparation. */
  readonly prepare: () => Promise<void>
  /**
   * Sends one exact execution-run transaction.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Raw low-level response.
   */
  readonly transact: (
    command: TransactWriteItemsCommand,
  ) => Promise<TransactWriteItemsCommandOutput>
}

/**
 * Secret-free structural AWS error supplied to Smithy's classifiers.
 */
type ExecutionRunAwsClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout code. */
    readonly code?: string
  }

/**
 * Private stable failure used inside the execution-run AWS boundary.
 */
class ExecutionRunAwsFailure extends Error {
  /** Stable raw-value-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private stable failure.
   *
   * @param code - Operator-safe migration failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'ExecutionRunAwsFailure'
    this.code = code
  }
}

/**
 * Concrete standalone execution-run create/read adapter.
 */
class AwsWorkspaceSearchMigrationExecutionRunPort
implements WorkspaceSearchMigrationExecutionRunAwsPort {
  /** Detached exact execution-run binding. */
  private readonly binding: ExecutionRunAdapterBinding

  /** Captured narrow state-table transport. */
  private readonly transport: PreparedExecutionRunTransport

  /** Adapter-owned trusted commit clock. */
  private readonly clock: WorkspaceSearchMigrationExecutionRunAwsClock

  /**
   * Creates one already validated execution-run adapter.
   *
   * @param binding - Exact detached adapter binding.
   * @param transport - Captured narrow transport.
   * @param clock - Adapter-owned trusted clock.
   */
  constructor(
    binding: ExecutionRunAdapterBinding,
    transport: PreparedExecutionRunTransport,
    clock: WorkspaceSearchMigrationExecutionRunAwsClock,
  ) {
    this.binding = binding
    this.transport = transport
    this.clock = clock
  }

  /**
   * Strongly reads the deterministic execution-run state.
   *
   * @param runId - Operator-selected migration run.
   * @returns Exact durable state or undefined.
   */
  async read(
    runId: string,
  ): Promise<WorkspaceSearchMigrationExecutionRun | undefined> {
    return runExecutionRunAwsBoundary(async () => {
      const exactRunId = readExecutionRunId(runId)
      if (exactRunId !== this.binding.executionBoundary.runId) {
        return failExecutionRunAws('INVALID_ARGUMENT')
      }
      return this.readState()
    })
  }

  /**
   * Atomically creates revision-one applying execution state.
   *
   * @param currentAuthority - Exact fresh current pre-plan authority.
   * @returns Exact durable state.
   */
  async create(
    currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchMigrationExecutionRun> {
    return runExecutionRunAwsBoundary(async () => {
      const authority = prepareExecutionRunAuthority(
        currentAuthority,
        this.binding,
      )
      const preflightAt = readExecutionRunClock(this.clock)
      validateExecutionRunCreation(
        this.binding,
        authority,
        preflightAt,
      )
      const durableBefore = await this.readState()
      if (durableBefore !== undefined) return durableBefore

      await this.transport.prepare()
      const commitAt = readExecutionRunClock(this.clock)
      if (commitAt.getTime() < preflightAt.getTime()) {
        return failExecutionRunAws('INVALID_STATE')
      }
      const intended = createExecutionRunState(
        this.binding,
        authority,
        commitAt,
      )
      const command = createExecutionRunTransactionCommand(
        this.binding,
        authority,
        intended,
        commitAt,
      )
      let transactionError: unknown
      try {
        await this.transport.transact(command)
      } catch (error: unknown) {
        const guardCode =
          readExecutionRunTransportGuardFailureCode(error)
        if (guardCode !== undefined) {
          return failExecutionRunAws(guardCode)
        }
        transactionError = error
      }
      return this.reconcileCreate(transactionError)
    })
  }

  /**
   * Reconciles one attempted create through an exact strong reread.
   *
   * @param transactionError - Raw transaction failure, if one occurred.
   * @returns Exact durable intended state.
   */
  private async reconcileCreate(
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationExecutionRun> {
    let durable: WorkspaceSearchMigrationExecutionRun | undefined
    try {
      durable = await this.readState()
    } catch (error: unknown) {
      return failExecutionRunAws(
        readExecutionRunReconciliationFailureCode(error),
      )
    }
    // Static-material equality is enforced while parsing, so another fresh
    // caller's durable row is the same admission even when createdAt differs.
    if (durable !== undefined) {
      return durable
    }
    return failExecutionRunAws(
      transactionError === undefined
        ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
        : classifyExecutionRunTransactionError(transactionError),
    )
  }

  /**
   * Strongly reads and strictly parses the one bound run-state row.
   *
   * @returns Exact durable state or undefined.
   */
  private async readState():
  Promise<WorkspaceSearchMigrationExecutionRun | undefined> {
    const output = await this.transport.get(
      createExecutionRunReadCommand(this.binding),
    )
    const item = readExecutionRunOutputItem(output)
    return item === undefined
      ? undefined
      : parseExecutionRunRecord(this.binding, item)
  }
}

/**
 * Creates one measured standalone execution-run adapter.
 *
 * @param input - Exact configuration, planning authority, fence, and transport.
 * @returns Durable execution-run create/read port.
 */
export function createAwsWorkspaceSearchMigrationExecutionRunPort(
  input: CreateWorkspaceSearchMigrationExecutionRunAwsPortInput,
): WorkspaceSearchMigrationExecutionRunAwsPort {
  try {
    const record = requireExecutionRunInputRecord(input)
    requireExactExecutionRunInputKeys(record, [
      'clock',
      'closedWriterFenceRecord',
      'configuration',
      'configurationHash',
      'executionBoundary',
      'planSeal',
      'sealedPlanningAuthority',
      'transport',
    ])
    const binding = createExecutionRunAdapterBinding(
      input.configuration,
      input.configurationHash,
      input.executionBoundary,
      input.sealedPlanningAuthority,
      input.planSeal,
      input.closedWriterFenceRecord,
    )
    const transport = prepareExecutionRunTransport(
      input.transport,
    )
    const clock = input.clock
    if (
      typeof clock !== 'function' ||
      nodeUtilTypes.isProxy(clock)
    ) {
      return failExecutionRunAws('INVALID_ARGUMENT')
    }
    return new AwsWorkspaceSearchMigrationExecutionRunPort(
      binding,
      transport,
      clock,
    )
  } catch (error: unknown) {
    throw createExecutionRunAwsPublicFailure(
      readExecutionRunAwsFailureCode(error, true),
    )
  }
}

/**
 * Creates the exact immutable admission-row check used by later execution work.
 *
 * The caller must supply an admission envelope obtained through the bound
 * execution-run port. This helper snapshots it through the strict canonical
 * codec and compares every durable admission attribute, including its bytes.
 *
 * @param input - Exact state-table identity, configuration, and admission.
 * @returns One immutable execution-run admission ConditionCheck.
 */
export function createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck(
  input:
    CreateWorkspaceSearchMigrationExecutionRunAdmissionConditionCheckInput,
): TransactWriteItem {
  try {
    const record = requireExecutionRunInputRecord(input)
    requireExactExecutionRunInputKeys(record, [
      'configurationHash',
      'executionRun',
      'stateTable',
    ])
    const strict = parseWorkspaceSearchMigrationExecutionRun(
      serializeWorkspaceSearchMigrationExecutionRun(input.executionRun),
    )
    const stateTableValue = input.stateTable
    if (
      typeof stateTableValue !== 'object' ||
      stateTableValue === null ||
      nodeUtilTypes.isProxy(stateTableValue)
    ) {
      return failExecutionRunAws('INVALID_ARGUMENT')
    }
    const stateTableName = readExecutionRunOwnDataValue(
      stateTableValue,
      'tableName',
      'INVALID_ARGUMENT',
    )
    const stateTableId = readExecutionRunOwnDataValue(
      stateTableValue,
      'tableId',
      'INVALID_ARGUMENT',
    )
    const stateTableRole = readExecutionRunOwnDataValue(
      stateTableValue,
      'role',
      'INVALID_ARGUMENT',
    )
    const expectedStateTable =
      strict.runState.configuration.tables['migration-state']
    if (
      stateTableRole !== 'migration-state' ||
      stateTableName !== expectedStateTable.tableName ||
      stateTableId !== expectedStateTable.tableId ||
      input.configurationHash !== strict.configurationHash
    ) {
      return failExecutionRunAws('CONFIGURATION_DRIFT')
    }
    const bytes =
      serializeWorkspaceSearchMigrationExecutionRun(strict)
    const conditionAttributes = {
      kind: { S: executionRunRecordKind },
      version: { N: String(executionRunRecordVersion) },
      stateTableId: { S: expectedStateTable.tableId },
      configurationHash: { S: strict.configurationHash },
      runId: { S: strict.runId },
      revision: { N: String(strict.revision) },
      status: { S: strict.status },
      bindingDigest: { S: strict.binding.bindingDigest },
      stateDigest: { S: strict.stateDigest },
      executionRunDigest: { S: strict.executionRunDigest },
      executionRunBytes: { B: bytes },
    } satisfies Readonly<Record<string, AttributeValue>>
    const names: Record<string, string> = {}
    const values: Record<string, AttributeValue> = {}
    const clauses: string[] = []
    let index = 0
    for (const [name, value] of Object.entries(conditionAttributes)) {
      const nameToken = `#field${index}`
      const valueToken = `:value${index}`
      names[nameToken] = name
      values[valueToken] = value
      clauses.push(`${nameToken} = ${valueToken}`)
      index += 1
    }
    return {
      ConditionCheck: {
        TableName: expectedStateTable.tableName,
        Key: {
          migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
          recordKey: {
            S: createExecutionRunRecordKeyFromIdentity(
              expectedStateTable.tableId,
              strict.configurationHash,
              strict.runId,
            ),
          },
        },
        ConditionExpression: clauses.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValuesOnConditionCheckFailure: 'NONE',
      },
    }
  } catch (error: unknown) {
    throw createExecutionRunAwsPublicFailure(
      readExecutionRunAwsFailureCode(error, true),
    )
  }
}

/**
 * Constructs and cross-validates one exact detached adapter binding.
 *
 * @param configurationValue - Candidate measured configuration.
 * @param configurationHashValue - Candidate reviewed digest.
 * @param executionBoundaryValue - Candidate revision-two boundary.
 * @param sealedPlanningAuthorityValue - Candidate immutable sealed root.
 * @param planSealValue - Candidate strict canonical plan seal.
 * @param closedWriterFenceRecordValue - Candidate exact closed fence row.
 * @returns Complete exact adapter binding.
 */
function createExecutionRunAdapterBinding(
  configurationValue: WorkspaceSearchMigrationConfiguration,
  configurationHashValue: string,
  executionBoundaryValue:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
  sealedPlanningAuthorityValue:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  planSealValue: WorkspaceSearchPlanSeal,
  closedWriterFenceRecordValue:
    WorkspaceSearchWriterFenceClosedRecord,
): ExecutionRunAdapterBinding {
  if (
    typeof configurationHashValue !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(configurationHashValue)
  ) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  let configuration: WorkspaceSearchMigrationConfiguration
  let executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  let sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  let planSeal: WorkspaceSearchPlanSeal
  let closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  try {
    configuration =
      detachWorkspaceSearchMigrationPlanningConfiguration(
        configurationValue,
      )
    const boundary =
      parseWorkspaceSearchMigrationExecutionBoundary(
        serializeWorkspaceSearchMigrationExecutionBoundary(
          executionBoundaryValue,
        ),
      )
    if (boundary.phase !== 'planning-admitted') {
      return failExecutionRunAws('INVALID_ARGUMENT')
    }
    executionBoundary = boundary
    sealedPlanningAuthority =
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          sealedPlanningAuthorityValue,
        ),
      )
    planSeal = parseWorkspaceSearchPlanSeal(
      serializeWorkspaceSearchPlanSeal(planSealValue),
    )
    closedWriterFenceRecord =
      readWorkspaceSearchWriterFenceClosedRecord(
        closedWriterFenceRecordValue,
      )
  } catch {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  let measuredHash: string
  try {
    measuredHash =
      createWorkspaceSearchConfigurationHash(configuration)
  } catch {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  if (measuredHash !== configurationHashValue) {
    return failExecutionRunAws('CONFIGURATION_HASH_MISMATCH')
  }
  const stateTable = configuration.tables['migration-state']
  const tableIds = createExecutionRunTableIds(configuration)
  const writerFence = createWorkspaceSearchWriterFenceBinding({
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
    tableIds,
  })
  requireExecutionRunConstructionBinding({
    configurationHash: configurationHashValue,
    tableIds,
    writerFence,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    planSeal,
  })
  return {
    configuration,
    configurationHash: configurationHashValue,
    stateTable,
    writerFence,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    planSeal,
    staticMaterialDigest:
      createStaticExecutionRunMaterialDigest({
        configurationHash: configurationHashValue,
        runId: executionBoundary.runId,
        tableIds,
        executionBoundaryDigest:
          executionBoundary.boundaryDigest,
        closedWriterFenceRecordDigest:
          closedWriterFenceRecord.recordDigest,
        sealedPlanningAuthorityDigest:
          sealedPlanningAuthority.authorityDigest,
        planDigest: planSeal.planDigest,
        planOperationCount: planSeal.planOperationCount,
        planSealReference:
          sealedPlanningAuthority.planSealReference,
      }),
  }
}

/**
 * Independently projects all six physical TableIds from configuration.
 *
 * @param configuration - Detached measured configuration.
 * @returns Exact role-indexed physical TableIds.
 */
function createExecutionRunTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchWriterFenceTableIds {
  const tableIds: WorkspaceSearchWriterFenceTableIds = {
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
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      configuration.tables[role].role !== role ||
      typeof tableIds[role] !== 'string' ||
      tableIds[role].length === 0
    ) {
      return failExecutionRunAws('INVALID_ARGUMENT')
    }
  }
  return tableIds
}

/**
 * Cross-checks every construction-time execution admission dependency.
 *
 * @param input - Detached exact planning and writer-fence material.
 */
function requireExecutionRunConstructionBinding(
  input: {
    /** Reviewed configuration digest. */
    readonly configurationHash: string
    /** Independently projected all-six-table binding. */
    readonly tableIds: WorkspaceSearchWriterFenceTableIds
    /** Independently reconstructed writer-fence binding. */
    readonly writerFence: WorkspaceSearchWriterFenceBinding
    /** Exact closed writer-fence row. */
    readonly closedWriterFenceRecord:
      WorkspaceSearchWriterFenceClosedRecord
    /** Exact planning-admitted boundary. */
    readonly executionBoundary:
      WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
    /** Exact sealed authority root. */
    readonly sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2
    /** Exact canonical plan seal. */
    readonly planSeal: WorkspaceSearchPlanSeal
  },
): void {
  const boundary = input.executionBoundary
  const root = input.sealedPlanningAuthority
  const planSeal = input.planSeal
  const fence = input.closedWriterFenceRecord
  if (
    boundary.configurationHash !== input.configurationHash ||
    root.configurationHash !== input.configurationHash ||
    planSeal.configurationHash !== input.configurationHash ||
    root.runId !== boundary.runId ||
    planSeal.runId !== boundary.runId ||
    fence.recordDigest !==
      boundary.closedWriterFenceRecordDigest ||
    fence.closedAt !== boundary.closedAt ||
    fence.binding.recordKey !== input.writerFence.recordKey ||
    fence.binding.stateIncarnationDigest !==
      input.writerFence.stateIncarnationDigest ||
    fence.binding.datasetBindingDigest !==
      input.writerFence.datasetBindingDigest ||
    !sameExecutionRunCloseAuthority(
      fence.authority,
      boundary.closeAuthority,
    ) ||
    planSeal.planDigest !== root.planDigest ||
    planSeal.planOperationCount !== root.planOperationCount ||
    planSeal.sourceOperationCount !== root.sourceOperationCount ||
    planSeal.orphanOperationCount !== root.orphanOperationCount ||
    planSeal.planningSnapshotDigest !==
      root.planningSnapshotDigest
  ) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      boundary.tableIds[role] !== input.tableIds[role] ||
      root.tableIds[role] !== input.tableIds[role] ||
      fence.binding.tableIds[role] !== input.tableIds[role]
    ) {
      return failExecutionRunAws('CONFIGURATION_DRIFT')
    }
  }
  const planSealBytes =
    serializeWorkspaceSearchPlanSeal(planSeal)
  if (
    root.planSealReference.contentDigest !==
      createMigrationDigest(planSeal) ||
    root.planSealReference.byteLength !== planSealBytes.byteLength ||
    Date.parse(boundary.planningAdmission.admittedAt) >
      Date.parse(planSeal.createdAt) ||
    Date.parse(planSeal.createdAt) > Date.parse(root.sealedAt)
  ) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
}

/**
 * Compares every stable field in two exact writer-fence authorities.
 *
 * @param left - First authority.
 * @param right - Second authority.
 * @returns Whether every stable authority field is equal.
 */
function sameExecutionRunCloseAuthority(
  left: WorkspaceSearchWriterFenceClosedRecord['authority'],
  right: WorkspaceSearchWriterFenceClosedRecord['authority'],
): boolean {
  return left.configurationHash === right.configurationHash &&
    left.runId === right.runId &&
    left.ownerId === right.ownerId &&
    left.leaseFenceToken === right.leaseFenceToken &&
    left.maintenanceEvidenceReceiptDigest ===
      right.maintenanceEvidenceReceiptDigest &&
    left.maintenanceEvidencePointerRevision ===
      right.maintenanceEvidencePointerRevision
}

/**
 * Captures and validates the three narrow transport functions.
 *
 * @param value - Candidate execution-run transport.
 * @returns Bound immutable transport functions.
 */
function prepareExecutionRunTransport(
  value: unknown,
): PreparedExecutionRunTransport {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  const get = readExecutionRunOwnDataValue(
    value,
    'getExecutionRunState',
    'INVALID_ARGUMENT',
  )
  const prepare = readExecutionRunOwnDataValue(
    value,
    'prepareExecutionRunWrite',
    'INVALID_ARGUMENT',
  )
  const transact = readExecutionRunOwnDataValue(
    value,
    'transactWriteExecutionRun',
    'INVALID_ARGUMENT',
  )
  if (
    typeof get !== 'function' ||
    typeof prepare !== 'function' ||
    typeof transact !== 'function'
  ) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  return {
    get: get.bind(value),
    prepare: prepare.bind(value),
    transact: transact.bind(value),
  }
}

/**
 * Detaches and validates current authority before the first await.
 *
 * @param value - Candidate caller-owned authority.
 * @param binding - Exact adapter binding.
 * @returns Exact detached authority.
 */
function prepareExecutionRunAuthority(
  value: WorkspaceSearchMigrationPrePlanAuthority,
  binding: ExecutionRunAdapterBinding,
): WorkspaceSearchMigrationPrePlanAuthority {
  let authority: WorkspaceSearchMigrationPrePlanAuthority
  try {
    authority =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        value,
      )
  } catch {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  if (
    authority.configurationHash !== binding.configurationHash ||
    authority.stateTableId !== binding.stateTable.tableId ||
    authority.lease.runId !== binding.executionBoundary.runId
  ) {
    return failExecutionRunAws('CONFIGURATION_DRIFT')
  }
  return authority
}

/**
 * Validates authority freshness and the complete pure create graph.
 *
 * @param binding - Exact adapter binding.
 * @param authority - Detached current authority.
 * @param at - Adapter-owned validation instant.
 */
function validateExecutionRunCreation(
  binding: ExecutionRunAdapterBinding,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  at: Date,
): void {
  try {
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority,
      commitAt: at,
    })
    createExecutionRunState(binding, authority, at)
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) throw error
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
}

/**
 * Creates the strict pure revision-one applying envelope.
 *
 * @param binding - Exact adapter binding.
 * @param authority - Exact fresh current authority.
 * @param createdAt - Adapter-owned creation time.
 * @returns Detached strict execution-run state.
 */
function createExecutionRunState(
  binding: ExecutionRunAdapterBinding,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  createdAt: Date,
): WorkspaceSearchMigrationExecutionRun {
  try {
    const run = createWorkspaceSearchMigrationExecutionRun({
      executionBoundary: binding.executionBoundary,
      sealedPlanningAuthority:
        binding.sealedPlanningAuthority,
      planSeal: binding.planSeal,
      configuration: binding.configuration,
      configurationHash: binding.configurationHash,
      currentAuthority: authority,
      createdAt: createdAt.toISOString(),
    })
    requireExecutionRunStaticBinding(binding, run)
    return run
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) throw error
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
}

/**
 * Creates the exact fixed-order seven-item admission transaction.
 *
 * @param binding - Exact measured adapter binding.
 * @param authority - Exact current pre-plan authority.
 * @param intended - Exact revision-one state to publish.
 * @param commitAt - Adapter-owned transaction instant.
 * @returns Adapter-owned DynamoDB transaction command.
 */
function createExecutionRunTransactionCommand(
  binding: ExecutionRunAdapterBinding,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  intended: WorkspaceSearchMigrationExecutionRun,
  commitAt: Date,
): TransactWriteItemsCommand {
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority,
      commitAt,
    })
  const writerFenceCheck =
    createWorkspaceSearchWriterFenceClosedConditionCheck(
      binding.closedWriterFenceRecord,
      binding.writerFence,
    )
  const executionBoundaryCheck =
    createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
      {
        stateTable: binding.stateTable,
        configurationHash: binding.configurationHash,
        boundary: binding.executionBoundary,
      },
    )
  const sealedPlanningAuthorityCheck =
    createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck(
      {
        stateTable: binding.stateTable,
        configurationHash: binding.configurationHash,
        authority: binding.sealedPlanningAuthority,
      },
    )
  const executionRunPut =
    createExecutionRunAbsentPut(binding, intended)
  const items: TransactWriteItem[] = [
    ...authorityChecks,
    writerFenceCheck,
    executionBoundaryCheck,
    sealedPlanningAuthorityCheck,
    executionRunPut,
  ]
  const index =
    workspaceSearchMigrationExecutionRunTransactionIndex
  if (
    authorityChecks.length !== index.writerFence ||
    items.length !== executionRunTransactionItemCount
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken:
      createExecutionRunTransactionToken(intended),
    TransactItems: items,
  })
}

/**
 * Creates the conditional absent-row Put for revision-one execution state.
 *
 * @param binding - Exact adapter binding.
 * @param state - Exact intended execution state.
 * @returns One adapter-owned conditional Put.
 */
function createExecutionRunAbsentPut(
  binding: ExecutionRunAdapterBinding,
  state: WorkspaceSearchMigrationExecutionRun,
): TransactWriteItem {
  const put: NonNullable<TransactWriteItem['Put']> = {
    TableName: binding.stateTable.tableName,
    Item: createExecutionRunRecord(binding, state),
    ConditionExpression:
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    ExpressionAttributeNames: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
    ReturnValuesOnConditionCheckFailure: 'NONE',
  }
  return { Put: put }
}

/**
 * Creates one complete exact durable execution-run item.
 *
 * @param binding - Exact adapter binding.
 * @param state - Exact strict execution state.
 * @returns Complete low-level DynamoDB item.
 */
function createExecutionRunRecord(
  binding: ExecutionRunAdapterBinding,
  state: WorkspaceSearchMigrationExecutionRun,
): Readonly<Record<string, AttributeValue>> {
  const bytes = serializeWorkspaceSearchMigrationExecutionRun(state)
  const strict =
    parseWorkspaceSearchMigrationExecutionRun(bytes)
  requireExecutionRunStaticBinding(binding, strict)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createExecutionRunRecordKey(binding),
    },
    kind: { S: executionRunRecordKind },
    version: { N: String(executionRunRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: strict.runId },
    revision: { N: String(strict.revision) },
    status: { S: strict.status },
    bindingDigest: { S: strict.binding.bindingDigest },
    stateDigest: { S: strict.stateDigest },
    executionRunDigest: { S: strict.executionRunDigest },
    executionRunBytes: { B: bytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses and cross-checks one complete durable execution-run item.
 *
 * @param binding - Exact adapter binding.
 * @param item - Raw low-level DynamoDB item.
 * @returns Exact detached execution-run state.
 */
function parseExecutionRunRecord(
  binding: ExecutionRunAdapterBinding,
  item: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationExecutionRun {
  requireExactExecutionRunRecordKeys(item)
  if (
    readExecutionRunStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readExecutionRunStringAttribute(item, 'recordKey') !==
      createExecutionRunRecordKey(binding) ||
    readExecutionRunStringAttribute(item, 'kind') !==
      executionRunRecordKind ||
    readExecutionRunNumberAttribute(item, 'version') !==
      executionRunRecordVersion ||
    readExecutionRunStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readExecutionRunStringAttribute(
      item,
      'configurationHash',
    ) !== binding.configurationHash ||
    readExecutionRunStringAttribute(item, 'runId') !==
      binding.executionBoundary.runId
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const bytes = readExecutionRunBinaryAttribute(
    item,
    'executionRunBytes',
  )
  let state: WorkspaceSearchMigrationExecutionRun
  try {
    state = parseWorkspaceSearchMigrationExecutionRun(bytes)
  } catch {
    return failExecutionRunAws('INVALID_STATE')
  }
  requireExecutionRunStaticBinding(binding, state)
  if (
    state.revision !==
      readExecutionRunNumberAttribute(item, 'revision') ||
    state.status !==
      readExecutionRunStringAttribute(item, 'status') ||
    state.binding.bindingDigest !==
      readExecutionRunStringAttribute(item, 'bindingDigest') ||
    state.stateDigest !==
      readExecutionRunStringAttribute(item, 'stateDigest') ||
    state.executionRunDigest !==
      readExecutionRunStringAttribute(item, 'executionRunDigest')
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return state
}

/**
 * Requires a strict run state to match all static construction material.
 *
 * @param binding - Exact adapter binding.
 * @param state - Strict detached execution-run state.
 */
function requireExecutionRunStaticBinding(
  binding: ExecutionRunAdapterBinding,
  state: WorkspaceSearchMigrationExecutionRun,
): void {
  if (
    state.runId !== binding.executionBoundary.runId ||
    state.configurationHash !== binding.configurationHash ||
    state.revision !== 1 ||
    state.status !== 'applying' ||
    state.runState.dryRunEvidenceDigest !==
      binding.planSeal.dryRunEvidenceDigest ||
    state.binding.planningAdmittedAt !==
      binding.executionBoundary.planningAdmission.admittedAt ||
    state.binding.sealedAt !==
      binding.sealedPlanningAuthority.sealedAt ||
    !executionRunAuthoritySucceedsSealedPlanningAuthority(
      binding.sealedPlanningAuthority.currentAuthority,
      state.binding.currentAuthority,
    ) ||
    createStaticExecutionRunMaterialDigest({
      configurationHash: state.configurationHash,
      runId: state.runId,
      tableIds: state.binding.tableIds,
      executionBoundaryDigest:
        state.binding.executionBoundaryDigest,
      closedWriterFenceRecordDigest:
        state.binding.closedWriterFenceRecordDigest,
      sealedPlanningAuthorityDigest:
        state.binding.sealedPlanningAuthorityDigest,
      planDigest: state.binding.planDigest,
      planOperationCount: state.binding.planOperationCount,
      planSealReference: state.binding.planSealReference,
    }) !== binding.staticMaterialDigest
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
}

/**
 * Determines whether durable execution authority is the sealed authority or
 * one monotonic successor that could have admitted the same immutable plan.
 *
 * A higher takeover fence may select a new owner and pointer. Within the same
 * fence, the owner remains fixed, pointer revision cannot decrease, and an
 * unchanged pointer must identify the exact sealed receipt.
 *
 * @param sealed - Authority fixed by immutable sealed planning.
 * @param durable - Authority recorded by execution-run admission.
 * @returns Whether durable authority is a valid same-or-later successor.
 */
function executionRunAuthoritySucceedsSealedPlanningAuthority(
  sealed:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2['currentAuthority'],
  durable: WorkspaceSearchMigrationExecutionRunAuthorityBinding,
): boolean {
  if (durable.fenceToken > sealed.fenceToken) return true
  if (
    durable.fenceToken !== sealed.fenceToken ||
    durable.ownerId !== sealed.ownerId ||
    durable.maintenanceEvidencePointerRevision <
      sealed.maintenanceEvidencePointerRevision
  ) {
    return false
  }
  return durable.maintenanceEvidencePointerRevision !==
    sealed.maintenanceEvidencePointerRevision ||
    durable.maintenanceEvidenceReceiptDigest ===
      sealed.maintenanceEvidenceReceiptDigest
}

/**
 * Creates a digest of only immutable static execution-admission material.
 *
 * Mutable lease freshness and the adapter-created timestamp are deliberately
 * excluded so a later fresh caller can recover the same already-created run.
 *
 * @param input - Stable execution admission projection.
 * @returns Lowercase SHA-256 static-material digest.
 */
function createStaticExecutionRunMaterialDigest(
  input: {
    /** Reviewed configuration digest. */
    readonly configurationHash: string
    /** Operator-selected run. */
    readonly runId: string
    /** All six immutable physical table identities. */
    readonly tableIds: WorkspaceSearchWriterFenceTableIds
    /** Exact planning-admitted execution boundary digest. */
    readonly executionBoundaryDigest: string
    /** Exact closed writer-fence row digest. */
    readonly closedWriterFenceRecordDigest: string
    /** Exact immutable sealed planning-authority digest. */
    readonly sealedPlanningAuthorityDigest: string
    /** Exact complete operation-plan digest. */
    readonly planDigest: string
    /** Exact complete operation count. */
    readonly planOperationCount: number
    /** Exact rich immutable plan-seal reference. */
    readonly planSealReference:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2['planSealReference']
  },
): string {
  return createMigrationDigest({
    kind: 'workspace-search-migration-execution-run-static-material',
    version: executionRunRecordVersion,
    configurationHash: input.configurationHash,
    runId: input.runId,
    tableIds: input.tableIds,
    executionBoundaryDigest: input.executionBoundaryDigest,
    closedWriterFenceRecordDigest:
      input.closedWriterFenceRecordDigest,
    sealedPlanningAuthorityDigest:
      input.sealedPlanningAuthorityDigest,
    planDigest: input.planDigest,
    planOperationCount: input.planOperationCount,
    planSealReference: input.planSealReference,
  })
}

/**
 * Creates one strongly consistent deterministic execution-run read.
 *
 * @param binding - Exact adapter binding.
 * @returns Adapter-owned GetItem command.
 */
function createExecutionRunReadCommand(
  binding: ExecutionRunAdapterBinding,
): GetItemCommand {
  return new GetItemCommand({
    TableName: binding.stateTable.tableName,
    ConsistentRead: true,
    Key: {
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: {
        S: createExecutionRunRecordKey(binding),
      },
    },
  })
}

/**
 * Creates one bounded deterministic execution-run record key.
 *
 * @param binding - Exact adapter binding.
 * @returns Deterministic run/configuration state key.
 */
function createExecutionRunRecordKey(
  binding: ExecutionRunAdapterBinding,
): string {
  return createExecutionRunRecordKeyFromIdentity(
    binding.stateTable.tableId,
    binding.configurationHash,
    binding.executionBoundary.runId,
  )
}

/**
 * Creates the deterministic admission-row key from exact immutable identity.
 *
 * @param stateTableId - Immutable migration-state TableId.
 * @param configurationHash - Exact reviewed configuration digest.
 * @param runId - Operator-selected migration run.
 * @returns Deterministic run/configuration admission key.
 */
function createExecutionRunRecordKeyFromIdentity(
  stateTableId: string,
  configurationHash: string,
  runId: string,
): string {
  const digest = createMigrationDigest({
    kind: 'workspace-search-migration-execution-run-binding',
    version: executionRunRecordVersion,
    stateTableId,
    configurationHash,
    runId,
  })
  return `${executionRunRecordKeyPrefix}/${digest}/state`
}

/**
 * Creates a bounded deterministic transaction idempotency token.
 *
 * @param state - Exact intended execution-run state.
 * @returns Stable at-most-36-character DynamoDB token.
 */
function createExecutionRunTransactionToken(
  state: WorkspaceSearchMigrationExecutionRun,
): string {
  return createMigrationDigest({
    kind: 'workspace-search-migration-execution-run-create',
    version: executionRunRecordVersion,
    runId: state.runId,
    executionRunDigest: state.executionRunDigest,
  }).slice(0, 36)
}

/**
 * Reads an optional GetItem result without invoking output accessors.
 *
 * @param output - Raw low-level DynamoDB response.
 * @returns Raw item data property or undefined.
 */
function readExecutionRunOutputItem(
  output: GetItemCommandOutput,
): Readonly<Record<string, AttributeValue>> | undefined {
  if (
    typeof output !== 'object' ||
    output === null ||
    nodeUtilTypes.isProxy(output)
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const descriptor = Object.getOwnPropertyDescriptor(output, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
    typeof descriptor.value !== 'object' ||
    descriptor.value === null ||
    Array.isArray(descriptor.value) ||
    nodeUtilTypes.isProxy(descriptor.value)
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Requires the exact durable execution-run field set.
 *
 * @param item - Candidate low-level DynamoDB item.
 */
function requireExactExecutionRunRecordKeys(
  item: Readonly<Record<string, AttributeValue>>,
): void {
  if (
    typeof item !== 'object' ||
    item === null ||
    Array.isArray(item) ||
    nodeUtilTypes.isProxy(item) ||
    Object.getPrototypeOf(item) !== Object.prototype
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const expected = [
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
  ]
  const actual = Object.keys(item).sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  for (const key of expected) {
    readExecutionRunOwnDataValue(
      item,
      key,
      'INVALID_STATE',
    )
  }
}

/**
 * Reads one required exact single-string DynamoDB attribute.
 *
 * @param item - Strict durable item.
 * @param name - Required field name.
 * @returns Exact string value.
 */
function readExecutionRunStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = readExecutionRunOwnDataValue(
    item,
    name,
    'INVALID_STATE',
  )
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const stringValue = readExecutionRunOwnDataValue(
    value,
    'S',
    'INVALID_STATE',
  )
  if (typeof stringValue !== 'string') {
    return failExecutionRunAws('INVALID_STATE')
  }
  return stringValue
}

/**
 * Reads one required exact nonnegative integer DynamoDB attribute.
 *
 * @param item - Strict durable item.
 * @param name - Required field name.
 * @returns Exact safe integer.
 */
function readExecutionRunNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const value = readExecutionRunOwnDataValue(
    item,
    name,
    'INVALID_STATE',
  )
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const numberValue = readExecutionRunOwnDataValue(
    value,
    'N',
    'INVALID_STATE',
  )
  if (
    typeof numberValue !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(numberValue)
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const parsed = Number(numberValue)
  if (!Number.isSafeInteger(parsed)) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return parsed
}

/**
 * Reads and copies one required exact binary DynamoDB attribute.
 *
 * @param item - Strict durable item.
 * @param name - Required field name.
 * @returns Detached binary bytes.
 */
function readExecutionRunBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const value = readExecutionRunOwnDataValue(
    item,
    name,
    'INVALID_STATE',
  )
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return copyExecutionRunBytes(
    readExecutionRunOwnDataValue(
      value,
      'B',
      'INVALID_STATE',
    ),
  )
}

/**
 * Copies one intrinsic, non-shared Uint8Array.
 *
 * @param value - Candidate byte sequence.
 * @returns Detached exact bytes.
 */
function copyExecutionRunBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const byteLength =
    readExecutionRunIntrinsicByteLength(value)
  if (
    byteLength === 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_RUN_MAX_BYTES
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const buffer = readExecutionRunIntrinsicByteBuffer(value)
  if (nodeUtilTypes.isSharedArrayBuffer(buffer)) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const copy = new Uint8Array(value)
  if (copy.byteLength !== byteLength) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return copy
}

/**
 * Reads a Uint8Array view's intrinsic byte length.
 *
 * @param value - Validated non-Proxy Uint8Array.
 * @returns Exact intrinsic byte length.
 */
function readExecutionRunIntrinsicByteLength(
  value: Uint8Array,
): number {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  if (typedArrayPrototype === null) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
  )
  if (descriptor?.get === undefined) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const byteLength: unknown = Reflect.apply(
    descriptor.get,
    value,
    [],
  )
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return byteLength
}

/**
 * Reads a Uint8Array view's intrinsic backing buffer.
 *
 * @param value - Validated non-Proxy Uint8Array.
 * @returns Exact intrinsic backing buffer.
 */
function readExecutionRunIntrinsicByteBuffer(
  value: Uint8Array,
): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  if (typedArrayPrototype === null) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'buffer',
  )
  if (descriptor?.get === undefined) {
    return failExecutionRunAws('INVALID_STATE')
  }
  const buffer: unknown = Reflect.apply(
    descriptor.get,
    value,
    [],
  )
  if (
    !nodeUtilTypes.isArrayBuffer(buffer) &&
    !nodeUtilTypes.isSharedArrayBuffer(buffer)
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return buffer
}

/**
 * Reads one adapter clock using intrinsic Date access.
 *
 * @param clock - Adapter-owned clock.
 * @returns Detached exact trusted time.
 */
function readExecutionRunClock(
  clock: WorkspaceSearchMigrationExecutionRunAwsClock,
): Date {
  let value: Date
  try {
    value = clock()
  } catch {
    return failExecutionRunAws('INVALID_STATE')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failExecutionRunAws('INVALID_STATE')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failExecutionRunAws('INVALID_STATE')
  }
  return new Date(epochMilliseconds)
}

/**
 * Validates one bounded operator-selected run identifier.
 *
 * @param value - Candidate run identifier.
 * @returns Exact validated run identifier.
 */
function readExecutionRunId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires one plain exact input object.
 *
 * @param value - Candidate factory input.
 * @returns Plain input record.
 */
function requireExecutionRunInputRecord(
  value: unknown,
): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires the exact enumerable factory input key set.
 *
 * @param value - Candidate plain input object.
 * @param keys - Exact sorted field names.
 */
function requireExactExecutionRunInputKeys(
  value: object,
  keys: readonly string[],
): void {
  const expected = [...keys].sort()
  const ownKeys = Reflect.ownKeys(value)
  const actual: string[] = []
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return failExecutionRunAws('INVALID_ARGUMENT')
    }
    actual.push(key)
  }
  actual.sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failExecutionRunAws('INVALID_ARGUMENT')
  }
  for (const key of expected) {
    readExecutionRunOwnDataValue(
      value,
      key,
      'INVALID_ARGUMENT',
    )
  }
}

/**
 * Reads one own enumerable data property without invoking accessors.
 *
 * @param value - Candidate containing object.
 * @param key - Required own field.
 * @param failureCode - Stable code for malformed descriptors.
 * @returns Untrusted descriptor value.
 */
function readExecutionRunOwnDataValue(
  value: object,
  key: PropertyKey,
  failureCode: WorkspaceSearchMigrationFailureCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failExecutionRunAws(failureCode)
  }
  return descriptor.value
}

/**
 * Classifies one transaction failure only after a strong absent reread.
 *
 * @param error - Raw transaction error retained inside the private boundary.
 * @returns Stable retry, authority, ambiguous, or fail-closed code.
 */
function classifyExecutionRunTransactionError(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (isExecutionRunResourceNotFoundError(error)) {
      return 'CONFIGURATION_DRIFT'
    }
    if (
      error instanceof TransactionConflictException ||
      readExecutionRunErrorName(error) ===
        'TransactionConflictException'
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (
      error instanceof TransactionCanceledException ||
      readExecutionRunErrorName(error) ===
        'TransactionCanceledException'
    ) {
      const index =
        workspaceSearchMigrationExecutionRunTransactionIndex
      if (
        readExecutionRunCancellationReasonCode(
          error,
          index.lease,
        ) === 'ConditionalCheckFailed'
      ) {
        return 'LEASE_LOST'
      }
      if (
        readExecutionRunCancellationReasonCode(
          error,
          index.pointer,
        ) === 'ConditionalCheckFailed' ||
        readExecutionRunCancellationReasonCode(
          error,
          index.receipt,
        ) === 'ConditionalCheckFailed'
      ) {
        return 'INVALID_MAINTENANCE_EVIDENCE'
      }
      for (
        let conditionIndex = index.writerFence;
        conditionIndex <= index.executionRun;
        conditionIndex += 1
      ) {
        if (
          readExecutionRunCancellationReasonCode(
            error,
            conditionIndex,
          ) === 'ConditionalCheckFailed'
        ) {
          return 'INVALID_STATE'
        }
      }
      if (executionRunCancellationHasConditionalFailure(error)) {
        return 'INVALID_STATE'
      }
      return executionRunCancellationWasTransient(error)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (
      readExecutionRunErrorName(error) ===
        'TransactionInProgressException'
    ) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const input =
      createExecutionRunAwsClassificationInput(error)
    if (isThrottlingError(input)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (isTransientError(input)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    return 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Reads one fixed transaction cancellation reason.
 *
 * @param error - Raw DynamoDB cancellation.
 * @param index - Zero-based transaction item index.
 * @returns Stable reason code or undefined.
 */
function readExecutionRunCancellationReasonCode(
  error: unknown,
  index: number,
): string | undefined {
  try {
    const reasons: unknown = Reflect.get(
      Object(error),
      'CancellationReasons',
    )
    if (!Array.isArray(reasons)) return undefined
    const reason: unknown = reasons[index]
    if (typeof reason !== 'object' || reason === null) {
      return undefined
    }
    const code: unknown = Reflect.get(reason, 'Code')
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Detects any conditional failure in a transaction cancellation.
 *
 * @param error - Raw DynamoDB cancellation.
 * @returns Whether any item rejected its condition.
 */
function executionRunCancellationHasConditionalFailure(
  error: unknown,
): boolean {
  for (
    let index = 0;
    index <
      workspaceSearchMigrationExecutionRunTransactionIndex.count;
    index += 1
  ) {
    if (
      readExecutionRunCancellationReasonCode(error, index) ===
        'ConditionalCheckFailed'
    ) {
      return true
    }
  }
  return false
}

/**
 * Detects an explicitly retry-safe cancellation reason.
 *
 * @param error - Raw DynamoDB cancellation.
 * @returns Whether any reason proves infrastructure rejection.
 */
function executionRunCancellationWasTransient(
  error: unknown,
): boolean {
  for (
    let index = 0;
    index <
      workspaceSearchMigrationExecutionRunTransactionIndex.count;
    index += 1
  ) {
    const code = readExecutionRunCancellationReasonCode(
      error,
      index,
    )
    if (
      code === 'TransactionConflict' ||
      code === 'ProvisionedThroughputExceeded' ||
      code === 'ThrottlingError'
    ) {
      return true
    }
  }
  return false
}

/**
 * Preserves one managed transport guard failure without reconciliation.
 *
 * @param error - Candidate public guard failure.
 * @returns Stable code that must bypass reconciliation.
 */
function readExecutionRunTransportGuardFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode | undefined {
  if (!(error instanceof WorkspaceSearchMigrationFailure)) {
    return undefined
  }
  const code: unknown = error.code
  if (!isWorkspaceSearchMigrationFailureCode(code)) {
    return 'INVALID_STATE'
  }
  return code
}

/**
 * Classifies a failed post-transaction reconciliation read.
 *
 * @param error - Reread or parse failure.
 * @returns Stable fail-closed reconciliation code.
 */
function readExecutionRunReconciliationFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  if (error instanceof ExecutionRunAwsFailure) {
    return error.code
  }
  if (error instanceof WorkspaceSearchMigrationFailure) {
    const code: unknown = error.code
    if (!isWorkspaceSearchMigrationFailureCode(code)) {
      return 'INVALID_STATE'
    }
    return code === 'TRANSIENT_INFRASTRUCTURE_FAILURE'
      ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
      : code
  }
  return isExecutionRunResourceNotFoundError(error)
    ? 'CONFIGURATION_DRIFT'
    : 'AMBIGUOUS_OPERATION_UNRESOLVED'
}

/**
 * Detects a missing or replaced DynamoDB resource.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether it denotes resource absence.
 */
function isExecutionRunResourceNotFoundError(
  error: unknown,
): boolean {
  return error instanceof ResourceNotFoundException ||
    readExecutionRunErrorName(error) ===
      'ResourceNotFoundException'
}

/**
 * Reads one stable Error name.
 *
 * @param error - Candidate raw error.
 * @returns Stable name or undefined.
 */
function readExecutionRunErrorName(
  error: unknown,
): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined
    const name: unknown = Reflect.get(error, 'name')
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * Supplies only structural retry-classifier fields.
 *
 * @param error - Raw SDK or Node.js error.
 * @returns Detached secret-free classifier input.
 */
function createExecutionRunAwsClassificationInput(
  error: Error,
): ExecutionRunAwsClassificationInput {
  const name = readExecutionRunErrorName(error)
  const code = readExecutionRunOptionalErrorCode(error)
  return {
    name: name ?? 'Error',
    message: '',
    ...(code === undefined ? {} : { code }),
    $metadata: readExecutionRunOptionalErrorMetadata(error),
    $retryable: readExecutionRunOptionalRetryable(error),
  }
}

/**
 * Reads one optional bounded Node.js error code.
 *
 * @param error - Candidate raw Error.
 * @returns Bounded code or undefined.
 */
function readExecutionRunOptionalErrorCode(
  error: Error,
): string | undefined {
  try {
    const code: unknown = Reflect.get(error, 'code')
    return typeof code === 'string' && code.length <= 128
      ? code
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads safe Smithy metadata fields without retaining raw response data.
 *
 * @param error - Candidate raw Error.
 * @returns Structural metadata only.
 */
function readExecutionRunOptionalErrorMetadata(
  error: Error,
): ExecutionRunAwsClassificationInput['$metadata'] {
  try {
    const value: unknown = Reflect.get(error, '$metadata')
    if (typeof value !== 'object' || value === null) {
      return undefined
    }
    const httpStatusCode: unknown =
      Reflect.get(value, 'httpStatusCode')
    const attempts: unknown = Reflect.get(value, 'attempts')
    const totalRetryDelay: unknown =
      Reflect.get(value, 'totalRetryDelay')
    return {
      ...(typeof httpStatusCode === 'number'
        ? { httpStatusCode }
        : {}),
      ...(typeof attempts === 'number' ? { attempts } : {}),
      ...(typeof totalRetryDelay === 'number'
        ? { totalRetryDelay }
        : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Reads the structural Smithy retryable marker.
 *
 * @param error - Candidate raw Error.
 * @returns Detached retryable marker.
 */
function readExecutionRunOptionalRetryable(
  error: Error,
): ExecutionRunAwsClassificationInput['$retryable'] {
  try {
    const value: unknown = Reflect.get(error, '$retryable')
    if (typeof value !== 'object' || value === null) {
      return undefined
    }
    const throttling: unknown = Reflect.get(value, 'throttling')
    return typeof throttling === 'boolean'
      ? { throttling }
      : {}
  } catch {
    return undefined
  }
}

/**
 * Runs one async operation behind the raw-value-free public boundary.
 *
 * @param operation - Exact validation or AWS operation.
 * @returns Successful operation result.
 */
async function runExecutionRunAwsBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createExecutionRunAwsPublicFailure(
      readExecutionRunAwsFailureCode(error, false),
    )
  }
}

/**
 * Extracts one stable code from an internal, public, core, or raw failure.
 *
 * @param error - Arbitrary caught value.
 * @param duringConstruction - Whether core invalidity is caller argument.
 * @returns Stable raw-value-free migration failure code.
 */
function readExecutionRunAwsFailureCode(
  error: unknown,
  duringConstruction: boolean,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof ExecutionRunAwsFailure) {
      return error.code
    }
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : 'INVALID_STATE'
    }
    if (
      error instanceof WorkspaceSearchMigrationExecutionRunError ||
      error instanceof
        WorkspaceSearchMigrationExecutionBoundaryError ||
      error instanceof
        WorkspaceSearchMigrationSealedPlanningAuthorityV2Error ||
      error instanceof WorkspaceSearchWriterFenceError
    ) {
      return duringConstruction ? 'INVALID_ARGUMENT' : 'INVALID_STATE'
    }
    if (isExecutionRunResourceNotFoundError(error)) {
      return 'CONFIGURATION_DRIFT'
    }
    if (error instanceof Error) {
      const input =
        createExecutionRunAwsClassificationInput(error)
      if (
        isThrottlingError(input) ||
        isTransientError(input)
      ) {
        return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
      }
    }
    return duringConstruction ? 'INVALID_ARGUMENT' : 'INVALID_STATE'
  } catch {
    return duringConstruction ? 'INVALID_ARGUMENT' : 'INVALID_STATE'
  }
}

/**
 * Creates one fixed raw-value-free public failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Public migration failure.
 */
function createExecutionRunAwsPublicFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration execution run operation failed.',
  )
}

/**
 * Raises one private stable execution-run failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Never returns.
 */
function failExecutionRunAws(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new ExecutionRunAwsFailure(code)
}
