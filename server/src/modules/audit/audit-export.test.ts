import { describe, expect, test } from 'bun:test'
import {
  createAuditEvent,
  createMutationAuditContext,
  type AuditEventQuery,
  type AuditEventV1,
} from './audit'
import {
  AuditExportError,
  createAuditExportService,
  createAuditExportWorkspacePrefix,
  normalizeAuditExportFilters,
  toAuditExportView,
  type AuditExportJob,
  type AuditExportPart,
  type AuditExportStore,
} from './audit-export'

/** In-memory export store with versioned job documents. */
function createMemoryStore() {
  const jobs = new Map<string, { job: AuditExportJob; version: number }>()
  const parts = new Map<string, string>()
  const store: AuditExportStore & { jobs: typeof jobs; parts: typeof parts } = {
    jobs,
    parts,
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
      return [...jobs.values()].map((entry) => entry.job).filter((job) => job.workspaceId === workspaceId).reverse()
    },
    async putPart(workspaceId, exportId, index, body) {
      const key = `${createAuditExportWorkspacePrefix(workspaceId)}${exportId}/part-${String(index).padStart(5, '0')}.ndjson`
      parts.set(key, body)
      return { key, byteLength: Buffer.byteLength(body), sha256: 'digest' }
    },
    async createPartDownloadUrl(_workspaceId: string, _exportId: string, part: AuditExportPart) {
      return `https://download.test/${part.key}`
    },
  }
  return store
}

/** Builds audit events with sequential identifiers. */
function events(count: number): AuditEventV1[] {
  return Array.from({ length: count }, (_, index) => createAuditEvent({
    context: createMutationAuditContext({
      workspaceId: 'ws-1',
      actor: { id: 'actor-1', kind: 'user' },
      idempotencyKey: `request-${index + 1}`,
      occurredAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
      request: { method: 'PATCH', path: '/api/work-items/item-1' },
      source: { kind: 'api' },
    }),
    eventType: 'work-item.updated',
    entity: { type: 'work-item', id: 'item-1' },
    expiresAt: 1_900_000_000,
  }))
}

/** Creates a cursor-paginated reader over a fixed event list. */
function createReader(all: AuditEventV1[], calls: AuditEventQuery[] = []) {
  return async (query: AuditEventQuery) => {
    calls.push(query)
    const start = query.cursor ? Number(query.cursor) : 0
    const end = Math.min(all.length, start + (query.limit ?? 100))
    return { events: all.slice(start, end), ...(end < all.length ? { nextCursor: String(end) } : {}) }
  }
}

const requester = { userKey: 'admin@example.com', displayName: 'Admin' }
const fixedNow = () => new Date('2026-07-18T00:00:00.000Z')

