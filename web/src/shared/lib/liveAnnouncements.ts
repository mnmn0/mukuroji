/** Urgency of a screen-reader announcement. */
export type LiveAnnouncementPoliteness = 'polite' | 'assertive'

/**
 * One message queued for screen-reader users.
 */
export interface LiveAnnouncement {
  /** Monotonic identifier that lets the region re-announce an identical message. */
  readonly id: number
  /** Text read by assistive technology. */
  readonly message: string
}

/**
 * Latest announcement per politeness level.
 */
export interface LiveAnnouncementState {
  /** Latest polite announcement, read after the current speech finishes. */
  readonly polite?: LiveAnnouncement
  /** Latest assertive announcement, read immediately. */
  readonly assertive?: LiveAnnouncement
}

/** Window in which a repeated identical announcement is treated as a duplicate. */
const DUPLICATE_ANNOUNCEMENT_WINDOW_MILLISECONDS = 500

let state: LiveAnnouncementState = {}
let nextId = 1
let lastAnnouncedAt: Partial<Record<LiveAnnouncementPoliteness, number>> = {}
let lastSourceKey: Partial<Record<LiveAnnouncementPoliteness, unknown>> = {}
const listeners = new Set<() => void>()

/**
 * Announces a message through the application's persistent live regions.
 *
 * Messages are announced even when the visible feedback element mounts at the same
 * time, which newly inserted live regions do not reliably do. An identical message
 * repeated within half a second is ignored so that duplicate renders stay silent,
 * unless the caller identifies it as coming from a different action.
 *
 * @param message - Text to read; blank text is ignored.
 * @param politeness - `polite` for confirmations, `assertive` for failures.
 * @param now - Current time in milliseconds, injectable for tests.
 * @param sourceKey - Optional identity of the action that produced the message.
 */
export function announce(
  message: string,
  politeness: LiveAnnouncementPoliteness = 'polite',
  now: number = Date.now(),
  sourceKey?: unknown,
): void {
  const text = message.trim()
  if (!text) return
  const previous = state[politeness]
  const previousAt = lastAnnouncedAt[politeness]
  if (
    previous?.message === text &&
    previousAt !== undefined &&
    lastSourceKey[politeness] === sourceKey &&
    now - previousAt < DUPLICATE_ANNOUNCEMENT_WINDOW_MILLISECONDS
  ) {
    return
  }
  state = { ...state, [politeness]: { id: nextId, message: text } }
  nextId += 1
  lastAnnouncedAt = { ...lastAnnouncedAt, [politeness]: now }
  lastSourceKey = { ...lastSourceKey, [politeness]: sourceKey }
  for (const listener of listeners) listener()
}

/**
 * Subscribes to announcement changes.
 *
 * @param listener - Callback invoked after each accepted announcement.
 * @returns A function that removes the listener.
 */
export function subscribeToLiveAnnouncements(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Reads the latest announcement per politeness level.
 *
 * @returns An immutable snapshot that changes identity only when a message is accepted.
 */
export function readLiveAnnouncements(): LiveAnnouncementState {
  return state
}

/**
 * Clears announcements and duplicate tracking.
 *
 * Used by tests to isolate cases.
 */
export function resetLiveAnnouncements(): void {
  state = {}
  lastAnnouncedAt = {}
  lastSourceKey = {}
  for (const listener of listeners) listener()
}
