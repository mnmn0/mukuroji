import { type AgentUsageBucket } from '../../domain/agent-run-usage'
import { agentActivityRowKey, type AgentActivityRow, type AgentSessionCursorClaim } from '../../domain/agent-run-activity'
import {
  agentActivityPartition,
  agentSessionCursorPartition,
  type AgentActivityRowPage,
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
  /** Activity rows by partition and record key. */
  readonly activity = new Map<string, AgentActivityRow>()
  /** Session cursors by partition and session key. */
  readonly sessionCursors = new Map<string, number>()
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
            durationMs: saved.durationMs + bucket.durationMs,
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

  /** @inheritdoc */
  async recordActivityBatch(directoryId: string, memberKey: string, batchId: string, rows: readonly (AgentActivityRow | undefined)[]): Promise<'recorded' | 'duplicate'> {
    const receipt = `${directoryId}|${memberKey}|activity#${batchId}`
    if (this.#receipts.has(receipt)) return 'duplicate'
    this.#receipts.add(receipt)
    for (const row of rows) {
      if (!row) continue
      const key = `${agentActivityPartition(directoryId, memberKey)}|${agentActivityRowKey(row)}`
      const saved = this.activity.get(key)
      this.activity.set(key, saved
        ? { ...saved, count: saved.count + row.count, durationMs: saved.durationMs + row.durationMs, failureCount: saved.failureCount + row.failureCount }
        : { ...row })
    }
    return 'recorded'
  }

  /** @inheritdoc */
  async listMemberActivity(directoryId: string, memberKey: string, instanceIdHash: string, from: string, until: string | undefined, limit: number): Promise<AgentActivityRowPage> {
    const prefix = `${agentActivityPartition(directoryId, memberKey)}|`
    const inRange = [...this.activity.entries()]
      .filter(([key, row]) => key.startsWith(prefix) && row.bucketStart >= from && (until === undefined || row.bucketStart < until))
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, row]) => row)
    const maxScanned = limit * AGENT_USAGE_MAX_SCANNED_BUCKETS_FACTOR
    const rows: AgentActivityRow[] = []
    for (const [index, row] of inRange.entries()) {
      if (index === maxScanned) return { rows, hasMore: true }
      if (row.instanceIdHash !== instanceIdHash) continue
      if (rows.length === limit) return { rows, hasMore: true }
      rows.push({ ...row })
    }
    return { rows, hasMore: false }
  }

  /** @inheritdoc */
  async readSessionCursors(directoryId: string, memberKey: string, sessionKeys: readonly string[]): Promise<Map<string, number>> {
    const partition = agentSessionCursorPartition(directoryId, memberKey)
    const cursors = new Map<string, number>()
    for (const sessionKey of sessionKeys) {
      const saved = this.sessionCursors.get(`${partition}|${sessionKey}`)
      if (saved !== undefined) cursors.set(sessionKey, saved)
    }
    return cursors
  }

  /** @inheritdoc */
  async claimSessionCursors(directoryId: string, memberKey: string, claims: readonly AgentSessionCursorClaim[]): Promise<boolean> {
    const partition = agentSessionCursorPartition(directoryId, memberKey)
    if (claims.some((claim) => this.sessionCursors.get(`${partition}|${claim.sessionKey}`) !== claim.previousLastEventAtMs)) return false
    for (const claim of claims) this.sessionCursors.set(`${partition}|${claim.sessionKey}`, claim.lastEventAtMs)
    return true
  }

  /** @inheritdoc */
  async releaseSessionCursors(directoryId: string, memberKey: string, claims: readonly AgentSessionCursorClaim[]): Promise<void> {
    const partition = agentSessionCursorPartition(directoryId, memberKey)
    for (const claim of claims) {
      const key = `${partition}|${claim.sessionKey}`
      if (this.sessionCursors.get(key) !== claim.lastEventAtMs) continue
      if (claim.previousLastEventAtMs === undefined) this.sessionCursors.delete(key)
      else this.sessionCursors.set(key, claim.previousLastEventAtMs)
    }
  }
}
