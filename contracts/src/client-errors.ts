/** API path that receives browser error reports. Unauthenticated; see {@link ClientErrorReport}. */
export const CLIENT_ERROR_REPORT_PATH = '/client-errors'

/** Largest accepted report body, in bytes. */
export const CLIENT_ERROR_REPORT_MAX_BYTES = 1024

/** Kinds of browser errors the Web app reports. */
export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'route-error'] as const

/** Kind of one browser error report. */
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number]

/** Route pattern such as `/teams/:teamId/issues/:issueId`; never a concrete path with IDs. */
export const CLIENT_ERROR_ROUTE_PATTERN = /^\/[A-Za-z0-9/:*_-]{0,199}$/

/** Error constructor name such as `TypeError`; never the message. */
export const CLIENT_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_$]{0,63}$/

/** Full lowercase Git commit SHA of the Web build. */
export const CLIENT_ERROR_COMMIT_PATTERN = /^[0-9a-f]{40}$/

/** Lowercase UUID the browser generates for one report and shows to the user. */
export const CLIENT_ERROR_REPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * One browser error report.
 *
 * It names where and in which build the error happened, never what the user entered or saw:
 * messages, stacks, URLs with IDs or query strings, and page content are not part of it.
 */
export type ClientErrorReport = {
  /** Correlation ID of this report, shown to the user so operators can find the log record. */
  readonly reportId: string
  /** Kind of error. */
  readonly kind: ClientErrorKind
  /** Route pattern that was showing, matching {@link CLIENT_ERROR_ROUTE_PATTERN}. */
  readonly route: string
  /** Commit of the Web build, when the build embeds one. */
  readonly webCommitSha?: string
  /** Constructor name of the thrown value, when it is an Error. */
  readonly errorName?: string
  /** HTTP status of a route error response, from 400 to 599. */
  readonly status?: number
}

/**
 * Reports whether a value is one of the known report kinds.
 *
 * @param value - Untrusted value.
 * @returns Whether it is a {@link ClientErrorKind}.
 */
export function isClientErrorKind(value: unknown): value is ClientErrorKind {
  return CLIENT_ERROR_KINDS.some((kind) => kind === value)
}
