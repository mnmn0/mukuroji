import type { AuditEventV1, AuditFieldChange, AuditValue } from '../audit'

/** Sort-key prefix of the per-Work-Item Analytics history rows in the Analytics table. */
export const ANALYTICS_WORK_ITEM_HISTORY_RECORD_PREFIX = 'WORK_ITEM_HISTORY#'

/** `entryType` of a per-Work-Item Analytics history row. */
export const ANALYTICS_WORK_ITEM_HISTORY_ENTRY_TYPE = 'analytics-work-item-history'

/** Schema version of a per-Work-Item Analytics history row. */
export const ANALYTICS_WORK_ITEM_HISTORY_SCHEMA_VERSION = 1

/**
 * Serialized size above which a history row keeps no entries and is marked as overflowed.
 *
 * DynamoDB items are limited to 400 KB; the margin leaves room for keys and attribute names.
 */
export const ANALYTICS_WORK_ITEM_HISTORY_MAX_BYTES = 350 * 1024

/** Audit event fields the Analytics engine reads from a Work Item history event. */
export type AnalyticsHistoryEvent = Pick<
  AuditEventV1,
  | 'eventId'
  | 'eventType'
  | 'action'
  | 'occurredAt'
  | 'entity'
  | 'entityType'
  | 'entityId'
  | 'target'
  | 'targetType'
  | 'targetId'
  | 'changes'
  | 'metadata'
>

/** Audit metadata kept in a history entry, used by the canonical revision checks. */
export type AnalyticsWorkItemHistoryMetadata = {
  /** Writer adapter that produced the canonical mutation, such as `canonical-work-item`. */
  adapter?: string
  /** Team ID recorded by the canonical writer. */
  teamId?: string
  /** Work Item ID recorded by the canonical writer. */
  issueId?: string
  /** Canonical Work Item revision after the mutation. */
  afterRevision?: number
}

/** One audit event of a Work Item, reduced to what the Analytics engine reads. */
export type AnalyticsWorkItemHistoryEntry = {
  /** Source audit event ID, so evidence keeps pointing at the audit record. */
  eventId: string
  /** Source audit event type. */
  eventType: string
  /** Source audit action. */
  action: string
  /** Source audit occurrence time (ISO 8601). */
  occurredAt: string
  /** Field changes the Analytics engine can rewind or turn into transitions. */
  changes: AuditFieldChange[]
  /** Revision metadata of the source audit event, when it had any. */
  metadata?: AnalyticsWorkItemHistoryMetadata
  /** Audit retention expiry (epoch seconds); absent while retention is suspended. */
  expiresAt?: number
}

