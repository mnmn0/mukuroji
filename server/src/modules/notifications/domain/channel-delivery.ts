/** External channels that drain a durable per-notification delivery queue. */
export type ExternalDeliveryChannel = 'slack' | 'email'

/** Number of independent partitions in each channel's delivery due index. */
export const CHANNEL_DELIVERY_SHARDS = 16

/**
 * Distributes recipients deterministically across a channel's bounded delivery queue.
 * @param channel - External channel that owns the queue.
 * @param recipientKey - Canonical recipient partition.
 * @returns Stable non-secret queue partition.
 */
export function channelDeliveryShard(channel: ExternalDeliveryChannel, recipientKey: string): string {
  let hash = 0
  for (const character of recipientKey) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return `${channel}#${hash % CHANNEL_DELIVERY_SHARDS}`
}

/**
 * Selects the failed-delivery partition in the same sparse index for operator lookup.
 * @param channel - External channel that owns the queue.
 * @param recipientKey - Canonical recipient partition.
 * @returns Failed queue partition containing no recipient identity.
 */
export function channelFailedDeliveryShard(channel: ExternalDeliveryChannel, recipientKey: string): string {
  return channelDeliveryShard(channel, recipientKey).replace(`${channel}#`, `${channel}-failed#`)
}

/**
 * Distributes recipients deterministically across the bounded Email delivery queue.
 * @param recipientKey - Canonical recipient partition.
 * @returns Stable non-secret queue partition.
 */
export function emailDeliveryShard(recipientKey: string): string {
  return channelDeliveryShard('email', recipientKey)
}
