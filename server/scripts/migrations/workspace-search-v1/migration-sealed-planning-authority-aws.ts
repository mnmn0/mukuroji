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
import { types as nodeUtilTypes } from 'node:util'
import {
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks,
} from './migration-pre-plan-authority-aws'
import {
  type CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createWorkspaceSearchMigrationSourceTerminalHeadConditionCheck,
} from './migration-source-evidence-aws'
import {
  createWorkspaceSearchMigrationTargetTerminalHeadConditionCheck,
} from './migration-target-evidence-aws'

const publicationRecordKind =
  'workspace-search-sealed-planning-authority-v2-publication'
const publicationRecordVersion = 1
const publicationRecordKeyPrefix = 'sealed-planning-authority/v2'
const publicationTransactionItemCount = 9

/**
 * Fixed transaction and cancellation-reason positions for v2 publication.
 */
export const workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex =
  Object.freeze({
    lease: 0,
    pointer: 1,
    receipt: 2,
    projectDirectory: 3,
    workItems: 4,
    collaboration: 5,
    documents: 6,
    target: 7,
    root: 8,
    count: publicationTransactionItemCount,
  })

/**
 * Caller-owned publication material before the adapter assigns commit time.
 */
export type PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input =
  Omit<
    CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
    'sealedAt'
  >

/**
 * Exact immutable sealed root fixed by a later execution transaction.
 */
export type CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheckInput = {
  /** Exact measured migration-state table containing the durable root. */
  readonly stateTable: MigrationTableIdentity
  /** Reviewed measured-configuration digest used in root addressing. */
  readonly configurationHash: string
  /** Exact immutable version-two root to condition-check. */
  readonly authority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
}

/**
 * Narrow migration-state transport used by sealed-authority publication.
 */
export interface WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsTransport {
  /**
   * Strongly reads one deterministic publication record.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getSealedPlanningAuthority(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes the measured state-incarnation guard immediately before commit.
   */
  prepareSealedPlanningAuthorityWrite(): Promise<void>

