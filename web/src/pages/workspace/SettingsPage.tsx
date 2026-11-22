import { useMemo, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { aiAssistanceUiEnabled } from '../../features/ai-assistance/model/aiAssistanceRollout'
import { AutomationManagementPanelContainer } from '../../automation/ui/AutomationManagementPanelContainer'
import { DeveloperPlatformSettingsPanelContainer } from '../../developer-platform/ui/DeveloperPlatformSettingsPanelContainer'
import { AccountSecurityPanelContainer } from '../../features/account-security/ui/AccountSecurityPanel'
import { AuditLogPanelContainer } from '../../features/audit-log/ui/AuditLogPanelContainer'
import { AgentSettingsPanelContainer } from '../../features/agent-settings/ui/AgentSettingsPanelContainer'
import { AiAssistanceSettingsPanelContainer } from '../../features/ai-assistance/ui'
import { NotificationSettingsPanelContainer } from '../../notifications/ui/NotificationSettingsPanelContainer'
import { DirectoryAdministrationPanelContainer } from '../../projects/ui/DirectoryAdministrationPanel'
import { createTranslator } from '../../shared/i18n/i18n'
import { useAppBadgePermission } from '../../shared/lib/pwa/badgePermission'
import { useAppInstallPrompt } from '../../shared/lib/pwa/installPrompt'
import { AppInstallCard } from '../../shared/ui/AppInstallCard'
import { WorkItemConfigurationPanelContainer } from '../../work-items/ui/WorkItemConfigurationPanelContainer'
import { WorkItemKeyPrefixPanelContainer } from '../../work-items/ui/WorkItemKeyPrefixPanelContainer'
import { WorkspaceAccessPanelContainer } from '../../workspace/ui/WorkspaceAccessPanel'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'
import { resolveSettingsSection } from '../../workspace/model/settingsSections'
import { EnterpriseSecuritySettingsLink } from '../../workspace/ui/EnterpriseSecuritySettingsLink'
import { SettingsSectionNav } from '../../workspace/ui/SettingsSectionNav'
import { WorkspaceSettingsView } from '../../workspace/ui/WorkspaceSettingsView'
import { TenantAdministrationPanelContainer } from '../../workspace/ui/TenantAdministrationPanel'

/**
 * Renders the settings routes: `/settings` and `/settings/personal` for personal settings,
 * `/settings/workspace` for Workspace administration, and `/settings/team` for Team settings.
 *
 * @returns Settings content for the area in the URL, inside the shared Workspace shell.
 */
export function SettingsPage() {
  const workspace = useWorkspaceRouteContext()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const section = resolveSettingsSection(location.pathname, location.search)
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const appInstall = useAppInstallPrompt()
  const badgePermission = useAppBadgePermission()
  const [installOutcome, setInstallOutcome] = useState<'accepted' | 'dismissed' | 'failed'>()
  const developerPlatformInitialSection =
    searchParams.get('developerSection') === 'connectors'
      ? 'connectors'
      : undefined

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <SettingsSectionNav current={section} t={t} />
        {section === 'personal' ? (
          <WorkspaceSettingsView
            showAgentConnection={workspace.softwareFactoryEnabled}
            accountSections={workspace.accessToken ? (
              <>
                <AccountSecurityPanelContainer
                  accessToken={workspace.accessToken}
                  locale={workspace.locale}
                />
                {aiAssistanceUiEnabled ? (
                  <AiAssistanceSettingsPanelContainer
                    accessToken={workspace.accessToken}
                    canManagePolicy={workspace.canManageAiAssistance}
                    cacheScope={workspace.userKey ?? workspace.userIdentityAliases.at(-1)}
                    guardRequest={workspace.guardEnterpriseSession}
                    locale={workspace.locale}
                    workspaceId={workspace.workspaceId}
                  />
                ) : null}
              </>
            ) : undefined}
            appInstallSection={(
              <AppInstallCard
                badgePermission={{
                  offered: badgePermission.offered,
                  pending: badgePermission.pending,
                  blocked: badgePermission.blocked,
                  ...(badgePermission.result ? { result: badgePermission.result } : {}),
                  description: t('workspace.settings.install.badge.description'),
                  actionLabel: t('workspace.settings.install.badge.action'),
                  pendingLabel: t('workspace.settings.install.badge.pending'),
                  grantedMessage: t('workspace.settings.install.badge.granted'),
                  deniedMessage: t('workspace.settings.install.badge.denied'),
                  dismissedMessage: t('workspace.settings.install.badge.dismissed'),
                  unsupportedMessage: t('workspace.settings.install.badge.unsupported'),
                  onRequest: badgePermission.request,
                }}
                acceptedMessage={t('workspace.settings.install.accepted')}
                description={t('workspace.settings.install.description')}
                dismissedMessage={t('workspace.settings.install.dismissed')}
                failedMessage={t('workspace.settings.install.failed')}
                installedMessage={t('workspace.settings.install.installed')}
                installLabel={t('workspace.settings.install.action')}
                outcome={installOutcome}
                pendingLabel={t('workspace.settings.install.pending')}
                status={appInstall.status}
                title={t('workspace.settings.install.title')}
                onInstall={() => {
                  // The previous result stays announced, even after a new install offer, until the next attempt.
                  setInstallOutcome(undefined)
                  void appInstall.install().then((outcome) => {
                    if (outcome !== 'unavailable') setInstallOutcome(outcome)
                  })
                }}
              />
            )}
            fontSizePreference={workspace.fontSizePreference}
            themePreference={workspace.themePreference}
            timeZone={workspace.timeZone}
            locale={workspace.locale}
            notificationSettingsSection={workspace.accessToken ? (
              <NotificationSettingsPanelContainer
                accessToken={workspace.accessToken}
                locale={workspace.locale}
                guardRequest={workspace.guardEnterpriseSession}
                onSessionError={workspace.reportNotificationPreferencesError}
              />
            ) : undefined}
            onFontSizePreferenceChange={workspace.onFontSizePreferenceChange}
            onThemePreferenceChange={workspace.onThemePreferenceChange}
            onLocaleChange={workspace.onLocaleChange}
            onTimeZoneChange={workspace.onTimeZoneChange}
            isPreferencesSaveFailed={workspace.isMemberPreferencesSaveFailed}
            onRetryPreferencesSave={workspace.onRetryMemberPreferencesSave}
            t={t}
            userLabel={workspace.userLabel}
          />
        ) : null}
        {section === 'workspace' ? (
          <>
            <EnterpriseSecuritySettingsLink t={t} />
            {workspace.accessToken ? (
              <>
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
                {workspace.canManageWorkspaceConfiguration ? (
                  <DirectoryAdministrationPanelContainer
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
                <AutomationManagementPanelContainer
                  accessToken={workspace.accessToken}
                  canManage={workspace.canManageWorkspaceConfiguration}
                  locale={workspace.locale}
                  teams={[...workspace.teams]}
                />
                {workspace.canReadAuditLog || workspace.canExportAuditLog ? (
                  <AuditLogPanelContainer
                    accessToken={workspace.accessToken}
                    canExport={workspace.canExportAuditLog}
                    canSearch={workspace.canReadAuditLog}
                    guardRequest={workspace.guardEnterpriseSession}
                    locale={workspace.locale}
                    timeZone={workspace.timeZone}
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
        {section === 'team' && workspace.accessToken ? (
          <>
            <WorkItemConfigurationPanelContainer
              accessToken={workspace.accessToken}
              canManageWorkspaceConfiguration={
                workspace.canManageWorkspaceConfiguration
              }
              canMutateTeamConfiguration={workspace.canMutateTeamConfiguration}
              locale={workspace.locale}
              teams={workspace.teams}
            />
            <WorkItemKeyPrefixPanelContainer
              accessToken={workspace.accessToken}
              locale={workspace.locale}
              teams={workspace.teams}
            />
            {workspace.softwareFactoryEnabled ? (
              <AgentSettingsPanelContainer
                accessToken={workspace.accessToken}
                canMutateTeamConfiguration={workspace.canMutateTeamConfiguration}
                locale={workspace.locale}
                teams={workspace.teams}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </WorkspaceRouteContent>
  )
}
