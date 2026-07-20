import { Hono, type Context } from 'hono'

/** Audit HTTP adapter に注入する application operation です。 */
export type AuditRequestHandler = (
  context: Context,
  exportAsNdjson: boolean,
) => Response | Promise<Response>

/** Workspace audit query/export HTTP routes を作成します。 */
export function createAuditRouter(handleRequest: AuditRequestHandler) {
  const router = new Hono()
  router.get('/api/audit/events', (context) => handleRequest(context, false))
  router.get('/api/audit/events/export', (context) => handleRequest(context, true))
  return router
}
