import {
  GetItemCommand,
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactionConflictException,
  TransactWriteItemsCommand,
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
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceReadMaterial,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  createWorkspaceSearchWriterFenceTransitionPut,
  encodeWorkspaceSearchWriterFenceRecord,
  parseWorkspaceSearchWriterFenceObservation,
  workspaceSearchWriterFenceClosedRecordMatchesAuthority,
  WorkspaceSearchWriterFenceError,
  workspaceSearchWriterFenceTableRoles,
  type WorkspaceSearchWriterFenceAuthority,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceOpenRecord,
  type WorkspaceSearchWriterFenceRecord,
  type WorkspaceSearchWriterFenceTableIds,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
  type WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
} from './migration-pre-plan-authority-aws'

/**
 * Fixed transaction positions for an authority-bound writer-fence transition.
 */
export const workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex =
  Object.freeze({
    lease: 0,
    pointer: 1,
    receipt: 2,
    writerFence: 3,
    count: 4,
  })

/**
 * Adapter-owned source of trusted writer-fence transition time.
 */
export type WorkspaceSearchMigrationApplicationWriterFenceClock =
  () => Date

/**
 * Durable operator transitions for the global application-writer fence.
 */
export interface WorkspaceSearchMigrationApplicationWriterFenceAwsPort {
  /**
   * Bootstraps a missing fence as open at epoch and revision one.
   *
   * This one-time capability is valid only while application writers are
   * already disabled through AppConfig and fresh drain evidence is held by
   * current authority. It is not a restore or terminal-recovery decision:
   * those paths require an external recovery workflow before a future reopen
   * capability may be introduced.
   * Recovering an already-identical open row proves only its durable identity;
   * that read-only retry does not re-prove authority freshness at call time.
   *
   * @param currentAuthority - Exact lease and drain receipt authority.
   * @returns Exact strongly reread durable open observation.
   */
  bootstrapOpen(
    currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchWriterFenceObservation>

  /**
   * Strongly reads the exact incarnation- and dataset-bound fence row.
   *
   * A missing observation is intentionally returned as unavailable state; it
   * cannot be converted to application guard material by the shared boundary.
   *
   * @returns Missing state or one detached strict durable observation.
   */
  read(): Promise<WorkspaceSearchWriterFenceObservation>

  /**
   * Closes one exact open epoch under fresh current pre-plan authority.
   *
   * Recovering an already-identical closed row proves only its durable identity;
   * that read-only retry does not re-prove authority freshness at call time.
   *
   * @param currentAuthority - Exact lease and maintenance receipt authority.
   * @returns Exact strongly reread durable closed observation.
   */
  close(
    currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchWriterFenceObservation>
}

/**
 * Detached measured material retained by one operator adapter.
 */
type ApplicationWriterFenceAdapterBinding = {
  /** Shared writer-fence state and dataset binding. */
  readonly fence: WorkspaceSearchWriterFenceBinding
  /** Reviewed digest of the complete measured configuration. */
  readonly configurationHash: string
  /** Exact detached migration-state identity used by authority conditions. */
  readonly stateTable: MigrationTableIdentity
}

/**
 * Captured transport functions immune to later caller mutation.
 */
type PreparedApplicationWriterFenceTransport = {
  /**
   * Strongly reads the exact fence row.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  readonly get: (
    command: GetItemCommand,
  ) => Promise<GetItemCommandOutput>
  /** Runs the final measured-incarnation preparation. */
  readonly prepare: () => Promise<void>
  /**
   * Sends one exact transition transaction.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Raw low-level DynamoDB response.
   */
  readonly transact: (
    command: TransactWriteItemsCommand,
  ) => Promise<TransactWriteItemsCommandOutput>
}

/**
 * Supported durable writer-fence transition.
 */
type ApplicationWriterFenceTransition = 'bootstrap' | 'close'

/**
 * Stable transition material retained across transaction reconciliation.
 */
type ApplicationWriterFenceCommit = {
  /** Logical transition being committed. */
  readonly operation: ApplicationWriterFenceTransition
  /** Exact strongly read predecessor. */
  readonly predecessor: WorkspaceSearchWriterFenceObservation
  /** Exact timestamped successor sent to DynamoDB. */
  readonly successor: WorkspaceSearchWriterFenceRecord
}

/**
 * Secret-free structural error accepted by Smithy's classifiers.
 */
type ApplicationWriterFenceAwsClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout code. */
    readonly code?: string
  }

/**
 * Private stable failure used inside the AWS adapter boundary.
 */
class ApplicationWriterFenceAwsFailure extends Error {
  /** Stable raw-value-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private stable failure.
   *
   * @param code - Operator-safe migration failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'ApplicationWriterFenceAwsFailure'
    this.code = code
  }
}

/**
 * Concrete durable writer-fence operator adapter.
 */
class AwsWorkspaceSearchMigrationApplicationWriterFencePort
implements WorkspaceSearchMigrationApplicationWriterFenceAwsPort {
  /** Detached configuration, state, and dataset binding. */
  private readonly binding: ApplicationWriterFenceAdapterBinding

  /** Captured narrow state-table transport. */
  private readonly transport: PreparedApplicationWriterFenceTransport

  /** Adapter-owned trusted transition clock. */
  private readonly clock:
    WorkspaceSearchMigrationApplicationWriterFenceClock

  /**
   * Creates one already validated measured adapter.
   *
   * @param binding - Detached measured binding.
   * @param transport - Captured narrow transport.
   * @param clock - Adapter-owned trusted clock.
   */
  constructor(
    binding: ApplicationWriterFenceAdapterBinding,
    transport: PreparedApplicationWriterFenceTransport,
    clock: WorkspaceSearchMigrationApplicationWriterFenceClock,
  ) {
    this.binding = binding
    this.transport = transport
    this.clock = clock
  }

  /**
   * Bootstraps an absent writer-fence row as explicitly open.
   *
   * The authority conditions prove the migration-controlled disabled/drained
   * rollout context atomically with the initial row. An existing initial row
   * is handled only as durable bootstrap retry recovery.
   *
   * @param currentAuthority - Exact fresh bootstrap authority.
   * @returns Exact durable initial open observation.
   */
  async bootstrapOpen(
    currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchWriterFenceObservation> {
    return runApplicationWriterFenceAwsBoundary(async () => {
      const authoritySnapshot = readAuthorityTransitionSnapshot(
        currentAuthority,
        this.binding,
      )
      const predecessor = await this.readFence()
      if (predecessor.status === 'present') {
        if (!isInitialOpenRecord(predecessor.record)) {
          return failApplicationWriterFenceAws('INVALID_STATE')
        }
        return cloneObservation(predecessor, this.binding.fence)
      }
      await this.transport.prepare()
      const commitAt = readApplicationWriterFenceClock(this.clock)
      const authorityChecks =
        createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
          stateTable: this.binding.stateTable,
          configurationHash: this.binding.configurationHash,
          authority: authoritySnapshot,
          commitAt,
        })
      const successor =
        createWorkspaceSearchWriterFenceInitialOpenRecord(
          this.binding.fence,
          commitAt,
        )
      return this.commitAndReconcile(
        {
          operation: 'bootstrap',
          predecessor,
          successor,
        },
        authorityChecks,
      )
    })
  }

