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
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceReadMaterial,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  createWorkspaceSearchWriterFenceTransitionPut,
  parseWorkspaceSearchWriterFenceObservation,
  workspaceSearchWriterFenceClosedRecordMatchesAuthority,
  WorkspaceSearchWriterFenceError,
  workspaceSearchWriterFenceTableRoles,
  type WorkspaceSearchWriterFenceAuthority,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
  type WorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceOpenRecord,
  type WorkspaceSearchWriterFenceTableIds,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  admitWorkspaceSearchMigrationExecutionBoundaryPlanning,
  createWorkspaceSearchMigrationClosedExecutionBoundaryPredecessor,
  createWorkspaceSearchMigrationExecutionBoundary,
  detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary,
  parseWorkspaceSearchMigrationExecutionBoundary,
  recoverWorkspaceSearchMigrationExecutionBoundaryPlanningAdmission,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  WorkspaceSearchMigrationExecutionBoundaryError,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_BOUNDARY_MAX_BYTES,
  type WorkspaceSearchMigrationClosedExecutionBoundary,
  type WorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationSourcePlanningHeadAbsenceConditionCheck,
} from './migration-source-evidence-aws'
import {
  createWorkspaceSearchMigrationTargetPlanningHeadAbsenceConditionCheck,
} from './migration-target-evidence-aws'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
} from './maintenance-evidence'

const executionBoundaryRecordKind =
  'workspace-search-migration-execution-boundary-publication'
const executionBoundaryRecordVersion = 1
const executionBoundaryRecordKeyPrefix = 'execution-boundary/v1'
const executionBoundaryTransactionItemCount = 10

/**
 * Fixed transaction and cancellation-reason positions for both boundary
 * transitions.
 */
export const workspaceSearchMigrationExecutionBoundaryTransactionIndex =
  Object.freeze({
    lease: 0,
    pointer: 1,
    receipt: 2,
    writerFence: 3,
    projectDirectory: 4,
    workItems: 5,
    collaboration: 6,
    documents: 7,
    target: 8,
    boundary: 9,
    count: executionBoundaryTransactionItemCount,
  })

/**
 * Adapter-owned source of trusted execution-boundary commit time.
 */
export type WorkspaceSearchMigrationExecutionBoundaryAwsClock =
  () => Date

/**
 * Caller material required to admit post-close planning.
 */
export type AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput = {
  /** Exact current lease, pointer, and maintenance receipt authority. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Exact raw maintenance evidence proving the post-close drain. */
  readonly maintenanceEvidenceBytes: Uint8Array
}

/**
 * Narrow migration-state transport used by the atomic execution boundary.
 */
export interface WorkspaceSearchMigrationExecutionBoundaryAwsTransport {
  /**
   * Strongly reads one adapter-owned execution-boundary or writer-fence row.
   *
   * @param command - Adapter-owned strongly consistent GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getExecutionBoundaryState(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes the measured state-incarnation guard immediately before commit.
   */
  prepareExecutionBoundaryWrite(): Promise<void>

