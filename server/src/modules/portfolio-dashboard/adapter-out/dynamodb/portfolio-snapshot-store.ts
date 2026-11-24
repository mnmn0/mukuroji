import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  isPortfolioMonth,
  parsePortfolioProjectMetrics,
  PORTFOLIO_TEAM_PROJECT_LIMIT,
  type PortfolioProjectMetrics,
} from '@mukuroji/contracts'
import { createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import { ProjectDataError } from '../../../directory'
import type {
  StoredTeamPortfolioSnapshot,
  TeamPortfolioSnapshotReceipt,
  TeamPortfolioSnapshotStore as SnapshotStore,
  WriteTeamPortfolioSnapshotInput as WriteInput,
} from '../../application/team-portfolio'

/** DynamoDB condition checks that pin the caller's authorization in the same transaction. */
export type PortfolioSnapshotCallerAuthorizationCheck = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Snapshot write bound to DynamoDB authorization fences and the request audit context. */
export type WriteTeamPortfolioSnapshotInput = WriteInput<PortfolioSnapshotCallerAuthorizationCheck, MutationAuditContext>

/** Snapshot persistence bound to DynamoDB authorization fences and the request audit context. */
export type TeamPortfolioSnapshotStore = SnapshotStore<PortfolioSnapshotCallerAuthorizationCheck, MutationAuditContext>

/** Planning-table record type of one monthly portfolio snapshot. */
const ENTRY_TYPE = 'team-portfolio-snapshot'

/** Planning-table record type of one save request's receipt. */
const RECEIPT_TYPE = 'team-portfolio-snapshot-receipt'

/**
 * Builds the Planning-table record key of one save request's receipt.
 *
 * @param teamId - Team ID.
 * @param keyHash - Hash of the request's idempotency key.
 * @returns The record key.
 */
function receiptRecordKey(teamId: string, keyHash: string) {
  return `TEAM_PORTFOLIO_SNAPSHOT_RECEIPT#${encodeURIComponent(teamId)}#${keyHash}`
}

/**
 * Validates a stored receipt row.
 *
 * @param row - Raw DynamoDB item.
 * @param workspaceId - Expected Workspace.
 * @param teamId - Expected Team.
 * @param keyHash - Expected key hash.
 * @returns The receipt.
 * @throws ProjectDataError when the row is malformed.
 */
function parseReceipt(row: Record<string, unknown>, workspaceId: string, teamId: string, keyHash: string): TeamPortfolioSnapshotReceipt {
  const { requestFingerprint, month, revision } = row
  if (
    row.workspaceId !== workspaceId ||
    row.recordKey !== receiptRecordKey(teamId, keyHash) ||
    row.entryType !== RECEIPT_TYPE ||
    row.schemaVersion !== 1 ||
    row.teamId !== teamId ||
    row.keyHash !== keyHash ||
    typeof requestFingerprint !== 'string' ||
    !isPortfolioMonth(month) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw corruptSnapshot()
  }
  return { keyHash, requestFingerprint, month, revision }
}

/**
 * Largest serialized snapshot body a row may hold, leaving room under DynamoDB's 400 KB item
 * limit for the key and attribute names.
 */
const SNAPSHOT_MAX_BYTES = 350_000

/**
 * Builds the Planning-table record key of one Team's snapshot of one month.
 *
 * @param teamId - Team ID.
 * @param month - Month as `YYYY-MM`.
 * @returns The record key.
 */
function recordKey(teamId: string, month: string) {
  return `TEAM_PORTFOLIO_SNAPSHOT#${encodeURIComponent(teamId)}#${month}`
}

/**
 * Rejects a snapshot with an invalid revision or larger than one row may store.
 *
 * @param snapshot - Snapshot to store.
 * @throws ProjectDataError 400 for an invalid revision, and 413 when it is too large.
 */
function assertSnapshotSize(snapshot: StoredTeamPortfolioSnapshot) {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
    throw new ProjectDataError(400, 'InvalidPortfolioSnapshot', 'The snapshot revision is invalid.')
  }
  if (
    snapshot.projects.length > PORTFOLIO_TEAM_PROJECT_LIMIT ||
    new TextEncoder().encode(JSON.stringify(snapshot.projects)).length > SNAPSHOT_MAX_BYTES
  ) {
    throw new ProjectDataError(413, 'PortfolioTooLarge', 'The portfolio snapshot is too large to save.')
  }
}

/**
 * Builds the audit event of a snapshot save. It records the month and the number of Projects,
 * not the metrics or costs, which the row holds.
 *
 * @param auditTableName - Audit event table, when configured.
 * @param input - Write input.
 * @returns The conditional audit Put, or undefined when audit is not configured.
 */
