import type { AgentRunProblemReason } from '@mukuroji/contracts'

/** Generic Public API problem category an Agent Run error maps to. */
export type AgentRunErrorCategory =
  | 'validation_failed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'temporarily_unavailable'

/** HTTP status for each Agent Run error category. */
const statusByCategory: Record<AgentRunErrorCategory, number> = {
  validation_failed: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  temporarily_unavailable: 503,
}

/** Transport-independent Agent Run failure with a stable category and optional reason. */
export class AgentRunError extends Error {
  /** Generic problem category used by every API surface. */
  readonly category: AgentRunErrorCategory
  /** HTTP status derived from the category. */
  readonly status: number
  /** Agent Run specific reason reported to clients when the category alone is ambiguous. */
  readonly reason?: AgentRunProblemReason
  /** Request field the reason refers to, as a JSON Pointer. */
  readonly pointer?: string
  /** Seconds a client should wait before retrying a rate-limited request. */
  readonly retryAfterSeconds?: number

  /**
   * Creates an error from trusted, non-secret text.
   *
   * @param category - Generic problem category.
   * @param message - Safe description for clients.
   * @param options - Optional reason, field pointer, and retry delay.
   */
  constructor(
    category: AgentRunErrorCategory,
    message: string,
    options: {
      /** Agent Run specific reason. */
      reason?: AgentRunProblemReason
      /** JSON Pointer of the request field the reason refers to. */
      pointer?: string
      /** Seconds to wait before retrying. */
      retryAfterSeconds?: number
    } = {},
  ) {
    super(message)
    this.name = 'AgentRunError'
    this.category = category
    this.status = statusByCategory[category]
    this.reason = options.reason
    this.pointer = options.pointer
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

/**
 * Reports that another agent instance holds the Work Item claim.
 *
 * @param detail - Safe summary of the holding run.
 * @returns Conflict error with the `agent_run_conflict` reason.
 */
export function createAgentRunConflictError(detail?: string): AgentRunError {
  return new AgentRunError(
    'conflict',
    `Another agent instance holds this Work Item.${detail ? ` ${detail}` : ''} Inspect the task before continuing; do not take it over without the user's approval.`,
    { reason: 'agent_run_conflict', pointer: '/agentInstanceId' },
  )
}

/**
 * Reports that the referenced run is finished, released, or bound to another Work Item.
 *
 * @returns Conflict error with the `agent_run_not_active` reason.
 */
export function createAgentRunNotActiveError(): AgentRunError {
  return new AgentRunError(
    'conflict',
    'The Agent Run is no longer active for this Work Item. Stop working on it and report the situation to the user.',
    { reason: 'agent_run_not_active', pointer: '/agentRunId' },
  )
}

/**
 * Reports that the credential owner is not the member responsible for the run.
 *
 * @returns Forbidden error with the `agent_run_forbidden` reason.
 */
export function createAgentRunForbiddenError(): AgentRunError {
  return new AgentRunError(
    'forbidden',
    'Only the Work Item assignee can start or operate an Agent Run with their own credential.',
    { reason: 'agent_run_forbidden' },
  )
}

/**
 * Reports a claim row that does not match its run row, which must not be repaired silently.
 *
 * @returns Retryable unavailable error.
 */
export function createAgentRunIntegrityError(): AgentRunError {
  return new AgentRunError(
    'temporarily_unavailable',
    'Agent Run records are inconsistent. Retry later or ask an administrator to verify data integrity.',
  )
}
