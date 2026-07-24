import { useMemo } from 'react'
import { useNotificationInbox } from '../../notifications/mutations/useNotifications'
import { WorkspaceInboxView } from '../../notifications/ui/WorkspaceInboxView'
import { createTranslator } from '../../shared/i18n/i18n'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import { WorkspaceTaskLoadNotice } from '../../workspace/ui/WorkspaceDataNotices'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the URL-specific Inbox route with durable notifications and Work Item attention.
 *
 * @returns Inbox content rendered inside the shared Workspace shell.
 */
export function InboxPage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const notificationInbox = useNotificationInbox(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
    workspace.teams,
  )
  // Keep durable notifications available while the independent Work Item feed loads.
  const isLoading = Boolean(
    workItems.configurationsKey && workItems.isConfigurationsLoading,
  )

  return (
    <WorkspaceRouteContent
      isLoading={isLoading}
      sessionErrors={[
        workItems.workItemsError,
        workItems.configurationsError,
        ...workItems.configurationErrors,
        ...(notificationInbox.sessionErrors ?? []),
      ]}
    >
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice failedProjectCount={workItems.failedProjectCount} t={t} />
        <WorkspaceInboxView
          locale={workspace.locale}
          notificationInbox={notificationInbox}
          onOpenNotification={workspace.onOpenNotification}
          onOpenTask={workspace.onOpenTask}
          t={t}
          tasks={workItems.tasks}
          teams={workspace.teams}
          workItemConfigurationsByTeam={workItems.configurationsByTeam}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
