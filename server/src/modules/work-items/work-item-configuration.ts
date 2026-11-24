import { createHash } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  type GetCommandOutput,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  DEFAULT_WORK_ITEM_PROGRESS_MODE,
  isWorkItemProgressMode,
  isWorkItemHierarchyRank,
  isWorkItemParentCompletionPolicy,
  isWorkItemCompletionGateRequirement,
  DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_JOB_ROLE_LIMIT,
  WORK_ITEM_RELATION_ID_LIMIT,
  WORK_ITEM_TEAM_RELATION_LINK_LIMIT,
  DEFAULT_WORK_ITEM_TYPE,
  DEFAULT_WORK_ITEM_TYPE_ID,
  type CustomFieldDefinition,
  type CustomFieldValue,
  type WorkItemDetailSectionId,
  type WorkItemTypeChangePreview,
  type WorkItemTypeChangeResolution,
  type WorkItemTypeDefinition,
  type ResolvedWorkItemConfiguration,
  type WorkflowStatusCategory,
  type WorkItemConfiguration,
  type WorkItemConfigurationScopeType,
  type WorkItemCompletionGateErrorResponse,
  type WorkItemCompletionGatePolicy,
  type WorkItemCompletionGateUnmetCondition,
  evaluateWorkflowStatusRequirements,
  evaluateWorkflowTransitionActor,
  findWorkflowEntryActorRoles,
  type WorkflowRuleActor,
  type WorkflowRuleErrorResponse,
  type WorkflowRuleUnmetCondition,
  type WorkflowRuleWorkItemState,
  type WorkItemJobRoleDefinition,
  type WorkItemRelation,
  type WorkItemParentMutationResponse,
  type WorkItemRelationMutationResponse,
  type WorkItemRelationsResponse,
  type WorkItemRelationEventType,
  type WorkItemRelationType,
  createNotificationMessage,
} from '@mukuroji/contracts'
import {
  createDynamoDbClient as createConfiguredDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import {
  createAuditFieldChanges,
  createMutationAuditEventPut,
  ensureLocalAuditEventsTable,
  getConfiguredAuditTableName,
  type MutationAuditContext,
} from '../audit'
import {
  validateWorkflowDefinition as validateDomainWorkflowDefinition,
  WorkflowDefinitionValidationError,
} from '../work-item-workflow'
import { loadServerConfig } from '../../infrastructure/config/server-config'

/** Re-exports the canonical relation identifier validator for consumers. */
export { isCanonicalWorkItemRelationIds } from './canonical-work-item'

const CONFIGURATION_RECORD_KEY = 'CONFIG'
const CONFIGURATION_WRITE_LOCK_RECORD_KEY = 'CONFIG_WRITE_LOCK'
const CONFIGURATION_WRITE_LOCK_LEASE_SECONDS = 15 * 60
const RELATION_GRAPH_RECORD_KEY = 'RELATION_GRAPH'
const RELATION_RECORD_PREFIX = 'REL#'
/** Record key prefix of the row that counts restores of a parent Work Item's children. */
const CHILD_RESTORE_GUARD_RECORD_PREFIX = 'CHILD_RESTORE#'
/** Entry type of a child restore guard row. */
const CHILD_RESTORE_GUARD_ENTRY_TYPE = 'child-restore-guard'
/** Directed relation rows a Team may store; each logical link is a reciprocal pair. */
const TEAM_RELATION_EDGE_LIMIT = WORK_ITEM_TEAM_RELATION_LINK_LIMIT * 2
/** Work Items a single cycle validation may visit before failing closed. */
const RELATION_TRAVERSAL_NODE_LIMIT = TEAM_RELATION_EDGE_LIMIT
/** Concurrent neighbourhood reads issued by one cycle validation level. */
const RELATION_TRAVERSAL_READ_CONCURRENCY = 16
const DYNAMODB_TRANSACTION_ITEM_LIMIT = 100
/** Maximum UTF-8 JSON size allowed for a persisted Work Item configuration item. */
export const MAX_WORK_ITEM_CONFIGURATION_ITEM_SERIALIZED_BYTES = 350 * 1_024
const MAX_CUSTOM_FIELD_TEXT_LENGTH = 10_000
const MAX_FORMULA_EXPRESSION_LENGTH = 1_024
const CONFIGURATION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Work Item configuration domain / persistence error です。 */
export class WorkItemConfigurationError extends Error {
  /** API response に使う HTTP status です。 */
  readonly status: number
  /** Client が安定判定に使う error code です。 */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Rejects moving a Work Item into the `completed` category while a required completion Gate
 * condition is unmet; the API returns `409 WorkItemCompletionGateNotSatisfied` with the list.
 */
export class WorkItemCompletionGateError extends WorkItemConfigurationError {
  /** Required conditions that blocked the completion, in display order. */
  readonly unmetConditions: readonly WorkItemCompletionGateUnmetCondition[]

  /**
   * Creates the error for the blocking conditions.
   *
   * @param unmetConditions - Required conditions that are not met.
   */
  constructor(unmetConditions: readonly WorkItemCompletionGateUnmetCondition[]) {
    super(
      409,
      'WorkItemCompletionGateNotSatisfied',
      `The Team's completion Gate is not satisfied: ${unmetConditions.map((condition) => condition.condition).join(', ')}.`,
    )
    this.unmetConditions = unmetConditions
  }

  /**
   * Builds the Team API response body.
   *
   * @returns The stable error body with the unmet conditions.
   */
  toResponseBody(): WorkItemCompletionGateErrorResponse {
    return {
      code: 'WorkItemCompletionGateNotSatisfied',
      message: this.message,
      unmetConditions: this.unmetConditions.map((condition) => ({ ...condition })),
    }
  }
}

/**
 * Rejects a status change that the workflow's transition actor roles or status required fields do
 * not allow; the API returns the unmet rules so a person or an agent can see what is missing.
 */
export class WorkflowRuleError extends WorkItemConfigurationError {
  /** Every rule the change does not meet, actor rules first. */
  readonly unmetConditions: readonly WorkflowRuleUnmetCondition[]

  /**
   * Creates the error for the unmet rules.
   *
   * @param unmetConditions - Rules the change does not meet; at least one.
   */
  constructor(unmetConditions: readonly WorkflowRuleUnmetCondition[]) {
    const actorDenied = unmetConditions.some((condition) => condition.rule === 'transition-actor')
    super(
      actorDenied ? 403 : 409,
      actorDenied ? 'WorkflowTransitionActorDenied' : 'WorkflowStatusRequirementsNotMet',
      actorDenied
        ? 'The workflow does not let this actor make the status change.'
        : `Fields required in the target status are empty: ${unmetConditions.map((condition) =>
          condition.rule === 'required-custom-field' ? condition.customFieldId : condition.rule === 'required-field' ? condition.field : condition.rule,
        ).join(', ')}.`,
    )
    this.unmetConditions = unmetConditions
  }

  /**
   * Builds the API response body.
   *
   * @returns The stable error body with the unmet rules.
   */
  toResponseBody(): WorkflowRuleErrorResponse {
    return {
      code: this.code === 'WorkflowTransitionActorDenied'
        ? 'WorkflowTransitionActorDenied'
        : 'WorkflowStatusRequirementsNotMet',
      message: this.message,
      unmetConditions: this.unmetConditions.map((condition) =>
        condition.rule === 'transition-actor'
          ? { ...condition, allowedActorRoles: [...condition.allowedActorRoles] }
          : { ...condition }),
    }
  }
}

/**
 * Applies a workflow's transition actor roles and status required fields to a status change.
 *
 * Nothing is checked when the status does not change. A change without a known transition (a create
 * into a status, or a Type change to another workflow) uses the least restricted transition into the
 * target status.
 *
 * @param configuration - Work Item configuration that owns the workflow.
 * @param change - The status change, its actor, and the Work Item state after it.
 * @param change.workItemTypeId - Work Item Type after the change.
 * @param change.projectId - Project after the change, which decides the custom fields that apply.
 * @param change.fromStatusId - Status before the change, or `undefined` without a known transition.
 * @param change.toStatusId - Status after the change.
 * @param change.actor - Actor making the change.
 * @param change.state - Reads the Work Item state after the change, only when a status requires a field.
 * @throws WorkflowRuleError when a rule is not met.
 */
export function assertWorkflowRules(
  configuration: WorkItemConfiguration,
  change: {
    workItemTypeId: string | undefined
    projectId: string | undefined
    fromStatusId: string | undefined
    toStatusId: string
    actor: WorkflowRuleActor
    state: () => WorkflowRuleWorkItemState
  },
): void {
  if (change.fromStatusId === change.toStatusId) return
  const workflow = resolveWorkItemTypeWorkflow(configuration, change.workItemTypeId, { allowArchived: true })
  const status = workflow.statuses.find((candidate) => candidate.id === change.toStatusId)
  const unmet: WorkflowRuleUnmetCondition[] = []
  const actorRule = evaluateWorkflowTransitionActor(
    findWorkflowEntryActorRoles(workflow, change.fromStatusId, change.toStatusId),
    change.actor,
  )
  if (actorRule) unmet.push(actorRule)
  // A status shared by several Types or Projects asks only for the custom fields this Work Item can
  // hold; a field its Type or Project does not use could never be filled.
  const applicableFieldIds = (status?.requiredCustomFieldIds?.length ?? 0) > 0
    ? new Set(getWorkItemTypeCustomFieldDefinitions(configuration, change.workItemTypeId, { allowArchived: true })
      .filter((definition) => isFieldApplicable(definition, change.projectId))
      .map((definition) => definition.id))
    : new Set<string>()
  const requiredCustomFieldIds = status?.requiredCustomFieldIds?.filter((fieldId) => applicableFieldIds.has(fieldId)) ?? []
  if (status && ((status.requiredFields?.length ?? 0) > 0 || requiredCustomFieldIds.length > 0)) {
    unmet.push(...evaluateWorkflowStatusRequirements({ ...status, requiredCustomFieldIds }, change.state()))
  }
  if (unmet.length > 0) throw new WorkflowRuleError(unmet)
}

/** Work Item transaction が definition の同時変更を検出する guard です。 */
export type WorkItemConfigurationGuard = {
  /** Configuration table の partition key です。 */
  scopeKey: string
  /** 0 は CONFIG row が存在しないことを表します。 */
  revision: number
}

/** One endpoint's side of a relation change, recorded as one audit event. */
type RelationAuditChange = {
  /** Endpoint Work Item whose activity records the change. */
  workItemId: string
  /** Event type naming the change from the endpoint's point of view. */
  eventType: WorkItemRelationAuditEventType
  /** Relation type from the endpoint's point of view; omitted for a top-level reorder. */
  relationType?: WorkItemRelationType
  /** Other endpoint of an added or removed link; omitted for a parent change. */
  relatedWorkItemId?: string
  /** Parent before a parent change; omitted when the child had no parent. */
  previousParentWorkItemId?: string
  /** Parent after a parent change or of a reorder; omitted when there is no parent. */
  parentWorkItemId?: string
  /** Sibling rank before a reorder; omitted when the child followed its default rank. */
  previousHierarchyRank?: string
  /** Sibling rank stored by a reorder. */
  hierarchyRank?: string
}

/** Activity fallback summaries for the relation audit event types. */
const RELATION_AUDIT_SUMMARIES: Record<WorkItemRelationAuditEventType, string> = {
  'work-item.parent-changed': 'The parent was changed.',
  'work-item.child-added': 'A child was added.',
  'work-item.child-removed': 'A child was removed.',
  'work-item.blocker-added': 'A blocker was added.',
  'work-item.blocker-removed': 'A blocker was removed.',
  'work-item.blocking-added': 'This Work Item now blocks another Work Item.',
  'work-item.blocking-removed': 'This Work Item no longer blocks another Work Item.',
  'work-item.relation-added': 'A related Work Item was linked.',
  'work-item.relation-removed': 'A related Work Item was unlinked.',
  'work-item.sibling-order-changed': 'The order among siblings was changed.',
}

/**
 * Builds the notification metadata that sends a cleared blocker to the blocked Work Item's assignee.
 *
 * Only `work-item.blocker-removed` notifies. The projection resolves the endpoint's current
 * watchers, drops the actor, and checks the assignee and the Project scope again at delivery.
 *
 * @param change - Endpoint change recorded by the event.
 * @param audit - Request audit input carrying the endpoints read during authorization.
 * @returns Metadata fields to merge into the event, or none when the change does not notify.
 */
function createRelationNotificationMetadata(
  change: RelationAuditChange,
  audit: WorkItemRelationAuditInput | undefined,
): Record<string, unknown> {
  if (change.eventType !== 'work-item.blocker-removed') return {}
  const endpoint = audit?.notificationEndpoints?.get(change.workItemId)
  if (!endpoint) return {}
  return {
    deepLink: endpoint.deepLink,
    notificationTitle: endpoint.title,
    notificationMessage: createNotificationMessage('work-item.blocker-removed'),
    notificationCandidates: endpoint.assigneeMemberKey.trim() === ''
      ? []
      : [{ memberKey: endpoint.assigneeMemberKey, reason: 'assignee' }],
  }
}

/**
 * Builds the canonical audit entity ID of a Team-owned Work Item.
 *
 * Matches the `team/<teamId>/issue/<issueId>` ID the Work Item activity query reads.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item ID.
 * @returns The audit entity ID.
 */
function createRelationAuditEntityId(teamId: string, workItemId: string) {
  return `team/${teamId}/issue/${workItemId}`
}

/**
 * Describes one stored relation row being added or removed as an audit change on its source.
 *
 * @param relation - Directed relation row; its source is the endpoint that records the event.
 * @param change - Whether the row is added or removed.
 * @returns The endpoint change to record.
 */
function describeRelationAuditChange(
  relation: Pick<WorkItemRelation, 'sourceWorkItemId' | 'targetWorkItemId' | 'type'>,
  change: 'added' | 'removed',
): RelationAuditChange {
  const related = relation.targetWorkItemId
  if (relation.type === 'parent') {
    return {
      workItemId: relation.sourceWorkItemId,
      eventType: 'work-item.parent-changed',
      relationType: 'parent',
      ...(change === 'added' ? { parentWorkItemId: related } : { previousParentWorkItemId: related }),
    }
  }
  return {
    workItemId: relation.sourceWorkItemId,
    eventType: relationAuditEventType(relation.type, change),
    relationType: relation.type,
    relatedWorkItemId: related,
  }
}

/**
 * Describes a reorder among siblings as an audit change on the moved child.
 *
 * @param workItemId - Child whose sibling rank changed.
 * @param parentWorkItemId - Unchanged parent of the child; null for a top-level Work Item.
 * @param previousHierarchyRank - Rank stored before the reorder; undefined for the default rank.
 * @param hierarchyRank - Rank stored by the reorder.
 * @returns The endpoint change to record.
 */
function describeSiblingReorderAuditChange(
  workItemId: string,
  parentWorkItemId: string | null,
  previousHierarchyRank: string | undefined,
  hierarchyRank: string,
): RelationAuditChange {
  const change: RelationAuditChange = {
    workItemId,
    eventType: 'work-item.sibling-order-changed',
    hierarchyRank,
  }
  if (parentWorkItemId) {
    change.relationType = 'parent'
    change.parentWorkItemId = parentWorkItemId
  }
  if (previousHierarchyRank) change.previousHierarchyRank = previousHierarchyRank
  return change
}

/**
 * Names a non-parent relation change from its source endpoint's point of view.
 *
 * @param type - Relation type stored with the endpoint as its source.
 * @param change - Whether the link was added or removed.
 * @returns The audit event type.
 */
function relationAuditEventType(
  type: Exclude<WorkItemRelationType, 'parent'>,
  change: 'added' | 'removed',
): WorkItemRelationAuditEventType {
  switch (type) {
    case 'child':
      return change === 'added' ? 'work-item.child-added' : 'work-item.child-removed'
    case 'blockedBy':
      return change === 'added' ? 'work-item.blocker-added' : 'work-item.blocker-removed'
    case 'blocks':
      return change === 'added' ? 'work-item.blocking-added' : 'work-item.blocking-removed'
    case 'related':
    case 'duplicate':
      return change === 'added' ? 'work-item.relation-added' : 'work-item.relation-removed'
  }
}

/**
 * Creates the conditional write that advances a Team's relation graph revision by one.
 *
 * @param tableName - Work Item configuration table that holds the graph metadata.
 * @param scopeKey - Team configuration scope key.
 * @param expectedRevision - Revision the caller read; `0` means the metadata row does not exist yet.
 * @param nextEdgeCount - Directed relation row count after the change.
 * @returns A Put that fails unless the stored revision still equals `expectedRevision`.
 */
function createRelationGraphAdvance(
  tableName: string,
  scopeKey: string,
  expectedRevision: number,
  nextEdgeCount: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const graphItem = {
    scopeKey,
    recordKey: RELATION_GRAPH_RECORD_KEY,
    entryType: 'relation-graph',
    schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    revision: expectedRevision + 1,
    edgeCount: nextEdgeCount,
  }
  return expectedRevision === 0
    ? {
        Put: {
          TableName: tableName,
          Item: graphItem,
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        },
      }
    : {
        Put: {
          TableName: tableName,
          Item: graphItem,
          ConditionExpression: '#revision = :expectedRevision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
        },
      }
}

/**
 * Creates a DynamoDB guard for the semantic relation graph revision observed by a schedule preview.
 *
 * Schedule dependencies are owned by Planning, but a confirmed preview also preserves the
 * separately displayed semantic-block warning. The guard prevents that warning context from
 * changing between preview and the atomic schedule transaction.
 *
 * @param tableName - Work Item configuration table containing relation metadata.
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Team whose semantic relation graph was read.
 * @param expectedRevision - Non-negative graph revision returned by the preview.
 * @returns One DynamoDB ConditionCheck ready for the schedule cascade transaction.
 */
export function createWorkItemRelationGraphRevisionConditionCheck(
  tableName: string,
  workspaceId: string,
  teamId: string,
  expectedRevision: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemRelationGraphRevision',
      'Work Item relation graph revision must be a non-negative safe integer.',
    )
  }
  const key = {
    scopeKey: createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
    recordKey: RELATION_GRAPH_RECORD_KEY,
  }
  if (expectedRevision === 0) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: key,
        ConditionExpression:
          'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
      },
    }
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: key,
      ConditionExpression:
        '#entryType = :entryType AND #schemaVersion = :schemaVersion AND ' +
        '#revision = :expectedRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#schemaVersion': 'schemaVersion',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'relation-graph',
        ':schemaVersion': WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        ':expectedRevision': expectedRevision,
      },
    },
  }
}

/**
 * Creates an atomic relation graph revision increment for a Work Item Type change.
 *
 * The relation graph revision covers endpoint Work Item Types as well as relation edges,
 * so configuration validation and concurrent endpoint type changes can share one fence.
 *
 * @param tableName - Work Item configuration table containing relation metadata.
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Team whose relation graph is being changed.
 * @param expectedRevision - Positive graph revision observed by the caller's strong read.
 * @returns One DynamoDB Update ready for a Work Item mutation transaction.
 */
export function createWorkItemRelationGraphRevisionIncrementTransactionItem(
  tableName: string,
  workspaceId: string,
  teamId: string,
  expectedRevision: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    expectedRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemRelationGraphRevision',
      'Work Item relation graph revision must be a positive safe integer below the maximum.',
    )
  }
  return {
    Update: {
      TableName: tableName,
      Key: {
        scopeKey: createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
        recordKey: RELATION_GRAPH_RECORD_KEY,
      },
      UpdateExpression: 'SET #revision = :nextRevision',
      ConditionExpression:
        '#entryType = :entryType AND #schemaVersion = :schemaVersion AND ' +
        '#revision = :expectedRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#schemaVersion': 'schemaVersion',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'relation-graph',
        ':schemaVersion': WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        ':expectedRevision': expectedRevision,
        ':nextRevision': expectedRevision + 1,
      },
    },
  }
}

/**
 * Creates the key of the row that counts restores of a parent Work Item's children.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Team that owns the parent Work Item.
 * @param parentWorkItemId - Parent Work Item whose children are restored.
 * @returns The configuration table key of the parent's child restore guard row.
 */
function createChildRestoreGuardKey(workspaceId: string, teamId: string, parentWorkItemId: string) {
  return {
    scopeKey: createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
    recordKey: `${CHILD_RESTORE_GUARD_RECORD_PREFIX}${encodeURIComponent(
      readIdentifier(parentWorkItemId, 'Work Item ID'),
    )}`,
  }
}

/**
 * Creates the write that records one restore of a child Work Item under its parent.
 *
 * The parent's guard generation advances by one from the validated value the caller read, so an
 * archive of the parent that read its children before this restore fails at commit instead of
 * hiding the restored child. A row changed since the read, or one the reader would reject, fails
 * the restore instead of being overwritten.
 *
 * @param tableName - Work Item configuration table.
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Team that owns the parent Work Item.
 * @param parentWorkItemId - Parent of the Work Item being restored.
 * @param expectedGeneration - Generation read with `getChildRestoreGeneration`; `0` means no row yet.
 * @returns One DynamoDB Put or Update ready for the restore transaction.
 */
