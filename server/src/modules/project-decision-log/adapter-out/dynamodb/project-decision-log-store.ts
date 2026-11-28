import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  parseProjectDecisionEntry,
  PROJECT_DECISION_LOG_MAX_ENTRIES,
  type ProjectDecisionEntry,
} from '@mukuroji/contracts'
import { createAuditFieldChanges, createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import { ProjectDataError } from '../../../directory'
import {
  findProjectDecisionUpdateReceipt,
  PROJECT_DECISION_UPDATE_RECEIPTS_MAX,
  type CreateProjectDecisionEntryStoreInput,
  ProjectDecisionEntryRecord,
  ProjectDecisionLogScope,
  ProjectDecisionLogStore as LogStore,
  ProjectDecisionUpdateReceipt,
  TeamProjectDecisionEntry,
  UpdateProjectDecisionEntryStoreInput,
} from '../../application/project-decision-log-use-cases'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type ProjectDecisionLogCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Decision log persistence bound to DynamoDB authorization fences and the request audit context. */
export type ProjectDecisionLogStore = LogStore<ProjectDecisionLogCallerAuthorizationCheck, MutationAuditContext>

/** Creation input bound to DynamoDB fences. */
type CreateInput = CreateProjectDecisionEntryStoreInput<ProjectDecisionLogCallerAuthorizationCheck, MutationAuditContext>
/** Replacement input bound to DynamoDB fences. */
type UpdateInput = UpdateProjectDecisionEntryStoreInput<ProjectDecisionLogCallerAuthorizationCheck, MutationAuditContext>

/** Planning-table record type of one decision. */
const ENTRY_TYPE = 'project-decision-entry'
/** Planning-table record type of the per-Project decision counter. */
const COUNTER_TYPE = 'project-decision-log'
/** Schema version of the counter and decision rows. */
const SCHEMA_VERSION = 1
/** Fields whose changes are recorded in audit events. */
const AUDIT_FIELDS = [
  'title',
  'content',
  'rationale',
  'deciderMemberIds',
  'deciderNote',
  'decidedAt',
  'relatedWorkItemIds',
  'sources',
  'status',
  'supersededByEntryId',
  'origin',
  'revision',
]
/**
 * Fields whose values are redacted in audit changes: free text, links that may name private
 * channels, and member keys. The audit event's actor already records who changed the decision.
 */
const AUDIT_REDACTED_FIELDS = ['title', 'content', 'rationale', 'deciderMemberIds', 'deciderNote', 'sources']

/**
 * Builds the record key prefix of every decision log of a Team.
 *
 * @param teamId - Team ID.
 * @returns The prefix, which ends with the separator before the Project ID.
 */
function teamPrefix(teamId: string) {
  return `PROJECT_DECISION#${encodeURIComponent(teamId)}#`
}

/**
 * Builds the record key prefix shared by a Project log's counter and decisions.
 *
 * @param scope - Team and Project.
 * @returns The counter record key, which also prefixes every decision key.
 */
function counterKey(scope: Pick<ProjectDecisionLogScope, 'teamId' | 'projectId'>) {
  return `${teamPrefix(scope.teamId)}${encodeURIComponent(scope.projectId)}`
}

/**
 * Builds the record key of one decision.
 *
 * @param scope - Team and Project.
 * @param entryId - Entry ID.
 * @returns The decision record key.
 */
function entryKey(scope: Pick<ProjectDecisionLogScope, 'teamId' | 'projectId'>, entryId: string) {
  return `${counterKey(scope)}#ENTRY#${encodeURIComponent(entryId)}`
}

/** Stores each decision as one Planning-table row, next to a per-Project decision counter (ADR 0114). */
export class DynamoDbProjectDecisionLogStore implements ProjectDecisionLogStore {
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
   * Reads every decision of a Project log, following every page.
   *
   * @param scope - Team and Project.
   * @returns Every validated decision.
   */
  async list(scope: ProjectDecisionLogScope): Promise<ProjectDecisionEntry[]> {
    const entries: ProjectDecisionEntry[] = []
    for await (const row of this.queryRows(scope.workspaceId, `${counterKey(scope)}#ENTRY#`, true)) {
      entries.push(parseStoredEntry(row, scope))
      if (entries.length > PROJECT_DECISION_LOG_MAX_ENTRIES) throw corruptLog()
    }
    return entries
  }

  /**
   * Reads every decision of the Team's Projects with eventually consistent reads.
   *
   * Counter rows are told apart by their record key, not by a stored attribute, so a decision row
   * whose attributes are broken fails the read instead of being left out.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team ID.
   * @returns Every validated decision with its Project.
   */
  async listTeam(workspaceId: string, teamId: string): Promise<TeamProjectDecisionEntry[]> {
    const entries: TeamProjectDecisionEntry[] = []
    const prefix = teamPrefix(teamId)
    for await (const row of this.queryRows(workspaceId, prefix, false)) {
      const recordKey = row.recordKey
      if (typeof recordKey !== 'string' || !recordKey.startsWith(prefix)) throw corruptLog()
      // A Project's counter key is the prefix and the Project ID alone; decision keys go on.
      if (!recordKey.slice(prefix.length).includes('#ENTRY#')) continue
      const projectId = row.projectId
      if (typeof projectId !== 'string') throw corruptLog()
      entries.push({ projectId, entry: parseStoredEntry(row, { workspaceId, teamId, projectId }) })
    }
    return entries
  }

  /**
   * Reads one decision with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param entryId - Entry ID.
   * @returns The validated decision and its last update receipt, or `null`.
   */
  async get(scope: ProjectDecisionLogScope, entryId: string): Promise<ProjectDecisionEntryRecord | null> {
    const row = await this.readRow(scope, entryId)
    if (!row) return null
    return { entry: parseStoredEntry(row, scope), updateReceipts: parseUpdateReceipts(row) }
  }

  /**
   * Adds a decision and advances the per-Project counter in one transaction.
   *
   * @param input - Creation input.
   * @returns The stored decision, or the decision an earlier identical request stored.
   */
  async create(input: CreateInput): Promise<ProjectDecisionEntry> {
    requireCallerAuthorization(input.callerAuthorization)
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'project.decision_recorded',
      entityType: 'project',
      entityId: input.projectId,
      target: { type: ENTRY_TYPE, id: input.entry.id },
      action: 'decision_recorded',
      occurredAt: input.now,
      changes: createAuditFieldChanges(undefined, { ...input.entry }, AUDIT_FIELDS, AUDIT_REDACTED_FIELDS),
      metadata: { origin: input.entry.origin, projectId: input.projectId, teamId: input.teamId },
    })
    // DynamoDB numbers may hold fractions, so the count is checked to be a whole number here and
    // the transaction then requires that exact count.
    const count = readCounterCount(await this.readCounter(input), input)
    if (count !== undefined && count >= PROJECT_DECISION_LOG_MAX_ENTRIES) {
      // A key already used here answers as it would below the limit, so only a new decision is refused as full.
      const row = await this.readRow(input, input.entry.id)
      if (!row) throw logFull()
      if (row.creationFingerprint === input.creationFingerprint) return parseStoredEntry(row, input)
      throw creationKeyConflict()
    }
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
              UpdateExpression: 'SET #count = :next, #type = :type, #teamId = :teamId, #projectId = :projectId, #schemaVersion = :schemaVersion',
              // The counter must still be missing, or still be this Project's with the count read above.
              ConditionExpression: count === undefined
                ? 'attribute_not_exists(recordKey)'
                : '#type = :type AND #schemaVersion = :schemaVersion AND #teamId = :teamId AND #projectId = :projectId AND #count = :count',
              ExpressionAttributeNames: {
                '#count': 'entryCount',
                '#type': 'entryType',
                '#teamId': 'teamId',
                '#projectId': 'projectId',
                '#schemaVersion': 'schemaVersion',
              },
              ExpressionAttributeValues: {
                ...(count === undefined ? {} : { ':count': count }),
                ':next': (count ?? 0) + 1,
                ':type': COUNTER_TYPE,
                ':teamId': input.teamId,
                ':projectId': input.projectId,
                ':schemaVersion': SCHEMA_VERSION,
              },
            },
          },
          ...input.callerAuthorization,
          ...(audit ? [audit] : []),
        ],
      }))
    } catch (error) {
      const reasons = readCancellationCodes(error)
      const transactionSize = 2 + input.callerAuthorization.length + (audit ? 1 : 0)
      // A caller whose access changed, or whose fences did not pass cleanly, gets the same answer
      // as for any other write, even when the decision or the counter also failed.
      if (!callerFencesPassed(reasons, 2, input.callerAuthorization.length)) return storageFailure(error, transactionSize)
      if (reasons?.[0] === 'ConditionalCheckFailed') {
        // The entry ID comes from the request's idempotency key, so an existing decision means
        // the same request was already applied, unless it carried different content.
        const row = await this.readRow(input, input.entry.id)
        if (row && row.creationFingerprint === input.creationFingerprint) return parseStoredEntry(row, input)
        throw creationKeyConflict()
      }
      if (reasons?.[1] === 'ConditionalCheckFailed') {
        // A valid counter at the limit means the log is full, and a valid counter below it means
        // another decision was added meanwhile; any other counter is corrupt.
        const current = await this.readCounter(input)
        if (isCounterAtLimit(current, input)) throw logFull()
        readCounterCount(current, input)
        throw retryableFailure()
      }
      return storageFailure(error, transactionSize)
    }
    return input.entry
  }

  /**
   * Replaces a decision when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored decision.
   */
  async update(input: UpdateInput): Promise<ProjectDecisionEntry> {
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
      changes: createAuditFieldChanges({ ...input.previous }, { ...input.next }, AUDIT_FIELDS, AUDIT_REDACTED_FIELDS),
      metadata: { origin: input.next.origin, projectId: input.projectId, teamId: input.teamId },
    })
    const previousRow = await this.readRow(input, input.next.id)
    // A decision removed meanwhile is a conflict; a stored decision without its creation
    // fingerprint is broken, and reloading would not fix it.
    if (!previousRow) throw new ProjectDataError(409, 'ProjectDecisionEntryConflict', 'The decision changed. Reload and try again.')
    const creationFingerprint = previousRow.creationFingerprint
    if (typeof creationFingerprint !== 'string') throw corruptLog()
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                ...rowIdentity(input, input.next.id),
                creationFingerprint,
                updateReceipts: nextUpdateReceipts(input),
                ...input.next,
              },
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
      const transactionSize = 1 + input.callerAuthorization.length + (audit ? 1 : 0)
      const reasons = readCancellationCodes(error)
      // Only a revision failure with every caller fence confirmed may turn into an earlier success.
      if (callerFencesPassed(reasons, 1, input.callerAuthorization.length) && reasons?.[0] === 'ConditionalCheckFailed') {
        // A concurrent attempt of this same request may have taken the revision first.
        const current = await this.readRow(input, input.next.id)
        if (current) {
          const earlier = findProjectDecisionUpdateReceipt(parseUpdateReceipts(current), input.updateKey, input.updateReceipt)
          if (earlier === 'applied') return parseStoredEntry(current, input)
          if (earlier === 'reused') {
            throw new ProjectDataError(409, 'ProjectDecisionEntryIdempotencyConflict', 'This Idempotency-Key was already used for another change.')
          }
        }
      }
      return storageFailure(error, transactionSize)
    }
    return input.next
  }

  /**
   * Reads every row under a record key prefix, following every page.
   *
   * @param workspaceId - Workspace directory ID.
   * @param prefix - Record key prefix.
   * @param consistentRead - Whether to read strongly consistent.
   * @returns The raw rows.
   */
  private async *queryRows(
    workspaceId: string,
    prefix: string,
    consistentRead: boolean,
  ): AsyncGenerator<Record<string, unknown>> {
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#workspaceId = :workspaceId AND begins_with(#recordKey, :prefix)',
        ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': prefix },
        ConsistentRead: consistentRead,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })).catch((error: unknown) => storageFailure(error))
      yield* page.Items ?? []
      exclusiveStartKey = page.LastEvaluatedKey
    } while (exclusiveStartKey)
  }

  /**
   * Reads the raw per-Project counter row with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @returns The raw row, or `undefined`.
   */
  private async readCounter(scope: ProjectDecisionLogScope): Promise<Record<string, unknown> | undefined> {
    const { Item: row } = await this.client
      .send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId: scope.workspaceId, recordKey: counterKey(scope) },
        ConsistentRead: true,
      }))
      .catch((error: unknown) => storageFailure(error))
    return row
  }

  /**
   * Reads the raw row of one decision with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param entryId - Entry ID.
   * @returns The raw row, or `undefined`.
   */
  private async readRow(scope: ProjectDecisionLogScope, entryId: string): Promise<Record<string, unknown> | undefined> {
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
export class InMemoryProjectDecisionLogStore implements ProjectDecisionLogStore {
  /** Decisions and their creation and update receipts keyed by Workspace, Team, Project, and entry. */
  private readonly rows = new Map<string, {
    /** Workspace, Team, and Project the decision belongs to. */
    scope: ProjectDecisionLogScope
    /** Latest stored decision. */
    entry: ProjectDecisionEntry
    /** Fingerprint of the creating request's input, kept through every update. */
    creationFingerprint: string
    /** Receipts of the latest updates, oldest first, as on the DynamoDB row. */
    updateReceipts: ProjectDecisionUpdateReceipt[]
  }>()

  /**
   * Reads copies of every decision of a Project log.
   *
   * @param scope - Team and Project.
   * @returns The decisions.
   */
  async list(scope: ProjectDecisionLogScope): Promise<ProjectDecisionEntry[]> {
    return this.rowsOf(scope).map((row) => structuredClone(row.entry))
  }

  /**
   * Reads copies of every decision of a Team.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team ID.
   * @returns The decisions with their Projects.
   */
  async listTeam(workspaceId: string, teamId: string): Promise<TeamProjectDecisionEntry[]> {
    return [...this.rows.values()]
      .filter((row) => row.scope.workspaceId === workspaceId && row.scope.teamId === teamId)
      .map((row) => ({ projectId: row.scope.projectId, entry: structuredClone(row.entry) }))
  }

  /**
   * Selects the stored rows of a Project log.
   *
   * @param scope - Team and Project.
   * @returns The rows, not copied.
   */
  private rowsOf(scope: ProjectDecisionLogScope) {
    return [...this.rows.values()].filter((row) =>
      row.scope.workspaceId === scope.workspaceId &&
      row.scope.teamId === scope.teamId &&
      row.scope.projectId === scope.projectId)
  }

  /**
   * Reads a copy of one decision.
   *
   * @param scope - Team and Project.
   * @param entryId - Entry ID.
   * @returns The decision and its last update receipt, or `null`.
   */
  async get(scope: ProjectDecisionLogScope, entryId: string): Promise<ProjectDecisionEntryRecord | null> {
    const row = this.rows.get(memoryKey(scope, entryId))
    if (!row) return null
    return { entry: structuredClone(row.entry), updateReceipts: structuredClone(row.updateReceipts) }
  }

  /**
   * Adds a decision.
   *
   * @param input - Creation input.
   * @returns The stored decision, or the decision an earlier identical request stored.
   */
  async create(input: CreateInput): Promise<ProjectDecisionEntry> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = memoryKey(input, input.entry.id)
    const existing = this.rows.get(key)
    if (existing) {
      if (existing.creationFingerprint === input.creationFingerprint) return structuredClone(existing.entry)
      throw creationKeyConflict()
    }
    // Counting and adding happen without an await in between, so concurrent creates cannot both
    // pass the limit or the duplicate check.
    if (this.rowsOf(input).length >= PROJECT_DECISION_LOG_MAX_ENTRIES) throw logFull()
    this.rows.set(key, {
      scope: { workspaceId: input.workspaceId, teamId: input.teamId, projectId: input.projectId },
      entry: structuredClone(input.entry),
      creationFingerprint: input.creationFingerprint,
      updateReceipts: [],
    })
    return input.entry
  }

  /**
   * Replaces a decision when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored decision.
   */
  async update(input: UpdateInput): Promise<ProjectDecisionEntry> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = memoryKey(input, input.next.id)
    const existing = this.rows.get(key)
    if (existing && existing.entry.revision !== input.previous.revision) {
      const earlier = findProjectDecisionUpdateReceipt(existing.updateReceipts, input.updateKey, input.updateReceipt)
      if (earlier === 'applied') return structuredClone(existing.entry)
    }
    if (!existing || existing.entry.revision !== input.previous.revision) {
      throw new ProjectDataError(409, 'ProjectDecisionEntryConflict', 'The decision changed. Reload and try again.')
    }
    this.rows.set(key, {
      scope: existing.scope,
      entry: structuredClone(input.next),
      creationFingerprint: existing.creationFingerprint,
      updateReceipts: nextUpdateReceipts(input),
    })
    return input.next
  }
}

