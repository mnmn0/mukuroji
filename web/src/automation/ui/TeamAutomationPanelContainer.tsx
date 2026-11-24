import { useMemo, useState } from 'react'
import type { ProjectDirectoryTeam } from '../../projects/api'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { useAutomationManagementScopes } from '../queries/useAutomationManagementScopes'
import { AutomationManagementPanelContainer } from './AutomationManagementPanelContainer'

/** Props of {@link TeamAutomationPanelContainer}. */
export type TeamAutomationPanelContainerProps = {
  /** Session access token. */
  accessToken: string
  /** Display locale. */
  locale: Locale
  /** Teams of the Workspace. */
  teams: readonly ProjectDirectoryTeam[]
}

/**
 * Shows the Automation definitions owned by one Team from the Team settings, editable when the
 * member manages that Team (ADR 0087).
 *
 * @param props - Authentication, locale, and Teams.
 * @returns The Team Automation section, or nothing when the Workspace has no Team.
 */
export function TeamAutomationPanelContainer({ accessToken, locale, teams }: TeamAutomationPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.id)
  const team = teams.find((candidate) => candidate.id === selectedTeamId) ?? teams[0]
  const scopes = useAutomationManagementScopes(accessToken)
  const teamList = useMemo(() => (team ? [team] : []), [team])

  if (!team) return null
  const canManage = scopes.data !== undefined &&
    (scopes.data.workspace || scopes.data.teamIds.includes(team.id))

  return (
    <section aria-labelledby="team-automation-title" className="grid gap-3" data-testid="team-automation">
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
            onChange={(event) => setSelectedTeamId(event.target.value)}
            value={team.id}
          >
            {teams.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        {scopes.error ? (
          <p className="text-sm font-medium text-[var(--workbench-danger)]" role="alert">
            {t('automation.team.loadScopes')}
          </p>
        ) : null}
      </div>
      <AutomationManagementPanelContainer
        accessToken={accessToken}
        canManage={canManage}
        key={team.id}
        locale={locale}
        ownerTeamId={team.id}
        teams={teamList}
      />
    </section>
  )
}