  /**
   * Atomically condition-checks authority and evidence and publishes one root.
   *
   * @param command - Adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB response.
   */
  transactWriteSealedPlanningAuthority(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Adapter-owned source of trusted publication time.
 */
export type WorkspaceSearchMigrationSealedPlanningAuthorityV2Clock =
  () => Date

/**
 * Durable read and publication operations for one measured state incarnation.
 */
export interface WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort {
  /**
   * Strongly reads the immutable publication for one run.
   *
   * @param runId - Operator-selected migration run.
   * @returns Strict detached root, or undefined when it has not been published.
   */
  read(
    runId: string,
  ): Promise<WorkspaceSearchMigrationSealedPlanningAuthorityV2 | undefined>

  /**
   * Atomically publishes one validated v2 root under current authority.
   *
   * @param input - Complete manifest, provenance, evidence, and authority input.
   * @returns Exact immutable root proven durable by the transaction or reread.
   */
  publish(
    input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  ): Promise<WorkspaceSearchMigrationSealedPlanningAuthorityV2>
}

/**
 * Detached adapter construction binding.
 */
type SealedPlanningAuthorityPublicationBinding = {
  /** Exact physical migration-state table name. */
  readonly stateTableName: string
  /** Immutable migration-state TableId. */
  readonly stateTableId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
}

/**
 * Fully prepared transport methods captured at adapter construction.
 */
type PreparedSealedPlanningAuthorityTransport = {
  /**
   * Strongly reads one publication record.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level response.
   */
  readonly get: (
    command: GetItemCommand,
  ) => Promise<GetItemCommandOutput>
  /**
   * Runs the final measured-incarnation preparation.
   *
   * @returns Completion after the guard succeeds.
   */
  readonly prepare: () => Promise<void>
  /**
   * Sends one atomic publication transaction.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Raw low-level response.
   */
  readonly transact: (
    command: TransactWriteItemsCommand,
  ) => Promise<TransactWriteItemsCommandOutput>
}

/**
 * Canonical publication record and its exact root bytes.
 */
type PreparedPublicationRecord = {
  /** Complete low-level item written to the migration-state table. */
  readonly item: Readonly<Record<string, AttributeValue>>
  /** Exact canonical root bytes retained by the item. */
  readonly rootBytes: Uint8Array
}

/**
 * Descriptor-safe detached input for one sealed-root condition check.
 */
type PreparedSealedPlanningAuthorityConditionCheckInput = {
  /** Exact physical migration-state table containing the durable root. */
  readonly stateTableName: string
  /** Immutable migration-state TableId used in root addressing. */
  readonly stateTableId: string
  /** Reviewed measured-configuration digest used in root addressing. */
  readonly configurationHash: string
  /** Exact immutable version-two root to condition-check. */
  readonly authority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
}

/**
 * Secret-free structural AWS error supplied only to Smithy's classifiers.
 */
type SealedPlanningAuthorityAwsErrorClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout error code. */
    readonly code?: string
  }

/**
 * Stable internal publication failure.
 */
class SealedPlanningAuthorityPublicationFailure extends Error {
  /** Secret-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private failure without raw AWS or caller data.
   *
   * @param code - Stable operator-safe failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'SealedPlanningAuthorityPublicationFailure'
    this.code = code
  }
}

/**
 * Concrete immutable publication adapter for one measured state table.
 */
class AwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port
implements WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort {
  /** Detached measured state and configuration binding. */
  private readonly binding: SealedPlanningAuthorityPublicationBinding

  /** Captured narrow transport methods. */
  private readonly transport: PreparedSealedPlanningAuthorityTransport

  /** Adapter-owned trusted clock. */
  private readonly clock:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2Clock

  /**
   * Creates one concrete publication adapter.
   *
   * @param binding - Detached measured state/configuration binding.
   * @param transport - Captured narrow transport.
   * @param clock - Adapter-owned trusted clock.
   */
  constructor(
    binding: SealedPlanningAuthorityPublicationBinding,
    transport: PreparedSealedPlanningAuthorityTransport,
    clock: WorkspaceSearchMigrationSealedPlanningAuthorityV2Clock,
  ) {
    this.binding = binding
    this.transport = transport
    this.clock = clock
  }

  /**
   * Strongly reads the immutable publication for one run.
   *
   * @param runId - Operator-selected migration run.
   * @returns Strict detached root, or undefined when absent.
   */
  async read(
    runId: string,
  ): Promise<WorkspaceSearchMigrationSealedPlanningAuthorityV2 | undefined> {
    return runSealedPlanningAuthorityPublicationBoundary(async () => {
      const validatedRunId = readMigrationIdentifier(runId)
      return this.readPublication(validatedRunId)
    })
  }

  /**
   * Atomically publishes one validated root under current authority and heads.
   *
   * @param input - Complete publication input without adapter-owned time.
   * @returns Exact immutable durable root.
   */
  async publish(
    input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  ): Promise<WorkspaceSearchMigrationSealedPlanningAuthorityV2> {
    return runSealedPlanningAuthorityPublicationBoundary(async () => {
      const snapshot = this.preparePublishInput(input)
      const existing = await this.readPublication(snapshot.runId)
      if (existing !== undefined) {
        const recovered = this.recoverPublicationForInput(
          snapshot,
          existing,
        )
        await this.transport.prepare()
        return recovered
      }
      const preflightAt = readPublicationClock(this.clock)
      this.requireFreshPublishInput(snapshot, preflightAt)
      await this.transport.prepare()
      const commitAt = readPublicationClock(this.clock)
      const root =
        createWorkspaceSearchMigrationSealedPlanningAuthorityV2({
          ...snapshot,
          sealedAt: commitAt.toISOString(),
        })
      this.requireRootBinding(root)
      const record = createPublicationRecord(this.binding, root)
      const command = createPublicationCommand(
        this.binding,
        snapshot,
        root,
        record.item,
        commitAt,
      )
      try {
        await this.transport.transact(command)
        return clonePublicationRoot(root)
      } catch (transactionError: unknown) {
        const guardFailureCode =
          readPublicationTransportGuardFailureCode(transactionError)
        if (guardFailureCode !== undefined) {
          return failSealedPlanningAuthorityPublication(
            guardFailureCode,
          )
        }
        return this.reconcilePublication(
          snapshot,
          root,
          record.rootBytes,
          transactionError,
        )
      }
    })
  }

  /**
   * Detaches and validates every caller-owned field before the first await.
   *
   * @param input - Caller-owned publication material.
   * @returns Detached complete publication snapshot.
   */
  private preparePublishInput(
    input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  ): PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input {
    requireExactPublishInputKeys(input)
    const validationAt = readPublicationInputValidationTime(input)
    const candidate = createTimedPublicationInput(
      input,
      validationAt,
    )
    const preflightRoot =
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(candidate)
    this.requireRootBinding(preflightRoot)
    this.requireInputStateBinding(candidate)
    let snapshot: CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input
    try {
      snapshot = structuredClone(candidate)
    } catch {
      return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
    }
    return omitPublicationTime(snapshot)
  }

  /**
   * Revalidates time-sensitive authority before a new transaction attempt.
   *
   * @param input - Detached stable caller-owned publication material.
   * @param preflightAt - Trusted current preflight instant.
   */
  private requireFreshPublishInput(
    input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
    preflightAt: Date,
  ): void {
    const candidate = createTimedPublicationInput(
      input,
      preflightAt.toISOString(),
    )
    const preflightRoot =
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2(candidate)
    this.requireRootBinding(preflightRoot)
    this.requireInputStateBinding(candidate)
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable: candidate.configuration.tables['migration-state'],
      configurationHash: candidate.configurationHash,
      authority: candidate.currentAuthority,
      commitAt: preflightAt,
    })
    for (const source of workspaceSearchMigrationSourceNames) {
      createWorkspaceSearchMigrationSourceTerminalHeadConditionCheck({
        stateTable: candidate.configuration.tables['migration-state'],
        progress: candidate.sourceProgress[source],
      })
    }
    createWorkspaceSearchMigrationTargetTerminalHeadConditionCheck({
      stateTable: candidate.configuration.tables['migration-state'],
      progress: candidate.targetProgress,
    })
  }

