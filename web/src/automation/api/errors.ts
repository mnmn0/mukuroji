

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
  return trimTrailingSlash(
    typeof environment.VITE_WORKSPACE_API_BASE_URL === 'string'
      ? environment.VITE_WORKSPACE_API_BASE_URL
      : typeof environment.VITE_PROJECTS_API_BASE_URL === 'string'
        ? environment.VITE_PROJECTS_API_BASE_URL
        : typeof environment.VITE_TASKS_API_BASE_URL === 'string'
          ? environment.VITE_TASKS_API_BASE_URL
          : typeof environment.VITE_API_BASE_URL === 'string'
            ? environment.VITE_API_BASE_URL
            : '/api',
  )
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
