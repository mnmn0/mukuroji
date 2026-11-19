import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  parseProjectRaidEntry,
  PROJECT_RAID_LOG_MAX_ENTRIES,
  type ProjectRaidEntry,
} from '@mukuroji/contracts'
import { createAuditFieldChanges, createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import { ProjectDataError } from '../../../directory'
import type {
  CreateProjectRaidEntryStoreInput,
  ProjectRaidLogScope,
  ProjectRaidLogStore as LogStore,
  UpdateProjectRaidEntryStoreInput,
} from '../../application/project-raid-log-use-cases'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type ProjectRaidLogCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Log persistence bound to DynamoDB authorization fences and the request audit context. */
export type ProjectRaidLogStore = LogStore<ProjectRaidLogCallerAuthorizationCheck, MutationAuditContext>

/** Creation input bound to DynamoDB fences. */
type CreateInput = CreateProjectRaidEntryStoreInput<ProjectRaidLogCallerAuthorizationCheck, MutationAuditContext>
/** Replacement input bound to DynamoDB fences. */
type UpdateInput = UpdateProjectRaidEntryStoreInput<ProjectRaidLogCallerAuthorizationCheck, MutationAuditContext>

/** Planning-table record type of one log entry. */
const ENTRY_TYPE = 'project-raid-entry'
/** Planning-table record type of the per-Project entry counter. */
const COUNTER_TYPE = 'project-raid-log'
/** Fields whose values are recorded in audit changes. */
const AUDIT_FIELDS = ['kind', 'title', 'description', 'probability', 'impact', 'response', 'reviewDueDate', 'status', 'revision']
/** Free-text fields whose values are redacted in audit changes. */
const AUDIT_REDACTED_FIELDS = ['description', 'response']

/**
 * Builds the record key prefix shared by a Project log's counter and entries.
 *
 * @param scope - Team and Project.
 * @returns The counter record key, which also prefixes every entry key.
 */
function counterKey(scope: Pick<ProjectRaidLogScope, 'teamId' | 'projectId'>) {
  return `PROJECT_RAID#${encodeURIComponent(scope.teamId)}#${encodeURIComponent(scope.projectId)}`
}

/**
 * Builds the record key of one log entry.
 *
 * @param scope - Team and Project.
 * @param entryId - Entry ID.
 * @returns The entry record key.
 */
function entryKey(scope: Pick<ProjectRaidLogScope, 'teamId' | 'projectId'>, entryId: string) {
  return `${counterKey(scope)}#ENTRY#${encodeURIComponent(entryId)}`
}

/** Stores each Project log entry as one Planning-table row, next to a per-Project entry counter. */
export class DynamoDbProjectRaidLogStore implements ProjectRaidLogStore {
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
   * Reads every entry of a Project log, following every page.
   *
   * @param scope - Team and Project.
   * @returns Every validated entry.
   */
  async list(scope: ProjectRaidLogScope): Promise<ProjectRaidEntry[]> {
    const prefix = `${counterKey(scope)}#ENTRY#`
    const entries: ProjectRaidEntry[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#workspaceId = :workspaceId AND begins_with(#recordKey, :prefix)',
        ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':workspaceId': scope.workspaceId, ':prefix': prefix },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })).catch((error: unknown) => storageFailure(error))
      for (const row of page.Items ?? []) {
        entries.push(parseStoredEntry(row, scope))
      }
      exclusiveStartKey = page.LastEvaluatedKey
      if (entries.length > PROJECT_RAID_LOG_MAX_ENTRIES) throw corruptLog()
    } while (exclusiveStartKey)
    return entries
  }

  /**
   * Reads one entry with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param entryId - Entry ID.
   * @returns The validated entry, or `null`.
   */
  async get(scope: ProjectRaidLogScope, entryId: string): Promise<ProjectRaidEntry | null> {
    const row = await this.readRow(scope, entryId)
    return row ? parseStoredEntry(row, scope) : null
  }

  /**
   * Adds an entry and advances the per-Project counter in one transaction.
   *
   * @param input - Creation input.
   * @returns The stored entry, or the entry an earlier identical request stored.
   */
  async create(input: CreateInput): Promise<ProjectRaidEntry> {
    requireCallerAuthorization(input.callerAuthorization)
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'project.raid_entry_created',
      entityType: 'project',
      entityId: input.projectId,
      target: { type: ENTRY_TYPE, id: input.entry.id },
      action: 'raid_entry_created',
      occurredAt: input.now,
      changes: createAuditFieldChanges(undefined, toAuditRecord(input.entry), AUDIT_FIELDS, AUDIT_REDACTED_FIELDS),
      metadata: { kind: input.entry.kind, projectId: input.projectId, teamId: input.teamId },
    })
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                ...rowIdentity(input, input.entry.id),
                creationFingerprint: input.creationFingerprint,
                ...input.entry,
              },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { workspaceId: input.workspaceId, recordKey: counterKey(input) },
              UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, #type = :type, #teamId = :teamId, #projectId = :projectId, #schemaVersion = :schemaVersion',
              ConditionExpression: 'attribute_not_exists(recordKey) OR (#type = :type AND #count < :max)',
              ExpressionAttributeNames: {
                '#count': 'entryCount',
                '#type': 'entryType',
                '#teamId': 'teamId',
                '#projectId': 'projectId',
                '#schemaVersion': 'schemaVersion',
              },
              ExpressionAttributeValues: {
                ':zero': 0,
                ':one': 1,
                ':max': PROJECT_RAID_LOG_MAX_ENTRIES,
                ':type': COUNTER_TYPE,
                ':teamId': input.teamId,
                ':projectId': input.projectId,
                ':schemaVersion': 1,
              },
            },
          },
          ...input.callerAuthorization,
          ...(audit ? [audit] : []),
        ],
      }))
    } catch (error) {
      const reasons = readCancellationCodes(error)
      if (reasons?.[0] === 'ConditionalCheckFailed') {
        // The entry ID comes from the request's idempotency key, so an existing entry means the
        // same request was already applied, unless it carried different content.
        const row = await this.readRow(input, input.entry.id)
        if (row && row.creationFingerprint === input.creationFingerprint) return parseStoredEntry(row, input)
        throw new ProjectDataError(409, 'ProjectRaidEntryIdempotencyConflict', 'This Idempotency-Key was already used for another log entry.')
      }
      if (reasons?.[1] === 'ConditionalCheckFailed') {
        throw new ProjectDataError(413, 'ProjectRaidLogFull', `A Project log can hold at most ${PROJECT_RAID_LOG_MAX_ENTRIES} entries.`)
      }
      return storageFailure(error, 2 + input.callerAuthorization.length + (audit ? 1 : 0))
    }
    return input.entry
  }

  /**
   * Replaces an entry when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored entry.
   */
  async update(input: UpdateInput): Promise<ProjectRaidEntry> {
    requireCallerAuthorization(input.callerAuthorization)
    const action = describeUpdateAction(input.previous, input.next)
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: `project.${action}`,
      entityType: 'project',
      entityId: input.projectId,
      target: { type: ENTRY_TYPE, id: input.next.id },
      action,
      occurredAt: input.now,
      changes: createAuditFieldChanges(
        toAuditRecord(input.previous),
        toAuditRecord(input.next),
        AUDIT_FIELDS,
        AUDIT_REDACTED_FIELDS,
      ),
      metadata: { kind: input.next.kind, projectId: input.projectId, teamId: input.teamId },
    })
    const previousRow = await this.readRow(input, input.next.id)
    const creationFingerprint = previousRow?.creationFingerprint
    if (typeof creationFingerprint !== 'string') {
      throw new ProjectDataError(409, 'ProjectRaidEntryConflict', 'The log entry changed. Reload and try again.')
    }
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: { ...rowIdentity(input, input.next.id), creationFingerprint, ...input.next },
              ConditionExpression: '#type = :type AND #revision = :revision',
              ExpressionAttributeNames: { '#type': 'entryType', '#revision': 'revision' },
              ExpressionAttributeValues: { ':type': ENTRY_TYPE, ':revision': input.previous.revision },
            },
          },
          ...input.callerAuthorization,
          ...(audit ? [audit] : []),
        ],
      }))
    } catch (error) {
      return storageFailure(error, 1 + input.callerAuthorization.length + (audit ? 1 : 0))
    }
    return input.next
  }

  /**
   * Reads the raw row of one entry with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param entryId - Entry ID.
   * @returns The raw row, or `undefined`.
   */
  private async readRow(scope: ProjectRaidLogScope, entryId: string): Promise<Record<string, unknown> | undefined> {
    const { Item: row } = await this.client
      .send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId: scope.workspaceId, recordKey: entryKey(scope, entryId) },
        ConsistentRead: true,
      }))
      .catch((error: unknown) => storageFailure(error))
    return row
  }
}

