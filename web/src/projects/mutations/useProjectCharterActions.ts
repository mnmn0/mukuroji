import { useCallback } from 'react'
import { useSWRConfig } from 'swr'
import type { ProjectCharterState, ProjectLifecycleState, UpdateProjectCharterInput } from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import { transitionProjectLifecycle, updateProjectCharter } from '../api'
import { useProjectCharter } from '../queries/useProjectCharter'
import { isProjectDirectoryKey } from '../queries/useProjectDirectory'

/** Inputs accepted by the Project charter controller. */
export type UseProjectCharterActionsOptions = {
  /** Cognito access token. */
  accessToken?: string
  /** Team that owns the Project; nothing loads while it is unknown. */
  teamId?: string
  /** Project identifier. */
  projectId: string
  /** Whether the current authentication state permits the requests. */
  enabled: boolean
}

/**
 * Loads one Project's charter and exposes its save and lifecycle actions.
 *
 * Every committed change replaces the cached charter with the server's state and revalidates the
 * Project directory in every locale, so the sidebar, the directory, and Work Item creation see
 * the new lifecycle state.
 *
 * @param options - Session and Project identity.
 * @returns The charter state with reload, save, and transition actions.
 */
export function useProjectCharterActions({
  accessToken,
  teamId,
  projectId,
  enabled,
}: UseProjectCharterActionsOptions) {
  const { mutate: mutateGlobal } = useSWRConfig()
  const charter = useProjectCharter({ accessToken, teamId, projectId, enabled })
  const { mutate } = charter

  const commit = useCallback(async (next: ProjectCharterState) => {
    await mutate(next, { revalidate: false })
    await mutateGlobal(isProjectDirectoryKey)
    return next
  }, [mutate, mutateGlobal])

  const save = useCallback(async (input: UpdateProjectCharterInput) => {
    if (!accessToken || !teamId) return undefined
    return await commit(await updateProjectCharter(
      accessToken,
      teamId,
      projectId,
      input,
      createMutationRequestContext(),
    ))
  }, [accessToken, commit, projectId, teamId])

  const transition = useCallback(async (expectedRevision: number, state: ProjectLifecycleState) => {
    if (!accessToken || !teamId) return undefined
    return await commit(await transitionProjectLifecycle(
      accessToken,
      teamId,
      projectId,
      expectedRevision,
      state,
      createMutationRequestContext(),
    ))
  }, [accessToken, commit, projectId, teamId])

  const reload = useCallback(() => {
    void mutate()
  }, [mutate])

  return {
    state: charter.data,
    isLoading: charter.isLoading,
    hasLoadError: Boolean(charter.error),
    reload,
    save,
    transition,
  }
}
