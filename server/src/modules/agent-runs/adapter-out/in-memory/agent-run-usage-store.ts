import { type AgentUsageBucket } from '../../domain/agent-run-usage'
import { agentActivityRowKey, type AgentActivityRow, type AgentSessionCursor } from '../../domain/agent-run-activity'
import {
  agentActivityPartition,
  agentSessionCursorPartition,
  type AgentActivityRowPage,
  type AgentActivityWrite,
  type AgentAnalyticsWatch,
  type AgentAnalyticsWatchPage,
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
  /** Runs noted for the daily analytics export, by UTC start day. */
  readonly analyticsWatches = new Map<string, AgentAnalyticsWatch[]>()
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
  async recordActivityBatch(directoryId: string, memberKey: string, batchId: string, activity: AgentActivityWrite): Promise<'recorded' | 'duplicate' | 'cursor-moved'> {
    const toolReceipt = `${directoryId}|${memberKey}|activity#${batchId}`
    const waitReceipt = `${toolReceipt}#wait`
    let recorded = false
    if (!this.#receipts.has(toolReceipt) && activity.toolSlots.some((slot) => slot !== undefined)) {
      this.#receipts.add(toolReceipt)
      this.#addActivity(directoryId, memberKey, activity.toolSlots)
      recorded = true
    }
    if (activity.waitSlots.every((slot) => slot === undefined) && activity.claims.length === 0) return recorded ? 'recorded' : 'duplicate'
    if (this.#receipts.has(waitReceipt)) return recorded ? 'recorded' : 'duplicate'
    const partition = agentSessionCursorPartition(directoryId, memberKey)
    if (activity.claims.some((claim) => this.sessionCursors.get(`${partition}|${claim.sessionKey}`) !== claim.previousLastEventAtMs)) return 'cursor-moved'
    this.#receipts.add(waitReceipt)
    this.#addActivity(directoryId, memberKey, activity.waitSlots)
    for (const claim of activity.claims) this.sessionCursors.set(`${partition}|${claim.sessionKey}`, claim.lastEventAtMs)
    return 'recorded'
  }

  /**
   * Adds activity rows to the stored totals.
   *
   * @param directoryId - Workspace ID.
   * @param memberKey - Member that sent the export.
   * @param slots - Row slots; an empty slot adds nothing.
   */
  #addActivity(directoryId: string, memberKey: string, slots: readonly (AgentActivityRow | undefined)[]): void {
    for (const row of slots) {
      if (!row) continue
      const key = `${agentActivityPartition(directoryId, memberKey)}|${agentActivityRowKey(row)}`
      const saved = this.activity.get(key)
      this.activity.set(key, saved
        ? { ...saved, count: saved.count + row.count, durationMs: saved.durationMs + row.durationMs, failureCount: saved.failureCount + row.failureCount }
        : { ...row })
    }
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
  async advanceSessionCursors(directoryId: string, memberKey: string, cursors: readonly AgentSessionCursor[]): Promise<void> {
    const partition = agentSessionCursorPartition(directoryId, memberKey)
    for (const cursor of cursors) {
      const key = `${partition}|${cursor.sessionKey}`
      const saved = this.sessionCursors.get(key)
      if (saved === undefined || saved < cursor.lastEventAtMs) this.sessionCursors.set(key, cursor.lastEventAtMs)
    }
  }

  /** @inheritdoc */
  async watchRunForAnalytics(watch: AgentAnalyticsWatch, startedAt: Date): Promise<void> {
    const day = startedAt.toISOString().slice(0, 10)
    const watches = (this.analyticsWatches.get(day) ?? []).filter((saved) => watchKey(saved) !== watchKey(watch))
    this.analyticsWatches.set(day, [...watches, { ...watch }].sort((left, right) => watchKey(left) < watchKey(right) ? -1 : 1))
  }

  /** @inheritdoc */
  async listAnalyticsWatches(day: string, cursor: string | undefined, limit: number): Promise<AgentAnalyticsWatchPage> {
    const remaining = (this.analyticsWatches.get(day) ?? []).filter((watch) => cursor === undefined || watchKey(watch) > cursor)
    const watches = remaining.slice(0, limit)
    const last = watches.at(-1)
    return { watches, ...(remaining.length > limit && last ? { nextCursor: watchKey(last) } : {}) }
  }

}

/**
 * Builds the record key of a watch.
 *
 * @param watch - Watch.
 * @returns Key such as `<workspace>#<team>#<run>`.
 */
function watchKey(watch: AgentAnalyticsWatch): string {
  return `${watch.directoryId}#${watch.teamId}#${watch.runId}`
}
