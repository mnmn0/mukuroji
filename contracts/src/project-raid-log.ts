import { WORK_ITEM_SCHEDULE_MIN_YEAR } from './work-items'

/** Kinds of entries kept in a Project's risk, issue, and change request log. */
export type ProjectRaidEntryKind = 'risk' | 'issue' | 'change-request'

/** Every Project log entry kind in display order. */
export const PROJECT_RAID_ENTRY_KINDS: readonly ProjectRaidEntryKind[] = ['risk', 'issue', 'change-request']

/** Whether a Project log entry still needs attention. */
export type ProjectRaidEntryStatus = 'open' | 'closed'

/** Every Project log entry status in display order. */
export const PROJECT_RAID_ENTRY_STATUSES: readonly ProjectRaidEntryStatus[] = ['open', 'closed']

/** Severity derived from probability and impact, from least to most severe. */
export type ProjectRaidSeverity = 'low' | 'medium' | 'high' | 'critical'

/** Every severity from least to most severe. */
export const PROJECT_RAID_SEVERITIES: readonly ProjectRaidSeverity[] = ['low', 'medium', 'high', 'critical']

/** Smallest probability or impact rating. */
export const PROJECT_RAID_RATING_MIN = 1
/** Largest probability or impact rating. */
export const PROJECT_RAID_RATING_MAX = 5
/** Maximum length of an entry title. */
export const PROJECT_RAID_TITLE_MAX_LENGTH = 200
/** Maximum length of the description and response texts. */
export const PROJECT_RAID_TEXT_MAX_LENGTH = 2_000
/** Most entries, open and closed, one Project log may hold. */
export const PROJECT_RAID_LOG_MAX_ENTRIES = 300
/**
 * Most Work Items one entry may name as related. With the ID length below, a full log of 300
 * entries still fits the response size the text limits are chosen for (ADR 0024).
 */
export const PROJECT_RAID_RELATED_WORK_ITEMS_MAX = 10
/** Longest Work Item ID an entry may name as related. */
export const PROJECT_RAID_WORK_ITEM_ID_MAX_LENGTH = 128
/** Longest owner member key, the longest email address a member key can be. */
export const PROJECT_RAID_OWNER_ID_MAX_LENGTH = 254
/** Longest saved schedule baseline ID a decision may name. */
export const PROJECT_RAID_BASELINE_ID_MAX_LENGTH = 128

/** Pattern of a `YYYY-MM-DD` date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
/** UTC ISO 8601 timestamp, such as `2026-11-20T08:00:00.000Z`, split into date and time parts. */
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u
/**
 * Control characters other than tab, line feed, and carriage return. JSON escapes each of them
 * to six bytes, so allowing them would let a full log outgrow the response size the length
 * limits are chosen for.
 */
// eslint-disable-next-line no-control-regex -- these control characters are what the check rejects.
const DISALLOWED_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
/** A UTF-16 surrogate without its pair, which JSON also escapes to six bytes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Date change a change request asks for on one related Work Item, applied through the Work Item
 * schedule cascade when the request is approved (ADR 0078).
 */
export type ProjectRaidScheduleChangeOperation =
  | {
      /** Moves the Work Item, keeping its schedule mode and duration. */
      type: 'move'
      /** New date of the deadline, milestone, or range start, in `YYYY-MM-DD`. */
      targetDate: string
    }
  | {
      /** Changes the inclusive end of a date-range Work Item. */
      type: 'resize'
      /** New end date in `YYYY-MM-DD`. */
      endDate: string
    }

/** Requested date change of one Work Item the change request names as related. */
export type ProjectRaidScheduleChange = {
  /** Related Work Item whose dates change. */
  workItemId: string
  /** The change. */
  operation: ProjectRaidScheduleChangeOperation
}

/** Outcome of deciding a change request. */
export type ProjectRaidChangeDecisionOutcome = 'approved' | 'rejected'

