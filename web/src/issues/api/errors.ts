

/**
 * Lambda API からエラーレスポンスが返ったときに投げる例外です。
 */
export class TeamIssuesApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
