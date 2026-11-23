import useSWR from 'swr'
import { getCustomer, getCustomers } from '../../customers/api'
import { listProjectStatusShares } from '../api/statusReports'

/**
 * Builds the SWR key of a Project's share links.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The scope-bound cache key.
 */
export function projectStatusSharesKey(accessToken: string, teamId: string, projectId: string) {
  return ['project-status-shares', accessToken, teamId, projectId] as const
}

/**
 * Reads a Project's share links.
 *
 * @param accessToken - Session access token; nothing is read without it.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @param enabled - Whether the list should be read, such as while the dialog is open.
 * @returns SWR state of the list.
 */
export function useProjectStatusShares(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string | undefined,
  enabled: boolean,
) {
  return useSWR(
    accessToken && teamId && projectId && enabled ? projectStatusSharesKey(accessToken, teamId, projectId) : null,
    ([, token, currentTeamId, currentProjectId]) => listProjectStatusShares(token, currentTeamId, currentProjectId),
    { shouldRetryOnError: false },
  )
}

/** Most customers offered as share recipients. */
const CUSTOMER_OPTION_LIMIT = 100

/**
 * Reads the customers a share link can be sent to, and the contacts of the chosen one.
 *
 * A caller without customer read access gets an error, and the form then offers no customer.
 *
 * @param accessToken - Session access token; nothing is read without it.
 * @param enabled - Whether the customers should be read.
 * @param customerId - Chosen customer whose contacts are read.
 * @returns SWR states of the customers and of the chosen customer's detail.
 */
export function useProjectStatusShareRecipients(
  accessToken: string | undefined,
  enabled: boolean,
  customerId: string | undefined,
) {
  const customers = useSWR(
    accessToken && enabled ? ['project-status-share-customers', accessToken] as const : null,
    ([, token]) => getCustomers(token, { limit: CUSTOMER_OPTION_LIMIT, sortBy: 'name', sortDirection: 'ascending' }),
    { shouldRetryOnError: false },
  )
  const customer = useSWR(
    accessToken && enabled && customerId ? ['project-status-share-customer', accessToken, customerId] as const : null,
    ([, token, id]) => getCustomer(token, id),
    { shouldRetryOnError: false },
  )
  return { customers, customer }
}
