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

  /**
   * Creates a safe AI assistance application error.
   *
   * @param category - Stable error category.
   * @param code - Stable machine-readable error code.
   * @param message - Non-sensitive diagnostic message.
   * @param options - Optional standard error options.
   */
  constructor(
    category: AiAssistanceErrorCategory,
    code: AiAssistanceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AiAssistanceError'
    this.category = category
    this.code = code
  }
}
