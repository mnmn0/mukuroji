import type { KeyboardEvent } from 'react'

/**
 * Keeps keyboard focus within an open Developer Platform dialog.
 *
 * @param event - Keyboard event dispatched by the dialog root.
 * @returns Nothing.
 */
export function trapDialogFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return
  const focusable = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.hasAttribute('hidden'))
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) {
    event.preventDefault()
    return
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
