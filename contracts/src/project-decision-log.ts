import { parseProjectRaidEntry, type ProjectRaidEntry } from './project-raid-log'

/** Whether a recorded decision still holds. */
export type ProjectDecisionStatus = 'active' | 'superseded' | 'withdrawn'

/** Every decision status in display order. */
export const PROJECT_DECISION_STATUSES: readonly ProjectDecisionStatus[] = ['active', 'superseded', 'withdrawn']

/**
 * Screen or integration a decision was recorded from. `slack` is set only by the Slack message
 * shortcut, never by a request body (ADR 0114).
 */
export type ProjectDecisionOrigin = 'project' | 'work-item' | 'document' | 'slack'

/** Origins a Mukuroji screen may send in a request body. */
export const PROJECT_DECISION_CLIENT_ORIGINS: readonly ProjectDecisionOrigin[] = ['project', 'work-item', 'document']

/** Maximum length of a decision title. */
export const PROJECT_DECISION_TITLE_MAX_LENGTH = 200
/** Maximum length of the decision content and of its rationale. */
export const PROJECT_DECISION_TEXT_MAX_LENGTH = 2_000
/** Maximum length of the note naming deciders outside the Project, such as a customer. */
export const PROJECT_DECISION_DECIDER_NOTE_MAX_LENGTH = 200
/** Most Project members one decision may name as deciders. */
export const PROJECT_DECISION_DECIDERS_MAX = 10
/** Longest decider member key, the longest email address a member key can be. */
export const PROJECT_DECISION_MEMBER_ID_MAX_LENGTH = 254
/** Most Work Items one decision may name as related. */
export const PROJECT_DECISION_RELATED_WORK_ITEMS_MAX = 10
/** Longest Work Item ID a decision may name as related. */
export const PROJECT_DECISION_WORK_ITEM_ID_MAX_LENGTH = 128
/** Most source links, such as a Slack thread, minutes, an issue, or an ADR, one decision may keep. */
export const PROJECT_DECISION_SOURCES_MAX = 5
/** Longest source URL. */
export const PROJECT_DECISION_SOURCE_URL_MAX_LENGTH = 1_000
/** Longest source label. */
export const PROJECT_DECISION_SOURCE_LABEL_MAX_LENGTH = 200
/** Longest entry ID a decision may name as the one replacing it. */
export const PROJECT_DECISION_ENTRY_ID_MAX_LENGTH = 64
/**
 * Most decisions one Project log may hold. An entry at every field limit is about 14,600
 * characters, recorder included; JSON escapes a quote or backslash to two bytes, and the Lambda response wraps the
 * JSON body in another JSON string, so each such character can take four bytes. 100 entries stay
 * below the 6 MB Lambda response limit even then (ADR 0114).
 */
export const PROJECT_DECISION_LOG_MAX_ENTRIES = 100
/** Most items the Team decision log returns in one response, newest decision first. */
export const TEAM_DECISION_LOG_MAX_ITEMS = 100
/** Longest keyword the Team decision log filters by. */
export const TEAM_DECISION_LOG_QUERY_MAX_LENGTH = 100

/**
 * UTC ISO 8601 timestamp, such as `2026-11-20T08:00:00.000Z`, split into date and time parts.
 * Fractions stop at milliseconds, the precision timestamps are stored and compared at.
 */
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/u
/** Control characters other than tab, line feed, and carriage return. */
// eslint-disable-next-line no-control-regex -- these control characters are what the check rejects.
const DISALLOWED_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
/** A UTF-16 surrogate without its pair, which JSON escapes to six bytes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** Characters a source URL may hold: printable ASCII without spaces. */
const URL_CHARACTERS = /^[\x21-\x7E]+$/u

/** Link to where a decision was made or written down. */
export type ProjectDecisionSource = {
  /** Absolute `https` or `http` URL. */
  url: string
  /** Short text shown instead of the URL. */
  label?: string
}

