import { createHash, randomUUID } from 'node:crypto'
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { InboxDigestCheckpoint, InboxDigestCheckpointStore, InboxDigestPending } from '../application/inbox-digest-worker'
import type { InboxDigestRecipient } from '../application/inbox-digest'

/** Durable shard leases, pending pages and terminal failures in the existing Planning table. */
export class DynamoDbInboxDigestCheckpoints implements InboxDigestCheckpointStore {
  /** Existing table; checkpoint keys use a separate system partition. */ private readonly table: string
  /** Injected SDK client. */ private readonly client: DynamoDBDocumentClient
  /** Creates an inactive adapter.
   * @param table - Existing Planning table.
   * @param client - Composition-owned SDK client.
   */
  constructor(table: string, client: DynamoDBDocumentClient) { this.table = table; this.client = client }

  /** Suppresses an exhausted recipient until the next UTC day, retaining recovery evidence.
   * @param recipient - Candidate from the strongly checked due row.
   * @param now - Trusted clock.
   * @returns Whether today's terminal-failure row exists.
   */
  async isQuarantined(recipient: InboxDigestRecipient, now: number): Promise<boolean> {
    const key = failureKey(recipient, now)
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }))
    if (Item === undefined) return false
    if (Item.workspaceId !== key.workspaceId || Item.recordKey !== key.recordKey || Item.entryType !== 'inbox-digest-failure' || Item.schemaVersion !== 1 || !record(Item.recipient) || Item.recipient.workspaceId !== recipient.workspaceId || Item.recipient.memberKey !== recipient.memberKey) throw invalid()
    return true
  }

  /** Claims an idle/expired checkpoint using revision and lease conditions.
   * @param shard - Fixed queue shard.
   * @param now - Trusted clock.
   * @returns Owned checkpoint or undefined for a locked shard.
   */
  async claim(shard: number, now: number): Promise<InboxDigestCheckpoint | undefined> {
    if (!Number.isInteger(shard) || shard < 0 || shard >= 16 || !integer(now)) throw invalid()
    const key = checkpointKey(shard)
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }))
    const current = Item === undefined ? { shard, revision: 0, token: '', leaseUntil: 0, retryAt: 0, pending: [] } : parseCheckpoint(Item, shard)
    if (current.leaseUntil > now || current.retryAt > now) return undefined
    const result = { ...current, revision: current.revision + 1, token: randomUUID(), leaseUntil: now + 90_000 }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: this.table, Item: { ...key, entryType: 'inbox-digest-checkpoint', schemaVersion: 1, ...result },
        ConditionExpression: current.revision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :revision AND leaseUntil <= :now AND retryAt <= :now AND entryType = :type AND schemaVersion = :schema',
        ...(current.revision === 0 ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': current.revision, ':now': now, ':type': 'inbox-digest-checkpoint', ':schema': 1 } }),
      } }] }))
      return result
    } catch (error) { if (conditional(error)) return undefined; throw error }
  }

  /** Saves progress and any exhausted recipient atomically under current ownership.
   * @param input - Owned checkpoint with desired pending work.
   * @param now - Trusted clock.
   * @param release - Whether to release the shard lease.
   * @param failure - Exhausted recipient retained for operator recovery.
   * @returns Committed checkpoint; lost acknowledgements resume from storage.
   */
  async save(input: InboxDigestCheckpoint, now: number, release: boolean, failure?: InboxDigestRecipient): Promise<InboxDigestCheckpoint> {
    const key = checkpointKey(input.shard)
    const validated = parseCheckpoint({ ...key, entryType: 'inbox-digest-checkpoint', schemaVersion: 1, ...input }, input.shard)
    if (!integer(now) || validated.leaseUntil <= now) throw invalid()
    const result = { ...validated, revision: validated.revision + 1, leaseUntil: release ? 0 : validated.leaseUntil }
    await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: this.table,
      Item: { ...key, entryType: 'inbox-digest-checkpoint', schemaVersion: 1, ...result },
      ConditionExpression: '#revision = :revision AND #token = :token AND leaseUntil > :now AND entryType = :type AND schemaVersion = :schema',
      ExpressionAttributeNames: { '#revision': 'revision', '#token': 'token' },
      ExpressionAttributeValues: { ':revision': validated.revision, ':token': validated.token, ':now': now, ':type': 'inbox-digest-checkpoint', ':schema': 1 },
    } }, ...(failure ? [{ Put: { TableName: this.table, Item: { ...failureKey(failure, now), entryType: 'inbox-digest-failure', schemaVersion: 1, recipient: failure, shard: input.shard, failedAt: new Date(now).toISOString(), expiresAt: Math.floor(now / 1000) + 30 * 86_400 } } }] : [])] }))
    return result
  }
}

/** Validates persisted scheduling state before it can select work. */
function parseCheckpoint(row: Record<string, unknown>, shard: number): InboxDigestCheckpoint {
  if (!Number.isInteger(shard) || shard < 0 || shard >= 16 || row.workspaceId !== 'SYSTEM#INBOX_DIGEST' || row.recordKey !== `SHARD#${shard}` || row.shard !== shard || row.entryType !== 'inbox-digest-checkpoint' || row.schemaVersion !== 1 || !integer(row.revision) || row.revision < 1 || row.revision >= Number.MAX_SAFE_INTEGER || typeof row.token !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(row.token) || !integer(row.leaseUntil) || !integer(row.retryAt) || (row.cursor !== undefined && (typeof row.cursor !== 'string' || row.cursor.length > 4096 || !row.cursor)) || !Array.isArray(row.pending) || row.pending.length > 20) throw invalid()
  const pending: InboxDigestPending[] = row.pending.map((item: unknown) => {
    if (!record(item) || !record(item.recipient) || typeof item.recipient.workspaceId !== 'string' || !item.recipient.workspaceId || typeof item.recipient.memberKey !== 'string' || !item.recipient.memberKey || !integer(item.attempts) || item.attempts > 2) throw invalid()
    return { recipient: { workspaceId: item.recipient.workspaceId, memberKey: item.recipient.memberKey }, attempts: item.attempts }
  })
  if (new Set(pending.map((item) => JSON.stringify(item.recipient))).size !== pending.length) throw invalid()
  return { shard, revision: row.revision, token: row.token, leaseUntil: row.leaseUntil, retryAt: row.retryAt, pending, ...(typeof row.cursor === 'string' ? { cursor: row.cursor } : {}) }
}
/** Fixed noncanonical coordinates, never supplied by a tenant. */
function checkpointKey(shard: number) { return { workspaceId: 'SYSTEM#INBOX_DIGEST', recordKey: `SHARD#${shard}` } }
/** Binds terminal evidence to a recipient and UTC retry day. */
function failureKey(recipient: InboxDigestRecipient, now: number) { return { workspaceId: 'SYSTEM#INBOX_DIGEST', recordKey: `FAILURE#${createHash('sha256').update(JSON.stringify([recipient.workspaceId, recipient.memberKey, new Date(now).toISOString().slice(0, 10)])).digest('hex')}` } }
/** Narrows an untrusted DynamoDB map. */
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
/** Accepts nonnegative safe counters. */
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
/** Distinguishes a competing claim from infrastructure errors. */
function conditional(error: unknown) {
  return record(error) && error.name === 'TransactionCanceledException' && Array.isArray(error.CancellationReasons) && error.CancellationReasons.length === 1 && record(error.CancellationReasons[0]) && error.CancellationReasons[0].Code === 'ConditionalCheckFailed'
}
/** Creates a nonreflective checkpoint failure. */
function invalid() { return new Error('Invalid or expired Inbox digest checkpoint') }
