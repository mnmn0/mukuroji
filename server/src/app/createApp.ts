import { Hono } from 'hono'
import {
  handle,
  type LambdaContext,
  type LambdaEvent,
} from 'hono/aws-lambda'
import {
  auditRejectedEnterpriseSecurityMutation,
  bindApiDependencies,
  getAllowedOrigins,
  normalizeLambdaApiEvent,
  registerApiRoutes,
} from '../api/api-router'
import type { AppDependencies } from './composition/app-dependencies'
import { registerCommonMiddleware } from './middleware/common-middleware'
import { createSystemRouter } from './routes/system-router'

/**
 * Creates an API application with common middleware and domain routers.
 *
 * @param dependencies - Immutable domain dependency bundles owned by this app instance.
 * @returns A Hono application bound to the supplied dependencies.
 */
export function createApp(dependencies: AppDependencies): Hono {
  const app = bindApiDependencies(new Hono(), dependencies)

  registerCommonMiddleware(app, {
    getAllowedOrigins,
    auditRejectedEnterpriseSecurityMutation,
    createIdentifier: () => crypto.randomUUID(),
    now: Date.now,
    recordAccess: dependencies.operational.recordAccess,
    recordError: dependencies.operational.recordError,
  })
  app.route('/', createSystemRouter({
    readiness: dependencies.operational.readiness,
  }))
  registerApiRoutes(app)

  return app
}

/**
 * Creates an API Lambda handler bound to one dependency graph.
 *
 * @param dependencies - Immutable domain dependency bundles owned by the handler.
 * @returns A Lambda-compatible API handler.
 */
export function createApiHandler(dependencies: AppDependencies) {
  const lambdaHandler = handle(createApp(dependencies))
  return (event: LambdaEvent, lambdaContext?: LambdaContext) =>
    lambdaHandler(normalizeLambdaApiEvent(event), lambdaContext)
}

export type { AppDependencies } from './composition/app-dependencies'
