import type {
  AiAssistanceGenerationRequestObservation,
  AiAssistanceProjectionObservability,
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
  /** Optional full deployed application commit SHA used for release evidence attribution. */
  applicationCommitSha?: string
}

const AI_ASSISTANCE_METRIC_NAMESPACE = 'Mukuroji/AIAssistance'
const AI_ASSISTANCE_SERVICE = 'mukuroji-ai-assistance'
const UNAVAILABLE_APPLICATION_COMMIT_SHA = 'unavailable'
const UNKNOWN_MODEL_DIMENSION = 'other'

/**
 * Creates the content-free EMF adapter used by the AI assistance service.
 *
 * @param options - Optional sink, deterministic clock, and deployment provenance.
 * @returns Observation callbacks for request, provider, decision, and projection metrics.
 */
export function createAiAssistanceEmfObservability(
  options: AiAssistanceEmfObservabilityOptions = {},
): AiAssistanceProjectionObservability {
  const sink = options.sink ?? writeStandardOutput
  const nowMilliseconds = options.nowMilliseconds ?? Date.now
  const applicationCommitSha = readApplicationCommitSha(
    options.applicationCommitSha,
  )

  return {
    recordGenerationRequest(observation) {
      recordGenerationRequest(
        observation,
        applicationCommitSha,
        nowMilliseconds(),
        sink,
      )
    },
    recordProviderAttempt(observation) {
      recordProviderAttempt(
        observation,
        applicationCommitSha,
        nowMilliseconds(),
        sink,
      )
    },
    recordDecision(observation) {
      recordDecision(
        observation,
        applicationCommitSha,
        nowMilliseconds(),
        sink,
      )
    },
    recordProjectionFailures(failureCount) {
      recordProjectionFailures(
        failureCount,
        applicationCommitSha,
        nowMilliseconds(),
        sink,
      )
    },
  }
}

/** Writes one generation-request EMF record with bounded dimensions. */
function recordGenerationRequest(
  observation: AiAssistanceGenerationRequestObservation,
  applicationCommitSha: string,
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
          ['Service', 'ApplicationCommitSha'],
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
    ApplicationCommitSha: applicationCommitSha,
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
  applicationCommitSha: string,
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
          ['Service', 'ApplicationCommitSha'],
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
    ApplicationCommitSha: applicationCommitSha,
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
  applicationCommitSha: string,
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
          ['Service', 'ApplicationCommitSha'],
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
    ApplicationCommitSha: applicationCommitSha,
    task: observation.task,
    Task: observation.task,
    outcome: observation.outcome,
    Outcome: observation.outcome,
    DecisionCount: 1,
    DecisionApprovedCount: observation.outcome === 'approved' ? 1 : 0,
    DecisionRejectedCount: observation.outcome === 'rejected' ? 1 : 0,
  }))
}

/** Writes one aggregate count for records returned through partial-batch retry. */
function recordProjectionFailures(
  failureCount: number,
  applicationCommitSha: string,
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
          ['Service', 'ApplicationCommitSha'],
        ],
        Metrics: [{ Name: 'ProjectionFailureCount', Unit: 'Count' }],
      }],
    },
    event: 'ai-assistance.observability.projection-failed',
    service: AI_ASSISTANCE_SERVICE,
    Service: AI_ASSISTANCE_SERVICE,
    ApplicationCommitSha: applicationCommitSha,
    ProjectionFailureCount: readNonNegativeMetric(failureCount),
  }))
}

/**
 * Returns one bounded release-attribution dimension or rejects malformed input.
 *
 * @param value - Optional full lowercase Git commit SHA.
 * @returns Validated commit SHA or the bounded unavailable marker.
 */
function readApplicationCommitSha(value: string | undefined): string {
  if (value === undefined) return UNAVAILABLE_APPLICATION_COMMIT_SHA
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError(
      'applicationCommitSha must be one full lowercase 40-character Git commit SHA.',
    )
  }
  return value
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
