import {
  DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
  isWeeklyReportDate,
  isWorkspaceWeekStartDay,
  type WorkspaceWeekStartDay,
} from '@mukuroji/contracts'
import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { PersonalTimesheetContainer } from '../../features/time-tracking/ui/PersonalTimesheetContainer'
import { PersonalWeeklyReportContainer } from '../../features/time-tracking/ui/PersonalWeeklyReportContainer'
import { TeamWeeklyReportsContainer } from '../../features/time-tracking/ui/TeamWeeklyReportsContainer'
import { TimeApprovalQueueContainer } from '../../features/time-tracking/ui/TimeApprovalQueueContainer'
import { TimeReportContainer } from '../../features/time-tracking/ui/TimeReportContainer'
import { TimeTrackingViewTabs, type TimeTrackingView } from '../../features/time-tracking/ui/TimeTrackingViewTabs'
import { selectIndirectTimeEntryTargets, selectTimeEntryWorkItemChoices } from '../../features/time-tracking/model/timeEntryWorkItemOptions'
import { resolveWeekStart, shiftWeek } from '../../features/time-tracking/model/timePeriod'
import { useWorkspaceCalendarSettings } from '../../workspace/queries/useWorkspaceCalendarSettings'
import { useWorkspaceTimeEntryCategories } from '../../workspace/queries/useWorkspaceTimeEntryCategories'
import { TimeEntryCategoryContext } from '../../features/time-tracking/ui/timeEntryCategoryContext'
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
 * Reads the weekday of a `YYYY-MM-DD` date.
 *
 * @param date - Date from the URL.
 * @returns The weekday, 0 (Sunday) to 6, or undefined for a missing or invalid date.
 */
function readDateWeekday(date: string | undefined): WorkspaceWeekStartDay | undefined {
  if (!date || !isWeeklyReportDate(date)) return undefined
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay()
  return isWorkspaceWeekStartDay(weekday) ? weekday : undefined
}

