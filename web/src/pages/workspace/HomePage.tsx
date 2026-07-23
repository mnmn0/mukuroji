import { useMemo } from 'react'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  createWorkspaceSummary,
  getUniqueWorkspaceProjectIds,
} from '../../work-items/model/workspaceWorkItems'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import { WorkspaceTaskLoadNotice } from '../../workspace/ui/WorkspaceDataNotices'
import { HomeWorkspaceView } from '../../workspace/ui/HomeWorkspaceView'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the URL-specific Workspace home route.
 *
 * @returns Home content rendered inside the shared Workspace shell.
 */
export function HomePage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  const summary = useMemo(
    () => createWorkspaceSummary(workspace.teams, workItems.tasks),
    [workItems.tasks, workspace.teams],
  )
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
        <WorkspaceTaskLoadNotice
          failedProjectCount={failedProjectCount}
          t={t}
        />
        <HomeWorkspaceView
          onOpenTask={workspace.onOpenTask}
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
