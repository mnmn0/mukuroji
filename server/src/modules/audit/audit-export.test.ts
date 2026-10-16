import { describe, expect, test } from 'bun:test'
import {
  createAuditEvent,
  createMutationAuditContext,
  type AuditEventCountQuery,
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
    async createPartDownloadUrl(_workspaceId: string, _exportId: string, part: AuditExportPart, maxLifetimeSeconds: number) {
      return `https://download.test/${part.key}?ttl=${maxLifetimeSeconds}`
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

/**
 * Creates a consistent counter over a fixed event list.
 *
 * @param all - Events committed to the base table.
 * @param calls - Optional log of count queries.
 * @returns A single-page counter of the durable events.
 */
function createCounter(all: AuditEventV1[], calls: AuditEventCountQuery[] = []) {
  return async (query: AuditEventCountQuery) => {
    calls.push(query)
    return { count: all.filter((event) => event.expiresAt === undefined || event.expiresAt > query.durableAfter).length }
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
      countEvents: createCounter(events(250)),
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
      countEvents: createCounter([]),
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
      countEvents: createCounter([]),
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
      countEvents: createCounter(events(30)),
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
      countEvents: createCounter(events(30)),
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
      readEvents: async () => { throw new TypeError('Audit event is malformed.') },
      countEvents: createCounter([]),
      now: fixedNow,
      createId: () => 'e'.repeat(32),
    })
    const invalidJob = (await invalid.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })).job
    // A malformed persisted row with valid filters retries so the DLQ can surface it.
    await expect(invalid.processExport('ws-1', invalidJob.exportId)).rejects.toThrow('Audit event is malformed.')
    expect((await invalid.getExport('ws-1', invalidJob.exportId)).status).toBe('queued')
    // Filters the query layer rejects (for example, stored before validation existed) are terminal.
    const storedInvalid = store.jobs.get(`ws-1/${invalidJob.exportId}`)
    if (!storedInvalid) throw new Error('missing job')
    storedInvalid.job = { ...storedInvalid.job, filters: { eventTypes: [' '] } }
    expect(await invalid.processExport('ws-1', invalidJob.exportId)).toBe('failed')
    expect((await invalid.getExport('ws-1', invalidJob.exportId)).failure?.code).toBe('AuditExportQueryInvalid')

    const tooManyParts = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      readEvents: createReader(events(30)),
      countEvents: createCounter(events(30)),
      now: fixedNow,
      createId: () => 'f'.repeat(32),
      eventsPerPart: 10,
      maxParts: 2,
    })
    const partsJob = (await tooManyParts.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })).job
    expect(await tooManyParts.processExport('ws-1', partsJob.exportId)).toBe('advanced')
    expect(await tooManyParts.processExport('ws-1', partsJob.exportId)).toBe('advanced')
    expect(await tooManyParts.processExport('ws-1', partsJob.exportId)).toBe('failed')
    const failedParts = await tooManyParts.getExport('ws-1', partsJob.exportId)
    expect(failedParts.failure?.code).toBe('AuditExportTooManyParts')
    expect(failedParts.parts).toHaveLength(2)
  })

  test('stops writing after the processing deadline and presents the job as timed out', async () => {
    let current = new Date('2026-07-18T00:00:00.000Z')
    const store = createMemoryStore()
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      readEvents: createReader(events(30)),
      countEvents: createCounter(events(30)),
      now: () => current,
      createId: () => '1'.repeat(32),
      eventsPerPart: 10,
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    expect(await service.processExport('ws-1', job.exportId)).toBe('advanced')
    const beforeDeadline = await store.readJob('ws-1', job.exportId)
    // A worker that recovers days later must not rewrite job.json and restart bucket expiration.
    current = new Date('2026-07-21T00:00:00.000Z')
    expect(await service.processExport('ws-1', job.exportId)).toBe('skipped')
    expect(await store.readJob('ws-1', job.exportId)).toEqual(beforeDeadline)
    const failed = await service.getExport('ws-1', job.exportId)
    expect(failed.status).toBe('failed')
    expect(failed.failure?.code).toBe('AuditExportProcessingTimedOut')
    expect(failed.updatedAt).toBe('2026-07-19T00:00:00.000Z')
    expect(failed.parts).toHaveLength(1)
    expect((await service.listExports('ws-1')).map((listed) => listed.status)).toEqual(['failed'])
  })

  test('does not write a part or the job when reading runs past the deadline', async () => {
    let current = new Date('2026-07-18T00:00:00.000Z')
    const store = createMemoryStore()
    const reader = createReader(events(30))
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      countEvents: createCounter(events(30)),
      readEvents: async (query) => {
        // The step starts before the deadline but its reads finish after it.
        current = new Date('2026-07-19T00:00:01.000Z')
        return await reader(query)
      },
      now: () => current,
      createId: () => '1'.repeat(32),
      eventsPerPart: 10,
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    current = new Date('2026-07-18T23:59:00.000Z')
    const before = await store.readJob('ws-1', job.exportId)
    expect(await service.processExport('ws-1', job.exportId)).toBe('skipped')
    expect(await store.readJob('ws-1', job.exportId)).toEqual(before)
    expect((await service.getExport('ws-1', job.exportId)).failure?.code).toBe('AuditExportProcessingTimedOut')
  })

  test('treats a key whose stored job is past its API lifetime as expired', async () => {
    let current = fixedNow()
    const service = createAuditExportService({
      settleSeconds: 0,
      store: createMemoryStore(),
      queue: { async enqueue() {} },
      readEvents: createReader([]),
      countEvents: createCounter([]),
      now: () => current,
    })
    await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {}, idempotencyKey: 'old-key' })
    current = new Date(fixedNow().getTime() + 8 * 86_400_000)
    await expect(service.prepareExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {}, idempotencyKey: 'old-key' }))
      .rejects.toMatchObject({ status: 409, code: 'AuditExportIdempotencyKeyExpired' })
  })

  test('keeps the first recorded request time as the snapshot of a retried request', async () => {
    const service = createAuditExportService({
      settleSeconds: 0,
      store: createMemoryStore(),
      queue: { async enqueue() {} },
      readEvents: createReader([]),
      countEvents: createCounter([]),
      now: fixedNow,
    })
    const recordedAt = new Date(fixedNow().getTime() - 60_000).toISOString()
    const { job } = await service.requestExport({
      workspaceId: 'ws-1', requestedBy: requester, filters: {}, idempotencyKey: 'retry-key', requestedAt: recordedAt,
    })
    expect(job.snapshotAt).toBe(recordedAt)
    expect(job.createdAt).toBe(recordedAt)
    // A time in the future is not a recorded request; the current time is used instead.
    const future = await service.requestExport({
      workspaceId: 'ws-1', requestedBy: requester, filters: {}, idempotencyKey: 'other-key',
      requestedAt: new Date(fixedNow().getTime() + 60_000).toISOString(),
    })
    expect(future.job.snapshotAt).toBe(fixedNow().toISOString())
  })

  test('caps download links at the remaining job lifetime', async () => {
    let current = fixedNow()
    const store = createMemoryStore()
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      readEvents: createReader(events(3)),
      countEvents: createCounter(events(3)),
      now: () => current,
      createId: () => '3'.repeat(32),
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    expect(await service.processExport('ws-1', job.exportId)).toBe('completed')
    const completed = await service.getExport('ws-1', job.exportId)
    current = new Date(Date.parse(completed.expiresAt) - 42_000)
    const { parts } = await service.createDownloadLinks(await service.getExport('ws-1', job.exportId))
    expect(parts[0]?.url).toEndWith('?ttl=42')
  })

  test('retries transient read failures through the queue', async () => {
    const service = createAuditExportService({
      settleSeconds: 0,
      store: createMemoryStore(),
      queue: { async enqueue() {} },
      readEvents: async () => { throw new Error('DynamoDB throttled') },
      countEvents: createCounter([]),
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
      countEvents: createCounter([]),
      now: () => current,
      createId: () => '1'.repeat(32),
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })

    await expect(service.getExport('ws-2', job.exportId)).rejects.toMatchObject({ status: 404 })
    await expect(service.getExport('ws-1', '../job')).rejects.toBeInstanceOf(AuditExportError)
    current = new Date(fixedNow().getTime() + 8 * 86_400_000)
    await expect(service.getExport('ws-1', job.exportId)).rejects.toMatchObject({ code: 'AuditExportNotFound' })
    expect(await service.listExports('ws-1')).toEqual([])
    expect(await service.processExport('ws-1', job.exportId)).toBe('skipped')
  })

  test('rejects downloads before completion', async () => {
    const service = createAuditExportService({
      settleSeconds: 0,
      store: createMemoryStore(),
      queue: { async enqueue() {} },
      readEvents: createReader([]),
      countEvents: createCounter([]),
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
      countEvents: createCounter(all),
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
      countEvents: createCounter(events(2)),
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

  test('defers without writing while the tenant is inactive and resumes when it is restored', async () => {
    const reads: AuditEventQuery[] = []
    let active = false
    const { service, store, queued, job } = await requested({
      isTenantActive: async () => active,
      readEvents: createReader(events(2), reads),
      countEvents: createCounter(events(2)),
    })

    expect(await service.processExport('ws-1', job.exportId)).toBe('deferred')
    expect(queued.at(-1)).toEqual({ exportId: job.exportId, delaySeconds: 900 })
    expect(reads).toEqual([])
    expect(store.parts.size).toBe(0)
    expect((await service.getExport('ws-1', job.exportId)).status).toBe('queued')

    // A reversible closure step restored the tenant; the kept message resumes the job.
    active = true
    expect(await service.processExport('ws-1', job.exportId)).toBe('completed')

    // After closure deletes the export namespace the job is gone and the chain ends.
    store.jobs.clear()
    active = false
    expect(await service.processExport('ws-1', job.exportId)).toBe('skipped')
  })

  test('checkpoints a selective scan after the page budget even without matches', async () => {
    const reads: AuditEventQuery[] = []
    const { service, store, queued, job } = await requested({
      pagesPerStep: 3,
      countEvents: createCounter([]),
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
      countEvents: createCounter([]),
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

describe('audit export completeness barrier', () => {
  /**
   * Creates a service over a base table and an index that may lag behind it.
   *
   * @param overrides - Service dependency overrides.
   * @returns The service, its stores, the queue log, the visible index, and the job.
   */
  async function lagging(overrides: Partial<Parameters<typeof createAuditExportService>[0]> = {}) {
    const store = createMemoryStore()
    const base = events(6)
    const index = { visible: base.filter((_, position) => position !== 2) }
    const queued: Array<{ delaySeconds?: number }> = []
    let clock = Date.parse('2026-07-18T00:00:00.000Z')
    const service = createAuditExportService({
      settleSeconds: 30,
      store,
      queue: {
        async enqueue(_workspaceId, _exportId, delaySeconds) {
          queued.push(delaySeconds === undefined ? {} : { delaySeconds })
        },
      },
      readEvents: (query) => createReader(index.visible)(query),
      countEvents: createCounter(base),
      now: () => new Date(clock),
      createId: () => '9'.repeat(32),
      ...overrides,
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    // Steps run after the settle delay.
    clock += 60_000
    return { service, store, base, index, queued, job }
  }

  test('restarts a scan that missed an event the index had not received yet', async () => {
    const { service, base, index, queued, job } = await lagging()

    // The index is missing the third event, so the consistent count disagrees.
    expect(await service.processExport('ws-1', job.exportId)).toBe('restarted')
    const restarted = await service.getExport('ws-1', job.exportId)
    expect(restarted).toMatchObject({ status: 'queued', eventCount: 0, parts: [], scanAttempt: 2 })
    expect(restarted.verification).toBeUndefined()
    expect(queued.at(-1)).toEqual({ delaySeconds: 30 })

    index.visible = base
    expect(await service.processExport('ws-1', job.exportId)).toBe('completed')
    const done = await service.getExport('ws-1', job.exportId)
    expect(done).toMatchObject({ status: 'completed', eventCount: 6, scanAttempt: 2 })
    expect(done.verification).toBeUndefined()
  })

  test('fails as incomplete instead of completing when the index keeps missing events', async () => {
    const { service, job } = await lagging()

    expect(await service.processExport('ws-1', job.exportId)).toBe('restarted')
    expect(await service.processExport('ws-1', job.exportId)).toBe('restarted')
    expect(await service.processExport('ws-1', job.exportId)).toBe('failed')
    const failed = await service.getExport('ws-1', job.exportId)
    expect(failed.failure?.code).toBe('AuditExportIncomplete')
    expect(failed.verification).toBeUndefined()
  })

  test('checkpoints a long consistent count across steps with the same predicate as the scan', async () => {
    const counts: AuditEventCountQuery[] = []
    const { service, base, index, job } = await lagging({
      pagesPerStep: 2,
      countEvents: async (query) => {
        counts.push(query)
        const page = Number(query.cursor ?? '0')
        return page < 2 ? { count: 2, nextCursor: String(page + 1) } : { count: 2 }
      },
    })
    index.visible = base

    // One scan page and one count page fit the first step.
    expect(await service.processExport('ws-1', job.exportId)).toBe('advanced')
    expect(await service.getExport('ws-1', job.exportId)).toMatchObject({
      status: 'running',
      eventCount: 6,
      verification: { count: 2, cursor: '1' },
    })
    expect(await service.processExport('ws-1', job.exportId)).toBe('completed')
    expect(counts.map((query) => query.cursor)).toEqual([undefined, '1', '2'])
    expect(counts.every((query) => query.to === job.snapshotAt && query.workspaceId === 'ws-1')).toBe(true)
    // Events whose TTL can pass before the processing deadline are left out of the snapshot.
    expect(counts[0]?.durableAfter).toBe(Date.parse('2026-07-19T00:00:00.000Z') / 1000)
  })

  test('leaves events that TTL may delete during the job out of the export and the count', async () => {
    const store = createMemoryStore()
    // The first event expires exactly at the processing deadline, the second has no TTL.
    const all = events(4).map((event, position) => {
      if (position === 0) return { ...event, expiresAt: 1_784_419_200 }
      if (position === 1) {
        const { expiresAt: _expiresAt, ...held } = event
        void _expiresAt
        return held
      }
      return event
    })
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue() {} },
      // The index never received the expiring event, and TTL then deleted it from the base
      // table, so a check that counted it on neither side could not notice the miss.
      readEvents: createReader(all),
      countEvents: createCounter(all.slice(1)),
      now: fixedNow,
      createId: () => '6'.repeat(32),
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })

    expect(await service.processExport('ws-1', job.exportId)).toBe('completed')
    expect(await service.getExport('ws-1', job.exportId)).toMatchObject({ eventCount: 3 })
    const written = [...store.parts.values()].join('')
    expect(written).not.toContain(all[0]?.eventId ?? 'missing')
    expect(written).toContain(all[1]?.eventId ?? 'missing')
  })
})

describe('audit export continuation recovery', () => {
  test('a redelivered step that already committed only sends its continuation again', async () => {
    const store = createMemoryStore()
    let sendFails = false
    let sends = 0
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: {
        async enqueue() {
          if (sendFails) throw new Error('SQS unavailable')
          sends += 1
        },
      },
      readEvents: createReader(events(30)),
      countEvents: createCounter(events(30)),
      now: fixedNow,
      createId: () => '5'.repeat(32),
      eventsPerPart: 10,
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    sends = 0

    // The step commits its part and cursor, then the continuation send fails.
    sendFails = true
    await expect(service.processExport('ws-1', job.exportId, 'message-1')).rejects.toThrow('SQS unavailable')
    const committed = await store.readJob('ws-1', job.exportId)
    expect(committed?.job).toMatchObject({ status: 'running', eventCount: 10, lastStepMessageId: 'message-1' })

    // Every redelivery of the same message retries only the send, never another step.
    await expect(service.processExport('ws-1', job.exportId, 'message-1')).rejects.toThrow('SQS unavailable')
    sendFails = false
    expect(await service.processExport('ws-1', job.exportId, 'message-1')).toBe('advanced')
    expect(await store.readJob('ws-1', job.exportId)).toEqual(committed)
    expect(store.parts.size).toBe(1)
    expect(sends).toBe(1)

    // The continuation carries a new message and runs the next step.
    expect(await service.processExport('ws-1', job.exportId, 'message-2')).toBe('advanced')
    expect((await service.getExport('ws-1', job.exportId)).eventCount).toBe(20)
    expect(await service.processExport('ws-1', job.exportId, 'message-3')).toBe('completed')
    const done = await service.getExport('ws-1', job.exportId)
    expect(done).toMatchObject({ status: 'completed', eventCount: 30 })
    expect(done.lastStepMessageId).toBeUndefined()
  })

  test('reading a job whose continuation was lost schedules it once per stale period', async () => {
    const store = createMemoryStore()
    let current = fixedNow()
    let sendFails = false
    const queued: string[] = []
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: {
        async enqueue(_workspaceId, exportId) {
          if (sendFails) throw new Error('SQS unavailable')
          queued.push(exportId)
        },
      },
      readEvents: createReader(events(30)),
      countEvents: createCounter(events(30)),
      now: () => current,
      createId: () => '4'.repeat(32),
      eventsPerPart: 10,
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    // The send outage outlasts every receive, so the message reaches the DLQ.
    sendFails = true
    await expect(service.processExport('ws-1', job.exportId, 'message-1')).rejects.toThrow('SQS unavailable')
    sendFails = false
    queued.length = 0

    current = new Date(fixedNow().getTime() + 10 * 60_000)
    expect((await service.getExport('ws-1', job.exportId)).status).toBe('running')
    expect(queued).toEqual([])

    current = new Date(fixedNow().getTime() + 21 * 60_000)
    await service.getExport('ws-1', job.exportId)
    await service.getExport('ws-1', job.exportId)
    expect(await service.listExports('ws-1')).toHaveLength(1)
    expect(queued).toEqual([job.exportId])

    // The resumed step continues from the committed cursor.
    expect(await service.processExport('ws-1', job.exportId, 'message-2')).toBe('advanced')
    expect((await service.getExport('ws-1', job.exportId)).eventCount).toBe(20)
  })

  test('a resume whose send fails stays visible to the next read until a send succeeds', async () => {
    const store = createMemoryStore()
    let current = fixedNow()
    let sendFails = false
    const queued: string[] = []
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: {
        async enqueue(_workspaceId, exportId) {
          if (sendFails) throw new Error('SQS unavailable')
          queued.push(exportId)
        },
      },
      readEvents: createReader(events(30)),
      countEvents: createCounter(events(30)),
      now: () => current,
      createId: () => '2'.repeat(32),
      eventsPerPart: 10,
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    sendFails = true
    await expect(service.processExport('ws-1', job.exportId, 'message-1')).rejects.toThrow('SQS unavailable')
    queued.length = 0

    // The resume claims the job, but its send fails too.
    current = new Date(fixedNow().getTime() + 21 * 60_000)
    await expect(service.getExport('ws-1', job.exportId)).rejects.toThrow('SQS unavailable')
    expect((await store.readJob('ws-1', job.exportId))?.job.continuationPending).toBe(true)

    // A read moments later still sees the job as stale and sends the continuation.
    sendFails = false
    current = new Date(current.getTime() + 1_000)
    await service.getExport('ws-1', job.exportId)
    expect(queued).toEqual([job.exportId])
    expect((await store.readJob('ws-1', job.exportId))?.job.continuationPending).toBeUndefined()

    // Once sent, further reads within the stale period do not send again.
    await service.getExport('ws-1', job.exportId)
    expect(await service.listExports('ws-1')).toHaveLength(1)
    expect(queued).toHaveLength(1)

    // The next step commits and keeps no marker.
    expect(await service.processExport('ws-1', job.exportId, 'message-2')).toBe('advanced')
    expect((await store.readJob('ws-1', job.exportId))?.job).toMatchObject({ eventCount: 20, lastStepMessageId: 'message-2' })
    expect((await store.readJob('ws-1', job.exportId))?.job.continuationPending).toBeUndefined()
  })

  test('does not resume a job past its processing deadline', async () => {
    const store = createMemoryStore()
    let current = fixedNow()
    const queued: string[] = []
    const service = createAuditExportService({
      settleSeconds: 0,
      store,
      queue: { async enqueue(_workspaceId, exportId) { queued.push(exportId) } },
      readEvents: createReader([]),
      countEvents: createCounter([]),
      now: () => current,
      createId: () => '3'.repeat(32),
    })
    const { job } = await service.requestExport({ workspaceId: 'ws-1', requestedBy: requester, filters: {} })
    queued.length = 0
    const before = await store.readJob('ws-1', job.exportId)

    current = new Date(fixedNow().getTime() + 25 * 3_600_000)
    expect((await service.getExport('ws-1', job.exportId)).failure?.code).toBe('AuditExportProcessingTimedOut')
    expect(queued).toEqual([])
    expect(await store.readJob('ws-1', job.exportId)).toEqual(before)
  })
})

describe('normalizeAuditExportFilters', () => {
  const requestedAt = new Date('2026-07-10T00:00:00.000Z')

  test('rejects empty values instead of widening, and validates paired filters and timestamps', () => {
    expect(normalizeAuditExportFilters({ actorId: undefined, from: '2026-07-01T00:00:00.000Z' }, requestedAt))
      .toEqual({ from: '2026-07-01T00:00:00.000Z' })
    // A supplied but empty value would otherwise drop a restriction and export everything.
    expect(() => normalizeAuditExportFilters({ actorId: '' }, requestedAt)).toThrow('actorId must not be empty')
    expect(() => normalizeAuditExportFilters({ actorId: '  ' }, requestedAt)).toThrow('actorId must not be empty')
    expect(() => normalizeAuditExportFilters({ eventTypes: [] }, requestedAt)).toThrow('eventTypes must not be empty')
    // As in the synchronous query, a type may be filtered alone, but an ID needs its type.
    expect(normalizeAuditExportFilters({ entityType: 'work-item' }, requestedAt)).toEqual({ entityType: 'work-item' })
    expect(normalizeAuditExportFilters({ targetType: 'comment' }, requestedAt)).toEqual({ targetType: 'comment' })
    expect(() => normalizeAuditExportFilters({ entityId: 'x' }, requestedAt)).toThrow('entityId requires entityType')
    expect(() => normalizeAuditExportFilters({ targetId: 'x' }, requestedAt)).toThrow('targetId requires targetType')
    expect(() => normalizeAuditExportFilters({ from: 'yesterday' }, requestedAt)).toThrow('ISO 8601')
    expect(() => normalizeAuditExportFilters({ from: '2026-07-02T00:00:00Z', to: '2026-07-01T00:00:00Z' }, requestedAt)).toThrow('later than')
    // The query layer accepts at most 20 non-blank event types; reject the rest before creating a job.
    expect(() => normalizeAuditExportFilters({
      eventTypes: Array.from({ length: 21 }, (_, index) => `event-${index}`),
    }, requestedAt)).toThrow('at most 20')
    expect(() => normalizeAuditExportFilters({ eventTypes: ['work-item.updated', ' '] }, requestedAt)).toThrow('event type is required')
    // The worker caps the range at the snapshot time, so a future lower bound can never match.
    expect(() => normalizeAuditExportFilters({ from: '2026-07-11T00:00:01.000Z' }, new Date('2026-07-11T00:00:00.000Z'))).toThrow('future')
  })
})
