import type { CreateManualTriageEntryInput } from '@mukuroji/contracts'
import type { StoredSharedFields } from '../../../shared/lib/pwa/sharedContentInbox'

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
 * Prepares the `title`, `text`, and `url` fields a share target received for the form.
 *
 * Every value is treated as plain text. Control characters other than tabs and line breaks
 * are removed, and the result is cut to the API limits.
 *
 * @param fields - Shared fields; `undefined` when nothing was shared.
 * @returns Suggested title and body, empty when nothing was shared.
 */
export function readSharedContent(fields: StoredSharedFields | undefined): SharedContent {
  const sharedTitle = toSingleLine(sanitize(fields?.title))
  const text = sanitize(fields?.text).trim()
  const url = toSingleLine(sanitize(fields?.url))
  const firstTextLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const title = sharedTitle || toSingleLine(firstTextLine) || url
  // Only an exact link token counts as already included; a longer URL that merely starts with it does not.
  const link = url && !text.split(/\s+/).includes(url) ? truncate(url, sharedBodyMaxLength) : ''
  // The link is shared on its own, so cut the text to leave room for it instead of cutting the link.
  const linkSpace = link ? link.length + (text ? 2 : 0) : 0
  const body = [truncate(text, Math.max(0, sharedBodyMaxLength - linkSpace)), link]
    .filter(Boolean)
    .join('\n\n')

  return {
    title: truncate(title, sharedTitleMaxLength),
    body,
  }
}

/**
 * Creates the values that must stay the same across retries of one share.
 *
 * A share received through the share target uses its stored ID as the source, so every tab or
 * window that opens it sends the same logical handoff and the server's source claim lets only
 * one entry exist. The fallback retention is rounded to the UTC day for the same reason.
 *
 * @param sharedId - ID of the stored share, or empty when nothing was shared.
 * @param now - Current time.
 * @param createId - UUID factory for a handoff without a stored share.
 * @returns Source identifier and fallback retention deadline.
 */
export function createShareHandoffIdentity(
  sharedId = '',
  now: Date = new Date(),
  createId: () => string = () => globalThis.crypto.randomUUID(),
): ShareHandoffIdentity {
  const retentionExpiresAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + fallbackRetentionDays)
  return {
    sourceId: `share:${sharedId || createId()}`,
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
function sanitize(value: string | undefined): string {
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