  /**
   * Strongly reads the current writer-fence observation.
   *
   * @returns Missing or exact strict durable state.
   */
  async read(): Promise<WorkspaceSearchWriterFenceObservation> {
    return runApplicationWriterFenceAwsBoundary(() => this.readFence())
  }

  /**
   * Closes one open epoch under current lease and maintenance authority.
   *
   * @param currentAuthority - Exact current pre-plan authority.
   * @returns Exact durable closed observation.
   */
  async close(
    currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  ): Promise<WorkspaceSearchWriterFenceObservation> {
    return runApplicationWriterFenceAwsBoundary(async () => {
      const authoritySnapshot = readAuthorityTransitionSnapshot(
        currentAuthority,
        this.binding,
      )
      const closeAuthority =
        createWriterFenceAuthority(authoritySnapshot)
      const predecessor = await this.readFence()
      if (
        predecessor.status === 'present' &&
        predecessor.record.mode === 'closed'
      ) {
        if (
          !workspaceSearchWriterFenceClosedRecordMatchesAuthority(
            predecessor.record,
            this.binding.fence,
            closeAuthority,
          )
        ) {
          return failApplicationWriterFenceAws('INVALID_STATE')
        }
        return cloneObservation(predecessor, this.binding.fence)
      }
      if (
        predecessor.status !== 'present' ||
        predecessor.record.mode !== 'open'
      ) {
        return failApplicationWriterFenceAws('INVALID_STATE')
      }
      await this.transport.prepare()
      const commitAt = readApplicationWriterFenceClock(this.clock)
      const authorityChecks =
        createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
          stateTable: this.binding.stateTable,
          configurationHash: this.binding.configurationHash,
          authority: authoritySnapshot,
          commitAt,
        })
      const successor =
        createWorkspaceSearchWriterFenceClosedSuccessor(
          predecessor.record,
          closeAuthority,
          commitAt,
        )
      return this.commitAndReconcile(
        {
          operation: 'close',
          predecessor,
          successor,
        },
        authorityChecks,
      )
    })
  }

  /**
   * Commits one exact transition and always strongly rereads its durable row.
   *
   * Stable managed transport failures are not reconciled through a potentially
   * replaced session. Raw response loss is reconciled against this
   * incarnation-bound key and succeeds only for the exact logical successor.
   *
   * @param commit - Exact predecessor, successor, and logical operation.
   * @param authorityChecks - Three pre-plan authority checks.
   * @returns Exact durable successor observation.
   */
  private async commitAndReconcile(
    commit: ApplicationWriterFenceCommit,
    authorityChecks: readonly [
      TransactWriteItem,
      TransactWriteItem,
      TransactWriteItem,
    ],
  ): Promise<WorkspaceSearchWriterFenceObservation> {
    const transitionPut =
      createWorkspaceSearchWriterFenceTransitionPut(
        commit.predecessor,
        commit.successor,
      )
    const command = new TransactWriteItemsCommand({
      ClientRequestToken:
        createApplicationWriterFenceTransactionToken(commit),
      TransactItems: [...authorityChecks, transitionPut],
    })
    let transactionError: unknown
    try {
      await this.transport.transact(command)
    } catch (error: unknown) {
      const stableGuardFailure =
        readStableTransportGuardFailureCode(error)
      if (stableGuardFailure !== undefined) {
        return failApplicationWriterFenceAws(stableGuardFailure)
      }
      transactionError = error
    }
    return this.reconcileCommit(commit, transactionError)
  }

  /**
   * Strongly rereads and proves one exact or same-input durable successor.
   *
   * @param commit - Exact transition attempted by this adapter.
   * @param transactionError - Raw transaction failure, if one occurred.
   * @returns Exact detached durable successor.
   */
  private async reconcileCommit(
    commit: ApplicationWriterFenceCommit,
    transactionError: unknown,
  ): Promise<WorkspaceSearchWriterFenceObservation> {
    let output: GetItemCommandOutput
    try {
      output = await this.transport.get(
        new GetItemCommand(
          createWorkspaceSearchWriterFenceReadMaterial(
            this.binding.fence,
          ),
        ),
      )
    } catch (error: unknown) {
      const stableGuardFailure =
        readStableTransportGuardFailureCode(error)
      return failApplicationWriterFenceAws(
        stableGuardFailure ??
          (
            isResourceNotFoundError(error)
              ? 'CONFIGURATION_DRIFT'
              : 'AMBIGUOUS_OPERATION_UNRESOLVED'
          ),
      )
    }
    const durable = parseWorkspaceSearchWriterFenceObservation(
      output.Item,
      this.binding.fence,
    )
    if (durableMatchesCommit(durable, commit)) {
      return cloneObservation(durable, this.binding.fence)
    }
    if (observationEquals(durable, commit.predecessor)) {
      return failApplicationWriterFenceAws(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyApplicationWriterFenceTransactionError(
              transactionError,
            ),
      )
    }
    return failApplicationWriterFenceAws('INVALID_STATE')
  }

  /**
   * Strongly reads and parses the exact current fence row.
   *
   * @returns Missing or detached strict durable state.
   */
  private async readFence(): Promise<WorkspaceSearchWriterFenceObservation> {
    const output = await this.transport.get(
      new GetItemCommand(
        createWorkspaceSearchWriterFenceReadMaterial(
          this.binding.fence,
        ),
      ),
    )
    return parseWorkspaceSearchWriterFenceObservation(
      output.Item,
      this.binding.fence,
    )
  }
}

