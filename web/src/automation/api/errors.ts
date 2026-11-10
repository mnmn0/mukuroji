import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

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

/**
 * Automation API の base URL を既存 Workspace API と同じ優先順で解決します。
 *
 * @param environment - Vite から渡される環境変数です。
 * @returns 末尾の slash を除いた API base URL です。
 */
export function resolveAutomationApiBaseUrl(
  environment: Record<string, string | boolean | undefined>,
) {
  return resolveApiBaseUrl('workspace', environment)
}
