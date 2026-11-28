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
 * Builds the Planning table record key of a pull request snapshot row. The number is zero-padded
 * so the rows of a repository sort by number.
 *
 * @param repositoryId - GitHub repository ID.
 * @param number - Pull request number.
 * @returns The record key.
 */
export function createGitHubPullRequestRecordKey(repositoryId: string, number: number): string {
  return `GITHUB_PULL_REQUEST#${repositoryId}#${String(number).padStart(10, '0')}`
}

/**
 * Reads the pull request of a notification's audit entity, `<repositoryId>#<number>`.
 *
 * @param entityId - Audit entity ID.
 * @returns The repository ID and number, or `undefined` when the entity ID has another shape.
 */
export function readGitHubNotificationPullRequest(
  entityId: string | undefined,
): { repositoryId: string, number: number } | undefined {
  const match = /^([1-9][0-9]{0,19})#([1-9][0-9]{0,9})$/.exec(entityId ?? '')
  if (!match?.[1] || !match[2]) return undefined
  return { repositoryId: match[1], number: Number(match[2]) }
}
