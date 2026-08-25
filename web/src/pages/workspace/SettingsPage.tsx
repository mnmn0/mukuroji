import { useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { AutomationManagementPanelContainer } from '../../automation/ui/AutomationManagementPanelContainer'
import { DeveloperPlatformSettingsPanelContainer } from '../../developer-platform/ui/DeveloperPlatformSettingsPanelContainer'
import { AiAssistanceSettingsPanelContainer } from '../../features/ai-assistance/ui'
import { NotificationSettingsPanelContainer } from '../../notifications/ui/NotificationSettingsPanelContainer'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkItemConfigurationPanelContainer } from '../../work-items/ui/WorkItemConfigurationPanelContainer'
import { WorkspaceAccessPanelContainer } from '../../workspace/ui/WorkspaceAccessPanel'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'
import { WorkspaceSettingsView } from '../../workspace/ui/WorkspaceSettingsView'
import { TenantAdministrationPanelContainer } from '../../workspace/ui/TenantAdministrationPanel'

/**
 * Renders the URL-specific Workspace settings route.
 *
 * @returns Settings content rendered inside the shared Workspace shell.
 */
export function SettingsPage() {
  const workspace = useWorkspaceRouteContext()
  const [searchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const developerPlatformInitialSection =
    searchParams.get('developerSection') === 'connectors'
      ? 'connectors'
      : undefined

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceSettingsView
          configurationSections={workspace.accessToken ? (
            <>
              <AiAssistanceSettingsPanelContainer
                accessToken={workspace.accessToken}
                canManagePolicy={workspace.canManageWorkspaceConfiguration}
                locale={workspace.locale}
              />
              <WorkspaceAccessPanelContainer
                accessToken={workspace.accessToken}
                locale={workspace.locale}
              />
              {workspace.canManageWorkspaceConfiguration ? (
                <TenantAdministrationPanelContainer
                  accessToken={workspace.accessToken}
                  locale={workspace.locale}
                />
              ) : null}
              <DeveloperPlatformSettingsPanelContainer
                accessToken={workspace.accessToken}
                initialSection={developerPlatformInitialSection}
                locale={workspace.locale}
                teams={workspace.teams}
              />
              <WorkItemConfigurationPanelContainer
                accessToken={workspace.accessToken}
                canManageWorkspaceConfiguration={
                  workspace.canManageWorkspaceConfiguration
                }
                canMutateTeamConfiguration={workspace.canMutateTeamConfiguration}
                locale={workspace.locale}
                teams={workspace.teams}
              />
              <AutomationManagementPanelContainer
                accessToken={workspace.accessToken}
                canManage={workspace.canManageWorkspaceConfiguration}
                locale={workspace.locale}
                teams={[...workspace.teams]}
              />
            </>
          ) : undefined}
          fontSizePreference={workspace.fontSizePreference}
          locale={workspace.locale}
          notificationSettingsSection={workspace.accessToken ? (
            <NotificationSettingsPanelContainer
              accessToken={workspace.accessToken}
              locale={workspace.locale}
              onSessionError={workspace.reportNotificationPreferencesError}
            />
          ) : undefined}
          onFontSizePreferenceChange={workspace.onFontSizePreferenceChange}
          onLocaleChange={workspace.onLocaleChange}
          t={t}
          userLabel={workspace.userLabel}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
