import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { getWorkItemConfiguration } from '../api/configuration'

/**
 * 複数 Team の Work Item configuration をまとめて取得します。
 *
 * @param accessToken - Work Item configuration API の access token です。
 * @param teamIds - 取得対象の Team ID 一覧です。
 * @returns Team ID ごとの configuration、失敗した Team ID、取得 error です。
 */
export async function loadTeamWorkItemConfigurations(
  accessToken: string,
  teamIds: readonly string[],
) {
  const results = await Promise.allSettled(
    teamIds.map(async (teamId) => ({
      configuration: await getWorkItemConfiguration(accessToken, { kind: 'team', teamId }),
      teamId,
    })),
  )

  return {
    configurationsByTeam: Object.fromEntries(results.flatMap((result) =>
      result.status === 'fulfilled'
        ? [[result.value.teamId, result.value.configuration]]
        : [],
    )) as Record<string, ResolvedWorkItemConfiguration>,
    errors: results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    ),
    failedTeamIds: results.flatMap((result, index) =>
      result.status === 'rejected' ? [teamIds[index] ?? ''] : [],
    ).filter(Boolean),
  }
}
