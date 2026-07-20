import type { DocumentDetail } from '@mukuroji/contracts'

/**
 * Documents API が失敗したときの例外です。
 */
export class DocumentsApiError extends Error {
  /**
   * HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  /**
   * Documents API error を作成します。
   *
   * @param status - HTTP status code です。
   * @param message - User または log に渡す message です。
   * @param code - API が返した安定 error code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Latest server detail を添えて local draft を保持する revision conflict です。
 */
export class DocumentRevisionConflictError extends DocumentsApiError {
  /**
   * Conflict 検出後に取得した最新 server Document です。
   */
  readonly latestDocument: DocumentDetail

  /**
   * User の明示的な overwrite retry に必要な conflict context を作成します。
   *
   * @param latestDocument - Conflict 後の最新 server Document です。
   * @param message - 元 API error の message です。
   * @param code - 元 API error の安定 code です。
   */
  constructor(
    latestDocument: DocumentDetail,
    message: string,
    code?: string,
  ) {
    super(409, message, code)
    this.latestDocument = latestDocument
  }
}

/**
 * Documents API base URL を既存 Workspace API と同じ優先順で解決します。
 *
 * @param environment - Vite environment value map です。
 * @returns 末尾 slash を除いた API base URL です。
 */
export function resolveDocumentsApiBaseUrl(
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
  return value.replace(/\/+$/u, '')
}
