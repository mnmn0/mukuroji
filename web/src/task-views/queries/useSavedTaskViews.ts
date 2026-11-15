import type { TaskViewScope, TaskViewSurface } from '@mukuroji/contracts'
import useSWR from 'swr'
import { getSavedTaskViews } from '../api/savedTaskViews'

const savedTaskViewsQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
}

/**
 * Loads saved task views for one surface and route scope.
 *
 * @param accessToken - Bearer token used by the task-view API.
 * @param surface - Product surface consuming the definitions.
 * @param scope - Route and permission boundary for eligible definitions.
 * @param enabled - Whether authenticated loading is enabled.
 * @param keepPreviousData - Whether the previous scope's collection stays visible while the
 *   next scope loads.
 * @returns SWR state for the permission-filtered saved task-view collection.
 */
export function useSavedTaskViews(
  accessToken: string | undefined,
  surface: TaskViewSurface,
  scope: TaskViewScope,
  enabled = true,
  keepPreviousData = false,
) {
  const scopeKey = JSON.stringify(scope)
  const key = accessToken && enabled
    ? ['saved-task-views', accessToken, surface, scopeKey]
    : null

  return useSWR(
    key,
    ([, token]) => getSavedTaskViews(token, { scope, surface }),
    keepPreviousData ? { ...savedTaskViewsQueryConfig, keepPreviousData } : savedTaskViewsQueryConfig,
  )
}
