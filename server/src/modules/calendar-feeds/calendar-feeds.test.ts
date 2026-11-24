import { expect, test } from 'bun:test'
import { CALENDAR_FEED_PROJECT_LIMIT } from '@mukuroji/contracts'
import { InMemoryCalendarFeedStore } from './adapter-out/dynamodb/calendar-feed-store'
import {
  CALENDAR_FEED_WORK_ITEM_PAGE_LIMIT,
  readCalendarFeedUseCase,
  type CalendarFeedOwnerView,
  type CalendarFeedPlanningRow,
  type CalendarFeedReader,
  type CalendarFeedWorkItemRow,
} from './application/calendar-feed-read'
import {
  CalendarFeedError,
  createCalendarFeedToken,
  issueCalendarFeedUseCase,
  parseCalendarFeedToken,
  resolveCalendarFeedTokenUseCase,
  type CalendarFeedIssueReceiptDecision,
  type CalendarFeedIssueReceipts,
} from './application/calendar-feed-use-cases'

/** Owner of the test feeds. */
const owner = { workspaceId: 'workspace#1', memberKey: 'demo@example.com' }

/** Lets the owner read every Project. */
const canReadProject = async () => true

/**
 * Creates in-memory issue receipts that complete after the save, like a store without
 * transaction support.
 *
 * @returns The receipts and the number of reservations.
 */
function createReceipts() {
  const stored = new Map<string, { fingerprint: string, response?: unknown }>()
  const counts = { reserved: 0 }
  const receipts: CalendarFeedIssueReceipts<never> = {
    async reserve(key): Promise<CalendarFeedIssueReceiptDecision> {
      const current = stored.get(key.idempotencyKey)
      if (current && current.fingerprint !== key.requestFingerprint) {
        throw new CalendarFeedError('conflict', 'CalendarFeedIdempotencyConflict', 'conflict')
      }
      if (current?.response !== undefined) return { status: 'replay', response: current.response }
      stored.set(key.idempotencyKey, { fingerprint: key.requestFingerprint })
      counts.reserved += 1
      return { status: 'reserved', reservationId: `r${counts.reserved}` }
    },
    async prepareCompletion() {
      return undefined
    },
    async complete(key) {
      stored.set(key.idempotencyKey, { fingerprint: key.requestFingerprint, response: { status: 201, body: key.response } })
    },
    async release(key) {
      stored.delete(key.idempotencyKey)
    },
  }
  return { receipts, counts }
}

test('round-trips a token and rejects altered ones', () => {
  const { token, tokenHash } = createCalendarFeedToken(owner.workspaceId, Buffer.alloc(32, 7))
  expect(parseCalendarFeedToken(`${token}.ics`)).toEqual({ workspaceId: owner.workspaceId, tokenHash })
  expect(parseCalendarFeedToken(token)).toEqual({ workspaceId: owner.workspaceId, tokenHash })
  const [workspacePart, secret] = token.split('.')
  expect(parseCalendarFeedToken(`${workspacePart}.${secret?.slice(1)}`)).toBeUndefined()
  expect(parseCalendarFeedToken(`${workspacePart}=.${secret}`)).toBeUndefined()
  expect(parseCalendarFeedToken(`.${secret}`)).toBeUndefined()
  expect(parseCalendarFeedToken(undefined)).toBeUndefined()
  // A different secret never maps to the same digest.
  expect(createCalendarFeedToken(owner.workspaceId, Buffer.alloc(32, 8)).tokenHash).not.toBe(tokenHash)
})

test('limits the number of Project feeds but still lets an existing one be replaced', async () => {
  const store = new InMemoryCalendarFeedStore()
  const now = '2026-11-24T00:00:00.000Z'
  for (let index = 0; index < CALENDAR_FEED_PROJECT_LIMIT; index += 1) {
    await issueCalendarFeedUseCase(store, owner, { kind: 'project', teamId: 't', projectId: `p${index}` }, { now, canReadProject })
  }
  const over = issueCalendarFeedUseCase(store, owner, { kind: 'project', teamId: 't', projectId: 'extra' }, { now, canReadProject })
  expect(over).rejects.toBeInstanceOf(CalendarFeedError)
  await over.catch(() => undefined)
  const replaced = await issueCalendarFeedUseCase(store, owner, { kind: 'project', teamId: 't', projectId: 'p0' }, { now, canReadProject })
  expect(await resolveCalendarFeedTokenUseCase(store, replaced.feedPath.split('/').at(-1)))
    .toMatchObject({ workspaceId: owner.workspaceId, record: { projectId: 'p0' } })
  // The member feed does not count toward the Project limit.
  await issueCalendarFeedUseCase(store, owner, { kind: 'member' }, { now, canReadProject })
})

