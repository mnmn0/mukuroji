import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createHash } from 'node:crypto'
import type { SetUpdateFeedReadStateInput, UpdateFeedReadState } from '@mukuroji/contracts'
import { PlanningError, type PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { updateFeedReportKey, type UpdateFeedReadStateStore, type UpdateFeedReportReference } from '../application/read-state'

/** Composition boundary that binds server-built caller authorization checks to writes. */
export interface UpdateFeedReadStatePersistence extends UpdateFeedReadStateStore {
  /** Binds current membership and optional Enterprise control checks without exposing SDK types to the use case.
   * @param checks - Server-built caller authorization conditions.
   * @returns Request-scoped persistence guarded by those conditions.
   */
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[]): UpdateFeedReadStateStore
}

/** DynamoDB personal read-state adapter using exact keys in the existing Planning table. */
export class DynamoDbUpdateFeedReadStateStore implements UpdateFeedReadStatePersistence {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected DynamoDB document client. */
  private readonly client: DynamoDBDocumentClient
  /** Immutable request-scoped caller authorization conditions. */
  private readonly authorizationChecks: readonly PlanningCallerAuthorizationConditionCheck[]

  /** Creates a durable store without provisioning or touching canonical update rows.
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   * @param authorizationChecks - Server-built commit-time caller conditions, absent for read-only composition.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, authorizationChecks: readonly PlanningCallerAuthorizationConditionCheck[] = []) {
    this.tableName = tableName; this.client = client; this.authorizationChecks = structuredClone(authorizationChecks)
  }

  /** Creates an isolated write binding while retaining the same durable data store.
   * @param checks - Current membership and optional Enterprise control conditions.
   * @returns A request-scoped persistence port.
   */
  withCallerAuthorization(checks: readonly PlanningCallerAuthorizationConditionCheck[]): UpdateFeedReadStateStore {
    return new DynamoDbUpdateFeedReadStateStore(this.tableName, this.client, checks)
  }

  /** Reads at most 100 exact keys in groups of ten, using existing GetItem permissions.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member.
   * @param reports - Authorized immutable report identities.
   * @returns Logical report keys mapped to stored state.
   */
  async getMany(workspaceId: string, memberKey: string, reports: readonly UpdateFeedReportReference[]): Promise<ReadonlyMap<string, UpdateFeedReadState>> {
    const keys = new Map(reports.map((report) => [recordKey(memberKey, report), updateFeedReportKey(report)]))
    if (keys.size > 100) throw new PlanningError(413, 'UpdateFeedReadStateLimit', 'Too many read-state keys.')
    if (keys.size === 0) return new Map()
    const states = new Map<string, UpdateFeedReadState>()
    const records = [...keys.entries()]
    for (let offset = 0; offset < records.length; offset += 10) {
      const results = await Promise.all(records.slice(offset, offset + 10).map(async ([key, publicKey]) => {
        const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true })).catch((error: unknown) => throwStorageFailure(error))
        return { row: result.Item, key, publicKey }
      }))
      for (const { row, key, publicKey } of results) {
        if (!row) continue
        if (row.workspaceId !== workspaceId || row.recordKey !== key || row.schemaVersion !== 1 || typeof row.read !== 'boolean' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) {
          throw new PlanningError(502, 'UpdateFeedReadStateCorrupt', 'Stored read state is invalid.')
        }
        states.set(publicKey, { read: row.read, revision: row.revision })
      }
    }
    return states
  }

  /** Guards both personal state and current Planning/ACL revision in one transaction.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member.
   * @param input - Validated desired state and CAS revision.
   * @param planningRevision - Revision spanning fresh authorization reads.
   * @returns Committed personal state.
   */
  async set(workspaceId: string, memberKey: string, input: SetUpdateFeedReadStateInput, planningRevision: number): Promise<UpdateFeedReadState> {
    if (this.authorizationChecks.length === 0) throw new PlanningError(503, 'UpdateFeedAuthorizationUnavailable', 'Caller authorization conditions are unavailable.')
    const state = { read: input.read, revision: input.expectedRevision + 1 }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { workspaceId: `FENCE#${workspaceId}`, recordKey: 'META' },
          ConditionExpression: '#entryType = :entryType AND #schemaVersion = :schemaVersion AND #revision = :revision',
          ExpressionAttributeNames: { '#entryType': 'entryType', '#schemaVersion': 'schemaVersion', '#revision': 'revision' },
          ExpressionAttributeValues: { ':entryType': 'planning-meta', ':schemaVersion': 1, ':revision': planningRevision } } },
        { Put: { TableName: this.tableName, Item: { workspaceId, recordKey: recordKey(memberKey, input), schemaVersion: 1, ...state },
          ConditionExpression: input.expectedRevision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :revision',
          ...(input.expectedRevision === 0 ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': input.expectedRevision } }),
        } },
        ...this.authorizationChecks,
      ] }))
    } catch (error) {
      throwStorageFailure(error, this.authorizationChecks.length + 2)
    }
    return state
  }
}

