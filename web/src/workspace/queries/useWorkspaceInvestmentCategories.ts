import useSWR from 'swr'
import type { WorkspaceInvestmentCategorySettings } from '@mukuroji/contracts'
import { getWorkspaceInvestmentCategories } from '../api/tenantAdministration'

/** First element of every Workspace investment category cache key. */
const workspaceInvestmentCategoriesKeyPrefix = 'workspace-investment-categories'

const workspaceInvestmentCategoriesQueryConfig = {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Matches the cache keys of {@link useWorkspaceInvestmentCategories}, so a settings change can update every
 * reader regardless of the access token in the key.
 *
 * @param key - SWR cache key.
 * @returns Whether the key belongs to the Workspace investment category query.
 */
export function isWorkspaceInvestmentCategoriesKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === workspaceInvestmentCategoriesKeyPrefix
}

/** State of the Workspace investment category read. */
export type WorkspaceInvestmentCategoriesQuery = {
  /** Categories from the server; undefined until the read succeeds. */
  settings: WorkspaceInvestmentCategorySettings | undefined
  /** Failure of the latest read, if any. */
  error: unknown
  /** Reads the categories again. */
  retry: () => void
}

/**
 * Loads the Workspace investment categories (ADR 0116) for any member.
 *
 * @param accessToken - Bearer token used for the read.
 * @param enabled - Whether the query may run.
 * @returns The categories once loaded and the latest error.
 */
export function useWorkspaceInvestmentCategories(accessToken?: string, enabled = true): WorkspaceInvestmentCategoriesQuery {
  const key = accessToken && enabled ? [workspaceInvestmentCategoriesKeyPrefix, accessToken] as const : null
  const query = useSWR(key, ([, token]) => getWorkspaceInvestmentCategories(token), workspaceInvestmentCategoriesQueryConfig)
  const { mutate } = query
  return { settings: query.data, error: query.error, retry: () => { void mutate().catch(() => undefined) } }
}
