import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  markAllNotificationsRead,
  NotificationsApiError,
  type InboxNotification,
  type NotificationAction,
  type NotificationFilter,
  type NotificationPreferences,
  updateNotification,
  updateNotificationPreferences,
} from '../api'
import {
  createNotificationUnreadCountKey,
  useNotificationUnreadCount,
} from '../queries/useNotificationUnreadCount'
import { useNotificationInboxPages } from '../queries/useNotificationInbox'
import {
  useNotificationPreferencesQuery,
} from '../queries/useNotificationPreferences'

/**
 * 通知未読件数用の共有 SWR key を生成します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @returns 全画面で共有する SWR key です。
 */
/**
 * NotificationInbox が利用する data と action です。
 */
export type NotificationInboxController = {
  /**
   * 読み込み済み通知を cursor 順に重複除外した一覧です。
   */
  notifications: InboxNotification[]
  /**
   * recipient の実未読件数です。
   */
  unreadCount: number
  /**
   * 選択中の通知状態 filter です。
   */
  filter: NotificationFilter
  /**
   * 選択中の event type filter です。
   */
  eventType?: string
  /**
   * 読み込み済み通知から選択できる event type 一覧です。
   */
  availableEventTypes: string[]
  /**
   * 初回 page を読み込み中かどうかです。
   */
  isLoading: boolean
  /**
   * 次 page を読み込み中かどうかです。
   */
  isLoadingMore: boolean
  /**
   * 追加 page があるかどうかです。
   */
  hasMore: boolean
  /**
   * 通知一覧取得に失敗したかどうかです。
   */
  hasLoadError: boolean
  /**
   * 直近の通知 mutation に失敗したかどうかです。
   */
  hasMutationError: boolean
  /** Shell が認証 policy error を一元処理するための raw load/mutation errors です。 */
  sessionErrors?: readonly unknown[]
  /**
   * 実行中 mutation の通知 ID または mark-all 識別子です。
   */
  pendingNotificationId?: string
  /**
   * 通知状態 filter を変更します。
   */
  setFilter: (filter: NotificationFilter) => void
  /**
   * event type filter を変更します。
   */
  setEventType: (eventType?: string) => void
  /**
   * 指定通知を既読にします。
   */
  markRead: (notification: InboxNotification) => Promise<boolean>
  /**
   * 指定通知を未読に戻します。
   */
  markUnread: (notification: InboxNotification) => Promise<boolean>
  /**
   * 指定通知をアーカイブします。
   */
  archive: (notification: InboxNotification) => Promise<boolean>
  /**
   * 指定通知をアーカイブから戻します。
   */
  restore: (notification: InboxNotification) => Promise<boolean>
  /**
   * 指定通知を指定日時まで snooze します。
   */
  snooze: (notification: InboxNotification, snoozedUntil: string) => Promise<boolean>
  /**
   * 現在の recipient の通知をすべて既読にします。
   */
  markAllRead: () => Promise<boolean>
  /**
   * cursor の次 page を読み込みます。
   */
  loadMore: () => Promise<void>
  /**
   * 読み込み済み page を再検証します。
   */
  refresh: () => Promise<void>
}

/**
 * NotificationSettingsPanel が利用する data と action です。
 */
export type NotificationPreferencesController = {
  /**
   * 保存済み通知配信設定です。
   */
  preferences?: NotificationPreferences
  /**
   * 初回設定を読み込み中かどうかです。
   */
  isLoading: boolean
  /**
   * 設定取得に失敗したかどうかです。
   */
  hasLoadError: boolean
  /**
   * 設定を保存中かどうかです。
   */
  isSaving: boolean
  /**
   * 直近の保存に失敗したかどうかです。
   */
  hasSaveError: boolean
  /** Shell が認証 policy error を一元処理するための raw load/mutation errors です。 */
  sessionErrors?: readonly unknown[]
  /**
   * 直近の保存が成功したかどうかです。
   */
  didSave: boolean
  /**
   * 通知配信設定を保存します。
   */
  save: (preferences: NotificationPreferences) => Promise<boolean>
  /**
   * 保存済み設定を再取得します。
   */
  refresh: () => Promise<void>
}

