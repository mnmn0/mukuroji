/** Categories of GitHub integration errors, which the HTTP adapter maps to statuses. */
export type GitHubIntegrationErrorCategory =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'not-configured'
  | 'unavailable'

/** Classified error of the GitHub integration (ADR 0079). */
export class GitHubIntegrationError extends Error {
  /** Category the HTTP adapter maps to a status. */
  readonly category: GitHubIntegrationErrorCategory

  /** Stable error code clients may match. */
  readonly code: string

  /** Whether a later attempt of the same work may succeed. */
  readonly retryable: boolean

  /**
   * Creates an error.
   *
   * @param category - Error category.
   * @param code - Stable error code.
   * @param message - Secret-free message.
   * @param options - Cause and whether a retry may succeed.
   */
  constructor(
    category: GitHubIntegrationErrorCategory,
    code: string,
    message: string,
    options: { cause?: unknown, retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GitHubIntegrationError'
    this.category = category
    this.code = code
    this.retryable = options.retryable ?? category === 'unavailable'
  }
}
