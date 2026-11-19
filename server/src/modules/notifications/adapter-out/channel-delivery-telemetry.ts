import type { ChannelDeliveryTelemetry } from '../application/channel-delivery'

/**
 * Creates structured failure logs and CloudWatch Embedded Metric Format queue metrics for one channel.
 * @param label - PascalCase channel label used as the log event prefix and metric dimension.
 * @param write - JSON log sink; no notification contents or recipient identifiers are emitted.
 * @param now - Metric timestamp clock.
 * @returns Telemetry port for one scheduled delivery invocation.
 */
export function createChannelDeliveryTelemetry(
  label: 'Slack' | 'Email',
  write: (event: string) => void = console.log,
  now: () => number = Date.now,
): ChannelDeliveryTelemetry {
  return {
    reportFailure(failure) {
      write(JSON.stringify({ event: `${label}NotificationFailed`, ...failure }))
    },
    reportQueueHealth(oldestDueAgeSeconds, invalidCandidates) {
      write(JSON.stringify({
        _aws: {
          Timestamp: now(),
          CloudWatchMetrics: [{ Namespace: 'Mukuroji/Notifications', Dimensions: [['Channel']], Metrics: [
            { Name: 'OldestDueAgeSeconds', Unit: 'Seconds' },
            { Name: 'InvalidQueueCandidates', Unit: 'Count' },
          ] }],
        },
        Channel: label, OldestDueAgeSeconds: oldestDueAgeSeconds, InvalidQueueCandidates: invalidCandidates,
      }))
    },
  }
}
