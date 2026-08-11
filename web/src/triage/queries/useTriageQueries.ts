import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import {
  getTriageEntries,
  getTriageEntry,
  getTriageSettings,
  type TriageEntryPage,
  type TriageQueueFilters,
} from '../api'

const triageQueryConfig = {
  dedupingInterval: 5_000,
  shouldRetryOnError: false,
} as const

const triageQueueQueryConfig = {
  ...triageQueryConfig,
  refreshInterval: 60_000,
} as const

/**
 * Loads a filtered Team triage queue with opaque cursor pagination.
 *
 * @param accessToken - Access token used by the triage API.
 * @param teamId - Team whose queue should be loaded.
 * @param filters - URL-backed queue filters.
 * @param enabled - Whether the authenticated query may run.
 * @param currentUserKey - Canonical owner key used by the Mine filter.
 * @returns SWR Infinite state for the filtered queue.
 */
export function useTriageQueue(
  accessToken: string | undefined,
  teamId: string | undefined,
  filters: TriageQueueFilters,
  enabled = true,
  currentUserKey?: string,
) {
  return useSWRInfinite(
    (pageIndex, previousPage: TriageEntryPage | null) => {
      if (!accessToken || !teamId || !enabled) return null
      if (filters.owner === 'mine' && !currentUserKey) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null

      return [
        'triage-entries',
        accessToken,
        teamId,
        filters.query ?? '',
        filters.state ?? '',
        filters.source ?? '',
        filters.owner ?? 'all',
        currentUserKey ?? '',
        filters.sla ?? '',
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, currentTeamId, , state, source, owner, ownerKey, , cursor]) =>
      getTriageEntries(currentTeamId, token, {
        cursor: cursor || undefined,
        limit: 50,
        query: filters.query,
        sla: filters.sla,
        ownerUserId: owner === 'mine'
          ? ownerKey || undefined
          : owner === 'unowned' ? 'unowned' : undefined,
        sourceKind: source === 'form' || source === 'chat' || source === 'email' || source === 'webhook' || source === 'manual-handoff'
          ? source
          : undefined,
        state: state === 'pending' || state === 'accepted' || state === 'duplicate' || state === 'declined' || state === 'snoozed' || state === 'needs-information'
          ? state
          : undefined,
      }),
    triageQueueQueryConfig,
  )
}

/**
 * Loads one selected triage entry for the detail pane.
 *
 * @param accessToken - Access token used by the triage API.
 * @param teamId - Team whose queue owns the entry.
 * @param entryId - Stable selected entry ID.
 * @param enabled - Whether the authenticated query may run.
 * @returns SWR state for the selected detail.
 */
export function useTriageEntry(
  accessToken: string | undefined,
  teamId: string | undefined,
  entryId: string | undefined,
  enabled = true,
) {
  const key = accessToken && teamId && entryId && enabled
    ? ['triage-entry', accessToken, teamId, entryId] as const
    : null
  const query = useSWR(
    key,
    ([, token, currentTeamId, currentEntryId]) =>
      getTriageEntry(currentTeamId, currentEntryId, token),
    triageQueryConfig,
  )

  return { ...query, key }
}

/**
 * Loads Team triage routing, rotation, SLA, and escalation settings.
 *
 * @param accessToken - Access token used by the triage API.
 * @param teamId - Team whose settings should be loaded.
 * @param enabled - Whether the authenticated settings query may run.
 * @returns SWR state for Team triage settings.
 */
export function useTriageSettings(
  accessToken: string | undefined,
  teamId: string | undefined,
  enabled = true,
) {
  const key = accessToken && teamId && enabled
    ? ['triage-settings', accessToken, teamId] as const
    : null
  const query = useSWR(
    key,
    ([, token, currentTeamId]) => getTriageSettings(currentTeamId, token),
    triageQueryConfig,
  )

  return { ...query, key }
}
