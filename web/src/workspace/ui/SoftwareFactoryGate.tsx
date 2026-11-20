import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
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
 * Nothing renders while the current user is loading, so a bookmarked link neither flashes the
 * page nor calls its APIs; once loaded, a deployment without Software factory moves to the
 * fallback route.
 *
 * @param props - Fallback route and gated content.
 * @returns The content, nothing while loading, or a redirect.
 */
export function SoftwareFactoryGate({ fallbackPath, children }: SoftwareFactoryGateProps) {
  const workspace = useWorkspaceRouteContext()
  if (workspace.softwareFactoryEnabled) return <>{children}</>
  if (workspace.isLoading || !workspace.canLoadWorkspaceData) return null
  return <Navigate replace to={fallbackPath} />
}
