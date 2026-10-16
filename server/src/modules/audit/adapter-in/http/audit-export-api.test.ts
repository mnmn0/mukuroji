import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import type { AuditEventQuery, AuditEventV1 } from '../../audit'
import {
  createAuditExportService,
  type AuditExportJob,
  type AuditExportStore,
} from '../../audit-export'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createFakeAuditEvent,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** In-memory export store for HTTP tests. */
function createMemoryStore(): AuditExportStore {
  const jobs = new Map<string, { job: AuditExportJob; version: number }>()
  return {
    async createJob(job) {
      if (jobs.has(job.exportId)) return 'exists'
      jobs.set(job.exportId, { job, version: 1 })
      return 'created'
    },
    async readJob(_workspaceId, exportId) {
      const entry = jobs.get(exportId)
      return entry ? { job: entry.job, version: String(entry.version) } : undefined
    },
    async replaceJob(job, expectedVersion) {
      const entry = jobs.get(job.exportId)
      if (!entry || String(entry.version) !== expectedVersion) return false
      jobs.set(job.exportId, { job, version: entry.version + 1 })
      return true
    },
    async listJobs(workspaceId) {
      return [...jobs.values()].map((entry) => entry.job).filter((job) => job.workspaceId === workspaceId)
    },
    async putPart(_workspaceId, exportId, index, body) {
      return { key: `audit-exports/test/${exportId}/part-${index}.ndjson`, byteLength: body.length, sha256: 'digest' }
    },
    async createPartDownloadUrl(part) {
      return `https://download.test/${part.key}`
    },
  }
}

/**
 * Configures the app with an in-memory export service and audit writer.
 *
 * @param workspaceRole - Optional Workspace role of the caller.
 * @returns Recorded access events, queued export IDs, and the service.
 */
function configureExports(workspaceRole?: 'member') {
  configureFakeProjectClients(true, workspaceRole ? { workspaceRole } : {})
  const accessEvents: AuditEventV1[] = []
  const queued: string[] = []
  const event = createFakeAuditEvent()
  const auditEvents = {
    async putEvent(accessEvent: AuditEventV1) {
      accessEvents.push(accessEvent)
    },
    async getEvent() {
      return undefined
    },
    async query(_query: AuditEventQuery) {
      return { events: [event] }
    },
  }
  const service = createAuditExportService({
    store: createMemoryStore(),
    queue: { async enqueue(_workspaceId, exportId) { queued.push(exportId) } },
    readEvents: (query) => auditEvents.query(query),
  })
  setTestAppDependencies({ auditEvents, auditExports: service })
  return { accessEvents, queued, service }
}

const adminHeaders = () => ({
  Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
  'Content-Type': 'application/json',
})

test('requests, reports, and downloads an asynchronous audit export', async () => {
  const { accessEvents, queued, service } = configureExports()

  const created = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'export-1' },
    body: JSON.stringify({ filters: { eventTypes: ['work-item.updated'], from: '2026-07-01T00:00:00.000Z' } }),
  })
  expect(created.status).toBe(202)
  const { export: job } = await created.json()
  expect(job).toMatchObject({ status: 'queued', eventCount: 0, partCount: 0 })
  expect(job).not.toHaveProperty('requestFingerprint')
  expect(queued).toEqual([job.exportId])

  const replay = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'export-1' },
    body: JSON.stringify({ filters: { eventTypes: ['work-item.updated'], from: '2026-07-01T00:00:00.000Z' } }),
  })
  expect(replay.status).toBe(200)

  const notReady = await app.request(`/api/audit/exports/${job.exportId}/download`, { headers: adminHeaders() })
  expect(notReady.status).toBe(409)

  expect(await service.processExport('user#demo@example.com', job.exportId)).toBe('completed')

  const status = await app.request(`/api/audit/exports/${job.exportId}`, { headers: adminHeaders() })
  expect((await status.json()).export).toMatchObject({ status: 'completed', eventCount: 1, partCount: 1 })

  const listed = await app.request('/api/audit/exports', { headers: adminHeaders() })
  expect((await listed.json()).exports).toHaveLength(1)

  const download = await app.request(`/api/audit/exports/${job.exportId}/download`, { headers: adminHeaders() })
  expect(download.status).toBe(200)
  expect((await download.json()).parts).toEqual([
    expect.objectContaining({ index: 1, eventCount: 1, url: expect.stringMatching(/^https:\/\/download\.test\//) }),
  ])

  expect(accessEvents.map((event) => event.eventType)).toEqual([
    'audit.export-requested',
    'audit.export-requested',
    'audit.export-downloaded',
  ])
  expect(accessEvents[0]).toMatchObject({ metadata: { exportId: job.exportId, replayed: false } })
  expect(accessEvents[1]).toMatchObject({ metadata: { exportId: job.exportId, replayed: true } })
  expect(accessEvents[2]).toMatchObject({ metadata: { exportId: job.exportId, partCount: 1, eventCount: 1 } })
})

test('rejects Workspace members without audit export rights', async () => {
  configureExports('member')

  const member = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${createAccessToken([])}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(member.status).toBe(403)
})

test('rejects malformed filters and unknown exports', async () => {
  configureExports()

  const unknownFilter = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ filters: { workspaceId: 'other' } }),
  })
  expect(unknownFilter.status).toBe(400)
  expect(await unknownFilter.json()).toMatchObject({ code: 'InvalidAuditExportFilters' })

  const missing = await app.request(`/api/audit/exports/${'f'.repeat(32)}`, { headers: adminHeaders() })
  expect(missing.status).toBe(404)
})

test('reports asynchronous export as unavailable when it is not deployed', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/audit/exports', { headers: adminHeaders() })

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'AuditExportUnavailable' })
})