/**
 * Creates one measured durable application-writer-fence operator adapter.
 *
 * @param configuration - Complete measured six-table configuration.
 * @param configurationHash - Reviewed digest of that exact configuration.
 * @param transport - Existing measured pre-plan state-table transport.
 * @param clock - Adapter-owned trusted transition clock.
 * @returns Durable writer-fence operator port.
 */
export function createAwsWorkspaceSearchMigrationApplicationWriterFencePort(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  transport: WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
  clock: WorkspaceSearchMigrationApplicationWriterFenceClock,
): WorkspaceSearchMigrationApplicationWriterFenceAwsPort {
  try {
    const binding = createApplicationWriterFenceAdapterBinding(
      configuration,
      configurationHash,
    )
    const preparedTransport =
      prepareApplicationWriterFenceTransport(transport)
    if (typeof clock !== 'function') {
      return failApplicationWriterFenceAws('INVALID_ARGUMENT')
    }
    return new AwsWorkspaceSearchMigrationApplicationWriterFencePort(
      binding,
      preparedTransport,
      clock,
    )
  } catch (error: unknown) {
    throw createApplicationWriterFenceBoundaryFailure(
      readApplicationWriterFenceFailureCode(error, true),
    )
  }
}

/**
 * Constructs the complete detached six-table adapter binding.
 *
 * @param configuration - Candidate measured configuration.
 * @param configurationHash - Candidate reviewed digest.
 * @returns Exact detached adapter binding.
 */
