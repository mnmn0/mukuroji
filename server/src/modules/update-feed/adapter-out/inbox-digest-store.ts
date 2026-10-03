import { createHash } from 'node:crypto'
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { UpdateFeedDigestState } from '@mukuroji/contracts'
import { PlanningError, type PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { createNotificationRecipientKey, NOTIFICATION_PREFERENCES_KEY, parseStoredNotificationPreferences } from '../../notifications'
import { emptyDigestState, parseDigestState } from '../application/digest'
import { inboxDigestInterval, type InboxDigestMessage, type InboxDigestRecipient, type InboxDigestStore } from '../application/inbox-digest'
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
    const { Item } = await this.client.send(new GetCommand({ TableName: this.planningTable, Key: key(recipient), ConsistentRead: true }))
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
    const id = inboxDigestInterval(state, this.now())
    const before = current.history.find((row) => row.id === id)
    const after = state.history.find((row) => row.id === id)
    if (!Number.isSafeInteger(planningRevision) || planningRevision < 0 || current.revision !== state.revision || !current.preferences.enabled || !before || before.status !== 'pending' || before.leaseUntil <= this.now() || !after || after.status !== 'completed' || after.token !== before.token || after.attempts !== before.attempts || after.leaseUntil !== 0 || JSON.stringify(current.preferences) !== JSON.stringify(state.preferences) || JSON.stringify(state.history) !== JSON.stringify(current.history.map((row) => row.id === id ? after : row))) throw conflict()
    const expectedMessage = { id: `update-feed-digest:${id}`, occurredAt: `${id.slice(id.indexOf(':') + 1)}T00:00:00.000Z`, deepLink: '/updates' }
    if ((after.count === 0) !== (message === undefined) || (message && (message.id !== expectedMessage.id || message.occurredAt !== expectedMessage.occurredAt || message.deepLink !== '/updates'))) throw conflict()
    const recipientKey = createNotificationRecipientKey(recipient.workspaceId, recipient.memberKey)
    const preferenceKey = { recipientKey, notificationKey: NOTIFICATION_PREFERENCES_KEY }
    const { Item: preferencesRow } = await this.client.send(new GetCommand({ TableName: this.notificationsTable, Key: preferenceKey, ConsistentRead: true }))
    if (preferencesRow && (preferencesRow.recipientKey !== recipientKey || preferencesRow.notificationKey !== NOTIFICATION_PREFERENCES_KEY)) throw conflict()
    const preferences = parseStoredNotificationPreferences(preferencesRow, true)
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
    }))
    const recipients: InboxDigestRecipient[] = []
    for (const item of page.Items ?? []) {
      if (typeof item.workspaceId !== 'string' || typeof item.recordKey !== 'string') throw conflict()
      const { Item: row } = await this.client.send(new GetCommand({ TableName: this.planningTable, Key: { workspaceId: item.workspaceId, recordKey: item.recordKey }, ConsistentRead: true }))
      if (!row) continue
      if (typeof row.memberKey !== 'string') throw conflict()
      const recipient = normalize({ workspaceId: item.workspaceId, memberKey: row.memberKey })
      const state = parseRow(row, recipient)
      if (row.recordKey !== item.recordKey) throw conflict()
      if (state.preferences.enabled && row.inboxDigestShard === `inbox-digest#${shard}` && typeof row.inboxDigestDueAt === 'number' && row.inboxDigestDueAt <= now) recipients.push(recipient)
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
    catch (error) {
      if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'TransactionCanceledException' && 'CancellationReasons' in error && Array.isArray(error.CancellationReasons)) {
        const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined)
        if (codes.length === items.length && codes.includes('ConditionalCheckFailed') && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) throw conflict()
      }
      throw new PlanningError(503, 'InboxDigestStorageFailure', 'Inbox digest persistence failed.')
    }
    return result
  }
}

/** Validates current metadata and its server-derived recipient key. */
function parseRow(row: Record<string, unknown>, recipient: InboxDigestRecipient): UpdateFeedDigestState {
  if (row.workspaceId !== recipient.workspaceId || row.recordKey !== key(recipient).recordKey || row.memberKey !== recipient.memberKey || row.entryType !== 'update-feed-inbox-digest' || row.schemaVersion !== 1 || typeof row.revision !== 'number' || row.revision < 1) throw conflict()
  const state = parseDigestState(row)
  if (state.preferences.enabled && (row.inboxDigestShard !== shardKey(recipient) || typeof row.inboxDigestDueAt !== 'number' || !Number.isSafeInteger(row.inboxDigestDueAt) || row.inboxDigestDueAt < 0)) throw conflict()
  return state
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
  const due = receipt?.status === 'completed' || (receipt?.attempts ?? 0) >= 3 ? next : receipt?.status === 'pending' ? receipt.leaseUntil : receipt?.status === 'failed' ? now + 60_000 : now
  return { inboxDigestShard: shardKey(recipient), inboxDigestDueAt: due }
}
/** Stable sparse-index shard bound to both Workspace and member. */
function shardKey(recipient: InboxDigestRecipient) { return `inbox-digest#${createHash('sha256').update(JSON.stringify(recipient)).digest()[0]! % 16}` }
/** Returns a safe CAS/authorization failure. */
function conflict() { return new PlanningError(409, 'UpdateFeedDigestConflict', 'Digest state or authorization changed.') }
