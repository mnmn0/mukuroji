

/**
 * API からエラーレスポンスが返ったときに投げる例外です。
 */
export class ApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
   */
  readonly status: number
  /**
   * API が返した機械判定用の安定した error code です。
   */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
