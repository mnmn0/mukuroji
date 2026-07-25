import type { Hono } from 'hono'
import {
  recordRuntimeControlObservation,
  type RuntimeControlObservationRecorder,
} from '../../infrastructure/observability/runtime-control-observability'
import {
  runtimeControlAllowsExecution,
  type RuntimeControlProvider,
} from '../../infrastructure/runtime/runtime-control'
import {
  getSafeRuntimeControlSnapshot,
  readRuntimeControlObservedAt,
  recordRuntimeControlObservationSafely,
} from '../composition/runtime-control-safety'
import { readCanonicalCorrelationId } from './common-middleware'

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

/**
 * Registers the API admission gate after correlation/CORS middleware and
 * before authentication, audit, or route middleware.
 *
 * Liveness and CORS preflight never consult AppConfig. Readiness evaluates the
 * same API-scoped provider through its dedicated readiness probe so it can use
 * the stricter current-and-enabled rule.
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
    const allowed = runtimeControlAllowsExecution(snapshot)
    recordRuntimeControlObservationSafely(recordObservation, {
      observedAtMilliseconds: readRuntimeControlObservedAt(now),
      outcome: allowed ? 'allowed' : 'blocked',
      snapshot,
      surface: 'api',
    })
    if (allowed) return await next()

    const correlationId =
      readCanonicalCorrelationId(context.req.raw) ?? createIdentifier()
    context.header('Cache-Control', 'no-store')
    context.header('Pragma', 'no-cache')
    context.header(
      'Retry-After',
      String(RUNTIME_CONTROL_RETRY_AFTER_SECONDS),
    )
    return context.json({
      type: 'https://docs.mukuroji.app/problems/temporarily_unavailable',
      title: 'Service temporarily unavailable',
      status: 503,
      code: 'temporarily_unavailable',
      detail: 'The service is temporarily unavailable.',
      correlationId,
      retryable: true,
    }, 503, {
      'Content-Type': 'application/problem+json; charset=UTF-8',
    })
  })
}
