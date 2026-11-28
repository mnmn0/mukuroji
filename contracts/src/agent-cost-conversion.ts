import { isCurrencyCode } from './time-rate-cards'

/** Most currencies a Workspace may give a USD exchange rate for. */
export const MAX_AGENT_COST_USD_EXCHANGE_RATES = 20

/** Largest USD exchange rate a Workspace may enter, in major units of the currency per 1 USD. */
export const MAX_AGENT_COST_USD_EXCHANGE_RATE = 1_000_000

/** Most fraction digits a USD exchange rate may have. */
export const AGENT_COST_USD_EXCHANGE_RATE_FRACTION_DIGITS = 6

/** Millionths of a US dollar in one dollar, the unit Agent Run cost is stored in. */
const MICRO_USD_PER_USD = 1_000_000

/**
 * How a Workspace counts the estimated cost of coding agents (ADR 0119).
 *
 * Agent Run telemetry reports cost in US dollars (ADR 0061). The Workspace administrator sets a
 * fixed rate per budget currency, and Project budgets count the cost only when
 * `includeInProjectBudgets` is on.
 */
export type WorkspaceAgentCostSettings = {
  /**
   * Whether the Project budget report, the budget threshold alert, and the report's earned value
   * money figures add the estimated cost of Agent Runs to the actual cost.
   */
  includeInProjectBudgets: boolean
  /**
   * Major units of each currency that one US dollar is worth, keyed by ISO 4217 code, such as
   * `{ JPY: 150 }`. A budget in USD needs no entry.
   */
  usdExchangeRates: Readonly<Record<string, number>>
}

/** Agent cost settings of a Workspace that has not chosen its own: off, with no rates. */
export const DEFAULT_WORKSPACE_AGENT_COST_SETTINGS: WorkspaceAgentCostSettings = {
  includeInProjectBudgets: false,
  usdExchangeRates: {},
}

/**
 * Reports whether a value is a USD exchange rate a Workspace may store: a positive finite number
 * no larger than {@link MAX_AGENT_COST_USD_EXCHANGE_RATE} with at most
 * {@link AGENT_COST_USD_EXCHANGE_RATE_FRACTION_DIGITS} fraction digits.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a valid rate.
 */
export function isAgentCostUsdExchangeRate(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_AGENT_COST_USD_EXCHANGE_RATE) {
    return false
  }
  const scaled = value * 10 ** AGENT_COST_USD_EXCHANGE_RATE_FRACTION_DIGITS
  return Math.abs(scaled - Math.round(scaled)) < 1e-6
}

/**
 * Validates Workspace agent cost settings from an untrusted value.
 *
 * @param value - Untrusted settings.
 * @returns The settings with rates sorted by currency, or undefined when the flag is not a
 *   boolean, a key is not an upper-case ISO 4217 code, a rate is invalid, the rates include USD,
 *   or there are more than {@link MAX_AGENT_COST_USD_EXCHANGE_RATES} rates.
 */
export function readWorkspaceAgentCostSettings(value: unknown): WorkspaceAgentCostSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const includeInProjectBudgets: unknown = Reflect.get(value, 'includeInProjectBudgets')
  const rates: unknown = Reflect.get(value, 'usdExchangeRates')
  if (typeof includeInProjectBudgets !== 'boolean') return undefined
  if (typeof rates !== 'object' || rates === null || Array.isArray(rates)) return undefined
  const entries = Object.entries(rates)
  if (entries.length > MAX_AGENT_COST_USD_EXCHANGE_RATES) return undefined
  const usdExchangeRates: Record<string, number> = {}
  for (const [currency, rate] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!isCurrencyCode(currency) || currency === 'USD' || !isAgentCostUsdExchangeRate(rate)) return undefined
    usdExchangeRates[currency] = rate
  }
  return { includeInProjectBudgets, usdExchangeRates }
}

/**
 * Returns the rate that converts US dollars to a currency under Workspace settings.
 *
 * @param settings - Workspace agent cost settings.
 * @param currency - ISO 4217 code of the target currency.
 * @returns Major units of the currency per US dollar: 1 for USD, the configured rate otherwise,
 *   or undefined when the Workspace has no rate for the currency.
 */
export function resolveAgentCostUsdExchangeRate(
  settings: Pick<WorkspaceAgentCostSettings, 'usdExchangeRates'>,
  currency: string,
): number | undefined {
  if (currency === 'USD') return 1
  return Object.hasOwn(settings.usdExchangeRates, currency) ? settings.usdExchangeRates[currency] : undefined
}

/** Cached minor unit digits by currency. */
const minorDigitsByCurrency = new Map<string, number>()

/**
 * Returns how many minor unit digits a currency has, such as 0 for JPY and 2 for USD.
 *
 * @param currency - ISO 4217 code.
 * @returns Fraction digits the runtime's `Intl` uses for the currency, or 2 when it does not know it.
 */
export function currencyMinorUnitDigits(currency: string): number {
  let digits = minorDigitsByCurrency.get(currency)
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    } catch {
      digits = 2
    }
    minorDigitsByCurrency.set(currency, digits)
  }
  return digits
}

/**
 * Converts an estimated Agent Run cost in millionths of a US dollar to minor units of a currency
 * at a fixed rate (ADR 0119). Callers convert each total once and round at the end, so the sum of
 * converted parts may differ from the converted sum by rounding.
 *
 * @param costMicroUsd - Cost in millionths of a US dollar.
 * @param currency - ISO 4217 code of the target currency.
 * @param usdExchangeRate - Major units of the currency per US dollar.
 * @returns The cost in minor units of the currency, rounded to an integer.
 */
export function convertAgentCostMicroUsdToMinor(costMicroUsd: number, currency: string, usdExchangeRate: number): number {
  return Math.round((costMicroUsd * usdExchangeRate * 10 ** currencyMinorUnitDigits(currency)) / MICRO_USD_PER_USD)
}