/**
 * Tells whether every caller authorization fence of a cancelled transaction passed.
 *
 * @param reasons - Cancellation codes in transaction order, or `undefined` when unknown.
 * @param start - Index of the first fence.
 * @param count - Number of fences.
 * @returns Whether each fence reported `None`; unknown or other codes count as not passed.
 */
function callerFencesPassed(reasons: readonly (string | undefined)[] | undefined, start: number, count: number): boolean {
  if (!reasons || reasons.length < start + count) return false
  return reasons.slice(start, start + count).every((reason) => reason === 'None')
}

/**
 * Reads the update receipts kept on a stored decision row.
 *
 * @param row - Raw decision row.
 * @returns The receipts, oldest first.
 * @throws ProjectDataError 502 when the receipts are malformed.
 */
function parseUpdateReceipts(row: Record<string, unknown>): ProjectDecisionUpdateReceipt[] {
  const value = row.updateReceipts
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PROJECT_DECISION_UPDATE_RECEIPTS_MAX) throw corruptLog()
  return value.map((item: unknown) => {
    if (
      typeof item !== 'object' || item === null ||
      !('updateKey' in item) || typeof item.updateKey !== 'string' ||
      !('receipt' in item) || typeof item.receipt !== 'string'
    ) {
      throw corruptLog()
    }
    return { updateKey: item.updateKey, receipt: item.receipt }
  })
}

