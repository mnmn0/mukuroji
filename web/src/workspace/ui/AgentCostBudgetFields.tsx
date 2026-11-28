import { DEFAULT_WORKSPACE_AGENT_COST_SETTINGS, type WorkspaceAgentCostSettings } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props of the coding agent cost settings editor. */
export type AgentCostBudgetFieldsProps = {
  /** Settings being edited; absent when the Workspace never saved them. */
  settings: WorkspaceAgentCostSettings | undefined
  /** Workspace currency; the hint says whether budgets in it add the cost. */
  currency: string
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited settings. */
  onChange: (settings: WorkspaceAgentCostSettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Edits whether Project budgets show the estimated cost of coding agents in US dollars (ADR 0119).
 * Budgets in USD also add it to the actual cost; other budgets show it beside the actual cost.
 *
 * @param props - Settings draft, Workspace currency, lock state, change callback, and translator.
 * @returns The fields.
 */
export function AgentCostBudgetFields({ settings, currency, disabled, onChange, t }: AgentCostBudgetFieldsProps) {
  const current = settings ?? DEFAULT_WORKSPACE_AGENT_COST_SETTINGS
  return (
    <fieldset className="grid gap-2 text-sm text-[var(--workbench-text)]" data-testid="tenant-agent-cost">
      <legend className="font-semibold">{t('workspace.tenantAdministration.agentCost.title')}</legend>
      <label className="flex items-center gap-2">
        <input
          checked={current.includeInProjectBudgets}
          data-testid="tenant-agent-cost-include"
          disabled={disabled}
          onChange={(event) => onChange({ ...current, includeInProjectBudgets: event.target.checked })}
          type="checkbox"
        />
        {t('workspace.tenantAdministration.agentCost.include')}
      </label>
      <span className="text-xs font-normal text-[var(--workbench-muted)]">
        {t(currency === 'USD'
          ? 'workspace.tenantAdministration.agentCost.hint'
          : 'workspace.tenantAdministration.agentCost.otherCurrencyHint')}
      </span>
    </fieldset>
  )
}