/**
 * Renders a Team's time tracking: the member's weekly timesheet and weekly report, the managers'
 * weekly report status and approval queue, and the Team report with its CSV export and budgets.
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
  const view: TimeTrackingView = viewParam === 'approvals' ||
    viewParam === 'report' ||
    viewParam === 'weekly-report' ||
    viewParam === 'team-weekly-reports'
    ? viewParam
    : 'timesheet'
  const reportFrom = searchParams.get('from')
  const reportTo = searchParams.get('to')
  const reportRange = useMemo(() => resolveTimeReportRange(reportFrom, reportTo), [reportFrom, reportTo])
  const reportGroupBy = resolveTimeReportGroupBy(searchParams.get('groupBy'))
  const activeTeam = workspace.teams.find((team) => team.id === teamId)
  const enabled = workspace.canLoadWorkspaceData && activeTeam !== undefined
  const accessToken = enabled ? workspace.accessToken : undefined
  const calendarSettings = useWorkspaceCalendarSettings(accessToken, enabled)
  const weekStartDay = calendarSettings.settings?.weekStartDay
  // Until the Workspace categories load, or when they fail to, the built-in categories are shown;
  // the server still refuses a category the Workspace does not offer.
  const categorySettings = useWorkspaceTimeEntryCategories(accessToken, enabled).settings ??
    DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS
  const requestedWeek = searchParams.get('week') ?? undefined
  const weekStart = resolveWeekStart(requestedWeek, undefined, weekStartDay)
  // A weekly report opened from its history keeps the week it was saved under, even when the
  // Workspace has since moved its week start to another day.
  const exactReportWeekDay = view === 'weekly-report' && searchParams.get('exactWeek') === '1'
    ? readDateWeekday(requestedWeek)
    : undefined
  const reportWeekStartDay = exactReportWeekDay ?? weekStartDay
  const reportWeekStart = exactReportWeekDay === undefined ? weekStart : resolveWeekStart(requestedWeek, undefined, exactReportWeekDay)
  // Until the week start is known, view tabs keep the requested week as is, so a provisional
  // Monday-based date never replaces it in the URL.
  const linkWeek = calendarSettings.settings ? weekStart : requestedWeek
  // Filtered on the server, so other Teams' Work Items cannot push the read past its size limit.
  const teamWorkItemFilter = useMemo(() => ({ teamId: teamId ?? '' }), [teamId])
  const workItems = useWorkspaceWorkItems(accessToken, enabled, false, teamWorkItemFilter)
  // The weekly report lists only the member's own Work Items, filtered by the server.
  const myWorkItemFilter = useMemo(() => ({ teamId: teamId ?? '', involvement: 'mine' as const }), [teamId])
  const myWorkItems = useWorkspaceWorkItems(accessToken, enabled && view === 'weekly-report', false, myWorkItemFilter)
  const projectMembers = useWorkspaceProjectMembers(
    accessToken,
    activeTeam?.id,
    activeTeam?.projects ?? emptyTeamProjects,
    enabled && (view === 'approvals' || view === 'report' || view === 'team-weekly-reports'),
  )
  const teamScope = useMemo(() => ({ kind: 'team' as const, teamId: teamId ?? '' }), [teamId])
  // The Team task-view list carries the server's effective write scopes, enterprise grants included.
  const writeAccess = useSavedTaskViews(accessToken, 'team', teamScope, enabled && view === 'timesheet')
  // Only tasks the server would accept are offered, so a manual entry is never refused for access.
  const workItemOptions = useMemo(
    () => selectTimeEntryWorkItemChoices(workItems.data ?? [], teamId ?? '', writeAccess.data?.capabilities),
    [teamId, workItems.data, writeAccess.data?.capabilities],
  )
  // Indirect work goes on a Project the member may write, or on the Team when it allows time without one.
  const indirectTargets = useMemo(() => {
    const capabilities = writeAccess.data?.capabilities
    if (!capabilities || !teamId) return undefined
    return selectIndirectTimeEntryTargets(activeTeam?.projects ?? emptyTeamProjects, teamId, capabilities)
  }, [activeTeam?.projects, teamId, writeAccess.data?.capabilities])
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
   * @param nextWeekStart - First day of the week to show; undefined shows the current week.
   */
  const open = (nextView: TimeTrackingView, nextWeekStart: string | undefined) => {
    void navigate(createTeamTimeTrackingPath(teamId ?? '', nextView, nextWeekStart), { replace: true })
  }

  /**
   * Moves the week shown; 0 returns to the current week.
   *
   * @param weeks - Weeks to move.
   */
  const moveWeek = (weeks: number) => {
    open(view, weeks === 0 ? resolveWeekStart(null, undefined, weekStartDay) : shiftWeek(weekStart, weeks, weekStartDay))
  }

  if (!teamId) return null

  /**
   * Builds the link of a view tab. While a weekly report opened at its stored week start is shown,
   * the weekly report tab keeps that week instead of moving to the Workspace week start.
   *
   * @param candidate - View the tab opens.
   * @returns The tab's path.
   */
  const tabHref = (candidate: TimeTrackingView) => {
    if (candidate === 'report') {
      return createTeamTimeTrackingPath(teamId, 'report', undefined, { ...reportRange, groupBy: reportGroupBy })
    }
    if (candidate === 'weekly-report' && exactReportWeekDay !== undefined) {
      return createTeamTimeTrackingPath(teamId, 'weekly-report', reportWeekStart, undefined, true)
    }
    return createTeamTimeTrackingPath(teamId, candidate, linkWeek)
  }

  return (
    <WorkspaceRouteContent sessionErrors={[workItems.error, myWorkItems.error, writeAccess.error, projectMembers.error, calendarSettings.error]}>
      <TimeEntryCategoryContext value={categorySettings}>
        <div className="grid min-w-0 gap-4 px-[clamp(16px,3vw,34px)] py-5">
          <TimeTrackingViewTabs
            getHref={tabHref}
            onSelect={(candidate) => { void navigate(tabHref(candidate), { replace: true }) }}
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
          ) : !calendarSettings.settings ? (
            calendarSettings.error ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
                <span>{t('timeTracking.page.calendarSettingsError')}</span>
                <button
                  className="workbench-button-secondary min-h-8 px-3"
                  onClick={calendarSettings.retry}
                  type="button"
                >
                  {t('timeTracking.page.calendarSettingsRetry')}
                </button>
              </div>
            ) : (
              // Weekly views are laid out only once the Workspace week start is known.
              <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">
                {t('timeTracking.page.calendarSettingsLoading')}
              </p>
            )
          ) : view === 'weekly-report' ? (
            <PersonalWeeklyReportContainer
              accessToken={accessToken}
              hasWorkItemError={Boolean(myWorkItems.error)}
              key={`${teamId}:weekly-report:${reportWeekStart}`}
              locale={workspace.locale}
              memberKey={workspace.userKey}
              onMoveWeek={moveWeek}
              onOpenWeek={(nextWeekStart) => {
                void navigate(createTeamTimeTrackingPath(teamId, 'weekly-report', nextWeekStart, undefined, true), { replace: true })
              }}
              onRetryWorkItems={() => { void myWorkItems.mutate().catch(() => undefined) }}
              teamId={teamId}
              weekStart={reportWeekStart}
              weekStartDay={reportWeekStartDay ?? calendarSettings.settings.weekStartDay}
              workItems={myWorkItems.data}
              workItemTitles={workItemTitles}
            />
          ) : view === 'team-weekly-reports' ? (
            <TeamWeeklyReportsContainer
              accessToken={accessToken}
              key={`${teamId}:team-weekly-reports:${weekStart}`}
              locale={workspace.locale}
              memberNames={memberNames}
              onMoveWeek={moveWeek}
              teamId={teamId}
              weekStart={weekStart}
              weekStartDay={calendarSettings.settings.weekStartDay}
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
              weekStartDay={calendarSettings.settings.weekStartDay}
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
              weekStartDay={calendarSettings.settings.weekStartDay}
              isLoadingWorkItemOptions={isLoadingWorkItemOptions}
              {...(indirectTargets ? { indirectTargets } : {})}
              workItemOptions={workItemOptions}
              workItemTitles={workItemTitles}
            />
          )}
        </div>
      </TimeEntryCategoryContext>
    </WorkspaceRouteContent>
  )
}
