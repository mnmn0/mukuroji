import type { NotificationMessageLocale } from './notification-messages'

/**
 * Official Slack and GovSlack Incoming Webhook URL. Anything else (other hosts, ports, credentials,
 * query strings, fragments, or path segments) is refused before it is stored or called.
 */
const SLACK_INCOMING_WEBHOOK_URL = /^https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/

/** Longest webhook URL accepted, in characters. */
export const SLACK_INCOMING_WEBHOOK_URL_MAX_LENGTH = 2_048

/** Longest display label of a channel destination, in characters. */
export const NOTIFICATION_CHANNEL_DESTINATION_LABEL_MAX_LENGTH = 80

/**
 * Reports whether a value is an official Slack Incoming Webhook URL.
 *
 * @param value - Candidate URL, as typed or as stored.
 * @returns True only for `https://hooks.slack.com/services/…` or the GovSlack equivalent.
 */
export function isSlackIncomingWebhookUrl(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= SLACK_INCOMING_WEBHOOK_URL_MAX_LENGTH &&
    SLACK_INCOMING_WEBHOOK_URL.test(value.trim())
}

/** Where a shared chat channel destination belongs. */
export type NotificationChannelDestinationScope = 'team' | 'project'

/** Chat services a channel destination can post to. */
export const NOTIFICATION_CHANNEL_DESTINATION_PROVIDERS = ['slack'] as const

/** One chat service a channel destination can post to. */
export type NotificationChannelDestinationProvider = (typeof NOTIFICATION_CHANNEL_DESTINATION_PROVIDERS)[number]

/**
 * Shared chat channel destination of a Team or a Project, as the settings screen reads it. The
 * webhook URL itself is never returned.
 */
export type NotificationChannelDestination = {
  /** Whether the destination belongs to a Team or to one of its Projects. */
  scope: NotificationChannelDestinationScope
  /** Team of the destination, or the Team that owns the Project. */
  teamId: string
  /** Project of the destination; absent for a Team destination. */
  projectId?: string
  /** Whether a webhook is registered. */
  configured: boolean
  /** Chat service of the registered webhook. */
  provider?: NotificationChannelDestinationProvider
  /** Name the manager gave the channel, such as `#proj-alpha`. */
  label?: string
  /** Language the posts are written in. */
  locale: NotificationMessageLocale
  /** When the destination was last saved. */
  updatedAt?: string
  /** Revision a save or delete must name; 0 when nothing is saved. */
  revision: number
  /** Whether the caller may change or test the destination. */
  canManage: boolean
}

/** Body of a save of a Team or Project channel destination. */
export type SaveNotificationChannelDestinationRequest = {
  /**
   * Incoming Webhook URL. Required on the first save; when left out, the stored webhook is kept
   * and only the label and language change.
   */
  webhookUrl?: string
  /** Name of the channel shown on the settings screen; empty clears it. */
  label?: string
  /** Language the posts are written in. */
  locale: NotificationMessageLocale
  /** Revision the caller read; 0 for a first save. */
  expectedRevision: number
}

/** The caller's own Slack destination, as the settings screen reads it. */
export type PersonalSlackDestination = {
  /** Whether a webhook is registered for the caller. */
  configured: boolean
}

/** Body of a save of the caller's own Slack destination. */
export type SavePersonalSlackDestinationRequest = {
  /** Incoming Webhook URL of the caller's own Slack channel. */
  webhookUrl: string
}

/** Why a test message did not reach the destination. */
export const NOTIFICATION_DESTINATION_TEST_FAILURE_CODES = [
  'DestinationNotConfigured',
  'SlackDestinationInvalid',
  'SlackDeliveryRejected',
  'SlackDeliveryUnavailable',
] as const

/** One reason a test message did not reach the destination. */
export type NotificationDestinationTestFailureCode = (typeof NOTIFICATION_DESTINATION_TEST_FAILURE_CODES)[number]

/** Outcome of a test message sent to a registered destination. */
export type NotificationDestinationTestResult = {
  /** Whether the chat service accepted the message. */
  delivered: boolean
  /** Why the message was not accepted. */
  code?: NotificationDestinationTestFailureCode
}

/**
 * Events posted to a Project or Team channel, with the label shown above the post in each
 * language. Other events stay personal notifications.
 */
export const NOTIFICATION_CHANNEL_POST_EVENT_LABELS = {
  'planning-update.published': { en: 'Health update published', ja: 'ヘルス更新の公開' },
  'planning-update.health-degraded': { en: 'Health got worse', ja: 'ヘルスの悪化' },
  'planning-entity.milestone-completed': { en: 'Milestone completed', ja: 'Milestone の完了' },
  'planning-entity.milestone-rescheduled': { en: 'Milestone rescheduled', ja: 'Milestone の日程変更' },
  'work-item.due': { en: 'Due today', ja: '今日が期限' },
  'work-item.overdue': { en: 'Overdue', ja: '期限超過' },
} as const satisfies Record<string, Record<NotificationMessageLocale, string>>

/** Event type posted to a Project or Team channel. */
export type NotificationChannelPostEventType = keyof typeof NOTIFICATION_CHANNEL_POST_EVENT_LABELS

/**
 * Reports whether an event is posted to a Project or Team channel.
 *
 * @param eventType - Audit event type.
 * @returns True for the events listed in {@link NOTIFICATION_CHANNEL_POST_EVENT_LABELS}.
 */
export function isNotificationChannelPostEventType(eventType: string): eventType is NotificationChannelPostEventType {
  return Object.hasOwn(NOTIFICATION_CHANNEL_POST_EVENT_LABELS, eventType)
}
