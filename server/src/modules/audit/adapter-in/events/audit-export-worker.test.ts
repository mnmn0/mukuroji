import { describe, expect, test } from 'bun:test'
import { createAuditExportService, type AuditExportJob, type AuditExportStore } from '../../audit-export'
import { createAuditExportWorker } from './audit-export-worker'

/**
 * Creates an in-memory export store keyed by Workspace and export ID.
 *
 * @returns A store whose job versions advance on each replacement.
 */
function createMemoryStore(): AuditExportStore {
  const jobs = new Map<string, { job: AuditExportJob; version: number }>()
  return {
    async createJob(job) {
      const key = `${job.workspaceId}/${job.exportId}`
      if (jobs.has(key)) return 'exists'
      jobs.set(key, { job, version: 1 })
      return 'created'
    },
    async readJob(workspaceId, exportId) {
      const entry = jobs.get(`${workspaceId}/${exportId}`)
      return entry ? { job: entry.job, version: String(entry.version) } : undefined
    },
    async replaceJob(job, expectedVersion) {
      const key = `${job.workspaceId}/${job.exportId}`
      const entry = jobs.get(key)
      if (!entry || String(entry.version) !== expectedVersion) return false
      jobs.set(key, { job, version: entry.version + 1 })
      return true
    },
    async listJobs(workspaceId) {
      return [...jobs.values()].map((entry) => entry.job).filter((job) => job.workspaceId === workspaceId)
    },
    async putPart(_workspaceId, exportId, index, body) {
      return { key: `audit-exports/test/${exportId}/part-${index}.ndjson`, byteLength: body.length, sha256: 'digest' }
    },
    async createPartDownloadUrl(_workspaceId, _exportId, part) {
      return `https://download.test/${part.key}`
    },
  }
}

describe('audit export worker', () => {
  test('runs one step per valid message and sends failures and malformed messages back for redrive', async () => {
    const steps: string[] = []
    const logs: string[] = []
    const details: Record<string, string>[] = []
    const worker = createAuditExportWorker({
      async processExport(workspaceId, exportId, correlationId, messageId) {
        steps.push(`${workspaceId}/${exportId}#${correlationId}@${messageId}`)
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
    // The message's correlation ID is passed so the service can bind it to the stored job.
    expect(steps).toEqual([`ws-1/${'a'.repeat(32)}#corr-1@m1`, `ws-1/${'b'.repeat(32)}#corr-2@m2`])
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

  test('sends a message whose correlation ID differs from the stored job back for redrive', async () => {
    const store = createMemoryStore()
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      readEvents: async () => ({ events: [] }),
      countEvents: async () => ({ count: 0 }),
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      createId: () => 'a'.repeat(32),
    })
    const { job } = await service.requestExport({
      workspaceId: 'ws-1',
      requestedBy: { userKey: 'admin@example.com', displayName: 'Admin' },
      correlationId: 'corr-stored',
      filters: {},
    })
    const before = await store.readJob('ws-1', job.exportId)
    const details: Record<string, string>[] = []
    const worker = createAuditExportWorker(service, (_message, detail) => {
      details.push(detail)
    })

    const response = await worker({
      Records: [
        { messageId: 'm1', body: JSON.stringify({ version: 1, workspaceId: 'ws-1', exportId: job.exportId, correlationId: 'corr-forged' }) },
      ],
    })

    // The mismatch is a batch item failure, so the redrive policy dead-letters the message.
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
    expect(details).toEqual([{
      messageId: 'm1',
      exportId: job.exportId,
      correlationId: 'corr-forged',
      errorType: 'AuditExportCorrelationMismatchError',
    }])
    expect(await store.readJob('ws-1', job.exportId)).toEqual(before)
  })
})