export function createWorkItemChildRestoreGuardAdvance(
  tableName: string,
  workspaceId: string,
  teamId: string,
  parentWorkItemId: string,
  expectedGeneration: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  if (
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0 ||
    expectedGeneration >= Number.MAX_SAFE_INTEGER
  ) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemChildRestoreGeneration',
      'Work Item child restore generation must be a non-negative safe integer below the maximum.',
    )
  }
  const key = createChildRestoreGuardKey(workspaceId, teamId, parentWorkItemId)
  if (expectedGeneration === 0) {
    return {
      Put: {
        TableName: tableName,
        Item: {
          ...key,
          entryType: CHILD_RESTORE_GUARD_ENTRY_TYPE,
          schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
          generation: 1,
        },
        ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
      },
    }
  }
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: 'SET #generation = :nextGeneration',
      ConditionExpression:
        '#entryType = :entryType AND #schemaVersion = :schemaVersion AND #generation = :expectedGeneration',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#schemaVersion': 'schemaVersion',
        '#generation': 'generation',
      },
      ExpressionAttributeValues: {
        ':entryType': CHILD_RESTORE_GUARD_ENTRY_TYPE,
        ':schemaVersion': WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        ':expectedGeneration': expectedGeneration,
        ':nextGeneration': expectedGeneration + 1,
      },
    },
  }
}

/**
 * Creates the check that no child of a parent Work Item was restored since the caller read.
 *
 * @param tableName - Work Item configuration table.
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Team that owns the parent Work Item.
 * @param parentWorkItemId - Parent Work Item about to be archived.
 * @param expectedGeneration - Generation read before the children; `0` means no row yet.
 * @returns One DynamoDB ConditionCheck ready for the archive transaction.
 */
export function createWorkItemChildRestoreGuardConditionCheck(
  tableName: string,
  workspaceId: string,
  teamId: string,
  parentWorkItemId: string,
  expectedGeneration: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemChildRestoreGeneration',
      'Work Item child restore generation must be a non-negative safe integer.',
    )
  }
  const key = createChildRestoreGuardKey(workspaceId, teamId, parentWorkItemId)
  if (expectedGeneration === 0) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: key,
        ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
      },
    }
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: key,
      ConditionExpression:
        '#entryType = :entryType AND #schemaVersion = :schemaVersion AND #generation = :expectedGeneration',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#schemaVersion': 'schemaVersion',
        '#generation': 'generation',
      },
      ExpressionAttributeValues: {
        ':entryType': CHILD_RESTORE_GUARD_ENTRY_TYPE,
        ':schemaVersion': WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        ':expectedGeneration': expectedGeneration,
      },
    },
  }
}

/** DynamoDB transaction items contributed by a configuration validation boundary. */
export type WorkItemConfigurationTransactionItems = NonNullable<
  TransactWriteCommandInput['TransactItems']
>

/** Runs existing Work Item validation and contributes commit-time condition checks. */
export type WorkItemConfigurationUsageCheck = () => Promise<
  WorkItemConfigurationTransactionItems | void
>

/** Custom field value の正規化条件です。 */
export type NormalizeCustomFieldValuesOptions = {
  /** 作成時は default を補完し、更新時は existing value へ patch を適用します。 */
  mode: 'create' | 'update'
  /** 更新前に保存されている value です。 */
  existingValues?: Readonly<Record<string, CustomFieldValue>>
  /** Project scoped field の適用判定に使う遂行先 Project ID です。 */
  projectId?: string
  /** Backlog/Triage の quick capture では required value の欠落を許可します。 */
  allowRequiredMissing?: boolean
  /** Values are validated against this Work Item Type definition. */
  workItemTypeId?: string
}

/** Workflow status の解決結果です。 */
export type ResolvedWorkflowStatus = {
  /** Workflow 内の status ID です。 */
  workflowStatusId: string
  /** 横断集計に使う標準 category です。 */
  statusCategory: WorkflowStatusCategory
}

/** Relation mutation の入力です。 */
export type MutateWorkItemRelationInput = {
  /** Relation の起点 Work Item ID です。 */
  sourceWorkItemId: string
  /** Relation の終点 Work Item ID です。 */
  targetWorkItemId: string
  /** 起点から見た canonical relation type です。 */
  type: WorkItemRelationType
  /** 読み込み時点の relation graph revision です。 */
  expectedGraphRevision: number
  /** 認可時に読み取った起点 Work Item revision です。 */
  sourceExpectedRevision: number
  /** 認可時に読み取った終点 Work Item revision です。 */
  targetExpectedRevision: number
  /** 認可時に読み取った起点 Work Item の Project assignment です。 */
  sourceAssignedProjectId?: string
  /** 認可時に読み取った終点 Work Item の Project assignment です。 */
  targetAssignedProjectId?: string
}

/** Audit input recorded in the same transaction as a relation mutation. */
export type WorkItemRelationAuditInput = {
  /** Request audit context shared by every endpoint event of the mutation. */
  context: MutationAuditContext
  /** Workspace member key that the Work Item activity shows as the actor. */
  actorMemberKey: string
  /**
   * Notification details of the endpoints read during authorization, keyed by Work Item ID.
   * An endpoint whose blocker is removed notifies its assignee only when its details are here;
   * its current watchers are notified either way.
   */
  notificationEndpoints?: ReadonlyMap<string, WorkItemRelationNotificationEndpoint>
}

/**
 * Audit input for the relations removed by a Work Item delete.
 *
 * The other endpoints are only read while the clean-up is prepared, so their notification
 * details are built from that read instead of being supplied by the caller.
 */
export type WorkItemDeletionRelationAuditInput = {
  /** Request audit context of the delete, shared by every endpoint event. */
  context: MutationAuditContext
  /** Workspace member key that the Work Item activity shows as the actor. */
  actorMemberKey: string
  /**
   * Builds the app-relative path that opens an endpoint Work Item in a notification.
   *
   * @param workItemId - Endpoint Work Item ID.
   * @returns The deep link.
   */
  createDeepLink: (workItemId: string) => string
  /**
   * First audit sequence slot of the endpoint events. Event IDs derive from the idempotency key
   * and the slot only, so the slots must not overlap the delete event and any other event the
   * caller commits with the delete.
   */
  firstSequence: number
}

/** Endpoint details that let a relation audit event notify the endpoint's assignee. */
export type WorkItemRelationNotificationEndpoint = {
  /** Current assignee member key; empty when the Work Item has no assignee. */
  assigneeMemberKey: string
  /** Work Item title shown in the notification. */
  title: string
  /** App-relative path that opens the Work Item. */
  deepLink: string
  /** Project assignment the recipient must be able to read; omitted for a Team-only item. */
  assignedProjectId?: string
}

/** One audit event type recorded when a Work Item relation changes. */
type WorkItemRelationAuditEventType = WorkItemRelationEventType

/** Relation types projected into a Work Item's `relationIds`; `child` is excluded. */
export const WORK_ITEM_PROJECTED_RELATION_TYPES: readonly WorkItemRelationType[] = [
  'blockedBy',
  'blocks',
  'duplicate',
  'parent',
  'related',
]

/** Relation clean-up committed with the deletion of one Work Item. */
export type WorkItemDeletionRelationCleanup = {
  /**
   * Children of the Work Item. A Work Item with children is not deleted, so no clean-up is
   * prepared and `transactItems` is empty when this is not empty.
   */
  childWorkItemIds: string[]
  /**
   * Writes that remove every relation row of the Work Item and its reciprocal rows, update the
   * projected `relationIds` of the other endpoints, and advance the relation graph. Without
   * relations it only checks the graph revision, so a relation created meanwhile stops the delete.
   */
  transactItems: NonNullable<TransactWriteCommandInput['TransactItems']>
}

/** Options for reading one Work Item's relation neighbourhood. */
export type ListWorkItemRelationsOptions = {
  /** Relation types to read; omitted reads every type. */
  types?: readonly WorkItemRelationType[]
}

/** Authorization-time snapshot of one relation endpoint used as a transaction fence. */
export type WorkItemRelationEndpointSnapshot = {
  /** Endpoint Work Item ID. */
  workItemId: string
  /** Work Item revision read during authorization. */
  expectedRevision: number
  /** Project assignment read during authorization. */
  assignedProjectId?: string
}

/** Input for setting, replacing, or removing a Work Item's single parent. */
export type ReplaceWorkItemParentInput = {
  /** Child Work Item whose parent changes. */
  child: WorkItemRelationEndpointSnapshot
  /** Parent observed by the caller; omitted when the child had no parent. */
  currentParent?: WorkItemRelationEndpointSnapshot
  /** Requested parent; omitted removes the parent. */
  nextParent?: WorkItemRelationEndpointSnapshot
  /** Team relation graph revision observed by the caller. */
  expectedGraphRevision: number
  /**
   * Sibling order rank to store on the child. With an unchanged parent it only reorders the child;
   * omitted with a new parent, the stored rank is removed so the child follows creation order.
   */
  hierarchyRank?: string
}

/** Graph metadata read before a relation mutation. */
type RelationGraphState = {
  /** Current graph revision; zero before the metadata row exists. */
  revision: number
  /** Directed relation rows currently stored for the Team. */
  edgeCount: number
}

/** Pending relation rows applied to an endpoint projection. */
type RelationProjectionChange = {
  /** Rows added with the endpoint as their source. */
  add?: readonly WorkItemRelation[]
  /** Rows removed with the endpoint as their source. */
  remove?: readonly WorkItemRelation[]
}

/** Endpoint guard written with a relation transaction. */
type RelationTransactionEndpoint = WorkItemRelationEndpointSnapshot & {
  /** Next projection; omitted only checks the endpoint snapshot. */
  relationIds?: readonly string[]
  /**
   * Sibling order rank written with the projection; `null` removes the stored rank and
   * `undefined` leaves it unchanged.
   */
  hierarchyRank?: string | null
}

/** Items committed by one relation transaction. */
type RelationTransactionInput = {
  /** Graph revision observed before the mutation. */
  expectedRevision: number
  /** Directed relation rows stored after the mutation. */
  nextEdgeCount: number
  /** Endpoint projections and guards. */
  endpoints: readonly RelationTransactionEndpoint[]
  /** Relation row puts and deletes. */
  edgeMutations: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** Configuration guards appended after the relation rows. */
  configurationConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** Endpoint audit events appended after every other item. */
  auditPuts: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** Classifies a canceled transaction after re-reading its fences. */
  classifyCancellation: () => Promise<Error>
}

/** API handler が利用する Work Item configuration client contract です。 */
export type WorkItemConfigurationClient = {
  /** Workspace default または built-in default を返します。 */
  getWorkspaceConfiguration(workspaceId: string): Promise<ResolvedWorkItemConfiguration>
  /** Team override、Workspace default、built-in default の順で解決します。 */
  getTeamConfiguration(workspaceId: string, teamId: string): Promise<ResolvedWorkItemConfiguration>
  /**
   * Workspace default を optimistic revision 付きで保存します。
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param configuration - Validated configuration carrying the expected revision.
   * @param usageCheck - Commit-time compatibility checks and condition contributors.
   * @param completionTransactItems - Additional transaction items to commit atomically.
   * @param auditContext - Request audit context for the immutable configuration event.
   * @returns The saved configuration with its incremented revision.
   */
  saveWorkspaceConfiguration(
    workspaceId: string,
    configuration: WorkItemConfiguration,
    usageCheck: WorkItemConfigurationUsageCheck,
    completionTransactItems?: NonNullable<TransactWriteCommandInput['TransactItems']>,
    auditContext?: MutationAuditContext,
  ): Promise<ResolvedWorkItemConfiguration>
  /**
   * Team override を optimistic revision 付きで保存します。
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param teamId - Team whose configuration is being saved.
   * @param configuration - Validated configuration carrying the expected revision.
   * @param usageCheck - Commit-time compatibility checks and condition contributors.
   * @param completionTransactItems - Additional transaction items to commit atomically.
   * @param auditContext - Request audit context for the immutable configuration event.
   * @returns The saved configuration with its incremented revision.
   */
  saveTeamConfiguration(
    workspaceId: string,
    teamId: string,
    configuration: WorkItemConfiguration,
    usageCheck: WorkItemConfigurationUsageCheck,
    completionTransactItems?: NonNullable<TransactWriteCommandInput['TransactItems']>,
    auditContext?: MutationAuditContext,
  ): Promise<ResolvedWorkItemConfiguration>
  /**
   * Reads the relations stored with one Work Item as their source and the graph revision.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation graph is read.
   * @param workItemId - Source Work Item whose neighbourhood is read.
   * @param options - Optional relation type filter.
   * @returns The source Work Item's relations and the stable graph revision.
   */
  listRelations(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    options?: ListWorkItemRelationsOptions,
  ): Promise<WorkItemRelationsResponse>
  /**
   * Reads every relation and the stable graph revision for one Team.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose complete relation graph is read.
   * @returns All directed relations and their stable graph revision.
   */
  listRelationGraph(workspaceId: string, teamId: string): Promise<WorkItemRelationsResponse>
  /**
   * Reads the current canonical relation graph revision for recurrence-sensitive projections.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation graph is read.
   * @returns Current positive revision, or zero before graph metadata exists.
   */
  getRelationGraphRevision?(workspaceId: string, teamId: string): Promise<number>
  /**
   * Reads how many relation links, parent links included, a Team stores.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation graph is read.
   * @returns Stored links, each counted once although it is kept as two directed rows.
   */
  countRelationLinks?(workspaceId: string, teamId: string): Promise<number>
  /**
   * Reads how many times a child of the parent Work Item has been restored.
   *
   * @param workspaceId - Workspace that owns the parent Work Item.
   * @param teamId - Team that owns the parent Work Item.
   * @param parentWorkItemId - Parent Work Item about to be archived, or of a child being restored.
   * @returns Current generation, or zero before any child was restored.
   */
  getChildRestoreGeneration?(workspaceId: string, teamId: string, parentWorkItemId: string): Promise<number>
  /**
   * Prepares the relation clean-up that is committed in the same transaction as a Work Item delete.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item about to be deleted.
   * @param audit - Request audit input for the events recorded on the other endpoints.
   * @returns The Work Item's children and the clean-up writes.
   */
  prepareWorkItemDeletionRelationCleanup?(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    audit?: WorkItemDeletionRelationAuditInput,
  ): Promise<WorkItemDeletionRelationCleanup>
  /**
   * Reciprocal relation を単一 transaction で作成します。
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns both endpoints.
   * @param input - Relation mutation input.
   * @param configurationConditionChecks - Configuration guards committed with the relation.
   * @param audit - Request audit input for the endpoint events committed with the relation.
   * @returns The created relation pair and the next graph revision.
   */
  createRelation(
    workspaceId: string,
    teamId: string,
    input: MutateWorkItemRelationInput,
    configurationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>,
    audit?: WorkItemRelationAuditInput,
  ): Promise<WorkItemRelationMutationResponse>
  /**
   * Reciprocal relation を単一 transaction で削除します。
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns both endpoints.
   * @param input - Relation mutation input.
   * @param audit - Request audit input for the endpoint events committed with the deletion.
   * @returns The deleted relation pair and the next graph revision.
   */
  deleteRelation(
    workspaceId: string,
    teamId: string,
    input: MutateWorkItemRelationInput,
    audit?: WorkItemRelationAuditInput,
  ): Promise<WorkItemRelationMutationResponse>
  /**
   * Sets, replaces, or removes a Work Item's single parent as one atomic transaction.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns every endpoint.
   * @param input - Child, observed current parent, and requested next parent snapshots.
   * @param configurationConditionChecks - Configuration guards committed with the new parent link.
   * @param audit - Request audit input for the endpoint events committed with a parent change.
   * @returns The previous and next parent IDs with the resulting graph revision.
   */
  replaceParent(
    workspaceId: string,
    teamId: string,
    input: ReplaceWorkItemParentInput,
    configurationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>,
    audit?: WorkItemRelationAuditInput,
  ): Promise<WorkItemParentMutationResponse>
}

/** 既存4 statusを保持するbuilt-in configurationです。 */
export const DEFAULT_WORK_ITEM_CONFIGURATION: WorkItemConfiguration = {
  scopeType: 'workspace',
  scopeId: 'default',
  schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  revision: 0,
  workflow: {
    id: 'default-workflow',
    name: 'Default workflow',
    initialStatusId: 'todo',
    statuses: [
      { id: 'todo', name: 'Todo', category: 'unstarted', sortOrder: 10, color: 'slate' },
      { id: 'in-progress', name: 'In progress', category: 'started', sortOrder: 20, color: 'teal' },
      { id: 'review', name: 'Review', category: 'started', sortOrder: 30, color: 'amber' },
      { id: 'done', name: 'Done', category: 'completed', sortOrder: 40, color: 'emerald' },
    ],
    transitions: createAllDefaultTransitions(['todo', 'in-progress', 'review', 'done']),
  },
  customFields: [],
}

/** Workspace / Team scope の configuration table key を生成します。 */
export function createWorkItemConfigurationScopeKey(
  workspaceId: string,
  scopeType: WorkItemConfigurationScopeType,
  scopeId?: string,
) {
  const normalizedWorkspaceId = encodeURIComponent(readIdentifier(workspaceId, 'Workspace ID'))
  if (scopeType === 'workspace') {
    return `${normalizedWorkspaceId}#work-item-configuration`
  }
  const normalizedTeamId = encodeURIComponent(readIdentifier(scopeId, 'Team ID'))
  return `${normalizedWorkspaceId}#team#${normalizedTeamId}#work-item-configuration`
}

/** Resolved configuration を固定した DynamoDB ConditionCheck を生成します。 */
export function createWorkItemConfigurationGuardConditionChecks(
  tableName: string,
  workspaceId: string,
  teamId: string,
  resolved: ResolvedWorkItemConfiguration,
) {
  const guards = createConfigurationGuards(workspaceId, teamId, resolved)
  const currentEpochSeconds = Math.floor(Date.now() / 1_000)

  return guards.flatMap<
    NonNullable<TransactWriteCommandInput['TransactItems']>[number]
  >((guard) => [
    {
      ConditionCheck: {
        TableName: tableName,
        Key: { scopeKey: guard.scopeKey, recordKey: CONFIGURATION_WRITE_LOCK_RECORD_KEY },
        ConditionExpression:
          '(attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)) OR #expiresAt < :now',
        ExpressionAttributeNames: { '#expiresAt': 'expiresAtEpochSeconds' },
        ExpressionAttributeValues: { ':now': currentEpochSeconds },
      },
    },
    {
      ConditionCheck: {
        TableName: tableName,
        Key: { scopeKey: guard.scopeKey, recordKey: CONFIGURATION_RECORD_KEY },
        ...(guard.revision === 0
          ? { ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)' }
          : {
              ConditionExpression: '#revision = :revision',
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':revision': guard.revision },
            }),
      },
    },
  ])
}

/** Unknown input を厳格に検証済み configuration へ変換します。 */
export function validateWorkItemConfiguration(
  value: unknown,
  expectedScope?: { scopeType: WorkItemConfigurationScopeType; scopeId: string },
): WorkItemConfiguration {
  if (!isRecord(value)) {
    throw invalidConfiguration('Configuration must be an object.')
  }
  const scopeType = value.scopeType
  if (scopeType !== 'workspace' && scopeType !== 'team') {
    throw invalidConfiguration('Configuration scope is invalid.')
  }
  const scopeId = readIdentifier(value.scopeId, 'Configuration scope ID')
  if (expectedScope && (scopeType !== expectedScope.scopeType || scopeId !== expectedScope.scopeId)) {
    throw invalidConfiguration('Configuration scope does not match the request path.')
  }
  if (value.schemaVersion !== WORK_ITEM_CONFIGURATION_SCHEMA_VERSION) {
    throw invalidConfiguration('Configuration schema version is unsupported.')
  }
  const revision = readNonNegativeInteger(value.revision, 'Configuration revision')
  const workflow = validateWorkflowDefinition(value.workflow)
  const workflows = value.workflows === undefined
    ? undefined
    : readWorkflowDefinitions(value.workflows)
  if (workflows !== undefined) {
    assertUnique([workflow.id, ...workflows.map((candidate) => candidate.id)], 'Workflow ID')
  }
  assertUnique(
    [workflow, ...(workflows ?? [])].flatMap((candidate) =>
      candidate.statuses.map((status) => status.id),
    ),
    'Workflow status ID',
  )
  const customFields = readCustomFieldDefinitions(value.customFields)
  validateFormulaDefinitions(customFields)
  assertWorkflowStatusRequiredCustomFields([workflow, ...(workflows ?? [])], customFields)
  const workItemTypes = value.workItemTypes === undefined
    ? undefined
    : readWorkItemTypeDefinitions(value.workItemTypes, customFields, [
        workflow,
        ...(workflows ?? []),
      ])
  const jobRoles = value.jobRoles === undefined
    ? undefined
    : readJobRoleDefinitions(value.jobRoles)
  if (value.progressMode !== undefined && !isWorkItemProgressMode(value.progressMode)) {
    throw invalidConfiguration('Progress mode must be status-category, remaining-effort, or manual.')
  }
  const progressMode = value.progressMode
  if (
    value.parentCompletionPolicy !== undefined &&
    !isWorkItemParentCompletionPolicy(value.parentCompletionPolicy)
  ) {
    throw invalidConfiguration('Parent completion policy must be warn or reject.')
  }
  const parentCompletionPolicy = value.parentCompletionPolicy
  const completionGate = value.completionGate === undefined
    ? undefined
    : readWorkItemCompletionGatePolicy(value.completionGate)

  return {
    scopeType,
    scopeId,
    schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    revision,
    workflow,
    ...(workflows === undefined ? {} : { workflows }),
    customFields,
    ...(workItemTypes === undefined ? {} : { workItemTypes }),
    ...(jobRoles === undefined ? {} : { jobRoles }),
    ...(progressMode === undefined ? {} : { progressMode }),
    ...(parentCompletionPolicy === undefined ? {} : { parentCompletionPolicy }),
    ...(completionGate === undefined ? {} : { completionGate }),
    ...(value.updatedAt === undefined
      ? {}
      : { updatedAt: readIsoTimestamp(value.updatedAt, 'Configuration updatedAt') }),
  }
}

