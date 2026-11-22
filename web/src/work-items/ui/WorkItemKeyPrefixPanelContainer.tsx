import { useMemo, useState } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { createWorkItemKeyPrefixChoices } from '../model/workItemKeys'
import { useTeamWorkItemKeyPrefixController } from '../mutations/useTeamWorkItemKeyPrefixController'
import { WorkItemKeyPrefixPanel } from './WorkItemKeyPrefixPanel'

/** Team as listed in the Workspace directory. */
export type WorkItemKeyPrefixTeam = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
  /** Projects of the Team, whose codes become prefix choices. */
  projects: readonly {
    /** Descriptive charter, holding the Project code when one is set. */
    charter?: {
      /** Workspace-unique Project code. */
      code?: string
    }
  }[]
}

/** Props of {@link WorkItemKeyPrefixPanelContainer}. */
export type WorkItemKeyPrefixPanelContainerProps = {
  /** Session access token. */
  accessToken: string
  /** Locale used by the panel. */
  locale: Locale
  /** Teams of the Workspace. */
  teams: readonly WorkItemKeyPrefixTeam[]
}

/**
 * Connects the key prefix panel to the selected Team's setting and its change.
 *
 * @param props - Authentication, locale, and Teams.
 * @returns The key prefix panel.
 */
export function WorkItemKeyPrefixPanelContainer({ accessToken, locale, teams }: WorkItemKeyPrefixPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.id)
  const team = teams.find((candidate) => candidate.id === selectedTeamId) ?? teams[0]
  const teamId = team?.id
  const controller = useTeamWorkItemKeyPrefixController(accessToken, teamId)
  const projectCodeChoices = useMemo(
    () => createWorkItemKeyPrefixChoices(team?.projects.map((project) => project.charter?.code) ?? []),
    [team],
  )

  if (teams.length === 0) return null
  return (
    <WorkItemKeyPrefixPanel
      hasLoadError={controller.hasLoadError}
      isLoading={controller.isLoading}
      isSaving={controller.isSaving}
      onRetry={controller.retry}
      onSave={controller.save}
      onSelectTeam={setSelectedTeamId}
      projectCodeChoices={projectCodeChoices}
      {...(controller.saveResult ? { saveResult: controller.saveResult } : {})}
      {...(controller.settings ? { settings: controller.settings } : {})}
      t={t}
      teamId={teamId}
      teams={teams}
    />
  )
}
