/** Classified failure returned by the Team triage API boundary. */
export class TriageApiError extends Error {
  /** HTTP status associated with the failure. */
  readonly status: number
  /** Stable server error code when one was returned. */
  readonly code?: string

  /**
   * Creates a classified triage API failure.
   *
   * @param status - HTTP status associated with the failure.
   * @param message - Safe error message for logs and UI classification.
   * @param code - Optional stable server error code.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'TriageApiError'
    this.status = status
    this.code = code
  }
}
