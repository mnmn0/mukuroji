import type {
  AutomationRateLimit,
  AutomationRetryPolicy,
} from '@mukuroji/contracts'

/** Default retry policy shared by execution orchestration and recovery. */
export const DEFAULT_AUTOMATION_RETRY_POLICY: AutomationRetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 1_000,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
})

/** Default fixed-window rate limit applied to newly created rules. */
export const DEFAULT_AUTOMATION_RATE_LIMIT: AutomationRateLimit = Object.freeze({
  maxExecutions: 100,
  windowSeconds: 60,
})
