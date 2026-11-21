import { AnalyticsError } from './analytics'
import {
  toAnalyticsHistoryEvents,
  type AnalyticsHistoryEvent,
  type AnalyticsWorkItemHistoryKey,
  type AnalyticsWorkItemHistoryRow,
} from './analytics-work-item-history'

/**
 * Upper bound of history entries one Analytics read restores from history rows.
 *
 * It keeps the restored events within the API Lambda memory; the audit fallback keeps its own
 * smaller limits.
 */
export const ANALYTICS_HISTORY_ROW_EVENT_LIMIT = 200_000

/** Reads the per-Work-Item history rows that exist. */
export type AnalyticsWorkItemHistoryReader = {
  /** Returns the valid history rows of the given Work Items. */
  getWorkItemHistoryRows(
    workspaceId: string,
    workItems: readonly Pick<AnalyticsWorkItemHistoryKey, 'teamId' | 'workItemId'>[],
  ): Promise<AnalyticsWorkItemHistoryRow[]>
}

/** Canonical Work Item fields used to decide whether its history row is current. */
export type AnalyticsHistoryWorkItem = {
  /** Owning Team ID. */
  teamId: string
  /** Work Item ID. */
  id: string
  /** Current canonical revision. */
  revision: number
}

/** Inputs of {@link readAnalyticsWorkItemHistoryEvents}. */
export type ReadAnalyticsWorkItemHistoryEventsInput<T extends AnalyticsHistoryWorkItem> = {
  /** Workspace whose history is read. */
  workspaceId: string
  /** Canonical Work Items that need history, already filtered by the current ACL. */
  workItems: readonly T[]
  /** Inclusive upper bound of event occurrence (ISO 8601). */
  historyReadAt: string
  /** History row reader; without one every Work Item uses the audit timeline. */
  historyReader?: AnalyticsWorkItemHistoryReader | undefined
  /** Reads the audit timelines of the Work Items whose history row is missing or stale. */
  readAuditEvents(workItems: readonly T[]): Promise<readonly AnalyticsHistoryEvent[]>
  /** Clock used to drop entries past their audit retention. */
  now?: () => Date
}

/**
 * Reads Analytics history from history rows first and from the audit timeline for the rest.
 *
 * A history row is used only when its covered revision equals the Work Item's canonical revision
 * and it did not overflow. Every other Work Item, including one whose projection is still behind,
 * goes to `readAuditEvents`, so the result equals reading every audit timeline. The caller's read
 * barrier still checks the combined events against the canonical state.
 *
 * @param input - Work Items, cutoff, history reader, and audit fallback.
 * @returns History events of all given Work Items.
 * @throws AnalyticsError 413 when the history rows hold more entries than one read may restore.
 */
export async function readAnalyticsWorkItemHistoryEvents<T extends AnalyticsHistoryWorkItem>(
  input: ReadAnalyticsWorkItemHistoryEventsInput<T>,
): Promise<AnalyticsHistoryEvent[]> {
  const { workItems, historyReader } = input
  if (!historyReader || workItems.length === 0) {
    return [...await input.readAuditEvents(workItems)]
  }
  const rows = await readHistoryRows(historyReader, input.workspaceId, workItems)
  const rowsByKey = new Map(rows.map((row) => [historyKey(row.teamId, row.workItemId), row]))
  const nowEpochSeconds = Math.floor((input.now?.() ?? new Date()).getTime() / 1000)
  const historyEvents: AnalyticsHistoryEvent[] = []
  const fallback: T[] = []
  for (const workItem of workItems) {
    const row = rowsByKey.get(historyKey(workItem.teamId, workItem.id))
    if (
      !row ||
      row.overflow ||
      row.coveredRevision !== workItem.revision ||
      hasExpiredEntry(row, nowEpochSeconds)
    ) {
      fallback.push(workItem)
      continue
    }
    if (historyEvents.length + row.entries.length > ANALYTICS_HISTORY_ROW_EVENT_LIMIT) {
      throw new AnalyticsError(
        413,
        'AnalyticsHistoryLimitExceeded',
        'Analytics history for the authorized Work Items exceeds the safe query limit. Narrow the report scope.',
      )
    }
    historyEvents.push(...toAnalyticsHistoryEvents(row, input.historyReadAt, nowEpochSeconds))
  }
  if (fallback.length === 0) return historyEvents
  return [...historyEvents, ...await input.readAuditEvents(fallback)]
}

/**
 * Reads history rows, treating a failed read as no rows so every Work Item uses the audit path.
 *
 * Only the byte budget's 413 is kept, because the audit path would hit its own limit too.
 *
 * @param historyReader - History row reader.
 * @param workspaceId - Workspace whose rows are read.
 * @param workItems - Work Items to read.
 * @returns The rows read, or none when the read failed.
 * @throws AnalyticsError 413 when the rows exceed the byte budget.
 */
async function readHistoryRows(
  historyReader: AnalyticsWorkItemHistoryReader,
  workspaceId: string,
  workItems: readonly AnalyticsHistoryWorkItem[],
) {
  try {
    return await historyReader.getWorkItemHistoryRows(
      workspaceId,
      workItems.map((workItem) => ({ teamId: workItem.teamId, workItemId: workItem.id })),
    )
  } catch (error) {
    if (error instanceof AnalyticsError && error.status === 413) throw error
    console.warn('Analytics history rows could not be read; using the audit timeline.', {
      code: error instanceof AnalyticsError ? error.code : 'AnalyticsHistoryRowReadFailed',
      name: error instanceof Error ? error.name : 'Error',
    })
    return []
  }
}

/**
 * Returns whether a row still holds an entry past its audit retention.
 *
 * Such a row waits for TTL or the next projection write, and the audit timeline is read instead
 * so a dropped entry never removes the latest revision's event from the result.
 *
 * @param row - History row.
 * @param nowEpochSeconds - Current time.
 * @returns True when any entry has expired.
 */
function hasExpiredEntry(row: AnalyticsWorkItemHistoryRow, nowEpochSeconds: number) {
  return row.entries.some((entry) =>
    entry.expiresAt !== undefined && entry.expiresAt <= nowEpochSeconds
  )
}

/**
 * Builds a map key for a Work Item.
 *
 * @param teamId - Owning Team ID.
 * @param workItemId - Work Item ID.
 * @returns A key that cannot collide across Teams.
 */
function historyKey(teamId: string, workItemId: string) {
  return `${teamId}\0${workItemId}`
}
