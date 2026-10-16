import { createHash } from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { AuditEventIdempotencyConflictError, type AuditEventQuery, type AuditEventV1 } from '../../audit'
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
    async createPartDownloadUrl(_workspaceId, _exportId, part) {
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
function configureExports(workspaceRole?: 'member', readRecordedEvent: () => AuditEventV1 | undefined = () => undefined) {
  configureFakeProjectClients(true, workspaceRole ? { workspaceRole } : {})
  const accessEvents: AuditEventV1[] = []
  const queued: string[] = []
  const event = createFakeAuditEvent()
  const auditEvents = {
    async putEvent(accessEvent: AuditEventV1) {
      accessEvents.push(accessEvent)
    },
    async getEvent() {
      return readRecordedEvent()
    },
    async query(_query: AuditEventQuery) {
      return { events: [event] }
    },
  }
  const service = createAuditExportService({
    settleSeconds: 0,
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

test('keeps the export request receipt past every artifact even with a short audit retention', async () => {
  const previous = process.env.MUKUROJI_AUDIT_RETENTION_DAYS
  process.env.MUKUROJI_AUDIT_RETENTION_DAYS = '1'
  try {
    const { accessEvents } = configureExports()
    const created = await app.request('/api/audit/exports', {
      method: 'POST',
      headers: { ...adminHeaders(), 'Idempotency-Key': 'short-retention' },
      body: JSON.stringify({ filters: {} }),
    })
    expect(created.status).toBe(202)
    const requested = accessEvents[0]
    if (requested?.expiresAt === undefined) throw new Error('The export request event was not recorded with a TTL.')
    const retainedSeconds = requested.expiresAt - Math.floor(Date.parse(requested.occurredAt) / 1000)
    expect(retainedSeconds).toBeGreaterThanOrEqual(17 * 86_400)
  } finally {
    if (previous === undefined) delete process.env.MUKUROJI_AUDIT_RETENTION_DAYS
    else process.env.MUKUROJI_AUDIT_RETENTION_DAYS = previous
  }
})

test('uses the persisted request time after a concurrent first request and rejects receipts past the deadline', async () => {
  const request = () => app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'shared-key' },
    body: JSON.stringify({ filters: {} }),
  })
  // Record the request event this key produces.
  const first = configureExports()
  expect((await request()).status).toBe(202)
  const recorded = first.accessEvents[0]
  if (!recorded) throw new Error('The request event was not recorded.')

  // A concurrent first request wrote the receipt a minute earlier; the pre-read missed it and
  // the writer accepted this request as a duplicate. The job snapshot uses the persisted time.
  const earlier = { ...recorded, occurredAt: new Date(Date.parse(recorded.occurredAt) - 60_000).toISOString() }
  let reads = 0
  configureExports(undefined, () => (reads++ === 0 ? undefined : earlier))
  const concurrent = await request()
  expect(concurrent.status).toBe(202)
  expect((await concurrent.json()).export.snapshotAt).toBe(earlier.occurredAt)

  // A receipt whose job was never created cannot start one after the processing deadline.
  const stale = { ...recorded, occurredAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }
  configureExports(undefined, () => stale)
  const late = await request()
  expect(late.status).toBe(409)
  expect(await late.json()).toMatchObject({ code: 'AuditExportIdempotencyKeyExpired' })
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
  expect(accessEvents[0]).toMatchObject({ metadata: { exportId: job.exportId, filtered: true, filtersDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) } })
  // The replay repeats the event under the same identity and fingerprint, which the
  // idempotent audit writer collapses instead of rejecting as a conflicting reuse.
  for (const field of ['eventId', 'eventType', 'requestFingerprint', 'metadata'] as const) {
    expect(accessEvents[1]?.[field]).toEqual(accessEvents[0]?.[field])
  }
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

  // An unfiltered export must be requested explicitly.
  const missingFilters = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'missing-filters' },
    body: JSON.stringify({}),
  })
  expect(missingFilters.status).toBe(400)
  expect(await missingFilters.json()).toMatchObject({ code: 'InvalidAuditExportRequest' })

  const unknownFilter = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ filters: { workspaceId: 'other' } }),
  })
  expect(unknownFilter.status).toBe(400)
  expect(await unknownFilter.json()).toMatchObject({ code: 'InvalidAuditExportFilters' })

  // Missing, truncated, or misplaced filters must never become an unfiltered export.
  for (const body of [undefined, '{"filters":{"actorId":', JSON.stringify({ actorId: 'demo@example.com' }), '[]']) {
    const response = await app.request('/api/audit/exports', {
      method: 'POST',
      headers: adminHeaders(),
      ...(body === undefined ? {} : { body }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidAuditExportRequest' })
  }

  const tooManyTypes = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'too-many' },
    body: JSON.stringify({ filters: { eventTypes: Array.from({ length: 21 }, (_, index) => `event-${index}`) } }),
  })
  expect(tooManyTypes.status).toBe(400)
  expect(await tooManyTypes.json()).toMatchObject({ code: 'InvalidAuditExportFilters' })

  const missing = await app.request(`/api/audit/exports/${'f'.repeat(32)}`, { headers: adminHeaders() })
  expect(missing.status).toBe(404)
})

