

/**
 * Notification API のエラーレスポンスです。
 */
export class NotificationsApiError extends Error {
  /**
   * HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  /**
   * Notification API error を生成します。
   *
   * @param status - HTTP status code です。
   * @param message - 表示可能な error message です。
   * @param code - API 固有の安定 error code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
