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
import { isThrottlingError, isTransientError } from '@smithy/core/retry'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedConditionCheck,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  readWorkspaceSearchWriterFenceClosedRecord,
  workspaceSearchWriterFenceTableRoles,
  type WorkspaceSearchWriterFenceBinding,
  type WorkspaceSearchWriterFenceClosedRecord,
  type WorkspaceSearchWriterFenceTableIds,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationAppliedRootAbsentConditionCheck,
} from './migration-applied-root-aws'
import {
  createWorkspaceSearchMigrationApplyPredecessorAwsBinding,
  type WorkspaceSearchMigrationApplyPredecessorAwsBinding,
  type WorkspaceSearchMigrationApplyPredecessorAwsProjection,
} from './migration-apply-operation-aws'
import {
  createWorkspaceSearchMigrationCommittedPrefixApplySeal,
  parseWorkspaceSearchMigrationCommittedPrefixApplySeal,
  readWorkspaceSearchMigrationCommittedPrefixApplySealReference,
  serializeWorkspaceSearchMigrationCommittedPrefixApplySeal,
} from './migration-committed-prefix-apply-seal'
import type {
  WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway,
} from './migration-committed-prefix-apply-seal-aws'
import {
  createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck,
} from './migration-execution-boundary-aws'
import {
  detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary,
  parseWorkspaceSearchMigrationExecutionBoundary,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  type WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary,
} from './migration-execution-boundary'
import {
  createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck,
} from './migration-execution-run-aws'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createWorkspaceSearchMigrationFullVerificationConflictRecordKeys,
} from './migration-full-verification-key'
import {
  detachWorkspaceSearchMigrationPlanningConfiguration,
} from './migration-planning-join'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
  type WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationRollbackConflictRecordKeys,
  createWorkspaceSearchMigrationRolledBackRootV2RecordKey,
  createWorkspaceSearchMigrationRollbackStateV2RecordKey,
  createWorkspaceSearchMigrationRollbackStartRecordKey,
} from './migration-rollback-key'
import type {
  WorkspaceSearchMigrationRollbackAuthorityClaim,
  WorkspaceSearchMigrationRollbackCommandInput,
  WorkspaceSearchMigrationRollbackOperationAuthorityReader,
  WorkspaceSearchMigrationRollbackOperationAwsClock,
} from './migration-rollback-operation-aws'
import {
  createWorkspaceSearchMigrationRollbackStartRootV2,
  parseWorkspaceSearchMigrationRolledBackRootV2,
  parseWorkspaceSearchMigrationRollbackPersistenceStateV2,
  parseWorkspaceSearchMigrationRollbackStartRootV2,
  serializeWorkspaceSearchMigrationRolledBackRootV2,
  serializeWorkspaceSearchMigrationRollbackPersistenceStateV2,
  serializeWorkspaceSearchMigrationRollbackStartRootV2,
  type WorkspaceSearchMigrationRollbackPersistenceStateV2,
  type WorkspaceSearchMigrationRollbackStartRootV2,
  type WorkspaceSearchMigrationRolledBackRootV2,
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2,
} from './migration-rollback-persistence-v2'
import {
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck,
} from './migration-sealed-planning-authority-aws'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import type {
  WorkspaceSearchMigrationLeaseClaim,
} from './migration-state-machine'

const partialRollbackRecordVersion = 2
const rollbackStartRecordKind =
  'workspace-search-migration-rollback-start-root-record'
const rollbackStateRecordKind =
  'workspace-search-migration-rollback-state-record'
const rolledBackRootRecordKind =
  'workspace-search-migration-rolled-back-root-record'

/**
 * Fixed item positions for one atomic committed-prefix rollback start.
 */
export const workspaceSearchMigrationPartialRollbackStartTransactionIndex =
  Object.freeze({
    /** Current global lease condition. */
    lease: 0,
    /** Current maintenance pointer condition. */
    pointer: 1,
    /** Current immutable maintenance receipt condition. */
    receipt: 2,
    /** Exact closed application-writer fence condition. */
    writerFence: 3,
    /** Exact revision-two execution boundary condition. */
    executionBoundary: 4,
    /** Exact sealed planning-authority condition. */
    sealedPlanningAuthority: 5,
    /** Exact immutable execution admission condition. */
    executionRun: 6,
    /** Absent or exact mutable apply predecessor condition. */
    applyPredecessor: 7,
    /** Absent complete applied-root condition. */
    appliedRoot: 8,
    /** Absent deterministic full-verification mutable state. */
    verificationState: 9,
    /** Absent deterministic full-verification terminal root. */
    verifiedRoot: 10,
    /** Absent shared rollback-start sentinel Put. */
    startRoot: 11,
    /** Absent v2 rollback-state Put. */
    rollbackState: 12,
    /** Fixed partial rollback-start item count. */
    count: 13,
  })

/**
 * Narrow strongly consistent and transactional partial-start transport.
 */
export interface WorkspaceSearchMigrationPartialRollbackStartAwsTransport {
  /**
   * Strongly reads one adapter-owned or apply-owned migration-state row.
   *
   * @param command - Adapter-owned strongly consistent GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getPartialRollbackStartItem(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes all-six-table measured-incarnation guards after seal upload.
   */
  preparePartialRollbackStartWrite(): Promise<void>

