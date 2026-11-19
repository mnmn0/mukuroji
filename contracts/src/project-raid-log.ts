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
export const PROJECT_RAID_LOG_MAX_ENTRIES = 500

/** Pattern of a `YYYY-MM-DD` date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

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
  return text.length <= maxLength ? text : null
}

/**
 * Validates and normalizes untrusted Project log entry input.
 *
 * @param value - Untrusted input, usually the `entry` field of a request body.
 * @returns The normalized input or the first problem found.
 */
export function parseProjectRaidEntryInput(value: unknown): ProjectRaidEntryInputParseResult {
  if (!isRecord(value)) return { ok: false, message: 'Entry must be an object.' }
  const { kind, title, description, probability, impact, response, reviewDueDate, status } = value
  if (!isProjectRaidEntryKind(kind)) return { ok: false, message: 'Entry kind must be risk, issue, or change-request.' }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, message: 'Entry title is required.' }
  }
  const normalizedTitle = title.trim()
  if (normalizedTitle.length > PROJECT_RAID_TITLE_MAX_LENGTH) {
    return { ok: false, message: `Entry title must be at most ${PROJECT_RAID_TITLE_MAX_LENGTH} characters.` }
  }
  const normalizedDescription = readOptionalText(description, PROJECT_RAID_TEXT_MAX_LENGTH)
  if (normalizedDescription === null) {
    return { ok: false, message: `Entry description must be text of at most ${PROJECT_RAID_TEXT_MAX_LENGTH} characters.` }
  }
  const normalizedResponse = readOptionalText(response, PROJECT_RAID_TEXT_MAX_LENGTH)
  if (normalizedResponse === null) {
    return { ok: false, message: `Entry response must be text of at most ${PROJECT_RAID_TEXT_MAX_LENGTH} characters.` }
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
      status,
    },
  }
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
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return undefined
  if (closedAt !== undefined && typeof closedAt !== 'string') return undefined
  const input = parseProjectRaidEntryInput(value)
  if (!input.ok) return undefined
  // Stored and returned entries are already normalized, so a value that normalization would
  // change, such as untrimmed text, is not a valid entry.
  if (
    input.value.title !== value.title ||
    input.value.description !== value.description ||
    input.value.response !== value.response ||
    input.value.reviewDueDate !== value.reviewDueDate
  ) {
    return undefined
  }
  return {
    id,
    ...input.value,
    revision,
    createdAt,
    updatedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
  }
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
  return { teamId: value.teamId, projectId: value.projectId, entries }
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
