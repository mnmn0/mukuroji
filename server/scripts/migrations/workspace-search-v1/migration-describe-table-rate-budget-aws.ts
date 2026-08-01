import { types as nodeUtilTypes } from 'node:util'
import {
  GetItemCommand,
  ResourceNotFoundException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  isHexDigest,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationFailureCode,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationDescribeTableScopeBindingDigest,
} from './migration-describe-table-binding'
import {
  type WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointStore,
  type WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  type WorkspaceSearchMigrationDescribeTableRatePolicy,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION,
} from './migration-describe-table-rate-budget'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

const rateCheckpointRecordKind =
  'workspace-search-migration-describe-table-rate-checkpoint'
const rateCheckpointRecordVersion = 1
const rateCheckpointRecordKeyPrefix = 'describe-table-rate-budget/v1'
const maximumCheckpointJsonBytes = 64 * 1024

/** Complete controlled attribute set for one rate-checkpoint state row. */
const rateCheckpointRecordAttributeNames = Object.freeze([
  'checkpointDigest',
  'checkpointFenceToken',
  'checkpointJson',
  'checkpointRevision',
  'checkpointWriteNonce',
  'kind',
  'migrationId',
  'recordKey',
  'recordVersion',
  'scopeBindingDigest',
  'stateTableLocationBindingDigest',
])

/**
 * Narrow migration-state transport used by the production rate-budget store.
 */
