import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY as calendarPolicy,
  type ProjectRaidEntry,
  type TimeEntry,
} from '@mukuroji/contracts'
import { InMemoryTimeTrackingRepository, TimeTrackingService } from '../../time-tracking'
import {
  buildTeamPortfolioProjects,
  canCaptureTeamPortfolioSnapshot,
  redactTeamPortfolioSnapshot,
  type PortfolioWorkItem,
} from './team-portfolio'

/**
 * Builds a Work Item scheduled with a due date.
 *
 * @param overrides - Fields that differ from an open task due on 2026-11-30.
 * @returns The Work Item.
 */
function workItem(overrides: Partial<PortfolioWorkItem> & Pick<PortfolioWorkItem, 'id'>): PortfolioWorkItem {
  return {
    title: overrides.id,
    statusCategory: 'started',
    assignedProjectId: 'alpha',
    schedule: { calendarPolicy, mode: 'due-date', dueDate: '2026-11-30' },
    ...overrides,
  }
}

/**
 * Builds an open log entry.
 *
 * @param id - Entry ID.
 * @param kind - Entry kind.
 * @param impact - Impact from 1 to 5.
 * @returns The entry.
 */
function raidEntry(id: string, kind: ProjectRaidEntry['kind'], impact: number): ProjectRaidEntry {
  return {
    id,
    kind,
    title: id,
    impact,
    ...(kind === 'risk' ? { probability: impact } : {}),
    status: 'open',
    revision: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
}

describe('buildTeamPortfolioProjects', () => {
  test('counts progress, overdue, effort, baseline delay, and the next Milestone of each Project', () => {
    const [alpha, beta] = buildTeamPortfolioProjects({
      projectIds: ['alpha', 'beta'],
      workItems: [
        workItem({ id: 'done', statusCategory: 'completed', schedule: { calendarPolicy, mode: 'due-date', dueDate: '2026-11-01', plannedEffortMinutes: 120 } }),
        workItem({ id: 'late', schedule: { calendarPolicy, mode: 'due-date', dueDate: '2026-11-20', plannedEffortMinutes: 240 }, remainingEffortMinutes: 60 }),
        workItem({ id: 'slipped', schedule: { calendarPolicy, mode: 'due-date', dueDate: '2026-12-10' } }),
        workItem({ id: 'm2', schedule: { calendarPolicy, mode: 'milestone', startDate: '2026-12-20', endDate: '2026-12-20', durationDays: 0 } }),
        workItem({ id: 'm1', schedule: { calendarPolicy, mode: 'milestone', startDate: '2026-12-05', endDate: '2026-12-05', durationDays: 0 } }),
        workItem({ id: 'canceled', statusCategory: 'canceled' }),
        workItem({ id: 'archived', archivedAt: '2026-11-02T00:00:00.000Z' }),
        workItem({ id: 'other', assignedProjectId: 'hidden' }),
        workItem({ id: 'beta-one', assignedProjectId: 'beta' }),
      ],
      baselines: new Map([
        ['alpha', { revision: 1, capturedAt: '2026-11-01T00:00:00.000Z', entries: [
          { workItemId: 'slipped', endDate: '2026-12-01' },
          { workItemId: 'late', endDate: '2026-11-25' },
        ] }],
        ['beta', null],
      ]),
      raidEntries: new Map([['alpha', [raidEntry('r1', 'risk', 2), raidEntry('i1', 'issue', 5)]]]),
      budgets: new Map([['alpha', { budget: { amountMinor: 1_000, currency: 'JPY' }, actualCostMinor: 400, hasOtherCurrencyCost: false }]]),
      canSeeCost: (projectId) => projectId === 'alpha',
      today: '2026-11-23',
      localToday: () => '2026-11-23',
    })

    expect(alpha).toEqual({
      projectId: 'alpha',
      workItems: { total: 5, open: 4, completed: 1, overdueOpen: 1 },
      effort: { estimatedCount: 2, plannedMinutes: 360, remainingMinutes: 60 },
      schedule: { hasBaseline: true, delayedOpenCount: 1, maxDelayDays: 9 },
      nextMilestone: { workItemId: 'm1', title: 'm1', dueDate: '2026-12-05' },
      raid: { openRisks: 1, openIssues: 1, openChangeRequests: 0, highestOpenSeverity: 'critical' },
      budget: { amountMinor: 1_000, currency: 'JPY', actualCostMinor: 400, hasOtherCurrencyCost: false },
      costHidden: false,
    })
    expect(beta).toMatchObject({
      projectId: 'beta',
      workItems: { total: 1, open: 1 },
      schedule: { hasBaseline: false, delayedOpenCount: 0 },
      costHidden: true,
    })
    expect(beta?.budget).toBeUndefined()
  })
})

describe('redactTeamPortfolioSnapshot', () => {
  test('leaves out Projects the reader cannot read and budgets the reader may not see', () => {
    const [alpha, beta] = buildTeamPortfolioProjects({
      projectIds: ['alpha', 'beta'],
      workItems: [],
      baselines: new Map(),
      raidEntries: new Map(),
      budgets: new Map([['alpha', { budget: { amountMinor: 10, currency: 'USD' }, actualCostMinor: 1, hasOtherCurrencyCost: false }]]),
      canSeeCost: () => true,
      today: '2026-11-23',
      localToday: () => '2026-11-23',
    })
    if (!alpha || !beta) throw new Error('Rows are missing.')
    const snapshot = redactTeamPortfolioSnapshot(
      { workspaceId: 'w', teamId: 't', month: '2026-11', capturedAt: '2026-11-23T00:00:00.000Z', revision: 1, projects: [alpha, beta] },
      (projectId) => projectId === 'alpha',
      () => false,
    )
    expect(snapshot.hiddenProjectCount).toBe(1)
    expect(snapshot.costHiddenProjectCount).toBe(1)
    expect(snapshot.projects).toHaveLength(1)
    expect(snapshot.projects[0]?.budget).toBeUndefined()
    expect(snapshot.projects[0]?.costHidden).toBe(true)
  })
})

/**
 * Builds a stored billable time entry.
 *
 * @param id - Entry ID.
 * @param projectId - Project of the entry.
 * @param startAt - Start instant.
 * @param endAt - End instant.
 * @param currency - Currency of the rate.
 * @returns The entry.
 */
function timeEntry(id: string, projectId: string, startAt: string, endAt: string, currency = 'JPY'): TimeEntry {
  return {
    schemaVersion: 1,
    id,
    workspaceId: 'w',
    teamId: 't',
    projectId,
    userId: 'member',
    startAt,
    endAt,
    durationMinutes: Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000),
    billable: true,
    currency,
    status: 'approved',
    source: 'manual',
    revision: 1,
    hourlyRateMinor: 6_000,
    createdAt: startAt,
    updatedAt: startAt,
  }
}

