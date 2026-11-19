import { isSlackNotificationEligible } from '../notifications'
import {
  deliverDueChannelNotifications,
  type ChannelDelivery,
  type ChannelDeliveryBatch,
  type ChannelDeliveryDependencies,
  type ChannelDeliveryFailure,
  type ChannelDeliveryPolicy,
  type ChannelDeliveryStore,
  type ChannelDeliveryTelemetry,
  type ChannelSendResult,
} from './channel-delivery'

/** One durable Slack delivery, bound to its original recipient. */
export type SlackDelivery = ChannelDelivery

/** Safe outcome from one Slack HTTP attempt. */
export type SlackSendResult = ChannelSendResult

/** Bounded due-page results, including corrupt candidates that require operator attention. */
export type SlackDeliveryBatch = ChannelDeliveryBatch

/** Safe lookup coordinates for a failed delivery, without member or workspace identity. */
export type SlackDeliveryFailure = ChannelDeliveryFailure

/** Observability port for bounded queue health and actionable failure references. */
export type SlackDeliveryTelemetry = ChannelDeliveryTelemetry

/** Durable queue operations; leases fence concurrent schedule invocations. */
export type SlackDeliveryStore = ChannelDeliveryStore

/** Ports used by the scheduled Slack notification application. */
export type SlackDeliveryDependencies = ChannelDeliveryDependencies

/** Slack queue identity and the Slack opt-in period rule. */
const SLACK_DELIVERY_POLICY: ChannelDeliveryPolicy = {
  channel: 'slack', label: 'Slack', isEligible: isSlackNotificationEligible,
}

/**
 * Drains a bounded, fair window of due notifications across every queue shard.
 * @param dependencies - Persistence, authorization, transport, token, and clock ports.
 * @returns Number of Slack messages acknowledged during this invocation.
 */
export async function deliverDueSlackNotifications(dependencies: SlackDeliveryDependencies): Promise<number> {
  return deliverDueChannelNotifications(SLACK_DELIVERY_POLICY, dependencies)
}