export interface WorkspaceSearchMigrationDescribeTableRateCheckpointAwsTransport {
  /**
   * Strongly reads one exact rate-checkpoint row.
   *
   * @param command - Adapter-owned deterministic GetItem command.
   * @returns Raw low-level DynamoDB output.
   */
  getRateCheckpoint(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Transactionally replaces one exact rate-checkpoint row.
   *
   * @param command - Adapter-owned single-Put transaction command.
   * @returns Raw low-level DynamoDB output.
   */
  transactWriteRateCheckpoint(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Strict requested location available before the first DescribeTable call.
 */
export type WorkspaceSearchMigrationDescribeTableRateCheckpointRequestedBinding = {
  /** Exact twelve-digit AWS account owning the shared rate scope. */
  readonly account: string
  /** Exact AWS region owning the shared rate scope. */
  readonly region: string
  /**
   * Requested physical migration-state table used as the only location
   * binding. Replacing it loses the row and requires explicit bootstrap or
   * recovery authority from the lifecycle caller.
   */
  readonly tableName: string
}

/**
 * Requested location and narrow transport used to create the AWS store.
 */
export type CreateWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStoreInput = {
  /** Strict location and account/region scope known before measurement. */
  readonly binding:
    WorkspaceSearchMigrationDescribeTableRateCheckpointRequestedBinding
  /** Narrow low-level DynamoDB transport. */
  readonly transport:
    WorkspaceSearchMigrationDescribeTableRateCheckpointAwsTransport
}

/**
 * Detached requested location retained without exposing it in failures.
 *
 * This adapter deliberately cannot bind a measured TableId because its first
 * fence-zero DescribeTable call must already consume durable rate capacity.
 * Deleting or replacing this table therefore loses the ledger; an absent row
 * must be handled only by an explicit lifecycle bootstrap or recovery choice.
 */
type PreparedRateCheckpointLocation = {
  /** Exact physical migration-state table name. */
  readonly tableName: string
  /** Digest binding durable material only to its requested table location. */
  readonly locationBindingDigest: string
  /** Canonical account/region scope accepted by every store operation. */
  readonly scopeBindingDigest: string
}

/**
 * Captured transport functions immune to later caller property replacement.
 */
type PreparedRateCheckpointTransport = {
  /** Strongly reads one adapter-owned key. */
  readonly get: (
    command: GetItemCommand,
  ) => Promise<GetItemCommandOutput>
  /** Conditionally stores one adapter-owned row. */
  readonly transactWrite: (
    command: TransactWriteItemsCommand,
  ) => Promise<TransactWriteItemsCommandOutput>
}

/**
 * Strict checkpoint plus its exact canonical durable representation.
 */
type PreparedRateCheckpoint = {
  /** Detached exact checkpoint accepted by the rate lifecycle. */
  readonly checkpoint:
    WorkspaceSearchMigrationDescribeTableRateCheckpoint
  /** Canonical JSON text stored in the single state row. */
  readonly checkpointJson: string
  /** Domain-separated digest of the exact checkpoint and table binding. */
  readonly checkpointDigest: string
}

/**
 * Strict current row retained for an exact-predecessor conditional update.
 */
type LoadedRateCheckpointRecord = PreparedRateCheckpoint & {
  /** Deterministic sort key read from the validated state row. */
  readonly recordKey: string
}

/**
 * Fully detached exact CAS request ready for DynamoDB command construction.
 */
type PreparedRateCheckpointWrite = PreparedRateCheckpoint & {
  /** Opaque canonical account/region binding. */
  readonly scopeBindingDigest: string
  /** Exact predecessor revision or null for bootstrap. */
  readonly expectedRevision: number | null
}

/**
 * Stable private failure used inside the raw-value-free AWS boundary.
 */
class DescribeTableRateCheckpointAwsFailure extends Error {
  /** Stable migration failure code without resource or operator material. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one private stable failure.
   *
   * @param code - Raw-value-free failure classification.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'DescribeTableRateCheckpointAwsFailure'
    this.code = code
  }
}

/**
 * Creates a durable single-row checkpoint store before any measured table
 * identity exists.
 *
 * The requested table name is the only durable-location binding. If that table
 * is deleted or replaced, the checkpoint is lost with it; callers must observe
 * the absent row and make an explicit lifecycle bootstrap/recovery decision.
 * The store never creates a replacement checkpoint during `load`.
 *
 * @param input - Strict requested account, region, table, and transport.
 * @returns Durable strongly read, exact-predecessor CAS checkpoint store.
 */
export function createWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStore(
  input:
    CreateWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStoreInput,
): WorkspaceSearchMigrationDescribeTableRateCheckpointStore {
  return runRateCheckpointConstructionBoundary(() => {
    const prepared = prepareStoreInput(input)
    const store: WorkspaceSearchMigrationDescribeTableRateCheckpointStore =
      Object.freeze({
        load: async (scopeBindingDigest: string) =>
          await runRateCheckpointAwsBoundary(async () => {
            const scope = requireDigest(
              scopeBindingDigest,
              'INVALID_ARGUMENT',
            )
            if (scope !== prepared.location.scopeBindingDigest) {
              return failRateCheckpointAws('INVALID_ARGUMENT')
            }
            const loaded = await loadRateCheckpointRecord(
              prepared.location,
              prepared.transport,
              scope,
            )
            return loaded?.checkpoint
          }),
        compareAndSwap: async (
          write: WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
        ) =>
          await runRateCheckpointAwsBoundary(async () =>
            await compareAndSwapRateCheckpoint(
              prepared.location,
              prepared.transport,
              prepareRateCheckpointWrite(
                write,
                prepared.location.locationBindingDigest,
                prepared.location.scopeBindingDigest,
              ),
            )),
      })
    return store
  })
}

/**
 * Performs one exact-predecessor checkpoint compare-and-swap.
 *
 * @param location - Validated requested state-table location.
 * @param transport - Captured low-level DynamoDB transport.
 * @param write - Detached strict CAS request.
 * @returns Stored on success or conflict when the predecessor changed.
 */
async function compareAndSwapRateCheckpoint(
  location: PreparedRateCheckpointLocation,
  transport: PreparedRateCheckpointTransport,
  write: PreparedRateCheckpointWrite,
): Promise<'stored' | 'conflict'> {
  let predecessor: LoadedRateCheckpointRecord | undefined
  if (write.expectedRevision !== null) {
    predecessor = await loadRateCheckpointRecord(
      location,
      transport,
      write.scopeBindingDigest,
    )
    if (
      predecessor === undefined ||
      predecessor.checkpoint.revision !== write.expectedRevision ||
      predecessor.checkpoint.fenceToken > write.checkpoint.fenceToken
    ) {
      return 'conflict'
    }
    requireStableLedgerBinding(predecessor.checkpoint, write.checkpoint)
  }

  const command = createRateCheckpointTransactionCommand(
    location,
    write,
    predecessor,
  )
  try {
    await transport.transactWrite(command)
    return 'stored'
  } catch (error: unknown) {
    if (isConditionalTransactionConflict(error)) return 'conflict'
    throw error
  }
}

/**
 * Strongly reads and strictly validates one deterministic state row.
 *
 * @param location - Validated requested state-table location.
 * @param transport - Captured low-level DynamoDB transport.
 * @param scopeBindingDigest - Opaque canonical account/region binding.
 * @returns Strict row or undefined only when the exact key is absent.
 */
async function loadRateCheckpointRecord(
  location: PreparedRateCheckpointLocation,
  transport: PreparedRateCheckpointTransport,
  scopeBindingDigest: string,
): Promise<LoadedRateCheckpointRecord | undefined> {
  const recordKey = createRateCheckpointRecordKey(
    location.locationBindingDigest,
    scopeBindingDigest,
  )
  const output = await transport.get(new GetItemCommand({
    TableName: location.tableName,
    ConsistentRead: true,
    Key: createRateCheckpointPrimaryKey(recordKey),
  }))
  const item = readOptionalOutputItem(output)
  if (item === undefined) return undefined
  return parseRateCheckpointRecord(
    item,
    location.locationBindingDigest,
    scopeBindingDigest,
    recordKey,
  )
}

/**
 * Creates the exact absent-create or predecessor-bound update command.
 *
 * @param location - Validated requested state-table location.
 * @param write - Detached strict successor write.
 * @param predecessor - Strict current row for an update, when present.
 * @returns Transaction command containing exactly one conditional Put.
 */
function createRateCheckpointTransactionCommand(
  location: PreparedRateCheckpointLocation,
  write: PreparedRateCheckpointWrite,
  predecessor: LoadedRateCheckpointRecord | undefined,
): TransactWriteItemsCommand {
  const recordKey = createRateCheckpointRecordKey(
    location.locationBindingDigest,
    write.scopeBindingDigest,
  )
  const item = createRateCheckpointItem(
    location.locationBindingDigest,
    write,
    recordKey,
  )
  if (write.expectedRevision === null) {
    return new TransactWriteItemsCommand({
      TransactItems: [{
        Put: {
          TableName: location.tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(#migrationId) AND ' +
            'attribute_not_exists(#recordKey)',
          ExpressionAttributeNames: {
            '#migrationId': 'migrationId',
            '#recordKey': 'recordKey',
          },
          ReturnValuesOnConditionCheckFailure: 'NONE',
        },
      }],
    })
  }
  if (predecessor === undefined) {
    return failRateCheckpointAws('INVALID_STATE')
  }
  return new TransactWriteItemsCommand({
    TransactItems: [{
      Put: {
        TableName: location.tableName,
        Item: item,
        ConditionExpression: [
          '#migrationId = :migrationId',
          '#recordKey = :recordKey',
          '#kind = :kind',
          '#recordVersion = :recordVersion',
          '#stateTableLocationBindingDigest = :stateTableLocationBindingDigest',
          '#scopeBindingDigest = :scopeBindingDigest',
          '#checkpointRevision = :expectedRevision',
          '#checkpointFenceToken <= :successorFenceToken',
          '#checkpointDigest = :expectedCheckpointDigest',
        ].join(' AND '),
        ExpressionAttributeNames: {
          '#checkpointDigest': 'checkpointDigest',
          '#checkpointFenceToken': 'checkpointFenceToken',
          '#checkpointRevision': 'checkpointRevision',
          '#kind': 'kind',
          '#migrationId': 'migrationId',
          '#recordKey': 'recordKey',
          '#recordVersion': 'recordVersion',
          '#scopeBindingDigest': 'scopeBindingDigest',
          '#stateTableLocationBindingDigest':
            'stateTableLocationBindingDigest',
        },
        ExpressionAttributeValues: {
          ':expectedCheckpointDigest': {
            S: predecessor.checkpointDigest,
          },
          ':expectedRevision': { N: String(write.expectedRevision) },
          ':kind': { S: rateCheckpointRecordKind },
          ':migrationId': { S: WORKSPACE_SEARCH_MIGRATION_ID },
          ':recordKey': { S: predecessor.recordKey },
          ':recordVersion': { N: String(rateCheckpointRecordVersion) },
          ':scopeBindingDigest': { S: write.scopeBindingDigest },
          ':stateTableLocationBindingDigest': {
            S: location.locationBindingDigest,
          },
          ':successorFenceToken': {
            N: String(write.checkpoint.fenceToken),
          },
        },
        ReturnValuesOnConditionCheckFailure: 'NONE',
      },
    }],
  })
}

/**
 * Creates one complete canonical low-level state row.
 *
 * @param stateTableLocationBindingDigest - Requested table-name binding.
 * @param write - Strict successor checkpoint material.
 * @param recordKey - Deterministic exact sort key.
 * @returns Complete controlled low-level DynamoDB item.
 */
function createRateCheckpointItem(
  stateTableLocationBindingDigest: string,
  write: PreparedRateCheckpointWrite,
  recordKey: string,
): Readonly<Record<string, AttributeValue>> {
  const item = {
    checkpointDigest: { S: write.checkpointDigest },
    checkpointFenceToken: {
      N: String(write.checkpoint.fenceToken),
    },
    checkpointJson: { S: write.checkpointJson },
    checkpointRevision: { N: String(write.checkpoint.revision) },
    checkpointWriteNonce: { S: write.checkpoint.writeNonce },
    kind: { S: rateCheckpointRecordKind },
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
    recordVersion: { N: String(rateCheckpointRecordVersion) },
    scopeBindingDigest: { S: write.scopeBindingDigest },
    stateTableLocationBindingDigest: {
      S: stateTableLocationBindingDigest,
    },
  } satisfies Readonly<Record<string, AttributeValue>>
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Strictly parses one complete low-level checkpoint row.
 *
 * @param item - Detached canonical low-level item.
 * @param stateTableLocationBindingDigest - Expected table-name binding.
 * @param scopeBindingDigest - Expected opaque account/region binding.
 * @param recordKey - Expected deterministic sort key.
 * @returns Strict checkpoint row with its exact predecessor digest.
 */
function parseRateCheckpointRecord(
  item: Readonly<Record<string, AttributeValue>>,
  stateTableLocationBindingDigest: string,
  scopeBindingDigest: string,
  recordKey: string,
): LoadedRateCheckpointRecord {
  requireExactAttributeKeys(item, rateCheckpointRecordAttributeNames)
  const checkpointJson = readStringAttribute(item, 'checkpointJson')
  if (
    new TextEncoder().encode(checkpointJson).byteLength >
      maximumCheckpointJsonBytes
  ) {
    return failRateCheckpointAws('INVALID_STATE')
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(checkpointJson)
  } catch {
    return failRateCheckpointAws('INVALID_STATE')
  }
  const checkpoint = parseRateCheckpoint(
    candidate,
    scopeBindingDigest,
    'INVALID_STATE',
  )
  const prepared = prepareRateCheckpoint(
    checkpoint,
    stateTableLocationBindingDigest,
    'INVALID_STATE',
  )
  const checkpointDigest = readDigestAttribute(
    item,
    'checkpointDigest',
  )
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !== recordKey ||
    readStringAttribute(item, 'kind') !== rateCheckpointRecordKind ||
    readNumberAttribute(item, 'recordVersion') !==
      rateCheckpointRecordVersion ||
    readStringAttribute(item, 'stateTableLocationBindingDigest') !==
      stateTableLocationBindingDigest ||
    readStringAttribute(item, 'scopeBindingDigest') !==
      scopeBindingDigest ||
    readNumberAttribute(item, 'checkpointRevision') !==
      checkpoint.revision ||
    readNumberAttribute(item, 'checkpointFenceToken') !==
      checkpoint.fenceToken ||
    readStringAttribute(item, 'checkpointWriteNonce') !==
      checkpoint.writeNonce ||
    checkpointJson !== prepared.checkpointJson ||
    checkpointDigest !== prepared.checkpointDigest
  ) {
    return failRateCheckpointAws('INVALID_STATE')
  }
  return Object.freeze({
    ...prepared,
    recordKey,
  })
}

/**
 * Validates and detaches the exact store factory input.
 *
 * @param input - Candidate requested binding and transport.
 * @returns Stable requested location and captured transport material.
 */
function prepareStoreInput(
  input:
    CreateWorkspaceSearchMigrationDescribeTableRateCheckpointAwsStoreInput,
): {
  /** Detached exact requested migration-state location. */
  readonly location: PreparedRateCheckpointLocation
  /** Captured stable transport functions. */
  readonly transport: PreparedRateCheckpointTransport
} {
  const guards = createRateCheckpointGuards('INVALID_ARGUMENT')
  const record = requirePlainExactRecord(
    guards,
    input,
    ['binding', 'transport'],
    'INVALID_ARGUMENT',
  )
  return Object.freeze({
    location: prepareRequestedBinding(
      guards.readOwn(record, 'binding'),
    ),
    transport: prepareTransport(
      guards.readOwn(record, 'transport'),
    ),
  })
}

/**
 * Validates the requested account, region, and durable table location.
 *
 * @param value - Candidate requested binding available before measurement.
 * @returns Exact table location and canonical account/region scope.
 */
function prepareRequestedBinding(
  value: unknown,
): PreparedRateCheckpointLocation {
  const guards = createRateCheckpointGuards('INVALID_ARGUMENT')
  const record = requirePlainExactRecord(
    guards,
    value,
    ['account', 'region', 'tableName'],
    'INVALID_ARGUMENT',
  )
  const account = guards.readOwn(record, 'account')
  const region = guards.readOwn(record, 'region')
  const tableName = guards.readOwn(record, 'tableName')
  if (
    typeof account !== 'string' ||
    !/^\d{12}$/u.test(account) ||
    typeof region !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(region) ||
    typeof tableName !== 'string' ||
    tableName.length < 3 ||
    tableName.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(tableName)
  ) {
    return failRateCheckpointAws('INVALID_ARGUMENT')
  }
  return Object.freeze({
    tableName,
    locationBindingDigest: createMigrationDigest({
      kind: 'workspace-search-migration-state-table-location-binding',
      version: rateCheckpointRecordVersion,
      tableName,
    }),
    scopeBindingDigest:
      createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
        account,
        region,
      ),
  })
}

/**
 * Captures the two narrow transport operations once.
 *
 * @param value - Candidate low-level transport.
 * @returns Stable bound operation functions.
 */
function prepareTransport(
  value: unknown,
): PreparedRateCheckpointTransport {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failRateCheckpointAws('INVALID_ARGUMENT')
  }
  try {
    const getRateCheckpoint: unknown = Reflect.get(
      value,
      'getRateCheckpoint',
    )
    const transactWriteRateCheckpoint: unknown = Reflect.get(
      value,
      'transactWriteRateCheckpoint',
    )
    if (
      typeof getRateCheckpoint !== 'function' ||
      typeof transactWriteRateCheckpoint !== 'function'
    ) {
      return failRateCheckpointAws('INVALID_ARGUMENT')
    }
    return Object.freeze({
      get: (command: GetItemCommand) =>
        Reflect.apply(getRateCheckpoint, value, [command]),
      transactWrite: (command: TransactWriteItemsCommand) =>
        Reflect.apply(transactWriteRateCheckpoint, value, [command]),
    })
  } catch {
    return failRateCheckpointAws('INVALID_ARGUMENT')
  }
}

/**
 * Validates one exact-predecessor write and detaches its checkpoint.
 *
 * @param write - Candidate store CAS request.
 * @param stateTableLocationBindingDigest - Requested table-name binding.
 * @param expectedScopeBindingDigest - Canonical requested account/region scope.
 * @returns Detached strict write material.
 */
function prepareRateCheckpointWrite(
  write: WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  stateTableLocationBindingDigest: string,
  expectedScopeBindingDigest: string,
): PreparedRateCheckpointWrite {
  const guards = createRateCheckpointGuards('INVALID_ARGUMENT')
  const record = guards.requireRecord(write)
  guards.requireExactKeys(record, [
    'checkpoint',
    'expectedRevision',
    'scopeBindingDigest',
  ])
  const scopeBindingDigest = requireDigest(
    guards.readOwn(record, 'scopeBindingDigest'),
    'INVALID_ARGUMENT',
  )
  if (scopeBindingDigest !== expectedScopeBindingDigest) {
    return failRateCheckpointAws('INVALID_ARGUMENT')
  }
  const expectedRevision = guards.readOwn(record, 'expectedRevision')
  if (
    expectedRevision !== null &&
    !isNonNegativeSafeInteger(expectedRevision)
  ) {
    return failRateCheckpointAws('INVALID_ARGUMENT')
  }
  const checkpoint = parseRateCheckpoint(
    guards.readOwn(record, 'checkpoint'),
    scopeBindingDigest,
    'INVALID_ARGUMENT',
  )
  if (
    expectedRevision === null
      ? checkpoint.revision !== 0
      : expectedRevision === Number.MAX_SAFE_INTEGER ||
        checkpoint.revision !== expectedRevision + 1
  ) {
    return failRateCheckpointAws('INVALID_ARGUMENT')
  }
  return Object.freeze({
    ...prepareRateCheckpoint(
      checkpoint,
      stateTableLocationBindingDigest,
      'INVALID_ARGUMENT',
    ),
    expectedRevision,
    scopeBindingDigest,
  })
}

/**
 * Produces the canonical JSON and domain-separated checkpoint digest.
 *
 * @param checkpoint - Already strict detached checkpoint.
 * @param stateTableLocationBindingDigest - Requested table-name binding.
 * @param code - Stable failure code for serialization errors.
 * @returns Strict checkpoint and canonical durable material.
 */
function prepareRateCheckpoint(
  checkpoint: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  stateTableLocationBindingDigest: string,
  code: WorkspaceSearchMigrationFailureCode,
): PreparedRateCheckpoint {
  try {
    const checkpointJson = JSON.stringify(checkpoint)
    if (
      typeof checkpointJson !== 'string' ||
      new TextEncoder().encode(checkpointJson).byteLength >
        maximumCheckpointJsonBytes
    ) {
      return failRateCheckpointAws(code)
    }
    return Object.freeze({
      checkpoint,
      checkpointJson,
      checkpointDigest: createMigrationDigest({
        kind: rateCheckpointRecordKind,
        version: rateCheckpointRecordVersion,
        stateTableLocationBindingDigest,
        checkpoint,
      }),
    })
  } catch {
    return failRateCheckpointAws(code)
  }
}

/**
 * Parses and detaches one exact-shape rate checkpoint.
 *
 * @param value - Candidate untrusted checkpoint.
 * @param expectedScopeBindingDigest - Exact scope selected by the row key.
 * @param code - Stable failure classification.
 * @returns Detached strict checkpoint.
 */
function parseRateCheckpoint(
  value: unknown,
  expectedScopeBindingDigest: string,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationDescribeTableRateCheckpoint {
  const guards = createRateCheckpointGuards(code)
  const record = requirePlainExactRecord(guards, value, [
    'attemptCount',
    'attemptInFlight',
    'attemptInFlightNonce',
    'budgetStopCount',
    'cadenceWaitCount',
    'cadenceWaitMilliseconds',
    'capturedAtEpochMilliseconds',
    'fenceToken',
    'forfeitedAttemptCount',
    'mandatoryCleanupRequired',
    'maximumInFlight',
    'policy',
    'reservationKind',
    'reservedAttempts',
    'revision',
    'scopeBindingDigest',
    'sequence',
    'throttleCount',
    'transportBindingDigest',
    'version',
    'writeNonce',
  ], code)
  const version = guards.readOwn(record, 'version')
  const scopeBindingDigest = requireDigest(
    guards.readOwn(record, 'scopeBindingDigest'),
    code,
  )
  const transportBindingDigest = requireDigest(
    guards.readOwn(record, 'transportBindingDigest'),
    code,
  )
  const policy = parseRatePolicy(guards.readOwn(record, 'policy'), code)
  const revision = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'revision'),
    code,
  )
  const fenceToken = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'fenceToken'),
    code,
  )
  const writeNonce = requireDigest(
    guards.readOwn(record, 'writeNonce'),
    code,
  )
  const capturedAtEpochMilliseconds = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'capturedAtEpochMilliseconds'),
    code,
  )
  const attemptCount = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'attemptCount'),
    code,
  )
  const forfeitedAttemptCount = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'forfeitedAttemptCount'),
    code,
  )
  const reservedAttempts = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'reservedAttempts'),
    code,
  )
  const reservationKind = guards.readOwn(record, 'reservationKind')
  const mandatoryCleanupRequired = guards.readOwn(
    record,
    'mandatoryCleanupRequired',
  )
  const attemptInFlight = guards.readOwn(record, 'attemptInFlight')
  const rawAttemptInFlightNonce = guards.readOwn(
    record,
    'attemptInFlightNonce',
  )
  const sequence = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'sequence'),
    code,
  )
  const throttleCount = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'throttleCount'),
    code,
  )
  const budgetStopCount = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'budgetStopCount'),
    code,
  )
  const cadenceWaitCount = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'cadenceWaitCount'),
    code,
  )
  const cadenceWaitMilliseconds = requireNonNegativeSafeInteger(
    guards.readOwn(record, 'cadenceWaitMilliseconds'),
    code,
  )
  const maximumInFlight = guards.readOwn(record, 'maximumInFlight')
  let attemptInFlightNonce: string | null
  if (attemptInFlight === true) {
    attemptInFlightNonce = requireDigest(rawAttemptInFlightNonce, code)
  } else if (
    attemptInFlight === false &&
    rawAttemptInFlightNonce === null
  ) {
    attemptInFlightNonce = null
  } else {
    return failRateCheckpointAws(code)
  }
  if (
    version !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION ||
    scopeBindingDigest !== expectedScopeBindingDigest ||
    (
      reservationKind !== 'none' &&
      reservationKind !== 'checkpoint-page'
    ) ||
    (
      reservationKind === 'none'
        ? reservedAttempts !== 0
        : reservedAttempts < 1 ||
          reservedAttempts > policy.checkpointPageAttemptCapacity
    ) ||
    typeof mandatoryCleanupRequired !== 'boolean' ||
    sequence !== attemptCount ||
    (maximumInFlight !== 0 && maximumInFlight !== 1) ||
    attemptCount + forfeitedAttemptCount + reservedAttempts >
      policy.maximumAttemptsPerLifecycle
  ) {
    return failRateCheckpointAws(code)
  }
  return Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION,
    scopeBindingDigest,
    transportBindingDigest,
    policy,
    revision,
    fenceToken,
    writeNonce,
    capturedAtEpochMilliseconds,
    attemptCount,
    forfeitedAttemptCount,
    reservedAttempts,
    reservationKind,
    mandatoryCleanupRequired,
    attemptInFlight,
    attemptInFlightNonce,
    sequence,
    throttleCount,
    budgetStopCount,
    cadenceWaitCount,
    cadenceWaitMilliseconds,
    maximumInFlight,
  })
}

