import { useCallback, useMemo } from 'react'
import { useSWRConfig } from 'swr'
import type { ProjectLifecycleState, UpdateProjectCharterInput } from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import { transitionProjectLifecycle, updateProjectCharter, type ProjectMember } from '../api'
import { useProjectCharter } from '../queries/useProjectCharter'
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
  /** Project members offered as owner and sponsor. */
  members: readonly ProjectMember[]
  /** Whether the viewer may edit the charter and move the lifecycle. */
  canEdit: boolean
  /** Whether the viewer may approve or reject a proposed Project. */
  canDecideProposal: boolean
  /** Translator for every label. */
  t: (key: MessageKey) => string
}

/**
 * Loads one Project's charter and wires saving and lifecycle transitions to the API.
 *
 * Successful changes also revalidate the Project directory so the sidebar, the directory, and
 * Work Item creation see the new lifecycle state.
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
}: ProjectCharterSectionProps) {
  const { mutate: mutateGlobal } = useSWRConfig()
  const charter = useProjectCharter({ accessToken, teamId, projectId, enabled })
  const { mutate } = charter
  const revalidateDirectory = useCallback(async () => {
    // Revalidate without passing data: an explicit `undefined` would clear the cached directory and
    // unmount the screen while it reloads.
    await mutateGlobal((key) => Array.isArray(key) && key[0] === 'project-directory')
  }, [mutateGlobal])
  const handlers = useMemo(() => ({
    async onSave(input: UpdateProjectCharterInput) {
      if (!accessToken || !teamId) return
      const next = await updateProjectCharter(
        accessToken,
        teamId,
        projectId,
        input,
        createMutationRequestContext(),
      )
      await mutate(next, { revalidate: false })
      await revalidateDirectory()
    },
    async onTransition(expectedRevision: number, state: ProjectLifecycleState) {
      if (!accessToken || !teamId) return
      const next = await transitionProjectLifecycle(
        accessToken,
        teamId,
        projectId,
        expectedRevision,
        state,
        createMutationRequestContext(),
      )
      await mutate(next, { revalidate: false })
      await revalidateDirectory()
    },
  }), [accessToken, mutate, projectId, revalidateDirectory, teamId])

  if (!teamId) return null

  return (
    <ProjectCharterPanel
      canDecideProposal={canDecideProposal}
      canEdit={canEdit}
      hasLoadError={Boolean(charter.error)}
      isLoading={charter.isLoading}
      members={members}
      state={charter.data}
      t={t}
      onReload={() => void mutate()}
      onSave={handlers.onSave}
      onTransition={handlers.onTransition}
    />
  )
}
