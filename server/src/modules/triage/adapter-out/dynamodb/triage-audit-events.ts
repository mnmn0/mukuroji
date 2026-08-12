import { createHash } from 'node:crypto'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { TriageEntry } from '@mukuroji/contracts'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createAuditEventTransactPut,
  createMutationAuditContext,
  type MutationAuditContext,
} from '../../../audit'

/** Audit transaction items composable with canonical Triage persistence. */
type TriageAuditTransactionItems = NonNullable<TransactWriteCommandInput['TransactItems']>

/** Audit outbox storage configured for Triage mutations. */
export type TriageAuditOutboxConfiguration = {
  /** Immutable audit event table name. */
  tableName: string
  /** Number of days Triage audit events remain queryable. */
  retentionDays: number
}

/** Inputs used to append SLA audit events to the schedule transaction. */
export type CreateTriageScheduleAuditTransactionItemsInput = {
  /** Immutable audit event outbox configuration. */
  audit: TriageAuditOutboxConfiguration
  /** Strongly read entry before its scheduled transition. */
  entry: TriageEntry
  /** ISO 8601 schedule evaluation instant. */
  now: string
  /** Whether this transaction newly records an SLA breach. */
  breached: boolean
  /** Whether this transaction newly records an escalation. */
  escalated: boolean
  /** Current configured escalation recipient when one exists. */
  escalationOwnerUserId?: string
}

/** Inputs used to append one assignment audit event to an action transaction. */
export type CreateTriageAssignmentAuditTransactionItemsInput = {
  /** Immutable audit event outbox configuration. */
  audit: TriageAuditOutboxConfiguration
  /** Strongly read entry before the assignment action. */
  previousEntry: TriageEntry
  /** Entry produced by the revision-fenced assignment action. */
  assignedEntry: TriageEntry
  /** Authenticated Triage actor identifier stored with assignment metadata. */
  actorId: string
  /** Immutable API or semantic-source context bound to the same logical mutation. */
  auditContext: MutationAuditContext
}

/** Inputs used to append the initial-owner assignment event to source admission. */
export type CreateTriageAdmissionAssignmentAuditTransactionItemsInput = {
  /** Immutable audit event outbox configuration. */
  audit: TriageAuditOutboxConfiguration
  /** Fully normalized entry after routing and ownership admission. */
  entry: TriageEntry
}

/** Builds immutable outbox events for newly fired SLA schedule transitions.
 *
 * @param input The fired schedule flags, recipient snapshots, and audit configuration.
 * @returns Audit transaction items to append to the canonical entry transaction.
 */
export function createTriageScheduleAuditTransactionItems(
  input: CreateTriageScheduleAuditTransactionItemsInput,
): TriageAuditTransactionItems {
  const events = [
    ...(input.breached
      ? [createTriageScheduleAuditEvent(
          input,
          'sla-breached',
          input.entry.sla?.dueAt,
          input.entry.ownerUserId,
        )]
      : []),
    ...(input.escalated
      ? [createTriageScheduleAuditEvent(
          input,
          'escalated',
          input.entry.sla?.escalationDueAt,
          input.escalationOwnerUserId ?? input.entry.ownerUserId,
        )]
      : []),
  ]
  return events.map((event) => createAuditEventTransactPut(input.audit.tableName, event))
}

/** Builds one immutable assignment event for the same transaction as the entry and receipt.
 *
 * Unassignment and Project-only assignment changes remain auditable but intentionally carry no
 * notification candidate. A candidate is produced only when the action selects a different,
 * non-empty owner.
 *
 * @param input The snapshots, actor, immutable mutation context, and outbox configuration.
 * @returns The single audit outbox transaction item.
 */
