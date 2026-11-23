import type { WorkspaceMember } from '../../workspace/api/access'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import {
  createCrossProjectWorkItemJobRoleOptions,
  createCrossProjectWorkItemMemberOptions,
  createCrossProjectWorkItemProjectOptions,
  createCrossProjectWorkItemServerFilter,
  filterCrossProjectWorkItems,
  groupCrossProjectWorkItems,
  type CrossProjectWorkItemListState,
} from '../../features/cross-project-work-items/model/crossProjectWorkItems'
import {
  createCrossProjectWorkItemBuiltInDefinition,
  crossProjectWorkItemStateToTaskViewDefinition,
  crossProjectWorkItemTaskViewFields,
  crossProjectWorkItemTaskViewLayoutModes,
  crossProjectWorkItemTaskViewScope,
  readLegacyCrossProjectWorkItemState,
  removeLegacyCrossProjectWorkItemParams,
  taskViewDefinitionToCrossProjectWorkItemState,
} from '../../features/cross-project-work-items/model/crossProjectWorkItemTaskView'
import { CrossProjectWorkItemList } from '../../features/cross-project-work-items/ui/CrossProjectWorkItemList'
import { createTranslator } from '../../shared/i18n/i18n'
import { useTaskViewController } from '../../task-views/mutations/useTaskViewController'
import { taskViewDefinitionToPresentationSettings } from '../../task-views/model/taskViewSurfaceState'
import { TaskViewToolbar } from '../../task-views/ui/TaskViewToolbar'
import {
  createTaskViewOption,
  formatTaskViewMigrationWarning,
} from '../../task-views/ui/taskViewToolbarAdapter'
import { createWorkspaceTaskScheduleCalendarPolicy } from '../../tasks/model/taskSchedule'
import { useWorkspaceAccess } from '../../workspace/queries/useWorkspaceAccess'
import {
  useWorkspaceCalendarSettings,
  workspaceCalendarErrorMessageKey,
} from '../../workspace/queries/useWorkspaceCalendarSettings'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import {
  WorkspaceConfigurationLoadNotice,
  WorkspaceTaskLoadNotice,
} from '../../workspace/ui/WorkspaceDataNotices'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

const emptyWorkspaceMembers: WorkspaceMember[] = []
const builtInTaskViewDefinition = createCrossProjectWorkItemBuiltInDefinition()
const taskViewCapabilities = {
  columns: ['title'],
  fields: crossProjectWorkItemTaskViewFields,
  layoutModes: crossProjectWorkItemTaskViewLayoutModes,
  requiredColumns: ['title'],
  workflowStatuses: [],
}

/**
 * Renders the Workspace-wide Work Item list across every Project the viewer can read.
 *
 * Work Items come from the permission-filtered `GET /api/work-items`, so a shared URL or saved
 * view only shows what each viewer may read. Filters, grouping, and layout form a task view of the
 * `work-items` surface: it can be saved on the server, shared with a Team or the Workspace, and
 * temporary changes live in the URL.
 *
 * @returns The cross-Project Work Item list inside the shared Workspace shell.
 */
