import {
  DEFAULT_NOTIFICATION_MUTES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_MUTES_MAXIMUM,
  NOTIFICATION_MUTE_ID_MAX_LENGTH,
  toNotificationMuteProjectKey,
  NOTIFICATION_ROUTING_CHANNELS,
  type NotificationCategory,
  type NotificationCategoryChannels,
  type NotificationMutes,
  type NotificationRoutingChannel,
} from '@mukuroji/contracts'
import { NotificationError } from './notification-error'

/** The parts of a notification that decide its category and mute scope. */
export type NotificationRoutingSubject = {
  /** Event type, such as `work-item.updated`. */
  eventType: string
  /** Why this recipient was notified. */
  reasons: readonly string[]
  /** Project the notification belongs to, when it has one. */
  projectId?: string
  /** Team the notification belongs to, when it has one. */
  teamId?: string
}

/** The routing settings a member saved, with the channel switches they refine. */
export type NotificationRoutingPreferences = {
  /** The member's channel switches; a category never turns on a channel switched off here. */
  channels: Partial<Record<NotificationRoutingChannel, boolean>>
  /** Channels turned off per category; absent means none. */
  categoryChannels?: NotificationCategoryChannels
  /** Muted Projects and Teams; absent means none. */
  mutes?: NotificationMutes
}

/** How one notification is routed for one member. */
export type NotificationRouting = {
  /** The notification's category. */
  category: NotificationCategory
  /** Whether a mute stopped the notification. */
  muted: boolean
  /** Whether each channel receives the notification. */
  channels: Record<NotificationRoutingChannel, boolean>
}

const reasonCategories: ReadonlyArray<readonly [NotificationCategory, ReadonlySet<string>]> = [
  ['mention', new Set(['mention'])],
  ['approval', new Set(['approval-requested', 'approval-cancelled'])],
  ['assignment', new Set(['assignment', 'contributor', 'triage-assignment', 'workload-assignment'])],
  ['due', new Set([
    'due', 'due-soon', 'overdue', 'overdue-reminder', 'stale', 'schedule-change', 'due-date-change', 'baseline-slip',
  ])],
  ['status', new Set(['status-change', 'archive-change'])],
  ['comment', new Set(['reply'])],
  ['reminder', new Set(['timesheet', 'weekly-report', 'weekly-report-escalation', 'member-access-expiry'])],
]

const dueEventTypes = new Set([
  'work-item.due', 'work-item.due-soon', 'work-item.overdue', 'work-item.overdue-reminder',
  'work-item.overdue-escalation', 'work-item.stale', 'work-item.schedule-cascade-updated',
])

/**
 * Classifies a notification into the one category its routing settings use. The recipient's
 * reasons decide first, in category order, so a mention in a comment is a mention; the event
 * type decides when no reason does.
 *
 * @param subject - Event type and recipient reasons.
 * @returns The notification's category.
 */
export function classifyNotificationCategory(
  subject: Pick<NotificationRoutingSubject, 'eventType' | 'reasons'>,
): NotificationCategory {
  const eventType = subject.eventType.toLowerCase()
  if (eventType.startsWith('approval.')) {
    return subject.reasons.includes('mention') ? 'mention' : 'approval'
  }
  for (const [category, reasons] of reasonCategories) {
    if (subject.reasons.some((reason) => reasons.has(reason))) return category
  }
  if (dueEventTypes.has(eventType)) return 'due'
  if (eventType.startsWith('planning-update.') && eventType !== 'planning-update.commented') return 'planning'
  if (eventType.includes('comment') || eventType.endsWith('.replied')) return 'comment'
  if (eventType.startsWith('timesheet.') || eventType.startsWith('weekly-report.')) return 'reminder'
  if (eventType === 'triage.assigned') return 'assignment'
  if (eventType.startsWith('work-item.')) return 'status'
  return 'other'
}

/**
 * Reports whether a member's mutes stop a notification. Mentions and approval requests pass
 * when the member chose to keep them.
 *
 * @param mutes - The member's mutes.
 * @param subject - The notification's Project and Team.
 * @param category - The notification's category.
 * @returns Whether the notification is muted.
 */
