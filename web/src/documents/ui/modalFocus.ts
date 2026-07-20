import type { KeyboardEvent } from 'react'

const modalFocusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * Modal container 内の最初の操作可能要素へ focus を移します。
 *
 * @param container - Focus を閉じ込める modal container です。
 */
export function focusFirstModalElement(
  container: HTMLElement | null,
) {
  const first = getModalFocusableElements(container)[0]
  ;(first ?? container)?.focus()
}

/**
 * Tab / Shift+Tab を modal container の先頭と末尾で循環させます。
 *
 * @param event - Modal container で受け取った keyboard event です。
 * @param container - Focus を閉じ込める modal container です。
 */
export function trapModalFocus(
  event: KeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
) {
  if (event.key !== 'Tab' || !container) {
    return
  }

  const focusableElements = getModalFocusableElements(container)
  const first = focusableElements[0]
  const last = focusableElements.at(-1)
  if (!first || !last) {
    event.preventDefault()
    container.focus()
    return
  }

  const activeElement = globalThis.document.activeElement
  if (!container.contains(activeElement)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  } else if (event.shiftKey && activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function getModalFocusableElements(container: HTMLElement | null) {
  if (!container) {
    return []
  }

  return Array.from(
    container.querySelectorAll<HTMLElement>(modalFocusableSelector),
  ).filter(
    (element) =>
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden') !== 'true',
  )
}
