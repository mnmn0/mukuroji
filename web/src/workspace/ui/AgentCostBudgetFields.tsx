import { useId, useState } from 'react'
import {
  DEFAULT_WORKSPACE_AGENT_COST_SETTINGS,
  isAgentCostUsdExchangeRate,
  type WorkspaceAgentCostSettings,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props of the coding agent cost settings editor. */
export type AgentCostBudgetFieldsProps = {
  /** Settings being edited; absent when the Workspace never saved them. */
  settings: WorkspaceAgentCostSettings | undefined
  /** Workspace currency, whose USD rate the editor shows. */
  currency: string
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited settings. */
  onChange: (settings: WorkspaceAgentCostSettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Edits whether Project budgets count the estimated cost of coding agents, and the USD rate of the
 * Workspace currency that converts it (ADR 0119). Rates of other currencies saved through the API
 * are kept as they are.
 *
 * @param props - Settings draft, Workspace currency, lock state, change callback, and translator.
 * @returns The fields.
 */
export function AgentCostBudgetFields({ settings, currency, disabled, onChange, t }: AgentCostBudgetFieldsProps) {
  const id = useId()
  const current = settings ?? DEFAULT_WORKSPACE_AGENT_COST_SETTINGS
  const storedRate = Object.hasOwn(current.usdExchangeRates, currency) ? current.usdExchangeRates[currency] : undefined
  const [draft, setDraft] = useState<{ currency: string; text: string } | undefined>(undefined)
  const text = draft?.currency === currency ? draft.text : storedRate === undefined ? '' : String(storedRate)
  const trimmed = text.trim()
  const invalid = trimmed !== '' && !isAgentCostUsdExchangeRate(Number(trimmed))
  const missingRate = currency !== 'USD' && storedRate === undefined

  /**
   * Keeps the typed rate and saves it into the settings once it is a valid rate, or removes the
   * rate when the field is cleared or holds an invalid value.
   *
   * @param value - Typed text.
   */
  const changeRate = (value: string) => {
    setDraft({ currency, text: value })
    const rate = Number(value.trim())
    const rates: Record<string, number> = { ...current.usdExchangeRates }
    if (value.trim() !== '' && isAgentCostUsdExchangeRate(rate)) rates[currency] = rate
    else delete rates[currency]
    onChange({ ...current, usdExchangeRates: rates })
  }

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
      {currency === 'USD' ? null : (
        <label className="grid gap-1.5 font-semibold" htmlFor={`${id}-rate`}>
          {t('workspace.tenantAdministration.agentCost.rate').replace('{currency}', currency)}
          <input
            aria-invalid={invalid}
            className="workbench-input max-w-48"
            data-testid="tenant-agent-cost-rate"
            disabled={disabled}
            id={`${id}-rate`}
            inputMode="decimal"
            onChange={(event) => changeRate(event.target.value)}
            value={text}
          />
        </label>
      )}
      {invalid ? (
        <span className="text-xs text-[var(--workbench-danger)]" role="alert">
          {t('workspace.tenantAdministration.agentCost.invalidRate')}
        </span>
      ) : null}
      <span className="text-xs font-normal text-[var(--workbench-muted)]">
        {t(
          current.includeInProjectBudgets && missingRate
            ? 'workspace.tenantAdministration.agentCost.missingRateHint'
            : 'workspace.tenantAdministration.agentCost.hint',
        )}
      </span>
    </fieldset>
  )
}
