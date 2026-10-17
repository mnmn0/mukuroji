import { describe, expect, test } from 'bun:test'
import { createAuditExportWorker } from './audit-export-worker'

describe('audit export worker', () => {
  test('runs one step per valid message and sends failures and malformed messages back for redrive', async () => {
    const steps: string[] = []
    const logs: string[] = []
    const details: Record<string, string>[] = []
    const worker = createAuditExportWorker({
      async processExport(workspaceId, exportId, messageId) {
        steps.push(`${workspaceId}/${exportId}@${messageId}`)
        if (exportId === 'b'.repeat(32)) throw new Error('S3 unavailable')
        return 'advanced'
      },
    }, (message, detail) => {
      logs.push(message)
      details.push(detail)
    })

    const response = await worker({
      Records: [
        { messageId: 'm1', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: 'a'.repeat(32), correlationId: 'corr-1' }) },
        { messageId: 'm2', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: 'b'.repeat(32), correlationId: 'corr-2' }) },
        { messageId: 'm3', body: '{"version":2}' },
        { messageId: 'm4', body: 'not json' },
        { messageId: 'm5', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: '../job' }) },
        // A padded Workspace ID would address another tenant prefix, so it is malformed.
        { messageId: 'm6', body: JSON.stringify({ version: 1, workspaceId: ' ws-1 ', exportId: 'c'.repeat(32), correlationId: 'corr-6' }) },
        // Step logs are traced by the request correlation ID, so a message without a usable one is malformed.
        { messageId: 'm7', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: 'd'.repeat(32) }) },
        { messageId: 'm8', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: 'd'.repeat(32), correlationId: ' ' }) },
        { messageId: 'm9', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: 'd'.repeat(32), correlationId: ' corr-9' }) },
        { messageId: 'm10', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: 'd'.repeat(32), correlationId: 'c'.repeat(257) }) },
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
      { itemIdentifier: 'm6' },
      { itemIdentifier: 'm7' },
      { itemIdentifier: 'm8' },
      { itemIdentifier: 'm9' },
      { itemIdentifier: 'm10' },
    ])
    expect(logs.filter((message) => message.includes('malformed'))).toHaveLength(8)
    // A failed step is logged with the correlation ID of the request that started the export.
    expect(details).toContainEqual({
      messageId: 'm2',
      exportId: 'b'.repeat(32),
      correlationId: 'corr-2',
      errorType: 'Error',
    })
  })
})
