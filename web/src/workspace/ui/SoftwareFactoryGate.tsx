import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { WorkspaceRouteContent } from './WorkspaceRoute'
import { useWorkspaceRouteContext } from './WorkspaceRouteProvider'

/**
 * Props of {@link SoftwareFactoryGate}.
 */
export type SoftwareFactoryGateProps = {
  /** Route opened instead when the deployment does not serve Software factory. */
  fallbackPath: string
  /** Software factory content shown only when the deployment serves it. */
  children: ReactNode
}

/**
 * Shows a Software factory route only when the deployment serves it.
 *
 * Only the shared loading state renders while the current user is loading, so a bookmarked link
 * neither flashes the page nor calls its APIs; once loaded, a deployment without Software factory
 * moves to the fallback route. When the common data failed, the shell shows its own error.
 *
 * @param props - Fallback route and gated content.
 * @returns The content, the loading state, nothing after a common failure, or a redirect.
 */
export function SoftwareFactoryGate({ fallbackPath, children }: SoftwareFactoryGateProps) {
  const workspace = useWorkspaceRouteContext()
  if (workspace.softwareFactoryEnabled) return <>{children}</>
  if (workspace.isLoading) return <WorkspaceRouteContent isLoading>{null}</WorkspaceRouteContent>
  if (!workspace.canLoadWorkspaceData) return null
  return <Navigate replace to={fallbackPath} />
}