export function isNotificationMuted(
  mutes: NotificationMutes | undefined,
  subject: Pick<NotificationRoutingSubject, 'projectId' | 'teamId'>,
  category: NotificationCategory,
): boolean {
  if (!mutes) return false
  // A Project ID is unique only inside its Team, so a Project mute needs both IDs to match.
  const inMutedScope = (subject.teamId !== undefined && subject.projectId !== undefined &&
    mutes.projectKeys.includes(toNotificationMuteProjectKey(subject.teamId, subject.projectId))) ||
    (subject.teamId !== undefined && mutes.teamIds.includes(subject.teamId))
  if (!inMutedScope) return false
  if (category === 'mention' && mutes.keepMentions) return false
  if (category === 'approval' && mutes.keepApprovals) return false
  return true
}

/**
 * Decides which channels receive one notification for one member. A channel receives it when
 * the member's channel switch is on, its category does not turn that channel off, and no mute
 * stops it.
 *
 * @param preferences - The member's channel switches, category channels, and mutes.
 * @param subject - The notification's event type, reasons, Project, and Team.
 * @returns The category, whether it was muted, and each channel's decision.
 */
export function resolveNotificationRouting(
  preferences: NotificationRoutingPreferences,
  subject: NotificationRoutingSubject,
): NotificationRouting {
  const category = classifyNotificationCategory(subject)
  const muted = isNotificationMuted(preferences.mutes, subject, category)
  const overrides = preferences.categoryChannels?.[category]
  const receives = (channel: NotificationRoutingChannel) =>
    !muted && preferences.channels[channel] === true && overrides?.[channel] !== false
  return {
    category,
    muted,
    channels: { inApp: receives('inApp'), email: receives('email'), push: receives('push'), slack: receives('slack') },
  }
}

/**
 * Validates category channel settings from a request or a stored row. Only channels turned off
 * are kept; `true` and `null` mean "follow the channel switch".
 *
 * @param value - Untrusted category channel settings.
 * @returns Settings that keep only the channels turned off.
 * @throws NotificationError (400) for an unknown category or channel, or a non-boolean value.
 */
export function normalizeNotificationCategoryChannels(value: unknown): NotificationCategoryChannels {
  if (!isPlainRecord(value)) {
    throw invalidRouting('Category channels must be an object.')
  }
  const categories = new Set<string>(NOTIFICATION_CATEGORIES)
  const channels = new Set<string>(NOTIFICATION_ROUTING_CHANNELS)
  const normalized: NotificationCategoryChannels = {}
  for (const [category, entry] of Object.entries(value)) {
    if (!categories.has(category)) throw invalidRouting('Notification category is unknown.')
    if (entry === null || entry === undefined) continue
    if (!isPlainRecord(entry)) throw invalidRouting('Category channels must be an object.')
    const off: Partial<Record<NotificationRoutingChannel, false>> = {}
    for (const [channel, enabled] of Object.entries(entry)) {
      if (!channels.has(channel)) throw invalidRouting('Notification channel is unknown.')
      if (enabled === null || enabled === undefined || enabled === true) continue
      if (enabled !== false) throw invalidRouting('Category channel must be boolean.')
      off[readRoutingChannel(channel)] = false
    }
    if (Object.keys(off).length > 0) normalized[readCategory(category)] = off
  }
  return normalized
}

/**
 * Validates mutes from a request or a stored row, removing duplicate IDs and sorting them.
 *
 * @param value - Untrusted mutes.
 * @returns Validated mutes.
 * @throws NotificationError (400) for a malformed list, ID, or switch.
 */
export function normalizeNotificationMutes(value: unknown): NotificationMutes {
  if (!isPlainRecord(value)) throw invalidRouting('Notification mutes must be an object.')
  for (const key of Object.keys(value)) {
    if (key !== 'projectKeys' && key !== 'teamIds' && key !== 'keepMentions' && key !== 'keepApprovals') {
      throw invalidRouting('Notification mute field is unknown.')
    }
  }
  const keepMentions = value.keepMentions ?? DEFAULT_NOTIFICATION_MUTES.keepMentions
  const keepApprovals = value.keepApprovals ?? DEFAULT_NOTIFICATION_MUTES.keepApprovals
  if (typeof keepMentions !== 'boolean' || typeof keepApprovals !== 'boolean') {
    throw invalidRouting('Notification mute switches must be boolean.')
  }
  return {
    projectKeys: normalizeMuteIds(value.projectKeys, isValidMuteProjectKey),
    teamIds: normalizeMuteIds(value.teamIds, isValidMuteId),
    keepMentions,
    keepApprovals,
  }
}

