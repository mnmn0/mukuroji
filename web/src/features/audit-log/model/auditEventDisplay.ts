import type { AuditEventActorView, AuditValue } from '@mukuroji/contracts'
import type { Locale } from '../../../shared/i18n/i18n'

/** Longest value text shown before it is cut. */
const maxValueLength = 400

/**
 * Formats a before or after value of a field change for display.
 *
 * Strings show as typed, other values as compact JSON; long text is cut with an ellipsis.
 *
 * @param value - Recorded value.
 * @returns Display text.
 */
export function formatAuditValue(value: AuditValue): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maxValueLength ? `${text.slice(0, maxValueLength)}…` : text
}

/**
 * Formats an event time with date, time, and seconds in the member's time zone.
 *
 * @param occurredAt - ISO 8601 instant.
 * @param locale - Display locale.
 * @param timeZone - IANA time zone; undefined uses the browser's.
 * @returns Display text, or the raw value when it is not a valid instant.
 */
export function formatAuditTime(occurredAt: string, locale: Locale, timeZone?: string): string {
  const instant = Date.parse(occurredAt)
  if (Number.isNaN(instant)) return occurredAt
  try {
    return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(instant)
  } catch {
    return occurredAt
  }
}

/**
 * Picks the name to show for an actor: the recorded display name, else the actor ID.
 *
 * @param actor - Actor snapshot.
 * @returns Display name.
 */
export function formatAuditActorName(actor: AuditEventActorView): string {
  return actor.displayName?.trim() || actor.id
}

/**
 * Formats a byte count with a binary unit.
 *
 * @param byteLength - Size in bytes.
 * @returns Text such as `12.3 KB`.
 */
export function formatAuditByteLength(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`
  const units = ['KB', 'MB', 'GB'] as const
  let size = byteLength / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(1)} ${units[unit]}`
}
