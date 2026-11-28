import { parseSlackEnvelope } from '../domain/slack-events'
import { verifySlackSignature } from '../domain/slack-signature'
import type { SlackIngestConfigSource, SlackIngestQueue } from './ports/slack-ingest-ports'

/** Largest Events API request body accepted, in UTF-16 code units. */
export const SLACK_EVENT_BODY_MAX_LENGTH = 262_144

/** One received Events API request. */
export type SlackEventRequest = {
  /** Raw body exactly as received. */
  rawBody: string
  /** `X-Slack-Request-Timestamp` header. */
  timestamp: string | undefined
  /** `X-Slack-Signature` header. */
  signature: string | undefined
  /** Receive time. */
  now: Date
}

/** What the receiver answers Slack. */
export type SlackEventResponse =
  | {
      /** Accepted, or ignored on purpose. */
      status: 200
      /** Body to send. */
      body: { ok: true } | { challenge: string }
    }
  | {
      /** Rejected. */
      status: 400 | 401 | 403 | 404 | 413
      /** Stable code. */
      body: { code: string }
    }

/** Ports of the receiver. */
export type SlackEventReceiverPorts = {
  /** Slack app settings. */
  config: SlackIngestConfigSource
  /** Worker queue. */
  queue: SlackIngestQueue
  /**
   * Fails while the Workspace is suspended or closed.
   *
   * @param workspaceId - Workspace ID.
   */
  assertWorkspaceActive(workspaceId: string): Promise<void>
}

/**
 * Verifies one Slack Events API request and queues the event it carries.
 *
 * Slack expects an answer within three seconds, so the receiver only verifies, normalizes, and
 * queues; the worker reads Slack and writes rows. A redelivered event is queued again and the
 * worker's writes make the second run a no-op.
 *
 * @param request - Raw request.
 * @param ports - Settings, queue, and Workspace lifecycle check.
 * @returns The response.
 */
export async function receiveSlackEvent(
  request: SlackEventRequest,
  ports: SlackEventReceiverPorts,
): Promise<SlackEventResponse> {
  const config = await ports.config.read()
  if (!config) return { status: 404, body: { code: 'SlackIngestNotConfigured' } }
  if (request.rawBody.length > SLACK_EVENT_BODY_MAX_LENGTH) {
    return { status: 413, body: { code: 'SlackEventTooLarge' } }
  }
  const signed = verifySlackSignature(config.signingSecret, request, Math.floor(request.now.getTime() / 1000))
  if (!signed) return { status: 401, body: { code: 'SlackSignatureInvalid' } }

  let envelope
  try {
    envelope = parseSlackEnvelope(JSON.parse(request.rawBody))
  } catch {
    return { status: 400, body: { code: 'SlackEventInvalid' } }
  }
  if (envelope.kind === 'url-verification') return { status: 200, body: { challenge: envelope.challenge } }
  if (envelope.teamId !== config.teamId || (config.appId !== undefined && envelope.apiAppId !== config.appId)) {
    return { status: 403, body: { code: 'SlackTeamNotAllowed' } }
  }
  if (!envelope.event) return { status: 200, body: { ok: true } }
  await ports.assertWorkspaceActive(config.workspaceId)
  await ports.queue.send({
    kind: 'event',
    workspaceId: config.workspaceId,
    eventId: envelope.eventId,
    event: envelope.event,
  })
  return { status: 200, body: { ok: true } }
}
