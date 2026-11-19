import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { buildPersonalWeeklyReport } from '../model/personalWeeklyReport'
import { createWeekPeriod } from '../model/timePeriod'
import { useTimeEntries } from '../queries/useTimeEntries'
import { PersonalWeeklyReport } from './PersonalWeeklyReport'
import { createTimeTrackingFormatters } from './timeTrackingText'
import { useLocalToday } from './useNow'

const emptyWorkItems: readonly CanonicalWorkItem[] = []

/** Props of the member's weekly report connected to the API. */
export type PersonalWeeklyReportContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
  /** Team whose entries and Work Items are reported. */
  teamId: string
  /** Signed-in member key; the report reads only this member's entries. */
  memberKey: string | undefined
  /** Monday of the week as `YYYY-MM-DD`. */
  weekStart: string
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
  onRetryWorkItems,
  teamId,
  weekStart,
  workItemTitles,
  workItems,
}: PersonalWeeklyReportContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const week = useMemo(() => createWeekPeriod(weekStart), [weekStart])
  const today = useLocalToday()
  // Without the member key a manager would read the whole Team's entries, so nothing is read.
  const entries = useTimeEntries(accessToken, teamId, week, memberKey ? { userId: memberKey } : {}, memberKey !== undefined)
  const report = useMemo(() => buildPersonalWeeklyReport({
    weekDays: week.days,
    today,
    workItems: workItems ?? emptyWorkItems,
    entries: entries.data?.entries ?? [],
    workItemTitles,
  }), [entries.data?.entries, today, week.days, workItemTitles, workItems])

  return (
    <PersonalWeeklyReport
      formatters={formatters}
      // Without the member key the entries cannot be read, so the report is unavailable, not empty.
      hasLoadError={Boolean(entries.error) || hasWorkItemError || memberKey === undefined}
      isLoading={entries.isLoading || (workItems === undefined && !hasWorkItemError)}
      isPartial={entries.data?.complete === false}
      onCopy={writeClipboardText}
      onMoveWeek={onMoveWeek}
      onRetry={() => {
        onRetryWorkItems()
        void entries.mutate().catch(() => undefined)
      }}
      report={report}
      t={t}
      week={week}
    />
  )
}