  /**
   * Sends one fixed-order thirteen-item partial-start transaction.
   *
   * @param command - Adapter-owned fixed-order transaction.
   * @returns Raw low-level DynamoDB response.
   */
  transactWritePartialRollbackStart(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Static measured material and narrow capabilities for partial rollback start.
 */
export type CreateWorkspaceSearchMigrationPartialRollbackStartAwsPortInput = {
  /** Complete independently measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Exact revision-two planning-admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact immutable version-two sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact closed application-writer fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Fresh current-authority reader. */
  readonly authorityPort:
    WorkspaceSearchMigrationRollbackOperationAuthorityReader
  /** Run-scoped immutable committed-prefix seal gateway. */
  readonly committedPrefixSealGateway:
    Pick<
      WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway,
      | 'readCommittedPrefixApplySeal'
      | 'writeCommittedPrefixApplySeal'
    >
  /** Narrow measured DynamoDB partial-start transport. */
  readonly transport:
    WorkspaceSearchMigrationPartialRollbackStartAwsTransport
  /** Adapter-owned receiver-independent trusted clock function. */
  readonly clock: WorkspaceSearchMigrationRollbackOperationAwsClock
}

/**
 * Exact immutable committed-prefix terminal root fixed by a later transaction.
 */
export type CreateWorkspaceSearchMigrationRolledBackRootV2ConditionCheckInput =
  {
    /** Independently measured migration-state table identity. */
    readonly stateTable: MigrationTableIdentity
    /** Reviewed digest of the exact measured configuration. */
    readonly configurationHash: string
    /** Immutable execution admission owning the rollback chain. */
    readonly executionRun: WorkspaceSearchMigrationExecutionRun
    /** Exact immutable committed-prefix terminal root. */
    readonly root: WorkspaceSearchMigrationRolledBackRootV2
  }

/**
 * Durable standalone committed-prefix rollback-start capability.
 */
export interface WorkspaceSearchMigrationPartialRollbackStartAwsPort {
  /**
   * Reads the immutable identity owned by this lifecycle capability.
   *
   * @returns Fresh frozen binding identity.
   */
  readBindingIdentity():
    WorkspaceSearchMigrationPartialRollbackLifecycleBindingIdentity

  /**
   * Strongly reads the current validated v2 rollback lifecycle.
   *
   * @returns Coherent durable lifecycle, or undefined before rollback starts.
   */
  readRollbackLifecycle():
    Promise<
      WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot | undefined
    >

  /**
   * Strongly reads the current v2 rollback state.
   *
   * @returns Strict current durable state, or undefined before rollback starts.
   */
  readRollbackState():
    Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2 | undefined>

  /**
   * Creates one exact full-row condition for the immutable start root.
   *
   * @param startRoot - Exact immutable start root.
   * @returns Full-row equality ConditionCheck.
   */
  createStartRootConditionCheck(
    startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  ): TransactWriteItem

  /**
   * Creates one exact predecessor-state CAS Put.
   *
   * @param predecessor - Exact current rollback state.
   * @param successor - Exact direct lifecycle successor.
   * @returns Full-row predecessor CAS Put of the successor state.
   */
  createRollbackStateTransitionPut(
    predecessor: WorkspaceSearchMigrationRollbackPersistenceStateV2,
    successor: WorkspaceSearchMigrationRollbackPersistenceStateV2,
  ): TransactWriteItem

  /**
   * Creates one absent-only immutable terminal-root Put.
   *
   * @param rolledBackRoot - Exact immutable terminal root.
   * @returns Absent-row conditional Put.
   */
  createRolledBackRootAbsentPut(
    rolledBackRoot: WorkspaceSearchMigrationRolledBackRootV2,
  ): TransactWriteItem

  /**
   * Uploads a committed-prefix seal and atomically enters v2 rollback.
   *
   * @param input - Exact predecessor revision and current authority claim.
   * @returns Exact current durable rollback lifecycle state.
   */
  beginRollback(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2>
}

/**
 * Immutable identity of one v2 rollback lifecycle capability.
 */
export type WorkspaceSearchMigrationPartialRollbackLifecycleBindingIdentity = {
  /** Immutable physical migration-state table identifier. */
  readonly stateTableId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Operator-selected migration run. */
  readonly runId: string
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Stable digest shared by every rollback persistence record key. */
  readonly bindingDigest: string
}

/**
 * Coherent durable v2 rollback lifecycle validated against one start root.
 */
export type WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot = {
  /** Exact immutable committed-prefix rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Exact current rolling-back or terminal rollback state. */
  readonly state: WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Exact terminal root, present only with a terminal state. */
  readonly rolledBackRoot?: WorkspaceSearchMigrationRolledBackRootV2
}

/**
 * Detached immutable construction binding retained by the adapter.
 */
type PartialRollbackStartBinding = {
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact measured migration-state table. */
  readonly stateTable: MigrationTableIdentity
  /** Independently reconstructed writer-fence binding. */
  readonly writerFence: WorkspaceSearchWriterFenceBinding
  /** Exact closed writer-fence row. */
  readonly closedWriterFenceRecord:
    WorkspaceSearchWriterFenceClosedRecord
  /** Exact revision-two admitted execution boundary. */
  readonly executionBoundary:
    WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary
  /** Exact version-two sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Apply-owned exact predecessor capability. */
  readonly applyPredecessor:
    WorkspaceSearchMigrationApplyPredecessorAwsBinding
  /** Stable rollback-chain key namespace digest. */
  readonly bindingDigest: string
}

/**
 * Narrow v2 terminal-row binding shared by publication and conditions.
 */
type RolledBackRootV2RecordBinding = {
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Exact measured migration-state table. */
  readonly stateTable: MigrationTableIdentity
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Stable rollback-chain key namespace digest. */
  readonly bindingDigest: string
}

/**
 * Strict detached input prepared for a v2 terminal-root condition.
 */
type PreparedRolledBackRootV2ConditionCheckInput = {
  /** Narrow canonical durable-row binding. */
  readonly binding: RolledBackRootV2RecordBinding
  /** Strict detached immutable v2 terminal root. */
  readonly root: WorkspaceSearchMigrationRolledBackRootV2
}

/**
 * Captured dependency methods immune to later property replacement.
 */
type PreparedPartialRollbackStartDependencies = {
  /** Fresh authority read. */
  readonly readAuthority:
    WorkspaceSearchMigrationRollbackOperationAuthorityReader['readAuthority']
  /** Immutable committed-prefix seal write. */
  readonly writeSeal:
    WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway[
      'writeCommittedPrefixApplySeal'
    ]
  /** Immutable committed-prefix exact-version seal read. */
  readonly readSeal:
    WorkspaceSearchMigrationCommittedPrefixApplySealAwsGateway[
      'readCommittedPrefixApplySeal'
    ]
  /** Strong DynamoDB read. */
  readonly get:
    WorkspaceSearchMigrationPartialRollbackStartAwsTransport[
      'getPartialRollbackStartItem'
    ]
  /** Post-upload measured-incarnation preparation. */
  readonly prepare:
    WorkspaceSearchMigrationPartialRollbackStartAwsTransport[
      'preparePartialRollbackStartWrite'
    ]
  /** Fixed transaction send. */
  readonly transact:
    WorkspaceSearchMigrationPartialRollbackStartAwsTransport[
      'transactWritePartialRollbackStart'
    ]
  /** Detached trusted clock. */
  readonly clock: () => Date
}

/**
 * Fully detached caller command before the first asynchronous boundary.
 */
type PreparedPartialRollbackStartCommand = {
  /** Exact expected apply predecessor revision. */
  readonly expectedRevision: number
  /** Detached exact current authority claim. */
  readonly authority: WorkspaceSearchMigrationRollbackAuthorityClaim
}

/**
 * Coherent absent or atomically present partial-start snapshot.
 */
type PartialRollbackStartSnapshot = {
  /** Strict immutable v2 start root when present. */
  readonly startRoot?: WorkspaceSearchMigrationRollbackStartRootV2
  /** Strict current v2 rollback state when present. */
  readonly state?: WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Strict immutable v2 terminal root when present. */
  readonly rolledBackRoot?: WorkspaceSearchMigrationRolledBackRootV2
}

/**
 * Creates one measured direct committed-prefix rollback-start adapter.
 *
 * @param input - Measured roots, seal storage, authority, and transport.
 * @returns Atomic v2 rollback-start capability.
 */
export function createAwsWorkspaceSearchMigrationPartialRollbackStartPort(
  input: CreateWorkspaceSearchMigrationPartialRollbackStartAwsPortInput,
): WorkspaceSearchMigrationPartialRollbackStartAwsPort {
  try {
    const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
    requireExactKeys(record, [
      'authorityPort',
      'clock',
      'closedWriterFenceRecord',
      'committedPrefixSealGateway',
      'configuration',
      'configurationHash',
      'executionBoundary',
      'executionRun',
      'sealedPlanningAuthority',
      'transport',
    ], 'INVALID_ARGUMENT')
    const binding = createPartialRollbackStartBinding(
      readOwn(record, 'configuration', 'INVALID_ARGUMENT'),
      readOwn(record, 'configurationHash', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionBoundary', 'INVALID_ARGUMENT'),
      readOwn(record, 'sealedPlanningAuthority', 'INVALID_ARGUMENT'),
      readOwn(record, 'closedWriterFenceRecord', 'INVALID_ARGUMENT'),
      readOwn(record, 'executionRun', 'INVALID_ARGUMENT'),
    )
    const dependencies = preparePartialRollbackStartDependencies(
      readOwn(record, 'authorityPort', 'INVALID_ARGUMENT'),
      readOwn(
        record,
        'committedPrefixSealGateway',
        'INVALID_ARGUMENT',
      ),
      readOwn(record, 'transport', 'INVALID_ARGUMENT'),
      readOwn(record, 'clock', 'INVALID_ARGUMENT'),
    )
    return new AwsWorkspaceSearchMigrationPartialRollbackStartPort(
      binding,
      dependencies,
    )
  } catch (error: unknown) {
    throw createPartialRollbackStartPublicFailure(
      readPartialRollbackStartFailureCode(error, true),
    )
  }
}

/**
 * Creates an exact full-row condition for one immutable v2 rolled-back root.
 *
 * The admission and root are synchronously detached through their canonical
 * codecs. Every non-key durable attribute, including the canonical root bytes,
 * is compared by the returned condition.
 *
 * @param input - Measured state table, admission, configuration, and root.
 * @returns Exact immutable committed-prefix-root ConditionCheck.
 */
export function createWorkspaceSearchMigrationRolledBackRootV2ConditionCheck(
  input:
    CreateWorkspaceSearchMigrationRolledBackRootV2ConditionCheckInput,
): TransactWriteItem {
  try {
    const prepared = prepareRolledBackRootV2ConditionCheckInput(input)
    return createFullRowConditionCheck(
      prepared.binding.stateTable.tableName,
      createRolledBackRootRecord(prepared.binding, prepared.root),
    )
  } catch (error: unknown) {
    throw createPartialRollbackStartPublicFailure(
      readPartialRollbackStartFailureCode(error, true),
    )
  }
}

/**
 * Concrete direct committed-prefix rollback-start adapter.
 */
class AwsWorkspaceSearchMigrationPartialRollbackStartPort
implements WorkspaceSearchMigrationPartialRollbackStartAwsPort {
  /** Detached exact static binding. */
  private readonly binding: PartialRollbackStartBinding

  /** Frozen immutable identity exposed to composing operation adapters. */
  private readonly lifecycleBindingIdentity:
    WorkspaceSearchMigrationPartialRollbackLifecycleBindingIdentity

  /** Captured narrow dependencies. */
  private readonly dependencies:
    PreparedPartialRollbackStartDependencies

  /**
   * Creates one adapter from validated material.
   *
   * @param binding - Exact static partial-start binding.
   * @param dependencies - Captured narrow capabilities.
   */
  constructor(
    binding: PartialRollbackStartBinding,
    dependencies: PreparedPartialRollbackStartDependencies,
  ) {
    this.binding = binding
    this.lifecycleBindingIdentity = Object.freeze({
      stateTableId: binding.stateTable.tableId,
      configurationHash: binding.configurationHash,
      runId: binding.executionRun.runId,
      executionRunDigest:
        binding.executionRun.executionRunDigest,
      bindingDigest: binding.bindingDigest,
    })
    this.dependencies = dependencies
  }

  /**
   * Reads the immutable identity owned by this lifecycle capability.
   *
   * @returns Fresh frozen binding identity.
   */
  readBindingIdentity():
    WorkspaceSearchMigrationPartialRollbackLifecycleBindingIdentity {
    return Object.freeze({
      ...this.lifecycleBindingIdentity,
    })
  }

  /**
   * Strongly reads the current validated v2 rollback lifecycle.
   *
   * @returns Coherent durable lifecycle or undefined.
   */
  async readRollbackLifecycle():
    Promise<
      WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot | undefined
    > {
    return runPartialRollbackStartBoundary(async () =>
      this.readValidatedLifecycle()
    )
  }

  /**
   * Strongly reads the current v2 rollback state.
   *
   * @returns Strict durable state or undefined.
   */
  async readRollbackState():
    Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2 | undefined> {
    return runPartialRollbackStartBoundary(async () =>
      (await this.readValidatedLifecycle())?.state
    )
  }

  /**
   * Creates one exact full-row start-root condition.
   *
   * @param startRoot - Exact immutable start root.
   * @returns Full-row equality ConditionCheck.
   */
  createStartRootConditionCheck(
    startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  ): TransactWriteItem {
    return runPartialRollbackStartSynchronousBoundary(() => {
      const strictStartRoot =
        readPartialRollbackStartFactoryInput(() => {
          const parsed =
            parseWorkspaceSearchMigrationRollbackStartRootV2(
              serializeWorkspaceSearchMigrationRollbackStartRootV2(
                startRoot,
              ),
            )
          requireStartRootBinding(this.binding, parsed)
          return parsed
        })
      return createFullRowConditionCheck(
        this.binding.stateTable.tableName,
        createRollbackStartRecord(
          this.binding,
          strictStartRoot,
        ),
      )
    })
  }

  /**
   * Creates one exact predecessor-state CAS Put.
   *
   * @param predecessor - Exact current rollback state.
   * @param successor - Exact direct lifecycle successor.
   * @returns Full-row predecessor CAS Put of the successor state.
   */
  createRollbackStateTransitionPut(
    predecessor: WorkspaceSearchMigrationRollbackPersistenceStateV2,
    successor: WorkspaceSearchMigrationRollbackPersistenceStateV2,
  ): TransactWriteItem {
    return runPartialRollbackStartSynchronousBoundary(() => {
      const strictTransition =
        readPartialRollbackStartFactoryInput(() => {
          const parsedPredecessor =
            parseWorkspaceSearchMigrationRollbackPersistenceStateV2(
              serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
                predecessor,
              ),
            )
          const parsedSuccessor =
            parseWorkspaceSearchMigrationRollbackPersistenceStateV2(
              serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
                successor,
              ),
            )
          requireDirectRollbackStateTransition(
            this.binding,
            parsedPredecessor,
            parsedSuccessor,
          )
          return {
            predecessor: parsedPredecessor,
            successor: parsedSuccessor,
          }
        })
      return createExactPredecessorPut(
        this.binding.stateTable.tableName,
        createRollbackStateRecord(
          this.binding,
          strictTransition.predecessor,
        ),
        createRollbackStateRecord(
          this.binding,
          strictTransition.successor,
        ),
      )
    })
  }

  /**
   * Creates one absent-only immutable terminal-root Put.
   *
   * @param rolledBackRoot - Exact immutable terminal root.
   * @returns Absent-row conditional Put.
   */
  createRolledBackRootAbsentPut(
    rolledBackRoot: WorkspaceSearchMigrationRolledBackRootV2,
  ): TransactWriteItem {
    return runPartialRollbackStartSynchronousBoundary(() => {
      const strictRoot =
        readPartialRollbackStartFactoryInput(() => {
          const parsed =
            parseWorkspaceSearchMigrationRolledBackRootV2(
              serializeWorkspaceSearchMigrationRolledBackRootV2(
                rolledBackRoot,
              ),
            )
          requireRolledBackRootBinding(this.binding, parsed)
          return parsed
        })
      return createAbsentPut(
        this.binding.stateTable.tableName,
        createRolledBackRootRecord(
          this.binding,
          strictRoot,
        ),
      )
    })
  }

  /**
   * Uploads the current committed-prefix seal and atomically starts rollback.
   *
   * @param input - Exact apply predecessor revision and authority claim.
   * @returns Exact current durable rollback lifecycle state.
   */
  async beginRollback(
    input: WorkspaceSearchMigrationRollbackCommandInput,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2> {
    return runPartialRollbackStartBoundary(async () => {
      const command = preparePartialRollbackStartCommand(input)
      const existing = await this.readCoherentStartSnapshot()
      if (
        existing.startRoot !== undefined ||
        existing.state !== undefined ||
        existing.rolledBackRoot !== undefined
      ) {
        const lifecycle =
          await this.requireValidLifecycle(existing)
        requireStartMatchesCommand(
          lifecycle.startRoot,
          command,
        )
        return lifecycle.state
      }
      if (await this.hasFullVerificationConflict()) {
        return failPartialRollbackStart('INVALID_STATE')
      }

      const predecessor = await this.readApplyPredecessor()
      requireApplyPredecessorRevision(predecessor, command)
      const authority = await this.resolveAuthority(command)
      requireAuthorityClaimMatchesAuthority(
        command.authority,
        authority,
      )

      const sealCreatedAt = readClock(this.dependencies.clock)
      const seal =
        createWorkspaceSearchMigrationCommittedPrefixApplySeal({
          admission: this.binding.executionRun,
          predecessor: predecessor.predecessor,
          sealedPlanningAuthority:
            this.binding.sealedPlanningAuthority,
          createdAt: sealCreatedAt.toISOString(),
        })
      const sealBytes =
        serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
          seal,
        )
      const sealForWrite =
        parseWorkspaceSearchMigrationCommittedPrefixApplySeal(
          sealBytes,
        )
      let sealReferenceValue:
        Awaited<
          ReturnType<
            PreparedPartialRollbackStartDependencies['writeSeal']
          >
        >
      try {
        sealReferenceValue = await this.dependencies.writeSeal({
          seal: sealForWrite,
        })
      } catch (error: unknown) {
        const publicCode = readPublicFailureCode(error)
        return failPartialRollbackStart(publicCode ?? 'INVALID_JOURNAL')
      }
      const sealReference =
        readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
          sealReferenceValue,
        )

      await this.dependencies.prepare()
      const commitAt = readClock(this.dependencies.clock)
      const sealForRoot =
        parseWorkspaceSearchMigrationCommittedPrefixApplySeal(
          sealBytes,
        )
      const startRoot =
        createWorkspaceSearchMigrationRollbackStartRootV2({
          admission: this.binding.executionRun,
          predecessor: predecessor.predecessor,
          sealedPlanningAuthority:
            this.binding.sealedPlanningAuthority,
          seal: sealForRoot,
          sealReference,
          currentAuthority: authority,
          startedAt: commitAt.toISOString(),
        })
      if (
        startRoot.predecessorRevision !== command.expectedRevision
      ) {
        return failPartialRollbackStart('INVALID_STATE')
      }
      const transaction =
        createPartialRollbackStartTransactionCommand({
          binding: this.binding,
          currentAuthority: authority,
          predecessor,
          commitAt,
          startRoot,
        })
      let transactionError: unknown
      try {
        await this.dependencies.transact(transaction)
      } catch (error: unknown) {
        const publicCode = readPublicFailureCode(error)
        if (publicCode !== undefined) {
          return failPartialRollbackStart(publicCode)
        }
        transactionError = error
      }
      return this.reconcileBeginAfterAttempt(
        command,
        startRoot,
        transactionError,
      )
    })
  }

  /**
   * Resolves and validates fresh current authority.
   *
   * @param command - Detached caller command.
   * @returns Fresh strict authority bound to this run.
   */
  private async resolveAuthority(
    command: PreparedPartialRollbackStartCommand,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    const candidate = await this.dependencies.readAuthority(
      {
        lease: {
          runId: command.authority.lease.runId,
          ownerId: command.authority.lease.ownerId,
          fenceToken: command.authority.lease.fenceToken,
        },
        maintenanceEvidencePointerRevision:
          command.authority.maintenanceEvidencePointerRevision,
        maintenanceEvidenceReceiptDigest:
          command.authority.maintenanceEvidenceReceiptDigest,
      },
    )
    const detached =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        candidate,
      )
    if (
      detached.configurationHash !==
        this.binding.configurationHash ||
      detached.stateTableId !== this.binding.stateTable.tableId ||
      detached.lease.runId !== this.binding.executionRun.runId
    ) {
      return failPartialRollbackStart('CONFIGURATION_DRIFT')
    }
    return detached
  }

