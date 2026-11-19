import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { PersonalTimesheetContainer } from '../../features/time-tracking/ui/PersonalTimesheetContainer'
import { TimeApprovalQueueContainer } from '../../features/time-tracking/ui/TimeApprovalQueueContainer'
import { TimeReportContainer } from '../../features/time-tracking/ui/TimeReportContainer'
import { TimeTrackingViewTabs, type TimeTrackingView } from '../../features/time-tracking/ui/TimeTrackingViewTabs'
import { selectTimeEntryWorkItemChoices } from '../../features/time-tracking/model/timeEntryWorkItemOptions'
import { resolveWeekStart, shiftWeek } from '../../features/time-tracking/model/timePeriod'
import { resolveTimeReportGroupBy, resolveTimeReportRange } from '../../features/time-tracking/model/timeReport'
import { useWorkspaceWorkItems } from '../../issues/queries/useWorkItems'
import type { ProjectDirectoryProject } from '../../projects/api'
import { useWorkspaceProjectMembers } from '../../projects/queries/useProjectMembers'
import { useSavedTaskViews } from '../../task-views/queries/useSavedTaskViews'
import { createTranslator } from '../../shared/i18n/i18n'
import { createTeamTimeTrackingPath } from '../../shared/routing/paths'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

const emptyTeamProjects: ProjectDirectoryProject[] = []

/**
 * Renders a Team's time tracking: the member's weekly timesheet, the manager's approval queue, and
 * the Team report with its CSV export and budgets.
 *
 * The view, week, and report period live in the URL so a reload or shared link opens the same view.
 *
 * @returns Time tracking content inside the Workspace shell.
 */
