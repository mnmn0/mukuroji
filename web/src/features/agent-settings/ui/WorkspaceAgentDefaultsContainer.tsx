import { useState } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import {
  createUpdateWorkspaceAgentDefaultsRequest,
  createWorkspaceAgentDefaultsDraft,
  isWorkspaceAgentDefaultsDraftChanged,
  type WorkspaceAgentDefaultsDraft,
} from '../model/agentSettingsForm'
import { useSaveWorkspaceAgentDefaults } from '../mutations/useSaveWorkspaceAgentDefaults'
import { useWorkspaceAgentDefaults } from '../queries/useWorkspaceAgentDefaults'
import { WorkspaceAgentDefaultsSection } from './WorkspaceAgentDefaultsSection'

/** Inputs of the Workspace agent defaults container. */
export type WorkspaceAgentDefaultsContainerProps = {
  /** Session access token of a Workspace administrator. */
  accessToken: string
  /** Locale used by the section. */
  locale: Locale
  /** Called after a save, so Team settings that inherit the defaults are read again. */
  onSaved?: () => void
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Form values edited from one loaded revision of the defaults. */
type WorkspaceAgentDefaultsDraftState = {
  /** Revision the draft was started from, sent as `expectedRevision`. */
  baseRevision: number
  /** Form values. */
  value: WorkspaceAgentDefaultsDraft
}

/**
 * Connects the Workspace agent defaults section to its query and save.
 *
 * @param props - Authentication, locale, and translator.
 * @returns The defaults section.
 */
export function WorkspaceAgentDefaultsContainer({ accessToken, locale, onSaved, t }: WorkspaceAgentDefaultsContainerProps) {
  const [draftState, setDraftState] = useState<WorkspaceAgentDefaultsDraftState>()
  const defaultsQuery = useWorkspaceAgentDefaults(accessToken)
  const saving = useSaveWorkspaceAgentDefaults({ accessToken, mutateDefaults: defaultsQuery.mutate })
  const defaults = defaultsQuery.data
  const draft = defaults ? draftState?.value ?? createWorkspaceAgentDefaultsDraft(defaults) : undefined
  const baseRevision = draftState?.baseRevision ?? defaults?.revision

  /**
   * Saves the draft against the revision it was started from.
   */
  const handleSave = () => {
    if (!draft || baseRevision === undefined) return
    const request = createUpdateWorkspaceAgentDefaultsRequest(draft, baseRevision)
    if (!request) return
    void saving.save(request).then((outcome) => {
      if (outcome?.kind !== 'saved') return
      setDraftState(undefined)
      onSaved?.()
    })
  }

  return (
    <WorkspaceAgentDefaultsSection
      defaults={defaults}
      draft={draft}
      feedback={saving.feedback}
      hasLoadError={Boolean(defaultsQuery.error)}
      hasRevisionConflict={Boolean(defaults && draftState && draftState.baseRevision !== defaults.revision)}
      isDirty={Boolean(defaults && draft && isWorkspaceAgentDefaultsDraftChanged(defaults, draft))}
      isLoading={defaultsQuery.isLoading}
      isSaving={saving.isSaving}
      locale={locale}
      t={t}
      onDraftChange={(value) => {
        if (!defaults) return
        saving.clearFeedback()
        setDraftState({ baseRevision: draftState?.baseRevision ?? defaults.revision, value })
      }}
      onReload={() => {
        saving.clearFeedback()
        setDraftState(undefined)
        void defaultsQuery.mutate()
      }}
      onRetry={() => void defaultsQuery.mutate()}
      onSave={handleSave}
    />
  )
}