  /**
   * Strongly reads the current apply predecessor and applied-root absence.
   *
   * @returns Correlated exact apply predecessor projection.
   */
  private async readApplyPredecessor():
    Promise<WorkspaceSearchMigrationApplyPredecessorAwsProjection> {
    const [stateOutput, rootOutput] = await Promise.all([
      this.dependencies.get(
        this.binding.applyPredecessor
          .createExecutionStateStrongReadCommand(),
      ),
      this.dependencies.get(
        this.binding.applyPredecessor
          .createAppliedRootStrongReadCommand(),
      ),
    ])
    return this.binding.applyPredecessor.parseStrongReadOutputs(
      stateOutput,
      rootOutput,
    )
  }

  /**
   * Strongly detects either deterministic full-verification progress row.
   *
   * @returns Whether verification already won the phase-start race.
   */
  private async hasFullVerificationConflict(): Promise<boolean> {
    const keys = createFullVerificationConflictRecordKeys(
      this.binding,
    )
    const [stateOutput, rootOutput] = await Promise.all([
      this.dependencies.get(
        createStrongStateReadCommand(this.binding, keys.state),
      ),
      this.dependencies.get(
        createStrongStateReadCommand(this.binding, keys.root),
      ),
    ])
    return readOutputItem(stateOutput) !== undefined ||
      readOutputItem(rootOutput) !== undefined
  }

  /**
   * Reads start and state rows until two complete observations agree.
   *
   * @returns Coherent absent or atomically present partial-start snapshot.
   */
  private async readCoherentStartSnapshot():
    Promise<PartialRollbackStartSnapshot> {
    return readCoherentPartialRollbackStartSnapshot(
      async () => {
        const [startRoot, state, rolledBackRoot] = await Promise.all([
          this.readStart(),
          this.readState(),
          this.readRolledBackRoot(),
        ])
        return { startRoot, state, rolledBackRoot }
      },
      (left, right) =>
        left.startRoot?.startRootDigest ===
          right.startRoot?.startRootDigest &&
        left.state?.stateDigest === right.state?.stateDigest &&
        left.rolledBackRoot?.rootDigest ===
          right.rolledBackRoot?.rootDigest,
    )
  }

  /**
   * Reads and validates one complete lifecycle or coherent absence.
   *
   * @returns Exact validated lifecycle or undefined before rollback starts.
   */
  private async readValidatedLifecycle():
    Promise<
      WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot | undefined
    > {
    const snapshot = await this.readCoherentStartSnapshot()
    if (
      snapshot.startRoot === undefined &&
      snapshot.state === undefined &&
      snapshot.rolledBackRoot === undefined
    ) {
      return undefined
    }
    return this.requireValidLifecycle(snapshot)
  }

  /**
   * Validates one present start, mutable state, and optional terminal root.
   *
   * @param snapshot - Coherent present lifecycle rows.
   * @returns Exact validated lifecycle.
   */
  private async requireValidLifecycle(
    snapshot: PartialRollbackStartSnapshot,
  ): Promise<WorkspaceSearchMigrationPartialRollbackLifecycleSnapshot> {
    const startRoot = snapshot.startRoot
    const state = snapshot.state
    const rolledBackRoot = snapshot.rolledBackRoot
    if (startRoot === undefined || state === undefined) {
      return failPartialRollbackStart('INVALID_STATE')
    }
    requireStartAndLifecycleState(
      this.binding,
      startRoot,
      state,
    )
    if (
      (state.status === 'rolling-back' &&
        rolledBackRoot !== undefined) ||
      (state.status === 'rolled-back' &&
        rolledBackRoot === undefined)
    ) {
      return failPartialRollbackStart('INVALID_STATE')
    }
    if (rolledBackRoot !== undefined) {
      requireTerminalRootMatchesLifecycle(
        this.binding,
        startRoot,
        state,
        rolledBackRoot,
      )
    }
    await this.requireStoredSeal(startRoot)
    return rolledBackRoot === undefined
      ? { startRoot, state }
      : { startRoot, state, rolledBackRoot }
  }

  /**
   * Strongly reads the shared rollback-start sentinel row.
   *
   * @returns Strict v2 start root or undefined.
   */
  private async readStart():
    Promise<WorkspaceSearchMigrationRollbackStartRootV2 | undefined> {
    const output = await this.dependencies.get(
      createStrongStateReadCommand(
        this.binding,
        createRollbackStartRecordKey(this.binding),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseRollbackStartRecord(this.binding, item)
  }

  /**
   * Strongly reads the v2 rollback-state row.
   *
   * @returns Strict current v2 lifecycle state or undefined.
   */
  private async readState():
    Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2 | undefined> {
    const output = await this.dependencies.get(
      createStrongStateReadCommand(
        this.binding,
        createRollbackStateRecordKey(this.binding),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseRollbackStateRecord(this.binding, item)
  }

  /**
   * Strongly reads the immutable v2 rolled-back root row.
   *
   * @returns Strict v2 terminal root or undefined.
   */
  private async readRolledBackRoot():
    Promise<WorkspaceSearchMigrationRolledBackRootV2 | undefined> {
    const output = await this.dependencies.get(
      createStrongStateReadCommand(
        this.binding,
        createRolledBackRootRecordKey(this.binding),
      ),
    )
    const item = readOutputItem(output)
    return item === undefined
      ? undefined
      : parseRolledBackRootRecord(this.binding, item)
  }

  /**
   * Reads and compares the exact immutable seal version fixed by a start root.
   *
   * @param startRoot - Strict committed v2 rollback-start root.
   */
  private async requireStoredSeal(
    startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  ): Promise<void> {
    const expectedBytes =
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        startRoot.origin.seal,
      )
    const reference =
      readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
        startRoot.origin.sealReference,
      )
    let stored: Awaited<
      ReturnType<
        PreparedPartialRollbackStartDependencies['readSeal']
      >
    >
    try {
      stored = await this.dependencies.readSeal(
        reference,
      )
    } catch (error: unknown) {
      const publicCode = readPublicFailureCode(error)
      return failPartialRollbackStart(
        publicCode ?? 'INVALID_JOURNAL',
      )
    }
    const storedBytes =
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        stored,
      )
    if (
      Buffer.compare(
        Buffer.from(storedBytes),
        Buffer.from(expectedBytes),
      ) !== 0
    ) {
      return failPartialRollbackStart('INVALID_JOURNAL')
    }
  }

  /**
   * Reconciles a transaction attempt through deterministic durable rows.
   *
   * @param command - Detached attempted command.
   * @param intendedStart - Locally constructed intended start root.
   * @param transactionError - Raw transaction failure when present.
   * @returns Exact current committed lifecycle state.
   */
  private async reconcileBeginAfterAttempt(
    command: PreparedPartialRollbackStartCommand,
    intendedStart: WorkspaceSearchMigrationRollbackStartRootV2,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationRollbackPersistenceStateV2> {
    let snapshot: PartialRollbackStartSnapshot
    try {
      snapshot = await this.readCoherentStartSnapshot()
    } catch (error: unknown) {
      return failPartialRollbackStart(
        readPartialRollbackStartReconciliationFailureCode(error),
      )
    }
    if (
      snapshot.startRoot === undefined ||
      snapshot.state === undefined
    ) {
      if (
        snapshot.startRoot !== undefined ||
        snapshot.state !== undefined ||
        snapshot.rolledBackRoot !== undefined
      ) {
        return failPartialRollbackStart('INVALID_STATE')
      }
      return failPartialRollbackStart(
        transactionError === undefined
          ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
          : classifyPartialRollbackStartTransactionError(
              transactionError,
            ),
      )
    }
    requireStartIsLogicalWinner(
      command,
      intendedStart,
      snapshot.startRoot,
    )
    return (
      await this.requireValidLifecycle(snapshot)
    ).state
  }
}

/**
 * Complete controlled attribute set for the shared immutable start row.
 */
const rollbackStartRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'originDigest',
  'predecessorRevision',
  'recordKey',
  'recordVersion',
  'runId',
  'startRootBytes',
  'startRootDigest',
  'stateTableId',
])

/**
 * Complete controlled attribute set for the v2 rollback-state row.
 */
const rollbackStateRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'originDigest',
  'recordKey',
  'recordVersion',
  'revision',
  'runId',
  'startRootDigest',
  'stateBytes',
  'stateDigest',
  'stateTableId',
  'status',
])

/**
 * Complete controlled attribute set for the v2 rolled-back root row.
 */
const rolledBackRootRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'originDigest',
  'recordKey',
  'recordVersion',
  'rootBytes',
  'rootDigest',
  'runId',
  'startRootDigest',
  'stateTableId',
  'terminalStateDigest',
])

/**
 * Detaches and cross-validates all construction-time partial-start material.
 *
 * @param configurationValue - Candidate measured configuration.
 * @param configurationHashValue - Candidate reviewed digest.
 * @param executionBoundaryValue - Candidate revision-two boundary.
 * @param sealedPlanningAuthorityValue - Candidate sealed authority.
 * @param closedWriterFenceRecordValue - Candidate closed fence row.
 * @param executionRunValue - Candidate immutable execution admission.
 * @returns Exact detached static partial-start binding.
 */
