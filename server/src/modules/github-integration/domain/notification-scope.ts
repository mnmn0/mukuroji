/** Audit event type prefix of every GitHub pull request notification (ADR 0079). */
export const GITHUB_PULL_REQUEST_NOTIFICATION_EVENT_TYPE_PREFIX = 'github.pull_request_'

/** Record type of a repository link row in the Planning table. */
export const GITHUB_REPOSITORY_LINK_ENTRY_TYPE = 'github-repository-link'

/**
 * Builds the Planning table record key of a repository link row.
 *
 * @param repositoryId - GitHub repository ID.
 * @returns The record key.
 */
export function createGitHubRepositoryLinkRecordKey(repositoryId: string): string {
  return `GITHUB_REPOSITORY#${repositoryId}`
}

/**
 * Reads the repository ID of a pull request notification's audit entity, `<repositoryId>#<number>`.
 *
 * @param entityId - Audit entity ID.
 * @returns The repository ID, or `undefined` when the entity ID has another shape.
 */
export function readGitHubNotificationRepositoryId(entityId: string | undefined): string | undefined {
  const match = /^([1-9][0-9]{0,19})#[1-9][0-9]{0,9}$/.exec(entityId ?? '')
  return match?.[1]
}
