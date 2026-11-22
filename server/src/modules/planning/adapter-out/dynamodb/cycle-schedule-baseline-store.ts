import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES,
  isProjectScheduleBaselineCapturedAt,
  isProjectScheduleBaselineId,
  isProjectScheduleBaselineName,
  parseCycleScheduleBaselineEntry,
  parseSavedCycleScheduleBaselines,
  type CycleScheduleBaselineEntry,
} from '@mukuroji/contracts'
import { createAuditFieldChanges, createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import type {
  CycleScheduleBaselineIndex,
  CycleScheduleBaselineStore as BaselineStore,
  StoredCycleScheduleBaseline,
  WriteCycleScheduleBaselineInput as WriteInput,
} from '../../application/cycle-schedule-baseline'
import { PlanningError } from '../../planning'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type CycleScheduleBaselineCallerCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Write input with DynamoDB authorization fences and the request audit context. */
export type WriteCycleScheduleBaselineInput = WriteInput<CycleScheduleBaselineCallerCheck, MutationAuditContext>

/** Cycle baseline persistence bound to DynamoDB fences and the request audit context. */
export type CycleScheduleBaselineStore = BaselineStore<CycleScheduleBaselineCallerCheck, MutationAuditContext>

/** Planning-table record type of a Cycle's baseline list. */
const INDEX_ENTRY_TYPE = 'cycle-schedule-baseline-index'

/** Planning-table record type of one saved Cycle baseline. */
const SAVED_ENTRY_TYPE = 'cycle-schedule-baseline-saved'

/**
 * Builds the Planning-table record key of a Cycle's baseline list.
 *
 * No live Planning graph prefix (`ENTITY#`, `LINK#`, …) starts this key, so graph reads never
 * see the row.
 *
 * @param cycleId - Cycle ID.
 * @returns The record key.
 */
function indexRecordKey(cycleId: string) {
  return `CYCLE_SCHEDULE_BASELINE#${encodeURIComponent(cycleId)}`
}

/**
 * Builds the Planning-table record key of one saved Cycle baseline. Neither this prefix nor the
 * list row's prefix starts the other.
 *
 * @param cycleId - Cycle ID.
 * @param baselineId - Saved baseline ID.
 * @returns The record key.
 */
function savedRecordKey(cycleId: string, baselineId: string) {
  return `CYCLE_SCHEDULE_BASELINE_SAVED#${encodeURIComponent(cycleId)}#${encodeURIComponent(baselineId)}`
}

/**
 * Stores each Cycle's baseline list as one row of the Planning table and each saved baseline as
 * a row of its own.
 */
export class DynamoDbCycleScheduleBaselineStore implements CycleScheduleBaselineStore {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected document client. */
  private readonly client: Pick<DynamoDBDocumentClient, 'send'>
  /** Audit event table, when audit is configured. */
  private readonly auditTableName: string | undefined

  /**
   * Creates the store.
   *
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   * @param auditTableName - Audit event table written in the same transaction, when configured.
   */
  constructor(tableName: string, client: Pick<DynamoDBDocumentClient, 'send'>, auditTableName?: string) {
    this.tableName = tableName
    this.client = client
    this.auditTableName = auditTableName
  }

  /**
   * Reads the baseline list of a Cycle with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param cycleId - Cycle ID.
   * @returns The validated list, or `null` before the first capture.
   */
  async getIndex(workspaceId: string, cycleId: string): Promise<CycleScheduleBaselineIndex | null> {
    const key = indexRecordKey(cycleId)
    const row = await this.readRow(workspaceId, key)
    if (row === undefined) return null
    const { revision } = row
    const savedBaselines = parseSavedCycleScheduleBaselines(row.savedBaselines)
    if (
      !isRowOf(row, workspaceId, key, INDEX_ENTRY_TYPE) ||
      row.cycleId !== cycleId ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !savedBaselines
    ) {
      throw corruptBaseline()
    }
    return { revision, savedBaselines }
  }

  /**
   * Reads one saved Cycle baseline with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param cycleId - Cycle ID.
   * @param baselineId - Saved baseline ID.
   * @returns The validated baseline, or `null` when it is not stored.
   */
  async getSaved(workspaceId: string, cycleId: string, baselineId: string): Promise<StoredCycleScheduleBaseline | null> {
    const key = savedRecordKey(cycleId, baselineId)
    const row = await this.readRow(workspaceId, key)
    if (row === undefined) return null
    const { id, name, capturedAt, entries } = row
    if (
      !isRowOf(row, workspaceId, key, SAVED_ENTRY_TYPE) ||
      row.cycleId !== cycleId ||
      id !== baselineId ||
      !isProjectScheduleBaselineId(id) ||
      (name !== undefined && !isProjectScheduleBaselineName(name)) ||
      !isProjectScheduleBaselineCapturedAt(capturedAt) ||
      !Array.isArray(entries) ||
      entries.length > CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES
    ) {
      throw corruptBaseline()
    }
    const parsed: CycleScheduleBaselineEntry[] = []
    for (const entry of entries) {
      const value = parseCycleScheduleBaselineEntry(entry)
      if (!value) throw corruptBaseline()
      parsed.push(value)
    }
    return { id, ...(typeof name === 'string' ? { name } : {}), capturedAt, entries: parsed }
  }

  /**
   * Stores the new baseline row, the list row with a compare-and-set on its revision, the
   * deletions of dropped rows, the caller's authorization fences, and the audit event in one
   * transaction.
   *
   * @param input - Write input.
   */
  async write(input: WriteCycleScheduleBaselineInput): Promise<void> {
    if (input.baseline.entries.length > CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES) throw tooLarge()
    if (input.callerAuthorization.length === 0) {
      throw new PlanningError(503, 'CycleScheduleBaselineAuthorizationUnavailable', 'Caller authorization is unavailable.')
    }
    const revision = input.expectedRevision + 1
    const scope = { workspaceId: input.workspaceId, cycleId: input.cycleId }
    const audit = createCycleScheduleBaselineAuditPut(this.auditTableName, input, revision)
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...scope,
            recordKey: indexRecordKey(input.cycleId),
            entryType: INDEX_ENTRY_TYPE,
            schemaVersion: 1,
            revision,
            savedBaselines: input.savedBaselines.map((item) => ({ ...item })),
          },
          ConditionExpression: input.expectedRevision > 0
            ? '#revision = :revision AND #type = :type'
            : 'attribute_not_exists(recordKey)',
          ...(input.expectedRevision > 0
            ? {
                ExpressionAttributeNames: { '#revision': 'revision', '#type': 'entryType' },
                ExpressionAttributeValues: { ':revision': input.expectedRevision, ':type': INDEX_ENTRY_TYPE },
              }
            : {}),
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...scope,
            recordKey: savedRecordKey(input.cycleId, input.baseline.id),
            entryType: SAVED_ENTRY_TYPE,
            schemaVersion: 1,
            ...copyBaseline(input.baseline),
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      ...input.savedIdsToDelete.map((baselineId) => ({
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: savedRecordKey(input.cycleId, baselineId) },
        },
      })),
      ...input.callerAuthorization,
      ...(audit ? [audit] : []),
    ]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      storageFailure(error, transactItems.length)
    }
  }

  /**
   * Reads one Planning-table row with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param key - Record key.
   * @returns The raw row, or undefined when it does not exist.
   */
  private async readRow(workspaceId: string, key: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.client
      .send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true }))
      .catch((error: unknown) => storageFailure(error))
    const item: unknown = response.Item
    if (item === undefined) return undefined
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw corruptBaseline()
    return { ...item }
  }
}