/**
 * Rejects a status that requires an unknown or formula custom field.
 *
 * A formula is computed, so a person could not fill it to meet the requirement.
 *
 * @param workflows - Every workflow of the configuration.
 * @param customFields - Custom fields of the configuration.
 * @throws WorkItemConfigurationError when a status requires an unusable custom field.
 */
function assertWorkflowStatusRequiredCustomFields(
  workflows: readonly WorkItemConfiguration['workflow'][],
  customFields: readonly CustomFieldDefinition[],
) {
  const fieldsById = new Map(customFields.map((field) => [field.id, field]))
  for (const workflow of workflows) {
    for (const status of workflow.statuses) {
      for (const fieldId of status.requiredCustomFieldIds ?? []) {
        const field = fieldsById.get(fieldId)
        if (!field) {
          throw invalidConfiguration(`Workflow status "${status.id}" requires unknown custom field "${fieldId}".`)
        }
        if (field.type === 'formula') {
          throw invalidConfiguration(`Workflow status "${status.id}" cannot require formula field "${fieldId}".`)
        }
      }
    }
  }
}

/**
 * Validates a Team completion Gate policy.
 *
 * @param value - Untrusted `completionGate` value.
 * @returns The policy with only the conditions it sets.
 * @throws WorkItemConfigurationError when the value is not an object of known conditions and requirements.
 */
function readWorkItemCompletionGatePolicy(value: unknown): WorkItemCompletionGatePolicy {
  if (!isRecord(value)) {
    throw invalidConfiguration('Completion Gate must be an object.')
  }
  const policy: WorkItemCompletionGatePolicy = {}
  for (const [key, requirement] of Object.entries(value)) {
    if (key !== 'acceptanceCriteria' && key !== 'noPendingApprovals' && key !== 'humanApproval') {
      throw invalidConfiguration(`Completion Gate condition "${key}" is not supported.`)
    }
    if (!isWorkItemCompletionGateRequirement(requirement)) {
      throw invalidConfiguration(`Completion Gate condition "${key}" must be off, warn, or required.`)
    }
    policy[key] = requirement
  }
  return policy
}

/**
 * Rejects a configuration item that could exceed DynamoDB's 400 KB item limit.
 *
 * @param item - Configuration item about to be persisted.
 * @throws WorkItemConfigurationError when the serialized item is too large.
 */
export function validateWorkItemConfigurationItemSize(item: unknown): void {
  const serialized = JSON.stringify(item)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_WORK_ITEM_CONFIGURATION_ITEM_SERIALIZED_BYTES) {
    throw new WorkItemConfigurationError(
      413,
      'WorkItemConfigurationItemTooLarge',
      'Work Item configuration cannot fit safely within the DynamoDB 400 KB item limit.',
    )
  }
}

/** Unknown input を厳格に検証済み Workflow definition へ変換します。 */
export function validateWorkflowDefinition(value: unknown): WorkItemConfiguration['workflow'] {
  try {
    return validateDomainWorkflowDefinition(value)
  } catch (error) {
    if (error instanceof WorkflowDefinitionValidationError) {
      throw invalidConfiguration(error.message)
    }
    throw error
  }
}

/**
 * Resolves every workflow available to a Work Item Type.
 *
 * @param configuration - Work Item configuration whose workflows are resolved.
 * @returns The primary workflow followed by every distinct additional workflow.
 */
export function getWorkItemConfigurationWorkflows(
  configuration: WorkItemConfiguration,
): readonly WorkItemConfiguration['workflow'][] {
  return configuration.workflows === undefined
    ? [configuration.workflow]
    : [configuration.workflow, ...configuration.workflows.filter((workflow) =>
        workflow.id !== configuration.workflow.id,
      )]
}

/**
 * Resolves the active or archived Work Item Type for a configuration.
 *
 * @param configuration - Work Item configuration that owns the type definition.
 * @param requestedTypeId - Untrusted requested type identifier; omitted values use the built-in type.
 * @param options - Whether an archived type may be returned.
 * @returns The validated Work Item Type definition.
 * @throws WorkItemConfigurationError when the type is unknown or archived without permission.
 */
export function resolveWorkItemType(
  configuration: WorkItemConfiguration,
  requestedTypeId?: unknown,
  options: { allowArchived?: boolean } = {},
): WorkItemTypeDefinition {
  const typeId = requestedTypeId === undefined
    ? DEFAULT_WORK_ITEM_TYPE_ID
    : readConfigurationId(requestedTypeId, 'Work Item Type ID')
  const configuredType = configuration.workItemTypes?.find((candidate) => candidate.id === typeId)
  const type = configuredType ?? (
    typeId === DEFAULT_WORK_ITEM_TYPE_ID && configuredType === undefined
      ? DEFAULT_WORK_ITEM_TYPE
      : undefined
  )
  if (!type) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemType',
      `Work Item Type "${typeId}" is not defined.`,
    )
  }
  if (!options.allowArchived && type.status === 'archived') {
    throw new WorkItemConfigurationError(
      400,
      'ArchivedWorkItemType',
      `Work Item Type "${typeId}" is archived and cannot be used for new Work Items.`,
    )
  }
  return type
}

/**
 * Checks whether a child Work Item Type is permitted by its parent's definition.
 *
 * @param configuration - Resolved Work Item configuration for the Team.
 * @param parentTypeId - Stored type identifier of the parent Work Item.
 * @param childTypeId - Stored type identifier of the child Work Item.
 * @returns Nothing when the parent-child type relation is allowed.
 * @throws WorkItemConfigurationError when either type is invalid or the relation is denied.
 */
export function assertWorkItemChildTypeAllowed(
  configuration: WorkItemConfiguration,
  parentTypeId: unknown,
  childTypeId: unknown,
): void {
  const parentType = resolveWorkItemType(configuration, parentTypeId, { allowArchived: true })
  const childType = resolveWorkItemType(configuration, childTypeId, { allowArchived: true })
  if (parentType.allowedChildTypeIds.includes(childType.id)) return

  throw new WorkItemConfigurationError(
    409,
    'WorkItemChildTypeDenied',
    `Work Item Type "${childType.id}" cannot be created as a child of "${parentType.id}".`,
  )
}

/**
 * Resolves the workflow selected by a Work Item Type.
 *
 * @param configuration - Work Item configuration that owns the workflow definitions.
 * @param typeId - Untrusted Work Item Type identifier.
 * @param options - Whether an archived type may be used for resolution.
 * @returns The validated workflow selected by the type.
 * @throws WorkItemConfigurationError when the type or selected workflow is invalid.
 */
export function resolveWorkItemTypeWorkflow(
  configuration: WorkItemConfiguration,
  typeId?: unknown,
  options: { allowArchived?: boolean } = {},
): WorkItemConfiguration['workflow'] {
  const type = resolveWorkItemType(configuration, typeId, options)
  const hasExplicitType = configuration.workItemTypes?.some((candidate) => candidate.id === type.id) ?? false
  const workflowId = type.id === DEFAULT_WORK_ITEM_TYPE_ID && !hasExplicitType
    ? configuration.workflow.id
    : type.defaultWorkflowId
  const workflow = getWorkItemConfigurationWorkflows(configuration).find((candidate) =>
    candidate.id === workflowId,
  )
  if (!workflow) {
    throw invalidConfiguration(
      `Work Item Type "${type.id}" references unavailable workflow "${workflowId}".`,
    )
  }
  return workflow
}

/**
 * Returns the custom fields visible to a Work Item Type in definition order.
 *
 * @param configuration - Work Item configuration containing field definitions.
 * @param typeId - Untrusted Work Item Type identifier.
 * @param options - Whether an archived type may be used for resolution.
 * @returns Applicable custom field definitions in configuration order.
 * @throws WorkItemConfigurationError when the type is unknown or archived without permission.
 */
export function getWorkItemTypeCustomFieldDefinitions(
  configuration: WorkItemConfiguration,
  typeId?: unknown,
  options: { allowArchived?: boolean } = {},
): readonly CustomFieldDefinition[] {
  const type = resolveWorkItemType(configuration, typeId, options)
  const hasExplicitType = configuration.workItemTypes?.some((candidate) => candidate.id === type.id) ?? false
  if (type.id === DEFAULT_WORK_ITEM_TYPE_ID && !hasExplicitType) {
    return configuration.customFields
  }
  const fieldIds = new Set(type.customFieldIds)
  return configuration.customFields.filter((definition) => fieldIds.has(definition.id))
}

/**
 * Calculates the data and workflow impact of a Work Item Type change.
 *
 * @param configuration - Work Item configuration used to resolve both types.
 * @param currentTypeId - Current stored Work Item Type identifier.
 * @param currentWorkflowStatusId - Current stored workflow status identifier.
 * @param currentCustomFieldValues - Current stored custom field values.
 * @param targetTypeId - Requested replacement Work Item Type identifier.
 * @param projectId - Optional Project used for field applicability.
 * @param expectedRevision - Revision that must still hold when applying the change.
 * @returns Server-calculated type-change impact and resolution requirements.
 * @throws WorkItemConfigurationError when either type cannot be resolved.
 */
export function previewWorkItemTypeChange(
  configuration: WorkItemConfiguration,
  currentTypeId: unknown,
  currentWorkflowStatusId: string,
  currentCustomFieldValues: Readonly<Record<string, CustomFieldValue>>,
  targetTypeId: unknown,
  projectId?: string,
  expectedRevision = 0,
): WorkItemTypeChangePreview {
  const currentType = resolveWorkItemType(configuration, currentTypeId, { allowArchived: true })
  const targetType = resolveWorkItemType(configuration, targetTypeId)
  const targetWorkflow = resolveWorkItemTypeWorkflow(configuration, targetType.id)
  const targetDefinitions = getWorkItemTypeCustomFieldDefinitions(configuration, targetType.id)
    .filter((definition) => isFieldApplicable(definition, projectId))
  const targetDefinitionIds = new Set(targetDefinitions.map((definition) => definition.id))
  const lostCustomFieldIds = Object.keys(currentCustomFieldValues)
    .filter((fieldId) => !targetDefinitionIds.has(fieldId))
    .sort()
  const targetStatus = targetWorkflow.statuses.find((status) => status.id === currentWorkflowStatusId)
  const requiredCustomFieldIds = new Set([
    ...targetDefinitions
      .filter((definition) => definition.required)
      .map((definition) => definition.id),
    ...targetType.requiredCustomFieldIds,
  ])
  const missingRequiredCustomFieldIds = [...requiredCustomFieldIds]
    .filter((fieldId) =>
      targetDefinitionIds.has(fieldId) &&
      isMissingCustomFieldValue(currentCustomFieldValues[fieldId]),
    )
    .sort()
  const missingRequiredCustomFieldDefinitions = missingRequiredCustomFieldIds.flatMap((fieldId) => {
    const definition = targetDefinitions.find((candidate) => candidate.id === fieldId)
    return definition ? [{ ...definition, required: true }] : []
  })

  return {
    expectedRevision,
    currentWorkItemTypeId: currentType.id,
    currentWorkflowStatusId,
    targetWorkItemTypeId: targetType.id,
    lostCustomFieldIds,
    ...(targetStatus ? {} : { invalidWorkflowStatusId: currentWorkflowStatusId }),
    targetInitialWorkflowStatusId: targetWorkflow.initialStatusId,
    missingRequiredCustomFieldIds,
    missingRequiredCustomFieldDefinitions,
    approvalCompletionTransitionConflict: false,
    requiresResolution: lostCustomFieldIds.length > 0 ||
      targetStatus === undefined ||
      missingRequiredCustomFieldIds.length > 0,
  }
}

/** Determines whether a stored custom field value is absent for required-field preview purposes. */
function isMissingCustomFieldValue(value: CustomFieldValue | undefined): boolean {
  return value === undefined ||
    typeof value === 'string' && value.length === 0 ||
    Array.isArray(value) && value.length === 0
}

/** Validates the explicit acknowledgements required before a type change is persisted. */
export function assertWorkItemTypeChangeResolution(
  preview: WorkItemTypeChangePreview,
  resolution: WorkItemTypeChangeResolution | undefined,
  requestedWorkflowStatusId?: unknown,
): string {
  const discarded = [...new Set(resolution?.discardCustomFieldIds ?? [])].sort()
  const expectedDiscarded = [...preview.lostCustomFieldIds].sort()
  if (discarded.join('\u0000') !== expectedDiscarded.join('\u0000')) {
    throw new WorkItemConfigurationError(
      409,
      'WorkItemTypeChangeResolutionRequired',
      'Changing the Work Item Type requires an explicit resolution for every lost custom field.',
    )
  }
  const requestedStatus = requestedWorkflowStatusId ?? resolution?.workflowStatusId
  if (preview.invalidWorkflowStatusId !== undefined && requestedStatus === undefined) {
    throw new WorkItemConfigurationError(
      409,
      'WorkItemTypeChangeResolutionRequired',
      'Changing the Work Item Type requires a replacement workflow status.',
    )
  }
  if (requestedStatus !== undefined && typeof requestedStatus !== 'string') {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkflowStatus',
      'Replacement workflow status must be a string.',
    )
  }
  return requestedStatus ?? (
    preview.invalidWorkflowStatusId === undefined
      ? preview.currentWorkflowStatusId
      : preview.targetInitialWorkflowStatusId
  )
}

/**
 * Applies defaults or patches to Work Item custom field values and validates every definition.
 *
 * @param configuration - Work Item configuration that owns the definitions.
 * @param input - Untrusted create values or update patch values.
 * @param options - Operation mode and Work Item Type scope used for validation.
 * @returns Canonical custom field values suitable for persistence.
 * @throws WorkItemConfigurationError when a value is malformed or violates its definition.
 */
export function normalizeCustomFieldValues(
  configuration: WorkItemConfiguration,
  input: unknown,
  options: NormalizeCustomFieldValuesOptions,
) {
  const workItemType = resolveWorkItemType(configuration, options.workItemTypeId, {
    allowArchived: true,
  })
  const definitions = getWorkItemTypeCustomFieldDefinitions(configuration, workItemType.id, {
    allowArchived: true,
  })
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  const requiredFieldIds = new Set([
    ...definitions.filter((definition) => definition.required).map((definition) => definition.id),
    ...workItemType.requiredCustomFieldIds,
  ])
  const values: Record<string, CustomFieldValue> = {}

  if (options.mode === 'update') {
    for (const [fieldId, existingValue] of Object.entries(options.existingValues ?? {})) {
      const definition = definitionsById.get(fieldId)
      if (!definition) {
        throw invalidFieldValue(`Custom field "${fieldId}" is not defined.`)
      }
      if (!isFieldApplicable(definition, options.projectId)) {
        continue
      }
      if (definition.type === 'formula') {
        if (typeof existingValue !== 'number' || !Number.isFinite(existingValue)) {
          throw invalidFieldValue(`Formula field "${fieldId}" must contain a finite number.`)
        }
        values[fieldId] = existingValue
        continue
      }
      values[fieldId] = readCustomFieldValue(definition, existingValue)
    }
  }

  if (options.mode === 'create') {
    for (const definition of definitions) {
      if (
        definition.type !== 'formula' &&
        definition.defaultValue !== undefined &&
        isFieldApplicable(definition, options.projectId)
      ) {
        values[definition.id] = cloneCustomFieldValue(definition.defaultValue)
      }
    }
  }

  if (input !== undefined) {
    if (!isRecord(input)) {
      throw invalidFieldValue('Custom field values must be an object.')
    }
    for (const [fieldId, candidate] of Object.entries(input)) {
      const definition = definitionsById.get(fieldId)
      if (!definition) {
        throw invalidFieldValue(`Custom field "${fieldId}" is not defined.`)
      }
      if (!isFieldApplicable(definition, options.projectId)) {
        throw invalidFieldValue(`Custom field "${fieldId}" is not applicable to this Project.`)
      }
      if (definition.type === 'formula') {
        throw invalidFieldValue(`Formula field "${fieldId}" is read-only.`)
      }
      if (candidate === null && options.mode === 'update') {
        delete values[fieldId]
        continue
      }
      values[fieldId] = readCustomFieldValue(definition, candidate)
    }
  }

  for (const definition of definitions) {
    if (!isFieldApplicable(definition, options.projectId) || definition.type === 'formula') {
      continue
    }
    const value = values[definition.id]
    if (value === undefined) {
      if (requiredFieldIds.has(definition.id) && !options.allowRequiredMissing) {
        throw invalidFieldValue(`Custom field "${definition.id}" is required.`)
      }
      continue
    }
    validateCustomFieldValue(definition, value, requiredFieldIds.has(definition.id))
  }

  const applicableFormulaDefinitions = new Map(
    definitions
      .filter((definition) =>
        definition.type === 'formula' && isFieldApplicable(definition, options.projectId),
      )
      .map((definition) => [definition.id, definition]),
  )
  const evaluatedFormulaIds = new Set<string>()
  const deferredFormulaIds = new Set<string>()
  const evaluateFormulaField = (fieldId: string): boolean => {
    if (evaluatedFormulaIds.has(fieldId)) {
      return true
    }
    if (deferredFormulaIds.has(fieldId)) {
      return false
    }
    const definition = applicableFormulaDefinitions.get(fieldId)
    if (!definition) {
      return true
    }
    for (const reference of readFormulaReferences(definition.formulaExpression ?? '')) {
      if (applicableFormulaDefinitions.has(reference) && !evaluateFormulaField(reference)) {
        delete values[fieldId]
        deferredFormulaIds.add(fieldId)
        return false
      }

      if (
        options.allowRequiredMissing &&
        requiredFieldIds.has(reference) &&
        values[reference] === undefined
      ) {
        delete values[fieldId]
        deferredFormulaIds.add(fieldId)
        return false
      }
    }
    values[fieldId] = evaluateFormula(definition.formulaExpression ?? '', values)
    evaluatedFormulaIds.add(fieldId)
    return true
  }
  for (const fieldId of applicableFormulaDefinitions.keys()) {
    evaluateFormulaField(fieldId)
  }

  return values
}

/**
 * Resolves a requested workflow status, or the workflow's initial status when omitted.
 *
 * @param configuration - Work Item configuration that owns the workflow.
 * @param requestedStatusId - Optional untrusted requested status identifier.
 * @param workItemTypeId - Optional Work Item Type selecting the workflow.
 * @returns The canonical status identifier and its category.
 * @throws WorkItemConfigurationError when the status or workflow is invalid.
 */
export function resolveWorkflowStatus(
  configuration: WorkItemConfiguration,
  requestedStatusId?: unknown,
  workItemTypeId?: unknown,
): ResolvedWorkflowStatus {
  const workflow = workItemTypeId === undefined
    ? configuration.workflow
    : resolveWorkItemTypeWorkflow(configuration, workItemTypeId, { allowArchived: true })
  const statuses = workflow.statuses
  const requested = typeof requestedStatusId === 'string'
    ? statuses.find((status) => status.id === requestedStatusId.trim())
    : undefined
  const status = requested ?? statuses.find(
    (candidate) => candidate.id === workflow.initialStatusId,
  )
  if (!status) {
    throw invalidConfiguration('Workflow initial status is unavailable.')
  }
  if (requestedStatusId !== undefined && !requested) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkflowStatus',
      `Workflow status "${String(requestedStatusId)}" is not defined.`,
    )
  }
  return {
    workflowStatusId: status.id,
    statusCategory: status.category,
  }
}

/**
 * Determines whether a workflow transition is allowed for a Work Item Type.
 *
 * @param configuration - Work Item configuration that owns the workflow.
 * @param fromStatusId - Current workflow status identifier.
 * @param toStatusId - Requested workflow status identifier.
 * @param workItemTypeId - Optional Work Item Type selecting the workflow.
 * @returns Whether the transition is allowed.
 */
export function isWorkflowTransitionAllowed(
  configuration: WorkItemConfiguration,
  fromStatusId: string,
  toStatusId: string,
  workItemTypeId?: unknown,
) {
  if (fromStatusId === toStatusId) {
    return true
  }
  const workflow = workItemTypeId === undefined
    ? configuration.workflow
    : resolveWorkItemTypeWorkflow(configuration, workItemTypeId, { allowArchived: true })
  return workflow.transitions.some((transition) =>
    transition.fromStatusId === fromStatusId && transition.toStatusId === toStatusId,
  )
}

/**
 * Rejects a workflow transition that is not allowed for a Work Item Type.
 *
 * @param configuration - Work Item configuration that owns the workflow.
 * @param fromStatusId - Current workflow status identifier.
 * @param toStatusId - Requested workflow status identifier.
 * @param workItemTypeId - Optional Work Item Type selecting the workflow.
 * @throws WorkItemConfigurationError when the transition is not allowed.
 */
export function assertWorkflowTransitionAllowed(
  configuration: WorkItemConfiguration,
  fromStatusId: string,
  toStatusId: string,
  workItemTypeId?: unknown,
) {
  if (!isWorkflowTransitionAllowed(configuration, fromStatusId, toStatusId, workItemTypeId)) {
    throw new WorkItemConfigurationError(
      409,
      'WorkflowTransitionDenied',
      `Transition from "${fromStatusId}" to "${toStatusId}" is not allowed.`,
    )
  }
}

/** DynamoDB を利用する configuration / relation store です。 */
export class DynamoDbWorkItemConfigurationClient implements WorkItemConfigurationClient {
  /** Configuration / relation table 名です。 */
  private readonly tableName: string
  /** Canonical Work Items table 名です。 */
  private readonly workItemsTableName: string
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local bootstrap 用の低レベル client です。 */
  private readonly dynamoDbClient: DynamoDBClient
  /** Local table の自動作成を有効にするかどうかです。 */
  private readonly bootstrapLocalTable: boolean
  /** Immutable audit event table 名です。 */
  private readonly auditTableName?: string

