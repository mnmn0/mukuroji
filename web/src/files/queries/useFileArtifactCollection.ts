import useSWR from 'swr'
import {
  getProjectFiles,
  getWorkItemFiles,
} from '../api/collections'

const scanRefreshInterval = 3_000

/**
 * Work ItemまたはProjectに属するfile collectionを取得します。
 *
 * @param accessToken - Files API の access token です。
 * @param scope - Work ItemまたはProjectのresource scopeです。
 * @param enabled - Query を実行するかどうかです。
 * @returns File collection の SWR state です。
 */
export function useFileArtifactCollection(
  accessToken: string | undefined,
  scope:
    | { kind: 'work-item'; teamId: string; issueId: string }
    | { kind: 'project'; teamId: string; projectId: string }
    | undefined,
  enabled = true,
) {
  const scopeKey = scope ? JSON.stringify(scope) : ''
  const key = accessToken && scope && enabled
    ? ['file-artifacts', accessToken, scopeKey] as const
    : null

  return useSWR(
    key,
    () => {
      if (!accessToken || !scope) {
        throw new Error('File artifact scope is not configured.')
      }

      return scope.kind === 'work-item'
        ? getWorkItemFiles(scope.teamId, scope.issueId, accessToken)
        : getProjectFiles(scope.teamId, scope.projectId, accessToken)
    },
    {
      dedupingInterval: 1_000,
      refreshInterval: (latestData) => latestData?.files.some((file) =>
        file.currentVersion.scanStatus === 'pending' ||
        file.currentVersion.scanStatus === 'scanning'
      ) ? scanRefreshInterval : 0,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      shouldRetryOnError: false,
    },
  )
}
