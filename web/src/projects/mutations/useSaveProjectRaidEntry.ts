import type { ProjectRaidEntry, ProjectRaidEntryInput } from '@mukuroji/contracts'
import { useCallback, useRef } from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from '../api/errors'
import { createProjectRaidEntry, updateProjectRaidEntry } from '../api/raidLog'
import { projectRaidLogKey } from '../queries/useProjectRaidLog'

/** Session and Project a save applies to. */
export type ProjectRaidEntrySaveScope = {
  /** Cognito access token; saving does nothing without it. */
  accessToken?: string
  /** Team that owns the Project; saving does nothing without it. */
  teamId?: string
  /** Project identifier. */
  projectId: string
}

/**
 * Returns a function that adds or changes one Project log entry and reloads the log.
 *
 * A failed save keeps its request context, so saving the same input again reuses its
 * Idempotency-Key and the server returns the result of an attempt whose response was lost. Each
 * different input keeps its own context, so saving something else in between does not lose it.
 * A context is dropped once the server answers, with success or a client error. A caller whose
 * distinct operations may send the same input, such as promoting two risks with the same text,
 * passes an `operationKey` so each keeps its own Idempotency-Key. A conflict also
 * reloads the log, so the form can move onto the latest revision.
 *
 * @param scope - Session, Team, and Project.
 * @returns The save function, which rethrows the API error of a failed save.
 */
export function useSaveProjectRaidEntry({ accessToken, teamId, projectId }: ProjectRaidEntrySaveScope) {
  const { mutate } = useSWRConfig()
  const pendingSaves = useRef(new Map<string, MutationRequestContext>())
  return useCallback(async (
    entry: ProjectRaidEntry | undefined,
    input: ProjectRaidEntryInput,
    operationKey?: string,
  ) => {
    if (!accessToken || !teamId) return
    const key = projectRaidLogKey(accessToken, teamId, projectId)
    const fingerprint = JSON.stringify([
      teamId,
      projectId,
      entry?.id ?? null,
      entry?.revision ?? null,
      operationKey ?? null,
      input,
    ])
    const context = pendingSaves.current.get(fingerprint) ?? createMutationRequestContext()
    pendingSaves.current.set(fingerprint, context)
    /** Drops this save's context, but not one that a later save of the same input started. */
    const clearAttempt = () => {
      if (pendingSaves.current.get(fingerprint) === context) pendingSaves.current.delete(fingerprint)
    }
    try {
      if (entry) {
        await updateProjectRaidEntry(accessToken, teamId, projectId, entry.id, entry.revision, input, context)
      } else {
        await createProjectRaidEntry(accessToken, teamId, projectId, input, context)
      }
    } catch (error) {
      if (error instanceof ProjectDirectoryApiError && error.status < 500) {
        clearAttempt()
        if (error.status === 409) void mutate(key)
      }
      throw error
    }
    clearAttempt()
    await mutate(key)
  }, [accessToken, mutate, projectId, teamId])
}