/**
 * 全画面サイドバーで共有する通知未読件数を取得します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @param enabled - 認証確認後に取得を有効にするかどうかです。
 * @returns recipient の実未読件数です。
 */
export function useUnreadNotificationCount(accessToken?: string, enabled = true) {
  const { data } = useNotificationUnreadCount(accessToken, enabled)

  return data ?? 0
}

/**
 * 通知 Inbox の cursor pagination、filter、永続 action を管理します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @param enabled - Inbox 表示中だけ一覧取得を有効にするかどうかです。
 * @returns Inbox 描画用 controller です。
 */
export function useNotificationInbox(
  accessToken?: string,
  enabled = true,
): NotificationInboxController {
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const { mutate: mutateGlobal } = useSWRConfig()
  const [filter, setFilterState] = useState<NotificationFilter>('all')
  const [eventType, setEventTypeState] = useState<string | undefined>()
  const [pendingNotificationId, setPendingNotificationId] = useState<string | undefined>()
  const [mutationError, setMutationError] = useState<unknown>()
  const isConfigured = Boolean(accessToken && enabled)
  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
    setSize,
    size,
  } = useNotificationInboxPages(accessToken, isConfigured, filter, eventType)
  const notifications = useMemo(
    () => mergeNotifications(data?.flatMap((page) => page.notifications) ?? []),
    [data],
  )
  const unreadCount = data?.[0]?.unreadCount ?? 0
  const lastPage = data?.at(-1)
  const isLoadingMore = Boolean(data && data.length < size && isValidating)
  const availableEventTypes = useMemo(
    () => Array.from(new Set(notifications.map((notification) => notification.eventType))).sort(),
    [notifications],
  )

  useEffect(() => {
    if (!accessToken || !data?.[0]) {
      return
    }

    void mutateGlobal(
      createNotificationUnreadCountKey(accessToken),
      data[0].unreadCount,
      { revalidate: false },
    )
  }, [accessToken, data, mutateGlobal])

  const refresh = useCallback(async () => {
    await mutate()

    if (accessToken) {
      await mutateGlobal(createNotificationUnreadCountKey(accessToken))
    }
  }, [accessToken, mutate, mutateGlobal])

  const runNotificationAction = useCallback(async (
    notification: InboxNotification,
    action: NotificationAction,
    snoozedUntil?: string,
  ) => {
    if (!accessToken) {
      return false
    }

    setMutationError(undefined)
    setPendingNotificationId(notification.id)

    try {
      await mutationRunner.run(
        `notification:${action}:${notification.id}`,
        JSON.stringify({ action, snoozedUntil }),
        (context) => updateNotification(
          notification.id,
          accessToken,
          { action, ...(snoozedUntil ? { snoozedUntil } : {}) },
          context,
        ),
      )
      await refresh()
      return true
    } catch (actionError) {
      console.error('Notification action failed:', actionError)
      setMutationError(actionError)

      if (actionError instanceof NotificationsApiError && actionError.status === 409) {
        await refresh().catch(() => undefined)
      }

      return false
    } finally {
      setPendingNotificationId(undefined)
    }
  }, [accessToken, mutationRunner, refresh])

  const markAllRead = useCallback(async () => {
    if (!accessToken) {
      return false
    }

    setMutationError(undefined)
    setPendingNotificationId('mark-all')

    try {
      await mutationRunner.run(
        'notification:mark-all-read',
        String(unreadCount),
        (context) => markAllNotificationsRead(accessToken, context),
      )
      await refresh()
      return true
    } catch (markAllError) {
      console.error('Mark all notifications read failed:', markAllError)
      setMutationError(markAllError)
      return false
    } finally {
      setPendingNotificationId(undefined)
    }
  }, [accessToken, mutationRunner, refresh, unreadCount])

  const setFilter = useCallback((nextFilter: NotificationFilter) => {
    setFilterState(nextFilter)
    setMutationError(undefined)
    void setSize(1)
  }, [setSize])

  const setEventType = useCallback((nextEventType?: string) => {
    setEventTypeState(nextEventType)
    setMutationError(undefined)
    void setSize(1)
  }, [setSize])

  const loadMore = useCallback(async () => {
    if (!lastPage?.nextCursor) {
      return
    }

    await setSize(size + 1)
  }, [lastPage?.nextCursor, setSize, size])

  return {
    archive: (notification) => runNotificationAction(notification, 'archive'),
    availableEventTypes,
    eventType,
    filter,
    hasLoadError: Boolean(error),
    hasMore: Boolean(lastPage?.nextCursor),
    hasMutationError: Boolean(mutationError),
    isLoading,
    isLoadingMore,
    loadMore,
    markAllRead,
    markRead: (notification) => notification.readAt
      ? Promise.resolve(true)
      : runNotificationAction(notification, 'mark-read'),
    markUnread: (notification) => runNotificationAction(notification, 'mark-unread'),
    notifications,
    pendingNotificationId,
    sessionErrors: [error, mutationError],
    refresh,
    restore: (notification) => runNotificationAction(notification, 'restore'),
    setEventType,
    setFilter,
    snooze: (notification, snoozedUntil) =>
      runNotificationAction(notification, 'snooze', snoozedUntil),
    unreadCount,
  }
}

