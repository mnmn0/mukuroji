import { CHANNEL_DELIVERY_SHARDS, channelDeliveryShard, channelFailedDeliveryShard } from './channel-delivery'

/** Number of independent partitions in the Slack delivery due index. */
export const SLACK_DELIVERY_SHARDS = CHANNEL_DELIVERY_SHARDS

/**
 * Distributes recipients deterministically across the bounded delivery queue.
 * @param recipientKey - Canonical recipient partition.
 * @returns Stable non-secret queue partition.
 */
export function slackDeliveryShard(recipientKey: string): string {
  return channelDeliveryShard('slack', recipientKey)
}

/**
 * Selects the failed-delivery partition in the same sparse index for operator lookup.
 * @param recipientKey - Canonical recipient partition.
 * @returns Failed queue partition containing no recipient identity.
 */
export function slackFailedDeliveryShard(recipientKey: string): string {
  return channelFailedDeliveryShard('slack', recipientKey)
}
