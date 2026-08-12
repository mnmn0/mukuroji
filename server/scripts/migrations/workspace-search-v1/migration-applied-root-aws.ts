import { types as nodeUtilTypes } from 'node:util'
import {
  GetItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationAppliedRoot,
} from './migration-apply-seal'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'

const appliedRootRecordKind =
  'workspace-search-migration-applied-root-record'
const appliedRootRecordVersion = 1
const appliedRootRecordKeyPrefix = 'apply-seal/v1'

/**
 * Exact admitted-run material that addresses one immutable applied root.
 */
export type WorkspaceSearchMigrationAppliedRootAwsBindingInput = {
  /** Exact measured migration-state table incarnation. */
  readonly stateTable: MigrationTableIdentity
  /** Reviewed digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
}

/**
 * Exact material used to create or condition-check one applied-root row.
 */
export type WorkspaceSearchMigrationAppliedRootAwsRecordInput =
  WorkspaceSearchMigrationAppliedRootAwsBindingInput & {
    /** Exact immutable applied phase root. */
    readonly root: WorkspaceSearchMigrationAppliedRoot
  }

/**
 * Exact material used to strictly parse one low-level applied-root row.
 */
export type ParseWorkspaceSearchMigrationAppliedRootAwsRecordInput =
  WorkspaceSearchMigrationAppliedRootAwsBindingInput & {
    /** Untrusted low-level DynamoDB item returned by a strong read. */
    readonly item: unknown
  }

/**
 * Exact material used to parse one strongly consistent GetItem response.
 */
export type ParseWorkspaceSearchMigrationAppliedRootStrongReadOutputInput =
  WorkspaceSearchMigrationAppliedRootAwsBindingInput & {
    /** Untrusted low-level DynamoDB GetItem response. */
    readonly output: unknown
  }

/**
 * Detached validated addressing material for one admitted execution run.
 */
type PreparedAppliedRootBinding = {
  /** Exact physical migration-state table name. */
  readonly stateTableName: string
  /** Immutable migration-state table incarnation identifier. */
  readonly stateTableId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Operator-selected migration run. */
  readonly runId: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Stable digest used by deterministic apply-state keys. */
  readonly bindingDigest: string
}

/**
 * Canonical applied-root row plus its detached strict domain root.
 */
type PreparedAppliedRootRecord = {
  /** Detached exact admitted-run addressing material. */
  readonly binding: PreparedAppliedRootBinding
  /** Detached strict immutable applied phase root. */
  readonly root: WorkspaceSearchMigrationAppliedRoot
  /** Complete canonical low-level DynamoDB item. */
  readonly item: Readonly<Record<string, AttributeValue>>
}

/**
 * Minimal descriptor-safe migration-state table identity.
 */
type PreparedMigrationStateTable = {
  /** Required migration-state logical role. */
  readonly role: 'migration-state'
  /** Exact physical table name. */
  readonly tableName: string
  /** Immutable physical table incarnation identifier. */
  readonly tableId: string
}

/**
 * Complete controlled field set for immutable applied-root rows.
 */
const appliedRootRecordAttributeNames = Object.freeze([
  'committedAt',
  'configurationHash',
  'executionRunDigest',
  'kind',
  'migrationId',
  'predecessorExecutionStateDigest',
  'predecessorRevision',
  'predecessorRunStateDigest',
  'recordKey',
  'recordVersion',
  'rootBytes',
  'rootDigest',
  'runId',
  'sealContentDigest',
  'stateTableId',
  'status',
  'successorRevision',
  'successorRunStateDigest',
])

/**
 * Stable private failure inside the applied-root AWS boundary.
 */
class AppliedRootAwsFailure extends Error {
  /** Secret-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one raw-value-free private failure.
   *
   * @param code - Stable operator-safe failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'AppliedRootAwsFailure'
    this.code = code
  }
}

/**
 * Creates the stable admitted-run digest used by every apply-state key.
 *
 * @param input - Exact state-table, configuration, and execution admission.
 * @returns Deterministic digest of the immutable apply-run binding.
 */
export function createWorkspaceSearchMigrationApplyRunBindingDigest(
  input: WorkspaceSearchMigrationAppliedRootAwsBindingInput,
): string {
  return atAppliedRootAwsBoundary(
    () => prepareAppliedRootBinding(input).bindingDigest,
    'INVALID_ARGUMENT',
  )
}

/**
 * Creates the deterministic immutable applied-root record key.
 *
 * @param input - Exact state-table, configuration, and execution admission.
 * @returns Content-independent sort key for the admitted run's applied root.
 */
export function createWorkspaceSearchMigrationAppliedRootRecordKey(
  input: WorkspaceSearchMigrationAppliedRootAwsBindingInput,
): string {
  return atAppliedRootAwsBoundary(
    () =>
      createAppliedRootRecordKeyFromBinding(
        prepareAppliedRootBinding(input),
      ),
    'INVALID_ARGUMENT',
  )
}

/**
 * Creates the deterministic immutable applied-root primary key.
 *
 * @param input - Exact state-table, configuration, and execution admission.
 * @returns Detached low-level migration-state table primary key.
 */
export function createWorkspaceSearchMigrationAppliedRootKey(
  input: WorkspaceSearchMigrationAppliedRootAwsBindingInput,
): Readonly<Record<string, AttributeValue>> {
  return atAppliedRootAwsBoundary(
    () =>
      createAppliedRootKeyFromBinding(
        prepareAppliedRootBinding(input),
      ),
    'INVALID_ARGUMENT',
  )
}

/**
 * Creates the deterministic absent immutable applied-root condition.
 *
 * Partial-prefix rollback start uses this guard to lose atomically when
 * complete apply sealing has already published the immutable applied root.
 *
 * @param input - Exact state-table, configuration, and execution admission.
 * @returns One absent-item DynamoDB ConditionCheck for the applied-root key.
 */
export function createWorkspaceSearchMigrationAppliedRootAbsentConditionCheck(
  input: WorkspaceSearchMigrationAppliedRootAwsBindingInput,
): TransactWriteItem {
  return atAppliedRootAwsBoundary(() => {
    const binding = prepareAppliedRootBinding(input)
    return {
      ConditionCheck: {
        TableName: binding.stateTableName,
        Key: createAppliedRootKeyFromBinding(binding),
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
  }, 'INVALID_ARGUMENT')
}

/**
 * Creates the adapter-owned strongly consistent applied-root GetItem command.
 *
 * @param input - Exact state-table, configuration, and execution admission.
 * @returns Strongly consistent deterministic point read.
 */
export function createWorkspaceSearchMigrationAppliedRootStrongReadCommand(
  input: WorkspaceSearchMigrationAppliedRootAwsBindingInput,
): GetItemCommand {
  return atAppliedRootAwsBoundary(() => {
    const binding = prepareAppliedRootBinding(input)
    return new GetItemCommand({
      TableName: binding.stateTableName,
      ConsistentRead: true,
      Key: createAppliedRootKeyFromBinding(binding),
    })
  }, 'INVALID_ARGUMENT')
}

/**
 * Creates the complete canonical immutable applied-root DynamoDB row.
 *
 * This is the single row codec used by publication, later conditions, strict
 * reads, and tests.
 *
 * @param input - Exact admitted-run binding and immutable applied root.
 * @returns Complete canonical low-level applied-root row.
 */
export function createWorkspaceSearchMigrationAppliedRootRecord(
  input: WorkspaceSearchMigrationAppliedRootAwsRecordInput,
): Readonly<Record<string, AttributeValue>> {
  return atAppliedRootAwsBoundary(
    () => prepareAppliedRootRecord(input).item,
    'INVALID_ARGUMENT',
  )
}

/**
 * Strictly parses one complete applied-root DynamoDB row.
 *
 * Unknown, missing, malformed, or cross-run attributes fail closed. The
 * canonical root bytes are parsed and cross-checked against every indexed
 * controlled attribute.
 *
 * @param input - Exact admitted-run binding and untrusted low-level row.
 * @returns Detached strict immutable applied phase root.
 */
export function parseWorkspaceSearchMigrationAppliedRootRecord(
  input: ParseWorkspaceSearchMigrationAppliedRootAwsRecordInput,
): WorkspaceSearchMigrationAppliedRoot {
  return atAppliedRootAwsBoundary(
    () => parseAppliedRootRecordInput(input),
    'INVALID_STATE',
  )
}

/**
 * Parses one response to the adapter-owned strongly consistent point read.
 *
 * @param input - Exact admitted-run binding and untrusted GetItem response.
 * @returns Detached strict applied root, or undefined when the row is absent.
 */
export function parseWorkspaceSearchMigrationAppliedRootStrongReadOutput(
  input: ParseWorkspaceSearchMigrationAppliedRootStrongReadOutputInput,
): WorkspaceSearchMigrationAppliedRoot | undefined {
  return atAppliedRootAwsBoundary(() => {
    const record = requirePlainRecord(input, 'INVALID_STATE')
    requireExactKeys(record, [
      'configurationHash',
      'executionRun',
      'output',
      'stateTable',
    ], 'INVALID_STATE')
    const binding = prepareAppliedRootBindingFromRecord(
      record,
      'INVALID_STATE',
    )
    const item = readOutputItem(
      readOwn(record, 'output', 'INVALID_STATE'),
    )
    return item === undefined
      ? undefined
      : parseAppliedRootRecord(binding, item)
  }, 'INVALID_STATE')
}

/**
 * Creates the exact full-row immutable applied-root condition check.
 *
 * Every controlled non-key attribute is compared, including canonical root
 * bytes, table incarnation, run/configuration binding, seal reference digest,
 * predecessor/successor state, and commit time.
 *
 * @param input - Exact admitted-run binding and immutable applied root.
 * @returns One complete controlled-attribute DynamoDB ConditionCheck.
 */
export function createWorkspaceSearchMigrationAppliedRootConditionCheck(
  input: WorkspaceSearchMigrationAppliedRootAwsRecordInput,
): TransactWriteItem {
  return atAppliedRootAwsBoundary(() => {
    const material = prepareAppliedRootRecord(input)
    const migrationId = material.item.migrationId
    const recordKey = material.item.recordKey
    if (migrationId === undefined || recordKey === undefined) {
      return failAppliedRootAws('INVALID_STATE')
    }
    const names: Record<string, string> = {}
    const values: Record<string, AttributeValue> = {}
    const clauses: string[] = []
    let index = 0
    for (const [name, value] of Object.entries(material.item)) {
      if (name === 'migrationId' || name === 'recordKey') continue
      const nameToken = `#field${index}`
      const valueToken = `:value${index}`
      names[nameToken] = name
      values[valueToken] = value
      clauses.push(`${nameToken} = ${valueToken}`)
      index += 1
    }
    return {
      ConditionCheck: {
        TableName: material.binding.stateTableName,
        Key: {
          migrationId,
          recordKey,
        },
        ConditionExpression: clauses.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValuesOnConditionCheckFailure: 'NONE',
      },
    }
  }, 'INVALID_ARGUMENT')
}

/**
 * Creates one complete canonical applied-root record from strict input.
 *
 * @param input - Candidate record-construction material.
 * @returns Strict root, binding, and canonical row.
 */
function prepareAppliedRootRecord(
  input: WorkspaceSearchMigrationAppliedRootAwsRecordInput,
): PreparedAppliedRootRecord {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'configurationHash',
    'executionRun',
    'root',
    'stateTable',
  ], 'INVALID_ARGUMENT')
  const binding = prepareAppliedRootBindingFromRecord(
    record,
    'INVALID_ARGUMENT',
  )
  const root = detachAppliedRoot(
    readOwn(record, 'root', 'INVALID_ARGUMENT'),
    'INVALID_ARGUMENT',
  )
  requireAppliedRootBinding(binding, root, 'INVALID_STATE')
  const bytes = serializeWorkspaceSearchMigrationAppliedRoot(root)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createAppliedRootRecordKeyFromBinding(binding),
    },
    kind: { S: appliedRootRecordKind },
    recordVersion: { N: String(appliedRootRecordVersion) },
    stateTableId: { S: root.stateTableId },
    configurationHash: { S: root.configurationHash },
    runId: { S: root.runId },
    executionRunDigest: { S: root.executionRunDigest },
    predecessorRevision: {
      N: String(root.predecessorRevision),
    },
    predecessorExecutionStateDigest: {
      S: root.predecessorExecutionStateDigest,
    },
    predecessorRunStateDigest: {
      S: root.predecessorRunStateDigest,
    },
    successorRevision: {
      N: String(root.successorRevision),
    },
    status: { S: root.status },
    successorRunStateDigest: {
      S: root.successorRunStateDigest,
    },
    sealContentDigest: {
      S: root.sealReference.contentDigest,
    },
    committedAt: { S: root.committedAt },
    rootDigest: { S: root.rootDigest },
    rootBytes: { B: bytes },
  }
  validateDynamoDbItemSize(item)
  return { binding, root, item }
}

