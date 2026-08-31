import { Hono } from 'hono'
import { classifyApiError } from '../../infrastructure/observability/api-observability'
import {
  type ReadinessFailureRecorder,
  type ReadinessProbe,
  recordReadinessFailure,
  resolveReadinessCorrelationId,
} from '../../infrastructure/observability/readiness'

/**
 * Dependencies required by liveness and readiness system routes.
 */
export interface SystemRouterDependencies {
  /** Full Git commit SHA identifying this deployed API runtime, when configured. */
  readonly applicationCommitSha?: string
  /**
   * Generates a server-controlled correlation identifier when middleware
   * context is unavailable or invalid.
   *
   * @returns A canonical opaque identifier.
   */
  readonly createIdentifier?: () => string
  /** Verifies critical runtime configuration and dependencies. */
  readonly readiness: ReadinessProbe
  /** Optional destination for safe unexpected readiness failure observations. */
  readonly recordFailure?: ReadinessFailureRecorder
}

/**
 * Creates root banner, liveness, and dependency-aware readiness routes.
 *
 * @param dependencies - Operational probes kept outside domain modules.
 * @returns A router exposing safe system status contracts.
 */
export function createSystemRouter(
  dependencies: SystemRouterDependencies,
): Hono {
  const router = new Hono()
  const createIdentifier =
    dependencies.createIdentifier ?? (() => crypto.randomUUID())
  const recordFailure =
    dependencies.recordFailure ?? recordReadinessFailure

  router.get('/', (context) => context.text('mukuroji API'))
  router.get('/api/health', (context) => {
    context.header('Cache-Control', 'no-store')
    return context.json({
      ok: true,
      status: 'alive',
      ...(dependencies.applicationCommitSha === undefined
        ? {}
        : { applicationCommitSha: dependencies.applicationCommitSha }),
    })
  })
  router.get('/api/ready', async (context) => {
    const correlationId = resolveReadinessCorrelationId(
      context.req.header('X-Correlation-Id'),
      createIdentifier,
    )
    try {
      const result = await dependencies.readiness.check(correlationId)
      const body = {
        ok: result.ready,
        status: result.ready ? 'ready' : 'not-ready',
        checks: result.checks,
      }
      return result.ready
        ? context.json(body, 200)
        : context.json(body, 503)
    } catch (error) {
      recordFailure({
        correlationId,
        dependency: 'readiness-probe',
        errorType: classifyApiError(error),
      })
      return context.json({
        ok: false,
        status: 'not-ready',
        checks: [{ name: 'readiness-probe', ready: false }],
      }, 503)
    }
  })

  return router
}
