import {
  type AuditEventPage,
  createAuditFieldChanges,
  toAuditEventView,
  type MutationAuditContext,
  type MutationAuditEventInput,
} from '../../modules/audit/audit'
import type {
  PlanningEntityChangeAction,
  PlanningEntityTransactionResult,
  PlanningEntityTransactionSnapshot,
  PlanningMutationTransaction,
} from '../../modules/planning'
import { withPlanningAuditOutbox } from './planning-update-notifications'

/** Audit entity type that groups the activity of one Planning entity. */
export const PLANNING_ENTITY_AUDIT_ENTITY_TYPE = 'planning-entity'

/** Audit event type recorded for each Planning entity lifecycle change. */
export const PLANNING_ENTITY_AUDIT_EVENT_TYPES: Readonly<Record<PlanningEntityChangeAction, string>> = {
  created: 'planning-entity.created',
  duplicated: 'planning-entity.duplicated',
  updated: 'planning-entity.updated',
  moved: 'planning-entity.moved',
  archived: 'planning-entity.archived',
  restored: 'planning-entity.restored',
}

/** Timestamps every write changes; the event's own time already records them. */
const PLANNING_ENTITY_AUDIT_OMITTED_FIELDS = new Set(['createdAt', 'updatedAt'])

/** English verb shown at the start of each activity summary. */
const PLANNING_ENTITY_AUDIT_SUMMARY_VERBS: Readonly<Record<PlanningEntityChangeAction, string>> = {
  created: 'Created',
  duplicated: 'Duplicated',
  updated: 'Updated',
  moved: 'Moved',
  archived: 'Archived',
  restored: 'Restored',
}

/**
 * Creates the transaction that commits one Planning entity audit event with the change.
 *
 * Without an audit table (local runs without audit) no transaction is returned, and the Planning
 * mutation commits as before. The audit write is rebuilt for each commit attempt, so the mutation
 * keeps rebasing over canonical Work Item writes.
 *
 * @param workspaceId - Canonical Workspace ID.
 * @param auditContext - Request audit context of the mutation.
 * @param actorMemberKey - Workspace member key of the caller.
 * @returns The audit transaction, or `undefined` when audit is not configured.
 */
export function createPlanningEntityAuditTransaction(
  workspaceId: string,
  auditContext: MutationAuditContext,
  actorMemberKey: string,
): PlanningMutationTransaction<PlanningEntityTransactionResult> | undefined {
  const transaction = withPlanningAuditOutbox<PlanningEntityTransactionResult>(
    undefined,
    auditContext,
    (result) => createPlanningEntityAuditEvent({ workspaceId, actorMemberKey, result }),
  )
  return transaction && { prepare: (result) => transaction.prepare(result), rebaseSafe: true }
}

/** Inputs for the audit event of one Planning entity change. */
export type PlanningEntityAuditInput = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Workspace member key of the caller. */
  actorMemberKey: string
  /** Committed entity change reported by the Planning mutation. */
  result: PlanningEntityTransactionResult
}

/**
 * Builds the audit event for one Planning entity change.
 *
 * The event groups under the entity, so `GET /api/planning/entities/:entityId/activity` reads the
 * entity's history from the audit entity index. Field changes exclude the write timestamps.
 *
 * @param input - Workspace, caller, and committed change.
 * @returns Audit event input for the audit outbox.
 */
export function createPlanningEntityAuditEvent(
  input: PlanningEntityAuditInput,
): MutationAuditEventInput {
  const { result } = input
  const { entity } = result
  return {
    directoryId: input.workspaceId,
    eventType: PLANNING_ENTITY_AUDIT_EVENT_TYPES[result.action],
    entityType: PLANNING_ENTITY_AUDIT_ENTITY_TYPE,
    entityId: entity.id,
    action: result.action,
    occurredAt: entity.updatedAt,
    changes: createAuditFieldChanges(
      result.previous === undefined ? undefined : auditedEntityFields(result.previous),
      auditedEntityFields(entity),
    ),
    summary: excerpt(
      `${PLANNING_ENTITY_AUDIT_SUMMARY_VERBS[result.action]} ${entity.type}: ${entity.title}`,
    ),
    metadata: {
      actorMemberKey: input.actorMemberKey.toLowerCase(),
      planningEntityType: entity.type,
      planningRevision: result.revision,
      ...(entity.teamId === undefined ? {} : { teamId: entity.teamId }),
      ...(entity.projectId === undefined ? {} : { projectId: entity.projectId }),
      ...(result.sourceEntityId === undefined ? {} : { sourceEntityId: result.sourceEntityId }),
      ...(result.movedDescendantCount === undefined
        ? {}
        : { movedDescendantCount: result.movedDescendantCount }),
    },
  }
}

/**
 * Returns the entity fields compared by the audit event.
 *
 * @param entity - Stored Planning entity value.
 * @returns The entity without its write timestamps.
 */
function auditedEntityFields(entity: PlanningEntityTransactionSnapshot): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entity).filter(([field]) => !PLANNING_ENTITY_AUDIT_OMITTED_FIELDS.has(field)),
  )
}

/**
 * Shortens user text for an activity summary.
 *
 * @param value - Text that includes a user-authored title.
 * @returns At most 140 characters on one line.
 */
function excerpt(value: string) {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/**
 * Creates the Planning entity activity response with a stable actor identifier.
 *
 * @param page - Audit event page of one Planning entity.
 * @returns Activity page with each event's actor member key as `actorUserId`.
 */
export function toPlanningEntityActivityPageView(page: AuditEventPage) {
  return {
    events: page.events.map((event) => {
      const view = toAuditEventView(event)
      const actorMemberKey = event.metadata?.actorMemberKey
      return {
        ...view,
        actorUserId: typeof actorMemberKey === 'string' && actorMemberKey.trim()
          ? actorMemberKey
          : view.actor.id,
      }
    }),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}