/**
 * Parses and validates one complete reviewed rate policy.
 *
 * @param value - Candidate nested policy.
 * @param code - Stable failure classification.
 * @returns Detached strict reviewed policy.
 */
function parseRatePolicy(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  const guards = createRateCheckpointGuards(code)
  const record = requirePlainExactRecord(guards, value, [
    'checkpointPageAttemptCapacity',
    'maximumAdmissionWaitMilliseconds',
    'maximumAttemptsPerLifecycle',
    'maximumAttemptsPerWindow',
    'minimumAttemptIntervalMilliseconds',
    'minimumPageIntervalMilliseconds',
    'policyVersion',
    'throttleBackoffInitialMilliseconds',
    'throttleBackoffMaximumMilliseconds',
    'windowMilliseconds',
  ], code)
  const policyVersion = requireDigest(
    guards.readOwn(record, 'policyVersion'),
    code,
  )
  const maximumAttemptsPerWindow = requirePositiveSafeInteger(
    guards.readOwn(record, 'maximumAttemptsPerWindow'),
    code,
  )
  const maximumAttemptsPerLifecycle = requirePositiveSafeInteger(
    guards.readOwn(record, 'maximumAttemptsPerLifecycle'),
    code,
  )
  const checkpointPageAttemptCapacity = requirePositiveSafeInteger(
    guards.readOwn(record, 'checkpointPageAttemptCapacity'),
    code,
  )
  const windowMilliseconds = requirePositiveSafeInteger(
    guards.readOwn(record, 'windowMilliseconds'),
    code,
  )
  const minimumAttemptIntervalMilliseconds = requirePositiveSafeInteger(
    guards.readOwn(record, 'minimumAttemptIntervalMilliseconds'),
    code,
  )
  const minimumPageIntervalMilliseconds = requirePositiveSafeInteger(
    guards.readOwn(record, 'minimumPageIntervalMilliseconds'),
    code,
  )
  const maximumAdmissionWaitMilliseconds = requirePositiveSafeInteger(
    guards.readOwn(record, 'maximumAdmissionWaitMilliseconds'),
    code,
  )
  const throttleBackoffInitialMilliseconds = requirePositiveSafeInteger(
    guards.readOwn(record, 'throttleBackoffInitialMilliseconds'),
    code,
  )
  const throttleBackoffMaximumMilliseconds = requirePositiveSafeInteger(
    guards.readOwn(record, 'throttleBackoffMaximumMilliseconds'),
    code,
  )
  if (
    maximumAttemptsPerLifecycle <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS ||
    checkpointPageAttemptCapacity <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS ||
    checkpointPageAttemptCapacity > maximumAttemptsPerLifecycle ||
    maximumAttemptsPerLifecycle - checkpointPageAttemptCapacity <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS ||
    checkpointPageAttemptCapacity > maximumAttemptsPerWindow ||
    throttleBackoffInitialMilliseconds >
      throttleBackoffMaximumMilliseconds
  ) {
    return failRateCheckpointAws(code)
  }
  return Object.freeze({
    policyVersion,
    maximumAttemptsPerWindow,
    maximumAttemptsPerLifecycle,
    checkpointPageAttemptCapacity,
    windowMilliseconds,
    minimumAttemptIntervalMilliseconds,
    minimumPageIntervalMilliseconds,
    maximumAdmissionWaitMilliseconds,
    throttleBackoffInitialMilliseconds,
    throttleBackoffMaximumMilliseconds,
  })
}

