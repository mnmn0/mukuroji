import useSWR from 'swr'
import type { TenantAdministrationSnapshot } from '@mukuroji/contracts'
import { getTenantAdministration } from '../api/tenantAdministration'

const tenantAdministrationQueryConfig = {
  dedupingInterval: 10_000,
  refreshInterval: tenantAdministrationRefreshInterval,
  shouldRetryOnError: false,
} as const

/**
 * Polls only while a server-owned tenant workflow can make autonomous progress.
 *
 * @param snapshot - Latest tenant administration aggregate.
 * @returns Polling interval in milliseconds, or zero for stable states.
 */
function tenantAdministrationRefreshInterval(
  snapshot?: TenantAdministrationSnapshot,
): number {
  const operationProgressing = snapshot?.activeOperation?.status === 'requested' ||
    snapshot?.activeOperation?.status === 'running'
  const retentionProgressing = snapshot?.retentionReconciliation?.status === 'pending' ||
    snapshot?.retentionReconciliation?.status === 'running'
  return operationProgressing || retentionProgressing ? 3_000 : 0
}

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
