import { type AgentUsageBucket } from '../../domain/agent-run-usage'
import {
  agentUsagePartition,
  agentUsageRecordKey,
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
  async recordBatch(directoryId: string, memberKey: string, batchId: string, buckets: readonly AgentUsageBucket[]): Promise<'recorded' | 'duplicate'> {
    const receipt = `${directoryId}|${memberKey}|${batchId}`
    if (this.#receipts.has(receipt)) return 'duplicate'
    this.#receipts.add(receipt)
    for (const bucket of buckets) {
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
    const matching = [...this.buckets.entries()]
      .filter(([key, bucket]) => key.startsWith(prefix) && bucket.instanceIdHash === instanceIdHash &&
        bucket.bucketStart >= from && (until === undefined || bucket.bucketStart < until))
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, bucket]) => ({ ...bucket }))
    return { buckets: matching.slice(0, limit), hasMore: matching.length > limit }
  }
}
