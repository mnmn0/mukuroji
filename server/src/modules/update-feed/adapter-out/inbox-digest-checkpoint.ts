import { createHash, randomUUID } from 'node:crypto'
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { InboxDigestCheckpoint, InboxDigestCheckpointStore, InboxDigestFailure, InboxDigestPending, InboxDigestSettlement } from '../application/inbox-digest-worker'
import { inboxDigestLogicalInterval, type InboxDigestCandidate, type InboxDigestRecipient, type InboxDigestRetry } from '../application/inbox-digest'
import { PlanningError } from '../../planning'
import { digestStorageFailure } from './digest-storage-failure'

/** Durable shard leases, pending pages and terminal failures in the existing Planning table. */
export class DynamoDbInboxDigestCheckpoints implements InboxDigestCheckpointStore {
  /** Existing table; checkpoint keys use a separate system partition. */ private readonly table: string
  /** Injected SDK client. */ private readonly client: DynamoDBDocumentClient
  /** Creates an inactive adapter.
   * @param table - Existing Planning table.
   * @param client - Composition-owned SDK client.
   */
  constructor(table: string, client: DynamoDBDocumentClient) { this.table = table; this.client = client }

  /** Reserves a fair start before any shard work; crashes cannot pin the next invocation.
   * @returns The prior rotation position, atomically advanced modulo sixteen.
   */
  async reserveStartShard(): Promise<number> {
    const key = { workspaceId: 'SYSTEM#INBOX_DIGEST', recordKey: 'ROTATION' }
    for (let attempt = 0; attempt < 3; attempt++) {
      const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true })).catch((error: unknown) => digestStorageFailure(error))
      if (Item !== undefined && (Item.workspaceId !== key.workspaceId || Item.recordKey !== key.recordKey || Item.entryType !== 'inbox-digest-rotation' || Item.schemaVersion !== 1 || !integer(Item.revision) || Item.revision < 1 || Item.revision >= Number.MAX_SAFE_INTEGER || !integer(Item.nextShard) || Item.nextShard >= 16)) throw corrupt()
      const first = Item?.nextShard ?? 0
      const revision = Item?.revision ?? 0
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: {
          TableName: this.table, Item: { ...key, entryType: 'inbox-digest-rotation', schemaVersion: 1, revision: revision + 1, nextShard: (first + 1) % 16 },
          ConditionExpression: revision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :revision AND entryType = :type AND schemaVersion = :schema',
          ...(revision === 0 ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': revision, ':type': 'inbox-digest-rotation', ':schema': 1 } }),
        } }] }))
        return first
      } catch (error) {
        if (!conditional(error)) return digestStorageFailure(error, 1)
      }
    }
    throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Inbox digest rotation is concurrently owned.')
  }

  /** Suppresses an exhausted recipient until the next UTC day, retaining recovery evidence.
   * @param recipient - Candidate from the strongly checked due row.
   * @param now - Trusted clock.
   * @param shard - Trusted source shard whose continuation is being processed.
   * @returns Whether today's terminal-failure row exists.
   */
  async isQuarantined(recipient: InboxDigestRecipient, now: number, shard: number): Promise<boolean> {
    if (!integer(shard) || shard > 15 || !integer(now) || now > 8_640_000_000_000_000) throw invalid()
    const key = failureKey(recipient, now)
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true })).catch((error: unknown) => digestStorageFailure(error))
    if (Item === undefined) return false
    try {
      const { failedAt } = parseFailureEvidence(Item, key, 'inbox-digest-failure', recipient, now, shard)
      if (failureKey(recipient, failedAt).recordKey !== key.recordKey) throw invalid()
      return true
    } catch { throw corrupt() }
  }

  /** Checks whether this logical admission stage already exhausted its worker budget.
   * @param candidate - Strongly checked source identity and receipt progress.
   * @param now - Trusted discovery clock for fresh candidates.
   * @param shard - Trusted source shard whose continuation is being processed.
   * @returns Whether operator recovery is required for this interval/progress stage.
   */
  async isExhausted(candidate: InboxDigestCandidate | InboxDigestRetry, now: number, shard: number): Promise<boolean> {
    if (!integer(shard) || shard > 15 || !integer(now) || now > 8_640_000_000_000_000) throw invalid()
    const key = exhaustionKey(candidate, 'scheduledAt' in candidate ? candidate.scheduledAt : now, candidate.receiptAttempts ?? 0)
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true })).catch((error: unknown) => digestStorageFailure(error))
    if (Item === undefined) return false
    try {
      const { work } = parseFailureEvidence(Item, key, 'inbox-digest-exhaustion', candidate, now, shard)
      if (exhaustionKey({ ...work.recipient, frequency: work.frequency }, work.scheduledAt, work.receiptAttempts ?? 0).recordKey !== key.recordKey) throw invalid()
      return true
    } catch { throw corrupt() }
  }

  /** Claims an idle/expired checkpoint using revision and lease conditions.
   * @param shard - Fixed queue shard.
   * @param now - Trusted clock.
   * @returns Owned checkpoint or undefined for a locked shard.
   */
  async claim(shard: number, now: number): Promise<InboxDigestCheckpoint | undefined> {
    if (!Number.isInteger(shard) || shard < 0 || shard >= 16 || !integer(now)) throw invalid()
    const key = checkpointKey(shard)
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true })).catch((error: unknown) => digestStorageFailure(error))
    const current = Item === undefined ? { shard, revision: 0, token: '', leaseUntil: 0, retryAt: 0, pending: [] } : storedCheckpoint(Item, shard)
    if (current.leaseUntil > now || current.retryAt > now) return undefined
    const result = { ...current, revision: current.revision + 1, token: randomUUID(), leaseUntil: now + 90_000 }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: this.table, Item: { ...key, entryType: 'inbox-digest-checkpoint', schemaVersion: 1, ...result },
        ConditionExpression: current.revision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :revision AND leaseUntil <= :now AND retryAt <= :now AND entryType = :type AND schemaVersion = :schema',
        ...(current.revision === 0 ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': current.revision, ':now': now, ':type': 'inbox-digest-checkpoint', ':schema': 1 } }),
      } }] }))
      return result
    } catch (error) { if (conditional(error)) return undefined; return digestStorageFailure(error, 1) }
  }

  /** Recovers parked logical work without resetting its infrastructure retry budget.
   * @param recipient - Strongly rechecked due owner.
   * @returns Durable parked work, or undefined when none exists.
   */
  async readDeferred(recipient: InboxDigestRecipient): Promise<InboxDigestPending | undefined> {
    const key = deferredKey(recipient)
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true })).catch((error: unknown) => digestStorageFailure(error))
    if (Item === undefined) return undefined
    try {
      const item = parsePending(Item.pending)
      if (Item.workspaceId !== key.workspaceId || Item.recordKey !== key.recordKey || Item.entryType !== 'inbox-digest-deferred' || Item.schemaVersion !== 1 || item.scheduledAt === undefined || item.recipient.workspaceId !== recipient.workspaceId || item.recipient.memberKey !== recipient.memberKey) throw invalid()
      return item
    } catch { throw corrupt() }
  }

  /** Saves progress and any exhausted recipient atomically under current ownership.
   * @param input - Owned checkpoint with desired pending work.
   * @param now - Trusted clock.
   * @param release - Whether to release the shard lease.
   * @param failure - Exhausted recipient retained for operator recovery.
   * @param settlement - Durable park or acknowledgment in the same checkpoint transaction.
   * @returns Committed checkpoint; lost acknowledgements resume from storage.
   */
  async save(input: InboxDigestCheckpoint, now: number, release: boolean, failure?: InboxDigestFailure, settlement?: InboxDigestSettlement): Promise<InboxDigestCheckpoint> {
    const key = checkpointKey(input.shard)
    const validated = parseCheckpoint({ ...key, entryType: 'inbox-digest-checkpoint', schemaVersion: 1, ...input }, input.shard)
    if (!integer(now) || validated.leaseUntil <= now) throw invalid()
    const failedWork = failure ? parsePending(failure.work) : undefined
    if (failure && (!failedWork?.frequency || failedWork.scheduledAt === undefined || failedWork.scheduledAt > now || !validFailureReason(failure.reason))) throw invalid()
    const evidence = failedWork && failure ? { work: failedWork, reason: failure.reason, workerAttempts: failedWork.attempts + 1, recipient: failedWork.recipient, shard: input.shard, failedAt: new Date(now).toISOString() } : undefined
    const failures = failedWork?.frequency && failedWork.scheduledAt !== undefined && evidence ? [
      { Put: { TableName: this.table, Item: { ...failureKey(failedWork.recipient, now), entryType: 'inbox-digest-failure', schemaVersion: 1, ...evidence, expiresAt: Math.floor(now / 1000) + 30 * 86_400 } } },
      { Put: { TableName: this.table, Item: { ...exhaustionKey({ ...failedWork.recipient, frequency: failedWork.frequency }, failedWork.scheduledAt, failedWork.receiptAttempts ?? 0), entryType: 'inbox-digest-exhaustion', schemaVersion: 1, ...evidence } } },
    ] : []
    const settled = settlement ? parsePending(settlement.item) : undefined
    if (settlement && (!settled || settled.scheduledAt === undefined || settled.scheduledAt > now || !['park', 'finish'].includes(settlement.kind))) throw invalid()
    const movement = settled && settlement ? settlement.kind === 'park' ? [{ Put: { TableName: this.table, Item: { ...deferredKey(settled.recipient), entryType: 'inbox-digest-deferred', schemaVersion: 1, pending: settled } } }] : [{ Delete: { TableName: this.table, Key: deferredKey(settled.recipient) } }] : []
    const result = { ...validated, revision: validated.revision + 1, leaseUntil: release ? 0 : validated.leaseUntil }
    await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: this.table,
      Item: { ...key, entryType: 'inbox-digest-checkpoint', schemaVersion: 1, ...result },
      ConditionExpression: '#revision = :revision AND #token = :token AND leaseUntil > :now AND entryType = :type AND schemaVersion = :schema',
      ExpressionAttributeNames: { '#revision': 'revision', '#token': 'token' },
      ExpressionAttributeValues: { ':revision': validated.revision, ':token': validated.token, ':now': now, ':type': 'inbox-digest-checkpoint', ':schema': 1 },
    } }, ...failures, ...movement] })).catch((error: unknown) => digestStorageFailure(error, 1 + failures.length + movement.length))
    return result
  }
}

