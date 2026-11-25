import { describe, expect, test } from 'bun:test'
import {
  formatNotificationReasons,
  isNotificationChannelPostEventType,
  isSlackIncomingWebhookUrl,
} from '../src'

describe('notification reason labels', () => {
  test('writes known reasons in the reader language, once each, and leaves unknown keys out', () => {
    expect(formatNotificationReasons(['assignee', 'assignment', 'watcher'], 'ja')).toBe('担当、ウォッチ中')
    expect(formatNotificationReasons(['mention', 'Overdue'], 'en')).toBe('For you, Overdue')
    expect(formatNotificationReasons(['internal-only-key'], 'en')).toBe('')
  })
})

describe('Slack destinations', () => {
  test('accepts only official Slack and GovSlack Incoming Webhook URLs', () => {
    const url = 'https://hooks.slack.com/services/T000/B000/XXXX'
    expect(isSlackIncomingWebhookUrl(url)).toBe(true)
    expect(isSlackIncomingWebhookUrl(url.replace('slack.com', 'slack-gov.com'))).toBe(true)
    for (const value of [url.replace('https:', 'http:'), `${url}/x`, `${url}?a=1`, url.replace('hooks.', ''), 'x'.repeat(2_049), 1]) {
      expect(isSlackIncomingWebhookUrl(value)).toBe(false)
    }
  })

  test('posts only the listed events to channels', () => {
    expect(isNotificationChannelPostEventType('planning-update.published')).toBe(true)
    expect(isNotificationChannelPostEventType('work-item.overdue')).toBe(true)
    expect(isNotificationChannelPostEventType('comment.created')).toBe(false)
    expect(isNotificationChannelPostEventType('toString')).toBe(false)
  })
})
