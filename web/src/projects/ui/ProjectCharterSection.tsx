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
  /** Whether this session may change content at all, for example while online. */
  canMutate: boolean
  /** Fallback edit permission used until the server states the viewer's capabilities. */
  canEdit: boolean
  /** Fallback proposal-decision permission used until the server states the viewer's capabilities. */
  canDecideProposal: boolean
  /** Translator for every label. */
  t: (key: MessageKey) => string
  /** Keeps unsaved drafts per Project while the section is not shown. */
  draftStore?: ProjectCharterDraftStore
  /** Receives every failed charter request, so the page can handle an expired session. */
  onSessionError?: (error: unknown) => void
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
  canMutate,
  canEdit,
  canDecideProposal,
  t,
  draftStore,
  onSessionError,
}: ProjectCharterSectionProps) {
  const charter = useProjectCharterActions({ accessToken, teamId, projectId, enabled, onSessionError })
  // The server decides with the effective permissions, including Enterprise roles the client
  // cannot evaluate, so its answer replaces the role-based fallback once the charter is loaded.
  const viewer = charter.state?.viewer
  const keepDraft = useCallback((
    draft: ProjectCharterDraft | undefined,
    previous: ProjectCharterDraft | undefined,
  ) => {
    if (teamId) draftStore?.write(teamId, projectId, draft, previous)
  }, [draftStore, projectId, teamId])

  if (!teamId) return null

  // A draft belongs to one Team and Project, so another pair always starts a fresh panel.
  return (
    <ProjectCharterPanel
      key={JSON.stringify([teamId, projectId])}
      canDecideProposal={viewer ? canMutate && viewer.canDecideProposal : canDecideProposal}
      initialDraft={draftStore?.read(teamId, projectId)}
      onDraftChange={keepDraft}
      canEdit={viewer ? canMutate && viewer.canEdit : canEdit}
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
