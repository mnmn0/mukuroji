import type {
  PlanningUpdate,
  PlanningUpdateComment,
  PlanningUpdateTarget,
} from '@mukuroji/contracts'
import {
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type MutationAuditContext,
  type MutationAuditEventInput,
} from '../../modules/audit/audit'
import { createPlanningUpdatePublicTargetKey } from '../../modules/collaboration'
import {
  createPlanningUpdateTargetRecordKey,
  PlanningError,
  type PlanningMutationTransaction,
  type PlanningMutationTransactionResult,
  type PlanningUpdatePublishNotificationContext,
} from '../../modules/planning'
import { isRecord } from './value-guards'

/** Audit event type for a published update whose health did not get worse. */
export const PLANNING_UPDATE_PUBLISHED_EVENT_TYPE = 'planning-update.published'
/** Audit event type for a published update that moved health to at-risk or off-track. */
export const PLANNING_UPDATE_HEALTH_DEGRADED_EVENT_TYPE = 'planning-update.health-degraded'
/** Audit event type for a comment added to a published update. */
export const PLANNING_UPDATE_COMMENTED_EVENT_TYPE = 'planning-update.commented'
/** Maximum number of members one update comment may mention. */
export const MAX_PLANNING_UPDATE_COMMENT_MENTIONS = 20

/** Authorization scope stored on Planning notification events. */
export type PlanningNotificationScope = {
  /** Team that scopes the target, when any. */
  teamId?: string
  /** Project that scopes the target, when any. */
  projectId?: string
}

/** Inputs for the audit event written with an update publish. */
export type PlanningUpdatePublishAuditInput = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Committed immutable update; its context snapshot scope is the captured scope. */
  update: PlanningUpdate
  /** Health transition and cadence recipients decided by the Planning publish use case. */
  notification: PlanningUpdatePublishNotificationContext
}

/** Inputs for the audit event written with an update comment. */
export type PlanningUpdateCommentAuditInput = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Committed append-only comment. */
  comment: PlanningUpdateComment
  /** Author of the commented update. */
  updateAuthorMemberKey: string
  /** Validated members mentioned by the comment. */
  mentionMemberKeys: readonly string[]
  /** Team / Project scope used to authorize recipients. */
  scope: PlanningNotificationScope
}

/**
 * Creates the Planning page link that opens one target's update history.
 *
 * @param target - Project or Initiative update target.
 * @returns Relative Web path.
 */
export function createPlanningUpdateDeepLink(target: PlanningUpdateTarget) {
  const search = target.type === 'project'
    ? new URLSearchParams({ targetType: 'project', teamId: target.teamId, projectId: target.projectId })
    : new URLSearchParams({ targetType: 'initiative', entityId: target.entityId })
  return `/planning/portfolio?${search.toString()}`
}

/**
 * Builds the audit outbox event for one update publish.
 *
 * The event names the escalation recipient, and the update owner when health got worse. The
 * notification projection adds current target watchers and, for a Project target, current
 * Project members. The publishing member is removed there.
 *
 * @param input - Committed update and the publish use case's notification context.
 * @returns Audit event input for {@link createMutationAuditEventPut}.
 */
export function createPlanningUpdatePublishAuditEvent(
  input: PlanningUpdatePublishAuditInput,
): MutationAuditEventInput {
  const { update, notification } = input
  const degraded = notification.healthDegraded
  const previousHealth = notification.previousHealth
  const targetKey = createPlanningUpdatePublicTargetKey(update.target)
  const candidates = [
    ...(notification.escalationMemberKey
      ? [{ memberKey: notification.escalationMemberKey.toLowerCase(), reason: 'escalation' }]
      : []),
    ...(degraded
      ? [{ memberKey: notification.updateOwnerMemberKey.toLowerCase(), reason: 'update-owner' }]
      : []),
  ]
  return {
    directoryId: input.workspaceId,
    eventType: degraded
      ? PLANNING_UPDATE_HEALTH_DEGRADED_EVENT_TYPE
      : PLANNING_UPDATE_PUBLISHED_EVENT_TYPE,
    entityType: 'planning-update',
    entityId: targetKey,
    target: { type: 'planning-update-version', id: `${targetKey}/version/${update.version}` },
    action: 'published',
    occurredAt: update.createdAt,
    changes: degraded
      ? [{ field: 'health', before: previousHealth ?? 'unknown', after: update.health }]
      : [],
    summary: degraded
      ? `Health changed to ${update.health}: ${excerpt(update.summary)}`
      : `Health update published (${update.health}): ${excerpt(update.summary)}`,
    metadata: {
      actorMemberKey: update.authorMemberKey,
      ...planningTargetMetadata(update.target, update.contextSnapshot.scope),
      updateVersion: update.version,
      health: update.health,
      ...(previousHealth ? { previousHealth } : {}),
      deepLink: createPlanningUpdateDeepLink(update.target),
      notificationTitle: excerpt(update.summary),
      notificationCandidates: candidates,
    },
  }
}

