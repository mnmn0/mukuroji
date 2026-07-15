import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CustomFieldValue,
  type WorkflowStatusCategory,
  type WorkItemPriority,
} from '@mukuroji/contracts'

const WORK_ITEM_RELATION_ID_LIMIT = 100
const WORK_ITEM_RELATION_ID_MAX_LENGTH = 512
const WORK_ITEM_RELATION_TARGET_ID_MAX_LENGTH = 256

/** DynamoDB に保存する strict canonical Work Item row です。 */
export type CanonicalWorkItemRecord = Record<string, unknown> & {
  /** Work Item contract の schema version です。 */
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION
  /** State mutation の optimistic concurrency revision です。 */
  revision: number
  /** Workflow/custom field configuration の schema version です。 */
  workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  /** Work Item を所有する Workspace ID です。 */
  directoryId: string
  /** Workspace と Team を結合した primary partition key です。 */
  directoryTeamId: string
  /** Assigned Project がある場合の project GSI partition key です。 */
  directoryProjectId?: string
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item の遂行先 Project ID です。 */
  assignedProjectId?: string
  /** Team 内で Work Item を識別する sort key です。 */
  issueId: string
  /** Team/project 一覧で利用する表示順です。 */
  sortOrder: number
  /** Work Item の literal title です。 */
  title: string
  /** Work Item の説明です。 */
  description?: string
  /** 担当 Workspace member key です。 */
  assigneeUserId: string
  /** Work Item を作成した Workspace member key です。 */
  creatorMemberKey: string
  /** Workflow 内の現在 status ID です。 */
  workflowStatusId: string
  /** 横断集計に利用する標準 status category です。 */
  statusCategory: WorkflowStatusCategory
  /** Configuration に対して検証済みの custom field values です。 */
  customFieldValues: Record<string, CustomFieldValue>
  /** Relation Graph から同期した辞書順の派生 relation ID 一覧です。 */
  relationIds: string[]
  /** UTC calendar day として扱う期限文字列です。 */
  dueDate: string
  /** Work Item の優先度です。 */
  priority: WorkItemPriority
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終 state 更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
}

const forbiddenCanonicalWorkItemFields = [
  'assignee',
  'assigneeKey',
  'customFields',
  'migrationSource',
  'migrationSourceKey',
  'projectId',
  'source',
  'status',
  'titleKey',
  'workItemId',
] as const

/** 未知値が strict canonical Work Item storage row かを判定します。 */
export function isCanonicalWorkItemRecord(value: unknown): value is CanonicalWorkItemRecord {
  if (!isRecord(value)) {
    return false
  }

  return value.schemaVersion === WORK_ITEM_SCHEMA_VERSION &&
    isPositiveInteger(value.revision) &&
    value.workflowSchemaVersion === WORK_ITEM_CONFIGURATION_SCHEMA_VERSION &&
    isNonEmptyString(value.directoryId) &&
    isNonEmptyString(value.teamId) &&
    value.directoryTeamId === `${value.directoryId}#team#${value.teamId}` &&
    isNonEmptyString(value.issueId) &&
    typeof value.sortOrder === 'number' &&
    Number.isFinite(value.sortOrder) &&
    isNonEmptyString(value.title) &&
    (value.description === undefined || typeof value.description === 'string') &&
    isNonEmptyString(value.assigneeUserId) &&
    isNonEmptyString(value.creatorMemberKey) &&
    hasCanonicalProjectAssignment(value) &&
    forbiddenCanonicalWorkItemFields.every((field) => value[field] === undefined) &&
    isNonEmptyString(value.workflowStatusId) &&
    isWorkflowStatusCategory(value.statusCategory) &&
    isCanonicalCustomFieldValues(value.customFieldValues) &&
    isCanonicalWorkItemRelationIds(value.relationIds) &&
    isNonEmptyString(value.dueDate) &&
    isWorkItemPriority(value.priority) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt)
}

/** Canonical Work Item の derived relation ID 一覧を厳密検証します。 */
export function isCanonicalWorkItemRelationIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > WORK_ITEM_RELATION_ID_LIMIT) {
    return false
  }
  if (!value.every(isCanonicalWorkItemRelationId)) {
    return false
  }
  if (new Set(value).size !== value.length) {
    return false
  }
  return value.every((relationId, index) => index === 0 || value[index - 1]! < relationId)
}

function hasCanonicalProjectAssignment(value: Record<string, unknown>) {
  if (value.assignedProjectId === undefined) {
    return value.directoryProjectId === undefined
  }

  return isNonEmptyString(value.assignedProjectId) &&
    value.directoryProjectId === `${value.directoryId}#project#${value.assignedProjectId}`
}

function isCanonicalCustomFieldValues(
  value: unknown,
): value is Record<string, CustomFieldValue> {
  return isRecord(value) && Object.entries(value).every(([fieldId, fieldValue]) =>
    isNonEmptyString(fieldId) && isCanonicalCustomFieldValue(fieldValue)
  )
}

function isCanonicalCustomFieldValue(value: unknown): value is CustomFieldValue {
  return typeof value === 'string' ||
    typeof value === 'number' && Number.isFinite(value) ||
    typeof value === 'boolean' ||
    Array.isArray(value) && value.length <= 100 &&
      value.every((entry) => typeof entry === 'string')
}

function isCanonicalWorkItemRelationId(value: unknown) {
  if (typeof value !== 'string' || value.length > WORK_ITEM_RELATION_ID_MAX_LENGTH) {
    return false
  }
  const separatorIndex = value.indexOf(':')
  if (separatorIndex < 1) {
    return false
  }
  const type = value.slice(0, separatorIndex)
  const targetWorkItemId = value.slice(separatorIndex + 1)
  return isWorkItemRelationType(type) &&
    isNonEmptyString(targetWorkItemId) &&
    targetWorkItemId.length <= WORK_ITEM_RELATION_TARGET_ID_MAX_LENGTH
}

function isWorkflowStatusCategory(value: unknown): value is WorkflowStatusCategory {
  return value === 'backlog' ||
    value === 'unstarted' ||
    value === 'started' ||
    value === 'completed' ||
    value === 'canceled'
}

function isWorkItemPriority(value: unknown): value is WorkItemPriority {
  return value === 'high' || value === 'medium' || value === 'low'
}

function isWorkItemRelationType(value: string) {
  return value === 'parent' ||
    value === 'child' ||
    value === 'blocks' ||
    value === 'blockedBy' ||
    value === 'related' ||
    value === 'duplicate'
}

function isPositiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
