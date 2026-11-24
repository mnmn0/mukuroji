import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { CALENDAR_FEED_KINDS, type CalendarFeedKind } from '@mukuroji/contracts'
import {
  createMutationAuditEventPut,
  type MutationAuditContext,
} from '../../../audit'
import {
  CalendarFeedError,
  type CalendarFeedOwner,
  type CalendarFeedRecord,
  type CalendarFeedRemoveInput,
  type CalendarFeedSaveInput,
  type CalendarFeedStore,
} from '../../application/calendar-feed-use-cases'

/** Planning-table record type of one feed. */
const FEED_TYPE = 'calendar-feed'
/** Planning-table record type of the token lookup row of a feed. */
const TOKEN_TYPE = 'calendar-feed-token'
/** Schema version of the feed and token rows. */
const SCHEMA_VERSION = 1

/** Transaction item of a DynamoDB write. */
type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/**
 * Builds the record key prefix of one member's feeds.
 *
 * @param memberKey - Owner member key.
 * @returns The prefix.
 */
function ownerPrefix(memberKey: string): string {
  return `CALENDAR_FEED#${encodeURIComponent(memberKey)}#`
}

/**
 * Builds the record key of a feed. A member has one member feed and one feed per Project, so the
 * key names the target and a second issue of the same target replaces the row.
 *
 * @param record - Feed.
 * @returns The record key.
 */
function feedKey(record: Pick<CalendarFeedRecord, 'memberKey' | 'kind' | 'teamId' | 'projectId'>): string {
  return record.kind === 'member'
    ? `${ownerPrefix(record.memberKey)}MEMBER`
    : `${ownerPrefix(record.memberKey)}PROJECT#${encodeURIComponent(record.teamId ?? '')}#${encodeURIComponent(record.projectId ?? '')}`
}

/**
 * Builds the record key of a token lookup row. It does not start with a feed prefix, so listing
 * a member's feeds never reads it.
 *
 * @param tokenHash - Digest of the token secret.
 * @returns The record key.
 */
function tokenKey(tokenHash: string): string {
  return `CALENDAR_FEED_TOKEN#${tokenHash}`
}

/**
 * Stores each feed as one Planning-table row in the Workspace partition, and its current token
 * digest as a lookup row in the same partition, so deleting the Workspace partition removes
 * both. Replacing or revoking a token deletes its lookup row in the same transaction.
 */
