import { useMemo } from 'react'
import { useOrgStructure } from '../../projects/queries/useOrgStructure'
import { createWorkspaceSecurityScopeOptions } from '../../security/model/workspaceSecurityScopes'
import { EnterpriseSecurityPanelContainer } from '../../security/ui/EnterpriseSecurityPanelContainer'
import { OrgUnitScopesUnavailableNotice } from '../../security/ui/OrgUnitScopesUnavailableNotice'
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
  // A reader refused the structure sees no OrgUnit scopes; any other failure is shown with a retry.
  const orgStructure = useOrgStructure(workspace.accessToken)
  const orgUnits = orgStructure.data?.orgUnits
  const scopeOptions = useMemo(
    () => createWorkspaceSecurityScopeOptions(
      workspace.teams,
      t('security.scope.workspace'),
      orgUnits,
    ),
    [orgUnits, t, workspace.teams],
  )

  return (
    <WorkspaceRouteContent sessionErrors={[orgStructure.error]}>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        {orgStructure.error ? (
          <OrgUnitScopesUnavailableNotice locale={workspace.locale} onRetry={() => void orgStructure.mutate()} />
        ) : null}
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