/**
 * Appends this update's receipt to the receipts read before it, keeping only the latest ones.
 *
 * @param input - Replacement input.
 * @returns The receipts to store, oldest first.
 */
function nextUpdateReceipts(input: Pick<UpdateInput, 'previousReceipts' | 'updateKey' | 'updateReceipt'>): ProjectDecisionUpdateReceipt[] {
  return [...input.previousReceipts, { updateKey: input.updateKey, receipt: input.updateReceipt }]
    .slice(-PROJECT_DECISION_UPDATE_RECEIPTS_MAX)
}

/**
 * Builds the in-memory key of one decision.
 *
 * @param scope - Team and Project.
 * @param entryId - Entry ID.
 * @returns The key.
 */
function memoryKey(scope: ProjectDecisionLogScope, entryId: string) {
  return JSON.stringify([scope.workspaceId, scope.teamId, scope.projectId, entryId])
}

/**
 * Builds the identity attributes of one decision row.
 *
 * @param scope - Team and Project.
 * @param entryId - Entry ID.
 * @returns The key, record type, schema version, and owning Team and Project.
 */
function rowIdentity(scope: ProjectDecisionLogScope, entryId: string) {
  return {
    workspaceId: scope.workspaceId,
    recordKey: entryKey(scope, entryId),
    entryType: ENTRY_TYPE,
    schemaVersion: SCHEMA_VERSION,
    teamId: scope.teamId,
    projectId: scope.projectId,
  }
}

