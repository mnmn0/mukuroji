import { useMemo } from 'react'
import { createTranslator } from '../../shared/i18n/i18n'
import { HelpWorkspaceView } from '../../workspace/ui/HelpWorkspaceView'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the URL-specific Workspace help route.
 *
 * @returns Help content rendered inside the shared Workspace shell.
 */
export function HelpPage() {
  const workspace = useWorkspaceRouteContext()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <HelpWorkspaceView t={t} />
      </div>
    </WorkspaceRouteContent>
  )
}
