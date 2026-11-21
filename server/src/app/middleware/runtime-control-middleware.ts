import {
  MAINTENANCE_READ_ONLY_PROBLEM_CODE,
  MAINTENANCE_STATE_HEADER,
  MAINTENANCE_STATUS_PATH,
  MAINTENANCE_STOPPED_PROBLEM_CODE,
  type MaintenanceState,
  type MaintenanceStatusResponse,
} from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import {
  recordRuntimeControlObservation,
  type RuntimeControlObservationRecorder,
} from '../../infrastructure/observability/runtime-control-observability'
import {
  runtimeControlAllowsExecution,
  runtimeControlAllowsReads,
  type RuntimeControlProvider,
  type RuntimeControlSnapshot,
} from '../../infrastructure/runtime/runtime-control'
import {
  getSafeRuntimeControlSnapshot,
  readRuntimeControlObservedAt,
  recordRuntimeControlObservationSafely,
} from '../composition/runtime-control-safety'
import { readCanonicalCorrelationId } from './common-middleware'
import { isReadOnlyRequest } from './read-only-request-registry'

/**
 * Dependencies required by the API runtime-control gate.
 */
export interface RuntimeControlMiddlewareDependencies {
  /**
   * Generates a server-controlled identifier when common middleware is absent.
   *
   * @returns Opaque correlation identifier.
   */
  readonly createIdentifier?: () => string
  /** Timestamp source used for bounded decision telemetry. */
  readonly now?: () => number
  /** API-scoped runtime-control provider. */
  readonly provider: RuntimeControlProvider
  /** Optional destination for bounded runtime-control observations. */
  readonly recordObservation?: RuntimeControlObservationRecorder
}

const RUNTIME_CONTROL_RETRY_AFTER_SECONDS = 15

/** Full path of the unauthenticated maintenance status route. */
const MAINTENANCE_STATUS_ROUTE = `/api${MAINTENANCE_STATUS_PATH}`

/**
 * Fixed problem documents returned when the gate rejects a request.
 */
const BLOCKED_PROBLEMS = Object.freeze({
  'read-only': Object.freeze({
    type: `https://docs.mukuroji.app/problems/${MAINTENANCE_READ_ONLY_PROBLEM_CODE}`,
    title: 'Service in read-only maintenance',
    code: MAINTENANCE_READ_ONLY_PROBLEM_CODE,
    detail: 'The service is in read-only maintenance. Changes cannot be saved until it ends.',
  }),
  stopped: Object.freeze({
    type: `https://docs.mukuroji.app/problems/${MAINTENANCE_STOPPED_PROBLEM_CODE}`,
    title: 'Service under maintenance',
    code: MAINTENANCE_STOPPED_PROBLEM_CODE,
    detail: 'The service is stopped for maintenance.',
  }),
  unavailable: Object.freeze({
    type: 'https://docs.mukuroji.app/problems/temporarily_unavailable',
    title: 'Service temporarily unavailable',
    code: 'temporarily_unavailable',
    detail: 'The service is temporarily unavailable.',
  }),
})

/**
 * Maps an effective snapshot to the maintenance state the Web app shows.
 *
 * Only a current or bounded-stale document that an operator deployed counts as maintenance; an
 * unreadable or invalid control is an outage.
 *
 * @param snapshot - Effective request snapshot.
 * @returns Maintenance state for the snapshot.
 */
export function resolveMaintenanceState(
  snapshot: RuntimeControlSnapshot,
): MaintenanceState {
  if (snapshot.status !== 'current' && snapshot.status !== 'stale') {
    return 'unavailable'
  }
  if (snapshot.mode === 'enabled') return 'none'
  return snapshot.mode === 'read-only' ? 'read-only' : 'stopped'
}

/**
 * Marks a response as one that must not be cached.
 *
 * @param context - Request context whose response headers are set.
 */
