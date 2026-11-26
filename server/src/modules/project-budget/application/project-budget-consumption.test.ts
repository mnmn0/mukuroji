import { describe, expect, test } from 'bun:test'
import type { ProjectExpense, TimeBudget, TimeEntry } from '@mukuroji/contracts'
import {
  loadProjectBudgetConsumption,
  sumApprovedProjectExpenses,
  type ProjectBudgetConsumptionPorts,
} from './project-budget-consumption'

/** Project the tests measure. */
const scope = { workspaceId: 'w', teamId: 't', projectId: 'p' }

/**
 * Builds a stored time entry of the Project.
 *
 * @param startAt - Start instant.
 * @param costMinor - Cost of the entry.
 * @param overrides - Fields to change.
 * @returns The entry.
 */
function entry(startAt: string, costMinor: number, overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    schemaVersion: 1,
    workspaceId: 'w',
    teamId: 't',
    id: startAt,
    userId: 'member',
    projectId: 'p',
    startAt,
    endAt: new Date(Date.parse(startAt) + 60 * 60_000).toISOString(),
    durationMinutes: 60,
    billable: true,
    currency: 'JPY',
    actualCostMinor: costMinor,
    source: 'manual',
    status: 'approved',
    revision: 1,
    createdAt: startAt,
    updatedAt: startAt,
    ...overrides,
  }
}

/**
 * Builds an expense of the Project.
 *
 * @param date - Expense date.
 * @param amountMinor - Amount.
 * @param overrides - Fields to change.
 * @returns The expense.
 */
function expense(date: string, amountMinor: number, overrides: Partial<ProjectExpense> = {}): ProjectExpense {
  return {
    id: `${date}-${amountMinor}`,
    teamId: 't',
    projectId: 'p',
    date,
    category: 'License',
    amountMinor,
    currency: 'JPY',
    receiptFileIds: [],
    status: 'approved',
    submittedByMemberId: 'a@example.com',
    submittedAt: `${date}T00:00:00.000Z`,
    decision: { outcome: 'approved', decidedByMemberId: 'b@example.com', decidedAt: `${date}T01:00:00.000Z` },
    revision: 2,
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T01:00:00.000Z`,
    ...overrides,
  }
}

/**
 * Builds a Project budget.
 *
 * @param overrides - Fields to change.
 * @returns The budget.
 */
function budget(overrides: Partial<TimeBudget> = {}): TimeBudget {
  return {
    schemaVersion: 1,
    workspaceId: 'w',
    teamId: 't',
    scopeType: 'project',
    scopeId: 'p',
    amountMinor: 10_000,
    currency: 'JPY',
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Builds ports around fixed data.
 *
 * @param stored - Budget of the Project.
 * @param entries - Time entries of the Project.
 * @param expenses - Expenses of the Project.
 * @param calls - Receives each entry read.
 * @returns The ports.
 */
function ports(
  stored: TimeBudget | undefined,
  entries: TimeEntry[],
  expenses: ProjectExpense[],
  calls: string[] = [],
): ProjectBudgetConsumptionPorts {
  return {
    getBudget: async () => stored,
    listEntries: async (input) => {
      calls.push(`${input.from} ${input.to}`)
      return entries
    },
    listExpenses: async () => expenses,
  }
}

describe('loadProjectBudgetConsumption', () => {
  test('adds approved expenses in the budget currency to the time cost within the period up to today', async () => {
    const calls: string[] = []
    const consumption = await loadProjectBudgetConsumption(scope, 'Asia/Tokyo', new Date('2026-01-20T00:00:00.000Z'), ports(
      budget({ periodFrom: '2026-01-05', periodTo: '2026-03-31' }),
      [
        // 2026-01-04T20:00Z is 2026-01-05 in Tokyo, the first day of the period.
        entry('2026-01-04T20:00:00.000Z', 3_000),
        entry('2026-01-04T10:00:00.000Z', 5_000),
        entry('2026-01-10T00:00:00.000Z', 1_000, { currency: 'USD' }),
        entry('2026-01-11T00:00:00.000Z', 1_000, { projectId: 'other' }),
      ],
      [
        expense('2026-01-06', 4_000),
        expense('2026-01-07', 2_000, { status: 'submitted', decision: undefined }),
        expense('2026-01-08', 2_000, { currency: 'USD' }),
        expense('2026-01-21', 9_000),
      ],
      calls,
    ))
    expect(consumption).toMatchObject({ asOf: '2026-01-20', actualCostMinor: 7_000, consumedPercent: 70 })
    expect(calls).toEqual(['2026-01-04T10:00:00.000Z 2026-01-21T14:00:00.000Z'])
  })

  test('counts from the first record without a period, stops at an ended period, and skips a budget without an amount', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z')
    const calls: string[] = []
    expect(await loadProjectBudgetConsumption(scope, 'UTC', now, ports(budget(), [entry('2020-02-01T00:00:00.000Z', 2_500)], [], calls)))
      .toMatchObject({ asOf: '2026-06-01', consumedPercent: 25 })
    expect(calls[0]?.startsWith('2000-01-01T00:00:00.000Z')).toBe(true)
    expect(await loadProjectBudgetConsumption(scope, 'UTC', now, ports(
      budget({ periodFrom: '2026-01-01', periodTo: '2026-01-31' }),
      [entry('2026-01-31T00:00:00.000Z', 1_000), entry('2026-02-01T00:00:00.000Z', 1_000)],
      [expense('2026-02-02', 1_000)],
    ))).toMatchObject({ asOf: '2026-01-31', actualCostMinor: 1_000, consumedPercent: 10 })
    expect(await loadProjectBudgetConsumption(scope, 'UTC', now, ports(budget({ periodFrom: '2026-07-01' }), [], [])))
      .toMatchObject({ actualCostMinor: 0, consumedPercent: 0 })
    expect(await loadProjectBudgetConsumption(scope, 'UTC', now, ports(budget({ amountMinor: 0 }), [], []))).toBeUndefined()
    expect(await loadProjectBudgetConsumption(scope, 'UTC', now, ports(undefined, [], []))).toBeUndefined()
  })
})

describe('sumApprovedProjectExpenses', () => {
  test('totals approved expenses in the range and flags other currencies', () => {
    const expenses = [
      expense('2026-01-01', 100),
      expense('2026-01-02', 200, { status: 'rejected', decision: { outcome: 'rejected', decidedByMemberId: 'b', decidedAt: '2026-01-02T00:00:00.000Z' } }),
      expense('2026-01-03', 300, { currency: 'USD' }),
      expense('2026-02-01', 400),
    ]
    expect(sumApprovedProjectExpenses(expenses, 'JPY', undefined, '2026-01-31')).toEqual({ amountMinor: 100, hasOtherCurrency: true })
    expect(sumApprovedProjectExpenses(expenses, 'JPY', '2026-01-02', '2026-02-01')).toEqual({ amountMinor: 400, hasOtherCurrency: true })
  })
})
