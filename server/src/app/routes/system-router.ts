import { Hono } from 'hono'
import type { ReadinessProbe } from '../../infrastructure/observability/readiness'

/**
 * Dependencies required by liveness and readiness system routes.
 */
export interface SystemRouterDependencies {
  /** Verifies critical runtime configuration and dependencies. */
  readonly readiness: ReadinessProbe
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

  router.get('/', (context) => context.text('mukuroji API'))
  router.get('/api/health', (context) =>
    context.json({ ok: true, status: 'alive' }))
  router.get('/api/ready', async (context) => {
    try {
      const result = await dependencies.readiness.check()
      const body = {
        ok: result.ready,
        status: result.ready ? 'ready' : 'not-ready',
        checks: result.checks,
      }
      return result.ready
        ? context.json(body, 200)
        : context.json(body, 503)
    } catch {
      return context.json({
        ok: false,
        status: 'not-ready',
        checks: [{ name: 'readiness-probe', ready: false }],
      }, 503)
    }
  })

  return router
}
