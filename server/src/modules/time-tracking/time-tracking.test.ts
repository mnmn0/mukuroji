import { describe, expect, test } from 'bun:test'
import { DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS } from '@mukuroji/contracts'
import {
  InMemoryTimeTrackingRepository,
  TimeTrackingError,
  TimeTrackingService,
  type TimeTrackingCategorySource,
  type TimeTrackingIdempotencyPort,
} from './time-tracking'

/**
 * Creates an in-memory idempotency receipt store that replays a completed key
 * with the same fingerprint and rejects the key with any other fingerprint.
 */
function createIdempotencyStore(): TimeTrackingIdempotencyPort {
  const receipts = new Map<string, { fingerprint: string; response?: unknown }>()
  return {
    async reserveIdempotency(request) {
      const key = `${request.credentialId}\0${request.idempotencyKey}`
      const receipt = receipts.get(key)
      if (!receipt) {
        receipts.set(key, { fingerprint: request.requestFingerprint })
        return { status: 'reserved', reservationId: key }
      }
      if (receipt.fingerprint !== request.requestFingerprint) {
        throw new TimeTrackingError(409, 'IdempotencyKeyConflict', 'The key was used with another request.')
      }
      return receipt.response === undefined ? { status: 'in-progress' } : { status: 'replay', response: receipt.response }
    },
    async completeIdempotency(request) {
      receipts.set(request.reservationId, { fingerprint: request.requestFingerprint, response: request.response })
    },
    async releaseIdempotency(request) {
      receipts.delete(request.reservationId)
    },
  }
}

/** Creates an isolated service fixture with deterministic IDs and clock values. */
function createFixture(categories?: TimeTrackingCategorySource) {
  let id = 0
  const repository = new InMemoryTimeTrackingRepository()
  /** Canonical Work Item estimates keyed by Workspace, Team, and Work Item. */
  const plannedEffort = new Map<string, number>()
  const service = new TimeTrackingService(repository, {
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: () => `id-${++id}`,
    estimates: {
      async listPlannedEffort(workspaceId, teamId) {
        const prefix = `${workspaceId}\0${teamId}\0`
        return new Map([...plannedEffort].flatMap(([key, minutes]) =>
          key.startsWith(prefix) ? [[key.slice(prefix.length), minutes] as const] : []
        ))
      },
    },
    ...(categories ? { categories } : {}),
  })
  return { repository, service, plannedEffort }
}

