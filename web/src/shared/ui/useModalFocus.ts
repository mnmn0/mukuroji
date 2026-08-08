import { useEffect, useRef, type RefObject } from 'react'

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Modal を開いた要素への focus 復元を含む focus lifecycle を開始します。
 *
 * @param container - Focus を閉じ込める modal container です。
 * @param onClose - Escape が押されたときに modal を閉じる callback です。
 * @returns Listener を解除し、modal を開いた要素へ focus を戻す cleanup です。
 */
export function activateModalFocus(
  container: HTMLElement | null,
  onClose: () => void,
): () => void {
  if (!container || typeof document === 'undefined') {
    return () => undefined
  }

  const previouslyFocused = isFocusable(document.activeElement)
    ? document.activeElement
    : undefined
  const initialFocus = container.querySelector<HTMLElement>(
    '[data-modal-initial-focus]:not([disabled])',
  ) ?? getFocusableElements(container)[0] ?? container

  initialFocus.focus()

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const focusable = getFocusableElements(container)
    const first = focusable[0]
    const last = focusable.at(-1)

    if (!first || !last) {
      event.preventDefault()
      container.focus()
      return
    }

    const activeElement = document.activeElement
    const focusIsOutside = !activeElement || !container.contains(activeElement)
    if (event.shiftKey && (activeElement === first || focusIsOutside)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (activeElement === last || focusIsOutside)) {
      event.preventDefault()
      first.focus()
    }
  }

  document.addEventListener('keydown', handleKeyDown)

  return () => {
    document.removeEventListener('keydown', handleKeyDown)
    if (previouslyFocused?.isConnected !== false) {
      previouslyFocused?.focus()
    }
  }
}

/**
 * Modal の初期 focus、Tab trap、Escape close、focus 復元を適用します。
 *
 * @param onClose - Escape が押されたときに modal を閉じる callback です。
 * @returns `role="dialog"` を持つ modal container に設定する ref です。
 */
export function useModalFocus<TElement extends HTMLElement>(
  onClose: () => void,
): RefObject<TElement | null> {
  const containerRef = useRef<TElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(
    () => activateModalFocus(
      containerRef.current,
      () => onCloseRef.current(),
    ),
    [],
  )

  return containerRef
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
}

function isFocusable(element: Element | null): element is HTMLElement {
  return Boolean(element && 'focus' in element)
}
