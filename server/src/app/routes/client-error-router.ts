import { Hono, type Context } from 'hono'
import {
  CLIENT_ERROR_COMMIT_PATTERN,
  CLIENT_ERROR_NAME_PATTERN,
  CLIENT_ERROR_REPORT_ID_PATTERN,
  CLIENT_ERROR_REPORT_MAX_BYTES,
  CLIENT_ERROR_REPORT_PATH,
  CLIENT_ERROR_ROUTE_PATTERN,
  isClientErrorKind,
  type ClientErrorReport,
} from '@mukuroji/contracts'
import type { ClientErrorObservation } from '../../infrastructure/observability/api-observability'

/** Outcome of counting one report against the rate limits. */
export type ClientErrorReportAdmission =
  | {
    /** The report may be recorded. */
    readonly allowed: true
  }
  | {
    /** The report is over a limit. */
    readonly allowed: false
    /** Seconds until the window that refused it resets. */
    readonly retryAfterSeconds: number
  }

/** Dependencies of the browser error report route. */
export interface ClientErrorRouterDependencies {
  /**
   * Returns the browser origins the API accepts.
   *
   * @returns Allowed origins.
   */
  getAllowedOrigins(): readonly string[]
  /**
   * Counts one report from the request's trusted client address against the per-client and
   * overall limits.
   *
   * @param context - Request context, read only for its trusted client address.
   * @returns Whether the report may be recorded.
   */
  admit(context: Context): Promise<ClientErrorReportAdmission>
  /**
   * Returns the correlation identifier the common middleware gave this request.
   *
   * @param request - Raw request.
   * @returns The identifier, or undefined without the middleware.
   */
  readCorrelationId(request: Request): string | undefined
  /**
   * Writes one validated report to the operational log.
   *
   * @param observation - Validated report.
   */
  record(observation: ClientErrorObservation): void
  /**
   * Returns the current millisecond timestamp.
   *
   * @returns Unix time in milliseconds.
   */
  now(): number
}

/** Keys a report may carry; any other key rejects it. */
const REPORT_KEYS: ReadonlySet<string> = new Set(['reportId', 'kind', 'route', 'webCommitSha', 'errorName', 'status'])

/**
 * Reads one report body, accepting only the documented fields and formats.
 *
 * @param value - Parsed JSON body.
 * @returns The report, or undefined when any field is missing, unknown, or malformed.
 */
export function parseClientErrorReport(value: unknown): ClientErrorReport | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = new Map<string, unknown>(Object.entries(value))
  for (const key of entries.keys()) {
    if (!REPORT_KEYS.has(key)) return undefined
  }
  const reportId = entries.get('reportId')
  const kind = entries.get('kind')
  const route = entries.get('route')
  const webCommitSha = entries.get('webCommitSha')
  const errorName = entries.get('errorName')
  const status = entries.get('status')
  if (typeof reportId !== 'string' || !CLIENT_ERROR_REPORT_ID_PATTERN.test(reportId)) return undefined
  if (!isClientErrorKind(kind)) return undefined
  if (typeof route !== 'string' || !CLIENT_ERROR_ROUTE_PATTERN.test(route)) return undefined
  if (webCommitSha !== undefined && (typeof webCommitSha !== 'string' || !CLIENT_ERROR_COMMIT_PATTERN.test(webCommitSha))) {
    return undefined
  }
  if (errorName !== undefined && (typeof errorName !== 'string' || !CLIENT_ERROR_NAME_PATTERN.test(errorName))) {
    return undefined
  }
  if (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599)) {
    return undefined
  }
  return {
    reportId,
    kind,
    route,
    ...(webCommitSha === undefined ? {} : { webCommitSha }),
    ...(errorName === undefined ? {} : { errorName }),
    ...(status === undefined ? {} : { status }),
  }
}

/**
 * Reads the body as text, refusing to buffer more than the report limit.
 *
 * @param request - Raw request.
 * @returns The body text, or undefined when it exceeds {@link CLIENT_ERROR_REPORT_MAX_BYTES}.
 */
async function readBoundedBody(request: Request): Promise<string | undefined> {
  const body = request.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > CLIENT_ERROR_REPORT_MAX_BYTES) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/**
 * Answers a refused report with a body that names only the reason.
 *
 * @param context - Request context.
 * @param status - HTTP status.
 * @param error - Stable error code.
 * @returns The response.
 */
function refuse(context: Context, status: 400 | 403 | 413 | 415 | 429, error: string): Response {
  context.header('Cache-Control', 'no-store')
  return context.json({ error }, status)
}

/**
 * Creates the unauthenticated route that records browser errors in the operational log.
 *
 * The route accepts only a small JSON body from an allowed browser origin, validates every field
 * against a fixed pattern, and counts each report against a per-client and an overall limit
 * before it writes one log record, so a caller cannot store arbitrary text or flood the logs.
 *
 * @param dependencies - Origin list, rate limits, and the log destination.
 * @returns A router serving `POST /api/client-errors`.
 */
export function createClientErrorRouter(dependencies: ClientErrorRouterDependencies): Hono {
  const router = new Hono()
  router.post(`/api${CLIENT_ERROR_REPORT_PATH}`, async (context) => {
    const origin = context.req.header('Origin')
    if (origin === undefined || !dependencies.getAllowedOrigins().includes(origin)) {
      return refuse(context, 403, 'ClientErrorOriginNotAllowed')
    }
    const contentType = context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') return refuse(context, 415, 'ClientErrorUnsupportedMediaType')
    const declaredLength = Number(context.req.header('Content-Length') ?? '0')
    if (!Number.isFinite(declaredLength) || declaredLength > CLIENT_ERROR_REPORT_MAX_BYTES) {
      return refuse(context, 413, 'ClientErrorReportTooLarge')
    }

    let text: string | undefined
    try {
      text = await readBoundedBody(context.req.raw)
    } catch {
      return refuse(context, 400, 'InvalidClientErrorReport')
    }
    if (text === undefined) return refuse(context, 413, 'ClientErrorReportTooLarge')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return refuse(context, 400, 'InvalidClientErrorReport')
    }
    const report = parseClientErrorReport(parsed)
    if (report === undefined) return refuse(context, 400, 'InvalidClientErrorReport')

    const admission = await dependencies.admit(context)
    if (!admission.allowed) {
      context.header('Retry-After', String(Math.max(1, Math.ceil(admission.retryAfterSeconds))))
      return refuse(context, 429, 'ClientErrorReportRateLimited')
    }

    dependencies.record({
      ...report,
      correlationId: dependencies.readCorrelationId(context.req.raw) ?? report.reportId,
      observedAtMilliseconds: dependencies.now(),
    })
    context.header('Cache-Control', 'no-store')
    return context.body(null, 204)
  })
  return router
}
