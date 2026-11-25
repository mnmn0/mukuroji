import { useMemo, useState } from 'react'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { Locale } from '../../shared/i18n/i18n'
import { useAutomationManagementScopes } from '../queries/useAutomationManagementScopes'
import { AutomationManagementPanelContainer } from './AutomationManagementPanelContainer'
import { TeamAutomationScopeHeader } from './TeamAutomationScopeHeader'

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
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.id)
  const team = teams.find((candidate) => candidate.id === selectedTeamId) ?? teams[0]
  const scopes = useAutomationManagementScopes(accessToken)
  const teamList = useMemo(() => (team ? [team] : []), [team])

  if (!team) return null
  const canManage = scopes.data !== undefined &&
    (scopes.data.workspace || scopes.data.teamIds.includes(team.id))

  return (
    <section aria-labelledby="team-automation-title" className="grid gap-3" data-testid="team-automation">
      <TeamAutomationScopeHeader
        locale={locale}
        scopesFailed={scopes.error !== undefined}
        selectedTeamId={team.id}
        teams={teams}
        onRetryScopes={() => void scopes.mutate()}
        onSelectTeam={setSelectedTeamId}
      />
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