  constructor(
    tableName =
      loadServerConfig().environment.WORK_ITEM_CONFIGURATION_TABLE_NAME ??
      'mukuroji-work-item-configuration-local',
    workItemsTableName =
      loadServerConfig().environment.WORK_ITEMS_TABLE_NAME ??
      'mukuroji-team-issues-local',
    documentClient?: DynamoDBDocumentClient,
    dynamoDbClient = createConfiguredDynamoDbClient(),
    bootstrapLocalTable = false,
    auditTableName = documentClient === undefined
      ? getConfiguredAuditTableName() ?? 'mukuroji-audit-events'
      : undefined,
  ) {
    this.tableName = tableName
    this.workItemsTableName = workItemsTableName
    this.documentClient = documentClient ??
      createDocumentClient(dynamoDbClient)
    this.dynamoDbClient = dynamoDbClient
    this.bootstrapLocalTable = bootstrapLocalTable
    this.auditTableName = auditTableName?.trim() || undefined
  }

  /** Workspace default または built-in default を返します。 */
  async getWorkspaceConfiguration(workspaceId: string) {
    await this.ensureTable()
    const stored = await this.getStoredConfiguration(workspaceId, 'workspace', workspaceId)
    if (stored) {
      return { configuration: stored } satisfies ResolvedWorkItemConfiguration
    }
    return {
      configuration: createScopedDefaultConfiguration('workspace', workspaceId),
      inheritedFrom: 'default',
    } satisfies ResolvedWorkItemConfiguration
  }

  /** Team override、Workspace default、built-in default の順で解決します。 */
  async getTeamConfiguration(workspaceId: string, teamId: string) {
    await this.ensureTable()
    const team = await this.getStoredConfiguration(workspaceId, 'team', teamId)
    if (team) {
      return { configuration: team } satisfies ResolvedWorkItemConfiguration
    }
    const workspace = await this.getStoredConfiguration(workspaceId, 'workspace', workspaceId)
    if (workspace) {
      return {
        configuration: workspace,
        inheritedFrom: 'workspace',
      } satisfies ResolvedWorkItemConfiguration
    }
    return {
      configuration: createScopedDefaultConfiguration('workspace', workspaceId),
      inheritedFrom: 'default',
    } satisfies ResolvedWorkItemConfiguration
  }

  /**
   * Workspace default を optimistic revision 付きで保存します。
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param configuration - Validated configuration carrying the expected revision.
   * @param usageCheck - Commit-time compatibility checks and condition contributors.
   * @param completionTransactItems - Additional transaction items to commit atomically.
   * @param auditContext - Request audit context for the immutable configuration event.
   * @returns The saved configuration with its incremented revision.
   */
  async saveWorkspaceConfiguration(
    workspaceId: string,
    configuration: WorkItemConfiguration,
    usageCheck: WorkItemConfigurationUsageCheck,
    completionTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
    auditContext?: MutationAuditContext,
  ) {
    const saved = await this.saveConfiguration(
      workspaceId,
      'workspace',
      workspaceId,
      configuration,
      usageCheck,
      completionTransactItems,
      auditContext,
    )
    return { configuration: saved } satisfies ResolvedWorkItemConfiguration
  }

  /**
   * Team override を optimistic revision 付きで保存します。
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param teamId - Team whose configuration is being saved.
   * @param configuration - Validated configuration carrying the expected revision.
   * @param usageCheck - Commit-time compatibility checks and condition contributors.
   * @param completionTransactItems - Additional transaction items to commit atomically.
   * @param auditContext - Request audit context for the immutable configuration event.
   * @returns The saved configuration with its incremented revision.
   */
  async saveTeamConfiguration(
    workspaceId: string,
    teamId: string,
    configuration: WorkItemConfiguration,
    usageCheck: WorkItemConfigurationUsageCheck,
    completionTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
    auditContext?: MutationAuditContext,
  ) {
    const saved = await this.saveConfiguration(
      workspaceId,
      'team',
      teamId,
      configuration,
      usageCheck,
      completionTransactItems,
      auditContext,
    )
    return { configuration: saved } satisfies ResolvedWorkItemConfiguration
  }

  /**
   * Reads every relation and the stable graph revision for one Team.
   *
   * Only bulk projections such as Focus and Team configuration validation use this read.
   * Relation mutations read the neighbourhood of their endpoints instead.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose complete relation graph is read.
   * @returns All directed relations and their stable graph revision.
   */
  async listRelationGraph(
    workspaceId: string,
    teamId: string,
  ): Promise<WorkItemRelationsResponse> {
    await this.ensureTable()
    const before = await this.getRelationGraphRevision(workspaceId, teamId)
    const relations = await this.queryRelationRows(
      workspaceId,
      teamId,
      RELATION_RECORD_PREFIX,
      TEAM_RELATION_EDGE_LIMIT,
    )
    const after = await this.getRelationGraphRevision(workspaceId, teamId)
    assertStableGraphRevision(before, after)
    return {
      graphRevision: after,
      relations,
    } satisfies WorkItemRelationsResponse
  }

  /**
   * Reads the relations stored with one Work Item as their source, without reading the Team graph.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation graph is read.
   * @param workItemId - Source Work Item whose neighbourhood is read.
   * @param options - Optional relation type filter.
   * @returns The source Work Item's relations and the stable graph revision.
   */
  async listRelations(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    options: ListWorkItemRelationsOptions = {},
  ) {
    await this.ensureTable()
    const before = await this.getRelationGraphRevision(workspaceId, teamId)
    const relations = await this.readWorkItemRelations(
      workspaceId,
      teamId,
      workItemId,
      options.types,
    )
    const after = await this.getRelationGraphRevision(workspaceId, teamId)
    assertStableGraphRevision(before, after)
    return {
      graphRevision: after,
      relations,
    } satisfies WorkItemRelationsResponse
  }

