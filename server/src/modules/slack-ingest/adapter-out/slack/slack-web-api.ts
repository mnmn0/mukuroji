import { SlackIngestError, SlackRateLimitedError } from '../../errors'
import type { SlackHistoryPage, SlackWebApi } from '../../application/ports/slack-ingest-ports'

/** Slack Web API origin; no other host is called. */
const SLACK_API_ORIGIN = 'https://slack.com/api/'

/** Milliseconds one Slack call may take. */
const REQUEST_TIMEOUT_MS = 10_000

/** Largest response body read, in bytes. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/** Messages asked for per history page. */
const HISTORY_PAGE_SIZE = 200

/** Seconds to wait when Slack answers 429 without `Retry-After`. */
const DEFAULT_RETRY_AFTER_SECONDS = 30

/** Fetch function the client uses. */
export type SlackFetch = (input: string, init: RequestInit) => Promise<Response>

/**
 * Reports whether a value is an object that is not an array.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Slack Web API client bound to one bot token. */
export class FetchSlackWebApi implements SlackWebApi {
  /** Bot token, kept in memory only. */
  private readonly botToken: string
  /** Fetch implementation. */
  private readonly fetchImpl: SlackFetch

  /**
   * Creates the client.
   *
   * @param botToken - Bot token.
   * @param fetchImpl - Fetch implementation, replaced in tests.
   */
  constructor(botToken: string, fetchImpl: SlackFetch = fetch) {
    this.botToken = botToken
    this.fetchImpl = fetchImpl
  }

  /**
   * Calls one Web API method with form parameters.
   *
   * @param method - Method name such as `conversations.history`.
   * @param parameters - Form parameters.
   * @returns The `ok` response body.
   * @throws SlackRateLimitedError on 429; SlackIngestError when Slack refuses the call.
   */
  private async call(method: string, parameters: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${SLACK_API_ORIGIN}${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: new URLSearchParams(parameters).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'))
      throw new SlackRateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS)
    }
    if (!response.ok) {
      throw new SlackIngestError('unavailable', 'SlackApiUnavailable', `Slack ${method} answered HTTP ${response.status}.`)
    }
    const declared = Number(response.headers.get('Content-Length'))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new SlackIngestError('unavailable', 'SlackApiResponseTooLarge', `Slack ${method} response is too large.`)
    }
    const text = await response.text()
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new SlackIngestError('unavailable', 'SlackApiResponseTooLarge', `Slack ${method} response is too large.`)
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new SlackIngestError('unavailable', 'SlackApiResponseInvalid', `Slack ${method} response is not JSON.`)
    }
    if (!isRecord(body)) throw new SlackIngestError('unavailable', 'SlackApiResponseInvalid', `Slack ${method} response is invalid.`)
    if (body.ok !== true) {
      if (body.error === 'ratelimited') throw new SlackRateLimitedError(DEFAULT_RETRY_AFTER_SECONDS)
      const code = typeof body.error === 'string' ? body.error.slice(0, 64) : 'unknown_error'
      throw new SlackIngestError('unavailable', 'SlackApiError', `Slack ${method} failed: ${code}.`)
    }
    return body
  }

  /**
   * Calls `auth.test`.
   *
   * @returns Team URL and bot user ID.
   */
  async authTest(): Promise<{ url: string, userId: string }> {
    const body = await this.call('auth.test', {})
    if (typeof body.url !== 'string' || typeof body.user_id !== 'string') {
      throw new SlackIngestError('unavailable', 'SlackApiResponseInvalid', 'Slack auth.test response is invalid.')
    }
    return { url: body.url, userId: body.user_id }
  }

  /**
   * Calls `conversations.info`.
   *
   * @param channelId - Channel ID.
   * @returns Name and privacy.
   */
  async conversationInfo(channelId: string): Promise<{ name?: string, isPrivate: boolean }> {
    const body = await this.call('conversations.info', { channel: channelId })
    const channel = body.channel
    if (!isRecord(channel)) throw new SlackIngestError('unavailable', 'SlackApiResponseInvalid', 'Slack conversations.info response is invalid.')
    const name = typeof channel.name === 'string' && channel.name.length <= 80 ? channel.name : undefined
    return { ...(name ? { name } : {}), isPrivate: channel.is_private === true }
  }

  /**
   * Reads one page of messages and returns its cursor.
   *
   * @param method - `conversations.history` or `conversations.replies`.
   * @param parameters - Form parameters.
   * @returns The page.
   */
  private async page(method: string, parameters: Record<string, string>): Promise<SlackHistoryPage> {
    const body = await this.call(method, { ...parameters, limit: String(HISTORY_PAGE_SIZE) })
    const messages = Array.isArray(body.messages) ? body.messages : []
    const metadata = body.response_metadata
    const cursor = isRecord(metadata) && typeof metadata.next_cursor === 'string' && metadata.next_cursor.length > 0 &&
      metadata.next_cursor.length <= 512
      ? metadata.next_cursor
      : undefined
    return { messages, ...(body.has_more === true && cursor ? { nextCursor: cursor } : {}) }
  }

  /**
   * Calls `conversations.history`.
   *
   * @param channelId - Channel ID.
   * @param oldest - Oldest timestamp.
   * @param cursor - Page cursor.
   * @returns One page.
   */
  async history(channelId: string, oldest: string, cursor?: string): Promise<SlackHistoryPage> {
    return await this.page('conversations.history', { channel: channelId, oldest, ...(cursor ? { cursor } : {}) })
  }

  /**
   * Calls `conversations.replies`.
   *
   * @param channelId - Channel ID.
   * @param threadTs - Parent timestamp.
   * @param oldest - Oldest timestamp.
   * @returns One page.
   */
  async replies(channelId: string, threadTs: string, oldest: string): Promise<SlackHistoryPage> {
    return await this.page('conversations.replies', { channel: channelId, ts: threadTs, oldest })
  }

  /**
   * Calls `users.info`.
   *
   * @param userId - User ID.
   * @returns Display name, real name, or `null`.
   */
  async userName(userId: string): Promise<string | null> {
    const body = await this.call('users.info', { user: userId })
    const user = body.user
    if (!isRecord(user)) return null
    const profile = isRecord(user.profile) ? user.profile : {}
    for (const candidate of [profile.display_name, profile.real_name, user.real_name, user.name]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim().slice(0, 120)
    }
    return null
  }
}