  /**
   * Recovers one durable logical publication using its root-owned timestamp.
   *
   * The caller-owned input is reconstructed with the already durable
   * `sealedAt` so a retry cannot accept a different manifest, authority, or
   * evidence graph merely because it addresses the same deterministic key.
   *
   * @param input - Detached stable caller-owned publication material.
   * @param durable - Strict root read from the deterministic publication key.
   * @returns Detached durable root only when every stable field matches.
   */
  private recoverPublicationForInput(
    input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
    durable: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  ): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
    let candidate: WorkspaceSearchMigrationSealedPlanningAuthorityV2
    try {
      candidate =
        createWorkspaceSearchMigrationSealedPlanningAuthorityV2({
          ...input,
          sealedAt: durable.sealedAt,
        })
    } catch {
      return failSealedPlanningAuthorityPublication('INVALID_STATE')
    }
    const candidateBytes =
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        candidate,
      )
    const durableBytes =
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        durable,
      )
    if (!uint8ArraysEqual(candidateBytes, durableBytes)) {
      return failSealedPlanningAuthorityPublication('INVALID_STATE')
    }
    return clonePublicationRoot(durable)
  }

  /**
   * Requires a pure root to match the adapter's measured binding.
   *
   * @param root - Strict detached v2 root.
   */
  private requireRootBinding(
    root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  ): void {
    if (
      root.configurationHash !== this.binding.configurationHash ||
      root.tableIds['migration-state'] !== this.binding.stateTableId
    ) {
      return failSealedPlanningAuthorityPublication(
        'CONFIGURATION_DRIFT',
      )
    }
  }

  /**
   * Requires transaction conditions and the root Put to address one table.
   *
   * @param input - Strict complete pure-boundary publication input.
   */
  private requireInputStateBinding(
    input: CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  ): void {
    const stateTable = input.configuration.tables['migration-state']
    if (
      stateTable.tableName !== this.binding.stateTableName ||
      stateTable.tableId !== this.binding.stateTableId ||
      input.configurationHash !== this.binding.configurationHash
    ) {
      return failSealedPlanningAuthorityPublication(
        'CONFIGURATION_DRIFT',
      )
    }
  }

  /**
   * Strongly reads and validates one deterministic publication record.
   *
   * @param runId - Validated operator-selected run.
   * @returns Strict detached root or undefined when absent.
   */
  private async readPublication(
    runId: string,
  ): Promise<WorkspaceSearchMigrationSealedPlanningAuthorityV2 | undefined> {
    const output = await this.transport.get(
      createPublicationReadCommand(this.binding, runId),
    )
    const item = readPublicationOutputItem(output)
    if (item === undefined) return undefined
    return parsePublicationItem(this.binding, runId, item)
  }

  /**
   * Resolves a failed transaction by strongly rereading its immutable key.
   *
   * @param input - Detached stable caller-owned publication material.
   * @param intended - Exact intended root.
   * @param intendedBytes - Canonical bytes written by the transaction.
   * @param transactionError - Raw transaction error used only after absence.
   * @returns Exact intended or stable-input-equivalent durable root.
   */
  private async reconcilePublication(
    input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
    intended: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    intendedBytes: Uint8Array,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationSealedPlanningAuthorityV2> {
    let durable:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2 | undefined
    try {
      durable = await this.readPublication(intended.runId)
    } catch (reconciliationError: unknown) {
      if (
        reconciliationError instanceof
          SealedPlanningAuthorityPublicationFailure
      ) {
        throw reconciliationError
      }
      if (isResourceNotFoundError(reconciliationError)) {
        return failSealedPlanningAuthorityPublication(
          'CONFIGURATION_DRIFT',
        )
      }
      if (isConfigurationDriftFailure(reconciliationError)) {
        return failSealedPlanningAuthorityPublication(
          'CONFIGURATION_DRIFT',
        )
      }
      return failSealedPlanningAuthorityPublication(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
    if (durable !== undefined) {
      const durableBytes =
        serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          durable,
        )
      if (uint8ArraysEqual(durableBytes, intendedBytes)) {
        return clonePublicationRoot(intended)
      }
      return this.recoverPublicationForInput(input, durable)
    }
    return failSealedPlanningAuthorityPublication(
      classifyPublicationTransactionError(transactionError),
    )
  }
}

/**
 * Creates one measured concrete v2 publication adapter.
 *
 * @param stateTable - Exact measured migration-state table incarnation.
 * @param configurationHash - Reviewed measured-configuration digest.
 * @param transport - Narrow strongly consistent and transactional transport.
 * @param clock - Adapter-owned trusted commit clock.
 * @returns Durable v2 publication port.
 */
export function createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
  stateTable: MigrationTableIdentity,
  configurationHash: string,
  transport: WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsTransport,
  clock: WorkspaceSearchMigrationSealedPlanningAuthorityV2Clock,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsPort {
  try {
    requireMigrationStateTableIdentity(stateTable)
    const stateTableName = readOwnDataProperty(
      stateTable,
      'tableName',
    )
    const stateTableId = readOwnDataProperty(stateTable, 'tableId')
    if (!isHexDigest(configurationHash)) {
      return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
    }
    const preparedTransport = preparePublicationTransport(transport)
    if (typeof clock !== 'function') {
      return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
    }
    return new AwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
      {
        stateTableName,
        stateTableId,
        configurationHash,
      },
      preparedTransport,
      clock,
    )
  } catch (error: unknown) {
    throw createSealedPlanningAuthorityPublicationBoundaryFailure(
      readSealedPlanningAuthorityPublicationFailureCode(error),
    )
  }
}

/**
 * Creates an exact immutable sealed-root condition check.
 *
 * The complete canonical root bytes and their independently indexed binding
 * fields are fixed together so a later execution transaction cannot substitute
 * another publication for the same run.
 *
 * @param input - Measured state table, configuration digest, and exact root.
 * @returns One adapter-owned DynamoDB ConditionCheck transaction item.
 */
export function createWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheck(
  input:
    CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheckInput,
): TransactWriteItem {
  try {
    const snapshot = prepareSealedPlanningAuthorityConditionCheckInput(
      input,
    )
    if (!isHexDigest(snapshot.configurationHash)) {
      return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
    }
    const rootBytes =
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        snapshot.authority,
      )
    const root =
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(rootBytes)
    if (
      root.configurationHash !== snapshot.configurationHash ||
      root.tableIds['migration-state'] !== snapshot.stateTableId
    ) {
      return failSealedPlanningAuthorityPublication(
        'CONFIGURATION_DRIFT',
      )
    }
    const binding: SealedPlanningAuthorityPublicationBinding = {
      stateTableName: snapshot.stateTableName,
      stateTableId: snapshot.stateTableId,
      configurationHash: snapshot.configurationHash,
    }
    const conditionCheck:
      NonNullable<TransactWriteItem['ConditionCheck']> = {
        TableName: binding.stateTableName,
        Key: {
          migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
          recordKey: {
            S: createPublicationRecordKey(binding, root.runId),
          },
        },
        ConditionExpression: [
          '#kind = :kind',
          '#version = :version',
          '#stateTableId = :stateTableId',
          '#configurationHash = :configurationHash',
          '#runId = :runId',
          '#authorityDigest = :authorityDigest',
          '#sealedAt = :sealedAt',
          '#rootBytes = :rootBytes',
        ].join(' AND '),
        ExpressionAttributeNames: {
          '#kind': 'kind',
          '#version': 'version',
          '#stateTableId': 'stateTableId',
          '#configurationHash': 'configurationHash',
          '#runId': 'runId',
          '#authorityDigest': 'authorityDigest',
          '#sealedAt': 'sealedAt',
          '#rootBytes': 'rootBytes',
        },
        ExpressionAttributeValues: {
          ':kind': { S: publicationRecordKind },
          ':version': { N: String(publicationRecordVersion) },
          ':stateTableId': { S: binding.stateTableId },
          ':configurationHash': { S: binding.configurationHash },
          ':runId': { S: root.runId },
          ':authorityDigest': { S: root.authorityDigest },
          ':sealedAt': { S: root.sealedAt },
          ':rootBytes': { B: rootBytes },
        },
        ReturnValuesOnConditionCheckFailure: 'NONE',
      }
    return { ConditionCheck: conditionCheck }
  } catch (error: unknown) {
    throw createSealedPlanningAuthorityPublicationBoundaryFailure(
      readSealedPlanningAuthorityPublicationFailureCode(error),
    )
  }
}

