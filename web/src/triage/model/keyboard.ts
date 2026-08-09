import type { TriageEntryCapabilities } from '../api'

/** Action form that may be opened by a keyboard shortcut. */
export type TriageActionMode =
  | 'accept'
  | 'duplicate'
  | 'decline'
  | 'request-information'
  | 'snooze'

/**
 * Resolves the next queue row index for supported navigation keys.
 *
 * @param currentIndex - Index of the row currently receiving keyboard input.
 * @param key - Browser keyboard event key.
 * @param itemCount - Number of visible rows.
 * @returns The next index, or undefined for unsupported keys or an empty queue.
 */
export function resolveTriageNavigationIndex(
  currentIndex: number,
  key: string,
  itemCount: number,
) {
  if (itemCount <= 0) return undefined
  if (key === 'ArrowDown') return (currentIndex + 1) % itemCount
  if (key === 'ArrowUp') return (currentIndex - 1 + itemCount) % itemCount
  if (key === 'Home') return 0
  if (key === 'End') return itemCount - 1
  return undefined
}

/**
 * Resolves a non-destructive action-form shortcut allowed by server capabilities.
 *
 * @param key - Browser keyboard event key.
 * @param target - Event target used to suppress shortcuts while editing.
 * @param capabilities - Server-computed actions available to the principal.
 * @returns Action form to open, or undefined when the shortcut is unavailable.
 */
export function resolveTriageActionShortcut(
  key: string,
  target: EventTarget | null,
  capabilities: TriageEntryCapabilities,
): TriageActionMode | undefined {
  if (isEditableKeyboardTarget(target)) return undefined
  const normalizedKey = key.toLocaleLowerCase()
  if (normalizedKey === 'a' && (capabilities.canAcceptCreate || capabilities.canAcceptLink)) {
    return 'accept'
  }
  if (normalizedKey === 'd' && capabilities.canMarkDuplicate) return 'duplicate'
  if (normalizedKey === 'x' && capabilities.canDecline) return 'decline'
  if (
    normalizedKey === 'i' &&
    capabilities.canRequestInformation &&
    capabilities.canReply
  ) return 'request-information'
  if (normalizedKey === 's' && capabilities.canSnooze) return 'snooze'
  return undefined
}

/**
 * Checks whether a shortcut target is an editable browser control.
 *
 * @param target - Keyboard event target.
 * @returns Whether single-key triage shortcuts must be suppressed.
 */
export function isEditableKeyboardTarget(target: EventTarget | null) {
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
  )
}
