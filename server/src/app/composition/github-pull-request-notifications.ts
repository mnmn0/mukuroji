import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { GitHubPullRequestNotificationRevalidator } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import { DynamoDbGitHubNotificationReader } from '../../modules/github-integration'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'

/**
 * Adapts the GitHub notification reader to the projection's revalidator port.
 *
 * @param reader - Reader of repository links and pull request snapshots.
 * @returns Revalidator that rereads the link and the stored snapshot.
 */
export function createGitHubPullRequestNotificationRevalidator(
  reader: Pick<DynamoDbGitHubNotificationReader, 'readLink' | 'readSnapshot' | 'linkTeamCondition'>,
): GitHubPullRequestNotificationRevalidator {
  return {
    async readLinkCondition({ workspaceId, repositoryId, teamId }) {
      const link = await reader.readLink(workspaceId, repositoryId)
      return link?.teamId === teamId ? reader.linkTeamCondition(workspaceId, repositoryId, teamId) : undefined
    },
    async readSnapshot({ workspaceId, repositoryId, number }) {
      return await reader.readSnapshot(workspaceId, repositoryId, number) ?? undefined
    },
  }
}

/**
 * Creates the production GitHub notification revalidator, or nothing when the Planning table is
 * not configured, in which case every GitHub notification is dropped.
 *
 * @param planningTableName - Planning table.
 * @param documentClient - Shared document client, when the caller has one.
 * @returns The revalidator, if configured.
 */
export function createConfiguredGitHubPullRequestNotificationRevalidator(
  planningTableName: string | undefined,
  documentClient?: DynamoDBDocumentClient,
): GitHubPullRequestNotificationRevalidator | undefined {
  if (!planningTableName) return undefined
  return createGitHubPullRequestNotificationRevalidator(new DynamoDbGitHubNotificationReader(
    planningTableName,
    documentClient ?? createDynamoDbDocumentClient(createDynamoDbClient()),
  ))
}
