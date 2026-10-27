import { useMemo, useState } from 'react'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { useWorkItemConfiguration } from '../../../work-items/queries/useWorkItemConfigurations'
import {
  createAgentSettingsDraft,
  createUpdateAgentSettingsRequest,
  isAgentSettingsDraftChanged,
  listAgentAcceptanceCriteriaFieldOptions,
  listAgentProjectBriefTargets,
  listAgentReadyStatusOptions,
  type AgentSettingsDraft,
  type AgentSettingsProject,
} from '../model/agentSettingsForm'
import { useSaveTeamAgentSettings } from '../mutations/useSaveTeamAgentSettings'
import { useTeamAgentSettings } from '../queries/useTeamAgentSettings'
import { AgentSettingsPanel, type AgentSettingsConfigurationState } from './AgentSettingsPanel'

/** Team as listed in the Workspace directory. */
export type AgentSettingsTeam = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
  /** Projects of the Team that the operator can see. */
  projects: readonly AgentSettingsProject[]
}

/** Inputs of the Agent settings container. */
export type AgentSettingsPanelContainerProps = {
  /** Session access token. */
  accessToken: string
  /** Whether the operator may attempt Team configuration changes; the server still requires a Team manager. */
  canMutateTeamConfiguration: boolean
  /** Locale used by the panel. */
  locale: Locale
  /** Teams of the Workspace. */
  teams: readonly AgentSettingsTeam[]
}

/** Form values edited from one loaded revision of one Team's settings. */
type AgentSettingsDraftState = {
  /** Team the draft belongs to. */
  teamId: string
  /** Revision the draft was started from, sent as `expectedRevision`. */
  baseRevision: number
  /** Form values. */
  value: AgentSettingsDraft
}

/**
 * Connects the Agent settings panel to the Team's settings, its Work Item configuration, and the save.
 *
 * @param props - Authentication, permission, locale, and Teams.
 * @returns The Agent settings panel for the selected Team.
 */
export function AgentSettingsPanelContainer({
  accessToken,
  canMutateTeamConfiguration,
  locale,
  teams,
}: AgentSettingsPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.id)
  const [draftState, setDraftState] = useState<AgentSettingsDraftState>()
  const [deniedTeamIds, setDeniedTeamIds] = useState<ReadonlySet<string>>(() => new Set())
  const team = teams.find((candidate) => candidate.id === selectedTeamId) ?? teams[0]
  const teamId = team?.id
  const settingsQuery = useTeamAgentSettings(accessToken, teamId)
  const configurationQuery = useWorkItemConfiguration(accessToken, teamId)
  const saving = useSaveTeamAgentSettings({
    accessToken,
    mutateSettings: settingsQuery.mutate,
    teamId: teamId ?? '',
  })
  const settings = settingsQuery.data
  const ownDraft = draftState && draftState.teamId === teamId ? draftState : undefined
  const draft = settings ? ownDraft?.value ?? createAgentSettingsDraft(settings) : undefined
  const baseRevision = ownDraft?.baseRevision ?? settings?.revision
  const configuration = configurationQuery.data?.configuration
  const configurationState: AgentSettingsConfigurationState = configuration
    ? 'ready'
    : configurationQuery.error ? 'error' : 'loading'
  const readOnly = !canMutateTeamConfiguration || (teamId !== undefined && deniedTeamIds.has(teamId))

  /**
   * Discards the draft and the save outcome.
   */
  const resetEditing = () => {
    saving.clearFeedback()
    setDraftState(undefined)
  }

  /**
   * Saves the draft against the revision it was started from.
   */
  const handleSave = () => {
    if (!teamId || !draft || baseRevision === undefined) return
    const request = createUpdateAgentSettingsRequest(draft, baseRevision)
    if (!request) return
    void saving.save(request).then((outcome) => {
      if (outcome?.kind === 'saved') setDraftState(undefined)
      if (outcome?.kind === 'forbidden') {
        setDraftState(undefined)
        setDeniedTeamIds((current) => new Set([...current, teamId]))
      }
    })
  }

  return (
    <AgentSettingsPanel
      acceptanceCriteriaFieldOptions={listAgentAcceptanceCriteriaFieldOptions(configuration, draft?.acceptanceCriteriaFieldId ?? '')}
      configurationState={configurationState}
      draft={draft}
      feedback={saving.feedback}
      hasLoadError={Boolean(settingsQuery.error)}
      hasRevisionConflict={Boolean(settings && ownDraft && ownDraft.baseRevision !== settings.revision)}
      isDirty={Boolean(settings && draft && isAgentSettingsDraftChanged(settings, draft))}
      isLoading={settingsQuery.isLoading}
      isSaving={saving.isSaving}
      locale={locale}
      projectBriefTargets={settings ? listAgentProjectBriefTargets(team?.projects ?? [], settings.projectBriefs) : []}
      readOnly={readOnly}
      readyStatusOptions={listAgentReadyStatusOptions(configuration, draft?.readyStatusIds ?? [])}
      selectedTeamId={teamId}
      settings={settings}
      t={t}
      teamOptions={teams}
      onConfigurationRetry={() => void configurationQuery.mutate()}
      onDraftChange={(value) => {
        if (!teamId || !settings) return
        saving.clearFeedback()
        setDraftState({ teamId, baseRevision: ownDraft?.baseRevision ?? settings.revision, value })
      }}
      onReload={() => {
        resetEditing()
        void settingsQuery.mutate()
      }}
      onRetry={() => void settingsQuery.mutate()}
      onSave={handleSave}
      onTeamChange={(nextTeamId) => {
        resetEditing()
        setSelectedTeamId(nextTeamId)
      }}
    />
  )
}
