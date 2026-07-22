/** Error raised by directory and Work Item persistence adapters. */
export class ProjectDataError extends Error {
  /** HTTP-compatible status associated with the persistence failure. */
  readonly status: number

  /** Stable application error code. */
  readonly code: string

  /**
   * Creates a project data error.
   *
   * @param status - HTTP-compatible failure status.
   * @param code - Stable application error code.
   * @param message - Safe diagnostic message.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
