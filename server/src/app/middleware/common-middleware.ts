import type { Hono, MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'

/**
 * API 共通 middleware の組み立てに必要な依存です。
 */
export interface CommonMiddlewareDependencies {
  /** 現在許可されている browser origin を返します。 */
  getAllowedOrigins(): readonly string[]
  /** Enterprise security mutation の拒否結果を audit します。 */
  auditRejectedEnterpriseSecurityMutation: MiddlewareHandler
}

/**
 * CORS、機密 response header、拒否監査 middleware を app へ登録します。
 */
export function registerCommonMiddleware(
  app: Hono,
  dependencies: CommonMiddlewareDependencies,
): void {
  app.use(
    '/api/*',
    cors({
      origin: (origin) =>
        dependencies.getAllowedOrigins().includes(origin)
          ? origin
          : undefined,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'Idempotency-Key',
        'X-Break-Glass-Reason',
        'X-Correlation-Id',
        'X-Request-Id',
      ],
      exposeHeaders: ['X-Audit-Truncated', 'X-Audit-Next-Cursor'],
    }),
  )

  app.use('/api/*', async (context, next) => {
    await next()
    if (
      context.req.path.startsWith('/api/request-') ||
      context.req.path.startsWith('/api/enterprise/security') ||
      context.req.path.startsWith('/api/auth/sso') ||
      context.req.path.startsWith('/api/scim/')
    ) {
      context.header('Cache-Control', 'private, no-store')
      context.header('Pragma', 'no-cache')
      context.header('Referrer-Policy', 'no-referrer')
    }
  })

  app.use(
    '/api/enterprise/security/*',
    dependencies.auditRejectedEnterpriseSecurityMutation,
  )
  app.use(
    '/api/scim/*',
    dependencies.auditRejectedEnterpriseSecurityMutation,
  )
}