function setNoStoreHeaders(context: Context): void {
  context.header('Cache-Control', 'no-store')
  context.header('Pragma', 'no-cache')
}

/**
 * Adds the read-only maintenance header to an admitted response.
 *
 * Some responses, such as `Response.redirect`, carry immutable headers; those are
 * copied into a new response first.
 *
 * @param context - Request context holding the route's response.
 */
function markReadOnlyResponse(context: Context): void {
  try {
    context.res.headers.set(MAINTENANCE_STATE_HEADER, 'read-only')
  } catch {
    const response = new Response(context.res.body, context.res)
    response.headers.set(MAINTENANCE_STATE_HEADER, 'read-only')
    context.res = response
  }
}

/**
 * Registers the API admission gate after correlation/CORS middleware and
 * before authentication, audit, or route middleware.
 *
 * Liveness and CORS preflight never consult AppConfig. Readiness evaluates the
 * same API-scoped provider through its dedicated readiness probe so it can use
 * the stricter current-and-enabled rule. `GET /api/maintenance` answers the
 * maintenance state here without authentication. In `read-only` mode only
 * requests that {@link isReadOnlyRequest} accepts reach the routes, and every
 * admitted response carries the maintenance header.
 *
 * @param app - Hono application receiving the API gate.
 * @param dependencies - Scoped provider and safe telemetry dependencies.
 */
export function registerRuntimeControlMiddleware(
  app: Hono,
  dependencies: RuntimeControlMiddlewareDependencies,
): void {
  const createIdentifier =
    dependencies.createIdentifier ?? (() => crypto.randomUUID())
  const now = dependencies.now ?? Date.now
  const recordObservation =
    dependencies.recordObservation ?? recordRuntimeControlObservation

  app.use('/api/*', async (context, next) => {
    if (
      context.req.method === 'OPTIONS' ||
      context.req.path === '/api/health' ||
      context.req.path === '/api/ready'
    ) {
      return await next()
    }

    const snapshot = await getSafeRuntimeControlSnapshot(
      dependencies.provider,
    )
    const maintenance = resolveMaintenanceState(snapshot)
    if (
      context.req.path === MAINTENANCE_STATUS_ROUTE &&
      (context.req.method === 'GET' || context.req.method === 'HEAD')
    ) {
      // The status is answered here, before authentication and every route, so the Web app
      // can tell maintenance from an outage even while all other requests are rejected.
      setNoStoreHeaders(context)
      const status: MaintenanceStatusResponse = { state: maintenance }
      return context.json(status)
    }

    const allowed = runtimeControlAllowsExecution(snapshot) || (
      runtimeControlAllowsReads(snapshot) &&
      isReadOnlyRequest(context.req.method, context.req.path)
    )
    recordRuntimeControlObservationSafely(recordObservation, {
      observedAtMilliseconds: readRuntimeControlObservedAt(now),
      outcome: allowed ? 'allowed' : 'blocked',
      snapshot,
      surface: 'api',
    })
    if (allowed) {
      await next()
      if (maintenance === 'read-only') markReadOnlyResponse(context)
      return
    }

    const correlationId =
      readCanonicalCorrelationId(context.req.raw) ?? createIdentifier()
    setNoStoreHeaders(context)
    context.header(
      'Retry-After',
      String(RUNTIME_CONTROL_RETRY_AFTER_SECONDS),
    )
    if (maintenance === 'read-only' || maintenance === 'stopped') {
      context.header(MAINTENANCE_STATE_HEADER, maintenance)
    }
    const problem = maintenance === 'read-only' || maintenance === 'stopped'
      ? BLOCKED_PROBLEMS[maintenance]
      : BLOCKED_PROBLEMS.unavailable
    return context.json({
      type: problem.type,
      title: problem.title,
      status: 503,
      code: problem.code,
      detail: problem.detail,
      correlationId,
      retryable: true,
    }, 503, {
      'Content-Type': 'application/problem+json; charset=UTF-8',
    })
  })
}
