import {
  readServerEnvironment,
  type ServerEnvironment,
} from '../config/server-config'

/**
 * Trusted runtime identifiers that join application observations to AWS telemetry.
 */
export interface ApiRuntimeMetadata {
  /** Lambda invocation identifier supplied by the runtime, when available. */
  readonly invocationId?: string
  /** X-Ray root trace identifier supplied by the Lambda runtime, when available. */
  readonly traceId?: string
}

/**
 * Safe request metadata recorded when an API request completes.
 */
export interface ApiAccessObservation {
  /** Correlation identifier propagated across the logical operation. */
  readonly correlationId: string
  /** End-to-end duration measured by the API middleware. */
  readonly durationMilliseconds: number
  /** HTTP method without request headers or body content. */
  readonly method: string
  /** Lambda invocation identifier supplied by the runtime, when available. */
  readonly invocationId?: string
  /** Millisecond Unix timestamp captured when the request completed. */
  readonly observedAtMilliseconds: number
  /** Request identifier for this HTTP hop. */
  readonly requestId: string
  /** Coarse route group that excludes entity identifiers and query values. */
  readonly routeGroup: string
  /** Whether the exact request method and path belong in the customer API SLI. */
  readonly sliEligible: boolean
  /** Final HTTP response status. */
  readonly status: number
  /** X-Ray root trace identifier supplied by the runtime, when available. */
  readonly traceId?: string
}

/**
 * Safe request metadata recorded when an unexpected API error is caught.
 */
export interface ApiErrorObservation {
  /** Correlation identifier propagated across the logical operation. */
  readonly correlationId: string
  /** Runtime error category without the exception message or stack. */
  readonly errorType: string
  /** HTTP method without request headers or body content. */
  readonly method: string
  /** Lambda invocation identifier supplied by the runtime, when available. */
  readonly invocationId?: string
  /** Millisecond Unix timestamp captured when the error was caught. */
  readonly observedAtMilliseconds: number
  /** Request identifier for this HTTP hop. */
  readonly requestId: string
  /** Coarse route group that excludes entity identifiers and query values. */
  readonly routeGroup: string
  /** X-Ray root trace identifier supplied by the runtime, when available. */
  readonly traceId?: string
}

/**
 * Destination for one serialized structured log record.
 *
 * @param serializedRecord - JSON log record safe for operational storage.
 */
export type StructuredApiLogSink = (serializedRecord: string) => void

const SAFE_API_METHODS = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
])

const SAFE_API_ROUTE_AREAS = new Set([
  'analytics',
  'approvals',
  'audit',
  'auth',
  'automation',
  'bulk-operations',
  'dashboard',
  'developer',
  'document-backlinks',
  'documents',
  'enterprise',
  'health',
  'notification-preferences',
  'notifications',
  'planning',
  'projects',
  'public',
  'ready',
  'realtime',
  'recurring-work',
  'request-forms',
  'request-intake',
  'request-queue',
  'request-submissions',
  'request-threads',
  'saved-views',
  'scim',
  'search',
  'teams',
  'v1',
  'work-item-configuration',
  'work-items',
  'workspace',
])

/**
 * Writes an Embedded Metric Format access record for request count, latency, and errors.
 *
 * The record intentionally excludes headers, bodies, query values, entity identifiers,
 * exception messages, and stack traces.
 *
 * @param observation - Safe request completion metadata.
 * @param sink - Optional destination used by tests or the runtime console.
 */
export function recordApiAccess(
  observation: ApiAccessObservation,
  sink: StructuredApiLogSink = writeStandardOutput,
): void {
  sink(JSON.stringify({
    _aws: {
      Timestamp: observation.observedAtMilliseconds,
      CloudWatchMetrics: [{
        Namespace: 'Mukuroji/API',
        Dimensions: [['Service']],
        Metrics: [
          { Name: 'RequestCount', Unit: 'Count' },
          { Name: 'Latency', Unit: 'Milliseconds' },
          { Name: 'ServerErrorCount', Unit: 'Count' },
          ...(observation.sliEligible
            ? [
              { Name: 'EligibleRequestCount', Unit: 'Count' },
              { Name: 'EligibleLatency', Unit: 'Milliseconds' },
              { Name: 'EligibleServerErrorCount', Unit: 'Count' },
            ]
            : []),
        ],
      }],
    },
    event: 'api.request.completed',
    service: 'mukuroji-api',
    Service: 'mukuroji-api',
    correlationId: observation.correlationId,
    requestId: observation.requestId,
    method: observation.method,
    routeGroup: observation.routeGroup,
    sliEligible: observation.sliEligible,
    ...(observation.invocationId
      ? { invocationId: observation.invocationId }
      : {}),
    ...(observation.traceId ? { traceId: observation.traceId } : {}),
    status: observation.status,
    durationMs: observation.durationMilliseconds,
    RequestCount: 1,
    Latency: observation.durationMilliseconds,
    ServerErrorCount: observation.status >= 500 ? 1 : 0,
    ...(observation.sliEligible
      ? {
        EligibleRequestCount: 1,
        EligibleLatency: observation.durationMilliseconds,
        EligibleServerErrorCount: observation.status >= 500 ? 1 : 0,
      }
      : {}),
  }))
}

/**
 * Returns whether an exact API request belongs in the customer-traffic SLI.
 *
 * Liveness, readiness, and CORS preflight traffic remain in raw telemetry but
 * are excluded from availability and latency objectives.
 *
 * @param method - HTTP request method supplied by Hono.
 * @param path - Exact request path supplied by Hono.
 * @returns Whether the request is eligible for API SLI metrics.
 */
