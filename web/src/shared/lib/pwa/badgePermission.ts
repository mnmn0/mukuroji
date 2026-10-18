import { useState, useSyncExternalStore } from 'react'
import { refreshAppBadge, type AppBadgeNavigator } from './appBadge'
import { isStandaloneDisplay } from './standaloneDisplay'

/** Notification surface used to ask whether the installed app may show its icon badge. */
export type NotificationPermissionSource = {
  /** Current notification permission, such as `default`, `granted`, or `denied`. */
  readonly permission: string
  /**
   * Shows the browser's notification permission dialog.
   *
   * @returns The permission after the user answered.
   */
  requestPermission: () => Promise<string>
}

/** Browser capabilities that decide whether the badge permission opt-in can be offered. */
export type AppBadgePermissionEnvironment = {
  /** Whether the page runs as an installed standalone app. */
  standalone: boolean
  /**
   * Whether the platform shows the app badge only with notification permission, as iOS and
   * iPadOS Home Screen web apps do; Chromium desktop apps show it without permission.
   */
  badgeRequiresNotificationPermission: boolean
  /** Navigator that may expose the Badging API. */
  navigator: AppBadgeNavigator | undefined
  /** Notification API, when the browser has one. */
  notification: NotificationPermissionSource | undefined
}

/**
 * Result of asking for notification permission to show the app badge; `dismissed` when the
 * dialog closed without a choice, and `unsupported` when the browser could not ask.
 */
export type AppBadgePermissionResult = 'granted' | 'denied' | 'dismissed' | 'unsupported'

/**
 * Decides whether the badge permission matters here at all.
 *
 * iOS and iPadOS Home Screen apps expose the Badging API but show the badge only after
 * notification permission is granted. The permission matters only inside the installed app,
 * only on such a platform, and only where both the Badging API and `Notification` exist.
 * Platforms that show badges without permission, such as Chromium desktop apps, never qualify.
 *
 * @param environment - Standalone display, platform requirement, navigator, and Notification API.
 * @returns Whether the badge depends on notification permission on this page.
 */
function isAppBadgePermissionApplicable(environment: AppBadgePermissionEnvironment): boolean {
  const { badgeRequiresNotificationPermission, navigator, notification, standalone } = environment
  return standalone
    && badgeRequiresNotificationPermission
    && typeof navigator?.setAppBadge === 'function'
    && notification !== undefined
    && typeof notification.requestPermission === 'function'
}

/**
 * Decides whether the settings page offers allowing notifications for the app badge.
 *
 * The opt-in is offered only where the badge depends on notification permission (see
 * `isAppBadgePermissionApplicable`) and only while the user has not answered yet, so it
 * never re-asks after a grant or a block.
 *
 * @param environment - Standalone display, platform requirement, navigator, and Notification API.
 * @returns Whether the opt-in button can be shown.
 */
export function canRequestAppBadgePermission(environment: AppBadgePermissionEnvironment): boolean {
  return isAppBadgePermissionApplicable(environment) && environment.notification?.permission === 'default'
}

/**
 * Decides whether the badge is currently blocked because notifications are denied.
 *
 * Derived from the current permission without asking, so a user who denied it earlier still
 * sees how to enable the badge after a reload. Platforms that do not need the permission
 * never report a block.
 *
 * @param environment - Standalone display, platform requirement, navigator, and Notification API.
 * @returns Whether the card should explain that notifications are blocked.
 */
export function isAppBadgePermissionBlocked(environment: AppBadgePermissionEnvironment): boolean {
  return isAppBadgePermissionApplicable(environment) && environment.notification?.permission === 'denied'
}

/**
 * Asks for notification permission from a user action and refreshes the badge once granted.
 *
 * The browser dialog is requested synchronously, before any await, so it runs inside the
 * click that started it; browsers ignore permission requests made outside a user gesture.
 * The app sends no push notifications; the permission only lets the platform show the badge.
 *
 * @param notification - Notification API to ask; undefined reports `unsupported`.
 * @param refreshBadge - Shows the current unread count again after a grant.
 * @returns The user's answer, or `unsupported` when the browser could not ask; never rejects.
 */
