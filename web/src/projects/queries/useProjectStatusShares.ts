import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import type { CustomerPage } from '@mukuroji/contracts'
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

/** Customers read per page of share recipients. */
const CUSTOMER_PAGE_SIZE = 100

/**
 * Reads the customers a share link can be sent to, a page at a time, and the contacts of the
 * chosen one.
 *
 * A caller without customer read access gets an error, and the form then offers no customer.
 * Customers come in pages of {@link CUSTOMER_PAGE_SIZE} sorted by name; `loadMore` reads the next
 * page, so every customer can be chosen even by a member who may not search by name.
 *
 * @param accessToken - Session access token; nothing is read without it.
 * @param enabled - Whether the customers should be read.
 * @param customerId - Chosen customer whose contacts are read.
 * @param customerSearch - Text the customer names are filtered by; empty lists every customer.
 * @param onCustomerError - Called with a failed customer read, such as a search the caller may not run.
 * @returns The customers read so far, paging and retry controls, and the chosen customer's detail.
 */
export function useProjectStatusShareRecipients(
  accessToken: string | undefined,
  enabled: boolean,
  customerId: string | undefined,
  customerSearch = '',
  onCustomerError?: (error: unknown) => void,
) {
  const search = customerSearch.trim()
  const pages = useSWRInfinite(
    (index: number, previous: CustomerPage | null) => {
      if (!accessToken || !enabled) return null
      if (index > 0 && !previous?.nextCursor) return null
      return ['project-status-share-customers', accessToken, search, index > 0 ? previous?.nextCursor ?? '' : ''] as const
    },
    ([, token, text, cursor]: readonly [string, string, string, string]) => getCustomers(token, {
      limit: CUSTOMER_PAGE_SIZE,
      sortBy: 'name',
      sortDirection: 'ascending',
      ...(text ? { search: text } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    { shouldRetryOnError: false, keepPreviousData: true, revalidateFirstPage: false, onError: onCustomerError },
  )
  const customer = useSWR(
    accessToken && enabled && customerId ? ['project-status-share-customer', accessToken, customerId] as const : null,
    ([, token, id]) => getCustomer(token, id),
    { shouldRetryOnError: false },
  )
  const lastPage = pages.data?.at(-1)
  return {
    customers: {
      items: pages.data?.flatMap((page) => page.customers) ?? [],
      hasMore: Boolean(lastPage?.nextCursor),
      loadMore: () => pages.setSize((size) => size + 1),
      error: pages.error,
      isValidating: pages.isValidating,
      mutate: pages.mutate,
    },
    customer,
  }
}
