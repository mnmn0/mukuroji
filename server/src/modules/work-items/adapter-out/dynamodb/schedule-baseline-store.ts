import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  isProjectScheduleBaselineId,
  isProjectScheduleBaselineName,
  isProjectScheduleBaselineCapturedAt,
  parseProjectScheduleBaselineEntry,
  parseSavedProjectScheduleBaselines,
  PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES,
  type ProjectScheduleBaseline,
  type ProjectScheduleBaselineEntry,
} from '@mukuroji/contracts'
import { createAuditFieldChanges, createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import { ProjectDataError } from '../../../directory'
import type {
  ActiveProjectScheduleBaseline,
  ProjectScheduleBaselineStore as BaselineStore,
  WriteProjectScheduleBaselineInput as WriteInput,
} from '../../application/use-cases/project-schedule-baseline'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type ScheduleBaselineCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Write input with DynamoDB authorization fences and the request audit context. */
export type WriteProjectScheduleBaselineInput = WriteInput<ScheduleBaselineCallerAuthorizationCheck, MutationAuditContext>

/** Baseline persistence bound to DynamoDB authorization fences and the request audit context. */
export type ProjectScheduleBaselineStore = BaselineStore<ScheduleBaselineCallerAuthorizationCheck, MutationAuditContext>

/** Planning-table record type of a Project's active schedule baseline. */
const ENTRY_TYPE = 'project-schedule-baseline'

/** Planning-table record type of one saved named baseline. */
const SAVED_ENTRY_TYPE = 'project-schedule-baseline-saved'

/** Baseline fields whose values the audit event records. */
const AUDIT_FIELDS = ['baselineId', 'revision', 'capturedAt', 'entryCount'] as const

/**
 * Builds the Planning-table record key of a Project's active schedule baseline.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The record key.
 */
function recordKey(teamId: string, projectId: string) {
  return `PROJECT_SCHEDULE_BASELINE#${encodeURIComponent(teamId)}#${encodeURIComponent(projectId)}`
}

/**
 * Builds the Planning-table record key of one saved baseline.
 *
 * The prefix differs from the active row's, so no key of one kind starts with a key of the other.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @param baselineId - Saved baseline ID.
 * @returns The record key.
 */
function savedRecordKey(teamId: string, projectId: string, baselineId: string) {
  return `PROJECT_SCHEDULE_BASELINE_SAVED#${encodeURIComponent(teamId)}#${encodeURIComponent(projectId)}#${encodeURIComponent(baselineId)}`
}

/**
 * Rejects a write holding more entries than one record may store.
 *
 * @param entries - Entries to store.
 */
function assertEntryLimit(entries: readonly ProjectScheduleBaselineEntry[]) {
  if (entries.length > PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES) {
    throw new ProjectDataError(
      413,
      'ScheduleBaselineTooLarge',
      `A schedule baseline can hold at most ${PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES} Work Items.`,
    )
  }
}

/**
 * Stores each Project's active schedule baseline as one row in the Planning table, with the list
 * of saved baselines, and each saved baseline as a row of its own.
 */
export class DynamoDbProjectScheduleBaselineStore implements ProjectScheduleBaselineStore {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected document client. */
  private readonly client: DynamoDBDocumentClient
  /** Audit event table, when audit is configured. */
  private readonly auditTableName: string | undefined

  /**
   * Creates the store.
   *
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   * @param auditTableName - Audit event table written in the same transaction, when configured.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, auditTableName?: string) {
    this.tableName = tableName
    this.client = client
    this.auditTableName = auditTableName
  }

  /**
   * Reads the active baseline of a Project with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @returns The validated baseline, or `null` when none was captured.
   */
  async get(workspaceId: string, teamId: string, projectId: string): Promise<ActiveProjectScheduleBaseline | null> {
    const key = recordKey(teamId, projectId)
    const row = await this.readRow(workspaceId, key)
    if (row === undefined) return null
    const baseline = parseStoredBaseline(row, workspaceId, key, ENTRY_TYPE)
    const savedBaselines = row.savedBaselines === undefined ? [] : parseSavedProjectScheduleBaselines(row.savedBaselines)
    if (!savedBaselines) throw corruptBaseline()
    return { ...baseline, savedBaselines }
  }

  /**
   * Reads one saved baseline with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @param baselineId - Saved baseline ID.
   * @returns The validated baseline, or `null` when it is not stored.
   */
  async getSaved(
    workspaceId: string,
    teamId: string,
    projectId: string,
    baselineId: string,
  ): Promise<ProjectScheduleBaseline | null> {
    const key = savedRecordKey(teamId, projectId, baselineId)
    const row = await this.readRow(workspaceId, key)
    if (row === undefined) return null
    const baseline = parseStoredBaseline(row, workspaceId, key, SAVED_ENTRY_TYPE)
    if (baseline.id !== baselineId) throw corruptBaseline()
    return baseline
  }

  /**
   * Builds a transaction check that the active baseline is still the one a caller read, so a
   * change measured against it cannot commit after the baseline was captured or switched.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline was read.
   * @param revision - Revision that was read, or `null` when no baseline was stored.
   * @returns The ConditionCheck item.
   */
  createActiveRevisionConditionCheck(
    workspaceId: string,
    teamId: string,
    projectId: string,
    revision: number | null,
  ): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
    const Key = { workspaceId, recordKey: recordKey(teamId, projectId) }
    if (revision === null) {
      return { ConditionCheck: { TableName: this.tableName, Key, ConditionExpression: 'attribute_not_exists(recordKey)' } }
    }
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key,
        ConditionExpression: '#revision = :revision AND #type = :type',
        ExpressionAttributeNames: { '#revision': 'revision', '#type': 'entryType' },
        ExpressionAttributeValues: { ':revision': revision, ':type': ENTRY_TYPE },
      },
    }
  }

  /**
   * Replaces the active baseline with a compare-and-set on its revision, and stores, in the same
   * transaction, the new saved rows, the deletions of dropped saved rows, the caller's
   * authorization fences, and the audit event.
   *
   * @param input - Write input.
   * @returns The stored active baseline.
   */
  async write(input: WriteProjectScheduleBaselineInput): Promise<ProjectScheduleBaseline> {
    assertEntryLimit(input.baseline.entries)
    for (const saved of input.savedRowsToPut) assertEntryLimit(saved.entries)
    if (input.callerAuthorization.length === 0) {
      throw new ProjectDataError(503, 'ScheduleBaselineAuthorizationUnavailable', 'Caller authorization is unavailable.')
    }
    const expectedRevision = input.expectedRevision
    const baseline = copyBaseline({ ...input.baseline, revision: expectedRevision + 1 })
    const audit = createScheduleBaselineAuditPut(this.auditTableName, input, baseline)
    const scope = { workspaceId: input.workspaceId, teamId: input.teamId, projectId: input.projectId }
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...scope,
            recordKey: recordKey(input.teamId, input.projectId),
            entryType: ENTRY_TYPE,
            schemaVersion: 1,
            ...baseline,
            savedBaselines: input.savedBaselines.map((item) => ({ ...item })),
          },
          ConditionExpression: expectedRevision > 0
            ? '#revision = :revision AND #type = :type'
            : 'attribute_not_exists(recordKey)',
          ...(expectedRevision > 0
            ? {
                ExpressionAttributeNames: { '#revision': 'revision', '#type': 'entryType' },
                ExpressionAttributeValues: { ':revision': expectedRevision, ':type': ENTRY_TYPE },
              }
            : {}),
        },
      },
      ...input.savedRowsToPut.map((saved) => ({
        Put: {
          TableName: this.tableName,
          Item: {
            ...scope,
            recordKey: savedRecordKey(input.teamId, input.projectId, saved.id),
            entryType: SAVED_ENTRY_TYPE,
            schemaVersion: 1,
            ...copyBaseline(saved),
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      })),
      ...input.savedIdsToDelete.map((baselineId) => ({
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: savedRecordKey(input.teamId, input.projectId, baselineId) },
        },
      })),
      ...input.callerAuthorization,
      ...(audit ? [audit] : []),
    ]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      return storageFailure(error, transactItems.length)
    }
    return baseline
  }

  /**
   * Reads one Planning-table row with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param key - Record key.
   * @returns The raw row, or undefined when it does not exist.
   */
  private async readRow(workspaceId: string, key: string): Promise<Record<string, unknown> | undefined> {
    const { Item: row } = await this.client
      .send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true }))
      .catch((error: unknown) => storageFailure(error))
    return row
  }
}