/**
 * Strictly parses one exported record-parser input.
 *
 * @param input - Candidate binding and raw item.
 * @returns Detached strict immutable applied root.
 */
function parseAppliedRootRecordInput(
  input: ParseWorkspaceSearchMigrationAppliedRootAwsRecordInput,
): WorkspaceSearchMigrationAppliedRoot {
  const record = requirePlainRecord(input, 'INVALID_STATE')
  requireExactKeys(record, [
    'configurationHash',
    'executionRun',
    'item',
    'stateTable',
  ], 'INVALID_STATE')
  const binding = prepareAppliedRootBindingFromRecord(
    record,
    'INVALID_STATE',
  )
  const item = cloneAttributeMap(
    readOwn(record, 'item', 'INVALID_STATE'),
    'INVALID_STATE',
  )
  validateDynamoDbItemSize(item)
  return parseAppliedRootRecord(binding, item)
}

/**
 * Strictly parses and cross-checks one complete durable applied-root item.
 *
 * @param binding - Exact detached admitted-run addressing material.
 * @param item - Detached untrusted low-level DynamoDB item.
 * @returns Detached strict immutable applied root.
 */
function parseAppliedRootRecord(
  binding: PreparedAppliedRootBinding,
  item: Readonly<Record<string, AttributeValue>>,
): WorkspaceSearchMigrationAppliedRoot {
  requireExactAttributeKeys(
    item,
    appliedRootRecordAttributeNames,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(item, 'recordKey') !==
      createAppliedRootRecordKeyFromBinding(binding) ||
    readStringAttribute(item, 'kind') !==
      appliedRootRecordKind ||
    readNumberAttribute(item, 'recordVersion') !==
      appliedRootRecordVersion ||
    readStringAttribute(item, 'stateTableId') !==
      binding.stateTableId ||
    readStringAttribute(item, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(item, 'runId') !== binding.runId ||
    readStringAttribute(item, 'executionRunDigest') !==
      binding.executionRunDigest
  ) {
    return failAppliedRootAws('INVALID_STATE')
  }
  const root = detachAppliedRoot(
    parseWorkspaceSearchMigrationAppliedRoot(
      readBinaryAttribute(item, 'rootBytes'),
    ),
    'INVALID_STATE',
  )
  requireAppliedRootBinding(binding, root, 'INVALID_STATE')
  if (
    readNumberAttribute(item, 'predecessorRevision') !==
      root.predecessorRevision ||
    readStringAttribute(
      item,
      'predecessorExecutionStateDigest',
    ) !== root.predecessorExecutionStateDigest ||
    readStringAttribute(item, 'predecessorRunStateDigest') !==
      root.predecessorRunStateDigest ||
    readNumberAttribute(item, 'successorRevision') !==
      root.successorRevision ||
    readStringAttribute(item, 'status') !== root.status ||
    readStringAttribute(item, 'successorRunStateDigest') !==
      root.successorRunStateDigest ||
    readStringAttribute(item, 'sealContentDigest') !==
      root.sealReference.contentDigest ||
    readStringAttribute(item, 'committedAt') !==
      root.committedAt ||
    readStringAttribute(item, 'rootDigest') !== root.rootDigest
  ) {
    return failAppliedRootAws('INVALID_STATE')
  }
  return root
}

/**
 * Validates and detaches one exported applied-root binding.
 *
 * @param input - Candidate binding input.
 * @returns Detached exact admitted-run addressing material.
 */
function prepareAppliedRootBinding(
  input: WorkspaceSearchMigrationAppliedRootAwsBindingInput,
): PreparedAppliedRootBinding {
  const record = requirePlainRecord(input, 'INVALID_ARGUMENT')
  requireExactKeys(record, [
    'configurationHash',
    'executionRun',
    'stateTable',
  ], 'INVALID_ARGUMENT')
  return prepareAppliedRootBindingFromRecord(
    record,
    'INVALID_ARGUMENT',
  )
}

/**
 * Reads binding fields from one already shape-checked outer record.
 *
 * @param record - Exact outer input record containing binding fields.
 * @param code - Stable failure classification for malformed material.
 * @returns Detached exact admitted-run addressing material.
 */
function prepareAppliedRootBindingFromRecord(
  record: Readonly<Record<string, unknown>>,
  code: WorkspaceSearchMigrationFailureCode,
): PreparedAppliedRootBinding {
  const stateTable = readMigrationStateTable(
    readOwn(record, 'stateTable', code),
    code,
  )
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash', code),
    code,
  )
  const executionRun = detachExecutionRun(
    readOwn(record, 'executionRun', code),
    code,
  )
  const expectedStateTable =
    executionRun.runState.configuration.tables['migration-state']
  if (
    stateTable.tableName !== expectedStateTable.tableName ||
    stateTable.tableId !== expectedStateTable.tableId ||
    executionRun.binding.tableIds['migration-state'] !==
      expectedStateTable.tableId ||
    configurationHash !== executionRun.configurationHash
  ) {
    return failAppliedRootAws('CONFIGURATION_DRIFT')
  }
  const bindingDigest = createMigrationDigest({
    kind: 'workspace-search-apply-run-binding',
    version: appliedRootRecordVersion,
    stateTableId: stateTable.tableId,
    configurationHash,
    runId: executionRun.runId,
    executionRunDigest: executionRun.executionRunDigest,
  })
  return {
    stateTableName: stateTable.tableName,
    stateTableId: stateTable.tableId,
    configurationHash,
    runId: executionRun.runId,
    executionRunDigest: executionRun.executionRunDigest,
    bindingDigest,
  }
}