/** Validates persisted scheduling state before it can select work. */
function parseCheckpoint(row: Record<string, unknown>, shard: number): InboxDigestCheckpoint {
  if (!Number.isInteger(shard) || shard < 0 || shard >= 16 || row.workspaceId !== 'SYSTEM#INBOX_DIGEST' || row.recordKey !== `SHARD#${shard}` || row.shard !== shard || row.entryType !== 'inbox-digest-checkpoint' || row.schemaVersion !== 1 || !integer(row.revision) || row.revision < 1 || row.revision >= Number.MAX_SAFE_INTEGER || typeof row.token !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(row.token) || !integer(row.leaseUntil) || !integer(row.retryAt) || (row.cursor !== undefined && (typeof row.cursor !== 'string' || row.cursor.length > 4096 || !row.cursor)) || !Array.isArray(row.pending) || row.pending.length > 20) throw invalid()
  const pending = row.pending.map(parsePending)
  if (new Set(pending.map((item) => JSON.stringify(item.recipient))).size !== pending.length) throw invalid()
  return { shard, revision: row.revision, token: row.token, leaseUntil: row.leaseUntil, retryAt: row.retryAt, pending, ...(typeof row.cursor === 'string' ? { cursor: row.cursor } : {}) }
}
/** Validates shared page/deferred metadata while retaining legacy checkpoint compatibility. */
function parsePending(item: unknown): InboxDigestPending {
  if (!record(item) || !record(item.recipient) || typeof item.recipient.workspaceId !== 'string' || !item.recipient.workspaceId || typeof item.recipient.memberKey !== 'string' || !item.recipient.memberKey || !integer(item.attempts) || item.attempts > 2 || (item.scheduledAt !== undefined && (!integer(item.scheduledAt) || item.scheduledAt > 8_640_000_000_000_000)) || (item.conflicts !== undefined && (!integer(item.conflicts) || item.conflicts > 2))) throw invalid()
  if (item.receiptAttempts !== undefined && (!integer(item.receiptAttempts) || item.receiptAttempts > 3)) throw invalid()
  if (item.frequency !== undefined && ((item.frequency !== 'daily' && item.frequency !== 'weekly') || item.scheduledAt === undefined)) throw invalid()
  return { recipient: { workspaceId: item.recipient.workspaceId, memberKey: item.recipient.memberKey }, attempts: item.attempts, ...(item.scheduledAt === undefined ? {} : { scheduledAt: item.scheduledAt }), ...(item.frequency === undefined ? {} : { frequency: item.frequency }), ...(item.conflicts === undefined ? {} : { conflicts: item.conflicts }), ...(item.receiptAttempts === undefined ? {} : { receiptAttempts: item.receiptAttempts }) }
}
/** Validates the complete bodyless recovery envelope shared by both terminal row kinds. */
function parseFailureEvidence(row: Record<string, unknown>, key: { /** Expected partition. */ workspaceId: string; /** Expected terminal key. */ recordKey: string }, kind: 'inbox-digest-failure' | 'inbox-digest-exhaustion', recipient: InboxDigestRecipient, now: number, shard: number) {
  const work = parsePending(row.work)
  const failedAt = typeof row.failedAt === 'string' ? Date.parse(row.failedAt) : NaN
  if (!work.frequency || work.scheduledAt === undefined || !integer(failedAt) || failedAt > now || new Date(failedAt).toISOString() !== row.failedAt || work.scheduledAt > failedAt || row.workspaceId !== key.workspaceId || row.recordKey !== key.recordKey || row.entryType !== kind || row.schemaVersion !== 1 || row.shard !== shard || !record(row.recipient) || row.recipient.workspaceId !== recipient.workspaceId || row.recipient.memberKey !== recipient.memberKey || work.recipient.workspaceId !== recipient.workspaceId || work.recipient.memberKey !== recipient.memberKey || !validFailureReason(row.reason) || row.workerAttempts !== work.attempts + 1) throw invalid()
  if (kind === 'inbox-digest-failure' ? row.expiresAt !== Math.floor(failedAt / 1000) + 30 * 86_400 : row.expiresAt !== undefined) throw invalid()
  return { work: { ...work, frequency: work.frequency, scheduledAt: work.scheduledAt }, failedAt }
}
/** Binds terminal budgets to canonical identity and a bounded, strongly read receipt stage. */
function exhaustionKey(candidate: InboxDigestCandidate, scheduledAt: number, progress: number) {
  if (!integer(progress) || progress > 3) throw invalid()
  return { workspaceId: 'SYSTEM#INBOX_DIGEST', recordKey: `EXHAUSTED#${createHash('sha256').update(JSON.stringify([candidate.workspaceId, candidate.memberKey, inboxDigestLogicalInterval(candidate.frequency, scheduledAt), progress])).digest('hex')}` }
}
/** Accepts only stable recovery categories, never reflected exception messages. */
function validFailureReason(value: unknown): boolean { return typeof value === 'string' && ['retry-exhausted', 'exhausted', 'corrupt-state', 'storage-permanent', 'recipient-mismatch', 'invalid-input'].includes(value) }
/** Binds parked logical work to one server-resolved owner without a lossy TTL. */
function deferredKey(recipient: InboxDigestRecipient) { return { workspaceId: 'SYSTEM#INBOX_DIGEST', recordKey: `DEFERRED#${createHash('sha256').update(JSON.stringify([recipient.workspaceId, recipient.memberKey])).digest('hex')}` } }
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
function invalid() { return new PlanningError(400, 'UpdateFeedDigestInvalid', 'Invalid or expired Inbox digest checkpoint') }
/** Classifies only persisted parsing failures as corruption, never SDK exceptions. */
function storedCheckpoint(row: Record<string, unknown>, shard: number) {
  try { return parseCheckpoint(row, shard) } catch { throw corrupt() }
}
/** Produces a bodyless persisted-state error for invocation-level recovery. */
function corrupt() { return new PlanningError(502, 'UpdateFeedDigestCorruptState', 'Inbox digest checkpoint metadata is unavailable.') }
