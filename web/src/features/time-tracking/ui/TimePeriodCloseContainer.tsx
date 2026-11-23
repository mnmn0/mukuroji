import { useMemo, useState } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { useTimePeriodMutations } from '../mutations/useTimePeriodMutations'
import { useTeamTimePeriods, useWorkspaceTimePeriod } from '../queries/useTimePeriods'
import { TimePeriodClosePanel } from './TimePeriodClosePanel'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Props of the month close view connected to the API. */
export type TimePeriodCloseContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
  /** Team whose months are shown. */
  teamId: string
  /** Display locale. */
  locale: Locale
  /** IANA timezone a new close uses. */
  timeZone: string
  /** Team names keyed by Team ID, for the Workspace section. */
  teamNames: Readonly<Record<string, string>>
  /** Current time, injectable for stories and tests. */
  now?: Date
}

/**
 * Returns the month before the given time, in the browser's local calendar, which is the month a
 * manager usually closes.
 *
 * @param now - Current time.
 * @returns Previous month as `YYYY-MM`.
 */
function previousMonth(now: Date): string {
  const date = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Connects the month close view to the Team and Workspace month close APIs.
 *
 * @param props - Team, session, and display settings.
 * @returns Connected month close view.
 */
export function TimePeriodCloseContainer({ accessToken, locale, now, teamId, teamNames, timeZone }: TimePeriodCloseContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' }),
    [locale],
  )
  const [defaultMonth] = useState(() => previousMonth(now ?? new Date()))
  const [workspaceMonth, setWorkspaceMonth] = useState(defaultMonth)
  const periods = useTeamTimePeriods(accessToken, teamId)
  const workspace = useWorkspaceTimePeriod(accessToken, workspaceMonth, periods.data?.canManageWorkspacePeriods === true)
  const mutations = useTimePeriodMutations(accessToken, teamId)

  /**
   * Formats a `YYYY-MM` month for display, falling back to the raw text.
   *
   * @param month - Month text.
   * @returns Display month.
   */
  const formatMonth = (month: string) => {
    const match = /^(\d{4})-(\d{2})$/u.exec(month)
    return match ? monthFormatter.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))) : month
  }

  return (
    <TimePeriodClosePanel
      defaultMonth={defaultMonth}
      formatMonth={formatMonth}
      formatters={formatters}
      hasLoadError={Boolean(periods.error)}
      hasWorkspaceLoadError={Boolean(workspace.error)}
      isLoading={periods.isLoading}
      isWorkspaceLoading={workspace.isLoading}
      onCloseMonth={(month) => mutations.closeTeamMonth(month, timeZone)}
      onCloseWorkspaceMonth={(month) => mutations.closeWorkspaceMonth(month, timeZone)}
      onReopenMonth={(month, reason) => mutations.reopenTeamMonth(month, reason)}
      onReopenWorkspaceMonth={(month, reason) => mutations.reopenWorkspaceMonth(month, reason)}
      onRetry={() => { void periods.mutate().catch(() => undefined) }}
      onRetryWorkspace={() => { void workspace.mutate().catch(() => undefined) }}
      onWorkspaceMonthChange={setWorkspaceMonth}
      {...(periods.data ? { periods: periods.data } : {})}
      t={t}
      teamNames={teamNames}
      timeZone={timeZone}
      workspaceMonth={workspaceMonth}
      {...(workspace.data ? { workspaceState: workspace.data } : {})}
    />
  )
}
