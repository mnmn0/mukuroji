import { useMemo, useState } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { useTimePeriodMutations } from '../mutations/useTimePeriodMutations'
import { useTeamTimePeriods } from '../queries/useTimePeriods'
import { TimePeriodClosePanel } from './TimePeriodClosePanel'
import { createMonthFormatter, previousMonth } from './timePeriodForm'
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
  /** Current time, injectable for stories and tests. */
  now?: Date
}

/**
 * Connects the Team month close view to the Team month close API.
 *
 * @param props - Team, session, and display settings.
 * @returns Connected month close view.
 */
export function TimePeriodCloseContainer({ accessToken, locale, now, teamId, timeZone }: TimePeriodCloseContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const formatMonth = useMemo(() => createMonthFormatter(locale), [locale])
  const [defaultMonth] = useState(() => previousMonth(now ?? new Date()))
  const periods = useTeamTimePeriods(accessToken, teamId)
  const mutations = useTimePeriodMutations(accessToken, teamId)

  return (
    <TimePeriodClosePanel
      defaultMonth={defaultMonth}
      formatMonth={formatMonth}
      formatters={formatters}
      hasLoadError={Boolean(periods.error)}
      isLoading={periods.isLoading}
      onCloseMonth={(month) => mutations.closeTeamMonth(month, timeZone)}
      onReopenMonth={(month, reason) => mutations.reopenTeamMonth(month, reason)}
      onRetry={() => { void periods.mutate().catch(() => undefined) }}
      {...(periods.data ? { periods: periods.data } : {})}
      t={t}
      timeZone={timeZone}
    />
  )
}
