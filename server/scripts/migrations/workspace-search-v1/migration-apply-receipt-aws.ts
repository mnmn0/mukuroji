import { types as nodeUtilTypes } from 'node:util'
import {
  GetItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import {
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchOperationMarker,
  type WorkspaceSearchOperationReceipt,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationApplyRunBindingDigest,
} from './migration-applied-root-aws'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  parseWorkspaceSearchMigrationOperationMarker,
  serializeWorkspaceSearchMigrationOperationMarker,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES,
} from './migration-execution-state'

const applyReceiptRecordVersion = 1
const maximumSafeJsonArrayLength = 4_096
const maximumSafeJsonDepth = 64
const maximumSafeJsonNodes = 10_000
const maximumSafeJsonObjectProperties = 1_024
const operationMarkerRecordKind =
  'workspace-search-migration-apply-operation-marker'
const journalSequenceRecordKind =
  'workspace-search-migration-apply-journal-sequence'
const operationMarkerRecordKeyPrefix = 'apply-operation/v1'
const journalSequenceRecordKeyPrefix =
  'apply-journal-sequence/v1'

/**
 * Exact admitted-run material used to address immutable apply receipts.
 */
export type WorkspaceSearchMigrationApplyReceiptAwsBindingInput = {
  /** Exact measured migration-state table incarnation. */
  readonly stateTable: MigrationTableIdentity
  /** Reviewed digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Exact immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
}

/**
 * Detached strict projection shared by operation-marker receipt rows.
 */
export type WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection = {
  /** Exact canonical no-op or mutating apply receipt. */
  readonly receipt: WorkspaceSearchOperationMarker
  /** Mutable execution-state revision condition-checked by apply. */
  readonly predecessorRevision: number
  /** Mutable execution-state revision committed by apply. */
  readonly successorRevision: number
  /** Digest of the exact successor mutable execution-state envelope. */
  readonly successorExecutionStateDigest: string
  /** Digest of the exact canonical receipt document. */
  readonly markerDigest: string
}

/**
 * Detached strict projection read from a mutation journal-sequence row.
 */
export type WorkspaceSearchMigrationApplySequenceReceiptAwsProjection = {
  /** Exact canonical mutating apply receipt. */
  readonly receipt: WorkspaceSearchOperationReceipt
  /** Mutable execution-state revision condition-checked by apply. */
  readonly predecessorRevision: number
  /** Mutable execution-state revision committed by apply. */
  readonly successorRevision: number
  /** Digest of the exact successor mutable execution-state envelope. */
  readonly successorExecutionStateDigest: string
  /** Digest of the exact canonical receipt document. */
  readonly markerDigest: string
}

/**
 * Fully correlated mutation receipt proven by both immutable apply rows.
 */
export type WorkspaceSearchMigrationCorrelatedApplyReceiptAwsProjection = {
  /** Exact canonical mutating apply receipt shared by both rows. */
  readonly receipt: WorkspaceSearchOperationReceipt
  /** Mutable execution-state revision condition-checked by apply. */
  readonly predecessorRevision: number
  /** Mutable execution-state revision committed by apply. */
  readonly successorRevision: number
  /** Digest of the exact successor mutable execution-state envelope. */
  readonly successorExecutionStateDigest: string
  /** Digest of the exact canonical receipt document. */
  readonly markerDigest: string
}

/**
 * Detached public identity of one admitted apply-receipt namespace.
 */
export type WorkspaceSearchMigrationApplyReceiptAwsBindingIdentity = {
  /** Immutable migration-state table incarnation identifier. */
  readonly stateTableId: string
  /** Reviewed digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Operator-selected admitted migration run identifier. */
  readonly runId: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Official deterministic namespace digest used by apply receipt keys. */
  readonly bindingDigest: string
}

/**
 * Admitted-run-bound read and transaction-guard capability for apply receipts.
 */
export interface WorkspaceSearchMigrationApplyReceiptAwsBinding {
  /**
   * Reads the exact immutable namespace identity retained by this capability.
   *
   * @returns Fresh detached frozen identity using the official key formula.
   */
  readBindingIdentity():
    WorkspaceSearchMigrationApplyReceiptAwsBindingIdentity

  /**
   * Creates a strong read for one deterministic mutation sequence.
   *
   * @param sequence - Exact positive mutation sequence.
   * @returns Adapter-owned strongly consistent point-read command.
   */
  createJournalSequenceStrongReadCommand(
    sequence: number,
  ): GetItemCommand

  /**
   * Parses one deterministic mutation-sequence strong-read response.
   *
   * @param sequence - Exact positive mutation sequence.
   * @param output - Untrusted low-level DynamoDB GetItem response.
   * @returns Detached strict receipt projection, or undefined when absent.
   */
  parseJournalSequenceStrongReadOutput(
    sequence: number,
    output: unknown,
  ): WorkspaceSearchMigrationApplySequenceReceiptAwsProjection | undefined

  /**
   * Creates a strong read for one deterministic operation-id marker.
   *
   * @param operationId - Exact stable operation identifier.
   * @returns Adapter-owned strongly consistent point-read command.
   */
  createOperationMarkerStrongReadCommand(
    operationId: string,
  ): GetItemCommand

  /**
   * Parses one deterministic operation-marker strong-read response.
   *
   * @param operationId - Exact stable operation identifier.
   * @param output - Untrusted low-level DynamoDB GetItem response.
   * @returns Detached strict marker projection, or undefined when absent.
   */
  parseOperationMarkerStrongReadOutput(
    operationId: string,
    output: unknown,
  ): WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection | undefined

  /**
   * Requires sequence and operation-marker rows to describe one exact commit.
   *
   * @param sequence - Strict mutation-sequence row projection.
   * @param marker - Strict operation-id marker row projection.
   * @returns Fresh detached fully correlated mutating receipt projection.
   */
  correlateRows(
    sequence: WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
    marker: WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
  ): WorkspaceSearchMigrationCorrelatedApplyReceiptAwsProjection

  /**
   * Creates a strict full-controlled-row condition for a sequence receipt.
   *
   * @param projection - Strict mutation-sequence receipt projection.
   * @returns Exact immutable sequence-row DynamoDB ConditionCheck.
   */
  createJournalSequenceConditionCheck(
    projection: WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
  ): TransactWriteItem

  /**
   * Creates a strict full-controlled-row condition for an operation marker.
   *
   * @param projection - Strict operation-marker receipt projection.
   * @returns Exact immutable marker-row DynamoDB ConditionCheck.
   */
  createOperationMarkerConditionCheck(
    projection: WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
  ): TransactWriteItem
}

/**
 * Detached validated addressing material retained only by the capability.
 */
type PreparedApplyReceiptBinding = {
  /** Exact physical migration-state table name. */
  readonly stateTableName: string
  /** Immutable migration-state table incarnation identifier. */
  readonly stateTableId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Operator-selected admitted migration run. */
  readonly runId: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Exact operation count in the immutable sealed plan. */
  readonly planOperationCount: number
  /** Stable digest used by the existing apply receipt keys. */
  readonly bindingDigest: string
}

/**
 * Mutable traversal budget used before passing a value to a JSON codec.
 */
type SafeJsonTraversalBudget = {
  /** Objects on the current traversal path for cycle detection. */
  readonly active: WeakSet<object>
  /** Objects already encountered, including shared DAG references. */
  readonly visited: WeakSet<object>
  /** Total primitive and container nodes encountered so far. */
  nodes: number
}

/**
 * Complete controlled field set for immutable operation-marker rows.
 */
const markerRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'markerBytes',
  'markerDigest',
  'migrationId',
  'operationId',
  'planOperationDigest',
  'planSequence',
  'predecessorRevision',
  'recordKey',
  'recordVersion',
  'runId',
  'stateTableId',
  'successorExecutionStateDigest',
  'successorRevision',
])

