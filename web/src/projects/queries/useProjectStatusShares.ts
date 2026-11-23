import type { CreateProjectStatusShareRequest } from '@mukuroji/contracts'
import { useCallback } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { getCustomer, getCustomers } from '../../customers/api'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import {
  createProjectStatusShare,
  listProjectStatusShares,
  revokeProjectStatusShare,
} from '../api/statusReports'

/**
 * Builds the SWR key of a Project's share links.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The scope-bound cache key.
 */
function projectStatusSharesKey(accessToken: string, teamId: string, projectId: string) {
  return ['project-status-shares', accessToken, teamId, projectId] as const
}

/**
 * Reads a Project's share links and returns the actions that create and revoke them.
 *
 * @param accessToken - Session access token; nothing is read without it.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @param enabled - Whether the list should be read, such as while the dialog is open.
 * @returns SWR state of the list, and the create and revoke actions, which reload it.
 */
export function useProjectStatusShares(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string | undefined,
  enabled: boolean,
) {
  const { mutate } = useSWRConfig()
  const key = accessToken && teamId && projectId && enabled
    ? projectStatusSharesKey(accessToken, teamId, projectId)
    : null
  const list = useSWR(
    key,
    ([, token, currentTeamId, currentProjectId]) => listProjectStatusShares(token, currentTeamId, currentProjectId),
    { shouldRetryOnError: false },
  )
  const create = useCallback(async (request: CreateProjectStatusShareRequest) => {
    if (!accessToken || !teamId || !projectId) throw new Error('The session is not ready.')
    const created = await createProjectStatusShare(accessToken, teamId, projectId, request, createMutationRequestContext())
    await mutate(projectStatusSharesKey(accessToken, teamId, projectId))
    return created
  }, [accessToken, mutate, projectId, teamId])
  const revoke = useCallback(async (shareId: string) => {
    if (!accessToken || !teamId || !projectId) return
    await revokeProjectStatusShare(accessToken, teamId, projectId, shareId, createMutationRequestContext())
    await mutate(projectStatusSharesKey(accessToken, teamId, projectId))
  }, [accessToken, mutate, projectId, teamId])
  return { list, create, revoke }
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