describe('audit export service', () => {
  test('writes parts across steps and completes', async () => {
    const store = createMemoryStore()
    const queued: string[] = []
    const calls: AuditEventQuery[] = []
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue(_workspaceId, exportId) { queued.push(exportId) } },
      readEvents: createReader(events(250), calls),
      now: fixedNow,
      createId: () => 'a'.repeat(32),
      eventsPerPart: 120,
    })

    const { job, created } = await service.requestExport({
      workspaceId: 'ws-1',
      requestedBy: requester,
      filters: { eventTypes: ['work-item.updated'], from: '2026-06-01T00:00:00.000Z' },
    })
    expect(created).toBe(true)
    expect(queued).toEqual([job.exportId])

    expect(await service.processExport('ws-1', job.exportId)).toBe('advanced')
    expect(await service.processExport('ws-1', job.exportId)).toBe('advanced')
    expect(await service.processExport('ws-1', job.exportId)).toBe('completed')
    expect(await service.processExport('ws-1', job.exportId)).toBe('skipped')

    const done = await service.getExport('ws-1', job.exportId)
    expect(done.status).toBe('completed')
    expect(done.eventCount).toBe(250)
    expect(done.parts.map((part) => part.eventCount)).toEqual([120, 120, 10])
    expect(done.nextCursor).toBeUndefined()
    expect(queued).toHaveLength(3)
    expect(calls.every((query) => query.direction === 'ascending' && query.workspaceId === 'ws-1')).toBe(true)
    expect(calls.every((query) => query.to === job.snapshotAt)).toBe(true)
    const firstPart = [...store.parts.values()][0] ?? ''
    expect(firstPart.trim().split('\n')).toHaveLength(120)

    const links = await service.createDownloadLinks(done)
    expect(links.parts.map((link) => link.index)).toEqual([1, 2, 3])
    expect(links.parts[0]?.url).toStartWith('https://download.test/audit-exports/')
    expect(links).not.toHaveProperty('nextPart')
    expect(toAuditExportView(done)).toEqual(expect.objectContaining({ partCount: 3, requestedBy: { displayName: 'Admin' } }))
    expect(toAuditExportView(done)).not.toHaveProperty('nextCursor')
  })

  test('completes an empty export without parts', async () => {
    const store = createMemoryStore()
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      readEvents: createReader([]),
      now: fixedNow,
      createId: () => 'b'.repeat(32),
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })

    expect(await service.processExport('ws-1', job.exportId)).toBe('completed')
    expect((await service.getExport('ws-1', job.exportId)).parts).toEqual([])
  })

  test('replays an idempotent request and re-enqueues a job that never started', async () => {
    const store = createMemoryStore()
    let enqueueAttempts = 0
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: {
        async enqueue() {
          enqueueAttempts += 1
          if (enqueueAttempts === 1) throw new Error('queue unavailable')
        },
      },
      readEvents: createReader([]),
      now: fixedNow,
    })
    const request = { workspaceId: 'ws-1', requestedBy: requester, filters: { actorId: 'actor-1' }, idempotencyKey: 'key-1' }

    await expect(service.requestExport(request)).rejects.toThrow('queue unavailable')
    const replay = await service.requestExport(request)

    expect(replay.created).toBe(false)
    expect(replay.job.status).toBe('queued')
    expect(enqueueAttempts).toBe(2)
    await expect(service.requestExport({ ...request, filters: { actorId: 'actor-2' } })).rejects.toMatchObject({
      code: 'AuditExportIdempotencyConflict',
      status: 409,
    })
    await expect(service.requestExport({ ...request, requestedBy: { userKey: 'other@example.com', displayName: 'Other' } }))
      .resolves.toMatchObject({ created: true })
  })

  test('only one concurrent step advances a job', async () => {
    const store = createMemoryStore()
    const queued: string[] = []
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue(_workspaceId, exportId) { queued.push(exportId) } },
      readEvents: createReader(events(30)),
      now: fixedNow,
      createId: () => 'c'.repeat(32),
      eventsPerPart: 10,
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    queued.length = 0

    const results = await Promise.all([
      service.processExport('ws-1', job.exportId),
      service.processExport('ws-1', job.exportId),
    ])

    expect(results.sort()).toEqual(['advanced', 'skipped'])
    expect(queued).toHaveLength(1)
    expect((await service.getExport('ws-1', job.exportId)).parts).toHaveLength(1)
  })

  test('fails exports above the event limit and invalid queries', async () => {
    const store = createMemoryStore()
    const tooLarge = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      readEvents: createReader(events(30)),
      now: fixedNow,
      createId: () => 'd'.repeat(32),
      eventsPerPart: 20,
      maxEvents: 25,
    })
    const { job } = await tooLarge.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    expect(await tooLarge.processExport('ws-1', job.exportId)).toBe('advanced')
    expect(await tooLarge.processExport('ws-1', job.exportId)).toBe('failed')
    expect((await tooLarge.getExport('ws-1', job.exportId)).failure?.code).toBe('AuditExportTooLarge')

    const invalid = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      readEvents: async () => { throw new TypeError('Invalid cursor.') },
      now: fixedNow,
      createId: () => 'e'.repeat(32),
    })
    const invalidJob = (await invalid.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })).job
    expect(await invalid.processExport('ws-1', invalidJob.exportId)).toBe('failed')
    expect((await invalid.getExport('ws-1', invalidJob.exportId)).failure?.code).toBe('AuditExportQueryInvalid')
  })

  test('retries transient read failures through the queue', async () => {
    const service = createAuditExportService({
      settleSeconds: 0,
      store: createMemoryStore(),
      queue: { async enqueue() {} },
      readEvents: async () => { throw new Error('DynamoDB throttled') },
      now: fixedNow,
      createId: () => 'f'.repeat(32),
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })

    await expect(service.processExport('ws-1', job.exportId)).rejects.toThrow('DynamoDB throttled')
    expect((await service.getExport('ws-1', job.exportId)).status).toBe('queued')
  })

  test('hides jobs of other Workspaces, unknown IDs, and expired jobs', async () => {
    let current = fixedNow()
    const service = createAuditExportService({
      settleSeconds: 0,
      store: createMemoryStore(),
      queue: { async enqueue() {} },
      readEvents: createReader([]),
      now: () => current,
      createId: () => '1'.repeat(32),
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })

    await expect(service.getExport('ws-2', job.exportId)).rejects.toMatchObject({ status: 404 })
    await expect(service.getExport('ws-1', '../job')).rejects.toBeInstanceOf(AuditExportError)
    current = new Date(fixedNow().getTime() + 8 * 86_400_000)
    await expect(service.getExport('ws-1', job.exportId)).rejects.toMatchObject({ code: 'AuditExportNotFound' })
    expect(await service.listExports('ws-1')).toEqual([])
    expect(await service.processExport('ws-1', job.exportId)).toBe('failed')
  })

  test('rejects downloads before completion', async () => {
    const service = createAuditExportService({
      settleSeconds: 0,
      store: createMemoryStore(),
      queue: { async enqueue() {} },
      readEvents: createReader([]),
      now: fixedNow,
      createId: () => '2'.repeat(32),
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })

    await expect(service.createDownloadLinks(job)).rejects.toMatchObject({ code: 'AuditExportNotReady' })
  })
})