  /**
   * Creates one reciprocal relation in a single transaction.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns both endpoints.
   * @param input - Normalizable relation mutation input.
   * @param configurationConditionChecks - Configuration guards committed with the relation.
   * @param audit - Request audit input for the endpoint events committed with the relation.
   * @returns The created relation pair and the next graph revision.
   */
  async createRelation(
    workspaceId: string,
    teamId: string,
    input: MutateWorkItemRelationInput,
    configurationConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
    audit?: WorkItemRelationAuditInput,
  ) {
    await this.ensureTable()
    this.assertRelationAuditInput(workspaceId, audit)
    const normalized = normalizeRelationInput(input)
    if (normalized.sourceWorkItemId === normalized.targetWorkItemId) {
      throw new WorkItemConfigurationError(400, 'WorkItemRelationSelf', 'A Work Item cannot relate to itself.')
    }
    const graph = await this.readRelationGraphState(workspaceId, teamId)
    assertExpectedGraphRevision(graph.revision, normalized.expectedGraphRevision)
    const createdAt = new Date().toISOString()
    const relation: WorkItemRelation = {
      sourceWorkItemId: normalized.sourceWorkItemId,
      targetWorkItemId: normalized.targetWorkItemId,
      type: normalized.type,
      createdAt,
    }
    const reciprocalRelation: WorkItemRelation = {
      sourceWorkItemId: normalized.targetWorkItemId,
      targetWorkItemId: normalized.sourceWorkItemId,
      type: reciprocalRelationType(normalized.type),
      createdAt,
    }
    if (await this.readRelationRow(workspaceId, teamId, relation)) {
      throw new WorkItemConfigurationError(409, 'WorkItemRelationDuplicate', 'The relation already exists.')
    }
    if (normalized.type === 'parent') {
      const parents = await this.readWorkItemRelations(
        workspaceId,
        teamId,
        normalized.sourceWorkItemId,
        ['parent'],
      )
      if (parents.length > 0) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemParentAlreadyExists',
          'A Work Item can have only one parent. Replace the parent instead of adding another one.',
        )
      }
    }
    const nextEdgeCount = graph.edgeCount + 2
    assertTeamRelationEdgeCapacity(nextEdgeCount)
    await this.assertRelationDoesNotCreateCycle(
      workspaceId,
      teamId,
      normalized.type,
      normalized.sourceWorkItemId,
      normalized.targetWorkItemId,
    )
    const [sourceRelationIds, targetRelationIds] = await Promise.all([
      this.readChangedRelationIds(workspaceId, teamId, relation, { add: [relation] }),
      this.readChangedRelationIds(workspaceId, teamId, reciprocalRelation, { add: [reciprocalRelation] }),
    ])

    const endpoints: RelationTransactionEndpoint[] = [
      {
        workItemId: normalized.sourceWorkItemId,
        expectedRevision: normalized.sourceExpectedRevision,
        assignedProjectId: normalized.sourceAssignedProjectId,
        relationIds: sourceRelationIds,
        // A child that gains a parent starts from the default order there, as with replaceParent.
        ...(normalized.type === 'parent' ? { hierarchyRank: null } : {}),
      },
      {
        workItemId: normalized.targetWorkItemId,
        expectedRevision: normalized.targetExpectedRevision,
        assignedProjectId: normalized.targetAssignedProjectId,
        relationIds: targetRelationIds,
      },
    ]
    await this.sendRelationTransaction(workspaceId, teamId, {
      expectedRevision: graph.revision,
      nextEdgeCount,
      endpoints,
      edgeMutations: [
        createRelationPut(this.tableName, workspaceId, teamId, relation),
        createRelationPut(this.tableName, workspaceId, teamId, reciprocalRelation),
      ],
      configurationConditionChecks,
      auditPuts: this.createRelationAuditPuts(workspaceId, teamId, audit, createdAt, graph.revision + 1, [
        describeRelationAuditChange(relation, 'added'),
        describeRelationAuditChange(reciprocalRelation, 'added'),
      ], endpoints),
      classifyCancellation: () => this.classifyRelationTransactionCancellation(
        workspaceId,
        teamId,
        normalized,
        relation,
        reciprocalRelation,
        'create',
      ),
    })
    return { relation, reciprocalRelation, graphRevision: graph.revision + 1 }
  }

  /**
   * Deletes one reciprocal relation in a single transaction.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns both endpoints.
   * @param input - Normalizable relation mutation input; reciprocal types are accepted.
   * @param audit - Request audit input for the endpoint events committed with the deletion.
   * @returns The deleted relation pair and the next graph revision.
   */
  async deleteRelation(
    workspaceId: string,
    teamId: string,
    input: MutateWorkItemRelationInput,
    audit?: WorkItemRelationAuditInput,
  ) {
    await this.ensureTable()
    this.assertRelationAuditInput(workspaceId, audit)
    const normalized = normalizeRelationInput(input, true)
    const graph = await this.readRelationGraphState(workspaceId, teamId)
    assertExpectedGraphRevision(graph.revision, normalized.expectedGraphRevision)
    const [relation, reciprocalRelation] = await Promise.all([
      this.readRelationRow(workspaceId, teamId, {
        sourceWorkItemId: normalized.sourceWorkItemId,
        targetWorkItemId: normalized.targetWorkItemId,
        type: normalized.type,
      }),
      this.readRelationRow(workspaceId, teamId, {
        sourceWorkItemId: normalized.targetWorkItemId,
        targetWorkItemId: normalized.sourceWorkItemId,
        type: reciprocalRelationType(normalized.type),
      }),
    ])
    if (!relation) {
      throw new WorkItemConfigurationError(404, 'WorkItemRelationNotFound', 'The relation was not found.')
    }
    if (!reciprocalRelation) {
      throw new WorkItemConfigurationError(503, 'WorkItemRelationInconsistent', 'The reciprocal relation is missing.')
    }
    if (graph.edgeCount < 2) {
      throw new WorkItemConfigurationError(
        503,
        'WorkItemRelationInconsistent',
        'Stored relation graph metadata is inconsistent.',
      )
    }
    const [sourceRelationIds, targetRelationIds] = await Promise.all([
      this.readChangedRelationIds(workspaceId, teamId, relation, { remove: [relation] }),
      this.readChangedRelationIds(workspaceId, teamId, reciprocalRelation, { remove: [reciprocalRelation] }),
    ])
    const endpoints: RelationTransactionEndpoint[] = [
      {
        workItemId: normalized.sourceWorkItemId,
        expectedRevision: normalized.sourceExpectedRevision,
        assignedProjectId: normalized.sourceAssignedProjectId,
        relationIds: sourceRelationIds,
        // A child that loses its parent drops the sibling rank that only meant something under it.
        ...(normalized.type === 'parent' ? { hierarchyRank: null } : {}),
      },
      {
        workItemId: normalized.targetWorkItemId,
        expectedRevision: normalized.targetExpectedRevision,
        assignedProjectId: normalized.targetAssignedProjectId,
        relationIds: targetRelationIds,
        ...(normalized.type === 'child' ? { hierarchyRank: null } : {}),
      },
    ]
    await this.sendRelationTransaction(workspaceId, teamId, {
      expectedRevision: graph.revision,
      nextEdgeCount: graph.edgeCount - 2,
      endpoints,
      edgeMutations: [
        createRelationDelete(this.tableName, workspaceId, teamId, relation),
        createRelationDelete(this.tableName, workspaceId, teamId, reciprocalRelation),
      ],
      configurationConditionChecks: [],
      auditPuts: this.createRelationAuditPuts(
        workspaceId,
        teamId,
        audit,
        new Date().toISOString(),
        graph.revision + 1,
        [
          describeRelationAuditChange(relation, 'removed'),
          describeRelationAuditChange(reciprocalRelation, 'removed'),
        ],
        endpoints,
      ),
      classifyCancellation: () => this.classifyRelationTransactionCancellation(
        workspaceId,
        teamId,
        normalized,
        relation,
        reciprocalRelation,
        'delete',
      ),
    })
    return { relation, reciprocalRelation, graphRevision: graph.revision + 1 }
  }

  /**
   * Prepares the relation clean-up that is committed in the same transaction as a Work Item delete.
   *
   * Every relation row of the Work Item and its reciprocal row are deleted, and each other
   * endpoint whose projection held the Work Item gets its `relationIds` rewritten without it. The
   * other endpoint's revision is not advanced, the same as for a relation delete, but is required
   * to be unchanged. The graph revision advances once, so a relation changed meanwhile anywhere in
   * the Team stops the delete. A Work Item with children gets no clean-up: deleting it would leave
   * the children under a parent that no longer exists, so the caller refuses the delete. The Work
   * Item's child restore guard row is deleted with it.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item about to be deleted.
   * @returns The Work Item's children and the clean-up writes.
   * @throws WorkItemConfigurationError `503 WorkItemRelationInconsistent` when a reciprocal row, an
   * endpoint, or the edge count is missing.
   */
  async prepareWorkItemDeletionRelationCleanup(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    audit?: WorkItemDeletionRelationAuditInput,
  ): Promise<WorkItemDeletionRelationCleanup> {
    await this.ensureTable()
    this.assertRelationAuditInput(workspaceId, audit)
    const graph = await this.readRelationGraphState(workspaceId, teamId)
    const relations = await this.readWorkItemRelations(workspaceId, teamId, workItemId)
    const childWorkItemIds = relations
      .filter((relation) => relation.type === 'child')
      .map((relation) => relation.targetWorkItemId)
    if (childWorkItemIds.length > 0) return { childWorkItemIds, transactItems: [] }
    // The Work Item's child restore guard is only read by an archive of the Work Item itself.
    const guardDelete = {
      Delete: {
        TableName: this.tableName,
        Key: createChildRestoreGuardKey(workspaceId, teamId, workItemId),
      },
    }
    if (relations.length === 0) {
      return {
        childWorkItemIds,
        transactItems: [
          createWorkItemRelationGraphRevisionConditionCheck(
            this.tableName,
            workspaceId,
            teamId,
            graph.revision,
          ),
          guardDelete,
        ],
      }
    }
    const reciprocals = await Promise.all(relations.map(async (relation) => {
      const reciprocal = await this.readRelationRow(workspaceId, teamId, {
        sourceWorkItemId: relation.targetWorkItemId,
        targetWorkItemId: relation.sourceWorkItemId,
        type: reciprocalRelationType(relation.type),
      })
      if (!reciprocal) {
        throw new WorkItemConfigurationError(503, 'WorkItemRelationInconsistent', 'The reciprocal relation is missing.')
      }
      return reciprocal
    }))
    if (graph.edgeCount < relations.length * 2) {
      throw new WorkItemConfigurationError(
        503,
        'WorkItemRelationInconsistent',
        'Stored relation graph metadata is inconsistent.',
      )
    }
    // One endpoint can hold several relations to the Work Item, and a transaction may write each
    // item only once, so each other endpoint is guarded once with all of its removed rows.
    const removedByEndpoint = new Map<string, WorkItemRelation[]>()
    for (const reciprocal of reciprocals) {
      removedByEndpoint.set(reciprocal.sourceWorkItemId, [
        ...removedByEndpoint.get(reciprocal.sourceWorkItemId) ?? [],
        reciprocal,
      ])
    }
    const workItemPartitionKey = `${workspaceId}#team#${teamId}`
    const endpoints = await Promise.all([...removedByEndpoint].map(async ([endpointId, removed]) => {
      const projected = removed.filter((relation) => isProjectedRelationType(relation.type))
      const [relationIds, response] = await Promise.all([
        projected.length > 0
          ? this.readRelationIdsAfter(workspaceId, teamId, endpointId, { remove: projected })
          : Promise.resolve(undefined),
        this.documentClient.send(new GetCommand({
          TableName: this.workItemsTableName,
          Key: { directoryTeamId: workItemPartitionKey, issueId: endpointId },
          ConsistentRead: true,
        })),
      ])
      const endpoint = response.Item
      if (
        !endpoint ||
        typeof endpoint.revision !== 'number' ||
        (endpoint.assignedProjectId !== undefined && typeof endpoint.assignedProjectId !== 'string')
      ) {
        throw new WorkItemConfigurationError(503, 'WorkItemRelationInconsistent', 'A relation endpoint is missing.')
      }
      const assignedProjectId = typeof endpoint.assignedProjectId === 'string'
        ? endpoint.assignedProjectId
        : undefined
      const snapshot: RelationTransactionEndpoint = {
        workItemId: endpointId,
        expectedRevision: endpoint.revision,
        ...(assignedProjectId ? { assignedProjectId } : {}),
        // An endpoint holding only the parent's `child` row keeps its projection; its guard still
        // pins the Project assignment recorded on its audit event.
        ...(relationIds ? { relationIds } : {}),
      }
      const notification: WorkItemRelationNotificationEndpoint | undefined = audit
        ? {
            assigneeMemberKey: typeof endpoint.assigneeUserId === 'string' ? endpoint.assigneeUserId : '',
            title: typeof endpoint.title === 'string' ? endpoint.title : endpointId,
            deepLink: audit.createDeepLink(endpointId),
            ...(assignedProjectId ? { assignedProjectId } : {}),
          }
        : undefined
      return { snapshot, notification }
    }))
    const snapshots = endpoints.map((endpoint) => endpoint.snapshot)
    const relationAudit: WorkItemRelationAuditInput | undefined = audit
      ? {
          context: audit.context,
          actorMemberKey: audit.actorMemberKey,
          notificationEndpoints: new Map(endpoints.flatMap((endpoint) =>
            endpoint.notification ? [[endpoint.snapshot.workItemId, endpoint.notification] as const] : []
          )),
        }
      : undefined
    return {
      childWorkItemIds,
      transactItems: [
        createRelationGraphAdvance(
          this.tableName,
          createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
          graph.revision,
          graph.edgeCount - relations.length * 2,
        ),
        ...[...relations, ...reciprocals].map((relation) =>
          createRelationDelete(this.tableName, workspaceId, teamId, relation)
        ),
        ...snapshots.map((snapshot) =>
          createRelationEndpointTransactionItem(this.workItemsTableName, workItemPartitionKey, snapshot)
        ),
        guardDelete,
        // The deleted Work Item keeps only its own delete event; each other endpoint records the
        // removal from its point of view, so a cleared blocker notifies the blocked Work Item.
        ...this.createRelationAuditPuts(
          workspaceId,
          teamId,
          relationAudit,
          audit?.context.occurredAt ?? new Date().toISOString(),
          graph.revision + 1,
          reciprocals.map((reciprocal) => describeRelationAuditChange(reciprocal, 'removed')),
          snapshots,
          audit?.firstSequence,
        ),
      ],
    }
  }

  /**
   * Sets, replaces, or removes a Work Item's single parent as one atomic transaction.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns every endpoint.
   * @param input - Child, observed current parent, and requested next parent snapshots.
   * @param configurationConditionChecks - Configuration guards committed with the new parent link.
   * @param audit - Request audit input for the endpoint events committed with a parent change.
   * @returns The previous and next parent IDs with the resulting graph revision.
   */
  async replaceParent(
    workspaceId: string,
    teamId: string,
    input: ReplaceWorkItemParentInput,
    configurationConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
    audit?: WorkItemRelationAuditInput,
  ): Promise<WorkItemParentMutationResponse> {
    await this.ensureTable()
    this.assertRelationAuditInput(workspaceId, audit)
    const normalized = normalizeReplaceParentInput(input)
    const child = normalized.child
    if (normalized.nextParent?.workItemId === child.workItemId) {
      throw new WorkItemConfigurationError(400, 'WorkItemRelationSelf', 'A Work Item cannot relate to itself.')
    }
    const graph = await this.readRelationGraphState(workspaceId, teamId)
    const storedParents = await this.readWorkItemRelations(
      workspaceId,
      teamId,
      child.workItemId,
      ['parent'],
    )
    const previousParentWorkItemId = normalized.currentParent?.workItemId ?? null
    const parentWorkItemId = normalized.nextParent?.workItemId ?? null
    // Setting a parent is declarative: when the child already has exactly the requested parent,
    // including on a retry after a lost response, report success without writing. The revision is
    // read again so the response never pairs the stored parent with a revision older than it.
    if (
      storedParents.length === (parentWorkItemId ? 1 : 0) &&
      (storedParents[0]?.targetWorkItemId ?? null) === parentWorkItemId
    ) {
      // A rank already stored is declarative success too: the move committed and only its
      // response was lost, so the retry's older graph revision must not turn it into a conflict.
      const hierarchyRank = normalized.hierarchyRank
      const previousHierarchyRank = hierarchyRank === undefined
        ? undefined
        : await this.readStoredHierarchyRank(workspaceId, teamId, child.workItemId)
      if (hierarchyRank !== undefined && previousHierarchyRank !== hierarchyRank) {
        // The rank was chosen among the siblings the caller saw, so it needs their graph revision.
        // The rank write advances that revision, so a concurrent reorder or parent change conflicts.
        assertExpectedGraphRevision(graph.revision, normalized.expectedGraphRevision)
        const graphRevision = await this.writeHierarchyRank(
          workspaceId,
          teamId,
          child,
          hierarchyRank,
          graph,
          // The parent and the configuration guards authorized the reorder, so a parent moved to
          // another Project or a guard that changed before the commit refuses it.
          normalized.nextParent
            ? { parent: normalized.nextParent, configurationConditionChecks }
            : undefined,
          (occurredAt, nextGraphRevision) => this.createRelationAuditPuts(
            workspaceId,
            teamId,
            audit,
            occurredAt,
            nextGraphRevision,
            [describeSiblingReorderAuditChange(
              child.workItemId,
              parentWorkItemId,
              previousHierarchyRank,
              hierarchyRank,
            )],
            [child],
          ),
        )
        return { previousParentWorkItemId, parentWorkItemId, graphRevision }
      }
      const after = await this.getRelationGraphRevision(workspaceId, teamId)
      assertStableGraphRevision(graph.revision, after)
      return { previousParentWorkItemId, parentWorkItemId, graphRevision: after }
    }
    assertExpectedGraphRevision(graph.revision, normalized.expectedGraphRevision)
    if (
      storedParents.length !== (normalized.currentParent ? 1 : 0) ||
      (storedParents[0]?.targetWorkItemId ?? null) !== previousParentWorkItemId
    ) {
      throw new WorkItemConfigurationError(
        409,
        'WorkItemRelationGraphConflict',
        'The Work Item parent changed. Reload and try again.',
      )
    }
    const removed: WorkItemRelation[] = []
    const storedParent = storedParents[0]
    if (storedParent) {
      const storedChild = await this.readRelationRow(workspaceId, teamId, {
        sourceWorkItemId: storedParent.targetWorkItemId,
        targetWorkItemId: child.workItemId,
        type: 'child',
      })
      if (!storedChild) {
        throw new WorkItemConfigurationError(
          503,
          'WorkItemRelationInconsistent',
          'The reciprocal relation is missing.',
        )
      }
      removed.push(storedParent, storedChild)
    }
    const createdAt = new Date().toISOString()
    const added: WorkItemRelation[] = normalized.nextParent
      ? [
          {
            sourceWorkItemId: child.workItemId,
            targetWorkItemId: normalized.nextParent.workItemId,
            type: 'parent',
            createdAt,
          },
          {
            sourceWorkItemId: normalized.nextParent.workItemId,
            targetWorkItemId: child.workItemId,
            type: 'child',
            createdAt,
          },
        ]
      : []
    const nextEdgeCount = graph.edgeCount + added.length - removed.length
    if (nextEdgeCount < 0) {
      throw new WorkItemConfigurationError(
        503,
        'WorkItemRelationInconsistent',
        'Stored relation graph metadata is inconsistent.',
      )
    }
    if (nextEdgeCount > graph.edgeCount) {
      assertTeamRelationEdgeCapacity(nextEdgeCount)
    }
    if (normalized.nextParent) {
      await this.assertRelationDoesNotCreateCycle(
        workspaceId,
        teamId,
        'parent',
        child.workItemId,
        normalized.nextParent.workItemId,
      )
    }
    const childAdded = added.filter((relation) => relation.sourceWorkItemId === child.workItemId)
    const childRemoved = removed.filter((relation) => relation.sourceWorkItemId === child.workItemId)
    const childRelationIds = await this.readRelationIdsAfter(
      workspaceId,
      teamId,
      child.workItemId,
      { add: childAdded, remove: childRemoved },
    )
    const endpoints: RelationTransactionEndpoint[] = [
      { ...child, relationIds: childRelationIds, hierarchyRank: normalized.hierarchyRank ?? null },
      ...(normalized.currentParent ? [normalized.currentParent] : []),
      ...(normalized.nextParent ? [normalized.nextParent] : []),
    ]
    await this.sendRelationTransaction(workspaceId, teamId, {
      expectedRevision: graph.revision,
      nextEdgeCount,
      endpoints,
      edgeMutations: [
        ...removed.map((relation) => createRelationDelete(this.tableName, workspaceId, teamId, relation)),
        ...added.map((relation) => createRelationPut(this.tableName, workspaceId, teamId, relation)),
      ],
      configurationConditionChecks: normalized.nextParent ? configurationConditionChecks : [],
      auditPuts: this.createRelationAuditPuts(workspaceId, teamId, audit, createdAt, graph.revision + 1, [
        {
          workItemId: child.workItemId,
          eventType: 'work-item.parent-changed',
          relationType: 'parent',
          ...(previousParentWorkItemId ? { previousParentWorkItemId } : {}),
          ...(parentWorkItemId ? { parentWorkItemId } : {}),
        },
        ...removed
          .filter((relation) => relation.type === 'child')
          .map((relation) => describeRelationAuditChange(relation, 'removed')),
        ...added
          .filter((relation) => relation.type === 'child')
          .map((relation) => describeRelationAuditChange(relation, 'added')),
      ], endpoints),
      classifyCancellation: () => this.classifyParentReplacementCancellation(
        workspaceId,
        teamId,
        normalized,
      ),
    })
    return { previousParentWorkItemId, parentWorkItemId, graphRevision: graph.revision + 1 }
  }

  /**
   * Reads the sibling order rank stored on a Work Item.
   *
   * @param workspaceId - Workspace that owns the Work Item.
   * @param teamId - Team that owns the Work Item.
   * @param workItemId - Work Item to read.
   * @returns The stored rank, or undefined when the Work Item follows its default rank.
   */
  private async readStoredHierarchyRank(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<string | undefined> {
    let response: GetCommandOutput
    try {
      response = await this.documentClient.send(new GetCommand({
        TableName: this.workItemsTableName,
        Key: { directoryTeamId: `${workspaceId}#team#${teamId}`, issueId: workItemId },
        ProjectionExpression: '#hierarchyRank',
        ExpressionAttributeNames: { '#hierarchyRank': 'hierarchyRank' },
        ConsistentRead: true,
      }))
    } catch (error) {
      if (error instanceof WorkItemConfigurationError) throw error
      throw new WorkItemConfigurationError(
        503,
        'WorkItemRelationUnavailable',
        'The Work Item hierarchy cannot be read now. Try again.',
      )
    }
    const rank: unknown = response.Item?.hierarchyRank
    return typeof rank === 'string' ? rank : undefined
  }

  /**
   * Stores a child's sibling order rank without changing its parent.
   *
   * The write advances the graph revision the caller read, in the same transaction. A parent
   * change or another reorder made meanwhile therefore makes this reorder fail with a conflict
   * instead of overwriting a rank chosen from a newer outline.
   *
   * @param workspaceId - Workspace that owns the Work Item.
   * @param teamId - Team that owns the Work Item.
   * @param child - Child snapshot whose revision and Project assignment fence the write.
   * @param hierarchyRank - Validated rank to store.
   * @param graph - Relation graph state read before the unchanged parent was observed.
   * @param authorization - The unchanged parent and the configuration guards that authorized the
   *   reorder, checked again in the transaction; omitted for a top-level Work Item.
   * @param createAuditPuts - Builds the reorder audit event Puts committed with the rank, given the
   *   commit timestamp and the graph revision the reorder writes.
   * @returns The graph revision after the reorder.
   */
  private async writeHierarchyRank(
    workspaceId: string,
    teamId: string,
    child: WorkItemRelationEndpointSnapshot,
    hierarchyRank: string,
    graph: { revision: number, edgeCount: number },
    authorization?: {
      parent: WorkItemRelationEndpointSnapshot
      configurationConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']>
    },
    createAuditPuts: (
      occurredAt: string,
      graphRevision: number,
    ) => NonNullable<TransactWriteCommandInput['TransactItems']> = () => [],
  ): Promise<number> {
    const item = createRelationEndpointTransactionItem(
      this.workItemsTableName,
      `${workspaceId}#team#${teamId}`,
      { ...child, hierarchyRank },
    )
    if (!item.Update) {
      throw new WorkItemConfigurationError(500, 'WorkItemHierarchyRankWriteInvalid', 'The rank write is invalid.')
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          item,
          createRelationGraphAdvance(
            this.tableName,
            createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
            graph.revision,
            graph.edgeCount,
          ),
          ...(authorization
            ? [
                createRelationEndpointTransactionItem(
                  this.workItemsTableName,
                  `${workspaceId}#team#${teamId}`,
                  authorization.parent,
                ),
                ...authorization.configurationConditionChecks,
              ]
            : []),
          // Audit Puts come last so the fence indexes checked below keep their positions.
          ...createAuditPuts(new Date().toISOString(), graph.revision + 1),
        ],
      }))
      return graph.revision + 1
    } catch (error) {
      const itemCount = 2 + (authorization ? 1 + authorization.configurationConditionChecks.length : 0)
      if (Array.from({ length: itemCount }, (_, index) => index)
        .some((index) => isTransactionConditionalFailureAt(error, index))) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemRelationGraphConflict',
          'The Work Item changed. Reload and try again.',
        )
      }
      if (isPermanentTransactionRejection(error)) {
        throw createRelationStoragePermanentError()
      }
      if (isTransactionCancellationReason(error, 'TransactionConflict')) {
        // Another write to the same rows in flight cancels this one without a failed condition.
        // A revision that moved meanwhile is a conflict; otherwise the reorder can be retried.
        let after: number
        try {
          after = await this.getRelationGraphRevision(workspaceId, teamId)
        } catch (readError) {
          throw toPersistenceError(readError)
        }
        if (after !== graph.revision) {
          throw new WorkItemConfigurationError(
            409,
            'WorkItemRelationGraphConflict',
            'The Work Item hierarchy changed. Reload and try again.',
          )
        }
        throw new WorkItemConfigurationError(
          503,
          'WorkItemRelationUnavailable',
          'The reorder was canceled by a concurrent write. Try again.',
        )
      }
      throw toPersistenceError(error)
    }
  }

  private async ensureTable() {
    if (this.bootstrapLocalTable) {
      await ensureLocalWorkItemConfigurationTable(this.tableName, this.dynamoDbClient)
      if (this.auditTableName) {
        await ensureLocalAuditEventsTable(this.auditTableName, this.dynamoDbClient)
      }
    }
  }

  private async getStoredConfiguration(
    workspaceId: string,
    scopeType: WorkItemConfigurationScopeType,
    scopeId: string,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createWorkItemConfigurationScopeKey(workspaceId, scopeType, scopeId),
        recordKey: CONFIGURATION_RECORD_KEY,
      },
      ConsistentRead: true,
    }))
    if (!response.Item) {
      return undefined
    }
    return validateStoredConfiguration(response.Item, scopeType, scopeId)
  }

  private async saveConfiguration(
    workspaceId: string,
    scopeType: WorkItemConfigurationScopeType,
    scopeId: string,
    configuration: WorkItemConfiguration,
    usageCheck: WorkItemConfigurationUsageCheck,
    completionTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']>,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureTable()
    const validated = validateWorkItemConfiguration(configuration, { scopeType, scopeId })
    if (this.auditTableName && auditContext === undefined) {
      throw new WorkItemConfigurationError(
        500,
        'WorkItemConfigurationAuditContextMissing',
        'Work Item configuration mutation audit context is required.',
      )
    }
    if (auditContext && auditContext.workspaceId !== workspaceId) {
      throw new WorkItemConfigurationError(
        500,
        'WorkItemConfigurationAuditContextMismatch',
        'Work Item configuration mutation audit context does not match the target Workspace.',
      )
    }
    const scopeKey = createWorkItemConfigurationScopeKey(workspaceId, scopeType, scopeId)
    const nextRevision = validated.revision + 1
    const item = {
      ...validated,
      scopeKey,
      recordKey: CONFIGURATION_RECORD_KEY,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
    }
    validateWorkItemConfigurationItemSize(item)
    const lock = await this.acquireConfigurationWriteLock(scopeKey)
    const releaseLock = async () => {
      try {
        await this.releaseConfigurationWriteLock(scopeKey, lock.token)
      } catch (releaseError) {
        console.error('Failed to release Work Item configuration write lock.', releaseError)
      }
    }
    const auditEnabled = this.auditTableName !== undefined
    let previousConfiguration: WorkItemConfiguration | undefined
    let usageConditionChecks: WorkItemConfigurationTransactionItems = []
    try {
      if (auditEnabled) {
        previousConfiguration = await this.getStoredConfiguration(workspaceId, scopeType, scopeId)
      }
      usageConditionChecks = (await usageCheck()) ?? []
    } catch (error) {
      await releaseLock()
      throw error
    }

    const auditPut = auditEnabled
      ? createMutationAuditEventPut(this.auditTableName, auditContext, {
          directoryId: workspaceId,
          eventType: previousConfiguration
            ? 'work-item-configuration.updated'
            : 'work-item-configuration.created',
          entityType: 'work-item-configuration',
          entityId: `${scopeType}:${scopeId}`,
          action: previousConfiguration ? 'updated' : 'created',
          occurredAt: item.updatedAt,
          changes: createAuditFieldChanges(
            previousConfiguration
              ? createWorkItemConfigurationAuditSnapshot(previousConfiguration)
              : undefined,
            createWorkItemConfigurationAuditSnapshot({
              ...validated,
              revision: nextRevision,
            }),
          ),
          summary: previousConfiguration
            ? 'Work Item configuration was updated.'
            : 'Work Item configuration was created.',
          metadata: {
            adapter: 'work-item-configuration',
            scopeType,
            scopeId,
            previousRevision: previousConfiguration?.revision ?? 0,
            revision: nextRevision,
          },
        })
      : undefined

    const transactionItemCount = 2 + usageConditionChecks.length + completionTransactItems.length +
      (auditPut === undefined ? 0 : 1)
    if (transactionItemCount > DYNAMODB_TRANSACTION_ITEM_LIMIT) {
      await releaseLock()
      throw new WorkItemConfigurationError(
        413,
        'WorkItemConfigurationTransactionTooLarge',
        'Work Item configuration changes exceed the transaction limit.',
      )
    }

    const currentEpochSeconds = Math.floor(Date.now() / 1_000)
    try {
      const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        {
          Put: {
            TableName: this.tableName,
            Item: item,
            ...(validated.revision === 0
              ? {
                  ConditionExpression:
                    'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
                }
              : {
                  ConditionExpression: '#revision = :expectedRevision',
                  ExpressionAttributeNames: { '#revision': 'revision' },
                  ExpressionAttributeValues: { ':expectedRevision': validated.revision },
                }),
          },
        },
        {
          Delete: {
            TableName: this.tableName,
            Key: { scopeKey, recordKey: CONFIGURATION_WRITE_LOCK_RECORD_KEY },
            ConditionExpression: '#token = :token AND #expiresAt >= :now',
            ExpressionAttributeNames: {
              '#expiresAt': 'expiresAtEpochSeconds',
              '#token': 'token',
            },
            ExpressionAttributeValues: {
              ':now': currentEpochSeconds,
              ':token': lock.token,
            },
          },
        },
        ...usageConditionChecks,
        ...completionTransactItems,
        ...(auditPut === undefined ? [] : [auditPut]),
      ]
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      await releaseLock()
      if (
        isNamedError(error, 'ConditionalCheckFailedException') ||
        isConfigurationConditionalTransactionCancellation(error) ||
        usageConditionChecks.some((_, index) =>
          isTransactionConditionalFailureAt(error, 2 + index),
        )
      ) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemConfigurationRevisionConflict',
          'Work Item configuration changed. Reload and try again.',
        )
      }
      throw toPersistenceError(error)
    }
    return validateStoredConfiguration(item, scopeType, scopeId)
  }

  private async acquireConfigurationWriteLock(scopeKey: string) {
    const token = globalThis.crypto.randomUUID()
    const currentEpochSeconds = Math.floor(Date.now() / 1_000)
    const expiresAtEpochSeconds = currentEpochSeconds + CONFIGURATION_WRITE_LOCK_LEASE_SECONDS
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          scopeKey,
          recordKey: CONFIGURATION_WRITE_LOCK_RECORD_KEY,
          entryType: 'configuration-write-lock',
          token,
          expiresAtEpochSeconds,
        },
        ConditionExpression:
          '(attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)) OR #expiresAt < :now',
        ExpressionAttributeNames: { '#expiresAt': 'expiresAtEpochSeconds' },
        ExpressionAttributeValues: { ':now': currentEpochSeconds },
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemConfigurationWriteInProgress',
          'Another Work Item configuration update is in progress.',
        )
      }
      throw toPersistenceError(error)
    }
    return { token }
  }

  private async releaseConfigurationWriteLock(scopeKey: string, token: string) {
    try {
      await this.documentClient.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { scopeKey, recordKey: CONFIGURATION_WRITE_LOCK_RECORD_KEY },
        ConditionExpression: '#token = :token',
        ExpressionAttributeNames: { '#token': 'token' },
        ExpressionAttributeValues: { ':token': token },
      }))
    } catch (error) {
      if (!isNamedError(error, 'ConditionalCheckFailedException')) {
        throw toPersistenceError(error)
      }
    }
  }

  /**
   * Reads the graph revision and stored directed edge count for one Team.
   *
   * Graph rows written before the edge count existed are counted once with a COUNT query; the
   * next mutation stores the count.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose graph metadata is read.
   * @returns The current revision and directed edge count.
   */
  private async readRelationGraphState(
    workspaceId: string,
    teamId: string,
  ): Promise<RelationGraphState> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
        recordKey: RELATION_GRAPH_RECORD_KEY,
      },
      ConsistentRead: true,
    }))
    if (!response.Item) {
      return { revision: 0, edgeCount: 0 }
    }
    const revision = readRelationGraphRevisionItem(response.Item)
    const edgeCount = response.Item.edgeCount === undefined
      ? await this.countRelationRows(workspaceId, teamId)
      : readStoredEdgeCount(response.Item.edgeCount)
    return { revision, edgeCount }
  }

  /**
   * Counts the directed relation rows of a Team graph without reading their attributes.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation rows are counted.
   * @returns The number of stored directed relation rows.
   */
  private async countRelationRows(workspaceId: string, teamId: string) {
    let count = 0
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'scopeKey = :scopeKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':scopeKey': createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
          ':prefix': RELATION_RECORD_PREFIX,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
        Select: 'COUNT',
      }))
      count += response.Count ?? 0
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return count
  }

  /**
   * Reads every relation row under one record key prefix with strongly consistent pages.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation rows are read.
   * @param prefix - Relation record key prefix.
   * @param limit - Optional maximum number of rows before failing closed.
   * @returns Relation rows in record key order.
   */
  private async queryRelationRows(
    workspaceId: string,
    teamId: string,
    prefix: string,
    limit?: number,
  ) {
    const relations: WorkItemRelation[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'scopeKey = :scopeKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':scopeKey': createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
          ':prefix': prefix,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }))
      for (const item of response.Items ?? []) {
        relations.push(readRelationItem(item))
        if (limit !== undefined && relations.length > limit) {
          throw teamRelationLimitExceeded()
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return relations
  }

  /**
   * Reads the relations whose source is one Work Item through its record key prefix.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation rows are read.
   * @param workItemId - Source Work Item ID.
   * @param types - Optional relation types; omitted reads every type.
   * @returns Relation rows of the Work Item in record key order.
   */
  private async readWorkItemRelations(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    types?: readonly WorkItemRelationType[],
  ) {
    const sourcePrefix = createRelationSourcePrefix(workItemId)
    const pages = types === undefined
      ? [await this.queryRelationRows(workspaceId, teamId, sourcePrefix)]
      : await Promise.all([...new Set(types)].sort().map((type) =>
          this.queryRelationRows(workspaceId, teamId, `${sourcePrefix}${encodeURIComponent(type)}#`)
        ))
    const relations = pages.flat()
    if (relations.some((relation) => relation.sourceWorkItemId !== workItemId)) {
      throw storedRelationInvalid()
    }
    return relations
  }

  /**
   * Reads one directed relation row by its exact key.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation row is read.
   * @param relation - Source, target, and type identifying the row.
   * @returns The stored relation, or undefined when the row does not exist.
   */
  private async readRelationRow(
    workspaceId: string,
    teamId: string,
    relation: WorkItemRelation,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
        recordKey: createRelationRecordKey(relation),
      },
      ConsistentRead: true,
    }))
    if (!response.Item) {
      return undefined
    }
    const stored = readRelationItem(response.Item)
    if (
      stored.sourceWorkItemId !== relation.sourceWorkItemId ||
      stored.targetWorkItemId !== relation.targetWorkItemId ||
      stored.type !== relation.type
    ) {
      throw storedRelationInvalid()
    }
    return stored
  }

  /**
   * Computes the next `relationIds` of a relation's source when that relation is projected.
   *
   * `child` rows are not projected, so a parent's row is only condition-checked.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation rows are read.
   * @param relation - Directed relation being added or removed.
   * @param change - Rows added to or removed from the source.
   * @returns The next projection, or undefined when the source projection does not change.
   */
  private async readChangedRelationIds(
    workspaceId: string,
    teamId: string,
    relation: WorkItemRelation,
    change: RelationProjectionChange,
  ) {
    if (!isProjectedRelationType(relation.type)) {
      return undefined
    }
    return this.readRelationIdsAfter(workspaceId, teamId, relation.sourceWorkItemId, change)
  }

  /**
   * Reads one Work Item's projected relations and applies a pending change.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation rows are read.
   * @param workItemId - Work Item whose projection is computed.
   * @param change - Rows added to or removed from the Work Item.
   * @returns The sorted `relationIds` after the change.
   */
  private async readRelationIdsAfter(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    change: RelationProjectionChange,
  ) {
    const current = await this.readWorkItemRelations(
      workspaceId,
      teamId,
      workItemId,
      WORK_ITEM_PROJECTED_RELATION_TYPES,
    )
    const removedKeys = new Set((change.remove ?? []).map(createRelationRecordKey))
    return createWorkItemRelationIds([
      ...current.filter((relation) => !removedKeys.has(createRelationRecordKey(relation))),
      ...(change.add ?? []),
    ], workItemId)
  }

  /**
   * Rejects parent and blocks relations that would close a cycle.
   *
   * The traversal follows the same relation type from the new target, reading only the
   * neighbourhood of each visited Work Item. A parent chain is linear because every Work Item has
   * at most one parent.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation rows are read.
   * @param type - Relation type being added.
   * @param sourceWorkItemId - Source of the new relation.
   * @param targetWorkItemId - Target of the new relation.
   */
  private async assertRelationDoesNotCreateCycle(
    workspaceId: string,
    teamId: string,
    type: WorkItemRelationType,
    sourceWorkItemId: string,
    targetWorkItemId: string,
  ) {
    if (type !== 'parent' && type !== 'blocks') {
      return
    }
    const visited = new Set<string>()
    let frontier = [targetWorkItemId]
    while (frontier.length > 0) {
      if (frontier.includes(sourceWorkItemId)) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemRelationCycle',
          `The ${type} relation would create a cycle.`,
        )
      }
      for (const workItemId of frontier) {
        visited.add(workItemId)
      }
      if (visited.size > RELATION_TRAVERSAL_NODE_LIMIT) {
        throw new WorkItemConfigurationError(
          413,
          'WorkItemRelationTraversalLimitExceeded',
          `Cycle validation cannot visit more than ${RELATION_TRAVERSAL_NODE_LIMIT} Work Items.`,
        )
      }
      const next = new Set<string>()
      for (
        let offset = 0;
        offset < frontier.length;
        offset += RELATION_TRAVERSAL_READ_CONCURRENCY
      ) {
        const batch = frontier.slice(offset, offset + RELATION_TRAVERSAL_READ_CONCURRENCY)
        const pages = await Promise.all(batch.map((workItemId) =>
          this.readWorkItemRelations(workspaceId, teamId, workItemId, [type])
        ))
        for (const relation of pages.flat()) {
          if (!visited.has(relation.targetWorkItemId)) {
            next.add(relation.targetWorkItemId)
          }
        }
      }
      frontier = [...next]
    }
  }

  /**
   * Reads a parent Work Item's child restore generation with a strongly consistent read.
   *
   * @param workspaceId - Workspace that owns the parent Work Item.
   * @param teamId - Team that owns the parent Work Item.
   * @param parentWorkItemId - Parent Work Item about to be archived.
   * @returns Current generation, or zero before any child was restored.
   * @throws WorkItemConfigurationError `503 StoredWorkItemConfigurationInvalid` when the row is malformed
   * or has an unsupported schema.
   */
  async getChildRestoreGeneration(
    workspaceId: string,
    teamId: string,
    parentWorkItemId: string,
  ): Promise<number> {
    await this.ensureTable()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createChildRestoreGuardKey(workspaceId, teamId, parentWorkItemId),
      ConsistentRead: true,
    }))
    const item = response.Item
    if (!item) return 0
    if (
      item.entryType !== CHILD_RESTORE_GUARD_ENTRY_TYPE ||
      item.schemaVersion !== WORK_ITEM_CONFIGURATION_SCHEMA_VERSION ||
      typeof item.generation !== 'number' ||
      !Number.isSafeInteger(item.generation) ||
      item.generation < 1
    ) {
      throw storedConfigurationInvalid()
    }
    return item.generation
  }

  /**
   * Reads how many relation links, parent links included, a Team stores.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation graph is read.
   * @returns Stored links, each counted once although it is kept as two directed rows.
   */
  async countRelationLinks(workspaceId: string, teamId: string): Promise<number> {
    await this.ensureTable()
    const { edgeCount } = await this.readRelationGraphState(workspaceId, teamId)
    return Math.floor(edgeCount / 2)
  }

  /**
   * Reads the current canonical relation graph revision with a strongly consistent read.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose relation graph is read.
   * @returns Current positive revision, or zero before graph metadata exists.
   */
  async getRelationGraphRevision(workspaceId: string, teamId: string): Promise<number> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
        recordKey: RELATION_GRAPH_RECORD_KEY,
      },
      ConsistentRead: true,
    }))
    if (!response.Item) {
      return 0
    }
    return readRelationGraphRevisionItem(response.Item)
  }

  /**
   * Rejects a relation mutation whose audit input is missing or belongs to another Workspace.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param audit - Request audit input supplied by the caller.
   */
  private assertRelationAuditInput(workspaceId: string, audit: WorkItemRelationAuditInput | undefined) {
    if (this.auditTableName && audit === undefined) {
      throw new WorkItemConfigurationError(
        500,
        'WorkItemRelationAuditContextMissing',
        'Work Item relation mutation audit context is required.',
      )
    }
    if (audit && audit.context.workspaceId !== workspaceId) {
      throw new WorkItemConfigurationError(
        500,
        'WorkItemRelationAuditContextMismatch',
        'Work Item relation mutation audit context does not match the target Workspace.',
      )
    }
  }

  /**
   * Creates one audit event Put per endpoint change for the relation transaction.
   *
   * Each endpoint gets its own event under its Work Item entity so both activity timelines show
   * the change. The Work Item `revision` stays unchanged; the events carry the graph revision.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns every endpoint.
   * @param audit - Request audit input; omitted only when auditing is not configured.
   * @param occurredAt - Commit timestamp shared by every event of the mutation.
   * @param graphRevision - Relation graph revision written by the mutation.
   * @param changes - Endpoint changes in a deterministic order.
   * @param endpoints - Endpoint snapshots guarded by the same transaction; each change's endpoint
   * must be among them so its event records the Project assignment the commit checked.
   * @param firstSequence - Audit sequence slot of the first change; later changes take the next
   * slots.
   * @returns Audit event Puts, or none when auditing is not configured.
   */
  private createRelationAuditPuts(
    workspaceId: string,
    teamId: string,
    audit: WorkItemRelationAuditInput | undefined,
    occurredAt: string,
    graphRevision: number,
    changes: readonly RelationAuditChange[],
    endpoints: readonly WorkItemRelationEndpointSnapshot[],
    firstSequence = 0,
  ): NonNullable<TransactWriteCommandInput['TransactItems']> {
    return changes.flatMap((change, index) => {
      const sequence = firstSequence + index
      const endpoint = endpoints.find((candidate) => candidate.workItemId === change.workItemId)
      if (!endpoint) {
        throw new WorkItemConfigurationError(
          500,
          'WorkItemRelationAuditEndpointMissing',
          'A relation audit event has no guarded endpoint snapshot.',
        )
      }
      const put = createMutationAuditEventPut(this.auditTableName, audit?.context, {
        directoryId: workspaceId,
        eventType: change.eventType,
        entityType: 'work-item',
        entityId: createRelationAuditEntityId(teamId, change.workItemId),
        action: change.eventType.slice('work-item.'.length),
        occurredAt,
        // The other endpoint may sit in a Project this endpoint's viewers cannot read, so its ID
        // stays out of the public `changes` and lives only in metadata, which views never expose.
        changes: [],
        summary: RELATION_AUDIT_SUMMARIES[change.eventType],
        metadata: {
          adapter: 'work-item-relation',
          ...(audit ? { actorMemberKey: audit.actorMemberKey } : {}),
          teamId,
          issueId: change.workItemId,
          // Webhook delivery and notifications check the endpoint's Project, which the endpoint
          // guard in the same transaction pins to this value.
          ...(endpoint.assignedProjectId ? { projectId: endpoint.assignedProjectId } : {}),
          // Marks that the Project scope above is complete: events written before it was recorded
          // lack `projectId` even for Project-assigned Work Items, so webhooks skip them.
          projectScopeRecorded: true,
          ...(change.relationType ? { relationType: change.relationType } : {}),
          ...(change.relatedWorkItemId ? { relatedWorkItemId: change.relatedWorkItemId } : {}),
          ...(change.previousParentWorkItemId
            ? { previousParentWorkItemId: change.previousParentWorkItemId }
            : {}),
          ...(change.parentWorkItemId ? { parentWorkItemId: change.parentWorkItemId } : {}),
          ...(change.previousHierarchyRank ? { previousHierarchyRank: change.previousHierarchyRank } : {}),
          ...(change.hierarchyRank ? { hierarchyRank: change.hierarchyRank } : {}),
          graphRevision,
          ...createRelationNotificationMetadata(change, audit),
        },
        sequence,
      })
      return put ? [put] : []
    })
  }

  /**
   * Commits relation row changes, endpoint guards, and the graph metadata in one transaction.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns every endpoint.
   * @param input - Graph CAS, endpoint, row, and configuration items to commit.
   */
  private async sendRelationTransaction(
    workspaceId: string,
    teamId: string,
    input: RelationTransactionInput,
  ) {
    const scopeKey = createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId)
    const workItemPartitionKey = `${workspaceId}#team#${teamId}`
    const configurationConditionStartIndex =
      input.endpoints.length + 1 + input.edgeMutations.length
    const graphMutation = createRelationGraphAdvance(
      this.tableName,
      scopeKey,
      input.expectedRevision,
      input.nextEdgeCount,
    )
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      ...input.endpoints.map((endpoint) => createRelationEndpointTransactionItem(
        this.workItemsTableName,
        workItemPartitionKey,
        endpoint,
      )),
      graphMutation,
      ...input.edgeMutations,
      ...input.configurationConditionChecks,
      ...input.auditPuts,
    ]
    if (transactItems.length > DYNAMODB_TRANSACTION_ITEM_LIMIT) {
      throw new WorkItemConfigurationError(
        413,
        'WorkItemRelationTransactionTooLarge',
        'The relation change exceeds the transaction limit.',
      )
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (input.configurationConditionChecks.some((_, index) =>
        isTransactionConditionalFailureAt(error, configurationConditionStartIndex + index)
      )) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemConfigurationRevisionConflict',
          'Work Item configuration changed during the relation mutation.',
        )
      }
      if (isPermanentTransactionRejection(error)) {
        throw createRelationStoragePermanentError()
      }
      if (isNamedError(error, 'TransactionCanceledException')) {
        throw await input.classifyCancellation()
      }
      throw toPersistenceError(error)
    }
  }

  /**
   * Classifies a canceled parent replacement after re-reading its fences.
   *
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team that owns every endpoint.
   * @param input - Normalized parent replacement input.
   * @returns The error to return to the caller.
   */
  private async classifyParentReplacementCancellation(
    workspaceId: string,
    teamId: string,
    input: ReplaceWorkItemParentInput,
  ) {
    try {
      const workItemPartitionKey = `${workspaceId}#team#${teamId}`
      const endpoints = [
        input.child,
        ...(input.currentParent ? [input.currentParent] : []),
        ...(input.nextParent ? [input.nextParent] : []),
      ]
      const [graphRevision, storedParents, ...items] = await Promise.all([
        this.getRelationGraphRevision(workspaceId, teamId),
        this.readWorkItemRelations(workspaceId, teamId, input.child.workItemId, ['parent']),
        ...endpoints.map((endpoint) => this.documentClient.send(new GetCommand({
          TableName: this.workItemsTableName,
          Key: { directoryTeamId: workItemPartitionKey, issueId: endpoint.workItemId },
          ConsistentRead: true,
        }))),
      ])
      if (items.some((item) => !item.Item)) {
        return new WorkItemConfigurationError(
          404,
          'WorkItemRelationEndpointNotFound',
          'A relation endpoint no longer exists.',
        )
      }
      const endpointsChanged = endpoints.some((endpoint, index) => {
        const item = items[index]?.Item
        return !item ||
          !relationEndpointMatchesSnapshot(item, endpoint.expectedRevision, endpoint.assignedProjectId)
      })
      const parentChanged = storedParents.length !== (input.currentParent ? 1 : 0) ||
        (storedParents[0]?.targetWorkItemId ?? null) !== (input.currentParent?.workItemId ?? null)
      if (
        endpointsChanged ||
        parentChanged ||
        graphRevision !== input.expectedGraphRevision
      ) {
        return new WorkItemConfigurationError(
          409,
          'WorkItemRelationGraphConflict',
          'Work Item relations or endpoints changed. Reload and try again.',
        )
      }
    } catch (error) {
      return toPersistenceError(error)
    }
    return new WorkItemConfigurationError(
      503,
      'WorkItemRelationUnavailable',
      'The relation transaction was canceled for an unclassified reason.',
    )
  }

  private async classifyRelationTransactionCancellation(
    workspaceId: string,
    teamId: string,
    input: MutateWorkItemRelationInput,
    relation: WorkItemRelation,
    reciprocalRelation: WorkItemRelation,
    operation: 'create' | 'delete',
  ) {
    try {
      const workItemPartitionKey = `${workspaceId}#team#${teamId}`
      const scopeKey = createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId)
      const [source, target, graphRevision, storedRelation, storedReciprocal] = await Promise.all([
        this.documentClient.send(new GetCommand({
          TableName: this.workItemsTableName,
          Key: { directoryTeamId: workItemPartitionKey, issueId: input.sourceWorkItemId },
          ConsistentRead: true,
        })),
        this.documentClient.send(new GetCommand({
          TableName: this.workItemsTableName,
          Key: { directoryTeamId: workItemPartitionKey, issueId: input.targetWorkItemId },
          ConsistentRead: true,
        })),
        this.getRelationGraphRevision(workspaceId, teamId),
        this.documentClient.send(new GetCommand({
          TableName: this.tableName,
          Key: { scopeKey, recordKey: createRelationRecordKey(relation) },
          ConsistentRead: true,
        })),
        this.documentClient.send(new GetCommand({
          TableName: this.tableName,
          Key: { scopeKey, recordKey: createRelationRecordKey(reciprocalRelation) },
          ConsistentRead: true,
        })),
      ])
      if (!source.Item || !target.Item) {
        return new WorkItemConfigurationError(
          404,
          'WorkItemRelationEndpointNotFound',
          'A relation endpoint no longer exists.',
        )
      }
      if (
        !relationEndpointMatchesSnapshot(
          source.Item,
          input.sourceExpectedRevision,
          input.sourceAssignedProjectId,
        ) ||
        !relationEndpointMatchesSnapshot(
          target.Item,
          input.targetExpectedRevision,
          input.targetAssignedProjectId,
        ) ||
        graphRevision !== input.expectedGraphRevision
      ) {
        return new WorkItemConfigurationError(
          409,
          'WorkItemRelationGraphConflict',
          'Work Item relations or endpoints changed. Reload and try again.',
        )
      }
      const relationExists = Boolean(storedRelation.Item)
      const reciprocalExists = Boolean(storedReciprocal.Item)
      if (relationExists !== reciprocalExists) {
        return new WorkItemConfigurationError(
          503,
          'WorkItemRelationInconsistent',
          'Only one side of the reciprocal relation exists.',
        )
      }
      if (operation === 'create' && relationExists) {
        return new WorkItemConfigurationError(
          409,
          'WorkItemRelationDuplicate',
          'The relation already exists.',
        )
      }
      if (operation === 'delete' && !relationExists) {
        return new WorkItemConfigurationError(
          404,
          'WorkItemRelationNotFound',
          'The relation no longer exists.',
        )
      }
    } catch (error) {
      return toPersistenceError(error)
    }

    return new WorkItemConfigurationError(
      503,
      'WorkItemRelationUnavailable',
      'The relation transaction was canceled for an unclassified reason.',
    )
  }
}