describe('TimeTrackingService.summarizeProjectBudgets', () => {
  test('totals billable cost within each budget period up to now and fails closed over the limit', async () => {
    const repository = new InMemoryTimeTrackingRepository()
    const service = new TimeTrackingService(repository)
    await repository.saveBudget({
      schemaVersion: 1, workspaceId: 'w', teamId: 't', scopeType: 'project', scopeId: 'alpha', amountMinor: 100_000, currency: 'JPY',
      periodFrom: '2026-11-01', periodTo: '2026-11-30', revision: 1, updatedAt: '2026-11-01T00:00:00.000Z',
    }, 0)
    await repository.saveEntry(timeEntry('before', 'alpha', '2026-10-31T10:00:00.000Z', '2026-10-31T11:00:00.000Z'))
    await repository.saveEntry(timeEntry('inside', 'alpha', '2026-11-10T10:00:00.000Z', '2026-11-10T12:00:00.000Z'))
    await repository.saveEntry(timeEntry('usd', 'alpha', '2026-11-11T10:00:00.000Z', '2026-11-11T11:00:00.000Z', 'USD'))
    await repository.saveEntry(timeEntry('future', 'alpha', '2026-11-25T10:00:00.000Z', '2026-11-25T11:00:00.000Z'))
    const input = { workspaceId: 'w', teamId: 't', projectIds: ['alpha', 'none'], timeZone: 'UTC', now: new Date('2026-11-23T00:00:00.000Z'), entryLimit: 10 }

    const budgets = await service.summarizeProjectBudgets(input)
    expect([...budgets.keys()]).toEqual(['alpha'])
    expect(budgets.get('alpha')).toMatchObject({ actualCostMinor: 12_000, hasOtherCurrencyCost: true })

    await expect(service.summarizeProjectBudgets({ ...input, entryLimit: 1 })).rejects.toMatchObject({ status: 413, code: 'PortfolioTooLarge' })
  })

  test('reads only the budget of the same Project ID in the requested Team', async () => {
    const repository = new InMemoryTimeTrackingRepository()
    const service = new TimeTrackingService(repository)
    await repository.saveBudget({
      schemaVersion: 1, workspaceId: 'w', teamId: 'other-team', scopeType: 'project', scopeId: 'alpha', amountMinor: 1, currency: 'USD',
      revision: 1, updatedAt: '2026-11-01T00:00:00.000Z',
    }, 0)

    const budgets = await service.summarizeProjectBudgets({
      workspaceId: 'w', teamId: 't', projectIds: ['alpha'], timeZone: 'UTC', now: new Date('2026-11-23T00:00:00.000Z'), entryLimit: 10,
    })

    expect(budgets.size).toBe(0)
  })

  test('counts only entries inside each Project budget period toward the limit', async () => {
    const repository = new InMemoryTimeTrackingRepository()
    const service = new TimeTrackingService(repository)
    await repository.saveBudget({
      schemaVersion: 1, workspaceId: 'w', teamId: 't', scopeType: 'project', scopeId: 'alpha', amountMinor: 100_000, currency: 'JPY',
      periodFrom: '2026-01-01', periodTo: '2026-01-31', revision: 1, updatedAt: '2026-01-01T00:00:00.000Z',
    }, 0)
    await repository.saveBudget({
      schemaVersion: 1, workspaceId: 'w', teamId: 't', scopeType: 'project', scopeId: 'beta', amountMinor: 100_000, currency: 'JPY',
      periodFrom: '2026-11-01', periodTo: '2026-11-30', revision: 1, updatedAt: '2026-11-01T00:00:00.000Z',
    }, 0)
    await repository.saveEntry(timeEntry('alpha-jan', 'alpha', '2026-01-10T10:00:00.000Z', '2026-01-10T11:00:00.000Z'))
    for (const day of ['03', '04', '05']) {
      await repository.saveEntry(timeEntry(`alpha-nov-${day}`, 'alpha', `2026-11-${day}T10:00:00.000Z`, `2026-11-${day}T11:00:00.000Z`))
    }
    await repository.saveEntry(timeEntry('beta-nov', 'beta', '2026-11-10T10:00:00.000Z', '2026-11-10T11:00:00.000Z'))

    const budgets = await service.summarizeProjectBudgets({
      workspaceId: 'w', teamId: 't', projectIds: ['alpha', 'beta'], timeZone: 'UTC', now: new Date('2026-11-23T00:00:00.000Z'), entryLimit: 2,
    })
    expect(budgets.get('alpha')).toMatchObject({ actualCostMinor: 6_000 })
    expect(budgets.get('beta')).toMatchObject({ actualCostMinor: 6_000 })
  })

  test('reads a budget that ends far in the future up to now', async () => {
    const repository = new InMemoryTimeTrackingRepository()
    const service = new TimeTrackingService(repository)
    await repository.saveBudget({
      schemaVersion: 1, workspaceId: 'w', teamId: 't', scopeType: 'project', scopeId: 'alpha', amountMinor: 100_000, currency: 'JPY',
      periodFrom: '2026-11-01', periodTo: '9999-12-31', revision: 1, updatedAt: '2026-11-01T00:00:00.000Z',
    }, 0)
    await repository.saveEntry(timeEntry('inside', 'alpha', '2026-11-10T10:00:00.000Z', '2026-11-10T11:00:00.000Z'))
    const budgets = await service.summarizeProjectBudgets({
      workspaceId: 'w', teamId: 't', projectIds: ['alpha'], timeZone: 'Asia/Tokyo', now: new Date('2026-11-23T00:00:00.000Z'), entryLimit: 10,
    })
    expect(budgets.get('alpha')).toMatchObject({ actualCostMinor: 6_000 })
  })

  test('refuses a total cost that cannot be represented exactly', async () => {
    const repository = new InMemoryTimeTrackingRepository()
    const service = new TimeTrackingService(repository)
    await repository.saveBudget({
      schemaVersion: 1, workspaceId: 'w', teamId: 't', scopeType: 'project', scopeId: 'alpha', amountMinor: 100_000, currency: 'JPY',
      periodFrom: '2026-11-01', periodTo: '2026-11-30', revision: 1, updatedAt: '2026-11-01T00:00:00.000Z',
    }, 0)
    for (const id of ['a', 'b']) {
      await repository.saveEntry({
        ...timeEntry(id, 'alpha', '2026-11-10T10:00:00.000Z', '2026-11-10T11:00:00.000Z'),
        hourlyRateMinor: 5_000_000_000_000_000,
      })
    }
    await expect(service.summarizeProjectBudgets({
      workspaceId: 'w', teamId: 't', projectIds: ['alpha'], timeZone: 'UTC', now: new Date('2026-11-23T00:00:00.000Z'), entryLimit: 10,
    })).rejects.toMatchObject({ status: 422, code: 'PortfolioCostOverflow' })
  })
})

