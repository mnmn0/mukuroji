import { useMemo, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { aiAssistanceUiEnabled } from '../../features/ai-assistance/model/aiAssistanceRollout'
import { AutomationManagementPanelContainer } from '../../automation/ui/AutomationManagementPanelContainer'
import { TeamAutomationPanelContainer } from '../../automation/ui/TeamAutomationPanelContainer'
import { DeveloperPlatformSettingsPanelContainer } from '../../developer-platform/ui/DeveloperPlatformSettingsPanelContainer'
import { AccountSecurityPanelContainer } from '../../features/account-security/ui/AccountSecurityPanel'
import { AuditLogPanelContainer } from '../../features/audit-log/ui/AuditLogPanelContainer'
import { CalendarFeedsPanelContainer } from '../../features/calendar-feeds/ui/CalendarFeedsPanelContainer'
import { resolveBrowserTimeZone } from '../../features/time-tracking/model/timePeriod'
import { WorkspaceTimePeriodContainer } from '../../features/time-tracking/ui/WorkspaceTimePeriodContainer'
import { AgentSettingsPanelContainer } from '../../features/agent-settings/ui/AgentSettingsPanelContainer'
import { AiAssistanceSettingsPanelContainer } from '../../features/ai-assistance/ui'
import { NotificationSettingsPanelContainer } from '../../notifications/ui/NotificationSettingsPanelContainer'
import { DirectoryAdministrationPanelContainer } from '../../projects/ui/DirectoryAdministrationPanel'
import { OrgStructurePanelContainer } from '../../projects/ui/OrgStructurePanel'
import { TeamProfilePanelContainer } from '../../projects/ui/TeamProfilePanel'
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
import { SettingsSectionNav, type SettingsPanelLink } from '../../workspace/ui/SettingsSectionNav'
import { MemberProfileSectionContainer } from '../../workspace/ui/MemberProfileSection'
import { SettingsPanelAnchor } from '../../workspace/ui/SettingsPanelAnchor'
import { useSettingsPanelScroll } from '../../workspace/ui/useSettingsPanelScroll'
import { WorkspaceSettingsView } from '../../workspace/ui/WorkspaceSettingsView'
import { TenantAdministrationPanelContainer } from '../../workspace/ui/TenantAdministrationPanel'
import { WorkCalendarPanelContainer } from '../../workspace/ui/WorkCalendarPanelContainer'
import { WorkspaceWorkCalendarAdjustment } from '../../workspace/ui/WorkspaceWorkCalendarAdjustment'

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
  useSettingsPanelScroll(location.hash, location.key)
  const developerPlatformInitialSection =
    searchParams.get('developerSection') === 'connectors'
      ? 'connectors'
      : undefined

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <SettingsSectionNav
          current={section}
          panels={listSettingsPanels(section, {
            accessToken: Boolean(workspace.accessToken),
            aiAssistance: aiAssistanceUiEnabled,
            auditLog: workspace.canReadAuditLog || workspace.canExportAuditLog,
            workspaceConfiguration: workspace.canManageWorkspaceConfiguration,
            softwareFactory: workspace.softwareFactoryEnabled,
            teamManagement: workspace.canManageTeams,
            workspaceTimePeriods: workspace.canManageWorkspaceTimePeriods,
          })}
          t={t}
        />
        {section === 'personal' ? (
          <WorkspaceSettingsView
            accountSections={workspace.accessToken ? (
              <>
                <SettingsPanelAnchor panel="account-security">
                  <AccountSecurityPanelContainer
                    accessToken={workspace.accessToken}
                    locale={workspace.locale}
                  />
                </SettingsPanelAnchor>
                {aiAssistanceUiEnabled ? (
                  <SettingsPanelAnchor panel="ai-assistance">
                  <AiAssistanceSettingsPanelContainer
                    accessToken={workspace.accessToken}
                    canManagePolicy={workspace.canManageAiAssistance}
                    cacheScope={workspace.userKey ?? workspace.userIdentityAliases.at(-1)}
                    guardRequest={workspace.guardEnterpriseSession}
                    locale={workspace.locale}
                    workspaceId={workspace.workspaceId}
                  />
                  </SettingsPanelAnchor>
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
            calendarFeedsSection={workspace.accessToken ? (
              <CalendarFeedsPanelContainer
                accessToken={workspace.accessToken}
                locale={workspace.locale}
                teams={workspace.teams}
              />
            ) : undefined}
            fontSizePreference={workspace.fontSizePreference}
            themePreference={workspace.themePreference}
            timeZone={workspace.timeZone}
            locale={workspace.locale}
            notificationSettingsSection={workspace.accessToken ? (
              <NotificationSettingsPanelContainer
                accessToken={workspace.accessToken}
                locale={workspace.locale}
                guardRequest={workspace.guardEnterpriseSession}
                memberTimeZone={workspace.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
                muteTargets={workspace.teams}
                onSessionError={workspace.reportNotificationPreferencesError}
              />
            ) : undefined}
            onFontSizePreferenceChange={workspace.onFontSizePreferenceChange}
            onThemePreferenceChange={workspace.onThemePreferenceChange}
            onLocaleChange={workspace.onLocaleChange}
            onTimeZoneChange={workspace.onTimeZoneChange}
            profileSection={workspace.accessToken ? (
              <MemberProfileSectionContainer
                accessToken={workspace.accessToken}
                t={t}
                userLabel={workspace.userLabel}
              />
            ) : undefined}
            isPreferencesSaveFailed={workspace.isMemberPreferencesSaveFailed}
            onRetryPreferencesSave={workspace.onRetryMemberPreferencesSave}
            t={t}
            userLabel={workspace.userLabel}
          />
        ) : null}
        {section === 'workspace' ? (
          <>
            <SettingsPanelAnchor panel="enterprise-security">
              <EnterpriseSecuritySettingsLink t={t} />
            </SettingsPanelAnchor>
            {workspace.accessToken ? (
              <>
                <SettingsPanelAnchor panel="members">
                  <WorkspaceAccessPanelContainer
                    accessToken={workspace.accessToken}
                    locale={workspace.locale}
                    workspaceId={workspace.workspaceId}
                  />
                </SettingsPanelAnchor>
                {workspace.canManageWorkspaceConfiguration ? (
                  <SettingsPanelAnchor panel="tenant">
                    <TenantAdministrationPanelContainer
                      accessToken={workspace.accessToken}
                      locale={workspace.locale}
                    />
                    <WorkspaceWorkCalendarAdjustment
                      accessToken={workspace.accessToken}
                      locale={workspace.locale}
                    />
                  </SettingsPanelAnchor>
                ) : null}
                {workspace.canManageWorkspaceConfiguration ? (
                  <SettingsPanelAnchor panel="directory">
                    <DirectoryAdministrationPanelContainer
                      accessToken={workspace.accessToken}
                      locale={workspace.locale}
                    />
                    <OrgStructurePanelContainer
                      accessToken={workspace.accessToken}
                      guardRequest={workspace.guardEnterpriseSession}
                      locale={workspace.locale}
                      teams={workspace.teams}
                    />
                  </SettingsPanelAnchor>
                ) : null}
                {workspace.canManageWorkspaceTimePeriods ? (
                  <SettingsPanelAnchor panel="time-periods">
                    <WorkspaceTimePeriodContainer
                      accessToken={workspace.accessToken}
                      locale={workspace.locale}
                      timeZone={workspace.timeZone ?? resolveBrowserTimeZone()}
                    />
                  </SettingsPanelAnchor>
                ) : null}
                <SettingsPanelAnchor panel="developer-platform">
                  <DeveloperPlatformSettingsPanelContainer
                    accessToken={workspace.accessToken}
                    initialSection={developerPlatformInitialSection}
                    locale={workspace.locale}
                    teams={workspace.teams}
                  />
                </SettingsPanelAnchor>
                <SettingsPanelAnchor panel="automation">
                  <AutomationManagementPanelContainer
                    accessToken={workspace.accessToken}
                    canManage={workspace.canManageWorkspaceConfiguration}
                    locale={workspace.locale}
                    teams={[...workspace.teams]}
                  />
                </SettingsPanelAnchor>
                {workspace.canReadAuditLog || workspace.canExportAuditLog ? (
                  <SettingsPanelAnchor panel="audit-log">
                    <AuditLogPanelContainer
                      accessToken={workspace.accessToken}
                      canExport={workspace.canExportAuditLog}
                      canSearch={workspace.canReadAuditLog}
                      guardRequest={workspace.guardEnterpriseSession}
                      locale={workspace.locale}
                      timeZone={workspace.timeZone}
                    />
                  </SettingsPanelAnchor>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
        {section === 'team' && workspace.accessToken ? (
          <>
            {workspace.canManageTeams ? (
              <SettingsPanelAnchor panel="team-profile">
                <TeamProfilePanelContainer accessToken={workspace.accessToken} locale={workspace.locale} />
              </SettingsPanelAnchor>
            ) : null}
            <SettingsPanelAnchor panel="work-item-configuration">
              <WorkItemConfigurationPanelContainer
                accessToken={workspace.accessToken}
                canManageWorkspaceConfiguration={
                  workspace.canManageWorkspaceConfiguration
                }
                canMutateTeamConfiguration={workspace.canMutateTeamConfiguration}
                locale={workspace.locale}
                teams={workspace.teams}
              />
            </SettingsPanelAnchor>
            <SettingsPanelAnchor panel="work-calendar">
              <WorkCalendarPanelContainer
                accessToken={workspace.accessToken}
                locale={workspace.locale}
                teams={workspace.teams}
              />
            </SettingsPanelAnchor>
            <SettingsPanelAnchor panel="work-item-key-prefix">
              <WorkItemKeyPrefixPanelContainer
                accessToken={workspace.accessToken}
                locale={workspace.locale}
                teams={workspace.teams}
              />
            </SettingsPanelAnchor>
            <SettingsPanelAnchor panel="team-automation">
              <TeamAutomationPanelContainer
                accessToken={workspace.accessToken}
                locale={workspace.locale}
                teams={workspace.teams}
              />
            </SettingsPanelAnchor>
            {workspace.softwareFactoryEnabled ? (
              <SettingsPanelAnchor panel="agent-settings">
                <AgentSettingsPanelContainer
                  accessToken={workspace.accessToken}
                  canMutateTeamConfiguration={workspace.canMutateTeamConfiguration}
                  locale={workspace.locale}
                  teams={workspace.teams}
                />
              </SettingsPanelAnchor>
            ) : null}
          </>
        ) : null}
      </div>
    </WorkspaceRouteContent>
  )
}

/** Which conditionally shown settings panels are on the page. */
type SettingsPanelAvailability = {
  /** Whether the member is signed in, which every API-backed panel needs. */
  accessToken: boolean
  /** Whether the AI assistance panel is rolled out. */
  aiAssistance: boolean
  /** Whether the member can search or export the audit log. */
  auditLog: boolean
  /** Whether the member manages the Workspace configuration. */
  workspaceConfiguration: boolean
  /** Whether the Software factory is enabled. */
  softwareFactory: boolean
  /** Whether the member manages Teams, which shows the Team profile panel. */
  teamManagement: boolean
  /** Whether the member closes months for every Team. */
  workspaceTimePeriods: boolean
}

/**
 * Lists the panels shown in a settings area, in page order, for the in-page links.
 *
 * @param section - Settings area on the page.
 * @param available - Which conditional panels are shown.
 * @returns Links to the panels on the page.
 */
function listSettingsPanels(
  section: ReturnType<typeof resolveSettingsSection>,
  available: SettingsPanelAvailability,
): SettingsPanelLink[] {
  const signedIn = available.accessToken
  const panels: Array<SettingsPanelLink['panel'] | false> = section === 'personal'
    ? [
        'profile',
        'display',
        // The install card hides itself where the browser cannot install the app, so it is not linked.
        signedIn && 'notifications',
        signedIn && 'account-security',
        signedIn && available.aiAssistance && 'ai-assistance',
        'agent-connection',
      ]
    : section === 'workspace'
      ? [
          'enterprise-security',
          signedIn && 'members',
          signedIn && available.workspaceConfiguration && 'tenant',
          signedIn && available.workspaceConfiguration && 'directory',
          signedIn && available.workspaceTimePeriods && 'time-periods',
          signedIn && 'developer-platform',
          signedIn && 'automation',
          signedIn && available.auditLog && 'audit-log',
        ]
      : [
          signedIn && available.teamManagement && 'team-profile',
          signedIn && 'work-item-configuration',
          signedIn && 'work-calendar',
          signedIn && 'work-item-key-prefix',
          signedIn && 'team-automation',
          signedIn && available.softwareFactory && 'agent-settings',
        ]
  return panels.filter((panel) => panel !== false).map((panel) => ({ panel, section }))
}
