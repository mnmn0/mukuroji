import { useMemo } from 'react'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'
import { WorkspaceSettingsView } from '../../workspace/ui/WorkspaceSettingsView'

/**
 * Renders the URL-specific Workspace settings route.
 *
 * @returns Settings content rendered inside the shared Workspace shell.
 */
export function SettingsPage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceSettingsView
          accessToken={workspace.accessToken}
          canManageWorkspaceConfiguration={workspace.canManageWorkspaceConfiguration}
          canMutateTeamConfiguration={workspace.canMutateTeamConfiguration}
          fontSizePreference={workspace.fontSizePreference}
          locale={workspace.locale}
          onFontSizePreferenceChange={workspace.onFontSizePreferenceChange}
          onLocaleChange={workspace.onLocaleChange}
          onSessionError={workspace.reportNotificationPreferencesError}
          t={t}
          teams={workspace.teams}
          userLabel={workspace.userLabel}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
