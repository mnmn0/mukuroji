/**
 * Failure of a Team Agent settings request, carrying the HTTP status and the server's stable code.
 */
export class AgentSettingsApiError extends Error {
  /** HTTP status of the response; `502` when the response body could not be trusted. */
  readonly status: number

  /** Stable error code the server returned, such as `conflict` or `validation_failed`. */
  readonly code?: string

  /**
   * Creates a classified Agent settings API error.
   *
   * @param status - HTTP response status.
   * @param message - Message safe to show the operator.
   * @param code - Stable server error code, if any.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AgentSettingsApiError'
    this.status = status
    this.code = code
  }
}