/** Isolated store for route and application tests. */
export class InMemoryCycleScheduleBaselineStore implements CycleScheduleBaselineStore {
  /** Baseline lists keyed by Workspace and Cycle. */
  private readonly indexes = new Map<string, CycleScheduleBaselineIndex>()
  /** Saved baselines keyed by Workspace, Cycle, and baseline ID. */
  private readonly saved = new Map<string, StoredCycleScheduleBaseline>()
  /** Audit events the writes would record, oldest first, for tests to inspect. */
  readonly auditEvents: { eventType: string; cycleId: string; actorId: string; revision: number }[] = []

  /**
   * Reads a copy of a Cycle's baseline list.
   *
   * @param workspaceId - Workspace directory ID.
   * @param cycleId - Cycle ID.
   * @returns The list, or `null`.
   */
  async getIndex(workspaceId: string, cycleId: string): Promise<CycleScheduleBaselineIndex | null> {
    return structuredClone(this.indexes.get(JSON.stringify([workspaceId, cycleId])) ?? null)
  }

  /**
   * Reads a copy of one saved baseline.
   *
   * @param workspaceId - Workspace directory ID.
   * @param cycleId - Cycle ID.
   * @param baselineId - Saved baseline ID.
   * @returns The baseline, or `null`.
   */
  async getSaved(workspaceId: string, cycleId: string, baselineId: string): Promise<StoredCycleScheduleBaseline | null> {
    return structuredClone(this.saved.get(JSON.stringify([workspaceId, cycleId, baselineId])) ?? null)
  }

