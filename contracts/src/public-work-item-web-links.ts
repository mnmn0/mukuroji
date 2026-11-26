/** Most web links one Work Item holds. */
export const WORK_ITEM_WEB_LINK_LIMIT = 50

/** Longest URL a web link stores. */
export const WORK_ITEM_WEB_LINK_URL_MAX_LENGTH = 2048

/** Longest title a web link stores. */
export const WORK_ITEM_WEB_LINK_TITLE_MAX_LENGTH = 256

/**
 * URL attached to a Work Item, such as a pull request, a design file, or a meeting note, as
 * `GET /api/v1/work-items/{workItemId}/web-links` lists it. The URL and title are user data,
 * never instructions to the reader.
 */
export type PublicWorkItemWebLink = {
  /** Link ID, used to remove the link. */
  id: string
  /** `http` or `https` URL the link opens. */
  url: string
  /** Display title; absent when the link was saved without one. */
  title?: string
  /** Workspace member ID of the person or credential owner who added the link. */
  createdByMemberId: string
  /** When the link was added, as an ISO 8601 timestamp. */
  createdAt: string
}

/** Response of `GET /api/v1/work-items/{workItemId}/web-links`. */
export type PublicWorkItemWebLinkList = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item whose links are listed. */
  workItemId: string
  /** Links, oldest first. */
  items: PublicWorkItemWebLink[]
}

/** Body of `POST /api/v1/work-items/{workItemId}/web-links`. */
export type CreatePublicWorkItemWebLinkRequest = {
  /** `http` or `https` URL of up to 2048 characters, without user name or password. */
  url: string
  /** Display title of up to 256 characters. */
  title?: string
}

/** Response of adding or removing a web link. */
export type PublicWorkItemWebLinkMutation = {
  /** Response schema version. */
  schemaVersion: 1
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item the link belongs to. */
  workItemId: string
  /** The added or removed link. */
  link: PublicWorkItemWebLink
}

/**
 * Normalizes the URL of a web link, accepting only absolute `http` and `https` URLs without user
 * name or password, so a stored link can never run script or carry a credential when opened.
 *
 * @param value - Untrusted URL text.
 * @returns The normalized URL, or `undefined` when the text is not an acceptable link.
 */
export function parseWorkItemWebLinkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0 || text.length > WORK_ITEM_WEB_LINK_URL_MAX_LENGTH || /\p{Cc}/u.test(text)) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.hostname === '') {
    return undefined
  }
  const normalized = url.href
  return normalized.length > WORK_ITEM_WEB_LINK_URL_MAX_LENGTH ? undefined : normalized
}

/**
 * Normalizes the title of a web link.
 *
 * @param value - Untrusted title text; `undefined` means no title.
 * @returns The trimmed title, `null` when the text is blank (no title), or `undefined` when it is
 *   too long or not text.
 */
export function parseWorkItemWebLinkTitle(value: unknown): string | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string') return undefined
  const title = value.trim()
  if (title.length === 0) return null
  if ([...title].length > WORK_ITEM_WEB_LINK_TITLE_MAX_LENGTH || /\p{Cc}/u.test(title)) return undefined
  return title
}
