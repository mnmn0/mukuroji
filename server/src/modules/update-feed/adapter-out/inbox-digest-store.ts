import { createHash } from 'node:crypto'
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { UpdateFeedDigestState } from '@mukuroji/contracts'
import { PlanningError, type PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { digestStorageFailure } from './digest-storage-failure'
import { createNotificationRecipientKey, NOTIFICATION_PREFERENCES_KEY, parseStoredNotificationPreferences } from '../../notifications'
import { emptyDigestState, parseDigestState } from '../application/digest'
import { inboxDigestInterval, type InboxDigestCandidate, type InboxDigestMessage, type InboxDigestRecipient, type InboxDigestRetry, type InboxDigestStore } from '../application/inbox-digest'
import { createInboxDigestNotification } from './inbox-digest-notification'

/** Undeployed sparse GSI schema; activation requires separate infrastructure review. */
export const INBOX_DIGEST_INDEX = { name: 'InboxDigestDueIndex', partitionKey: 'inboxDigestShard', sortKey: 'inboxDigestDueAt', shards: 16 } as const

/** Durable delivery-only metadata and atomic Inbox completion. */
export class DynamoDbInboxDigestStore implements InboxDigestStore {
  /** Existing Planning table. */
  private readonly planningTable: string
  /** Existing Notifications table. */
  private readonly notificationsTable: string
  /** Injected SDK transport. */
  private readonly client: DynamoDBDocumentClient
  /** Fresh recipient membership/Enterprise transaction guards. */
  private readonly checks: readonly PlanningCallerAuthorizationConditionCheck[]
  /** Server clock used for due keys and lease expiry. */
  private readonly now: () => number
  /** Recipient language; no body is persisted. */
  private readonly locale: 'ja' | 'en'

  /** Constructs an inactive adapter; construction performs no I/O.
   * @param planningTable - Existing Planning table.
   * @param notificationsTable - Existing Inbox table.
   * @param client - Injected SDK client.
   * @param checks - Current server-resolved member/Enterprise guards.
   * @param now - Trusted clock.
   * @param locale - Current recipient language.
   */
  constructor(planningTable: string, notificationsTable: string, client: DynamoDBDocumentClient, checks: readonly PlanningCallerAuthorizationConditionCheck[] = [], now: () => number = Date.now, locale: 'ja' | 'en' = 'ja') {
    this.planningTable = planningTable; this.notificationsTable = notificationsTable; this.client = client
    this.checks = structuredClone(checks); this.now = now; this.locale = locale
  }

  /** Binds fresh server-side guards; a missing binding cannot write.
   * @param checks - Current recipient authorization checks.
   * @param locale - Recipient language.
   * @returns An isolated binding to the delivery collection.
   */
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[], locale: 'ja' | 'en' = this.locale): DynamoDbInboxDigestStore {
    return new DynamoDbInboxDigestStore(this.planningTable, this.notificationsTable, this.client, checks, this.now, locale)
  }

  /** Reads one strongly consistent delivery row, never the manual preview collection.
   * @param workspaceId - Authenticated Workspace.
   * @param memberKey - Authenticated normalized member.
   * @returns Validated state, disabled when absent.
   */
  async get(workspaceId: string, memberKey: string): Promise<UpdateFeedDigestState> {
    const recipient = normalize({ workspaceId, memberKey })
    const { Item } = await this.client.send(new GetCommand({ TableName: this.planningTable, Key: key(recipient), ConsistentRead: true })).catch((error: unknown) => digestStorageFailure(error))
    return Item === undefined ? emptyDigestState() : parseRow(Item, recipient)
  }

  /** Changes settings/claims/failures using CAS and current recipient guards.
   * @param workspaceId - Authenticated Workspace.
   * @param memberKey - Authenticated member.
   * @param input - Observed state and requested replacement.
   * @returns Committed state; completion is only permitted through complete().
   */
  async replace(workspaceId: string, memberKey: string, input: UpdateFeedDigestState): Promise<UpdateFeedDigestState> {
    const recipient = normalize({ workspaceId, memberKey })
    const current = await this.get(workspaceId, memberKey)
    const next = parseDigestState(input)
    if (next.revision !== current.revision || next.history.some((receipt) => receipt.status === 'completed' && !current.history.some((old) => JSON.stringify(old) === JSON.stringify(receipt)))) throw conflict()
    return this.write(recipient, next, [])
  }

  /** Atomically inserts a deterministic Inbox row with the fenced completion receipt.
   * @param owner - Server-resolved recipient.
   * @param input - Desired completion at the claimed revision.
   * @param planningRevision - Captured content authorization fence.
   * @param message - Bodyless Inbox link; absent only for an empty result.
   * @returns Committed state; lost responses are recovered through get().
   */
  async complete(owner: InboxDigestRecipient, input: UpdateFeedDigestState, planningRevision: number, message: InboxDigestMessage | undefined): Promise<UpdateFeedDigestState> {
    const recipient = normalize(owner)
    const state = parseDigestState(input)
    const current = await this.get(recipient.workspaceId, recipient.memberKey)
    // Completion belongs to the single claimed transition, even if generation
    // crosses UTC midnight or Monday before its lease expires.
    const changed = state.history.filter((row, index) => JSON.stringify(row) !== JSON.stringify(current.history[index]))
    const candidate = changed.length === 1 ? changed[0] : undefined
    if (!candidate || !candidate.id.startsWith(`${state.preferences.frequency}:`)) throw conflict()
    const id = candidate.id
    const before = current.history.find((row) => row.id === id)
    const after = state.history.find((row) => row.id === id)
    if (!Number.isSafeInteger(planningRevision) || planningRevision < 0 || current.revision !== state.revision || !current.preferences.enabled || !before || before.status !== 'pending' || before.leaseUntil <= this.now() || !after || after.status !== 'completed' || after.token !== before.token || after.attempts !== before.attempts || after.leaseUntil !== 0 || JSON.stringify(current.preferences) !== JSON.stringify(state.preferences) || JSON.stringify(state.history) !== JSON.stringify(current.history.map((row) => row.id === id ? after : row))) throw conflict()
    if (after.startedAt !== before.startedAt) throw conflict()
    const startedAt = before.startedAt ?? before.leaseUntil - 60_000
    // Logical interval may precede the first successful claim after an outage.
    // Its validated, unchanged receipt ID must never be later than the claim.
    if (startedAt < 0 || startedAt > before.leaseUntil - 60_000 || Date.parse(`${id.slice(id.indexOf(':') + 1)}T00:00:00.000Z`) > startedAt) throw conflict()
    const expectedMessage = { id: `update-feed-digest:${id}`, occurredAt: new Date(startedAt).toISOString(), deepLink: '/updates' }
    if ((after.count === 0) !== (message === undefined) || (message && (message.id !== expectedMessage.id || message.occurredAt !== expectedMessage.occurredAt || message.deepLink !== '/updates'))) throw conflict()
    const recipientKey = createNotificationRecipientKey(recipient.workspaceId, recipient.memberKey)
    const preferenceKey = { recipientKey, notificationKey: NOTIFICATION_PREFERENCES_KEY }
    const { Item: preferencesRow } = await this.client.send(new GetCommand({ TableName: this.notificationsTable, Key: preferenceKey, ConsistentRead: true })).catch((error: unknown) => digestStorageFailure(error))
    const preferences = notificationPreferences(preferencesRow, recipientKey)
    if (!preferences.channels.inApp) throw conflict()
    const guards: PlanningCallerAuthorizationConditionCheck[] = [
      { ConditionCheck: { TableName: this.planningTable, Key: { workspaceId: `FENCE#${recipient.workspaceId}`, recordKey: 'META' },
        ConditionExpression: planningRevision === 0 ? 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' : '#type = :type AND #schema = :schema AND #revision = :revision',
        ...(planningRevision === 0 ? {} : { ExpressionAttributeNames: { '#type': 'entryType', '#schema': 'schemaVersion', '#revision': 'revision' }, ExpressionAttributeValues: { ':type': 'planning-meta', ':schema': 1, ':revision': planningRevision } }),
      } },
      { ConditionCheck: { TableName: this.notificationsTable, Key: preferenceKey,
        ConditionExpression: preferencesRow === undefined ? 'attribute_not_exists(recipientKey) AND attribute_not_exists(notificationKey)' : '#type = :type AND #version = :version AND #channels.#inApp = :enabled',
        ...(preferencesRow === undefined ? {} : { ExpressionAttributeNames: { '#type': 'itemType', '#version': 'version', '#channels': 'channels', '#inApp': 'inApp' }, ExpressionAttributeValues: { ':type': 'preferences', ':version': preferences.version, ':enabled': true } }),
      } },
    ]
    return this.write(recipient, state, guards, message, before.leaseUntil)
  }

  /** Queries one bounded sparse-index page and strongly rechecks every candidate.
   * @param shard - One of sixteen deterministic partitions.
   * @param limit - Maximum inspected index rows, 1–100.
   * @param cursor - SDK key from the prior internal page; never an HTTP input.
   * @returns Current due recipients and explicit continuation.
   */
  async listDue(shard: number, limit = 100, cursor?: Record<string, unknown>) {
    if (!Number.isInteger(shard) || shard < 0 || shard >= 16 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw conflict()
    const now = this.now()
    const page = await this.client.send(new QueryCommand({ TableName: this.planningTable, IndexName: INBOX_DIGEST_INDEX.name,
      KeyConditionExpression: '#shard = :shard AND #due <= :due', ExpressionAttributeNames: { '#shard': INBOX_DIGEST_INDEX.partitionKey, '#due': INBOX_DIGEST_INDEX.sortKey },
      ExpressionAttributeValues: { ':shard': `inbox-digest#${shard}`, ':due': now }, Limit: limit, ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    })).catch((error: unknown) => digestStorageFailure(error))
    const recipients: (InboxDigestCandidate | InboxDigestRetry)[] = []
    for (const item of page.Items ?? []) {
      if (typeof item.workspaceId !== 'string' || !item.workspaceId.trim() || typeof item.recordKey !== 'string' || !item.recordKey.startsWith('UPDATE_FEED_INBOX_DIGEST#')) throw corruptCandidate()
      const { Item: row } = await this.client.send(new GetCommand({ TableName: this.planningTable, Key: { workspaceId: item.workspaceId, recordKey: item.recordKey }, ConsistentRead: true })).catch((error: unknown) => digestStorageFailure(error))
      if (!row) continue
      if (typeof row.memberKey !== 'string' || !row.memberKey.trim()) throw corruptCandidate()
      const recipient = normalize({ workspaceId: item.workspaceId, memberKey: row.memberKey })
      const state = parseRow(row, recipient)
      if (row.recordKey !== item.recordKey) throw corruptCandidate()
      if (state.preferences.enabled && row.inboxDigestShard === `inbox-digest#${shard}` && typeof row.inboxDigestDueAt === 'number' && row.inboxDigestDueAt <= now) {
        const retry = retryableReceipt(state)
        recipients.push({ ...recipient, frequency: state.preferences.frequency, ...(retry ? { scheduledAt: Date.parse(`${retry.id.slice(retry.id.indexOf(':') + 1)}T00:00:00.000Z`), receiptAttempts: retry.attempts } : {}) })
      }
    }
    return { recipients, cursor: page.LastEvaluatedKey }
  }

  /** Writes only delivery metadata and optional Inbox row under one transaction. */
  private async write(recipient: InboxDigestRecipient, state: UpdateFeedDigestState, guards: readonly PlanningCallerAuthorizationConditionCheck[], message?: InboxDigestMessage, leaseUntil?: number): Promise<UpdateFeedDigestState> {
    if (this.checks.length === 0) throw new PlanningError(503, 'UpdateFeedDigestAuthorizationUnavailable', 'Recipient authorization is unavailable.')
    if (leaseUntil !== undefined && leaseUntil <= this.now()) throw conflict()
    const result = { ...state, revision: state.revision + 1 }
    const items = [{ Put: { TableName: this.planningTable,
      Item: { ...key(recipient), memberKey: recipient.memberKey, entryType: 'update-feed-inbox-digest', schemaVersion: 1, ...result, ...dueFields(recipient, result, this.now()) },
      ConditionExpression: state.revision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :revision AND #type = :type AND #schema = :schema',
      ...(state.revision === 0 ? {} : { ExpressionAttributeNames: { '#revision': 'revision', '#type': 'entryType', '#schema': 'schemaVersion' }, ExpressionAttributeValues: { ':revision': state.revision, ':type': 'update-feed-inbox-digest', ':schema': 1 } }),
    } }, ...this.checks, ...guards, ...(message ? [{ Put: { TableName: this.notificationsTable, Item: createInboxDigestNotification(recipient, message, this.locale), ConditionExpression: 'attribute_not_exists(recipientKey) AND attribute_not_exists(notificationKey)' } }] : [])]
    try { await this.client.send(new TransactWriteCommand({ TransactItems: items })) }
    catch (error) { return digestStorageFailure(error, items.length) }
    return result
  }
}

/** Validates stored notification consent independently of SDK and explicit opt-out failures. */
function notificationPreferences(row: Record<string, unknown> | undefined, recipientKey: string) {
  try {
    if (row && (row.recipientKey !== recipientKey || row.notificationKey !== NOTIFICATION_PREFERENCES_KEY)) throw new Error('Invalid preference owner')
    return parseStoredNotificationPreferences(row, true)
  } catch { throw new PlanningError(502, 'UpdateFeedDigestCorruptState', 'Notification preferences are invalid.') }
}

/** Validates current metadata and its server-derived recipient key. */
function parseRow(row: Record<string, unknown>, recipient: InboxDigestRecipient): UpdateFeedDigestState {
  try {
    if (row.workspaceId !== recipient.workspaceId || row.recordKey !== key(recipient).recordKey || row.memberKey !== recipient.memberKey || row.entryType !== 'update-feed-inbox-digest' || row.schemaVersion !== 1 || typeof row.revision !== 'number' || row.revision < 1) throw new Error('Invalid envelope')
    const state = parseDigestState(row)
    if (state.preferences.enabled && (row.inboxDigestShard !== shardKey(recipient) || typeof row.inboxDigestDueAt !== 'number' || !Number.isSafeInteger(row.inboxDigestDueAt) || row.inboxDigestDueAt < 0)) throw new Error('Invalid due metadata')
    if (!state.preferences.enabled && (row.inboxDigestShard !== undefined || row.inboxDigestDueAt !== undefined)) throw new Error('Unexpected due metadata')
    return state
  } catch { throw new PlanningError(502, 'UpdateFeedDigestCorruptState', 'Inbox digest metadata is unavailable.') }
}
/** Normalizes server identities before deriving storage coordinates. */
function normalize(recipient: InboxDigestRecipient): InboxDigestRecipient {
  if (!recipient.workspaceId.trim() || !recipient.memberKey.trim()) throw conflict()
  return { workspaceId: recipient.workspaceId, memberKey: recipient.memberKey.trim().toLowerCase() }
}
/** Separates delivery metadata from the manual preview namespace. */
function key(recipient: InboxDigestRecipient) { return { workspaceId: recipient.workspaceId, recordKey: `UPDATE_FEED_INBOX_DIGEST#${createHash('sha256').update(recipient.memberKey).digest('hex')}` } }
/** Computes a sparse due entry, removing it entirely when delivery is disabled. */
function dueFields(recipient: InboxDigestRecipient, state: UpdateFeedDigestState, now: number) {
  if (!state.preferences.enabled) return {}
  const id = inboxDigestInterval(state, now)
  const receipt = state.history.find((item) => item.id === id)
  const start = Date.parse(`${id.slice(id.indexOf(':') + 1)}T00:00:00.000Z`)
  const next = start + (state.preferences.frequency === 'daily' ? 1 : 7) * 86_400_000
  const pending = state.history.filter((item) => item.status === 'pending')
  const due = pending.length ? Math.min(...pending.map((item) => item.leaseUntil)) : retryableReceipt(state) ? now + 60_000 : receipt?.status === 'completed' || (receipt?.attempts ?? 0) >= 3 ? next : now
  return { inboxDigestShard: shardKey(recipient), inboxDigestDueAt: due }
}
/** Selects the oldest unfinished interval under current cadence, never an exhausted receipt. */
function retryableReceipt(state: UpdateFeedDigestState) {
  return state.history.filter((item) => item.id.startsWith(`${state.preferences.frequency}:`) && item.status !== 'completed' && item.attempts < 3).sort((a, b) => a.id.localeCompare(b.id))[0]
}
/** Stable sparse-index shard bound to both Workspace and member. */
function shardKey(recipient: InboxDigestRecipient) { return `inbox-digest#${createHash('sha256').update(JSON.stringify(recipient)).digest()[0]! % 16}` }
/** Returns a safe CAS/authorization failure. */
function conflict() { return new PlanningError(409, 'UpdateFeedDigestConflict', 'Digest state or authorization changed.') }
/** Rejects malformed persisted candidate coordinates without exposing their values. */
function corruptCandidate() { return new PlanningError(502, 'UpdateFeedDigestCorruptState', 'Inbox digest candidate metadata is unavailable.') }