/** Recorded decision on a change request, which closes it. */
export type ProjectRaidChangeDecision = {
  /** Whether the request was approved or rejected. */
  outcome: ProjectRaidChangeDecisionOutcome
  /** ISO timestamp of the decision. */
  decidedAt: string
  /** Member who decided, by member key. */
  decidedByMemberId: string
  /** Schedule baseline captured on approval, when the baseline was replaced. */
  baselineId?: string
}

/** Minutes an approval hold keeps others from rejecting or editing a change request. */
export const PROJECT_RAID_APPROVAL_HOLD_MINUTES = 10

/**
 * Hold a Project manager puts on an open change request before applying its date changes, so
 * nobody else rejects or edits it while the approval is under way (ADR 0078).
 */
export type ProjectRaidApprovalHold = {
  /** Member approving the request, by member key. */
  heldByMemberId: string
  /** ISO timestamp the hold was taken or last renewed. */
  heldAt: string
  /** ISO timestamp after which others may reject or edit the request again. */
  expiresAt: string
}

/** One risk, issue, or change request recorded for a Project. */
export type ProjectRaidEntry = {
  /** Server-assigned entry ID, unique within the Project. */
  id: string
  /** Whether this is a risk, an issue, or a change request. */
  kind: ProjectRaidEntryKind
  /** Short name of the entry. */
  title: string
  /** What may happen, what happened, or what change is requested. */
  description?: string
  /** Likelihood from 1 to 5; only risks have one. */
  probability?: number
  /** Effect on the Project from 1 to 5. */
  impact: number
  /** Mitigation for a risk, resolution for an issue, or the decision for a change request. */
  response?: string
  /** Date in `YYYY-MM-DD` by which the entry should be reviewed again. */
  reviewDueDate?: string
  /** Project member responsible for the entry, by member key. */
  ownerMemberId?: string
  /** Work Items of the Project the entry affects, without duplicates, in the order given. */
  relatedWorkItemIds?: string[]
  /** Date changes a change request asks for, at most one per related Work Item. */
  scheduleChanges?: ProjectRaidScheduleChange[]
  /** Decision on a change request; set only by the decision endpoint. */
  decision?: ProjectRaidChangeDecision
  /** Approval under way on an open change request; set only by the approval hold endpoint. */
  approvalHold?: ProjectRaidApprovalHold
  /** Whether the entry is still open. */
  status: ProjectRaidEntryStatus
  /** Increments with every change to this entry. */
  revision: number
  /** ISO timestamp of creation. */
  createdAt: string
  /** ISO timestamp of the last change. */
  updatedAt: string
  /** ISO timestamp of the last close; absent while open. */
  closedAt?: string
}

/** Editable fields of a Project log entry, sent on create and on every update. */
export type ProjectRaidEntryInput = {
  /** Whether this is a risk, an issue, or a change request. Fixed after creation. */
  kind: ProjectRaidEntryKind
  /** Short name of the entry. */
  title: string
  /** What may happen, what happened, or what change is requested. */
  description?: string
  /** Likelihood from 1 to 5; required for a risk and rejected for other kinds. */
  probability?: number
  /** Effect on the Project from 1 to 5. */
  impact: number
  /** Mitigation, resolution, or decision. */
  response?: string
  /** Date in `YYYY-MM-DD` by which the entry should be reviewed again. */
  reviewDueDate?: string
  /** Project member responsible for the entry, by member key; the server checks membership. */
  ownerMemberId?: string
  /** Work Items of the same Project the entry affects; the server checks each one exists there. */
  relatedWorkItemIds?: string[]
  /**
   * Date changes a change request asks for. Only a change request has them, each on a different
   * Work Item among `relatedWorkItemIds`.
   */
  scheduleChanges?: ProjectRaidScheduleChange[]
  /** Whether the entry is still open. */
  status: ProjectRaidEntryStatus
}

/** Request body that adds one entry to a Project log. */
export type CreateProjectRaidEntryRequest = {
  /** The new entry. */
  entry: ProjectRaidEntryInput
}

