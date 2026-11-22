import { createHash } from 'node:crypto'
import {
  AGENT_TELEMETRY_API_REQUEST_EVENT,
  AGENT_TELEMETRY_INSTANCE_ATTRIBUTE,
  type AgentRunUsage,
} from '@mukuroji/contracts'
import { hashAgentInstanceId } from './agent-run'

/** Length of one usage bucket. Usage is attributed to runs at this resolution. */
export const AGENT_USAGE_BUCKET_SECONDS = 10

/** Largest number of log records one OTLP export may carry. */
export const AGENT_TELEMETRY_MAX_LOG_RECORDS = 2_000

/** Oldest event age the receiver accepts, so a replayed old export cannot rewrite history. */
export const AGENT_TELEMETRY_MAX_EVENT_AGE_DAYS = 7

/** Clock skew tolerated for events stamped ahead of the server. */
const maximumFutureSkewMs = 5 * 60_000

/** Largest token count one request may report, well above any model's context window. */
const maximumTokensPerRequest = 100_000_000

/** Largest estimated cost one request may report, in US dollars. */
const maximumCostUsdPerRequest = 10_000

/** Longest model name kept; longer names are cut. */
const maximumModelLength = 128

/** Instance hash recorded for usage that names no agent instance. Such usage never matches a run. */
export const UNKNOWN_AGENT_INSTANCE_HASH = 'unknown'

/** Event names, without the runtime prefix, that carry the usage of one model request. */
const apiRequestEventNames = new Set([AGENT_TELEMETRY_API_REQUEST_EVENT, 'api_request'])

/** Usage of one model request, read from one OTLP log record. */
export type AgentUsageEvent = {
  /** SHA-256 of the agent instance ID, or {@link UNKNOWN_AGENT_INSTANCE_HASH}. */
  instanceIdHash: string
  /** Request time in epoch milliseconds. */
  occurredAtMs: number
  /** Model that served the request. */
  model: string
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Input tokens read from the prompt cache. */
  cacheReadTokens: number
  /** Input tokens written to the prompt cache. */
  cacheCreationTokens: number
  /** Estimated cost in millionths of US dollars. */
  costMicroUsd: number
}

/** Usage events read from one OTLP export and the number of usage records it rejected. */
export type ParsedAgentTelemetry = {
  /** Accepted usage events. */
  events: AgentUsageEvent[]
  /** Usage records that were malformed or outside the accepted time window. */
  rejectedRecords: number
}

/** Usage added together for one member, agent instance, model, and bucket. */
export type AgentUsageBucket = {
  /** Bucket start as an ISO 8601 UTC timestamp with second precision, such as `2026-11-22T17:05:10Z`. */
  bucketStart: string
  /** SHA-256 of the agent instance ID, or {@link UNKNOWN_AGENT_INSTANCE_HASH}. */
  instanceIdHash: string
  /** Model that served the requests. */
  model: string
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Input tokens read from the prompt cache. */
  cacheReadTokens: number
  /** Input tokens written to the prompt cache. */
  cacheCreationTokens: number
  /** Estimated cost in millionths of US dollars. */
  costMicroUsd: number
  /** Model requests the bucket covers. */
  requestCount: number
}

/** Error for an export body that is not an OTLP JSON logs request at all. */
export class AgentTelemetryFormatError extends Error {
  /**
   * Creates the error.
   * @param message - Reason the body was refused.
   */
  constructor(message: string) {
    super(message)
    this.name = 'AgentTelemetryFormatError'
  }
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
 * Reads an optional array field of an OTLP message.
 *
 * @param record - OTLP message.
 * @param field - Field name.
 * @returns The array, or an empty array when the field is absent.
 * @throws AgentTelemetryFormatError when the field is present and not an array.
 */
function readArray(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new AgentTelemetryFormatError(`${field} must be an array.`)
  return value
}

/**
 * Converts an OTLP JSON `AnyValue` to a string or number. Integers arrive as decimal strings in the
 * protobuf JSON mapping, so numeric strings stay strings here and the caller decides.
 *
 * @param value - OTLP `AnyValue`.
 * @returns The scalar, or undefined for arrays, maps, bytes, and malformed values.
 */
function readAnyValue(value: unknown): string | number | boolean | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.stringValue === 'string') return value.stringValue
  if (typeof value.intValue === 'string' || typeof value.intValue === 'number') return value.intValue
  if (typeof value.doubleValue === 'number') return value.doubleValue
  if (typeof value.boolValue === 'boolean') return value.boolValue
  return undefined
}

/**
 * Reads the scalar attributes of an OTLP message. Only the keys in `keep` are read, so prompts,
 * tool input, and other content never leave this function.
 *
 * @param attributes - OTLP `KeyValue` list.
 * @param keep - Attribute keys to read.
 * @returns Scalars by key.
 */
