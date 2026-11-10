import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { PersonalTimesheetContainer } from '../../features/time-tracking/ui/PersonalTimesheetContainer'
import { TimeApprovalQueueContainer } from '../../features/time-tracking/ui/TimeApprovalQueueContainer'
import { TimeTrackingViewTabs, type TimeTrackingView } from '../../features/time-tracking/ui/TimeTrackingViewTabs'
import { resolveWeekStart, shiftWeek } from '../../features/time-tracking/model/timePeriod'
import {
  canRecordTimeOnWorkItem,
  readViewerProjectRoles,
} from '../../features/time-tracking/model/workItemWriteAccess'
import { useWorkspaceWorkItems } from '../../issues/queries/useWorkItems'
import type { ProjectDirectoryProject } from '../../projects/api'
import { useWorkspaceProjectMembers } from '../../projects/queries/useProjectMembers'
import { createTranslator } from '../../shared/i18n/i18n'
import { createTeamTimeTrackingPath } from '../../shared/routing/paths'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

const emptyTeamProjects: ProjectDirectoryProject[] = []

/**
 * Renders a Team's time tracking: the member's weekly timesheet and the manager's approval queue.
 *
 * The view and week live in the URL so a reload or shared link opens the same week.
 *
 * @returns Time tracking content inside the Workspace shell.
 */
export function TeamTimeTrackingPage() {
  const workspace = useWorkspaceRouteContext()
  const teamId = useParams().teamId
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const view: TimeTrackingView = searchParams.get('view') === 'approvals' ? 'approvals' : 'timesheet'
  const weekStart = resolveWeekStart(searchParams.get('week'))
  const activeTeam = workspace.teams.find((team) => team.id === teamId)
  const enabled = workspace.canLoadWorkspaceData && activeTeam !== undefined
  const accessToken = enabled ? workspace.accessToken : undefined
  const workItems = useWorkspaceWorkItems(accessToken, enabled)
  const writer = useMemo(() => ({
    canMutate: workspace.canMutateTeamConfiguration,
    isSystemAdmin: workspace.isSystemAdmin ?? false,
    ...(workspace.userKey ? { userKey: workspace.userKey } : {}),
  }), [workspace.canMutateTeamConfiguration, workspace.isSystemAdmin, workspace.userKey])
  // Members give approver names, and the viewer's own Project roles decide which tasks accept time.
  const needsViewerRoles = writer.canMutate && !writer.isSystemAdmin
  const projectMembers = useWorkspaceProjectMembers(
    accessToken,
    activeTeam?.id,
    activeTeam?.projects ?? emptyTeamProjects,
    enabled && (view === 'approvals' || needsViewerRoles),
  )
  const viewerProjectRoles = useMemo(
    () => readViewerProjectRoles(projectMembers.data?.members ?? [], writer.userKey),
    [projectMembers.data?.members, writer.userKey],
  )
  // Only tasks the server would accept are offered, so a manual entry is never refused for access.
  const workItemOptions = useMemo(
    () => (workItems.data ?? [])
      .filter((item) => item.teamId === teamId && !item.archivedAt)
      .filter((item) => canRecordTimeOnWorkItem(item, writer, viewerProjectRoles))
      .map((item) => ({ id: item.id, title: item.title }))
      .sort((left, right) => left.title.localeCompare(right.title)),
    [teamId, viewerProjectRoles, workItems.data, writer],
  )
  const isLoadingWorkItemOptions = workItems.isLoading || (needsViewerRoles && projectMembers.isLoading)
  const workItemTitles = useMemo(
    () => Object.fromEntries((workItems.data ?? [])
      .filter((item) => item.teamId === teamId)
      .map((item) => [item.id, item.title])),
    [teamId, workItems.data],
  )
  // Without Work Items the entry form has nothing to pick, so a failed lookup is shown, not treated as empty.
  const lookupError = workItems.error ?? projectMembers.error ?? projectMembers.data?.errors[0]
  const memberNames = useMemo(() => {
    const names: Record<string, string> = {}
    for (const access of projectMembers.data?.members ?? []) {
      names[access.member.id] = access.member.name ?? access.member.email ?? access.member.id
    }
    return names
  }, [projectMembers.data?.members])

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
    <WorkspaceRouteContent sessionErrors={[workItems.error, projectMembers.error]}>
      <div className="grid min-w-0 gap-4 px-[clamp(16px,3vw,34px)] py-5">
        <TimeTrackingViewTabs
          getHref={(candidate) => createTeamTimeTrackingPath(teamId, candidate, weekStart)}
          onSelect={(candidate) => open(candidate, weekStart)}
          t={t}
          view={view}
        />
        {lookupError ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
            <span>{t('timeTracking.page.lookupError')}</span>
            <button
              className="workbench-button-secondary min-h-8 px-3"
              onClick={() => { void Promise.all([workItems.mutate(), projectMembers.mutate()]).catch(() => undefined) }}
              type="button"
            >
              {t('timeTracking.page.lookupRetry')}
            </button>
          </div>
        ) : null}
        {view === 'approvals' ? (
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
