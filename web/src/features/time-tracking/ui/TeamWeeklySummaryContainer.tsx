import type { WorkspaceWeekStartDay } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { createWeekPeriod } from '../model/timePeriod'
import { useTeamWeeklySummary } from '../queries/useWeeklyReports'
import { TeamWeeklySummary } from './TeamWeeklySummary'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Props of the Team weekly summary connected to the API. */
export type TeamWeeklySummaryContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
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
 * Connects the Team weekly summary to the API.
 *
 * @param props - Team, week, and session.
 * @returns Connected view.
 */
export function TeamWeeklySummaryContainer({
  accessToken,
  locale,
  onMoveWeek,
  projectNames,
  teamId,
  weekStart,
  weekStartDay,
}: TeamWeeklySummaryContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const week = useMemo(() => createWeekPeriod(weekStart, weekStartDay), [weekStart, weekStartDay])
  const summary = useTeamWeeklySummary(accessToken, teamId, week.days[0] ?? weekStart)
  const isTooLarge = summary.error instanceof TimeTrackingApiError && summary.error.status === 413

  return (
    <TeamWeeklySummary
      formatters={formatters}
      hasLoadError={Boolean(summary.error) && !isTooLarge}
      isTooLarge={isTooLarge}
      onMoveWeek={onMoveWeek}
      onRetry={() => { void summary.mutate().catch(() => undefined) }}
      projectNames={projectNames}
      summary={summary.data}
      t={t}
      teamId={teamId}
      week={week}
    />
  )
}
