import { describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import { createAuditRouter } from './audit-router'

/** Export job handlers that echo the route they served. */
const exportJobs = {
  create: (context: Context) => context.json({ route: 'create' }),
  list: (context: Context) => context.json({ route: 'list' }),
  get: (context: Context) => context.json({ route: 'get', exportId: context.req.param('exportId') }),
  download: (context: Context) => context.json({ route: 'download', exportId: context.req.param('exportId') }),
}

describe('createAuditRouter', () => {
  test('preserves query and NDJSON export route modes', async () => {
    const modes: boolean[] = []
    const router = createAuditRouter((context, exportAsNdjson) => {
      modes.push(exportAsNdjson)
      return context.json({ exportAsNdjson })
    }, exportJobs)

    expect(await (await router.request('/api/audit/events')).json()).toEqual({
      exportAsNdjson: false,
    })
    expect(await (await router.request('/api/audit/events/export')).json()).toEqual({
      exportAsNdjson: true,
    })
    expect(modes).toEqual([false, true])
  })

  test('routes asynchronous export job requests', async () => {
    const router = createAuditRouter((context) => context.json({}), exportJobs)
    const exportId = 'a'.repeat(32)

    expect(await (await router.request('/api/audit/exports', { method: 'POST' })).json()).toEqual({ route: 'create' })
    expect(await (await router.request('/api/audit/exports')).json()).toEqual({ route: 'list' })
    expect(await (await router.request(`/api/audit/exports/${exportId}`)).json()).toEqual({ route: 'get', exportId })
    expect(await (await router.request(`/api/audit/exports/${exportId}/download`)).json())
      .toEqual({ route: 'download', exportId })
  })
})