export function WorkItemsPage() {
  const workspace = useWorkspaceRouteContext()
  const [searchParams, setSearchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const taskViewController = useTaskViewController({
    accessToken: workspace.accessToken,
    builtInDefinition: builtInTaskViewDefinition,
    capabilities: taskViewCapabilities,
    enabled: workspace.canLoadWorkspaceData,
    onSearchParamsChange: (nextSearchParams) => {
      setSearchParams(removeLegacyCrossProjectWorkItemParams(nextSearchParams), { replace: true })
    },
    scope: crossProjectWorkItemTaskViewScope,
    searchParams,
    surface: 'work-items',
  })
  const { effectiveDefinition, isLoading: isTaskViewLoading, setEffectiveDefinition } = taskViewController
  // A link from before saved views carries the list state in its own parameters. Whenever the URL
  // has them, the list renders that state, and the parameters are rewritten into a temporary change
  // of the current view so the URL keeps one source of truth.
  const legacyState = useMemo(() => readLegacyCrossProjectWorkItemState(searchParams), [searchParams])
  const state = useMemo(
    () => legacyState ?? taskViewDefinitionToCrossProjectWorkItemState(effectiveDefinition),
    [effectiveDefinition, legacyState],
  )
  // Rewriting the URL syncs the browser location, an external system. It runs for every URL that
  // still has the older parameters, including one reached by Back/Forward, and ends once they leave.
  // Each such URL is rewritten once, so renders before the rewrite lands do not queue more of them.
  const convertedLegacySearch = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!legacyState) {
      convertedLegacySearch.current = undefined
      return
    }
    // The rewrite waits for the saved views, so it layers over the default view the viewer gets.
    if (isTaskViewLoading) return
    const search = searchParams.toString()
    if (convertedLegacySearch.current === search) return
    convertedLegacySearch.current = search
    setEffectiveDefinition(
      crossProjectWorkItemStateToTaskViewDefinition(legacyState, effectiveDefinition),
    )
  }, [effectiveDefinition, isTaskViewLoading, legacyState, searchParams, setEffectiveDefinition])
  const serverFilter = useMemo(() => createCrossProjectWorkItemServerFilter(state), [state])
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
    workspace.teams,
    false,
    serverFilter,
  )
  // Only the Gantt chart shades the Workspace days off and follows its weeks and fiscal quarters,
  // so the calendar is read for that layout.
  const workspaceCalendar = useWorkspaceCalendarSettings(
    workspace.accessToken,
    workspace.canLoadWorkspaceData && state.layout === 'gantt',
  )
  const workspaceCalendarErrorKey = workspaceCalendarErrorMessageKey(workspaceCalendar)
  const workingCalendar = useMemo(
    // A failed read falls back to the default calendar, as on My Tasks.
    () => workspaceCalendar.settings || workspaceCalendar.error
      ? createWorkspaceTaskScheduleCalendarPolicy(workspaceCalendar.settings)
      : undefined,
    [workspaceCalendar.settings, workspaceCalendar.error],
  )
  const workspaceAccess = useWorkspaceAccess(workspace.accessToken, workspace.canLoadWorkspaceData)
  const members = workspaceAccess.data?.members ?? emptyWorkspaceMembers
  const memberLabels = useMemo(
    () => new Map(members.map((member) => [member.memberKey, member.name ?? member.email])),
    [members],
  )
  const filteredWorkItems = useMemo(
    () => filterCrossProjectWorkItems(workItems.tasks, state, workspace.userIdentityAliases),
    [state, workItems.tasks, workspace.userIdentityAliases],
  )
  const groups = useMemo(
    () => groupCrossProjectWorkItems(filteredWorkItems, state.grouping, workspace.teams),
    [filteredWorkItems, state.grouping, workspace.teams],
  )
  const projectOptions = useMemo(
    () => createCrossProjectWorkItemProjectOptions(workspace.teams),
    [workspace.teams],
  )
  const memberOptions = useMemo(
    () => createCrossProjectWorkItemMemberOptions(workItems.tasks, memberLabels, state.contributorMemberId),
    [memberLabels, state.contributorMemberId, workItems.tasks],
  )
  const jobRoleOptions = useMemo(
    () => createCrossProjectWorkItemJobRoleOptions(
      workItems.tasks,
      workItems.configurationsByTeam,
      workspace.teams,
      state.contributorJobRole,
    ),
    [state.contributorJobRole, workItems.configurationsByTeam, workItems.tasks, workspace.teams],
  )
  const changeState = useCallback((next: CrossProjectWorkItemListState) => {
    setEffectiveDefinition(crossProjectWorkItemStateToTaskViewDefinition(next, effectiveDefinition))
  }, [effectiveDefinition, setEffectiveDefinition])
  const taskViewTeams = useMemo(() => {
    const writableTeamIds = new Set(taskViewController.writableTeamIds)
    return workspace.teams
      .filter((team) => writableTeamIds.has(team.id))
      .map((team) => ({ id: team.id, name: team.name }))
  }, [taskViewController.writableTeamIds, workspace.teams])

  return (
    // The list shows its own loading state, so changing a filter keeps the toolbar mounted.
    <WorkspaceRouteContent
      sessionErrors={[
        workItems.workItemsError,
        workItems.configurationsError,
        ...workItems.configurationErrors,
        workspaceAccess.error,
      ]}
    >
      <div className="grid gap-4 px-[clamp(16px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice
          error={workItems.workItemsError}
          failedProjectCount={workItems.failedProjectCount}
          t={t}
        />
        <WorkspaceConfigurationLoadNotice
          failedTeamCount={workItems.configurationFailedTeamIds.length}
          onRetry={() => void workItems.mutateConfigurations()}
          t={t}
          testId="work-items-configuration-error"
        />
        {workspaceCalendarErrorKey ? (
          // The Gantt chart falls back to the default calendar, so the notice says why the days off
          // may differ and offers a retry, as on My Tasks.
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-warning-border)] bg-[var(--workbench-warning-surface)] px-4 py-3"
            data-testid="work-items-workspace-calendar-error"
            role="alert"
          >
            <p className="text-sm font-semibold text-[var(--workbench-warning)]">{t(workspaceCalendarErrorKey)}</p>
            <button className="workbench-button-secondary min-h-9 px-3" onClick={workspaceCalendar.retry} type="button">
              {t('tasks.workspaceCalendar.retry')}
            </button>
          </div>
        ) : null}
        <TaskViewToolbar
          builtInName={t('workItems.crossProject.builtInView')}
          canManageShared={taskViewController.canManageShared}
          canWrite={taskViewController.canWrite}
          columnOptions={[]}
          errorMessage={taskViewController.errorMessage}
          groupOptions={[]}
          isDirty={taskViewController.isDirty}
          isSaving={taskViewController.isSaving}
          migrationWarnings={taskViewController.migrationWarnings.map(formatTaskViewMigrationWarning)}
          onCopyLink={taskViewController.copyPermalink}
          onDelete={taskViewController.deleteView}
          onDuplicate={taskViewController.duplicateView}
          onPatchPreference={taskViewController.patchPreference}
          onReset={taskViewController.resetOverrides}
          onSaveAs={taskViewController.saveAs}
          onSelectView={taskViewController.selectView}
          onSettingsChange={() => undefined}
          onUpdate={taskViewController.updateActiveView}
          selectedView={taskViewController.activeSavedView
            ? createTaskViewOption(taskViewController.activeSavedView)
            : undefined}
          settings={taskViewDefinitionToPresentationSettings(effectiveDefinition)}
          supportsSettings={false}
          t={t}
          teams={taskViewTeams}
          views={taskViewController.views.map(createTaskViewOption)}
        />
        <CrossProjectWorkItemList
          configurationsByTeam={workItems.configurationsByTeam}
          groups={groups}
          isLoading={workItems.isWorkItemsLoading}
          loadFailed={Boolean(workItems.workItemsError)}
          jobRoleOptions={jobRoleOptions}
          memberLabels={memberLabels}
          memberOptions={memberOptions}
          onChangeState={changeState}
          onOpenWorkItem={workspace.onOpenTask}
          onRetry={() => void workItems.mutateWorkItems()}
          projectOptions={projectOptions}
          state={state}
          t={t}
          teams={workspace.teams}
          totalCount={filteredWorkItems.length}
          workingCalendar={workingCalendar}
          calendarPeriods={workspaceCalendar.settings}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
