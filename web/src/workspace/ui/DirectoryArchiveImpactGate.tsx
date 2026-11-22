import type { ArchiveImpactGateProps, ArchiveImpactState } from '../../shared/ui/archive-impact'
import { useDirectoryArchiveImpact } from '../../projects/queries/useDirectoryArchiveImpact'
import { useWorkspaceRouteContext } from './WorkspaceRouteProvider'

/**
 * Reads the archive impact of a Team or Project for an open archive confirmation and renders
 * the confirmation body with it. Counts being refreshed count as loading, so the archive button
 * never acts on counts from an earlier opening.
 *
 * @param props - Target and the body renderer.
 * @returns The confirmation body for the current loading state.
 */
export function DirectoryArchiveImpactGate({ target, children }: ArchiveImpactGateProps) {
  const workspace = useWorkspaceRouteContext()
  const { data, error, isValidating } = useDirectoryArchiveImpact(
    workspace.accessToken,
    target,
    workspace.guardEnterpriseSession,
  )
  const state: ArchiveImpactState = error
    ? { status: 'error' }
    : data && !isValidating
      ? { status: 'ready', impact: data }
      : { status: 'loading' }

  return <>{children(state)}</>
}