/** Request body that replaces the editable fields of one entry. */
export type UpdateProjectRaidEntryRequest = {
  /** Entry revision read before constructing the update. */
  expectedRevision: number
  /** Next editable fields. Omitted optional fields are cleared. */
  entry: ProjectRaidEntryInput
}

/**
 * Request body that approves or rejects an open change request and closes it. The client applies
 * the requested date changes and captures the baseline first; the decision is recorded last, so
 * a failure on the way leaves the request open (ADR 0078).
 */
export type DecideProjectRaidChangeRequest = {
  /** Entry revision read before deciding. */
  expectedRevision: number
  /** Approve or reject. */
  outcome: ProjectRaidChangeDecisionOutcome
  /** Baseline captured for the approval; it must be the Project's active baseline. Approval only. */
  baselineId?: string
}

/**
 * Request body that puts an approval hold on an open change request before its date changes are
 * applied. The same member may renew their own hold; another member's active hold is refused.
 */
export type HoldProjectRaidChangeRequest = {
  /** Entry revision read before holding. */
  expectedRevision: number
}

/** Open entry counts and the most severe open entry of a Project log. */
export type ProjectRaidLogSummary = {
  /** Number of open entries of each kind. */
  openCounts: Record<ProjectRaidEntryKind, number>
  /** Severity of the most severe open entry; absent when nothing is open. */
  highestOpenSeverity?: ProjectRaidSeverity
  /** Number of open entries whose review date is before the given day. */
  overdueReviewCount: number
}

/** Response of the Project log read endpoint. */
export type ProjectRaidLogResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the log belongs to. */
  projectId: string
  /** Entries, newest first. */
  entries: ProjectRaidEntry[]
  /** What the requesting member may do, decided by the server from the effective permissions. */
  viewer?: ProjectRaidLogViewerCapabilities
}

/** Project log actions the requesting member may take. */
export type ProjectRaidLogViewerCapabilities = {
  /** Whether the member may add, edit, close, and reopen entries. */
  canEdit: boolean
  /**
   * Whether the member may approve or reject change requests, which takes a Project manager
   * because approval replaces the schedule baseline. Absent from servers that predate it.
   */
  canDecide?: boolean
}

/** Response of the create and update endpoints. */
export type ProjectRaidEntryResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the log belongs to. */
  projectId: string
  /** The stored entry. */
  entry: ProjectRaidEntry
}

/** Result of validating untrusted entry input. */
export type ProjectRaidEntryInputParseResult =
  | {
      /** The input is valid. */
      ok: true
      /** Normalized input. */
      value: ProjectRaidEntryInput
    }
  | {
      /** The input is invalid. */
      ok: false
      /** Safe explanation of the first problem found. */
      message: string
    }

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a value is a Project log entry kind.
 *
 * @param value - Value to check.
 * @returns Whether the value is a known kind.
 */
export function isProjectRaidEntryKind(value: unknown): value is ProjectRaidEntryKind {
  return value === 'risk' || value === 'issue' || value === 'change-request'
}

/**
 * Checks whether a value is a Project log entry status.
 *
 * @param value - Value to check.
 * @returns Whether the value is a known status.
 */
export function isProjectRaidEntryStatus(value: unknown): value is ProjectRaidEntryStatus {
  return value === 'open' || value === 'closed'
}

/**
 * Checks whether a value is a 1 to 5 rating.
 *
 * @param value - Value to check.
 * @returns Whether the value is an integer rating.
 */
function isRating(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PROJECT_RAID_RATING_MIN &&
    value <= PROJECT_RAID_RATING_MAX
}

/**
 * Checks whether a value is a real calendar date in `YYYY-MM-DD`.
 *
 * @param value - Value to check.
 * @returns Whether the value is a valid date string.
 */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Checks whether a value is a real UTC timestamp in ISO 8601, as the server records them.
 *
 * @param value - Value to check.
 * @returns Whether the value is a valid timestamp string.
 */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = TIMESTAMP_PATTERN.exec(value)
  if (!match) return false
  const [, date, hours, minutes, seconds] = match
  return isCalendarDate(date) && Number(hours) < 24 && Number(minutes) < 60 && Number(seconds) < 60
}