/**
 * Reports whether two category channel settings turn off the same channels.
 *
 * @param left - First settings.
 * @param right - Second settings.
 * @returns Whether both are equal.
 */
export function categoryChannelsEqual(
  left: NotificationCategoryChannels | undefined,
  right: NotificationCategoryChannels | undefined,
): boolean {
  return NOTIFICATION_CATEGORIES.every((category) => NOTIFICATION_ROUTING_CHANNELS.every(
    (channel) => (left?.[category]?.[channel] === false) === (right?.[category]?.[channel] === false),
  ))
}

/**
 * Reports whether two mute settings are equal, treating absent mutes as the defaults.
 *
 * @param left - First mutes.
 * @param right - Second mutes.
 * @returns Whether both are equal.
 */
export function notificationMutesEqual(
  left: NotificationMutes | undefined,
  right: NotificationMutes | undefined,
): boolean {
  const a = left ?? DEFAULT_NOTIFICATION_MUTES
  const b = right ?? DEFAULT_NOTIFICATION_MUTES
  return a.keepMentions === b.keepMentions &&
    a.keepApprovals === b.keepApprovals &&
    a.projectKeys.join('\0') === b.projectKeys.join('\0') &&
    a.teamIds.join('\0') === b.teamIds.join('\0')
}

/**
 * Reports whether mutes differ from the defaults and are worth storing.
 *
 * @param mutes - Validated mutes.
 * @returns Whether any ID is muted or a switch differs from its default.
 */
export function hasNotificationMutes(mutes: NotificationMutes | undefined): mutes is NotificationMutes {
  return mutes !== undefined && !notificationMutesEqual(mutes, DEFAULT_NOTIFICATION_MUTES)
}

/**
 * Validates one list of muted IDs or Project keys.
 *
 * @param value - Untrusted list; absent means empty.
 * @param isValid - Checks one trimmed entry.
 * @returns Unique, sorted entries.
 * @throws NotificationError (400) for a non-array, a bad entry, or too many entries.
 */
function normalizeMuteIds(value: unknown, isValid: (id: string) => boolean): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalidRouting('Muted IDs must be an array.')
  const ids = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw invalidRouting('Muted ID must be a string.')
    const id = item.trim()
    if (!isValid(id)) {
      throw invalidRouting('Muted ID is invalid.')
    }
    ids.add(id)
  }
  if (ids.size > NOTIFICATION_MUTES_MAXIMUM) throw invalidRouting('Too many muted IDs.')
  return [...ids].sort()
}

/**
 * Reports whether a string is a usable Project or Team ID in a mute list.
 *
 * @param id - Trimmed ID.
 * @returns Whether the ID is non-empty, short enough, and has no `#`.
 */
function isValidMuteId(id: string): boolean {
  return id.length > 0 && id.length <= NOTIFICATION_MUTE_ID_MAX_LENGTH && !id.includes('#')
}

/**
 * Reports whether a string is a `<teamId>#<projectId>` mute key with two valid IDs.
 *
 * @param key - Trimmed key.
 * @returns Whether the key has exactly one `#` between two valid IDs.
 */
function isValidMuteProjectKey(key: string): boolean {
  const parts = key.split('#')
  return parts.length === 2 && parts.every(isValidMuteId)
}

/**
 * Narrows a validated category name.
 *
 * @param value - A name already checked against the category list.
 * @returns The category.
 */
function readCategory(value: string): NotificationCategory {
  const category = NOTIFICATION_CATEGORIES.find((item) => item === value)
  if (!category) throw invalidRouting('Notification category is unknown.')
  return category
}

/**
 * Narrows a validated channel name.
 *
 * @param value - A name already checked against the channel list.
 * @returns The channel.
 */
function readRoutingChannel(value: string): NotificationRoutingChannel {
  const channel = NOTIFICATION_ROUTING_CHANNELS.find((item) => item === value)
  if (!channel) throw invalidRouting('Notification channel is unknown.')
  return channel
}

/**
 * Reports whether a value is a non-array object.
 *
 * @param value - Untrusted value.
 * @returns Whether it is a plain record.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates the 400 error for invalid routing settings.
 *
 * @param message - Message safe to return to clients.
 * @returns The error.
 */
function invalidRouting(message: string): NotificationError {
  return new NotificationError(400, 'InvalidNotificationPreferences', message)
}
