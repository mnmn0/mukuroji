import type { ChannelDeliveryTelemetry } from '../../application/channel-delivery'
import { createChannelDeliveryTelemetry } from '../channel-delivery-telemetry'

/**
 * Creates structured failure logs and CloudWatch Embedded Metric Format queue metrics.
 * @param write - JSON log sink; no notification contents or recipient identifiers are emitted.
 * @param now - Metric timestamp clock.
 * @returns Telemetry port for one scheduled delivery invocation.
 */
export function createSlackDeliveryTelemetry(
  write: (event: string) => void = console.log,
  now: () => number = Date.now,
): ChannelDeliveryTelemetry {
  return createChannelDeliveryTelemetry('Slack', write, now)
}