/**
 * Rejects accessors, Proxies, extra fields, and later caller mutation.
 *
 * @param input - Candidate exported condition-check input.
 * @returns Detached descriptor-safe condition-check material.
 */
function prepareSealedPlanningAuthorityConditionCheckInput(
  input:
    CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2ConditionCheckInput,
): PreparedSealedPlanningAuthorityConditionCheckInput {
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeUtilTypes.isProxy(input)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  const expected = [
    'authority',
    'configurationHash',
    'stateTable',
  ]
  const ownKeys = Reflect.ownKeys(input)
  if (
    ownKeys.length !== expected.length ||
    ownKeys.some((key) => typeof key !== 'string')
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  const actual = Object.keys(input).sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  const stateTable = readOwnDataProperty(input, 'stateTable')
  requireMigrationStateTableIdentity(stateTable)
  if (typeof stateTable !== 'object' || stateTable === null) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  const stateTableName = readOwnDataValue(stateTable, 'tableName')
  const stateTableId = readOwnDataValue(stateTable, 'tableId')
  if (
    typeof stateTableName !== 'string' ||
    typeof stateTableId !== 'string'
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  return {
    authority: readOwnDataProperty(input, 'authority'),
    configurationHash: readOwnDataProperty(
      input,
      'configurationHash',
    ),
    stateTableName,
    stateTableId,
  }
}

/**
 * Creates the fixed nine-item atomic publication command.
 *
 * @param binding - Measured state/configuration binding.
 * @param input - Detached complete publication input.
 * @param root - Exact intended v2 root.
 * @param rootItem - Complete immutable root item.
 * @param commitAt - Adapter-owned commit instant.
 * @returns Adapter-owned DynamoDB transaction.
 */
function createPublicationCommand(
  binding: SealedPlanningAuthorityPublicationBinding,
  input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  rootItem: Readonly<Record<string, AttributeValue>>,
  commitAt: Date,
): TransactWriteItemsCommand {
  const stateTable = input.configuration.tables['migration-state']
  const authorityChecks =
    createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks({
      stateTable,
      configurationHash: input.configurationHash,
      authority: input.currentAuthority,
      commitAt,
    })
  const sourceChecks = workspaceSearchMigrationSourceNames.map((source) =>
    createWorkspaceSearchMigrationSourceTerminalHeadConditionCheck({
      stateTable,
      progress: input.sourceProgress[source],
    })
  )
  const targetCheck =
    createWorkspaceSearchMigrationTargetTerminalHeadConditionCheck({
      stateTable,
      progress: input.targetProgress,
    })
  const rootPut: NonNullable<TransactWriteItem['Put']> = {
    TableName: binding.stateTableName,
    Item: rootItem,
    ConditionExpression:
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    ExpressionAttributeNames: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
  }
  const items: TransactWriteItem[] = [
    ...authorityChecks,
    ...sourceChecks,
    targetCheck,
    { Put: rootPut },
  ]
  if (items.length !== publicationTransactionItemCount) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken: createPublicationTransactionToken(
      binding,
      root,
    ),
    TransactItems: items,
  })
}

/**
 * Creates one complete canonical immutable publication item.
 *
 * @param binding - Measured state/configuration binding.
 * @param root - Exact strict v2 root.
 * @returns Complete low-level item and canonical root bytes.
 */
function createPublicationRecord(
  binding: SealedPlanningAuthorityPublicationBinding,
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): PreparedPublicationRecord {
  const rootBytes =
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(root)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createPublicationRecordKey(binding, root.runId),
    },
    kind: { S: publicationRecordKind },
    version: { N: String(publicationRecordVersion) },
    stateTableId: { S: binding.stateTableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: root.runId },
    authorityDigest: { S: root.authorityDigest },
    sealedAt: { S: root.sealedAt },
    rootBytes: { B: rootBytes },
  }
  validateDynamoDbItemSize(item)
  return {
    item,
    rootBytes: new Uint8Array(rootBytes),
  }
}

/**
 * Parses and cross-checks one complete durable publication item.
 *
 * @param binding - Measured state/configuration binding.
 * @param runId - Exact run addressed by the read.
 * @param item - Raw low-level DynamoDB item.
 * @returns Strict detached v2 root.
 */
