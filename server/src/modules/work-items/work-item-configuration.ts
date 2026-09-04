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
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
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
  type WorkItemRelation,
  type WorkItemRelationMutationResponse,
  type WorkItemRelationsResponse,
  type WorkItemRelationType,
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

/** Re-exports the canonical relation identifier validator for consumers. */
export { isCanonicalWorkItemRelationIds } from './canonical-work-item'

const CONFIGURATION_RECORD_KEY = 'CONFIG'
const CONFIGURATION_WRITE_LOCK_RECORD_KEY = 'CONFIG_WRITE_LOCK'
const CONFIGURATION_WRITE_LOCK_LEASE_SECONDS = 15 * 60
const RELATION_GRAPH_RECORD_KEY = 'RELATION_GRAPH'
const RELATION_RECORD_PREFIX = 'REL#'
const RELATION_SCAN_LIMIT = 2_000
const WORK_ITEM_RELATION_ID_LIMIT = 100
const DYNAMODB_TRANSACTION_ITEM_LIMIT = 100
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

/** Work Item transaction が definition の同時変更を検出する guard です。 */
export type WorkItemConfigurationGuard = {
  /** Configuration table の partition key です。 */
  scopeKey: string
  /** 0 は CONFIG row が存在しないことを表します。 */
  revision: number
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
  /** Work Item から見た relation と graph revision を返します。 */
  listRelations(
    workspaceId: string,
    teamId: string,
    workItemId: string,
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
  /** Reciprocal relation を単一 transaction で作成します。 */
  createRelation(
    workspaceId: string,
    teamId: string,
    input: MutateWorkItemRelationInput,
    configurationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>,
  ): Promise<WorkItemRelationMutationResponse>
  /** Reciprocal relation を単一 transaction で削除します。 */
  deleteRelation(
    workspaceId: string,
    teamId: string,
    input: MutateWorkItemRelationInput,
  ): Promise<WorkItemRelationMutationResponse>
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
  const workItemTypes = value.workItemTypes === undefined
    ? undefined
    : readWorkItemTypeDefinitions(value.workItemTypes, customFields, [
        workflow,
        ...(workflows ?? []),
      ])

  return {
    scopeType,
    scopeId,
    schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    revision,
    workflow,
    ...(workflows === undefined ? {} : { workflows }),
    customFields,
    ...(workItemTypes === undefined ? {} : { workItemTypes }),
    ...(value.updatedAt === undefined
      ? {}
      : { updatedAt: readIsoTimestamp(value.updatedAt, 'Configuration updatedAt') }),
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
  const typeId = requestedTypeId === undefined || requestedTypeId === null || requestedTypeId === ''
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
      process.env.WORK_ITEM_CONFIGURATION_TABLE_NAME ??
      'mukuroji-work-item-configuration-local',
    workItemsTableName =
      process.env.WORK_ITEMS_TABLE_NAME ??
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
   * @param workspaceId - Workspace that owns the relation graph.
   * @param teamId - Team whose complete relation graph is read.
   * @returns All directed relations and their stable graph revision.
   */
  async listRelationGraph(
    workspaceId: string,
    teamId: string,
  ): Promise<WorkItemRelationsResponse> {
    await this.ensureTable()
    const snapshot = await this.readStableRelationGraph(workspaceId, teamId)
    return {
      graphRevision: snapshot.revision,
      relations: snapshot.relations,
    } satisfies WorkItemRelationsResponse
  }

  /** Work Item から見た relation と graph revision を返します。 */
  async listRelations(workspaceId: string, teamId: string, workItemId: string) {
    const snapshot = await this.listRelationGraph(workspaceId, teamId)
    return {
      graphRevision: snapshot.graphRevision,
      relations: snapshot.relations.filter((relation) => relation.sourceWorkItemId === workItemId),
    } satisfies WorkItemRelationsResponse
  }

  /** Reciprocal relation を単一 transaction で作成します。 */
  async createRelation(
    workspaceId: string,
    teamId: string,
    input: MutateWorkItemRelationInput,
    configurationConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    await this.ensureTable()
    const normalized = normalizeRelationInput(input)
    const snapshot = await this.readStableRelationGraph(workspaceId, teamId)
    assertExpectedGraphRevision(snapshot.revision, normalized.expectedGraphRevision)
    if (normalized.sourceWorkItemId === normalized.targetWorkItemId) {
      throw new WorkItemConfigurationError(400, 'WorkItemRelationSelf', 'A Work Item cannot relate to itself.')
    }
    const reciprocalType = reciprocalRelationType(normalized.type)
    const duplicate = snapshot.relations.some((relation) =>
      relation.sourceWorkItemId === normalized.sourceWorkItemId &&
      relation.targetWorkItemId === normalized.targetWorkItemId &&
      relation.type === normalized.type,
    )
    if (duplicate) {
      throw new WorkItemConfigurationError(409, 'WorkItemRelationDuplicate', 'The relation already exists.')
    }
    if (snapshot.relations.length + 2 > RELATION_SCAN_LIMIT) {
      throw new WorkItemConfigurationError(
        413,
        'WorkItemRelationGraphLimitExceeded',
        `A Team relation graph cannot exceed ${RELATION_SCAN_LIMIT} directed edges.`,
      )
    }
    assertRelationDoesNotCreateCycle(snapshot.relations, normalized)
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
      type: reciprocalType,
      createdAt,
    }
    const nextRevision = snapshot.revision + 1
    const nextRelations = [...snapshot.relations, relation, reciprocalRelation]

    await this.sendRelationTransaction(
      workspaceId,
      teamId,
      snapshot.revision,
      [
        createRelationPut(this.tableName, workspaceId, teamId, relation),
        createRelationPut(this.tableName, workspaceId, teamId, reciprocalRelation),
      ],
      normalized,
      relation,
      reciprocalRelation,
      createWorkItemRelationIds(nextRelations, normalized.sourceWorkItemId),
      createWorkItemRelationIds(nextRelations, normalized.targetWorkItemId),
      'create',
      configurationConditionChecks,
    )
    return { relation, reciprocalRelation, graphRevision: nextRevision }
  }

  /** Reciprocal relation を単一 transaction で削除します。 */
  async deleteRelation(workspaceId: string, teamId: string, input: MutateWorkItemRelationInput) {
    await this.ensureTable()
    const normalized = normalizeRelationInput(input, true)
    const snapshot = await this.readStableRelationGraph(workspaceId, teamId)
    assertExpectedGraphRevision(snapshot.revision, normalized.expectedGraphRevision)
    const reciprocalType = reciprocalRelationType(normalized.type)
    const relation = snapshot.relations.find((candidate) =>
      candidate.sourceWorkItemId === normalized.sourceWorkItemId &&
      candidate.targetWorkItemId === normalized.targetWorkItemId &&
      candidate.type === normalized.type,
    )
    if (!relation) {
      throw new WorkItemConfigurationError(404, 'WorkItemRelationNotFound', 'The relation was not found.')
    }
    const reciprocalRelation = snapshot.relations.find((candidate) =>
      candidate.sourceWorkItemId === normalized.targetWorkItemId &&
      candidate.targetWorkItemId === normalized.sourceWorkItemId &&
      candidate.type === reciprocalType,
    )
    if (!reciprocalRelation) {
      throw new WorkItemConfigurationError(503, 'WorkItemRelationInconsistent', 'The reciprocal relation is missing.')
    }
    const nextRevision = snapshot.revision + 1
    const removedRecordKeys = new Set([
      createRelationRecordKey(relation),
      createRelationRecordKey(reciprocalRelation),
    ])
    const nextRelations = snapshot.relations.filter((candidate) =>
      !removedRecordKeys.has(createRelationRecordKey(candidate))
    )
    await this.sendRelationTransaction(
      workspaceId,
      teamId,
      snapshot.revision,
      [
        createRelationDelete(this.tableName, workspaceId, teamId, relation),
        createRelationDelete(this.tableName, workspaceId, teamId, reciprocalRelation),
      ],
      normalized,
      relation,
      reciprocalRelation,
      createWorkItemRelationIds(nextRelations, normalized.sourceWorkItemId),
      createWorkItemRelationIds(nextRelations, normalized.targetWorkItemId),
      'delete',
    )
    return { relation, reciprocalRelation, graphRevision: nextRevision }
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
    const lock = await this.acquireConfigurationWriteLock(scopeKey)
    const nextRevision = validated.revision + 1
    const item = {
      ...validated,
      scopeKey,
      recordKey: CONFIGURATION_RECORD_KEY,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
    }
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

  private async readStableRelationGraph(workspaceId: string, teamId: string) {
    const before = await this.getRelationGraphRevision(workspaceId, teamId)
    const relations: WorkItemRelation[] = []
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
      }))
      for (const item of response.Items ?? []) {
        relations.push(readRelationItem(item))
        if (relations.length > RELATION_SCAN_LIMIT) {
          throw new WorkItemConfigurationError(
            413,
            'WorkItemRelationGraphLimitExceeded',
            `A Team relation graph cannot exceed ${RELATION_SCAN_LIMIT} directed edges.`,
          )
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    const after = await this.getRelationGraphRevision(workspaceId, teamId)
    if (before !== after) {
      throw new WorkItemConfigurationError(
        409,
        'WorkItemRelationGraphConflict',
        'Work Item relations changed. Reload and try again.',
      )
    }
    return { relations, revision: after }
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
    if (
      response.Item.entryType !== 'relation-graph' ||
      response.Item.schemaVersion !== WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
    ) {
      throw new WorkItemConfigurationError(
        503,
        'InvalidWorkItemRelationGraph',
        'Stored relation graph metadata is invalid.',
      )
    }
    return readPositiveInteger(response.Item.revision, 'Relation graph revision')
  }

  private async sendRelationTransaction(
    workspaceId: string,
    teamId: string,
    expectedRevision: number,
    edgeMutations: NonNullable<TransactWriteCommandInput['TransactItems']>,
    input: MutateWorkItemRelationInput,
    relation: WorkItemRelation,
    reciprocalRelation: WorkItemRelation,
    sourceRelationIds: readonly string[],
    targetRelationIds: readonly string[],
    operation: 'create' | 'delete',
    configurationConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    const scopeKey = createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId)
    const workItemPartitionKey = `${workspaceId}#team#${teamId}`
    const configurationConditionStartIndex = 2 + 1 + edgeMutations.length
    const graphMutation = expectedRevision === 0
      ? {
          Put: {
            TableName: this.tableName,
            Item: {
              scopeKey,
              recordKey: RELATION_GRAPH_RECORD_KEY,
              entryType: 'relation-graph',
              schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
              revision: 1,
            },
            ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          },
        }
      : {
          Put: {
            TableName: this.tableName,
            Item: {
              scopeKey,
              recordKey: RELATION_GRAPH_RECORD_KEY,
              entryType: 'relation-graph',
              schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
              revision: expectedRevision + 1,
            },
            ConditionExpression: '#revision = :expectedRevision',
            ExpressionAttributeNames: { '#revision': 'revision' },
            ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
          },
        }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.workItemsTableName,
              Key: { directoryTeamId: workItemPartitionKey, issueId: input.sourceWorkItemId },
              ...createRelationEndpointProjectionUpdate(
                input.sourceExpectedRevision,
                input.sourceAssignedProjectId,
                sourceRelationIds,
              ),
            },
          },
          {
            Update: {
              TableName: this.workItemsTableName,
              Key: { directoryTeamId: workItemPartitionKey, issueId: input.targetWorkItemId },
              ...createRelationEndpointProjectionUpdate(
                input.targetExpectedRevision,
                input.targetAssignedProjectId,
                targetRelationIds,
              ),
            },
          },
          graphMutation,
          ...edgeMutations,
          ...configurationConditionChecks,
        ],
      }))
    } catch (error) {
      if (configurationConditionChecks.some((_, index) =>
        isTransactionConditionalFailureAt(error, configurationConditionStartIndex + index)
      )) {
        throw new WorkItemConfigurationError(
          409,
          'WorkItemConfigurationRevisionConflict',
          'Work Item configuration changed during the relation mutation.',
        )
      }
      if (isNamedError(error, 'TransactionCanceledException')) {
        throw await this.classifyRelationTransactionCancellation(
          workspaceId,
          teamId,
          input,
          relation,
          reciprocalRelation,
          operation,
        )
      }
      throw toPersistenceError(error)
    }
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
 * stable identifiers, policy lists, and structural counts instead of copying that unbounded
 * payload into the audit table.
 *
 * @param configuration - Validated Work Item configuration to summarize.
 * @returns A deterministic, bounded summary of the configuration structure.
 */
