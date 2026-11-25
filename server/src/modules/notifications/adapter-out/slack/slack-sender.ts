import { createHash } from 'node:crypto'
import { formatNotificationReasons, isSlackIncomingWebhookUrl, type NotificationMessageLocale } from '@mukuroji/contracts'
import type { NotificationLocaleReader } from '../../application/channel-delivery'
import type { SlackDelivery, SlackSendResult } from '../../application/slack-delivery'
import { DEFAULT_NOTIFICATION_LOCALE, resolveNotificationSummaryText } from '../../domain/notification-summary'
import { formatNotificationHeading, resolveNotificationLinks, type NotificationLinks } from '../notification-links'
import { postSlackWebhookMessage, slackLink, type SlackFetch } from './slack-webhook'

export type { SlackFetch } from './slack-webhook'

/**
 * Resolves the recipient-bound destination within the tenant's existing secret-cleanup namespace.
 * @param workspaceId - Canonical workspace identity.
 * @param memberKey - Canonical recipient member key.
 * @returns Secret ID without exposing either identity.
 */
export function slackNotificationSecretId(workspaceId: string, memberKey: string): string {
  const workspaceHash = createHash('sha256').update(workspaceId.trim()).digest('hex')
  const memberHash = createHash('sha256').update(memberKey.trim().toLowerCase()).digest('hex')
  return `mukuroji/automation-webhooks/${workspaceHash}/slack/${memberHash}`
}

/** Reads a secret value by its server-derived identity. */
export type SlackSecretReader = (secretId: string) => Promise<string | undefined>

/**
 * Creates a sender that only accepts Slack Incoming Webhook URLs from Secrets Manager.
 * @param readSecret - Secret loader configured by the composition root.
 * @param send - Timeout-aware HTTP boundary, replaceable in offline tests.
 * @param appOrigin - Web application origin for the Work Item key and Inbox links; without it the
 *   message carries text only.
 * @param readLocale - Recipient language reader; without one the summary is written in Japanese.
 * @returns Recipient-bound notification sender.
 */
export function createSlackNotificationSender(
  readSecret: SlackSecretReader,
  send: SlackFetch = fetch,
  appOrigin?: string,
  readLocale: NotificationLocaleReader = async () => DEFAULT_NOTIFICATION_LOCALE,
) {
  return async (delivery: SlackDelivery): Promise<SlackSendResult> => {
    let secret: string | undefined
    try {
      secret = await readSecret(slackNotificationSecretId(delivery.workspaceId, delivery.memberKey))
    } catch {
      return { succeeded: false, retryable: true, code: 'SlackDestinationUnavailable' }
    }
    if (!isSlackIncomingWebhookUrl(secret)) return { succeeded: false, retryable: false, code: 'SlackDestinationInvalid' }

    let locale: NotificationMessageLocale
    const localeDeadline = AbortSignal.timeout(5_000)
    try {
      locale = await readLocale(delivery, localeDeadline)
    } catch {
      return { succeeded: false, retryable: true, code: 'NotificationLocaleUnavailable' }
    }
    // A reader that outlived its deadline never posts; the lease may already belong to a newer claim.
    if (localeDeadline.aborted) return { succeeded: false, retryable: true, code: 'NotificationLocaleUnavailable' }
    const notification = delivery.notification
    const text = [
      formatNotificationHeading(notification) || 'Mukuroji',
      resolveNotificationSummaryText(notification, locale),
      formatNotificationReasons(notification.reasons, locale),
    ].filter(Boolean).join('\n')
    const links = appOrigin ? resolveNotificationLinks(notification, appOrigin) : undefined
    return await postSlackWebhookMessage(secret, { text, ...(links ? { linkText: formatSlackNotificationLinks(links, locale) } : {}) }, send)
  }
}

/**
 * Builds the link line of a Slack message from server-made URLs only.
 * @param links - Deep link and optional Work Item key page.
 * @param locale - Reader's language for the fixed link label.
 * @returns mrkdwn links to the Work Item key page and the target screen.
 */
export function formatSlackNotificationLinks(links: NotificationLinks, locale: NotificationMessageLocale): string {
  // Only the canonical key and server-built URLs reach mrkdwn, so stored text cannot add markup.
  const open = slackLink(links.open, locale === 'ja' ? 'mukuroji で開く' : 'Open in mukuroji')
  return links.workItemKey ? `${slackLink(links.workItemKey.url, links.workItemKey.key)} · ${open}` : open
}