export async function requestAppBadgePermission(
  notification: NotificationPermissionSource | undefined,
  refreshBadge: () => void,
): Promise<AppBadgePermissionResult> {
  if (!notification || typeof notification.requestPermission !== 'function') return 'unsupported'
  let permission: string
  try {
    permission = await notification.requestPermission()
  } catch {
    return 'unsupported'
  }
  if (permission === 'granted') {
    refreshBadge()
    return 'granted'
  }
  if (permission === 'denied') return 'denied'
  if (permission === 'default') return 'dismissed'
  return 'unsupported'
}

/** Navigator details used to recognize platforms whose badge needs notification permission. */
export type BadgePlatformHints = {
  /** Browser user agent. */
  userAgent: string
  /** Legacy platform string; iPadOS reports `MacIntel` with a desktop user agent. */
  platform?: string
  /** Number of touch points; above one on an iPad that requests the desktop site. */
  maxTouchPoints?: number
  /** Whether the navigator has WebKit's non-standard `standalone` property. */
  hasStandaloneProperty: boolean
}

/**
 * Recognizes Apple WebKit, where installed web apps show the badge only after notification
 * permission is granted: iOS and iPadOS Home Screen apps and macOS Safari "Add to Dock" apps.
 *
 * WebKit's `navigator.standalone` property marks iOS and iPadOS Safari; the user agent covers
 * iPhone and iPod, and iPadOS with a desktop user agent is recognized by `MacIntel` with touch.
 * macOS Safari is recognized by its `Version/... Safari/` user agent without a Chromium, Edge,
 * Opera, or Firefox token, so Chromium desktop apps, which badge without permission, are excluded.
 *
 * @param hints - Navigator details.
 * @returns Whether the badge needs notification permission on this platform.
 */
export function isNotificationGatedBadgePlatform(hints: BadgePlatformHints): boolean {
  if (hints.hasStandaloneProperty) return true
  if (/\b(?:iPhone|iPad|iPod)\b/u.test(hints.userAgent)) return true
  if (hints.platform === 'MacIntel' && (hints.maxTouchPoints ?? 0) > 1) return true
  return isMacSafariUserAgent(hints.userAgent)
}

/**
 * Recognizes desktop Safari on macOS from its user agent.
 *
 * @param userAgent - Browser user agent.
 * @returns Whether the user agent is macOS Safari rather than another macOS browser.
 */
function isMacSafariUserAgent(userAgent: string): boolean {
  return /\bMacintosh\b/u.test(userAgent) &&
    /\bVersion\/\d[\d.]*\b.*\bSafari\//u.test(userAgent) &&
    !/\b(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|Firefox|FxiOS)\//u.test(userAgent)
}

/**
 * Reads the running page's badge permission capabilities.
 *
 * @returns The environment, with nothing available outside a browser.
 */
export function readAppBadgePermissionEnvironment(): AppBadgePermissionEnvironment {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { standalone: false, badgeRequiresNotificationPermission: false, navigator: undefined, notification: undefined }
  }
  const standalone = isStandaloneDisplay()
  return {
    standalone,
    badgeRequiresNotificationPermission: isNotificationGatedBadgePlatform({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      hasStandaloneProperty: 'standalone' in navigator,
    }),
    navigator,
    notification: typeof Notification === 'undefined' ? undefined : Notification,
  }
}

/** Badge permission opt-in state for the settings install card. */
export type AppBadgePermissionSnapshot = {
  /** Whether the opt-in button can be shown now; always true while a request is pending. */
  offered: boolean
  /** Whether the browser permission dialog is open. */
  pending: boolean
  /**
   * Whether notifications are currently denied, so the badge cannot appear; read without asking.
   * False while a request is pending, since its answer is announced instead.
   */
  blocked: boolean
  /** Answer from the latest request made on this page, if any and still current. */
  result?: AppBadgePermissionResult
}