export function createTriageAssignmentAuditTransactionItems(
  input: CreateTriageAssignmentAuditTransactionItemsInput,
): TriageAuditTransactionItems {
  const actorId = requireText(input.actorId, 'Triage assignment actor ID', 320)
  const notificationMemberKey = readNewAssignmentOwner(
    input.previousEntry.ownerUserId,
    input.assignedEntry.ownerUserId,
  )
  const deepLink = createTriageDeepLink(input.assignedEntry)
  requireMatchingAuditWorkspace(input.auditContext, input.assignedEntry.workspaceId)
  const event = createAuditEvent({
    context: input.auditContext,
    eventType: 'triage.assigned',
    entity: { type: 'triage-entry', id: input.assignedEntry.id },
    action: 'assigned',
    changes: [
      ...(input.previousEntry.ownerUserId !== input.assignedEntry.ownerUserId
        ? [{
            field: 'ownerUserId',
            before: input.previousEntry.ownerUserId ?? null,
            after: input.assignedEntry.ownerUserId ?? null,
          }]
        : []),
      ...(input.previousEntry.projectId !== input.assignedEntry.projectId
        ? [{
            field: 'projectId',
            before: input.previousEntry.projectId ?? null,
            after: input.assignedEntry.projectId ?? null,
          }]
        : []),
    ],
    summary: 'Triage assignment changed.',
    metadata: {
      actorMemberKey: actorId,
      teamId: input.assignedEntry.teamId,
      ...(input.assignedEntry.projectId
        ? { projectId: input.assignedEntry.projectId }
        : {}),
      triageEntryId: input.assignedEntry.id,
      deepLink,
      notificationTitle: 'Triage assignment',
      notificationCandidates: notificationMemberKey
        ? [{ memberKey: notificationMemberKey, reason: 'triage-assignment' }]
        : [],
    },
    expiresAt: calculateAuditExpiresAt(
      input.auditContext.occurredAt,
      input.audit.retentionDays,
    ),
    outboxStatus: 'pending',
  })
  return [createAuditEventTransactPut(input.audit.tableName, event)]
}

/** Builds the atomic assignment notification emitted when admission selects an owner.
 *
 * @param input The admitted entry and immutable audit outbox configuration.
 * @returns The single audit outbox transaction item, or no item for an unowned entry.
 */
export function createTriageAdmissionAssignmentAuditTransactionItems(
  input: CreateTriageAdmissionAssignmentAuditTransactionItemsInput,
): TriageAuditTransactionItems {
  const notificationMemberKey = readTriageNotificationMemberKey(input.entry.ownerUserId)
  if (!notificationMemberKey) return []

  const eventType = 'triage.assigned'
  const context = createMutationAuditContext({
    workspaceId: input.entry.workspaceId,
    actor: {
      id: 'system:triage-admission',
      kind: 'system',
      displayName: 'Mukuroji Triage admission',
    },
    idempotencyKey: `triage-admission-v1:${input.entry.id}`,
    occurredAt: input.entry.createdAt,
    request: {
      method: 'ADMISSION',
      path: '/internal/triage-admission',
      body: {
        entryId: input.entry.id,
        ownerUserId: notificationMemberKey,
        projectId: input.entry.projectId,
        teamId: input.entry.teamId,
      },
    },
    source: {
      kind: 'system',
      method: 'ADMISSION',
      route: '/internal/triage-admission',
    },
  })
  const event = createAuditEvent({
    context,
    eventType,
    entity: { type: 'triage-entry', id: input.entry.id },
    action: 'assigned',
    changes: [{
      field: 'ownerUserId',
      after: notificationMemberKey,
    }],
    summary: 'Triage assignment changed.',
    metadata: {
      actorMemberKey: 'system:triage-admission',
      teamId: input.entry.teamId,
      ...(input.entry.projectId ? { projectId: input.entry.projectId } : {}),
      triageEntryId: input.entry.id,
      deepLink: createTriageDeepLink(input.entry),
      notificationTitle: 'Triage assignment',
      notificationCandidates: [{
        memberKey: notificationMemberKey,
        reason: 'triage-assignment',
      }],
    },
    expiresAt: calculateAuditExpiresAt(
      input.entry.createdAt,
      input.audit.retentionDays,
    ),
    outboxStatus: 'pending',
  })
  return [createAuditEventTransactPut(input.audit.tableName, event)]
}

/** Rejects an audit context captured for a different Workspace.
 *
 * @param context Immutable mutation context supplied by the caller boundary.
 * @param workspaceId Workspace owning the assigned Triage Entry.
 */
function requireMatchingAuditWorkspace(
  context: MutationAuditContext,
  workspaceId: string,
): void {
  if (context.workspaceId !== workspaceId) {
    throw new TypeError('Triage assignment audit context belongs to another Workspace.')
  }
}

/** Creates one deterministic Triage SLA audit event and notification candidate.
 *
 * @param input Current entry, schedule result, and audit retention configuration.
 * @param kind Scheduled transition represented by the event.
 * @param deadline Deadline that deterministically identifies the transition.
 * @param notificationUserId Optional member receiving the projected notification.
 * @returns An immutable pending audit event ready for a transactional put.
 */