/**
 * Requires a plain exact-key object before any nested property is trusted.
 *
 * @param guards - Stable consumer-owned strict record guards.
 * @param value - Candidate untrusted object.
 * @param keys - Complete expected enumerable data-property set.
 * @param code - Stable failure classification.
 * @returns Strict ordinary record.
 */
function requirePlainExactRecord(
  guards: WorkspaceSearchMigrationStrictRecordGuards,
  value: unknown,
  keys: readonly string[],
  code: WorkspaceSearchMigrationFailureCode,
): object {
  const record = guards.requireRecord(value)
  if (Object.getPrototypeOf(record) !== Object.prototype) {
    return failRateCheckpointAws(code)
  }
  guards.requireExactKeys(record, keys)
  return record
}

/**
 * Requires one conventional lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param code - Stable failure classification.
 * @returns Exact validated digest.
 */
function requireDigest(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  if (!isHexDigest(value)) return failRateCheckpointAws(code)
  return value
}

/**
 * Requires one non-negative safe integer.
 *
 * @param value - Candidate scalar.
 * @param code - Stable failure classification.
 * @returns Exact validated integer.
 */
function requireNonNegativeSafeInteger(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): number {
  if (!isNonNegativeSafeInteger(value)) {
    return failRateCheckpointAws(code)
  }
  return value
}

