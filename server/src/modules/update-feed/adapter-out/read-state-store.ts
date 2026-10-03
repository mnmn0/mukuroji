import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createHash } from 'node:crypto'
import type { SetUpdateFeedReadStateInput, UpdateFeedReadState } from '@mukuroji/contracts'
import { PlanningError } from '../../planning'
import { updateFeedReportKey, type UpdateFeedReadStateStore, type UpdateFeedReportReference } from '../application/read-state'

/** DynamoDB personal read-state adapter using exact keys in the existing Planning table. */
export class DynamoDbUpdateFeedReadStateStore implements UpdateFeedReadStateStore {
  /** Existing Planning table name. */
  private readonly tableName: string
  /** Injected DynamoDB document client. */
  private readonly client: DynamoDBDocumentClient

  /** Creates a durable store without provisioning or touching canonical update rows.
   * @param tableName - Existing Planning table.
   * @param client - Configured document client.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient) { this.tableName = tableName; this.client = client }

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
        const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey: key }, ConsistentRead: true }))
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
    const state = { read: input.read, revision: input.expectedRevision + 1 }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.tableName, Key: { workspaceId: `FENCE#${workspaceId}`, recordKey: 'META' },
          ConditionExpression: '#revision = :revision', ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': planningRevision } } },
        { Put: { TableName: this.tableName, Item: { workspaceId, recordKey: recordKey(memberKey, input), schemaVersion: 1, ...state },
          ConditionExpression: input.expectedRevision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :revision',
          ...(input.expectedRevision === 0 ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': input.expectedRevision } }),
        } },
      ] }))
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException' && 'CancellationReasons' in error && Array.isArray(error.CancellationReasons) && error.CancellationReasons.some((reason: unknown) => typeof reason === 'object' && reason !== null && 'Code' in reason && reason.Code === 'ConditionalCheckFailed')) {
        throw new PlanningError(409, 'UpdateFeedReadStateConflict', 'Read state or target permissions changed. Refresh and retry.')
      }
      throw error
    }
    return state
  }
}

/** Isolated in-memory adapter used only by test composition. */
export class InMemoryUpdateFeedReadStateStore implements UpdateFeedReadStateStore {
  /** Exact Workspace/member/report state keys. */
  private readonly states = new Map<string, UpdateFeedReadState>()
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

/** Builds a noncanonical key that is excluded from Planning graph/history queries. */
function recordKey(memberKey: string, report: UpdateFeedReportReference): string {
  const member = createHash('sha256').update(memberKey.trim().toLowerCase()).digest('hex')
  const identity = createHash('sha256').update(updateFeedReportKey(report)).digest('hex')
  return `UPDATE_FEED_READ#${member}#${identity}`
}
