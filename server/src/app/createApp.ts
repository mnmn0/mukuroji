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
import {
  createRuntimeControlAwareReadinessProbe,
} from './composition/runtime-control'
import {
  registerCommonMiddleware,
  registerEnterpriseSecurityAuditMiddleware,
} from './middleware/common-middleware'
import {
  registerRuntimeControlMiddleware,
} from './middleware/runtime-control-middleware'
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
    createIdentifier: () => crypto.randomUUID(),
    now: Date.now,
    recordAccess: dependencies.operational.recordAccess,
    recordError: dependencies.operational.recordError,
  })
  registerRuntimeControlMiddleware(app, {
    provider: dependencies.operational.runtimeControl,
    recordObservation: dependencies.operational.recordRuntimeControl,
  })
  registerEnterpriseSecurityAuditMiddleware(
    app,
    auditRejectedEnterpriseSecurityMutation,
  )
  app.route('/', createSystemRouter({
    ...(dependencies.operational.applicationCommitSha === undefined
      ? {}
      : { applicationCommitSha: dependencies.operational.applicationCommitSha }),
    readiness: createRuntimeControlAwareReadinessProbe(
      dependencies.operational.readiness,
      dependencies.operational.runtimeControl,
      dependencies.operational.recordRuntimeControl,
    ),
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
