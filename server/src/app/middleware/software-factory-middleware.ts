import type { Context, Hono } from 'hono'
import { SOFTWARE_FACTORY_NOT_DEPLOYED_CODE } from '../../infrastructure/config/software-factory'

/**
 * Dependencies of the Software factory deployment gate.
 */
export interface SoftwareFactoryMiddlewareDependencies {
  /**
   * Reads whether this deployment includes the Software factory module.
   *
   * @returns Whether Software factory routes may run.
   */
  readonly deployed: () => boolean
}

/**
 * One group of routes the gate refuses while Software factory is not deployed.
 */
type SoftwareFactoryRoute = Readonly<{
  /** Hono path patterns, matched by the same router that serves the routes. */
  readonly paths: readonly string[]
  /** HTTP methods refused on the paths; every method when omitted. */
  readonly methods?: readonly string[]
}>

/**
 * Routes that exist only for Software factory: the Web Factory board, Agent Run history,
 * reports, and analytics, Team agent settings, the Public API Agent Run and agent context
 * endpoints that coding agents call through MCP, and the issuance of personal agent
 * credentials. Revoking a personal credential stays available so that keys issued while the
 * module was on can still be removed.
 */
const SOFTWARE_FACTORY_ROUTES: readonly SoftwareFactoryRoute[] = [
  {
    paths: [
      '/api/teams/:teamId/work-items/:workItemId/agent-runs',
      '/api/teams/:teamId/work-items/:workItemId/agent-runs/*',
      '/api/teams/:teamId/work-items/:workItemId/agent-run-reports',
      '/api/teams/:teamId/work-items/:workItemId/agent-run-reports/*',
      '/api/teams/:teamId/agent-runs',
      '/api/teams/:teamId/agent-runs/*',
      '/api/teams/:teamId/agent-settings',
      '/api/teams/:teamId/agent-settings/*',
      '/api/v1/work-items/:workItemId/agent-runs',
      '/api/v1/work-items/:workItemId/agent-runs/*',
      '/api/v1/agent-runs',
      '/api/v1/agent-runs/*',
      '/api/v1/agent-settings',
      '/api/v1/agent-settings/*',
      '/api/v1/agent-context',
      '/api/v1/agent-context/*',
      '/api/developer/me/agent-connection',
      '/api/developer/me/agent-connection/*',
    ],
  },
  {
    paths: [
      '/api/developer/me/api-keys',
      '/api/developer/me/api-keys/:apiKeyId/rotate',
    ],
    methods: ['POST'],
  },
]

/**
 * Builds the response for a route of a module this deployment does not include.
 *
 * Public API paths answer with a problem document so that API clients parse it like their
 * other errors; Web paths use the `{ code, message }` body the Web API already returns.
 *
 * @param context - Request context.
 * @returns A non-retryable 503 response.
 */
function softwareFactoryNotDeployed(context: Context): Response {
  const message = 'Software factory is not deployed in this environment.'
  context.header('Cache-Control', 'no-store')
  const path = context.req.path
  if (path.startsWith('/api/v1/') || path.startsWith('/api/developer/')) {
    return context.json({
      type: 'https://docs.mukuroji.app/problems/software_factory_not_deployed',
      title: 'Software Factory Not Deployed',
      status: 503,
      code: SOFTWARE_FACTORY_NOT_DEPLOYED_CODE,
      detail: message,
      instance: path,
      retryable: false,
    }, 503, {
      'Content-Type': 'application/problem+json; charset=utf-8',
    })
  }
  return context.json({ code: SOFTWARE_FACTORY_NOT_DEPLOYED_CODE, message }, 503)
}

/**
 * Registers the gate that refuses Software factory routes when the deployment omits the
 * module. It runs before authentication so that no Agent Run, agent setting, or credential
 * work starts.
 *
 * Register it after the common and runtime-control middleware and before the domain routes.
 *
 * @param app - Hono application receiving the gate.
 * @param dependencies - Deployment switch reader.
 */
export function registerSoftwareFactoryMiddleware(
  app: Hono,
  dependencies: SoftwareFactoryMiddlewareDependencies,
): void {
  for (const route of SOFTWARE_FACTORY_ROUTES) {
    for (const path of route.paths) {
      app.use(path, async (context, next) => {
        const method = context.req.method.toUpperCase()
        const refused = method !== 'OPTIONS' &&
          (route.methods === undefined || route.methods.includes(method))
        if (refused && !dependencies.deployed()) return softwareFactoryNotDeployed(context)
        return await next()
      })
    }
  }
}