/** Identity of one Work Item history row. */
export type AnalyticsWorkItemHistoryKey = {
  /** Owning Workspace ID. */
  workspaceId: string
  /** Owning Team ID. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
}

/** Per-Work-Item Analytics history row, derived from the Work Item's audit events. */
export type AnalyticsWorkItemHistoryRow = AnalyticsWorkItemHistoryKey & {
  /** Highest canonical revision whose audit events are all present without gaps; 0 if none. */
  coveredRevision: number
  /** True when the entries did not fit in one row; readers then use the audit timeline. */
  overflow: boolean
  /** Work Item audit events in occurrence order; empty when `overflow` is true. */
  entries: AnalyticsWorkItemHistoryEntry[]
  /** Optimistic concurrency counter, incremented on every write. */
  rowVersion: number
}

/** Result of reading one history row for an update. */
export type AnalyticsWorkItemHistoryRowRead = {
  /** Parsed row, or undefined when it is missing or malformed. */
  row: AnalyticsWorkItemHistoryRow | undefined
  /** Whether an item exists under the history key, even if it could not be parsed. */
  exists: boolean
}

/** Write side of the per-Work-Item Analytics history rows. */
export type AnalyticsWorkItemHistoryStore = {
  /** Reads one row with a strongly consistent read. */
  getRow(key: AnalyticsWorkItemHistoryKey): Promise<AnalyticsWorkItemHistoryRowRead>
  /**
   * Saves a row if the stored row is still the one that was read.
   *
   * @returns False when another writer changed the row first.
   */
  putRow(
    row: AnalyticsWorkItemHistoryRow,
    previous: AnalyticsWorkItemHistoryRowRead,
  ): Promise<boolean>
  /** Deletes a row; deleting a missing row succeeds. */
  deleteRow(key: AnalyticsWorkItemHistoryKey): Promise<void>
}

/**
 * Builds the canonical audit entity ID of a Work Item.
 *
 * @param teamId - Owning Team ID.
 * @param workItemId - Work Item ID.
 * @returns The `team/<teamId>/issue/<workItemId>` entity ID used by audit events.
 */
export function createAnalyticsWorkItemEntityId(teamId: string, workItemId: string) {
  return `team/${teamId}/issue/${workItemId}`
}

/**
 * Builds the Analytics table sort key of a Work Item history row.
 *
 * @param teamId - Owning Team ID.
 * @param workItemId - Work Item ID.
 * @returns The `WORK_ITEM_HISTORY#<team>#<workItem>` record key with encoded components.
 */
export function createAnalyticsWorkItemHistoryRecordKey(teamId: string, workItemId: string) {
  return `${ANALYTICS_WORK_ITEM_HISTORY_RECORD_PREFIX}${encodeURIComponent(teamId)}#${
    encodeURIComponent(workItemId)
  }`
}

/**
 * Maps an audit field path to the Analytics state field it changes.
 *
 * @param field - Dot-separated audit field path.
 * @returns The normalized Analytics field, or undefined when Analytics ignores the field.
 */
export function normalizeAnalyticsFieldPath(field: string) {
  if (field === 'workflowStatusCategory' || field === 'workflow.category') {
    return 'statusCategory'
  }
  if (
    field === 'title' ||
    field === 'assignedProjectId' ||
    field === 'assigneeUserId' ||
    field === 'workItemTypeId' ||
    field === 'statusCategory' ||
    field === 'dueDate' ||
    field === 'createdAt' ||
    field === 'updatedAt' ||
    field === 'archivedAt' ||
    field === 'customFieldValues' ||
    field.startsWith('customFieldValues.') ||
    field === 'schedule' ||
    field === 'remainingEffortMinutes'
  ) {
    return field
  }
  return undefined
}

/** Work Item identity and history entry read from one audit event. */
export type AnalyticsWorkItemHistoryEventInput = {
  /** Owning Team ID. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
  /** Whether the event deleted the Work Item. */
  deleted: boolean
  /** Reduced history entry of the event. */
  entry: AnalyticsWorkItemHistoryEntry
}

/**
 * Reduces an audit event to a Work Item history entry when the event targets a Work Item itself.
 *
 * Events of records attached to a Work Item (comments, files, context items) share its entity
 * timeline but target their own records; the Analytics engine ignores them, so they are skipped.
 *
 * @param event - Normalized audit event.
 * @returns The Work Item identity and entry, or undefined for any other event.
 */
export function readAnalyticsWorkItemHistoryEvent(
  event: AuditEventV1,
): AnalyticsWorkItemHistoryEventInput | undefined {
  if (
    event.entityType !== 'work-item' ||
    event.entity.type !== 'work-item' ||
    event.entityId !== event.entity.id ||
    event.targetType !== 'work-item' ||
    event.target.type !== 'work-item' ||
    event.targetId !== event.target.id ||
    event.targetId !== event.entityId
  ) {
    return undefined
  }
  const identity = parseAnalyticsWorkItemEntityId(event.entityId)
  if (!identity) return undefined
  const metadata = readHistoryMetadata(event.metadata)
  if (
    (metadata?.teamId !== undefined && metadata.teamId !== identity.teamId) ||
    (metadata?.issueId !== undefined && metadata.issueId !== identity.workItemId)
  ) {
    return undefined
  }
  return {
    ...identity,
    deleted: event.eventType === 'work-item.deleted',
    entry: {
      eventId: event.eventId,
      eventType: event.eventType,
      action: event.action,
      occurredAt: event.occurredAt,
      changes: event.changes
        .filter((change) => normalizeAnalyticsFieldPath(change.field) !== undefined)
        .map((change) => structuredClone(change)),
      ...(metadata === undefined ? {} : { metadata }),
      ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
    },
  }
}

/**
 * Parses a canonical Work Item audit entity ID.
 *
 * @param entityId - Audit entity ID.
 * @returns The Team and Work Item IDs, or undefined when the ID is not canonical.
 */
function parseAnalyticsWorkItemEntityId(entityId: string) {
  const match = /^team\/([^/]+)\/issue\/([^/]+)$/.exec(entityId)
  if (!match?.[1] || !match[2]) return undefined
  return { teamId: match[1], workItemId: match[2] }
}

/**
 * Keeps the audit metadata fields that the Analytics revision checks read.
 *
 * @param metadata - Source audit metadata.
 * @returns The reduced metadata, or undefined when none of the fields are present.
 */
function readHistoryMetadata(
  metadata: AuditEventV1['metadata'],
): AnalyticsWorkItemHistoryMetadata | undefined {
  if (!metadata) return undefined
  const result: AnalyticsWorkItemHistoryMetadata = {}
  if (typeof metadata.adapter === 'string') result.adapter = metadata.adapter
  if (typeof metadata.teamId === 'string') result.teamId = metadata.teamId
  if (typeof metadata.issueId === 'string') result.issueId = metadata.issueId
  if (
    typeof metadata.afterRevision === 'number' &&
    Number.isSafeInteger(metadata.afterRevision) &&
    metadata.afterRevision > 0
  ) {
    result.afterRevision = metadata.afterRevision
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/**
 * Creates an empty history row for a Work Item.
 *
 * @param key - Workspace, Team, and Work Item IDs.
 * @returns A row with no entries and revision 0 coverage.
 */
export function createEmptyAnalyticsWorkItemHistoryRow(
  key: AnalyticsWorkItemHistoryKey,
): AnalyticsWorkItemHistoryRow {
  return { ...key, coveredRevision: 0, overflow: false, entries: [], rowVersion: 0 }
}

/**
 * Merges history entries into a row.
 *
 * Entries are keyed by event ID; a later copy of the same event replaces the earlier one, so
 * an audit retention change (a new `expiresAt`) updates the entry. Entries past their audit
 * retention are dropped. Coverage is recomputed, and a row that no longer fits in one item is
 * marked as overflowed and keeps no entries.
 *
 * @param row - Current row.
 * @param entries - Entries to merge.
 * @param nowEpochSeconds - Current time; when given, expired entries are dropped.
 * @returns The merged row with an incremented `rowVersion`.
 */
export function mergeAnalyticsWorkItemHistoryEntries(
  row: AnalyticsWorkItemHistoryRow,
  entries: readonly AnalyticsWorkItemHistoryEntry[],
  nowEpochSeconds?: number,
): AnalyticsWorkItemHistoryRow {
  if (row.overflow) {
    return { ...row, rowVersion: row.rowVersion + 1 }
  }
  const byEventId = new Map(row.entries.map((entry) => [entry.eventId, entry]))
  for (const entry of entries) byEventId.set(entry.eventId, entry)
  const merged = [...byEventId.values()]
    .filter((entry) =>
      nowEpochSeconds === undefined ||
      entry.expiresAt === undefined ||
      entry.expiresAt > nowEpochSeconds
    )
    .sort(compareHistoryEntries)
  const next: AnalyticsWorkItemHistoryRow = {
    ...row,
    coveredRevision: calculateCoveredRevision(merged),
    overflow: false,
    entries: merged,
    rowVersion: row.rowVersion + 1,
  }
  if (measureAnalyticsWorkItemHistoryRow(next) > ANALYTICS_WORK_ITEM_HISTORY_MAX_BYTES) {
    return { ...next, overflow: true, entries: [] }
  }
  return next
}

/**
 * Returns whether merging an entry would leave a revision gap that the audit timeline may fill.
 *
 * @param row - Current row.
 * @param entry - Entry about to be merged.
 * @returns True when the entry's revision is beyond the next contiguous revision.
 */
export function hasAnalyticsWorkItemHistoryGap(
  row: AnalyticsWorkItemHistoryRow,
  entry: AnalyticsWorkItemHistoryEntry,
) {
  const revision = entry.metadata?.afterRevision
  if (revision === undefined || row.overflow) return false
  if (row.coveredRevision === 0) return revision > 1
  return revision > row.coveredRevision + 1
}

/**
 * Calculates the highest revision reached without gaps from the lowest stored revision.
 *
 * Audit events older than the tenant retention can be gone, so coverage starts at the lowest
 * revision present instead of revision 1, matching what the audit timeline itself still holds.
 *
 * @param entries - History entries.
 * @returns The covered revision, or 0 when no entry carries a revision.
 */
function calculateCoveredRevision(entries: readonly AnalyticsWorkItemHistoryEntry[]) {
  const revisions = new Set<number>()
  for (const entry of entries) {
    const revision = entry.metadata?.afterRevision
    if (revision !== undefined) revisions.add(revision)
  }
  if (revisions.size === 0) return 0
  let covered = Math.min(...revisions)
  while (revisions.has(covered + 1)) covered += 1
  return covered
}

/**
 * Orders history entries the way the Analytics engine orders audit events.
 *
 * @param left - First entry.
 * @param right - Second entry.
 * @returns A negative, zero, or positive comparison result.
 */
function compareHistoryEntries(
  left: AnalyticsWorkItemHistoryEntry,
  right: AnalyticsWorkItemHistoryEntry,
) {
  return left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventId.localeCompare(right.eventId)
}

/**
 * Estimates the stored size of a history row.
 *
 * @param row - Row to measure.
 * @returns The UTF-8 byte length of the row serialized as JSON.
 */
export function measureAnalyticsWorkItemHistoryRow(row: AnalyticsWorkItemHistoryRow) {
  return Buffer.byteLength(JSON.stringify(row), 'utf8')
}

/**
 * Restores the Analytics engine's view of the audit events stored in a history row.
 *
 * @param row - History row whose coverage was already checked against the canonical revision.
 * @param historyReadAt - Inclusive upper bound of event occurrence (ISO 8601).
 * @param nowEpochSeconds - Current time; entries past their audit retention are dropped.
 * @returns Events in occurrence order.
 */
export function toAnalyticsHistoryEvents(
  row: AnalyticsWorkItemHistoryRow,
  historyReadAt: string,
  nowEpochSeconds: number,
): AnalyticsHistoryEvent[] {
  const cutoff = Date.parse(historyReadAt)
  const entityId = createAnalyticsWorkItemEntityId(row.teamId, row.workItemId)
  const entity = { type: 'work-item', id: entityId } as const
  return row.entries
    .filter((entry) =>
      (!Number.isFinite(cutoff) || Date.parse(entry.occurredAt) <= cutoff) &&
      (entry.expiresAt === undefined || entry.expiresAt > nowEpochSeconds)
    )
    .map((entry) => ({
      eventId: entry.eventId,
      eventType: entry.eventType,
      action: entry.action,
      occurredAt: entry.occurredAt,
      entity: { ...entity },
      entityType: 'work-item',
      entityId,
      target: { ...entity },
      targetType: 'work-item',
      targetId: entityId,
      changes: entry.changes.map((change) => structuredClone(change)),
      ...(entry.metadata === undefined ? {} : { metadata: { ...entry.metadata } }),
    }))
}

/** DynamoDB TTL attribute of the Analytics table, set only on history rows. */
export const ANALYTICS_WORK_ITEM_HISTORY_TTL_ATTRIBUTE = 'historyExpiresAt'

/**
 * Serializes a history row for DynamoDB.
 *
 * @param row - Row to store.
 * @returns The DynamoDB item, keyed by `workspaceId` and `recordKey`.
 */
export function toStoredAnalyticsWorkItemHistoryRow(row: AnalyticsWorkItemHistoryRow) {
  const expiries = row.entries.flatMap((entry) =>
    entry.expiresAt === undefined ? [] : [entry.expiresAt]
  )
  return {
    // DynamoDB TTL deletes the row once its oldest entry passes the audit retention, so the row
    // never keeps audit data longer than the audit table does; the next event rebuilds it.
    ...(expiries.length === 0 ? {} : { historyExpiresAt: Math.min(...expiries) }),
    workspaceId: row.workspaceId,
    recordKey: createAnalyticsWorkItemHistoryRecordKey(row.teamId, row.workItemId),
    entryType: ANALYTICS_WORK_ITEM_HISTORY_ENTRY_TYPE,
    schemaVersion: ANALYTICS_WORK_ITEM_HISTORY_SCHEMA_VERSION,
    teamId: row.teamId,
    workItemId: row.workItemId,
    coveredRevision: row.coveredRevision,
    overflow: row.overflow,
    entries: row.entries,
    rowVersion: row.rowVersion,
  }
}

/**
 * Parses a stored history row strictly.
 *
 * @param value - DynamoDB item.
 * @returns The row, or undefined when the item is not a valid schema v1 history row.
 */
export function parseStoredAnalyticsWorkItemHistoryRow(
  value: unknown,
): AnalyticsWorkItemHistoryRow | undefined {
  if (!isRecord(value)) return undefined
  const {
    workspaceId,
    recordKey,
    teamId,
    workItemId,
    coveredRevision,
    overflow,
    entries,
    rowVersion,
  } = value
  if (
    value.entryType !== ANALYTICS_WORK_ITEM_HISTORY_ENTRY_TYPE ||
    value.schemaVersion !== ANALYTICS_WORK_ITEM_HISTORY_SCHEMA_VERSION ||
    typeof workspaceId !== 'string' ||
    typeof teamId !== 'string' ||
    typeof workItemId !== 'string' ||
    recordKey !== createAnalyticsWorkItemHistoryRecordKey(teamId, workItemId) ||
    !isNonNegativeInteger(coveredRevision) ||
    typeof overflow !== 'boolean' ||
    !isNonNegativeInteger(rowVersion) ||
    !Array.isArray(entries)
  ) {
    return undefined
  }
  const parsedEntries: AnalyticsWorkItemHistoryEntry[] = []
  for (const entry of entries) {
    const parsed = parseStoredHistoryEntry(entry)
    if (!parsed) return undefined
    parsedEntries.push(parsed)
  }
  return {
    workspaceId,
    teamId,
    workItemId,
    coveredRevision,
    overflow,
    entries: parsedEntries,
    rowVersion,
  }
}

/**
 * Parses one stored history entry.
 *
 * @param value - Stored entry.
 * @returns The entry, or undefined when it is malformed.
 */
function parseStoredHistoryEntry(value: unknown): AnalyticsWorkItemHistoryEntry | undefined {
  if (!isRecord(value)) return undefined
  const { eventId, eventType, action, occurredAt, changes, metadata, expiresAt } = value
  if (
    typeof eventId !== 'string' ||
    typeof eventType !== 'string' ||
    typeof action !== 'string' ||
    typeof occurredAt !== 'string' ||
    !Array.isArray(changes) ||
    (expiresAt !== undefined && !isNonNegativeInteger(expiresAt))
  ) {
    return undefined
  }
  const parsedChanges: AuditFieldChange[] = []
  for (const change of changes) {
    if (!isRecord(change) || typeof change.field !== 'string') return undefined
    if (change.redacted !== undefined && typeof change.redacted !== 'boolean') return undefined
    parsedChanges.push({
      field: change.field,
      ...(change.before === undefined ? {} : { before: readAuditValue(change.before) }),
      ...(change.after === undefined ? {} : { after: readAuditValue(change.after) }),
      ...(change.redacted === undefined ? {} : { redacted: change.redacted }),
    })
  }
  let parsedMetadata: AnalyticsWorkItemHistoryMetadata | undefined
  if (metadata !== undefined) {
    if (!isRecord(metadata)) return undefined
    parsedMetadata = {}
    if (metadata.adapter !== undefined) {
      if (typeof metadata.adapter !== 'string') return undefined
      parsedMetadata.adapter = metadata.adapter
    }
    if (metadata.teamId !== undefined) {
      if (typeof metadata.teamId !== 'string') return undefined
      parsedMetadata.teamId = metadata.teamId
    }
    if (metadata.issueId !== undefined) {
      if (typeof metadata.issueId !== 'string') return undefined
      parsedMetadata.issueId = metadata.issueId
    }
    if (metadata.afterRevision !== undefined) {
      if (!isNonNegativeInteger(metadata.afterRevision)) return undefined
      parsedMetadata.afterRevision = metadata.afterRevision
    }
  }
  return {
    eventId,
    eventType,
    action,
    occurredAt,
    changes: parsedChanges,
    ...(parsedMetadata === undefined ? {} : { metadata: parsedMetadata }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/**
 * Narrows a stored value to an audit value (JSON-compatible data).
 *
 * @param value - Stored value.
 * @returns The value as an audit value; unsupported values become null.
 */
function readAuditValue(value: unknown): AuditValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value
  }
  if (Array.isArray(value)) return value.map(readAuditValue)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, readAuditValue(entry)]),
    )
  }
  return null
}

/**
 * Returns whether a value is a non-negative safe integer.
 *
 * @param value - Candidate value.
 * @returns True for 0, 1, 2, ...
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Returns whether a value is a non-array object.
 *
 * @param value - Candidate value.
 * @returns True for plain objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