  /**
   * Stores a baseline and the updated list.
   *
   * @param input - Write input.
   */
  async write(input: WriteCycleScheduleBaselineInput): Promise<void> {
    if (input.baseline.entries.length > CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES) throw tooLarge()
    const key = JSON.stringify([input.workspaceId, input.cycleId])
    const savedKey = (baselineId: string) => JSON.stringify([input.workspaceId, input.cycleId, baselineId])
    if ((this.indexes.get(key)?.revision ?? 0) !== input.expectedRevision || this.saved.has(savedKey(input.baseline.id))) {
      throw conflict()
    }
    const revision = input.expectedRevision + 1
    this.indexes.set(key, structuredClone({ revision, savedBaselines: input.savedBaselines }))
    this.saved.set(savedKey(input.baseline.id), copyBaseline(input.baseline))
    for (const baselineId of input.savedIdsToDelete) this.saved.delete(savedKey(baselineId))
    this.auditEvents.push({
      eventType: CYCLE_SCHEDULE_BASELINE_CAPTURED_EVENT_TYPE,
      cycleId: input.cycleId,
      actorId: input.auditContext.actor.id,
      revision,
    })
  }
}

/** Baseline fields whose values the audit event records. */
const AUDIT_FIELDS = ['baselineId', 'revision', 'capturedAt', 'entryCount'] as const

/** Audit event type of a Cycle baseline capture. */
export const CYCLE_SCHEDULE_BASELINE_CAPTURED_EVENT_TYPE = 'cycle.schedule_baseline_captured'

/**
 * Builds the audit event of a capture. It keeps the baseline ID, list revision, capture time,
 * and Work Item count, and not the Work Item IDs, dates, or the name, which the rows hold.
 *
 * @param auditTableName - Audit event table, when configured.
 * @param input - Write input.
 * @param revision - List revision after the write.
 * @returns The conditional audit Put, or undefined when audit is not configured.
 */
function createCycleScheduleBaselineAuditPut(
  auditTableName: string | undefined,
  input: WriteCycleScheduleBaselineInput,
  revision: number,
) {
  return createMutationAuditEventPut(auditTableName, input.auditContext, {
    directoryId: input.workspaceId,
    eventType: CYCLE_SCHEDULE_BASELINE_CAPTURED_EVENT_TYPE,
    entityType: 'cycle',
    entityId: input.cycleId,
    target: { type: SAVED_ENTRY_TYPE, id: input.baseline.id },
    action: 'schedule_baseline_captured',
    occurredAt: input.writtenAt,
    changes: createAuditFieldChanges(
      input.expectedRevision > 0 ? { revision: input.expectedRevision } : undefined,
      {
        baselineId: input.baseline.id,
        revision,
        capturedAt: input.baseline.capturedAt,
        entryCount: input.baseline.entries.length,
      },
      AUDIT_FIELDS,
    ),
    metadata: {
      cycleId: input.cycleId,
      savedBaselineCount: input.savedBaselines.length,
      ...(input.savedIdsToDelete.length > 0 ? { droppedBaselineIds: input.savedIdsToDelete } : {}),
    },
  })
}

