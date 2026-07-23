import { useMemo } from 'react'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  getUniqueWorkspaceProjectIds,
  isWorkspaceTaskAssignedToUser,
} from '../../work-items/model/workspaceWorkItems'
import { useWorkspaceTaskStatusMutation } from '../../workspace/mutations/useWorkspaceTaskStatusMutation'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import {
  WorkspaceConfigurationLoadNotice,
  WorkspaceTaskLoadNotice,
} from '../../workspace/ui/WorkspaceDataNotices'
import { MyTasksWorkspaceView } from '../../workspace/ui/MyTasksWorkspaceView'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the URL-specific My Tasks route and owns its status mutation controller.
 *
 * @returns My Tasks content rendered inside the shared Workspace shell.
 */
export function MyTasksPage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  const myTasks = useMemo(
    () => workItems.tasks.filter((task) => isWorkspaceTaskAssignedToUser(
      task,
      workspace.userIdentityAliases,
    )),
    [workItems.tasks, workspace.userIdentityAliases],
  )
  const statusMutation = useWorkspaceTaskStatusMutation({
    accessToken: workspace.accessToken,
    configurationsByTeam: workItems.configurationsByTeam,
    enabled: workspace.canMutateTeamConfiguration,
    guardAuthenticatedRequest: workspace.guardEnterpriseSession,
    mutateWorkItems: workItems.mutateWorkItems,
    t,
    tasks: workItems.tasks,
  })
  const failedProjectCount = workItems.workItemsError
    ? getUniqueWorkspaceProjectIds(workspace.teams).length
    : 0
  const isLoading = Boolean(
    workItems.workItemsKey && workItems.isWorkItemsLoading,
  ) || Boolean(
    workItems.configurationsKey && workItems.isConfigurationsLoading,
  )

  return (
    <WorkspaceRouteContent
      isLoading={isLoading}
      sessionErrors={[
        workItems.workItemsError,
        workItems.configurationsError,
        ...workItems.configurationErrors,
      ]}
    >
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice failedProjectCount={failedProjectCount} t={t} />
        <WorkspaceConfigurationLoadNotice
          failedTeamCount={workItems.configurationFailedTeamIds.length}
          onRetry={() => void workItems.mutateConfigurations()}
          t={t}
        />
        <MyTasksWorkspaceView
          configurationFailedTeamIds={workItems.configurationFailedTeamIds}
          configurationsByTeam={workItems.configurationsByTeam}
          onMoveTaskStatus={statusMutation.moveTaskStatus}
          onOpenTask={workspace.onOpenTask}
          t={t}
          taskMoveErrorMessage={statusMutation.errorMessage}
          tasks={myTasks}
          teams={workspace.teams}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