/**
 * Detaches one strict immutable revision-one execution admission.
 *
 * @param value - Candidate execution-run envelope.
 * @param code - Stable failure classification for malformed material.
 * @returns Detached strict execution-run envelope.
 */
function detachExecutionRun(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRunCandidate(value)) {
    return failAppliedRootAws(code)
  }
  try {
    return parseWorkspaceSearchMigrationExecutionRun(
      serializeWorkspaceSearchMigrationExecutionRun(value),
    )
  } catch {
    return failAppliedRootAws(code)
  }
}

/**
 * Narrows one candidate enough for the strict execution-run codec.
 *
 * @param value - Candidate execution-run value.
 * @returns Whether the discriminator is an own enumerable data property.
 */
function isExecutionRunCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  if (!isPlainRecord(value)) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  return descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value ===
      'workspace-search-migration-execution-run'
}

/**
 * Detaches one strict immutable applied root through its canonical codec.
 *
 * @param value - Candidate applied-root envelope.
 * @param code - Stable failure classification for malformed material.
 * @returns Detached strict immutable applied root.
 */
function detachAppliedRoot(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationAppliedRoot {
  if (!isAppliedRootCandidate(value)) {
    return failAppliedRootAws(code)
  }
  try {
    return parseWorkspaceSearchMigrationAppliedRoot(
      serializeWorkspaceSearchMigrationAppliedRoot(value),
    )
  } catch {
    return failAppliedRootAws(code)
  }
}

/**
 * Narrows one candidate enough for the strict applied-root codec.
 *
 * @param value - Candidate applied-root value.
 * @returns Whether the discriminator is an own enumerable data property.
 */
function isAppliedRootCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationAppliedRoot {
  if (!isPlainRecord(value)) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  return descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value ===
      'workspace-search-migration-applied-root'
}

/**
 * Reads the minimal exact migration-state table incarnation.
 *
 * @param value - Candidate measured table identity.
 * @param code - Stable failure classification for malformed material.
 * @returns Detached exact table name, TableId, and logical role.
 */
function readMigrationStateTable(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): PreparedMigrationStateTable {
  const record = requirePlainRecord(value, code)
  const role = readOwn(record, 'role', code)
  if (role !== 'migration-state') {
    return failAppliedRootAws(code)
  }
  return {
    role,
    tableName: readIdentifier(
      readOwn(record, 'tableName', code),
      code,
    ),
    tableId: readIdentifier(
      readOwn(record, 'tableId', code),
      code,
    ),
  }
}

/**
 * Requires one root to remain in the exact admitted run and table incarnation.
 *
 * @param binding - Exact detached admitted-run addressing material.
 * @param root - Candidate strict immutable applied root.
 * @param code - Stable failure classification for a mismatch.
 */
function requireAppliedRootBinding(
  binding: PreparedAppliedRootBinding,
  root: WorkspaceSearchMigrationAppliedRoot,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  if (
    root.stateTableId !== binding.stateTableId ||
    root.configurationHash !== binding.configurationHash ||
    root.runId !== binding.runId ||
    root.executionRunDigest !== binding.executionRunDigest
  ) {
    return failAppliedRootAws(code)
  }
}

/**
 * Creates the deterministic root sort key from detached validated material.
 *
 * @param binding - Exact detached admitted-run binding.
 * @returns Content-independent applied-root sort key.
 */
function createAppliedRootRecordKeyFromBinding(
  binding: PreparedAppliedRootBinding,
): string {
  return `${appliedRootRecordKeyPrefix}/${binding.bindingDigest}/complete-plan`
}

/**
 * Creates the low-level root key from detached validated material.
 *
 * @param binding - Exact detached admitted-run binding.
 * @returns Detached low-level primary key.
 */
function createAppliedRootKeyFromBinding(
  binding: PreparedAppliedRootBinding,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createAppliedRootRecordKeyFromBinding(binding),
    },
  }
}