/** Local DynamoDB にCDK互換configuration tableを作成します。 */
export async function ensureLocalWorkItemConfigurationTable(
  tableName: string,
  client: DynamoDBClient,
) {
  try {
    const response = await client.send(new DescribeTableCommand({ TableName: tableName }))
    if (!isConfigurationTableDescription(response.Table)) {
      throw new Error(`Local DynamoDB table "${tableName}" has an incompatible schema.`)
    }
    return
  } catch (error) {
    if (!isNamedError(error, 'ResourceNotFoundException')) {
      throw error
    }
  }
  await client.send(new CreateTableCommand({
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: 'scopeKey', AttributeType: 'S' },
      { AttributeName: 'recordKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'scopeKey', KeyType: 'HASH' },
      { AttributeName: 'recordKey', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  }))
}

function createAllDefaultTransitions(statusIds: readonly string[]) {
  return statusIds.flatMap((fromStatusId) =>
    statusIds
      .filter((toStatusId) => toStatusId !== fromStatusId)
      .map((toStatusId) => ({ fromStatusId, toStatusId })),
  )
}

function createScopedDefaultConfiguration(
  scopeType: WorkItemConfigurationScopeType,
  scopeId: string,
): WorkItemConfiguration {
  return {
    ...structuredClone(DEFAULT_WORK_ITEM_CONFIGURATION),
    scopeType,
    scopeId,
  }
}

/**
 * Creates a bounded configuration summary suitable for an immutable audit event.
 *
 * The full configuration can contain user-authored option lists and formulas. Audit events keep
 * stable identifiers and per-resource policy hashes instead of copying that unbounded payload
 * into the audit table. Each Work Item Type is kept as its own fixed-size policy record so a
 * single type edit cannot turn the whole type collection into one oversized audit value.
 *
 * @param configuration - Validated Work Item configuration to summarize.
 * @returns A deterministic, bounded summary of the configuration structure.
 */
function createWorkItemConfigurationAuditSnapshot(configuration: WorkItemConfiguration) {
  return {
    revision: configuration.revision,
    // The calculation policy changes every displayed progress percentage, so its value is audited.
    progressMode: configuration.progressMode ?? DEFAULT_WORK_ITEM_PROGRESS_MODE,
    // Whether open children block completing a parent is a Team policy, so its value is audited.
    parentCompletionPolicy:
      configuration.parentCompletionPolicy ?? DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY,
    // Which conditions block completion is a Team policy, so its value is audited.
    completionGate: configuration.completionGate ?? {},
    workflowIds: getWorkItemConfigurationWorkflows(configuration)
      .map((workflow) => workflow.id)
      .sort(),
    workflowPolicies: getWorkItemConfigurationWorkflows(configuration)
      .map((workflow) => ({
        id: workflow.id,
        policyHash: createWorkItemConfigurationPolicyHash(workflow),
      }))
      .sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0),
    customFieldIds: configuration.customFields
      .map((field) => field.id)
      .sort(),
    customFieldPolicies: configuration.customFields
      .map((field) => ({
        id: field.id,
        policyHash: createWorkItemConfigurationPolicyHash(field),
      }))
      .sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0),
    workItemTypes: (configuration.workItemTypes ?? [])
      .map((type) => ({
        id: type.id,
        policyHash: createWorkItemConfigurationPolicyHash(type),
      }))
      .sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0),
    jobRoles: (configuration.jobRoles ?? [])
      .map((jobRole) => ({
        id: jobRole.id,
        policyHash: createWorkItemConfigurationPolicyHash(jobRole),
      }))
      .sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0),
  }
}

/** Creates a stable SHA-256 fingerprint for a mutable configuration policy. */
function createWorkItemConfigurationPolicyHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableSerializeConfigurationValue(value)).digest('hex')}`
}

/** Serializes configuration values with sorted object keys for deterministic hashing. */
function stableSerializeConfigurationValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerializeConfigurationValue(entry)).join(',')}]`
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerializeConfigurationValue(entry)}`)
    .join(',')}}`
}

function createConfigurationGuards(
  workspaceId: string,
  teamId: string,
  resolved: ResolvedWorkItemConfiguration,
) {
  const teamScopeKey = createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId)
  if (!resolved.inheritedFrom && resolved.configuration.scopeType === 'team') {
    return [{ scopeKey: teamScopeKey, revision: resolved.configuration.revision }]
  }
  const workspaceScopeKey = createWorkItemConfigurationScopeKey(workspaceId, 'workspace', workspaceId)
  return [
    { scopeKey: teamScopeKey, revision: 0 },
    {
      scopeKey: workspaceScopeKey,
      revision: resolved.inheritedFrom === 'workspace' ? resolved.configuration.revision : 0,
    },
  ]
}

function readWorkflowDefinitions(value: unknown): WorkItemConfiguration['workflow'][] {
  if (!Array.isArray(value) || value.length > 100) {
    throw invalidConfiguration('Workflows must be an array with at most 100 entries.')
  }
  const workflows = value.map((workflow) => validateWorkflowDefinition(workflow))
  assertUnique(workflows.map((workflow) => workflow.id), 'Workflow ID')
  return workflows
}

/**
 * Validates the job roles contributors can be planned against.
 *
 * @param value - Untrusted job role list.
 * @returns Job roles with trimmed names and unique stable IDs.
 */
