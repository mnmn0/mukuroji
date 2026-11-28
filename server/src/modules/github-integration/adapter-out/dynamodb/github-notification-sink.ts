import { createHash } from 'node:crypto'
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createNotificationMessage, type NotificationMessage } from '@mukuroji/contracts'
import { calculateAuditExpiresAt, createAuditEvent, createMutationAuditContext } from '../../../audit'
import { GitHubIntegrationError } from '../../domain/github-integration-error'
import type { GitHubPullRequestNotificationKind } from '../../domain/pull-request-notifications'
import { GITHUB_PULL_REQUEST_NOTIFICATION_EVENT_TYPE_PREFIX } from '../../domain/notification-scope'
import type { GitHubPullRequestNotificationDelivery, GitHubPullRequestNotificationSink } from '../../application/ports'

/** Audit event type of each notification kind. */
export const GITHUB_PULL_REQUEST_NOTIFICATION_EVENT_TYPES = {
  'review-requested': `${GITHUB_PULL_REQUEST_NOTIFICATION_EVENT_TYPE_PREFIX}review_requested`,
  'checks-failed': `${GITHUB_PULL_REQUEST_NOTIFICATION_EVENT_TYPE_PREFIX}checks_failed`,
  conflict: `${GITHUB_PULL_REQUEST_NOTIFICATION_EVENT_TYPE_PREFIX}conflict`,
} as const satisfies Record<GitHubPullRequestNotificationKind, string>

/** Recipient reason of each notification kind. */
const NOTIFICATION_REASONS = {
  'review-requested': 'review-requested',
  'checks-failed': 'pull-request-author',
  conflict: 'pull-request-author',
} as const satisfies Record<GitHubPullRequestNotificationKind, string>

/** Longest pull request title or check list copied into a message. */
const MESSAGE_TEXT_MAX_LENGTH = 200

/** Audit summary; the title stays in the permission-checked notification, not in the audit log. */
const AUDIT_SUMMARY = 'A GitHub pull request notification was sent.'

/** Actor of the events. */
const ACTOR = { id: 'system:github-sync', kind: 'system', displayName: 'Mukuroji GitHub sync' } as const

/**
 * Writes pull request notifications as audit events that the collaboration projection turns into
 * Inbox notifications (#775).
 *
 * The event carries the linked Team, so the projection delivers it only while the recipient can
 * read that Team. Its idempotency key comes from the notification key, so a retry writes nothing.
 */
export class DynamoDbGitHubNotificationSink implements GitHubPullRequestNotificationSink {
  /** Audit events table. */
  private readonly tableName: string

  /** DynamoDB client. */
  private readonly client: DynamoDBDocumentClient

  /** Days an audit event is kept. */
  private readonly retentionDays: number

  /**
   * Creates the sink.
   *
   * @param tableName - Audit events table.
   * @param client - DynamoDB client.
   * @param retentionDays - Days an audit event is kept.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, retentionDays: number) {
    this.tableName = tableName
    this.client = client
    this.retentionDays = retentionDays
  }

  /**
   * Writes one notification event, once per key.
   *
   * @param delivery - Notification and its recipient.
   */
  async publish(delivery: GitHubPullRequestNotificationDelivery): Promise<void> {
    const item = createGitHubNotificationAuditEvent(delivery, new Date(), this.retentionDays)
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
        ExpressionAttributeNames: { '#directoryId': 'directoryId', '#eventId': 'eventId' },
      }))
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return
      throw new GitHubIntegrationError('unavailable', 'GitHubNotificationWriteFailed', 'The notification could not be written.', { cause: error })
    }
  }
}

/** Sink that keeps notifications in memory, for tests and local runs. */
export class InMemoryGitHubNotificationSink implements GitHubPullRequestNotificationSink {
  /** Notifications written, once per key. */
  readonly published: GitHubPullRequestNotificationDelivery[] = []

  /**
   * Records one notification, once per recipient and key.
   *
   * @param delivery - Notification and its recipient.
   */
  async publish(delivery: GitHubPullRequestNotificationDelivery): Promise<void> {
    const duplicate = this.published.some((published) =>
      published.memberKey === delivery.memberKey &&
      published.key === delivery.key &&
      published.pullRequest.repositoryId === delivery.pullRequest.repositoryId &&
      published.pullRequest.number === delivery.pullRequest.number)
    if (!duplicate) this.published.push(structuredClone(delivery))
  }
}

/**
 * Builds the audit event of one notification.
 *
 * @param delivery - Notification and its recipient.
 * @param now - Write time.
 * @param retentionDays - Days the event is kept.
 * @returns The audit row.
 */
export function createGitHubNotificationAuditEvent(
  delivery: GitHubPullRequestNotificationDelivery,
  now: Date,
  retentionDays: number,
) {
  const { pullRequest } = delivery
  const entityId = `${pullRequest.repositoryId}#${pullRequest.number}`
  const eventType = GITHUB_PULL_REQUEST_NOTIFICATION_EVENT_TYPES[delivery.kind]
  const digest = createHash('sha256')
    .update([delivery.workspaceId, entityId, eventType, delivery.memberKey, delivery.key].join('\0'))
    .digest('hex')
  const occurredAt = now.toISOString()
  const context = createMutationAuditContext({
    workspaceId: delivery.workspaceId,
    actor: ACTOR,
    idempotencyKey: `github-notification-v1:${digest}`,
    occurredAt,
    request: { method: 'QUEUE', path: '/internal/github-sync', body: { entityId, kind: delivery.kind } },
    source: { kind: 'system', method: 'QUEUE', route: '/internal/github-sync' },
  })
  return createAuditEvent({
    context,
    eventType,
    entity: { type: 'github-pull-request', id: entityId },
    action: delivery.kind,
    changes: [],
    summary: AUDIT_SUMMARY,
    metadata: {
      notificationMessage: createDeliveryMessage(delivery),
      notificationTitle: truncate(`${pullRequest.repository}#${pullRequest.number} ${pullRequest.title}`),
      actorMemberKey: 'system',
      // The recipient must still read this Team when the notification is delivered.
      teamId: delivery.teamId,
      deepLink: '/reviews',
      notificationCandidates: [{ memberKey: delivery.memberKey, reason: NOTIFICATION_REASONS[delivery.kind] }],
    },
    expiresAt: calculateAuditExpiresAt(occurredAt, retentionDays),
    outboxStatus: 'pending',
  })
}

/**
 * Builds the localized message of a notification.
 *
 * @param delivery - Notification and its pull request.
 * @returns The message.
 */
function createDeliveryMessage(delivery: GitHubPullRequestNotificationDelivery): NotificationMessage {
  const { pullRequest } = delivery
  const common = { repository: pullRequest.repository, number: pullRequest.number }
  switch (delivery.kind) {
    case 'review-requested':
      return createNotificationMessage('github.review-requested', { ...common, title: truncate(pullRequest.title) })
    case 'checks-failed':
      return createNotificationMessage('github.checks-failed', { ...common, checks: truncate(pullRequest.checks.failedNames.join(', ')) })
    case 'conflict':
      return createNotificationMessage('github.conflict', common)
  }
}

/**
 * Shortens text copied from GitHub.
 *
 * @param text - Text.
 * @returns At most {@link MESSAGE_TEXT_MAX_LENGTH} code points, with an ellipsis when cut.
 */
function truncate(text: string): string {
  const codePoints = [...text]
  return codePoints.length > MESSAGE_TEXT_MAX_LENGTH ? `${codePoints.slice(0, MESSAGE_TEXT_MAX_LENGTH - 1).join('')}…` : text
}
