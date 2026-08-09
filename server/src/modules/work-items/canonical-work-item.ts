import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CustomFieldValue,
  type WorkflowStatusCategory,
  type WorkItemPriority,
  type WorkItemSchedule,
} from '@mukuroji/contracts'
import {
  deriveWorkItemScheduleDueDate,
  isCanonicalWorkItemSchedule,
} from './domain/work-item-schedule'

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
  /** Import の冪等作成 payload を識別する SHA-256 digest です。 */
  importRequestDigest?: string
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
  /** Request intake から作成された場合の source submission ID です。 */
  sourceRequestId?: string
  /** Team Triage から作成された場合の source Entry ID です。 */
  sourceTriageEntryId?: string
  /** Workflow 内の現在 status ID です。 */
  workflowStatusId: string
  /** 横断集計に利用する標準 status category です。 */
  statusCategory: WorkflowStatusCategory
  /** Configuration に対して検証済みの custom field values です。 */
  customFieldValues: Record<string, CustomFieldValue>
  /** Relation Graph から同期した辞書順の派生 relation ID 一覧です。 */
  relationIds: string[]
  /** Schedule から導出した YYYY-MM-DD の local calendar day projection です。 */
  dueDate: string
  /** Canonical schedule used by every planning view. */
  schedule: WorkItemSchedule
  /** Work Item の優先度です。 */
  priority: WorkItemPriority
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終 state 更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
  /** Reversible archive を適用した ISO 8601 timestamp です。 */
  archivedAt?: string
  /** Archive mutation を実行した Workspace member key です。 */
  archivedBy?: string
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
    hasCanonicalWorkItemRecordBase(value) &&
    hasCanonicalScheduleProjection(value)
}

/**
 * Validates the non-schedule fields of a canonical Work Item record.
 *
 * @param value - Candidate storage record.
 * @returns Whether all version-independent fields are canonical.
 */
function hasCanonicalWorkItemRecordBase(value: Record<string, unknown>): boolean {
  return isPositiveInteger(value.revision) &&
    value.workflowSchemaVersion === WORK_ITEM_CONFIGURATION_SCHEMA_VERSION &&
    isNonEmptyString(value.directoryId) &&
    isNonEmptyString(value.teamId) &&
    value.directoryTeamId === `${value.directoryId}#team#${value.teamId}` &&
    isNonEmptyString(value.issueId) &&
    (value.importRequestDigest === undefined ||
      isSha256Digest(value.importRequestDigest)) &&
    typeof value.sortOrder === 'number' &&
    Number.isFinite(value.sortOrder) &&
    isNonEmptyString(value.title) &&
    (value.description === undefined || typeof value.description === 'string') &&
    isNonEmptyString(value.assigneeUserId) &&
    isNonEmptyString(value.creatorMemberKey) &&
    (value.sourceRequestId === undefined || isNonEmptyString(value.sourceRequestId)) &&
    (value.sourceTriageEntryId === undefined ||
      isNonEmptyString(value.sourceTriageEntryId)) &&
    hasCanonicalProjectAssignment(value) &&
    forbiddenCanonicalWorkItemFields.every((field) => value[field] === undefined) &&
    isNonEmptyString(value.workflowStatusId) &&
    isWorkflowStatusCategory(value.statusCategory) &&
    isCanonicalCustomFieldValues(value.customFieldValues) &&
    isCanonicalWorkItemRelationIds(value.relationIds) &&
    isWorkItemPriority(value.priority) &&
    isCanonicalUtcTimestamp(value.createdAt) &&
    isCanonicalUtcTimestamp(value.updatedAt) &&
    areUtcTimestampsChronological(value.createdAt, value.updatedAt) &&
    hasCanonicalArchiveState(value)
}

/**
 * Checks that a schema-v2 schedule and its deadline projection agree exactly.
 *
 * @param value - Candidate schema-v2 row.
 * @returns Whether the schedule is valid and `dueDate` is its canonical projection.
 */
function hasCanonicalScheduleProjection(value: Record<string, unknown>): boolean {
  return isCanonicalWorkItemSchedule(value.schedule) &&
    value.dueDate === deriveWorkItemScheduleDueDate(value.schedule)
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

/**
 * Validates the optional archive timestamp and actor as one atomic state.
 *
 * @param value - Candidate Work Item record.
 * @returns True when both archive fields are absent or jointly canonical.
 */
function hasCanonicalArchiveState(value: Record<string, unknown>) {
  if (value.archivedAt === undefined && value.archivedBy === undefined) {
    return true
  }
  return isNonEmptyString(value.archivedBy) &&
    isCanonicalWorkItemArchiveWindow(
      value.createdAt,
      value.archivedAt,
      value.updatedAt,
    )
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

/**
 * Checks a real canonical ISO Work Item date.
 *
 * @param value - Candidate due date.
 * @returns True for a canonical real calendar day.
 */
export function isCanonicalWorkItemDueDate(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) {
    return false
  }
  const yearText = match[1]
  const monthText = match[2]
  const dayText = match[3]
  if (!yearText || !monthText || !dayText) {
    return false
  }
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
}

/**
 * Checks that canonical Work Item timestamps form one creation-to-archive-to-update window.
 *
 * @param createdAt - Candidate Work Item creation timestamp.
 * @param archivedAt - Candidate Work Item archive timestamp.
 * @param updatedAt - Candidate Work Item update timestamp.
 * @returns True when all timestamps are canonical and chronologically ordered.
 */
export function isCanonicalWorkItemArchiveWindow(
  createdAt: unknown,
  archivedAt: unknown,
  updatedAt: unknown,
): boolean {
  return isCanonicalUtcTimestamp(createdAt) &&
    isCanonicalUtcTimestamp(archivedAt) &&
    isCanonicalUtcTimestamp(updatedAt) &&
    areUtcTimestampsChronological(createdAt, archivedAt) &&
    areUtcTimestampsChronological(archivedAt, updatedAt)
}

/**
 * Checks a canonical millisecond-precision UTC ISO timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns True when parsing and canonical serialization are lossless.
 */
function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

/**
 * Compares two already-canonical UTC timestamps by their epoch values.
 *
 * @param earlier - Timestamp expected to occur first.
 * @param later - Timestamp expected to occur second.
 * @returns True when the timestamps are chronologically ordered.
 */
function areUtcTimestampsChronological(earlier: string, later: string): boolean {
  return new Date(earlier).getTime() <= new Date(later).getTime()
}

/**
 * Checks a lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns True for exactly 32 bytes of lowercase hexadecimal text.
 */
function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