export function isEligibleApiSliRequest(
  method: string,
  path: string,
): boolean {
  if (method.trim().toUpperCase() === 'OPTIONS') return false

  const pathWithoutQuery = path.split(/[?#]/, 1)[0] ?? ''
  if (
    pathWithoutQuery === '/api/health' ||
    pathWithoutQuery === '/api/ready'
  ) {
    return false
  }
  return pathWithoutQuery === '/api' || pathWithoutQuery.startsWith('/api/')
}

/**
 * Writes a safe structured record for an unexpected request error.
 *
 * @param observation - Safe unexpected-error metadata.
 * @param sink - Optional destination used by tests or the runtime console.
 */
export function recordApiError(
  observation: ApiErrorObservation,
  sink: StructuredApiLogSink = writeStandardError,
): void {
  sink(JSON.stringify({
    event: 'api.request.failed',
    service: 'mukuroji-api',
    correlationId: observation.correlationId,
    requestId: observation.requestId,
    method: observation.method,
    routeGroup: observation.routeGroup,
    errorType: observation.errorType,
    ...(observation.invocationId
      ? { invocationId: observation.invocationId }
      : {}),
    ...(observation.traceId ? { traceId: observation.traceId } : {}),
    observedAt: new Date(observation.observedAtMilliseconds).toISOString(),
  }))
}

/**
 * Returns a low-cardinality method category.
 *
 * @param method - Untrusted HTTP method supplied by the request runtime.
 * @returns A standard API method or a bounded fallback category.
 */
export function summarizeApiMethod(method: string): string {
  const normalized = method.trim().toUpperCase()
  return SAFE_API_METHODS.has(normalized) ? normalized : 'OTHER'
}

/**
 * Returns a fixed low-cardinality route group without client-controlled values.
 *
 * @param path - Request path supplied by Hono.
 * @returns A known `/api/<area>` prefix or a bounded unmatched marker.
 */
export function summarizeApiRoute(path: string): string {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0] ?? ''
  const segments = pathWithoutQuery.split('/').filter(Boolean)
  if (segments.length === 0) return '/'
  if (segments[0] !== 'api') return '/unmatched'
  const area = segments[1]
  if (!area) return '/api'
  return SAFE_API_ROUTE_AREAS.has(area)
    ? `/api/${area}`
    : '/api/unmatched'
}

/**
 * Returns a safe runtime category for an unknown thrown value.
 *
 * @param error - Unknown value caught by the common middleware.
 * @returns The Error name or a generic category.
 */
export function classifyApiError(error: unknown): string {
  if (error instanceof TypeError) return 'TypeError'
  if (error instanceof RangeError) return 'RangeError'
  if (error instanceof ReferenceError) return 'ReferenceError'
  if (error instanceof SyntaxError) return 'SyntaxError'
  if (error instanceof URIError) return 'URIError'
  return error instanceof Error ? 'Error' : 'UnknownError'
}

/**
 * Resolves runtime-controlled Lambda and X-Ray identifiers for structured logs.
 *
 * Client request headers are intentionally excluded. Values are accepted only
 * from the Hono Lambda environment and the Lambda-managed X-Ray environment.
 *
 * @param runtime - Hono environment supplied by the AWS Lambda adapter.
 * @param environment - Runtime environment containing the active X-Ray header.
 * @returns Validated trusted runtime metadata.
 */
export function resolveApiRuntimeMetadata(
  runtime: unknown,
  environment: ServerEnvironment = readServerEnvironment(),
): ApiRuntimeMetadata {
  const runtimeRecord = isUnknownRecord(runtime) ? runtime : undefined
  const lambdaContext = runtimeRecord?.lambdaContext
  const lambdaContextRecord = isUnknownRecord(lambdaContext)
    ? lambdaContext
    : undefined
  const invocationId = readBoundedRuntimeIdentifier(
    lambdaContextRecord?.awsRequestId,
  )
  const traceId = readXrayRootTraceId(environment._X_AMZN_TRACE_ID)

  return Object.freeze({
    ...(invocationId ? { invocationId } : {}),
    ...(traceId ? { traceId } : {}),
  })
}

/**
 * Checks whether an unknown value is a string-keyed object.
 *
 * @param value - Unknown runtime value.
 * @returns Whether the value can be inspected by property name.
 */
function isUnknownRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads a bounded opaque identifier from a trusted runtime object.
 *
 * @param value - Unknown runtime property.
 * @returns A validated identifier, when present.
 */
function readBoundedRuntimeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(normalized)
    ? normalized
    : undefined
}

/**
 * Extracts a valid X-Ray root trace identifier from the Lambda trace header.
 *
 * @param value - Lambda-managed `_X_AMZN_TRACE_ID` value.
 * @returns The root trace identifier, when present and valid.
 */
function readXrayRootTraceId(value: string | undefined): string | undefined {
  return value
    ?.match(/(?:^|;)Root=(1-[0-9a-f]{8}-[0-9a-f]{24})(?:;|$)/u)?.[1]
}

/**
 * Writes a serialized access record to standard output.
 *
 * @param serializedRecord - JSON record produced by the observability boundary.
 */
function writeStandardOutput(serializedRecord: string): void {
  console.log(serializedRecord)
}

/**
 * Writes a serialized error record to standard error.
 *
 * @param serializedRecord - JSON record produced by the observability boundary.
 */
function writeStandardError(serializedRecord: string): void {
  console.error(serializedRecord)
}
