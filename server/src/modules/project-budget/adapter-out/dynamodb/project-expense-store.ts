import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  parseProjectExpense,
  PROJECT_EXPENSES_MAX_ENTRIES,
  type ProjectExpense,
} from '@mukuroji/contracts'
import { createAuditFieldChanges, createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import { ProjectDataError } from '../../../directory'
import type {
  CreateProjectExpenseStoreInput,
  DeleteProjectExpenseStoreInput,
  ProjectExpenseRecord,
  ProjectExpenseScope,
  ProjectExpenseStore as ExpenseStore,
  UpdateProjectExpenseStoreInput,
} from '../../application/project-expense-use-cases'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type ProjectExpenseCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Expense persistence bound to DynamoDB authorization fences and the request audit context. */
export type ProjectExpenseStore = ExpenseStore<ProjectExpenseCallerAuthorizationCheck, MutationAuditContext>

/** Creation input bound to DynamoDB fences. */
type CreateInput = CreateProjectExpenseStoreInput<ProjectExpenseCallerAuthorizationCheck, MutationAuditContext>
/** Replacement input bound to DynamoDB fences. */
type UpdateInput = UpdateProjectExpenseStoreInput<ProjectExpenseCallerAuthorizationCheck, MutationAuditContext>
/** Removal input bound to DynamoDB fences. */
type DeleteInput = DeleteProjectExpenseStoreInput<ProjectExpenseCallerAuthorizationCheck, MutationAuditContext>

/** Planning-table record type of one expense. */
const ENTRY_TYPE = 'project-expense'
/** Planning-table record type of the receipt a removal leaves behind. */
const DELETION_TYPE = 'project-expense-deletion'
/** Planning-table record type of the per-Project expense counter. */
const COUNTER_TYPE = 'project-expense-ledger'
/** Schema version of the counter and expense rows. */
const SCHEMA_VERSION = 1
/** Fields whose values are recorded in audit changes. */
const AUDIT_FIELDS = [
  'date',
  'category',
  'amountMinor',
  'currency',
  'description',
  'workItemId',
  'receiptFileIds',
  'status',
  'decisionNote',
  'revision',
]
/** Free-text fields and the confidential amount, whose values are redacted in audit changes. */
const AUDIT_REDACTED_FIELDS = ['category', 'amountMinor', 'description', 'decisionNote']

/**
 * Builds the record key of a Project's expense counter, which also prefixes every expense key.
 *
 * @param scope - Team and Project.
 * @returns The counter record key.
 */
function counterKey(scope: Pick<ProjectExpenseScope, 'teamId' | 'projectId'>) {
  return `PROJECT_EXPENSE#${encodeURIComponent(scope.teamId)}#${encodeURIComponent(scope.projectId)}`
}

/**
 * Builds the record key of one expense.
 *
 * @param scope - Team and Project.
 * @param expenseId - Expense ID.
 * @returns The expense record key.
 */
function entryKey(scope: Pick<ProjectExpenseScope, 'teamId' | 'projectId'>, expenseId: string) {
  return `${counterKey(scope)}#ENTRY#${encodeURIComponent(expenseId)}`
}

/**
 * Builds the sort key of the receipt a removed expense leaves, outside the expense list prefix.
 *
 * @param scope - Team and Project.
 * @param expenseId - Expense ID.
 * @returns The sort key.
 */
function deletionKey(scope: Pick<ProjectExpenseScope, 'teamId' | 'projectId'>, expenseId: string) {
  return `${counterKey(scope)}#DELETED#${encodeURIComponent(expenseId)}`
}

/** Stores each Project expense as one Planning-table row, next to a per-Project counter. */
export class DynamoDbProjectExpenseStore implements ProjectExpenseStore {
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
   * Reads every expense of a Project, following every page.
   *
   * @param scope - Team and Project.
   * @returns Every validated expense.
   */
  async list(scope: ProjectExpenseScope): Promise<ProjectExpense[]> {
    const prefix = `${counterKey(scope)}#ENTRY#`
    const expenses: ProjectExpense[] = []
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
        expenses.push(parseStoredExpense(row, scope))
      }
      exclusiveStartKey = page.LastEvaluatedKey
      if (expenses.length > PROJECT_EXPENSES_MAX_ENTRIES) throw corruptLedger()
    } while (exclusiveStartKey)
    return expenses
  }

  /**
   * Reads one expense with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param expenseId - Expense ID.
   * @returns The validated expense and its last change receipt, or `null`.
   */
  async get(scope: ProjectExpenseScope, expenseId: string): Promise<ProjectExpenseRecord | null> {
    const row = await this.readRow(scope, expenseId)
    if (!row) return null
    const expense = parseStoredExpense(row, scope)
    const receipt = row.lastUpdateReceipt
    const updateKey = row.lastUpdateKey
    if (receipt !== undefined && typeof receipt !== 'string') throw corruptLedger()
    if (updateKey !== undefined && typeof updateKey !== 'string') throw corruptLedger()
    return {
      expense,
      ...(receipt === undefined ? {} : { lastUpdateReceipt: receipt }),
      ...(updateKey === undefined ? {} : { lastUpdateKey: updateKey }),
    }
  }

  /**
   * Adds an expense and advances the per-Project counter in one transaction.
   *
   * @param input - Creation input.
   * @returns The stored expense, or the expense an earlier identical request stored.
   */
  async create(input: CreateInput): Promise<ProjectExpense> {
    requireCallerAuthorization(input.callerAuthorization)
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'project.expense_submitted',
      entityType: 'project',
      entityId: input.projectId,
      target: { type: ENTRY_TYPE, id: input.expense.id },
      action: 'expense_submitted',
      occurredAt: input.now,
      changes: createAuditFieldChanges(undefined, toAuditRecord(input.expense), AUDIT_FIELDS, AUDIT_REDACTED_FIELDS),
      metadata: { projectId: input.projectId, teamId: input.teamId },
    })
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                ...rowIdentity(input, input.expense.id),
                creationFingerprint: input.creationFingerprint,
                ...input.expense,
              },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { workspaceId: input.workspaceId, recordKey: counterKey(input) },
              UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, #type = if_not_exists(#type, :type), #teamId = if_not_exists(#teamId, :teamId), #projectId = if_not_exists(#projectId, :projectId), #schemaVersion = if_not_exists(#schemaVersion, :schemaVersion)',
              // An existing counter must be this Project's, in the known schema, not negative, and
              // below the limit.
              ConditionExpression: 'attribute_not_exists(recordKey) OR (#type = :type AND #schemaVersion = :schemaVersion AND #teamId = :teamId AND #projectId = :projectId AND #count >= :zero AND #count < :max)',
              ExpressionAttributeNames: counterNames(),
              ExpressionAttributeValues: {
                ...counterValues(input),
                ':one': 1,
                ':max': PROJECT_EXPENSES_MAX_ENTRIES,
              },
            },
          },
          {
            // A removed expense keeps its receipt, so a late retry of its creation does not bring
            // it back and leave the receipt pointing at a live expense.
            ConditionCheck: {
              TableName: this.tableName,
              Key: { workspaceId: input.workspaceId, recordKey: deletionKey(input, input.expense.id) },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          ...input.callerAuthorization,
          ...(audit ? [audit] : []),
        ],
      }))
    } catch (error) {
      const reasons = readCancellationCodes(error)
      const transactionSize = 3 + input.callerAuthorization.length + (audit ? 1 : 0)
      const callerAuthorizationFailed = reasons
        ?.slice(3, 3 + input.callerAuthorization.length)
        .includes('ConditionalCheckFailed') ?? false
      // A caller whose access changed gets the same answer as for any other write.
      if (callerAuthorizationFailed) return storageFailure(error, transactionSize)
      if (reasons?.[2] === 'ConditionalCheckFailed') throw expenseDeleted()
      if (reasons?.[0] === 'ConditionalCheckFailed') {
        // The expense ID comes from the request's idempotency key, so an existing expense means
        // the same request was already applied, unless it carried different content.
        const row = await this.readRow(input, input.expense.id)
        if (row && row.creationFingerprint === input.creationFingerprint) return parseStoredExpense(row, input)
        throw new ProjectDataError(409, 'ProjectExpenseIdempotencyConflict', 'This Idempotency-Key was already used for another expense.')
      }
      if (reasons?.[1] === 'ConditionalCheckFailed') {
        if (isCounterAtLimit(await this.readCounter(input), input)) throw ledgerFull()
        throw corruptLedger()
      }
      return storageFailure(error, transactionSize)
    }
    return input.expense
  }

  /**
   * Replaces an expense when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored expense.
   */
  async update(input: UpdateInput): Promise<ProjectExpense> {
    requireCallerAuthorization(input.callerAuthorization)
    const action = describeUpdateAction(input.next)
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
      metadata: { projectId: input.projectId, teamId: input.teamId },
    })
    const previousRow = await this.readRow(input, input.next.id)
    const creationFingerprint = previousRow?.creationFingerprint
    if (typeof creationFingerprint !== 'string') throw conflict()
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                ...rowIdentity(input, input.next.id),
                creationFingerprint,
                lastUpdateReceipt: input.updateReceipt,
                lastUpdateKey: input.updateKey,
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
      return storageFailure(error, 1 + input.callerAuthorization.length + (audit ? 1 : 0))
    }
    return input.next
  }

  /**
   * Removes an expense when it still has the previous revision, and lowers the counter.
   *
   * @param input - Removal input.
   */
  async delete(input: DeleteInput): Promise<void> {
    requireCallerAuthorization(input.callerAuthorization)
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'project.expense_deleted',
      entityType: 'project',
      entityId: input.projectId,
      target: { type: ENTRY_TYPE, id: input.previous.id },
      action: 'expense_deleted',
      occurredAt: input.now,
      changes: createAuditFieldChanges(toAuditRecord(input.previous), undefined, AUDIT_FIELDS, AUDIT_REDACTED_FIELDS),
      metadata: { projectId: input.projectId, teamId: input.teamId },
    })
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: { workspaceId: input.workspaceId, recordKey: entryKey(input, input.previous.id) },
              // An approved expense counts toward the budget, so the delete is refused at commit
              // when a decision lands between the read and the write.
              ConditionExpression: '#type = :type AND #revision = :revision AND #status <> :approved',
              ExpressionAttributeNames: { '#type': 'entryType', '#revision': 'revision', '#status': 'status' },
              ExpressionAttributeValues: { ':type': ENTRY_TYPE, ':revision': input.previous.revision, ':approved': 'approved' },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { workspaceId: input.workspaceId, recordKey: counterKey(input) },
              UpdateExpression: 'SET #count = #count - :one',
              ConditionExpression: '#type = :type AND #schemaVersion = :schemaVersion AND #teamId = :teamId AND #projectId = :projectId AND #count > :zero',
              ExpressionAttributeNames: counterNames(),
              ExpressionAttributeValues: { ...counterValues(input), ':one': 1 },
            },
          },
          {
            // Expense IDs come from Idempotency-Keys, so a removed expense is never stored again
            // and its receipt lets a retry that lost the response succeed.
            Put: {
              TableName: this.tableName,
              Item: {
                workspaceId: input.workspaceId,
                recordKey: deletionKey(input, input.previous.id),
                entryType: DELETION_TYPE,
                schemaVersion: SCHEMA_VERSION,
                teamId: input.teamId,
                projectId: input.projectId,
                expenseId: input.previous.id,
                deleteReceipt: input.deleteReceipt,
                deletedAt: input.now,
              },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          ...input.callerAuthorization,
          ...(audit ? [audit] : []),
        ],
      }))
    } catch (error) {
      const reasons = readCancellationCodes(error)
      if (reasons?.[1] === 'ConditionalCheckFailed' && reasons[0] !== 'ConditionalCheckFailed') throw corruptLedger()
      return storageFailure(error, 3 + input.callerAuthorization.length + (audit ? 1 : 0))
    }
  }

  /**
   * Tells whether a request with this receipt removed the expense, with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param expenseId - Expense ID.
   * @param deleteReceipt - Receipt of the removal request.
   * @returns True when the stored removal receipt matches.
   */
  async wasDeletedBy(scope: ProjectExpenseScope, expenseId: string, deleteReceipt: string): Promise<boolean> {
    const { Item: row } = await this.client
      .send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId: scope.workspaceId, recordKey: deletionKey(scope, expenseId) },
        ConsistentRead: true,
      }))
      .catch((error: unknown) => storageFailure(error))
    return row?.entryType === DELETION_TYPE && row.deleteReceipt === deleteReceipt
  }

  /**
   * Reads the raw per-Project counter row with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @returns The raw row, or `undefined`.
   */
  private async readCounter(scope: ProjectExpenseScope): Promise<Record<string, unknown> | undefined> {
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
   * Reads the raw row of one expense with a strongly consistent read.
   *
   * @param scope - Team and Project.
   * @param expenseId - Expense ID.
   * @returns The raw row, or `undefined`.
   */
  private async readRow(scope: ProjectExpenseScope, expenseId: string): Promise<Record<string, unknown> | undefined> {
    const { Item: row } = await this.client
      .send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId: scope.workspaceId, recordKey: entryKey(scope, expenseId) },
        ConsistentRead: true,
      }))
      .catch((error: unknown) => storageFailure(error))
    return row
  }
}