/** Editable fields of a decision, as a client sends them. */
export type ProjectDecisionEntryInput = {
  /** Short summary of what was decided. */
  title: string
  /** What was decided. */
  content: string
  /** Why it was decided. */
  rationale?: string
  /** Project members who made the decision. */
  deciderMemberIds?: string[]
  /** Deciders outside the Project, such as a customer, as free text. */
  deciderNote?: string
  /** When the decision was made, as a UTC ISO timestamp. */
  decidedAt: string
  /** Work Items of the Project the decision concerns. */
  relatedWorkItemIds?: string[]
  /** Where the decision was made or written down, such as a Slack thread, minutes, or an ADR. */
  sources?: ProjectDecisionSource[]
  /** Whether the decision still holds. */
  status: ProjectDecisionStatus
  /** Decision of the same log that replaces this one; only a superseded decision names it. */
  supersededByEntryId?: string
  /** Screen the decision was recorded from. */
  origin: ProjectDecisionOrigin
}

/** One recorded decision of a Project. */
export type ProjectDecisionEntry = ProjectDecisionEntryInput & {
  /** Entry ID. */
  id: string
  /** Member who recorded the decision. */
  recordedByMemberId: string
  /** Revision, starting at 1, that guards concurrent edits. */
  revision: number
  /** ISO timestamp the decision was recorded. */
  createdAt: string
  /** ISO timestamp of the last change. */
  updatedAt: string
}

/** Decision log actions the requesting member may take. */
export type ProjectDecisionLogViewerCapabilities = {
  /** Whether the member may record and edit decisions. */
  canEdit: boolean
}

/** Response of the Project decision log read endpoint. */
export type ProjectDecisionLogResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the log belongs to. */
  projectId: string
  /** Decisions, newest decision first. */
  entries: ProjectDecisionEntry[]
  /** What the requesting member may do. */
  viewer: ProjectDecisionLogViewerCapabilities
}

/** Response of the decision create and update endpoints. */
export type ProjectDecisionEntryResponse = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the log belongs to. */
  projectId: string
  /** The stored decision. */
  entry: ProjectDecisionEntry
}

/** One row of the Team decision log, from the decision log or from a decided change request. */
export type TeamDecisionLogItem =
  | {
      /** A decision recorded in a Project decision log. */
      kind: 'decision'
      /** Project the decision belongs to. */
      projectId: string
      /** When the decision was made. */
      decidedAt: string
      /** The decision. */
      entry: ProjectDecisionEntry
    }
  | {
      /** A change request approved or rejected in the Project risk, issue, and change request log. */
      kind: 'change-request'
      /** Project the change request belongs to. */
      projectId: string
      /** When the change request was decided. */
      decidedAt: string
      /** The decided change request. */
      entry: ProjectRaidEntry
    }

/** Response of the Team decision log read endpoint. */
export type TeamDecisionLogResponse = {
  /** Team whose Projects were read. */
  teamId: string
  /** Matching items the caller may see, newest decision first. */
  items: TeamDecisionLogItem[]
  /** Whether more items matched than {@link TEAM_DECISION_LOG_MAX_ITEMS}. */
  truncated: boolean
}

/** Result of validating untrusted decision input. */
export type ProjectDecisionEntryInputParseResult =
  | {
      /** The input is valid. */
      ok: true
      /** Normalized input. */
      value: ProjectDecisionEntryInput
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
 * Checks whether a value is a decision status.
 *
 * @param value - Value to check.
 * @returns Whether the value is a known status.
 */
export function isProjectDecisionStatus(value: unknown): value is ProjectDecisionStatus {
  return value === 'active' || value === 'superseded' || value === 'withdrawn'
}

/**
 * Checks whether a value is a decision origin.
 *
 * @param value - Value to check.
 * @returns Whether the value is a known origin.
 */
export function isProjectDecisionOrigin(value: unknown): value is ProjectDecisionOrigin {
  return value === 'project' || value === 'work-item' || value === 'document' || value === 'slack'
}

/**
 * Checks whether a value is a real UTC timestamp in ISO 8601.
 *
 * @param value - Value to check.
 * @returns Whether the value is a valid timestamp string.
 */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = TIMESTAMP_PATTERN.exec(value)
  if (!match) return false
  const [, date, hours, minutes, seconds] = match
  const day = new Date(`${date}T00:00:00.000Z`)
  return !Number.isNaN(day.getTime()) &&
    day.toISOString().slice(0, 10) === date &&
    Number(hours) < 24 && Number(minutes) < 60 && Number(seconds) < 60
}

/**
 * Checks whether text holds only characters that keep its JSON size close to its length.
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
 * Reads a list of IDs, trimming each one and dropping repeats.
 *
 * @param value - Raw field value.
 * @param maxItems - Most IDs allowed.
 * @param maxLength - Longest ID allowed.
 * @returns The IDs in the order given, `undefined` when absent or empty, or `null` when invalid.
 */