/**
 * Names the audit action of a decision replacement.
 *
 * @param previous - Decision before the change.
 * @param next - Decision after the change.
 * @returns `decision_superseded`, `decision_withdrawn`, or `decision_reinstated` for a status
 * change, else `decision_updated`.
 */
function describeUpdateAction(previous: ProjectDecisionEntry, next: ProjectDecisionEntry) {
  if (previous.status !== next.status) {
    if (next.status === 'superseded') return 'decision_superseded'
    if (next.status === 'withdrawn') return 'decision_withdrawn'
    return 'decision_reinstated'
  }
  return 'decision_updated'
}

/**
 * Refuses a write without the caller's commit-time authorization fences.
 *
 * @param checks - Caller authorization checks.
 */
function requireCallerAuthorization(checks: readonly unknown[]) {
  if (checks.length === 0) {
    throw new ProjectDataError(503, 'ProjectDecisionLogAuthorizationUnavailable', 'Caller authorization is unavailable.')
  }
}

/**
 * Validates a stored decision row.
 *
 * @param row - Raw DynamoDB item.
 * @param scope - Expected Workspace, Team, and Project.
 * @returns The decision.
 * @throws ProjectDataError when the row is malformed or belongs to another scope.
 */
function parseStoredEntry(row: Record<string, unknown>, scope: ProjectDecisionLogScope): ProjectDecisionEntry {
  const entry = parseProjectDecisionEntry(row)
  if (
    !entry ||
    row.workspaceId !== scope.workspaceId ||
    row.recordKey !== entryKey(scope, entry.id) ||
    row.entryType !== ENTRY_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    row.teamId !== scope.teamId ||
    row.projectId !== scope.projectId
  ) {
    throw corruptLog()
  }
  return entry
}