describe('canCaptureTeamPortfolioSnapshot', () => {
  /** Manager access to a Team of two Projects that can read and cost both. */
  const fullAccess = {
    isSystemAdmin: false,
    isTeamManager: true,
    directTeamGrant: false,
    projectIds: ['alpha', 'beta'],
    canReadProject: () => true,
    canSeeCost: () => true,
  }

  test('allows a manager who reads and costs every Project', () => {
    expect(canCaptureTeamPortfolioSnapshot(fullAccess)).toBe(true)
  })

  test('rejects a Team-wide grant that cannot read one Project, so a save cannot drop it', () => {
    expect(canCaptureTeamPortfolioSnapshot({
      ...fullAccess,
      directTeamGrant: true,
      canReadProject: (projectId) => projectId !== 'beta',
    })).toBe(false)
  })

  test('rejects a manager who cannot see one Project cost', () => {
    expect(canCaptureTeamPortfolioSnapshot({ ...fullAccess, canSeeCost: (projectId) => projectId === 'alpha' })).toBe(false)
  })

  test('allows an empty Team only with a Team-wide grant, and always a system administrator', () => {
    expect(canCaptureTeamPortfolioSnapshot({ ...fullAccess, projectIds: [] })).toBe(false)
    expect(canCaptureTeamPortfolioSnapshot({ ...fullAccess, projectIds: [], directTeamGrant: true })).toBe(true)
    expect(canCaptureTeamPortfolioSnapshot({ ...fullAccess, isTeamManager: false })).toBe(false)
    expect(canCaptureTeamPortfolioSnapshot({ ...fullAccess, isTeamManager: false, isSystemAdmin: true })).toBe(true)
  })
})
