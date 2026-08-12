import {
  DOCUMENT_SCHEMA_VERSION,
  type DocumentDetail,
  type SearchEntityType,
} from '@mukuroji/contracts'
import { validateDocumentPayload } from '../../../src/modules/documents'
import { isCanonicalWorkItemRecord } from '../../../src/modules/work-items'
import {
  createCommentWorkspaceSearchDocument,
  createDocumentWorkspaceSearchDocument,
  createProjectWorkspaceSearchDocument,
  createTeamWorkspaceSearchDocument,
  createWorkItemWorkspaceSearchDocument,
  createWorkspaceSearchDocumentRecordKey,
  WorkspaceSearchError,
  type WorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'

const projectDirectoryIgnoredEntryTypes = new Set<string>([
  'email-alias',
  'planning-meta',
  'project-member',
  'webhook-active-locator-rollback-checkpoint',
  'webhook-authorization-backfill-checkpoint',
  'webhook-team-grant',
  'webhook-team-grant-cleanup',
  'workspace-member',
  'workspace-metadata',
])
const collaborationIgnoredEntryTypes = new Set<string>([
  'discussion',
  'presence',
  'reaction',
  'watcher',
])
const documentIgnoredEntryTypes = new Set<string>([
  'document-authorization-revision',
  'document-backlink',
  'document-backlink-target-fence',
  'document-child',
  'document-comment',
  'document-comment-receipt',
  'document-operation',
  'document-preference',
  'document-presence',
  'document-public-link',
  'document-recent',
  'document-search-access',
  'document-search-body',
  'document-share',
  'document-tree-revision',
  'document-version',
  'document-version-delta',
  'document-version-snapshot',
])

/**
 * Source table role accepted by the Workspace Search migration mapper.
 */
export type WorkspaceSearchMigrationMapperSource =
  | 'project-directory'
  | 'work-items'
  | 'collaboration'
  | 'documents'

/**
 * Stable raw-value-free reason for rejecting a source row.
 */
export type WorkspaceSearchMigrationInvalidReason =
  | 'MALFORMED_PROJECT_DIRECTORY_TARGET'
  | 'UNRECOGNIZED_PROJECT_DIRECTORY_ROW'
  | 'MALFORMED_WORK_ITEM_TARGET'
  | 'MALFORMED_COLLABORATION_TARGET'
  | 'UNRECOGNIZED_COLLABORATION_ROW'
  | 'MALFORMED_DOCUMENT_TARGET'
  | 'UNRECOGNIZED_DOCUMENT_ROW'
  | 'MAPPER_EXCEPTION'

/**
 * Physical Workspace Search key produced by the pure mapper.
 */
export type WorkspaceSearchMigrationTargetKey = {
  /** Canonical Workspace Search partition key. */
  readonly workspaceId: string
  /** Deterministic Workspace Search sort key. */
  readonly recordKey: string
}

/**
 * Target replacement produced for an active canonical source row.
 */
export type WorkspaceSearchMigrationPut = {
  /** Target mutation discriminator. */
  readonly action: 'put'
  /** Complete validated Workspace Search document. */
  readonly document: WorkspaceSearchDocument
}

/**
 * Target deletion produced for an archived or deleted canonical source row.
 */
export type WorkspaceSearchMigrationDelete = {
  /** Target mutation discriminator. */
  readonly action: 'delete'
}

/**
 * Successfully mapped source row and its deterministic target identity.
 */
export type WorkspaceSearchMigrationMappedRow = {
  /** Classification discriminator. */
  readonly classification: 'mapped'
  /** Search entity family represented by the source row. */
  readonly entityType: SearchEntityType
  /** Exact physical target key. */
  readonly targetKey: WorkspaceSearchMigrationTargetKey
  /** Put or delete target state. */
  readonly operation: WorkspaceSearchMigrationPut | WorkspaceSearchMigrationDelete
}

/**
 * Recognized single-table row that intentionally has no Search projection.
 */
export type WorkspaceSearchMigrationIgnoredRow = {
  /** Classification discriminator. */
  readonly classification: 'ignored'
  /** Stable reason suitable for aggregate evidence and logs. */
  readonly reasonCode: 'RECOGNIZED_NON_TARGET_ROW'
}

/**
 * Unrecognized or malformed row that makes a production scan fail closed.
 */
export type WorkspaceSearchMigrationInvalidRow = {
  /** Classification discriminator. */
  readonly classification: 'invalid'
  /** Stable raw-value-free validation reason. */
  readonly reasonCode: WorkspaceSearchMigrationInvalidReason
}

/**
 * Complete pure classification returned for one decoded source row.
 */
export type WorkspaceSearchMigrationRowClassification =
  | WorkspaceSearchMigrationMappedRow
  | WorkspaceSearchMigrationIgnoredRow
  | WorkspaceSearchMigrationInvalidRow

/**
 * Canonical Work Item scope recovered from a collaboration partition key.
 */
type WorkItemCollaborationScope = {
  /** Canonical Workspace ID. */
  readonly workspaceId: string
  /** Owning Team ID. */
  readonly teamId: string
  /** Team-local Work Item ID. */
  readonly issueId: string
}

/**
 * Maps one decoded DynamoDB source row without I/O or mutable shared state.
 *
 * Known non-target single-table rows are ignored. Unknown discriminators and
 * malformed target rows are invalid so a production migration can fail closed.
 * No source values are returned in an invalid result.
 *
 * @param source - Logical source table role.
 * @param item - Decoded native DynamoDB source row.
 * @returns Put/delete mapping, recognized ignore, or stable invalid result.
 */
export function mapWorkspaceSearchMigrationRow(
  source: WorkspaceSearchMigrationMapperSource,
  item: Readonly<Record<string, unknown>>,
): WorkspaceSearchMigrationRowClassification {
  try {
    if (source === 'project-directory') {
      return mapProjectDirectoryRow(item)
    }
    if (source === 'work-items') {
      return mapWorkItemRow(item)
    }
    if (source === 'collaboration') {
      return mapCollaborationRow(item)
    }
    return mapDocumentRow(item)
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchError) {
      if (source === 'project-directory') {
        return invalidRow('MALFORMED_PROJECT_DIRECTORY_TARGET')
      }
      if (source === 'work-items') {
        return invalidRow('MALFORMED_WORK_ITEM_TARGET')
      }
      if (source === 'collaboration') {
        return invalidRow('MALFORMED_COLLABORATION_TARGET')
      }
      return invalidRow('MALFORMED_DOCUMENT_TARGET')
    }
    return invalidRow('MAPPER_EXCEPTION')
  }
}