/** Isolated in-memory adapter used only by test composition. */
export class InMemoryUpdateFeedReadStateStore implements UpdateFeedReadStatePersistence {
  /** Exact Workspace/member/report state keys. */
  private readonly states = new Map<string, UpdateFeedReadState>()
  /** Preserves the isolated test store; transaction condition evaluation is tested at the SDK boundary.
   * @param _checks - Server-built caller conditions, inspected by API wiring tests.
   * @returns This isolated in-memory test port.
   */
  withCallerAuthorization(_checks: readonly PlanningCallerAuthorizationConditionCheck[]): UpdateFeedReadStateStore { return this }
  /** Loads only requested immutable report versions.
   * @param workspaceId - Test Workspace.
   * @param memberKey - Test member.
   * @param reports - Requested version identities.
   * @returns Copies of matching personal states.
   */
  async getMany(workspaceId: string, memberKey: string, reports: readonly UpdateFeedReportReference[]) {
    return new Map(reports.flatMap((report) => {
      const state = this.states.get(JSON.stringify([workspaceId, recordKey(memberKey, report)]))
      return state ? [[updateFeedReportKey(report), { ...state }]] : []
    }))
  }
  /** Applies compare-and-swap without modifying any canonical update.
   * @param workspaceId - Test Workspace.
   * @param memberKey - Test member.
   * @param input - Desired state and expected revision.
   * @returns Committed state copy.
   */
  async set(workspaceId: string, memberKey: string, input: SetUpdateFeedReadStateInput): Promise<UpdateFeedReadState> {
    const key = JSON.stringify([workspaceId, recordKey(memberKey, input)])
    if ((this.states.get(key)?.revision ?? 0) !== input.expectedRevision) throw new PlanningError(409, 'UpdateFeedReadStateConflict', 'Read state changed.')
    const state = { read: input.read, revision: input.expectedRevision + 1 }
    this.states.set(key, state)
    return { ...state }
  }
}

/** Classifies conditional-only conflicts separately from transient or unknown persistence failures. */
function throwStorageFailure(error: unknown, transactionSize = 0): never {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
  const retryable = new Set(['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError'])
  if (name === 'TransactionCanceledException' && typeof error === 'object' && error !== null && 'CancellationReasons' in error && Array.isArray(error.CancellationReasons)) {
    const codes = error.CancellationReasons.map((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason ? reason.Code : undefined)
    if (transactionSize > 0 && codes.length === transactionSize && codes.includes('ConditionalCheckFailed') && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) {
      throw new PlanningError(409, 'UpdateFeedReadStateConflict', 'Read state or caller permissions changed. Refresh and retry.')
    }
    if (transactionSize > 0 && codes.length === transactionSize && codes.some((code) => typeof code === 'string' && retryable.has(code)) && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed' || typeof code === 'string' && retryable.has(code))) {
      throw new PlanningError(503, 'UpdateFeedReadStateRetryable', 'Read-state storage is temporarily unavailable. Refresh and retry.')
    }
  }
  if (typeof name === 'string' && ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TransactionInProgressException', 'TimeoutError'].includes(name)) {
    throw new PlanningError(503, 'UpdateFeedReadStateRetryable', 'Read-state storage is temporarily unavailable. Refresh and retry.')
  }
  throw new PlanningError(502, 'UpdateFeedReadStateStorageFailure', 'Read-state storage request failed.')
}

/** Builds a noncanonical key that is excluded from Planning graph/history queries. */
function recordKey(memberKey: string, report: UpdateFeedReportReference): string {
  const member = createHash('sha256').update(memberKey.trim().toLowerCase()).digest('hex')
  const identity = createHash('sha256').update(updateFeedReportKey(report)).digest('hex')
  return `UPDATE_FEED_READ#${member}#${identity}`
}