test('returns the first URL again when an issue request is retried with the same key', async () => {
  const store = new InMemoryCalendarFeedStore()
  const { receipts, counts } = createReceipts()
  const now = '2026-11-24T00:00:00.000Z'
  const options = { now, canReadProject, idempotency: { receipts, key: 'issue-1' } }
  const first = await issueCalendarFeedUseCase(store, owner, { kind: 'member' }, options)
  const retried = await issueCalendarFeedUseCase(store, owner, { kind: 'member' }, options)
  expect(retried).toEqual(first)
  expect(counts.reserved).toBe(1)
  // The URL still resolves: the retry did not rotate the token.
  expect(await resolveCalendarFeedTokenUseCase(store, first.feedPath.split('/').at(-1))).toBeDefined()
  // The same key with another body is refused.
  const other = issueCalendarFeedUseCase(store, owner, { kind: 'project', teamId: 't', projectId: 'p' }, options)
  expect(other).rejects.toMatchObject({ category: 'conflict' })
  await other.catch(() => undefined)
  // Another key rotates the token.
  const rotated = await issueCalendarFeedUseCase(store, owner, { kind: 'member' }, { ...options, idempotency: { receipts, key: 'issue-2' } })
  expect(rotated.feedPath).not.toBe(first.feedPath)
  expect(await resolveCalendarFeedTokenUseCase(store, first.feedPath.split('/').at(-1))).toBeUndefined()
})

test('answers a retry during the first request as temporarily unavailable, so the key is kept', async () => {
  const store = new InMemoryCalendarFeedStore()
  const receipts: CalendarFeedIssueReceipts<never> = {
    reserve: async () => ({ status: 'in-progress' }),
    prepareCompletion: async () => undefined,
    complete: async () => undefined,
    release: async () => undefined,
  }
  const retried = issueCalendarFeedUseCase(store, owner, { kind: 'member' }, {
    now: '2026-11-24T00:00:00.000Z',
    canReadProject,
    idempotency: { receipts, key: 'issue-1' },
  })
  await expect(retried).rejects.toMatchObject({ category: 'unavailable', code: 'CalendarFeedIssueInProgress' })
  expect(await store.list({ workspaceId: owner.workspaceId, memberKey: owner.memberKey })).toEqual([])
})

test('refuses a Project feed for a Project the owner cannot read', async () => {
  const store = new InMemoryCalendarFeedStore()
  const issued = issueCalendarFeedUseCase(store, owner, { kind: 'project', teamId: 't', projectId: 'hidden' }, {
    now: '2026-11-24T00:00:00.000Z',
    canReadProject: async () => false,
  })
  expect(issued).rejects.toMatchObject({ category: 'not-found', code: 'ProjectNotFound' })
  await issued.catch(() => undefined)
  expect(await store.list(owner)).toEqual([])
})

/**
 * Creates a Work Item row for the reader fake.
 *
 * @param id - Work Item ID.
 * @param projectId - Assigned Project.
 * @param dueDate - Deadline, or none for an unscheduled Work Item.
 * @returns The row.
 */
function workItemRow(id: string, projectId: string, dueDate?: string): CalendarFeedWorkItemRow {
  const calendarPolicy = { timeZone: 'Asia/Tokyo', workingWeekdays: [], holidays: [] }
  return {
    id,
    teamId: 'team-a',
    key: `A-${id}`,
    title: `Task ${id}`,
    revision: 1,
    assignedProjectId: projectId,
    schedule: dueDate ? { mode: 'due-date', dueDate, calendarPolicy } : { mode: 'unscheduled', calendarPolicy },
  }
}

/**
 * Creates a Milestone row for the reader fake.
 *
 * @param id - Milestone ID.
 * @param projectId - Project of the Milestone.
 * @returns The row.
 */
