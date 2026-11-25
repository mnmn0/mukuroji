import useSWR from 'swr'
import { getAutomationManagementScopes } from '../api'

/**
 * Reads which Automation definition scopes the caller can change (ADR 0087).
 *
 * @param accessToken - Automation API access token.
 * @returns The SWR state of the Workspace flag and the manageable Team identifiers.
 */
export function useAutomationManagementScopes(accessToken: string) {
  return useSWR(
    ['automation-management-scopes', accessToken],
    ([, token]) => getAutomationManagementScopes(token),
  )
}