export class DynamoDbCalendarFeedStore implements CalendarFeedStore<MutationAuditContext> {
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
   * Reads every feed of one member.
   *
   * @param owner - Workspace and member.
   * @returns The validated feeds.
   */
  async list(owner: CalendarFeedOwner): Promise<CalendarFeedRecord[]> {
    const records: CalendarFeedRecord[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#workspaceId = :workspaceId AND begins_with(#recordKey, :prefix)',
        ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':workspaceId': owner.workspaceId, ':prefix': ownerPrefix(owner.memberKey) },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })).catch((error: unknown) => storageFailure(error))
      for (const row of page.Items ?? []) records.push(parseFeedRow(row, owner.workspaceId))
      exclusiveStartKey = page.LastEvaluatedKey
    } while (exclusiveStartKey)
    return records.filter((record) => record.memberKey === owner.memberKey)
  }

  /**
   * Finds a feed through its token lookup row, and returns it only while that token is current.
   *
   * @param workspaceId - Workspace named by the token.
   * @param tokenHash - Digest of the token secret.
   * @returns The feed, or `null`.
   */
  async findByTokenHash(workspaceId: string, tokenHash: string): Promise<CalendarFeedRecord | null> {
    const tokenRow = await this.readItem(workspaceId, tokenKey(tokenHash))
    if (!tokenRow) return null
    if (
      tokenRow.entryType !== TOKEN_TYPE ||
      tokenRow.schemaVersion !== SCHEMA_VERSION ||
      typeof tokenRow.feedRecordKey !== 'string'
    ) {
      throw corruptFeed()
    }
    const feedRow = await this.readItem(workspaceId, tokenRow.feedRecordKey)
    if (!feedRow) return null
    const record = parseFeedRow(feedRow, workspaceId)
    return record.tokenHash === tokenHash ? record : null
  }

  /**
   * Stores a feed and its new token lookup row, deleting the previous lookup row, in one
   * transaction that fails when another request replaced the token first.
   *
   * @param input - Feed, previous digest, and audit context.
   */
  async save(input: CalendarFeedSaveInput<MutationAuditContext>): Promise<void> {
    const { record } = input
    const recordKey = feedKey(record)
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: input.previousTokenHash ? 'member.calendar_feed_rotated' : 'member.calendar_feed_issued',
      entityType: 'member',
      entityId: record.memberKey,
      target: { type: FEED_TYPE, id: record.id },
      action: input.previousTokenHash ? 'calendar_feed_rotated' : 'calendar_feed_issued',
      occurredAt: input.now,
      changes: [],
      metadata: auditMetadata(record),
    })
    const items: TransactItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: input.workspaceId,
            recordKey,
            entryType: FEED_TYPE,
            schemaVersion: SCHEMA_VERSION,
            feedId: record.id,
            kind: record.kind,
            memberKey: record.memberKey,
            ...(record.teamId === undefined ? {} : { teamId: record.teamId }),
            ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
            locale: record.locale,
            tokenHash: record.tokenHash,
            issuedAt: record.issuedAt,
            createdAt: record.createdAt,
          },
          ...(input.previousTokenHash
            ? {
                ConditionExpression: '#tokenHash = :previousTokenHash',
                ExpressionAttributeNames: { '#tokenHash': 'tokenHash' },
                ExpressionAttributeValues: { ':previousTokenHash': input.previousTokenHash },
              }
            : { ConditionExpression: 'attribute_not_exists(recordKey)' }),
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: input.workspaceId,
            recordKey: tokenKey(record.tokenHash),
            entryType: TOKEN_TYPE,
            schemaVersion: SCHEMA_VERSION,
            feedRecordKey: recordKey,
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      ...(input.previousTokenHash
        ? [{
            Delete: {
              TableName: this.tableName,
              Key: { workspaceId: input.workspaceId, recordKey: tokenKey(input.previousTokenHash) },
            },
          } satisfies TransactItem]
        : []),
      ...(audit ? [audit] : []),
    ]
    await this.client.send(new TransactWriteCommand({ TransactItems: items }))
      .catch((error: unknown) => storageFailure(error, items.length))
  }

  /**
   * Deletes a feed and its token lookup row while that token is still current.
   *
   * @param input - Feed and audit context.
   */
  async remove(input: CalendarFeedRemoveInput<MutationAuditContext>): Promise<void> {
    const { record } = input
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'member.calendar_feed_revoked',
      entityType: 'member',
      entityId: record.memberKey,
      target: { type: FEED_TYPE, id: record.id },
      action: 'calendar_feed_revoked',
      occurredAt: input.now,
      changes: [],
      metadata: auditMetadata(record),
    })
    const items: TransactItem[] = [
      {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: feedKey(record) },
          ConditionExpression: '#tokenHash = :tokenHash',
          ExpressionAttributeNames: { '#tokenHash': 'tokenHash' },
          ExpressionAttributeValues: { ':tokenHash': record.tokenHash },
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: tokenKey(record.tokenHash) },
        },
      },
      ...(audit ? [audit] : []),
    ]
    await this.client.send(new TransactWriteCommand({ TransactItems: items }))
      .catch((error: unknown) => storageFailure(error, items.length))
  }

  /**
   * Reads one row with a strongly consistent read.
   *
   * @param workspaceId - Workspace partition.
   * @param recordKey - Record key.
   * @returns The row, or `undefined`.
   */
  private async readItem(workspaceId: string, recordKey: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey },
      ConsistentRead: true,
    })).catch((error: unknown) => storageFailure(error))
    return result.Item
  }
}

/**
 * Keeps feeds in memory for tests and local runs, with the same replace and revoke rules.
 */
export class InMemoryCalendarFeedStore implements CalendarFeedStore {
  /** Feeds keyed by Workspace and feed record key. */
  private readonly feeds = new Map<string, CalendarFeedRecord>()
  /** Feed record keys keyed by Workspace and token digest. */
  private readonly tokens = new Map<string, string>()

  /**
   * Lists copies of one member's feeds.
   *
   * @param owner - Workspace and member.
   * @returns The feeds.
   */
  async list(owner: CalendarFeedOwner): Promise<CalendarFeedRecord[]> {
    const prefix = `${owner.workspaceId}\0${ownerPrefix(owner.memberKey)}`
    return [...this.feeds.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => structuredClone(record))
  }

  /**
   * Finds a feed by its current token digest.
   *
   * @param workspaceId - Workspace.
   * @param tokenHash - Digest.
   * @returns A copy of the feed, or `null`.
   */
  async findByTokenHash(workspaceId: string, tokenHash: string): Promise<CalendarFeedRecord | null> {
    const recordKey = this.tokens.get(`${workspaceId}\0${tokenHash}`)
    const record = recordKey === undefined ? undefined : this.feeds.get(`${workspaceId}\0${recordKey}`)
    return record && record.tokenHash === tokenHash ? structuredClone(record) : null
  }

