import type {
  AutomationExecution,
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

/**
 * How long a reserved rule execution may stay `pending` before the schedule worker recovers it,
 * in case the worker that reserved it stopped before claiming it.
 */
export const AUTOMATION_PENDING_EXECUTION_RECOVERY_DELAY_MS = 5 * 60_000

/**
 * Returns when a `pending` rule execution becomes due for recovery.
 *
 * @param execution - Reserved execution.
 * @returns The UTC ISO 8601 recovery time.
 */
export function getPendingExecutionRecoveryAt(execution: AutomationExecution): string {
  return new Date(Date.parse(execution.startedAt) + AUTOMATION_PENDING_EXECUTION_RECOVERY_DELAY_MS).toISOString()
}