/**
 * Maps a Project Directory target or classifies its discriminator.
 *
 * @param item - Decoded Project Directory row.
 * @returns Strict row classification.
 */
function mapProjectDirectoryRow(
  item: Readonly<Record<string, unknown>>,
): WorkspaceSearchMigrationRowClassification {
  const entryType = item.entryType
  if (typeof entryType === 'string' && projectDirectoryIgnoredEntryTypes.has(entryType)) {
    if (hasProjectDirectoryTargetKey(item)) {
      return invalidRow('MALFORMED_PROJECT_DIRECTORY_TARGET')
    }
    return ignoredRow()
  }
  if (entryType !== 'team' && entryType !== 'project') {
    return invalidRow('UNRECOGNIZED_PROJECT_DIRECTORY_ROW')
  }

  const workspaceId = readCanonicalWorkspaceId(item.directoryId)
  const teamId = readNonBlankString(item.teamId)
  const teamSortOrder = readPositiveSafeInteger(item.teamSortOrder)
  const entryKey = readNonBlankString(item.entryKey)
  const nameJa = readString(item.nameJa)
  const nameEn = readString(item.nameEn)
  const archivedAt = readOptionalCanonicalTimestamp(item.archivedAt)
  const createdAt = readOptionalCanonicalTimestamp(item.createdAt)
  const updatedAt = readOptionalCanonicalTimestamp(item.updatedAt)

  if (
    !workspaceId ||
    !teamId ||
    teamId.includes('/') ||
    !teamSortOrder ||
    !entryKey ||
    nameJa === undefined ||
    nameEn === undefined ||
    archivedAt === false ||
    createdAt === false ||
    updatedAt === false ||
    !areOptionalTimestampsChronological(createdAt, updatedAt) ||
    !isOptionalTimestampWithinRange(archivedAt, createdAt, updatedAt)
  ) {
    return invalidRow('MALFORMED_PROJECT_DIRECTORY_TARGET')
  }

  const title = hasNonBlankString(nameJa)
    ? nameJa
    : hasNonBlankString(nameEn)
      ? nameEn
      : undefined
  const subtitle = hasNonBlankString(nameJa) &&
      hasNonBlankString(nameEn) &&
      nameJa !== nameEn
    ? nameEn
    : undefined
  if (!title) return invalidRow('MALFORMED_PROJECT_DIRECTORY_TARGET')

  if (entryType === 'team') {
    if (
      entryKey !== createTeamEntryKey(teamSortOrder, teamId) ||
      item.expanded !== undefined && typeof item.expanded !== 'boolean'
    ) {
      return invalidRow('MALFORMED_PROJECT_DIRECTORY_TARGET')
    }
    const entityId = `team/${teamId}`
    if (archivedAt) {
      return mappedDelete(workspaceId, 'team', entityId)
    }
    return mappedPut(createTeamWorkspaceSearchDocument({
      workspaceId,
      teamId,
      title,
      ...(subtitle ? { subtitle } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }))
  }

  const projectId = readNonBlankString(item.projectId)
  const projectSortOrder = readPositiveSafeInteger(item.projectSortOrder)
  if (
    !projectId ||
    projectId.includes('/') ||
    !projectSortOrder ||
    !isProjectTone(item.tone) ||
    entryKey !== createProjectEntryKey(
      teamSortOrder,
      projectSortOrder,
      projectId,
    )
  ) {
    return invalidRow('MALFORMED_PROJECT_DIRECTORY_TARGET')
  }
  const entityId = `team/${teamId}/project/${projectId}`
  if (archivedAt) {
    return mappedDelete(workspaceId, 'project', entityId)
  }
  return mappedPut(createProjectWorkspaceSearchDocument({
    workspaceId,
    teamId,
    projectId,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }))
}

/**
 * Maps one strict canonical Work Item row.
 *
 * @param item - Decoded Work Item row.
 * @returns Strict row classification.
 */
function mapWorkItemRow(
  item: Readonly<Record<string, unknown>>,
): WorkspaceSearchMigrationRowClassification {
  if (!isCanonicalWorkItemRecord(item)) {
    return invalidRow('MALFORMED_WORK_ITEM_TARGET')
  }
  if (
    item.directoryId.length > 1_024 ||
    item.teamId.includes('/') ||
    item.issueId.includes('/') ||
    item.assignedProjectId?.includes('/')
  ) {
    return invalidRow('MALFORMED_WORK_ITEM_TARGET')
  }
  const deletedAt = readOptionalCanonicalTimestamp(item.deletedAt)
  if (
    deletedAt === false ||
    deletedAt &&
      (
        Date.parse(deletedAt) < Date.parse(item.createdAt) ||
        Date.parse(deletedAt) > Date.parse(item.updatedAt)
      )
  ) {
    return invalidRow('MALFORMED_WORK_ITEM_TARGET')
  }

  const entityId = `team/${item.teamId}/issue/${item.issueId}`
  if (item.archivedAt || deletedAt) {
    return mappedDelete(item.directoryId, 'work-item', entityId)
  }

  return mappedPut(createWorkItemWorkspaceSearchDocument({
    workspaceId: item.directoryId,
    teamId: item.teamId,
    issueId: item.issueId,
    title: item.title,
    ...(item.description ? { body: item.description } : {}),
    ...(item.assignedProjectId ? { projectId: item.assignedProjectId } : {}),
    assigneeUserId: item.assigneeUserId,
    creatorUserId: item.creatorMemberKey,
    status: item.workflowStatusId,
    ...(Object.keys(item.customFieldValues).length > 0
      ? { customFields: item.customFieldValues }
      : {}),
    ...(item.relationIds.length > 0 ? { relationIds: item.relationIds } : {}),
    dueDate: item.dueDate,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }))
}

/**
 * Maps a Collaboration comment or classifies its discriminator.
 *
 * @param item - Decoded Collaboration row.
 * @returns Strict row classification.
 */
function mapCollaborationRow(
  item: Readonly<Record<string, unknown>>,
): WorkspaceSearchMigrationRowClassification {
  const entryType = item.entryType
  if (typeof entryType === 'string' && collaborationIgnoredEntryTypes.has(entryType)) {
    if (hasRecordKeyPrefix(item, 'COMMENT#')) {
      return invalidRow('MALFORMED_COLLABORATION_TARGET')
    }
    return ignoredRow()
  }
  if (entryType !== 'comment') {
    return invalidRow('UNRECOGNIZED_COLLABORATION_ROW')
  }
  if (hasOwnAttribute(item, 'expiresAt')) {
    return invalidRow('MALFORMED_COLLABORATION_TARGET')
  }

  const entityKey = readNonBlankString(item.entityKey)
  const commentId = readNonBlankString(item.id)
  const recordKey = readNonBlankString(item.recordKey)
  const rootCommentId = readNonBlankString(item.rootCommentId)
  const authorMemberKey = readNonBlankString(item.authorMemberKey)
  const bodyMarkdown = readString(item.bodyMarkdown)
  const version = readPositiveSafeInteger(item.version)
  const createdAt = readCanonicalTimestamp(item.createdAt)
  const updatedAt = readCanonicalTimestamp(item.updatedAt)
  const deletedAt = readOptionalCanonicalTimestamp(item.deletedAt)
  const editedAt = readOptionalCanonicalTimestamp(item.editedAt)
  const resolvedAt = readOptionalCanonicalTimestamp(item.resolvedAt)
  const resolvedByMemberKey = readOptionalCanonicalMemberKey(
    item.resolvedByMemberKey,
  )
  const scope = entityKey
    ? parseWorkItemCollaborationEntityKey(entityKey)
    : undefined

  if (
    !scope ||
    !commentId ||
    commentId.includes('/') ||
    recordKey !== `COMMENT#${commentId}` ||
    !rootCommentId ||
    rootCommentId.includes('/') ||
    !authorMemberKey ||
    bodyMarkdown === undefined ||
    (!deletedAt && !hasNonBlankString(bodyMarkdown)) ||
    !version ||
    !createdAt ||
    !updatedAt ||
    deletedAt === false ||
    editedAt === false ||
    resolvedAt === false ||
    resolvedByMemberKey === false ||
    (resolvedAt === undefined) !== (resolvedByMemberKey === undefined) ||
    Date.parse(createdAt) > Date.parse(updatedAt) ||
    !isOptionalNonBlankString(item.parentCommentId) ||
    !isCanonicalMemberKeyArray(item.mentionMemberKeys)
  ) {
    return invalidRow('MALFORMED_COLLABORATION_TARGET')
  }

  for (const timestamp of [deletedAt, editedAt, resolvedAt]) {
    if (
      timestamp &&
      (
        Date.parse(timestamp) < Date.parse(createdAt) ||
        Date.parse(timestamp) > Date.parse(updatedAt)
      )
    ) {
      return invalidRow('MALFORMED_COLLABORATION_TARGET')
    }
  }

  const entityId =
    `team/${scope.teamId}/issue/${scope.issueId}/comment/${commentId}`
  if (deletedAt) {
    return mappedDelete(scope.workspaceId, 'comment', entityId)
  }

  return mappedPut(createCommentWorkspaceSearchDocument({
    workspaceId: scope.workspaceId,
    teamId: scope.teamId,
    issueId: scope.issueId,
    commentId,
    body: bodyMarkdown,
    creatorUserId: authorMemberKey,
    createdAt,
    updatedAt,
  }))
}

/**
 * Maps a current Document row or classifies its discriminator.
 *
 * @param item - Decoded Documents single-table row.
 * @returns Strict row classification.
 */
function mapDocumentRow(
  item: Readonly<Record<string, unknown>>,
): WorkspaceSearchMigrationRowClassification {
  const entryType = item.entryType
  if (typeof entryType === 'string' && documentIgnoredEntryTypes.has(entryType)) {
    if (hasRecordKeyPrefix(item, 'DOCUMENT#')) {
      return invalidRow('MALFORMED_DOCUMENT_TARGET')
    }
    return ignoredRow()
  }
  if (entryType !== 'document') {
    return invalidRow('UNRECOGNIZED_DOCUMENT_ROW')
  }
  if (hasOwnAttribute(item, 'expiresAtEpoch')) {
    return invalidRow('MALFORMED_DOCUMENT_TARGET')
  }

  const workspaceId = readCanonicalWorkspaceId(item.workspaceId)
  const documentId = readNonBlankString(item.documentId)
  const revision = readPositiveSafeInteger(item.revision)
  if (
    !workspaceId ||
    !documentId ||
    !revision ||
    item.recordKey !== `DOCUMENT#${documentId}` ||
    !isCanonicalDocumentDetail(item.document) ||
    item.document.id !== documentId ||
    item.document.revision !== revision
  ) {
    return invalidRow('MALFORMED_DOCUMENT_TARGET')
  }

  if (item.document.archivedAt) {
    return mappedDelete(workspaceId, 'document', documentId)
  }
  return mappedPut(
    createDocumentWorkspaceSearchDocument(workspaceId, item.document),
  )
}

/**
 * Validates the complete Document snapshot used by the Search projector.
 *
 * @param value - Candidate canonical Document detail.
 * @returns Whether the value passes the domain validator and common metadata rules.
 */
function isCanonicalDocumentDetail(value: unknown): value is DocumentDetail {
  const createdAt = isRecord(value)
    ? readCanonicalTimestamp(value.createdAt)
    : undefined
  const updatedAt = isRecord(value)
    ? readCanonicalTimestamp(value.updatedAt)
    : undefined
  if (
    !isRecord(value) ||
    value.schemaVersion !== DOCUMENT_SCHEMA_VERSION ||
    !createdAt ||
    !updatedAt ||
    typeof value.favorite !== 'boolean' ||
    !hasDocumentCapabilities(value.capabilities) ||
    readOptionalCanonicalTimestamp(value.lastOpenedAt) === false ||
    readOptionalCanonicalTimestamp(value.archivedAt) === false
  ) {
    return false
  }

  if (
    value.kind === 'folder' &&
    (
      !Number.isSafeInteger(value.childCount) ||
      typeof value.childCount !== 'number' ||
      value.childCount < 0
    )
  ) {
    return false
  }

  try {
    // Keep the persisted value untrusted until the runtime validator succeeds;
    // a direct call would require an unchecked DocumentDetail assertion here.
    Reflect.apply(validateDocumentPayload, undefined, [value])
  } catch {
    return false
  }

  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    return false
  }
  if (
    typeof value.archivedAt === 'string' &&
    (
      Date.parse(value.archivedAt) < Date.parse(createdAt) ||
      Date.parse(value.archivedAt) > Date.parse(updatedAt)
    )
  ) {
    return false
  }
  return true
}

