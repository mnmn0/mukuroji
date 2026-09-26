/** Number of independent partitions in the Slack delivery due index. */
export const SLACK_DELIVERY_SHARDS = 16

/**
 * Distributes recipients deterministically across the bounded delivery queue.
 * @param recipientKey - Canonical recipient partition.
 * @returns Stable non-secret queue partition.
 */
export function slackDeliveryShard(recipientKey: string): string {
  let hash = 0
  for (const character of recipientKey) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return `slack#${hash % SLACK_DELIVERY_SHARDS}`
}

/**
 * Selects the failed-delivery partition in the same sparse index for operator lookup.
 * @param recipientKey - Canonical recipient partition.
 * @returns Failed queue partition containing no recipient identity.
 */
export function slackFailedDeliveryShard(recipientKey: string): string {
  return slackDeliveryShard(recipientKey).replace('slack#', 'slack-failed#')
}
