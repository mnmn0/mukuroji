import { expect, test } from 'bun:test'
import { evaluateBudgetThresholdAlerts, type ScheduledProjectBudgetStatus } from './budget-threshold-alerts'

/**
 * Builds a budget status of one Project.
 *
 * @param overrides - Fields to change.
 * @returns The status.
 */
function status(overrides: Partial<ScheduledProjectBudgetStatus>): ScheduledProjectBudgetStatus {
  return {
    teamId: 't',
    projectId: 'p',
    amountMinor: 100_000,
    currency: 'JPY',
    alertPercent: 90,
    actualCostMinor: 90_000,
    consumedPercent: 90,
    managerMemberKeys: ['pm@example.com'],
    ...overrides,
  }
}

test('decides the alert on the exact cost, even where the products exceed double precision', () => {
  expect(evaluateBudgetThresholdAlerts('w', [status({})])).toHaveLength(1)
  // 89.99% shows as 90.0% but has not reached the threshold.
  expect(evaluateBudgetThresholdAlerts('w', [status({ actualCostMinor: 89_990, consumedPercent: 90 })])).toEqual([])
  // One minor unit short of 90% of the largest safe budget: doubles would round both products equal.
  const amountMinor = Number.MAX_SAFE_INTEGER
  expect(evaluateBudgetThresholdAlerts('w', [status({ amountMinor, actualCostMinor: 8_106_479_329_266_891 })])).toEqual([])
  expect(evaluateBudgetThresholdAlerts('w', [status({ amountMinor, actualCostMinor: 8_106_479_329_266_892 })])).toHaveLength(1)
})

test('refuses a cost past the exact integer range instead of guessing', () => {
  // 110% of the largest safe budget is not a safe integer, so a double product could round up.
  const amountMinor = Number.MAX_SAFE_INTEGER
  expect(() => evaluateBudgetThresholdAlerts('w', [status({ amountMinor, alertPercent: 110, actualCostMinor: 9_907_919_180_215_090 })]))
    .toThrow(RangeError)
})