describe('TimeTrackingService', () => {
  test('creates, submits, approves, and locks an entry with immutable history', async () => {
    const { service } = createFixture()
    const entry = await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:30:00.000Z',
      billable: true,
      currency: 'jpy',
      hourlyRateMinor: 2_000,
      source: 'manual',
    }, true)

    const submitted = await service.transitionEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      canApprove: false,
      expectedRevision: entry.revision,
      action: 'submit',
    })
    const approved = await service.transitionEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'manager-1',
      canApprove: true,
      expectedRevision: submitted.revision,
      action: 'approve',
    })
    const locked = await service.transitionEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'manager-1',
      canApprove: true,
      expectedRevision: approved.revision,
      action: 'lock',
    })

    expect(locked.status).toBe('locked')
    expect(locked.durationMinutes).toBe(90)
    expect(locked.actualCostMinor).toBe(3_000)
    expect(await service.listHistory('workspace-1', 'team-1', entry.id)).toHaveLength(4)
  })

  test('rejects confidential rate changes for a general member', async () => {
    const { service } = createFixture()
    await expect(service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 100,
      source: 'manual',
    }, false)).rejects.toMatchObject({
      code: 'ConfidentialRateDenied',
      status: 403,
    })
  })

  test('allows only one running timer and recovers it before stopping', async () => {
    const { service } = createFixture()
    const timer = await service.startTimer({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      billable: false,
      startedAt: '2026-08-02T09:00:00.000Z',
    })
    await expect(service.startTimer({
      workspaceId: 'workspace-1',
      teamId: 'team-2',
      workItemId: 'work-item-2',
      userId: 'member-1',
      billable: true,
    })).rejects.toMatchObject({ code: 'RunningTimerAlreadyExists' })
    expect((await service.getActiveTimer('workspace-1', 'member-1'))?.id).toBe(timer.id)
    const entry = await service.stopTimer({
      workspaceId: 'workspace-1',
      timerId: timer.id,
      userId: 'member-1',
      endedAt: '2026-08-02T10:15:00.000Z',
      currency: 'USD',
      canManageRates: false,
    })
    expect(entry.source).toBe('timer')
    expect(entry.durationMinutes).toBe(75)
    expect(await service.getActiveTimer('workspace-1', 'member-1')).toBeUndefined()
  })

  test('splits an interval crossing local midnight into daily and weekly timesheets', async () => {
    const { service } = createFixture()
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-01T14:30:00.000Z',
      endAt: '2026-08-01T16:30:00.000Z',
      billable: true,
      currency: 'USD',
      source: 'manual',
    }, false)
    const sheet = await service.createTimesheet({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-01',
      to: '2026-08-02',
      timeZone: 'Asia/Tokyo',
      groupBy: 'day',
      includeCosts: false,
    })
    expect(sheet.days.map((day) => [day.key, day.minutes])).toEqual([
      ['2026-08-01', 30],
      ['2026-08-02', 90],
    ])
    expect(sheet.weeks).toHaveLength(1)
    expect(sheet.costsRedacted).toBe(true)
  })

  test('starts weekly timesheet and report buckets on the Workspace week start day', async () => {
    const { service } = createFixture({
      readCategories: async () => DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
      readWeekStartDay: async () => 0,
    })
    for (const [startAt, endAt] of [
      ['2026-08-01T01:00:00.000Z', '2026-08-01T02:00:00.000Z'],
      ['2026-08-02T01:00:00.000Z', '2026-08-02T03:00:00.000Z'],
    ] as const) {
      await service.createEntry({
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        workItemId: 'work-item-1',
        userId: 'member-1',
        startAt,
        endAt,
        billable: true,
        currency: 'USD',
        source: 'manual',
      }, false)
    }
    const input = {
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-07-26',
      to: '2026-08-08',
      timeZone: 'Asia/Tokyo',
      groupBy: 'week',
      includeCosts: false,
    } as const
    const sheet = await service.createTimesheet(input)
    expect(sheet.weeks.map((week) => [week.key, week.minutes])).toEqual([
      ['2026-07-26', 60],
      ['2026-08-02', 120],
    ])
    const summary = await service.createSummary(input)
    expect(summary.groups.map((group) => [group.key, group.minutes])).toEqual([
      ['2026-07-26', 60],
      ['2026-08-02', 120],
    ])

    const monday = createFixture()
    await monday.service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T01:00:00.000Z',
      endAt: '2026-08-02T02:00:00.000Z',
      billable: true,
      currency: 'USD',
      source: 'manual',
    }, false)
    expect((await monday.service.createTimesheet(input)).weeks.map((week) => week.key)).toEqual(['2026-07-27'])
  })

  test('compares canonical Work Item estimates with project grouped actual time', async () => {
    const { service, plannedEffort } = createFixture()
    plannedEffort.set('workspace-1\0team-1\0work-item-1', 120)
    plannedEffort.set('workspace-1\0team-2\0work-item-1', 999)
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 5_000,
      source: 'manual',
    }, true)
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T10:00:00.000Z',
      endAt: '2026-08-02T10:30:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 5_000,
      source: 'manual',
    }, true)
    const summary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-02',
      to: '2026-08-02',
      timeZone: 'UTC',
      groupBy: 'project',
      includeCosts: true,
    })
    expect(summary.groups[0]).toMatchObject({
      key: 'project-1',
      minutes: 90,
      estimateMinutes: 120,
      actualCostMinor: 7_500,
    })
    expect(summary.totalActualCostMinor).toBe(7_500)
    expect(summary.totalEstimateMinutes).toBe(120)

    const workItemSummary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-02',
      to: '2026-08-02',
      timeZone: 'UTC',
      groupBy: 'work-item',
      includeCosts: false,
    })
    expect(workItemSummary.groups[0]).toMatchObject({
      key: 'work-item-1',
      minutes: 90,
      estimateMinutes: 120,
    })
    const userSummary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-02',
      to: '2026-08-02',
      timeZone: 'UTC',
      groupBy: 'user',
      includeCosts: false,
    })
    expect(userSummary.totalEstimateMinutes).toBe(120)
  })

  test('clears stale costs, enforces budget revisions, and rejects invalid dates', async () => {
    const { service } = createFixture()
    const entry = await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 6_000,
      source: 'manual',
    }, true)
    const updated = await service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      canManageRates: true,
      expectedRevision: entry.revision,
      billable: false,
    })
    expect(updated.actualCostMinor).toBeUndefined()

    await expect(service.saveBudget({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      scopeType: 'team',
      scopeId: 'team-1',
      amountMinor: 10_000,
      currency: 'USD',
      periodFrom: '2026-02-30',
      expectedRevision: 0,
      updatedBy: 'manager-1',
    })).rejects.toMatchObject({ code: 'InvalidDate' })
    const budget = await service.saveBudget({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      scopeType: 'team',
      scopeId: 'team-1',
      amountMinor: 10_000,
      currency: 'USD',
      expectedRevision: 0,
      updatedBy: 'manager-1',
    })
    await expect(service.saveBudget({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      scopeType: 'team',
      scopeId: 'team-1',
      amountMinor: 12_000,
      currency: 'USD',
      expectedRevision: 0,
      updatedBy: 'manager-1',
    })).rejects.toMatchObject({ code: 'TimeBudgetRevisionConflict' })
    expect(budget.revision).toBe(1)
  })

  test('keeps the alert percentage of a Project default budget across saves that omit it (ADR 0105)', async () => {
    const { service } = createFixture()
    const base = {
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      scopeType: 'project' as const,
      scopeId: 'project-1',
      amountMinor: 10_000,
      currency: 'JPY',
      updatedBy: 'manager-1',
    }
    const saved = await service.saveBudget({ ...base, alertPercent: 80, expectedRevision: 0 })
    expect(saved.alertPercent).toBe(80)
    const edited = await service.saveBudget({ ...base, amountMinor: 20_000, expectedRevision: 1 })
    expect(edited).toMatchObject({ amountMinor: 20_000, alertPercent: 80 })
    expect((await service.getBudget('workspace-1', 'team-1', 'project', 'project-1'))?.alertPercent).toBe(80)
    for (const alertPercent of [0, 1001, 12.5]) {
      await expect(service.saveBudget({ ...base, alertPercent, expectedRevision: 2 }))
        .rejects.toMatchObject({ status: 400, code: 'InvalidBudgetAlertPercent' })
    }
    await expect(service.saveBudget({ ...base, scopeType: 'team', scopeId: 'team-1', alertPercent: 90, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'InvalidBudgetAlertPercent' })
    await expect(service.saveBudget({
      ...base,
      periodFrom: '2026-04-01',
      periodTo: '2027-03-31',
      periodBudget: true,
      alertPercent: 90,
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: 'InvalidBudgetAlertPercent' })
  })

  test('clips report totals and keeps mixed-currency costs separate', async () => {
    const { service } = createFixture()
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-usd',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T11:00:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 6_000,
      source: 'manual',
    }, true)
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-eur',
      userId: 'member-1',
      startAt: '2026-08-02T09:30:00.000Z',
      endAt: '2026-08-02T10:30:00.000Z',
      billable: true,
      currency: 'EUR',
      hourlyRateMinor: 6_000,
      source: 'manual',
    }, true)
    const summary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-02T10:00:00.000Z',
      to: '2026-08-02T11:00:00.000Z',
      timeZone: 'UTC',
      groupBy: 'user',
      includeCosts: true,
    })
    expect(summary.totalMinutes).toBe(90)
    expect(summary.totalActualCostMinor).toBeUndefined()
    expect(summary.totalActualCostByCurrency).toEqual({ EUR: 3_000, USD: 6_000 })
  })

  test('loads more than 500 entries for complete reports', async () => {
    const { service } = createFixture()
    const base = Date.parse('2026-08-01T00:00:00.000Z')
    for (let index = 0; index < 501; index += 1) {
      const startAt = new Date(base + index * 60_000).toISOString()
      const endAt = new Date(base + (index + 1) * 60_000).toISOString()
      await service.createEntry({
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        workItemId: `work-item-${index}`,
        userId: 'member-1',
        startAt,
        endAt,
        billable: false,
        currency: 'USD',
        source: 'manual',
      }, false)
    }
    const summary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-01',
      to: '2026-08-02',
      timeZone: 'UTC',
      groupBy: 'user',
      includeCosts: false,
    })
    expect(summary.totalMinutes).toBe(501)
    expect(summary.groups[0]?.entryCount).toBe(501)
  })

  test('allows an overlong timer to be cancelled', async () => {
    const { service } = createFixture()
    const timer = await service.startTimer({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      billable: false,
      startedAt: '2026-07-20T09:00:00.000Z',
    })
    await service.cancelTimer({
      workspaceId: 'workspace-1',
      timerId: timer.id,
      userId: 'member-1',
    })
    expect(await service.getActiveTimer('workspace-1', 'member-1')).toBeUndefined()
  })

  test('replays an entry update whose derived authorization changed between retries', async () => {
    const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      createId: (() => {
        let id = 0
        return () => `id-${++id}`
      })(),
      idempotency: createIdempotencyStore(),
    })
    const entry = await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: true,
      currency: 'USD',
      source: 'manual',
    }, false)
    const update = {
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      expectedRevision: entry.revision,
      workItemId: 'work-item-2',
      projectId: 'project-2',
      idempotencyKey: 'move-1',
    }
    const first = await service.updateEntry({ ...update, canManageRates: false, authorizedRevision: entry.revision })
    const retry = await service.updateEntry({ ...update, canManageRates: true, authorizedRevision: first.revision })
    expect(retry).toEqual(first)
  })

  test('replays an entry whose currency came from a Workspace default that changed between retries', async () => {
    const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      createId: (() => {
        let id = 0
        return () => `id-${++id}`
      })(),
      idempotency: createIdempotencyStore(),
    })
    const request = {
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: true,
      source: 'manual' as const,
      idempotencyKey: 'create-1',
    }
    const first = await service.createEntry({ ...request, currency: 'EUR', currencyFromWorkspaceDefault: true }, false)
    const retry = await service.createEntry({ ...request, currency: 'USD', currencyFromWorkspaceDefault: true }, false)
    expect(retry).toEqual(first)
    // A currency the client named is still part of the request.
    await expect(service.createEntry({ ...request, currency: 'USD' }, false))
      .rejects.toMatchObject({ code: 'IdempotencyKeyConflict' })
  })

  test('records a categorized date-and-minutes entry and reports it by category', async () => {
    const { service } = createFixture()
    const meeting = await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      duration: { date: '2026-08-03', minutes: 120, timeZone: 'Asia/Tokyo' },
      category: 'meeting',
      billable: false,
      currency: 'JPY',
      source: 'manual',
    }, false)
    expect(meeting).toMatchObject({
      startAt: '2026-08-02T15:00:00.000Z',
      endAt: '2026-08-02T17:00:00.000Z',
      durationMinutes: 120,
      durationOnly: true,
      category: 'meeting',
    })
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-03T01:00:00.000Z',
      endAt: '2026-08-03T01:30:00.000Z',
      billable: false,
      currency: 'JPY',
      source: 'manual',
    }, false)

    const summary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-03',
      to: '2026-08-09',
      timeZone: 'Asia/Tokyo',
      groupBy: 'category',
      includeCosts: false,
    })
    expect(summary.groups.map(({ key, label, minutes }) => ({ key, label, minutes }))).toEqual([
      { key: 'meeting', label: 'meeting', minutes: 120 },
      { key: 'uncategorized', label: 'Uncategorized', minutes: 30 },
    ])
    expect(summary.totalMinutes).toBe(150)
    const csv = await service.createCsv({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-03',
      to: '2026-08-09',
      timeZone: 'Asia/Tokyo',
      groupBy: 'category',
      includeCosts: false,
    })
    expect(csv.split('\n')[1]).toStartWith('meeting,120,')

    const edited = await service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: meeting.id,
      actorUserId: 'member-1',
      canManageRates: false,
      expectedRevision: 1,
      category: null,
    })
    expect(edited.category).toBeUndefined()
    expect(edited.durationOnly).toBe(true)
    const timed = await service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: meeting.id,
      actorUserId: 'member-1',
      canManageRates: false,
      expectedRevision: 2,
      startAt: '2026-08-03T00:00:00.000Z',
      endAt: '2026-08-03T01:00:00.000Z',
      category: 'review',
    })
    expect(timed.durationOnly).toBeUndefined()
    expect(timed.category).toBe('review')
  })

  test('records time only under categories the Workspace offers and names them in reports', async () => {
    let id = 0
    const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
      now: () => new Date('2026-08-03T09:00:00.000Z'),
      createId: () => `id-${++id}`,
      categories: {
        readCategories: async () => ({
          categories: [
            { key: 'meeting', label: '打ち合わせ', active: true },
            { key: 'custom-sales', label: '営業支援', active: true },
            { key: 'leave', active: false },
          ],
        }),
      },
    })
    const base = {
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      userId: 'member-1',
      duration: { date: '2026-08-03', minutes: 60, timeZone: 'Asia/Tokyo' },
      billable: false,
      currency: 'JPY',
      source: 'manual' as const,
    }
    const sales = await service.createEntry({ ...base, category: 'custom-sales' }, false)
    expect(sales.category).toBe('custom-sales')
    // A retired category and one the Workspace does not define are both refused for new time.
    for (const category of ['leave', 'design']) {
      await expect(service.createEntry({ ...base, category }, false)).rejects.toMatchObject({
        status: 400,
        code: 'InvalidTimeEntryCategory',
      })
    }
    await expect(service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: sales.id,
      actorUserId: 'member-1',
      canManageRates: false,
      expectedRevision: 1,
      category: 'leave',
    })).rejects.toMatchObject({ status: 400, code: 'InvalidTimeEntryCategory' })

    const summary = await service.createSummary({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-03',
      to: '2026-08-09',
      timeZone: 'Asia/Tokyo',
      groupBy: 'category',
      includeCosts: false,
    })
    expect(summary.groups.map(({ key, label, minutes }) => ({ key, label, minutes }))).toEqual([
      { key: 'custom-sales', label: '営業支援', minutes: 60 },
    ])
  })

  test('keeps a category the Workspace retired after the entry was recorded', async () => {
    let active = true
    let id = 0
    const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
      now: () => new Date('2026-08-03T09:00:00.000Z'),
      createId: () => `id-${++id}`,
      categories: { readCategories: async () => ({ categories: [{ key: 'custom-sales', label: '営業支援', active }, { key: 'meeting', active: true }] }) },
    })
    const entry = await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      userId: 'member-1',
      duration: { date: '2026-08-03', minutes: 60, timeZone: 'Asia/Tokyo' },
      category: 'custom-sales',
      billable: false,
      currency: 'JPY',
      source: 'manual',
    }, false)
    active = false
    const edited = await service.updateEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      canManageRates: false,
      expectedRevision: 1,
      category: 'custom-sales',
      description: 'Proposal review',
    })
    expect(edited).toMatchObject({ category: 'custom-sales', description: 'Proposal review' })
  })

  test('rejects invalid date-and-minutes entries', async () => {
    const { service } = createFixture()
    const base = {
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      billable: false,
      currency: 'JPY',
      source: 'manual' as const,
    }
    const cases: Array<[Parameters<TimeTrackingService['createEntry']>[0], string]> = [
      [{ ...base, duration: { date: '2026-02-30', minutes: 60, timeZone: 'UTC' } }, 'InvalidDate'],
      [{ ...base, duration: { date: '2026-08-03', minutes: 0, timeZone: 'UTC' } }, 'InvalidInteger'],
      [{ ...base, duration: { date: '2026-08-03', minutes: 1.5, timeZone: 'UTC' } }, 'InvalidInteger'],
      [{ ...base, duration: { date: '2026-08-03', minutes: 60, timeZone: 'Mars/Base' } }, 'InvalidTimeZone'],
      // 2026-03-08 is 23 hours long in New York.
      [{ ...base, duration: { date: '2026-03-08', minutes: 24 * 60, timeZone: 'America/New_York' } }, 'TimeEntryExceedsDay'],
      [{ ...base, startAt: '2026-08-03T00:00:00.000Z', duration: { date: '2026-08-03', minutes: 60, timeZone: 'UTC' } }, 'InvalidRequest'],
      [{ ...base, startAt: '2026-08-03T00:00:00.000Z' }, 'InvalidRequest'],
    ]
    for (const [input, code] of cases) {
      await expect(service.createEntry(input, false)).rejects.toMatchObject({ code })
    }
  })
})