/**
 * Requires one positive safe integer.
 *
 * @param value - Candidate scalar.
 * @param code - Stable failure classification.
 * @returns Exact validated integer.
 */
function requirePositiveSafeInteger(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failRateCheckpointAws(code)
  }
  return value
}

/**
 * Narrows one scalar to a non-negative safe integer.
 *
 * @param value - Candidate scalar.
 * @returns Whether the scalar is a non-negative safe integer.
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
}

/**
 * Rejects updates that attempt to change one ledger's policy or transport.
 *
 * @param predecessor - Strict current checkpoint.
 * @param successor - Strict requested successor checkpoint.
 */
function requireStableLedgerBinding(
  predecessor: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  successor: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
): void {
  if (
    predecessor.scopeBindingDigest !== successor.scopeBindingDigest ||
    predecessor.transportBindingDigest !==
      successor.transportBindingDigest ||
    JSON.stringify(predecessor.policy) !== JSON.stringify(successor.policy)
  ) {
    return failRateCheckpointAws('INVALID_ARGUMENT')
  }
}

/**
 * Creates the deterministic opaque sort key for one table and rate scope.
 *
 * @param stateTableLocationBindingDigest - Requested table-name binding.
 * @param scopeBindingDigest - Opaque account/region ledger binding.
 * @returns Content-independent deterministic state-row sort key.
 */
