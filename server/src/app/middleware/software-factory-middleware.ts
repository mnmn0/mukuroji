import type { Hono } from 'hono'
import { softwareFactoryNotDeployedResponse } from '../../infrastructure/http/software-factory-not-deployed'

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
 * endpoints that coding agents call through MCP, and the agent telemetry receiver. Personal credentials stay available, because
 * the Workspace MCP profile reads the Workspace with them whether or not the module is on.
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
      '/api/v1/work-items/:workItemId/agent-run-questions',
      '/api/v1/agent-runs',
      '/api/v1/agent-runs/*',
      '/api/v1/agent-settings',
      '/api/v1/agent-settings/*',
      '/api/v1/agent-context',
      '/api/v1/agent-context/*',
      '/api/v1/agent-telemetry/*',
    ],
  },
]

/**
 * Registers the gate that refuses Software factory routes when the deployment omits the
 * module. It runs before authentication so that no Agent Run or agent setting
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
        if (refused && !dependencies.deployed()) {
          const publicApi = context.req.path.startsWith('/api/v1/') ||
            context.req.path.startsWith('/api/developer/')
          return softwareFactoryNotDeployedResponse(context, publicApi ? 'problem' : 'web')
        }
        return await next()
      })
    }
  }
}