function readIds(value: unknown, maxItems: number, maxLength: number): string[] | undefined | null {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const item of value) {
    const id = readOptionalText(item, maxLength)
    if (id === undefined || id === null) return null
    if (ids.includes(id)) continue
    ids.push(id)
    if (ids.length > maxItems) return null
  }
  return ids.length === 0 ? undefined : ids
}

/**
 * Normalizes a source URL, accepting only absolute `https` and `http` URLs without credentials.
 *
 * @param value - Raw URL.
 * @returns The URL as given after trimming, or `undefined` when it is not allowed.
 */
export function normalizeProjectDecisionSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0 || text.length > PROJECT_DECISION_SOURCE_URL_MAX_LENGTH || !URL_CHARACTERS.test(text)) return undefined
  // Without `//` a browser resolves `https:host/path` against the current page, so only the
  // authority form is a link to another site.
  if (!/^https?:\/\//iu.test(text)) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  // A link with credentials would keep a secret in the log and in every copy of it.
  if (url.username !== '' || url.password !== '') return undefined
  return text
}

/**
 * Reads the source links of a decision, dropping repeated URLs.
 *
 * @param value - Raw field value.
 * @returns The sources in the order given, `undefined` when absent or empty, or `null` when invalid.
 */
function readSources(value: unknown): ProjectDecisionSource[] | undefined | null {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  const sources: ProjectDecisionSource[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const url = normalizeProjectDecisionSourceUrl(item.url)
    if (url === undefined) return null
    const label = readOptionalText(item.label, PROJECT_DECISION_SOURCE_LABEL_MAX_LENGTH)
    if (label === null) return null
    if (sources.some((source) => source.url === url)) continue
    sources.push({ url, ...(label === undefined ? {} : { label }) })
    if (sources.length > PROJECT_DECISION_SOURCES_MAX) return null
  }
  return sources.length === 0 ? undefined : sources
}

/**
 * Validates and normalizes untrusted decision input.
 *
 * @param value - Untrusted input, usually the `entry` field of a request body.
 * @returns The normalized input or the first problem found.
 */
