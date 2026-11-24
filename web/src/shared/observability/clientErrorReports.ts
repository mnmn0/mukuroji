import {
  CLIENT_ERROR_NAME_PATTERN,
  CLIENT_ERROR_REPORT_PATH,
  CLIENT_ERROR_ROUTE_PATTERN,
  type ClientErrorKind,
  type ClientErrorReport,
} from '@mukuroji/contracts'

/** Reports one page load sends at most; later errors are dropped. */
const maxReportsPerPageLoad = 5

/** One error to report. */
export type ClientErrorOccurrence = {
  /** Kind of error. */
  readonly kind: ClientErrorKind
  /** Route pattern that was showing. */
  readonly route: string
  /** Thrown value; only its constructor name is reported. */
  readonly error: unknown
  /** HTTP status of a route error response. */
  readonly status?: number
}

/** Dependencies of the reporter. */
export type ClientErrorReporterOptions = {
  /** Commit of the running Web build. */
  readonly webCommitSha: string | undefined
  /**
   * Sends one report; failures are ignored.
   *
   * @param report - Report to send.
   */
  readonly send: (report: ClientErrorReport) => void
  /**
   * Generates a report ID.
   *
   * @returns A lowercase UUID.
   */
  readonly createReportId: () => string
}

/**
 * Reports browser errors with a per-page-load cap and de-duplication.
 */
export type ClientErrorReporter = {
  /**
   * Reports one error unless it repeats an earlier one or the cap is reached.
   *
   * @param occurrence - The error.
   * @returns The report ID, the earlier one for a repeat, or undefined when dropped.
   */
  readonly report: (occurrence: ClientErrorOccurrence) => string | undefined
}

/**
 * Turns a route pattern into the reportable form, or a fallback when it cannot be reported.
 *
 * @param route - Route pattern such as `/teams/:teamId`.
 * @returns The pattern, or `/unknown`.
 */
function normalizeRoute(route: string): string {
  return CLIENT_ERROR_ROUTE_PATTERN.test(route) ? route : '/unknown'
}

/**
 * Reads the constructor name of a thrown value, never its message.
 *
 * @param error - Thrown value.
 * @returns The name, or undefined for non-errors and unusual names.
 */
export function readErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  return CLIENT_ERROR_NAME_PATTERN.test(error.name) ? error.name : undefined
}

/**
 * Creates a reporter that sends at most 5 reports per page load and sends a repeated error once.
 *
 * @param options - Build commit, transport, and ID source.
 * @returns The reporter.
 */
export function createClientErrorReporter(options: ClientErrorReporterOptions): ClientErrorReporter {
  const sent = new Map<string, string>()
  return {
    report: (occurrence) => {
      const route = normalizeRoute(occurrence.route)
      const errorName = readErrorName(occurrence.error)
      const status = occurrence.status !== undefined && Number.isInteger(occurrence.status) &&
        occurrence.status >= 400 && occurrence.status <= 599
        ? occurrence.status
        : undefined
      const key = `${occurrence.kind}\0${route}\0${errorName ?? ''}\0${status ?? ''}`
      const earlier = sent.get(key)
      if (earlier !== undefined) return earlier
      if (sent.size >= maxReportsPerPageLoad) return undefined
      const reportId = options.createReportId()
      sent.set(key, reportId)
      options.send({
        reportId,
        kind: occurrence.kind,
        route,
        ...(options.webCommitSha === undefined ? {} : { webCommitSha: options.webCommitSha }),
        ...(errorName === undefined ? {} : { errorName }),
        ...(status === undefined ? {} : { status }),
      })
      return reportId
    },
  }
}

/**
 * Joins the matched route definitions into one pattern, such as `/teams/:teamId/issues/:issueId`.
 *
 * @param matches - Matched routes from outermost to innermost.
 * @returns The pattern; `/` when no route has a path.
 */
export function routePatternFromMatches(matches: readonly { readonly route: { readonly path?: string } }[]): string {
  const segments = matches
    .map((match) => match.route.path ?? '')
    .flatMap((path) => path.split('/'))
    .filter((segment) => segment !== '')
  return `/${segments.join('/')}`
}

/**
 * Sends one report to the API without credentials, surviving page unload.
 *
 * @param apiBaseUrl - API base URL such as `/api`.
 * @param report - Report to send.
 * @param send - `fetch` to use.
 */
export function sendClientErrorReport(apiBaseUrl: string, report: ClientErrorReport, send: typeof fetch): void {
  try {
    void send(`${apiBaseUrl}${CLIENT_ERROR_REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      credentials: 'omit',
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // Reporting must never raise another error.
  }
}
