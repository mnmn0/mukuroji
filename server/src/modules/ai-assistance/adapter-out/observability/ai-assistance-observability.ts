import type {
  AiAssistanceGenerationRequestObservation,
  AiAssistanceObservability,
  AiAssistanceProviderAttemptObservation,
  AiAssistanceDecisionObservation,
} from '../../application/ports/ai-assistance-ports'

/** Destination for one serialized, content-free AI assistance EMF record. */
export type StructuredAiAssistanceLogSink = (
  /** Secret-free serialized record. */
  serializedRecord: string,
) => void

/** Testable runtime dependencies for the AI assistance EMF adapter. */
export type AiAssistanceEmfObservabilityOptions = {
  /** Optional serialized-record destination. */
  sink?: StructuredAiAssistanceLogSink
  /** Optional millisecond clock used for EMF timestamps. */
  nowMilliseconds?: () => number
}

const AI_ASSISTANCE_METRIC_NAMESPACE = 'Mukuroji/AIAssistance'
const AI_ASSISTANCE_SERVICE = 'mukuroji-ai-assistance'
const UNKNOWN_MODEL_DIMENSION = 'other'

/**
 * Creates the content-free EMF adapter used by the AI assistance service.
 *
 * @param options - Optional sink and deterministic clock.
 * @returns Failure-independent observation callbacks for request, provider, and decision metrics.
 */
export function createAiAssistanceEmfObservability(
  options: AiAssistanceEmfObservabilityOptions = {},
): AiAssistanceObservability {
  const sink = options.sink ?? writeStandardOutput
  const nowMilliseconds = options.nowMilliseconds ?? Date.now

  return {
    recordGenerationRequest(observation) {
      recordGenerationRequest(observation, nowMilliseconds(), sink)
    },
    recordProviderAttempt(observation) {
      recordProviderAttempt(observation, nowMilliseconds(), sink)
    },
    recordDecision(observation) {
      recordDecision(observation, nowMilliseconds(), sink)
    },
  }
}

/** Writes one generation-request EMF record with bounded dimensions. */
function recordGenerationRequest(
  observation: AiAssistanceGenerationRequestObservation,
  observedAtMilliseconds: number,
  sink: StructuredAiAssistanceLogSink,
): void {
  const latencyMs = readNonNegativeMetric(observation.latencyMs)
  sink(JSON.stringify({
    _aws: {
      Timestamp: readTimestamp(observedAtMilliseconds),
      CloudWatchMetrics: [{
        Namespace: AI_ASSISTANCE_METRIC_NAMESPACE,
        Dimensions: [
          ['Service'],
          ['Service', 'Task'],
          ['Service', 'Task', 'Outcome'],
        ],
        Metrics: [
          { Name: 'GenerationRequestCount', Unit: 'Count' },
          { Name: 'GenerationSuccessCount', Unit: 'Count' },
          { Name: 'GenerationReplayCount', Unit: 'Count' },
          { Name: 'GenerationFailureCount', Unit: 'Count' },
          { Name: 'GenerationLatency', Unit: 'Milliseconds' },
        ],
      }],
    },
    event: 'ai-assistance.generation.completed',
    service: AI_ASSISTANCE_SERVICE,
    Service: AI_ASSISTANCE_SERVICE,
    task: observation.task,
    Task: observation.task,
    outcome: observation.outcome,
    Outcome: observation.outcome,
    replayed: observation.replayed,
    ...(observation.failureCategory === undefined
      ? {}
      : { failureCategory: observation.failureCategory }),
    ...(observation.failureCode === undefined
      ? {}
      : { failureCode: observation.failureCode }),
    GenerationRequestCount: 1,
    GenerationSuccessCount: observation.outcome === 'succeeded' ? 1 : 0,
    GenerationReplayCount: observation.replayed ? 1 : 0,
    GenerationFailureCount: observation.outcome === 'failed' ? 1 : 0,
    GenerationLatency: latencyMs,
  }))
}