/**
 * Complete controlled field set for immutable journal-sequence rows.
 */
const sequenceRecordAttributeNames = Object.freeze([
  'configurationHash',
  'executionRunDigest',
  'kind',
  'markerBytes',
  'markerDigest',
  'migrationId',
  'operationId',
  'operationMarkerRecordKey',
  'planOperationDigest',
  'planSequence',
  'predecessorRevision',
  'recordKey',
  'recordVersion',
  'runId',
  'sequence',
  'stateTableId',
  'successorExecutionStateDigest',
  'successorRevision',
])

/**
 * Stable private failure inside the apply-receipt persistence boundary.
 */
class ApplyReceiptAwsFailure extends Error {
  /** Secret-free migration failure code. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one raw-value-free private failure.
   *
   * @param code - Stable operator-safe migration failure code.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super(code)
    this.name = 'ApplyReceiptAwsFailure'
    this.code = code
  }
}

/**
 * Creates one admitted-run-bound apply-receipt persistence capability.
 *
 * The capability recreates the exact version-one keys and row schema emitted
 * by the current apply adapter while keeping raw DynamoDB rows private.
 *
 * @param input - Exact migration-state table, configuration, and execution run.
 * @returns Frozen strong-read, correlation, and transaction-guard capability.
 */
export function createWorkspaceSearchMigrationApplyReceiptAwsBinding(
  input: WorkspaceSearchMigrationApplyReceiptAwsBindingInput,
): WorkspaceSearchMigrationApplyReceiptAwsBinding {
  return atApplyReceiptAwsBoundary(() => {
    const binding = prepareApplyReceiptBinding(
      input,
      'INVALID_ARGUMENT',
    )
    return Object.freeze({
      readBindingIdentity:
        (): WorkspaceSearchMigrationApplyReceiptAwsBindingIdentity =>
          Object.freeze({
            stateTableId: binding.stateTableId,
            configurationHash: binding.configurationHash,
            runId: binding.runId,
            executionRunDigest: binding.executionRunDigest,
            bindingDigest: binding.bindingDigest,
          }),
      createJournalSequenceStrongReadCommand: (
        sequence: number,
      ): GetItemCommand =>
        atApplyReceiptAwsBoundary(
          () =>
            createStrongReadCommand(
              binding,
              createJournalSequenceKey(
                binding,
                readPositiveSafeInteger(
                  sequence,
                  'INVALID_ARGUMENT',
                ),
              ),
            ),
          'INVALID_ARGUMENT',
        ),
      parseJournalSequenceStrongReadOutput: (
        sequence: number,
        output: unknown,
      ): WorkspaceSearchMigrationApplySequenceReceiptAwsProjection |
        undefined =>
        atApplyReceiptAwsBoundary(() => {
          const strictSequence = readPositiveSafeInteger(
            sequence,
            'INVALID_ARGUMENT',
          )
          const item = readOutputItem(output)
          return item === undefined
            ? undefined
            : parseSequenceRecord(
                binding,
                strictSequence,
                item,
              )
        }, 'INVALID_STATE'),
      createOperationMarkerStrongReadCommand: (
        operationId: string,
      ): GetItemCommand =>
        atApplyReceiptAwsBoundary(
          () =>
            createStrongReadCommand(
              binding,
              createOperationMarkerKey(
                binding,
                readDigest(operationId, 'INVALID_ARGUMENT'),
              ),
            ),
          'INVALID_ARGUMENT',
        ),
      parseOperationMarkerStrongReadOutput: (
        operationId: string,
        output: unknown,
      ): WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection |
        undefined =>
        atApplyReceiptAwsBoundary(() => {
          const strictOperationId = readDigest(
            operationId,
            'INVALID_ARGUMENT',
          )
          const item = readOutputItem(output)
          return item === undefined
            ? undefined
            : parseMarkerRecord(
                binding,
                strictOperationId,
                item,
              )
        }, 'INVALID_STATE'),
      correlateRows: (
        sequence:
          WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
        marker:
          WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
      ): WorkspaceSearchMigrationCorrelatedApplyReceiptAwsProjection =>
        atApplyReceiptAwsBoundary(
          () => correlateApplyReceiptRows(binding, sequence, marker),
          'INVALID_STATE',
        ),
      createJournalSequenceConditionCheck: (
        projection:
          WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
      ): TransactWriteItem =>
        atApplyReceiptAwsBoundary(() => {
          const strict = prepareSequenceProjection(
            binding,
            projection,
            'INVALID_ARGUMENT',
          )
          return createFullRowConditionCheck(
            binding,
            createSequenceRecord(binding, strict),
          )
        }, 'INVALID_ARGUMENT'),
      createOperationMarkerConditionCheck: (
        projection:
          WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
      ): TransactWriteItem =>
        atApplyReceiptAwsBoundary(() => {
          const strict = prepareMarkerProjection(
            binding,
            projection,
            'INVALID_ARGUMENT',
          )
          return createFullRowConditionCheck(
            binding,
            createMarkerRecord(binding, strict),
          )
        }, 'INVALID_ARGUMENT'),
    })
  }, 'INVALID_ARGUMENT')
}

/**
 * Validates and detaches one exported apply-receipt binding.
 *
 * @param input - Candidate binding input.
 * @param code - Stable failure classification for malformed material.
 * @returns Exact detached admitted-run addressing material.
 */
function prepareApplyReceiptBinding(
  input: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): PreparedApplyReceiptBinding {
  const record = requirePlainRecord(input, code)
  requireExactKeys(record, [
    'configurationHash',
    'executionRun',
    'stateTable',
  ], code)
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash', code),
    code,
  )
  const executionRun = detachExecutionRun(
    readOwn(record, 'executionRun', code),
    code,
  )
  const stateTableValue = readOwn(record, 'stateTable', code)
  requireSafeJsonData(stateTableValue, code)
  const stateTable = readMigrationStateTable(stateTableValue, code)
  const expectedStateTable =
    executionRun.runState.configuration.tables['migration-state']
  if (
    createMigrationDigest(stateTableValue) !==
      createMigrationDigest(expectedStateTable) ||
    stateTable.tableName !== expectedStateTable.tableName ||
    stateTable.tableId !== expectedStateTable.tableId ||
    executionRun.binding.tableIds['migration-state'] !==
      expectedStateTable.tableId ||
    configurationHash !== executionRun.configurationHash
  ) {
    return failApplyReceiptAws('CONFIGURATION_DRIFT')
  }
  const bindingDigest =
    createWorkspaceSearchMigrationApplyRunBindingDigest({
      stateTable: expectedStateTable,
      configurationHash,
      executionRun,
    })
  return {
    stateTableName: stateTable.tableName,
    stateTableId: stateTable.tableId,
    configurationHash,
    runId: executionRun.runId,
    executionRunDigest: executionRun.executionRunDigest,
    planOperationCount:
      executionRun.binding.planOperationCount,
    bindingDigest,
  }
}

