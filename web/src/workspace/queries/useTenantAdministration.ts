import useSWR from 'swr'
import { getTenantAdministration } from '../api/tenantAdministration'

const tenantAdministrationQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Loads the tenant administration aggregate for an authenticated administrator.
 *
 * @param accessToken - Bearer token used for the tenant administration API.
 * @param enabled - Whether the query may run.
 * @returns Tenant administration SWR state.
 */
export function useTenantAdministration(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['tenant-administration', accessToken] as const
    : null
  const query = useSWR(
    key,
    ([, token]) => getTenantAdministration(token),
    tenantAdministrationQueryConfig,
  )
  return { ...query, key }
}