/**
 * recipient の通知配信設定を取得・保存します。
 *
 * @param accessToken - API 認証に使う access token です。
 * @param enabled - 設定画面表示中だけ取得を有効にするかどうかです。
 * @param onSessionError - Reports or clears an error for shared session policy handling.
 * @returns 設定画面描画用 controller です。
 */
export function useNotificationPreferences(
  accessToken?: string,
  enabled = true,
  onSessionError?: (error?: unknown) => void,
): NotificationPreferencesController {
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<unknown>()
  const [didSave, setDidSave] = useState(false)
  const {
    data: preferences,
    error,
    isLoading,
    mutate,
  } = useNotificationPreferencesQuery(accessToken, enabled, onSessionError)

  const save = useCallback(async (nextPreferences: NotificationPreferences) => {
    if (!accessToken) {
      return false
    }

    setDidSave(false)
    setSaveError(undefined)
    setIsSaving(true)

    try {
      const savedPreferences = await mutationRunner.run(
        'notification-preferences:update',
        JSON.stringify(nextPreferences),
        (context) => updateNotificationPreferences(accessToken, nextPreferences, context),
      )

      await mutate(savedPreferences, { revalidate: false })
      onSessionError?.()
      setDidSave(true)
      return true
    } catch (saveError) {
      console.error('Notification preferences update failed:', saveError)
      setSaveError(saveError)
      onSessionError?.(saveError)

      if (saveError instanceof NotificationsApiError && saveError.status === 409) {
        await mutate().catch(() => undefined)
      }

      return false
    } finally {
      setIsSaving(false)
    }
  }, [accessToken, mutate, mutationRunner, onSessionError])

  return {
    didSave,
    hasLoadError: Boolean(error),
    hasSaveError: Boolean(saveError),
    isLoading,
    isSaving,
    preferences,
    refresh: async () => {
      await mutate()
    },
    save,
    sessionErrors: [error, saveError],
  }
}

/**
 * cursor page を跨いだ通知を ID で重複除外します。
 *
 * @param notifications - cursor 順に連結した通知です。
 * @returns 最初に現れた通知を維持した一覧です。
 */
export function mergeNotifications(notifications: InboxNotification[]) {
  return Array.from(
    new Map(notifications.map((notification) => [notification.id, notification])).values(),
  )
}
