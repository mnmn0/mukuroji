import { type AgentUsageBucket } from '../../domain/agent-run-usage'
import {
  agentUsagePartition,
  agentUsageRecordKey,
  AGENT_USAGE_MAX_SCANNED_BUCKETS_FACTOR,
  type AgentRunUsageStore,
  type AgentUsageBucketPage,
} from '../dynamodb/agent-run-usage-store'

/** In-memory usage store for tests and local composition without DynamoDB. */
export class InMemoryAgentRunUsageStore implements AgentRunUsageStore {
  /** Buckets by partition and record key. */
  readonly buckets = new Map<string, AgentUsageBucket>()
  /** Export receipts by partition and record key. */
  readonly #receipts = new Set<string>()

  /** @inheritdoc */
  async recordBatch(directoryId: string, memberKey: string, batchId: string, buckets: readonly (AgentUsageBucket | undefined)[]): Promise<'recorded' | 'duplicate'> {
    const receipt = `${directoryId}|${memberKey}|${batchId}`
    if (this.#receipts.has(receipt)) return 'duplicate'
    this.#receipts.add(receipt)
    for (const bucket of buckets) {
      if (!bucket) continue
      const key = `${agentUsagePartition(directoryId, memberKey)}|${agentUsageRecordKey(bucket)}`
      const saved = this.buckets.get(key)
      this.buckets.set(key, saved
        ? {
            ...saved,
            inputTokens: saved.inputTokens + bucket.inputTokens,
            outputTokens: saved.outputTokens + bucket.outputTokens,
            cacheReadTokens: saved.cacheReadTokens + bucket.cacheReadTokens,
            cacheCreationTokens: saved.cacheCreationTokens + bucket.cacheCreationTokens,
            costMicroUsd: saved.costMicroUsd + bucket.costMicroUsd,
            requestCount: saved.requestCount + bucket.requestCount,
          }
        : { ...bucket })
    }
    return 'recorded'
  }

  /** @inheritdoc */
  async listMemberBuckets(directoryId: string, memberKey: string, instanceIdHash: string, from: string, until: string | undefined, limit: number): Promise<AgentUsageBucketPage> {
    const prefix = `${agentUsagePartition(directoryId, memberKey)}|`
    const inRange = [...this.buckets.entries()]
      .filter(([key, bucket]) => key.startsWith(prefix) &&
        bucket.bucketStart >= from && (until === undefined || bucket.bucketStart < until))
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, bucket]) => bucket)
    // Same bounds as the DynamoDB store: other instances' rows count toward the scan bound.
    const maxScanned = limit * AGENT_USAGE_MAX_SCANNED_BUCKETS_FACTOR
    const buckets: AgentUsageBucket[] = []
    for (const [index, bucket] of inRange.entries()) {
      if (index === maxScanned) return { buckets, hasMore: true }
      if (bucket.instanceIdHash !== instanceIdHash) continue
      if (buckets.length === limit) return { buckets, hasMore: true }
      buckets.push({ ...bucket })
    }
    return { buckets, hasMore: false }
  }
}
