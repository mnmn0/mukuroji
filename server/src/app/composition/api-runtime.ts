import type { Hono } from 'hono'
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda'
import type { AppDependencies } from './app-dependencies'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { createApiHandler, createApp } from '../createApp'
import { createProductionAppDependencies } from './api-dependencies'

const productionDependencies: AppDependencies = createProductionAppDependencies()

/** Production Hono application shared by the API Lambda and Bun development server. */
export const app = createApp(productionDependencies)

const apiHandler = createApiHandler(productionDependencies)

/** Validates production-only configuration required by the API runtime. */
export function validateApiServerConfig(): void {
  if (!loadServerConfig().runtimeRole) {
    void loadServerConfig().publicApiCursorSecret
  }
}

/**
 * Dispatches an HTTP event to the instance-scoped production application.
 *
 * @param event - API Gateway or Lambda Function URL event.
 * @param lambdaContext - Optional Lambda invocation context.
 * @returns The Hono Lambda response.
 */
export const handler = (
  event: LambdaEvent,
  lambdaContext?: LambdaContext,
) => {
  validateApiServerConfig()
  return apiHandler(event, lambdaContext)
}

/** Bun development-server entrypoint. */
const bunServer = {
  port: loadServerConfig().port,
  fetch: (...args: Parameters<Hono['fetch']>) => app.fetch(...args),
}

export default bunServer
