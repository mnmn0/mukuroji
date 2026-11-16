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
  /**
   * Receives every failed load, save, and transition before the panel shows it, so the page can
   * send an expired or revoked session to sign in again.
   */
  onSessionError?: (error: unknown) => void
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
  onSessionError,
}: UseProjectCharterActionsOptions) {
  const { mutate: mutateGlobal } = useSWRConfig()
  const charter = useProjectCharter({ accessToken, teamId, projectId, enabled, onError: onSessionError })
  const { key, mutate } = charter

  // The cache entry is the one the request started from, so a response that arrives after the
  // viewer moved to another Team or Project never lands in that other Project's cache.
  const commit = useCallback(async (
    requestKey: NonNullable<typeof key>,
    next: ProjectCharterState,
  ) => {
    await mutateGlobal(requestKey, next, { revalidate: false })
    await mutateGlobal(isProjectDirectoryKey)
    return next
  }, [mutateGlobal])

  const save = useCallback(async (input: UpdateProjectCharterInput) => {
    if (!key) return undefined
    const [, token, requestTeamId, requestProjectId] = key
    return await commit(key, await reportingSessionError(updateProjectCharter(
      token,
      requestTeamId,
      requestProjectId,
      input,
      createMutationRequestContext(),
    ), onSessionError))
  }, [commit, key, onSessionError])

  const transition = useCallback(async (expectedRevision: number, state: ProjectLifecycleState) => {
    if (!key) return undefined
    const [, token, requestTeamId, requestProjectId] = key
    return await commit(key, await reportingSessionError(transitionProjectLifecycle(
      token,
      requestTeamId,
      requestProjectId,
      expectedRevision,
      state,
      createMutationRequestContext(),
    ), onSessionError))
  }, [commit, key, onSessionError])

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

/**
 * Hands a failed request to the session error handler and rethrows it for the panel.
 *
 * @param request - Pending charter request.
 * @param onSessionError - Optional handler for failed requests.
 * @returns The request's result.
 */
async function reportingSessionError<Result>(
  request: Promise<Result>,
  onSessionError: ((error: unknown) => void) | undefined,
) {
  try {
    return await request
  } catch (error) {
    onSessionError?.(error)
    throw error
  }
}