export function parseProjectDecisionEntryInput(value: unknown): ProjectDecisionEntryInputParseResult {
  if (!isRecord(value)) return { ok: false, message: 'Decision must be an object.' }
  const title = readOptionalText(value.title, PROJECT_DECISION_TITLE_MAX_LENGTH)
  if (title === undefined || title === null) {
    return { ok: false, message: `Decision title is required and must be at most ${PROJECT_DECISION_TITLE_MAX_LENGTH} characters without control characters.` }
  }
  const content = readOptionalText(value.content, PROJECT_DECISION_TEXT_MAX_LENGTH)
  if (content === undefined || content === null) {
    return { ok: false, message: `Decision content is required and must be at most ${PROJECT_DECISION_TEXT_MAX_LENGTH} characters without control characters.` }
  }
  const rationale = readOptionalText(value.rationale, PROJECT_DECISION_TEXT_MAX_LENGTH)
  if (rationale === null) {
    return { ok: false, message: `Decision rationale must be at most ${PROJECT_DECISION_TEXT_MAX_LENGTH} characters without control characters.` }
  }
  const deciderMemberIds = readIds(value.deciderMemberIds, PROJECT_DECISION_DECIDERS_MAX, PROJECT_DECISION_MEMBER_ID_MAX_LENGTH)
  if (deciderMemberIds === null) {
    return { ok: false, message: `Deciders must be a list of at most ${PROJECT_DECISION_DECIDERS_MAX} member IDs.` }
  }
  const deciderNote = readOptionalText(value.deciderNote, PROJECT_DECISION_DECIDER_NOTE_MAX_LENGTH)
  if (deciderNote === null) {
    return { ok: false, message: `Decider note must be at most ${PROJECT_DECISION_DECIDER_NOTE_MAX_LENGTH} characters without control characters.` }
  }
  if (!isTimestamp(value.decidedAt)) return { ok: false, message: 'decidedAt must be a UTC ISO 8601 timestamp.' }
  const relatedWorkItemIds = readIds(value.relatedWorkItemIds, PROJECT_DECISION_RELATED_WORK_ITEMS_MAX, PROJECT_DECISION_WORK_ITEM_ID_MAX_LENGTH)
  if (relatedWorkItemIds === null) {
    return { ok: false, message: `Related Work Items must be a list of at most ${PROJECT_DECISION_RELATED_WORK_ITEMS_MAX} Work Item IDs.` }
  }
  const sources = readSources(value.sources)
  if (sources === null) {
    return { ok: false, message: `Sources must be at most ${PROJECT_DECISION_SOURCES_MAX} https or http links of at most ${PROJECT_DECISION_SOURCE_URL_MAX_LENGTH} characters without credentials.` }
  }
  if (!isProjectDecisionStatus(value.status)) return { ok: false, message: 'Decision status must be active, superseded, or withdrawn.' }
  const supersededByEntryId = readOptionalText(value.supersededByEntryId, PROJECT_DECISION_ENTRY_ID_MAX_LENGTH)
  if (supersededByEntryId === null) return { ok: false, message: 'supersededByEntryId must be a decision ID.' }
  if (supersededByEntryId !== undefined && value.status !== 'superseded') {
    return { ok: false, message: 'Only a superseded decision names the decision replacing it.' }
  }
  if (!isProjectDecisionOrigin(value.origin)) return { ok: false, message: 'Decision origin must be project, work-item, document, or slack.' }
  return {
    ok: true,
    value: {
      title,
      content,
      ...(rationale === undefined ? {} : { rationale }),
      ...(deciderMemberIds === undefined ? {} : { deciderMemberIds }),
      ...(deciderNote === undefined ? {} : { deciderNote }),
      // One representation keeps stored timestamps comparable however the client wrote them.
      decidedAt: new Date(value.decidedAt).toISOString(),
      ...(relatedWorkItemIds === undefined ? {} : { relatedWorkItemIds }),
      ...(sources === undefined ? {} : { sources }),
      status: value.status,
      ...(supersededByEntryId === undefined ? {} : { supersededByEntryId }),
      origin: value.origin,
    },
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
 * Tells whether stored sources equal their normalized form.
 *
 * @param normalized - Normalized sources, or `undefined` when there are none.
 * @param raw - Sources as stored or received.
 * @returns Whether both hold the same links in the same order, with no other fields.
 */
function sameSources(normalized: readonly ProjectDecisionSource[] | undefined, raw: unknown) {
  if (normalized === undefined) return raw === undefined
  return Array.isArray(raw) && raw.length === normalized.length && normalized.every((source, index) => {
    const item: unknown = raw[index]
    return isRecord(item) &&
      Object.keys(item).every((key) => key === 'url' || key === 'label') &&
      item.url === source.url &&
      item.label === source.label
  })
}

/**
 * Validates a stored or received decision.
 *
 * @param value - Untrusted decision, such as a stored row or an API response item.
 * @returns The decision, or `undefined` when any field is malformed.
 */
export function parseProjectDecisionEntry(value: unknown): ProjectDecisionEntry | undefined {
  if (!isRecord(value)) return undefined
  const { id, recordedByMemberId, revision, createdAt, updatedAt } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > PROJECT_DECISION_ENTRY_ID_MAX_LENGTH) return undefined
  if (
    typeof recordedByMemberId !== 'string' ||
    recordedByMemberId.length === 0 ||
    recordedByMemberId.length > PROJECT_DECISION_MEMBER_ID_MAX_LENGTH
  ) {
    return undefined
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return undefined
  const input = parseProjectDecisionEntryInput(value)
  if (!input.ok) return undefined
  // Stored and returned decisions are already normalized, so a value normalization would change
  // is not a valid decision.
  if (
    input.value.title !== value.title ||
    input.value.content !== value.content ||
    input.value.decidedAt !== value.decidedAt ||
    input.value.rationale !== value.rationale ||
    input.value.deciderNote !== value.deciderNote ||
    input.value.supersededByEntryId !== value.supersededByEntryId ||
    !sameIds(input.value.deciderMemberIds, value.deciderMemberIds) ||
    !sameIds(input.value.relatedWorkItemIds, value.relatedWorkItemIds) ||
    !sameSources(input.value.sources, value.sources)
  ) {
    return undefined
  }
  return { id, ...input.value, recordedByMemberId, revision, createdAt, updatedAt }
}

/**
 * Sorts decisions newest decision first, breaking ties by recording time and ID.
 *
 * @param left - One decision.
 * @param right - The other decision.
 * @returns The sort order.
 */
export function compareProjectDecisionEntries(left: ProjectDecisionEntry, right: ProjectDecisionEntry): number {
  return compareTimestampsNewestFirst(left.decidedAt, right.decidedAt) ||
    compareTimestampsNewestFirst(left.createdAt, right.createdAt) ||
    left.id.localeCompare(right.id)
}

/**
 * Orders two ISO timestamps newest first by the instant they name, so timestamps written with
 * different fractional-second precision still sort chronologically.
 *
 * @param left - One timestamp.
 * @param right - The other timestamp.
 * @returns A negative number when `left` is newer, positive when older, and 0 when equal.
 */
export function compareTimestampsNewestFirst(left: string, right: string): number {
  return Date.parse(right) - Date.parse(left)
}

/**
 * Validates a Project decision log read response.
 *
 * @param value - Untrusted response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseProjectDecisionLogResponse(value: unknown): ProjectDecisionLogResponse | undefined {
  if (!isRecord(value) || typeof value.teamId !== 'string' || typeof value.projectId !== 'string') return undefined
  if (!Array.isArray(value.entries) || !isRecord(value.viewer) || typeof value.viewer.canEdit !== 'boolean') return undefined
  const entries: ProjectDecisionEntry[] = []
  for (const item of value.entries) {
    const entry = parseProjectDecisionEntry(item)
    if (!entry) return undefined
    entries.push(entry)
  }
  return { teamId: value.teamId, projectId: value.projectId, entries, viewer: { canEdit: value.viewer.canEdit } }
}

/**
 * Validates a decision create or update response.
 *
 * @param value - Untrusted response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseProjectDecisionEntryResponse(value: unknown): ProjectDecisionEntryResponse | undefined {
  if (!isRecord(value) || typeof value.teamId !== 'string' || typeof value.projectId !== 'string') return undefined
  const entry = parseProjectDecisionEntry(value.entry)
  return entry ? { teamId: value.teamId, projectId: value.projectId, entry } : undefined
}

/**
 * Validates one Team decision log item.
 *
 * @param value - Untrusted item.
 * @returns The item, or `undefined` when malformed.
 */
function parseTeamDecisionLogItem(value: unknown): TeamDecisionLogItem | undefined {
  if (!isRecord(value) || typeof value.projectId !== 'string' || !isTimestamp(value.decidedAt)) return undefined
  if (value.kind === 'decision') {
    const entry = parseProjectDecisionEntry(value.entry)
    return entry ? { kind: 'decision', projectId: value.projectId, decidedAt: value.decidedAt, entry } : undefined
  }
  if (value.kind === 'change-request') {
    const entry = parseProjectRaidEntry(value.entry)
    return entry?.decision ? { kind: 'change-request', projectId: value.projectId, decidedAt: value.decidedAt, entry } : undefined
  }
  return undefined
}

/**
 * Validates a Team decision log read response.
 *
 * @param value - Untrusted response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseTeamDecisionLogResponse(value: unknown): TeamDecisionLogResponse | undefined {
  if (!isRecord(value) || typeof value.teamId !== 'string' || typeof value.truncated !== 'boolean') return undefined
  if (!Array.isArray(value.items)) return undefined
  const items: TeamDecisionLogItem[] = []
  for (const raw of value.items) {
    const item = parseTeamDecisionLogItem(raw)
    if (!item) return undefined
    items.push(item)
  }
  return { teamId: value.teamId, items, truncated: value.truncated }
}

/**
 * Tells whether a decision or decided change request matches a keyword, ignoring case.
 *
 * @param item - Team decision log item.
 * @param keyword - Trimmed keyword; an empty keyword matches everything.
 * @returns Whether the title or any free text contains the keyword.
 */
export function teamDecisionLogItemMatches(item: TeamDecisionLogItem, keyword: string): boolean {
  if (keyword.length === 0) return true
  const needle = keyword.toLocaleLowerCase()
  const texts = item.kind === 'decision'
    ? [item.entry.title, item.entry.content, item.entry.rationale, item.entry.deciderNote]
    : [item.entry.title, item.entry.description, item.entry.response]
  return texts.some((text) => text?.toLocaleLowerCase().includes(needle) === true)
}
