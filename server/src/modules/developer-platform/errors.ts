/** Stable Developer Platform application error. */
export class DeveloperPlatformError extends Error {
  /** HTTP-compatible status category used by inbound adapters. */
  readonly status: number
  /** Stable error code used by external clients. */
  readonly code: string

  /**
   * Creates a stable Developer Platform error.
   *
   * @param status - HTTP-compatible status category.
   * @param code - Stable machine-readable error code.
   * @param message - Safe human-readable error message.
   * @param options - Standard error construction options.
   */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeveloperPlatformError'
    this.status = status
    this.code = code
  }
}
