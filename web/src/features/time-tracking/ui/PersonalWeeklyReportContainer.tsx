import type { CanonicalWorkItem, WorkspaceWeekStartDay } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { buildPersonalWeeklyReport } from '../model/personalWeeklyReport'
import { createWeekPeriod } from '../model/timePeriod'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { useWeeklyReportMutations } from '../mutations/useWeeklyReportMutations'
import { useTimeEntries } from '../queries/useTimeEntries'
import { useWeeklyReport, useWeeklyReportHistory } from '../queries/useWeeklyReports'
import { PersonalWeeklyReport, type WeeklyReportActionResult } from './PersonalWeeklyReport'
import { createTimeTrackingFormatters, describeTimeEntrySubject } from './timeTrackingText'
import { useLocalToday } from './useNow'
import { useTimeEntryCategories } from '../model/timeEntryCategoryContext'

const emptyWorkItems: readonly CanonicalWorkItem[] = []

/** Props of the member's weekly report connected to the API. */
export type PersonalWeeklyReportContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
  /** Team whose entries and Work Items are reported. */
  teamId: string
  /** Signed-in member key; the report reads only this member's entries. */
  memberKey: string | undefined
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Day Workspace weeks start on, 0 (Sunday) to 6; Monday when omitted. */
  weekStartDay?: WorkspaceWeekStartDay
  /** Display locale. */
  locale: Locale
  /** Team Work Items the member owns or contributes to, as filtered by the server. */
  workItems: readonly CanonicalWorkItem[] | undefined
  /** Whether the member's Work Items failed to load. */
  hasWorkItemError: boolean
  /** Titles of every Team Work Item, for time recorded against items outside `workItems`. */
  workItemTitles: Readonly<Record<string, string>>
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
  /** Opens the week starting on a date, from the history. */
  onOpenWeek: (weekStart: string) => void
  /** Retries the member's Work Item read. */
  onRetryWorkItems: () => void
}

/**
 * Writes text to the system clipboard.
 *
 * @param text - Text to copy.
 * @returns Resolves once copied; rejects when the clipboard is unavailable or refused.
 */
async function writeClipboardText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error('Clipboard unavailable')
  await navigator.clipboard.writeText(text)
}

/**
 * Maps a save or submission failure to the outcome the view reports.
 *
 * @param error - Thrown error.
 * @returns The outcome.
 */
function toActionResult(error: unknown): WeeklyReportActionResult {
  if (error instanceof TimeTrackingApiError) {
    if (error.code === 'WeeklyReportSubmissionLimit') return 'limit'
    if (error.status === 409) return 'conflict'
  }
  return 'failed'
}

/**
 * Runs a save or submission and turns its outcome into a result.
 *
 * @param action - The API call.
 * @returns The outcome.
 */
async function runAction(action: () => Promise<unknown>): Promise<WeeklyReportActionResult> {
  try {
    await action()
    return 'done'
  } catch (error) {
    return toActionResult(error)
  }
}

/**
 * Connects the member's weekly report to their time entries and Work Items.
 *
 * @param props - Team, week, member, and the member's Work Items.
 * @returns Connected weekly report.
 */
export function PersonalWeeklyReportContainer({
  accessToken,
  hasWorkItemError,
  locale,
  memberKey,
  onMoveWeek,
  onOpenWeek,
  onRetryWorkItems,
  teamId,
  weekStart,
  weekStartDay,
  workItemTitles,
  workItems,
}: PersonalWeeklyReportContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const categories = useTimeEntryCategories()
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const week = useMemo(() => createWeekPeriod(weekStart, weekStartDay), [weekStart, weekStartDay])
  const today = useLocalToday()
  // Without the member key a manager would read the whole Team's entries, so nothing is read.
  const entries = useTimeEntries(accessToken, teamId, week, memberKey ? { userId: memberKey } : {}, memberKey !== undefined)
  const saved = useWeeklyReport(accessToken, teamId, memberKey, week.days[0] ?? weekStart)
  const history = useWeeklyReportHistory(accessToken, teamId, memberKey)
  const mutations = useWeeklyReportMutations(accessToken, teamId, memberKey, week.days[0] ?? weekStart)
  const report = useMemo(() => buildPersonalWeeklyReport({
    weekDays: week.days,
    today,
    workItems: workItems ?? emptyWorkItems,
    entries: entries.data?.entries ?? [],
    workItemTitles,
    indirectTitle: (category) => describeTimeEntrySubject(t, category ? { category } : {}, {}, categories),
  }), [categories, entries.data?.entries, t, today, week.days, workItemTitles, workItems])

  return (
    <PersonalWeeklyReport
      formatters={formatters}
      // Without the member key the entries cannot be read, so the report is unavailable, not empty.
      hasLoadError={Boolean(entries.error) || Boolean(saved.error) || hasWorkItemError || memberKey === undefined}
      {...(history.data ? { history: history.data.weeks } : {})}
      hasHistoryError={Boolean(history.error)}
      isLoading={entries.isLoading || saved.isLoading || (workItems === undefined && !hasWorkItemError)}
      isPartial={entries.data?.complete === false}
      onCopy={writeClipboardText}
      onMoveWeek={onMoveWeek}
      onOpenWeek={onOpenWeek}
      onRetry={() => {
        onRetryWorkItems()
        void Promise.all([entries.mutate(), saved.mutate(), history.mutate()]).catch(() => undefined)
      }}
      onRetryHistory={() => { void history.mutate().catch(() => undefined) }}
      onSaveDraft={(expectedRevision, notes) => runAction(() => mutations.saveDraft(expectedRevision, notes))}
      onSubmit={(request) => runAction(() => mutations.submit(request))}
      report={report}
      savedReport={saved.data}
      t={t}
      week={week}
    />
  )
}
