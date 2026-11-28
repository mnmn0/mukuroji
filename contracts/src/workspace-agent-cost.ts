/** Millionths of a US dollar in one cent, the minor unit of a USD budget. */
const MICRO_USD_PER_CENT = 10_000

/**
 * How a Workspace counts the estimated cost of coding agents (ADR 0119).
 *
 * Agent Run telemetry reports cost in US dollars (ADR 0061), and the cost stays in US dollars:
 * Project budgets show it only when `includeInProjectBudgets` is on, and add it to the actual cost
 * only when the budget itself is in USD.
 */
export type WorkspaceAgentCostSettings = {
  /**
   * Whether the Project budget report shows the estimated cost of Agent Runs, and whether budgets
   * in USD add it to the actual cost, the threshold alert, and the report's earned value money
   * figures.
   */
  includeInProjectBudgets: boolean
}

/** Agent cost settings of a Workspace that has not chosen its own: off. */
export const DEFAULT_WORKSPACE_AGENT_COST_SETTINGS: WorkspaceAgentCostSettings = {
  includeInProjectBudgets: false,
}

/**
 * Validates Workspace agent cost settings from an untrusted value.
 *
 * @param value - Untrusted settings.
 * @returns The settings, or undefined when the value is not an object with a boolean
 *   `includeInProjectBudgets`.
 */
export function readWorkspaceAgentCostSettings(value: unknown): WorkspaceAgentCostSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const includeInProjectBudgets: unknown = Reflect.get(value, 'includeInProjectBudgets')
  if (typeof includeInProjectBudgets !== 'boolean') return undefined
  return { includeInProjectBudgets }
}

/**
 * Converts an estimated Agent Run cost in millionths of a US dollar to US cents, the minor unit a
 * USD budget counts in (ADR 0119). Callers convert each total once and round at the end.
 *
 * @param costMicroUsd - Cost in millionths of a US dollar.
 * @returns The cost in cents, rounded to an integer.
 */
export function agentCostMicroUsdToCents(costMicroUsd: number): number {
  return Math.round(costMicroUsd / MICRO_USD_PER_CENT)
}
