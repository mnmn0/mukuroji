import type { ArchiveImpactGateProps, ArchiveImpactState } from '../../shared/ui/archive-impact'
import { useDirectoryArchiveImpact } from '../../projects/queries/useDirectoryArchiveImpact'
import { useWorkspaceRouteContext } from './WorkspaceRouteProvider'

/**
 * Reads the archive impact of a Team or Project for an open archive confirmation and renders
 * the confirmation body with it. A request in flight counts as loading, even after an earlier
 * failure, so the archive button never acts on counts or errors from an earlier opening.
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
  const state: ArchiveImpactState = isValidating
    ? { status: 'loading' }
    : error
      ? { status: 'error' }
      : data
        ? { status: 'ready', impact: data }
        : { status: 'loading' }

  return <>{children(state)}</>
}
