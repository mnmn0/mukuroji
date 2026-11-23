import { useState } from 'react'
import { useSearchParams } from 'react-router'
import type { CapacityPlanningGranularity, MyTimesheet, MyTimesheetSubmitRequest } from '@mukuroji/contracts'
import { useSubmitMyTimesheet } from '../../features/time-tracking/mutations/useSubmitMyTimesheet'
import { createWeekPeriod, resolveBrowserTimeZone, resolveWeekStart, shiftWeek } from '../../features/time-tracking/model/timePeriod'
import { useMyTimesheet } from '../../features/time-tracking/queries/useMyTimesheet'
import { MyTimesheetPanel } from '../../features/time-tracking/ui/MyTimesheetPanel'
import { createTranslator } from '../../shared/i18n/i18n'
import { useWorkspaceWorkload } from '../../workload/queries/useWorkspaceWorkload'
import { WorkspaceWorkloadView } from '../../workload/ui/WorkspaceWorkloadView'
import { useWorkspaceCalendarSettings } from '../../workspace/queries/useWorkspaceCalendarSettings'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Hosts the workload across Teams and the caller's own time across Teams.
 *
 * @returns Both sections inside the shared Workspace shell.
 */
export function WorkspaceWorkloadPage() {
  const workspace = useWorkspaceRouteContext()
  return <WorkspaceWorkloadSession key={workspace.accessToken} />
}

/** Keeps the submission state of one authenticated session. */
function WorkspaceWorkloadSession() {
  const workspace = useWorkspaceRouteContext()
  const t = createTranslator(workspace.locale)
  const [params, setParams] = useSearchParams()
  const [granularity, setGranularity] = useState<CapacityPlanningGranularity>('week')
  const workload = useWorkspaceWorkload(workspace.accessToken, granularity, workspace.canLoadWorkspaceData)
  // The week must follow the Workspace week start, so the timesheet waits for the calendar.
  const calendarSettings = useWorkspaceCalendarSettings(workspace.accessToken, workspace.canLoadWorkspaceData)
  const weekStartDay = calendarSettings.settings?.weekStartDay
  const weekStart = resolveWeekStart(params.get('week'), undefined, weekStartDay)
  const week = createWeekPeriod(weekStart, weekStartDay)
  const timesheet = useMyTimesheet(
    workspace.accessToken,
    { from: week.from, to: week.to, timeZone: resolveBrowserTimeZone() },
    workspace.canLoadWorkspaceData && weekStartDay !== undefined,
  )
  const submission = useSubmitMyTimesheet(workspace.accessToken)
  return (
    <WorkspaceRouteContent sessionErrors={[workload.error, timesheet.error, calendarSettings.error]}>
      <div className="grid gap-8 px-[clamp(16px,3vw,34px)] py-5">
        <WorkspaceWorkloadView
          failed={Boolean(workload.error)}
          granularity={granularity}
          isLoading={workload.isLoading}
          onGranularityChange={setGranularity}
          onRetry={() => { void workload.mutate() }}
          snapshot={workload.data}
          t={t}
        />
        {weekStartDay === undefined ? (
          calendarSettings.error ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-tone-f2c7c7 bg-tone-fff7f7 px-4 py-3 text-sm font-semibold text-fg-9f3f3f" role="alert">
              <span>{t('timeTracking.page.calendarSettingsError')}</span>
              <button className="rounded-md border border-tone-d99696 px-3 py-2 text-xs font-bold" type="button" onClick={calendarSettings.retry}>
                {t('timeTracking.page.calendarSettingsRetry')}
              </button>
            </div>
          ) : (
            <p className="text-sm font-semibold text-[var(--workbench-muted)]" aria-live="polite">
              {t('timeTracking.page.calendarSettingsLoading')}
            </p>
          )
        ) : (
          <MyTimesheetPanel
            days={week.days}
            failed={Boolean(timesheet.error)}
            isLoading={timesheet.isLoading}
            isSubmitting={submission.isSubmitting}
            notice={submission.notice}
            onMoveWeek={(weeks) => {
              submission.clearNotice()
              setParams({ week: shiftWeek(weekStart, weeks, weekStartDay) })
            }}
            onRetry={() => { void timesheet.mutate() }}
            onSubmit={() => {
              void submission.submit({ from: week.from, to: week.to, entries: listSubmittableEntries(timesheet.data) })
            }}
            t={t}
            timesheet={timesheet.data}
          />
        )}
      </div>
    </WorkspaceRouteContent>
  )
}

/**
 * Lists the draft and rejected entries of every Team the member sees, with the revision shown.
 *
 * @param timesheet - Loaded personal timesheet, or undefined while loading.
 * @returns Entries to submit.
 */
function listSubmittableEntries(timesheet: MyTimesheet | undefined): MyTimesheetSubmitRequest['entries'] {
  return (timesheet?.teams ?? []).flatMap((team) => team.entries
    .filter((entry) => entry.status === 'draft' || entry.status === 'rejected')
    .map((entry) => ({ teamId: team.teamId, entryId: entry.id, expectedRevision: entry.revision })))
}