/**
 * Reads one optional low-level GetItem result without invoking accessors.
 *
 * @param output - Raw low-level DynamoDB response.
 * @returns Detached exact item or undefined.
 */
function readOutputItem(
  output: unknown,
): Readonly<Record<string, AttributeValue>> | undefined {
  const record = requirePlainRecord(output, 'INVALID_STATE')
  if (
    Reflect.ownKeys(record).some((key) => typeof key === 'symbol')
  ) {
    return failAppliedRootAws('INVALID_STATE')
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failAppliedRootAws('INVALID_STATE')
  }
  const item = cloneAttributeMap(
    descriptor.value,
    'INVALID_STATE',
  )
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Losslessly detaches one low-level DynamoDB attribute map.
 *
 * @param value - Candidate item or key.
 * @param code - Stable failure classification.
 * @returns Detached validated attribute map.
 */
function cloneAttributeMap(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, AttributeValue>> {
  try {
    return decodeAttributeMap(encodeUnknownAttributeMap(value))
  } catch {
    return failAppliedRootAws(code)
  }
}

/**
 * Requires one item to contain exactly the controlled attribute set.
 *
 * @param item - Candidate low-level item.
 * @param expectedKeys - Complete expected attribute names.
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
    return failAppliedRootAws(code)
  }
}

/**
 * Reads one exact single-string DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
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
  if (typeof value !== 'string') {
    return failAppliedRootAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads one exact nonnegative integer DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
 * @returns Exact safe integer.
 */
function readNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const attribute = readOwn(item, name, 'INVALID_STATE')
  const record = requirePlainRecord(attribute, 'INVALID_STATE')
  requireExactKeys(record, ['N'], 'INVALID_STATE')
  const value = readOwn(record, 'N', 'INVALID_STATE')
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    return failAppliedRootAws('INVALID_STATE')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    return failAppliedRootAws('INVALID_STATE')
  }
  return parsed
}

