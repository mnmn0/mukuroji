import type { EmailFeedbackTelemetry } from '../../application/email-feedback'

/**
 * Creates structured logs and CloudWatch Embedded Metric Format counts for Email feedback.
 * No address, recipient key, or message content is written.
 * @param write - JSON log sink.
 * @param now - Metric timestamp clock.
 * @returns Telemetry port for one feedback run.
 */
export function createEmailFeedbackTelemetry(
  write: (event: string) => void = console.log,
  now: () => number = Date.now,
): EmailFeedbackTelemetry {
  const metric = (name: 'EmailSuppressions' | 'InvalidEmailFeedback', dimensions: Record<string, string>) => write(JSON.stringify({
    _aws: {
      Timestamp: now(),
      CloudWatchMetrics: [{ Namespace: 'Mukuroji/Notifications', Dimensions: [Object.keys(dimensions)], Metrics: [{ Name: name, Unit: 'Count' }] }],
    },
    ...dimensions, [name]: 1,
  }))
  return {
    reportSuppression(reason) {
      write(JSON.stringify({ event: 'EmailRecipientSuppressed', reason }))
      metric('EmailSuppressions', { Reason: reason })
    },
    reportInvalid() {
      write(JSON.stringify({ event: 'EmailFeedbackInvalid' }))
      metric('InvalidEmailFeedback', { Channel: 'Email' })
    },
  }
}