/**
 * Reads the count of a counter row that belongs to the Project and has the known schema.
 *
 * @param row - Raw counter row, or `undefined` when it is missing.
 * @param scope - Team and Project the counter must belong to.
 * @returns The whole, non-negative count, or `undefined` when the counter is missing.
 * @throws ProjectDataError 502 when the counter is malformed.
 */
function readCounterCount(row: Record<string, unknown> | undefined, scope: ProjectDecisionLogScope): number | undefined {
  if (row === undefined) return undefined
  if (
    row.entryType !== COUNTER_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    row.teamId !== scope.teamId ||
    row.projectId !== scope.projectId ||
    typeof row.entryCount !== 'number' ||
    !Number.isSafeInteger(row.entryCount) ||
    row.entryCount < 0
  ) {
    throw corruptLog()
  }
  return row.entryCount
}

/**
 * Tells whether a counter row belongs to the Project, has the known schema, and is at the limit.
 *
 * @param row - Raw counter row, or `undefined` when it is missing.
 * @param scope - Team and Project the counter must belong to.
 * @returns Whether the counter is valid and full.
 */
function isCounterAtLimit(row: Record<string, unknown> | undefined, scope: ProjectDecisionLogScope) {
  return row !== undefined &&
    row.entryType === COUNTER_TYPE &&
    row.schemaVersion === SCHEMA_VERSION &&
    row.teamId === scope.teamId &&
    row.projectId === scope.projectId &&
    typeof row.entryCount === 'number' &&
    Number.isSafeInteger(row.entryCount) &&
    row.entryCount >= PROJECT_DECISION_LOG_MAX_ENTRIES
}

/**
 * Creates the error for a full decision log.
 *
 * @returns The error.
 */
function logFull() {
  return new ProjectDataError(413, 'ProjectDecisionLogFull', `A Project decision log can hold at most ${PROJECT_DECISION_LOG_MAX_ENTRIES} decisions.`)
}

/**
 * Creates the error for an Idempotency-Key that already created a different decision.
 *
 * @returns The error.
 */
function creationKeyConflict() {
  return new ProjectDataError(409, 'ProjectDecisionEntryIdempotencyConflict', 'This Idempotency-Key was already used for another decision.')
}

/**
 * Creates the error for a malformed stored log.
 *
 * @returns The error.
 */
function corruptLog() {
  return new ProjectDataError(502, 'ProjectDecisionLogCorruptState', 'The stored decision log is invalid.')
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
      throw new ProjectDataError(409, 'ProjectDecisionEntryConflict', 'The decision or your permissions changed. Reload and try again.')
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
  throw new ProjectDataError(502, 'ProjectDecisionLogStorageFailure', 'Decision log storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'ProjectDecisionLogRetryable', 'Decision log storage is temporarily unavailable.')
}