/**
 * Checks whether text holds only characters that keep its JSON size close to its length: no
 * control character other than tab and line breaks, and no unpaired surrogate.
 *
 * @param text - Text to check.
 * @returns Whether the text may be stored.
 */
function hasStorableCharacters(text: string) {
  return !DISALLOWED_CONTROL_CHARACTER.test(text) && !LONE_SURROGATE.test(text)
}

/**
 * Reads an optional text field, trimming it and treating an empty string as absent.
 *
 * @param value - Raw field value.
 * @param maxLength - Longest allowed text.
 * @returns The trimmed text, `undefined` when absent, or `null` when invalid.
 */
function readOptionalText(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return undefined
  return text.length <= maxLength && hasStorableCharacters(text) ? text : null
}

/**
 * Reads the related Work Item IDs, trimming each one and dropping repeats.
 *
 * @param value - Raw field value.
 * @returns The IDs in the order given, `undefined` when absent or empty, or `null` when invalid.
 */
function readRelatedWorkItemIds(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const item of value) {
    const id = readOptionalText(item, PROJECT_RAID_WORK_ITEM_ID_MAX_LENGTH)
    if (id === undefined || id === null) return null
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length > PROJECT_RAID_RELATED_WORK_ITEMS_MAX) return null
  return ids.length === 0 ? undefined : ids
}

/**
 * Validates and normalizes untrusted Project log entry input.
 *
 * @param value - Untrusted input, usually the `entry` field of a request body.
 * @returns The normalized input or the first problem found.
 */
export function parseProjectRaidEntryInput(value: unknown): ProjectRaidEntryInputParseResult {
  if (!isRecord(value)) return { ok: false, message: 'Entry must be an object.' }
  const { kind, title, description, probability, impact, response, reviewDueDate, ownerMemberId, relatedWorkItemIds, scheduleChanges, status } = value
  if (!isProjectRaidEntryKind(kind)) return { ok: false, message: 'Entry kind must be risk, issue, or change-request.' }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, message: 'Entry title is required.' }
  }
  const normalizedTitle = title.trim()
  if (normalizedTitle.length > PROJECT_RAID_TITLE_MAX_LENGTH) {
    return { ok: false, message: `Entry title must be at most ${PROJECT_RAID_TITLE_MAX_LENGTH} characters.` }
  }
  if (!hasStorableCharacters(normalizedTitle)) {
    return { ok: false, message: 'Entry title must not contain control characters.' }
  }
  const normalizedDescription = readOptionalText(description, PROJECT_RAID_TEXT_MAX_LENGTH)
  if (normalizedDescription === null) {
    return { ok: false, message: `Entry description must be text of at most ${PROJECT_RAID_TEXT_MAX_LENGTH} characters without control characters.` }
  }
  const normalizedResponse = readOptionalText(response, PROJECT_RAID_TEXT_MAX_LENGTH)
  if (normalizedResponse === null) {
    return { ok: false, message: `Entry response must be text of at most ${PROJECT_RAID_TEXT_MAX_LENGTH} characters without control characters.` }
  }
  if (kind === 'risk') {
    if (!isRating(probability)) return { ok: false, message: 'Risk probability must be an integer from 1 to 5.' }
  } else if (probability !== undefined && probability !== null) {
    return { ok: false, message: 'Only a risk has a probability.' }
  }
  if (!isRating(impact)) return { ok: false, message: 'Entry impact must be an integer from 1 to 5.' }
  if (reviewDueDate !== undefined && reviewDueDate !== null && reviewDueDate !== '' && !isCalendarDate(reviewDueDate)) {
    return { ok: false, message: 'Entry review date must be a date in YYYY-MM-DD.' }
  }
  const normalizedOwner = readOptionalText(ownerMemberId, PROJECT_RAID_OWNER_ID_MAX_LENGTH)
  if (normalizedOwner === null) {
    return { ok: false, message: `Entry owner must be a member ID of at most ${PROJECT_RAID_OWNER_ID_MAX_LENGTH} characters.` }
  }
  const normalizedRelated = readRelatedWorkItemIds(relatedWorkItemIds)
  if (normalizedRelated === null) {
    return {
      ok: false,
      message: `Related Work Items must be a list of at most ${PROJECT_RAID_RELATED_WORK_ITEMS_MAX} Work Item IDs of at most ${PROJECT_RAID_WORK_ITEM_ID_MAX_LENGTH} characters.`,
    }
  }
  const normalizedScheduleChanges = readScheduleChanges(scheduleChanges, normalizedRelated ?? [])
  if (normalizedScheduleChanges === null) {
    return {
      ok: false,
      message: 'Schedule changes must each move or resize a different related Work Item to a date in YYYY-MM-DD.',
    }
  }
  if (normalizedScheduleChanges !== undefined && kind !== 'change-request') {
    return { ok: false, message: 'Only a change request has schedule changes.' }
  }
  if (!isProjectRaidEntryStatus(status)) return { ok: false, message: 'Entry status must be open or closed.' }
  return {
    ok: true,
    value: {
      kind,
      title: normalizedTitle,
      ...(normalizedDescription === undefined ? {} : { description: normalizedDescription }),
      ...(kind === 'risk' && isRating(probability) ? { probability } : {}),
      impact,
      ...(normalizedResponse === undefined ? {} : { response: normalizedResponse }),
      ...(isCalendarDate(reviewDueDate) ? { reviewDueDate } : {}),
      ...(normalizedOwner === undefined ? {} : { ownerMemberId: normalizedOwner }),
      ...(normalizedRelated === undefined ? {} : { relatedWorkItemIds: normalizedRelated }),
      ...(normalizedScheduleChanges === undefined ? {} : { scheduleChanges: normalizedScheduleChanges }),
      status,
    },
  }
}

