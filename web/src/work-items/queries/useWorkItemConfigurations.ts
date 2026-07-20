import useSWR from 'swr'
import {
  getWorkItemConfiguration,
  type WorkItemConfigurationScope,
} from '../api/configuration'
import { loadTeamWorkItemConfigurations } from './teamWorkItemConfigurations'

const workItemConfigurationQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Team の Work Item configuration を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param teamId - 取得対象の Team ID です。
 * @param enabled - Query を実行するかどうかです。
 * @returns 解決済み Work Item configuration の SWR state です。
 */
export function useWorkItemConfiguration(
  accessToken: string | undefined,
  teamId: string | undefined,
  enabled = true,
) {
  const key = accessToken && teamId && enabled
    ? ['work-item-configuration', accessToken, teamId] as const
    : null

  const query = useSWR(
    key,
    ([, token, currentTeamId]) => getWorkItemConfiguration(token, {
      kind: 'team',
      teamId: currentTeamId,
    }),
    workItemConfigurationQueryConfig,
  )

  return { ...query, key }
}

/**
 * 複数 Team の Work Item configuration をまとめて取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param scope - SWR key を分離する利用画面のscopeです。
 * @param teamIds - 取得対象の Team ID 一覧です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Team ID ごとの configuration 集約結果です。
 */
export function useTeamWorkItemConfigurations(
  accessToken: string | undefined,
  scope: string,
  teamIds: readonly string[],
  enabled = true,
) {
  const key = accessToken && enabled && teamIds.length > 0
    ? [`${scope}-work-item-configurations`, accessToken, teamIds.join('\0')] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => loadTeamWorkItemConfigurations(token, teamIds),
    workItemConfigurationQueryConfig,
  )

  return { ...query, key }
}

/**
 * WorkspaceまたはTeam scopeのWork Item configurationを取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param scope - WorkspaceまたはTeamの取得scopeです。
 * @param enabled - Query を実行するかどうかです。
 * @returns 解決済み Work Item configuration の SWR state です。
 */
export function useScopedWorkItemConfiguration(
  accessToken: string | undefined,
  scope: WorkItemConfigurationScope,
  enabled = true,
) {
  const scopeId = scope.kind === 'team' ? scope.teamId : ''
  const key = accessToken && enabled
    ? ['work-item-configuration-settings', accessToken, scope.kind, scopeId] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => getWorkItemConfiguration(token, scope),
    workItemConfigurationQueryConfig,
  )

  return { ...query, key }
}
