import useSWR from 'swr'
import { getPersonalAgentConnection } from '../api/apiKeys'

/**
 * Loads the current member's agent connection details and personal keys.
 *
 * @param accessToken - Access token of the signed-in member.
 * @returns SWR state for the personal agent connection overview.
 */
export function usePersonalAgentConnection(accessToken: string | undefined) {
  return useSWR(
    accessToken ? ['personal-agent-connection', accessToken] as const : null,
    ([, token]) => getPersonalAgentConnection(token),
    { shouldRetryOnError: false },
  )
}
