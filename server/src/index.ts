import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda'
import { app } from './api/app'

export * from './api/app'

function normalizeLambdaApiEvent(event: LambdaEvent): LambdaEvent {
  if ('rawPath' in event) {
    const rawPath = normalizeApiRequestPath(event.rawPath)

    if (rawPath === event.rawPath) {
      return event
    }

    return {
      ...event,
      rawPath,
      requestContext: {
        ...event.requestContext,
        http: {
          ...event.requestContext.http,
          path: rawPath,
        },
      },
    }
  }

  const path = normalizeApiRequestPath(event.path)

  return path === event.path ? event : { ...event, path }
}

function normalizeApiRequestPath(path: string) {
  if (path === '/' || path === '/api' || path.startsWith('/api/')) {
    return path
  }

  return `/api${path.startsWith('/') ? path : `/${path}`}`
}

function getRuntimeEnv(name: string) {
  if (typeof Bun !== 'undefined') {
    return Bun.env[name]
  }

  return process.env[name]
}

const lambdaHandler = handle(app)

/**
 * Function URL 直下と `/api` prefix 付き event を同じ Hono route へ渡す Lambda handler です。
 */
export const handler = (event: LambdaEvent, lambdaContext?: LambdaContext) => {
  return lambdaHandler(normalizeLambdaApiEvent(event), lambdaContext)
}

/**
 * Bun のローカル開発サーバー entrypoint です。
 */
const developmentServer = {
  port: Number(getRuntimeEnv('PORT') ?? 3000),
  fetch: app.fetch,
}

export default developmentServer