export function TeamTimeTrackingPage() {
  const workspace = useWorkspaceRouteContext()
  const teamId = useParams().teamId
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const viewParam = searchParams.get('view')
  const view: TimeTrackingView = viewParam === 'approvals' || viewParam === 'report' ? viewParam : 'timesheet'
  const weekStart = resolveWeekStart(searchParams.get('week'))
  const reportFrom = searchParams.get('from')
  const reportTo = searchParams.get('to')
  const reportRange = useMemo(() => resolveTimeReportRange(reportFrom, reportTo), [reportFrom, reportTo])
  const reportGroupBy = resolveTimeReportGroupBy(searchParams.get('groupBy'))
  const activeTeam = workspace.teams.find((team) => team.id === teamId)
  const enabled = workspace.canLoadWorkspaceData && activeTeam !== undefined
  const accessToken = enabled ? workspace.accessToken : undefined
  // Filtered on the server, so other Teams' Work Items cannot push the read past its size limit.
  const teamWorkItemFilter = useMemo(() => ({ teamId: teamId ?? '' }), [teamId])
  const workItems = useWorkspaceWorkItems(accessToken, enabled, false, teamWorkItemFilter)
  const projectMembers = useWorkspaceProjectMembers(
    accessToken,
    activeTeam?.id,
    activeTeam?.projects ?? emptyTeamProjects,
    enabled && view !== 'timesheet',
  )
  const teamScope = useMemo(() => ({ kind: 'team' as const, teamId: teamId ?? '' }), [teamId])
  // The Team task-view list carries the server's effective write scopes, enterprise grants included.
  const writeAccess = useSavedTaskViews(accessToken, 'team', teamScope, enabled && view === 'timesheet')
  // Only tasks the server would accept are offered, so a manual entry is never refused for access.
  const workItemOptions = useMemo(
    () => selectTimeEntryWorkItemChoices(workItems.data ?? [], teamId ?? '', writeAccess.data?.capabilities),
    [teamId, workItems.data, writeAccess.data?.capabilities],
  )
  // Until both reads land, an empty list means unknown, not "nothing writable".
  const isLoadingWorkItemOptions = !workItems.data || !writeAccess.data
  const workItemTitles = useMemo(
    () => Object.fromEntries((workItems.data ?? [])
      .filter((item) => item.teamId === teamId)
      .map((item) => [item.id, item.title])),
    [teamId, workItems.data],
  )
  // Without Work Items the entry form has nothing to pick, so a failed lookup is shown, not treated as empty.
  const lookupError = workItems.error ?? writeAccess.error ?? projectMembers.error ?? projectMembers.data?.errors[0]
  const memberNames = useMemo(() => {
    const names: Record<string, string> = {}
    for (const access of projectMembers.data?.members ?? []) {
      names[access.member.id] = access.member.name ?? access.member.email ?? access.member.id
    }
    return names
  }, [projectMembers.data?.members])
  const teamProjects = activeTeam?.projects ?? emptyTeamProjects
  const reportLabels = useMemo(() => ({
    members: memberNames,
    projects: Object.fromEntries(teamProjects.map((project) => [project.id, project.name])),
    workItems: workItemTitles,
  }), [memberNames, teamProjects, workItemTitles])

  /**
   * Opens a view and week through the URL.
   *
   * @param nextView - View to show.
   * @param nextWeekStart - Monday of the week to show.
   */
  const open = (nextView: TimeTrackingView, nextWeekStart: string) => {
    void navigate(createTeamTimeTrackingPath(teamId ?? '', nextView, nextWeekStart), { replace: true })
  }

  /**
   * Moves the week shown; 0 returns to the current week.
   *
   * @param weeks - Weeks to move.
   */
  const moveWeek = (weeks: number) => {
    open(view, weeks === 0 ? resolveWeekStart(null) : shiftWeek(weekStart, weeks))
  }

  if (!teamId) return null

  return (
    <WorkspaceRouteContent sessionErrors={[workItems.error, writeAccess.error, projectMembers.error]}>
      <div className="grid min-w-0 gap-4 px-[clamp(16px,3vw,34px)] py-5">
        <TimeTrackingViewTabs
          getHref={(candidate) => candidate === 'report'
            ? createTeamTimeTrackingPath(teamId, 'report', undefined, { ...reportRange, groupBy: reportGroupBy })
            : createTeamTimeTrackingPath(teamId, candidate, weekStart)}
          onSelect={(candidate) => { void navigate(candidate === 'report'
            ? createTeamTimeTrackingPath(teamId, 'report', undefined, { ...reportRange, groupBy: reportGroupBy })
            : createTeamTimeTrackingPath(teamId, candidate, weekStart), { replace: true }) }}
          t={t}
          view={view}
        />
        {lookupError ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
            <span>{t('timeTracking.page.lookupError')}</span>
            <button
              className="workbench-button-secondary min-h-8 px-3"
              onClick={() => { void Promise.all([workItems.mutate(), writeAccess.mutate(), projectMembers.mutate()]).catch(() => undefined) }}
              type="button"
            >
              {t('timeTracking.page.lookupRetry')}
            </button>
          </div>
        ) : null}
        {view === 'report' ? (
          <TimeReportContainer
            accessToken={accessToken}
            groupBy={reportGroupBy}
            key={`${teamId}:report`}
            labels={reportLabels}
            locale={workspace.locale}
            onChange={(range, groupBy) => {
              void navigate(createTeamTimeTrackingPath(teamId, 'report', undefined, { ...range, groupBy }), { replace: true })
            }}
            projects={teamProjects}
            range={reportRange}
            teamId={teamId}
          />
        ) : view === 'approvals' ? (
          <TimeApprovalQueueContainer
            accessToken={accessToken}
            key={`${teamId}:approvals`}
            locale={workspace.locale}
            memberNames={memberNames}
            onMoveWeek={moveWeek}
            teamId={teamId}
            weekStart={weekStart}
            workItemTitles={workItemTitles}
          />
        ) : (
          <PersonalTimesheetContainer
            accessToken={accessToken}
            key={`${teamId}:timesheet`}
            locale={workspace.locale}
            {...(workspace.userKey ? { memberKey: workspace.userKey } : {})}
            onMoveWeek={moveWeek}
            teamId={teamId}
            weekStart={weekStart}
            isLoadingWorkItemOptions={isLoadingWorkItemOptions}
            workItemOptions={workItemOptions}
            workItemTitles={workItemTitles}
          />
        )}
      </div>
    </WorkspaceRouteContent>
  )
}
