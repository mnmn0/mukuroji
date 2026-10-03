import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createHash } from 'node:crypto'
import type { ReplaceSavedUpdateFeedsInput, SavedUpdateFeeds } from '@mukuroji/contracts'
import { PlanningError, type PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { parseSavedUpdateFeeds, type SavedUpdateFeedsStore } from '../application/saved-feeds'

/** Composition-only binding for fresh caller authorization conditions. */
export interface SavedUpdateFeedsPersistence extends SavedUpdateFeedsStore {
  /** Creates a request-local write binding.
   * @param checks - Server-built current member/Enterprise conditions.
   * @returns Bound application persistence port.
   */
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[]): SavedUpdateFeedsStore
}

/** Single-row bounded personal definitions in the existing Planning table. */
export class DynamoDbSavedUpdateFeedsStore implements SavedUpdateFeedsPersistence {
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
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[]): SavedUpdateFeedsStore { return new DynamoDbSavedUpdateFeedsStore(this.tableName, this.client, checks) }
  /** Reads one exact strongly consistent personal collection.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member identity.
   * @returns Validated definitions or empty revision zero.
   */
  async get(workspaceId: string, memberKey: string): Promise<SavedUpdateFeeds> {
    try {
      const key = recordKey(memberKey)
      const { Item: row } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true }))
      if (row === undefined) return { revision: 0, feeds: [] }
      if (row.workspaceId !== workspaceId || row.recordKey !== key || row.schemaVersion !== 1 || row.entryType !== 'update-feed-definitions' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid saved definitions')
      const parsed = parseSavedUpdateFeeds({ expectedRevision: 0, feeds: row.feeds })
      return { revision: row.revision, feeds: parsed.feeds }
    } catch (error) { return storageFailure(error) }
  }
  /** Atomically replaces personal definitions with CAS and current caller checks.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member identity.
   * @param input - Desired definitions and observed revision.
   * @returns Committed bounded collection.
   */
  async replace(workspaceId: string, memberKey: string, input: ReplaceSavedUpdateFeedsInput): Promise<SavedUpdateFeeds> {
    const parsed = parseSavedUpdateFeeds(input)
    if (this.checks.length === 0) throw new PlanningError(503, 'SavedUpdateFeedsAuthorizationUnavailable', 'Caller authorization is unavailable.')
    const result = { revision: parsed.expectedRevision + 1, feeds: parsed.feeds }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [{ Put: {
        TableName: this.tableName, Item: { workspaceId, recordKey: recordKey(memberKey), entryType: 'update-feed-definitions', schemaVersion: 1, ...result },
        ConditionExpression: parsed.expectedRevision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :revision AND #schema = :schema AND #type = :type',
        ...(parsed.expectedRevision === 0 ? {} : { ExpressionAttributeNames: { '#revision': 'revision', '#schema': 'schemaVersion', '#type': 'entryType' }, ExpressionAttributeValues: { ':revision': parsed.expectedRevision, ':schema': 1, ':type': 'update-feed-definitions' } }),
      } }, ...this.checks] }))
    } catch (error) { return storageFailure(error, this.checks.length + 1) }
    return result
  }
}

/** Isolated CAS store for application and route tests. */
export class InMemorySavedUpdateFeedsStore implements SavedUpdateFeedsPersistence {
  /** Workspace/member scoped collections. */
  private readonly collections = new Map<string, SavedUpdateFeeds>()
  /** Preserves the isolated test store; SDK tests verify conditions.
   * @param _checks - Current caller guards.
   * @returns Isolated application port.
   */
  withCallerAuthorization(_checks: readonly PlanningCallerAuthorizationConditionCheck[]): SavedUpdateFeedsStore { return this }
  /** Reads a copy of one personal collection.
   * @param workspaceId - Test Workspace.
   * @param memberKey - Test member.
   * @returns Owned definitions only.
   */
  async get(workspaceId: string, memberKey: string): Promise<SavedUpdateFeeds> { return structuredClone(this.collections.get(JSON.stringify([workspaceId, recordKey(memberKey)])) ?? { revision: 0, feeds: [] }) }
  /** Replaces definitions with optimistic concurrency.
   * @param workspaceId - Test Workspace.
   * @param memberKey - Test member.
   * @param input - Desired collection.
   * @returns Committed copy.
   */
  async replace(workspaceId: string, memberKey: string, input: ReplaceSavedUpdateFeedsInput): Promise<SavedUpdateFeeds> {
    const parsed = parseSavedUpdateFeeds(input)
    const key = JSON.stringify([workspaceId, recordKey(memberKey)])
    if ((this.collections.get(key)?.revision ?? 0) !== parsed.expectedRevision) throw new PlanningError(409, 'SavedUpdateFeedsConflict', 'Saved feeds changed. Reload before saving.')
    const result = { revision: parsed.expectedRevision + 1, feeds: parsed.feeds }
    this.collections.set(key, structuredClone(result))
    return result
  }
}

/** Derives a member-specific noncanonical key with no user-supplied physical key. */
function recordKey(memberKey: string) { return `UPDATE_FEED_DEFINITIONS#${createHash('sha256').update(memberKey.trim().toLowerCase()).digest('hex')}` }
/** Fences a digest's explicitly confirmed personal definitions in the same transaction.
 * @param tableName - Existing Planning table.
 * @param workspaceId - Authenticated Workspace.
 * @param memberKey - Authenticated owner.
 * @param revision - Optional confirmed collection revision.
 * @returns A typed revision guard, absent for standard-only selections.
 */
export function digestSavedFeedsFence(tableName: string, workspaceId: string, memberKey: string, revision?: number): PlanningCallerAuthorizationConditionCheck[] {
  if (revision === undefined) return []
  if (!Number.isSafeInteger(revision) || revision < 1) throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Digest selection changed.')
  return [{ ConditionCheck: { TableName: tableName, Key: { workspaceId, recordKey: recordKey(memberKey) }, ConditionExpression: '#revision = :revision AND #schema = :schema AND #type = :type', ExpressionAttributeNames: { '#revision': 'revision', '#schema': 'schemaVersion', '#type': 'entryType' }, ExpressionAttributeValues: { ':revision': revision, ':schema': 1, ':type': 'update-feed-definitions' } } }]
}
/** Classifies full transaction reason vectors and rejects malformed persistence. */
function storageFailure(error: unknown, size = 0): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  if (name === 'TransactionCanceledException' && typeof error === 'object' && error !== null && 'CancellationReasons' in error && Array.isArray(error.CancellationReasons)) {
    const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined)
    if (size > 0 && codes.length === size) {
      if (codes.includes('ConditionalCheckFailed') && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) throw new PlanningError(409, 'SavedUpdateFeedsConflict', 'Saved feeds or permissions changed. Reload before saving.')
      const transient = ['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']
      if (codes.some((code) => transient.includes(String(code))) && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed' || transient.includes(String(code)))) throw new PlanningError(503, 'SavedUpdateFeedsRetryable', 'Saved feed storage is temporarily unavailable.')
    }
  }
  if (typeof name === 'string' && ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)) throw new PlanningError(503, 'SavedUpdateFeedsRetryable', 'Saved feed storage is temporarily unavailable.')
  throw new PlanningError(502, 'SavedUpdateFeedsStorageFailure', 'Saved feed storage request failed.')
}
