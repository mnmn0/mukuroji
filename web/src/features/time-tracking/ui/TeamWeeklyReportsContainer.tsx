import type { WorkspaceWeekStartDay } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { createWeekPeriod } from '../model/timePeriod'
import { useTeamWeeklyReportStatus, useWeeklyReport } from '../queries/useWeeklyReports'
import { TeamWeeklyReports } from './TeamWeeklyReports'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Props of the Team's weekly reports connected to the API. */
export type TeamWeeklyReportsContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
  /** Team whose reports are listed. */
  teamId: string
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Day Workspace weeks start on, 0 (Sunday) to 6; Monday when omitted. */
  weekStartDay?: WorkspaceWeekStartDay
  /** Display locale. */
  locale: Locale
  /** Member display names keyed by member key. */
  memberNames: Readonly<Record<string, string>>
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
}

/**
 * Connects the Team's weekly report status and the selected member's report to the API.
 *
 * @param props - Team, week, and session.
 * @returns Connected view.
 */
export function TeamWeeklyReportsContainer({
  accessToken,
  locale,
  memberNames,
  onMoveWeek,
  teamId,
  weekStart,
  weekStartDay,
}: TeamWeeklyReportsContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const week = useMemo(() => createWeekPeriod(weekStart, weekStartDay), [weekStart, weekStartDay])
  const firstDay = week.days[0] ?? weekStart
  const status = useTeamWeeklyReportStatus(accessToken, teamId, firstDay)
  const [selectedMemberKey, setSelectedMemberKey] = useState<string>()
  const selectedReport = useWeeklyReport(accessToken, teamId, selectedMemberKey, firstDay)
  const isForbidden = status.error instanceof TimeTrackingApiError && status.error.status === 403

  return (
    <TeamWeeklyReports
      formatters={formatters}
      hasLoadError={Boolean(status.error) && !isForbidden}
      hasSelectedReportError={Boolean(selectedReport.error)}
      isForbidden={isForbidden}
      memberNames={memberNames}
      members={status.data?.members}
      onMoveWeek={onMoveWeek}
      onRetry={() => { void status.mutate().catch(() => undefined) }}
      onSelectMember={setSelectedMemberKey}
      selectedMemberKey={selectedMemberKey}
      selectedReport={selectedReport.data}
      t={t}
      week={week}
    />
  )
}
