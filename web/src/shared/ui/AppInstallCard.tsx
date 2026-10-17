import { useEffect, useRef, useState } from 'react'
import type { AppBadgePermissionResult } from '../lib/pwa/badgePermission'
import { resolveAppInstallAnnouncement, type AppInstallOutcome, type AppInstallStatus } from '../lib/pwa/installPrompt'

/** Opt-in for allowing notifications so the installed app's icon can show its badge. */
export type AppBadgePermissionSectionProps = {
  /** Whether the opt-in button can be shown now. */
  offered: boolean
  /** Whether the browser permission dialog is open. */
  pending: boolean
  /** Whether notifications are denied right now; shows the blocked guidance without announcing it. */
  blocked?: boolean
  /** Answer from the latest request made from this card, if any. */
  result?: AppBadgePermissionResult
  /** Localized explanation of why the badge needs notification permission. */
  description: string
  /** Localized label of the opt-in button. */
  actionLabel: string
  /** Localized label of the opt-in button while the permission dialog is open. */
  pendingLabel: string
  /** Localized message shown after the user allowed notifications. */
  grantedMessage: string
  /** Localized message shown after the user blocked notifications. */
  deniedMessage: string
  /** Localized message shown when the dialog closed without a choice. */
  dismissedMessage: string
  /** Localized message shown when the browser could not ask for permission. */
  unsupportedMessage: string
  /** Asks for notification permission; called only from the button's click. */
  onRequest: () => void
}

/** Props of the app install card. */
export type AppInstallCardProps = {
  /** Whether the app can be installed from the page. */
  status: AppInstallStatus
  /** Result of the latest install dialog shown from this card, if any; reset it when Install is pressed again. */
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
  /** Badge permission opt-in shown inside the installed app, if any. */
  badgePermission?: AppBadgePermissionSectionProps
}

/**
 * Offers installing the app from the page, or confirms that it is installed.
 *
 * Renders nothing while the browser offers no in-page install, so unsupported browsers
 * keep using their own install menu. While the browser dialog is open the button stays
 * mounted and focusable but inert; afterwards focus moves to the announced result.
 * Inside the installed app the card can also offer allowing notifications so the icon
 * badge appears; that request is made only when the user presses its button.
 *
 * @param props - Install status, the latest outcome, localized copy, and the install action.
 * @returns The card, or null when nothing can be offered.
 */
export function AppInstallCard(props: AppInstallCardProps) {
  const { description, installLabel, installedMessage, onInstall, outcome, pendingLabel, status, title } = props
  const resultRef = useRef<HTMLParagraphElement>(null)
  const showsButton = status === 'available' || status === 'prompting'
  // Remember the status at mount, so an install from the browser menu is announced while an
  // app that already runs installed is not.
  const [initialStatus] = useState(status)
  const announcement = resolveAppInstallAnnouncement({ initialStatus, status, ...(outcome ? { outcome } : {}) })
  const result = announcement === undefined
    ? undefined
    : announcement === 'installed'
      ? installedMessage
      : announcement === 'accepted' ? props.acceptedMessage : announcement === 'failed' ? props.failedMessage : props.dismissedMessage
  // Keyed by the outcome and the announcement, not the translated text or the raw status, so a
  // language change or a fresh install offer after a dismissal does not move focus again.
  const resultKey = result === undefined ? undefined : `${outcome}:${announcement}`

  useEffect(() => {
    // The install button disappears once the dialog closes, so keep focus on the result.
    if (resultKey) resultRef.current?.focus()
  }, [resultKey])

  const badgePermission = props.badgePermission
  const showsBadgePermission = badgePermission !== undefined
    && (badgePermission.offered || badgePermission.blocked === true || badgePermission.result !== undefined)
  if (status === 'unavailable' && outcome === undefined && !showsBadgePermission) return null
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
      {showsBadgePermission ? <AppBadgePermissionSection {...badgePermission} /> : null}
    </section>
  )
}

/**
 * Offers allowing notifications for the app badge and announces the answer.
 *
 * While the permission dialog is open the button stays mounted and focusable but inert.
 * Once the answer is known, focus moves to the announced result, because the button
 * disappears after a grant or a block. A block that already existed when the page loaded is
 * shown as static guidance, without a live region or a focus move.
 *
 * @param props - Opt-in state, localized copy, and the request action.
 * @returns The opt-in row.
 */
function AppBadgePermissionSection(props: AppBadgePermissionSectionProps) {
  const { actionLabel, description, offered, onRequest, pending, pendingLabel, result } = props
  const resultRef = useRef<HTMLParagraphElement>(null)
  const message = result === undefined
    ? undefined
    : result === 'granted'
      ? props.grantedMessage
      : result === 'denied' ? props.deniedMessage : result === 'dismissed' ? props.dismissedMessage : props.unsupportedMessage

  useEffect(() => {
    // Keyed by the result, not the translated text, so a language change does not steal focus.
    if (result) resultRef.current?.focus()
  }, [result])

  return (
    <div className="flex basis-full flex-wrap items-center justify-between gap-3 border-t border-[var(--workbench-border)] pt-3" data-testid="app-badge-permission">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--workbench-muted)]">{description}</p>
        {message ? (
          <p className="mt-1 text-sm text-[var(--workbench-text)]" ref={resultRef} role="status" tabIndex={-1}>{message}</p>
        ) : props.blocked ? (
          // A block found on load is guidance, not news: shown without a live region or focus move.
          <p className="mt-1 text-sm text-[var(--workbench-text)]">{props.deniedMessage}</p>
        ) : null}
      </div>
      {offered ? (
        <button
          aria-disabled={pending ? true : undefined}
          className="workbench-button-secondary min-h-11 px-4 aria-disabled:opacity-60"
          onClick={pending ? undefined : onRequest}
          type="button"
        >
          {pending ? pendingLabel : actionLabel}
        </button>
      ) : null}
    </div>
  )
}
