import { Hono } from 'hono'

/**
 * Root banner と API health contract を提供する router を作成します。
 */
export function createSystemRouter(): Hono {
  const router = new Hono()

  router.get('/', (context) => context.text('mukuroji API'))
  router.get('/api/health', (context) => context.json({ ok: true }))

  return router
}
