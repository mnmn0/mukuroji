import { createMutationHeaders, type MutationRequestContext } from '../api/mutationHeaders'

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

/**
 * 配信チャネルごとの有効状態です。
 */
export type NotificationChannels = {
  /**
   * アプリ内 Inbox へ配信するかどうかです。
   */
  inApp: boolean
  /**
   * email へ配信するかどうかです。
   */
  email: boolean
  /**
   * browser push へ配信するかどうかです。
   */
  push: boolean
}

/**
 * digest または即時配信の頻度です。
 */
export type NotificationFrequency = 'instant' | 'hourly' | 'daily' | 'weekly'

/**
 * 通知を抑制する時間帯設定です。
 */
export type NotificationQuietHours = {
  /**
   * quiet hours を有効にするかどうかです。
   */
  enabled: boolean
  /**
   * 抑制開始時刻を表す `HH:mm` 形式の値です。
   */
  start: string
  /**
   * 抑制終了時刻を表す `HH:mm` 形式の値です。
   */
  end: string
  /**
   * 時刻解釈に使う IANA time zone です。
   */
  timeZone: string
}

/**
 * recipient ごとに保存される通知配信設定です。
 */
export type NotificationPreferences = {
  /**
   * 有効な配信チャネルです。
   */
  channels: NotificationChannels
  /**
   * 配信頻度です。
   */
  frequency: NotificationFrequency
  /**
   * 通知を抑制する時間帯です。
   */
  quietHours: NotificationQuietHours
  /**
   * optimistic concurrency に使う version です。
   */
  version: number
  /**
   * 最終更新日時です。
   */
  updatedAt?: string
}

/**
 * Notification API のエラーレスポンスです。
 */
export class NotificationsApiError extends Error {
  /**
   * HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  /**
   * Notification API error を生成します。
   *
   * @param status - HTTP status code です。
   * @param message - 表示可能な error message です。
   * @param code - API 固有の安定 error code です。
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
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

/**
 * recipient の通知配信設定を取得します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @returns 保存済み通知配信設定です。
 */
export function getNotificationPreferences(accessToken: string) {
  return requestJson<NotificationPreferences>(
    `${notificationsApiBaseUrl}/notification-preferences`,
    accessToken,
  )
}

/**
 * recipient の通知配信設定を保存します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @param preferences - 保存する設定と現在 version です。
 * @param mutationContext - retry 間で共有する mutation context です。
 * @returns 保存後の通知配信設定です。
 */
export function updateNotificationPreferences(
  accessToken: string,
  preferences: NotificationPreferences,
  mutationContext: MutationRequestContext,
) {
  return requestJson<NotificationPreferences>(
    `${notificationsApiBaseUrl}/notification-preferences`,
    accessToken,
    {
      body: JSON.stringify(preferences),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PUT',
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