function createWorkItemConfigurationAuditSnapshot(configuration: WorkItemConfiguration) {
  return {
    revision: configuration.revision,
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
        name: type.name,
        status: type.status,
        defaultWorkflowId: type.defaultWorkflowId,
        customFieldIds: [...type.customFieldIds].sort(),
        requiredCustomFieldIds: [...type.requiredCustomFieldIds].sort(),
        detailSections: [...type.detailSections],
        allowedChildTypeIds: [...type.allowedChildTypeIds].sort(),
        customFieldCount: type.customFieldIds.length,
        requiredCustomFieldCount: type.requiredCustomFieldIds.length,
      }))
      .sort((first, second) => first.id.localeCompare(second.id)),
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
    value === 'files' || value === 'activity'
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

function createRelationEndpointProjectionUpdate(
  revision: number,
  assignedProjectId: string | undefined,
  relationIds: readonly string[],
) {
  return {
    UpdateExpression: 'SET #relationIds = :relationIds',
    ConditionExpression:
      'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #revision = :revision AND ' +
      (assignedProjectId === undefined
        ? 'attribute_not_exists(#assignedProjectId)'
        : '#assignedProjectId = :assignedProjectId'),
    ExpressionAttributeNames: {
      '#assignedProjectId': 'assignedProjectId',
      '#relationIds': 'relationIds',
      '#revision': 'revision',
    },
    ExpressionAttributeValues: {
      ':relationIds': [...relationIds],
      ':revision': revision,
      ...(assignedProjectId === undefined ? {} : { ':assignedProjectId': assignedProjectId }),
    },
  }
}