test('requires an idempotency key and records the request before creating the job', async () => {
  const { accessEvents, queued } = configureExports()
  const body = JSON.stringify({ filters: { actorId: 'demo@example.com' } })

  const keyless = await app.request('/api/audit/exports', { method: 'POST', headers: adminHeaders(), body })
  expect(keyless.status).toBe(400)
  expect(await keyless.json()).toMatchObject({ code: 'IdempotencyKeyRequired' })
  expect(accessEvents).toEqual([])

  const created = await app.request('/api/audit/exports', { method: 'POST', headers: { ...adminHeaders(), 'Idempotency-Key': 'export-a' }, body })
  expect(created.status).toBe(202)
  const reused = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'export-a' },
    body: JSON.stringify({ filters: { actorId: 'someone-else@example.com' } }),
  })
  expect(reused.status).toBe(409)
  expect(await reused.json()).toMatchObject({ code: 'AuditExportIdempotencyConflict' })
  expect(accessEvents).toHaveLength(1)
  expect(queued).toHaveLength(1)

  // The audit identity is scoped to export requests, not the raw header shared with other operations.
  const auditKeyHash = (key: string) => createHash('sha256')
    .update(`audit-idempotency-v1\0${accessEvents[0]?.workspaceId}\0${accessEvents[0]?.actor.id}\0${key}`)
    .digest('hex')
  const exportId = (await created.json()).export.exportId
  expect(accessEvents[0]?.idempotencyKeyHash).toBe(auditKeyHash(`audit-export-request:${exportId}`))
  expect(accessEvents[0]?.idempotencyKeyHash).not.toBe(auditKeyHash('export-a'))

  const future = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'export-future' },
    body: JSON.stringify({ filters: { from: '2999-01-01T00:00:00.000Z' } }),
  })
  expect(future.status).toBe(400)
  expect(await future.json()).toMatchObject({ code: 'InvalidAuditExportFilters' })

  // A failed audit write leaves no job behind; the retry with the same key creates it.
  const failing = configureExports()
  setTestAppDependencies({
    auditEvents: {
      async putEvent() { throw new Error('audit unavailable') },
      async getEvent() { return undefined },
      async query() { return { events: [] } },
    },
    auditExports: failing.service,
  })
  const blocked = await app.request('/api/audit/exports', { method: 'POST', headers: { ...adminHeaders(), 'Idempotency-Key': 'export-b' }, body })
  expect(blocked.status).toBeGreaterThanOrEqual(500)
  expect(await failing.service.listExports('user#demo@example.com')).toEqual([])
  expect(failing.queued).toEqual([])
})

