import { describe, expect, test } from 'bun:test'
import { createAuditExportWorker } from './audit-export-worker'

describe('audit export worker', () => {
  test('runs one step per valid message and sends failures and malformed messages back for redrive', async () => {
    const steps: string[] = []
    const logs: string[] = []
    const worker = createAuditExportWorker({
      async processExport(workspaceId, exportId, messageId) {
        steps.push(`${workspaceId}/${exportId}@${messageId}`)
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

    // The SQS message ID is passed so a redelivered committed step only resends its continuation.
    expect(steps).toEqual([`ws-1/${'a'.repeat(32)}@m1`, `ws-1/${'b'.repeat(32)}@m2`])
    // Malformed messages are failures too, so the redrive policy quarantines them in the DLQ.
    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: 'm2' },
      { itemIdentifier: 'm3' },
      { itemIdentifier: 'm4' },
      { itemIdentifier: 'm5' },
    ])
    expect(logs.filter((message) => message.includes('malformed'))).toHaveLength(3)
  })
})
