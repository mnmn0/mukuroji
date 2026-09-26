import { createHash } from 'node:crypto'
import type { SlackDelivery, SlackSendResult } from '../../application/slack-delivery'

/**
 * Resolves the recipient-bound destination within the tenant's existing secret-cleanup namespace.
 * @param workspaceId - Canonical workspace identity.
 * @param memberKey - Canonical recipient member key.
 * @returns Secret ID without exposing either identity.
 */
export function slackNotificationSecretId(workspaceId: string, memberKey: string): string {
  const workspaceHash = createHash('sha256').update(workspaceId.trim()).digest('hex')
  const memberHash = createHash('sha256').update(memberKey.trim().toLowerCase()).digest('hex')
  return `mukuroji/automation-webhooks/${workspaceHash}/slack-${memberHash}`
}

/** HTTP boundary used by the fixed-host Slack transport. */
export type SlackFetch = (url: URL, init: RequestInit) => Promise<Response>

/** Reads a secret value by its server-derived identity. */
export type SlackSecretReader = (secretId: string) => Promise<string | undefined>

/**
 * Creates a sender that only accepts Slack Incoming Webhook URLs from Secrets Manager.
 * @param readSecret - Secret loader configured by the composition root.
 * @param send - Timeout-aware HTTP boundary, replaceable in offline tests.
 * @returns Recipient-bound notification sender.
 */
export function createSlackNotificationSender(readSecret: SlackSecretReader, send: SlackFetch = fetch) {
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

    const notification = delivery.notification
    const text = [notification.title ?? 'Mukuroji', notification.summary, notification.reasons.join(', ')]
      .filter(Boolean).join('\n').slice(0, 3_000)
    try {
      const response = await send(new URL(secret.trim()), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
          blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
          mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false,
        }),
      })
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
      if (response.status === 200 && acknowledgement.trim() === 'ok') {
        return { succeeded: true, retryable: false }
      }
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      const seconds = Number(response.headers.get('Retry-After'))
      return {
        succeeded: false, retryable, code: 'SlackDeliveryRejected',
        ...(retryable && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86_400
          ? { retryAfterMs: seconds * 1_000 } : {}),
      }
    } catch {
      return { succeeded: false, retryable: true, code: 'SlackDeliveryUnavailable' }
    }
  }
}
