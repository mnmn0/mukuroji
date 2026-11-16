import type { MessageKey } from '../../shared/i18n/i18n'
import { useCallback } from 'react'
import type {
  ProjectCharterDraft,
  ProjectCharterDraftStore,
  ProjectCharterPersonCandidate,
} from '../model/projectCharterView'
import { useProjectCharterActions } from '../mutations/useProjectCharterActions'
import { ProjectCharterPanel } from './ProjectCharterPanel'

/** Props for the self-loading Project charter section. */
export type ProjectCharterSectionProps = {
  /** Cognito access token. */
  accessToken?: string
  /** Team that owns the Project; the section waits while it is ambiguous. */
  teamId?: string
  /** Project identifier. */
  projectId: string
  /** Whether loading is allowed for the current session. */
  enabled: boolean
  /** Active Workspace members offered as owner and sponsor. */
  members: readonly ProjectCharterPersonCandidate[]
  /** Whether the viewer may edit the charter and move the lifecycle. */
  canEdit: boolean
  /** Whether the viewer may approve or reject a proposed Project. */
  canDecideProposal: boolean
  /** Translator for every label. */
  t: (key: MessageKey) => string
  /** Keeps unsaved drafts per Project while the section is not shown. */
  draftStore?: ProjectCharterDraftStore
}

/**
 * Connects the Project charter panel to its query and mutation controller.
 *
 * @param props - Session, Project identity, and permissions.
 * @returns The charter panel, or nothing while the owning Team is unknown.
 */
export function ProjectCharterSection({
  accessToken,
  teamId,
  projectId,
  enabled,
  members,
  canEdit,
  canDecideProposal,
  t,
  draftStore,
}: ProjectCharterSectionProps) {
  const charter = useProjectCharterActions({ accessToken, teamId, projectId, enabled })
  const keepDraft = useCallback((draft: ProjectCharterDraft | undefined) => {
    if (teamId) draftStore?.write(teamId, projectId, draft)
  }, [draftStore, projectId, teamId])

  if (!teamId) return null

  // A draft belongs to one Team and Project, so another pair always starts a fresh panel.
  return (
    <ProjectCharterPanel
      key={JSON.stringify([teamId, projectId])}
      canDecideProposal={canDecideProposal}
      initialDraft={draftStore?.read(teamId, projectId)}
      onDraftChange={keepDraft}
      canEdit={canEdit}
      hasLoadError={charter.hasLoadError}
      isLoading={charter.isLoading}
      members={members}
      state={charter.state}
      t={t}
      onReload={charter.reload}
      onSave={charter.save}
      onTransition={charter.transition}
    />
  )
}
