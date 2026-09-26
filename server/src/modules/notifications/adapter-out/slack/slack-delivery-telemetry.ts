import type { SlackDeliveryTelemetry } from '../../application/slack-delivery'

/**
 * Creates structured failure logs and CloudWatch Embedded Metric Format queue metrics.
 * @param write - JSON log sink; no notification contents or recipient identifiers are emitted.
 * @param now - Metric timestamp clock.
 * @returns Telemetry port for one scheduled delivery invocation.
 */
export function createSlackDeliveryTelemetry(
  write: (event: string) => void = console.log,
  now: () => number = Date.now,
): SlackDeliveryTelemetry {
  return {
    reportFailure(failure) {
      write(JSON.stringify({ event: 'SlackNotificationFailed', ...failure }))
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
        Channel: 'Slack', OldestDueAgeSeconds: oldestDueAgeSeconds, InvalidQueueCandidates: invalidCandidates,
      }))
    },
  }
}
