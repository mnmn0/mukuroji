import type { CreateProjectStatusShareRequest } from '@mukuroji/contracts'
import { useCallback, useRef } from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from '../api/errors'
import { createProjectStatusShare, revokeProjectStatusShare } from '../api/statusReports'
import { projectStatusSharesKey } from '../queries/useProjectStatusShares'

/**
 * Returns the actions that create and revoke a Project's share links and reload the list.
 *
 * A creation that failed without a client error keeps its request context, so creating the same
 * link again reuses its Idempotency-Key and the server returns the link of an attempt whose
 * response was lost. The context is dropped once the server answers with success or a client
 * error, or when the request changes.
 *
 * @param accessToken - Session access token; the actions do nothing without it.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The create action, which returns the created link, and the revoke action.
 */
export function useProjectStatusShareActions(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string | undefined,
) {
  const { mutate } = useSWRConfig()
  const pendingCreate = useRef<{ fingerprint: string; context: MutationRequestContext }>(undefined)
  const create = useCallback(async (request: CreateProjectStatusShareRequest) => {
    if (!accessToken || !teamId || !projectId) throw new Error('The session is not ready.')
    const fingerprint = JSON.stringify([teamId, projectId, request])
    if (pendingCreate.current?.fingerprint !== fingerprint) {
      pendingCreate.current = { fingerprint, context: createMutationRequestContext() }
    }
    const attempt = pendingCreate.current
    /** Drops this creation's context, but not one that a different creation started meanwhile. */
    const clearAttempt = () => {
      if (pendingCreate.current === attempt) pendingCreate.current = undefined
    }
    let created
    try {
      created = await createProjectStatusShare(accessToken, teamId, projectId, request, attempt.context)
    } catch (error) {
      if (error instanceof ProjectDirectoryApiError && error.status < 500) clearAttempt()
      throw error
    }
    clearAttempt()
    await mutate(projectStatusSharesKey(accessToken, teamId, projectId))
    return created
  }, [accessToken, mutate, projectId, teamId])
  const revoke = useCallback(async (shareId: string) => {
    if (!accessToken || !teamId || !projectId) return
    await revokeProjectStatusShare(accessToken, teamId, projectId, shareId, createMutationRequestContext())
    await mutate(projectStatusSharesKey(accessToken, teamId, projectId))
  }, [accessToken, mutate, projectId, teamId])
  return { create, revoke }
}
