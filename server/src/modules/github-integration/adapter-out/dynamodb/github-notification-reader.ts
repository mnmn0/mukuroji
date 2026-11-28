import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { GitHubRepositoryLinkRecord } from '../../application/ports'
import { GitHubIntegrationError } from '../../domain/github-integration-error'
import {
  createGitHubPullRequestRecordKey,
  createGitHubRepositoryLinkRecordKey,
  GITHUB_REPOSITORY_LINK_ENTRY_TYPE,
} from '../../domain/notification-scope'
import type { GitHubPullRequestSnapshot } from '../../domain/pull-request-snapshot'
import { parseGitHubPullRequestSnapshotRow, parseGitHubRepositoryLinkRow } from './github-integration-store'

/** DynamoDB condition that holds while a repository stays linked to one Team. */
export type GitHubRepositoryLinkTeamCondition = {
  /** Condition check of a transaction. */
  ConditionCheck: {
    /** Planning table. */
    TableName: string
    /** Link row key. */
    Key: { workspaceId: string, recordKey: string }
    /** Link type and Team. */
    ConditionExpression: string
    /** Values of the condition. */
    ExpressionAttributeValues: Record<string, string>
  }
}

/**
 * Reads the rows a GitHub pull request notification is revalidated against, with consistent reads
 * and the same validation as the integration store, so an unreadable row fails rather than
 * authorizing a notification (ADR 0079).
 */
export class DynamoDbGitHubNotificationReader {
  /** Planning table. */
  private readonly tableName: string

  /** Document client. */
  private readonly client: DynamoDBDocumentClient

  /**
   * Creates the reader.
   *
   * @param tableName - Planning table.
   * @param client - Document client.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient) {
    this.tableName = tableName
    this.client = client
  }

  /**
   * Reads a repository's current link.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository.
   * @returns The link, or `null` when the repository is not linked.
   * @throws GitHubIntegrationError `GitHubIntegrationCorrupt` when the row cannot be read.
   */
  async readLink(workspaceId: string, repositoryId: string): Promise<GitHubRepositoryLinkRecord | null> {
    const row = await this.read(workspaceId, createGitHubRepositoryLinkRecordKey(repositoryId))
    return row ? parseGitHubRepositoryLinkRow(row, workspaceId) : null
  }

  /**
   * Reads a stored pull request snapshot.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository.
   * @param number - Pull request number.
   * @returns The snapshot, or `null` when none is stored.
   * @throws GitHubIntegrationError `GitHubIntegrationCorrupt` when the row or its read time cannot be read.
   */
  async readSnapshot(workspaceId: string, repositoryId: string, number: number): Promise<GitHubPullRequestSnapshot | null> {
    const row = await this.read(workspaceId, createGitHubPullRequestRecordKey(repositoryId, number))
    if (!row) return null
    const snapshot = parseGitHubPullRequestSnapshotRow(row)
    if (!Number.isFinite(Date.parse(snapshot.syncedAt))) {
      throw new GitHubIntegrationError('unavailable', 'GitHubIntegrationCorrupt', 'GitHub integration data is unavailable.', { retryable: false })
    }
    return snapshot
  }

  /**
   * Builds the condition that the repository is still linked to a Team, for the transaction that
   * saves the notification.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository.
   * @param teamId - Team the notification is scoped to.
   * @returns The condition check.
   */
  linkTeamCondition(workspaceId: string, repositoryId: string, teamId: string): GitHubRepositoryLinkTeamCondition {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { workspaceId, recordKey: createGitHubRepositoryLinkRecordKey(repositoryId) },
        ConditionExpression: 'entryType = :entryType AND teamId = :teamId',
        ExpressionAttributeValues: { ':entryType': GITHUB_REPOSITORY_LINK_ENTRY_TYPE, ':teamId': teamId },
      },
    }
  }

  /**
   * Reads one row with a consistent read.
   *
   * @param workspaceId - Workspace.
   * @param recordKey - Row key.
   * @returns The row, if any.
   */
  private async read(workspaceId: string, recordKey: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { workspaceId, recordKey }, ConsistentRead: true }))
    return result.Item
  }
}