/**
 * Reads the requested date changes of a change request.
 *
 * @param value - Raw field value.
 * @param relatedWorkItemIds - Normalized related Work Items; each change must name one of them.
 * @returns The changes in the order given, `undefined` when absent or empty, or `null` when invalid.
 */
function readScheduleChanges(
  value: unknown,
  relatedWorkItemIds: readonly string[],
): ProjectRaidScheduleChange[] | undefined | null {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  const changes: ProjectRaidScheduleChange[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.workItemId !== 'string') return null
    const workItemId = item.workItemId.trim()
    if (!relatedWorkItemIds.includes(workItemId)) return null
    if (changes.some((change) => change.workItemId === workItemId)) return null
    const operation = readScheduleChangeOperation(item.operation)
    if (!operation) return null
    changes.push({ workItemId, operation })
  }
  return changes.length === 0 ? undefined : changes
}

/**
 * Reads one requested date change.
 *
 * @param value - Raw operation.
 * @returns The operation, or `undefined` when invalid.
 */
function readScheduleChangeOperation(value: unknown): ProjectRaidScheduleChangeOperation | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'move' && isScheduleChangeDate(value.targetDate)) return { type: 'move', targetDate: value.targetDate }
  if (value.type === 'resize' && isScheduleChangeDate(value.endDate)) return { type: 'resize', endDate: value.endDate }
  return undefined
}

/**
 * Tells whether a value is a date a Work Item schedule accepts, so that a request can always be
 * applied when it is approved: a real `YYYY-MM-DD` date from {@link WORK_ITEM_SCHEDULE_MIN_YEAR}.
 *
 * @param value - Candidate date.
 * @returns Whether the value is a schedulable calendar date.
 */
function isScheduleChangeDate(value: unknown): value is string {
  return isCalendarDate(value) && Number(value.slice(0, 4)) >= WORK_ITEM_SCHEDULE_MIN_YEAR
}

