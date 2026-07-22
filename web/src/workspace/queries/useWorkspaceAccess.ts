import useSWR from 'swr'
import { getWorkspaceAccess } from '../api/access'

const workspaceAccessQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Workspace member と invitation を含む access snapshot を取得します。
 *
 * @param accessToken - Workspace access API の access token です。
 * @param enabled - Current user の確認後に取得を有効にするかどうかです。
 * @returns Workspace access の SWR state です。
 */
export function useWorkspaceAccess(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['workspace-access', accessToken] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => getWorkspaceAccess(token),
    workspaceAccessQueryConfig,
  )

  return {
    ...query,
    key,
  }
}