/**
 * Checks the Boolean capability shape required by DocumentDetail.
 *
 * @param value - Candidate capability map.
 * @returns Whether all canonical capability flags are Boolean.
 */
function hasDocumentCapabilities(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.canView === 'boolean' &&
    typeof value.canEdit === 'boolean' &&
    typeof value.canComment === 'boolean' &&
    typeof value.canShare === 'boolean' &&
    typeof value.canManagePermissions === 'boolean' &&
    typeof value.canArchive === 'boolean' &&
    typeof value.canRestore === 'boolean' &&
    typeof value.canExport === 'boolean'
}

/**
 * Checks whether a Project Directory row occupies a Team or Project target key.
 *
 * @param item - Decoded Project Directory row.
 * @returns Whether the physical key belongs to a migration target family.
 */
function hasProjectDirectoryTargetKey(
  item: Readonly<Record<string, unknown>>,
): boolean {
  const entryKey = item.entryKey
  return typeof entryKey === 'string' &&
    (
      /^[0-9]{6,}#000000#TEAM#[^#]+$/u.test(entryKey) ||
      /^[0-9]{6,}#[0-9]{6,}#PROJECT#[^#]+$/u.test(entryKey)
    )
}

/**
 * Checks whether a row's sort key occupies one target-family prefix.
 *
 * @param item - Decoded single-table row.
 * @param prefix - Physical target sort-key prefix.
 * @returns Whether the row occupies the target prefix.
 */
