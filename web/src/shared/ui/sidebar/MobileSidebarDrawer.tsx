import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * MobileSidebarDrawer に渡す props です。
 */
export type MobileSidebarDrawerProps = {
  /**
   * ドロワー内に表示するサイドバー要素です。
   */
  children: ReactNode
  /**
   * 背景クリック用 close button の aria-label です。
   */
  closeLabel: string
  /**
   * ドロワー dialog のアクセシブルネームです。
   */
  dialogLabel: string
  /**
   * ドロワーを表示するかどうかです。
   */
  isOpen: boolean
  /**
   * ドロワーを閉じる callback です。
   */
  onClose: () => void
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * モバイル表示時にサイドバーをモーダルドロワーとして表示します。
 */
export function MobileSidebarDrawer({
  children,
  closeLabel,
  dialogLabel,
  isOpen,
  onClose,
}: MobileSidebarDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null)
  const drawerContentRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isOpen) {
      return undefined
    }

    const previousFocusedElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined
    const drawer = drawerRef.current
    const drawerContent = drawerContentRef.current
    const firstFocusableElement = getFocusableElements(drawerContent)[0]
    const previousBodyOverflow = document.body.style.overflow

    document.body.style.overflow = 'hidden'
    ;(firstFocusableElement ?? drawer)?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      const hasNestedModal = Boolean(
        drawerContent?.querySelector('[role="dialog"][aria-modal="true"]'),
      )

      if (hasNestedModal) {
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') {
        return
      }

      const focusableElements = getFocusableElements(drawerContent)

      if (focusableElements.length === 0) {
        event.preventDefault()
        drawer?.focus()
        return
      }

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]
      const activeElement = document.activeElement

      if (!activeElement || !drawerContent?.contains(activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? lastElement : firstElement).focus()
        return
      }

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault()
        lastElement.focus()
        return
      }

      if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault()
        firstElement.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousBodyOverflow
      previousFocusedElement?.focus()
    }
  }, [isOpen])

  if (!isOpen) {
    return null
  }

  return (
    <div
      aria-label={dialogLabel}
      aria-modal="true"
      className="fixed inset-0 z-50 h-dvh max-h-dvh min-[981px]:hidden"
      ref={drawerRef}
      role="dialog"
      tabIndex={-1}
    >
      <button
        aria-label={closeLabel}
        className="absolute inset-0 bg-slate-950/45"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        className="relative z-10 h-dvh max-h-dvh w-fit max-w-[calc(100vw-32px)]"
        ref={drawerContentRef}
      >
        {children}
      </div>
    </div>
  )
}

function getFocusableElements(container: HTMLElement | null) {
  if (!container) {
    return []
  }

  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.tabIndex !== -1 &&
      (element.offsetWidth > 0 || element.offsetHeight > 0),
  )
}
