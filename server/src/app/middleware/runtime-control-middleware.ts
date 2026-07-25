import type { Hono } from 'hono'
import {
  recordRuntimeControlObservation,
  type RuntimeControlObservationRecorder,
} from '../../infrastructure/observability/runtime-control-observability'
import {
  runtimeControlAllowsExecution,
  type RuntimeControlProvider,
  type RuntimeControlSnapshot,
} from '../../infrastructure/runtime/runtime-control'
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

    const snapshot = await getSafeSnapshot(dependencies.provider)
    const allowed = runtimeControlAllowsExecution(snapshot)
    recordObservationSafely(recordObservation, {
      observedAtMilliseconds: readObservedAt(now),
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

/**
 * Converts an unexpected provider rejection into a disabled unavailable state.
 *
 * @param provider - API-scoped provider.
 * @returns Provider state or a redacted fail-closed substitute.
 */
async function getSafeSnapshot(
  provider: RuntimeControlProvider,
): Promise<RuntimeControlSnapshot> {
  try {
    return await provider.getSnapshot()
  } catch {
    return Object.freeze({
      mode: 'disabled',
      status: 'unavailable',
    })
  }
}

/**
 * Emits safe decision telemetry without making observability authoritative.
 *
 * @param recorder - Observation destination.
 * @param observation - Bounded API decision.
 */
function recordObservationSafely(
  recorder: RuntimeControlObservationRecorder,
  observation: Parameters<RuntimeControlObservationRecorder>[0],
): void {
  try {
    recorder(observation)
  } catch {
    // Admission remains authoritative when telemetry is unavailable.
  }
}

/**
 * Reads a bounded observation timestamp.
 *
 * @param now - Candidate timestamp source.
 * @returns Non-negative safe integer timestamp or zero.
 */
function readObservedAt(now: () => number): number {
  try {
    const observedAtMilliseconds = now()
    return Number.isSafeInteger(observedAtMilliseconds) &&
      observedAtMilliseconds >= 0
      ? observedAtMilliseconds
      : 0
  } catch {
    return 0
  }
}
