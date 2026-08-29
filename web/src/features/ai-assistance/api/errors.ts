/**
 * Error returned by the permission-aware AI assistance API.
 */
export class AiAssistanceApiError extends Error {
  /** HTTP status returned by the API. */
  readonly status: number

  /** Stable server error code when one was provided. */
  readonly code?: string

  /**
   * Creates a classified AI assistance API error.
   *
   * @param status - HTTP response status.
   * @param message - Safe transport error message.
   * @param code - Optional stable server error code.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AiAssistanceApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Resolves the AI assistance API base URL from the existing Workspace API environment.
 *
 * @param environment - Vite environment values.
 * @returns A base URL without trailing slashes.
 */
export function resolveAiAssistanceApiBaseUrl(
  environment: Record<string, string | boolean | undefined>,
): string {
  const value = typeof environment.VITE_WORKSPACE_API_BASE_URL === 'string'
    ? environment.VITE_WORKSPACE_API_BASE_URL
    : typeof environment.VITE_PROJECTS_API_BASE_URL === 'string'
      ? environment.VITE_PROJECTS_API_BASE_URL
      : typeof environment.VITE_API_BASE_URL === 'string'
        ? environment.VITE_API_BASE_URL
        : '/api'

  return value.replace(/\/+$/, '')
}
