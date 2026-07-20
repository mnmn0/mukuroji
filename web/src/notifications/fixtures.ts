import type { InboxNotification, NotificationPreferences } from './api'
import type {
  NotificationInboxController,
  NotificationPreferencesController,
} from './mutations/useNotifications'

/**
 * Storybook と UI test で使う notification-backed Inbox の通知です。
 */
export const notificationFixtures: InboxNotification[] = [
  {
    id: 'notification-mention-1',
    eventType: 'comment.mentioned',
    reasons: ['mention'],
    actorLabel: '佐藤 花子',
    title: 'ログイン導線の文言を確認',
    summary: 'コメントであなたに確認を依頼しました。',
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'wireframe',
    commentId: 'comment-1',
    occurredAt: '2026-07-12T03:20:00.000Z',
    state: 'unread',
  },
  {
    id: 'notification-assignment-1',
    eventType: 'work-item.assigned',
    reasons: ['assignee'],
    actorLabel: '鈴木 大輔',
    title: 'ロードマップの依存リスクを確認',
    summary: 'この Work Item の担当者に設定されました。',
    teamId: 'core-team',
    projectId: 'product-roadmap',
    issueId: 'roadmap-risk',
    occurredAt: '2026-07-11T08:10:00.000Z',
    readAt: '2026-07-11T08:12:00.000Z',
    state: 'read',
  },
  {
    id: 'notification-automation-1',
    eventType: 'automation.failed',
    reasons: ['watcher'],
    title: '週次サマリーの自動処理',
    summary: '外部配信に失敗しました。設定と接続状態を確認してください。',
    teamId: 'core-team',
    occurredAt: '2026-07-09T22:40:00.000Z',
    state: 'unread',
  },
]

/**
 * Storybook で NotificationInbox を操作可能にする controller fixture です。
 */
export const notificationInboxControllerFixture: NotificationInboxController = {
  archive: async () => true,
  availableEventTypes: notificationFixtures.map((notification) => notification.eventType),
  eventType: undefined,
  filter: 'all',
  hasLoadError: false,
  hasMore: true,
  hasMutationError: false,
  isLoading: false,
  isLoadingMore: false,
  loadMore: async () => undefined,
  markAllRead: async () => true,
  markRead: async () => true,
  markUnread: async () => true,
  notifications: notificationFixtures,
  pendingNotificationId: undefined,
  refresh: async () => undefined,
  restore: async () => true,
  setEventType: () => undefined,
  setFilter: () => undefined,
  snooze: async () => true,
  unreadCount: 2,
}

/**
 * Storybook で使う保存済み通知配信設定です。
 */
export const notificationPreferencesFixture: NotificationPreferences = {
  channels: {
    email: true,
    inApp: true,
    push: false,
  },
  frequency: 'instant',
  quietHours: {
    enabled: true,
    end: '08:00',
    start: '22:00',
    timeZone: 'Asia/Tokyo',
  },
  updatedAt: '2026-07-12T01:00:00.000Z',
  version: 3,
}

/**
 * Storybook で通知設定を編集可能にする controller fixture です。
 */
export const notificationPreferencesControllerFixture: NotificationPreferencesController = {
  didSave: false,
  hasLoadError: false,
  hasSaveError: false,
  isLoading: false,
  isSaving: false,
  preferences: notificationPreferencesFixture,
  refresh: async () => undefined,
  save: async () => true,
}