describe('audit export step safety', () => {
  /**
   * Creates a service with one requested job and a recording queue.
   *
   * @param overrides - Service dependency overrides.
   * @param all - Events visible to the reader.
   * @returns The service, its queue log, and the requested job.
   */
  async function requested(
    overrides: Partial<Parameters<typeof createAuditExportService>[0]>,
    all: AuditEventV1[] = events(5),
  ) {
    const store = createMemoryStore()
    const queued: Array<{ exportId: string; delaySeconds?: number }> = []
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: {
        async enqueue(_workspaceId, exportId, delaySeconds) {
          queued.push({ exportId, ...(delaySeconds === undefined ? {} : { delaySeconds }) })
        },
      },
      readEvents: createReader(all),
      now: fixedNow,
      createId: () => '7'.repeat(32),
      ...overrides,
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    return { service, queued, store, job }
  }

  test('waits for the settle delay before reading events', async () => {
    const reads: AuditEventQuery[] = []
    let clock = Date.parse('2026-07-18T00:00:00.000Z')
    const { service, queued, job } = await requested({
      settleSeconds: 30,
      now: () => new Date(clock),
      readEvents: createReader(events(2), reads),
    })
    expect(queued).toEqual([{ exportId: job.exportId, delaySeconds: 30 }])

    clock += 10_000
    expect(await service.processExport('ws-1', job.exportId)).toBe('deferred')
    expect(reads).toEqual([])
    expect(queued.at(-1)).toEqual({ exportId: job.exportId, delaySeconds: 20 })

    clock += 20_000
    expect(await service.processExport('ws-1', job.exportId)).toBe('completed')
    expect(reads).toHaveLength(1)
  })

  test('stops without writing for closing or closed tenants', async () => {
    const reads: AuditEventQuery[] = []
    const { service, store, job } = await requested({
      isTenantActive: async () => false,
      readEvents: createReader(events(2), reads),
    })

    expect(await service.processExport('ws-1', job.exportId)).toBe('skipped')
    expect(reads).toEqual([])
    expect(store.parts.size).toBe(0)
    expect((await service.getExport('ws-1', job.exportId)).status).toBe('queued')
  })

  test('checkpoints a selective scan after the page budget even without matches', async () => {
    const reads: AuditEventQuery[] = []
    const { service, store, queued, job } = await requested({
      pagesPerStep: 3,
      readEvents: async (query) => {
        reads.push(query)
        const page = Number(query.cursor ?? '0')
        return { events: [], nextCursor: String(page + 1) }
      },
    })

    expect(await service.processExport('ws-1', job.exportId)).toBe('advanced')
    expect(reads).toHaveLength(3)
    expect(store.parts.size).toBe(0)
    const checkpointed = await service.getExport('ws-1', job.exportId)
    expect(checkpointed).toMatchObject({ status: 'running', nextCursor: '3', eventCount: 0, parts: [] })
    expect(queued).toHaveLength(2)
  })

  test('closes a part when its serialized byte budget is reached', async () => {
    const { service, job } = await requested({ partByteBudget: 1 }, events(250))

    expect(await service.processExport('ws-1', job.exportId)).toBe('advanced')
    // One query page of 100 events exceeds the budget, so the step stops there.
    expect((await service.getExport('ws-1', job.exportId)).parts.map((part) => part.eventCount)).toEqual([100])
  })

  test('marks a keyless job failed when it cannot be scheduled', async () => {
    const store = createMemoryStore()
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() { throw new Error('queue unavailable') } },
      readEvents: createReader([]),
      now: fixedNow,
      createId: () => '8'.repeat(32),
    })

    await expect(service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} }))
      .rejects.toThrow('queue unavailable')
    expect(await service.getExport('ws-1', '8'.repeat(32))).toMatchObject({
      status: 'failed',
      failure: { code: 'AuditExportEnqueueFailed' },
    })
  })
})

describe('normalizeAuditExportFilters', () => {
  test('drops empty values and validates paired filters and timestamps', () => {
    expect(normalizeAuditExportFilters({ actorId: '', eventTypes: [], from: '2026-07-01T00:00:00.000Z' }))
      .toEqual({ from: '2026-07-01T00:00:00.000Z' })
    expect(() => normalizeAuditExportFilters({ entityType: 'work-item' })).toThrow('entityType and entityId')
    expect(() => normalizeAuditExportFilters({ targetId: 'x' })).toThrow('targetType and targetId')
    expect(() => normalizeAuditExportFilters({ from: 'yesterday' })).toThrow('ISO 8601')
    expect(() => normalizeAuditExportFilters({ from: '2026-07-02T00:00:00Z', to: '2026-07-01T00:00:00Z' })).toThrow('later than')
    // The query layer accepts at most 20 non-blank event types; reject the rest before creating a job.
    expect(() => normalizeAuditExportFilters({
      eventTypes: Array.from({ length: 21 }, (_, index) => `event-${index}`),
    })).toThrow('at most 20')
    expect(() => normalizeAuditExportFilters({ eventTypes: ['work-item.updated', ' '] })).toThrow('event type is required')
  })
})
