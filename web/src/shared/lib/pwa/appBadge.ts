/** Navigator surface used to set the installed app's icon badge. */
export type AppBadgeNavigator = {
  /** Shows a number on the app icon. */
  setAppBadge?: (count?: number) => Promise<void>
  /** Removes the app icon badge. */
  clearAppBadge?: () => Promise<void>
}

/**
 * Shows the unread Inbox count on the installed app's icon, or clears it.
 *
 * The badge carries only a number, so it reveals nothing about the Workspace. Browsers
 * without the Badging API are ignored, and badge failures never affect the page.
 *
 * @param count - Unread count; undefined or zero clears the badge.
 * @param target - Navigator to use; defaults to the page's navigator.
 */
export function syncAppBadge(count: number | undefined, target: AppBadgeNavigator | undefined = readNavigator()): void {
  if (!target) return
  const request = count !== undefined && Number.isSafeInteger(count) && count > 0
    ? target.setAppBadge?.(count)
    : target.clearAppBadge?.()
  request?.catch(() => undefined)
}

/**
 * Reads the page navigator when it exists.
 *
 * @returns The navigator, or undefined outside a browser.
 */
function readNavigator(): AppBadgeNavigator | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator
}
