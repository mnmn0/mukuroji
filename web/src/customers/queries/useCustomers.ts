import useSWR from 'swr'
import type { CustomerListInput } from '@mukuroji/contracts'
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

/** Loads the Customer directory with SWR-owned URL filter state. */
export function useCustomers(
  accessToken: string | undefined,
  input: CustomerListInput,
  enabled: boolean,
) {
  const key = accessToken && enabled
    ? ['customers', accessToken, input] as const
    : null
  const query = useSWR(
    key,
    ([, token, queryInput]) => getCustomers(token, queryInput),
    customerQueryConfig,
  )
  return { ...query, key }
}

/** Loads saved Customer directory views when the Workspace directory is available. */
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

/** Loads one Customer detail graph when a Customer route parameter is selected. */
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

/** Loads the Project-level Customer impact aggregate for a Project detail route. */
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
