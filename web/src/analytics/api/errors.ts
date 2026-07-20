

/**
 * Analytics API が返した失敗を表す例外です。
 */
export class AnalyticsApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した機械判定用の安定 error code です。
   */
  readonly code?: string

  /**
   * Analytics API error を生成します。
   *
   * @param status - HTTP status code です。
   * @param message - Error response の message です。
   * @param code - Error response の安定 code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AnalyticsApiError'
    this.status = status
    this.code = code
  }
}