/**
 * Copies a baseline into the fields a row stores, leaving out absent optional fields.
 *
 * @param baseline - Baseline to store.
 * @returns A copy that shares no arrays with the input.
 */
function copyBaseline(baseline: ProjectScheduleBaseline): ProjectScheduleBaseline {
  return {
    revision: baseline.revision,
    ...(baseline.id === undefined ? {} : { id: baseline.id }),
    ...(baseline.name === undefined ? {} : { name: baseline.name }),
    capturedAt: baseline.capturedAt,
    entries: baseline.entries.map((entry) => ({ ...entry })),
  }
}

/**
 * Builds the audit event of a write: `project.schedule_baseline_captured` for a Project's first
 * baseline, `project.schedule_baseline_replaced` when a capture replaces the active baseline,
 * and `project.schedule_baseline_activated` when a saved baseline is made active.
 *
 * The event keeps the baseline ID, revision, capture time, and Work Item count of both active
 * baselines, and not the Work Item IDs, dates, or the baseline names, which the rows hold.
 *
 * @param auditTableName - Audit event table, when configured.
 * @param input - Write input.
 * @param baseline - Active baseline being stored.
 * @returns The conditional audit Put, or undefined when audit is not configured.
 */
function createScheduleBaselineAuditPut(
  auditTableName: string | undefined,
  input: WriteProjectScheduleBaselineInput,
  baseline: ProjectScheduleBaseline & { id?: string },
) {
  const action = scheduleBaselineAuditAction(input)
  const after = {
    ...(baseline.id === undefined ? {} : { baselineId: baseline.id }),
    revision: baseline.revision,
    capturedAt: baseline.capturedAt,
    entryCount: baseline.entries.length,
  }
  return createMutationAuditEventPut(auditTableName, input.auditContext, {
    directoryId: input.workspaceId,
    eventType: `project.${action}`,
    entityType: 'project',
    entityId: input.projectId,
    target: { type: ENTRY_TYPE, id: input.projectId },
    action,
    occurredAt: input.writtenAt,
    changes: createAuditFieldChanges(input.previous ?? undefined, after, AUDIT_FIELDS),
    metadata: {
      teamId: input.teamId,
      projectId: input.projectId,
      savedBaselineCount: input.savedBaselines.length,
      ...(input.savedIdsToDelete.length > 0 ? { droppedBaselineIds: input.savedIdsToDelete } : {}),
    },
  })
}