/**
 * Reads a stored change request decision.
 *
 * @param value - Raw decision.
 * @returns The decision, `undefined` when absent, or `null` when malformed.
 */
function readDecision(value: unknown): ProjectRaidChangeDecision | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const { outcome, decidedAt, decidedByMemberId, baselineId } = value
  if (outcome !== 'approved' && outcome !== 'rejected') return null
  if (!isTimestamp(decidedAt)) return null
  if (typeof decidedByMemberId !== 'string' || decidedByMemberId.length === 0 || decidedByMemberId.length > PROJECT_RAID_OWNER_ID_MAX_LENGTH) {
    return null
  }
  if (baselineId !== undefined && (outcome !== 'approved' || typeof baselineId !== 'string' ||
    baselineId.length === 0 || baselineId.length > PROJECT_RAID_BASELINE_ID_MAX_LENGTH)) {
    return null
  }
  return { outcome, decidedAt, decidedByMemberId, ...(typeof baselineId === 'string' ? { baselineId } : {}) }
}

/**
 * Reads a stored approval hold.
 *
 * @param value - Raw hold.
 * @returns The hold, `undefined` when absent, or `null` when malformed.
 */
function readApprovalHold(value: unknown): ProjectRaidApprovalHold | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || !hasOnlyKeys(value, ['heldByMemberId', 'heldAt', 'expiresAt'])) return null
  const { heldByMemberId, heldAt, expiresAt } = value
  if (typeof heldByMemberId !== 'string' || heldByMemberId.length === 0 || heldByMemberId.length > PROJECT_RAID_OWNER_ID_MAX_LENGTH) {
    return null
  }
  if (!isTimestamp(heldAt) || !isTimestamp(expiresAt)) return null
  return { heldByMemberId, heldAt, expiresAt }
}

/**
 * Tells whether an approval hold still keeps others from rejecting or editing its change request.
 *
 * @param hold - Hold on the entry, if any.
 * @param now - Current time.
 * @returns Whether a hold exists and has not expired.
 */
export function isProjectRaidApprovalHoldActive(hold: ProjectRaidApprovalHold | undefined, now: Date): boolean {
  return hold !== undefined && Date.parse(hold.expiresAt) > now.getTime()
}

/**
 * Tells whether a stored schedule change list equals its normalized form.
 *
 * @param normalized - Normalized changes, or `undefined` when there are none.
 * @param raw - Changes as stored or received.
 * @returns Whether both hold the same changes in the same order.
 */
function sameScheduleChanges(normalized: readonly ProjectRaidScheduleChange[] | undefined, raw: unknown) {
  if (normalized === undefined) return raw === undefined
  return Array.isArray(raw) && raw.length === normalized.length &&
    normalized.every((change, index) => sameScheduleChange(change, raw[index]))
}

/**
 * Tells whether one stored change holds exactly the fields of its normalized form, whatever order
 * its object keys are in.
 *
 * @param normalized - Normalized change.
 * @param raw - Change as stored or received.
 * @returns Whether both hold the same Work Item and the same operation, with no other fields.
 */
function sameScheduleChange(normalized: ProjectRaidScheduleChange, raw: unknown) {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['workItemId', 'operation'])) return false
  if (raw.workItemId !== normalized.workItemId || !isRecord(raw.operation)) return false
  const operation = raw.operation
  return normalized.operation.type === 'move'
    ? hasOnlyKeys(operation, ['type', 'targetDate']) &&
      operation.type === 'move' && operation.targetDate === normalized.operation.targetDate
    : hasOnlyKeys(operation, ['type', 'endDate']) &&
      operation.type === 'resize' && operation.endDate === normalized.operation.endDate
}

/**
 * Tells whether an object has no keys besides the given ones.
 *
 * @param value - Object to check.
 * @param keys - Allowed keys.
 * @returns Whether every key of the object is allowed.
 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}

/**
 * Validates a stored or received Project log entry.
 *
 * @param value - Untrusted entry, such as a stored row or an API response item.
 * @returns The entry, or `undefined` when any field is malformed.
 */
