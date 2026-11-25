import { useMemo } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'

/** Props of {@link TeamAutomationScopeHeader}. */
export type TeamAutomationScopeHeaderProps = {
  /** Display locale. */
  locale: Locale
  /** Whether reading the manageable scopes failed. */
  scopesFailed: boolean
  /** Team whose definitions are shown. */
  selectedTeamId: string
  /** Teams the member can pick. */
  teams: readonly { id: string; name: string }[]
  /** Retries reading the manageable scopes. */
  onRetryScopes: () => void
  /** Selects another Team. */
  onSelectTeam: (teamId: string) => void
}

/**
 * Heading of the Team Automation section: the Team picker, and a retry when the manageable
 * scopes could not be read (ADR 0087).
 *
 * @param props - Locale, Teams, selection, and scope load state.
 * @returns The section heading.
 */
export function TeamAutomationScopeHeader({
  locale,
  scopesFailed,
  selectedTeamId,
  teams,
  onRetryScopes,
  onSelectTeam,
}: TeamAutomationScopeHeaderProps) {
  const t = useMemo(() => createTranslator(locale), [locale])

  return (
    <div className="workbench-panel grid gap-2 px-5 py-5">
      <h2 className="text-lg font-semibold text-[var(--workbench-text)]" id="team-automation-title">
        {t('automation.team.title')}
      </h2>
      <p className="max-w-[720px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
        {t('automation.team.description')}
      </p>
      <label className="grid max-w-xs gap-1 text-sm font-semibold text-[var(--workbench-text)]">
        {t('automation.team.select')}
        <select
          className="workbench-input min-h-10 px-3"
          data-testid="team-automation-team"
          onChange={(event) => onSelectTeam(event.target.value)}
          value={selectedTeamId}
        >
          {teams.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
      </label>
      {scopesFailed ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm font-medium text-[var(--workbench-danger)]">
            {t('automation.team.loadScopes')}
          </p>
          <button
            className="workbench-button-secondary min-h-9 px-3"
            data-testid="team-automation-retry-scopes"
            type="button"
            onClick={onRetryScopes}
          >
            {t('automation.team.retryScopes')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
