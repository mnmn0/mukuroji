import type { WorkItemArtifactStatusesResponse } from '@mukuroji/contracts'
import type { WorkspacePrincipal } from '../shared/project-access'
import { createConnectorPullRequestStatusReader, readWorkItemArtifactStatuses } from '../shared/agent-run-artifact-status-access'
import { developerPlatformDependencies, workItemDependencies } from '../shared/app-dependencies'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'
import { requireConfiguredConnectorSyncEngine } from './public-api-routes'

/** Verifies reported pull requests through the Workspace's connected accounts. */
const pullRequestStatusReader = createConnectorPullRequestStatusReader({
  listConnectors: (workspaceId) => developerPlatformDependencies.connectors.listConnectors(workspaceId),
  getEngine: requireConfiguredConnectorSyncEngine,
})

/**
 * Reads the provider status of the pull requests that a Work Item's Agent Runs reported (ADR 0103).
 * A viewer of the Work Item may read it; the provider is read through the Workspace's connections.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns One status per reported pull request URL.
 */
export async function readWebWorkItemArtifactStatuses(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<WorkItemArtifactStatusesResponse> {
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
  return readWorkItemArtifactStatuses(
    { directoryId: principal.directoryId, teamId, workItemId },
    {
      agentRuns: workItemDependencies.agentRuns,
      statuses: workItemDependencies.agentRunArtifactStatuses,
      reader: pullRequestStatusReader,
    },
  )
}
