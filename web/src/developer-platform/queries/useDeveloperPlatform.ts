import type { CursorPage, ImportJob, WorkItemSyncConflict } from '@mukuroji/contracts'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { getPersonalCredentialAdministration } from '../api/apiKeys'
import { listAvailableDeveloperConnectorProviders } from '../api/connectors'
import { getDeveloperPlatformResources } from '../api/overview'
import { listDeveloperSyncConflicts } from '../api/syncConflicts'
import { getDeveloperImportProgress } from '../api/transfers'

const developerPlatformQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Developer Platform resources とcapabilitiesを取得します。
 *
 * @param accessToken - Developer Platform API の access token です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Developer Platform overview の SWR state と共有keyです。
 */
export function useDeveloperPlatformResources(
  accessToken: string | undefined,
  enabled = true,
) {
  const key = accessToken && enabled
    ? ['developer-platform', accessToken] as const
    : null
  const query = useSWR(
    key,
    ([, token]) => getDeveloperPlatformResources(token),
    developerPlatformQueryConfig,
  )

  return {
    ...query,
    key,
  }
}

/**
 * Fetches, for administrators, the member self-issuance policy and the IDs of issued personal API keys.
 *
 * @param accessToken - Access token for the Developer Platform API.
 * @param enabled - Whether to run the query.
 * @returns SWR state holding the policy and the personal API key IDs.
 */
export function usePersonalCredentialAdministration(
  accessToken: string | undefined,
  enabled = true,
) {
  return useSWR(
    accessToken && enabled
      ? ['developer-personal-credentials', accessToken] as const
      : null,
    ([, token]) => getPersonalCredentialAdministration(token),
    developerPlatformQueryConfig,
  )
}

/**
 * Fetches the connector providers configured in this environment.
 *
 * @param accessToken - Access token for the Developer Platform API.
 * @param enabled - Whether to run the query; it needs the integration management capability.
 * @returns SWR state holding the configured provider identifiers.
 */
export function useAvailableDeveloperConnectorProviders(
  accessToken: string | undefined,
  enabled = true,
) {
  return useSWR(
    accessToken && enabled
      ? ['developer-connector-providers', accessToken] as const
      : null,
    ([, token]) => listAvailableDeveloperConnectorProviders(token),
    developerPlatformQueryConfig,
  )
}

/**
 * Developer connector sync conflictsをcursor paginationで取得します。
 *
 * @param accessToken - Developer Platform API の access token です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Sync conflict page の SWR Infinite state です。
 */
export function useDeveloperSyncConflicts(
  accessToken: string | undefined,
  enabled = true,
) {
  return useSWRInfinite(
    (
      pageIndex,
      previousPage: CursorPage<WorkItemSyncConflict> | null,
    ) => {
      if (!accessToken || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'developer-sync-conflicts',
        accessToken,
        previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, cursor]) => listDeveloperSyncConflicts(token, {
      ...(cursor ? { cursor } : {}),
      limit: 50,
    }),
    developerPlatformQueryConfig,
  )
}

/** How often the progress of a running import is read again. */
const importProgressRefreshMilliseconds = 3_000

/**
 * Reads the progress of an import job while it is queued or running.
 *
 * @param accessToken - Access token for the Developer Platform API.
 * @param job - Latest import job, if any.
 * @returns SWR state holding the job's progress.
 */
export function useDeveloperImportProgress(
  accessToken: string | undefined,
  job: ImportJob | undefined,
) {
  const running = job !== undefined && !job.dryRun && isRunningImportStatus(job.status)
  const key = accessToken && job && !job.dryRun
    ? ['developer-import-progress', accessToken, job.id] as const
    : null
  return useSWR(
    key,
    ([, token, jobId]) => getDeveloperImportProgress(token, jobId),
    {
      shouldRetryOnError: false,
      // Polls until the job ends; a finished job is read once for its final counts.
      refreshInterval: (latest) =>
        running && (latest === undefined || isRunningImportStatus(latest.status))
          ? importProgressRefreshMilliseconds
          : 0,
    },
  )
}

/**
 * Reports whether an import job still has rows or links to process.
 *
 * @param status - Import job status.
 * @returns Whether the job is queued, validating, or running.
 */
export function isRunningImportStatus(status: ImportJob['status']) {
  return status === 'queued' || status === 'validating' || status === 'running'
}
