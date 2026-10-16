import { useEffect, useRef } from 'react'
import type { AppInstallOutcome, AppInstallStatus } from '../lib/pwa/installPrompt'

/** Props of the app install card. */
export type AppInstallCardProps = {
  /** Whether the app can be installed from the page. */
  status: AppInstallStatus
  /** Result of the latest install dialog shown from this card, if any. */
  outcome?: Exclude<AppInstallOutcome, 'unavailable'>
  /** Localized card title. */
  title: string
  /** Localized explanation shown while installation is available. */
  description: string
  /** Localized label of the install button. */
  installLabel: string
  /** Localized label of the install button while the browser dialog is open. */
  pendingLabel: string
  /** Localized message shown after the user accepted the browser dialog. */
  acceptedMessage: string
  /** Localized message shown after the user dismissed the browser dialog. */
  dismissedMessage: string
  /** Localized message shown when the browser could not show its dialog. */
  failedMessage: string
  /** Localized message shown when the app runs installed. */
  installedMessage: string
  /** Shows the browser install dialog. */
  onInstall: () => void
}

/**
 * Offers installing the app from the page, or confirms that it is installed.
 *
 * Renders nothing while the browser offers no in-page install, so unsupported browsers
 * keep using their own install menu. While the browser dialog is open the button stays
 * mounted and focusable but inert; afterwards focus moves to the announced result.
 *
 * @param props - Install status, the latest outcome, localized copy, and the install action.
 * @returns The card, or null when nothing can be offered.
 */
export function AppInstallCard(props: AppInstallCardProps) {
  const { description, installLabel, installedMessage, onInstall, outcome, pendingLabel, status, title } = props
  const resultRef = useRef<HTMLParagraphElement>(null)
  const showsButton = status === 'available' || status === 'prompting'
  // After an accepted dialog the store turns `installed`; keep announcing through that transition.
  const result = showsButton || outcome === undefined
    ? undefined
    : status === 'installed'
      ? installedMessage
      : outcome === 'accepted' ? props.acceptedMessage : outcome === 'failed' ? props.failedMessage : props.dismissedMessage
  // Keyed by the outcome and status, not the translated text, so a language change does not steal focus.
  const resultKey = result === undefined ? undefined : `${outcome}:${status}`

  useEffect(() => {
    // The install button disappears once the dialog closes, so keep focus on the result.
    if (resultKey) resultRef.current?.focus()
  }, [resultKey])

  if (status === 'unavailable' && outcome === undefined) return null
  return (
    <section aria-labelledby="app-install-title" className="workbench-panel flex flex-wrap items-center justify-between gap-3 p-5" data-testid="app-install-card">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]" id="app-install-title">{title}</h2>
        {result ? (
          <p className="mt-1 text-sm text-[var(--workbench-muted)]" ref={resultRef} role="status" tabIndex={-1}>{result}</p>
        ) : (
          <p className="mt-1 text-sm text-[var(--workbench-muted)]">{status === 'installed' ? installedMessage : description}</p>
        )}
      </div>
      {showsButton ? (
        <button
          aria-disabled={status === 'prompting' ? true : undefined}
          className="workbench-button-primary min-h-11 px-4 aria-disabled:opacity-60"
          onClick={status === 'available' ? onInstall : undefined}
          type="button"
        >
          {status === 'prompting' ? pendingLabel : installLabel}
        </button>
      ) : null}
    </section>
  )
}