function readJobRoleDefinitions(value: unknown): WorkItemJobRoleDefinition[] {
  if (!Array.isArray(value) || value.length > WORK_ITEM_JOB_ROLE_LIMIT) {
    throw invalidConfiguration(`Job roles must be an array with at most ${WORK_ITEM_JOB_ROLE_LIMIT} entries.`)
  }
  const jobRoles = value.map((candidate): WorkItemJobRoleDefinition => {
    if (!isRecord(candidate)) {
      throw invalidConfiguration('Job role must be an object.')
    }
    const archived = candidate.archived === undefined ? undefined : readBoolean(candidate.archived, 'Job role archived')
    return {
      id: readConfigurationId(candidate.id, 'Job role ID'),
      name: readDisplayName(candidate.name, 'Job role name'),
      ...(archived ? { archived } : {}),
    }
  })
  assertUnique(jobRoles.map((jobRole) => jobRole.id), 'Job role ID')
  return jobRoles
}

function readWorkItemTypeDefinitions(
  value: unknown,
  customFields: readonly CustomFieldDefinition[],
  workflows: readonly WorkItemConfiguration['workflow'][],
): WorkItemTypeDefinition[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw invalidConfiguration('Work Item Types must be an array with at most 100 entries.')
  }
  const types = value.map((candidate) => readWorkItemTypeDefinition(candidate))
  assertUnique(types.map((type) => type.id), 'Work Item Type ID')
  assertUnique(types.map((type) => type.sortOrder), 'Work Item Type sortOrder')
  const customFieldIds = new Set(customFields.map((definition) => definition.id))
  const customFieldsById = new Map(customFields.map((definition) => [definition.id, definition]))
  const workflowIds = new Set(workflows.map((workflow) => workflow.id))
  const typeIds = new Set([...types.map((type) => type.id), DEFAULT_WORK_ITEM_TYPE_ID])
  for (const type of types) {
    if (!workflowIds.has(type.defaultWorkflowId)) {
      throw invalidConfiguration(
        `Work Item Type "${type.id}" references unknown workflow "${type.defaultWorkflowId}".`,
      )
    }
    if (type.customFieldIds.some((fieldId) => !customFieldIds.has(fieldId))) {
      throw invalidConfiguration(`Work Item Type "${type.id}" references an unknown custom field.`)
    }
    if (type.requiredCustomFieldIds.some((fieldId) => !type.customFieldIds.includes(fieldId))) {
      throw invalidConfiguration(
        `Work Item Type "${type.id}" has a required custom field that is not available.`,
      )
    }
    if (type.requiredCustomFieldIds.some((fieldId) => customFieldsById.get(fieldId)?.type === 'formula')) {
      throw invalidConfiguration(`Work Item Type "${type.id}" cannot require a formula field.`)
    }
    const typeFieldIds = new Set(type.customFieldIds)
    for (const fieldId of type.customFieldIds) {
      const definition = customFieldsById.get(fieldId)
      if (definition?.type !== 'formula') continue
      const missingReference = readFormulaReferences(definition.formulaExpression ?? '')
        .find((reference) => !typeFieldIds.has(reference))
      if (missingReference) {
        throw invalidConfiguration(
          `Work Item Type "${type.id}" formula field "${fieldId}" references an unavailable field "${missingReference}".`,
        )
      }
    }
    if (type.allowedChildTypeIds.some((childTypeId) => !typeIds.has(childTypeId))) {
      throw invalidConfiguration(`Work Item Type "${type.id}" references an unknown child type.`)
    }
  }
  return types
}

function readWorkItemTypeDefinition(value: unknown): WorkItemTypeDefinition {
  if (!isRecord(value)) {
    throw invalidConfiguration('Work Item Type definition must be an object.')
  }
  const customFieldIds = readConfigurationIdList(value.customFieldIds, 'Work Item Type custom field IDs')
  const requiredCustomFieldIds = readConfigurationIdList(
    value.requiredCustomFieldIds,
    'Work Item Type required custom field IDs',
  )
  const detailSections = readDetailSections(value.detailSections)
  const allowedChildTypeIds = readConfigurationIdList(
    value.allowedChildTypeIds,
    'Work Item Type child type IDs',
  )
  if (value.status !== 'active' && value.status !== 'archived') {
    throw invalidConfiguration('Work Item Type status is invalid.')
  }
  return {
    id: readConfigurationId(value.id, 'Work Item Type ID'),
    name: readDisplayName(value.name, 'Work Item Type name'),
    iconToken: readConfigurationId(value.iconToken, 'Work Item Type icon token'),
    ...(value.description === undefined
      ? {}
      : { description: readBoundedText(value.description, 'Work Item Type description', 2_000) }),
    status: value.status,
    defaultWorkflowId: readConfigurationId(value.defaultWorkflowId, 'Work Item Type workflow ID'),
    customFieldIds,
    requiredCustomFieldIds,
    detailSections,
    allowedChildTypeIds,
    sortOrder: readNonNegativeInteger(value.sortOrder, 'Work Item Type sortOrder'),
  }
}

function readConfigurationIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw invalidConfiguration(`${label} must be an array with at most 100 entries.`)
  }
  const values = value.map((candidate) => readConfigurationId(candidate, label))
  assertUnique(values, label)
  return values
}

function readDetailSections(value: unknown): WorkItemDetailSectionId[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw invalidConfiguration('Work Item Type detail sections must be an array with at most 20 entries.')
  }
  const sections = value.map((candidate) => {
    if (!isWorkItemDetailSectionId(candidate)) {
      throw invalidConfiguration('Work Item Type detail section is invalid.')
    }
    return candidate
  })
  assertUnique(sections, 'Work Item Type detail section')
  return sections
}

function readBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw invalidConfiguration(`${label} is invalid.`)
  }
  return value.trim()
}

function isWorkItemDetailSectionId(value: unknown): value is WorkItemDetailSectionId {
  return value === 'overview' || value === 'description' || value === 'custom-fields' ||
    value === 'workflow' || value === 'schedule' || value === 'relations' ||
    value === 'files' || value === 'time' || value === 'activity'
}

function readCustomFieldDefinitions(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) {
    throw invalidConfiguration('Custom fields must be an array with at most 100 entries.')
  }
  const definitions = value.map((definition) => readCustomFieldDefinition(definition))
  assertUnique(definitions.map((definition) => definition.id), 'Custom field ID')
  assertUnique(definitions.map((definition) => definition.sortOrder), 'Custom field sortOrder')
  return definitions
}

function readCustomFieldDefinition(value: unknown): CustomFieldDefinition {
  if (!isRecord(value)) {
    throw invalidConfiguration('Custom field definition must be an object.')
  }
  const type = value.type
  if (!isCustomFieldType(type)) {
    throw invalidConfiguration('Custom field type is invalid.')
  }
  const definition: CustomFieldDefinition = {
    id: readConfigurationId(value.id, 'Custom field ID'),
    name: readDisplayName(value.name, 'Custom field name'),
    type,
    sortOrder: readNonNegativeInteger(value.sortOrder, 'Custom field sortOrder'),
    required: readBoolean(value.required, 'Custom field required'),
  }
  if (value.projectIds !== undefined) {
    if (!Array.isArray(value.projectIds) || value.projectIds.length > 100) {
      throw invalidConfiguration('Custom field projectIds are invalid.')
    }
    definition.projectIds = value.projectIds.map((projectId) => readIdentifier(projectId, 'Project ID'))
    assertUnique(definition.projectIds, 'Custom field Project ID')
  }
  if (value.validation !== undefined) {
    definition.validation = readCustomFieldValidation(value.validation)
  }
  if (type === 'select' || type === 'multi-select') {
    if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > 100) {
      throw invalidConfiguration('Select fields require between 1 and 100 options.')
    }
    definition.options = value.options.map((option) => readCustomFieldOption(option))
    assertUnique(definition.options.map((option) => option.id), 'Custom field option ID')
    assertUnique(definition.options.map((option) => option.sortOrder), 'Custom field option sortOrder')
  } else if (value.options !== undefined) {
    throw invalidConfiguration('Only select fields can define options.')
  }
  if (type === 'currency') {
    if (typeof value.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(value.currencyCode)) {
      throw invalidConfiguration('Currency fields require an uppercase ISO currency code.')
    }
    const supportedCurrencies = getSupportedCurrencyCodes()
    if (supportedCurrencies && !supportedCurrencies.has(value.currencyCode)) {
      throw invalidConfiguration('Currency fields require a supported ISO currency code.')
    }
    definition.currencyCode = value.currencyCode
  }
  if (type === 'duration') {
    if (value.durationUnit !== 'minutes' && value.durationUnit !== 'hours' && value.durationUnit !== 'days') {
      throw invalidConfiguration('Duration fields require minutes, hours, or days.')
    }
    definition.durationUnit = value.durationUnit
  }
  if (type === 'formula') {
    if (
      typeof value.formulaExpression !== 'string' ||
      !value.formulaExpression.trim() ||
      value.formulaExpression.length > MAX_FORMULA_EXPRESSION_LENGTH
    ) {
      throw invalidConfiguration('Formula fields require an expression.')
    }
    definition.formulaExpression = value.formulaExpression.trim()
  } else if (value.formulaExpression !== undefined) {
    throw invalidConfiguration('Only formula fields can define an expression.')
  }
  if (value.defaultValue !== undefined) {
    if (type === 'formula') {
      throw invalidConfiguration('Formula fields cannot define a default value.')
    }
    definition.defaultValue = readCustomFieldValue(definition, value.defaultValue)
    validateCustomFieldValue(definition, definition.defaultValue)
  }
  return definition
}

function readCustomFieldValidation(value: unknown) {
  if (!isRecord(value)) {
    throw invalidConfiguration('Custom field validation must be an object.')
  }
  const validation: NonNullable<CustomFieldDefinition['validation']> = {}
  for (const key of ['min', 'max'] as const) {
    if (value[key] !== undefined) {
      validation[key] = readFiniteNumber(value[key], `Validation ${key}`)
    }
  }
  for (const key of ['minLength', 'maxLength'] as const) {
    if (value[key] !== undefined) {
      validation[key] = readNonNegativeInteger(value[key], `Validation ${key}`)
    }
  }
  if (validation.min !== undefined && validation.max !== undefined && validation.min > validation.max) {
    throw invalidConfiguration('Validation min cannot exceed max.')
  }
  if (
    validation.minLength !== undefined &&
    validation.maxLength !== undefined &&
    validation.minLength > validation.maxLength
  ) {
    throw invalidConfiguration('Validation minLength cannot exceed maxLength.')
  }
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string' || value.pattern.length > 512) {
      throw invalidConfiguration('Validation pattern is invalid.')
    }
    try {
      new RegExp(value.pattern)
    } catch {
      throw invalidConfiguration('Validation pattern is not a valid regular expression.')
    }
    if (!isSafeValidationPattern(value.pattern)) {
      throw invalidConfiguration('Validation pattern contains unsafe repeated expressions.')
    }
    validation.pattern = value.pattern
  }
  return validation
}

function readCustomFieldOption(value: unknown) {
  if (!isRecord(value)) {
    throw invalidConfiguration('Custom field option must be an object.')
  }
  return {
    id: readConfigurationId(value.id, 'Custom field option ID'),
    name: readDisplayName(value.name, 'Custom field option name'),
    sortOrder: readNonNegativeInteger(value.sortOrder, 'Custom field option sortOrder'),
    ...(value.color === undefined ? {} : { color: readDisplayName(value.color, 'Custom field option color') }),
  }
}

function validateFormulaDefinitions(definitions: readonly CustomFieldDefinition[]) {
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  const dependencies = new Map<string, string[]>()
  for (const definition of definitions) {
    if (definition.type !== 'formula') {
      continue
    }
    const references = readFormulaReferences(definition.formulaExpression ?? '')
    for (const reference of references) {
      const referencedDefinition = definitionsById.get(reference)
      if (!referencedDefinition) {
        throw invalidConfiguration(`Formula field "${definition.id}" references unknown field "${reference}".`)
      }
      if (
        referencedDefinition.type !== 'number' &&
        referencedDefinition.type !== 'currency' &&
        referencedDefinition.type !== 'duration' &&
        referencedDefinition.type !== 'formula'
      ) {
        throw invalidConfiguration(
          `Formula field "${definition.id}" references non-numeric field "${reference}".`,
        )
      }
      if (!formulaScopeIsCoveredByReference(definition, referencedDefinition)) {
        throw invalidConfiguration(
          `Formula field "${definition.id}" can apply where reference "${reference}" is unavailable.`,
        )
      }
    }
    validateFormulaExpression(definition.formulaExpression ?? '')
    dependencies.set(definition.id, references.filter((reference) =>
      definitionsById.get(reference)?.type === 'formula',
    ))
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (fieldId: string) => {
    if (visiting.has(fieldId)) {
      throw invalidConfiguration(`Formula dependency cycle includes "${fieldId}".`)
    }
    if (visited.has(fieldId)) {
      return
    }
    visiting.add(fieldId)
    for (const dependency of dependencies.get(fieldId) ?? []) {
      visit(dependency)
    }
    visiting.delete(fieldId)
    visited.add(fieldId)
  }
  for (const fieldId of dependencies.keys()) {
    visit(fieldId)
  }
}

function formulaScopeIsCoveredByReference(
  formula: CustomFieldDefinition,
  reference: CustomFieldDefinition,
) {
  if (!reference.projectIds || reference.projectIds.length === 0) {
    return true
  }
  if (!formula.projectIds || formula.projectIds.length === 0) {
    return false
  }
  const referenceProjectIds = new Set(reference.projectIds)
  return formula.projectIds.every((projectId) => referenceProjectIds.has(projectId))
}

function readCustomFieldValue(
  definition: CustomFieldDefinition,
  value: unknown,
): CustomFieldValue {
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw invalidFieldValue(`Custom field "${definition.id}" must be boolean.`)
    }
    return value
  }
  if (definition.type === 'number' || definition.type === 'currency' || definition.type === 'duration') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidFieldValue(`Custom field "${definition.id}" must be a finite number.`)
    }
    return value
  }
  if (definition.type === 'multi-select') {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      !value.every((entry) => typeof entry === 'string')
    ) {
      throw invalidFieldValue(`Custom field "${definition.id}" must be a string array.`)
    }
    if (new Set(value).size !== value.length) {
      throw invalidFieldValue(`Custom field "${definition.id}" cannot contain duplicate options.`)
    }
    const optionOrder = new Map(
      definition.options?.map((option, index) => [option.id, index]) ?? [],
    )
    return [...value].sort(
      (first, second) =>
        (optionOrder.get(first) ?? Number.MAX_SAFE_INTEGER) -
          (optionOrder.get(second) ?? Number.MAX_SAFE_INTEGER) ||
        first.localeCompare(second),
    )
  }
  if (typeof value !== 'string') {
    throw invalidFieldValue(`Custom field "${definition.id}" must be a string.`)
  }
  if (value.length > MAX_CUSTOM_FIELD_TEXT_LENGTH) {
    throw invalidFieldValue(`Custom field "${definition.id}" exceeds the maximum value length.`)
  }
  return value.trim()
}

/**
 * Validates a normalized custom field value against its definition and Work Item Type scope.
 *
 * @param definition - Custom field definition that owns the value.
 * @param value - Normalized custom field value to validate.
 * @param required - Whether the value is required for the current Work Item Type.
 */
function validateCustomFieldValue(
  definition: CustomFieldDefinition,
  value: CustomFieldValue,
  required = definition.required,
) {
  if (
    required &&
    ((typeof value === 'string' && value.length === 0) ||
      (Array.isArray(value) && value.length === 0))
  ) {
    throw invalidFieldValue(`Custom field "${definition.id}" is required.`)
  }
  if (
    definition.type === 'text' &&
    typeof value === 'string' &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127
    })
  ) {
    throw invalidFieldValue(`Custom field "${definition.id}" cannot contain control characters.`)
  }
  if (definition.type === 'duration' && typeof value === 'number' && value < 0) {
    throw invalidFieldValue(`Custom field "${definition.id}" cannot be negative.`)
  }
  if (
    definition.type === 'currency' &&
    typeof value === 'number' &&
    !hasSupportedCurrencyPrecision(value, definition.currencyCode ?? '')
  ) {
    throw invalidFieldValue(`Custom field "${definition.id}" exceeds its currency precision.`)
  }
  if (definition.type === 'date' && (typeof value !== 'string' || !isValidIsoDate(value))) {
    throw invalidFieldValue(`Custom field "${definition.id}" must be an ISO date.`)
  }
  if (definition.type === 'select' && typeof value === 'string') {
    assertConfiguredOptions(definition, [value])
  }
  if (definition.type === 'multi-select' && Array.isArray(value)) {
    assertConfiguredOptions(definition, value)
  }
  const validation = definition.validation
  if (!validation) {
    return
  }
  if (typeof value === 'number') {
    if (validation.min !== undefined && value < validation.min) {
      throw invalidFieldValue(`Custom field "${definition.id}" is below its minimum.`)
    }
    if (validation.max !== undefined && value > validation.max) {
      throw invalidFieldValue(`Custom field "${definition.id}" exceeds its maximum.`)
    }
  }
  const length = typeof value === 'string' || Array.isArray(value) ? value.length : undefined
  if (length !== undefined) {
    if (validation.minLength !== undefined && length < validation.minLength) {
      throw invalidFieldValue(`Custom field "${definition.id}" is shorter than its minimum length.`)
    }
    if (validation.maxLength !== undefined && length > validation.maxLength) {
      throw invalidFieldValue(`Custom field "${definition.id}" exceeds its maximum length.`)
    }
  }
  if (
    validation.pattern &&
    definition.type === 'text' &&
    typeof value === 'string' &&
    !new RegExp(validation.pattern).test(value)
  ) {
    throw invalidFieldValue(`Custom field "${definition.id}" does not match its pattern.`)
  }
}

function evaluateFormula(expression: string, values: Readonly<Record<string, CustomFieldValue>>) {
  const tokens = tokenizeFormula(expression, values)
  let position = 0
  const peek = () => tokens[position]
  const consume = () => tokens[position++]
  const parsePrimary = (): number => {
    const token = consume()
    if (token === '(') {
      const value = parseExpression()
      if (consume() !== ')') {
        throw invalidFieldValue('Formula parenthesis is not closed.')
      }
      return value
    }
    if (token === '+' || token === '-') {
      const value = parsePrimary()
      return token === '-' ? -value : value
    }
    if (typeof token === 'number') {
      return token
    }
    throw invalidFieldValue('Formula expression is invalid.')
  }
  const parseTerm = (): number => {
    let value = parsePrimary()
    while (peek() === '*' || peek() === '/') {
      const operator = consume()
      const right = parsePrimary()
      if (operator === '/' && right === 0) {
        throw invalidFieldValue('Formula cannot divide by zero.')
      }
      value = operator === '*' ? value * right : value / right
    }
    return value
  }
  const parseExpression = (): number => {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const operator = consume()
      const right = parseTerm()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }
  const result = parseExpression()
  if (position !== tokens.length || !Number.isFinite(result)) {
    throw invalidFieldValue('Formula result is invalid.')
  }
  return result
}

function validateFormulaExpression(expression: string) {
  const tokens = tokenizeFormula(expression)
  let position = 0
  const peek = () => tokens[position]
  const consume = () => tokens[position++]
  const finiteConstant = (value: number) => {
    if (!Number.isFinite(value)) {
      throw invalidConfiguration('Formula result is invalid.')
    }
    return value
  }
  const parsePrimary = (): number | undefined => {
    const token = consume()
    if (token === '(') {
      const value = parseExpression()
      if (consume() !== ')') {
        throw invalidConfiguration('Formula parenthesis is not closed.')
      }
      return value
    }
    if (token === '+' || token === '-') {
      const value = parsePrimary()
      if (value === undefined) {
        return undefined
      }
      return token === '-' ? -value : value
    }
    if (typeof token === 'number') {
      return finiteConstant(token)
    }
    if (typeof token === 'string' && token.startsWith('{')) {
      return undefined
    }
    throw invalidConfiguration('Formula expression is invalid.')
  }
  const parseTerm = (): number | undefined => {
    let value = parsePrimary()
    while (peek() === '*' || peek() === '/') {
      const operator = consume()
      const right = parsePrimary()
      if (operator === '/' && right === 0) {
        throw invalidConfiguration('Formula cannot divide by zero.')
      }
      if (operator === '*' && (value === 0 || right === 0)) {
        value = 0
      } else if (value === undefined || right === undefined) {
        value = undefined
      } else {
        value = finiteConstant(operator === '*' ? value * right : value / right)
      }
    }
    return value
  }
  const parseExpression = (): number | undefined => {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const operator = consume()
      const right = parseTerm()
      if (value === undefined || right === undefined) {
        value = undefined
      } else {
        value = finiteConstant(operator === '+' ? value + right : value - right)
      }
    }
    return value
  }
  parseExpression()
  if (position !== tokens.length) {
    throw invalidConfiguration('Formula expression is invalid.')
  }
}

function tokenizeFormula(
  expression: string,
  values?: Readonly<Record<string, CustomFieldValue>>,
) {
  const tokens: Array<number | string> = []
  let offset = 0
  const tokenPattern = /\s*(\{([^}]+)\}|(?:\d+(?:\.\d+)?|\.\d+)|[()+\-*/])/gy
  while (offset < expression.length) {
    tokenPattern.lastIndex = offset
    const match = tokenPattern.exec(expression)
    if (!match || match.index !== offset) {
      throw invalidConfiguration('Formula contains unsupported syntax.')
    }
    offset = tokenPattern.lastIndex
    const token = match[1]
    const reference = match[2]
    if (reference !== undefined) {
      if (!values) {
        tokens.push(token)
        continue
      }
      const value = values[reference]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidFieldValue(`Formula reference "${reference}" must contain a number.`)
      }
      tokens.push(value)
    } else if (/^(?:\d|\.)/.test(token)) {
      tokens.push(Number(token))
    } else {
      tokens.push(token)
    }
  }
  if (tokens.length === 0) {
    throw invalidConfiguration('Formula expression is empty.')
  }
  return tokens
}

