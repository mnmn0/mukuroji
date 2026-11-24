import { isPushNotificationEligible } from '../notifications'
import { deliverDueChannelNotifications, type ChannelDeliveryDependencies, type ChannelDeliveryPolicy } from './channel-delivery'

/** Push queue identity and the push opt-in period rule. */
const PUSH_DELIVERY_POLICY: ChannelDeliveryPolicy = {
  channel: 'push', label: 'Push', isEligible: isPushNotificationEligible,
}

/**
 * Drains a bounded, fair window of due Web Push notifications across every queue shard.
 * @param dependencies - Persistence, authorization, transport, token, and clock ports.
 * @returns Number of notifications at least one of the recipient's devices accepted.
 */
export async function deliverDuePushNotifications(dependencies: ChannelDeliveryDependencies): Promise<number> {
  return deliverDueChannelNotifications(PUSH_DELIVERY_POLICY, dependencies)
}