function createPartialRollbackStartBinding(
  configurationValue: unknown,
  configurationHashValue: unknown,
  executionBoundaryValue: unknown,
  sealedPlanningAuthorityValue: unknown,
  closedWriterFenceRecordValue: unknown,
  executionRunValue: unknown,
): PartialRollbackStartBinding {
  const configuration =
    detachWorkspaceSearchMigrationPlanningConfiguration(
      configurationValue,
    )
  const configurationHash = readDigest(
    configurationHashValue,
    'INVALID_ARGUMENT',
  )
  if (
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failPartialRollbackStart(
      'CONFIGURATION_HASH_MISMATCH',
    )
  }
  const executionBoundary =
    parseWorkspaceSearchMigrationExecutionBoundary(
      serializeWorkspaceSearchMigrationExecutionBoundary(
        requireExecutionBoundary(executionBoundaryValue),
      ),
    )
  if (executionBoundary.phase !== 'planning-admitted') {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  const sealedPlanningAuthority =
    parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        requireSealedPlanningAuthority(
          sealedPlanningAuthorityValue,
        ),
      ),
    )
  const closedWriterFenceRecord =
    readWorkspaceSearchWriterFenceClosedRecord(
      requireClosedWriterFenceRecord(
        closedWriterFenceRecordValue,
      ),
    )
  const executionRun =
    parseWorkspaceSearchMigrationExecutionRun(
      serializeWorkspaceSearchMigrationExecutionRun(
        requireExecutionRun(executionRunValue),
      ),
    )
  const stateTable = configuration.tables['migration-state']
  const tableIds = createPartialRollbackTableIds(configuration)
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
  if (
    executionBoundary.configurationHash !== configurationHash ||
    sealedPlanningAuthority.configurationHash !==
      configurationHash ||
    executionRun.configurationHash !== configurationHash ||
    executionBoundary.runId !== sealedPlanningAuthority.runId ||
    executionBoundary.runId !== executionRun.runId ||
    executionRun.binding.executionBoundaryDigest !==
      executionBoundary.boundaryDigest ||
    executionRun.binding.closedWriterFenceRecordDigest !==
      closedWriterFenceRecord.recordDigest ||
    executionRun.binding.sealedPlanningAuthorityDigest !==
      sealedPlanningAuthority.authorityDigest ||
    executionRun.binding.planDigest !==
      sealedPlanningAuthority.planDigest ||
    executionRun.binding.planOperationCount !==
      sealedPlanningAuthority.planOperationCount ||
    closedWriterFenceRecord.binding.recordKey !==
      writerFence.recordKey
  ) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      executionBoundary.tableIds[role] !== tableIds[role] ||
      sealedPlanningAuthority.tableIds[role] !== tableIds[role] ||
      executionRun.binding.tableIds[role] !== tableIds[role] ||
      closedWriterFenceRecord.binding.tableIds[role] !==
        tableIds[role]
    ) {
      return failPartialRollbackStart('CONFIGURATION_DRIFT')
    }
  }
  createWorkspaceSearchWriterFenceClosedConditionCheck(
    closedWriterFenceRecord,
    writerFence,
  )
  createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
    {
      stateTable,
      configurationHash,
      boundary: executionBoundary,
    },
  )
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck({
    stateTable,
    configurationHash,
    authority: sealedPlanningAuthority,
  })
  createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
    stateTable,
    configurationHash,
    executionRun,
  })
  const applyPredecessor =
    createWorkspaceSearchMigrationApplyPredecessorAwsBinding({
      stateTable,
      configurationHash,
      executionRun,
    })
  return {
    configurationHash,
    stateTable,
    writerFence,
    closedWriterFenceRecord,
    executionBoundary,
    sealedPlanningAuthority,
    executionRun,
    applyPredecessor,
    bindingDigest:
      createWorkspaceSearchMigrationRollbackConflictRecordKeys({
        stateTableId: stateTable.tableId,
        configurationHash,
        runId: executionRun.runId,
        executionRunDigest: executionRun.executionRunDigest,
      }).bindingDigest,
  }
}

/**
 * Projects all six measured table identifiers.
 *
 * @param configuration - Detached measured configuration.
 * @returns Exact role-indexed identifiers.
 */
function createPartialRollbackTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchWriterFenceTableIds {
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
 * Captures dependency methods without retaining mutable public properties.
 *
 * @param authorityPortValue - Candidate authority reader.
 * @param sealGatewayValue - Candidate immutable seal writer.
 * @param transportValue - Candidate DynamoDB transport.
 * @param clockValue - Candidate trusted clock.
 * @returns Captured narrow dependencies.
 */
function preparePartialRollbackStartDependencies(
  authorityPortValue: unknown,
  sealGatewayValue: unknown,
  transportValue: unknown,
  clockValue: unknown,
): PreparedPartialRollbackStartDependencies {
  const authorityPort =
    requireDependencyObject(authorityPortValue)
  const sealGateway =
    requireDependencyObject(sealGatewayValue)
  const transport = requireDependencyObject(transportValue)
  const readAuthority = readCallableMethod(
    authorityPort,
    'readAuthority',
  )
  const writeSeal = readCallableMethod(
    sealGateway,
    'writeCommittedPrefixApplySeal',
  )
  const readSeal = readCallableMethod(
    sealGateway,
    'readCommittedPrefixApplySeal',
  )
  const get = readCallableMethod(
    transport,
    'getPartialRollbackStartItem',
  )
  const prepare = readCallableMethod(
    transport,
    'preparePartialRollbackStartWrite',
  )
  const transact = readCallableMethod(
    transport,
    'transactWritePartialRollbackStart',
  )
  if (
    !isCallable<
      PreparedPartialRollbackStartDependencies['readAuthority']
    >(readAuthority) ||
    !isCallable<
      PreparedPartialRollbackStartDependencies['writeSeal']
    >(writeSeal) ||
    !isCallable<
      PreparedPartialRollbackStartDependencies['readSeal']
    >(readSeal) ||
    !isCallable<
      PreparedPartialRollbackStartDependencies['get']
    >(get) ||
    !isCallable<
      PreparedPartialRollbackStartDependencies['prepare']
    >(prepare) ||
    !isCallable<
      PreparedPartialRollbackStartDependencies['transact']
    >(transact)
  ) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return {
    readAuthority: readAuthority.bind(authorityPort),
    writeSeal: writeSeal.bind(sealGateway),
    readSeal: readSeal.bind(sealGateway),
    get: get.bind(transport),
    prepare: prepare.bind(transport),
    transact: transact.bind(transport),
    clock: snapshotClock(clockValue),
  }
}

/**
 * Creates the complete immutable v2 rollback-start DynamoDB row.
 *
 * @param binding - Exact static partial-start binding.
 * @param root - Strict immutable v2 start root.
 * @returns Complete bounded low-level row.
 */
function createRollbackStartRecord(
  binding: PartialRollbackStartBinding,
  root: WorkspaceSearchMigrationRollbackStartRootV2,
): Readonly<Record<string, AttributeValue>> {
  requireStartRootBinding(binding, root)
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: createRollbackStartRecordKey(binding) },
    recordVersion: { N: String(partialRollbackRecordVersion) },
    kind: { S: rollbackStartRecordKind },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    originDigest: { S: root.originDigest },
    predecessorRevision: { N: String(root.predecessorRevision) },
    startRootDigest: { S: root.startRootDigest },
    startRootBytes: {
      B: serializeWorkspaceSearchMigrationRollbackStartRootV2(root),
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses one immutable v2 rollback-start DynamoDB row.
 *
 * @param binding - Exact static partial-start binding.
 * @param value - Untrusted low-level row.
 * @returns Strict detached v2 start root.
 */
function parseRollbackStartRecord(
  binding: PartialRollbackStartBinding,
  value: unknown,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  const item = cloneLowLevelMap(value, 'INVALID_STATE')
  requireExactAttributeKeys(
    item,
    rollbackStartRecordAttributeNames,
    'INVALID_STATE',
  )
  requireCommonRecordBinding(
    binding,
    item,
    rollbackStartRecordKind,
    createRollbackStartRecordKey(binding),
  )
  const root = parseWorkspaceSearchMigrationRollbackStartRootV2(
    readBinaryAttribute(item, 'startRootBytes'),
  )
  if (
    readDigestAttribute(item, 'startRootDigest') !==
      root.startRootDigest ||
    readDigestAttribute(item, 'originDigest') !==
      root.originDigest ||
    readPositiveSafeIntegerAttribute(
      item,
      'predecessorRevision',
    ) !== root.predecessorRevision
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  requireStartRootBinding(binding, root)
  requireAttributeMapsEqual(
    item,
    createRollbackStartRecord(binding, root),
  )
  return root
}

/**
 * Creates the complete current v2 rollback-state DynamoDB row.
 *
 * @param binding - Exact static partial-start binding.
 * @param state - Strict current v2 rollback lifecycle state.
 * @returns Complete bounded low-level row.
 */
function createRollbackStateRecord(
  binding: PartialRollbackStartBinding,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): Readonly<Record<string, AttributeValue>> {
  requireStateBinding(binding, state)
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: createRollbackStateRecordKey(binding) },
    recordVersion: { N: String(partialRollbackRecordVersion) },
    kind: { S: rollbackStateRecordKind },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    originDigest: { S: state.originDigest },
    startRootDigest: { S: state.startRootDigest },
    revision: { N: String(state.revision) },
    status: { S: state.status },
    stateDigest: { S: state.stateDigest },
    stateBytes: {
      B: serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
        state,
      ),
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses one current v2 rollback-state DynamoDB row.
 *
 * @param binding - Exact static partial-start binding.
 * @param value - Untrusted low-level row.
 * @returns Strict detached v2 rollback state.
 */
function parseRollbackStateRecord(
  binding: PartialRollbackStartBinding,
  value: unknown,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  const item = cloneLowLevelMap(value, 'INVALID_STATE')
  requireExactAttributeKeys(
    item,
    rollbackStateRecordAttributeNames,
    'INVALID_STATE',
  )
  requireCommonRecordBinding(
    binding,
    item,
    rollbackStateRecordKind,
    createRollbackStateRecordKey(binding),
  )
  const state =
    parseWorkspaceSearchMigrationRollbackPersistenceStateV2(
      readBinaryAttribute(item, 'stateBytes'),
    )
  if (
    readPositiveSafeIntegerAttribute(item, 'revision') !==
      state.revision ||
    readStringAttribute(item, 'status') !== state.status ||
    readDigestAttribute(item, 'stateDigest') !==
      state.stateDigest ||
    readDigestAttribute(item, 'originDigest') !==
      state.originDigest ||
    readDigestAttribute(item, 'startRootDigest') !==
      state.startRootDigest
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  requireStateBinding(binding, state)
  requireAttributeMapsEqual(
    item,
    createRollbackStateRecord(binding, state),
  )
  return state
}

/**
 * Synchronously detaches and correlates one v2 terminal-root condition input.
 *
 * @param input - Candidate measured table, admission, and terminal root.
 * @returns Strict narrow durable-row binding and immutable root.
 */
function prepareRolledBackRootV2ConditionCheckInput(
  input: unknown,
): PreparedRolledBackRootV2ConditionCheckInput {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'configurationHash',
    'executionRun',
    'root',
    'stateTable',
  ], 'INVALID_ARGUMENT')
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash', 'INVALID_ARGUMENT'),
    'INVALID_ARGUMENT',
  )
  const stateTable = detachRolledBackRootV2StateTable(
    readOwn(record, 'stateTable', 'INVALID_ARGUMENT'),
  )
  const executionRun = detachRolledBackRootV2ExecutionRun(
    readOwn(record, 'executionRun', 'INVALID_ARGUMENT'),
  )
  const root = detachRolledBackRootV2(
    readOwn(record, 'root', 'INVALID_ARGUMENT'),
  )
  // Intentionally discard the condition: its strict builder validates admission.
  createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
    stateTable,
    configurationHash,
    executionRun,
  })
  const binding: RolledBackRootV2RecordBinding = {
    stateTable,
    configurationHash,
    executionRun,
    bindingDigest:
      createWorkspaceSearchMigrationRollbackConflictRecordKeys({
        stateTableId: stateTable.tableId,
        configurationHash,
        runId: executionRun.runId,
        executionRunDigest: executionRun.executionRunDigest,
      }).bindingDigest,
  }
  requireRolledBackRootV2RecordBinding(
    binding,
    root,
    'INVALID_ARGUMENT',
  )
  return { binding, root }
}

/**
 * Detaches one migration-state identity used for v2 root addressing.
 *
 * @param value - Candidate measured migration-state table.
 * @returns Detached minimally narrowed table identity.
 */
function detachRolledBackRootV2StateTable(
  value: unknown,
): MigrationTableIdentity {
  if (!isMigrationStateTableIdentityCandidate(value)) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  let detached: unknown
  try {
    detached = structuredClone(value)
  } catch {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  if (!isMigrationStateTableIdentityCandidate(detached)) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return detached
}

/**
 * Detects the data fields required by immutable state-row addressing.
 *
 * @param value - Candidate measured table identity.
 * @returns Whether it is a descriptor-safe migration-state table.
 */
function isMigrationStateTableIdentityCandidate(
  value: unknown,
): value is MigrationTableIdentity {
  if (!isOrdinaryObject(value)) return false
  const role = Object.getOwnPropertyDescriptor(value, 'role')
  const tableName = Object.getOwnPropertyDescriptor(value, 'tableName')
  const tableId = Object.getOwnPropertyDescriptor(value, 'tableId')
  return role?.value === 'migration-state' &&
    typeof tableName?.value === 'string' &&
    tableName.value.length > 0 &&
    typeof tableId?.value === 'string' &&
    tableId.value.length > 0
}

/**
 * Detaches one immutable execution admission through its canonical codec.
 *
 * @param value - Candidate immutable admission.
 * @returns Strict detached admission.
 */
function detachRolledBackRootV2ExecutionRun(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  const candidate = requireExecutionRun(value)
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(candidate),
  )
}

/**
 * Detaches one immutable v2 terminal root through its canonical codec.
 *
 * @param value - Candidate terminal root.
 * @returns Strict detached rolled-back root.
 */
function detachRolledBackRootV2(
  value: unknown,
): WorkspaceSearchMigrationRolledBackRootV2 {
  if (!isRolledBackRootV2Candidate(value)) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return parseWorkspaceSearchMigrationRolledBackRootV2(
    serializeWorkspaceSearchMigrationRolledBackRootV2(value),
  )
}

