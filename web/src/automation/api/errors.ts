

/** Automation API の失敗を表す error です。 */
export class AutomationApiError extends Error {
  /** HTTP status code です。 */
  readonly status: number

  /** API が返した安定 error code です。 */
  readonly code?: string

  /**
   * Automation API error を生成します。
   *
   * @param status - HTTP status code です。
   * @param message - 利用者向け error message です。
   * @param code - API が返した安定 error code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AutomationApiError'
    this.status = status
    this.code = code
  }
}