function createSnapshotAuditPut(auditTableName: string | undefined, input: WriteTeamPortfolioSnapshotInput) {
  const { snapshot } = input
  return createMutationAuditEventPut(auditTableName, input.auditContext, {
    directoryId: snapshot.workspaceId,
    eventType: 'team.portfolio_snapshot_saved',
    entityType: 'team',
    entityId: snapshot.teamId,
    target: { type: ENTRY_TYPE, id: `${snapshot.teamId}:${snapshot.month}` },
    action: 'portfolio_snapshot_saved',
    occurredAt: snapshot.capturedAt,
    metadata: { teamId: snapshot.teamId, month: snapshot.month, projectCount: snapshot.projects.length },
  })
}

/** Stores each Team's monthly portfolio snapshot as one row in the Planning table. */
export class DynamoDbTeamPortfolioSnapshotStore implements TeamPortfolioSnapshotStore {
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
   * Reads one month's snapshot with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team ID.
   * @param month - Month as `YYYY-MM`.
   * @returns The validated snapshot, or `null` when none was saved.
   */
  async get(workspaceId: string, teamId: string, month: string): Promise<StoredTeamPortfolioSnapshot | null> {
    const key = recordKey(teamId, month)
    const { Item: row } = await this.client
      .send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true }))
      .catch((error: unknown) => storageFailure(error))
    if (row === undefined) return null
    return parseStoredSnapshot(row, workspaceId, teamId, month, key)
  }

  /**
   * Reads the receipt of an earlier save request with a strongly consistent read.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team ID.
   * @param keyHash - Hash of the idempotency key.
   * @returns The validated receipt, or `null`.
   */
  async getReceipt(workspaceId: string, teamId: string, keyHash: string): Promise<TeamPortfolioSnapshotReceipt | null> {
    const { Item: row } = await this.client
      .send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: receiptRecordKey(teamId, keyHash) },
        ConsistentRead: true,
      }))
      .catch((error: unknown) => storageFailure(error))
    return row === undefined ? null : parseReceipt(row, workspaceId, teamId, keyHash)
  }

  /**
   * Stores one month's snapshot, replacing an earlier one, with the caller's authorization
   * fences and the audit event in the same transaction.
   *
   * @param input - Write input.
   */
  async put(input: WriteTeamPortfolioSnapshotInput): Promise<void> {
    assertSnapshotSize(input.snapshot)
    if (input.callerAuthorization.length === 0) {
      throw new ProjectDataError(503, 'PortfolioSnapshotAuthorizationUnavailable', 'Caller authorization is unavailable.')
    }
    const { snapshot } = input
    const audit = createSnapshotAuditPut(this.auditTableName, input)
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: snapshot.workspaceId,
            recordKey: recordKey(snapshot.teamId, snapshot.month),
            entryType: ENTRY_TYPE,
            schemaVersion: 1,
            teamId: snapshot.teamId,
            month: snapshot.month,
            capturedAt: snapshot.capturedAt,
            revision: snapshot.revision,
            projects: structuredClone(snapshot.projects),
          },
          // A capture replaces only the revision it read, so a slower earlier capture cannot
          // overwrite a newer one.
          ...(snapshot.revision === 1
            ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
            : {
                ConditionExpression: '#revision = :expectedRevision',
                ExpressionAttributeNames: { '#revision': 'revision' },
                ExpressionAttributeValues: { ':expectedRevision': snapshot.revision - 1 },
              }),
        },
      },
      {
        // Kept for every save, so a retry is recognized after later saves too.
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: snapshot.workspaceId,
            recordKey: receiptRecordKey(snapshot.teamId, input.receipt.keyHash),
            entryType: RECEIPT_TYPE,
            schemaVersion: 1,
            teamId: snapshot.teamId,
            keyHash: input.receipt.keyHash,
            requestFingerprint: input.receipt.requestFingerprint,
            month: input.receipt.month,
            revision: input.receipt.revision,
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      ...input.callerAuthorization,
      ...(audit ? [audit] : []),
    ]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      storageFailure(error, transactItems.length)
    }
  }
}

/** Isolated store for route and application tests. */
export class InMemoryTeamPortfolioSnapshotStore implements TeamPortfolioSnapshotStore {
  /** Snapshots keyed by Workspace, Team, and month. */
  private readonly snapshots = new Map<string, StoredTeamPortfolioSnapshot>()
  /** Receipts keyed by Workspace, Team, and key hash. */
  private readonly receipts = new Map<string, TeamPortfolioSnapshotReceipt>()
  /** Audit events the writes would record, oldest first, for tests to inspect. */
  readonly auditEvents: { eventType: string; teamId: string; month: string; actorId: string }[] = []