/**
 * Minimally narrows a v2 terminal root for its strict codec.
 *
 * @param value - Candidate runtime root.
 * @returns Whether the strict v2 root codec may inspect it.
 */
function isRolledBackRootV2Candidate(
  value: unknown,
): value is WorkspaceSearchMigrationRolledBackRootV2 {
  return isOrdinaryObject(value)
}

/**
 * Creates the complete immutable v2 rolled-back root DynamoDB row.
 *
 * @param binding - Exact static partial-start binding.
 * @param root - Strict immutable v2 terminal root.
 * @returns Complete bounded low-level row.
 */
function createRolledBackRootRecord(
  binding: RolledBackRootV2RecordBinding,
  root: WorkspaceSearchMigrationRolledBackRootV2,
): Readonly<Record<string, AttributeValue>> {
  requireRolledBackRootV2RecordBinding(
    binding,
    root,
    'INVALID_STATE',
  )
  const item = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: createRolledBackRootRecordKey(binding) },
    recordVersion: { N: String(partialRollbackRecordVersion) },
    kind: { S: rolledBackRootRecordKind },
    stateTableId: { S: binding.stateTable.tableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.executionRun.runId },
    executionRunDigest: {
      S: binding.executionRun.executionRunDigest,
    },
    originDigest: { S: root.originDigest },
    startRootDigest: { S: root.startRootDigest },
    terminalStateDigest: { S: root.terminalStateDigest },
    rootDigest: { S: root.rootDigest },
    rootBytes: {
      B: serializeWorkspaceSearchMigrationRolledBackRootV2(root),
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses one immutable v2 rolled-back root DynamoDB row.
 *
 * @param binding - Exact static partial-start binding.
 * @param value - Untrusted low-level row.
 * @returns Strict detached v2 terminal root.
 */
function parseRolledBackRootRecord(
  binding: PartialRollbackStartBinding,
  value: unknown,
): WorkspaceSearchMigrationRolledBackRootV2 {
  const item = cloneLowLevelMap(value, 'INVALID_STATE')
  requireExactAttributeKeys(
    item,
    rolledBackRootRecordAttributeNames,
    'INVALID_STATE',
  )
  requireCommonRecordBinding(
    binding,
    item,
    rolledBackRootRecordKind,
    createRolledBackRootRecordKey(binding),
  )
  const root = parseWorkspaceSearchMigrationRolledBackRootV2(
    readBinaryAttribute(item, 'rootBytes'),
  )
  if (
    readDigestAttribute(item, 'rootDigest') !==
      root.rootDigest ||
    readDigestAttribute(item, 'originDigest') !==
      root.originDigest ||
    readDigestAttribute(item, 'startRootDigest') !==
      root.startRootDigest ||
    readDigestAttribute(item, 'terminalStateDigest') !==
      root.terminalStateDigest
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  requireRolledBackRootBinding(binding, root)
  requireAttributeMapsEqual(
    item,
    createRolledBackRootRecord(binding, root),
  )
  return root
}

/**
 * Builds the fixed thirteen-item committed-prefix rollback transaction.
 *
 * @param input - Exact authority, predecessor, and v2 start root.
 * @returns Adapter-owned idempotent transaction command.
 */
function createPartialRollbackStartTransactionCommand(
  input: {
    /** Exact static partial-start binding. */
    readonly binding: PartialRollbackStartBinding
    /** Fresh current authority. */
    readonly currentAuthority:
      WorkspaceSearchMigrationPrePlanAuthority
    /** Exact apply predecessor selected before seal creation. */
    readonly predecessor:
      WorkspaceSearchMigrationApplyPredecessorAwsProjection
    /** Final adapter-owned transaction time. */
    readonly commitAt: Date
    /** Exact immutable v2 start root. */
    readonly startRoot:
      WorkspaceSearchMigrationRollbackStartRootV2
  },
): TransactWriteItemsCommand {
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      authority: input.currentAuthority,
      commitAt: input.commitAt,
    })
  const verificationKeys =
    createFullVerificationConflictRecordKeys(input.binding)
  const items: TransactWriteItem[] = [
    ...authorityChecks,
    createWorkspaceSearchWriterFenceClosedConditionCheck(
      input.binding.closedWriterFenceRecord,
      input.binding.writerFence,
    ),
    createWorkspaceSearchMigrationPlanningAdmittedExecutionBoundaryConditionCheck(
      {
        stateTable: input.binding.stateTable,
        configurationHash: input.binding.configurationHash,
        boundary: input.binding.executionBoundary,
      },
    ),
    createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      authority: input.binding.sealedPlanningAuthority,
    }),
    createWorkspaceSearchMigrationExecutionRunAdmissionConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      executionRun: input.binding.executionRun,
    }),
    input.binding.applyPredecessor
      .createExecutionStateConditionCheck(
        input.predecessor.predecessor,
      ),
    createWorkspaceSearchMigrationAppliedRootAbsentConditionCheck({
      stateTable: input.binding.stateTable,
      configurationHash: input.binding.configurationHash,
      executionRun: input.binding.executionRun,
    }),
    createAbsentConditionCheck(
      input.binding.stateTable.tableName,
      createStateKey(verificationKeys.state),
    ),
    createAbsentConditionCheck(
      input.binding.stateTable.tableName,
      createStateKey(verificationKeys.root),
    ),
    createAbsentPut(
      input.binding.stateTable.tableName,
      createRollbackStartRecord(
        input.binding,
        input.startRoot,
      ),
    ),
    createAbsentPut(
      input.binding.stateTable.tableName,
      createRollbackStateRecord(
        input.binding,
        input.startRoot.initialState,
      ),
    ),
  ]
  if (
    items.length !==
      workspaceSearchMigrationPartialRollbackStartTransactionIndex
        .count
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken: createMigrationDigest({
      kind:
        'workspace-search-migration-partial-rollback-start-transaction',
      version: partialRollbackRecordVersion,
      startRootDigest: input.startRoot.startRootDigest,
    }).slice(0, 36),
    TransactItems: items,
    ReturnConsumedCapacity: 'NONE',
    ReturnItemCollectionMetrics: 'NONE',
  })
}

/**
 * Creates the deterministic full-verification conflict keys.
 *
 * @param binding - Exact static partial-start binding.
 * @returns Mutable verification-state and immutable verified-root keys.
 */
function createFullVerificationConflictRecordKeys(
  binding: PartialRollbackStartBinding,
): {
  /** Deterministic mutable verification-state key. */
  readonly state: string
  /** Deterministic immutable verified-root key. */
  readonly root: string
} {
  return createWorkspaceSearchMigrationFullVerificationConflictRecordKeys({
    stateTableId: binding.stateTable.tableId,
    configurationHash: binding.configurationHash,
    runId: binding.executionRun.runId,
    executionRunDigest:
      binding.executionRun.executionRunDigest,
    sealedPlanningAuthorityDigest:
      binding.sealedPlanningAuthority.authorityDigest,
  })
}

/**
 * Creates the immutable shared rollback-start record key.
 *
 * @param binding - Exact static partial-start binding.
 * @returns Existing rollback-start/v1 shared sentinel key.
 */
function createRollbackStartRecordKey(
  binding: PartialRollbackStartBinding,
): string {
  return createWorkspaceSearchMigrationRollbackStartRecordKey(
    binding.bindingDigest,
  )
}

/**
 * Creates the v2-only mutable rollback-state record key.
 *
 * @param binding - Exact static partial-start binding.
 * @returns Stable rollback-state/v2 key.
 */
function createRollbackStateRecordKey(
  binding: PartialRollbackStartBinding,
): string {
  return createWorkspaceSearchMigrationRollbackStateV2RecordKey(
    binding.bindingDigest,
  )
}

/**
 * Creates the v2-only immutable rolled-back root record key.
 *
 * @param binding - Exact static partial-start binding.
 * @returns Stable rolled-back-root/v2 key.
 */
function createRolledBackRootRecordKey(
  binding: Pick<RolledBackRootV2RecordBinding, 'bindingDigest'>,
): string {
  return createWorkspaceSearchMigrationRolledBackRootV2RecordKey(
    binding.bindingDigest,
  )
}

/**
 * Creates one strongly consistent migration-state row read.
 *
 * @param binding - Exact static partial-start binding.
 * @param recordKey - Exact deterministic record key.
 * @returns Adapter-owned strong-read command.
 */
function createStrongStateReadCommand(
  binding: PartialRollbackStartBinding,
  recordKey: string,
): GetItemCommand {
  return new GetItemCommand({
    TableName: binding.stateTable.tableName,
    ConsistentRead: true,
    Key: createStateKey(recordKey),
  })
}

/**
 * Creates one migration-state compound key.
 *
 * @param recordKey - Exact deterministic sort-key value.
 * @returns Detached low-level key.
 */
function createStateKey(
  recordKey: string,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
  }
}

/**
 * Creates one deterministic absent-row condition.
 *
 * @param tableName - Exact measured state-table name.
 * @param key - Exact compound migration-state key.
 * @returns Absent-item ConditionCheck.
 */