/** Badge permission opt-in state and its request action. */
export type AppBadgePermissionState = AppBadgePermissionSnapshot & {
  /** Asks for permission; call only from a user action such as a click. */
  request: () => void
}

/** Badge permission opt-in shared by a settings card and its lifecycle listeners. */
export type AppBadgePermissionStore = {
  /**
   * Subscribes to opt-in changes and starts watching for permission changes made outside the page.
   *
   * @param listener - Called after the snapshot changed.
   * @returns Unsubscribe function that also stops the lifecycle listeners.
   */
  subscribe: (listener: () => void) => () => void
  /**
   * Reads the current opt-in state; the same object until something changes.
   *
   * @returns Current snapshot.
   */
  getSnapshot: () => AppBadgePermissionSnapshot
  /** Asks for permission; call only from a user action such as a click. */
  request: () => void
  /** Re-reads the environment, clearing a result the current permission no longer matches. */
  reconcile: () => void
}

/** Dependencies of the badge permission opt-in store. */
export type AppBadgePermissionStoreOptions = {
  /** Reads the browser capabilities; defaults to the running page. */
  readEnvironment?: () => AppBadgePermissionEnvironment
  /** Watches for permission changes made outside the page; defaults to the page lifecycle. */
  subscribeLifecycle?: (onChange: () => void) => () => void
  /** Shows the current unread count again after a grant; defaults to `refreshAppBadge`. */
  refreshBadge?: () => void
}

/**
 * Creates the badge permission opt-in store. Permission is requested only through `request`.
 *
 * Each request clears the previous answer first, so a repeated answer such as a second
 * dismissal is announced again. A permission changed outside the page, for example in the
 * device settings, is picked up when the page becomes visible or focused again or when the
 * Permissions API reports a change; an answer that no longer matches is cleared, and a
 * permission that became `granted` refreshes the badge.
 *
 * @param options - Environment reader, lifecycle subscription, and badge refresh.
 * @returns The store.
 */
export function createAppBadgePermissionStore(options: AppBadgePermissionStoreOptions = {}): AppBadgePermissionStore {
  const readEnvironment = options.readEnvironment ?? readAppBadgePermissionEnvironment
  const subscribeLifecycle = options.subscribeLifecycle ?? subscribeNotificationPermissionChanges
  const refreshBadge = options.refreshBadge ?? refreshAppBadge
  const listeners = new Set<() => void>()
  let pending = false
  let result: AppBadgePermissionResult | undefined
  /** Permission seen when the result was recorded, or on the latest reconcile. */
  let knownPermission = readEnvironment().notification?.permission
  let snapshot = buildSnapshot()
  let stopLifecycle: (() => void) | undefined

  /**
   * Builds a snapshot from the current environment and request state.
   *
   * @returns New snapshot.
   */
  function buildSnapshot(): AppBadgePermissionSnapshot {
    const environment = readEnvironment()
    // The permission can change before the request settles, for example when a focus or
    // Permissions API event arrives first. Keep the focused control mounted, and its outcome
    // unannounced, until the answer is known.
    return {
      offered: pending || canRequestAppBadgePermission(environment),
      pending,
      blocked: !pending && isAppBadgePermissionBlocked(environment),
      ...(result ? { result } : {}),
    }
  }

  /** Publishes a new snapshot when anything visible changed. */
  function update(): void {
    const next = buildSnapshot()
    if (
      next.offered === snapshot.offered
      && next.pending === snapshot.pending
      && next.blocked === snapshot.blocked
      && next.result === snapshot.result
    ) return
    snapshot = next
    for (const listener of listeners) listener()
  }

  /**
   * Re-reads the environment and clears an answer the current permission no longer matches.
   *
   * A grant made outside the app, for example in device settings after a denial, becomes the
   * announced `granted` result, so the row that may hold focus stays mounted and says so.
   */
  function reconcile(): void {
    const permission = readEnvironment().notification?.permission
    if (permission !== knownPermission) {
      knownPermission = permission
      if (!pending) result = permission === 'granted' ? 'granted' : undefined
      if (permission === 'granted') refreshBadge()
    }
    update()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      stopLifecycle ??= subscribeLifecycle(reconcile)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopLifecycle?.()
          stopLifecycle = undefined
        }
      }
    },
    getSnapshot: () => snapshot,
    request() {
      if (pending) return
      const environment = readEnvironment()
      pending = true
      result = undefined
      // Ask before publishing the state, so the dialog is requested within the user's click.
      const answer = requestAppBadgePermission(environment.notification, refreshBadge)
      update()
      void answer.then((value) => {
        pending = false
        result = value
        knownPermission = readEnvironment().notification?.permission
        update()
      })
    },
    reconcile,
  }
}