function createApplicationWriterFenceAdapterBinding(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): ApplicationWriterFenceAdapterBinding {
  if (
    typeof configurationHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(configurationHash)
  ) {
    return failApplicationWriterFenceAws('INVALID_ARGUMENT')
  }
  let snapshot: WorkspaceSearchMigrationConfiguration
  try {
    snapshot = structuredClone(configuration)
  } catch {
    return failApplicationWriterFenceAws('INVALID_ARGUMENT')
  }
  let measuredHash: string
  try {
    measuredHash = createWorkspaceSearchConfigurationHash(snapshot)
  } catch {
    return failApplicationWriterFenceAws('INVALID_ARGUMENT')
  }
  if (measuredHash !== configurationHash) {
    return failApplicationWriterFenceAws(
      'CONFIGURATION_HASH_MISMATCH',
    )
  }
  const tableIds = createWriterFenceTableIds(snapshot)
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
    fence: createWorkspaceSearchWriterFenceBinding({
      stateTableName: stateTable.tableName,
      stateTableId: stateTable.tableId,
      stateIncarnationDigest,
      tableIds,
    }),
    configurationHash,
    stateTable,
  }
}

/**
 * Detaches all six table identifiers from one measured configuration.
 *
 * @param configuration - Detached measured configuration.
 * @returns Exact role-indexed physical TableIds.
 */
function createWriterFenceTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchWriterFenceTableIds {
  const tableIds = {
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
      return failApplicationWriterFenceAws('INVALID_ARGUMENT')
    }
  }
  return tableIds
}

/**
 * Captures and validates the three narrow transport functions.
 *
 * @param transport - Candidate measured pre-plan transport.
 * @returns Bound transport functions.
 */
