/** Safe API error raised by the Enterprise Identity domain. */
export class EnterpriseIdentityError extends Error {
  /** Status code exposed by HTTP adapters. */
  readonly status: number
  /** Stable code that clients can use for branching. */
  readonly code: string
  /** Whether retrying the same operation is safe. */
  readonly retryable: boolean

  /**
   * Creates an Enterprise Identity error.
   *
   * @param status - Safe status code used by HTTP adapters.
   * @param code - Stable code clients can branch on.
   * @param message - Safe message that does not contain secrets.
   * @param retryable - Whether the same operation can be retried safely.
   * @param options - Standard error options, including an optional cause.
   */
  constructor(
    status: number,
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EnterpriseIdentityError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}
