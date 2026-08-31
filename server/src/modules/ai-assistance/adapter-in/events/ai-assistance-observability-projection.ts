import type {
  AiAssistanceTask,
  AiAssistanceUsage,
} from '@mukuroji/contracts'
import { z } from 'zod'
import type {
  BatchItemFailure,
  BatchResponse,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'
import type {
  AiAssistanceDecisionObservation,
  AiAssistanceObservability,
  AiAssistanceProviderAttemptObservation,
  AiAssistanceProviderAttemptOutcome,
} from '../../application/ports/ai-assistance-ports'

const nonNegativeIntegerAttributeSchema = z.object({
  N: z.string().regex(/^(0|[1-9]\d*)$/),
}).strict()
const nonNegativeNumberAttributeSchema = z.object({ N: z.string().min(1) }).strict()
const isoInstantAttributeSchema = z.object({
  S: z.string().datetime({ offset: true }),
}).strict()
const taskAttributeSchema = z.object({
  S: z.enum(['triage', 'summary', 'search', 'planning']),
}).strict()
const providerOutcomeAttributeSchema = z.object({
  S: z.enum([
    'succeeded',
    'failed',
    'throttled',
    'timeout',
    'refused',
    'invalid-output',
    'indeterminate',
  ]),
}).strict()
const errorCategoryAttributeSchema = z.object({
  S: z.enum([
    'validation',
    'authentication',
    'authorization',
    'not-found',
    'conflict',
    'rate-limit',
    'upstream',
    'timeout',
  ]),
}).strict()
const errorCodeAttributeSchema = z.object({
  S: z.enum([
    'InvalidAiAssistanceRequest',
    'InvalidAiAssistanceOutput',
    'AiAssistanceOutputNotAllowed',
    'AiAssistanceCitationInvalid',
    'AiAssistanceAuthenticationRequired',
    'AiAssistanceDisabled',
    'AiAssistancePreferenceDisabled',
    'AiAssistanceTaskDisabled',
    'AiAssistanceModelNotAllowed',
    'AiAssistanceAuthorizationChanged',
    'AiAssistanceSourceChanged',
    'AiAssistanceGenerationNotFound',
    'AiAssistanceRevisionConflict',
    'AiAssistanceIdempotencyKeyRequired',
    'AiAssistanceIdempotencyConflict',
    'AiAssistanceGenerationInProgress',
    'AiAssistanceRateLimitExceeded',
    'AiAssistanceDecisionAlreadyRecorded',
    'AiAssistanceAttemptFailed',
    'AiAssistancePersistenceError',
    'AiAssistanceModelRefused',
    'AiAssistanceProviderError',
    'AiAssistanceProviderRateLimited',
    'AiAssistanceProviderTimeout',
    'InvalidAiAssistanceRecord',
  ]),
}).strict()

const usageAttributeSchema = z.object({
  M: z.object({
    inputTokens: nonNegativeIntegerAttributeSchema.optional(),
    outputTokens: nonNegativeIntegerAttributeSchema.optional(),
    latencyMs: nonNegativeIntegerAttributeSchema,
    costUsd: nonNegativeNumberAttributeSchema.optional(),
    costUnavailableReason: z.object({
      S: z.enum(['provider-not-reported', 'pricing-not-configured']),
    }).strict().optional(),
  }).passthrough(),
}).strict()

const attemptAttributeSchema = z.object({
  M: z.object({
    task: taskAttributeSchema,
    modelId: z.object({ S: z.string().min(1).max(256) }).strict(),
    status: z.object({ S: z.enum(['succeeded', 'failed']) }).strict(),
    endedAt: isoInstantAttributeSchema,
    latencyMs: nonNegativeIntegerAttributeSchema.optional(),
    usage: usageAttributeSchema.optional(),
    usageUnavailableReason: z.object({
      S: z.enum([
        'provider-did-not-report',
        'attempt-outcome-indeterminate',
      ]),
    }).strict().optional(),
    providerOutcome: providerOutcomeAttributeSchema.optional(),
    failureCategory: errorCategoryAttributeSchema.optional(),
    failureCode: errorCodeAttributeSchema.optional(),
  }).passthrough(),
}).strict()

const terminalReceiptImageSchema = z.object({
  recordType: z.object({
    S: z.literal('ai-assistance-generation-idempotency'),
  }).strict(),
  status: z.object({ S: z.enum(['completed', 'failed']) }).strict(),
  attempt: attemptAttributeSchema.optional(),
  failedAt: isoInstantAttributeSchema.optional(),
  failureCategory: errorCategoryAttributeSchema.optional(),
  failureCode: errorCodeAttributeSchema.optional(),
}).passthrough()

const decidedGenerationImageSchema = z.object({
  recordType: z.object({ S: z.literal('ai-assistance-generation') }).strict(),
  generation: z.object({
    M: z.object({
      task: taskAttributeSchema,
      decision: z.object({
        M: z.object({
          outcome: z.object({ S: z.enum(['approved', 'rejected']) }).strict(),
          decidedAt: isoInstantAttributeSchema,
        }).passthrough(),
      }).strict(),
    }).passthrough(),
  }).strict(),
}).passthrough()

/** Stable, content-free classification for one projection failure. */
type ProjectionFailureCategory =
  | 'malformed-record'
  | 'observability-sink'
  | 'unexpected'

/** Internal projection error that carries only a bounded failure category. */
class ProjectionFailure extends Error {
  /** Bounded failure category that is safe to include in operational logs. */
  readonly category: ProjectionFailureCategory

  /**
   * Creates one content-free projection failure.
   *
   * @param category - Stable category describing the failed projection stage.
   */
  constructor(category: ProjectionFailureCategory) {
    super('AI assistance observability projection failed.')
    this.name = 'AiAssistanceObservabilityProjectionError'
    this.category = category
  }
}

/**
 * Projects durable terminal AI metadata into content-free operational metrics.
 *
 * @remarks DynamoDB Streams delivery is at least once. A record can be
 * redelivered after a timeout or partial failure, so its EMF metric can be
 * emitted more than once even though the originating terminal mutation is
 * protected by a durable conditional write.
 * @param event - Workspace Search table stream batch containing NEW_IMAGE values.
 * @param observability - Content-free AI assistance observation boundary.
 * @returns Per-record failures that Lambda can retry without discarding the batch.
 */
export async function processAiAssistanceObservabilityBatch(
  event: DynamoStreamEvent,
  observability: AiAssistanceObservability,
): Promise<BatchResponse> {
  const batchItemFailures: BatchItemFailure[] = []

  for (const record of event.Records ?? []) {
    try {
      processAiAssistanceObservabilityRecord(record, observability)
    } catch (error: unknown) {
      logProjectionFailure(readProjectionFailureCategory(error))
      batchItemFailures.push(createBatchItemFailure(record))
    }
  }

  return { batchItemFailures }
}

/**
 * Projects one relevant stream record without retaining identifiers or content.
 *
 * @param record - Candidate DynamoDB stream record.
 * @param observability - Content-free AI assistance observation boundary.
 */
function processAiAssistanceObservabilityRecord(
  record: DynamoStreamRecord,
  observability: AiAssistanceObservability,
): void {
  const providerAttempt = readProviderAttemptObservation(record)
  if (providerAttempt) {
    try {
      observability.recordProviderAttempt(providerAttempt)
    } catch {
      throw new ProjectionFailure('observability-sink')
    }
    return
  }

  const decision = readDecisionObservation(record)
  if (decision) {
    try {
      observability.recordDecision(decision)
    } catch {
      throw new ProjectionFailure('observability-sink')
    }
  }
}

/**
 * Reads metric-safe provider metadata from a terminal idempotency receipt.
 *
 * @param record - Candidate DynamoDB stream record.
 * @returns A provider observation, or undefined for an unrelated/no-provider record.
 */
function readProviderAttemptObservation(
  record: DynamoStreamRecord,
): AiAssistanceProviderAttemptObservation | undefined {
  if (!isNewImageMutation(record)) return undefined
  const image = record.dynamodb?.NewImage
  if (image?.recordType?.S !== 'ai-assistance-generation-idempotency') {
    return undefined
  }
  if (image.status?.S !== 'completed' && image.status?.S !== 'failed') {
    return undefined
  }

  const parsed = terminalReceiptImageSchema.safeParse(image)
  if (!parsed.success) throw malformedProjectionRecord()
  const receipt = parsed.data
  const outerFailureCategory = receipt.failureCategory?.S
  const outerFailureCode = receipt.failureCode?.S
  const hasCompleteOuterFailure = receipt.failedAt !== undefined &&
    outerFailureCategory !== undefined && outerFailureCode !== undefined
  const hasAnyOuterFailure = receipt.failedAt !== undefined ||
    outerFailureCategory !== undefined || outerFailureCode !== undefined

  if (
    (receipt.status.S === 'completed' && hasAnyOuterFailure) ||
    (receipt.status.S === 'failed' && !hasCompleteOuterFailure)
  ) {
    throw malformedProjectionRecord()
  }
  if (!receipt.attempt) {
    if (receipt.status.S === 'completed') throw malformedProjectionRecord()
    return undefined
  }

  const attempt = receipt.attempt.M
  const attemptFailureCategory = attempt.failureCategory?.S
  const attemptFailureCode = attempt.failureCode?.S
  const hasCompleteAttemptFailure = attemptFailureCategory !== undefined &&
    attemptFailureCode !== undefined
  const hasAnyAttemptFailure = attemptFailureCategory !== undefined ||
    attemptFailureCode !== undefined
  const usage = attempt.usage === undefined
    ? undefined
    : readUsage(attempt.usage.M)
  const hasUsageUnavailableReason = attempt.usageUnavailableReason !== undefined
  const hasIndeterminateOutcome = attempt.providerOutcome?.S === 'indeterminate'

  if (
    (attempt.status.S === 'succeeded' && (
      receipt.status.S !== 'completed' ||
      attempt.providerOutcome?.S !== 'succeeded' ||
      attempt.latencyMs === undefined ||
      usage === undefined ||
      hasUsageUnavailableReason ||
      hasAnyAttemptFailure
    )) ||
    (attempt.status.S === 'failed' && (
      receipt.status.S !== 'failed' ||
      !hasCompleteAttemptFailure ||
      attemptFailureCategory !== outerFailureCategory ||
      attemptFailureCode !== outerFailureCode ||
      (usage === undefined) === !hasUsageUnavailableReason ||
      (hasIndeterminateOutcome
        ? attempt.latencyMs !== undefined ||
          attempt.usageUnavailableReason?.S !== 'attempt-outcome-indeterminate'
        : attempt.latencyMs === undefined ||
          attempt.usageUnavailableReason?.S === 'attempt-outcome-indeterminate') ||
      !isProviderOutcomeCompatibleWithFailure(
        attempt.providerOutcome?.S,
        attemptFailureCode,
      )
    ))
  ) {
    throw malformedProjectionRecord()
  }

  const providerOutcome = attempt.providerOutcome?.S
  if (providerOutcome === undefined) return undefined
  return createProviderAttemptObservation(
    attempt.task.S,
    attempt.modelId.S,
    providerOutcome,
    attempt.latencyMs === undefined
      ? undefined
      : readNonNegativeInteger(attempt.latencyMs.N),
    usage,
    attempt.usageUnavailableReason?.S,
    attemptFailureCategory,
    attemptFailureCode,
  )
}

/** Checks that one projected provider outcome agrees with its stable failure code. */
function isProviderOutcomeCompatibleWithFailure(
  providerOutcome: AiAssistanceProviderAttemptOutcome | undefined,
  failureCode: AiAssistanceProviderAttemptObservation['failureCode'],
): boolean {
  if (failureCode === undefined) return providerOutcome === undefined
  if (
    failureCode === 'InvalidAiAssistanceOutput' ||
    failureCode === 'AiAssistanceCitationInvalid' ||
    failureCode === 'AiAssistanceOutputNotAllowed'
  ) return providerOutcome === 'invalid-output'
  if (failureCode === 'AiAssistanceProviderRateLimited') {
    return providerOutcome === 'throttled'
  }
  if (failureCode === 'AiAssistanceModelRefused') {
    return providerOutcome === 'refused'
  }
  if (failureCode === 'AiAssistanceProviderTimeout') {
    return providerOutcome === undefined || providerOutcome === 'timeout'
  }
  if (failureCode === 'AiAssistanceProviderError') {
    return providerOutcome === 'failed'
  }
  if (
    failureCode === 'AiAssistanceAttemptFailed' ||
    failureCode === 'AiAssistancePersistenceError' ||
    failureCode === 'AiAssistanceIdempotencyConflict' ||
    failureCode === 'InvalidAiAssistanceRecord'
  ) {
    return providerOutcome === undefined ||
      providerOutcome === 'succeeded' ||
      providerOutcome === 'failed' ||
      providerOutcome === 'indeterminate'
  }
  return providerOutcome === undefined ||
    providerOutcome === 'succeeded' ||
    providerOutcome === 'failed'
}

/**
 * Creates one observation from already validated terminal attempt metadata.
 *
 * @param task - AI product workflow.
 * @param modelId - Deployment-allowlisted model identifier.
 * @param outcome - Durable provider outcome.
 * @param latencyMs - Durable provider latency when dispatch completion is known.
 * @param usage - Validated provider usage when available.
 * @param durableUsageUnavailableReason - Persisted bounded unavailable reason.
 * @param failureCategory - Stable pipeline failure category when applicable.
 * @param failureCode - Stable pipeline failure code when applicable.
 * @returns Content-free provider observation.
 */
function createProviderAttemptObservation(
  task: AiAssistanceTask,
  modelId: string,
  outcome: AiAssistanceProviderAttemptOutcome,
  latencyMs: number | undefined,
  usage: AiAssistanceUsage | undefined,
  durableUsageUnavailableReason:
    | 'provider-did-not-report'
    | 'attempt-outcome-indeterminate'
    | undefined,
  failureCategory: AiAssistanceProviderAttemptObservation['failureCategory'],
  failureCode: AiAssistanceProviderAttemptObservation['failureCode'],
): AiAssistanceProviderAttemptObservation {
  const usageUnavailableReason = usage === undefined
    ? durableUsageUnavailableReason ?? 'provider-did-not-report'
    : usage.inputTokens === undefined ||
        usage.outputTokens === undefined ||
        usage.costUsd === undefined
      ? 'token-or-cost-missing'
      : undefined
  return {
    task,
    modelId,
    outcome,
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(usage === undefined ? {} : { usage }),
    ...(usageUnavailableReason === undefined ? {} : { usageUnavailableReason }),
    ...(failureCategory === undefined ? {} : { failureCategory }),
    ...(failureCode === undefined ? {} : { failureCode }),
  }
}

/**
 * Reads provider usage from a DynamoDB map after its structural validation.
 *
 * @param usage - Structurally validated usage attributes.
 * @returns Strict public provider usage metadata.
 */
function readUsage(usage: z.output<typeof usageAttributeSchema>['M']): AiAssistanceUsage {
  const inputTokens = usage.inputTokens === undefined
    ? undefined
    : readNonNegativeInteger(usage.inputTokens.N)
  const outputTokens = usage.outputTokens === undefined
    ? undefined
    : readNonNegativeInteger(usage.outputTokens.N)
  const latencyMs = readNonNegativeInteger(usage.latencyMs.N)
  const costUsd = usage.costUsd === undefined
    ? undefined
    : readNonNegativeNumber(usage.costUsd.N)
  const costUnavailableReason = usage.costUnavailableReason?.S
  if ((costUsd === undefined) === (costUnavailableReason === undefined)) {
    throw malformedProjectionRecord()
  }
  if (costUsd !== undefined) {
    return {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      latencyMs,
      costUsd,
    }
  }
  if (costUnavailableReason === undefined) throw malformedProjectionRecord()
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    latencyMs,
    costUnavailableReason,
  }
}

