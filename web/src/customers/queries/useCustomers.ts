import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import type { CustomerListInput, CustomerPage } from '@mukuroji/contracts'
import { useEffect } from 'react'
import {
  getCustomer,
  getCustomerSavedViews,
  getCustomers,
  getProjectCustomerImpact,
} from '../api'

const customerQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/** Loads the Customer directory with SWR-owned URL filter state.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param input URL-backed Customer filters.
 * @param enabled Whether the directory query is allowed to run.
 * @returns SWR state for the accumulated Customer pages.
 */
export function useCustomers(
  accessToken: string | undefined,
  input: CustomerListInput,
  enabled: boolean,
) {
  const query = useSWRInfinite(
    (pageIndex, previousPage: CustomerPage | null) => {
      if (!accessToken || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'customers',
        accessToken,
        input,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, queryInput, cursor]) => getCustomers(token, {
      ...queryInput,
      cursor: cursor || undefined,
      limit: queryInput.limit ?? 100,
    }),
    customerQueryConfig,
  )
  const { data: pageData, isValidating, setSize, size } = query
  useEffect(() => {
    if (!enabled || !pageData || isValidating) return
    if (!pageData.at(-1)?.nextCursor) return
    void setSize(size + 1)
  }, [enabled, isValidating, pageData, setSize, size])
  const pages = pageData ?? []
  const customers = pages.flatMap((page) => page.customers)
  const nextCursor = pages.at(-1)?.nextCursor
  return {
    ...query,
    data: pageData
      ? { customers, ...(nextCursor ? { nextCursor } : {}) }
      : undefined,
    isLoadingMore: Boolean(query.data && query.data.length < query.size && query.isValidating),
    key: accessToken && enabled ? ['customers', accessToken, input] as const : null,
  }
}

/** Loads saved Customer directory views when the Workspace directory is available.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param enabled Whether the saved-view query is allowed to run.
 * @returns SWR state for the saved-view collection.
 */
export function useCustomerSavedViews(
  accessToken: string | undefined,
  enabled: boolean,
) {
  const key = accessToken && enabled ? ['customer-saved-views', accessToken] as const : null
  const query = useSWR(
    key,
    ([, token]) => getCustomerSavedViews(token),
    customerQueryConfig,
  )
  return { ...query, key }
}

/** Loads one Customer detail graph when a Customer route parameter is selected.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param customerId Selected Customer identifier, when present.
 * @param enabled Whether the detail query is allowed to run.
 * @returns SWR state for the selected Customer detail.
 */
export function useCustomer(
  accessToken: string | undefined,
  customerId: string | undefined,
  enabled: boolean,
) {
  const key = accessToken && customerId && enabled
    ? ['customer', accessToken, customerId] as const
    : null
  const query = useSWR(
    key,
    ([, token, id]) => getCustomer(token, id),
    customerQueryConfig,
  )
  return { ...query, key }
}

/** Loads the Project-level Customer impact aggregate for a Project detail route.
 *
 * @param accessToken Bearer token for the authenticated Workspace.
 * @param projectId Selected Project identifier, when present.
 * @param enabled Whether the impact query is allowed to run.
 * @returns SWR state for the Project Customer impact signal.
 */
export function useProjectCustomerImpact(
  accessToken: string | undefined,
  projectId: string | undefined,
  enabled: boolean,
) {
  const key = accessToken && projectId && enabled
    ? ['project-customer-impact', accessToken, projectId] as const
    : null
  const query = useSWR(
    key,
    ([, token, id]) => getProjectCustomerImpact(token, id),
    customerQueryConfig,
  )
  return { ...query, key }
}
