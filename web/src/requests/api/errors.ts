

/**
 * Request API の失敗を status/code とともに保持する例外です。
 */
export class RequestIntakeApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number
  /**
   * API が返した安定 error code です。
   */
  readonly code?: string
  /**
   * Rate limit 時に API が指定した retry 秒数です。
   */
  readonly retryAfterSeconds?: number

  constructor(
    status: number,
    message: string,
    code?: string,
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'RequestIntakeApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}
