import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { NotificationsApiError } from './errors'

/** Notification row に永続化される状態です。 */
export type NotificationState = 'unread' | 'read' | 'archived' | 'snoozed'

/**
 * Inbox API が受け付ける通知状態 filter です。
 */
export type NotificationFilter = 'all' | NotificationState

/**
 * 通知に対して実行できる永続化 action です。
 */
export type NotificationAction =
  | 'mark-read'
  | 'mark-unread'
  | 'archive'
  | 'restore'
  | 'snooze'

/**
 * Inbox に表示するユーザー別通知です。
 */
export type InboxNotification = {
  /**
   * 通知を識別する安定 ID です。
   */
  id: string
  /**
   * 通知元 event の種別です。
   */
  eventType: string
  /**
   * 同じ event がこの recipient に届いた理由です。
   */
  reasons: string[]
  /**
   * event を発生させた actor の表示名です。
   */
  actorLabel?: string
  /**
   * 通知対象の Work Item などのタイトルです。
   */
  title?: string
  /**
   * 通知内容を補足する安全な要約です。
   */
  summary?: string
  /**
   * 通知対象へ遷移するアプリ内 path です。
   */
  deepLink?: string
  /**
   * 通知対象を所有する Team ID です。
   */
  teamId?: string
  /**
   * 通知対象が割り当てられた Project ID です。
   */
  projectId?: string
  /**
   * 通知対象の canonical Work Item ID です。
   */
  issueId?: string
  /**
   * 通知対象の comment ID です。
   */
  commentId?: string
  /**
   * reply が属する root comment ID です。
   */
  rootCommentId?: string
  /**
   * 通知元 event の発生日時です。
   */
  occurredAt: string
  /**
   * read/archive/snooze を統合した現在状態です。
   */
  state: NotificationState
  /**
   * 既読になった日時です。
   */
  readAt?: string
  /**
   * アーカイブした日時です。
   */
  archivedAt?: string
  /**
   * 通知を再表示する日時です。
   */
  snoozedUntil?: string
}

/**
 * 通知一覧取得 API の cursor page です。
 */
export type NotificationPage = {
  /**
   * page に含まれる通知です。
   */
  notifications: InboxNotification[]
  /**
   * 次 page を取得する opaque cursor です。
   */
  nextCursor?: string
  /**
   * 現在の recipient の実未読件数です。
   */
  unreadCount: number
}

/**
 * 通知一覧 API の取得条件です。
 */
export type GetNotificationsOptions = {
  /**
   * 通知状態 filter です。
   */
  filter?: NotificationFilter
  /**
   * event type の完全一致 filter です。
   */
  type?: string
  /**
   * 1 page の最大件数です。
   */
  limit?: number
  /**
   * API が返した opaque cursor です。
   */
  cursor?: string
}

/**
 * 通知状態更新 API の入力です。
 */
export type UpdateNotificationInput = {
  /**
   * 実行する通知 action です。
   */
  action: NotificationAction
  /**
   * snooze action で指定する再表示日時です。
   */
  snoozedUntil?: string
}

/** すべて既読 mutation の結果です。 */
export type MarkAllNotificationsReadResponse = {
  /** 今回 read に更新できた通知数です。 */
  updatedCount: number
  /** Mutation 後に現在権限で表示できる未読数です。 */
  unreadCount: number
}

const notificationsApiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

const defaultNotificationsApiErrorMessage = 'Unable to complete the notification request.'

/**
 * recipient の通知を cursor 付きで取得します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @param options - filter、type、pagination 条件です。
 * @returns 通知 page と実未読件数です。
 */
export function getNotifications(
  accessToken: string,
  options: GetNotificationsOptions = {},
) {
  const query = new URLSearchParams()

  query.set('filter', options.filter ?? 'all')
  if (options.type) {
    query.set('type', options.type)
  }
  if (options.limit !== undefined) {
    query.set('limit', String(options.limit))
  }
  if (options.cursor) {
    query.set('cursor', options.cursor)
  }

  return requestJson<NotificationPage>(
    `${notificationsApiBaseUrl}/notifications?${query.toString()}`,
    accessToken,
  )
}

/**
 * recipient の実未読件数だけを取得します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @returns 実未読件数です。
 */
export async function getNotificationUnreadCount(accessToken: string) {
  const response = await requestJson<{ unreadCount: number }>(
    `${notificationsApiBaseUrl}/notifications/unread-count`,
    accessToken,
  )

  return response.unreadCount
}

/**
 * 1件の通知状態を更新します。
 *
 * @param notificationId - 更新対象の通知 ID です。
 * @param accessToken - API 認証に使う access token です。
 * @param input - 実行する action と任意の snooze 日時です。
 * @param mutationContext - retry 間で共有する mutation context です。
 * @returns 更新後の通知です。
 */
export function updateNotification(
  notificationId: string,
  accessToken: string,
  input: UpdateNotificationInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<InboxNotification>(
    `${notificationsApiBaseUrl}/notifications/${encodeURIComponent(notificationId)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PATCH',
    },
  )
}

/**
 * 現在表示対象の通知をすべて既読にします。
 *
 * @param accessToken - API 認証に使う access token です。
 * @param mutationContext - retry 間で共有する mutation context です。
 */
export function markAllNotificationsRead(
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<MarkAllNotificationsReadResponse>(
    `${notificationsApiBaseUrl}/notifications/mark-all-read`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )
}

async function requestJson<TResponse>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const error = readApiError(data)

    throw new NotificationsApiError(response.status, error.message, error.code)
  }

  return data as TResponse
}

function readApiError(data: unknown) {
  const message = typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string' &&
    data.message.trim().length > 0
    ? data.message
    : defaultNotificationsApiErrorMessage
  const code = typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : undefined

  return { code, message }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
