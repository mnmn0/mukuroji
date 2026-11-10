import useSWR from 'swr'
import { getTeamAgentSettings } from '../api/agentSettings'

/** SWR options for Agent settings; failures stay visible with a retry action instead of retrying silently. */
const agentSettingsQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Reads the Agent settings of one Team.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team whose settings are read; reading is skipped without it.
 * @returns SWR state of the settings.
 */
export function useTeamAgentSettings(accessToken: string | undefined, teamId: string | undefined) {
  return useSWR(
    accessToken && teamId ? ['team-agent-settings', accessToken, teamId] as const : null,
    ([, token, currentTeamId]) => getTeamAgentSettings(token, currentTeamId),
    agentSettingsQueryConfig,
  )
}