function parsePublicationItem(
  binding: SealedPlanningAuthorityPublicationBinding,
  runId: string,
  item: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  requireExactPublicationItemKeys(item)
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !==
      createPublicationRecordKey(binding, runId) ||
    readStringAttribute(item, 'kind') !== publicationRecordKind ||
    readNumberAttribute(item, 'version') !==
      publicationRecordVersion ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !== runId
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const rootBytes = readBinaryAttribute(item, 'rootBytes')
  let root: WorkspaceSearchMigrationSealedPlanningAuthorityV2
  try {
    root =
      parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(rootBytes)
  } catch {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  if (
    root.runId !== runId ||
    root.configurationHash !== binding.configurationHash ||
    root.tableIds['migration-state'] !== binding.stateTableId ||
    root.authorityDigest !==
      readStringAttribute(item, 'authorityDigest') ||
    root.sealedAt !== readStringAttribute(item, 'sealedAt')
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return root
}

/**
 * Creates one strongly consistent root read.
 *
 * @param binding - Measured state/configuration binding.
 * @param runId - Validated operator-selected run.
 * @returns Adapter-owned GetItem command.
 */
function createPublicationReadCommand(
  binding: SealedPlanningAuthorityPublicationBinding,
  runId: string,
): GetItemCommand {
  return new GetItemCommand({
    TableName: binding.stateTableName,
    ConsistentRead: true,
    Key: {
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: {
        S: createPublicationRecordKey(binding, runId),
      },
    },
  })
}

/**
 * Reads an optional GetItem result without invoking output accessors.
 *
 * @param output - Raw low-level DynamoDB response.
 * @returns Raw item data property, or undefined when absent.
 */
function readPublicationOutputItem(
  output: GetItemCommandOutput,
): Readonly<Record<string, AttributeValue>> | undefined {
  if (
    typeof output !== 'object' ||
    output === null ||
    nodeUtilTypes.isProxy(output)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
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
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return output.Item
}

/**
 * Creates one bounded deterministic publication record key.
 *
 * @param binding - Measured state/configuration binding.
 * @param runId - Validated operator-selected run.
 * @returns Deterministic run/configuration publication key.
 */
function createPublicationRecordKey(
  binding: SealedPlanningAuthorityPublicationBinding,
  runId: string,
): string {
  const validatedRunId = readMigrationIdentifier(runId)
  const bindingDigest = createMigrationDigest({
    kind: 'workspace-search-sealed-planning-authority-v2-binding',
    version: publicationRecordVersion,
    stateTableId: binding.stateTableId,
    configurationHash: binding.configurationHash,
    runId: validatedRunId,
  })
  return `${publicationRecordKeyPrefix}/${bindingDigest}/root`
}

/**
 * Creates one stable at-most-36-character transaction token.
 *
 * @param binding - Measured state/configuration binding.
 * @param root - Exact intended publication root.
 * @returns Bounded deterministic DynamoDB idempotency token.
 */
function createPublicationTransactionToken(
  binding: SealedPlanningAuthorityPublicationBinding,
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): string {
  return createMigrationDigest({
    kind: 'workspace-search-sealed-planning-authority-v2-commit',
    version: publicationRecordVersion,
    stateTableId: binding.stateTableId,
    configurationHash: binding.configurationHash,
    runId: root.runId,
    authorityDigest: root.authorityDigest,
  }).slice(0, 36)
}

/**
 * Requires the exact top-level publication fields without invoking accessors.
 *
 * @param input - Candidate caller-owned publication input.
 */
function requireExactPublishInputKeys(
  input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeUtilTypes.isProxy(input)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  const expected = [
    'configuration',
    'configurationHash',
    'currentAuthority',
    'planManifestHead',
    'planManifestHeadReference',
    'planSeal',
    'planSealReference',
    'planningAuthorityProvenance',
    'planningProvenanceManifestHead',
    'planningProvenanceManifestHeadReference',
    'runId',
    'sourceProgress',
    'targetProgress',
  ]
  const ownKeys = Reflect.ownKeys(input)
  const keys: string[] = []
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
    }
    keys.push(key)
  }
  keys.sort()
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  for (const key of expected) {
    readOwnDataValue(input, key)
  }
}

/**
 * Constructs a top-level data-only v2 input without evaluating accessors.
 *
 * @param input - Caller-owned publication input with exact data descriptors.
 * @param sealedAt - Adapter-owned canonical preflight or commit time.
 * @returns Complete v2 pure-boundary input.
 */
function createTimedPublicationInput(
  input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  sealedAt: string,
): CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input {
  return {
    runId: readOwnDataProperty(input, 'runId'),
    configuration: readOwnDataProperty(input, 'configuration'),
    configurationHash: readOwnDataProperty(
      input,
      'configurationHash',
    ),
    planSeal: readOwnDataProperty(input, 'planSeal'),
    planSealReference: readOwnDataProperty(
      input,
      'planSealReference',
    ),
    planManifestHead: readOwnDataProperty(
      input,
      'planManifestHead',
    ),
    planManifestHeadReference: readOwnDataProperty(
      input,
      'planManifestHeadReference',
    ),
    planningProvenanceManifestHead: readOwnDataProperty(
      input,
      'planningProvenanceManifestHead',
    ),
    planningProvenanceManifestHeadReference: readOwnDataProperty(
      input,
      'planningProvenanceManifestHeadReference',
    ),
    planningAuthorityProvenance: readOwnDataProperty(
      input,
      'planningAuthorityProvenance',
    ),
    sourceProgress: readOwnDataProperty(input, 'sourceProgress'),
    targetProgress: readOwnDataProperty(input, 'targetProgress'),
    currentAuthority: readOwnDataProperty(
      input,
      'currentAuthority',
    ),
    sealedAt,
  }
}

/**
 * Reads the earliest stable instant at which a valid input can be detached.
 *
 * This timestamp validates and snapshots the caller graph before I/O. It is
 * not used as current authority for a new transaction; that proof is repeated
 * later with the trusted adapter clock.
 *
 * @param input - Caller-owned publication material with exact top-level keys.
 * @returns Later of plan creation and current-authority evaluation.
 */
function readPublicationInputValidationTime(
  input: PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
): string {
  const planSeal = readOwnDataObject(input, 'planSeal')
  const currentAuthority = readOwnDataObject(
    input,
    'currentAuthority',
  )
  const createdAt = readOwnDataValue(planSeal, 'createdAt')
  const evaluatedAt = readOwnDataValue(
    currentAuthority,
    'evaluatedAt',
  )
  if (
    !isCanonicalTimestamp(createdAt) ||
    !isCanonicalTimestamp(evaluatedAt)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  return Date.parse(createdAt) >= Date.parse(evaluatedAt)
    ? createdAt
    : evaluatedAt
}

/**
 * Removes adapter-owned preflight time from one validated detached snapshot.
 *
 * @param input - Complete cloned v2 pure-boundary input.
 * @returns Detached caller publication material.
 */
function omitPublicationTime(
  input: CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
): PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input {
  return {
    runId: input.runId,
    configuration: input.configuration,
    configurationHash: input.configurationHash,
    planSeal: input.planSeal,
    planSealReference: input.planSealReference,
    planManifestHead: input.planManifestHead,
    planManifestHeadReference: input.planManifestHeadReference,
    planningProvenanceManifestHead:
      input.planningProvenanceManifestHead,
    planningProvenanceManifestHeadReference:
      input.planningProvenanceManifestHeadReference,
    planningAuthorityProvenance:
      input.planningAuthorityProvenance,
    sourceProgress: input.sourceProgress,
    targetProgress: input.targetProgress,
    currentAuthority: input.currentAuthority,
  }
}

/**
 * Reads one own enumerable data property with its generic declared type.
 *
 * @param value - Candidate containing object.
 * @param key - Required own data-property key.
 * @returns Exact descriptor value without invoking an accessor.
 */
function readOwnDataProperty<
  Value extends object,
  Key extends keyof Value,
>(
  value: Value,
  key: Key,
): Value[Key] {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  return descriptor.value
}

/**
 * Reads one own enumerable data property as a non-Proxy object.
 *
 * @param value - Candidate containing object.
 * @param key - Required own data-property key.
 * @returns Untrusted object value safe for descriptor inspection.
 */
function readOwnDataObject(
  value: object,
  key: PropertyKey,
): object {
  const candidate = readOwnDataValue(value, key)
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate) ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  return candidate
}

/**
 * Reads one own enumerable data property without trusting its value.
 *
 * @param value - Candidate containing object.
 * @param key - Required own data-property key.
 * @returns Untrusted descriptor value without invoking an accessor.
 */
function readOwnDataValue(
  value: object,
  key: PropertyKey,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  return descriptor.value
}

/**
 * Reads one exact adapter clock instant without trusting Date overrides.
 *
 * @param clock - Adapter-owned clock.
 * @returns Detached exact commit instant.
 */
function readPublicationClock(
  clock: WorkspaceSearchMigrationSealedPlanningAuthorityV2Clock,
): Date {
  let value: Date
  try {
    value = clock()
  } catch {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return new Date(epochMilliseconds)
}

/**
 * Captures and validates narrow transport methods without invoking them.
 *
 * @param transport - Candidate narrow transport.
 * @returns Bound immutable method set.
 */
function preparePublicationTransport(
  transport: WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsTransport,
): PreparedSealedPlanningAuthorityTransport {
  if (
    typeof transport !== 'object' ||
    transport === null ||
    nodeUtilTypes.isProxy(transport)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  const get = readOwnDataValue(
    transport,
    'getSealedPlanningAuthority',
  )
  const prepare = readOwnDataValue(
    transport,
    'prepareSealedPlanningAuthorityWrite',
  )
  const transact = readOwnDataValue(
    transport,
    'transactWriteSealedPlanningAuthority',
  )
  if (
    typeof get !== 'function' ||
    typeof prepare !== 'function' ||
    typeof transact !== 'function'
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  return {
    get: get.bind(transport),
    prepare: prepare.bind(transport),
    transact: transact.bind(transport),
  }
}

/**
 * Validates the measured state fields directly consumed by this adapter.
 *
 * @param value - Candidate measured migration-state identity.
 */
function requireMigrationStateTableIdentity(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  if (
    readOwnDataValue(value, 'role') !== 'migration-state' ||
    !isBoundedText(readOwnDataValue(value, 'tableArn'), 2_048) ||
    !isBoundedText(readOwnDataValue(value, 'tableId'), 1_024) ||
    !isBoundedText(readOwnDataValue(value, 'account'), 64) ||
    !isBoundedText(readOwnDataValue(value, 'region'), 64) ||
    !isCanonicalTimestamp(
      readOwnDataValue(value, 'creationTime'),
    )
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  const tableName = readOwnDataValue(value, 'tableName')
  if (
    typeof tableName !== 'string' ||
    tableName.length < 3 ||
    tableName.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(tableName)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
}

/**
 * Checks one nonempty bounded text field.
 *
 * @param value - Candidate value.
 * @param maximumLength - Maximum accepted UTF-16 length.
 * @returns Whether the candidate is accepted.
 */
function isBoundedText(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength
}

/**
 * Validates one safe migration identifier.
 *
 * @param value - Candidate run identifier.
 * @returns Exact validated identifier.
 */
function readMigrationIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires the exact durable publication item field set.
 *
 * @param item - Candidate low-level item.
 */
function requireExactPublicationItemKeys(
  item: Readonly<Record<string, AttributeValue>>,
): void {
  const expected = [
    'authorityDigest',
    'configurationHash',
    'kind',
    'migrationId',
    'recordKey',
    'rootBytes',
    'runId',
    'sealedAt',
    'stateTableId',
    'version',
  ]
  if (
    typeof item !== 'object' ||
    item === null ||
    Array.isArray(item) ||
    nodeUtilTypes.isProxy(item)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const ownKeys = Reflect.ownKeys(item)
  if (ownKeys.some((key) => typeof key !== 'string')) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const actual = Object.keys(item).sort()
  if (
    ownKeys.length !== actual.length ||
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return failSealedPlanningAuthorityPublication('INVALID_STATE')
    }
  }
}

/**
 * Reads one strict DynamoDB string attribute.
 *
 * @param item - Complete low-level item.
 * @param name - Secret-free attribute name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = readAttributeDataValue(item, name, 'S')
  if (typeof value !== 'string') {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return value
}

/**
 * Reads one strict DynamoDB numeric integer attribute.
 *
 * @param item - Complete low-level item.
 * @param name - Secret-free attribute name.
 * @returns Exact safe integer value.
 */
function readNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const encoded = readAttributeDataValue(item, name, 'N')
  if (
    typeof encoded !== 'string' ||
    !/^(0|[1-9][0-9]*)$/u.test(encoded)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const value = Number(encoded)
  if (!Number.isSafeInteger(value)) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return value
}

/**
 * Reads one strict DynamoDB binary attribute.
 *
 * @param item - Complete low-level item.
 * @param name - Secret-free attribute name.
 * @returns Detached exact bytes.
 */
function readBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const value = readAttributeDataValue(item, name, 'B')
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const buffer = readIntrinsicPublicationByteBuffer(value)
  if (nodeUtilTypes.isSharedArrayBuffer(buffer)) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const bytes = new Uint8Array(value)
  if (bytes.byteLength === 0) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return bytes
}

/**
 * Reads one exact DynamoDB AttributeValue data variant.
 *
 * @param item - Complete descriptor-safe low-level item.
 * @param name - Exact item attribute name.
 * @param variant - Required low-level AttributeValue discriminator.
 * @returns Untrusted data value without invoking an accessor.
 */
function readAttributeDataValue(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
  variant: 'B' | 'N' | 'S',
): unknown {
  const itemDescriptor = Object.getOwnPropertyDescriptor(item, name)
  if (
    itemDescriptor === undefined ||
    itemDescriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(itemDescriptor, 'value')
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const attribute: unknown = itemDescriptor.value
  if (
    typeof attribute !== 'object' ||
    attribute === null ||
    Array.isArray(attribute) ||
    nodeUtilTypes.isProxy(attribute)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const keys = Reflect.ownKeys(attribute)
  const descriptor = Object.getOwnPropertyDescriptor(attribute, variant)
  if (
    keys.length !== 1 ||
    keys[0] !== variant ||
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Reads a Uint8Array's intrinsic backing buffer without subclass accessors.
 *
 * @param value - Validated non-Proxy Uint8Array.
 * @returns Exact intrinsic backing buffer.
 */
function readIntrinsicPublicationByteBuffer(
  value: Uint8Array,
): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'buffer',
  )
  if (descriptor?.get === undefined) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  const buffer: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    !nodeUtilTypes.isArrayBuffer(buffer) &&
    !nodeUtilTypes.isSharedArrayBuffer(buffer)
  ) {
    return failSealedPlanningAuthorityPublication('INVALID_STATE')
  }
  return buffer
}

/**
 * Classifies one transaction failure only after a strong read proves absence.
 *
 * @param error - Raw transaction error retained inside the private boundary.
 * @returns Stable retry, authority, ambiguous, or fail-closed code.
 */
function classifyPublicationTransactionError(
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
        workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex
      if (
        readTransactionCancellationReasonCode(error, index.lease) ===
          'ConditionalCheckFailed'
      ) {
        return 'LEASE_LOST'
      }
      if (
        readTransactionCancellationReasonCode(error, index.pointer) ===
          'ConditionalCheckFailed' ||
        readTransactionCancellationReasonCode(error, index.receipt) ===
          'ConditionalCheckFailed'
      ) {
        return 'INVALID_MAINTENANCE_EVIDENCE'
      }
      for (
        let conditionIndex = index.projectDirectory;
        conditionIndex <= index.root;
        conditionIndex += 1
      ) {
        if (
          readTransactionCancellationReasonCode(
            error,
            conditionIndex,
          ) === 'ConditionalCheckFailed'
        ) {
          return 'INVALID_STATE'
        }
      }
      if (transactionCancellationHasConditionalFailure(error)) {
        return 'INVALID_STATE'
      }
      return transactionCancellationWasTransient(error)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    const name = readErrorName(error)
    if (name === 'TransactionInProgressException') {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const classificationInput =
      createSealedPlanningAuthorityAwsErrorClassificationInput(error)
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
 * Reads one transaction cancellation reason by fixed item index.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @param index - Zero-based transaction item index.
 * @returns Stable reason code or undefined.
 */
function readTransactionCancellationReasonCode(
  error: TransactionCanceledException,
  index: number,
): string | undefined {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return undefined
  const reason: unknown = reasons[index]
  if (typeof reason !== 'object' || reason === null) return undefined
  const code: unknown = Reflect.get(reason, 'Code')
  return typeof code === 'string' ? code : undefined
}

/**
 * Detects any conditional failure in a transaction cancellation.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @returns Whether any transaction item rejected its condition.
 */
function transactionCancellationHasConditionalFailure(
  error: TransactionCanceledException,
): boolean {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  return reasons.some((reason) =>
    typeof reason === 'object' &&
    reason !== null &&
    Reflect.get(reason, 'Code') === 'ConditionalCheckFailed'
  )
}

/**
 * Detects explicit retry-safe transaction cancellation reasons.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @returns Whether one reason proves an infrastructure rejection.
 */
function transactionCancellationWasTransient(
  error: TransactionCanceledException,
): boolean {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  return reasons.some((reason) => {
    if (typeof reason !== 'object' || reason === null) return false
    const code: unknown = Reflect.get(reason, 'Code')
    return code === 'ThrottlingError' ||
      code === 'ProvisionedThroughputExceeded' ||
      code === 'TransactionConflict'
  })
}

/**
 * Detects a missing migration-state table without exposing raw errors.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether the stable error identity denotes resource absence.
 */
function isResourceNotFoundError(error: unknown): boolean {
  return error instanceof ResourceNotFoundException ||
    readErrorName(error) === 'ResourceNotFoundException'
}

/**
 * Detects a safe managed-session state-incarnation drift failure.
 *
 * @param error - Candidate public migration failure.
 * @returns Whether reconciliation proved configuration drift.
 */
function isConfigurationDriftFailure(error: unknown): boolean {
  return error instanceof WorkspaceSearchMigrationFailure &&
    error.code === 'CONFIGURATION_DRIFT'
}

/**
 * Preserves a managed post-transaction guard failure before reconciliation.
 *
 * A durable byte-identical root cannot prove that source or target table
 * incarnations stayed current after commit. Infrastructure failure while
 * running that post-check is therefore ambiguous rather than retry-safe.
 *
 * @param error - Candidate managed transport failure.
 * @returns Stable fail-closed code, or undefined for a raw transaction error.
 */
function readPublicationTransportGuardFailureCode(
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
 * Reads one stable Error name.
 *
 * @param error - Candidate raw error.
 * @returns Stable name or undefined.
 */
function readErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const name: unknown = Reflect.get(error, 'name')
  return typeof name === 'string' ? name : undefined
}

/**
 * Detects an explicit throttling error that proves retryable rejection.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether its stable name denotes throttling.
 */
function isExplicitThrottlingError(error: unknown): boolean {
  const name = readErrorName(error)
  return name === 'ThrottlingException' ||
    name === 'ProvisionedThroughputExceededException' ||
    name === 'RequestLimitExceeded' ||
    name === 'TooManyRequestsException'
}

/**
 * Detects a transport failure whose original request may still commit.
 *
 * @param error - Candidate raw SDK or Node.js transport error.
 * @returns Whether the outcome must remain ambiguous.
 */
function isPotentialNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return isTransientError(
    createSealedPlanningAuthorityAwsErrorClassificationInput(error),
  )
}

/**
 * Copies only fields required by Smithy's retry classifiers.
 *
 * @param error - Raw SDK or Node.js transport error.
 * @param depth - Bounded wrapped-cause depth already copied.
 * @returns Detached secret-free classifier input.
 */
function createSealedPlanningAuthorityAwsErrorClassificationInput(
  error: Error,
  depth = 0,
): SealedPlanningAuthorityAwsErrorClassificationInput {
  const nameValue: unknown = Reflect.get(error, 'name')
  const codeValue: unknown = Reflect.get(error, 'code')
  const metadataValue: unknown = Reflect.get(error, '$metadata')
  const retryableValue: unknown = Reflect.get(error, '$retryable')
  const causeValue: unknown =
    depth <= 10 ? Reflect.get(error, 'cause') : undefined
  const httpStatusCode = readOptionalClassifierNumber(
    metadataValue,
    'httpStatusCode',
  )
  const throttling = readOptionalClassifierBoolean(
    retryableValue,
    'throttling',
  )
  const hasRetryableTrait =
    typeof retryableValue === 'object' && retryableValue !== null
  return {
    name: typeof nameValue === 'string' ? nameValue : '',
    message: '',
    ...(typeof codeValue === 'string' ? { code: codeValue } : {}),
    ...(httpStatusCode === undefined
      ? {}
      : { $metadata: { httpStatusCode } }),
    ...(hasRetryableTrait
      ? {
          $retryable:
            throttling === undefined ? {} : { throttling },
        }
      : {}),
    ...(causeValue instanceof Error
      ? {
          cause:
            createSealedPlanningAuthorityAwsErrorClassificationInput(
              causeValue,
              depth + 1,
            ),
        }
      : {}),
  }
}

/**
 * Reads one optional finite numeric classifier property.
 *
 * @param value - Candidate classifier object.
 * @param property - Exact property name.
 * @returns Finite number or undefined.
 */
function readOptionalClassifierNumber(
  value: unknown,
  property: string,
): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'number' &&
      Number.isFinite(propertyValue)
    ? propertyValue
    : undefined
}

/**
 * Reads one optional Boolean classifier property.
 *
 * @param value - Candidate classifier object.
 * @param property - Exact property name.
 * @returns Boolean or undefined.
 */
function readOptionalClassifierBoolean(
  value: unknown,
  property: string,
): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'boolean'
    ? propertyValue
    : undefined
}

/**
 * Compares two byte arrays without string or object coercion.
 *
 * @param left - First exact byte sequence.
 * @param right - Second exact byte sequence.
 * @returns Whether both byte sequences are identical.
 */
function uint8ArraysEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

/**
 * Returns a detached strict root through its canonical parser.
 *
 * @param root - Exact strict publication root.
 * @returns Detached strict root.
 */
function clonePublicationRoot(
  root: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(root),
  )
}

/**
 * Runs one async adapter boundary and replaces all raw failures.
 *
 * @param operation - Exact validation or AWS operation.
 * @returns Detached successful result.
 */
async function runSealedPlanningAuthorityPublicationBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createSealedPlanningAuthorityPublicationBoundaryFailure(
      readSealedPlanningAuthorityPublicationFailureCode(error),
    )
  }
}

/**
 * Reads a stable safe failure code from one internal or public error.
 *
 * @param error - Arbitrary caught value.
 * @returns Stable fail-closed migration failure code.
 */
function readSealedPlanningAuthorityPublicationFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (
      error instanceof SealedPlanningAuthorityPublicationFailure
    ) {
      return error.code
    }
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : 'INVALID_STATE'
    }
    if (isResourceNotFoundError(error)) return 'CONFIGURATION_DRIFT'
    if (isExplicitThrottlingError(error)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (isPotentialNetworkFailure(error)) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Creates one stable raw-value-free public failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Public migration failure.
 */
function createSealedPlanningAuthorityPublicationBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search sealed planning authority publication failed.',
  )
}

/**
 * Raises one private stable publication failure.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Never returns.
 */
function failSealedPlanningAuthorityPublication(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new SealedPlanningAuthorityPublicationFailure(code)
}
