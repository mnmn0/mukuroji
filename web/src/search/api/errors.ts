import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

/**
 * Workspace search API の base URL を既存 Workspace API と同じ優先順で解決します。
 */
export function resolveSearchApiBaseUrl(environment: Record<string, string | boolean | undefined>) {
  return resolveApiBaseUrl('workspace', environment)
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
