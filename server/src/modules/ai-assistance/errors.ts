import type { AiAssistanceUsage } from '@mukuroji/contracts'

/** Stable error categories exposed by the AI assistance application boundary. */
export type AiAssistanceErrorCategory =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'not-found'
  | 'conflict'
  | 'rate-limit'
  | 'upstream'
  | 'timeout'

/** Stable machine-readable AI assistance error codes. */
export type AiAssistanceErrorCode =
  | 'InvalidAiAssistanceRequest'
  | 'InvalidAiAssistanceOutput'
  | 'AiAssistanceOutputNotAllowed'
  | 'AiAssistanceCitationInvalid'
  | 'AiAssistanceAuthenticationRequired'
  | 'AiAssistanceDisabled'
  | 'AiAssistancePreferenceDisabled'
  | 'AiAssistanceTaskDisabled'
  | 'AiAssistanceModelNotAllowed'
  | 'AiAssistanceAuthorizationChanged'
  | 'AiAssistanceSourceChanged'
  | 'AiAssistanceGenerationNotFound'
  | 'AiAssistanceRevisionConflict'
  | 'AiAssistanceIdempotencyKeyRequired'
  | 'AiAssistanceIdempotencyConflict'
  | 'AiAssistanceGenerationInProgress'
  | 'AiAssistanceRateLimitExceeded'
  | 'AiAssistanceDecisionAlreadyRecorded'
  | 'AiAssistanceAttemptFailed'
  | 'AiAssistancePersistenceError'
  | 'AiAssistanceProviderError'
  | 'AiAssistanceProviderTimeout'
  | 'InvalidAiAssistanceRecord'

/** Application error that keeps HTTP and AWS implementation details out of the domain. */
export class AiAssistanceError extends Error {
  /** Stable machine-readable error code. */
  readonly code: AiAssistanceErrorCode

  /** Error category used by transport adapters. */
  readonly category: AiAssistanceErrorCategory

  /** Provider-reported usage retained when structured output validation fails. */
  readonly usage?: AiAssistanceUsage

  /** Provider trace retained for safe terminal-attempt accounting. */
  readonly providerTraceId?: string

  /**
   * Creates a safe AI assistance application error.
   *
   * @param category - Stable error category.
   * @param code - Stable machine-readable error code.
   * @param message - Non-sensitive diagnostic message.
   * @param options - Optional standard error options.
   * @param usage - Optional provider usage retained for failed-attempt accounting.
   * @param providerTraceId - Optional provider trace retained for failed-attempt accounting.
   */
  constructor(
    category: AiAssistanceErrorCategory,
    code: AiAssistanceErrorCode,
    message: string,
    options?: ErrorOptions,
    usage?: AiAssistanceUsage,
    providerTraceId?: string,
  ) {
    super(message, options)
    this.name = 'AiAssistanceError'
    this.category = category
    this.code = code
    this.usage = usage
    this.providerTraceId = providerTraceId
  }
}
