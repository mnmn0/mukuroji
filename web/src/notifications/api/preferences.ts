import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { NotificationsApiError } from './errors'

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

const notificationsApiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

const defaultNotificationsApiErrorMessage = 'Unable to complete the notification request.'

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