function createRateCheckpointRecordKey(
  stateTableLocationBindingDigest: string,
  scopeBindingDigest: string,
): string {
  const bindingDigest = createMigrationDigest({
    kind: 'workspace-search-describe-table-rate-checkpoint-key',
    version: rateCheckpointRecordVersion,
    stateTableLocationBindingDigest,
    scopeBindingDigest,
  })
  return `${rateCheckpointRecordKeyPrefix}/${bindingDigest}`
}

/**
 * Creates the exact low-level migration-state primary key.
 *
 * @param recordKey - Deterministic checkpoint sort key.
 * @returns Detached low-level DynamoDB key.
 */
function createRateCheckpointPrimaryKey(
  recordKey: string,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: recordKey },
  }
}

/**
 * Reads an optional low-level Item without invoking caller accessors.
 *
 * @param output - Raw GetItem output.
 * @returns Detached canonical item or undefined when absent.
 */
function readOptionalOutputItem(
  output: unknown,
): Readonly<Record<string, AttributeValue>> | undefined {
  if (
    typeof output !== 'object' ||
    output === null ||
    nodeUtilTypes.isProxy(output)
  ) {
    return failRateCheckpointAws('INVALID_STATE')
  }
  const descriptor = Object.getOwnPropertyDescriptor(output, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failRateCheckpointAws('INVALID_STATE')
  }
  try {
    const item = decodeAttributeMap(
      encodeUnknownAttributeMap(descriptor.value),
    )
    validateDynamoDbItemSize(item)
    return item
  } catch {
    return failRateCheckpointAws('INVALID_STATE')
  }
}

