import { isSlackIncomingWebhookUrl } from '@mukuroji/contracts'
import type { ChannelSendResult } from '../../application/channel-delivery'

/** HTTP boundary used by the fixed-host Slack transport. */
export type SlackFetch = (url: URL, init: RequestInit) => Promise<Response>

/** Message posted to one Slack Incoming Webhook. */
export type SlackWebhookMessage = {
  /** Plain text body; Slack never expands mentions or markup in it. */
  text: string
  /**
   * Optional mrkdwn context line. Callers build it only from server-made URLs and fixed or
   * canonical labels, so stored text never reaches mrkdwn.
   */
  linkText?: string
}

/**
 * Posts one message to a Slack Incoming Webhook and classifies the outcome without reading or
 * keeping the provider's error body.
 *
 * @param webhookUrl - Stored webhook URL; anything other than an official Slack URL is refused.
 * @param message - Plain text body and optional link line.
 * @param send - Timeout-aware HTTP boundary.
 * @returns Whether Slack accepted the message, and whether a failure may be retried.
 */
export async function postSlackWebhookMessage(
  webhookUrl: string | undefined,
  message: SlackWebhookMessage,
  send: SlackFetch,
): Promise<ChannelSendResult> {
  if (!isSlackIncomingWebhookUrl(webhookUrl)) {
    return { succeeded: false, retryable: false, code: 'SlackDestinationInvalid' }
  }
  const text = message.text.slice(0, 3_000)
  try {
    const response = await send(new URL(webhookUrl.trim()), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        blocks: [
          { type: 'section', text: { type: 'plain_text', text, emoji: false } },
          ...(message.linkText ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: message.linkText }] }] : []),
        ],
        mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false,
      }),
    })
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    const seconds = Number(response.headers.get('Retry-After'))
    const rejected: ChannelSendResult = {
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
    if (acknowledgement.trim() === 'ok') return { succeeded: true, retryable: false }
    return rejected
  } catch {
    return { succeeded: false, retryable: true, code: 'SlackDeliveryUnavailable' }
  }
}

/**
 * Formats a Slack mrkdwn link whose URL cannot end the link or change its label.
 * @param url - Absolute URL built by the server on the application origin.
 * @param label - Fixed label or canonical Work Item key, which never contains mrkdwn control characters.
 * @returns `<url|label>` with Slack control characters in the URL escaped.
 */
export function slackLink(url: string, label: string): string {
  const safeUrl = url.replaceAll('&', '&amp;').replaceAll('|', '%7C').replaceAll('<', '%3C').replaceAll('>', '%3E')
  return `<${safeUrl}|${label}>`
}