function readFormulaReferences(expression: string) {
  return [...expression.matchAll(/\{([^}]+)\}/g)].map((match) =>
    readConfigurationId(match[1], 'Formula reference'),
  )
}

function normalizeRelationInput(
  input: MutateWorkItemRelationInput,
  allowReciprocalType = false,
): MutateWorkItemRelationInput {
  const type = input.type
  if (
    type !== 'parent' &&
    type !== 'blocks' &&
    type !== 'related' &&
    type !== 'duplicate' &&
    !(allowReciprocalType && (type === 'child' || type === 'blockedBy'))
  ) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemRelation',
      'Only parent, blocks, related, and duplicate relations can be created directly.',
    )
  }
  return {
    sourceWorkItemId: readIdentifier(input.sourceWorkItemId, 'Source Work Item ID'),
    targetWorkItemId: readIdentifier(input.targetWorkItemId, 'Target Work Item ID'),
    type,
    expectedGraphRevision: readNonNegativeInteger(input.expectedGraphRevision, 'Relation graph revision'),
    sourceExpectedRevision: readPositiveInteger(
      input.sourceExpectedRevision,
      'Source Work Item revision',
    ),
    targetExpectedRevision: readPositiveInteger(
      input.targetExpectedRevision,
      'Target Work Item revision',
    ),
    ...(input.sourceAssignedProjectId === undefined
      ? {}
      : { sourceAssignedProjectId: readIdentifier(input.sourceAssignedProjectId, 'Source Project ID') }),
    ...(input.targetAssignedProjectId === undefined
      ? {}
      : { targetAssignedProjectId: readIdentifier(input.targetAssignedProjectId, 'Target Project ID') }),
  }
}

/**
 * Creates the Work Item row item that fences a relation endpoint and optionally stores its projection.
 *
 * @param workItemsTableName - Canonical Work Items table name.
 * @param workItemPartitionKey - Team partition key of the endpoint.
 * @param endpoint - Endpoint snapshot and optional next projection.
 * @returns An Update when the projection changes, otherwise a ConditionCheck.
 */
function createRelationEndpointTransactionItem(
  workItemsTableName: string,
  workItemPartitionKey: string,
  endpoint: RelationTransactionEndpoint,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const guard = {
    TableName: workItemsTableName,
    Key: { directoryTeamId: workItemPartitionKey, issueId: endpoint.workItemId },
    ConditionExpression:
      'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #revision = :revision AND ' +
      (endpoint.assignedProjectId === undefined
        ? 'attribute_not_exists(#assignedProjectId)'
        : '#assignedProjectId = :assignedProjectId'),
    ExpressionAttributeNames: {
      '#assignedProjectId': 'assignedProjectId',
      '#revision': 'revision',
    },
    ExpressionAttributeValues: {
      ':revision': endpoint.expectedRevision,
      ...(endpoint.assignedProjectId === undefined
        ? {}
        : { ':assignedProjectId': endpoint.assignedProjectId }),
    },
  }
  if (endpoint.relationIds === undefined && endpoint.hierarchyRank === undefined) {
    return { ConditionCheck: guard }
  }
  const setExpressions: string[] = []
  const names: Record<string, string> = { ...guard.ExpressionAttributeNames }
  const values: Record<string, unknown> = { ...guard.ExpressionAttributeValues }
  if (endpoint.relationIds !== undefined) {
    setExpressions.push('#relationIds = :relationIds')
    names['#relationIds'] = 'relationIds'
    values[':relationIds'] = [...endpoint.relationIds]
  }
  if (typeof endpoint.hierarchyRank === 'string') {
    setExpressions.push('#hierarchyRank = :hierarchyRank')
    names['#hierarchyRank'] = 'hierarchyRank'
    values[':hierarchyRank'] = endpoint.hierarchyRank
  } else if (endpoint.hierarchyRank === null) {
    names['#hierarchyRank'] = 'hierarchyRank'
  }
  return {
    Update: {
      ...guard,
      UpdateExpression: [
        setExpressions.length > 0 ? `SET ${setExpressions.join(', ')}` : undefined,
        endpoint.hierarchyRank === null ? 'REMOVE #hierarchyRank' : undefined,
      ].filter((part) => part !== undefined).join(' '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  }
}

/**
 * Relation graph から Work Item row/search 用の決定的な relation ID 一覧を作成します。
 *
 * `child` relation は親の projection に含めません。子は子側の `parent:<id>` で引けるため、
 * 親が持てる子の数を projection の上限で縛らないためです。
 *
 * @param relations - Relations that may include rows of other sources.
 * @param sourceWorkItemId - Work Item whose projection is created.
 * @returns Sorted unique `type:targetWorkItemId` entries.
 */
export function createWorkItemRelationIds(
  relations: readonly WorkItemRelation[],
  sourceWorkItemId: string,
) {
  const relationIds = relations
    .filter((relation) =>
      relation.sourceWorkItemId === sourceWorkItemId && isProjectedRelationType(relation.type)
    )
    .map((relation) => `${relation.type}:${relation.targetWorkItemId}`)
  if (new Set(relationIds).size !== relationIds.length) {
    throw storedRelationInvalid()
  }
  if (relationIds.length > WORK_ITEM_RELATION_ID_LIMIT) {
    throw new WorkItemConfigurationError(
      413,
      'WorkItemRelationEndpointLimitExceeded',
      `A Work Item cannot exceed ${WORK_ITEM_RELATION_ID_LIMIT} relations.`,
    )
  }
  return relationIds.sort()
}

function relationEndpointMatchesSnapshot(
  item: Record<string, unknown>,
  expectedRevision: number,
  expectedAssignedProjectId?: string,
) {
  return item.revision === expectedRevision &&
    (expectedAssignedProjectId === undefined
      ? item.assignedProjectId === undefined
      : item.assignedProjectId === expectedAssignedProjectId)
}

function reciprocalRelationType(type: WorkItemRelationType): WorkItemRelationType {
  const reciprocal: Record<WorkItemRelationType, WorkItemRelationType> = {
    parent: 'child',
    child: 'parent',
    blocks: 'blockedBy',
    blockedBy: 'blocks',
    related: 'related',
    duplicate: 'duplicate',
  }
  return reciprocal[type]
}

/**
 * Checks whether a relation type is stored in the source Work Item's `relationIds`.
 *
 * @param type - Relation type.
 * @returns False only for `child`.
 */
function isProjectedRelationType(type: WorkItemRelationType) {
  return type !== 'child'
}

/**
 * Rejects a mutation that would store more directed rows than the Team limit.
 *
 * @param nextEdgeCount - Directed rows after the mutation.
 */
function assertTeamRelationEdgeCapacity(nextEdgeCount: number) {
  if (nextEdgeCount > TEAM_RELATION_EDGE_LIMIT) {
    throw teamRelationLimitExceeded()
  }
}

/**
 * Creates the error returned when a Team relation graph would exceed its link limit.
 *
 * @returns A 413 configuration error.
 */
function teamRelationLimitExceeded() {
  return new WorkItemConfigurationError(
    413,
    'WorkItemRelationGraphLimitExceeded',
    `A Team cannot store more than ${WORK_ITEM_TEAM_RELATION_LINK_LIMIT} relation links.`,
  )
}

/**
 * Fails when the graph revision moved while a multi-page read was in progress.
 *
 * @param before - Revision read before the pages.
 * @param after - Revision read after the pages.
 */
function assertStableGraphRevision(before: number, after: number) {
  if (before !== after) {
    throw new WorkItemConfigurationError(
      409,
      'WorkItemRelationGraphConflict',
      'Work Item relations changed. Reload and try again.',
    )
  }
}

/**
 * Validates the stored relation graph metadata row and reads its revision.
 *
 * @param item - Stored graph metadata row.
 * @returns The positive graph revision.
 */
function readRelationGraphRevisionItem(item: Record<string, unknown>) {
  if (
    item.entryType !== 'relation-graph' ||
    item.schemaVersion !== WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  ) {
    throw new WorkItemConfigurationError(
      503,
      'InvalidWorkItemRelationGraph',
      'Stored relation graph metadata is invalid.',
    )
  }
  return readPositiveInteger(item.revision, 'Relation graph revision')
}

/**
 * Reads the stored directed edge count of a relation graph metadata row.
 *
 * @param value - Stored `edgeCount` attribute.
 * @returns The non-negative edge count.
 */
function readStoredEdgeCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkItemConfigurationError(
      503,
      'InvalidWorkItemRelationGraph',
      'Stored relation graph metadata is invalid.',
    )
  }
  return value
}

/**
 * Creates the record key prefix shared by every relation whose source is one Work Item.
 *
 * @param workItemId - Source Work Item ID.
 * @returns The `REL#<source>#` prefix.
 */
function createRelationSourcePrefix(workItemId: string) {
  return `${RELATION_RECORD_PREFIX}${encodeURIComponent(workItemId)}#`
}

/**
 * Validates a parent replacement input from an authorized caller.
 *
 * @param input - Parent replacement input.
 * @returns The input with validated identifiers and revisions.
 */
function normalizeReplaceParentInput(input: ReplaceWorkItemParentInput): ReplaceWorkItemParentInput {
  const readEndpoint = (endpoint: WorkItemRelationEndpointSnapshot, label: string) => ({
    workItemId: readIdentifier(endpoint.workItemId, `${label} Work Item ID`),
    expectedRevision: readPositiveInteger(endpoint.expectedRevision, `${label} Work Item revision`),
    ...(endpoint.assignedProjectId === undefined
      ? {}
      : { assignedProjectId: readIdentifier(endpoint.assignedProjectId, `${label} Project ID`) }),
  })
  return {
    child: readEndpoint(input.child, 'Child'),
    ...(input.currentParent ? { currentParent: readEndpoint(input.currentParent, 'Current parent') } : {}),
    ...(input.nextParent ? { nextParent: readEndpoint(input.nextParent, 'Parent') } : {}),
    expectedGraphRevision: readNonNegativeInteger(input.expectedGraphRevision, 'Relation graph revision'),
    ...(input.hierarchyRank === undefined
      ? {}
      : { hierarchyRank: readWorkItemHierarchyRank(input.hierarchyRank) }),
  }
}

/**
 * Validates a requested sibling order rank.
 *
 * @param value - Untrusted rank.
 * @returns The rank.
 */
function readWorkItemHierarchyRank(value: unknown): string {
  if (!isWorkItemHierarchyRank(value)) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemHierarchyRank',
      'The hierarchy rank must be 1 to 64 lowercase base-36 digits that do not end in 0.',
    )
  }
  return value
}

function assertExpectedGraphRevision(current: number, expected: number) {
  if (current !== expected) {
    throw new WorkItemConfigurationError(
      409,
      'WorkItemRelationGraphConflict',
      'Work Item relations changed. Reload and try again.',
    )
  }
}

function createRelationPut(
  tableName: string,
  workspaceId: string,
  teamId: string,
  relation: WorkItemRelation,
) {
  return {
    Put: {
      TableName: tableName,
      Item: createRelationItem(workspaceId, teamId, relation),
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  }
}

function createRelationDelete(
  tableName: string,
  workspaceId: string,
  teamId: string,
  relation: WorkItemRelation,
) {
  return {
    Delete: {
      TableName: tableName,
      Key: {
        scopeKey: createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
        recordKey: createRelationRecordKey(relation),
      },
      ConditionExpression: 'attribute_exists(scopeKey) AND attribute_exists(recordKey)',
    },
  }
}

function createRelationItem(workspaceId: string, teamId: string, relation: WorkItemRelation) {
  return {
    scopeKey: createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId),
    recordKey: createRelationRecordKey(relation),
    entryType: 'relation',
    ...relation,
  }
}

function createRelationRecordKey(relation: WorkItemRelation) {
  return `${RELATION_RECORD_PREFIX}${encodeURIComponent(relation.sourceWorkItemId)}#` +
    `${encodeURIComponent(relation.type)}#${encodeURIComponent(relation.targetWorkItemId)}`
}

function readRelationItem(value: unknown): WorkItemRelation {
  if (!isRecord(value) || value.entryType !== 'relation' || !isRelationType(value.type)) {
    throw storedRelationInvalid()
  }
  try {
    return {
      sourceWorkItemId: readIdentifier(value.sourceWorkItemId, 'Source Work Item ID'),
      targetWorkItemId: readIdentifier(value.targetWorkItemId, 'Target Work Item ID'),
      type: value.type,
      createdAt: readIsoTimestamp(value.createdAt, 'Relation createdAt'),
    }
  } catch (error) {
    if (error instanceof WorkItemConfigurationError) {
      throw storedRelationInvalid()
    }
    throw error
  }
}

function validateStoredConfiguration(
  item: unknown,
  scopeType: WorkItemConfigurationScopeType,
  scopeId: string,
) {
  try {
    const configuration = validateWorkItemConfiguration(item, { scopeType, scopeId })
    if (configuration.revision < 1) {
      throw storedConfigurationInvalid()
    }
    return configuration
  } catch (error) {
    if (error instanceof WorkItemConfigurationError) {
      throw storedConfigurationInvalid()
    }
    throw error
  }
}

function isConfigurationTableDescription(table: TableDescription | undefined) {
  const keys = table?.KeySchema ?? []
  return keys.some((key) => key.AttributeName === 'scopeKey' && key.KeyType === 'HASH') &&
    keys.some((key) => key.AttributeName === 'recordKey' && key.KeyType === 'RANGE')
}

function createDocumentClient(dynamoDbClient: DynamoDBClient) {
  return createDynamoDbDocumentClient(dynamoDbClient)
}

function cloneCustomFieldValue(value: CustomFieldValue): CustomFieldValue {
  return Array.isArray(value) ? [...value] : value
}

function isFieldApplicable(definition: CustomFieldDefinition, projectId?: string) {
  return !definition.projectIds || definition.projectIds.length === 0 ||
    Boolean(projectId && definition.projectIds.includes(projectId))
}

function assertConfiguredOptions(definition: CustomFieldDefinition, optionIds: readonly string[]) {
  const configured = new Set(definition.options?.map((option) => option.id) ?? [])
  if (optionIds.some((optionId) => !configured.has(optionId))) {
    throw invalidFieldValue(`Custom field "${definition.id}" contains an invalid option.`)
  }
}

function isValidIsoDate(value: string) {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function getSupportedCurrencyCodes() {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: 'currency') => string[] }
  ).supportedValuesOf

  return supportedValuesOf ? new Set(supportedValuesOf('currency')) : undefined
}

/**
 * Checks whether a currency value uses the precision supported by its currency.
 *
 * @param value - Finite numeric amount to validate.
 * @param currencyCode - ISO 4217 currency code configured for the field.
 * @returns Whether the value can be represented without unsupported fractional digits.
 */
export function hasSupportedCurrencyPrecision(
  value: number,
  currencyCode: string,
): boolean {
  try {
    const fractionDigits = new Intl.NumberFormat('en', {
      currency: currencyCode,
      style: 'currency',
    }).resolvedOptions().maximumFractionDigits ?? 2
    const scaled = value * 10 ** fractionDigits
    return Math.abs(scaled - Math.round(scaled)) < 1e-8
  } catch {
    return false
  }
}

function isSafeValidationPattern(pattern: string) {
  if (/\\[1-9]|\\k</.test(pattern) || /[()|]/.test(pattern)) {
    return false
  }

  let escaped = false
  let insideCharacterClass = false
  let variableQuantifierCount = 0
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      insideCharacterClass = true
      continue
    }
    if (character === ']' && insideCharacterClass) {
      insideCharacterClass = false
      continue
    }
    if (insideCharacterClass) {
      continue
    }
    if (character === '*' || character === '+' || character === '?') {
      variableQuantifierCount += 1
    } else if (character === '{') {
      const quantifier = pattern.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/)
      if (quantifier) {
        const minimum = Number(quantifier[1])
        const maximum = quantifier[2] === undefined || quantifier[2] === ''
          ? minimum
          : Number(quantifier[2])
        if (
          !Number.isSafeInteger(minimum) ||
          !Number.isSafeInteger(maximum) ||
          maximum > MAX_CUSTOM_FIELD_TEXT_LENGTH
        ) {
          return false
        }
        if (quantifier[2] !== undefined) {
          variableQuantifierCount += 1
        }
        index += quantifier[0].length - 1
      }
    }
    if (variableQuantifierCount > 1) {
      return false
    }
  }
  return variableQuantifierCount === 0 || pattern.startsWith('^')
}

function assertUnique(values: readonly (number | string)[], label: string) {
  if (new Set(values).size !== values.length) {
    throw invalidConfiguration(`${label} must be unique.`)
  }
}

function readIdentifier(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw invalidConfiguration(`${label} is invalid.`)
  }
  return value.trim()
}

function readConfigurationId(value: unknown, label: string) {
  const id = readIdentifier(value, label)
  if (!CONFIGURATION_ID_PATTERN.test(id)) {
    throw invalidConfiguration(`${label} must use letters, numbers, dots, underscores, or hyphens.`)
  }
  return id
}

function readDisplayName(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) {
    throw invalidConfiguration(`${label} is invalid.`)
  }
  return value.trim()
}

function readNonNegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidConfiguration(`${label} must be a non-negative integer.`)
  }
  return value as number
}

function readPositiveInteger(value: unknown, label: string) {
  const result = readNonNegativeInteger(value, label)
  if (result === 0) {
    throw invalidConfiguration(`${label} must be positive.`)
  }
  return result
}

function readFiniteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidConfiguration(`${label} must be a finite number.`)
  }
  return value
}

function readBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    throw invalidConfiguration(`${label} must be boolean.`)
  }
  return value
}

function readIsoTimestamp(value: unknown, label: string) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw invalidConfiguration(`${label} is invalid.`)
  }
  return value
}

function isCustomFieldType(value: unknown): value is CustomFieldDefinition['type'] {
  return value === 'text' || value === 'number' || value === 'boolean' || value === 'date' ||
    value === 'select' || value === 'multi-select' || value === 'person' ||
    value === 'currency' || value === 'duration' || value === 'formula'
}

function isRelationType(value: unknown): value is WorkItemRelationType {
  return value === 'parent' || value === 'child' || value === 'blocks' ||
    value === 'blockedBy' || value === 'related' || value === 'duplicate'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNamedError(error: unknown, nameOrCode: string) {
  return isRecord(error) && (error.name === nameOrCode || error.code === nameOrCode)
}

function isConfigurationConditionalTransactionCancellation(error: unknown) {
  if (!isNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons) || reasons.length < 2) {
    return false
  }
  const reasonCodes = reasons.slice(0, 2).map((reason) => isRecord(reason) ? reason.Code : undefined)
  return reasonCodes.includes('ConditionalCheckFailed') &&
    reasonCodes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')
}

/**
 * Returns whether a DynamoDB transaction cancellation lists a reason code for any item.
 *
 * @param error - Unknown error thrown by a TransactWrite.
 * @param code - Cancellation reason code, such as `TransactionConflict`.
 * @returns Whether any item of the canceled transaction carries the code.
 */
function isTransactionCancellationReason(error: unknown, code: string) {
  if (!isNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }
  const reasons = error.CancellationReasons
  return Array.isArray(reasons) && reasons.some((reason) => isRecord(reason) && reason.Code === code)
}

/**
 * Returns whether DynamoDB rejected an item of a canceled transaction, such as a row grown past
 * the item size limit. Such a rejection fails the same way on every retry.
 *
 * @param error - Unknown error thrown by a TransactWrite.
 * @returns Whether any item carries `ValidationError` or `ItemCollectionSizeLimitExceeded`.
 */
function isPermanentTransactionRejection(error: unknown) {
  return isTransactionCancellationReason(error, 'ValidationError') ||
    isTransactionCancellationReason(error, 'ItemCollectionSizeLimitExceeded')
}

/**
 * Creates the non-retryable error for a relation or rank write that storage rejected.
 *
 * @returns `502 WorkItemRelationStoragePermanent`, which is neither a conflict nor transient.
 */
function createRelationStoragePermanentError() {
  return new WorkItemConfigurationError(
    502,
    'WorkItemRelationStoragePermanent',
    'The change was rejected by storage. Contact an administrator.',
  )
}

/** Returns whether a DynamoDB transaction cancellation identifies a conditional failure at an index. */
function isTransactionConditionalFailureAt(error: unknown, index: number) {
  if (!isNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }
  const reasons = error.CancellationReasons
  return Array.isArray(reasons) &&
    isRecord(reasons[index]) &&
    reasons[index].Code === 'ConditionalCheckFailed'
}

function invalidConfiguration(message: string) {
  return new WorkItemConfigurationError(400, 'InvalidWorkItemConfiguration', message)
}

function invalidFieldValue(message: string) {
  return new WorkItemConfigurationError(400, 'InvalidCustomFieldValue', message)
}

function storedConfigurationInvalid() {
  return new WorkItemConfigurationError(
    503,
    'StoredWorkItemConfigurationInvalid',
    'Stored Work Item configuration is invalid.',
  )
}

function storedRelationInvalid() {
  return new WorkItemConfigurationError(
    503,
    'StoredWorkItemRelationInvalid',
    'Stored Work Item relation is invalid.',
  )
}

function toPersistenceError(error: unknown) {
  if (error instanceof WorkItemConfigurationError) {
    return error
  }
  const code = isRecord(error) && typeof error.name === 'string'
    ? error.name
    : 'WorkItemConfigurationUnavailable'
  return new WorkItemConfigurationError(
    503,
    code,
    'Work Item configuration storage is unavailable.',
  )
}