/**
 * Requires the exact controlled DynamoDB attribute-name set.
 *
 * @param item - Candidate detached low-level item.
 * @param expected - Complete controlled attribute names.
 */
function requireExactAttributeKeys(
  item: Readonly<Record<string, AttributeValue>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(item).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    return failRateCheckpointAws('INVALID_STATE')
  }
}

/**
 * Reads one exact single-string DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
 * @returns Exact string scalar.
 */
function readStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const guards = createRateCheckpointGuards('INVALID_STATE')
  const attribute = guards.requireRecord(guards.readOwn(item, name))
  guards.requireExactKeys(attribute, ['S'])
  const value = guards.readOwn(attribute, 'S')
  if (typeof value !== 'string') {
    return failRateCheckpointAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads one conventional digest string DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
 * @returns Exact validated digest.
 */
function readDigestAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  return requireDigest(
    readStringAttribute(item, name),
    'INVALID_STATE',
  )
}

/**
 * Reads one exact non-negative safe integer DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
 * @returns Exact validated integer.
 */
function readNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const guards = createRateCheckpointGuards('INVALID_STATE')
  const attribute = guards.requireRecord(guards.readOwn(item, name))
  guards.requireExactKeys(attribute, ['N'])
  const raw = guards.readOwn(attribute, 'N')
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    return failRateCheckpointAws('INVALID_STATE')
  }
  const value = Number(raw)
  return requireNonNegativeSafeInteger(value, 'INVALID_STATE')
}