  /**
   * Commits one exact fixed-order ten-item transition.
   *
   * @param command - Adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB response.
   */
  transactWriteExecutionBoundary(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Durable atomic close and post-close planning admission operations.
 */
export interface WorkspaceSearchMigrationExecutionBoundaryAwsPort {
  /**
   * Strongly reads one deterministic run boundary.
   *
   * @param runId - Operator-selected migration run.
   * @returns Exact durable boundary or undefined when absent.
   */
  read(
    runId: string,
  ): Promise<WorkspaceSearchMigrationExecutionBoundary | undefined>

  /**
   * Atomically closes the writer fence and publishes revision one.
   *
   * A retry may return revision two when the same close already advanced
   * through planning admission.
   *
   * @param currentAuthority - Exact current authority owning the close.
   * @returns Exact durable boundary for the same logical close.
   */
  close(
    currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchMigrationExecutionBoundary>

  /**
   * Atomically admits planning while the exact closed fence remains current.
   *
   * @param input - Current authority and raw post-close drain evidence.
   * @returns Exact durable revision-two boundary.
   */
  admitPlanning(
    input: AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput,
  ): Promise<WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary>
}

/**
 * Detached measured material retained by one execution-boundary adapter.
 */
type ExecutionBoundaryAdapterBinding = {
  /** Complete detached measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of that exact configuration. */
  readonly configurationHash: string
  /** Exact detached migration-state table identity. */
  readonly stateTable: MigrationTableIdentity
  /** Shared exact writer-fence binding for all six TableIds. */
  readonly writerFence: WorkspaceSearchWriterFenceBinding
}

/**
 * Captured transport functions immune to later caller mutation.
 */
type PreparedExecutionBoundaryTransport = {
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
   * Sends one exact boundary transaction.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Raw low-level response.
   */
  readonly transact: (
    command: TransactWriteItemsCommand,
  ) => Promise<TransactWriteItemsCommandOutput>
}

/**
 * Exact pair of rows whose consistency is required before decisions.
 */
type ExecutionBoundaryStatePair = {
  /** Run-scoped durable boundary, when present. */
  readonly boundary:
    WorkspaceSearchMigrationExecutionBoundary | undefined
  /** Global incarnation- and dataset-bound writer fence. */
  readonly writerFence: WorkspaceSearchWriterFenceObservation
}

/**
 * Detached stable admission input retained across asynchronous work.
 */
type PreparedExecutionBoundaryAdmissionInput = {
  /** Exact detached current authority. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Exact bounded copied maintenance-evidence bytes. */
  readonly maintenanceEvidenceBytes: Uint8Array
}

/**
 * Stable logical transition retained through transaction reconciliation.
 */
type ExecutionBoundaryCloseCommit = {
  /** Close transitions publish the fence and revision one together. */
  readonly operation: 'close'
  /** Exact caller-authorized run. */
  readonly runId: string
  /** Stable authority projected into the closed fence. */
  readonly closeAuthority: WorkspaceSearchWriterFenceAuthority
  /** Exact open writer-fence predecessor. */
  readonly predecessorFence: WorkspaceSearchWriterFenceOpenRecord
  /** Exact intended closed writer-fence successor. */
  readonly successorFence: WorkspaceSearchWriterFenceClosedRecord
  /** Exact intended revision-one boundary. */
  readonly successorBoundary:
    WorkspaceSearchMigrationClosedExecutionBoundary
}

/**
 * Stable logical admission retained through transaction reconciliation.
 */
type ExecutionBoundaryAdmissionCommit = {
  /** Admission transitions only the durable boundary row. */
  readonly operation: 'admit-planning'
  /** Exact caller-authorized run. */
  readonly runId: string
  /** Exact revision-one predecessor. */
  readonly predecessorBoundary:
    WorkspaceSearchMigrationClosedExecutionBoundary
  /** Exact closed fence fixed by the transaction. */
  readonly closedFence: WorkspaceSearchWriterFenceClosedRecord
  /** Detached current admission authority. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Detached bounded maintenance-evidence bytes. */
  readonly maintenanceEvidenceBytes: Uint8Array
  /** Exact intended revision-two successor. */
  readonly successorBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
}

/**
 * One exact boundary transition.
 */
type ExecutionBoundaryCommit =
  | ExecutionBoundaryAdmissionCommit
  | ExecutionBoundaryCloseCommit

/**
 * Secret-free structural AWS error supplied to Smithy's classifiers.
 */
type ExecutionBoundaryAwsClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout code. */
    readonly code?: string
  }

/**
 * Private stable failure used inside the AWS adapter boundary.
 */
class ExecutionBoundaryAwsFailure extends Error {
  /** Stable raw-value-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private stable failure.
   *
   * @param code - Operator-safe migration failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'ExecutionBoundaryAwsFailure'
    this.code = code
  }
}

/**
 * Concrete durable atomic execution-boundary adapter.
 */
class AwsWorkspaceSearchMigrationExecutionBoundaryPort
implements WorkspaceSearchMigrationExecutionBoundaryAwsPort {
  /** Detached measured configuration and state binding. */
  private readonly binding: ExecutionBoundaryAdapterBinding

  /** Captured narrow state-table transport. */
  private readonly transport: PreparedExecutionBoundaryTransport

  /** Adapter-owned trusted commit clock. */
  private readonly clock:
    WorkspaceSearchMigrationExecutionBoundaryAwsClock

  /**
   * Creates one already validated execution-boundary adapter.
   *
   * @param binding - Detached measured binding.
   * @param transport - Captured narrow transport.
   * @param clock - Adapter-owned trusted clock.
   */
  constructor(
    binding: ExecutionBoundaryAdapterBinding,
    transport: PreparedExecutionBoundaryTransport,
    clock: WorkspaceSearchMigrationExecutionBoundaryAwsClock,
  ) {
    this.binding = binding
    this.transport = transport
    this.clock = clock
  }

  /**
   * Strongly reads one deterministic run boundary.
   *
   * @param runId - Operator-selected migration run.
   * @returns Exact durable boundary or undefined.
   */
  async read(
    runId: string,
  ): Promise<WorkspaceSearchMigrationExecutionBoundary | undefined> {
    return runExecutionBoundaryAwsBoundary(async () => {
      const validatedRunId = readMigrationRunId(runId)
      const pair = await this.readStablePair(validatedRunId)
      return pair.boundary
    })
  }

  /**
   * Atomically closes the writer fence and publishes revision one.
   *
   * @param currentAuthority - Exact current pre-plan authority.
   * @returns Exact durable boundary for the same logical close.
   */
  async close(
    currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchMigrationExecutionBoundary> {
    return runExecutionBoundaryAwsBoundary(async () => {
      const authoritySnapshot = prepareExecutionBoundaryAuthority(
        currentAuthority,
        this.binding,
      )
      const runId = authoritySnapshot.lease.runId
      const closeAuthority =
        createExecutionBoundaryWriterFenceAuthority(
          authoritySnapshot,
        )
      const predecessor = await this.readStablePair(runId)
      if (predecessor.boundary !== undefined) {
        return recoverDurableClose(
          this.binding,
          predecessor,
          closeAuthority,
        )
      }
      if (
        predecessor.writerFence.status !== 'present' ||
        predecessor.writerFence.record.mode !== 'open'
      ) {
        return failExecutionBoundaryAws('INVALID_STATE')
      }

      await this.transport.prepare()
      const commitAt = readExecutionBoundaryClock(this.clock)
      const successorFence =
        createWorkspaceSearchWriterFenceClosedSuccessor(
          predecessor.writerFence.record,
          closeAuthority,
          commitAt,
        )
      const successorBoundary =
        createWorkspaceSearchMigrationExecutionBoundary({
          runId,
          configurationHash: this.binding.configurationHash,
          tableIds: this.binding.writerFence.tableIds,
          closedWriterFenceRecord: successorFence,
        })
      const commit: ExecutionBoundaryCloseCommit = {
        operation: 'close',
        runId,
        closeAuthority,
        predecessorFence: predecessor.writerFence.record,
        successorFence,
        successorBoundary,
      }
      return this.commitAndReconcile(
        commit,
        authoritySnapshot,
        commitAt,
      )
    })
  }

  /**
   * Atomically admits planning while the exact closed fence remains current.
   *
   * @param input - Current authority and raw post-close evidence.
   * @returns Exact durable revision-two boundary.
   */
  async admitPlanning(
    input: AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput,
  ): Promise<WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary> {
    return runExecutionBoundaryAwsBoundary(async () => {
      const snapshot = prepareExecutionBoundaryAdmissionInput(
        input,
        this.binding,
      )
      const runId = snapshot.currentAuthority.lease.runId
      const predecessor = await this.readStablePair(runId)
      if (
        predecessor.boundary === undefined ||
        predecessor.writerFence.status !== 'present' ||
        predecessor.writerFence.record.mode !== 'closed'
      ) {
        return failExecutionBoundaryAws('INVALID_STATE')
      }
      if (predecessor.boundary.phase === 'planning-admitted') {
        return recoverDurableAdmission(
          predecessor.boundary,
          snapshot,
        )
      }

      await this.transport.prepare()
      const commitAt = readExecutionBoundaryClock(this.clock)
      const successorBoundary =
        admitWorkspaceSearchMigrationExecutionBoundaryPlanning({
          current: predecessor.boundary,
          currentAuthority: snapshot.currentAuthority,
          admittedAt: commitAt.toISOString(),
          maintenanceEvidenceBytes:
            snapshot.maintenanceEvidenceBytes,
        })
      const commit: ExecutionBoundaryAdmissionCommit = {
        operation: 'admit-planning',
        runId,
        predecessorBoundary: predecessor.boundary,
        closedFence: predecessor.writerFence.record,
        currentAuthority: snapshot.currentAuthority,
        maintenanceEvidenceBytes:
          snapshot.maintenanceEvidenceBytes,
        successorBoundary,
      }
      const durable = await this.commitAndReconcile(
        commit,
        snapshot.currentAuthority,
        commitAt,
      )
      if (durable.phase !== 'planning-admitted') {
        return failExecutionBoundaryAws('INVALID_STATE')
      }
      return durable
    })
  }

  /**
   * Commits one exact fixed-order transition and reconciles both durable rows.
   *
   * @param commit - Exact logical transition.
   * @param authority - Detached current authority.
   * @param commitAt - Exact adapter-owned commit instant.
   * @returns Exact durable boundary proving the logical transition.
   */
  private async commitAndReconcile(
    commit: ExecutionBoundaryCommit,
    authority: WorkspaceSearchMigrationPrePlanAuthority,
    commitAt: Date,
  ): Promise<WorkspaceSearchMigrationExecutionBoundary> {
    const command = createExecutionBoundaryTransactionCommand(
      this.binding,
      commit,
      authority,
      commitAt,
    )
    let transactionError: unknown
    try {
      await this.transport.transact(command)
    } catch (error: unknown) {
      const stableGuardFailure =
        readExecutionBoundaryTransportGuardFailureCode(error)
      if (stableGuardFailure !== undefined) {
        return failExecutionBoundaryAws(stableGuardFailure)
      }
      transactionError = error
    }
    return this.reconcileCommit(commit, transactionError)
  }

  /**
   * Strongly rereads a stable boundary/fence pair after one transaction.
   *
   * @param commit - Exact logical transition attempted.
   * @param transactionError - Raw transaction failure, if one occurred.
   * @returns Exact durable logical successor.
   */
  private async reconcileCommit(
    commit: ExecutionBoundaryCommit,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationExecutionBoundary> {
    let durable: ExecutionBoundaryStatePair
    try {
      durable = await this.readStablePair(commit.runId)
    } catch (error: unknown) {
      const code = readExecutionBoundaryReconciliationFailureCode(error)
      return failExecutionBoundaryAws(code)
    }
    const recovered = recoverCommitIfDurable(
      this.binding,
      durable,
      commit,
    )
    if (recovered !== undefined) return recovered
    if (pairEqualsCommitPredecessor(durable, commit)) {
      return failExecutionBoundaryAws(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyExecutionBoundaryTransactionError(
              transactionError,
            ),
      )
    }
    return failExecutionBoundaryAws('INVALID_STATE')
  }

  /**
   * Strongly reads a boundary/fence pair and retries a cross-transition mix.
   *
   * @param runId - Exact validated run.
   * @returns One internally compatible durable pair.
   */
  private async readStablePair(
    runId: string,
  ): Promise<ExecutionBoundaryStatePair> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const boundaryBeforeFence = await this.readBoundary(runId)
      const writerFence = await this.readWriterFence()
      const boundaryAfterFence = await this.readBoundary(runId)
      if (
        !executionBoundarySnapshotsEqual(
          boundaryBeforeFence,
          boundaryAfterFence,
        )
      ) {
        continue
      }
      const pair = {
        boundary: boundaryAfterFence,
        writerFence,
      }
      if (executionBoundaryPairIsInternallyConsistent(pair)) {
        return pair
      }
    }
    return failExecutionBoundaryAws('INVALID_STATE')
  }

  /**
   * Strongly reads and parses one run-scoped boundary row.
   *
   * @param runId - Exact validated run.
   * @returns Strict detached boundary or undefined.
   */
  private async readBoundary(
    runId: string,
  ): Promise<WorkspaceSearchMigrationExecutionBoundary | undefined> {
    const output = await this.transport.get(
      createExecutionBoundaryReadCommand(this.binding, runId),
    )
    const item = readExecutionBoundaryOutputItem(output)
    return item === undefined
      ? undefined
      : parseExecutionBoundaryRecord(this.binding, runId, item)
  }

  /**
   * Strongly reads and parses the exact global writer-fence row.
   *
   * @returns Missing or strict detached writer-fence observation.
   */
  private async readWriterFence(): Promise<WorkspaceSearchWriterFenceObservation> {
    const output = await this.transport.get(
      new GetItemCommand(
        createWorkspaceSearchWriterFenceReadMaterial(
          this.binding.writerFence,
        ),
      ),
    )
    const item = readExecutionBoundaryOutputItem(output)
    return parseWorkspaceSearchWriterFenceObservation(
      item,
      this.binding.writerFence,
    )
  }
}

/**
 * Creates one measured atomic execution-boundary adapter.
 *
 * @param configuration - Complete measured six-table configuration.
 * @param configurationHash - Reviewed digest of that exact configuration.
 * @param transport - Narrow state-table transport.
 * @param clock - Adapter-owned trusted commit clock.
 * @returns Durable execution-boundary port.
 */
export function createAwsWorkspaceSearchMigrationExecutionBoundaryPort(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  transport: WorkspaceSearchMigrationExecutionBoundaryAwsTransport,
  clock: WorkspaceSearchMigrationExecutionBoundaryAwsClock,
): WorkspaceSearchMigrationExecutionBoundaryAwsPort {
  try {
    const binding = createExecutionBoundaryAdapterBinding(
      configuration,
      configurationHash,
    )
    const preparedTransport =
      prepareExecutionBoundaryTransport(transport)
    if (typeof clock !== 'function') {
      return failExecutionBoundaryAws('INVALID_ARGUMENT')
    }
    return new AwsWorkspaceSearchMigrationExecutionBoundaryPort(
      binding,
      preparedTransport,
      clock,
    )
  } catch (error: unknown) {
    throw createExecutionBoundaryAwsPublicFailure(
      readExecutionBoundaryAwsFailureCode(error, true),
    )
  }
}

/**
 * Constructs the complete detached six-table adapter binding.
 *
 * @param configuration - Candidate measured configuration.
 * @param configurationHash - Candidate reviewed digest.
 * @returns Exact detached execution-boundary binding.
 */
function createExecutionBoundaryAdapterBinding(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): ExecutionBoundaryAdapterBinding {
  if (
    typeof configurationHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(configurationHash)
  ) {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  let snapshot: WorkspaceSearchMigrationConfiguration
  try {
    snapshot =
      detachWorkspaceSearchMigrationPlanningConfiguration(
        configuration,
      )
  } catch {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  let measuredHash: string
  try {
    measuredHash = createWorkspaceSearchConfigurationHash(snapshot)
  } catch {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  if (measuredHash !== configurationHash) {
    return failExecutionBoundaryAws(
      'CONFIGURATION_HASH_MISMATCH',
    )
  }
  const tableIds = createExecutionBoundaryTableIds(snapshot)
  const stateTable = snapshot.tables['migration-state']
  const stateIncarnationDigest =
    createWorkspaceSearchWriterFenceStateIncarnationDigest({
      role: 'migration-state',
      tableName: stateTable.tableName,
      tableArn: stateTable.tableArn,
      tableId: stateTable.tableId,
      creationTime: stateTable.creationTime,
      account: stateTable.account,
      region: stateTable.region,
    })
  return {
    configuration: snapshot,
    configurationHash,
    stateTable,
    writerFence: createWorkspaceSearchWriterFenceBinding({
      stateTableName: stateTable.tableName,
      stateTableId: stateTable.tableId,
      stateIncarnationDigest,
      tableIds,
    }),
  }
}

/**
 * Detaches all six physical TableIds from one measured configuration.
 *
 * @param configuration - Detached measured configuration.
 * @returns Exact role-indexed physical TableIds.
 */
function createExecutionBoundaryTableIds(
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
      return failExecutionBoundaryAws('INVALID_ARGUMENT')
    }
  }
  return tableIds
}

/**
 * Captures and validates the three narrow transport functions.
 *
 * @param transport - Candidate execution-boundary transport.
 * @returns Bound immutable transport functions.
 */
function prepareExecutionBoundaryTransport(
  transport: WorkspaceSearchMigrationExecutionBoundaryAwsTransport,
): PreparedExecutionBoundaryTransport {
  if (
    typeof transport !== 'object' ||
    transport === null ||
    nodeUtilTypes.isProxy(transport)
  ) {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  const get = readExecutionBoundaryOwnDataValue(
    transport,
    'getExecutionBoundaryState',
    'INVALID_ARGUMENT',
  )
  const prepare = readExecutionBoundaryOwnDataValue(
    transport,
    'prepareExecutionBoundaryWrite',
    'INVALID_ARGUMENT',
  )
  const transact = readExecutionBoundaryOwnDataValue(
    transport,
    'transactWriteExecutionBoundary',
    'INVALID_ARGUMENT',
  )
  if (
    typeof get !== 'function' ||
    typeof prepare !== 'function' ||
    typeof transact !== 'function'
  ) {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  return {
    get: get.bind(transport),
    prepare: prepare.bind(transport),
    transact: transact.bind(transport),
  }
}

/**
 * Validates and detaches current authority before the first await.
 *
 * @param authority - Candidate caller-owned authority.
 * @param binding - Exact adapter binding.
 * @returns Detached complete authority snapshot.
 */
function prepareExecutionBoundaryAuthority(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  binding: ExecutionBoundaryAdapterBinding,
): WorkspaceSearchMigrationPrePlanAuthority {
  let snapshot: WorkspaceSearchMigrationPrePlanAuthority
  try {
    snapshot =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        authority,
      )
  } catch {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  requireExecutionBoundaryAuthorityBinding(snapshot, binding)
  return snapshot
}

/**
 * Detaches the exact admission input before any asynchronous operation.
 *
 * @param input - Candidate caller-owned admission input.
 * @param binding - Exact adapter binding.
 * @returns Detached authority and copied evidence bytes.
 */
function prepareExecutionBoundaryAdmissionInput(
  input: AdmitWorkspaceSearchMigrationExecutionBoundaryAwsPlanningInput,
  binding: ExecutionBoundaryAdapterBinding,
): PreparedExecutionBoundaryAdmissionInput {
  requireExactExecutionBoundaryInputKeys(input, [
    'currentAuthority',
    'maintenanceEvidenceBytes',
  ])
  const authorityCandidate = readExecutionBoundaryOwnDataValue(
    input,
    'currentAuthority',
    'INVALID_ARGUMENT',
  )
  const bytesCandidate = readExecutionBoundaryOwnDataValue(
    input,
    'maintenanceEvidenceBytes',
    'INVALID_ARGUMENT',
  )
  let currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  try {
    currentAuthority =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        authorityCandidate,
      )
  } catch {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  requireExecutionBoundaryAuthorityBinding(
    currentAuthority,
    binding,
  )
  return {
    currentAuthority,
    maintenanceEvidenceBytes:
      copyExecutionBoundaryBytes(
        bytesCandidate,
        MAINTENANCE_EVIDENCE_MAX_BYTES,
        'INVALID_ARGUMENT',
      ),
  }
}

/**
 * Requires one detached authority to match the configured state incarnation.
 *
 * @param authority - Exact detached authority.
 * @param binding - Exact adapter binding.
 */
function requireExecutionBoundaryAuthorityBinding(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  binding: ExecutionBoundaryAdapterBinding,
): void {
  if (
    authority.configurationHash !== binding.configurationHash ||
    authority.stateTableId !== binding.stateTable.tableId
  ) {
    return failExecutionBoundaryAws('CONFIGURATION_DRIFT')
  }
  try {
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority,
      commitAt: new Date(authority.evaluatedAt),
    })
  } catch {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
}

/**
 * Projects the stable close identity from complete current authority.
 *
 * @param authority - Strict detached current pre-plan authority.
 * @returns Stable writer-fence authority.
 */
function createExecutionBoundaryWriterFenceAuthority(
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
 * Creates one fixed-order ten-item atomic transition command.
 *
 * @param binding - Measured configuration and table binding.
 * @param commit - Exact logical transition.
 * @param authority - Exact current authority.
 * @param commitAt - Adapter-owned transaction time.
 * @returns Adapter-owned DynamoDB transaction.
 */
function createExecutionBoundaryTransactionCommand(
  binding: ExecutionBoundaryAdapterBinding,
  commit: ExecutionBoundaryCommit,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  commitAt: Date,
): TransactWriteItemsCommand {
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: binding.stateTable,
      configurationHash: binding.configurationHash,
      authority,
      commitAt,
    })
  const writerFenceItem = commit.operation === 'close'
    ? createWorkspaceSearchWriterFenceTransitionPut(
        {
          status: 'present',
          record: commit.predecessorFence,
        },
        commit.successorFence,
      )
    : createWorkspaceSearchWriterFenceClosedConditionCheck(
        commit.closedFence,
        binding.writerFence,
      )
  const sourceChecks = workspaceSearchMigrationSourceNames.map(
    (source) =>
      createWorkspaceSearchMigrationSourcePlanningHeadAbsenceConditionCheck({
        stateTable: binding.stateTable,
        request: {
          runId: commit.runId,
          purpose: 'planning',
          configuration: binding.configuration,
          configurationHash: binding.configurationHash,
          source,
        },
      }),
  )
  const targetCheck =
    createWorkspaceSearchMigrationTargetPlanningHeadAbsenceConditionCheck({
      stateTable: binding.stateTable,
      request: {
        runId: commit.runId,
        purpose: 'planning',
        configuration: binding.configuration,
        configurationHash: binding.configurationHash,
      },
    })
  const boundaryPut = createExecutionBoundaryTransitionPut(
    binding,
    commit.operation === 'close'
      ? undefined
      : commit.predecessorBoundary,
    commit.successorBoundary,
  )
  const items: TransactWriteItem[] = [
    ...authorityChecks,
    writerFenceItem,
    ...sourceChecks,
    targetCheck,
    boundaryPut,
  ]
  const index =
    workspaceSearchMigrationExecutionBoundaryTransactionIndex
  if (
    authorityChecks.length !== index.writerFence ||
    sourceChecks.length !== index.target - index.projectDirectory ||
    items.length !== executionBoundaryTransactionItemCount
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken:
      createExecutionBoundaryTransactionToken(commit),
    TransactItems: items,
  })
}

/**
 * Creates the exact conditional boundary Put for either transition.
 *
 * @param binding - Exact adapter binding.
 * @param predecessor - Exact revision-one predecessor, or absence on close.
 * @param successor - Exact intended boundary successor.
 * @returns One adapter-owned conditional Put.
 */
function createExecutionBoundaryTransitionPut(
  binding: ExecutionBoundaryAdapterBinding,
  predecessor:
    WorkspaceSearchMigrationClosedExecutionBoundary | undefined,
  successor: WorkspaceSearchMigrationExecutionBoundary,
): TransactWriteItem {
  const record = createExecutionBoundaryRecord(binding, successor)
  const put: NonNullable<TransactWriteItem['Put']> = {
    TableName: binding.stateTable.tableName,
    Item: record,
    ...(predecessor === undefined
      ? {
          ConditionExpression:
            'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
          ExpressionAttributeNames: {
            '#migrationId': 'migrationId',
            '#recordKey': 'recordKey',
          },
        }
      : createExecutionBoundaryPredecessorCondition(
          binding,
          predecessor,
        )),
    ReturnValuesOnConditionCheckFailure: 'NONE',
  }
  return { Put: put }
}

/**
 * Creates an exact full-record predecessor condition.
 *
 * @param binding - Exact adapter binding.
 * @param predecessor - Exact durable revision-one predecessor.
 * @returns Condition fields for a boundary successor Put.
 */
function createExecutionBoundaryPredecessorCondition(
  binding: ExecutionBoundaryAdapterBinding,
  predecessor: WorkspaceSearchMigrationClosedExecutionBoundary,
): Pick<
  NonNullable<TransactWriteItem['Put']>,
  | 'ConditionExpression'
  | 'ExpressionAttributeNames'
  | 'ExpressionAttributeValues'
> {
  const item = createExecutionBoundaryRecord(binding, predecessor)
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const clauses: string[] = []
  const attributes = [
    'migrationId',
    'recordKey',
    'kind',
    'version',
    'stateTableId',
    'configurationHash',
    'runId',
    'phase',
    'revision',
    'closedWriterFenceRecordDigest',
    'boundaryDigest',
    'boundaryBytes',
  ]
  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes[index]
    if (attribute === undefined) {
      return failExecutionBoundaryAws('INVALID_STATE')
    }
    const nameToken = `#field${index}`
    const valueToken = `:field${index}`
    const value = item[attribute]
    if (value === undefined) {
      return failExecutionBoundaryAws('INVALID_STATE')
    }
    names[nameToken] = attribute
    values[valueToken] = value
    clauses.push(`${nameToken} = ${valueToken}`)
  }
  return {
    ConditionExpression: clauses.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }
}

/**
 * Creates one complete exact durable execution-boundary item.
 *
 * @param binding - Exact measured adapter binding.
 * @param boundary - Exact strict boundary.
 * @returns Complete low-level DynamoDB item.
 */
function createExecutionBoundaryRecord(
  binding: ExecutionBoundaryAdapterBinding,
  boundary: WorkspaceSearchMigrationExecutionBoundary,
): Readonly<Record<string, AttributeValue>> {
  const bytes =
    serializeWorkspaceSearchMigrationExecutionBoundary(boundary)
  const strict =
    parseWorkspaceSearchMigrationExecutionBoundary(bytes)
  requireExecutionBoundaryBinding(binding, strict)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createExecutionBoundaryRecordKey(
        binding,
        strict.runId,
      ),
    },
    kind: { S: executionBoundaryRecordKind },
    version: { N: String(executionBoundaryRecordVersion) },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: strict.runId },
    phase: { S: strict.phase },
    revision: { N: String(strict.revision) },
    closedWriterFenceRecordDigest: {
      S: strict.closedWriterFenceRecordDigest,
    },
    boundaryDigest: { S: strict.boundaryDigest },
    boundaryBytes: { B: bytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Parses and cross-checks one complete durable boundary item.
 *
 * @param binding - Exact measured adapter binding.
 * @param runId - Exact run addressed by the read.
 * @param item - Raw low-level DynamoDB item.
 * @returns Strict detached execution boundary.
 */
function parseExecutionBoundaryRecord(
  binding: ExecutionBoundaryAdapterBinding,
  runId: string,
  item: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationExecutionBoundary {
  requireExactExecutionBoundaryRecordKeys(item)
  if (
    readExecutionBoundaryStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readExecutionBoundaryStringAttribute(item, 'recordKey') !==
      createExecutionBoundaryRecordKey(binding, runId) ||
    readExecutionBoundaryStringAttribute(item, 'kind') !==
      executionBoundaryRecordKind ||
    readExecutionBoundaryNumberAttribute(item, 'version') !==
      executionBoundaryRecordVersion ||
    readExecutionBoundaryStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readExecutionBoundaryStringAttribute(
      item,
      'configurationHash',
    ) !== binding.configurationHash ||
    readExecutionBoundaryStringAttribute(item, 'runId') !== runId
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  const bytes = readExecutionBoundaryBinaryAttribute(
    item,
    'boundaryBytes',
  )
  let boundary: WorkspaceSearchMigrationExecutionBoundary
  try {
    boundary =
      parseWorkspaceSearchMigrationExecutionBoundary(bytes)
  } catch {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  requireExecutionBoundaryBinding(binding, boundary)
  if (
    boundary.runId !== runId ||
    boundary.phase !==
      readExecutionBoundaryStringAttribute(item, 'phase') ||
    boundary.revision !==
      readExecutionBoundaryNumberAttribute(item, 'revision') ||
    boundary.closedWriterFenceRecordDigest !==
      readExecutionBoundaryStringAttribute(
        item,
        'closedWriterFenceRecordDigest',
      ) ||
    boundary.boundaryDigest !==
      readExecutionBoundaryStringAttribute(item, 'boundaryDigest')
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return boundary
}

/**
 * Requires one pure boundary to match all measured adapter fields.
 *
 * @param binding - Exact measured adapter binding.
 * @param boundary - Exact strict boundary.
 */
function requireExecutionBoundaryBinding(
  binding: ExecutionBoundaryAdapterBinding,
  boundary: WorkspaceSearchMigrationExecutionBoundary,
): void {
  if (
    boundary.configurationHash !== binding.configurationHash ||
    boundary.tableIds['migration-state'] !==
      binding.stateTable.tableId
  ) {
    return failExecutionBoundaryAws('CONFIGURATION_DRIFT')
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      boundary.tableIds[role] !==
        binding.writerFence.tableIds[role]
    ) {
      return failExecutionBoundaryAws('CONFIGURATION_DRIFT')
    }
  }
}

/**
 * Creates one strongly consistent deterministic boundary read.
 *
 * @param binding - Exact adapter binding.
 * @param runId - Exact validated run.
 * @returns Adapter-owned GetItem command.
 */
function createExecutionBoundaryReadCommand(
  binding: ExecutionBoundaryAdapterBinding,
  runId: string,
): GetItemCommand {
  return new GetItemCommand({
    TableName: binding.stateTable.tableName,
    ConsistentRead: true,
    Key: {
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: {
        S: createExecutionBoundaryRecordKey(binding, runId),
      },
    },
  })
}

/**
 * Creates one bounded deterministic execution-boundary record key.
 *
 * @param binding - Exact adapter binding.
 * @param runId - Exact validated run.
 * @returns Deterministic run/configuration boundary key.
 */
function createExecutionBoundaryRecordKey(
  binding: ExecutionBoundaryAdapterBinding,
  runId: string,
): string {
  const validatedRunId = readMigrationRunId(runId)
  const bindingDigest = createMigrationDigest({
    kind: 'workspace-search-migration-execution-boundary-binding',
    version: executionBoundaryRecordVersion,
    stateTableId: binding.stateTable.tableId,
    configurationHash: binding.configurationHash,
    runId: validatedRunId,
  })
  return `${executionBoundaryRecordKeyPrefix}/${bindingDigest}/boundary`
}

/**
 * Creates one deterministic bounded transaction idempotency token.
 *
 * @param commit - Exact logical transition and successor.
 * @returns Stable at-most-36-character DynamoDB token.
 */
function createExecutionBoundaryTransactionToken(
  commit: ExecutionBoundaryCommit,
): string {
  return createMigrationDigest({
    kind: 'workspace-search-migration-execution-boundary-commit',
    version: executionBoundaryRecordVersion,
    operation: commit.operation,
    runId: commit.runId,
    predecessorBoundaryDigest:
      commit.operation === 'close'
        ? null
        : commit.predecessorBoundary.boundaryDigest,
    predecessorFenceDigest:
      commit.operation === 'close'
        ? commit.predecessorFence.recordDigest
        : commit.closedFence.recordDigest,
    successorBoundaryDigest:
      commit.successorBoundary.boundaryDigest,
    successorFenceDigest:
      commit.operation === 'close'
        ? commit.successorFence.recordDigest
        : commit.closedFence.recordDigest,
  }).slice(0, 36)
}

/**
 * Reads an optional GetItem result without invoking output accessors.
 *
 * @param output - Raw low-level DynamoDB response.
 * @returns Raw item data property or undefined.
 */
function readExecutionBoundaryOutputItem(
  output: GetItemCommandOutput,
): Readonly<Record<string, AttributeValue>> | undefined {
  if (
    typeof output !== 'object' ||
    output === null ||
    nodeUtilTypes.isProxy(output)
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
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
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Requires the exact durable execution-boundary field set.
 *
 * @param item - Candidate low-level DynamoDB item.
 */
function requireExactExecutionBoundaryRecordKeys(
  item: Readonly<Record<string, AttributeValue>>,
): void {
  const expected = [
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
  ]
  if (
    typeof item !== 'object' ||
    item === null ||
    Array.isArray(item) ||
    nodeUtilTypes.isProxy(item)
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  const ownKeys = Reflect.ownKeys(item)
  if (ownKeys.some((key) => typeof key !== 'string')) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  const actual = Object.keys(item).sort()
  if (
    ownKeys.length !== actual.length ||
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  for (const key of actual) {
    readExecutionBoundaryOwnDataValue(
      item,
      key,
      'INVALID_STATE',
    )
  }
}

/**
 * Reads one strict DynamoDB string attribute.
 *
 * @param item - Complete descriptor-safe item.
 * @param name - Exact attribute name.
 * @returns Exact string value.
 */
function readExecutionBoundaryStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = readExecutionBoundaryAttributeDataValue(
    item,
    name,
    'S',
  )
  if (typeof value !== 'string') {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads one strict DynamoDB nonnegative integer attribute.
 *
 * @param item - Complete descriptor-safe item.
 * @param name - Exact attribute name.
 * @returns Exact safe integer.
 */
function readExecutionBoundaryNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const encoded = readExecutionBoundaryAttributeDataValue(
    item,
    name,
    'N',
  )
  if (
    typeof encoded !== 'string' ||
    !/^(0|[1-9][0-9]*)$/u.test(encoded)
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  const value = Number(encoded)
  if (!Number.isSafeInteger(value)) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads one strict bounded DynamoDB binary attribute.
 *
 * @param item - Complete descriptor-safe item.
 * @param name - Exact attribute name.
 * @returns Detached exact bytes.
 */
function readExecutionBoundaryBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  return copyExecutionBoundaryBytes(
    readExecutionBoundaryAttributeDataValue(item, name, 'B'),
    WORKSPACE_SEARCH_MIGRATION_EXECUTION_BOUNDARY_MAX_BYTES,
    'INVALID_STATE',
  )
}

/**
 * Reads one exact DynamoDB AttributeValue data variant.
 *
 * @param item - Complete descriptor-safe item.
 * @param name - Exact item attribute name.
 * @param variant - Required low-level discriminator.
 * @returns Untrusted data value without invoking an accessor.
 */
function readExecutionBoundaryAttributeDataValue(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
  variant: 'B' | 'N' | 'S',
): unknown {
  const attribute = readExecutionBoundaryOwnDataValue(
    item,
    name,
    'INVALID_STATE',
  )
  if (
    typeof attribute !== 'object' ||
    attribute === null ||
    Array.isArray(attribute) ||
    nodeUtilTypes.isProxy(attribute)
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  const keys = Reflect.ownKeys(attribute)
  const descriptor = Object.getOwnPropertyDescriptor(
    attribute,
    variant,
  )
  if (
    keys.length !== 1 ||
    keys[0] !== variant ||
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Determines whether a strongly read boundary/fence pair can coexist.
 *
 * Absence is accepted only with a missing or open fence. Every present
 * boundary must reconstruct exactly from the same closed fence row.
 *
 * @param pair - Candidate strongly read pair.
 * @returns Whether the pair is internally complete and cross-bound.
 */
function executionBoundaryPairIsInternallyConsistent(
  pair: ExecutionBoundaryStatePair,
): boolean {
  if (pair.boundary === undefined) {
    return pair.writerFence.status === 'missing' ||
      pair.writerFence.record.mode === 'open'
  }
  if (
    pair.writerFence.status !== 'present' ||
    pair.writerFence.record.mode !== 'closed'
  ) {
    return false
  }
  try {
    const reconstructed =
      createWorkspaceSearchMigrationExecutionBoundary({
        runId: pair.boundary.runId,
        configurationHash: pair.boundary.configurationHash,
        tableIds: pair.boundary.tableIds,
        closedWriterFenceRecord: pair.writerFence.record,
      })
    const predecessor =
      createWorkspaceSearchMigrationClosedExecutionBoundaryPredecessor(
        pair.boundary,
      )
    return executionBoundaryValuesEqual(
      reconstructed,
      predecessor,
    )
  } catch {
    return false
  }
}

/**
 * Compares the same boundary row read on both sides of the writer fence.
 *
 * @param beforeFence - Boundary observed before the fence read.
 * @param afterFence - Boundary observed after the fence read.
 * @returns Whether both reads identify the same exact durable revision.
 */
function executionBoundarySnapshotsEqual(
  beforeFence:
    WorkspaceSearchMigrationExecutionBoundary | undefined,
  afterFence:
    WorkspaceSearchMigrationExecutionBoundary | undefined,
): boolean {
  if (beforeFence === undefined || afterFence === undefined) {
    return beforeFence === undefined && afterFence === undefined
  }
  return executionBoundaryValuesEqual(beforeFence, afterFence)
}

/**
 * Recovers one existing durable boundary for the exact logical close.
 *
 * @param binding - Exact measured adapter binding.
 * @param pair - Internally consistent durable pair.
 * @param closeAuthority - Stable authority projected by this retry.
 * @returns Exact durable revision one or later revision two boundary.
 */
function recoverDurableClose(
  binding: ExecutionBoundaryAdapterBinding,
  pair: ExecutionBoundaryStatePair,
  closeAuthority: WorkspaceSearchWriterFenceAuthority,
): WorkspaceSearchMigrationExecutionBoundary {
  if (
    pair.boundary === undefined ||
    pair.writerFence.status !== 'present' ||
    pair.writerFence.record.mode !== 'closed' ||
    !workspaceSearchWriterFenceClosedRecordMatchesAuthority(
      pair.writerFence.record,
      binding.writerFence,
      closeAuthority,
    )
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  const reconstructed =
    createWorkspaceSearchMigrationExecutionBoundary({
      runId: closeAuthority.runId,
      configurationHash: binding.configurationHash,
      tableIds: binding.writerFence.tableIds,
      closedWriterFenceRecord: pair.writerFence.record,
    })
  const durablePredecessor =
    createWorkspaceSearchMigrationClosedExecutionBoundaryPredecessor(
      pair.boundary,
    )
  if (
    !executionBoundaryValuesEqual(
      reconstructed,
      durablePredecessor,
    )
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return cloneExecutionBoundary(pair.boundary)
}

/**
 * Recovers one durable revision-two admission for exact stable input.
 *
 * @param durable - Strict durable planning-admitted boundary.
 * @param input - Detached stable retry input.
 * @returns Detached exact durable admission.
 */
function recoverDurableAdmission(
  durable:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
  input: PreparedExecutionBoundaryAdmissionInput,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  let candidate:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  try {
    candidate =
      recoverWorkspaceSearchMigrationExecutionBoundaryPlanningAdmission({
        current: durable,
        currentAuthority: input.currentAuthority,
        maintenanceEvidenceBytes: input.maintenanceEvidenceBytes,
      })
  } catch {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  if (!executionBoundaryValuesEqual(candidate, durable)) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return cloneExecutionBoundaryPlanningAdmission(durable)
}

/**
 * Recovers the logical successor of one attempted transition when durable.
 *
 * @param binding - Exact measured adapter binding.
 * @param pair - Strongly reread internally consistent pair.
 * @param commit - Exact attempted logical transition.
 * @returns Detached durable successor, or undefined while predecessor remains.
 */
function recoverCommitIfDurable(
  binding: ExecutionBoundaryAdapterBinding,
  pair: ExecutionBoundaryStatePair,
  commit: ExecutionBoundaryCommit,
): WorkspaceSearchMigrationExecutionBoundary | undefined {
  if (pair.boundary === undefined) return undefined
  if (commit.operation === 'close') {
    if (
      pair.writerFence.status !== 'present' ||
      pair.writerFence.record.mode !== 'closed'
    ) {
      return failExecutionBoundaryAws('INVALID_STATE')
    }
    const reconstructedFence =
      createWorkspaceSearchWriterFenceClosedSuccessor(
        commit.predecessorFence,
        commit.closeAuthority,
        new Date(pair.writerFence.record.closedAt),
      )
    if (
      reconstructedFence.recordDigest !==
        pair.writerFence.record.recordDigest
    ) {
      return failExecutionBoundaryAws('INVALID_STATE')
    }
    return recoverDurableClose(
      binding,
      pair,
      commit.closeAuthority,
    )
  }
  if (pair.boundary.phase === 'closed') return undefined
  const durablePredecessor =
    createWorkspaceSearchMigrationClosedExecutionBoundaryPredecessor(
      pair.boundary,
    )
  if (
    !executionBoundaryValuesEqual(
      durablePredecessor,
      commit.predecessorBoundary,
    )
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return recoverDurableAdmission(pair.boundary, {
    currentAuthority: commit.currentAuthority,
    maintenanceEvidenceBytes: commit.maintenanceEvidenceBytes,
  })
}

/**
 * Determines whether reconciliation still observes the exact predecessor.
 *
 * @param pair - Strongly reread internally consistent pair.
 * @param commit - Exact attempted logical transition.
 * @returns Whether neither durable transition advanced.
 */
function pairEqualsCommitPredecessor(
  pair: ExecutionBoundaryStatePair,
  commit: ExecutionBoundaryCommit,
): boolean {
  if (commit.operation === 'close') {
    return pair.boundary === undefined &&
      pair.writerFence.status === 'present' &&
      pair.writerFence.record.mode === 'open' &&
      pair.writerFence.record.recordDigest ===
        commit.predecessorFence.recordDigest
  }
  return pair.boundary !== undefined &&
    pair.boundary.phase === 'closed' &&
    pair.boundary.boundaryDigest ===
      commit.predecessorBoundary.boundaryDigest &&
    pair.writerFence.status === 'present' &&
    pair.writerFence.record.mode === 'closed' &&
    pair.writerFence.record.recordDigest ===
      commit.closedFence.recordDigest
}

/**
 * Compares two strict boundaries by exact canonical bytes.
 *
 * @param left - First strict boundary.
 * @param right - Second strict boundary.
 * @returns Whether both canonical byte sequences are identical.
 */
function executionBoundaryValuesEqual(
  left: WorkspaceSearchMigrationExecutionBoundary,
  right: WorkspaceSearchMigrationExecutionBoundary,
): boolean {
  return executionBoundaryBytesEqual(
    serializeWorkspaceSearchMigrationExecutionBoundary(left),
    serializeWorkspaceSearchMigrationExecutionBoundary(right),
  )
}

/**
 * Returns one detached strict boundary through its canonical codec.
 *
 * @param boundary - Candidate strict boundary.
 * @returns Detached strict boundary.
 */
function cloneExecutionBoundary(
  boundary: WorkspaceSearchMigrationExecutionBoundary,
): WorkspaceSearchMigrationExecutionBoundary {
  return parseWorkspaceSearchMigrationExecutionBoundary(
    serializeWorkspaceSearchMigrationExecutionBoundary(boundary),
  )
}

/**
 * Returns one detached strict planning admission through its codec.
 *
 * @param boundary - Candidate strict planning-admitted boundary.
 * @returns Detached strict planning-admitted boundary.
 */
function cloneExecutionBoundaryPlanningAdmission(
  boundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  const clone = cloneExecutionBoundary(boundary)
  if (clone.phase !== 'planning-admitted') {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return clone
}

/**
 * Compares two byte sequences without caller-controlled iteration.
 *
 * @param left - First exact bytes.
 * @param right - Second exact bytes.
 * @returns Whether length and every byte match.
 */
function executionBoundaryBytesEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Requires an exact data-only top-level exported input.
 *
 * @param input - Candidate caller-owned input.
 * @param expected - Exact sorted enumerable key set.
 */
function requireExactExecutionBoundaryInputKeys(
  input: object,
  expected: readonly string[],
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    nodeUtilTypes.isProxy(input)
  ) {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  const ownKeys = Reflect.ownKeys(input)
  const actual: string[] = []
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return failExecutionBoundaryAws('INVALID_ARGUMENT')
    }
    actual.push(key)
  }
  actual.sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  for (const key of expected) {
    readExecutionBoundaryOwnDataValue(
      input,
      key,
      'INVALID_ARGUMENT',
    )
  }
}

/**
 * Reads one own enumerable data property without invoking an accessor.
 *
 * @param value - Candidate containing object.
 * @param key - Required own data-property key.
 * @param failureCode - Stable failure code for malformed descriptors.
 * @returns Untrusted descriptor value.
 */
function readExecutionBoundaryOwnDataValue(
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
    return failExecutionBoundaryAws(failureCode)
  }
  return descriptor.value
}

/**
 * Copies one non-shared intrinsic Uint8Array within an exact bound.
 *
 * @param value - Candidate byte sequence.
 * @param maximumBytes - Maximum accepted byte length.
 * @param failureCode - Stable failure code for malformed bytes.
 * @returns Detached exact byte copy.
 */
function copyExecutionBoundaryBytes(
  value: unknown,
  maximumBytes: number,
  failureCode: WorkspaceSearchMigrationFailureCode,
): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failExecutionBoundaryAws(failureCode)
  }
  const byteLength =
    readExecutionBoundaryIntrinsicByteLength(
      value,
      failureCode,
    )
  if (
    byteLength === 0 ||
    byteLength > maximumBytes
  ) {
    return failExecutionBoundaryAws(failureCode)
  }
  const buffer = readExecutionBoundaryIntrinsicByteBuffer(
    value,
    failureCode,
  )
  if (nodeUtilTypes.isSharedArrayBuffer(buffer)) {
    return failExecutionBoundaryAws(failureCode)
  }
  const copy = new Uint8Array(value)
  if (copy.byteLength !== byteLength) {
    return failExecutionBoundaryAws(failureCode)
  }
  return copy
}

/**
 * Reads a Uint8Array view's intrinsic byte length before allocating a copy.
 *
 * @param value - Validated non-Proxy Uint8Array.
 * @param failureCode - Stable failure code for invalid intrinsic state.
 * @returns Exact intrinsic view byte length.
 */
function readExecutionBoundaryIntrinsicByteLength(
  value: Uint8Array,
  failureCode: WorkspaceSearchMigrationFailureCode,
): number {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  if (typedArrayPrototype === null) {
    return failExecutionBoundaryAws(failureCode)
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
  )
  if (descriptor?.get === undefined) {
    return failExecutionBoundaryAws(failureCode)
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
    return failExecutionBoundaryAws(failureCode)
  }
  return byteLength
}

/**
 * Reads a Uint8Array's intrinsic backing buffer.
 *
 * @param value - Validated non-Proxy Uint8Array.
 * @param failureCode - Stable failure code for invalid intrinsic state.
 * @returns Exact intrinsic backing buffer.
 */
function readExecutionBoundaryIntrinsicByteBuffer(
  value: Uint8Array,
  failureCode: WorkspaceSearchMigrationFailureCode,
): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  if (typedArrayPrototype === null) {
    return failExecutionBoundaryAws(failureCode)
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'buffer',
  )
  if (descriptor?.get === undefined) {
    return failExecutionBoundaryAws(failureCode)
  }
  const buffer: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    !nodeUtilTypes.isArrayBuffer(buffer) &&
    !nodeUtilTypes.isSharedArrayBuffer(buffer)
  ) {
    return failExecutionBoundaryAws(failureCode)
  }
  return buffer
}

/**
 * Reads one trusted finite adapter clock value.
 *
 * @param clock - Adapter-owned clock.
 * @returns Detached exact commit time.
 */
function readExecutionBoundaryClock(
  clock: WorkspaceSearchMigrationExecutionBoundaryAwsClock,
): Date {
  let value: Date
  try {
    value = clock()
  } catch {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failExecutionBoundaryAws('INVALID_STATE')
  }
  return new Date(epochMilliseconds)
}

/**
 * Validates one bounded operator-selected run identifier.
 *
 * @param value - Candidate run identifier.
 * @returns Exact validated run identifier.
 */
function readMigrationRunId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failExecutionBoundaryAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Classifies one transaction failure only after the predecessor was reread.
 *
 * @param error - Raw transaction error retained inside the private boundary.
 * @returns Stable retry, authority, ambiguous, or fail-closed code.
 */
function classifyExecutionBoundaryTransactionError(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (isExecutionBoundaryResourceNotFoundError(error)) {
      return 'CONFIGURATION_DRIFT'
    }
    if (
      error instanceof TransactionConflictException ||
      readExecutionBoundaryErrorName(error) ===
        'TransactionConflictException'
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (
      error instanceof TransactionCanceledException ||
      readExecutionBoundaryErrorName(error) ===
        'TransactionCanceledException'
    ) {
      const index =
        workspaceSearchMigrationExecutionBoundaryTransactionIndex
      if (
        readExecutionBoundaryCancellationReasonCode(
          error,
          index.lease,
        ) === 'ConditionalCheckFailed'
      ) {
        return 'LEASE_LOST'
      }
      if (
        readExecutionBoundaryCancellationReasonCode(
          error,
          index.pointer,
        ) === 'ConditionalCheckFailed' ||
        readExecutionBoundaryCancellationReasonCode(
          error,
          index.receipt,
        ) === 'ConditionalCheckFailed'
      ) {
        return 'INVALID_MAINTENANCE_EVIDENCE'
      }
      for (
        let conditionIndex = index.writerFence;
        conditionIndex <= index.boundary;
        conditionIndex += 1
      ) {
        if (
          readExecutionBoundaryCancellationReasonCode(
            error,
            conditionIndex,
          ) === 'ConditionalCheckFailed'
        ) {
          return 'INVALID_STATE'
        }
      }
      if (
        executionBoundaryCancellationHasConditionalFailure(error)
      ) {
        return 'INVALID_STATE'
      }
      return executionBoundaryCancellationWasTransient(error)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (
      readExecutionBoundaryErrorName(error) ===
        'TransactionInProgressException'
    ) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const input =
      createExecutionBoundaryAwsClassificationInput(error)
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
function readExecutionBoundaryCancellationReasonCode(
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
function executionBoundaryCancellationHasConditionalFailure(
  error: unknown,
): boolean {
  for (
    let index = 0;
    index <
      workspaceSearchMigrationExecutionBoundaryTransactionIndex.count;
    index += 1
  ) {
    if (
      readExecutionBoundaryCancellationReasonCode(error, index) ===
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
 * @returns Whether a reason proves infrastructure rejection.
 */
function executionBoundaryCancellationWasTransient(
  error: unknown,
): boolean {
  for (
    let index = 0;
    index <
      workspaceSearchMigrationExecutionBoundaryTransactionIndex.count;
    index += 1
  ) {
    const code = readExecutionBoundaryCancellationReasonCode(
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
 * Preserves one stable managed transport guard failure without rereading.
 *
 * @param error - Candidate raw or public failure.
 * @returns Stable code that must bypass reconciliation.
 */
function readExecutionBoundaryTransportGuardFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode | undefined {
  if (!(error instanceof WorkspaceSearchMigrationFailure)) {
    return undefined
  }
  const code: unknown = error.code
  if (!isWorkspaceSearchMigrationFailureCode(code)) {
    return 'INVALID_STATE'
  }
  return code === 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
    : code
}

/**
 * Classifies a failed post-transaction stable-pair reread.
 *
 * @param error - Reread or parse failure.
 * @returns Stable fail-closed reconciliation code.
 */
function readExecutionBoundaryReconciliationFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  if (error instanceof ExecutionBoundaryAwsFailure) {
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
  return isExecutionBoundaryResourceNotFoundError(error)
    ? 'CONFIGURATION_DRIFT'
    : 'AMBIGUOUS_OPERATION_UNRESOLVED'
}

/**
 * Detects a missing or replaced DynamoDB resource.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether it denotes resource absence.
 */
function isExecutionBoundaryResourceNotFoundError(
  error: unknown,
): boolean {
  return error instanceof ResourceNotFoundException ||
    readExecutionBoundaryErrorName(error) ===
      'ResourceNotFoundException'
}

/**
 * Reads one stable Error name.
 *
 * @param error - Candidate raw error.
 * @returns Stable name or undefined.
 */
function readExecutionBoundaryErrorName(
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
function createExecutionBoundaryAwsClassificationInput(
  error: Error,
): ExecutionBoundaryAwsClassificationInput {
  const name = readExecutionBoundaryErrorName(error)
  const code = readExecutionBoundaryOptionalErrorCode(error)
  return {
    name: name ?? 'Error',
    message: '',
    ...(code === undefined ? {} : { code }),
    $metadata:
      readExecutionBoundaryOptionalErrorMetadata(error),
    $retryable:
      readExecutionBoundaryOptionalRetryable(error),
  }
}

/**
 * Reads one optional bounded Node.js error code.
 *
 * @param error - Candidate raw Error.
 * @returns Bounded code or undefined.
 */
function readExecutionBoundaryOptionalErrorCode(
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
function readExecutionBoundaryOptionalErrorMetadata(
  error: Error,
): ExecutionBoundaryAwsClassificationInput['$metadata'] {
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
function readExecutionBoundaryOptionalRetryable(
  error: Error,
): ExecutionBoundaryAwsClassificationInput['$retryable'] {
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
async function runExecutionBoundaryAwsBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createExecutionBoundaryAwsPublicFailure(
      readExecutionBoundaryAwsFailureCode(error, false),
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
function readExecutionBoundaryAwsFailureCode(
  error: unknown,
  duringConstruction: boolean,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof ExecutionBoundaryAwsFailure) {
      return error.code
    }
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : 'INVALID_STATE'
    }
    if (
      error instanceof WorkspaceSearchMigrationExecutionBoundaryError ||
      error instanceof WorkspaceSearchWriterFenceError
    ) {
      return duringConstruction ? 'INVALID_ARGUMENT' : 'INVALID_STATE'
    }
    if (isExecutionBoundaryResourceNotFoundError(error)) {
      return 'CONFIGURATION_DRIFT'
    }
    if (error instanceof Error) {
      const input =
        createExecutionBoundaryAwsClassificationInput(error)
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
function createExecutionBoundaryAwsPublicFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration execution boundary operation failed.',
  )
}

/**
 * Raises one private stable execution-boundary failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Never returns.
 */
function failExecutionBoundaryAws(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new ExecutionBoundaryAwsFailure(code)
}
