import { isCanonicalWorkItemKey } from '@mukuroji/contracts'
import type { NotificationItem } from '../notifications'

/** Absolute links rendered into an external (Slack or Email) notification. */
export type NotificationLinks = {
  /** Absolute URL of the notification's in-app deep link, or the app root when it has none. */
  open: string
  /** Canonical key page of the target Work Item, when the notification carries a key. */
  workItemKey?: {
    /** Canonical Work Item key such as `ABC-123`. */
    key: string
    /** Absolute `/browse/<key>` URL that resolves the key even after the Work Item moves. */
    url: string
  }
}

/**
 * Builds the heading of an external notification, prefixing the Work Item key to the title.
 * @param notification - Delivered notification.
 * @returns `ABC-123 Title`, the title or key alone, or an empty string when neither exists.
 */
export function formatNotificationHeading(
  notification: Pick<NotificationItem, 'title' | 'workItemKey'>,
): string {
  const key = isCanonicalWorkItemKey(notification.workItemKey) ? notification.workItemKey : undefined
  return [key, notification.title?.trim()].filter(Boolean).join(' ')
}

/**
 * Resolves the links of a notification against the application origin, refusing other origins.
 * @param notification - Delivered notification.
 * @param appOrigin - Web application origin.
 * @returns The deep link and, when present, the Work Item key page as absolute URLs.
 */
export function resolveNotificationLinks(
  notification: Pick<NotificationItem, 'deepLink' | 'workItemKey'>,
  appOrigin: string,
): NotificationLinks {
  const origin = new URL(appOrigin).origin
  return {
    open: resolveSameOriginPath(notification.deepLink, origin),
    ...(isCanonicalWorkItemKey(notification.workItemKey)
      ? {
          workItemKey: {
            key: notification.workItemKey,
            url: new URL(`/browse/${encodeURIComponent(notification.workItemKey)}`, origin).href,
          },
        }
      : {}),
  }
}

/**
 * Resolves a stored relative path against the application origin.
 * @param path - Stored relative path.
 * @param origin - Normalized application origin.
 * @returns Absolute URL on the application origin, or the origin root for an unsafe path.
 */
function resolveSameOriginPath(path: string | undefined, origin: string): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return `${origin}/`
  const url = new URL(path, origin)
  return url.origin === origin ? url.href : `${origin}/`
}