/** Relation graph から Work Item row/search 用の決定的な relation ID 一覧を作成します。 */
export function createWorkItemRelationIds(
  relations: readonly WorkItemRelation[],
  sourceWorkItemId: string,
) {
  const relationIds = relations
    .filter((relation) => relation.sourceWorkItemId === sourceWorkItemId)
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

function assertRelationDoesNotCreateCycle(
  relations: readonly WorkItemRelation[],
  input: MutateWorkItemRelationInput,
) {
  if (input.type !== 'parent' && input.type !== 'blocks') {
    return
  }
  const adjacency = new Map<string, Set<string>>()
  for (const relation of relations) {
    if (relation.type !== input.type) {
      continue
    }
    const targets = adjacency.get(relation.sourceWorkItemId) ?? new Set<string>()
    targets.add(relation.targetWorkItemId)
    adjacency.set(relation.sourceWorkItemId, targets)
  }
  const pending = [input.targetWorkItemId]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === input.sourceWorkItemId) {
      throw new WorkItemConfigurationError(
        409,
        'WorkItemRelationCycle',
        `The ${input.type} relation would create a cycle.`,
      )
    }
    if (visited.has(current)) {
      continue
    }
    visited.add(current)
    pending.push(...(adjacency.get(current) ?? []))
  }
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