test('pages download links for exports with many parts', async () => {
  const { accessEvents, service } = configureExports()
  const created = await app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'many-parts' },
    body: JSON.stringify({ filters: {} }),
  })
  const { export: job } = await created.json()
  const stored = await service.getExport('user#demo@example.com', job.exportId)
  const parts = Array.from({ length: 150 }, (_, index) => ({
    index: index + 1, key: `audit-exports/test/${job.exportId}/part-${index + 1}.ndjson`, eventCount: 1, byteLength: 10, sha256: 'digest',
  }))
  const completed = { ...stored, status: 'completed' as const, parts, eventCount: 150 }
  const store = createMemoryStore()
  await store.createJob(completed)
  setTestAppDependencies({
    auditEvents: { async putEvent(event: AuditEventV1) { accessEvents.push(event) }, async getEvent() { return undefined }, async query() { return { events: [] } } },
    auditExports: createAuditExportService({ settleSeconds: 0, store, queue: { async enqueue() {} }, readEvents: async () => ({ events: [] }) }),
  })

  const first = await (await app.request(`/api/audit/exports/${job.exportId}/download`, { headers: adminHeaders() })).json()
  expect(first.parts).toHaveLength(100)
  expect(first.nextPart).toBe(100)
  const second = await (await app.request(`/api/audit/exports/${job.exportId}/download?fromPart=100`, { headers: adminHeaders() })).json()
  expect(second.parts.map((part: { index: number }) => part.index)).toEqual(Array.from({ length: 50 }, (_, index) => index + 101))
  expect(second).not.toHaveProperty('nextPart')
  for (const fromPart of ['-1', '150', 'abc']) {
    const invalid = await app.request(`/api/audit/exports/${job.exportId}/download?fromPart=${fromPart}`, { headers: adminHeaders() })
    expect(invalid.status).toBe(400)
  }
  expect(accessEvents.at(-1)).toMatchObject({ metadata: { exportId: job.exportId, fromPart: 100, partCount: 50 } })

  // One client key reused while following nextPart is scoped per page.
  const keyed = { ...adminHeaders(), 'Idempotency-Key': 'download-key' }
  const firstKeyed = await app.request(`/api/audit/exports/${job.exportId}/download`, { headers: keyed })
  const secondKeyed = await app.request(`/api/audit/exports/${job.exportId}/download?fromPart=100`, { headers: keyed })
  expect([firstKeyed.status, secondKeyed.status]).toEqual([200, 200])
  const [firstEvent, secondEvent] = accessEvents.slice(-2)
  expect(firstEvent?.idempotencyKeyHash).not.toBe(secondEvent?.idempotencyKeyHash)
})

test('reports asynchronous export as unavailable when it is not deployed', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/audit/exports', { headers: adminHeaders() })

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'AuditExportUnavailable' })
})

test('rejects a key whose export expired and maps audit-writer conflicts to 409', async () => {
  configureFakeProjectClients(true, {})
  const stored = new Map<string, AuditEventV1>()
  let rejectWrites: Error | undefined
  const auditEvents = {
    async putEvent(accessEvent: AuditEventV1) {
      if (rejectWrites) throw rejectWrites
      stored.set(accessEvent.eventId, accessEvent)
    },
    async getEvent(_workspaceId: string, eventId: string) {
      return stored.get(eventId)
    },
    async query(_query: AuditEventQuery) {
      return { events: [] }
    },
  }
  const memory = createMemoryStore()
  let jobsGone = false
  const store: AuditExportStore = {
    ...memory,
    async readJob(workspaceId, exportId) {
      return jobsGone ? undefined : memory.readJob(workspaceId, exportId)
    },
  }
  const service = createAuditExportService({
    settleSeconds: 0,
    store,
    queue: { async enqueue() {} },
    readEvents: (query) => auditEvents.query(query),
  })
  setTestAppDependencies({ auditEvents, auditExports: service })
  const request = () => app.request('/api/audit/exports', {
    method: 'POST',
    headers: { ...adminHeaders(), 'Idempotency-Key': 'expired-key' },
    body: JSON.stringify({ filters: {} }),
  })

  expect((await request()).status).toBe(202)
  // The job is gone (lifecycle removed it) while its request event, recorded 8 days ago, remains.
  jobsGone = true
  const [recorded] = stored.values()
  if (!recorded) throw new Error('missing audit event')
  stored.set(recorded.eventId, { ...recorded, occurredAt: new Date(Date.now() - 8 * 86_400_000).toISOString() })
  const expired = await request()
  expect(expired.status).toBe(409)
  expect(await expired.json()).toMatchObject({ code: 'AuditExportIdempotencyKeyExpired' })

  // A writer-side fingerprint conflict is the stable export conflict, not a 5xx.
  stored.clear()
  rejectWrites = new AuditEventIdempotencyConflictError()
  const conflicted = await request()
  expect(conflicted.status).toBe(409)
  expect(await conflicted.json()).toMatchObject({ code: 'AuditExportIdempotencyConflict' })

  // A malformed stored audit row is a server failure, not a client conflict.
  rejectWrites = new TypeError('Audit event is malformed.')
  const corrupted = await request()
  expect(corrupted.status).toBeGreaterThanOrEqual(500)
})