function milestoneRow(id: string, projectId: string): CalendarFeedPlanningRow {
  return {
    id,
    type: 'milestone',
    title: `Milestone ${id}`,
    teamId: 'team-a',
    projectId,
    ownerMemberKey: 'someone-else@example.com',
    forecast: { startDate: '2026-12-01', endDate: '2026-12-01' },
  }
}

test('keeps the Milestones of a Project whose member tasks have no dates', async () => {
  const store = new InMemoryCalendarFeedStore()
  const issued = await issueCalendarFeedUseCase(store, owner, { kind: 'member' }, {
    now: '2026-11-24T00:00:00.000Z',
    canReadProject,
  })
  const view: CalendarFeedOwnerView = {
    memberKeys: [owner.memberKey],
    async readWorkItemPage() {
      return { workItems: [workItemRow('1', 'undated'), workItemRow('2', 'dated', '2026-11-30')] }
    },
    async readPlanningEntities() {
      return [milestoneRow('m-undated', 'undated'), milestoneRow('m-dated', 'dated'), milestoneRow('m-other', 'other')]
    },
  }
  const reader: CalendarFeedReader = {
    openOwnerView: async () => view,
    readTimeZone: async () => 'Asia/Tokyo',
    consumeRateLimit: async () => ({ allowed: true }),
  }
  const result = await readCalendarFeedUseCase(store, reader, issued.feedPath.split('/').at(-1), new Date('2026-11-24T00:00:00Z'))
  if (result.kind !== 'feed') throw new Error(`Expected a feed, got ${result.kind}`)
  expect(result.body).toContain('Milestone m-undated')
  expect(result.body).toContain('Milestone m-dated')
  expect(result.body).not.toContain('Milestone m-other')
  // Only the dated task becomes an event.
  expect(result.body).toContain('A-2')
  expect(result.body).not.toContain('A-1 ')
})

test('fails instead of serving a partial feed when Work Item pages remain', async () => {
  const store = new InMemoryCalendarFeedStore()
  const issued = await issueCalendarFeedUseCase(store, owner, { kind: 'member' }, {
    now: '2026-11-24T00:00:00.000Z',
    canReadProject,
  })
  let pages = 0
  const reader: CalendarFeedReader = {
    openOwnerView: async () => ({
      memberKeys: [owner.memberKey],
      async readWorkItemPage() {
        pages += 1
        return { workItems: [], nextCursor: `cursor-${pages}` }
      },
      readPlanningEntities: async () => [],
    }),
    readTimeZone: async () => 'Asia/Tokyo',
    consumeRateLimit: async () => ({ allowed: true }),
  }
  const token = issued.feedPath.split('/').at(-1)
  expect(await readCalendarFeedUseCase(store, reader, token, new Date())).toEqual({ kind: 'too-large' })
  expect(pages).toBe(CALENDAR_FEED_WORK_ITEM_PAGE_LIMIT)
})

test('answers not found when the owner loses access during a read, and reports a rate limit', async () => {
  const store = new InMemoryCalendarFeedStore()
  const issued = await issueCalendarFeedUseCase(store, owner, { kind: 'member' }, {
    now: '2026-11-24T00:00:00.000Z',
    canReadProject,
  })
  const token = issued.feedPath.split('/').at(-1)
  const lost: CalendarFeedReader = {
    openOwnerView: async () => ({
      memberKeys: [owner.memberKey],
      async readWorkItemPage() {
        throw new CalendarFeedError('not-found', 'CalendarFeedAccessLost', 'lost')
      },
      readPlanningEntities: async () => [],
    }),
    readTimeZone: async () => 'Asia/Tokyo',
    consumeRateLimit: async () => ({ allowed: true }),
  }
  expect(await readCalendarFeedUseCase(store, lost, token, new Date())).toEqual({ kind: 'not-found' })
  const limited: CalendarFeedReader = { ...lost, consumeRateLimit: async () => ({ allowed: false, retryAfterSeconds: 12 }) }
  expect(await readCalendarFeedUseCase(store, limited, token, new Date())).toEqual({ kind: 'rate-limited', retryAfterSeconds: 12 })
  expect(await readCalendarFeedUseCase(store, lost, 'not-a-token', new Date())).toEqual({ kind: 'not-found' })
})