/** Page targets watched for permission changes made outside the page. */
export type NotificationPermissionLifecycleTargets = {
  /** Receives `focus` when the page window is focused again. */
  window: EventTarget | undefined
  /** Receives `visibilitychange` when the page becomes visible again. */
  document: EventTarget | undefined
  /** Permissions API, when the browser has one. */
  permissions: { query: (descriptor: { name: 'notifications' }) => Promise<EventTarget> } | undefined
}

/**
 * Calls `onChange` whenever the notification permission may have changed outside the page.
 *
 * Listens for `focus` and `visibilitychange`, because a user who allows notifications in the
 * device settings returns to the app without reloading it, and for the Permissions API
 * `change` event where the browser supports querying `notifications`.
 *
 * @param onChange - Re-reads the permission.
 * @param targets - Page targets; defaults to the running page.
 * @returns Stops listening.
 */
export function subscribeNotificationPermissionChanges(
  onChange: () => void,
  targets: NotificationPermissionLifecycleTargets = readNotificationPermissionLifecycleTargets(),
): () => void {
  let active = true
  let permissionStatus: EventTarget | undefined
  targets.window?.addEventListener('focus', onChange)
  targets.document?.addEventListener('visibilitychange', onChange)
  try {
    targets.permissions?.query({ name: 'notifications' }).then((status) => {
      if (!active) return
      permissionStatus = status
      status.addEventListener('change', onChange)
    }, () => undefined)
  } catch {
    // Browsers that cannot query `notifications` still reconcile on focus and visibility.
  }
  return () => {
    active = false
    targets.window?.removeEventListener('focus', onChange)
    targets.document?.removeEventListener('visibilitychange', onChange)
    permissionStatus?.removeEventListener('change', onChange)
  }
}

/**
 * Reads the running page's lifecycle targets.
 *
 * @returns The window, document, and Permissions API, each absent outside a browser.
 */
function readNotificationPermissionLifecycleTargets(): NotificationPermissionLifecycleTargets {
  const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions
  return {
    window: typeof window === 'undefined' ? undefined : window,
    document: typeof document === 'undefined' ? undefined : document,
    permissions: permissions && typeof permissions.query === 'function'
      ? { query: (descriptor) => permissions.query(descriptor) }
      : undefined,
  }
}

/**
 * Tracks the badge permission opt-in. Permission is requested only through `request`,
 * never automatically.
 *
 * @param options - Environment reader, lifecycle subscription, and badge refresh; defaults to the running page.
 * @returns Whether the opt-in is offered, the latest result, and the request action.
 */
export function useAppBadgePermission(options?: AppBadgePermissionStoreOptions): AppBadgePermissionState {
  const [store] = useState(() => createAppBadgePermissionStore(options))
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { ...snapshot, request: store.request }
}
