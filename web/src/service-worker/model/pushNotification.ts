import type { PushNotificationPayload } from '@mukuroji/contracts'

/** Path opened when a push names no usable target. */
export const defaultNotificationPath = '/inbox'

/** Title shown when a push arrives without a usable one; browsers require a notification. */
export const defaultNotificationTitle = 'mukuroji'

/** Icon shown with every push notification. */
export const notificationIconPath = '/pwa-192x192.png'

/** Longest title kept; longer ones are truncated. */
const maxTitleLength = 120

/** Longest body kept; longer ones are truncated. */
const maxBodyLength = 400

/** Notification fields the worker shows, with a same-origin target path. */
export type PushNotificationDisplay = {
  /** Title. */
  title: string
  /** Body text, when present. */
  body?: string
  /** Same-origin path opened on click. */
  path: string
  /** Replacement tag, when present. */
  tag?: string
}

/**
 * Reads a push message into a notification the worker can always show.
 *
 * Browsers require a visible notification for every push, so malformed or empty messages still
 * produce a generic one that opens the Inbox. Paths that are not same-origin application paths
 * are replaced, so a push can never open another site.
 *
 * @param data - Parsed push message, or `undefined` when it had no JSON body.
 * @returns Notification fields.
 */
export function readPushNotification(data: unknown): PushNotificationDisplay {
  const title = readText(readField(data, 'title'), maxTitleLength) ?? defaultNotificationTitle
  const body = readText(readField(data, 'body'), maxBodyLength)
  const tagValue = readField(data, 'tag')
  const tag = typeof tagValue === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(tagValue) ? tagValue : undefined
  return {
    title,
    ...(body ? { body } : {}),
    path: readNotificationPath(readField(data, 'path')),
    ...(tag ? { tag } : {}),
  }
}

/**
 * Reads the target path stored on a shown notification, falling back to the Inbox.
 *
 * @param data - Notification `data`, as stored by the worker.
 * @returns A same-origin application path.
 */
export function readNotificationClickPath(data: unknown): string {
  return readNotificationPath(readField(data, 'path'))
}

/**
 * Reads one payload field from an untrusted object.
 *
 * @param data - Untrusted value.
 * @param key - Payload field name.
 * @returns The field value, or `undefined` when `data` is not an object or lacks it.
 */
function readField(data: unknown, key: keyof PushNotificationPayload): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !Object.hasOwn(data, key)) return undefined
  return Reflect.get(data, key)
}

/**
 * Accepts only same-origin single-slash application paths without control characters or
 * backslashes, mirroring the app's deep-link check, which the worker cannot import.
 *
 * @param value - Untrusted path.
 * @returns The path, or the Inbox path when it is unsafe.
 */
export function readNotificationPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    })
  ) {
    return defaultNotificationPath
  }
  try {
    return new URL(value, 'https://mukuroji.invalid').origin === 'https://mukuroji.invalid' ? value : defaultNotificationPath
  } catch {
    return defaultNotificationPath
  }
}

/**
 * Picks the open app window to reuse for a notification click: a focused one first.
 *
 * @param clients - Open windows with their URL and focus state.
 * @param origin - Worker origin.
 * @returns The window to reuse, or `undefined` to open a new one.
 */
export function selectNotificationClient<Client extends { url: string, focused: boolean }>(
  clients: readonly Client[],
  origin: string,
): Client | undefined {
  const sameOrigin = clients.filter((client) => {
    try {
      return new URL(client.url).origin === origin
    } catch {
      return false
    }
  })
  return sameOrigin.find((client) => client.focused) ?? sameOrigin[0]
}

/**
 * Trims text and truncates it to a maximum length.
 *
 * @param value - Untrusted value.
 * @param maxLength - Maximum length in code points.
 * @returns The text, or `undefined` when it is not a non-empty string.
 */
function readText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  const characters = [...text]
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join('')}…` : text
}