function hasRecordKeyPrefix(
  item: Readonly<Record<string, unknown>>,
  prefix: string,
): boolean {
  return typeof item.recordKey === 'string' &&
    item.recordKey.startsWith(prefix)
}

/**
 * Checks whether a decoded row carries one physical table attribute.
 *
 * Collaboration and Documents target candidates must not carry their table's
 * TTL attribute because DynamoDB service deletion cannot participate in the
 * application writer fence. The measured migration identity separately
 * requires TTL to be disabled for Project Directory, Work Items, and the
 * Workspace Search target.
 *
 * @param item - Decoded single-table row.
 * @param attributeName - Exact physical TTL attribute name.
 * @returns Whether the attribute is present, without reading its value.
 */
function hasOwnAttribute(
  item: Readonly<Record<string, unknown>>,
  attributeName: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(item, attributeName)
}

/**
 * Recovers a canonical Work Item scope from a Collaboration partition key.
 *
 * @param entityKey - Candidate Collaboration partition key.
 * @returns Parsed scope, or undefined for a malformed or non-Work-Item key.
 */
function parseWorkItemCollaborationEntityKey(
  entityKey: string,
): WorkItemCollaborationScope | undefined {
  const workItemMarker = '#work-item#team/'
  const markerIndex = entityKey.lastIndexOf(workItemMarker)
  if (markerIndex < 1) return undefined

  const workspaceId = entityKey.slice(0, markerIndex)
  const remainder = entityKey.slice(markerIndex + workItemMarker.length)
  const issueMarker = '/issue/'
  const issueMarkerIndex = remainder.indexOf(issueMarker)
  if (issueMarkerIndex < 1) return undefined

  const teamId = remainder.slice(0, issueMarkerIndex)
  const issueId = remainder.slice(issueMarkerIndex + issueMarker.length)
  if (
    !readCanonicalWorkspaceId(workspaceId) ||
    !readNonBlankString(teamId) ||
    !readNonBlankString(issueId) ||
    teamId.includes('/') ||
    issueId.includes('/') ||
    `${workspaceId}${workItemMarker}${teamId}${issueMarker}${issueId}` !== entityKey
  ) {
    return undefined
  }
  return { workspaceId, teamId, issueId }
}