export function parseProjectRaidEntry(value: unknown): ProjectRaidEntry | undefined {
  if (!isRecord(value)) return undefined
  const { id, revision, createdAt, updatedAt, closedAt } = value
  const decision = readDecision(value.decision)
  if (decision === null) return undefined
  const approvalHold = readApprovalHold(value.approvalHold)
  if (approvalHold === null) return undefined
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return undefined
  if (closedAt !== undefined && !isTimestamp(closedAt)) return undefined
  const input = parseProjectRaidEntryInput(value)
  if (!input.ok) return undefined
  // Stored and returned entries are already normalized, so a value that normalization would
  // change, such as untrimmed text, is not a valid entry.
  if (
    input.value.title !== value.title ||
    input.value.description !== value.description ||
    input.value.response !== value.response ||
    input.value.reviewDueDate !== value.reviewDueDate ||
    input.value.ownerMemberId !== value.ownerMemberId ||
    !sameIds(input.value.relatedWorkItemIds, value.relatedWorkItemIds) ||
    !sameScheduleChanges(input.value.scheduleChanges, value.scheduleChanges)
  ) {
    return undefined
  }
  // Only a closed change request carries a decision.
  if (decision !== undefined && (input.value.kind !== 'change-request' || input.value.status !== 'closed')) return undefined
  // Only an open, undecided change request is held for approval.
  if (approvalHold !== undefined && (input.value.kind !== 'change-request' || input.value.status !== 'open' || decision !== undefined)) {
    return undefined
  }
  return {
    id,
    ...input.value,
    ...(decision === undefined ? {} : { decision }),
    ...(approvalHold === undefined ? {} : { approvalHold }),
    revision,
    createdAt,
    updatedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
  }
}

/**
 * Tells whether a stored ID list equals its normalized form.
 *
 * @param normalized - Normalized IDs, or `undefined` when there are none.
 * @param raw - IDs as stored or received.
 * @returns Whether both hold the same IDs in the same order.
 */
function sameIds(normalized: readonly string[] | undefined, raw: unknown) {
  if (normalized === undefined) return raw === undefined
  return Array.isArray(raw) && raw.length === normalized.length && normalized.every((id, index) => raw[index] === id)
}

/**
 * Derives the severity of an entry.
 *
 * A risk is rated by probability times impact: up to 4 is low, up to 9 medium, up to 16 high,
 * and above that critical. An issue or change request has already happened or been asked for,
 * so only its impact counts: 1 and 2 are low, 3 medium, 4 high, and 5 critical.
 *
 * @param entry - Entry kind, probability, and impact.
 * @returns The severity.
 */
export function deriveProjectRaidSeverity(
  entry: Pick<ProjectRaidEntryInput, 'kind' | 'probability' | 'impact'>,
): ProjectRaidSeverity {
  if (entry.kind === 'risk') {
    const score = (entry.probability ?? PROJECT_RAID_RATING_MIN) * entry.impact
    if (score <= 4) return 'low'
    if (score <= 9) return 'medium'
    if (score <= 16) return 'high'
    return 'critical'
  }
  if (entry.impact <= 2) return 'low'
  if (entry.impact === 3) return 'medium'
  if (entry.impact === 4) return 'high'
  return 'critical'
}

/**
 * Tells whether an open entry's review date has passed.
 *
 * @param entry - Entry status and review date.
 * @param today - Today in `YYYY-MM-DD`, in the viewer's calendar.
 * @returns Whether the entry is open and was due for review before today.
 */
export function isProjectRaidReviewOverdue(
  entry: Pick<ProjectRaidEntry, 'status' | 'reviewDueDate'>,
  today: string,
): boolean {
  return entry.status === 'open' && entry.reviewDueDate !== undefined && entry.reviewDueDate < today
}

