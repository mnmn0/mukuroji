import { useMemo } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { createWeekPeriod, resolveBrowserTimeZone } from '../model/timePeriod'
import { useTimeEntryMutations } from '../mutations/useTimeEntryMutations'
import { useTeamTimesheet } from '../queries/useTeamTimesheet'
import { useTimeEntries } from '../queries/useTimeEntries'
import { TimeApprovalQueue } from './TimeApprovalQueue'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Props of the approval queue connected to the API. */
export type TimeApprovalQueueContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
  /** Team whose entries are reviewed. */
  teamId: string
  /** Monday of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Display locale. */
  locale: Locale
  /** Member display names keyed by member key. */
  memberNames: Readonly<Record<string, string>>
  /** Work Item titles keyed by identifier. */
  workItemTitles: Readonly<Record<string, string>>
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
}

/**
 * Connects the approval queue to the entry and timesheet APIs.
 *
 * The Team timesheet withholds confidential costs from everyone but Team managers, so its
 * `costsRedacted` flag decides whether the queue is shown before any entry list is read.
 *
 * @param props - Team, week, and session.
 * @returns Connected queue.
 */
export function TimeApprovalQueueContainer({
  accessToken,
  locale,
  memberNames,
  onMoveWeek,
  teamId,
  weekStart,
  workItemTitles,
}: TimeApprovalQueueContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const week = useMemo(() => createWeekPeriod(weekStart), [weekStart])
  const timeZone = resolveBrowserTimeZone()
  const timesheet = useTeamTimesheet(accessToken, teamId, { ...week, timeZone })
  const canManage = timesheet.data ? !timesheet.data.costsRedacted : undefined
  const entries = useTimeEntries(accessToken, teamId, week, {}, canManage === true)
  const mutations = useTimeEntryMutations(accessToken)

  return (
    <TimeApprovalQueue
      canManage={canManage}
      entries={entries.data?.entries ?? []}
      formatters={formatters}
      hasLoadError={Boolean(timesheet.error ?? entries.error)}
      isLoading={entries.isLoading}
      isPartial={entries.data?.complete === false}
      memberNames={memberNames}
      onMoveWeek={onMoveWeek}
      onRetry={() => { void Promise.all([timesheet.mutate(), entries.mutate()]).catch(() => undefined) }}
      onTransitionEntry={(entry, action, reason) => mutations.transition(entry, action, reason)}
      onTransitionWeek={(action) => mutations.transitionPeriod(teamId, action, week)}
      t={t}
      {...(timesheet.data ? { teamTimesheet: timesheet.data } : {})}
      week={week}
      workItemTitles={workItemTitles}
    />
  )
}