function prepareApplicationWriterFenceTransport(
  transport: WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
): PreparedApplicationWriterFenceTransport {
  if (typeof transport !== 'object' || transport === null) {
    return failApplicationWriterFenceAws('INVALID_ARGUMENT')
  }
  const get = transport.getPrePlanAuthority
  const prepare = transport.preparePrePlanAuthorityWrite
  const transact = transport.transactWritePrePlanAuthority
  if (
    typeof get !== 'function' ||
    typeof prepare !== 'function' ||
    typeof transact !== 'function'
  ) {
    return failApplicationWriterFenceAws('INVALID_ARGUMENT')
  }
  return {
    get: get.bind(transport),
    prepare: prepare.bind(transport),
    transact: transact.bind(transport),
  }
}

/**
 * Validates and detaches current pre-plan authority before the first await.
 *
 * @param authority - Candidate caller-owned authority.
 * @param binding - Exact adapter configuration and state binding.
 * @returns Detached complete authority snapshot.
 */
function readAuthorityTransitionSnapshot(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  binding: ApplicationWriterFenceAdapterBinding,
): WorkspaceSearchMigrationPrePlanAuthority {
  let snapshot: WorkspaceSearchMigrationPrePlanAuthority
  try {
    snapshot = structuredClone(authority)
  } catch {
    return failApplicationWriterFenceAws('INVALID_ARGUMENT')
  }
  const evaluatedAt = new Date(snapshot.evaluatedAt)
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
    stateTable: binding.stateTable,
    configurationHash: binding.configurationHash,
    authority: snapshot,
    commitAt: evaluatedAt,
  })
  return snapshot
}

/**
 * Projects the stable close identity from complete pre-plan authority.
 *
 * @param authority - Strict detached current pre-plan authority.
 * @returns Stable writer-fence authority.
 */