/**
 * Reads one durable human decision from an AI generation NEW_IMAGE.
 *
 * @param record - Candidate DynamoDB stream record.
 * @returns A decision observation, or undefined when no decision is present.
 */
function readDecisionObservation(
  record: DynamoStreamRecord,
): AiAssistanceDecisionObservation | undefined {
  if (!isNewImageMutation(record)) return undefined
  const image = record.dynamodb?.NewImage
  if (image?.recordType?.S !== 'ai-assistance-generation') return undefined
  if (image.generation?.M?.decision === undefined) return undefined
  const parsed = decidedGenerationImageSchema.safeParse(image)
  if (!parsed.success) throw malformedProjectionRecord()
  return {
    task: parsed.data.generation.M.task.S,
    outcome: parsed.data.generation.M.decision.M.outcome.S,
  }
}

/** Returns whether a stream record can contain a post-mutation item image. */
function isNewImageMutation(record: DynamoStreamRecord): boolean {
  return record.eventName === 'INSERT' || record.eventName === 'MODIFY'
}

/** Parses one safe non-negative integer persisted as a DynamoDB number. */
function readNonNegativeInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw malformedProjectionRecord()
  return parsed
}

/** Parses one finite non-negative decimal persisted as a DynamoDB number. */
function readNonNegativeNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw malformedProjectionRecord()
  return parsed
}

/** Creates a content-free error for one matching malformed durable row. */
function malformedProjectionRecord(): Error {
  return new ProjectionFailure('malformed-record')
}

/** Creates the partial batch failure identity without exposing record content. */
function createBatchItemFailure(record: DynamoStreamRecord): BatchItemFailure {
  const sequenceNumber = record.dynamodb?.SequenceNumber
  if (!sequenceNumber) {
    throw new Error('AI assistance observability record is missing its sequence number.')
  }
  return { itemIdentifier: sequenceNumber }
}

/**
 * Returns a bounded category without exposing an unknown caught value.
 *
 * @param error - Unknown failure caught at the per-record boundary.
 * @returns Stable category safe for operational logs.
 */
function readProjectionFailureCategory(
  error: unknown,
): ProjectionFailureCategory {
  return error instanceof ProjectionFailure ? error.category : 'unexpected'
}

/**
 * Logs only stable projection metadata and never the raw image or caught error.
 *
 * @param category - Bounded stage classification for the failed projection.
 */
function logProjectionFailure(category: ProjectionFailureCategory): void {
  console.error('AI assistance observability projection failed.', {
    code: 'AiAssistanceObservabilityProjectionFailed',
    category,
  })
}
