import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  isSlackChannelId,
  isSlackIngestRetentionDays,
  parseSlackChannelTarget,
  SLACK_INGEST_DEFAULT_RETENTION_DAYS,
  type SlackChannelBackfillStatus,
  type SlackChannelTarget,
} from '@mukuroji/contracts'
import { createMutationAuditEventPut, type MutationAuditContext } from '../../../audit'
import { isSlackTs, isSlackUserId } from '../../domain/slack-events'
import { SlackIngestError } from '../../errors'
import type {
  SlackChannelRecord,
  SlackIngestAuditInput,
  SlackIngestSettings,
  SlackIngestStore,
  SlackInstallation,
  SlackMessageRef,
  SlackMessageWriteOutcome,
  StoredSlackMessage,
} from '../../application/ports/slack-ingest-ports'

/** Prefix of every Slack ingest row in the Developer Platform table. */
const PREFIX = 'slack-ingest#'
/** Record key of the settings row. */
const SETTINGS_KEY = `${PREFIX}settings`
/** Record key of the installation row. */
const INSTALLATION_KEY = `${PREFIX}installation`
/** Schema version of every row. */
const SCHEMA_VERSION = 1
/** Attempts of a conditional message write that lost a race. */
const MESSAGE_WRITE_ATTEMPTS = 3
/** Backfill states accepted from storage. */
const BACKFILL_STATUSES: readonly SlackChannelBackfillStatus[] = ['pending', 'running', 'completed', 'failed']

/** Transaction item of a DynamoDB write. */
type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Stored row as returned by the document client. */
type Row = Record<string, unknown>

/**
 * Builds a channel row key.
 *
 * @param channelId - Channel ID.
 * @returns The record key.
 */
function channelKey(channelId: string): string {
  return `${PREFIX}channel#${channelId}`
}

/**
 * Builds the key prefix of a channel's message rows.
 *
 * @param channelId - Channel ID.
 * @returns The prefix.
 */
function messagePrefix(channelId: string): string {
  return `${PREFIX}message#${channelId}#`
}

/**
 * Builds a message row key.
 *
 * @param ref - Message.
 * @returns The record key.
 */
function messageKey(ref: SlackMessageRef): string {
  return `${messagePrefix(ref.channelId)}${ref.ts}`
}

/**
 * Builds the key prefix of one Work Item key's index rows.
 *
 * @param key - Canonical Work Item key.
 * @returns The prefix.
 */
function keyIndexPrefix(key: string): string {
  return `${PREFIX}key#${key}#`
}

/**
 * Builds a key index row key. The time comes first so a descending query reads the newest
 * messages first.
 *
 * @param key - Canonical Work Item key.
 * @param ref - Message.
 * @returns The record key.
 */
function keyIndexKey(key: string, ref: SlackMessageRef): string {
  return `${keyIndexPrefix(key)}${ref.ts}#${ref.channelId}`
}

/**
 * Builds a user name cache row key.
 *
 * @param userId - Slack user ID.
 * @returns The record key.
 */
function userKey(userId: string): string {
  return `${PREFIX}user#${userId}`
}

/**
 * Creates the error for a malformed stored row.
 *
 * @returns The error.
 */
function corruptRow(): SlackIngestError {
  return new SlackIngestError('unavailable', 'SlackIngestRowInvalid', 'Stored Slack data is unavailable.')
}

/**
 * Reports whether a transaction or write failed only on its conditions.
 *
 * @param error - Thrown SDK error.
 * @returns Whether a condition failed.
 */
function isConditionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false
  if (error.name === 'ConditionalCheckFailedException') return true
  if (error.name !== 'TransactionCanceledException' || !('CancellationReasons' in error)) return false
  const reasons = error.CancellationReasons
  return Array.isArray(reasons) && reasons.some((reason: unknown) =>
    typeof reason === 'object' && reason !== null && 'Code' in reason && reason.Code === 'ConditionalCheckFailed')
}

/**
 * Reports whether a cancelled transaction failed the condition of one item.
 *
 * @param error - Thrown error.
 * @param index - Item position in the transaction.
 * @returns Whether that item's condition failed.
 */
