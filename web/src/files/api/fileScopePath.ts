import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import type { FileResourceScope } from '../model/fileScope'

const filesApiBaseUrl = resolveApiBaseUrl()

/**
 * Builds the API path of the Work Item or Project that owns files and approvals.
 *
 * @param scope - Owning resource scope.
 * @returns The encoded `/teams/{teamId}/issues/{issueId}` or `/teams/{teamId}/projects/{projectId}` path.
 */
export function createFileOwnerPath(scope: FileResourceScope) {
  const teamPath = `${filesApiBaseUrl}/teams/${encodeURIComponent(scope.teamId)}`
  return scope.kind === 'work-item'
    ? `${teamPath}/issues/${encodeURIComponent(scope.issueId)}`
    : `${teamPath}/projects/${encodeURIComponent(scope.projectId)}`
}
