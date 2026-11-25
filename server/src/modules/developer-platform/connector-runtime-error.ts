/** Connector runtime が外部 provider 失敗を分類する stable error です。 */
export class ConnectorRuntimeError extends Error {
  /** Stable internal error code です。 */
  readonly code: string
  /** Retry により回復する可能性です。 */
  readonly retryable: boolean
  /** Credential 再認証が必要かどうかです。 */
  readonly authorizationRequired: boolean
  /** Secret を含まない provider HTTP status です。 */
  readonly providerStatus?: number

  /** Secret-safe connector runtime error を作成します。 */
  constructor(
    code: string,
    message: string,
    options: {
      /** Retry により回復する可能性です。 */
      retryable?: boolean
      /** Credential 再認証が必要かどうかです。 */
      authorizationRequired?: boolean
      /** Secret を含まない provider HTTP status です。 */
      providerStatus?: number
    } = {},
  ) {
    super(message)
    this.name = 'ConnectorRuntimeError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.authorizationRequired = options.authorizationRequired ?? false
    this.providerStatus = options.providerStatus
  }
}