/**
 * Creates a mapped put classification.
 *
 * @param document - Validated target document.
 * @returns Mapped put result.
 */
function mappedPut(
  document: WorkspaceSearchDocument,
): WorkspaceSearchMigrationMappedRow {
  return {
    classification: 'mapped',
    entityType: document.entityType,
    targetKey: {
      workspaceId: document.workspaceId,
      recordKey: document.recordKey,
    },
    operation: {
      action: 'put',
      document,
    },
  }
}

/**
 * Creates a mapped delete classification.
 *
 * @param workspaceId - Canonical target partition key.
 * @param entityType - Search entity family.
 * @param entityId - Canonical entity identity.
 * @returns Mapped delete result.
 */
function mappedDelete(
  workspaceId: string,
  entityType: SearchEntityType,
  entityId: string,
): WorkspaceSearchMigrationMappedRow {
  return {
    classification: 'mapped',
    entityType,
    targetKey: {
      workspaceId,
      recordKey: createWorkspaceSearchDocumentRecordKey(entityType, entityId),
    },
    operation: { action: 'delete' },
  }
}

/**
 * Creates the recognized non-target classification.
 *
 * @returns Stable ignored result.
 */
function ignoredRow(): WorkspaceSearchMigrationIgnoredRow {
  return {
    classification: 'ignored',
    reasonCode: 'RECOGNIZED_NON_TARGET_ROW',
  }
}

