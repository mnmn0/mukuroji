import type { CreateManualTriageEntryInput } from '@mukuroji/contracts'

/** Longest title the manual handoff API accepts. */
export const sharedTitleMaxLength = 500

/** Longest body the manual handoff API accepts. */
export const sharedBodyMaxLength = 8_000

/** Longest requester display name the manual handoff API accepts. */
const requesterDisplayNameMaxLength = 300

/** Fallback retention sent with a handoff; the server replaces it with the Team setting. */
const fallbackRetentionDays = 30

/** Routing explanation retained for Triage operators. */
const shareRoutingReason = 'Shared to mukuroji from a device'

/** Content another app shared through the Web Share Target, prepared for the form. */
export type SharedContent = {
  /** Suggested entry title. */
  readonly title: string
  /** Suggested entry body, holding the shared text and link. */
  readonly body: string
}

/** Values the person confirmed in the share form. */
export type ShareHandoffDraft = {
  /** Entry title. */
  readonly title: string
  /** Entry body. */
  readonly body: string
}

/** Retry-stable values fixed once per share form. */
export type ShareHandoffIdentity = {
  /** Source identifier claimed by the handoff. */
  readonly sourceId: string
  /** Fallback retention deadline as an ISO instant. */
  readonly retentionExpiresAt: string
}

/**
 * Reads the `title`, `text`, and `url` fields a share target receives.
 *
 * Every value is treated as plain text. Control characters other than tabs and line breaks
 * are removed, and the result is cut to the API limits.
 *
 * @param searchParams - Query of the share target URL.
 * @returns Suggested title and body, empty when nothing was shared.
 */
export function readSharedContent(searchParams: URLSearchParams): SharedContent {
  const sharedTitle = toSingleLine(sanitize(searchParams.get('title')))
  const text = sanitize(searchParams.get('text')).trim()
  const url = toSingleLine(sanitize(searchParams.get('url')))
  const firstTextLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const title = sharedTitle || toSingleLine(firstTextLine) || url
  const body = [text, url && !text.includes(url) ? url : '']
    .filter(Boolean)
    .join('\n\n')

  return {
    title: truncate(title, sharedTitleMaxLength),
    body: truncate(body, sharedBodyMaxLength),
  }
}

/**
 * Creates the values that must stay the same across retries of one share.
 *
 * @param now - Current time.
 * @param createId - UUID factory.
 * @returns Source identifier and fallback retention deadline.
 */
export function createShareHandoffIdentity(
  now: Date = new Date(),
  createId: () => string = () => globalThis.crypto.randomUUID(),
): ShareHandoffIdentity {
  const retentionExpiresAt = new Date(now)
  retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + fallbackRetentionDays)
  return {
    sourceId: `share:${createId()}`,
    retentionExpiresAt: retentionExpiresAt.toISOString(),
  }
}

/**
 * Builds the manual handoff request for confirmed share content.
 *
 * @param draft - Title and body the person confirmed.
 * @param identity - Retry-stable source and retention values.
 * @param requesterDisplayName - Display name of the person sharing.
 * @returns Manual handoff input with trimmed, bounded values.
 */
export function createShareHandoffInput(
  draft: ShareHandoffDraft,
  identity: ShareHandoffIdentity,
  requesterDisplayName: string,
): CreateManualTriageEntryInput {
  return {
    sourceId: identity.sourceId,
    title: truncate(toSingleLine(draft.title), sharedTitleMaxLength),
    body: truncate(draft.body.trim(), sharedBodyMaxLength),
    requesterDisplayName: truncate(toSingleLine(requesterDisplayName), requesterDisplayNameMaxLength) || 'mukuroji',
    routingReason: shareRoutingReason,
    retentionExpiresAt: identity.retentionExpiresAt,
  }
}

/**
 * Removes control characters except tabs and line breaks, and normalizes line endings.
 *
 * @param value - Raw shared value.
 * @returns Sanitized text, empty for a missing value.
 */
function sanitize(value: string | null): string {
  if (!value) return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/**
 * Collapses whitespace runs, including line breaks, into single spaces.
 *
 * @param value - Text to collapse.
 * @returns Trimmed single-line text.
 */
function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Cuts text to a maximum number of UTF-16 code units without splitting a surrogate pair.
 *
 * @param value - Text to cut.
 * @param maxLength - Maximum length.
 * @returns Text no longer than `maxLength`.
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const end = /[\ud800-\udbff]/.test(value.charAt(maxLength - 1)) ? maxLength - 1 : maxLength
  return value.slice(0, end).trimEnd()
}