/**
 * Names the audited action of a write.
 *
 * @param input - Write input.
 * @returns The action.
 */
function scheduleBaselineAuditAction(input: Pick<WriteProjectScheduleBaselineInput, 'kind' | 'previous'>) {
  if (input.kind === 'activate') return 'schedule_baseline_activated'
  return input.previous ? 'schedule_baseline_replaced' : 'schedule_baseline_captured'
}

/** Isolated store for route and application tests. */
export class InMemoryProjectScheduleBaselineStore implements ProjectScheduleBaselineStore {
  /** Active baselines keyed by Workspace, Team, and Project. */
  private readonly baselines = new Map<string, ActiveProjectScheduleBaseline>()
  /** Saved baselines keyed by Workspace, Team, Project, and baseline ID. */
  private readonly saved = new Map<string, ProjectScheduleBaseline>()
  /** Audit events the writes would record, oldest first, for tests to inspect. */
  readonly auditEvents: { eventType: string; projectId: string; actorId: string; revision: number }[] = []

  /**
   * Reads a copy of a Project's active baseline.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @returns The baseline, or `null`.
   */
  async get(workspaceId: string, teamId: string, projectId: string): Promise<ActiveProjectScheduleBaseline | null> {
    return structuredClone(this.baselines.get(JSON.stringify([workspaceId, teamId, projectId])) ?? null)
  }

  /**
   * Reads a copy of one saved baseline.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @param baselineId - Saved baseline ID.
   * @returns The baseline, or `null`.
   */
  async getSaved(
    workspaceId: string,
    teamId: string,
    projectId: string,
    baselineId: string,
  ): Promise<ProjectScheduleBaseline | null> {
    return structuredClone(this.saved.get(JSON.stringify([workspaceId, teamId, projectId, baselineId])) ?? null)
  }

