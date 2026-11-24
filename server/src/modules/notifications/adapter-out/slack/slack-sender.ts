import { createHash } from 'node:crypto'
import type { NotificationMessageLocale } from '@mukuroji/contracts'
import type { NotificationLocaleReader } from '../../application/channel-delivery'
import type { SlackDelivery, SlackSendResult } from '../../application/slack-delivery'
import { DEFAULT_NOTIFICATION_LOCALE, resolveNotificationSummaryText } from '../../domain/notification-summary'
import { formatNotificationHeading, resolveNotificationLinks } from '../notification-links'

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

/** HTTP boundary used by the fixed-host Slack transport. */
export type SlackFetch = (url: URL, init: RequestInit) => Promise<Response>

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
    if (
      !secret || secret.length > 2_048 ||
      !/^https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(secret.trim())
    ) return { succeeded: false, retryable: false, code: 'SlackDestinationInvalid' }

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
      notification.reasons.join(', '),
    ].filter(Boolean).join('\n').slice(0, 3_000)
    const links = appOrigin ? resolveNotificationLinks(notification, appOrigin) : undefined
    // Only the canonical key and server-built URLs reach mrkdwn, so stored text cannot add markup.
    const linkText = links?.workItemKey
      ? `${slackLink(links.workItemKey.url, links.workItemKey.key)} · ${slackLink(links.open, 'Open in mukuroji')}`
      : links ? slackLink(links.open, 'Open in mukuroji') : undefined
    try {
      const response = await send(new URL(secret.trim()), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
          blocks: [
            { type: 'section', text: { type: 'plain_text', text, emoji: false } },
            ...(linkText ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: linkText }] }] : []),
          ],
          mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false,
        }),
      })
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      const seconds = Number(response.headers.get('Retry-After'))
      const rejected: SlackSendResult = {
        succeeded: false, retryable, code: 'SlackDeliveryRejected',
        ...(retryable && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86_400
          ? { retryAfterMs: seconds * 1_000 } : {}),
      }
      if (response.status !== 200) {
        // Status and headers determine rejection policy; an unreadable body cannot override them.
        try { await response.body?.cancel() } catch { /* Preserve the known HTTP outcome if cleanup fails. */ }
        return rejected
      }
      // Read at most the tiny Slack acknowledgement; never retain or log provider response bodies.
      const reader = response.body?.getReader()
      let acknowledgement = ''
      if (reader) {
        try {
          while (acknowledgement.length <= 16) {
            const chunk = await reader.read()
            if (chunk.done) break
            if (chunk.value.byteLength > 16) { acknowledgement = 'oversized'; break }
            acknowledgement += new TextDecoder().decode(chunk.value)
          }
        } finally { await reader.cancel() }
      }
      if (acknowledgement.trim() === 'ok') {
        return { succeeded: true, retryable: false }
      }
      return rejected
    } catch {
      return { succeeded: false, retryable: true, code: 'SlackDeliveryUnavailable' }
    }
  }
}

/**
 * Formats a Slack mrkdwn link whose URL cannot end the link or change its label.
 * @param url - Absolute URL built by the server on the application origin.
 * @param label - Fixed label or canonical Work Item key, which never contains mrkdwn control characters.
 * @returns `<url|label>` with Slack control characters in the URL escaped.
 */
function slackLink(url: string, label: string): string {
  const safeUrl = url.replaceAll('&', '&amp;').replaceAll('|', '%7C').replaceAll('<', '%3C').replaceAll('>', '%3E')
  return `<${safeUrl}|${label}>`
}