  /**
   * Reads a copy of one month's snapshot.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team ID.
   * @param month - Month as `YYYY-MM`.
   * @returns The snapshot, or `null`.
   */
  async get(workspaceId: string, teamId: string, month: string): Promise<StoredTeamPortfolioSnapshot | null> {
    return structuredClone(this.snapshots.get(JSON.stringify([workspaceId, teamId, month])) ?? null)
  }

  /**
   * Reads a copy of the receipt of an earlier save request.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team ID.
   * @param keyHash - Hash of the idempotency key.
   * @returns The receipt, or `null`.
   */
  async getReceipt(workspaceId: string, teamId: string, keyHash: string): Promise<TeamPortfolioSnapshotReceipt | null> {
    const receipt = this.receipts.get(JSON.stringify([workspaceId, teamId, keyHash]))
    return receipt ? { ...receipt } : null
  }

  /**
   * Stores a copy of one month's snapshot.
   *
   * @param input - Write input.
   */
  async put(input: WriteTeamPortfolioSnapshotInput): Promise<void> {
    assertSnapshotSize(input.snapshot)
    const { snapshot } = input
    const key = JSON.stringify([snapshot.workspaceId, snapshot.teamId, snapshot.month])
    const receiptKey = JSON.stringify([snapshot.workspaceId, snapshot.teamId, input.receipt.keyHash])
    if ((this.snapshots.get(key)?.revision ?? 0) !== snapshot.revision - 1 || this.receipts.has(receiptKey)) {
      throw snapshotConflict()
    }
    this.snapshots.set(key, structuredClone(snapshot))
    this.receipts.set(receiptKey, { ...input.receipt })
    this.auditEvents.push({
      eventType: 'team.portfolio_snapshot_saved',
      teamId: snapshot.teamId,
      month: snapshot.month,
      actorId: input.auditContext.actor.id,
    })
  }
}

/**
 * Validates a stored snapshot row.
 *
 * @param row - Raw DynamoDB item.
 * @param workspaceId - Expected Workspace.
 * @param teamId - Expected Team.
 * @param month - Expected month.
 * @param key - Expected record key.
 * @returns The snapshot.
 * @throws ProjectDataError when the row is malformed.
 */
function parseStoredSnapshot(
  row: Record<string, unknown>,
  workspaceId: string,
  teamId: string,
  month: string,
  key: string,
): StoredTeamPortfolioSnapshot {
  const { capturedAt, projects, revision } = row
  if (
    row.workspaceId !== workspaceId ||
    row.recordKey !== key ||
    row.entryType !== ENTRY_TYPE ||
    row.schemaVersion !== 1 ||
    row.teamId !== teamId ||
    row.month !== month ||
    !isPortfolioMonth(row.month) ||
    typeof capturedAt !== 'string' ||
    Number.isNaN(Date.parse(capturedAt)) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Array.isArray(projects) ||
    projects.length > PORTFOLIO_TEAM_PROJECT_LIMIT
  ) {
    throw corruptSnapshot()
  }
  const parsed: PortfolioProjectMetrics[] = []
  for (const candidate of projects) {
    const project = parsePortfolioProjectMetrics(candidate)
    if (!project) throw corruptSnapshot()
    parsed.push(project)
  }
  return { workspaceId, teamId, month, capturedAt, revision, projects: parsed }
}

/**
 * Creates the error for a malformed stored snapshot.
 *
 * @returns The error.
 */
function corruptSnapshot() {
  return new ProjectDataError(502, 'PortfolioSnapshotCorruptState', 'The stored portfolio snapshot is invalid.')
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
 * Maps a DynamoDB failure to a Project data error.
 *
 * A transaction cancelled only by failed conditions means another save of the month came first
 * or the caller's access changed. One
 * cancelled by throttling or a competing transaction is retryable, and any other failure is a
 * storage failure.
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
        throw snapshotConflict()
      }
      if (
        codes.some((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)) &&
        codes.every((code) =>
          code === 'None' || code === 'ConditionalCheckFailed' || (code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code)))
      ) {
        throw retryableFailure()
      }
    }
  }
  if (typeof name === 'string' && TRANSIENT_ERROR_NAMES.includes(name)) throw retryableFailure()
  throw new ProjectDataError(502, 'PortfolioSnapshotStorageFailure', 'Portfolio snapshot storage request failed.')
}

/**
 * Creates the error for a save that lost to another save of the month or to a permission change.
 *
 * @returns The error.
 */
function snapshotConflict() {
  return new ProjectDataError(409, 'PortfolioSnapshotConflict', 'The snapshot or your permissions changed. Reload and try again.')
}

/**
 * Creates the error for a storage failure that may succeed when retried.
 *
 * @returns The error.
 */
function retryableFailure() {
  return new ProjectDataError(503, 'PortfolioSnapshotRetryable', 'Portfolio snapshot storage is temporarily unavailable.')
}