/**
 * Creates one adapter-owned strongly consistent point read.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param key - Exact deterministic low-level primary key.
 * @returns Strongly consistent GetItem command.
 */
function createStrongReadCommand(
  binding: PreparedApplyReceiptBinding,
  key: Readonly<Record<string, AttributeValue>>,
): GetItemCommand {
  return new GetItemCommand({
    TableName: binding.stateTableName,
    ConsistentRead: true,
    Key: key,
  })
}

/**
 * Strictly parses one complete operation-marker row.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param operationId - Expected stable operation identifier.
 * @param item - Untrusted low-level DynamoDB item.
 * @returns Detached strict marker projection.
 */
function parseMarkerRecord(
  binding: PreparedApplyReceiptBinding,
  operationId: string,
  item: unknown,
): WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection {
  const record = requirePlainRecord(item, 'INVALID_STATE')
  requireExactAttributeKeys(
    record,
    markerRecordAttributeNames,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(record, 'recordKey') !==
      createOperationMarkerRecordKey(binding, operationId) ||
    readStringAttribute(record, 'kind') !==
      operationMarkerRecordKind ||
    readNumberAttribute(record, 'recordVersion') !==
      applyReceiptRecordVersion ||
    readStringAttribute(record, 'stateTableId') !==
      binding.stateTableId ||
    readStringAttribute(record, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(record, 'runId') !== binding.runId ||
    readStringAttribute(record, 'executionRunDigest') !==
      binding.executionRunDigest ||
    readStringAttribute(record, 'operationId') !== operationId
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  const receipt = parseMarkerBytes(
    readBinaryAttribute(record, 'markerBytes'),
    'INVALID_STATE',
  )
  const projection = createMarkerProjection(
    binding,
    receipt,
    record,
    'INVALID_STATE',
  )
  if (
    receipt.operationId !== operationId ||
    readNumberAttribute(record, 'planSequence') !==
      receipt.planSequence ||
    readStringAttribute(record, 'planOperationDigest') !==
      receipt.planOperationDigest
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  validateDynamoDbItemSize(createMarkerRecord(binding, projection))
  return projection
}

/**
 * Strictly parses one complete mutation journal-sequence row.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param sequence - Expected positive mutation sequence.
 * @param item - Untrusted low-level DynamoDB item.
 * @returns Detached strict mutation receipt projection.
 */
function parseSequenceRecord(
  binding: PreparedApplyReceiptBinding,
  sequence: number,
  item: unknown,
): WorkspaceSearchMigrationApplySequenceReceiptAwsProjection {
  const record = requirePlainRecord(item, 'INVALID_STATE')
  requireExactAttributeKeys(
    record,
    sequenceRecordAttributeNames,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readStringAttribute(record, 'recordKey') !==
      createJournalSequenceRecordKey(binding, sequence) ||
    readStringAttribute(record, 'kind') !==
      journalSequenceRecordKind ||
    readNumberAttribute(record, 'recordVersion') !==
      applyReceiptRecordVersion ||
    readStringAttribute(record, 'stateTableId') !==
      binding.stateTableId ||
    readStringAttribute(record, 'configurationHash') !==
      binding.configurationHash ||
    readStringAttribute(record, 'runId') !== binding.runId ||
    readStringAttribute(record, 'executionRunDigest') !==
      binding.executionRunDigest ||
    readNumberAttribute(record, 'sequence') !== sequence
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  const receipt = parseMarkerBytes(
    readBinaryAttribute(record, 'markerBytes'),
    'INVALID_STATE',
  )
  if (
    receipt.kind !== 'workspace-search-operation-applied' ||
    receipt.sequence !== sequence
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  const projection = createSequenceProjection(
    binding,
    receipt,
    record,
    'INVALID_STATE',
  )
  if (
    readStringAttribute(record, 'operationId') !==
      receipt.operationId ||
    readStringAttribute(record, 'operationMarkerRecordKey') !==
      createOperationMarkerRecordKey(
        binding,
        receipt.operationId,
      ) ||
    readNumberAttribute(record, 'planSequence') !==
      receipt.planSequence ||
    readStringAttribute(record, 'planOperationDigest') !==
      receipt.planOperationDigest
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  validateDynamoDbItemSize(createSequenceRecord(binding, projection))
  return projection
}

/**
 * Cross-checks common indexed fields and creates a marker projection.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param receipt - Strict canonical apply marker.
 * @param item - Shape-checked low-level marker row.
 * @param code - Stable failure classification for malformed material.
 * @returns Detached strict marker projection.
 */
function createMarkerProjection(
  binding: PreparedApplyReceiptBinding,
  receipt: WorkspaceSearchOperationMarker,
  item: Readonly<Record<string, unknown>>,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection {
  requireMarkerBinding(binding, receipt, code)
  const predecessorRevision = readPositiveSafeInteger(
    readNumberAttribute(item, 'predecessorRevision'),
    code,
  )
  const successorRevision = readPositiveSafeInteger(
    readNumberAttribute(item, 'successorRevision'),
    code,
  )
  const successorExecutionStateDigest = readDigest(
    readStringAttribute(item, 'successorExecutionStateDigest'),
    code,
  )
  const markerDigest = readDigest(
    readStringAttribute(item, 'markerDigest'),
    code,
  )
  if (
    successorRevision !== predecessorRevision + 1 ||
    markerDigest !== createMigrationDigest(receipt)
  ) {
    return failApplyReceiptAws(code)
  }
  return Object.freeze({
    receipt,
    predecessorRevision,
    successorRevision,
    successorExecutionStateDigest,
    markerDigest,
  })
}

/**
 * Cross-checks common indexed fields and creates a sequence projection.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param receipt - Strict canonical mutating receipt.
 * @param item - Shape-checked low-level sequence row.
 * @param code - Stable failure classification for malformed material.
 * @returns Detached strict sequence projection.
 */
function createSequenceProjection(
  binding: PreparedApplyReceiptBinding,
  receipt: WorkspaceSearchOperationReceipt,
  item: Readonly<Record<string, unknown>>,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationApplySequenceReceiptAwsProjection {
  const common = createMarkerProjection(
    binding,
    receipt,
    item,
    code,
  )
  return Object.freeze({
    receipt,
    predecessorRevision: common.predecessorRevision,
    successorRevision: common.successorRevision,
    successorExecutionStateDigest:
      common.successorExecutionStateDigest,
    markerDigest: common.markerDigest,
  })
}

/**
 * Detaches and validates a caller-supplied marker projection.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param value - Candidate public marker projection.
 * @param code - Stable failure classification for malformed material.
 * @returns Fresh detached strict marker projection.
 */
function prepareMarkerProjection(
  binding: PreparedApplyReceiptBinding,
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection {
  const record = requirePlainRecord(value, code)
  requireExactKeys(record, [
    'markerDigest',
    'predecessorRevision',
    'receipt',
    'successorExecutionStateDigest',
    'successorRevision',
  ], code)
  const receipt = detachMarker(
    readOwn(record, 'receipt', code),
    code,
  )
  requireMarkerBinding(binding, receipt, code)
  const predecessorRevision = readPositiveSafeInteger(
    readOwn(record, 'predecessorRevision', code),
    code,
  )
  const successorRevision = readPositiveSafeInteger(
    readOwn(record, 'successorRevision', code),
    code,
  )
  const successorExecutionStateDigest = readDigest(
    readOwn(record, 'successorExecutionStateDigest', code),
    code,
  )
  const markerDigest = readDigest(
    readOwn(record, 'markerDigest', code),
    code,
  )
  if (
    successorRevision !== predecessorRevision + 1 ||
    markerDigest !== createMigrationDigest(receipt)
  ) {
    return failApplyReceiptAws(code)
  }
  return Object.freeze({
    receipt,
    predecessorRevision,
    successorRevision,
    successorExecutionStateDigest,
    markerDigest,
  })
}

/**
 * Detaches and validates a caller-supplied mutation-sequence projection.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param value - Candidate public mutation-sequence projection.
 * @param code - Stable failure classification for malformed material.
 * @returns Fresh detached strict sequence projection.
 */
function prepareSequenceProjection(
  binding: PreparedApplyReceiptBinding,
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationApplySequenceReceiptAwsProjection {
  const marker = prepareMarkerProjection(binding, value, code)
  if (marker.receipt.kind !== 'workspace-search-operation-applied') {
    return failApplyReceiptAws(code)
  }
  return Object.freeze({
    receipt: marker.receipt,
    predecessorRevision: marker.predecessorRevision,
    successorRevision: marker.successorRevision,
    successorExecutionStateDigest:
      marker.successorExecutionStateDigest,
    markerDigest: marker.markerDigest,
  })
}

/**
 * Correlates the two immutable rows for one exact target mutation.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param sequenceValue - Candidate strict sequence projection.
 * @param markerValue - Candidate strict marker projection.
 * @returns Fresh detached correlated mutating receipt projection.
 */
function correlateApplyReceiptRows(
  binding: PreparedApplyReceiptBinding,
  sequenceValue: unknown,
  markerValue: unknown,
): WorkspaceSearchMigrationCorrelatedApplyReceiptAwsProjection {
  const sequence = prepareSequenceProjection(
    binding,
    sequenceValue,
    'INVALID_STATE',
  )
  const marker = prepareMarkerProjection(
    binding,
    markerValue,
    'INVALID_STATE',
  )
  if (
    marker.receipt.kind !== 'workspace-search-operation-applied' ||
    !equalBytes(
      serializeWorkspaceSearchMigrationOperationMarker(
        sequence.receipt,
      ),
      serializeWorkspaceSearchMigrationOperationMarker(
        marker.receipt,
      ),
    ) ||
    sequence.predecessorRevision !==
      marker.predecessorRevision ||
    sequence.successorRevision !== marker.successorRevision ||
    sequence.successorExecutionStateDigest !==
      marker.successorExecutionStateDigest ||
    sequence.markerDigest !== marker.markerDigest
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  return Object.freeze({
    receipt: sequence.receipt,
    predecessorRevision: sequence.predecessorRevision,
    successorRevision: sequence.successorRevision,
    successorExecutionStateDigest:
      sequence.successorExecutionStateDigest,
    markerDigest: sequence.markerDigest,
  })
}

/**
 * Creates one complete canonical operation-marker row.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param projection - Strict marker receipt projection.
 * @returns Complete version-one low-level DynamoDB record.
 */
function createMarkerRecord(
  binding: PreparedApplyReceiptBinding,
  projection: WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
): Readonly<Record<string, AttributeValue>> {
  const receipt = projection.receipt
  const markerBytes =
    serializeWorkspaceSearchMigrationOperationMarker(receipt)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createOperationMarkerRecordKey(
        binding,
        receipt.operationId,
      ),
    },
    kind: { S: operationMarkerRecordKind },
    recordVersion: { N: String(applyReceiptRecordVersion) },
    stateTableId: { S: binding.stateTableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.runId },
    executionRunDigest: { S: binding.executionRunDigest },
    operationId: { S: receipt.operationId },
    planSequence: { N: String(receipt.planSequence) },
    planOperationDigest: {
      S: receipt.planOperationDigest,
    },
    predecessorRevision: {
      N: String(projection.predecessorRevision),
    },
    successorRevision: {
      N: String(projection.successorRevision),
    },
    successorExecutionStateDigest: {
      S: projection.successorExecutionStateDigest,
    },
    markerDigest: { S: projection.markerDigest },
    markerBytes: { B: markerBytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Creates one complete canonical mutation journal-sequence row.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param projection - Strict mutating receipt projection.
 * @returns Complete version-one low-level DynamoDB record.
 */
function createSequenceRecord(
  binding: PreparedApplyReceiptBinding,
  projection: WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
): Readonly<Record<string, AttributeValue>> {
  const receipt = projection.receipt
  const markerBytes =
    serializeWorkspaceSearchMigrationOperationMarker(receipt)
  const item: Readonly<Record<string, AttributeValue>> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createJournalSequenceRecordKey(
        binding,
        receipt.sequence,
      ),
    },
    kind: { S: journalSequenceRecordKind },
    recordVersion: { N: String(applyReceiptRecordVersion) },
    stateTableId: { S: binding.stateTableId },
    configurationHash: { S: binding.configurationHash },
    runId: { S: binding.runId },
    executionRunDigest: { S: binding.executionRunDigest },
    sequence: { N: String(receipt.sequence) },
    operationId: { S: receipt.operationId },
    operationMarkerRecordKey: {
      S: createOperationMarkerRecordKey(
        binding,
        receipt.operationId,
      ),
    },
    planSequence: { N: String(receipt.planSequence) },
    planOperationDigest: {
      S: receipt.planOperationDigest,
    },
    predecessorRevision: {
      N: String(projection.predecessorRevision),
    },
    successorRevision: {
      N: String(projection.successorRevision),
    },
    successorExecutionStateDigest: {
      S: projection.successorExecutionStateDigest,
    },
    markerDigest: { S: projection.markerDigest },
    markerBytes: { B: markerBytes },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Creates one complete controlled-attribute immutable-row condition.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param item - Complete canonical marker or sequence row.
 * @returns One fixed-row DynamoDB ConditionCheck.
 */
function createFullRowConditionCheck(
  binding: PreparedApplyReceiptBinding,
  item: Readonly<Record<string, AttributeValue>>,
): TransactWriteItem {
  const migrationId = item.migrationId
  const recordKey = item.recordKey
  if (migrationId === undefined || recordKey === undefined) {
    return failApplyReceiptAws('INVALID_STATE')
  }
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
  return {
    ConditionCheck: {
      TableName: binding.stateTableName,
      Key: { migrationId, recordKey },
      ConditionExpression: clauses.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValuesOnConditionCheckFailure: 'NONE',
    },
  }
}

/**
 * Requires one marker to remain bound to the exact admitted execution.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param marker - Candidate strict operation marker.
 * @param code - Stable failure classification for a mismatch.
 */
function requireMarkerBinding(
  binding: PreparedApplyReceiptBinding,
  marker: WorkspaceSearchOperationMarker,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  if (
    marker.runId !== binding.runId ||
    marker.configurationHash !== binding.configurationHash ||
    marker.planSequence > binding.planOperationCount
  ) {
    return failApplyReceiptAws(code)
  }
}

/**
 * Creates the deterministic operation-marker low-level primary key.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param operationId - Stable operation identifier.
 * @returns Exact migration-state table primary key.
 */
function createOperationMarkerKey(
  binding: PreparedApplyReceiptBinding,
  operationId: string,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createOperationMarkerRecordKey(binding, operationId),
    },
  }
}

/**
 * Creates the deterministic journal-sequence low-level primary key.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param sequence - Positive mutation sequence.
 * @returns Exact migration-state table primary key.
 */
function createJournalSequenceKey(
  binding: PreparedApplyReceiptBinding,
  sequence: number,
): Readonly<Record<string, AttributeValue>> {
  return {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createJournalSequenceRecordKey(binding, sequence),
    },
  }
}

/**
 * Creates the existing version-one operation-marker sort key.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param operationId - Stable operation identifier.
 * @returns Bounded digest-addressed marker key.
 */
function createOperationMarkerRecordKey(
  binding: PreparedApplyReceiptBinding,
  operationId: string,
): string {
  const digest = createMigrationDigest({
    kind: 'workspace-search-apply-operation-key',
    version: applyReceiptRecordVersion,
    bindingDigest: binding.bindingDigest,
    operationId,
  })
  return `${operationMarkerRecordKeyPrefix}/${digest}/marker`
}

/**
 * Creates the existing version-one mutation-sequence sort key.
 *
 * @param binding - Exact detached admitted-run binding.
 * @param sequence - Positive mutation sequence.
 * @returns Bounded digest-addressed sequence key.
 */
function createJournalSequenceRecordKey(
  binding: PreparedApplyReceiptBinding,
  sequence: number,
): string {
  const digest = createMigrationDigest({
    kind: 'workspace-search-apply-journal-sequence-key',
    version: applyReceiptRecordVersion,
    bindingDigest: binding.bindingDigest,
    sequence,
  })
  return `${journalSequenceRecordKeyPrefix}/${digest}/receipt`
}

/**
 * Reads the minimal exact migration-state table address.
 *
 * @param value - Candidate measured table identity.
 * @param code - Stable failure classification for malformed material.
 * @returns Exact physical table name and immutable TableId.
 */
function readMigrationStateTable(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): {
  /** Exact physical migration-state table name. */
  readonly tableName: string
  /** Immutable physical table incarnation identifier. */
  readonly tableId: string
} {
  const record = requirePlainRecord(value, code)
  if (readOwn(record, 'role', code) !== 'migration-state') {
    return failApplyReceiptAws(code)
  }
  return {
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
 * Detaches one strict immutable execution admission.
 *
 * @param value - Candidate execution-run envelope.
 * @param code - Stable failure classification for malformed material.
 * @returns Detached strict revision-one execution admission.
 */
function detachExecutionRun(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationExecutionRun {
  requireSafeJsonData(value, code)
  if (!isExecutionRunCandidate(value)) {
    return failApplyReceiptAws(code)
  }
  try {
    return parseWorkspaceSearchMigrationExecutionRun(
      serializeWorkspaceSearchMigrationExecutionRun(value),
    )
  } catch {
    return failApplyReceiptAws(code)
  }
}

/**
 * Narrows one safe JSON value enough for the strict execution-run codec.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the execution-run discriminator is exact.
 */
function isExecutionRunCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  if (!isPlainRecord(value)) return false
  const descriptor =
    Object.getOwnPropertyDescriptor(value, 'kind')
  return descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value ===
      'workspace-search-migration-execution-run'
}

/**
 * Detaches one no-op or mutating marker through the canonical marker codec.
 *
 * @param value - Candidate operation marker.
 * @param code - Stable failure classification for malformed material.
 * @returns Fresh detached strict operation marker.
 */
function detachMarker(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchOperationMarker {
  requireSafeJsonData(value, code)
  if (!isOperationMarkerCandidate(value)) {
    return failApplyReceiptAws(code)
  }
  try {
    return parseWorkspaceSearchMigrationOperationMarker(
      serializeWorkspaceSearchMigrationOperationMarker(value),
    )
  } catch {
    return failApplyReceiptAws(code)
  }
}

/**
 * Narrows one safe JSON value enough for the strict marker codec.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the marker discriminator is supported.
 */
function isOperationMarkerCandidate(
  value: unknown,
): value is WorkspaceSearchOperationMarker {
  if (!isPlainRecord(value)) return false
  const descriptor =
    Object.getOwnPropertyDescriptor(value, 'kind')
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return false
  }
  return descriptor.value ===
      'workspace-search-operation-applied' ||
    descriptor.value ===
      'workspace-search-operation-already-current'
}

/**
 * Parses exact canonical marker bytes behind a stable local boundary.
 *
 * @param bytes - Candidate canonical marker bytes.
 * @param code - Stable failure classification for malformed bytes.
 * @returns Fresh detached strict operation marker.
 */
function parseMarkerBytes(
  bytes: Uint8Array,
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchOperationMarker {
  try {
    return parseWorkspaceSearchMigrationOperationMarker(bytes)
  } catch {
    return failApplyReceiptAws(code)
  }
}

/**
 * Reads one optional low-level GetItem result without invoking accessors.
 *
 * @param output - Raw low-level DynamoDB response.
 * @returns Raw item value, or undefined when the row is absent.
 */
function readOutputItem(output: unknown): unknown {
  const record = requirePlainRecord(output, 'INVALID_STATE')
  if (
    Reflect.ownKeys(record).some(
      (key) => typeof key === 'symbol',
    )
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  const descriptor =
    Object.getOwnPropertyDescriptor(record, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Requires an item to contain exactly the controlled attribute set.
 *
 * @param item - Candidate low-level item.
 * @param expectedKeys - Complete expected attribute names.
 * @param code - Stable failure classification.
 */
function requireExactAttributeKeys(
  item: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  code: WorkspaceSearchMigrationFailureCode,
): void {
  const actual = Reflect.ownKeys(item)
  if (
    actual.some((key) => typeof key === 'symbol') ||
    actual.length !== expectedKeys.length
  ) {
    return failApplyReceiptAws(code)
  }
  const actualStrings =
    Object.keys(item).sort(compareUtf8Ordinal)
  const expected =
    [...expectedKeys].sort(compareUtf8Ordinal)
  if (
    actualStrings.length !== expected.length ||
    actualStrings.some(
      (key, index) => key !== expected[index],
    )
  ) {
    return failApplyReceiptAws(code)
  }
  for (const key of expected) readOwn(item, key, code)
}

/**
 * Reads one exact single-string DynamoDB attribute.
 *
 * @param item - Shape-checked low-level item.
 * @param name - Required attribute name.
 * @returns Exact string value.
 */
function readStringAttribute(
  item: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const attribute = requirePlainRecord(
    readOwn(item, name, 'INVALID_STATE'),
    'INVALID_STATE',
  )
  requireExactKeys(attribute, ['S'], 'INVALID_STATE')
  const value = readOwn(attribute, 'S', 'INVALID_STATE')
  if (typeof value !== 'string') {
    return failApplyReceiptAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads one exact nonnegative integer DynamoDB attribute.
 *
 * @param item - Shape-checked low-level item.
 * @param name - Required attribute name.
 * @returns Exact safe integer.
 */
function readNumberAttribute(
  item: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const attribute = requirePlainRecord(
    readOwn(item, name, 'INVALID_STATE'),
    'INVALID_STATE',
  )
  requireExactKeys(attribute, ['N'], 'INVALID_STATE')
  const value = readOwn(attribute, 'N', 'INVALID_STATE')
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  return parsed
}

/**
 * Reads one exact nonempty binary DynamoDB attribute.
 *
 * @param item - Shape-checked low-level item.
 * @param name - Required attribute name.
 * @returns Detached exact bytes.
 */
function readBinaryAttribute(
  item: Readonly<Record<string, unknown>>,
  name: string,
): Uint8Array {
  const attribute = requirePlainRecord(
    readOwn(item, name, 'INVALID_STATE'),
    'INVALID_STATE',
  )
  requireExactKeys(attribute, ['B'], 'INVALID_STATE')
  const value = readOwn(attribute, 'B', 'INVALID_STATE')
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    value.byteLength === 0 ||
    value.byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES
  ) {
    return failApplyReceiptAws('INVALID_STATE')
  }
  const copy = new Uint8Array(value)
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
    return failApplyReceiptAws(code)
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
 * Requires an exact enumerable own data-property field set.
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
    return failApplyReceiptAws(code)
  }
  const actualStrings =
    Object.keys(record).sort(compareUtf8Ordinal)
  if (
    actualStrings.length !== expected.length ||
    actualStrings.some(
      (key, index) => key !== expected[index],
    )
  ) {
    return failApplyReceiptAws(code)
  }
  for (const key of expected) readOwn(record, key, code)
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
  const descriptor =
    Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failApplyReceiptAws(code)
  }
  return descriptor.value
}

/**
 * Rejects accessors, Proxies, cycles, and non-JSON values before a codec call.
 *
 * @param value - Candidate JSON-compatible graph.
 * @param code - Stable failure classification.
 */
function requireSafeJsonData(
  value: unknown,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  if (!isSafeJsonData(value, {
    active: new WeakSet<object>(),
    visited: new WeakSet<object>(),
    nodes: 0,
  }, 0)) {
    return failApplyReceiptAws(code)
  }
}

/**
 * Checks a bounded graph without invoking caller-controlled accessors.
 *
 * @param value - Candidate JSON value.
 * @param budget - Shared traversal identity and total-node budget.
 * @param depth - Current nested container depth.
 * @returns Whether the graph is finite, acyclic, and data-only.
 */
function isSafeJsonData(
  value: unknown,
  budget: SafeJsonTraversalBudget,
  depth: number,
): boolean {
  if (budget.nodes >= maximumSafeJsonNodes) return false
  budget.nodes += 1
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (
    typeof value !== 'object' ||
    depth > maximumSafeJsonDepth
  ) {
    return false
  }
  if (
    nodeUtilTypes.isProxy(value) ||
    budget.active.has(value) ||
    budget.visited.has(value)
  ) {
    return false
  }
  budget.active.add(value)
  budget.visited.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > maximumSafeJsonArrayLength) return false
      const keys = Reflect.ownKeys(value)
      const enumerableKeys = Object.keys(value)
      if (
        keys.some((key) => typeof key === 'symbol') ||
        keys.length !== value.length + 1 ||
        enumerableKeys.length !== value.length
      ) {
        return false
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor =
          Object.getOwnPropertyDescriptor(value, String(index))
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, 'value') ||
          !isSafeJsonData(
            descriptor.value,
            budget,
            depth + 1,
          )
        ) {
          return false
        }
      }
      return true
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return false
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.length > maximumSafeJsonObjectProperties ||
      keys.some((key) => typeof key === 'symbol')
    ) {
      return false
    }
    const enumerableKeys = Object.keys(value)
    if (enumerableKeys.length !== keys.length) return false
    for (const key of enumerableKeys) {
      const descriptor =
        Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') ||
        !isSafeJsonData(
          descriptor.value,
          budget,
          depth + 1,
        )
      ) {
        return false
      }
    }
    return true
  } finally {
    budget.active.delete(value)
  }
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
    return failApplyReceiptAws(code)
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
  if (!isHexDigest(value)) return failApplyReceiptAws(code)
  return value
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
    value <= 0
  ) {
    return failApplyReceiptAws(code)
  }
  return value
}

/**
 * Orders strings by their exact UTF-8 bytes.
 *
 * @param left - Left operand.
 * @param right - Right operand.
 * @returns Negative, zero, or positive ordering value.
 */
function compareUtf8Ordinal(
  left: string,
  right: string,
): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * Compares two byte sequences without coercion.
 *
 * @param left - First byte sequence.
 * @param right - Second byte sequence.
 * @returns Whether both sequences contain identical bytes.
 */
function equalBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
}

/**
 * Runs one synchronous public apply-receipt operation.
 *
 * @param operation - Exact synchronous operation.
 * @param fallbackCode - Stable code for unknown failures.
 * @returns Successful operation result.
 */
function atApplyReceiptAwsBoundary<Result>(
  operation: () => Result,
  fallbackCode: WorkspaceSearchMigrationFailureCode,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    const code = error instanceof ApplyReceiptAwsFailure
      ? error.code
      : error instanceof WorkspaceSearchMigrationFailure &&
          isWorkspaceSearchMigrationFailureCode(error.code)
        ? error.code
        : fallbackCode
    throw new WorkspaceSearchMigrationFailure(
      code,
      'Workspace Search migration apply receipt persistence failed.',
    )
  }
}

/**
 * Raises one private stable apply-receipt persistence failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Never returns.
 */
function failApplyReceiptAws(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new ApplyReceiptAwsFailure(code)
}
