import type { TeamWeeklySummaryResponse, WorkspaceWeekStartDay } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { createWeekPeriod } from '../model/timePeriod'
import { TeamWeeklySummary } from './TeamWeeklySummary'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Props of the Team weekly summary connected to the API. */
export type TeamWeeklySummaryContainerProps = {
  /** Summary read by the page; undefined while loading or after a failure. */
  summary: TeamWeeklySummaryResponse | undefined
  /** Read failure; the page also hands it to the session error handling. */
  error: unknown
  /** Reads the summary again. */
  onRetry: () => void
  /** Team summarized. */
  teamId: string
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Day Workspace weeks start on, 0 (Sunday) to 6; Monday when omitted. */
  weekStartDay?: WorkspaceWeekStartDay
  /** Display locale. */
  locale: Locale
  /** Project names keyed by Project ID. */
  projectNames: Readonly<Record<string, string>>
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
}

/**
 * Lays out the Team weekly summary that the page read, so the page can hand a session failure
 * of the read to its session error handling.
 *
 * @param props - Summary, Team, week, and locale.
 * @returns Connected view.
 */
export function TeamWeeklySummaryContainer({
  error,
  locale,
  onRetry,
  onMoveWeek,
  projectNames,
  summary,
  teamId,
  weekStart,
  weekStartDay,
}: TeamWeeklySummaryContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const week = useMemo(() => createWeekPeriod(weekStart, weekStartDay), [weekStart, weekStartDay])
  const isTooLarge = error instanceof TimeTrackingApiError && error.status === 413

  return (
    <TeamWeeklySummary
      formatters={formatters}
      hasLoadError={Boolean(error) && !isTooLarge}
      isTooLarge={isTooLarge}
      onMoveWeek={onMoveWeek}
      onRetry={onRetry}
      projectNames={projectNames}
      summary={summary}
      t={t}
      teamId={teamId}
      week={week}
    />
  )
}
