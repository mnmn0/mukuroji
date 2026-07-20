

/**
 * Enterprise security API の失敗を status/code とともに保持する例外です。
 */
export class EnterpriseSecurityApiError extends Error {
  /** API response の HTTP status code です。 */
  readonly status: number
  /** API が返した分岐可能な error code です。 */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'EnterpriseSecurityApiError'
    this.status = status
    this.code = code
  }
}
