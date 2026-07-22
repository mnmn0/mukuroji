/** Stable Automation failure category independent of an inbound transport. */
export type AutomationErrorCategory =
  | 'invalid-input'
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'unprocessable'
  | 'locked'
  | 'rate-limited'
  | 'unavailable'

/** Transport-neutral Automation domain and application error. */
export class AutomationError extends Error {
  /** Stable failure category mapped by each inbound adapter. */
  readonly category: AutomationErrorCategory
  /** Stable machine-readable error code. */
  readonly code: string
  /** Whether the same logical operation may be retried. */
  readonly retryable: boolean

  /**
   * Creates an Automation error.
   *
   * @param category - Stable transport-neutral failure category.
   * @param code - Stable machine-readable code.
   * @param message - Safe error message.
   * @param retryable - Whether retry is allowed.
   */
  constructor(
    category: AutomationErrorCategory,
    code: string,
    message: string,
    retryable = false,
  ) {
    super(message)
    this.category = category
    this.code = code
    this.retryable = retryable
  }
}
