import { useState } from 'react'
import { useSearchParams } from 'react-router'
import useSWR from 'swr'
import type { CapacityPlanningGranularity } from '@mukuroji/contracts'
import { getMyTimesheet, submitMyTimesheet } from '../../features/time-tracking/api/myTimesheet'
import { createWeekPeriod, resolveBrowserTimeZone, resolveWeekStart, shiftWeek } from '../../features/time-tracking/model/timePeriod'
import { MyTimesheetPanel, type MyTimesheetSubmitNotice } from '../../features/time-tracking/ui/MyTimesheetPanel'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import { createTranslator } from '../../shared/i18n/i18n'
import { getWorkspaceWorkload } from '../../workload/api'
import { createWorkloadDateRange } from '../../workload/model/dateRange'
import { WorkspaceWorkloadView } from '../../workload/ui/WorkspaceWorkloadView'
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
  const range = createWorkloadDateRange(new Date(), granularity === 'month' ? 62 : granularity === 'week' ? 28 : 14)
  const workload = useSWR(
    workspace.canLoadWorkspaceData && workspace.accessToken ? ['workspace-workload', workspace.accessToken, range.fromDate, range.toDate, granularity] as const : null,
    ([, token, fromDate, toDate, currentGranularity]) =>
      getWorkspaceWorkload(token, { fromDate, toDate, granularity: currentGranularity }),
    { shouldRetryOnError: false },
  )
  const weekStart = resolveWeekStart(params.get('week'))
  const week = createWeekPeriod(weekStart)
  const timeZone = resolveBrowserTimeZone()
  const timesheet = useSWR(
    workspace.canLoadWorkspaceData && workspace.accessToken ? ['my-timesheet', workspace.accessToken, week.from, week.to, timeZone] as const : null,
    ([, token, from, to, zone]) => getMyTimesheet(token, { from, to, timeZone: zone }),
    { shouldRetryOnError: false },
  )
  const [isSubmitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<MyTimesheetSubmitNotice>()
  const submit = async () => {
    const accessToken = workspace.accessToken
    if (!accessToken) return
    setSubmitting(true)
    setNotice(undefined)
    try {
      const result = await submitMyTimesheet(accessToken, { from: week.from, to: week.to }, createMutationRequestContext())
      setNotice(result.partialFailure
        ? { kind: 'partial', count: result.count, failed: result.failedEntryIds.length }
        : result.count === 0 ? { kind: 'nothing' } : { kind: 'submitted', count: result.count })
    } catch {
      setNotice({ kind: 'error' })
    } finally {
      setSubmitting(false)
      void timesheet.mutate()
    }
  }
  return (
    <WorkspaceRouteContent sessionErrors={[workload.error, timesheet.error]}>
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
        <MyTimesheetPanel
          days={week.days}
          failed={Boolean(timesheet.error)}
          isLoading={timesheet.isLoading}
          isSubmitting={isSubmitting}
          notice={notice}
          onMoveWeek={(weeks) => {
            setNotice(undefined)
            setParams({ week: shiftWeek(weekStart, weeks) })
          }}
          onRetry={() => { void timesheet.mutate() }}
          onSubmit={() => { void submit() }}
          t={t}
          timesheet={timesheet.data}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
