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

/** Broadcast channel that tells other tabs this page cleared the shared app badge. */
const APP_BADGE_CHANNEL = 'mukuroji-app-badge'

/** Identifies this page so it ignores its own clear notices. */
const pageId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : String(Math.random())

/** Minimal broadcast channel used for app badge notices. */
export type AppBadgeChannel = {
  /** Sends a notice to the other pages. */
  postMessage: (message: unknown) => void
  /** Receives notices from the other pages. */
  onmessage: ((event: MessageEvent) => void) | null
  /** Releases the channel. */
  close: () => void
}

/**
 * Clears the app badge when this page's session ends and tells the other tabs.
 *
 * The OS badge is shared by every window of the installed app, while sessions can live
 * per tab. Other tabs that are still signed in republish their own count on the notice.
 *
 * @param target - Navigator to use; defaults to the page's navigator.
 * @param openChannel - Opens the broadcast channel; defaults to `BroadcastChannel`.
 */
export function clearAppBadgeForEndedSession(
  target: AppBadgeNavigator | undefined = readNavigator(),
  openChannel: () => AppBadgeChannel | undefined = openBroadcastChannel,
): void {
  syncAppBadge(0, target)
  const channel = openChannel()
  if (!channel) return
  try {
    channel.postMessage({ type: 'cleared', pageId })
  } catch {
    // Notices are best effort; a closed or unsupported channel never affects sign-out.
  } finally {
    channel.close()
  }
}

/**
 * Calls the listener when another page cleared the shared app badge.
 *
 * @param listener - Republishes this page's count.
 * @param openChannel - Opens the broadcast channel; defaults to `BroadcastChannel`.
 * @returns Unsubscribe function.
 */
export function subscribeAppBadgeCleared(
  listener: () => void,
  openChannel: () => AppBadgeChannel | undefined = openBroadcastChannel,
): () => void {
  const channel = openChannel()
  if (!channel) return () => undefined
  channel.onmessage = (event) => {
    const message: unknown = event.data
    if (typeof message !== 'object' || message === null) return
    if (Reflect.get(message, 'type') !== 'cleared' || Reflect.get(message, 'pageId') === pageId) return
    listener()
  }
  return () => {
    channel.onmessage = null
    channel.close()
  }
}

/**
 * Chooses what the app badge should show for the current session.
 *
 * @param signedIn - Whether a Workspace session exists.
 * @param loadedCount - Unread count from the latest successful load, if any.
 * @returns The count to show, zero to clear, or undefined to leave the badge unchanged
 * while the count is loading or failed to load.
 */
export function resolveAppBadgeCount(signedIn: boolean, loadedCount: number | undefined): number | undefined {
  return signedIn ? loadedCount : 0
}

/**
 * Reads the page navigator when it exists.
 *
 * @returns The navigator, or undefined outside a browser.
 */
function readNavigator(): AppBadgeNavigator | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator
}

/**
 * Opens the app badge broadcast channel when the browser supports it.
 *
 * @returns The channel, or undefined without `BroadcastChannel`.
 */
function openBroadcastChannel(): AppBadgeChannel | undefined {
  return typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(APP_BADGE_CHANNEL)
}