/** Writes one durably finalized provider-attempt EMF record. */
function recordProviderAttempt(
  observation: AiAssistanceProviderAttemptObservation,
  observedAtMilliseconds: number,
  sink: StructuredAiAssistanceLogSink,
): void {
  const inputTokens = observation.usage?.inputTokens
  const outputTokens = observation.usage?.outputTokens
  const estimatedCostUsd = observation.usage?.costUsd
  const usageUnavailable = observation.usage === undefined ||
      inputTokens === undefined ||
      outputTokens === undefined ||
      estimatedCostUsd === undefined
    ? 1
    : 0
  const usageUnavailableReason = observation.usageUnavailableReason ??
    (usageUnavailable === 1 ? 'token-or-cost-missing' : undefined)
  const failed = observation.outcome === 'succeeded' ? 0 : 1
  sink(JSON.stringify({
    _aws: {
      Timestamp: readTimestamp(observedAtMilliseconds),
      CloudWatchMetrics: [{
        Namespace: AI_ASSISTANCE_METRIC_NAMESPACE,
        Dimensions: [
          ['Service'],
          ['Service', 'Task'],
          ['Service', 'Task', 'Outcome'],
          ['Service', 'Task', 'Outcome', 'Model'],
        ],
        Metrics: [
          { Name: 'ProviderAttemptCount', Unit: 'Count' },
          { Name: 'ProviderSuccessCount', Unit: 'Count' },
          { Name: 'ProviderFailureCount', Unit: 'Count' },
          { Name: 'ProviderThrottledCount', Unit: 'Count' },
          { Name: 'ProviderTimeoutCount', Unit: 'Count' },
          { Name: 'ProviderRefusedCount', Unit: 'Count' },
          { Name: 'ProviderInvalidOutputCount', Unit: 'Count' },
          ...(observation.latencyMs === undefined
            ? []
            : [{ Name: 'ProviderLatency', Unit: 'Milliseconds' }]),
          { Name: 'UsageUnavailableCount', Unit: 'Count' },
          ...(inputTokens === undefined
            ? []
            : [{ Name: 'InputTokenCount', Unit: 'Count' }]),
          ...(outputTokens === undefined
            ? []
            : [{ Name: 'OutputTokenCount', Unit: 'Count' }]),
          ...(estimatedCostUsd === undefined
            ? []
            : [{ Name: 'EstimatedCostUsd', Unit: 'None' }]),
        ],
      }],
    },
    event: 'ai-assistance.provider-attempt.finalized',
    service: AI_ASSISTANCE_SERVICE,
    Service: AI_ASSISTANCE_SERVICE,
    task: observation.task,
    Task: observation.task,
    outcome: observation.outcome,
    Outcome: observation.outcome,
    model: readModelDimension(observation.modelId),
    Model: readModelDimension(observation.modelId),
    ...(observation.failureCategory === undefined
      ? {}
      : { failureCategory: observation.failureCategory }),
    ...(observation.failureCode === undefined
      ? {}
      : { failureCode: observation.failureCode }),
    ...(observation.outcome === 'refused'
      ? { refusalReason: 'content-filter' }
      : {}),
    ...(usageUnavailableReason === undefined
      ? {}
      : { usageUnavailableReason }),
    ProviderAttemptCount: 1,
    ProviderSuccessCount: observation.outcome === 'succeeded' ? 1 : 0,
    ProviderFailureCount: failed,
    ProviderThrottledCount: observation.outcome === 'throttled' ? 1 : 0,
    ProviderTimeoutCount: observation.outcome === 'timeout' ? 1 : 0,
    ProviderRefusedCount: observation.outcome === 'refused' ? 1 : 0,
    ProviderInvalidOutputCount: observation.outcome === 'invalid-output' ? 1 : 0,
    ...(observation.latencyMs === undefined
      ? {}
      : { ProviderLatency: readNonNegativeMetric(observation.latencyMs) }),
    UsageUnavailableCount: usageUnavailable,
    ...(inputTokens === undefined
      ? {}
      : { InputTokenCount: readNonNegativeMetric(inputTokens) }),
    ...(outputTokens === undefined
      ? {}
      : { OutputTokenCount: readNonNegativeMetric(outputTokens) }),
    ...(estimatedCostUsd === undefined
      ? {}
      : { EstimatedCostUsd: readNonNegativeMetric(estimatedCostUsd) }),
  }))
}

/** Writes one newly persisted human-decision EMF record. */
function recordDecision(
  observation: AiAssistanceDecisionObservation,
  observedAtMilliseconds: number,
  sink: StructuredAiAssistanceLogSink,
): void {
  sink(JSON.stringify({
    _aws: {
      Timestamp: readTimestamp(observedAtMilliseconds),
      CloudWatchMetrics: [{
        Namespace: AI_ASSISTANCE_METRIC_NAMESPACE,
        Dimensions: [
          ['Service'],
          ['Service', 'Task'],
          ['Service', 'Task', 'Outcome'],
        ],
        Metrics: [
          { Name: 'DecisionCount', Unit: 'Count' },
          { Name: 'DecisionApprovedCount', Unit: 'Count' },
          { Name: 'DecisionRejectedCount', Unit: 'Count' },
        ],
      }],
    },
    event: 'ai-assistance.decision.recorded',
    service: AI_ASSISTANCE_SERVICE,
    Service: AI_ASSISTANCE_SERVICE,
    task: observation.task,
    Task: observation.task,
    outcome: observation.outcome,
    Outcome: observation.outcome,
    DecisionCount: 1,
    DecisionApprovedCount: observation.outcome === 'approved' ? 1 : 0,
    DecisionRejectedCount: observation.outcome === 'rejected' ? 1 : 0,
  }))
}

/** Returns a finite non-negative metric value or a safe zero fallback. */
function readNonNegativeMetric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** Returns a valid millisecond timestamp or the Unix epoch fallback. */
function readTimestamp(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Returns a bounded model dimension without accepting arbitrary log content. */
function readModelDimension(value: string): string {
  const candidate = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u.test(candidate)
    ? candidate
    : UNKNOWN_MODEL_DIMENSION
}

/** Writes one serialized observation to standard output. */
function writeStandardOutput(serializedRecord: string): void {
  console.log(serializedRecord)
}
