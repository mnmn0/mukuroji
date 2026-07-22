

/**
 * Developer Platform API の失敗を status code と安定 code 付きで保持します。
 */
export class DeveloperPlatformApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した機械判定用 error code です。
   */
  readonly code?: string

  /**
   * 同じ idempotency key で安全に再試行すべき失敗かどうかです。
   */
  readonly retryable: boolean

  /** API が指定した再試行待機秒数です。 */
  readonly retryAfterSeconds?: number

  /**
   * Developer Platform API error を作成します。
   *
   * @param status API response の HTTP status code です。
   * @param message ユーザーへ表示できる secret-safe message です。
   * @param code API が返した機械判定用 error code です。
   * @param retryable 同じ logical mutation として再試行できるかどうかです。
   * @param retryAfterSeconds API が Retry-After で指定した待機秒数です。
   */
  constructor(
    status: number,
    message: string,
    code?: string,
    retryable = false,
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'DeveloperPlatformApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Developer Platform mutation の idempotency context を retry まで保持するか判定します。
 *
 * Transport failure と retryable な Problem Details response は、server 側で mutation が
 * commit 済みか判別できないため同じ context を再利用します。
 *
 * @param error mutation request が返した error です。
 * @returns 同じ logical mutation context を保持する場合は true です。
 */
export function shouldRetainDeveloperPlatformMutationContext(error: unknown) {
  return !(error instanceof DeveloperPlatformApiError) || error.retryable
}