function createAbsentConditionCheck(
  tableName: string,
  key: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: cloneLowLevelMap(key, 'INVALID_ARGUMENT'),
      ConditionExpression:
        'attribute_not_exists(#migrationId) AND ' +
        'attribute_not_exists(#recordKey)',
      ExpressionAttributeNames: {
        '#migrationId': 'migrationId',
        '#recordKey': 'recordKey',
      },
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates one deterministic absent-row Put.
 *
 * @param tableName - Exact measured state-table name.
 * @param item - Complete adapter-owned row.
 * @returns Absent-item conditional Put.
 */
function createAbsentPut(
  tableName: string,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  validateDynamoDbItemSize(item)
  return {
    Put: {
      TableName: tableName,
      Item: cloneLowLevelMap(item, 'INVALID_STATE'),
      ConditionExpression:
        'attribute_not_exists(#migrationId) AND ' +
        'attribute_not_exists(#recordKey)',
      ExpressionAttributeNames: {
        '#migrationId': 'migrationId',
        '#recordKey': 'recordKey',
      },
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates one complete controlled-row equality ConditionCheck.
 *
 * @param tableName - Exact measured state table name.
 * @param item - Complete strict predecessor row.
 * @returns Full-controlled-row ConditionCheck.
 */
function createFullRowConditionCheck(
  tableName: string,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  const fields = createFullRowConditionFields(item)
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: readItemKey(item),
      ...fields,
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates one exact-predecessor mutable-state CAS Put.
 *
 * @param tableName - Exact measured state table name.
 * @param predecessor - Complete strict predecessor row.
 * @param successor - Complete strict successor row.
 * @returns Full-row predecessor CAS Put.
 */
function createExactPredecessorPut(
  tableName: string,
  predecessor: Readonly<Record<string, AttributeValue>>,
  successor: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  const predecessorKey = readItemKey(predecessor)
  const successorKey = readItemKey(successor)
  requireAttributeMapsEqual(predecessorKey, successorKey)
  validateDynamoDbItemSize(successor)
  return {
    Put: {
      TableName: tableName,
      Item: cloneLowLevelMap(successor, 'INVALID_STATE'),
      ...createFullRowConditionFields(predecessor),
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Creates complete non-key equality expressions for one controlled row.
 *
 * @param item - Complete strict adapter-owned row.
 * @returns Exact condition expression operands.
 */
function createFullRowConditionFields(
  item: Readonly<Record<string, AttributeValue>>,
): {
  /** Exact conjunction of every controlled non-key field. */
  readonly ConditionExpression: string
  /** Attribute-name substitutions. */
  readonly ExpressionAttributeNames:
    Readonly<Record<string, string>>
  /** Attribute-value substitutions. */
  readonly ExpressionAttributeValues:
    Readonly<Record<string, AttributeValue>>
} {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const clauses: string[] = []
  let index = 0
  for (const [name, value] of Object.entries(item)) {
    if (name === 'migrationId' || name === 'recordKey') continue
    const nameToken = `#field${index}`
    const valueToken = `:value${index}`
    names[nameToken] = name
    values[valueToken] = value
    clauses.push(`${nameToken} = ${valueToken}`)
    index += 1
  }
  if (clauses.length === 0) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  return {
    ConditionExpression: clauses.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues:
      cloneLowLevelMap(values, 'INVALID_STATE'),
  }
}

/**
 * Reads the compound key from a complete migration-state row.
 *
 * @param item - Complete adapter-owned row.
 * @returns Detached exact compound key.
 */
function readItemKey(
  item: Readonly<Record<string, AttributeValue>>,
): Readonly<Record<string, AttributeValue>> {
  const migrationId = item.migrationId
  const recordKey = item.recordKey
  if (migrationId === undefined || recordKey === undefined) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  return cloneLowLevelMap(
    { migrationId, recordKey },
    'INVALID_STATE',
  )
}

/**
 * Requires one start root to share the exact admitted static binding.
 *
 * @param binding - Exact static partial-start binding.
 * @param root - Candidate strict v2 start root.
 */
function requireStartRootBinding(
  binding: PartialRollbackStartBinding,
  root: WorkspaceSearchMigrationRollbackStartRootV2,
): void {
  if (
    root.persistenceVersion !== partialRollbackRecordVersion ||
    root.configurationHash !== binding.configurationHash ||
    root.runId !== binding.executionRun.runId ||
    root.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    root.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest ||
    root.origin.planDigest !==
      binding.sealedPlanningAuthority.planDigest ||
    root.origin.planOperationCount !==
      binding.sealedPlanningAuthority.planOperationCount ||
    root.origin.planSealReference.objectKey !==
      binding.sealedPlanningAuthority.planSealReference.objectKey ||
    root.origin.planSealReference.versionId !==
      binding.sealedPlanningAuthority.planSealReference.versionId ||
    root.origin.planSealReference.contentDigest !==
      binding.sealedPlanningAuthority.planSealReference.contentDigest ||
    root.origin.planSealReference.byteLength !==
      binding.sealedPlanningAuthority.planSealReference.byteLength ||
    root.origin.planSealReference.retainUntil !==
      binding.sealedPlanningAuthority.planSealReference.retainUntil
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      root.tableIds[role] !==
        binding.executionRun.binding.tableIds[role]
    ) {
      return failPartialRollbackStart('INVALID_STATE')
    }
  }
}

/**
 * Requires one lifecycle state to share the exact admitted static binding.
 *
 * @param binding - Exact static partial-start binding.
 * @param state - Candidate strict v2 rollback state.
 */
function requireStateBinding(
  binding: PartialRollbackStartBinding,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): void {
  if (
    state.persistenceVersion !== partialRollbackRecordVersion ||
    state.configurationHash !== binding.configurationHash ||
    state.runId !== binding.executionRun.runId ||
    state.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    state.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthority.authorityDigest
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      state.tableIds[role] !==
        binding.executionRun.binding.tableIds[role]
    ) {
      return failPartialRollbackStart('INVALID_STATE')
    }
  }
}

/**
 * Requires one terminal root to share the exact admitted static binding.
 *
 * @param binding - Exact static partial-start binding.
 * @param root - Candidate strict v2 rolled-back root.
 */
function requireRolledBackRootBinding(
  binding: PartialRollbackStartBinding,
  root: WorkspaceSearchMigrationRolledBackRootV2,
): void {
  requireRolledBackRootV2RecordBinding(binding, root, 'INVALID_STATE')
}

/**
 * Requires one v2 terminal root to match its immutable row namespace.
 *
 * @param binding - Narrow measured root-row binding.
 * @param root - Candidate strict v2 terminal root.
 * @param code - Stable failure classification for the calling boundary.
 */
function requireRolledBackRootV2RecordBinding(
  binding: RolledBackRootV2RecordBinding,
  root: WorkspaceSearchMigrationRolledBackRootV2,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  if (
    root.persistenceVersion !== partialRollbackRecordVersion ||
    root.configurationHash !== binding.configurationHash ||
    root.runId !== binding.executionRun.runId ||
    root.executionRunDigest !==
      binding.executionRun.executionRunDigest ||
    root.sealedPlanningAuthorityDigest !==
      binding.executionRun.binding.sealedPlanningAuthorityDigest ||
    root.terminalState.status !== 'rolled-back' ||
    root.tableIds['migration-state'] !== binding.stateTable.tableId
  ) {
    return failPartialRollbackStart(code)
  }
  for (const role of workspaceSearchWriterFenceTableRoles) {
    if (
      root.tableIds[role] !==
        binding.executionRun.binding.tableIds[role]
    ) {
      return failPartialRollbackStart(code)
    }
  }
}

/**
 * Requires an atomically written start root and exact initial state.
 *
 * @param binding - Exact static partial-start binding.
 * @param root - Strict immutable v2 start root.
 * @param state - Strict initial v2 rollback state.
 */
function requireStartAndInitialState(
  binding: PartialRollbackStartBinding,
  root: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): void {
  requireStartRootBinding(binding, root)
  requireStateBinding(binding, state)
  if (
    state.startRootDigest !== root.startRootDigest ||
    state.originDigest !== root.originDigest ||
    state.predecessorDigest !== root.originDigest ||
    state.stateDigest !== root.initialStateDigest ||
    state.stateDigest !== root.initialState.stateDigest ||
    state.runStateDigest !== root.initialRunStateDigest
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  const rootStateBytes =
    serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
      root.initialState,
    )
  const stateBytes =
    serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
      state,
    )
  if (
    Buffer.compare(
      Buffer.from(rootStateBytes),
      Buffer.from(stateBytes),
    ) !== 0
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Requires one current lifecycle state to descend from the exact start root.
 *
 * @param binding - Exact static partial-start binding.
 * @param root - Strict immutable v2 start root.
 * @param state - Strict current v2 rollback lifecycle state.
 */
function requireStartAndLifecycleState(
  binding: PartialRollbackStartBinding,
  root: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): void {
  requireStartAndInitialState(
    binding,
    root,
    root.initialState,
  )
  requireStateBinding(binding, state)
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
    root.currentAuthority,
    state.currentAuthority,
  )
  const rollingRevision =
    root.predecessorRevision + 1 + state.restored
  const expectedRevision = state.status === 'rolled-back'
    ? rollingRevision + 1
    : rollingRevision
  if (
    !Number.isSafeInteger(rollingRevision) ||
    !Number.isSafeInteger(expectedRevision) ||
    state.originDigest !== root.originDigest ||
    state.startRootDigest !== root.startRootDigest ||
    state.upperBoundSequence !== root.originalJournalSequence ||
    state.revision !== expectedRevision ||
    (
      state.status === 'rolling-back' &&
      state.restored === 0 &&
      state.stateDigest !== root.initialState.stateDigest
    ) ||
    (
      (state.status !== 'rolling-back' || state.restored !== 0) &&
      state.predecessorKind !== 'rollback-state'
    )
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Requires a terminal root to exactly publish the current terminal state.
 *
 * @param binding - Exact static partial-start binding.
 * @param startRoot - Strict immutable v2 start root.
 * @param state - Strict current terminal state.
 * @param rolledBackRoot - Strict immutable v2 terminal root.
 */
function requireTerminalRootMatchesLifecycle(
  binding: PartialRollbackStartBinding,
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
  rolledBackRoot: WorkspaceSearchMigrationRolledBackRootV2,
): void {
  requireRolledBackRootBinding(binding, rolledBackRoot)
  if (
    state.status !== 'rolled-back' ||
    rolledBackRoot.originDigest !== startRoot.originDigest ||
    rolledBackRoot.startRootDigest !== startRoot.startRootDigest ||
    rolledBackRoot.rollbackStartedAt !== startRoot.startedAt ||
    rolledBackRoot.terminalStateDigest !== state.stateDigest
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  const stateBytes =
    serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
      state,
    )
  const terminalStateBytes =
    serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
      rolledBackRoot.terminalState,
    )
  if (
    Buffer.compare(
      Buffer.from(stateBytes),
      Buffer.from(terminalStateBytes),
    ) !== 0
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Requires a direct rolling or terminal lifecycle-state successor.
 *
 * @param binding - Exact static partial-start binding.
 * @param predecessor - Exact current rolling state.
 * @param successor - Candidate direct rolling or terminal successor.
 */
function requireDirectRollbackStateTransition(
  binding: PartialRollbackStartBinding,
  predecessor: WorkspaceSearchMigrationRollbackPersistenceStateV2,
  successor: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): void {
  requireStateBinding(binding, predecessor)
  requireStateBinding(binding, successor)
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
    predecessor.currentAuthority,
    successor.currentAuthority,
  )
  const commonInvalid =
    predecessor.status !== 'rolling-back' ||
    successor.predecessorKind !== 'rollback-state' ||
    successor.predecessorDigest !== predecessor.stateDigest ||
    successor.revision !== predecessor.revision + 1 ||
    successor.originDigest !== predecessor.originDigest ||
    successor.startRootDigest !== predecessor.startRootDigest ||
    successor.upperBoundSequence !==
      predecessor.upperBoundSequence
  if (commonInvalid) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  if (successor.status === 'rolling-back') {
    if (
      predecessor.nextSequence < 1 ||
      successor.nextSequence !== predecessor.nextSequence - 1 ||
      successor.restored !== predecessor.restored + 1
    ) {
      return failPartialRollbackStart('INVALID_STATE')
    }
    return
  }
  if (
    predecessor.nextSequence !== 0 ||
    successor.nextSequence !== predecessor.nextSequence ||
    successor.expectedHeadDigest !==
      predecessor.expectedHeadDigest ||
    successor.restored !== predecessor.restored ||
    successor.lastRollbackReceiptDigest !==
      predecessor.lastRollbackReceiptDigest
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Requires one existing start to identify the caller's exact begin command.
 *
 * @param startRoot - Existing strict immutable v2 start root.
 * @param command - Detached caller command.
 */
function requireStartMatchesCommand(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  command: PreparedPartialRollbackStartCommand,
): void {
  if (
    startRoot.predecessorRevision !== command.expectedRevision ||
    startRoot.currentAuthority.ownerId !==
      command.authority.lease.ownerId ||
    startRoot.currentAuthority.fenceToken !==
      command.authority.lease.fenceToken ||
    startRoot.currentAuthority
        .maintenanceEvidencePointerRevision !==
      command.authority.maintenanceEvidencePointerRevision ||
    startRoot.currentAuthority
        .maintenanceEvidenceReceiptDigest !==
      command.authority.maintenanceEvidenceReceiptDigest ||
    startRoot.runId !== command.authority.lease.runId
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Requires a committed winner to preserve every time-independent input.
 *
 * Concurrent attempts can choose different seal and transaction timestamps,
 * immutable-object versions, and resulting self digests. The exact stored
 * artifact is verified separately through the committed winner's reference.
 *
 * @param command - Detached caller command.
 * @param intended - Locally constructed attempted root.
 * @param committed - Strongly read committed root.
 */
function requireStartIsLogicalWinner(
  command: PreparedPartialRollbackStartCommand,
  intended: WorkspaceSearchMigrationRollbackStartRootV2,
  committed: WorkspaceSearchMigrationRollbackStartRootV2,
): void {
  requireStartMatchesCommand(committed, command)
  if (
    committed.predecessorDigest !== intended.predecessorDigest ||
    committed.predecessorRunStateDigest !==
      intended.predecessorRunStateDigest ||
    committed.originalJournalSequence !==
      intended.originalJournalSequence ||
    committed.originalJournalHeadDigest !==
      intended.originalJournalHeadDigest ||
    committed.executionRunDigest !== intended.executionRunDigest ||
    committed.sealedPlanningAuthorityDigest !==
      intended.sealedPlanningAuthorityDigest ||
    committed.origin.planDigest !== intended.origin.planDigest ||
    committed.origin.planOperationCount !==
      intended.origin.planOperationCount
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Requires the selected apply predecessor to be applying at caller revision.
 *
 * @param projection - Correlated apply predecessor and run state.
 * @param command - Detached caller command.
 */
function requireApplyPredecessorRevision(
  projection: WorkspaceSearchMigrationApplyPredecessorAwsProjection,
  command: PreparedPartialRollbackStartCommand,
): void {
  if (
    projection.runState.status !== 'applying' ||
    projection.runState.revision !== command.expectedRevision
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Requires resolved authority to match the complete exact caller claim.
 *
 * @param claim - Detached caller lease, pointer, and receipt identity.
 * @param authority - Fresh durable authority.
 */
function requireAuthorityClaimMatchesAuthority(
  claim: WorkspaceSearchMigrationRollbackAuthorityClaim,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): void {
  if (
    authority.lease.runId !== claim.lease.runId ||
    authority.lease.ownerId !== claim.lease.ownerId ||
    authority.lease.fenceToken !== claim.lease.fenceToken
  ) {
    return failPartialRollbackStart('LEASE_LOST')
  }
  if (
    authority.maintenanceEvidencePointerRevision !==
      claim.maintenanceEvidencePointerRevision ||
    authority.maintenanceEvidenceReceiptDigest !==
      claim.maintenanceEvidenceReceiptDigest
  ) {
    return failPartialRollbackStart(
      'INVALID_MAINTENANCE_EVIDENCE',
    )
  }
}

/**
 * Detaches one caller command before any asynchronous boundary.
 *
 * @param input - Candidate public command.
 * @returns Exact detached revision and current authority claim.
 */
function preparePartialRollbackStartCommand(
  input: WorkspaceSearchMigrationRollbackCommandInput,
): PreparedPartialRollbackStartCommand {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'authority',
    'expectedRevision',
  ], 'INVALID_ARGUMENT')
  return {
    expectedRevision: readPositiveSafeInteger(
      readOwn(record, 'expectedRevision', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
    authority: readRollbackAuthorityClaim(
      readOwn(record, 'authority', 'INVALID_ARGUMENT'),
    ),
  }
}

/**
 * Detaches one exact current lease, pointer, and receipt claim.
 *
 * @param value - Candidate current authority claim.
 * @returns Strict detached claim.
 */
function readRollbackAuthorityClaim(
  value: unknown,
): WorkspaceSearchMigrationRollbackAuthorityClaim {
  const record = requirePlainRecord(value, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
  ], 'INVALID_ARGUMENT')
  return {
    lease: readLeaseClaim(
      readOwn(record, 'lease', 'INVALID_ARGUMENT'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(
        record,
        'maintenanceEvidenceReceiptDigest',
        'INVALID_ARGUMENT',
      ),
      'INVALID_ARGUMENT',
    ),
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(
        record,
        'maintenanceEvidencePointerRevision',
        'INVALID_ARGUMENT',
      ),
      'INVALID_ARGUMENT',
    ),
  }
}

/**
 * Reads one exact active lease identity.
 *
 * @param value - Candidate lease claim.
 * @returns Detached exact claim.
 */
function readLeaseClaim(
  value: unknown,
): WorkspaceSearchMigrationLeaseClaim {
  const record = requirePlainRecord(value, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'fenceToken',
    'ownerId',
    'runId',
  ], 'INVALID_ARGUMENT')
  return {
    runId: readIdentifier(
      readOwn(record, 'runId', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
    ownerId: readIdentifier(
      readOwn(record, 'ownerId', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken', 'INVALID_ARGUMENT'),
      'INVALID_ARGUMENT',
    ),
  }
}

/**
 * Captures one receiver-independent Date-returning clock behind a strict
 * runtime check.
 *
 * @param value - Candidate trusted clock that does not depend on `this`.
 * @returns Captured detached clock.
 */
function snapshotClock(value: unknown): () => Date {
  if (
    typeof value !== 'function' ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return () => {
    const candidate: unknown = Reflect.apply(value, undefined, [])
    if (
      nodeUtilTypes.isProxy(candidate) ||
      !(candidate instanceof Date)
    ) {
      return failPartialRollbackStart('INVALID_STATE')
    }
    let milliseconds: number
    try {
      milliseconds = Date.prototype.getTime.call(candidate)
    } catch {
      return failPartialRollbackStart('INVALID_STATE')
    }
    if (!Number.isSafeInteger(milliseconds)) {
      return failPartialRollbackStart('INVALID_STATE')
    }
    return new Date(milliseconds)
  }
}

/**
 * Reads one fresh trusted adapter time.
 *
 * @param clock - Captured trusted clock.
 * @returns Fresh detached valid Date.
 */
function readClock(clock: () => Date): Date {
  return clock()
}

/**
 * Requires one non-Proxy dependency receiver.
 *
 * @param value - Candidate dependency object.
 * @returns Exact object receiver.
 */
function requireDependencyObject(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Reads one data-method through a bounded prototype chain.
 *
 * @param receiver - Exact non-Proxy receiver.
 * @param key - Required method name.
 * @returns Exact callable data method.
 */
function readCallableMethod(
  receiver: object,
  key: string,
): unknown {
  let current: object | null = receiver
  let depth = 0
  while (current !== null && depth < 16) {
    if (nodeUtilTypes.isProxy(current)) {
      return failPartialRollbackStart('INVALID_ARGUMENT')
    }
    const descriptor =
      Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' ||
        nodeUtilTypes.isProxy(descriptor.value)
      ) {
        return failPartialRollbackStart('INVALID_ARGUMENT')
      }
      return descriptor.value
    }
    current = Object.getPrototypeOf(current)
    depth += 1
  }
  return failPartialRollbackStart('INVALID_ARGUMENT')
}

/**
 * Narrows one dependency method.
 *
 * @param value - Candidate callable.
 * @returns Whether the value is a non-Proxy function.
 */
function isCallable<Callable extends (...input: never[]) => unknown>(
  value: unknown,
): value is Callable {
  return typeof value === 'function' && !nodeUtilTypes.isProxy(value)
}

/**
 * Structurally narrows a planning execution boundary.
 *
 * @param value - Candidate boundary.
 * @returns Minimally narrowed boundary for the strict codec.
 */
function requireExecutionBoundary(
  value: unknown,
): WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  if (!isExecutionBoundaryCandidate(value)) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Structurally narrows a sealed planning authority.
 *
 * @param value - Candidate authority.
 * @returns Minimally narrowed authority for the strict codec.
 */
function requireSealedPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (!isSealedPlanningAuthorityCandidate(value)) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Structurally narrows an immutable execution admission.
 *
 * @param value - Candidate execution run.
 * @returns Minimally narrowed execution run for the strict codec.
 */
function requireExecutionRun(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRunCandidate(value)) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Structurally narrows one exact closed writer-fence row.
 *
 * @param value - Candidate closed row.
 * @returns Minimally narrowed closed row for the strict reader.
 */
function requireClosedWriterFenceRecord(
  value: unknown,
): WorkspaceSearchWriterFenceClosedRecord {
  if (!isClosedWriterFenceRecordCandidate(value)) {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Minimally narrows a candidate admitted execution boundary.
 *
 * @param value - Candidate runtime value.
 * @returns Whether a strict boundary codec may inspect it.
 */
function isExecutionBoundaryCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationPlanningAdmittedExecutionBoundary {
  return isOrdinaryObject(value)
}

/**
 * Minimally narrows a candidate sealed planning authority.
 *
 * @param value - Candidate runtime value.
 * @returns Whether a strict authority codec may inspect it.
 */
function isSealedPlanningAuthorityCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return isOrdinaryObject(value)
}

/**
 * Minimally narrows a candidate immutable execution admission.
 *
 * @param value - Candidate runtime value.
 * @returns Whether a strict execution-run codec may inspect it.
 */
function isExecutionRunCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  return isOrdinaryObject(value)
}

/**
 * Minimally narrows a candidate closed writer-fence row.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the strict writer-fence reader may inspect it.
 */
function isClosedWriterFenceRecordCandidate(
  value: unknown,
): value is WorkspaceSearchWriterFenceClosedRecord {
  return isOrdinaryObject(value)
}

/**
 * Narrows one non-Proxy non-array object.
 *
 * @param value - Candidate runtime value.
 * @returns Whether it is safe for a strict codec to inspect.
 */
function isOrdinaryObject(value: unknown): value is object {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Losslessly detaches one low-level DynamoDB attribute map.
 *
 * @param value - Candidate item or key.
 * @param code - Stable failure classification.
 * @returns Detached validated attribute map.
 */
function cloneLowLevelMap(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, AttributeValue>> {
  try {
    return decodeAttributeMap(encodeUnknownAttributeMap(value))
  } catch {
    return failPartialRollbackStart(code)
  }
}

/**
 * Reads one optional low-level GetItem result safely.
 *
 * @param output - Raw low-level response.
 * @returns Raw item value or undefined.
 */
function readOutputItem(output: unknown): unknown {
  if (!isOrdinaryObject(output)) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  if (
    Reflect.ownKeys(output).some(
      (key) => typeof key === 'symbol',
    )
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  const descriptor =
    Object.getOwnPropertyDescriptor(output, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Requires one item to contain exactly its controlled attribute set.
 *
 * @param item - Candidate strict low-level item.
 * @param expectedKeys - Complete controlled field names.
 * @param code - Stable failure classification.
 */
function requireExactAttributeKeys(
  item: Readonly<Record<string, AttributeValue>>,
  expectedKeys: readonly string[],
  code: WorkspaceSearchMigrationFailureCode,
): void {
  const actual = Object.keys(item).sort(compareUtf8Ordinal)
  const expected = [...expectedKeys].sort(compareUtf8Ordinal)
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failPartialRollbackStart(code)
  }
}

/**
 * Requires exact byte-level equality of two low-level attribute maps.
 *
 * @param left - First strict attribute map.
 * @param right - Second strict attribute map.
 */
function requireAttributeMapsEqual(
  left: Readonly<Record<string, AttributeValue>>,
  right: Readonly<Record<string, AttributeValue>>,
): void {
  try {
    if (
      createMigrationDigest(encodeUnknownAttributeMap(left)) !==
        createMigrationDigest(encodeUnknownAttributeMap(right))
    ) {
      return failPartialRollbackStart('INVALID_STATE')
    }
  } catch {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Requires common adapter-owned record binding fields.
 *
 * @param binding - Exact static partial-start binding.
 * @param item - Strict low-level row.
 * @param kind - Exact record-kind discriminator.
 * @param recordKey - Exact deterministic record key.
 */
function requireCommonRecordBinding(
  binding: PartialRollbackStartBinding,
  item: Readonly<Record<string, AttributeValue>>,
  kind: string,
  recordKey: string,
): void {
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !== recordKey ||
    readPositiveSafeIntegerAttribute(item, 'recordVersion') !==
      partialRollbackRecordVersion ||
    readStringAttribute(item, 'kind') !== kind ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTable.tableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !==
      binding.executionRun.runId ||
    readStringAttribute(item, 'executionRunDigest') !==
      binding.executionRun.executionRunDigest
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
}

/**
 * Reads one exact string AttributeValue.
 *
 * @param item - Strict low-level item.
 * @param name - Required field name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(attribute, 'INVALID_STATE')
  requireExactKeys(record, ['S'], 'INVALID_STATE')
  const value = readOwn(record, 'S', 'INVALID_STATE')
  return typeof value === 'string'
    ? value
    : failPartialRollbackStart('INVALID_STATE')
}

/**
 * Reads one exact lowercase digest AttributeValue.
 *
 * @param item - Strict low-level item.
 * @param name - Required field name.
 * @returns Exact lowercase digest.
 */
function readDigestAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  return readDigest(
    readStringAttribute(item, name),
    'INVALID_STATE',
  )
}

/**
 * Reads one exact positive integer AttributeValue.
 *
 * @param item - Strict low-level item.
 * @param name - Required field name.
 * @returns Exact positive safe integer.
 */
function readPositiveSafeIntegerAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(attribute, 'INVALID_STATE')
  requireExactKeys(record, ['N'], 'INVALID_STATE')
  const value = readOwn(record, 'N', 'INVALID_STATE')
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  return readPositiveSafeInteger(Number(value), 'INVALID_STATE')
}

/**
 * Reads one exact nonempty binary AttributeValue.
 *
 * @param item - Strict low-level item.
 * @param name - Required field name.
 * @returns Detached bytes.
 */
function readBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(attribute, 'INVALID_STATE')
  requireExactKeys(record, ['B'], 'INVALID_STATE')
  const value = readOwn(record, 'B', 'INVALID_STATE')
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failPartialRollbackStart('INVALID_STATE')
  }
  const bytes = new Uint8Array(value)
  return bytes.byteLength > 0
    ? bytes
    : failPartialRollbackStart('INVALID_STATE')
}

/**
 * Requires an ordinary exact-field record.
 *
 * @param value - Candidate runtime value.
 * @param code - Stable failure classification.
 * @returns Exact ordinary record.
 */
function requirePlainRecord(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return failPartialRollbackStart(code)
  }
  return value
}

/**
 * Narrows one ordinary non-Proxy string-keyed record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is an ordinary record.
 */
function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype
}

/**
 * Requires an exact enumerable own data-property set.
 *
 * @param record - Candidate ordinary record.
 * @param expectedKeys - Complete accepted field names.
 * @param code - Stable failure classification.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  code: WorkspaceSearchMigrationFailureCode,
): void {
  const actual = Reflect.ownKeys(record)
  const expected = [...expectedKeys].sort(compareUtf8Ordinal)
  if (
    actual.some((key) => typeof key === 'symbol') ||
    actual.length !== expected.length
  ) {
    return failPartialRollbackStart(code)
  }
  const actualStrings =
    Object.keys(record).sort(compareUtf8Ordinal)
  if (
    actualStrings.length !== expected.length ||
    actualStrings.some(
      (key, index) => key !== expected[index],
    )
  ) {
    return failPartialRollbackStart(code)
  }
  for (const key of expected) {
    readOwn(record, key, code)
  }
}

/**
 * Reads one enumerable own data property without invoking an accessor.
 *
 * @param value - Candidate object.
 * @param key - Required property name.
 * @param code - Stable failure classification.
 * @returns Exact stored value.
 */
function readOwn(
  value: object,
  key: PropertyKey,
  code: WorkspaceSearchMigrationFailureCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failPartialRollbackStart(code)
  }
  return descriptor.value
}

/**
 * Reads one bounded nonblank identifier.
 *
 * @param value - Candidate identifier.
 * @param code - Stable failure classification.
 * @returns Exact identifier.
 */
function readIdentifier(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value !== value.trim()
  ) {
    return failPartialRollbackStart(code)
  }
  return value
}

/**
 * Reads one exact lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param code - Stable failure classification.
 * @returns Exact digest.
 */
function readDigest(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  return isHexDigest(value)
    ? value
    : failPartialRollbackStart(code)
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @param code - Stable failure classification.
 * @returns Exact positive safe integer.
 */
function readPositiveSafeInteger(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failPartialRollbackStart(code)
  }
  return value
}

/**
 * Compares text by its UTF-8 byte order.
 *
 * @param left - First text.
 * @param right - Second text.
 * @returns Negative, zero, or positive ordering.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * Reads individually strong rows until two complete observations agree.
 *
 * @param readSnapshot - Reads one complete collection of related rows.
 * @param isSameSnapshot - Compares immutable digests.
 * @returns Latest of two consecutive equal observations.
 */
async function readCoherentPartialRollbackStartSnapshot<Value>(
  readSnapshot: () => Promise<Value>,
  isSameSnapshot: (left: Value, right: Value) => boolean,
): Promise<Value> {
  let previous = await readSnapshot()
  for (let index = 1; index < 3; index += 1) {
    const current = await readSnapshot()
    if (isSameSnapshot(previous, current)) return current
    previous = current
  }
  return failPartialRollbackStart(
    'AMBIGUOUS_OPERATION_UNRESOLVED',
  )
}

/**
 * Classifies one failed fixed-order partial rollback-start transaction.
 *
 * @param error - Raw transaction failure.
 * @returns Stable secret-free failure code.
 */
function classifyPartialRollbackStartTransactionError(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (nodeUtilTypes.isProxy(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    if (isResourceNotFoundError(error)) {
      return 'CONFIGURATION_DRIFT'
    }
    if (
      error instanceof TransactionConflictException ||
      readErrorName(error) === 'TransactionConflictException'
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (
      error instanceof TransactionCanceledException ||
      readErrorName(error) === 'TransactionCanceledException'
    ) {
      const index =
        workspaceSearchMigrationPartialRollbackStartTransactionIndex
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
      for (
        let conditionIndex = 0;
        conditionIndex < index.count;
        conditionIndex += 1
      ) {
        if (
          readCancellationReasonCode(
            error,
            conditionIndex,
          ) === 'ConditionalCheckFailed'
        ) {
          return 'INVALID_STATE'
        }
      }
      return cancellationWasTransient(error, index.count)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    if (readErrorName(error) === 'TransactionInProgressException') {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const input = createAwsClassificationInput(error)
    if (isThrottlingError(input)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return isTransientError(input)
      ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
      : 'INVALID_STATE'
  } catch {
    return 'AMBIGUOUS_OPERATION_UNRESOLVED'
  }
}

/**
 * Reads one fixed cancellation reason without invoking accessors.
 *
 * @param error - Raw transaction cancellation.
 * @param index - Zero-based fixed transaction index.
 * @returns Stable AWS reason code or undefined.
 */
function readCancellationReasonCode(
  error: unknown,
  index: number,
): string | undefined {
  try {
    if (!isOrdinaryObject(error)) return undefined
    const reasonsDescriptor =
      Object.getOwnPropertyDescriptor(error, 'CancellationReasons')
    if (
      reasonsDescriptor === undefined ||
      !Object.hasOwn(reasonsDescriptor, 'value') ||
      !Array.isArray(reasonsDescriptor.value)
    ) {
      return undefined
    }
    const reason: unknown = reasonsDescriptor.value[index]
    if (!isOrdinaryObject(reason)) return undefined
    const codeDescriptor =
      Object.getOwnPropertyDescriptor(reason, 'Code')
    const code = codeDescriptor !== undefined &&
        Object.hasOwn(codeDescriptor, 'value')
      ? codeDescriptor.value
      : undefined
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Detects an explicitly retry-safe transaction cancellation.
 *
 * @param error - Raw transaction cancellation.
 * @param count - Exact fixed transaction item count.
 * @returns Whether any reason is retry-safe infrastructure pressure.
 */
function cancellationWasTransient(
  error: unknown,
  count: number,
): boolean {
  for (let index = 0; index < count; index += 1) {
    const code = readCancellationReasonCode(error, index)
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
 * Private structural input supplied to Smithy retry classifiers.
 */
type PartialRollbackStartAwsClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout code. */
    readonly code?: string
  }

/**
 * Copies only secret-free structural retry-classifier fields.
 *
 * @param error - Raw SDK or Node.js Error.
 * @returns Sanitized structural classification input.
 */
function createAwsClassificationInput(
  error: Error,
): PartialRollbackStartAwsClassificationInput {
  const input: {
    name: string
    message: string
    $metadata?: {
      httpStatusCode?: number
    }
    code?: string
  } = {
    name: readErrorName(error) ?? 'Error',
    message:
      'Workspace Search migration partial rollback start failed.',
  }
  const code = readOwnStringIfData(error, 'code')
  if (code !== undefined) input.code = code
  const metadata = readOwnRecordIfData(error, '$metadata')
  if (metadata !== undefined) {
    const status = readOwnNumberIfData(
      metadata,
      'httpStatusCode',
    )
    if (status !== undefined) {
      input.$metadata = { httpStatusCode: status }
    }
  }
  return input
}

/**
 * Reads one own string data property safely.
 *
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns String value or undefined.
 */
function readOwnStringIfData(
  value: object,
  key: PropertyKey,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined
}

/**
 * Reads one own finite number data property safely.
 *
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns Finite number or undefined.
 */
function readOwnNumberIfData(
  value: object,
  key: PropertyKey,
): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'number' &&
      Number.isFinite(descriptor.value)
    ? descriptor.value
    : undefined
}

/**
 * Reads one own ordinary-record data property safely.
 *
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns Ordinary record or undefined.
 */
function readOwnRecordIfData(
  value: object,
  key: PropertyKey,
): Readonly<Record<string, unknown>> | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  const candidate = descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined
  return typeof candidate === 'object' &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      !nodeUtilTypes.isProxy(candidate) &&
      Object.getPrototypeOf(candidate) === Object.prototype
    ? candidate
    : undefined
}

/**
 * Reads a stable Error name without invoking caller accessors.
 *
 * @param error - Candidate raw error.
 * @returns Stable name or undefined.
 */
function readErrorName(error: unknown): string | undefined {
  try {
    if (
      typeof error !== 'object' ||
      error === null ||
      nodeUtilTypes.isProxy(error) ||
      !(error instanceof Error)
    ) {
      return undefined
    }
    return readOwnStringIfData(error, 'name') ?? 'Error'
  } catch {
    return undefined
  }
}

/**
 * Detects a missing or replaced DynamoDB resource.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether it denotes resource absence.
 */
function isResourceNotFoundError(error: unknown): boolean {
  try {
    if (nodeUtilTypes.isProxy(error)) return false
    return error instanceof ResourceNotFoundException ||
      readErrorName(error) === 'ResourceNotFoundException'
  } catch {
    return false
  }
}

/**
 * Reads a trusted public managed-guard failure code.
 *
 * @param error - Candidate public transport failure.
 * @returns Stable code or undefined for a raw failure.
 */
function readPublicFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode | undefined {
  try {
    if (
      nodeUtilTypes.isProxy(error) ||
      !(error instanceof WorkspaceSearchMigrationFailure)
    ) {
      return undefined
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return 'INVALID_STATE'
    }
    return isWorkspaceSearchMigrationFailureCode(descriptor.value)
      ? descriptor.value
      : 'INVALID_STATE'
  } catch {
    return undefined
  }
}

/**
 * Classifies a failed strong reconciliation read.
 *
 * @param error - Arbitrary reconciliation failure.
 * @returns Stable fail-closed reconciliation code.
 */
function readPartialRollbackStartReconciliationFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (nodeUtilTypes.isProxy(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    if (error instanceof PartialRollbackStartFailure) {
      return error.code
    }
    const publicCode = readPublicFailureCode(error)
    if (publicCode !== undefined) {
      return publicCode === 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
        : publicCode
    }
    return isResourceNotFoundError(error)
      ? 'CONFIGURATION_DRIFT'
      : 'AMBIGUOUS_OPERATION_UNRESOLVED'
  } catch {
    return 'AMBIGUOUS_OPERATION_UNRESOLVED'
  }
}

/**
 * Runs one asynchronous public operation behind a stable failure boundary.
 *
 * @param operation - Exact asynchronous operation.
 * @returns Successful operation result.
 */
async function runPartialRollbackStartBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createPartialRollbackStartPublicFailure(
      readPartialRollbackStartFailureCode(error, false),
    )
  }
}

/**
 * Runs one synchronous public factory behind a stable failure boundary.
 *
 * @param operation - Exact synchronous operation.
 * @returns Successful operation result.
 */
function runPartialRollbackStartSynchronousBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    throw createPartialRollbackStartPublicFailure(
      readPartialRollbackStartFailureCode(error, false),
    )
  }
}

/**
 * Validates and detaches caller-owned transaction-factory input.
 *
 * Malformed, hostile, or foreign material is an argument failure even when a
 * lower-level canonical codec reports that the supplied state is invalid.
 *
 * @param operation - Exact synchronous input validation and detachment.
 * @returns Strict detached factory input.
 */
function readPartialRollbackStartFactoryInput<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch {
    return failPartialRollbackStart('INVALID_ARGUMENT')
  }
}

/**
 * Extracts one stable code from internal, public, or raw failures.
 *
 * @param error - Arbitrary caught value.
 * @param duringConstruction - Whether malformed core input is an argument.
 * @returns Stable raw-value-free failure code.
 */
function readPartialRollbackStartFailureCode(
  error: unknown,
  duringConstruction: boolean,
): WorkspaceSearchMigrationFailureCode {
  const fallback = duringConstruction
    ? 'INVALID_ARGUMENT'
    : 'INVALID_STATE'
  try {
    if (nodeUtilTypes.isProxy(error)) return fallback
    const publicCode = readPublicFailureCode(error)
    if (publicCode !== undefined) return publicCode
    if (error instanceof PartialRollbackStartFailure) {
      return error.code
    }
    if (isResourceNotFoundError(error)) {
      return 'CONFIGURATION_DRIFT'
    }
    if (error instanceof Error) {
      const classification = createAwsClassificationInput(error)
      if (isThrottlingError(classification)) {
        return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
      }
      if (isTransientError(classification)) {
        return duringConstruction
          ? 'INVALID_ARGUMENT'
          : 'AMBIGUOUS_OPERATION_UNRESOLVED'
      }
    }
    return fallback
  } catch {
    return fallback
  }
}

/**
 * Private stable failure inside the partial-start adapter boundary.
 */
class PartialRollbackStartFailure extends Error {
  /** Stable raw-value-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private stable failure.
   *
   * @param code - Operator-safe failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'PartialRollbackStartFailure'
    this.code = code
  }
}

/**
 * Creates one generic public partial rollback-start failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Raw-value-free public migration failure.
 */
function createPartialRollbackStartPublicFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration partial rollback start failed.',
  )
}

/**
 * Raises one private stable partial rollback-start failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Never returns.
 */
function failPartialRollbackStart(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new PartialRollbackStartFailure(code)
}
