import type { AppInstallStatus } from '../lib/pwa/installPrompt'

/** Props of the app install card. */
export type AppInstallCardProps = {
  /** Whether the app can be installed from the page. */
  status: AppInstallStatus
  /** Localized card title. */
  title: string
  /** Localized explanation shown while installation is available. */
  description: string
  /** Localized label of the install button. */
  installLabel: string
  /** Localized message shown when the app runs installed. */
  installedMessage: string
  /** Shows the browser install dialog. */
  onInstall: () => void
}

/**
 * Offers installing the app from the page, or confirms that it is installed.
 *
 * Renders nothing while the browser offers no in-page install, so unsupported browsers
 * keep using their own install menu.
 *
 * @param props - Install status, localized copy, and the install action.
 * @returns The card, or null when nothing can be offered.
 */
export function AppInstallCard({ description, installLabel, installedMessage, onInstall, status, title }: AppInstallCardProps) {
  if (status === 'unavailable') return null
  return (
    <section aria-labelledby="app-install-title" className="workbench-panel flex flex-wrap items-center justify-between gap-3 p-5" data-testid="app-install-card">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]" id="app-install-title">{title}</h2>
        <p className="mt-1 text-sm text-[var(--workbench-muted)]">{status === 'installed' ? installedMessage : description}</p>
      </div>
      {status === 'available' ? (
        <button className="workbench-button-primary min-h-11 px-4" onClick={onInstall} type="button">
          {installLabel}
        </button>
      ) : null}
    </section>
  )
}