/**
 * Creates a stable invalid classification.
 *
 * @param reasonCode - Raw-value-free source validation reason.
 * @returns Stable invalid result.
 */
function invalidRow(
  reasonCode: WorkspaceSearchMigrationInvalidReason,
): WorkspaceSearchMigrationInvalidRow {
  return {
    classification: 'invalid',
    reasonCode,
  }
}

/**
 * Creates a canonical Team directory sort key.
 *
 * @param teamSortOrder - Positive Team display order.
 * @param teamId - Canonical Team ID.
 * @returns Exact physical sort key.
 */
function createTeamEntryKey(teamSortOrder: number, teamId: string): string {
  return `${padSortOrder(teamSortOrder)}#000000#TEAM#${teamId}`
}

/**
 * Creates a canonical Project directory sort key.
 *
 * @param teamSortOrder - Positive Team display order.
 * @param projectSortOrder - Positive Project display order.
 * @param projectId - Canonical Project ID.
 * @returns Exact physical sort key.
 */
function createProjectEntryKey(
  teamSortOrder: number,
  projectSortOrder: number,
  projectId: string,
): string {
  return `${padSortOrder(teamSortOrder)}#${padSortOrder(projectSortOrder)}#PROJECT#${projectId}`
}

/**
 * Formats a directory display order for its physical key.
 *
 * @param value - Positive safe display order.
 * @returns At-least-six-digit decimal text.
 */
function padSortOrder(value: number): string {
  return String(value).padStart(6, '0')
}

/**
 * Checks a supported Project display tone.
 *
 * @param value - Candidate tone.
 * @returns Whether the tone is canonical.
 */
