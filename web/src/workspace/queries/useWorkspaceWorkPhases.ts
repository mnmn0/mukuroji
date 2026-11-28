import useSWR from 'swr'
import type { WorkspaceWorkPhaseSettings } from '@mukuroji/contracts'
import { getWorkspaceWorkPhases } from '../api/tenantAdministration'

/** First element of every Workspace work phase cache key. */
const workspaceWorkPhasesKeyPrefix = 'workspace-work-phases'

const workspaceWorkPhasesQueryConfig = {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Matches the cache keys of {@link useWorkspaceWorkPhases}, so a settings change can update every
 * reader regardless of the access token in the key.
 *
 * @param key - SWR cache key.
 * @returns Whether the key belongs to the Workspace work phase query.
 */
export function isWorkspaceWorkPhasesKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === workspaceWorkPhasesKeyPrefix
}

/** State of the Workspace work phase read. */
export type WorkspaceWorkPhasesQuery = {
  /** Phases from the server; undefined until the read succeeds. */
  settings: WorkspaceWorkPhaseSettings | undefined
  /** Failure of the latest read, if any. */
  error: unknown
}

/**
 * Loads the Workspace work phases (ADR 0115) for any member.
 *
 * @param accessToken - Bearer token used for the read.
 * @param enabled - Whether the query may run.
 * @returns The phases once loaded and the latest error.
 */
export function useWorkspaceWorkPhases(accessToken?: string, enabled = true): WorkspaceWorkPhasesQuery {
  const key = accessToken && enabled ? [workspaceWorkPhasesKeyPrefix, accessToken] as const : null
  const query = useSWR(key, ([, token]) => getWorkspaceWorkPhases(token), workspaceWorkPhasesQueryConfig)
  return { settings: query.data, error: query.error }
}
