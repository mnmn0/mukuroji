import { describe, expect, test } from 'bun:test'
import { createAuditExportWorker } from './audit-export-worker'

describe('audit export worker', () => {
  test('runs one step per valid message, drops malformed ones, and retries failures', async () => {
    const steps: string[] = []
    const logs: string[] = []
    const worker = createAuditExportWorker({
      async processExport(workspaceId, exportId) {
        steps.push(`${workspaceId}/${exportId}`)
        if (exportId === 'b'.repeat(32)) throw new Error('S3 unavailable')
        return 'advanced'
      },
    }, (message) => logs.push(message))

    const response = await worker({
      Records: [
        { messageId: 'm1', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: 'a'.repeat(32) }) },
        { messageId: 'm2', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: 'b'.repeat(32) }) },
        { messageId: 'm3', body: '{"version":2}' },
        { messageId: 'm4', body: 'not json' },
        { messageId: 'm5', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: '../job' }) },
      ],
    })

    expect(steps).toEqual([`ws-1/${'a'.repeat(32)}`, `ws-1/${'b'.repeat(32)}`])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }])
    expect(logs.filter((message) => message.includes('malformed'))).toHaveLength(3)
  })
})
