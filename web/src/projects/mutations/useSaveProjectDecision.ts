import type { ProjectDecisionEntry, ProjectDecisionEntryInput } from '@mukuroji/contracts'
import { useCallback, useRef } from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from '../api/errors'
import { createProjectDecision, updateProjectDecision } from '../api/decisionLog'
import { isTeamDecisionLogKey, projectDecisionLogKey } from '../queries/useProjectDecisionLog'

/** Session a save applies to. */
export type ProjectDecisionSaveScope = {
  /** Cognito access token; saving does nothing without it. */
  accessToken?: string
}

/**
 * Returns a function that records or changes one decision and reloads the logs showing it.
 *
 * A failed save keeps its request context, so saving the same input again reuses its
 * Idempotency-Key and the server returns the result of an attempt whose response was lost. A
 * context is dropped once the server answers, with success or a client error. A conflict also
 * reloads the log, so the form can move onto the latest revision.
 *
 * @param scope - Session.
 * @returns The save function, which returns the stored decision and rethrows the API error of a
 * failed save.
 */
export function useSaveProjectDecision({ accessToken }: ProjectDecisionSaveScope) {
  const { mutate } = useSWRConfig()
  const pendingSaves = useRef(new Map<string, MutationRequestContext>())
  return useCallback(async (
    teamId: string | undefined,
    projectId: string,
    entry: ProjectDecisionEntry | undefined,
    input: ProjectDecisionEntryInput,
  ): Promise<ProjectDecisionEntry | undefined> => {
    if (!accessToken || !teamId) return undefined
    const key = projectDecisionLogKey(accessToken, teamId, projectId)
    const fingerprint = JSON.stringify([teamId, projectId, entry?.id ?? null, entry?.revision ?? null, input])
    const context = pendingSaves.current.get(fingerprint) ?? createMutationRequestContext()
    pendingSaves.current.set(fingerprint, context)
    /** Drops this save's context, but not one that a later save of the same input started. */
    const clearAttempt = () => {
      if (pendingSaves.current.get(fingerprint) === context) pendingSaves.current.delete(fingerprint)
    }
    let stored: ProjectDecisionEntry
    try {
      stored = entry
        ? (await updateProjectDecision(accessToken, teamId, projectId, entry.id, entry.revision, input, context)).entry
        : (await createProjectDecision(accessToken, teamId, projectId, input, context)).entry
    } catch (error) {
      if (error instanceof ProjectDirectoryApiError && error.status < 500) {
        clearAttempt()
        if (error.status === 409) void mutate(key)
      }
      throw error
    }
    clearAttempt()
    await Promise.all([
      mutate(key),
      mutate((cacheKey) => isTeamDecisionLogKey(cacheKey, teamId)),
    ])
    return stored
  }, [accessToken, mutate])
}