function readAttributes(attributes: unknown[], keep: ReadonlySet<string>): Map<string, string | number | boolean> {
  const values = new Map<string, string | number | boolean>()
  for (const attribute of attributes) {
    if (!isRecord(attribute) || typeof attribute.key !== 'string' || !keep.has(attribute.key)) continue
    const value = readAnyValue(attribute.value)
    if (value !== undefined) values.set(attribute.key, value)
  }
  return values
}

/** Resource attributes the receiver reads. */
const resourceAttributeKeys = new Set([AGENT_TELEMETRY_INSTANCE_ATTRIBUTE])

/** Log record attributes the receiver reads. Everything else, including prompts, is dropped. */
const logAttributeKeys = new Set([
  'event.name',
  'event.timestamp',
  AGENT_TELEMETRY_INSTANCE_ATTRIBUTE,
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
  'cost_usd_micros',
])

/**
 * Reads a non-negative finite number from a scalar attribute.
 *
 * @param value - Scalar attribute value.
 * @param maximum - Largest accepted value.
 * @returns The number, 0 when absent, or undefined when malformed or out of range.
 */
function readNonNegativeNumber(value: string | number | boolean | undefined, maximum: number): number | undefined {
  if (value === undefined) return 0
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(value.trim()) ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || number < 0 || number > maximum) return undefined
  return number
}

/**
 * Reads a token count attribute.
 *
 * @param value - Scalar attribute value.
 * @returns A whole token count, or undefined when malformed.
 */
function readTokenCount(value: string | number | boolean | undefined): number | undefined {
  const number = readNonNegativeNumber(value, maximumTokensPerRequest)
  return number === undefined || !Number.isInteger(number) ? undefined : number
}

/**
 * Reads a log record's time from `timeUnixNano`, then `observedTimeUnixNano`, then the
 * `event.timestamp` attribute.
 *
 * @param record - OTLP `LogRecord`.
 * @param eventTimestamp - The `event.timestamp` attribute, when present.
 * @returns Epoch milliseconds, or undefined when no valid time exists.
 */