/**
 * Reads one exact nonempty binary DynamoDB attribute.
 *
 * @param item - Strict low-level item.
 * @param name - Required attribute name.
 * @returns Detached exact bytes.
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
    return failAppliedRootAws('INVALID_STATE')
  }
  const copy = new Uint8Array(value)
  if (copy.byteLength === 0) {
    return failAppliedRootAws('INVALID_STATE')
  }
  return copy
}

/**
 * Requires one ordinary non-Proxy record.
 *
 * @param value - Candidate record.
 * @param code - Stable failure classification.
 * @returns Exact ordinary record.
 */
function requirePlainRecord(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return failAppliedRootAws(code)
  }
  return value
}

/**
 * Narrows one ordinary non-Proxy record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is an ordinary string-keyed record.
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
 * Requires an exact enumerable own field set.
 *
 * @param record - Candidate ordinary record.
 * @param expectedKeys - Complete accepted field set.
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
    return failAppliedRootAws(code)
  }
  const actualStrings = Object.keys(record).sort(compareUtf8Ordinal)
  if (
    actualStrings.length !== expected.length ||
    actualStrings.some((key, index) => key !== expected[index])
  ) {
    return failAppliedRootAws(code)
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
 * @returns Exact stored property value.
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
    return failAppliedRootAws(code)
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
    return failAppliedRootAws(code)
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param code - Stable failure classification.
 * @returns Exact lowercase digest.
 */
function readDigest(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): string {
  if (!isHexDigest(value)) return failAppliedRootAws(code)
  return value
}

/**
 * Orders strings by UTF-8 byte order.
 *
 * @param left - Left operand.
 * @param right - Right operand.
 * @returns Negative, zero, or positive ordering value.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * Runs one synchronous public applied-root AWS operation.
 *
 * @param operation - Exact synchronous operation.
 * @param fallbackCode - Stable code for unknown implementation failures.
 * @returns Successful operation result.
 */
function atAppliedRootAwsBoundary<Result>(
  operation: () => Result,
  fallbackCode: WorkspaceSearchMigrationFailureCode,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    const code = error instanceof AppliedRootAwsFailure
      ? error.code
      : error instanceof WorkspaceSearchMigrationFailure &&
          isWorkspaceSearchMigrationFailureCode(error.code)
        ? error.code
        : fallbackCode
    throw new WorkspaceSearchMigrationFailure(
      code,
      'Workspace Search migration applied-root persistence failed.',
    )
  }
}

/**
 * Raises one private stable applied-root AWS failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Never returns.
 */
function failAppliedRootAws(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new AppliedRootAwsFailure(code)
}