/**
 * Summarizes the open entries of a Project log.
 *
 * @param entries - Every entry of the log.
 * @param today - Today in `YYYY-MM-DD`, used to count overdue reviews.
 * @returns Open counts per kind, the highest open severity, and the overdue review count.
 */
export function summarizeProjectRaidLog(
  entries: readonly ProjectRaidEntry[],
  today: string,
): ProjectRaidLogSummary {
  const openCounts: Record<ProjectRaidEntryKind, number> = { risk: 0, issue: 0, 'change-request': 0 }
  let highest = -1
  let overdueReviewCount = 0
  for (const entry of entries) {
    if (entry.status !== 'open') continue
    openCounts[entry.kind] += 1
    highest = Math.max(highest, PROJECT_RAID_SEVERITIES.indexOf(deriveProjectRaidSeverity(entry)))
    if (isProjectRaidReviewOverdue(entry, today)) overdueReviewCount += 1
  }
  const highestOpenSeverity = PROJECT_RAID_SEVERITIES[highest]
  return {
    openCounts,
    ...(highestOpenSeverity === undefined ? {} : { highestOpenSeverity }),
    overdueReviewCount,
  }
}

/**
 * Validates a Project log read response.
 *
 * @param value - Untrusted response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseProjectRaidLogResponse(value: unknown): ProjectRaidLogResponse | undefined {
  if (!isRecord(value) || typeof value.teamId !== 'string' || typeof value.projectId !== 'string') return undefined
  if (!Array.isArray(value.entries)) return undefined
  const entries: ProjectRaidEntry[] = []
  for (const item of value.entries) {
    const entry = parseProjectRaidEntry(item)
    if (!entry) return undefined
    entries.push(entry)
  }
  const { viewer } = value
  if (viewer !== undefined && (
    !isRecord(viewer) ||
    typeof viewer.canEdit !== 'boolean' ||
    (viewer.canDecide !== undefined && typeof viewer.canDecide !== 'boolean')
  )) return undefined
  return {
    teamId: value.teamId,
    projectId: value.projectId,
    entries,
    ...(isRecord(viewer) && typeof viewer.canEdit === 'boolean'
      ? {
          viewer: {
            canEdit: viewer.canEdit,
            ...(typeof viewer.canDecide === 'boolean' ? { canDecide: viewer.canDecide } : {}),
          },
        }
      : {}),
  }
}

/**
 * Validates a Project log create or update response.
 *
 * @param value - Untrusted response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseProjectRaidEntryResponse(value: unknown): ProjectRaidEntryResponse | undefined {
  if (!isRecord(value) || typeof value.teamId !== 'string' || typeof value.projectId !== 'string') return undefined
  const entry = parseProjectRaidEntry(value.entry)
  return entry ? { teamId: value.teamId, projectId: value.projectId, entry } : undefined
}

/**
 * One Project log entry as the Public API returns it, with its derived severity. The approval hold
 * is internal to the approval flow and is left out.
 */
export type PublicProjectRaidEntry = Omit<ProjectRaidEntry, 'approvalHold'> & {
  /** Severity derived from probability and impact by {@link deriveProjectRaidSeverity}. */
  severity: ProjectRaidSeverity
}

/**
 * Builds the Public API form of an entry: adds its severity and leaves out the approval hold.
 *
 * @param entry - Stored entry.
 * @returns The entry as the Public API returns it.
 */
export function toPublicProjectRaidEntry(entry: ProjectRaidEntry): PublicProjectRaidEntry {
  const { approvalHold: _approvalHold, ...visible } = entry
  return { ...visible, severity: deriveProjectRaidSeverity(entry) }
}

/** Response of `GET /api/v1/projects/{projectId}/raid-log`. */
export type PublicProjectRaidLog = {
  /** Version of this response shape. */
  schemaVersion: 1
  /** Team that owns the Project. */
  teamId: string
  /** Project the log belongs to. */
  projectId: string
  /** Every entry, open and closed, newest first. */
  items: PublicProjectRaidEntry[]
}