  /**
   * Writes a Project's active baseline and its saved rows.
   *
   * @param input - Write input.
   * @returns The stored active baseline.
   */
  async write(input: WriteProjectScheduleBaselineInput): Promise<ProjectScheduleBaseline> {
    assertEntryLimit(input.baseline.entries)
    const key = JSON.stringify([input.workspaceId, input.teamId, input.projectId])
    if ((this.baselines.get(key)?.revision ?? 0) !== input.expectedRevision) {
      throw new ProjectDataError(409, 'ScheduleBaselineConflict', 'The schedule baseline changed. Reload and try again.')
    }
    const savedKey = (baselineId: string) =>
      JSON.stringify([input.workspaceId, input.teamId, input.projectId, baselineId])
    if (input.savedRowsToPut.some((saved) => this.saved.has(savedKey(saved.id)))) {
      throw new ProjectDataError(409, 'ScheduleBaselineConflict', 'The schedule baseline changed. Reload and try again.')
    }
    const baseline = copyBaseline({ ...input.baseline, revision: input.expectedRevision + 1 })
    this.baselines.set(key, structuredClone({ ...baseline, savedBaselines: input.savedBaselines }))
    for (const saved of input.savedRowsToPut) this.saved.set(savedKey(saved.id), copyBaseline(saved))
    for (const baselineId of input.savedIdsToDelete) this.saved.delete(savedKey(baselineId))
    this.auditEvents.push({
      eventType: `project.${scheduleBaselineAuditAction(input)}`,
      projectId: input.projectId,
      actorId: input.auditContext.actor.id,
      revision: baseline.revision,
    })
    return baseline
  }
}

/**
 * Validates a stored baseline row.
 *
 * @param row - Raw DynamoDB item.
 * @param workspaceId - Expected Workspace.
 * @param key - Expected record key.
 * @param entryType - Expected record type.
 * @returns The baseline.
 * @throws ProjectDataError when the row is malformed.
 */
function parseStoredBaseline(
  row: Record<string, unknown>,
  workspaceId: string,
  key: string,
  entryType: string,
): ProjectScheduleBaseline {
  const { revision, id, name, capturedAt, entries } = row
  if (
    row.workspaceId !== workspaceId ||
    row.recordKey !== key ||
    row.entryType !== entryType ||
    row.schemaVersion !== 1 ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (id !== undefined && !isProjectScheduleBaselineId(id)) ||
    (name !== undefined && !isProjectScheduleBaselineName(name)) ||
    !isProjectScheduleBaselineCapturedAt(capturedAt) ||
    !Array.isArray(entries) ||
    entries.length > PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES
  ) {
    throw corruptBaseline()
  }
  const parsed: ProjectScheduleBaselineEntry[] = []
  for (const entry of entries) {
    const value = parseProjectScheduleBaselineEntry(entry)
    if (!value) throw corruptBaseline()
    parsed.push(value)
  }
  return {
    revision,
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    capturedAt,
    entries: parsed,
  }
}

/**
 * Creates the error for a malformed stored baseline.
 *
 * @returns The error.
 */
function corruptBaseline() {
  return new ProjectDataError(502, 'ScheduleBaselineCorruptState', 'The stored schedule baseline is invalid.')
}

/** DynamoDB cancellation codes that mean the request may succeed if retried. */
const TRANSIENT_CANCELLATION_CODES = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']

/**
 * Maps a DynamoDB failure to a Project data error.
 *
 * A transaction cancelled only by failed conditions is a conflict. One cancelled by throttling
 * or a competing transaction is retryable, and any other cancellation is a storage failure.
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
        throw new ProjectDataError(
          409,
          'ScheduleBaselineConflict',
          'The schedule baseline or your permissions changed. Reload and try again.',
        )
      }
      if (
        codes.some((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)) &&
        codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed' || (code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)))
      ) {
        throw retryableFailure()
      }
    }
  }
  if (
    typeof name === 'string' &&
    ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)
  ) {
    throw retryableFailure()
  }
  throw new ProjectDataError(502, 'ScheduleBaselineStorageFailure', 'Schedule baseline storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'ScheduleBaselineRetryable', 'Schedule baseline storage is temporarily unavailable.')
}