function createTriageScheduleAuditEvent(
  input: CreateTriageScheduleAuditTransactionItemsInput,
  kind: 'sla-breached' | 'escalated',
  deadline: string | undefined,
  notificationUserId: string | undefined,
) {
  const eventType = kind === 'sla-breached' ? 'triage.sla-breached' : 'triage.escalated'
  const notificationReason = kind === 'sla-breached' ? 'triage-sla' : 'triage-escalation'
  const notificationMemberKey = readTriageNotificationMemberKey(notificationUserId)
  const digest = createHash('sha256').update([
    input.entry.workspaceId,
    input.entry.id,
    eventType,
    deadline ?? input.now,
  ].join('\0')).digest('hex')
  const context = createMutationAuditContext({
    workspaceId: input.entry.workspaceId,
    actor: {
      id: 'system:triage-schedule',
      kind: 'system',
      displayName: 'Mukuroji Triage schedule',
    },
    idempotencyKey: `triage-schedule-v1:${digest}`,
    occurredAt: input.now,
    request: {
      method: 'SCHEDULE',
      path: '/internal/triage-schedule',
      body: {
        entryId: input.entry.id,
        eventType,
        deadline,
      },
    },
    source: {
      kind: 'system',
      method: 'SCHEDULE',
      route: '/internal/triage-schedule',
    },
  })
  return createAuditEvent({
    context,
    eventType,
    entity: { type: 'triage-entry', id: input.entry.id },
    action: kind,
    changes: [{
      field: kind === 'sla-breached' ? 'sla.breachedAt' : 'sla.escalatedAt',
      after: input.now,
    }],
    summary: kind === 'sla-breached'
      ? 'Triage response SLA was breached.'
      : 'The triage entry was escalated.',
    metadata: {
      actorMemberKey: 'system:triage-schedule',
      teamId: input.entry.teamId,
      ...(input.entry.projectId ? { projectId: input.entry.projectId } : {}),
      triageEntryId: input.entry.id,
      deepLink: createTriageDeepLink(input.entry),
      notificationTitle: kind === 'sla-breached'
        ? 'Triage SLA breached'
        : 'Triage entry escalated',
      notificationCandidates: notificationMemberKey
        ? [{ memberKey: notificationMemberKey, reason: notificationReason }]
        : [],
    },
    expiresAt: calculateAuditExpiresAt(input.now, input.audit.retentionDays),
    outboxStatus: 'pending',
  })
}

/** Creates a permission-revalidated route without persisting source preview content.
 *
 * @param entry Triage Entry supplying only its Team and Entry identifiers.
 * @returns A relative deep link resolved through the live Triage permission boundary.
 */
function createTriageDeepLink(entry: TriageEntry): string {
  return `/teams/${encodeURIComponent(entry.teamId)}/triage?entryId=${
    encodeURIComponent(entry.id)
  }`
}

/** Returns a normalized recipient only when an action selects a different owner.
 *
 * @param previousOwnerUserId Owner before the assignment action.
 * @param assignedOwnerUserId Owner after the assignment action.
 * @returns The new canonical member key, or undefined for unchanged or cleared ownership.
 */
function readNewAssignmentOwner(
  previousOwnerUserId: string | undefined,
  assignedOwnerUserId: string | undefined,
): string | undefined {
  const previous = readTriageNotificationMemberKey(previousOwnerUserId)
  const assigned = readTriageNotificationMemberKey(assignedOwnerUserId)
  return assigned && assigned !== previous ? assigned : undefined
}

/** Normalizes one bounded Workspace notification member key from persisted state.
 *
 * @param value The untrusted persisted recipient value.
 * @returns The canonical member key, or undefined when the value is unsafe.
 */
export function readTriageNotificationMemberKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return normalized && normalized.length <= 320 &&
      /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(normalized)
    ? normalized
    : undefined
}

/** Requires a bounded, non-empty text value.
 *
 * @param value Candidate text at an internal audit boundary.
 * @param label Safe field label used by validation errors.
 * @param maximumLength Maximum accepted Unicode code-unit length.
 * @returns The trimmed validated text.
 */
function requireText(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximumLength) {
    throw new TypeError(`${label} is invalid.`)
  }
  return normalized
}