function readRecordTime(record: Record<string, unknown>, eventTimestamp: string | number | boolean | undefined): number | undefined {
  for (const field of ['timeUnixNano', 'observedTimeUnixNano']) {
    const value = record[field]
    if (typeof value === 'string' && /^\d{1,20}$/u.test(value) && value !== '0') {
      return Number(BigInt(value) / 1_000_000n)
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return Math.floor(value / 1_000_000)
  }
  if (typeof eventTimestamp === 'string') {
    const parsed = Date.parse(eventTimestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Normalizes a model name for storage and keys.
 *
 * @param value - Scalar attribute value.
 * @returns A trimmed model name without `#`, or `unknown`.
 */
function readModel(value: string | number | boolean | undefined): string {
  if (typeof value !== 'string') return 'unknown'
  // Control characters and the key separator never reach a key.
  const model = value.replace(/[\p{Cc}#]/gu, '').trim().slice(0, maximumModelLength)
  return model === '' ? 'unknown' : model
}

/**
 * Reads the instance hash from a raw instance ID attribute.
 *
 * @param value - Scalar attribute value.
 * @returns The instance hash, or {@link UNKNOWN_AGENT_INSTANCE_HASH} when the ID is missing or malformed.
 */
function readInstanceHash(value: string | number | boolean | undefined): string {
  if (typeof value !== 'string') return UNKNOWN_AGENT_INSTANCE_HASH
  // Matches the MCP instance ID rule: 1 to 256 characters without surrounding whitespace or control characters.
  if (value.length === 0 || value.length > 256 || value.trim() !== value || /\p{Cc}/u.test(value)) {
    return UNKNOWN_AGENT_INSTANCE_HASH
  }
  return hashAgentInstanceId(value)
}

/**
 * Reads the model request usage events from an OTLP/HTTP JSON `ExportLogsServiceRequest`. Records of
 * other events are ignored without counting as rejected; usage records that are malformed or stamped
 * outside the accepted window are counted as rejected.
 *
 * @param body - Parsed JSON request body.
 * @param now - Receive time.
 * @returns Accepted events and the rejected record count.
 * @throws AgentTelemetryFormatError when the body is not a logs export or has too many records.
 */
export function parseAgentTelemetryLogs(body: unknown, now: Date): ParsedAgentTelemetry {
  if (!isRecord(body)) throw new AgentTelemetryFormatError('The body must be an OTLP ExportLogsServiceRequest object.')
  const events: AgentUsageEvent[] = []
  let rejectedRecords = 0
  let recordCount = 0
  const oldest = now.getTime() - AGENT_TELEMETRY_MAX_EVENT_AGE_DAYS * 86_400_000
  const newest = now.getTime() + maximumFutureSkewMs
  for (const resourceLogs of readArray(body, 'resourceLogs')) {
    if (!isRecord(resourceLogs)) throw new AgentTelemetryFormatError('resourceLogs entries must be objects.')
    const resource = isRecord(resourceLogs.resource) ? resourceLogs.resource : {}
    const resourceAttributes = readAttributes(readArray(resource, 'attributes'), resourceAttributeKeys)
    for (const scopeLogs of readArray(resourceLogs, 'scopeLogs')) {
      if (!isRecord(scopeLogs)) throw new AgentTelemetryFormatError('scopeLogs entries must be objects.')
      for (const record of readArray(scopeLogs, 'logRecords')) {
        recordCount += 1
        if (recordCount > AGENT_TELEMETRY_MAX_LOG_RECORDS) {
          throw new AgentTelemetryFormatError(`An export may carry at most ${AGENT_TELEMETRY_MAX_LOG_RECORDS} log records.`)
        }
        if (!isRecord(record)) {
          rejectedRecords += 1
          continue
        }
        const attributes = readAttributes(readArray(record, 'attributes'), logAttributeKeys)
        const body = readAnyValue(record.body)
        const eventName = attributes.get('event.name')
        const isUsage = (typeof body === 'string' && apiRequestEventNames.has(body)) ||
          (typeof eventName === 'string' && apiRequestEventNames.has(eventName))
        if (!isUsage) continue
        const occurredAtMs = readRecordTime(record, attributes.get('event.timestamp'))
        const inputTokens = readTokenCount(attributes.get('input_tokens'))
        const outputTokens = readTokenCount(attributes.get('output_tokens'))
        const cacheReadTokens = readTokenCount(attributes.get('cache_read_tokens'))
        const cacheCreationTokens = readTokenCount(attributes.get('cache_creation_tokens'))
        // Newer Claude Code versions also send the cost in micro-dollars, which avoids float rounding.
        const costMicros = readNonNegativeNumber(attributes.get('cost_usd_micros'), maximumCostUsdPerRequest * 1_000_000)
        const costUsd = !attributes.has('cost_usd_micros')
          ? readNonNegativeNumber(attributes.get('cost_usd'), maximumCostUsdPerRequest)
          : costMicros === undefined ? undefined : costMicros / 1_000_000
        if (
          occurredAtMs === undefined || occurredAtMs < oldest || occurredAtMs > newest ||
          inputTokens === undefined || outputTokens === undefined ||
          cacheReadTokens === undefined || cacheCreationTokens === undefined || costUsd === undefined
        ) {
          rejectedRecords += 1
          continue
        }
        events.push({
          // A record attribute wins, so one exporter can serve several instances.
          instanceIdHash: readInstanceHash(
            attributes.get(AGENT_TELEMETRY_INSTANCE_ATTRIBUTE) ?? resourceAttributes.get(AGENT_TELEMETRY_INSTANCE_ATTRIBUTE),
          ),
          occurredAtMs,
          model: readModel(attributes.get('model')),
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          costMicroUsd: Math.round(costUsd * 1_000_000),
        })
      }
    }
  }
  return { events, rejectedRecords }
}

/**
 * Formats the start of the bucket that holds a time.
 *
 * @param epochMs - Time in epoch milliseconds.
 * @returns Bucket start such as `2026-11-22T17:05:10Z`.
 */
export function formatUsageBucketStart(epochMs: number): string {
  const bucketMs = AGENT_USAGE_BUCKET_SECONDS * 1_000
  return `${new Date(Math.floor(epochMs / bucketMs) * bucketMs).toISOString().slice(0, 19)}Z`
}

/**
 * Adds usage events together by agent instance, model, and bucket.
 *
 * @param events - Accepted usage events.
 * @returns Buckets sorted by start, instance, and model.
 */
export function groupAgentUsageBuckets(events: readonly AgentUsageEvent[]): AgentUsageBucket[] {
  const buckets = new Map<string, AgentUsageBucket>()
  for (const event of events) {
    const bucketStart = formatUsageBucketStart(event.occurredAtMs)
    const key = `${bucketStart}#${event.instanceIdHash}#${event.model}`
    const bucket = buckets.get(key) ?? {
      bucketStart,
      instanceIdHash: event.instanceIdHash,
      model: event.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costMicroUsd: 0,
      requestCount: 0,
    }
    bucket.inputTokens += event.inputTokens
    bucket.outputTokens += event.outputTokens
    bucket.cacheReadTokens += event.cacheReadTokens
    bucket.cacheCreationTokens += event.cacheCreationTokens
    bucket.costMicroUsd += event.costMicroUsd
    bucket.requestCount += 1
    buckets.set(key, bucket)
  }
  return [...buckets.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, bucket]) => bucket)
}

/**
 * Derives a stable ID for one export from its member and accepted events, so a retried export is
 * recognized and not counted twice.
 *
 * @param memberKey - Member that sent the export.
 * @param events - Accepted usage events in export order.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function deriveAgentTelemetryBatchId(memberKey: string, events: readonly AgentUsageEvent[]): string {
  const hash = createHash('sha256').update(`agent-telemetry-batch\u0000${memberKey}`)
  for (const event of events) {
    hash.update([
      '',
      event.instanceIdHash,
      String(event.occurredAtMs),
      event.model,
      String(event.inputTokens),
      String(event.outputTokens),
      String(event.cacheReadTokens),
      String(event.cacheCreationTokens),
      String(event.costMicroUsd),
    ].join('\u0000'))
  }
  return hash.digest('hex')
}

/** Run fields that decide which usage buckets belong to it. */
export type AgentUsageRunWindow = {
  /** Instance hash of the run. */
  instanceIdHash: string
  /** Run start. */
  startedAt: string
  /** Run finish, when the run finished. */
  finishedAt?: string
}

/**
 * Returns the bucket range of a run: from the bucket holding its start up to, but not including,
 * the bucket holding its finish. Two runs of one instance that follow each other therefore never
 * share a bucket. An active run has no end.
 *
 * @param run - Run window.
 * @returns First bucket start and the exclusive end bucket start, when the run finished.
 */
export function agentUsageRunBucketRange(run: AgentUsageRunWindow): { from: string; until?: string } {
  return {
    from: formatUsageBucketStart(Date.parse(run.startedAt)),
    ...(run.finishedAt === undefined ? {} : { until: formatUsageBucketStart(Date.parse(run.finishedAt)) }),
  }
}

/**
 * Checks whether a bucket belongs to a run.
 *
 * @param bucket - Usage bucket of the run's member.
 * @param run - Run window.
 * @returns True when the bucket names the run's instance and starts inside its range.
 */
export function isAgentUsageBucketInRun(bucket: Pick<AgentUsageBucket, 'bucketStart' | 'instanceIdHash'>, run: AgentUsageRunWindow): boolean {
  if (bucket.instanceIdHash !== run.instanceIdHash) return false
  const range = agentUsageRunBucketRange(run)
  return bucket.bucketStart >= range.from && (range.until === undefined || bucket.bucketStart < range.until)
}

/**
 * Adds usage buckets together for a response.
 *
 * @param buckets - Buckets to add.
 * @param includeCost - Whether the viewer may see the estimated cost.
 * @param hasMore - Whether more buckets existed than were read.
 * @returns The summary, or undefined when there is nothing to report.
 */
export function summarizeAgentUsage(
  buckets: readonly Pick<AgentUsageBucket, 'model' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'costMicroUsd' | 'requestCount'>[],
  includeCost: boolean,
  hasMore: boolean,
): AgentRunUsage | undefined {
  if (buckets.length === 0) return undefined
  const models = new Set<string>()
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 0, costMicroUsd: 0 }
  for (const bucket of buckets) {
    models.add(bucket.model)
    usage.inputTokens += bucket.inputTokens
    usage.outputTokens += bucket.outputTokens
    usage.cacheReadTokens += bucket.cacheReadTokens
    usage.cacheCreationTokens += bucket.cacheCreationTokens
    usage.requestCount += bucket.requestCount
    usage.costMicroUsd += bucket.costMicroUsd
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    requestCount: usage.requestCount,
    ...(includeCost ? { estimatedCostMicroUsd: usage.costMicroUsd } : {}),
    models: [...models].sort(),
    hasMore,
  }
}

/**
 * Adds run usage summaries together.
 *
 * @param usages - Summaries of individual runs.
 * @returns The combined summary, or undefined when no run has usage.
 */
export function combineAgentRunUsage(usages: readonly (AgentRunUsage | undefined)[]): AgentRunUsage | undefined {
  const present = usages.filter((usage): usage is AgentRunUsage => usage !== undefined)
  if (present.length === 0) return undefined
  const includeCost = present.every((usage) => usage.estimatedCostMicroUsd !== undefined)
  const models = new Set(present.flatMap((usage) => usage.models))
  return {
    inputTokens: present.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: present.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cacheReadTokens: present.reduce((sum, usage) => sum + usage.cacheReadTokens, 0),
    cacheCreationTokens: present.reduce((sum, usage) => sum + usage.cacheCreationTokens, 0),
    requestCount: present.reduce((sum, usage) => sum + usage.requestCount, 0),
    ...(includeCost ? { estimatedCostMicroUsd: present.reduce((sum, usage) => sum + (usage.estimatedCostMicroUsd ?? 0), 0) } : {}),
    models: [...models].sort(),
    hasMore: present.some((usage) => usage.hasMore),
  }
}
