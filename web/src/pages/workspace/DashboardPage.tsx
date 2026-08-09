import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { usePlanningSnapshot } from '../../planning/queries/usePlanningSnapshot'
import { createTranslator } from '../../shared/i18n/i18n'
import { createPlanningProjectUpdatePath } from '../../shared/routing/paths'
import { createWorkspaceSummary } from '../../work-items/model/workspaceWorkItems'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import { DashboardWorkspaceView } from '../../workspace/ui/DashboardWorkspaceView'
import { WorkspaceTaskLoadNotice } from '../../workspace/ui/WorkspaceDataNotices'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the URL-specific Workspace dashboard route.
 *
 * @returns Dashboard content rendered inside the shared Workspace shell.
 */
export function DashboardPage() {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
    workspace.teams,
  )
  const summary = useMemo(
    () => createWorkspaceSummary(workspace.teams, workItems.tasks),
    [workItems.tasks, workspace.teams],
  )
  const planning = usePlanningSnapshot(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  return (
    <WorkspaceRouteContent
      isLoading={workItems.isLoading || Boolean(planning.key && planning.isLoading)}
      sessionErrors={[
        workItems.workItemsError,
        workItems.configurationsError,
        ...workItems.configurationErrors,
      ]}
    >
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice failedProjectCount={workItems.failedProjectCount} t={t} />
        <DashboardWorkspaceView
          onOpenPlanningUpdate={(teamId, projectId) => navigate(
            createPlanningProjectUpdatePath(teamId, projectId),
          )}
          onOpenTask={workspace.onOpenTask}
          planningUpdateTargets={planning.data?.updateTargets}
          planningUpdatesErrorMessage={planning.error
            ? t('workspace.planningUpdate.error.loading')
            : undefined}
          summary={summary}
          t={t}
          tasks={workItems.tasks}
          teams={workspace.teams}
          workItemConfigurationsByTeam={workItems.configurationsByTeam}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
