import { createHash } from 'node:crypto'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import {
  createNotificationMessage,
  formatNotificationMessage,
  type NotificationMessageCode,
} from '@mukuroji/contracts'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createAuditEventTransactPut,
  createMutationAuditContext,
} from '../audit'

/** Reason stored on a requester notification, so the Inbox can tell why it arrived. */
export const REQUEST_REQUESTER_NOTIFICATION_REASON = 'requester'

/** Prefix of every audit event type that notifies the member who sent a request. */
export const REQUEST_REQUESTER_EVENT_TYPE_PREFIX = 'request.requester.'

/** Changes to a request that the member who sent it is told about. */
export type RequestRequesterNotificationKind =
  | 'more-info-requested'
  | 'rejected'
  | 'duplicate'
  | 'accepted'
  | 'completed'

/** Inputs for the audit event that notifies a requester about their request. */
export type RequestRequesterNotificationInput = {
  /** Audit outbox table name. */
  auditTableName: string
  /** Number of days the audit event is kept. */
  auditRetentionDays: number
  /** Workspace that owns the request. */
  workspaceId: string
  /** Request submission ID. */
  submissionId: string
  /** Member who sent the request; no event is written without one. */
  requesterUserId?: string
  /** Form title shown as the notification title. */
  formTitle: string
  /** What changed. */
  kind: RequestRequesterNotificationKind
  /** Member or system that made the change; a requester never notifies themself. */
  actorId: string
  /** When the change happened, in ISO 8601. */
  occurredAt: string
  /** ID that makes the event unique, such as the submission event or Work Item revision. */
  occurrenceId: string
}

const messageCodes: Record<RequestRequesterNotificationKind, NotificationMessageCode> = {
  'more-info-requested': 'request.more-info-requested',
  rejected: 'request.rejected',
  duplicate: 'request.duplicate',
  accepted: 'request.accepted',
  completed: 'request.completed',
}

/**
 * Builds the audit outbox event that puts a notification in the requester's Inbox.
 *
 * The event carries no Team, Project, or Work Item scope, so the notification shows only the
 * form title and a fixed sentence, and links to the requester's own request page. It never
 * copies the team's message, the rejection reason, or the Work Item title.
 *
 * @param input - Request, requester, change, and audit configuration.
 * @returns One audit put, or none when the request has no signed-in requester.
 */
export function createRequestRequesterNotificationTransactItems(
  input: RequestRequesterNotificationInput,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const requester = readRequesterMemberKey(input.requesterUserId)
  if (!requester) return []
  const eventType = `${REQUEST_REQUESTER_EVENT_TYPE_PREFIX}${input.kind}`
  const digest = createHash('sha256')
    .update([input.workspaceId, input.submissionId, eventType, input.occurrenceId].join('\0'))
    .digest('hex')
  const route = '/internal/request-requester-notification'
  const context = createMutationAuditContext({
    workspaceId: input.workspaceId,
    actor: {
      id: 'system:request-intake',
      kind: 'system',
      displayName: 'Mukuroji Request intake',
    },
    idempotencyKey: `request-requester-notification-v1:${digest}`,
    occurredAt: input.occurredAt,
    request: {
      method: 'NOTIFY',
      path: route,
      body: { submissionId: input.submissionId, kind: input.kind, occurrenceId: input.occurrenceId },
    },
    source: { kind: 'system', method: 'NOTIFY', route },
  })
  const message = createNotificationMessage(messageCodes[input.kind])
  const event = createAuditEvent({
    context,
    eventType,
    entity: { type: 'request-submission', id: input.submissionId },
    action: input.kind,
    changes: [],
    summary: formatNotificationMessage(message, 'en'),
    metadata: {
      actorMemberKey: input.actorId,
      deepLink: createMyRequestDeepLink(input.submissionId),
      notificationTitle: input.formTitle.slice(0, 500),
      notificationMessage: message,
      notificationCandidates: [{ memberKey: requester, reason: REQUEST_REQUESTER_NOTIFICATION_REASON }],
    },
    expiresAt: calculateAuditExpiresAt(input.occurredAt, input.auditRetentionDays),
    outboxStatus: 'pending',
  })
  return [createAuditEventTransactPut(input.auditTableName, event)]
}

/**
 * Builds the app path of one of the requester's own requests.
 *
 * @param submissionId - Request submission ID.
 * @returns Relative path of the request on the "My requests" page.
 */
export function createMyRequestDeepLink(submissionId: string): string {
  return `/my-requests?requestId=${encodeURIComponent(submissionId)}`
}

/**
 * Normalizes the stored requester member key.
 *
 * @param value - Stored requester value, which may be absent for anonymous requests.
 * @returns The lower-case member key, or undefined when it is absent or holds whitespace or
 *   control characters.
 */
function readRequesterMemberKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  // Member keys are stored as normalized emails, which may hold any printable character.
  return normalized && normalized.length <= 320 && /^[^\s\p{Cc}]+$/u.test(normalized)
    ? normalized
    : undefined
}
