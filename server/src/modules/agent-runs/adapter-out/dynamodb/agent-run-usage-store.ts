import { QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import { type AgentUsageBucket } from '../../domain/agent-run-usage'
import { createAgentRunIntegrityError } from '../../domain/agent-run-error'

/** Days a usage bucket is kept before DynamoDB TTL removes it. */
export const AGENT_USAGE_RETENTION_DAYS = 400

/** Days an export receipt is kept, long enough to cover every OTLP exporter retry. */
export const AGENT_USAGE_BATCH_RECEIPT_DAYS = 2

/** TTL attribute of usage rows and export receipts in the Agent Runs table. */
export const AGENT_USAGE_TTL_ATTRIBUTE = 'usageExpiresAt'

/** Bucket updates one transaction carries next to its receipt; DynamoDB allows 100 items. */
const bucketsPerTransaction = 99

/** Minimal DynamoDB command boundary used by the usage store. */
export type AgentRunUsageDocumentClient = {
  /** Sends one query or transaction. */
  send(command: QueryCommand | TransactWriteCommand): Promise<{
    /** Query page. */
    Items?: Record<string, unknown>[]
    /** Key of the last evaluated item when more items remain. */
    LastEvaluatedKey?: Record<string, unknown>
  }>
}

/** Buckets read for one member and time range. */
export type AgentUsageBucketPage = {
  /** Buckets in start order. */
  buckets: AgentUsageBucket[]
  /** Whether more buckets existed in the range than the limit allowed. */
  hasMore: boolean
}

/** Persistence of agent telemetry usage, attributed to runs when it is read. */
export interface AgentRunUsageStore {
  /**
   * Adds one export's buckets to the member's totals. A retried export with the same batch ID adds
   * nothing.
   *
   * @param directoryId - Workspace ID.
   * @param memberKey - Member that sent the export.
   * @param batchId - Stable ID of the export.
   * @param buckets - Usage grouped by bucket, instance, and model.
   * @param now - Receive time.
   * @returns Whether the export was added or was already added.
   */
  recordBatch(directoryId: string, memberKey: string, batchId: string, buckets: readonly (AgentUsageBucket | undefined)[], now: Date): Promise<'recorded' | 'duplicate'>
  /**
   * Reads a member's buckets of one agent instance that start in a range. The member's other
   * instances share the partition, so at most {@link AGENT_USAGE_MAX_SCANNED_BUCKETS_FACTOR} times
   * `limit` rows are read; `hasMore` is set when that bound or `limit` stopped the read.
   *
   * @param directoryId - Workspace ID.
   * @param memberKey - Member whose usage is read.
   * @param instanceIdHash - Agent instance whose buckets are returned.
   * @param from - First bucket start, inclusive.
   * @param until - Bucket start where the range ends, exclusive; open when undefined.
   * @param limit - Largest number of buckets to return.
   * @returns Buckets in start order.
   */
  listMemberBuckets(directoryId: string, memberKey: string, instanceIdHash: string, from: string, until: string | undefined, limit: number): Promise<AgentUsageBucketPage>
}

/** Rows of other instances one usage read may pass over, as a multiple of its bucket limit. */
export const AGENT_USAGE_MAX_SCANNED_BUCKETS_FACTOR = 5

/**
 * Builds the partition of a member's usage buckets.
 *
 * @param directoryId - Workspace ID.
 * @param memberKey - Member key.
 * @returns Partition key value.
 */
export function agentUsagePartition(directoryId: string, memberKey: string): string {
  return `${directoryId}#agent-usage#member#${memberKey}`
}

/**
 * Builds the partition of a member's export receipts.
 *
 * @param directoryId - Workspace ID.
 * @param memberKey - Member key.
 * @returns Partition key value.
 */
function agentUsageBatchPartition(directoryId: string, memberKey: string): string {
  return `${directoryId}#agent-usage-batch#member#${memberKey}`
}

/**
 * Builds a bucket row key. Bucket starts have a fixed width, so keys sort by time.
 *
 * @param bucket - Bucket identity.
 * @returns Sort key value.
 */
export function agentUsageRecordKey(bucket: Pick<AgentUsageBucket, 'bucketStart' | 'instanceIdHash' | 'model'>): string {
  return `${bucket.bucketStart}#${bucket.instanceIdHash}#${bucket.model}`
}

/**
 * Converts a time to the TTL epoch seconds a number of days later.
 *
 * @param now - Start time.
 * @param days - Days to keep.
 * @returns Epoch seconds.
 */
function expiresAfterDays(now: Date, days: number): number {
  return Math.floor(now.getTime() / 1_000) + days * 86_400
}

/**
 * Narrows a value to a plain object.
 *
 * @param value - Untrusted value.
 * @returns True for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a transaction failed only because its receipt already existed.
 *
 * @param error - Thrown value.
 * @returns True when the first item failed its condition.
 */
function isReceiptConflict(error: unknown): boolean {
  if (!isRecord(error) || error.name !== 'TransactionCanceledException') return false
  const reasons = error.CancellationReasons
  return Array.isArray(reasons) && isRecord(reasons[0]) && reasons[0].Code === 'ConditionalCheckFailed'
}

/**
 * Reads a stored non-negative integer counter.
 *
 * @param item - Stored row.
 * @param field - Counter name.
 * @returns The counter.
 * @throws AgentRunError when the counter is malformed.
 */
function storedCounter(item: Record<string, unknown>, field: string): number {
  const value = item[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw createAgentRunIntegrityError()
  return value
}

/**
 * Reads a stored bucket row.
 *
 * @param item - Stored row.
 * @returns The bucket.
 * @throws AgentRunError when the row is malformed.
 */
export function parseAgentUsageBucket(item: Record<string, unknown>): AgentUsageBucket {
  const { bucketStart, instanceIdHash, model } = item
  if (typeof bucketStart !== 'string' || typeof instanceIdHash !== 'string' || typeof model !== 'string') {
    throw createAgentRunIntegrityError()
  }
  if (item.recordKey !== agentUsageRecordKey({ bucketStart, instanceIdHash, model })) throw createAgentRunIntegrityError()
  return {
    bucketStart,
    instanceIdHash,
    model,
    inputTokens: storedCounter(item, 'inputTokens'),
    outputTokens: storedCounter(item, 'outputTokens'),
    cacheReadTokens: storedCounter(item, 'cacheReadTokens'),
    cacheCreationTokens: storedCounter(item, 'cacheCreationTokens'),
    costMicroUsd: storedCounter(item, 'costMicroUsd'),
    requestCount: storedCounter(item, 'requestCount'),
  }
}

/** DynamoDB implementation that keeps usage rows in the Agent Runs table. */
export class DynamoDbAgentRunUsageStore implements AgentRunUsageStore {
  /** Document client for the Agent Runs table. */
  readonly #client: AgentRunUsageDocumentClient
  /** Agent Runs table name. */
  readonly #tableName: string

  /**
   * Creates the store.
   * @param client - DynamoDB document client.
   * @param tableName - Agent Runs table name.
   */
  constructor(client: AgentRunUsageDocumentClient, tableName: string) {
    this.#client = client
    this.#tableName = tableName
  }

  /** @inheritdoc */
  async recordBatch(directoryId: string, memberKey: string, batchId: string, buckets: readonly (AgentUsageBucket | undefined)[], now: Date): Promise<'recorded' | 'duplicate'> {
    let recorded = false
    // Each chunk has its own receipt, so a retry after a partial failure adds only the missing chunks.
    // Empty slots keep the chunk boundaries of the export; a chunk with nothing to add is skipped.
    for (let start = 0, chunk = 0; start < buckets.length; start += bucketsPerTransaction, chunk += 1) {
      const chunkBuckets = buckets.slice(start, start + bucketsPerTransaction)
        .filter((bucket): bucket is AgentUsageBucket => bucket !== undefined)
      if (chunkBuckets.length === 0) continue
      const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        {
          Put: {
            TableName: this.#tableName,
            Item: {
              directoryTeamId: agentUsageBatchPartition(directoryId, memberKey),
              recordKey: `${batchId}#${chunk}`,
              entityType: 'agent-usage-batch',
              workspaceId: directoryId,
              receivedAt: now.toISOString(),
              [AGENT_USAGE_TTL_ATTRIBUTE]: expiresAfterDays(now, AGENT_USAGE_BATCH_RECEIPT_DAYS),
            },
            ConditionExpression: 'attribute_not_exists(recordKey)',
          },
        },
        ...chunkBuckets.map((bucket) => ({
          Update: {
            TableName: this.#tableName,
            Key: { directoryTeamId: agentUsagePartition(directoryId, memberKey), recordKey: agentUsageRecordKey(bucket) },
            UpdateExpression: [
              'SET #entityType = :entityType, #workspaceId = :workspaceId, #memberKey = :memberKey,',
              '#bucketStart = :bucketStart, #instanceIdHash = :instanceIdHash, #model = :model, #ttl = :ttl',
              'ADD #inputTokens :inputTokens, #outputTokens :outputTokens, #cacheReadTokens :cacheReadTokens,',
              '#cacheCreationTokens :cacheCreationTokens, #costMicroUsd :costMicroUsd, #requestCount :requestCount',
            ].join(' '),
            ExpressionAttributeNames: {
              '#entityType': 'entityType',
              '#workspaceId': 'workspaceId',
              '#memberKey': 'memberKey',
              '#bucketStart': 'bucketStart',
              '#instanceIdHash': 'instanceIdHash',
              '#model': 'model',
              '#ttl': AGENT_USAGE_TTL_ATTRIBUTE,
              '#inputTokens': 'inputTokens',
              '#outputTokens': 'outputTokens',
              '#cacheReadTokens': 'cacheReadTokens',
              '#cacheCreationTokens': 'cacheCreationTokens',
              '#costMicroUsd': 'costMicroUsd',
              '#requestCount': 'requestCount',
            },
            ExpressionAttributeValues: {
              ':entityType': 'agent-usage',
              ':workspaceId': directoryId,
              ':memberKey': memberKey,
              ':bucketStart': bucket.bucketStart,
              ':instanceIdHash': bucket.instanceIdHash,
              ':model': bucket.model,
              ':ttl': expiresAfterDays(now, AGENT_USAGE_RETENTION_DAYS),
              ':inputTokens': bucket.inputTokens,
              ':outputTokens': bucket.outputTokens,
              ':cacheReadTokens': bucket.cacheReadTokens,
              ':cacheCreationTokens': bucket.cacheCreationTokens,
              ':costMicroUsd': bucket.costMicroUsd,
              ':requestCount': bucket.requestCount,
            },
          },
        })),
      ]
      try {
        await this.#client.send(new TransactWriteCommand({ TransactItems: items }))
        recorded = true
      } catch (error) {
        if (!isReceiptConflict(error)) throw error
      }
    }
    return recorded ? 'recorded' : 'duplicate'
  }

  /** @inheritdoc */
  async listMemberBuckets(directoryId: string, memberKey: string, instanceIdHash: string, from: string, until: string | undefined, limit: number): Promise<AgentUsageBucketPage> {
    const buckets: AgentUsageBucket[] = []
    const maxScanned = limit * AGENT_USAGE_MAX_SCANNED_BUCKETS_FACTOR
    let scanned = 0
    let exclusiveStartKey: Record<string, unknown> | undefined
    // `<until>` sorts before every key of its own bucket, so BETWEEN stops before that bucket. An
    // open range ends after every possible bucket start.
    const upper = until ?? '~'
    if (upper <= from) return { buckets, hasMore: false }
    do {
      const page = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: '#partition = :partition AND #recordKey BETWEEN :from AND :until',
        ExpressionAttributeNames: { '#partition': 'directoryTeamId', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':partition': agentUsagePartition(directoryId, memberKey), ':from': from, ':until': upper },
        Limit: Math.min(1_000, maxScanned + 1 - scanned),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of page.Items ?? []) {
        if (scanned === maxScanned) return { buckets, hasMore: true }
        scanned += 1
        const bucket = parseAgentUsageBucket(item)
        if (until !== undefined && bucket.bucketStart >= until) continue
        if (bucket.instanceIdHash !== instanceIdHash) continue
        if (buckets.length === limit) return { buckets, hasMore: true }
        buckets.push(bucket)
      }
      exclusiveStartKey = page.LastEvaluatedKey
    } while (exclusiveStartKey)
    return { buckets, hasMore: false }
  }
}
