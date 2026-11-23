import type { InboxNotification, NotificationPreferences } from './api'
import type {
  NotificationInboxController,
  NotificationPreferencesController,
} from './mutations/useNotifications'
import type { TeamReminderSettingsController } from './mutations/useTeamReminderSettings'

/**
 * Storybook と UI test で使う notification-backed Inbox の通知です。
 */
export const notificationFixtures: InboxNotification[] = [
  {
    id: 'notification-mention-1',
    eventId: 'event-comment-mentioned-1',
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
    eventId: 'event-work-item-assigned-1',
    eventType: 'work-item.assigned',
    reasons: ['assignee'],
    actorLabel: '鈴木 大輔',
    title: 'ロードマップの依存リスクを確認',
    workItemKey: 'CORE-42',
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
 * Storybook と UI test で使う、定期配信されたレポートの通知です。
 */
export const reportDeliveryNotificationFixture: InboxNotification = {
  id: 'notification-report-delivered-1',
  eventId: 'event-analytics-report-delivered-1',
  eventType: 'analytics.report.delivered',
  reasons: ['report-recipient'],
  title: '週次ポートフォリオ',
  summary: 'A scheduled report snapshot is ready.',
  deepLink: '/reports?v=1&report=weekly-report&snapshot=snapshot-1',
  occurredAt: '2026-07-13T08:00:12.000Z',
  state: 'unread',
}

/**
 * Storybook と UI test で使う、blocker が解除された Work Item の通知です。
 * Server が保存する英語の概要を持ち、表示では翻訳した概要に置き換わります。
 */
export const blockerClearedNotificationFixture: InboxNotification = {
  id: 'notification-blocker-cleared-1',
  eventId: 'event-blocker-removed-1',
  eventType: 'work-item.blocker-removed',
  reasons: ['assignee', 'watcher'],
  actorLabel: '佐藤 花子',
  title: 'リリース手順を作る',
  summary: 'A blocker was removed.',
  teamId: 'core-team',
  projectId: 'refero',
  issueId: 'release-steps',
  occurredAt: '2026-07-12T03:20:00.000Z',
  state: 'unread',
}

/**
 * Storybook と UI test で使う、概要を message code で持つ期限超過の通知です。
 * 表示言語で文にし、code がなければ保存済みの英語の概要を出します。
 */
export const overdueMessageNotificationFixture: InboxNotification = {
  id: 'notification-overdue-1',
  eventId: 'event-overdue-1',
  eventType: 'work-item.overdue',
  reasons: ['assignee'],
  title: 'リリース手順を作る',
  summary: 'Work Item "リリース手順を作る" is overdue.',
  message: { code: 'work-item.overdue', params: { title: 'リリース手順を作る' } },
  teamId: 'core-team',
  projectId: 'refero',
  issueId: 'release-steps',
  occurredAt: '2026-07-12T03:20:00.000Z',
  state: 'unread',
}

/**
 * Storybook で NotificationInbox を操作可能にする controller fixture です。
 */
export const notificationInboxControllerFixture: NotificationInboxController = {
  archive: async () => true,
  availableEventTypes: notificationFixtures.map((notification) => notification.eventType),
  bulkFailedCount: 0,
  bulkUpdate: async (notifications) => ({
    failedIds: [],
    succeededIds: notifications.map((notification) => notification.id),
  }),
  eventType: undefined,
  filter: 'all',
  hasLoadError: false,
  hasMore: true,
  hasMutationError: false,
  isBulkPending: false,
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

/**
 * Team reminder settings controller fixture for a Team manager in Storybook and tests.
 */
export const teamReminderSettingsControllerFixture: TeamReminderSettingsController = {
  settings: {
    teamId: 'core',
    days: { dueSoonDays: 2, overdueEscalationDays: 14 },
    defaults: {
      dueSoonDays: 3,
      overdueReminderIntervalDays: 7,
      overdueEscalationDays: 7,
      staleStartedDays: 7,
      timesheetReminderDays: 7,
    },
    revision: 3,
    updatedAt: '2026-07-12T00:00:00.000Z',
    canManage: true,
  },
  isLoading: false,
  hasLoadError: false,
  isUnavailable: false,
  isSaving: false,
  sessionErrors: [],
  refresh: async () => undefined,
  save: async () => true,
}
