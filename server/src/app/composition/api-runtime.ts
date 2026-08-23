import {
  Hono,
  type Context,
  type ExecutionContext,
} from 'hono'
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { createApiHandler, createApp } from '../createApp'
import { createProductionAppDependencies } from './api-dependencies'
import { hydrateApiRuntimeEnvironment } from './api-runtime-environment'

/**
 * Builds the production API only after its external configuration is loaded.
 *
 * @returns The configured Hono application and Lambda adapter.
 */
async function createProductionRuntime() {
  await getApiRuntimeEnvironmentHydration()
  const productionDependencies = createProductionAppDependencies()
  const application = createApp(productionDependencies)
  validateApiServerConfig()
  return {
    apiHandler: createApiHandler(productionDependencies),
    application,
  }
}

let apiRuntimeEnvironmentHydrationPromise: Promise<void> | undefined
let productionRuntimePromise:
  ReturnType<typeof createProductionRuntime> | undefined

/**
 * Hydrates external configuration once while permitting a failed fetch to retry.
 *
 * A successful hydration remains process-stable so a later dependency
 * construction failure does not reinterpret its own decoded values as
 * competing discrete configuration.
 *
 * @returns The successful or current environment-hydration attempt.
 */
function getApiRuntimeEnvironmentHydration(): Promise<void> {
  if (apiRuntimeEnvironmentHydrationPromise !== undefined) {
    return apiRuntimeEnvironmentHydrationPromise
  }
  const hydration = hydrateApiRuntimeEnvironment()
  apiRuntimeEnvironmentHydrationPromise = hydration
  void hydration.catch(() => {
    if (apiRuntimeEnvironmentHydrationPromise === hydration) {
      apiRuntimeEnvironmentHydrationPromise = undefined
    }
  })
  return hydration
}

/**
 * Returns a retryable cold-start singleton for production composition.
 *
 * @returns The current or newly started production-runtime initialization.
 */
function getProductionRuntime(): ReturnType<typeof createProductionRuntime> {
  if (productionRuntimePromise !== undefined) {
    return productionRuntimePromise
  }
  const initialization = createProductionRuntime()
  productionRuntimePromise = initialization
  void initialization.catch(() => {
    if (productionRuntimePromise === initialization) {
      productionRuntimePromise = undefined
    }
  })
  return initialization
}

/** Validates production-only configuration required by the API runtime. */
export function validateApiServerConfig(): void {
  if (!loadServerConfig().runtimeRole) {
    void loadServerConfig().publicApiCursorSecret
  }
}

/**
 * Production-compatible Hono facade for local tooling and package consumers.
 *
 * The real application remains lazy so Lambda can retrieve configuration
 * before any production dependencies are constructed.
 */
export const app = new Hono()

app.all('*', async (context) => {
  const runtime = await getProductionRuntime()
  return await runtime.application.fetch(
    context.req.raw,
    context.env,
    readOptionalExecutionContext(context),
  )
})

/**
 * Reads the outer Hono execution context when the facade runtime supplies one.
 *
 * Hono's accessor intentionally throws for local `app.request()` calls, so the
 * lazy facade must preserve that supported context-free path.
 *
 * @param context - Outer lazy-facade request context.
 * @returns The runtime execution context, or undefined for local requests.
 */
function readOptionalExecutionContext(
  context: Context,
): ExecutionContext | undefined {
  try {
    return context.executionCtx
  } catch {
    return undefined
  }
}

/**
 * Dispatches an HTTP event to the lazily configured production application.
 *
 * @param event - API Gateway or Lambda Function URL event.
 * @param lambdaContext - Optional Lambda invocation context.
 * @returns The Hono Lambda response.
 */
export const handler = async (
  event: LambdaEvent,
  lambdaContext?: LambdaContext,
) => {
  const runtime = await getProductionRuntime()
  return await runtime.apiHandler(event, lambdaContext)
}

/** Bun development-server entrypoint. */
const bunServer = {
  port: loadServerConfig().port,
  fetch: async (...args: Parameters<Hono['fetch']>) => {
    const runtime = await getProductionRuntime()
    return await runtime.application.fetch(...args)
  },
}

export default bunServer
