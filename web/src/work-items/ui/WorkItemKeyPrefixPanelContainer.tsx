import { useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { getTeamWorkItemKeyPrefix, TeamIssuesApiError, updateTeamWorkItemKeyPrefix } from '../../issues/api'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { createWorkItemKeyPrefixChoices } from '../model/workItemKeys'
import { WorkItemKeyPrefixPanel, type WorkItemKeyPrefixSaveResult } from './WorkItemKeyPrefixPanel'

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
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.id)
  const team = teams.find((candidate) => candidate.id === selectedTeamId) ?? teams[0]
  const teamId = team?.id
  const { data, error, isLoading, mutate } = useSWR(
    teamId ? ['team-work-item-key-prefix', accessToken, teamId] as const : null,
    ([, token, id]) => getTeamWorkItemKeyPrefix(id, token),
    { revalidateOnFocus: false },
  )
  // Kept per Team, so a change that finishes after switching Teams is not shown on another Team.
  const [saveStates, setSaveStates] = useState<Readonly<Record<string, { isSaving: boolean; result?: WorkItemKeyPrefixSaveResult }>>>({})
  const projectCodeChoices = useMemo(
    () => createWorkItemKeyPrefixChoices(team?.projects.map((project) => project.charter?.code) ?? []),
    [team],
  )

  /**
   * Changes the selected Team's prefix against the loaded one.
   *
   * @param keyPrefix - New uppercase prefix.
   */
  const save = async (keyPrefix: string) => {
    if (!teamId || !data) return
    const request = { keyPrefix, expectedKeyPrefix: data.keyPrefix ?? null }
    setSaveStates((states) => ({ ...states, [teamId]: { isSaving: true } }))
    try {
      const saved = await mutationRunner.run(
        `work-item-key-prefix:${teamId}`,
        JSON.stringify(request),
        (context) => updateTeamWorkItemKeyPrefix(teamId, accessToken, request, context),
      )
      await mutate(saved, { revalidate: false })
      setSaveStates((states) => ({ ...states, [teamId]: { isSaving: false, result: 'saved' } }))
    } catch (caught) {
      const code = caught instanceof TeamIssuesApiError ? caught.code : undefined
      const result: WorkItemKeyPrefixSaveResult = code === 'WorkItemKeyPrefixTaken'
        ? 'taken'
        : code === 'WorkItemKeyPrefixChanged' ? 'conflict' : 'error'
      if (result === 'conflict') await mutate().catch(() => undefined)
      setSaveStates((states) => ({ ...states, [teamId]: { isSaving: false, result } }))
    }
  }

  if (teams.length === 0) return null
  const saveState = teamId ? saveStates[teamId] : undefined
  return (
    <WorkItemKeyPrefixPanel
      hasLoadError={Boolean(error)}
      isLoading={isLoading}
      isSaving={saveState?.isSaving ?? false}
      onRetry={() => { void mutate() }}
      onSave={(keyPrefix) => { void save(keyPrefix) }}
      onSelectTeam={setSelectedTeamId}
      projectCodeChoices={projectCodeChoices}
      {...(saveState?.result ? { saveResult: saveState.result } : {})}
      {...(data ? { settings: data } : {})}
      t={t}
      teamId={teamId}
      teams={teams}
    />
  )
}