/**
 * Copies a baseline into the fields a row stores.
 *
 * @param baseline - Baseline to store.
 * @returns A copy that shares no arrays with the input.
 */
function copyBaseline(baseline: StoredCycleScheduleBaseline): StoredCycleScheduleBaseline {
  return {
    id: baseline.id,
    ...(baseline.name === undefined ? {} : { name: baseline.name }),
    capturedAt: baseline.capturedAt,
    entries: baseline.entries.map((entry) => ({ ...entry })),
  }
}

/**
 * Checks the key fields every stored row carries.
 *
 * @param row - Raw item.
 * @param workspaceId - Expected Workspace.
 * @param key - Expected record key.
 * @param entryType - Expected record type.
 * @returns Whether the row belongs to that key.
 */
function isRowOf(row: Record<string, unknown>, workspaceId: string, key: string, entryType: string) {
  return row.workspaceId === workspaceId && row.recordKey === key && row.entryType === entryType && row.schemaVersion === 1
}

/**
 * Creates the error for a malformed stored baseline.
 *
 * @returns The error.
 */
function corruptBaseline() {
  return new PlanningError(502, 'CycleScheduleBaselineCorruptState', 'The stored Cycle schedule baseline is invalid.')
}

/**
 * Creates the error for a baseline with too many entries.
 *
 * @returns The error.
 */
function tooLarge() {
  return new PlanningError(
    413,
    'CycleScheduleBaselineTooLarge',
    `A Cycle schedule baseline can hold at most ${CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES} Work Items.`,
  )
}

/**
 * Creates the error for a capture that raced another one or lost the caller's access.
 *
 * @returns The error.
 */
function conflict() {
  return new PlanningError(409, 'CycleScheduleBaselineConflict', 'The Cycle baselines or your permissions changed. Reload and try again.')
}

/** DynamoDB cancellation codes that mean the request may succeed if retried. */
const TRANSIENT_CANCELLATION_CODES = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']

/** SDK error names that mean the request may succeed if retried. */
const TRANSIENT_ERROR_NAMES = [
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'TransactionInProgressException',
  'TimeoutError',
]

/**
 * Maps a DynamoDB failure to a Planning error.
 *
 * A transaction cancelled only by failed conditions is a conflict; one cancelled by throttling
 * or a competing transaction is retryable; anything else is a storage failure.
 *
 * @param error - Thrown SDK error.
 * @param transactionSize - Number of items in the cancelled transaction, or 0 for a plain read.
 * @returns Never; always throws.
 */
function storageFailure(error: unknown, transactionSize = 0): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (
    name === 'TransactionCanceledException' &&
    typeof error === 'object' &&
    error !== null &&
    'CancellationReasons' in error &&
    Array.isArray(error.CancellationReasons)
  ) {
    const codes = error.CancellationReasons.map((reason: unknown) =>
      typeof reason === 'object' && reason !== null && 'Code' in reason ? String(reason.Code) : undefined)
    if (transactionSize > 0 && codes.length === transactionSize) {
      if (codes.includes('ConditionalCheckFailed') && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) {
        throw conflict()
      }
      const allowed = (code: string | undefined) =>
        code === 'None' || code === 'ConditionalCheckFailed' || (code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code))
      if (codes.some((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)) && codes.every(allowed)) {
        throw retryable()
      }
    }
  }
  if (typeof name === 'string' && TRANSIENT_ERROR_NAMES.includes(name)) throw retryable()
  throw new PlanningError(502, 'CycleScheduleBaselineStorageFailure', 'Cycle schedule baseline storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryable() {
  return new PlanningError(503, 'CycleScheduleBaselineRetryable', 'Cycle schedule baseline storage is temporarily unavailable.')
}