  /**
   * Stores a feed, replacing its token when the previous digest matches.
   *
   * @param input - Feed and previous digest.
   */
  async save(input: CalendarFeedSaveInput<unknown>): Promise<void> {
    const recordKey = feedKey(input.record)
    const key = `${input.workspaceId}\0${recordKey}`
    const current = this.feeds.get(key)
    if (input.previousTokenHash ? current?.tokenHash !== input.previousTokenHash : current !== undefined) {
      throw conflict()
    }
    if (input.previousTokenHash) this.tokens.delete(`${input.workspaceId}\0${input.previousTokenHash}`)
    this.feeds.set(key, structuredClone(input.record))
    this.tokens.set(`${input.workspaceId}\0${input.record.tokenHash}`, recordKey)
  }

  /**
   * Deletes a feed while its token is current.
   *
   * @param input - Feed.
   */
  async remove(input: CalendarFeedRemoveInput<unknown>): Promise<void> {
    const key = `${input.workspaceId}\0${feedKey(input.record)}`
    if (this.feeds.get(key)?.tokenHash !== input.record.tokenHash) throw conflict()
    this.feeds.delete(key)
    this.tokens.delete(`${input.workspaceId}\0${input.record.tokenHash}`)
  }
}

/**
 * Builds the audit metadata of a feed change; the token and its digest are never recorded.
 *
 * @param record - Feed.
 * @returns Metadata.
 */
function auditMetadata(record: CalendarFeedRecord): Record<string, string> {
  return {
    feedKind: record.kind,
    ...(record.teamId === undefined ? {} : { teamId: record.teamId }),
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
  }
}

/**
 * Validates a stored feed row.
 *
 * @param row - Raw row.
 * @param workspaceId - Partition the row was read from.
 * @returns The feed.
 * @throws CalendarFeedError 503 when the row is malformed.
 */
function parseFeedRow(row: Record<string, unknown>, workspaceId: string): CalendarFeedRecord {
  const kind = row.kind
  if (
    row.workspaceId !== workspaceId ||
    row.entryType !== FEED_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    !isFeedKind(kind) ||
    typeof row.feedId !== 'string' ||
    typeof row.memberKey !== 'string' ||
    typeof row.tokenHash !== 'string' ||
    typeof row.issuedAt !== 'string' ||
    typeof row.createdAt !== 'string' ||
    (row.locale !== 'ja' && row.locale !== 'en') ||
    (kind === 'project' && (typeof row.teamId !== 'string' || typeof row.projectId !== 'string'))
  ) {
    throw corruptFeed()
  }
  const record: CalendarFeedRecord = {
    id: row.feedId,
    kind,
    ...(kind === 'project' && typeof row.teamId === 'string' && typeof row.projectId === 'string'
      ? { teamId: row.teamId, projectId: row.projectId }
      : {}),
    locale: row.locale,
    issuedAt: row.issuedAt,
    createdAt: row.createdAt,
    memberKey: row.memberKey,
    tokenHash: row.tokenHash,
  }
  if (row.recordKey !== feedKey(record)) throw corruptFeed()
  return record
}

/**
 * Returns whether a stored value is a feed kind.
 *
 * @param value - Stored value.
 * @returns Whether it is `member` or `project`.
 */
function isFeedKind(value: unknown): value is CalendarFeedKind {
  return CALENDAR_FEED_KINDS.some((kind) => kind === value)
}

/**
 * Creates the error for a malformed stored row.
 *
 * @returns The error.
 */
function corruptFeed(): CalendarFeedError {
  return new CalendarFeedError(503, 'CalendarFeedCorrupt', 'Calendar feed data is unavailable.')
}

/**
 * Creates the error for a feed another request changed first.
 *
 * @returns The error.
 */
function conflict(): CalendarFeedError {
  return new CalendarFeedError(409, 'CalendarFeedConflict', 'The calendar feed changed. Reload and try again.')
}

/** DynamoDB cancellation codes that mean the request may succeed if retried. */
const TRANSIENT_CANCELLATION_CODES = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']

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

/**
 * Maps a DynamoDB failure to a calendar feed error: failed conditions are a conflict, throttling
 * is retryable, and anything else is unavailable storage.
 *
 * @param error - Thrown SDK error.
 * @param transactionSize - Number of items in the cancelled transaction, or 0 for a plain read.
 * @returns Never; always throws.
 */
function storageFailure(error: unknown, transactionSize = 0): never {
  if (error instanceof CalendarFeedError) throw error
  const codes = readCancellationCodes(error)
  if (codes && transactionSize > 0 && codes.length === transactionSize) {
    const isConditionOrNone = (code: string | undefined) => code === 'None' || code === 'ConditionalCheckFailed'
    if (codes.includes('ConditionalCheckFailed') && codes.every(isConditionOrNone)) throw conflict()
    if (codes.some((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES.includes(code))) {
      throw new CalendarFeedError(503, 'CalendarFeedRetryable', 'Calendar feed storage is temporarily unavailable.', { cause: error })
    }
  }
  throw new CalendarFeedError(503, 'CalendarFeedStorageFailure', 'Calendar feed storage request failed.', { cause: error })
}
