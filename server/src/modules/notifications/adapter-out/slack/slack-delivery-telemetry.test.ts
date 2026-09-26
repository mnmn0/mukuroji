import { expect, test } from 'bun:test'
import { createSlackDeliveryTelemetry } from './slack-delivery-telemetry'

test('emits actionable failure coordinates and the alarm-compatible EMF contract', () => {
  const events: string[] = []
  const telemetry = createSlackDeliveryTelemetry((event) => { events.push(event) }, () => 1_800_000_000_000)
  telemetry.reportFailure({ reference: 'random-reference', shard: 'slack-failed#3', dueAt: '2026-09-26T12:00:00.000Z', code: 'SlackDeliveryRejected' })
  telemetry.reportQueueHealth(1_800, 2)
  expect(JSON.parse(events[0]!)).toEqual({ event: 'SlackNotificationFailed', reference: 'random-reference', shard: 'slack-failed#3', dueAt: '2026-09-26T12:00:00.000Z', code: 'SlackDeliveryRejected' })
  expect(JSON.parse(events[1]!)).toMatchObject({
    _aws: { Timestamp: 1_800_000_000_000, CloudWatchMetrics: [{ Namespace: 'Mukuroji/Notifications', Dimensions: [['Channel']] }] },
    Channel: 'Slack', OldestDueAgeSeconds: 1_800, InvalidQueueCandidates: 2,
  })
})
