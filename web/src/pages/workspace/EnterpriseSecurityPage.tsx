import { useMemo } from 'react'
import { createWorkspaceSecurityScopeOptions } from '../../security/model/workspaceSecurityScopes'
import { EnterpriseSecurityPanelContainer } from '../../security/ui/EnterpriseSecurityPanelContainer'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the URL-specific Enterprise Security settings route.
 *
 * @returns Security content rendered inside the shared Workspace shell.
 */
export function EnterpriseSecurityPage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const scopeOptions = useMemo(
    () => createWorkspaceSecurityScopeOptions(
      workspace.teams,
      t('security.scope.workspace'),
    ),
    [t, workspace.teams],
  )

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        {workspace.accessToken ? (
          <EnterpriseSecurityPanelContainer
            accessToken={workspace.accessToken}
            locale={workspace.locale}
            scopeOptions={scopeOptions}
          />
        ) : null}
      </div>
    </WorkspaceRouteContent>
  )
}
