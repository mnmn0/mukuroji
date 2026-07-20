import { describe, expect, test } from 'bun:test'
import { createAuditRouter } from './audit-router'

describe('createAuditRouter', () => {
  test('preserves query and NDJSON export route modes', async () => {
    const modes: boolean[] = []
    const router = createAuditRouter((context, exportAsNdjson) => {
      modes.push(exportAsNdjson)
      return context.json({ exportAsNdjson })
    })

    expect(await (await router.request('/api/audit/events')).json()).toEqual({
      exportAsNdjson: false,
    })
    expect(await (await router.request('/api/audit/events/export')).json()).toEqual({
      exportAsNdjson: true,
    })
    expect(modes).toEqual([false, true])
  })
})
