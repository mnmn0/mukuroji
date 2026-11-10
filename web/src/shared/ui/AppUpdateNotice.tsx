/** Props of the app update notice. */
export type AppUpdateNoticeProps = {
  /** Localized sentence explaining that a new version is ready. */
  message: string
  /** Localized label of the button that reloads into the new version. */
  reloadLabel: string
  /** Localized label of the button that postpones the update. */
  dismissLabel: string
  /** Applies the update; the page reloads once the new version takes control. */
  onReload: () => void
  /** Hides the notice until the next update. */
  onDismiss: () => void
}

/**
 * Non-blocking notice offering to reload into a newly installed app version.
 *
 * It sits above the bottom safe area on phones and in the bottom-right corner on wider screens,
 * and is announced politely so screen reader users hear it without losing their place.
 *
 * @param props - Localized copy and the update actions.
 * @returns The notice element.
 */
export function AppUpdateNotice({
  message,
  reloadLabel,
  dismissLabel,
  onReload,
  onDismiss,
}: AppUpdateNoticeProps) {
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-w-md sm:p-0"
    >
      <div className="workbench-panel flex flex-col gap-3 p-4 shadow-lg sm:flex-row sm:items-center">
        <p className="m-0 flex-1 text-sm leading-6">{message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            className="workbench-button-secondary min-h-11 flex-1 px-3 sm:flex-none"
            onClick={onDismiss}
          >
            {dismissLabel}
          </button>
          <button
            type="button"
            className="workbench-button-primary min-h-11 flex-1 px-3 sm:flex-none"
            onClick={onReload}
          >
            {reloadLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
