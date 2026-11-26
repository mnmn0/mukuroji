import useSWR from 'swr'
import { getWorkspaceAgentDefaults } from '../api/agentSettings'

/** SWR options for the Workspace agent defaults; failures stay visible with a retry action. */
const workspaceAgentDefaultsQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Reads the Workspace agent defaults.
 *
 * @param accessToken - Session access token of a Workspace administrator; reading is skipped without it.
 * @returns SWR state of the defaults.
 */
export function useWorkspaceAgentDefaults(accessToken: string | undefined) {
  return useSWR(
    accessToken ? ['workspace-agent-defaults', accessToken] as const : null,
    ([, token]) => getWorkspaceAgentDefaults(token),
    workspaceAgentDefaultsQueryConfig,
  )
}
