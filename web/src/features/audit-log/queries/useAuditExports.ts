import useSWR from 'swr'
import type { AuditExportView } from '@mukuroji/contracts'
import { listAuditExports } from '../api/auditExports'
import type { AuditLogRequestGuard } from './useAuditEvents'

/** Interval between reads while an export is still being written. */
const auditExportPollingIntervalMs = 5_000

/**
 * Chooses how often to read the export list.
 *
 * @param exports - Latest export list.
 * @returns Polling interval while an export is queued or running, otherwise 0.
 */
function auditExportRefreshInterval(exports?: AuditExportView[]): number {
  return exports?.some((job) => job.status === 'queued' || job.status === 'running')
    ? auditExportPollingIntervalMs
    : 0
}

/**
 * Loads the Workspace's recent audit exports and follows unfinished ones until they settle.
 *
 * Reading the list is not audited, so this may load as soon as the panel opens.
 *
 * @param accessToken - Bearer token; omission disables the query.
 * @param enabled - Whether the member may export audit events.
 * @param guardRequest - Session-policy guard of the Workspace shell.
 * @returns Export list SWR state.
 */
export function useAuditExports(
  accessToken: string | undefined,
  enabled: boolean,
  guardRequest: AuditLogRequestGuard,
) {
  return useSWR(
    accessToken && enabled ? ['audit-exports', accessToken] as const : null,
    ([, token]) => guardRequest(listAuditExports(token)),
    {
      refreshInterval: auditExportRefreshInterval,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}
