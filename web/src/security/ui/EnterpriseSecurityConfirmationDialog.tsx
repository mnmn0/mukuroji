import {
  useEffect,
  useId,
  useRef,
  type RefObject,
} from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createEnterpriseSecurityConfirmationCopy,
  type EnterpriseSecurityConfirmation,
} from '../model/enterpriseSecurityConfirmation'

/**
 * Props for the enterprise security confirmation dialog.
 */
export type EnterpriseSecurityConfirmationDialogProps = {
  /** High-impact operation that requires confirmation. */
  confirmation: EnterpriseSecurityConfirmation
  /** Safe display message from the most recent API failure. */
  errorMessage?: string
  /** Whether the confirmed operation is running. */
  isBusy: boolean
  /** Element that should regain focus after the dialog closes. */
  returnFocusRef: RefObject<HTMLElement | null>
  /** Resolves localized security messages. */
  t: (key: MessageKey) => string
  /** Executes the confirmed operation. */
  onConfirm: () => Promise<void> | void
  /** Requests that the dialog close. */
  onRequestClose: () => void
}

/**
 * Renders a focus-trapped confirmation dialog for high-impact security changes.
 *
 * @param props - Confirmation state, focus target, copy resolver, and actions.
 * @returns The modal confirmation dialog.
 */
export function EnterpriseSecurityConfirmationDialog({
  confirmation,
  errorMessage,
  isBusy,
  returnFocusRef,
  t,
  onConfirm,
  onRequestClose,
}: EnterpriseSecurityConfirmationDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const dialogId = useId()
  const titleId = `${dialogId}-title`
  const descriptionId = `${dialogId}-description`
  const copy = createEnterpriseSecurityConfirmationCopy(confirmation, t)

  useEffect(() => {
    const returnFocusElement = returnFocusRef.current
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()

    return () => {
      window.requestAnimationFrame(() => {
        if (returnFocusElement?.isConnected) {
          returnFocusElement.focus()
        }
      })
    }
  }, [returnFocusRef])

  useEffect(() => {
    /** Handles focus wrapping and Escape dismissal while the dialog is open. */
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const dialog = dialogRef.current

      if (event.key === 'Tab' && dialog) {
        trapEnterpriseSecurityDialogFocus(event, dialog)
        return
      }

      if (event.key === 'Escape' && !isBusy) {
        onRequestClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isBusy, onRequestClose])

  useEffect(() => {
    if (isBusy) {
      dialogRef.current?.focus()
    }
  }, [isBusy])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={() => {
        if (!isBusy) {
          onRequestClose()
        }
      }}
    >
      <section
        aria-busy={isBusy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="workbench-panel w-full max-w-[520px] overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        data-testid="enterprise-security-confirmation"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5">
          <h2
            className="text-xl font-semibold text-[var(--workbench-text)]"
            id={titleId}
          >
            {copy.title}
          </h2>
        </div>
        <div className="p-6">
          <p
            className="text-sm font-medium leading-6 text-[var(--workbench-muted)]"
            id={descriptionId}
          >
            {copy.description}
          </p>
          {errorMessage ? (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700" role="alert">
                {errorMessage}
              </p>
              <p className="mt-1 text-xs font-medium leading-5 text-red-700">
                {t('security.dialog.retryHint')}
              </p>
            </div>
          ) : null}
          <div className="mt-6 flex justify-end gap-3">
            <button
              className="workbench-button-secondary min-h-10 px-4"
              data-autofocus
              disabled={isBusy}
              type="button"
              onClick={onRequestClose}
            >
              {t('security.action.cancel')}
            </button>
            <button
              className={
                copy.destructive
                  ? 'min-h-10 rounded-md border border-red-700 bg-red-700 px-4 text-sm font-semibold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60'
                  : 'workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60'
              }
              disabled={isBusy}
              type="button"
              onClick={() => void onConfirm()}
            >
              {isBusy ? t('security.action.working') : copy.confirmLabel}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

/**
 * Wraps keyboard focus within the currently open confirmation dialog.
 *
 * @param event - Browser Tab key event.
 * @param dialog - Dialog element that owns the focus boundary.
 */
function trapEnterpriseSecurityDialogFocus(
  event: globalThis.KeyboardEvent,
  dialog: HTMLElement,
) {
  const focusableElements = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  )

  if (focusableElements.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements.at(-1)

  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault()
    lastElement?.focus()
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault()
    firstElement?.focus()
  }
}