/**
 * Creates strict record guards bound to one stable private failure.
 *
 * @param code - Failure classification for every guard rejection.
 * @returns Consumer-bound strict record guards.
 */
function createRateCheckpointGuards(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationStrictRecordGuards {
  return new WorkspaceSearchMigrationStrictRecordGuards(
    () => failRateCheckpointAws(code),
  )
}

/**
 * Checks whether the one-item transaction lost its Put condition.
 *
 * @param error - Arbitrary caught transport failure.
 * @returns Whether item zero reports exactly ConditionalCheckFailed.
 */
function isConditionalTransactionConflict(error: unknown): boolean {
  if (
    readErrorName(error) !== 'TransactionCanceledException' ||
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) {
    return false
  }
  try {
    const reasons: unknown = Reflect.get(error, 'CancellationReasons')
    if (!Array.isArray(reasons) || reasons.length !== 1) return false
    const reason: unknown = reasons[0]
    if (
      typeof reason !== 'object' ||
      reason === null ||
      nodeUtilTypes.isProxy(reason)
    ) {
      return false
    }
    const code: unknown = Reflect.get(reason, 'Code')
    return code === 'ConditionalCheckFailed'
  } catch {
    return false
  }
}

/**
 * Reads an error name without letting an accessor or Proxy escape.
 *
 * @param error - Arbitrary caught value.
 * @returns Safe error name or undefined.
 */
function readErrorName(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    nodeUtilTypes.isProxy(error)
  ) {
    return undefined
  }
  try {
    const name: unknown = Reflect.get(error, 'name')
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * Runs one synchronous factory operation behind the safe public boundary.
 *
 * @param operation - Exact validation and construction operation.
 * @returns Constructed durable store.
 */
function runRateCheckpointConstructionBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    throw createRateCheckpointPublicFailure(
      readRateCheckpointFailureCode(error, true),
    )
  }
}

/**
 * Runs one asynchronous store operation behind the safe public boundary.
 *
 * @param operation - Exact validation or low-level AWS operation.
 * @returns Successful operation result.
 */
async function runRateCheckpointAwsBoundary<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createRateCheckpointPublicFailure(
      readRateCheckpointFailureCode(error, false),
    )
  }
}

/**
 * Classifies an internal or raw failure without retaining raw values.
 *
 * @param error - Arbitrary caught value.
 * @param duringConstruction - Whether failure occurred at factory input.
 * @returns Stable resource- and operator-safe migration failure code.
 */
function readRateCheckpointFailureCode(
  error: unknown,
  duringConstruction: boolean,
): WorkspaceSearchMigrationFailureCode {
  if (error instanceof DescribeTableRateCheckpointAwsFailure) {
    return error.code
  }
  if (
    error instanceof ResourceNotFoundException ||
    readErrorName(error) === 'ResourceNotFoundException'
  ) {
    return 'CONFIGURATION_DRIFT'
  }
  return duringConstruction
    ? 'INVALID_ARGUMENT'
    : 'TRANSIENT_INFRASTRUCTURE_FAILURE'
}

/**
 * Creates one fixed failure containing no resource, run, owner, or cursor.
 *
 * @param code - Stable safe migration failure code.
 * @returns Public raw-value-free migration failure.
 */
function createRateCheckpointPublicFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration DescribeTable rate checkpoint storage failed.',
  )
}

/**
 * Raises one stable private failure without retaining a raw cause.
 *
 * @param code - Stable raw-value-free migration failure code.
 * @returns Never returns.
 */
function failRateCheckpointAws(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new DescribeTableRateCheckpointAwsFailure(code)
}
