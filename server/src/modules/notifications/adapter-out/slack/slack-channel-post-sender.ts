import { NOTIFICATION_CHANNEL_POST_EVENT_LABELS } from '@mukuroji/contracts'
import type { ChannelPostSender } from '../../application/channel-posts'
import type { NotificationDestinationTestSender } from '../../application/notification-destinations'
import { resolveNotificationSummaryText } from '../../domain/notification-summary'
import type { SlackDestinationSecretStore } from '../secrets-manager/slack-destination-secret-store'
import { slackChannelDestinationSecretId } from '../secrets-manager/slack-destination-secret-store'
import { formatNotificationHeading, resolveNotificationLinks } from '../notification-links'
import { formatSlackNotificationLinks } from './slack-sender'
import { postSlackWebhookMessage, type SlackFetch } from './slack-webhook'

/**
 * Creates the sender of Team and Project channel posts.
 *
 * The post names the kind of event, the target, and the summary in the destination's language,
 * with links to the target screen when the application origin is known.
 *
 * @param secrets - Webhook reader.
 * @param send - Timeout-aware HTTP boundary.
 * @param appOrigin - Web application origin for the links; without it the post carries text only.
 * @returns Channel post sender.
 */
export function createSlackChannelPostSender(
  secrets: Pick<SlackDestinationSecretStore, 'read'>,
  send: SlackFetch = fetch,
  appOrigin?: string,
): ChannelPostSender {
  return async (post, destination) => {
    let webhookUrl: string | undefined
    try {
      webhookUrl = await secrets.read(slackChannelDestinationSecretId(post.workspaceId, post.target))
    } catch {
      return { succeeded: false, retryable: true, code: 'SlackDestinationUnavailable' }
    }
    if (webhookUrl === undefined) return { succeeded: false, retryable: false, code: 'SlackDestinationMissing' }
    const locale = destination.locale
    const label = NOTIFICATION_CHANNEL_POST_EVENT_LABELS[post.eventType][locale]
    const heading = formatNotificationHeading(post)
    const text = [
      heading ? `[${label}] ${heading}` : `[${label}]`,
      resolveNotificationSummaryText(post, locale),
    ].filter(Boolean).join('\n')
    const links = appOrigin ? resolveNotificationLinks(post, appOrigin) : undefined
    return await postSlackWebhookMessage(
      webhookUrl,
      { text, ...(links ? { linkText: formatSlackNotificationLinks(links, locale) } : {}) },
      send,
    )
  }
}

/**
 * Creates the sender of the fixed test message shown after a destination is saved.
 * @param send - Timeout-aware HTTP boundary.
 * @returns Test message sender.
 */
export function createSlackTestMessageSender(send: SlackFetch = fetch): NotificationDestinationTestSender {
  return async (webhookUrl, locale) => await postSlackWebhookMessage(webhookUrl, {
    text: locale === 'ja'
      ? 'mukuroji からのテスト通知です。この送信先に通知が届きます。'
      : 'This is a test message from mukuroji. Notifications will arrive here.',
  }, send)
}
