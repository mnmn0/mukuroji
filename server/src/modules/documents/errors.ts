/**
 * Stable error returned by the Documents domain and application ports.
 */
export class DocumentError extends Error {
  /** HTTP-compatible status used by the inbound adapter. */
  readonly status: number
  /** Stable machine-readable error code. */
  readonly code: string
  /** Safe structured details such as operation conflicts. */
  readonly details?: unknown

  /**
   * Creates a Documents error.
   *
   * @param status - HTTP-compatible status used at the adapter boundary.
   * @param code - Stable machine-readable error code.
   * @param message - Human-readable internal error message.
   * @param details - Optional safe structured details.
   * @param options - Standard Error construction options.
   */
  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DocumentError'
    this.status = status
    this.code = code
    this.details = details
  }
}
