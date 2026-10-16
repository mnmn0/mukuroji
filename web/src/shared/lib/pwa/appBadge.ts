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
 * Clears the app badge and tells the other tabs, when a session ends or its count reaches zero.
 *
 * The OS badge is shared by every window of the installed app, while sessions can live
 * per tab. Other tabs that are still signed in republish their own count on the notice,
 * which is sent only after the clear settles so their update lands last.
 *
 * @param target - Navigator to use; defaults to the page's navigator.
 * @param openChannel - Opens the broadcast channel; defaults to `BroadcastChannel`.
 * @returns Resolves once the notice was sent; never rejects.
 */
export async function clearAppBadgeAndNotifyTabs(
  target: AppBadgeNavigator | undefined = readNavigator(),
  openChannel: () => AppBadgeChannel | undefined = openBroadcastChannel,
): Promise<void> {
  try {
    await target?.clearAppBadge?.()
  } catch {
    // Badge failures never affect sign-out.
  }
  // A session started on this page while the clear was pending must republish after it, and
  // the broadcast never reaches the page that sent it.
  for (const listener of localClearListeners) listener()
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

/** Listeners on this page that republish after any clear settles, including this page's own. */
const localClearListeners = new Set<() => void>()

/**
 * Calls the listener after any page, this one included, cleared the shared app badge.
 *
 * The listener decides whether its session still applies, so a session that ended with the
 * clear does nothing while one started after it republishes.
 *
 * @param listener - Republishes this page's count.
 * @param openChannel - Opens the broadcast channel; defaults to `BroadcastChannel`.
 * @returns Unsubscribe function.
 */
export function subscribeAppBadgeCleared(
  listener: () => void,
  openChannel: () => AppBadgeChannel | undefined = openBroadcastChannel,
): () => void {
  localClearListeners.add(listener)
  const channel = openChannel()
  if (channel) {
    channel.onmessage = (event) => {
      const message: unknown = event.data
      if (typeof message !== 'object' || message === null) return
      // This page's own clears reach its listeners directly, after the clear settles.
      if (Reflect.get(message, 'type') !== 'cleared' || Reflect.get(message, 'pageId') === pageId) return
      listener()
    }
  }
  return () => {
    localClearListeners.delete(listener)
    if (!channel) return
    channel.onmessage = null
    channel.close()
  }
}

/** Inputs for keeping one tab's positive count on the shared app badge. */
export type KeepAppBadgePublishedOptions = {
  /** Positive unread count this tab last loaded. */
  count: number
  /** Whether this tab's session is still stored; a remembered session may be shared by tabs. */
  isSessionStored: () => boolean
  /** Reloads the unread count; resolves with the fresh count when it is known. */
  refreshCount: () => Promise<unknown>
  /** Shows a count on the badge; defaults to `syncAppBadge`. */
  sync?: (count: number) => void
  /** Subscribes to clear notices; defaults to `subscribeAppBadgeCleared`. */
  subscribeCleared?: (listener: () => void) => () => void
}

/**
 * Shows this tab's count on the shared app badge and republishes it after another clear.
 *
 * Every publication first checks that the session is still stored, so a tab whose shared
 * session was signed out elsewhere never restores the badge. After a clear notice the tab
 * reloads its count; when that reload fails it reapplies the count it already knows, since
 * a same-valued later load would not publish again.
 *
 * @param options - Count, session check, and refresh.
 * @returns Stops publishing; pending reloads are ignored afterwards.
 */
export function keepAppBadgePublished(options: KeepAppBadgePublishedOptions): () => void {
  const sync = options.sync ?? ((count: number) => syncAppBadge(count))
  const subscribeCleared = options.subscribeCleared ?? ((listener: () => void) => subscribeAppBadgeCleared(listener))
  let active = true
  /**
   * Shows a count while this tab is still active and signed in.
   *
   * @param count - Count to show.
   */
  const publish = (count: number) => {
    if (active && options.isSessionStored()) sync(count)
  }
  publish(options.count)
  const unsubscribe = subscribeCleared(() => {
    if (!options.isSessionStored()) return
    options.refreshCount().then(
      (fresh) => publish(typeof fresh === 'number' ? fresh : options.count),
      () => publish(options.count),
    )
  })
  return () => {
    active = false
    unsubscribe()
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

/** What a tab does with the shared app badge for its current count. */
export type AppBadgeAction =
  | {
    /** Leave the badge as it is while the count is loading or failed. */
    kind: 'keep'
  }
  | {
    /** Clear the badge and tell other tabs, so a still-signed-in one can republish its count. */
    kind: 'clear'
  }
  | {
    /** Show a positive count. */
    kind: 'show'
    /** Count to show. */
    count: number
  }

/**
 * Decides how a tab updates the shared app badge.
 *
 * @param signedIn - Whether this tab has a session.
 * @param loadedCount - Unread count from the latest successful load, if any.
 * @returns `keep` while signed out or while the count is unknown, `clear` (telling other tabs)
 * for a loaded zero, or `show` for a positive count.
 */
export function resolveAppBadgeAction(signedIn: boolean, loadedCount: number | undefined): AppBadgeAction {
  // A page without a session leaves the shared badge alone: sign-out already cleared it in
  // clearAuthSession, and a fresh signed-out tab must not clear another tab's count.
  if (!signedIn || loadedCount === undefined) return { kind: 'keep' }
  if (loadedCount <= 0) return { kind: 'clear' }
  return { kind: 'show', count: loadedCount }
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