function isConditionFailureAt(error: unknown, index: number): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false
  if (error.name !== 'TransactionCanceledException' || !('CancellationReasons' in error)) return false
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return false
  const reason: unknown = reasons[index]
  return typeof reason === 'object' && reason !== null && 'Code' in reason && reason.Code === 'ConditionalCheckFailed'
}

/**
 * Reads a string array of Work Item keys from a row.
 *
 * @param value - Stored value.
 * @returns The keys.
 * @throws SlackIngestError when the value is not a string array.
 */
function readKeys(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((key) => typeof key === 'string')) throw corruptRow()
  return value.map(String)
}

/**
 * Parses a channel row.
 *
 * @param row - Stored row.
 * @returns The channel.
 * @throws SlackIngestError when the row is malformed.
 */
function parseChannel(row: Row): SlackChannelRecord {
  const { channelId, name, isPrivate, membership, mappingRevision, updatedAt } = row
  if (
    !isSlackChannelId(channelId) ||
    row.recordKey !== channelKey(channelId) ||
    (name !== undefined && typeof name !== 'string') ||
    typeof isPrivate !== 'boolean' ||
    (membership !== 'joined' && membership !== 'left') ||
    typeof mappingRevision !== 'number' ||
    typeof updatedAt !== 'string'
  ) {
    throw corruptRow()
  }
  let target: SlackChannelTarget | undefined
  try {
    target = row.target === undefined ? undefined : parseSlackChannelTarget(row.target)
  } catch {
    throw corruptRow()
  }
  const backfill = readBackfill(row.backfill)
  return {
    channelId,
    ...(typeof name === 'string' ? { name } : {}),
    isPrivate,
    membership,
    ...(target ? { target } : {}),
    mappingRevision,
    ...(backfill ? { backfill } : {}),
    updatedAt,
  }
}

/**
 * Parses a stored backfill state.
 *
 * @param value - Stored value.
 * @returns The state, when present.
 * @throws SlackIngestError when the value is malformed.
 */
function readBackfill(value: unknown): SlackChannelRecord['backfill'] {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw corruptRow()
  const status = BACKFILL_STATUSES.find((candidate) => candidate === Reflect.get(value, 'status'))
  const importedCount = Reflect.get(value, 'importedCount')
  if (!status || typeof importedCount !== 'number') throw corruptRow()
  return { status, importedCount }
}

/** A message row, which may be a deletion tombstone. */
type MessageRow = {
  /** Message, absent for a tombstone. */
  message?: StoredSlackMessage
  /** Stored version. */
  version: string
  /** Keys indexed for the message. */
  keys: string[]
}

/**
 * Parses a message row.
 *
 * @param row - Stored row.
 * @returns The message or tombstone.
 * @throws SlackIngestError when the row is malformed.
 */
function parseMessageRow(row: Row): MessageRow {
  const { channelId, ts, version } = row
  if (!isSlackChannelId(channelId) || !isSlackTs(ts) || typeof version !== 'string') throw corruptRow()
  if (row.recordKey !== messageKey({ channelId, ts })) throw corruptRow()
  if (row.deleted === true) return { version, keys: [] }
  const { userId, text, permalink, expiresAt, threadTs, editedTs, authorName } = row
  if (
    !isSlackUserId(userId) ||
    typeof text !== 'string' ||
    typeof permalink !== 'string' ||
    typeof expiresAt !== 'number' ||
    (threadTs !== undefined && !isSlackTs(threadTs)) ||
    (editedTs !== undefined && !isSlackTs(editedTs)) ||
    (authorName !== undefined && typeof authorName !== 'string')
  ) {
    throw corruptRow()
  }
  const keys = readKeys(row.keys)
  return {
    version,
    keys,
    message: {
      channelId,
      ts,
      ...(isSlackTs(threadTs) ? { threadTs } : {}),
      userId,
      text,
      version,
      ...(isSlackTs(editedTs) ? { editedTs } : {}),
      ...(typeof authorName === 'string' ? { authorName } : {}),
      keys,
      permalink,
      expiresAt,
    },
  }
}

