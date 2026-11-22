/**
 * Notification categories a member can route to channels, in the order settings screens list
 * them. Every notification belongs to exactly one category.
 */
export const NOTIFICATION_CATEGORIES = [
  'mention',
  'approval',
  'assignment',
  'status',
  'due',
  'comment',
  'planning',
  'reminder',
  'other',
] as const

/** One notification category. */
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/** Channels a category can be turned off for, in the order settings screens list them. */
export const NOTIFICATION_ROUTING_CHANNELS = ['inApp', 'email', 'push', 'slack'] as const

/** One channel a category can be turned off for. */
export type NotificationRoutingChannel = (typeof NOTIFICATION_ROUTING_CHANNELS)[number]

/**
 * Channels a member turned off for each category. A category or channel that is absent follows
 * the member's channel switch; only `false` is stored, because a category cannot turn on a
 * channel the member switched off.
 */
export type NotificationCategoryChannels = Partial<
  Record<NotificationCategory, Partial<Record<NotificationRoutingChannel, false>>>
>

/** Largest number of Projects, and separately of Teams, a member can mute. */
export const NOTIFICATION_MUTES_MAXIMUM = 100

/** Longest Project or Team ID accepted in a mute list. */
export const NOTIFICATION_MUTE_ID_MAX_LENGTH = 128

/**
 * Projects and Teams whose notifications a member does not want delivered. A muted
 * notification is kept in the archived Inbox and goes to no channel.
 */
export type NotificationMutes = {
  /** Muted Project IDs, sorted and unique. */
  projectIds: string[]
  /** Muted Team IDs, sorted and unique. */
  teamIds: string[]
  /** Whether mentions are still delivered from a muted Project or Team. */
  keepMentions: boolean
  /** Whether approval requests are still delivered from a muted Project or Team. */
  keepApprovals: boolean
}

/** Mutes used when a member has saved none. */
export const DEFAULT_NOTIFICATION_MUTES: Readonly<NotificationMutes> = Object.freeze({
  projectIds: [],
  teamIds: [],
  keepMentions: true,
  keepApprovals: true,
})

/** Inbox actions that `POST /api/notifications/bulk` applies to several notifications. */
export const NOTIFICATION_BULK_ACTIONS = ['mark-read', 'mark-unread', 'archive', 'restore'] as const

/** One Inbox action applied in bulk. */
export type NotificationBulkAction = (typeof NOTIFICATION_BULK_ACTIONS)[number]

/** Largest number of notifications one bulk request may change. */
export const NOTIFICATION_BULK_MAXIMUM = 50

/** A notification a bulk request could not change. */
export type NotificationBulkFailure = {
  /** Opaque notification ID from the request. */
  id: string
  /** HTTP status the same change would get as a single request. */
  status: number
  /** Stable error code, such as `NotificationNotFound`. */
  code: string
}
