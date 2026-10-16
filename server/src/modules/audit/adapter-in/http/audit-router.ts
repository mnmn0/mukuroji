import { Hono, type Context } from 'hono'

/** Audit HTTP adapter に注入する application operation です。 */
export type AuditRequestHandler = (
  context: Context,
  exportAsNdjson: boolean,
) => Response | Promise<Response>

/**
 * Handlers of the asynchronous audit export job routes.
 */
export type AuditExportJobHandlers = {
  /** Creates an export job. */
  readonly create: (context: Context) => Response | Promise<Response>
  /** Lists recent export jobs. */
  readonly list: (context: Context) => Response | Promise<Response>
  /** Reads one export job. */
  readonly get: (context: Context) => Response | Promise<Response>
  /** Issues download links for a completed export job. */
  readonly download: (context: Context) => Response | Promise<Response>
}

/**
 * Creates the Workspace audit query, export, and export job HTTP routes.
 *
 * @param handleRequest - Synchronous audit query and NDJSON export handler.
 * @param exportJobs - Asynchronous export job handlers.
 * @returns The audit router.
 */
export function createAuditRouter(
  handleRequest: AuditRequestHandler,
  exportJobs: AuditExportJobHandlers,
) {
  const router = new Hono()
  router.get('/api/audit/events', (context) => handleRequest(context, false))
  router.get('/api/audit/events/export', (context) => handleRequest(context, true))
  router.post('/api/audit/exports', (context) => exportJobs.create(context))
  router.get('/api/audit/exports', (context) => exportJobs.list(context))
  router.get('/api/audit/exports/:exportId', (context) => exportJobs.get(context))
  router.get('/api/audit/exports/:exportId/download', (context) => exportJobs.download(context))
  return router
}
