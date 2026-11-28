/** Stable failure kinds of the Slack ingest use cases. */
export type SlackIngestErrorCategory =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'not-configured'
  | 'unavailable'

/** Failure of a Slack ingest use case with a stable code. */
export class SlackIngestError extends Error {
  /** Failure kind the transport maps to a status. */
  readonly category: SlackIngestErrorCategory
  /** Stable code returned to clients. */
  readonly code: string

  /**
   * Creates the error.
   *
   * @param category - Failure kind.
   * @param code - Stable code.
   * @param message - Safe message without secrets.
   */
  constructor(category: SlackIngestErrorCategory, code: string, message: string) {
    super(message)
    this.name = 'SlackIngestError'
    this.category = category
    this.code = code
  }
}

/** Slack answered 429; the job should run again after the given delay. */
export class SlackRateLimitedError extends Error {
  /** Seconds Slack asked to wait. */
  readonly retryAfterSeconds: number

  /**
   * Creates the error.
   *
   * @param retryAfterSeconds - Seconds from the `Retry-After` header.
   */
  constructor(retryAfterSeconds: number) {
    super('Slack rate limit reached.')
    this.name = 'SlackRateLimitedError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}