function createWriterFenceAuthority(
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
 * Returns a detached observation through the strict shared codec.
 *
 * @param observation - Candidate strict observation.
 * @param binding - Independently measured current binding.
 * @returns Detached strict observation.
 */
function cloneObservation(
  observation: WorkspaceSearchWriterFenceObservation,
  binding: WorkspaceSearchWriterFenceBinding,
): WorkspaceSearchWriterFenceObservation {
  return observation.status === 'missing'
    ? parseWorkspaceSearchWriterFenceObservation(undefined, binding)
    : parseWorkspaceSearchWriterFenceObservation(
        encodeWorkspaceSearchWriterFenceRecord(observation.record),
        binding,
      )
}

/**
 * Detects the sole valid already-initialized row.
 *
 * @param record - Strict current durable row.
 * @returns Whether it is the exact initial open epoch.
 */
function isInitialOpenRecord(
  record: WorkspaceSearchWriterFenceRecord,
): record is WorkspaceSearchWriterFenceOpenRecord {
  return record.mode === 'open' &&
    record.writerEpoch === 1 &&
    record.controlRevision === 1 &&
    record.previousClosedRecordDigest === null &&
    createWorkspaceSearchWriterFenceInitialOpenRecord(
      record.binding,
      new Date(record.openedAt),
    ).recordDigest === record.recordDigest
}

/**
 * Determines whether a durable observation is the logical attempted successor.
 *
 * The durable row's own transition timestamp is used to reconstruct retries,
 * so a concurrent process or restarted adapter can recover the first success
 * without inventing a replacement durable identity.
 *
 * @param durable - Strongly reread current observation.
 * @param commit - Original stable predecessor and logical transition.
 * @returns Whether the durable row proves the attempted logical successor.
 */
function durableMatchesCommit(
  durable: WorkspaceSearchWriterFenceObservation,
  commit: ApplicationWriterFenceCommit,
): boolean {
  if (durable.status !== 'present') return false
  const record = durable.record
  if (commit.operation === 'bootstrap') {
    return isInitialOpenRecord(record)
  }
  if (
    commit.operation === 'close' &&
    commit.predecessor.status === 'present' &&
    commit.predecessor.record.mode === 'open' &&
    record.mode === 'closed' &&
    commit.successor.mode === 'closed'
  ) {
    if (
      !workspaceSearchWriterFenceClosedRecordMatchesAuthority(
        record,
        commit.successor.binding,
        commit.successor.authority,
      )
    ) {
      return false
    }
    return createWorkspaceSearchWriterFenceClosedSuccessor(
      commit.predecessor.record,
      commit.successor.authority,
      new Date(record.closedAt),
    ).recordDigest === record.recordDigest
  }
  return false
}

/**
 * Compares two strict observations by exact durable record identity.
 *
 * @param left - First observation.
 * @param right - Second observation.
 * @returns Whether both represent the same missing or exact present state.
 */
function observationEquals(
  left: WorkspaceSearchWriterFenceObservation,
  right: WorkspaceSearchWriterFenceObservation,
): boolean {
  if (left.status === 'missing' || right.status === 'missing') {
    return left.status === 'missing' && right.status === 'missing'
  }
  return left.record.recordDigest === right.record.recordDigest
}

/**
 * Creates one deterministic bounded exact-transaction idempotency token.
 *
 * @param commit - Exact predecessor and timestamped successor.
 * @returns Stable at-most-36-character DynamoDB token.
 */
function createApplicationWriterFenceTransactionToken(
  commit: ApplicationWriterFenceCommit,
): string {
  return createMigrationDigest({
    kind: 'workspace-search-application-writer-fence-commit',
    version: 1,
    operation: commit.operation,
    predecessorRecordDigest:
      commit.predecessor.status === 'missing'
        ? null
        : commit.predecessor.record.recordDigest,
    successorRecordDigest: commit.successor.recordDigest,
  }).slice(0, 36)
}

/**
 * Reads one trusted finite Date without retaining caller-owned state.
 *
 * @param clock - Adapter-owned trusted clock.
 * @returns Detached exact commit time.
 */
function readApplicationWriterFenceClock(
  clock: WorkspaceSearchMigrationApplicationWriterFenceClock,
): Date {
  const value = clock()
  if (!(value instanceof Date)) {
    return failApplicationWriterFenceAws('INVALID_STATE')
  }
  let milliseconds: number
  try {
    milliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failApplicationWriterFenceAws('INVALID_STATE')
  }
  if (!Number.isFinite(milliseconds)) {
    return failApplicationWriterFenceAws('INVALID_STATE')
  }
  return new Date(milliseconds)
}

/**
 * Classifies one failed transaction only after its predecessor was reread.
 *
 * @param error - Raw transaction failure.
 * @returns Stable migration failure code.
 */
function classifyApplicationWriterFenceTransactionError(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (isResourceNotFoundError(error)) return 'CONFIGURATION_DRIFT'
    if (
      error instanceof TransactionConflictException ||
      readErrorName(error) === 'TransactionConflictException'
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (error instanceof TransactionCanceledException) {
      const index =
        workspaceSearchMigrationApplicationWriterFenceAuthorityTransitionIndex
      if (
        readCancellationReasonCode(error, index.lease) ===
          'ConditionalCheckFailed'
      ) {
        return 'LEASE_LOST'
      }
      if (
        readCancellationReasonCode(error, index.pointer) ===
          'ConditionalCheckFailed' ||
        readCancellationReasonCode(error, index.receipt) ===
          'ConditionalCheckFailed'
      ) {
        return 'INVALID_MAINTENANCE_EVIDENCE'
      }
      if (
        readCancellationReasonCode(error, index.writerFence) ===
          'ConditionalCheckFailed'
      ) {
        return 'INVALID_STATE'
      }
      if (transactionCancellationWasTransient(error)) {
        return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
      }
      return 'INVALID_STATE'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (readErrorName(error) === 'TransactionInProgressException') {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const classificationInput =
      createApplicationWriterFenceAwsClassificationInput(error)
    if (isThrottlingError(classificationInput)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (isTransientError(classificationInput)) {
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
 * @param error - Raw DynamoDB transaction cancellation.
 * @param index - Zero-based transaction item index.
 * @returns Stable cancellation code when present.
 */
function readCancellationReasonCode(
  error: TransactionCanceledException,
  index: number,
): string | undefined {
  const reason = error.CancellationReasons?.[index]
  return typeof reason?.Code === 'string'
    ? reason.Code
    : undefined
}

/**
 * Detects explicit retry-safe cancellation reasons.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @returns Whether DynamoDB explicitly reported a transient cause.
 */
function transactionCancellationWasTransient(
  error: TransactionCanceledException,
): boolean {
  return error.CancellationReasons?.some((reason) =>
    reason.Code === 'TransactionConflict' ||
    reason.Code === 'ProvisionedThroughputExceeded' ||
    reason.Code === 'ThrottlingError'
  ) === true
}

/**
 * Preserves one already-stable managed transport guard failure.
 *
 * @param error - Candidate raw or public failure.
 * @returns Stable code that must not be reconciled through this transport.
 */
function readStableTransportGuardFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode | undefined {
  if (!(error instanceof WorkspaceSearchMigrationFailure)) {
    return undefined
  }
  const code: unknown = error.code
  return isWorkspaceSearchMigrationFailureCode(code)
    ? code
    : 'INVALID_STATE'
}

/**
 * Detects a missing/replaced DynamoDB resource.
 *
 * @param error - Candidate raw AWS failure.
 * @returns Whether it is ResourceNotFoundException.
 */
function isResourceNotFoundError(error: unknown): boolean {
  return error instanceof ResourceNotFoundException ||
    readErrorName(error) === 'ResourceNotFoundException'
}

/**
 * Reads one safe error name.
 *
 * @param error - Candidate error.
 * @returns Stable name or undefined.
 */
function readErrorName(error: unknown): string | undefined {
  try {
    return error instanceof Error && typeof error.name === 'string'
      ? error.name
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Supplies only structural retry-classifier fields.
 *
 * @param error - Raw error retained inside the adapter boundary.
 * @returns Secret-free classifier input.
 */
function createApplicationWriterFenceAwsClassificationInput(
  error: Error,
): ApplicationWriterFenceAwsClassificationInput {
  const name = readErrorName(error)
  const code = readOptionalErrorCode(error)
  return {
    name: name ?? 'Error',
    message: '',
    ...(code === undefined ? {} : { code }),
    $metadata: readOptionalErrorMetadata(error),
    $retryable: readOptionalRetryable(error),
  }
}

/**
 * Reads one optional Node.js error code.
 *
 * @param error - Candidate raw Error.
 * @returns Bounded code or undefined.
 */
function readOptionalErrorCode(error: Error): string | undefined {
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
function readOptionalErrorMetadata(
  error: Error,
): ApplicationWriterFenceAwsClassificationInput['$metadata'] {
  try {
    const value: unknown = Reflect.get(error, '$metadata')
    if (typeof value !== 'object' || value === null) return undefined
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
function readOptionalRetryable(
  error: Error,
): ApplicationWriterFenceAwsClassificationInput['$retryable'] {
  try {
    const value: unknown = Reflect.get(error, '$retryable')
    if (typeof value !== 'object' || value === null) return undefined
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
async function runApplicationWriterFenceAwsBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createApplicationWriterFenceBoundaryFailure(
      readApplicationWriterFenceFailureCode(error, false),
    )
  }
}

/**
 * Extracts one stable code from an internal, core, public, or raw failure.
 *
 * @param error - Arbitrary caught value.
 * @param duringConstruction - Whether invalid core input is caller argument.
 * @returns Stable raw-value-free migration failure code.
 */
function readApplicationWriterFenceFailureCode(
  error: unknown,
  duringConstruction: boolean,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof ApplicationWriterFenceAwsFailure) {
      return error.code
    }
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : 'INVALID_STATE'
    }
    if (error instanceof WorkspaceSearchWriterFenceError) {
      return duringConstruction ? 'INVALID_ARGUMENT' : 'INVALID_STATE'
    }
    if (isResourceNotFoundError(error)) return 'CONFIGURATION_DRIFT'
    if (error instanceof Error) {
      const input =
        createApplicationWriterFenceAwsClassificationInput(error)
      if (
        isThrottlingError(input) ||
        isTransientError(input)
      ) {
        return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
      }
    }
    return 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Creates one fixed safe public failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Public migration failure.
 */
function createApplicationWriterFenceBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search application writer fence operation failed.',
  )
}

/**
 * Raises one private stable writer-fence AWS failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Never returns.
 */
function failApplicationWriterFenceAws(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new ApplicationWriterFenceAwsFailure(code)
}