/** Isolated store for route and application tests. */
export class InMemoryProjectExpenseStore implements ProjectExpenseStore {
  /** Expenses with their creation and change receipts keyed by Workspace, Team, Project, and expense. */
  private readonly rows = new Map<string, { expense: ProjectExpense; creationFingerprint: string; lastUpdateReceipt?: string; lastUpdateKey?: string }>()
  /** Removal receipts of removed expenses, keyed like `rows`. */
  private readonly deletions = new Map<string, string>()

  /**
   * Reads copies of every expense of a Project.
   *
   * @param scope - Team and Project.
   * @returns The expenses.
   */
  async list(scope: ProjectExpenseScope): Promise<ProjectExpense[]> {
    return this.rowsOf(scope).map((row) => structuredClone(row.expense))
  }

  /**
   * Selects the stored rows of a Project.
   *
   * @param scope - Team and Project.
   * @returns The rows, not copied.
   */
  private rowsOf(scope: ProjectExpenseScope) {
    const prefix = JSON.stringify([scope.workspaceId, scope.teamId, scope.projectId]).slice(0, -1)
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${prefix},`))
      .map(([, row]) => row)
  }

  /**
   * Reads a copy of one expense.
   *
   * @param scope - Team and Project.
   * @param expenseId - Expense ID.
   * @returns The expense and its last change receipt, or `null`.
   */
  async get(scope: ProjectExpenseScope, expenseId: string): Promise<ProjectExpenseRecord | null> {
    const row = this.rows.get(memoryKey(scope, expenseId))
    if (!row) return null
    return {
      expense: structuredClone(row.expense),
      ...(row.lastUpdateReceipt === undefined ? {} : { lastUpdateReceipt: row.lastUpdateReceipt }),
      ...(row.lastUpdateKey === undefined ? {} : { lastUpdateKey: row.lastUpdateKey }),
    }
  }

  /**
   * Adds an expense.
   *
   * @param input - Creation input.
   * @returns The stored expense, or the expense an earlier identical request stored.
   */
  async create(input: CreateInput): Promise<ProjectExpense> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = memoryKey(input, input.expense.id)
    if (this.deletions.has(key)) throw expenseDeleted()
    const existing = this.rows.get(key)
    if (existing) {
      if (existing.creationFingerprint === input.creationFingerprint) return structuredClone(existing.expense)
      throw new ProjectDataError(409, 'ProjectExpenseIdempotencyConflict', 'This Idempotency-Key was already used for another expense.')
    }
    // Counting and adding happen without an await in between, so concurrent creates cannot both
    // pass the limit.
    if (this.rowsOf(input).length >= PROJECT_EXPENSES_MAX_ENTRIES) throw ledgerFull()
    this.rows.set(key, { expense: structuredClone(input.expense), creationFingerprint: input.creationFingerprint })
    return input.expense
  }

  /**
   * Replaces an expense when it still has the previous revision.
   *
   * @param input - Replacement input.
   * @returns The stored expense.
   */
  async update(input: UpdateInput): Promise<ProjectExpense> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = memoryKey(input, input.next.id)
    const existing = this.rows.get(key)
    if (!existing || existing.expense.revision !== input.previous.revision) throw conflict()
    this.rows.set(key, {
      expense: structuredClone(input.next),
      creationFingerprint: existing.creationFingerprint,
      lastUpdateReceipt: input.updateReceipt,
      lastUpdateKey: input.updateKey,
    })
    return input.next
  }

  /**
   * Removes an expense when it still has the previous revision and is not approved.
   *
   * @param input - Removal input.
   */
  async delete(input: DeleteInput): Promise<void> {
    requireCallerAuthorization(input.callerAuthorization)
    const key = memoryKey(input, input.previous.id)
    const existing = this.rows.get(key)
    if (!existing || existing.expense.revision !== input.previous.revision || existing.expense.status === 'approved') throw conflict()
    this.rows.delete(key)
    this.deletions.set(key, input.deleteReceipt)
  }

  /**
   * Tells whether a request with this receipt removed the expense.
   *
   * @param scope - Team and Project.
   * @param expenseId - Expense ID.
   * @param deleteReceipt - Receipt of the removal request.
   * @returns True when the stored removal receipt matches.
   */
  async wasDeletedBy(scope: ProjectExpenseScope, expenseId: string, deleteReceipt: string): Promise<boolean> {
    return this.deletions.get(memoryKey(scope, expenseId)) === deleteReceipt
  }
}

/**
 * Builds the in-memory key of one expense.
 *
 * @param scope - Team and Project.
 * @param expenseId - Expense ID.
 * @returns The key.
 */
function memoryKey(scope: ProjectExpenseScope, expenseId: string) {
  return JSON.stringify([scope.workspaceId, scope.teamId, scope.projectId, expenseId])
}

/**
 * Builds the identity attributes of one expense row.
 *
 * @param scope - Team and Project.
 * @param expenseId - Expense ID.
 * @returns The key, record type, schema version, and owning Team and Project.
 */
function rowIdentity(scope: ProjectExpenseScope, expenseId: string) {
  return {
    workspaceId: scope.workspaceId,
    recordKey: entryKey(scope, expenseId),
    entryType: ENTRY_TYPE,
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * Names the attributes the counter conditions read.
 *
 * @returns The expression attribute names.
 */
function counterNames() {
  return {
    '#count': 'entryCount',
    '#type': 'entryType',
    '#teamId': 'teamId',
    '#projectId': 'projectId',
    '#schemaVersion': 'schemaVersion',
  }
}

/**
 * Builds the values the counter conditions compare with.
 *
 * @param scope - Team and Project the counter belongs to.
 * @returns The expression attribute values.
 */
function counterValues(scope: ProjectExpenseScope) {
  return {
    ':zero': 0,
    ':type': COUNTER_TYPE,
    ':teamId': scope.teamId,
    ':projectId': scope.projectId,
    ':schemaVersion': SCHEMA_VERSION,
  }
}

/**
 * Names the audit action of an expense replacement.
 *
 * @param next - Expense after the change.
 * @returns `expense_approved`, `expense_rejected`, or `expense_resubmitted`.
 */
function describeUpdateAction(next: ProjectExpense) {
  if (next.status === 'approved') return 'expense_approved'
  if (next.status === 'rejected') return 'expense_rejected'
  return 'expense_resubmitted'
}

/**
 * Converts an expense to the plain record compared for audit changes. Member keys are left out:
 * the audit event's actor already records who acted, and a member key must not be kept in the
 * changes.
 *
 * @param expense - Expense.
 * @returns The expense fields as a record.
 */
function toAuditRecord(expense: ProjectExpense): Record<string, unknown> {
  const { submittedByMemberId: _submitter, decision, ...fields } = expense
  return { ...fields, ...(decision?.note === undefined ? {} : { decisionNote: decision.note }) }
}

/**
 * Refuses a write without the caller's commit-time authorization fences.
 *
 * @param checks - Caller authorization checks.
 */
function requireCallerAuthorization(checks: readonly unknown[]) {
  if (checks.length === 0) {
    throw new ProjectDataError(503, 'ProjectExpenseAuthorizationUnavailable', 'Caller authorization is unavailable.')
  }
}

/**
 * Validates a stored expense row.
 *
 * @param row - Raw DynamoDB item.
 * @param scope - Expected Workspace, Team, and Project.
 * @returns The expense.
 * @throws ProjectDataError when the row is malformed or belongs to another scope.
 */
function parseStoredExpense(row: Record<string, unknown>, scope: ProjectExpenseScope): ProjectExpense {
  const expense = parseProjectExpense(row)
  if (
    !expense ||
    row.workspaceId !== scope.workspaceId ||
    row.recordKey !== entryKey(scope, expense.id) ||
    row.entryType !== ENTRY_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    expense.teamId !== scope.teamId ||
    expense.projectId !== scope.projectId
  ) {
    throw corruptLedger()
  }
  return expense
}

/**
 * Tells whether a counter row belongs to the Project, has the known schema, and is at the limit.
 *
 * @param row - Raw counter row, or `undefined` when it is missing.
 * @param scope - Team and Project the counter must belong to.
 * @returns Whether the counter is valid and full.
 */
function isCounterAtLimit(row: Record<string, unknown> | undefined, scope: ProjectExpenseScope) {
  return row !== undefined &&
    row.entryType === COUNTER_TYPE &&
    row.schemaVersion === SCHEMA_VERSION &&
    row.teamId === scope.teamId &&
    row.projectId === scope.projectId &&
    typeof row.entryCount === 'number' &&
    Number.isSafeInteger(row.entryCount) &&
    row.entryCount >= PROJECT_EXPENSES_MAX_ENTRIES
}

/**
 * Creates the error for a Project that holds the most expenses it may.
 *
 * @returns The error.
 */
function ledgerFull() {
  return new ProjectDataError(413, 'ProjectExpensesFull', `A Project can hold at most ${PROJECT_EXPENSES_MAX_ENTRIES} expenses.`)
}

/**
 * Creates the error for an expense that changed since it was read.
 *
 * @returns The error.
 */
function conflict() {
  return new ProjectDataError(409, 'ProjectExpenseConflict', 'The expense changed. Reload and try again.')
}

/**
 * Creates the error for malformed stored expenses.
 *
 * @returns The error.
 */
function corruptLedger() {
  return new ProjectDataError(502, 'ProjectExpenseCorruptState', 'The stored Project expenses are invalid.')
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
 * Builds the error of a creation retried after its expense was removed.
 *
 * @returns The 409 error.
 */
function expenseDeleted() {
  return new ProjectDataError(409, 'ProjectExpenseDeleted', 'This expense was deleted. Submit it again as a new expense.')
}

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
      throw new ProjectDataError(409, 'ProjectExpenseConflict', 'The expense or your permissions changed. Reload and try again.')
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
  throw new ProjectDataError(502, 'ProjectExpenseStorageFailure', 'Project expense storage request failed.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'ProjectExpenseRetryable', 'Project expense storage is temporarily unavailable.')
}