/**
 * Builds the audit outbox event for one update comment.
 *
 * The update author and every mentioned member are candidates; the commenter is removed by
 * the notification projection.
 *
 * @param input - Committed comment, update author, mentions, and scope.
 * @returns Audit event input for {@link createMutationAuditEventPut}.
 */
export function createPlanningUpdateCommentAuditEvent(
  input: PlanningUpdateCommentAuditInput,
): MutationAuditEventInput {
  const { comment } = input
  const targetKey = createPlanningUpdatePublicTargetKey(comment.target)
  return {
    directoryId: input.workspaceId,
    eventType: PLANNING_UPDATE_COMMENTED_EVENT_TYPE,
    entityType: 'planning-update',
    entityId: targetKey,
    target: {
      type: 'planning-update-comment',
      id: `${targetKey}/version/${comment.updateVersion}/comment/${comment.id}`,
    },
    action: 'commented',
    occurredAt: comment.createdAt,
    changes: [],
    summary: excerpt(comment.body),
    metadata: {
      actorMemberKey: comment.authorMemberKey,
      ...planningTargetMetadata(comment.target, input.scope),
      updateVersion: comment.updateVersion,
      commentId: comment.id,
      deepLink: createPlanningUpdateDeepLink(comment.target),
      notificationTitle: excerpt(comment.body),
      notificationCandidates: [
        { memberKey: input.updateAuthorMemberKey.toLowerCase(), reason: 'update-author' },
        ...input.mentionMemberKeys.map((memberKey) => ({ memberKey, reason: 'mention' })),
      ],
    },
  }
}

/**
 * Validates the optional member mentions of an update comment request.
 *
 * @param value - Untrusted `mentionMemberKeys` request value.
 * @returns Sorted, deduplicated, lower-case member keys.
 * @throws PlanningError when the value is not a bounded list of member keys.
 */
export function readPlanningUpdateCommentMentions(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_PLANNING_UPDATE_COMMENT_MENTIONS) {
    throw invalidMentions()
  }
  const keys = value.map((item) => {
    if (typeof item !== 'string') throw invalidMentions()
    const key = item.trim().toLowerCase()
    if (!key || key.length > 320 || /[\s#]/.test(key)) throw invalidMentions()
    return key
  })
  return [...new Set(keys)].sort()
}

/**
 * Adds an audit outbox write to a Planning mutation transaction.
 *
 * Without an audit table (local runs without audit), the base transaction is returned unchanged.
 * With an idempotency receipt the audit write follows the receipt; without one the audit write
 * becomes the transaction's single contribution.
 *
 * @param base - Optional durable receipt transaction.
 * @param auditContext - Request audit context.
 * @param createEvent - Builds the audit event from the committed mutation result.
 * @returns A transaction that commits the audit event with the Planning mutation.
 */
export function withPlanningAuditOutbox<TResult extends PlanningMutationTransactionResult>(
  base: PlanningMutationTransaction<TResult> | undefined,
  auditContext: MutationAuditContext,
  createEvent: (result: TResult) => MutationAuditEventInput | undefined,
): PlanningMutationTransaction<TResult> | undefined {
  const tableName = getConfiguredAuditTableName()
  if (!tableName) return base
  return {
    async prepare(result) {
      const event = createEvent(result)
      const auditPut = event
        ? createMutationAuditEventPut(tableName, auditContext, event)
        : undefined
      const contribution = base ? await base.prepare(result) : undefined
      if (!auditPut) return contribution
      if (contribution === undefined) return { transactWriteItem: auditPut }
      if (!isRecord(contribution)) {
        throw new PlanningError(
          503,
          'PlanningIdempotencyUnavailable',
          'The durable Planning mutation receipt is unavailable.',
        )
      }
      return { ...contribution, additionalTransactWriteItems: [auditPut] }
    },
  }
}

/**
 * Creates target and scope metadata read by the notification projection.
 *
 * `teamId` / `projectId` keep the scope captured by the update. The target record key lets the
 * projection, Slack delivery, and the Inbox read the target's current scope, so a recipient must
 * be able to read both before the update or comment text reaches them.
 *
 * @param target - Project or Initiative update target.
 * @param scope - Team / Project scope captured by the update.
 * @returns Audit metadata fields.
 */
function planningTargetMetadata(target: PlanningUpdateTarget, scope: PlanningNotificationScope) {
  return {
    planningTargetType: target.type,
    planningTargetId: target.type === 'project' ? target.projectId : target.entityId,
    planningTargetRecordKey: createPlanningUpdateTargetRecordKey(target),
    ...(scope.teamId ? { teamId: scope.teamId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
  }
}

/**
 * Shortens user text for an Inbox title or summary.
 *
 * @param value - User-authored text.
 * @returns At most 140 characters on one line.
 */
function excerpt(value: string) {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/** Creates the stable validation error for malformed comment mentions. */
function invalidMentions() {
  return new PlanningError(
    400,
    'InvalidPlanningUpdateCommentMentions',
    `Mentions must be a list of at most ${MAX_PLANNING_UPDATE_COMMENT_MENTIONS} member keys.`,
  )
}
