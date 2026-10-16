import { useState } from 'react'
import { refreshAppBadge, type AppBadgeNavigator } from './appBadge'

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
 * Decides whether the settings page offers allowing notifications for the app badge.
 *
 * iOS and iPadOS Home Screen apps expose the Badging API but show the badge only after
 * notification permission is granted. The opt-in is offered only inside the installed app,
 * only where both the Badging API and `Notification` exist, and only while the user has not
 * answered yet, so it never re-asks after a grant or a block.
 *
 * @param environment - Standalone display, navigator, and Notification API.
 * @returns Whether the opt-in button can be shown.
 */
export function canRequestAppBadgePermission(environment: AppBadgePermissionEnvironment): boolean {
  const { navigator, notification, standalone } = environment
  return standalone
    && typeof navigator?.setAppBadge === 'function'
    && notification !== undefined
    && typeof notification.requestPermission === 'function'
    && notification.permission === 'default'
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

/**
 * Reads the running page's badge permission capabilities.
 *
 * @returns The environment, with nothing available outside a browser.
 */
export function readAppBadgePermissionEnvironment(): AppBadgePermissionEnvironment {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { standalone: false, navigator: undefined, notification: undefined }
  }
  // iOS Safari also reports Home Screen apps through the non-standard `navigator.standalone`.
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true
    || Reflect.get(navigator, 'standalone') === true
  return {
    standalone,
    navigator,
    notification: typeof Notification === 'undefined' ? undefined : Notification,
  }
}

/** Badge permission opt-in state for the settings install card. */
export type AppBadgePermissionState = {
  /** Whether the opt-in button can be shown now. */
  offered: boolean
  /** Whether the browser permission dialog is open. */
  pending: boolean
  /** Answer from the latest request made on this page, if any. */
  result?: AppBadgePermissionResult
  /** Asks for permission; call only from a user action such as a click. */
  request: () => void
}

/**
 * Tracks the badge permission opt-in. Permission is requested only through `request`,
 * never automatically.
 *
 * @param readEnvironment - Reads the browser capabilities; defaults to the running page.
 * @returns Whether the opt-in is offered, the latest result, and the request action.
 */
export function useAppBadgePermission(
  readEnvironment: () => AppBadgePermissionEnvironment = readAppBadgePermissionEnvironment,
): AppBadgePermissionState {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<AppBadgePermissionResult>()
  const environment = readEnvironment()
  return {
    offered: canRequestAppBadgePermission(environment),
    pending,
    ...(result ? { result } : {}),
    request: () => {
      if (pending) return
      setPending(true)
      void requestAppBadgePermission(environment.notification, refreshAppBadge).then((answer) => {
        setResult(answer)
        setPending(false)
      })
    },
  }
}
