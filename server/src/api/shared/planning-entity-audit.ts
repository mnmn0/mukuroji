import {
  AUDIT_REDACTED_VALUE,
  type AuditEventPage,
  type AuditEventV1,
  createAuditFieldChanges,
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  toAuditEventView,
  type MutationAuditContext,
  type MutationAuditEventInput,
} from '../../modules/audit/audit'
import type {
  PlanningDependencyChangeAction,
  PlanningDependencyTransactionResult,
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

/** Audit event type recorded on both endpoints of a dependency change between Planning entities. */
export const PLANNING_DEPENDENCY_AUDIT_EVENT_TYPES: Readonly<Record<PlanningDependencyChangeAction, string>> = {
  created: 'planning-entity.dependency-added',
  deleted: 'planning-entity.dependency-removed',
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

/**
 * Creates the transaction that commits the audit events of one dependency change with the change.
 *
 * Each endpoint gets one event under its own entity, so both activity timelines show who added or
 * removed the dependency. The other endpoint is named only in metadata, which the activity response
 * hides from readers who cannot see it. Without an audit table no transaction is returned.
 *
 * @param workspaceId - Canonical Workspace ID.
 * @param auditContext - Request audit context of the mutation.
 * @param actorMemberKey - Workspace member key of the caller.
 * @returns The audit transaction, or `undefined` when audit is not configured.
 */
export function createPlanningDependencyAuditTransaction(
  workspaceId: string,
  auditContext: MutationAuditContext,
  actorMemberKey: string,
): PlanningMutationTransaction<PlanningDependencyTransactionResult> | undefined {
  const tableName = getConfiguredAuditTableName()
  if (!tableName) return undefined
  return {
    async prepare(result) {
      const [predecessorEvent, successorEvent] = createPlanningDependencyAuditEvents({
        workspaceId,
        actorMemberKey,
        result,
      })
      return {
        transactWriteItem: createMutationAuditEventPut(tableName, auditContext, predecessorEvent),
        additionalTransactWriteItems: [
          createMutationAuditEventPut(tableName, auditContext, successorEvent),
        ],
      }
    },
    rebaseSafe: true,
  }
}

/** Inputs for the audit events of one dependency change between Planning entities. */
export type PlanningDependencyAuditInput = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Workspace member key of the caller. */
  actorMemberKey: string
  /** Committed dependency change reported by the Planning mutation. */
  result: PlanningDependencyTransactionResult
}

/**
 * Builds the predecessor and successor audit events of one dependency change.
 *
 * @param input - Workspace, caller, and committed change.
 * @returns The predecessor event (sequence 0) and the successor event (sequence 1).
 */
export function createPlanningDependencyAuditEvents(
  input: PlanningDependencyAuditInput,
): [MutationAuditEventInput, MutationAuditEventInput] {
  const { result } = input
  /** Builds the event recorded under one endpoint. */
  const eventFor = (
    role: 'predecessor' | 'successor',
    entity: PlanningEntityTransactionSnapshot,
    relatedEntityId: string,
    sequence: number,
  ): MutationAuditEventInput => {
    const fields = auditedDependencyFields(result.dependency)
    const verb = result.action === 'created' ? 'Added' : 'Removed'
    // A predecessor gains or loses a successor, and a successor a predecessor.
    const counterpart = role === 'predecessor' ? 'successor' : 'predecessor'
    return {
      directoryId: input.workspaceId,
      eventType: PLANNING_DEPENDENCY_AUDIT_EVENT_TYPES[result.action],
      entityType: PLANNING_ENTITY_AUDIT_ENTITY_TYPE,
      entityId: entity.id,
      target: { type: 'planning-dependency', id: result.dependency.id },
      action: result.action === 'created' ? 'dependency-added' : 'dependency-removed',
      occurredAt: result.occurredAt,
      changes: result.action === 'created'
        ? createAuditFieldChanges(undefined, fields)
        : createAuditFieldChanges(fields, undefined),
      summary: excerpt(`${verb} a ${counterpart} dependency on ${entity.type}: ${entity.title}`),
      metadata: {
        actorMemberKey: input.actorMemberKey.toLowerCase(),
        planningEntityType: entity.type,
        planningRevision: result.revision,
        dependencyId: result.dependency.id,
        dependencyRole: role,
        relatedEntityId,
        ...(entity.teamId === undefined ? {} : { teamId: entity.teamId }),
        ...(entity.projectId === undefined ? {} : { projectId: entity.projectId }),
      },
      sequence,
    }
  }
  return [
    eventFor('predecessor', result.predecessor, result.successor.id, 0),
    eventFor('successor', result.successor, result.predecessor.id, 1),
  ]
}

/**
 * Returns the dependency fields recorded by its audit events.
 *
 * @param dependency - Dependency added or removed.
 * @returns Scheduling type, lag, and the optional date constraint; endpoint IDs stay in metadata.
 */
function auditedDependencyFields(
  dependency: PlanningDependencyTransactionResult['dependency'],
): Record<string, unknown> {
  return {
    type: dependency.type,
    lagDays: dependency.lagDays,
    ...(dependency.constraint === undefined ? {} : { constraint: dependency.constraint }),
  }
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
      ...(result.previousCycleId === undefined ? {} : { previousCycleId: result.previousCycleId }),
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
 * Creates the Planning entity activity response with the public audit event projection.
 *
 * @param page - Audit event page of one Planning entity.
 * @returns Activity page whose events carry only the public audit event fields.
 */
export function toPlanningEntityActivityPageView(page: AuditEventPage) {
  return {
    events: page.events.map((event) => toAuditEventView(event)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}

/** Team / Project scope an entity had when an audit event recorded it. */
export type PlanningEntityAuditScope = {
  /** Team scope, when any. */
  teamId?: string
  /** Project scope, when any. */
  projectId?: string
}

/**
 * Lists every scope whose content one Planning entity audit event shows.
 *
 * The event records the scope after the change; a move also shows the scope it left, rebuilt from
 * its `teamId` / `projectId` changes. A reader must be able to view each scope, so history written
 * while the entity sat in another Team or Project stays hidden from readers of the current scope.
 *
 * @param event - Stored Planning entity audit event.
 * @returns The scopes to authorize, or `undefined` when the recorded scope is malformed.
 */
export function readPlanningEntityAuditScopes(
  event: AuditEventV1,
): PlanningEntityAuditScope[] | undefined {
  const metadata = event.metadata ?? {}
  const teamId = metadata.teamId
  const projectId = metadata.projectId
  if (
    (teamId !== undefined && typeof teamId !== 'string') ||
    (projectId !== undefined && typeof projectId !== 'string')
  ) {
    return undefined
  }
  const current: PlanningEntityAuditScope = {
    ...(teamId === undefined ? {} : { teamId }),
    ...(projectId === undefined ? {} : { projectId }),
  }
  // Only a move leaves a scope; a created entity's first scope has no `before` and no prior scope.
  if (event.action !== 'moved') return [current]
  const previous: PlanningEntityAuditScope = { ...current }
  let moved = false
  for (const change of event.changes) {
    if (change.field !== 'teamId' && change.field !== 'projectId') continue
    if (change.before !== undefined && typeof change.before !== 'string') return undefined
    moved = true
    if (change.before === undefined) delete previous[change.field]
    else previous[change.field] = change.before
  }
  return moved ? [current, previous] : [current]
}

/** Change fields whose values name another Planning entity. */
const PLANNING_ENTITY_AUDIT_REFERENCE_FIELDS = new Set(['parentId', 'nextCycleId'])

/** Metadata fields whose values name another Planning entity. */
const PLANNING_ENTITY_AUDIT_REFERENCE_METADATA = [
  'sourceEntityId',
  'previousCycleId',
  'relatedEntityId',
] as const

/**
 * Hides references to Planning entities the reader cannot see, as the Planning snapshot does.
 *
 * A reference change keeps its value only when the named entity is visible to the reader; any
 * other value is replaced by the audit redaction marker. Reference metadata naming a hidden
 * entity is removed.
 *
 * @param event - Stored Planning entity audit event the reader may read.
 * @param visibleEntityIds - Entities in the reader's filtered Planning snapshot.
 * @returns A copy of the event without hidden entity references.
 */
export function redactPlanningEntityAuditReferences(
  event: AuditEventV1,
  visibleEntityIds: ReadonlySet<string>,
): AuditEventV1 {
  /** Reports whether a reference value may be shown. */
  const visible = (value: unknown) => typeof value === 'string' && visibleEntityIds.has(value)
  const changes = event.changes.map((change) => {
    if (!PLANNING_ENTITY_AUDIT_REFERENCE_FIELDS.has(change.field)) return change
    const hideBefore = change.before !== undefined && !visible(change.before)
    const hideAfter = change.after !== undefined && !visible(change.after)
    if (!hideBefore && !hideAfter) return change
    return {
      ...change,
      ...(hideBefore ? { before: AUDIT_REDACTED_VALUE } : {}),
      ...(hideAfter ? { after: AUDIT_REDACTED_VALUE } : {}),
      redacted: true,
    }
  })
  const metadata = event.metadata === undefined ? undefined : { ...event.metadata }
  for (const field of PLANNING_ENTITY_AUDIT_REFERENCE_METADATA) {
    if (metadata && metadata[field] !== undefined && !visible(metadata[field])) delete metadata[field]
  }
  return { ...event, changes, ...(metadata === undefined ? {} : { metadata }) }
}
