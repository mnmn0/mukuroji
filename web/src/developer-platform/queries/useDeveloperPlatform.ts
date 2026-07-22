import type { CursorPage, WorkItemSyncConflict } from '@mukuroji/contracts'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { getDeveloperPlatformResources } from '../api/overview'
import { listDeveloperSyncConflicts } from '../api/syncConflicts'

const developerPlatformQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Developer Platform resources とcapabilitiesを取得します。
 *
 * @param accessToken - Developer Platform API の access token です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Developer Platform overview の SWR state と共有keyです。
 */
export function useDeveloperPlatformResources(
  accessToken: string | undefined,
  enabled = true,
) {
  const key = accessToken && enabled
    ? ['developer-platform', accessToken] as const
    : null
  const query = useSWR(
    key,
    ([, token]) => getDeveloperPlatformResources(token),
    developerPlatformQueryConfig,
  )

  return {
    ...query,
    key,
  }
}

/**
 * Developer connector sync conflictsをcursor paginationで取得します。
 *
 * @param accessToken - Developer Platform API の access token です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Sync conflict page の SWR Infinite state です。
 */
export function useDeveloperSyncConflicts(
  accessToken: string | undefined,
  enabled = true,
) {
  return useSWRInfinite(
    (
      pageIndex,
      previousPage: CursorPage<WorkItemSyncConflict> | null,
    ) => {
      if (!accessToken || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'developer-sync-conflicts',
        accessToken,
        previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, cursor]) => listDeveloperSyncConflicts(token, {
      ...(cursor ? { cursor } : {}),
      limit: 50,
    }),
    developerPlatformQueryConfig,
  )
}
