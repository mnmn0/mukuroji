import {
  DEFAULT_NOTIFICATION_MUTES,
  type NotificationCategory,
  type NotificationCategoryChannels,
  type NotificationMutes,
  type NotificationRoutingChannel,
} from '@mukuroji/contracts'

/** Which list of a mute setting an ID belongs to. */
export type NotificationMuteKind = 'projectIds' | 'teamIds'

/**
 * Reports whether a category still receives a channel, before the channel switch is applied.
 *
 * @param categoryChannels - Channels turned off per category.
 * @param category - Category shown in the row.
 * @param channel - Channel shown in the column.
 * @returns Whether the category leaves the channel on.
 */
export function isCategoryChannelOn(
  categoryChannels: NotificationCategoryChannels | undefined,
  category: NotificationCategory,
  channel: NotificationRoutingChannel,
) {
  return categoryChannels?.[category]?.[channel] !== false
}

/**
 * Turns one channel on or off for one category, keeping only channels turned off.
 *
 * @param categoryChannels - Current settings.
 * @param category - Category to change.
 * @param channel - Channel to change.
 * @param enabled - Whether the category should receive the channel.
 * @returns New settings; the input is not changed.
 */
export function setCategoryChannel(
  categoryChannels: NotificationCategoryChannels | undefined,
  category: NotificationCategory,
  channel: NotificationRoutingChannel,
  enabled: boolean,
): NotificationCategoryChannels {
  const next: NotificationCategoryChannels = { ...categoryChannels }
  const off = { ...next[category] }
  if (enabled) {
    delete off[channel]
  } else {
    off[channel] = false
  }
  if (Object.keys(off).length > 0) {
    next[category] = off
  } else {
    delete next[category]
  }
  return next
}

/**
 * Returns the saved mutes, or the defaults when none were saved.
 *
 * @param mutes - Saved mutes, if any.
 * @returns Mutes to show and edit.
 */
export function resolveNotificationMutes(mutes: NotificationMutes | undefined): NotificationMutes {
  return mutes ?? {
    ...DEFAULT_NOTIFICATION_MUTES,
    projectIds: [],
    teamIds: [],
  }
}

/**
 * Mutes or unmutes one Project or Team.
 *
 * @param mutes - Current mutes.
 * @param kind - Whether the ID is a Project or a Team.
 * @param id - Project or Team ID.
 * @param muted - Whether the ID should be muted.
 * @returns New mutes with a sorted, unique ID list; the input is not changed.
 */
export function setNotificationMuted(
  mutes: NotificationMutes,
  kind: NotificationMuteKind,
  id: string,
  muted: boolean,
): NotificationMutes {
  const ids = new Set(mutes[kind])
  if (muted) {
    ids.add(id)
  } else {
    ids.delete(id)
  }
  return { ...mutes, [kind]: [...ids].sort() }
}
