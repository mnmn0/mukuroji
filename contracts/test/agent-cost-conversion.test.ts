import { describe, expect, test } from 'bun:test'
import {
  convertAgentCostMicroUsdToMinor,
  isAgentCostUsdExchangeRate,
  readWorkspaceAgentCostSettings,
  resolveAgentCostUsdExchangeRate,
} from '../src/agent-cost-conversion'

describe('Workspace agent cost settings (ADR 0119)', () => {
  test('reads valid settings with rates sorted by currency', () => {
    expect(readWorkspaceAgentCostSettings({ includeInProjectBudgets: true, usdExchangeRates: { JPY: 150.25, EUR: 0.92 } }))
      .toEqual({ includeInProjectBudgets: true, usdExchangeRates: { EUR: 0.92, JPY: 150.25 } })
  })

  test('rejects USD, lower-case codes, bad rates, and a missing flag', () => {
    expect(readWorkspaceAgentCostSettings({ includeInProjectBudgets: true, usdExchangeRates: { USD: 1 } })).toBeUndefined()
    expect(readWorkspaceAgentCostSettings({ includeInProjectBudgets: true, usdExchangeRates: { jpy: 150 } })).toBeUndefined()
    expect(readWorkspaceAgentCostSettings({ includeInProjectBudgets: true, usdExchangeRates: { JPY: 0 } })).toBeUndefined()
    expect(readWorkspaceAgentCostSettings({ usdExchangeRates: {} })).toBeUndefined()
    expect(readWorkspaceAgentCostSettings({ includeInProjectBudgets: false, usdExchangeRates: [] })).toBeUndefined()
  })

  test('limits rates to six fraction digits and the largest rate', () => {
    expect(isAgentCostUsdExchangeRate(0.000001)).toBe(true)
    expect(isAgentCostUsdExchangeRate(0.0000001)).toBe(false)
    expect(isAgentCostUsdExchangeRate(1_000_000)).toBe(true)
    expect(isAgentCostUsdExchangeRate(1_000_001)).toBe(false)
    expect(isAgentCostUsdExchangeRate(Number.NaN)).toBe(false)
  })

  test('uses 1 for USD and the stored rate otherwise', () => {
    const settings = { usdExchangeRates: { JPY: 150 } }
    expect(resolveAgentCostUsdExchangeRate(settings, 'USD')).toBe(1)
    expect(resolveAgentCostUsdExchangeRate(settings, 'JPY')).toBe(150)
    expect(resolveAgentCostUsdExchangeRate(settings, 'EUR')).toBeUndefined()
  })

  test('converts millionths of a dollar into minor units of the currency', () => {
    // $1.234567 at 150.5 JPY is 185.8 yen; JPY has no minor unit.
    expect(convertAgentCostMicroUsdToMinor(1_234_567, 'JPY', 150.5)).toBe(186)
    // $1.234567 in USD is 123.46 cents.
    expect(convertAgentCostMicroUsdToMinor(1_234_567, 'USD', 1)).toBe(123)
    expect(convertAgentCostMicroUsdToMinor(10_000_000, 'EUR', 0.92)).toBe(920)
  })
})
