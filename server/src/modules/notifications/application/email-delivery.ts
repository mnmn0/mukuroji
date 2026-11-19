import { isEmailNotificationEligible } from '../notifications'
import { deliverDueChannelNotifications, type ChannelDeliveryDependencies, type ChannelDeliveryPolicy } from './channel-delivery'

/** Email queue identity and the Email opt-in period rule. */
const EMAIL_DELIVERY_POLICY: ChannelDeliveryPolicy = {
  channel: 'email', label: 'Email', isEligible: isEmailNotificationEligible,
}

/**
 * Drains a bounded, fair window of due Email notifications across every queue shard.
 * @param dependencies - Persistence, authorization, transport, token, and clock ports.
 * @returns Number of messages the Email transport accepted during this invocation.
 */
export async function deliverDueEmailNotifications(dependencies: ChannelDeliveryDependencies): Promise<number> {
  return deliverDueChannelNotifications(EMAIL_DELIVERY_POLICY, dependencies)
}