/** Isolated store for route and application tests. */
export class InMemoryProjectRaidLogStore implements ProjectRaidLogStore {
  /** Entries and their creation fingerprints keyed by Workspace, Team, Project, and entry. */
  private readonly rows = new Map<string, { entry: ProjectRaidEntry; creationFingerprint: string }>()

  /**
   * Reads copies of every entry of a Project log.
   *
   * @param scope - Team and Project.
   * @returns The entries.
   */
  async list(scope: ProjectRaidLogScope): Promise<ProjectRaidEntry[]> {
    const prefix = JSON.stringify([scope.workspaceId, scope.teamId, scope.projectId]).slice(0, -1)
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${prefix},`))
      .map(([, row]) => structuredClone(row.entry))
  }

  /**
   * Reads a copy of one entry.
   *
   * @param scope - Team and Project.
   * @param entryId - Entry ID.
   * @returns The entry, or `null`.
   */
  async get(scope: ProjectRaidLogScope, entryId: string): Promise<ProjectRaidEntry | null> {
    return structuredClone(this.rows.get(memoryKey(scope, entryId))?.entry ?? null)
  }

  /**
   * Adds an entry.
   *
   * @param input - Creation input.
   * @returns The stored entry, or the entry an earlier identical request stored.
   */
  async create(input: CreateInput): Promise<ProjectRaidEntry> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = memoryKey(input, input.entry.id)
    const existing = this.rows.get(key)
    if (existing) {
      if (existing.creationFingerprint === input.creationFingerprint) return structuredClone(existing.entry)
      throw new ProjectDataError(409, 'ProjectRaidEntryIdempotencyConflict', 'This Idempotency-Key was already used for another log entry.')
    }
    if ((await this.list(input)).length >= PROJECT_RAID_LOG_MAX_ENTRIES) {
      throw new ProjectDataError(413, 'ProjectRaidLogFull', `A Project log can hold at most ${PROJECT_RAID_LOG_MAX_ENTRIES} entries.`)
    }
    this.rows.set(key, { entry: structuredClone(input.entry), creationFingerprint: input.creationFingerprint })
    return input.entry
  }

  /**
   * Replaces an entry when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored entry.
   */
  async update(input: UpdateInput): Promise<ProjectRaidEntry> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = memoryKey(input, input.next.id)
    const existing = this.rows.get(key)
    if (!existing || existing.entry.revision !== input.previous.revision) {
      throw new ProjectDataError(409, 'ProjectRaidEntryConflict', 'The log entry changed. Reload and try again.')
    }
    this.rows.set(key, { entry: structuredClone(input.next), creationFingerprint: existing.creationFingerprint })
    return input.next
  }
}

/**
 * Builds the in-memory key of one entry.
 *
 * @param scope - Team and Project.
 * @param entryId - Entry ID.
 * @returns The key.
 */
function memoryKey(scope: ProjectRaidLogScope, entryId: string) {
  return JSON.stringify([scope.workspaceId, scope.teamId, scope.projectId, entryId])
}

/**
 * Builds the identity attributes of one entry row.
 *
 * @param scope - Team and Project.
 * @param entryId - Entry ID.
 * @returns The key, record type, schema version, and owning Team and Project.
 */
function rowIdentity(scope: ProjectRaidLogScope, entryId: string) {
  return {
    workspaceId: scope.workspaceId,
    recordKey: entryKey(scope, entryId),
    entryType: ENTRY_TYPE,
    schemaVersion: 1,
    teamId: scope.teamId,
    projectId: scope.projectId,
  }
}

/**
 * Names the audit action of an entry replacement.
 *
 * @param previous - Entry before the change.
 * @param next - Entry after the change.
 * @returns `raid_entry_closed`, `raid_entry_reopened`, or `raid_entry_updated`.
 */
function describeUpdateAction(previous: ProjectRaidEntry, next: ProjectRaidEntry) {
  if (previous.status === 'open' && next.status === 'closed') return 'raid_entry_closed'
  if (previous.status === 'closed' && next.status === 'open') return 'raid_entry_reopened'
  return 'raid_entry_updated'
}

/**
 * Converts an entry to the plain record compared for audit changes.
 *
 * @param entry - Entry.
 * @returns The entry fields as a record.
 */
function toAuditRecord(entry: ProjectRaidEntry): Record<string, unknown> {
  return { ...entry }
}

/**
 * Refuses a write without the caller's commit-time authorization fences.
 *
 * @param checks - Caller authorization checks.
 */
function requireCallerAuthorization(checks: readonly unknown[]) {
  if (checks.length === 0) {
    throw new ProjectDataError(503, 'ProjectRaidLogAuthorizationUnavailable', 'Caller authorization is unavailable.')
  }
}

/**
 * Validates a stored entry row.
 *
 * @param row - Raw DynamoDB item.
 * @param scope - Expected Workspace, Team, and Project.
 * @returns The entry.
 * @throws ProjectDataError when the row is malformed or belongs to another scope.
 */
function parseStoredEntry(row: Record<string, unknown>, scope: ProjectRaidLogScope): ProjectRaidEntry {
  const entry = parseProjectRaidEntry(row)
  if (
    !entry ||
    row.workspaceId !== scope.workspaceId ||
    row.recordKey !== entryKey(scope, entry.id) ||
    row.entryType !== ENTRY_TYPE ||
    row.schemaVersion !== 1 ||
    row.teamId !== scope.teamId ||
    row.projectId !== scope.projectId
  ) {
    throw corruptLog()
  }
  return entry
}

/**
 * Creates the error for a malformed stored log.
 *
 * @returns The error.
 */
function corruptLog() {
  return new ProjectDataError(502, 'ProjectRaidLogCorruptState', 'The stored Project log is invalid.')
}

/**
 * Reads the cancellation reason codes of a cancelled transaction.
 *
 * @param error - Thrown SDK error.
 * @returns The codes in transaction order, or `undefined` for any other error.
 */
function readCancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('name' in error) ||
    error.name !== 'TransactionCanceledException' ||
    !('CancellationReasons' in error) ||
    !Array.isArray(error.CancellationReasons)
  ) {
    return undefined
  }
  return error.CancellationReasons.map((reason: unknown) =>
    typeof reason === 'object' && reason !== null && 'Code' in reason ? String(reason.Code) : undefined)
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
  if (error instanceof ProjectDataError) throw error
  const codes = readCancellationCodes(error)
  if (codes && transactionSize > 0 && codes.length === transactionSize) {
    const isConditionOrNone = (code: string | undefined) => code === 'None' || code === 'ConditionalCheckFailed'
    if (codes.includes('ConditionalCheckFailed') && codes.every(isConditionOrNone)) {
      throw new ProjectDataError(409, 'ProjectRaidEntryConflict', 'The log entry or your permissions changed. Reload and try again.')
    }
    if (
      codes.some((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)) &&
      codes.every((code) => isConditionOrNone(code) || (code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)))
    ) {
      throw retryableFailure()
    }
  }
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (
    typeof name === 'string' &&
    ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)
  ) {
    throw retryableFailure()
  }
  throw new ProjectDataError(502, 'ProjectRaidLogStorageFailure', 'Project log storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'ProjectRaidLogRetryable', 'Project log storage is temporarily unavailable.')
}
