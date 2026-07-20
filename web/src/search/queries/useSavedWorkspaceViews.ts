import useSWR from 'swr'
import { getSavedWorkspaceViews } from '../api/savedViews'

const savedWorkspaceViewsQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Current user の保存済み Workspace view を取得します。
 *
 * @param accessToken - Search API の access token です。
 * @param enabled - Current user の確認後に取得を有効にするかどうかです。
 * @returns Saved Workspace view 一覧の SWR state です。
 */
export function useSavedWorkspaceViews(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['saved-workspace-views', accessToken] as const
    : null

  return useSWR(
    key,
    ([, token]) => getSavedWorkspaceViews(token),
    savedWorkspaceViewsQueryConfig,
  )
}