function isProjectTone(value: unknown): boolean {
  return value === 'blue' ||
    value === 'purple' ||
    value === 'green' ||
    value === 'yellow'
}

/**
 * Reads a canonical nonblank string without exposing it in an error.
 *
 * @param value - Candidate value.
 * @returns Original trimmed nonblank string, or undefined.
 */
function readNonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' &&
      value.length > 0 &&
      value === value.trim()
    ? value
    : undefined
}

/**
 * Reads the exact application-canonical Workspace Search partition key.
 *
 * @param value - Candidate Workspace ID.
 * @returns Exact-trimmed ID up to the runtime's 1,024-character limit.
 */
function readCanonicalWorkspaceId(value: unknown): string | undefined {
  const workspaceId = readNonBlankString(value)
  return workspaceId && workspaceId.length <= 1_024
    ? workspaceId
    : undefined
}

/**
 * Checks whether text contains at least one non-whitespace character.
 *
 * @param value - Candidate display or body text.
 * @returns Whether the text contains visible content.
 */
function hasNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Reads any string, including an empty localized name.
 *
 * @param value - Candidate value.
 * @returns String value, or undefined.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Reads a positive safe integer.
 *
 * @param value - Candidate value.
 * @returns Positive safe integer, or undefined.
 */
function readPositiveSafeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Reads a canonical ISO timestamp.
 *
 * @param value - Candidate value.
 * @returns Canonical timestamp, or undefined.
 */
function readCanonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return undefined
  return new Date(milliseconds).toISOString() === value ? value : undefined
}

/**
 * Validates an optional canonical timestamp while distinguishing invalid input.
 *
 * @param value - Candidate optional timestamp.
 * @returns Undefined when absent, canonical text when valid, or false when invalid.
 */
function readOptionalCanonicalTimestamp(
  value: unknown,
): string | undefined | false {
  if (value === undefined) return undefined
  return readCanonicalTimestamp(value) ?? false
}

/**
 * Checks ordering when both optional timestamps are present.
 *
 * @param createdAt - Optional creation time.
 * @param updatedAt - Optional update time.
 * @returns Whether the pair is absent or chronological.
 */
function areOptionalTimestampsChronological(
  createdAt: string | undefined,
  updatedAt: string | undefined,
): boolean {
  return !createdAt ||
    !updatedAt ||
    Date.parse(createdAt) <= Date.parse(updatedAt)
}

/**
 * Checks whether an optional event time falls inside an available row lifetime.
 *
 * @param eventAt - Optional event timestamp.
 * @param createdAt - Optional creation timestamp.
 * @param updatedAt - Optional update timestamp.
 * @returns Whether the event is within every supplied boundary.
 */
function isOptionalTimestampWithinRange(
  eventAt: string | undefined,
  createdAt: string | undefined,
  updatedAt: string | undefined,
): boolean {
  if (!eventAt) return true
  if (createdAt && Date.parse(eventAt) < Date.parse(createdAt)) return false
  return !updatedAt || Date.parse(eventAt) <= Date.parse(updatedAt)
}

/**
 * Checks an optional nonblank string field.
 *
 * @param value - Candidate optional string.
 * @returns Whether the field is absent or nonblank.
 */
function isOptionalNonBlankString(value: unknown): boolean {
  return value === undefined || readNonBlankString(value) !== undefined
}

/**
 * Checks a required string array.
 *
 * @param value - Candidate mention member-key array.
 * @returns Whether members are bounded, unique, and already normalized.
 */
function isCanonicalMemberKeyArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20) return false
  const memberKeys = new Set<string>()
  for (const entry of value) {
    if (!isCanonicalMemberKey(entry) || memberKeys.has(entry)) return false
    memberKeys.add(entry)
  }
  return true
}

/**
 * Checks a normalized Collaboration member key.
 *
 * @param value - Candidate member key.
 * @returns Whether the key is nonblank, trimmed, and lowercase.
 */
function isCanonicalMemberKey(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim().toLowerCase()
}

/**
 * Validates an optional canonical Collaboration member key.
 *
 * @param value - Candidate optional member key.
 * @returns Undefined when absent, canonical text when valid, or false when invalid.
 */
function readOptionalCanonicalMemberKey(
  value: unknown,
): string | undefined | false {
  if (value === undefined) return undefined
  return isCanonicalMemberKey(value) ? value : false
}

/**
 * Checks whether a value is a non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a validation record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
