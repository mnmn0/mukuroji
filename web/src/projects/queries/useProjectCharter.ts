import { useMemo } from 'react'
import useSWR from 'swr'
import { getProjectCharter } from '../api/charter'

/** Inputs accepted by the Project charter query. */
export type UseProjectCharterOptions = {
  /** Cognito access token. */
  accessToken?: string
  /** Team that owns the Project; the query waits while it is unknown. */
  teamId?: string
  /** Project identifier. */
  projectId: string
  /** Whether the current authentication state permits the request. */
  enabled: boolean
  /** Receives each failed load, so an expired session can be sent to sign in again. */
  onError?: (error: unknown) => void
}

/**
 * Loads and caches the charter and lifecycle state of one Team-owned Project.
 *
 * @param options - Authentication state and Project identity.
 * @returns SWR state and its active key.
 */
export function useProjectCharter({
  accessToken,
  teamId,
  projectId,
  enabled,
  onError,
}: UseProjectCharterOptions) {
  const key: readonly ['project-charter', string, string, string] | null = useMemo(
    () => accessToken && teamId && enabled ? ['project-charter', accessToken, teamId, projectId] : null,
    [accessToken, enabled, projectId, teamId],
  )
  const query = useSWR(
    key,
    ([, token, currentTeamId, currentProjectId]) =>
      getProjectCharter(token, currentTeamId, currentProjectId),
    {
      dedupingInterval: 5_000,
      shouldRetryOnError: false,
      onError: (error: unknown) => onError?.(error),
    },
  )

  return { ...query, key }
}
