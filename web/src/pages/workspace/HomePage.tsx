import { useMemo } from 'react'
import { useWorkspaceFocusOverview } from '../../features/focus-queue/queries/useWorkspaceFocusOverview'
import { createTranslator } from '../../shared/i18n/i18n'
import { createWorkspaceSummary } from '../../work-items/model/workspaceWorkItems'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import {
  WorkspaceFocusLoadNotice,
  WorkspaceTaskLoadNotice,
} from '../../workspace/ui/WorkspaceDataNotices'
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
    workspace.teams,
  )
  const focus = useWorkspaceFocusOverview(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  const summary = useMemo(
    () => createWorkspaceSummary(
      workspace.teams,
      workItems.tasks,
      focus.blockedCount,
    ),
    [focus.blockedCount, workItems.tasks, workspace.teams],
  )
  return (
    <WorkspaceRouteContent
      isLoading={workItems.isLoading || focus.isLoading}
      sessionErrors={[
        workItems.workItemsError,
        workItems.configurationsError,
        ...workItems.configurationErrors,
      ]}
    >
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice
          failedProjectCount={workItems.failedProjectCount}
          t={t}
        />
        <WorkspaceFocusLoadNotice {...focus.noticeProps} t={t} />
        <HomeWorkspaceView
          focusQueue={focus.response}
          isFocusUnavailable={focus.isUnavailable}
          onOpenTask={workspace.onOpenTask}
          summary={summary}
          t={t}
          teams={workspace.teams}
          workItemConfigurationsByTeam={workItems.configurationsByTeam}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
