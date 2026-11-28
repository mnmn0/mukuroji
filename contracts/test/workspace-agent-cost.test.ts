import { describe, expect, test } from 'bun:test'
import { agentCostMicroUsdToCents, readWorkspaceAgentCostSettings } from '../src/workspace-agent-cost'

describe('Workspace agent cost settings (ADR 0119)', () => {
  test('reads the flag and drops other fields', () => {
    expect(readWorkspaceAgentCostSettings({ includeInProjectBudgets: true })).toEqual({ includeInProjectBudgets: true })
    expect(readWorkspaceAgentCostSettings({ includeInProjectBudgets: false, usdExchangeRates: { JPY: 150 } }))
      .toEqual({ includeInProjectBudgets: false })
  })

  test('rejects settings without a boolean flag', () => {
    expect(readWorkspaceAgentCostSettings({})).toBeUndefined()
    expect(readWorkspaceAgentCostSettings({ includeInProjectBudgets: 'yes' })).toBeUndefined()
    expect(readWorkspaceAgentCostSettings([])).toBeUndefined()
    expect(readWorkspaceAgentCostSettings(null)).toBeUndefined()
  })

  test('converts millionths of a dollar to cents, rounding once', () => {
    expect(agentCostMicroUsdToCents(1_234_567)).toBe(123)
    expect(agentCostMicroUsdToCents(5_000)).toBe(1)
    expect(agentCostMicroUsdToCents(0)).toBe(0)
  })
})
