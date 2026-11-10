import { useMemo } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { createWeekPeriod } from '../model/timePeriod'
import { useTimeEntryMutations } from '../mutations/useTimeEntryMutations'
import { useRejectionReasons } from '../queries/useRejectionReasons'
import { useTimeEntries } from '../queries/useTimeEntries'
import { PersonalTimesheet } from './PersonalTimesheet'
import type { TimeEntryWorkItemOption } from './TimeEntryForm'
import { createTimeTrackingFormatters } from './timeTrackingText'
import { useLocalToday } from './useNow'

/** Props of the member's timesheet connected to the API. */
export type PersonalTimesheetContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
  /** Team whose entries are shown. */
  teamId: string
  /** Signed-in member key, so a manager reads only their own entries. */
  memberKey?: string
  /** Monday of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Display locale. */
  locale: Locale
  /** Work Items of the Team the member may record time against. */
  workItemOptions: readonly TimeEntryWorkItemOption[]
  /** Whether the offered Work Items are still being resolved. */
  isLoadingWorkItemOptions?: boolean
  /** Titles of every Team Work Item, including ones the member can no longer record against. */
  workItemTitles: Readonly<Record<string, string>>
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
}

/**
 * Connects the member's weekly timesheet to the entry APIs.
 *
 * @param props - Team, week, and session.
 * @returns Connected timesheet.
 */
export function PersonalTimesheetContainer({
  accessToken,
  isLoadingWorkItemOptions = false,
  locale,
  memberKey,
  onMoveWeek,
  teamId,
  weekStart,
  workItemOptions,
  workItemTitles,
}: PersonalTimesheetContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const week = useMemo(() => createWeekPeriod(weekStart), [weekStart])
  const today = useLocalToday()
  const entries = useTimeEntries(accessToken, teamId, week, memberKey ? { userId: memberKey } : {})
  const rejectionReasons = useRejectionReasons(accessToken, entries.data?.entries ?? [])
  const mutations = useTimeEntryMutations(accessToken)

  return (
    <PersonalTimesheet
      entries={entries.data?.entries ?? []}
      formatters={formatters}
      hasLoadError={Boolean(entries.error ?? rejectionReasons.error)}
      isLoading={entries.isLoading}
      isLoadingWorkItemOptions={isLoadingWorkItemOptions}
      isPartial={entries.data?.complete === false}
      onCreateEntry={(input) => mutations.create(teamId, input)}
      onMoveWeek={onMoveWeek}
      onRetry={() => { void Promise.all([entries.mutate(), rejectionReasons.mutate()]).catch(() => undefined) }}
      onSubmitEntry={(entry) => mutations.transition(entry, 'submit')}
      onSubmitWeek={() => mutations.transitionPeriod(teamId, 'submit', week)}
      onUpdateEntry={(entry, input) => mutations.update(entry, input)}
      {...(rejectionReasons.data ? { rejectionReasons: rejectionReasons.data } : {})}
      t={t}
      today={today}
      week={week}
      workItemOptions={workItemOptions}
      workItemTitles={workItemTitles}
    />
  )
}
