import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createHash } from 'node:crypto'
import type { UpdateFeedDigestState } from '@mukuroji/contracts'
import { PlanningError, type PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { parseDigestState, emptyDigestState, type UpdateFeedDigestStore } from '../application/digest'

/** Composition-only binding for fresh caller authorization conditions. */
export interface UpdateFeedDigestPersistence extends UpdateFeedDigestStore {
  /** Creates a request-local write binding.
   * @param checks - Server-built current member/Enterprise conditions.
   * @returns Bound application persistence port.
   */
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[]): UpdateFeedDigestStore
}

/** Single-row bounded digest metadata in the existing Planning table. */
export class DynamoDbUpdateFeedDigestStore implements UpdateFeedDigestPersistence {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected document client. */
  private readonly client: DynamoDBDocumentClient
  /** Current immutable caller guards. */
  private readonly checks: readonly PlanningCallerAuthorizationConditionCheck[]
  /** Constructs an adapter without provisioning or touching report content.
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   * @param checks - Optional request-local caller conditions.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, checks: readonly PlanningCallerAuthorizationConditionCheck[] = []) { this.tableName = tableName; this.client = client; this.checks = structuredClone(checks) }
  /** Binds immutable current caller guards.
   * @param checks - Server-built authorization conditions.
   * @returns Request-local write port.
   */
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[]): UpdateFeedDigestStore { return new DynamoDbUpdateFeedDigestStore(this.tableName, this.client, checks) }
  /** Reads one exact strongly consistent personal collection.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member identity.
   * @returns Validated digest metadata or empty revision zero.
   */
  async get(workspaceId: string, memberKey: string): Promise<UpdateFeedDigestState> {
    try {
      const key = recordKey(memberKey)
      const { Item: row } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true }))
      if (row === undefined) return emptyDigestState()
      if (row.workspaceId !== workspaceId || row.recordKey !== key || row.schemaVersion !== 1 || row.entryType !== 'update-feed-digest' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid saved digest metadata')
      return parseDigestState({ revision: row.revision, preferences: row.preferences, history: row.history })
    } catch (error) { return storageFailure(error) }
  }
  /** Atomically replaces digest metadata with CAS and current caller checks.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member identity.
   * @param input - Desired digest metadata and observed revision.
   * @param planningRevision - Optional content authorization fence.
   * @returns Committed bounded collection.
   */
  async replace(workspaceId: string, memberKey: string, input: UpdateFeedDigestState, planningRevision?: number): Promise<UpdateFeedDigestState> {
    const parsed = parseDigestState(input)
    if (this.checks.length === 0) throw new PlanningError(503, 'UpdateFeedDigestAuthorizationUnavailable', 'Caller authorization is unavailable.')
    const result = { ...parsed, revision: parsed.revision + 1 }
    const fence: PlanningCallerAuthorizationConditionCheck[] = planningRevision === undefined ? [] : [{ ConditionCheck: {
      TableName: this.tableName, Key: { workspaceId: `FENCE#${workspaceId}`, recordKey: 'META' },
      ConditionExpression: planningRevision === 0
        ? 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)'
        : '#entryType = :entryType AND #schemaVersion = :schemaVersion AND #revision = :revision',
      ...(planningRevision === 0 ? {} : {
        ExpressionAttributeNames: { '#entryType': 'entryType', '#schemaVersion': 'schemaVersion', '#revision': 'revision' },
        ExpressionAttributeValues: { ':entryType': 'planning-meta', ':schemaVersion': 1, ':revision': planningRevision },
      }),
    } }]
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: {
        TableName: this.tableName, Item: { workspaceId, recordKey: recordKey(memberKey), entryType: 'update-feed-digest', schemaVersion: 1, ...result },
        ConditionExpression: parsed.revision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :revision AND #schema = :schema AND #type = :type',
        ...(parsed.revision === 0 ? {} : { ExpressionAttributeNames: { '#revision': 'revision', '#schema': 'schemaVersion', '#type': 'entryType' }, ExpressionAttributeValues: { ':revision': parsed.revision, ':schema': 1, ':type': 'update-feed-digest' } }),
      } }, ...this.checks, ...fence] }))
    } catch (error) { return storageFailure(error, this.checks.length + fence.length + 1) }
    return result
  }
}

/** Isolated CAS store for application and route tests. */
export class InMemoryUpdateFeedDigestStore implements UpdateFeedDigestPersistence {
  /** Workspace/member scoped collections. */
  private readonly collections = new Map<string, UpdateFeedDigestState>()
  /** Preserves the isolated test store; SDK tests verify conditions.
   * @param _checks - Current caller guards.
   * @returns Isolated application port.
   */
  withCallerAuthorization(_checks: readonly PlanningCallerAuthorizationConditionCheck[]): UpdateFeedDigestStore { return this }
  /** Reads a copy of one personal collection.
   * @param workspaceId - Test Workspace.
   * @param memberKey - Test member.
   * @returns Owned digest metadata only.
   */
  async get(workspaceId: string, memberKey: string): Promise<UpdateFeedDigestState> { return structuredClone(this.collections.get(JSON.stringify([workspaceId, recordKey(memberKey)])) ?? emptyDigestState()) }
  /** Replaces digest metadata with optimistic concurrency.
   * @param workspaceId - Test Workspace.
   * @param memberKey - Test member.
   * @param input - Desired state.
   * @returns Committed copy.
   */
  async replace(workspaceId: string, memberKey: string, input: UpdateFeedDigestState): Promise<UpdateFeedDigestState> {
    const parsed = parseDigestState(input)
    const key = JSON.stringify([workspaceId, recordKey(memberKey)])
    if ((this.collections.get(key)?.revision ?? 0) !== parsed.revision) throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Digest state changed. Reload before saving.')
    const result = { ...parsed, revision: parsed.revision + 1 }
    this.collections.set(key, structuredClone(result))
    return result
  }
}

/** Derives a member-specific noncanonical key with no user-supplied physical key. */
function recordKey(memberKey: string) { return `UPDATE_FEED_DIGEST#${createHash('sha256').update(memberKey.trim().toLowerCase()).digest('hex')}` }
/** Classifies full transaction reason vectors and rejects malformed persistence. */
function storageFailure(error: unknown, size = 0): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (name === 'TransactionCanceledException' && typeof error === 'object' && error !== null && 'CancellationReasons' in error && Array.isArray(error.CancellationReasons)) {
    const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined)
    if (size > 0 && codes.length === size) {
      if (codes.includes('ConditionalCheckFailed') && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Digest state or permissions changed. Reload before saving.')
      const transient = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']
      if (codes.some((code) => transient.includes(String(code))) && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed' || transient.includes(String(code)))) throw new PlanningError(503, 'UpdateFeedDigestRetryable', 'Digest storage is temporarily unavailable.')
    }
  }
  if (typeof name === 'string' && ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)) throw new PlanningError(503, 'UpdateFeedDigestRetryable', 'Digest storage is temporarily unavailable.')
  throw new PlanningError(502, 'UpdateFeedDigestStorageFailure', 'Digest storage request failed.')
}
