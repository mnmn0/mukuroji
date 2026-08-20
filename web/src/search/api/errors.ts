

/**
 * Workspace search API の base URL を既存 Workspace API と同じ優先順で解決します。
 */
export function resolveSearchApiBaseUrl(environment: Record<string, string | boolean | undefined>) {
  return trimTrailingSlash(
    typeof environment.VITE_WORKSPACE_API_BASE_URL === 'string'
      ? environment.VITE_WORKSPACE_API_BASE_URL
      : typeof environment.VITE_PROJECTS_API_BASE_URL === 'string'
        ? environment.VITE_PROJECTS_API_BASE_URL
        : typeof environment.VITE_API_BASE_URL === 'string'
            ? environment.VITE_API_BASE_URL
            : '/api',
  )
}

/**
 * Workspace search / saved view API が失敗したときの例外です。
 */
export class WorkspaceSearchApiError extends Error {
  /**
   * API response の HTTP status code です。
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

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
