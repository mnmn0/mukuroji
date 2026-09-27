import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { isSafeApplicationPath } from '../../../shared/routing/applicationPath'
import { createAiActivityStore } from '../model/aiActivity'
import { createAiActivityOrigin } from '../model/aiActivityOrigin'
import { AiActivityContext, useAiActivity } from '../queries/aiActivityContext'
import { useAiActivityClock } from '../queries/useAiActivityClock'
import { AiActivityBoard } from './AiActivityBoard'

/** Props for the authentication-keyed activity lifetime. */
export type AiActivityProviderProps = {
  /** Workspace shell and assistants within this session. */
  children: ReactNode
  /** Locale for the global board. */
  locale: Locale
  /** Stable workspace target when the original launcher disappears. */
  fallbackFocusRef: RefObject<HTMLElement | null>
}

/**
 * Owns session metadata and overlays the board without unmounting active work.
 * @param props - Workspace content and display locale.
 * @returns Session-scoped metadata context and an optional native modal.
 */
export function AiActivityProvider({ children, locale, fallbackFocusRef }: AiActivityProviderProps) {
  const [store] = useState(() => createAiActivityStore())
  const [isOpen, setIsOpen] = useState(false)
  const location = useLocation()
  const openBoard = useCallback(() => setIsOpen(true), [])
  const closeBoard = useCallback(() => setIsOpen(false), [])
  const origin = createAiActivityOrigin(location.pathname, location.search)
  const value = useMemo(() => ({ store, origin, openBoard }), [store, origin, openBoard])
  return (
    <AiActivityContext.Provider value={value}>
      {children}
      {isOpen ? <AiActivityDialog fallbackFocusRef={fallbackFocusRef} locale={locale} onClose={closeBoard} /> : null}
    </AiActivityContext.Provider>
  )
}

/** Inputs for the native activity modal. */
type AiActivityDialogProps = {
  /** Locale for timestamps and labels. */
  locale: Locale
  /** Closes the modal without changing the source view. */
  onClose: () => void
  /** Stable workspace target when the original launcher disappears. */
  fallbackFocusRef: RefObject<HTMLElement | null>
}

/** Presents the board with native focus trapping, Escape, and focus restoration. */
function AiActivityDialog({ locale, onClose, fallbackFocusRef }: AiActivityDialogProps) {
  const { context, activities } = useAiActivity()
  const now = useAiActivityClock(activities)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const navigate = useNavigate()
  const t = createTranslator(locale)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && previousFocus.getClientRects().length > 0) previousFocus.focus()
      else fallbackFocusRef.current?.focus()
    }
  }, [fallbackFocusRef])
  return (
    <dialog
      aria-label={t('ai.activity.title')}
      className="fixed inset-0 m-auto h-[min(900px,calc(100svh_-_48px))] max-h-none w-[min(1440px,calc(100%_-_48px))] max-w-none overflow-hidden rounded-lg border border-[var(--workbench-border)] p-0 shadow-xl backdrop:bg-black/30 max-[759px]:h-svh max-[759px]:w-full max-[759px]:rounded-none"
      onCancel={onClose}
      ref={dialogRef}
    >
      <AiActivityBoard
        activities={activities}
        locale={locale}
        now={now}
        onClearHistory={context?.store.clearHistory}
        onClose={onClose}
        onOpenOrigin={(origin) => {
          if (!isSafeApplicationPath(origin)) return
          onClose()
          if (origin !== context?.origin) void navigate(origin)
        }}
        t={t}
      />
    </dialog>
  )
}
