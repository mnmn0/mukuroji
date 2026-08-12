import { createHash } from 'node:crypto'
import { ExternalChatError } from './external-chat'

/** Default retry delay used when a provider schedule is absent or invalid. */
const DEFAULT_RETRY_DELAY_MS = 30_000

/** Maximum provider-controlled delay accepted by the local retry scheduler. */
const MAXIMUM_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000

/** Minimum deterministic local jitter added to a retry schedule. */
const MINIMUM_RETRY_JITTER_MS = 250

/** Inclusive deterministic jitter range above the minimum delay. */
const RETRY_JITTER_RANGE_MS = 1_001

/**
 * Produces a bounded canonical retry timestamp with stable operation-scoped jitter.
 *
 * Provider timestamps are accepted only when they are canonical, strictly future, and within the
 * local scheduling horizon. Invalid values fall back to the configured delay instead of creating
 * a hot loop, persistence failure, or unbounded starvation. The same operation and base schedule
 * always receive the same jitter so receipt replay remains deterministic.
 *
 * @param now - Canonical current server timestamp.
 * @param operationId - Stable logical operation identifier used for deterministic jitter.
 * @param providerRetryAt - Optional provider Retry-After timestamp.
 * @param fallbackDelayMs - Local fallback delay for an absent or invalid provider schedule.
 * @returns Canonical bounded retry timestamp.
 */
export function normalizeExternalChatRetryAt(
  now: string,
  operationId: string,
  providerRetryAt?: string,
  fallbackDelayMs = DEFAULT_RETRY_DELAY_MS,
): string {
  const nowMilliseconds = canonicalTimestampMilliseconds(now)
  const fallback = boundedFallbackDelay(fallbackDelayMs)
  const maximum = nowMilliseconds + MAXIMUM_RETRY_DELAY_MS
  const providerMilliseconds = providerRetryAt === undefined
    ? undefined
    : optionalCanonicalTimestampMilliseconds(providerRetryAt)
  const base = providerMilliseconds !== undefined &&
      providerMilliseconds > nowMilliseconds &&
      providerMilliseconds <= maximum
    ? providerMilliseconds
    : nowMilliseconds + fallback
  const jitter = deterministicRetryJitter(operationId)
  return new Date(Math.min(base + jitter, maximum)).toISOString()
}

/**
 * Parses a required canonical timestamp.
 *
 * @param value - Candidate server timestamp.
 * @returns Parsed epoch milliseconds.
 */
function canonicalTimestampMilliseconds(value: string): number {
  const parsed = optionalCanonicalTimestampMilliseconds(value)
  if (parsed === undefined) {
    throw new ExternalChatError(
      'ExternalChatValidationFailed',
      'The retry scheduler clock is invalid.',
    )
  }
  return parsed
}

/**
 * Parses a canonical millisecond-precision UTC timestamp when valid.
 *
 * @param value - Candidate timestamp.
 * @returns Parsed epoch milliseconds, or undefined for an invalid value.
 */
function optionalCanonicalTimestampMilliseconds(value: string): number | undefined {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : undefined
}

/**
 * Bounds a caller-provided fallback without accepting zero, negative, or unsafe intervals.
 *
 * @param value - Candidate fallback delay.
 * @returns Safe fallback delay.
 */
function boundedFallbackDelay(value: number): number {
  return Number.isSafeInteger(value) && value > 0 && value <= MAXIMUM_RETRY_DELAY_MS
    ? value
    : DEFAULT_RETRY_DELAY_MS
}

/**
 * Derives stable bounded jitter from a logical operation identifier.
 *
 * @param operationId - Stable operation identifier.
 * @returns Jitter interval in milliseconds.
 */
function deterministicRetryJitter(operationId: string): number {
  const prefix = createHash('sha256').update(operationId).digest().readUInt32BE(0)
  return MINIMUM_RETRY_JITTER_MS + (prefix % RETRY_JITTER_RANGE_MS)
}