/**
 * Splits a list into chunks.
 *
 * @param items - Items.
 * @param size - Chunk size.
 * @returns Chunks in order.
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

/** Slack ingest rows in the Developer Platform table, partitioned by Workspace (ADR 0113). */
export class DynamoDbSlackIngestStore implements SlackIngestStore<MutationAuditContext> {
  /** Developer Platform table name. */
  private readonly tableName: string
  /** Document client. */
  private readonly client: DynamoDBDocumentClient
  /** Audit table written with administrator changes, when audit is configured. */
  private readonly auditTableName: string | undefined

  /**
   * Creates the store.
   *
   * @param tableName - Developer Platform table name.
   * @param client - Document client.
   * @param auditTableName - Audit table, when configured.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, auditTableName?: string) {
    this.tableName = tableName
    this.client = client
    this.auditTableName = auditTableName
  }

  /**
   * Reads one row with a consistent read.
   *
   * @param workspaceId - Workspace ID.
   * @param recordKey - Record key.
   * @returns The row, when present.
   */
  private async getRow(workspaceId: string, recordKey: string): Promise<Row | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey },
      ConsistentRead: true,
    }))
    return response.Item
  }

  /**
   * Builds the audit put of an administrator change.
   *
   * @param workspaceId - Workspace ID.
   * @param audit - Audit input.
   * @param event - Event details.
   * @returns The transaction item, when audit is configured.
   */
  private auditPut(
    workspaceId: string,
    audit: SlackIngestAuditInput<MutationAuditContext>,
    event: { eventType: string, action: string, entityId: string, metadata: Record<string, unknown> },
  ): TransactItem | undefined {
    return createMutationAuditEventPut(this.auditTableName, audit.context, {
      directoryId: workspaceId,
      eventType: event.eventType,
      entityType: 'slack-ingest',
      entityId: event.entityId,
      target: { type: 'slack-ingest', id: event.entityId },
      action: event.action,
      occurredAt: audit.now,
      changes: [],
      metadata: event.metadata,
    })
  }

  /**
   * Reads the Workspace settings.
   *
   * @param workspaceId - Workspace ID.
   * @returns The settings or the defaults.
   */
  async getSettings(workspaceId: string): Promise<SlackIngestSettings> {
    const row = await this.getRow(workspaceId, SETTINGS_KEY)
    if (!row) return { retentionDays: SLACK_INGEST_DEFAULT_RETENTION_DAYS, revision: 0 }
    if (!isSlackIngestRetentionDays(row.retentionDays) || typeof row.revision !== 'number') throw corruptRow()
    return { retentionDays: row.retentionDays, revision: row.revision }
  }

  /**
   * Saves the retention while the revision is unchanged.
   *
   * @param workspaceId - Workspace ID.
   * @param retentionDays - New retention.
   * @param expectedRevision - Revision read.
   * @param audit - Audit input.
   * @returns The saved settings.
   */
  async saveSettings(
    workspaceId: string,
    retentionDays: number,
    expectedRevision: number,
    audit: SlackIngestAuditInput<MutationAuditContext>,
  ): Promise<SlackIngestSettings> {
    const revision = expectedRevision + 1
    const auditItem = this.auditPut(workspaceId, audit, {
      eventType: 'slack_ingest.settings_updated',
      action: 'settings_updated',
      entityId: 'settings',
      metadata: { retentionDays },
    })
    const items: TransactItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId,
            recordKey: SETTINGS_KEY,
            entryType: 'slack-ingest-settings',
            schemaVersion: SCHEMA_VERSION,
            retentionDays,
            revision,
            updatedAt: audit.now,
          },
          ...(expectedRevision === 0
            ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
            : {
                ConditionExpression: '#revision = :expected',
                ExpressionAttributeNames: { '#revision': 'revision' },
                ExpressionAttributeValues: { ':expected': expectedRevision },
              }),
        },
      },
      ...(auditItem ? [auditItem] : []),
    ]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      if (isConditionFailure(error)) {
        throw new SlackIngestError('conflict', 'SlackIngestSettingsConflict', 'The settings changed. Reload and try again.')
      }
      throw error
    }
    return { retentionDays, revision }
  }

  /**
   * Reads the stored installation.
   *
   * @param workspaceId - Workspace ID.
   * @returns The installation, when stored.
   */
  async getInstallation(workspaceId: string): Promise<SlackInstallation | undefined> {
    const row = await this.getRow(workspaceId, INSTALLATION_KEY)
    if (!row) return undefined
    const { teamOrigin, botUserId, checkedAt } = row
    if (typeof teamOrigin !== 'string' || !isSlackUserId(botUserId) || typeof checkedAt !== 'string') throw corruptRow()
    return { teamOrigin, botUserId, checkedAt }
  }

  /**
   * Saves the installation.
   *
   * @param workspaceId - Workspace ID.
   * @param installation - Installation.
   */
  async putInstallation(workspaceId: string, installation: SlackInstallation): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        workspaceId,
        recordKey: INSTALLATION_KEY,
        entryType: 'slack-ingest-installation',
        schemaVersion: SCHEMA_VERSION,
        ...installation,
      },
    }))
  }

  /**
   * Reads one channel.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @returns The channel, when stored.
   */
  async getChannel(workspaceId: string, channelId: string): Promise<SlackChannelRecord | undefined> {
    const row = await this.getRow(workspaceId, channelKey(channelId))
    return row ? parseChannel(row) : undefined
  }

  /**
   * Lists every stored channel, reading every page.
   *
   * @param workspaceId - Workspace ID.
   * @returns Channels.
   */
  async listChannels(workspaceId: string): Promise<SlackChannelRecord[]> {
    const channels: SlackChannelRecord[] = []
    let startKey: Record<string, unknown> | undefined
    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': `${PREFIX}channel#` },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }))
      for (const row of response.Items ?? []) channels.push(parseChannel(row))
      startKey = response.LastEvaluatedKey
    } while (startKey)
    return channels
  }

  /**
   * Records the bot joining or leaving a channel.
   *
   * @param workspaceId - Workspace ID.
   * @param channel - Channel facts.
   * @returns The channel.
   */
  async recordMembership(
    workspaceId: string,
    channel: { channelId: string, name?: string, isPrivate: boolean, membership: 'joined' | 'left', now: string },
  ): Promise<SlackChannelRecord> {
    const response = await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: channelKey(channel.channelId) },
      UpdateExpression: [
        'SET entryType = :entryType, schemaVersion = :schemaVersion, channelId = :channelId',
        'isPrivate = :isPrivate, membership = :membership, updatedAt = :now',
        'mappingRevision = if_not_exists(mappingRevision, :zero)',
        ...(channel.name ? ['#name = :name'] : []),
      ].join(', '),
      ...(channel.name ? { ExpressionAttributeNames: { '#name': 'name' } } : {}),
      ExpressionAttributeValues: {
        ':entryType': 'slack-ingest-channel',
        ':schemaVersion': SCHEMA_VERSION,
        ':channelId': channel.channelId,
        ':isPrivate': channel.isPrivate,
        ':membership': channel.membership,
        ':now': channel.now,
        ':zero': 0,
        ...(channel.name ? { ':name': channel.name } : {}),
      },
      ReturnValues: 'ALL_NEW',
    }))
    if (!response.Attributes) throw corruptRow()
    return parseChannel(response.Attributes)
  }

  /**
   * Changes a channel's mapping and resets its load.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param target - New target, or `undefined`.
   * @param expectedRevision - Mapping revision read.
   * @param audit - Audit input.
   * @returns The channel.
   */
  async setChannelTarget(
    workspaceId: string,
    channelId: string,
    target: SlackChannelTarget | undefined,
    expectedRevision: number,
    audit: SlackIngestAuditInput<MutationAuditContext>,
  ): Promise<SlackChannelRecord> {
    const auditItem = this.auditPut(workspaceId, audit, {
      eventType: target ? 'slack_ingest.channel_mapped' : 'slack_ingest.channel_unmapped',
      action: target ? 'channel_mapped' : 'channel_unmapped',
      entityId: channelId,
      metadata: { channelId, ...(target ? { target } : {}) },
    })
    const items: TransactItem[] = [
      {
        Update: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: channelKey(channelId) },
          UpdateExpression: target
            ? 'SET #target = :target, mappingRevision = :next, backfill = :backfill, updatedAt = :now'
            : 'SET mappingRevision = :next, updatedAt = :now REMOVE #target, backfill',
          ConditionExpression: 'attribute_exists(recordKey) AND mappingRevision = :expected',
          ExpressionAttributeNames: { '#target': 'target' },
          ExpressionAttributeValues: {
            ':expected': expectedRevision,
            ':next': expectedRevision + 1,
            ':now': audit.now,
            ...(target ? { ':target': target, ':backfill': { status: 'pending', importedCount: 0 } } : {}),
          },
        },
      },
      ...(auditItem ? [auditItem] : []),
    ]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      if (isConditionFailure(error)) {
        throw new SlackIngestError('conflict', 'SlackChannelMappingConflict', 'The channel changed. Reload and try again.')
      }
      throw error
    }
    const updated = await this.getChannel(workspaceId, channelId)
    if (!updated) throw corruptRow()
    return updated
  }

  /**
   * Updates a load while its mapping is current.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param mappingRevision - Mapping revision.
   * @param backfill - New load state.
   * @param now - ISO 8601 time.
   * @returns Whether the mapping was current.
   */
  async updateBackfill(
    workspaceId: string,
    channelId: string,
    mappingRevision: number,
    backfill: NonNullable<SlackChannelRecord['backfill']>,
    now: string,
  ): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: channelKey(channelId) },
        UpdateExpression: 'SET backfill = :backfill, updatedAt = :now',
        ConditionExpression: 'attribute_exists(#target) AND mappingRevision = :revision',
        ExpressionAttributeNames: { '#target': 'target' },
        ExpressionAttributeValues: { ':backfill': backfill, ':now': now, ':revision': mappingRevision },
      }))
      return true
    } catch (error) {
      if (isConditionFailure(error)) return false
      throw error
    }
  }

  /**
   * Reads a message row.
   *
   * @param workspaceId - Workspace ID.
   * @param ref - Message.
   * @returns The row, when stored.
   */
  private async getMessageRow(workspaceId: string, ref: SlackMessageRef): Promise<MessageRow | undefined> {
    const row = await this.getRow(workspaceId, messageKey(ref))
    return row ? parseMessageRow(row) : undefined
  }

  /**
   * Builds the condition that the stored row is still the one read.
   *
   * @param existing - Row read, or `undefined` when there was none.
   * @returns Condition fields of the put.
   */
  private unchangedCondition(existing: MessageRow | undefined) {
    return existing
      ? {
          ConditionExpression: '#version = :previousVersion',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':previousVersion': existing.version },
        }
      : { ConditionExpression: 'attribute_not_exists(recordKey)' }
  }

  /**
   * Builds the key index changes from the old keys to the new ones.
   *
   * @param workspaceId - Workspace ID.
   * @param ref - Message.
   * @param oldKeys - Keys indexed now.
   * @param newKeys - Keys to index.
   * @param expiresAt - TTL of new index rows.
   * @returns Transaction items.
   */
  private keyIndexItems(
    workspaceId: string,
    ref: SlackMessageRef,
    oldKeys: readonly string[],
    newKeys: readonly string[],
    expiresAt: number,
  ): TransactItem[] {
    return [
      ...oldKeys.filter((key) => !newKeys.includes(key)).map((key): TransactItem => ({
        Delete: { TableName: this.tableName, Key: { workspaceId, recordKey: keyIndexKey(key, ref) } },
      })),
      ...newKeys.map((key): TransactItem => ({
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId,
            recordKey: keyIndexKey(key, ref),
            entryType: 'slack-ingest-key',
            schemaVersion: SCHEMA_VERSION,
            key,
            channelId: ref.channelId,
            ts: ref.ts,
            expiresAt,
          },
        },
      })),
    ]
  }

  /**
   * Writes a message unless a newer version or a deletion is stored.
   *
   * @param workspaceId - Workspace ID.
   * @param message - Message.
   * @returns Whether it was written.
   */
  async putMessage(workspaceId: string, message: StoredSlackMessage, mappingRevision: number): Promise<SlackMessageWriteOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      const existing = await this.getMessageRow(workspaceId, message)
      if (existing && (!existing.message || existing.version >= message.version)) return 'stale'
      const items: TransactItem[] = [
        {
          // An unmap or remap after the job read the channel fences this write out.
          ConditionCheck: {
            TableName: this.tableName,
            Key: { workspaceId, recordKey: channelKey(message.channelId) },
            ConditionExpression: 'mappingRevision = :revision AND attribute_exists(#target)',
            ExpressionAttributeNames: { '#target': 'target' },
            ExpressionAttributeValues: { ':revision': mappingRevision },
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              workspaceId,
              recordKey: messageKey(message),
              entryType: 'slack-ingest-message',
              schemaVersion: SCHEMA_VERSION,
              ...message,
            },
            ...this.unchangedCondition(existing),
          },
        },
        ...this.keyIndexItems(workspaceId, message, existing?.keys ?? [], message.keys, message.expiresAt),
      ]
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: items }))
        return 'written'
      } catch (error) {
        if (isConditionFailureAt(error, 0)) return 'unmapped'
        if (!isConditionFailure(error) || attempt >= MESSAGE_WRITE_ATTEMPTS) throw error
      }
    }
  }

  /**
   * Replaces a message with a tombstone and removes its key rows.
   *
   * @param workspaceId - Workspace ID.
   * @param ref - Message.
   * @param eventTs - Deletion timestamp.
   * @param expiresAt - Tombstone TTL.
   */
  async deleteMessage(workspaceId: string, ref: SlackMessageRef, eventTs: string, expiresAt: number): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const existing = await this.getMessageRow(workspaceId, ref)
      if (existing && !existing.message) return
      const items: TransactItem[] = [
        {
          Put: {
            TableName: this.tableName,
            Item: {
              workspaceId,
              recordKey: messageKey(ref),
              entryType: 'slack-ingest-message',
              schemaVersion: SCHEMA_VERSION,
              channelId: ref.channelId,
              ts: ref.ts,
              version: eventTs,
              deleted: true,
              expiresAt,
            },
            ...this.unchangedCondition(existing),
          },
        },
        ...this.keyIndexItems(workspaceId, ref, existing?.keys ?? [], [], expiresAt),
      ]
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: items }))
        return
      } catch (error) {
        if (!isConditionFailure(error) || attempt >= MESSAGE_WRITE_ATTEMPTS) throw error
      }
    }
  }

  /**
   * Reads stored messages, leaving out tombstones, missing rows, and rows past their TTL.
   *
   * @param workspaceId - Workspace ID.
   * @param refs - Messages.
   * @returns Messages that exist.
   */
  async getMessages(workspaceId: string, refs: readonly SlackMessageRef[]): Promise<StoredSlackMessage[]> {
    const messages: StoredSlackMessage[] = []
    const nowSeconds = Math.floor(Date.now() / 1000)
    for (const batch of chunk(refs, 100)) {
      let keys: Record<string, unknown>[] = batch.map((ref) => ({ workspaceId, recordKey: messageKey(ref) }))
      for (let attempt = 0; keys.length > 0; attempt += 1) {
        if (attempt >= 5) throw new SlackIngestError('unavailable', 'SlackIngestReadUnavailable', 'Stored Slack data is temporarily unavailable.')
        const response = await this.client.send(new BatchGetCommand({
          RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } },
        }))
        for (const row of response.Responses?.[this.tableName] ?? []) {
          const parsed = parseMessageRow(row)
          if (parsed.message && parsed.message.expiresAt > nowSeconds) messages.push(parsed.message)
        }
        keys = response.UnprocessedKeys?.[this.tableName]?.Keys ?? []
      }
    }
    return messages
  }

  /**
   * Lists the messages indexed under a Work Item key.
   *
   * @param workspaceId - Workspace ID.
   * @param key - Work Item key.
   * @param limit - Most references.
   * @returns References and whether more exist.
   */
  async listMessageRefsByKey(
    workspaceId: string,
    key: string,
    limit: number,
  ): Promise<{ refs: SlackMessageRef[], truncated: boolean }> {
    const refs: SlackMessageRef[] = []
    let startKey: Record<string, unknown> | undefined
    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': keyIndexPrefix(key) },
        ScanIndexForward: false,
        Limit: limit + 1 - refs.length,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }))
      for (const row of response.Items ?? []) {
        const { channelId, ts } = row
        if (!isSlackChannelId(channelId) || !isSlackTs(ts) || row.recordKey !== keyIndexKey(key, { channelId, ts })) {
          throw corruptRow()
        }
        refs.push({ channelId, ts })
      }
      startKey = response.LastEvaluatedKey
    } while (startKey && refs.length <= limit)
    return { refs: refs.slice(0, limit), truncated: refs.length > limit }
  }

  /**
   * Deletes up to `limit` messages of a channel with their key rows.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param beforeTs - Deletes only older messages, when given.
   * @param limit - Most messages.
   * @returns Count and whether none remain.
   */
  async deleteChannelMessages(
    workspaceId: string,
    channelId: string,
    beforeTs: string | undefined,
    limit: number,
  ): Promise<{ deleted: number, done: boolean }> {
    const prefix = messagePrefix(channelId)
    const rows: MessageRow[] = []
    const refs: SlackMessageRef[] = []
    let startKey: Record<string, unknown> | undefined
    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: beforeTs
          ? 'workspaceId = :workspaceId AND recordKey BETWEEN :start AND :end'
          : 'workspaceId = :workspaceId AND begins_with(recordKey, :start)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':start': prefix,
          ...(beforeTs ? { ':end': `${prefix}${beforeTs}` } : {}),
        },
        Limit: limit - rows.length,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }))
      for (const row of response.Items ?? []) {
        const parsed = parseMessageRow(row)
        rows.push(parsed)
        if (isSlackTs(row.ts)) refs.push({ channelId, ts: row.ts })
      }
      startKey = response.LastEvaluatedKey
    } while (startKey && rows.length < limit)

    const deletes: Record<string, unknown>[] = []
    rows.forEach((row, index) => {
      const ref = refs[index]
      if (!ref) return
      deletes.push({ workspaceId, recordKey: messageKey(ref) })
      for (const key of row.keys) deletes.push({ workspaceId, recordKey: keyIndexKey(key, ref) })
    })
    for (const batch of chunk(deletes, 25)) {
      let requests = batch.map((Key) => ({ DeleteRequest: { Key } }))
      for (let attempt = 0; requests.length > 0; attempt += 1) {
        if (attempt >= 5) throw new SlackIngestError('unavailable', 'SlackIngestDeleteUnavailable', 'Slack data deletion is temporarily unavailable.')
        const response = await this.client.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }))
        const unprocessed = response.UnprocessedItems?.[this.tableName] ?? []
        requests = unprocessed.flatMap((item) => item.DeleteRequest?.Key ? [{ DeleteRequest: { Key: item.DeleteRequest.Key } }] : [])
      }
    }
    return { deleted: rows.length, done: startKey === undefined && rows.length < limit }
  }

  /**
   * Reads a cached author name.
   *
   * @param workspaceId - Workspace ID.
   * @param userId - Slack user ID.
   * @returns The name, `null`, or `undefined` when not cached.
   */
  async getUserName(workspaceId: string, userId: string): Promise<string | null | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: userKey(userId) },
    }))
    const row = response.Item
    if (!row || typeof row.expiresAt !== 'number' || row.expiresAt <= Math.floor(Date.now() / 1000)) return undefined
    return typeof row.displayName === 'string' ? row.displayName : null
  }

  /**
   * Caches an author name.
   *
   * @param workspaceId - Workspace ID.
   * @param userId - Slack user ID.
   * @param name - Name or `null`.
   * @param expiresAt - Cache TTL.
   */
  async putUserName(workspaceId: string, userId: string, name: string | null, expiresAt: number): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        workspaceId,
        recordKey: userKey(userId),
        entryType: 'slack-ingest-user',
        schemaVersion: SCHEMA_VERSION,
        userId,
        ...(name === null ? {} : { displayName: name }),
        expiresAt,
      },
    }))
  }
}
