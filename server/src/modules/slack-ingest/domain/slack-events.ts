import { isSlackChannelId } from '@mukuroji/contracts'

/** Longest message text kept, in UTF-16 code units. */
export const SLACK_MESSAGE_TEXT_MAX_LENGTH = 8_000

/** Slack message timestamp shape, such as `1700000000.123456`. */
const SLACK_TS_PATTERN = /^[0-9]{9,12}\.[0-9]{6}$/u

/** Slack user ID shape. */
const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{8,20}$/u

/** Slack team or app ID shape. */
const SLACK_TEAM_OR_APP_ID_PATTERN = /^[TAE][A-Z0-9]{8,20}$/u

/** Message subtypes that carry a person's words; every other subtype is a system message. */
const HUMAN_MESSAGE_SUBTYPES = new Set(['thread_broadcast', 'file_share', 'me_message'])

/** Channel kind the bot reads. */
export type SlackChannelKind = 'public' | 'private'

/** A person's message as stored. */
export type SlackMessageContent = {
  /** Channel ID. */
  channelId: string
  /** Message timestamp. */
  ts: string
  /** Parent timestamp for a thread reply. */
  threadTs?: string
  /** Author user ID. */
  userId: string
  /** Message text, cut to the stored length. */
  text: string
  /** Version: the edit timestamp, or `ts` for an unedited message. */
  version: string
  /** Edit timestamp, when edited. */
  editedTs?: string
}

/** A Slack event the worker acts on, without provider payload fields. */
export type SlackInboundEvent =
  | {
      /** A message was posted. */
      kind: 'message-posted'
      /** Channel kind from the event. */
      channelKind: SlackChannelKind
      /** Message content. */
      message: SlackMessageContent
    }
  | {
      /** A message was edited. */
      kind: 'message-changed'
      /** Channel kind from the event. */
      channelKind: SlackChannelKind
      /** New message content. */
      message: SlackMessageContent
    }
  | {
      /** A message was deleted. */
      kind: 'message-deleted'
      /** Channel ID. */
      channelId: string
      /** Deleted message timestamp. */
      ts: string
      /** Event timestamp, which orders the deletion after every earlier version. */
      eventTs: string
    }
  | {
      /** A user joined a channel; the worker acts only when it is the bot. */
      kind: 'member-joined'
      /** Channel ID. */
      channelId: string
      /** User who joined. */
      userId: string
      /** Channel kind, when Slack sent it. */
      channelKind?: SlackChannelKind
      /** Event timestamp, which orders membership changes, when Slack sent it. */
      eventTs?: string
    }
  | {
      /** The bot left or was removed from a channel. */
      kind: 'bot-left'
      /** Channel ID. */
      channelId: string
      /** Event timestamp, which orders membership changes, when Slack sent it. */
      eventTs?: string
    }

/** A parsed Slack Events API request body. */
export type SlackEnvelope =
  | {
      /** Slack's request URL check. */
      kind: 'url-verification'
      /** Value to echo back. */
      challenge: string
    }
  | {
      /** A delivered event. */
      kind: 'event-callback'
      /** Slack team ID. */
      teamId: string
      /** Slack app ID. */
      apiAppId?: string
      /** Event ID, unique per delivery attempt group. */
      eventId: string
      /** Event this deployment acts on, or `undefined` for one it ignores. */
      event?: SlackInboundEvent
    }

/**
 * Reports whether a value is an object that is not an array.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reports whether a value is a Slack message timestamp.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a timestamp.
 */
export function isSlackTs(value: unknown): value is string {
  return typeof value === 'string' && SLACK_TS_PATTERN.test(value)
}

/**
 * Reports whether a value is a Slack user ID.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a user ID.
 */
export function isSlackUserId(value: unknown): value is string {
  return typeof value === 'string' && SLACK_USER_ID_PATTERN.test(value)
}

/**
 * Reports whether a value is a Slack team or app ID.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a team or app ID.
 */
export function isSlackTeamOrAppId(value: unknown): value is string {
  return typeof value === 'string' && SLACK_TEAM_OR_APP_ID_PATTERN.test(value)
}

/**
 * Reads the channel kind from an event's `channel_type`.
 *
 * @param value - `channel_type` value.
 * @returns The kind, or `undefined` for a DM, group DM, or unknown kind.
 */
function readChannelKind(value: unknown): SlackChannelKind | undefined {
  if (value === 'channel') return 'public'
  if (value === 'group') return 'private'
  return undefined
}

/**
 * Normalizes one Slack message object into stored content, rejecting bot and system messages.
 *
 * @param channelId - Channel the message is in.
 * @param value - Slack message object from an event or a history page.
 * @returns The content, or `undefined` when the message is not a person's message.
 */
export function readSlackMessageContent(channelId: string, value: unknown): SlackMessageContent | undefined {
  if (!isRecord(value)) return undefined
  if (value.bot_id !== undefined || value.bot_profile !== undefined) return undefined
  if (value.subtype !== undefined && !(typeof value.subtype === 'string' && HUMAN_MESSAGE_SUBTYPES.has(value.subtype))) {
    return undefined
  }
  if (value.hidden === true) return undefined
  const { ts, user, text } = value
  if (!isSlackTs(ts) || !isSlackUserId(user) || typeof text !== 'string') return undefined
  const threadTs = isSlackTs(value.thread_ts) && value.thread_ts !== ts ? value.thread_ts : undefined
  const edited = isRecord(value.edited) && isSlackTs(value.edited.ts) ? value.edited.ts : undefined
  return {
    channelId,
    ts,
    ...(threadTs ? { threadTs } : {}),
    userId: user,
    text: text.length > SLACK_MESSAGE_TEXT_MAX_LENGTH ? text.slice(0, SLACK_MESSAGE_TEXT_MAX_LENGTH) : text,
    version: edited ?? ts,
    ...(edited ? { editedTs: edited } : {}),
  }
}

/**
 * Normalizes the inner event of an `event_callback`.
 *
 * @param value - `event` field.
 * @returns The event, or `undefined` when this deployment ignores it.
 */
export function readSlackInboundEvent(value: unknown): SlackInboundEvent | undefined {
  if (!isRecord(value)) return undefined
  const channelId = value.channel
  if (value.type === 'message') {
    if (!isSlackChannelId(channelId)) return undefined
    const channelKind = readChannelKind(value.channel_type)
    if (!channelKind) return undefined
    if (value.subtype === 'message_changed') {
      const changed = value.message
      // A parent deleted while it has replies stays as a tombstone, which removes its text.
      if (isRecord(changed) && changed.subtype === 'tombstone' && isSlackTs(changed.ts)) {
        const eventTs = value.event_ts ?? value.ts
        if (!isSlackTs(eventTs)) return undefined
        return { kind: 'message-deleted', channelId, ts: changed.ts, eventTs }
      }
      const message = readSlackMessageContent(channelId, value.message)
      return message ? { kind: 'message-changed', channelKind, message } : undefined
    }
    if (value.subtype === 'message_deleted') {
      const eventTs = value.event_ts ?? value.ts
      if (!isSlackTs(value.deleted_ts) || !isSlackTs(eventTs)) return undefined
      return { kind: 'message-deleted', channelId, ts: value.deleted_ts, eventTs }
    }
    const message = readSlackMessageContent(channelId, value)
    return message ? { kind: 'message-posted', channelKind, message } : undefined
  }
  if (value.type === 'member_joined_channel') {
    if (!isSlackChannelId(channelId) || !isSlackUserId(value.user)) return undefined
    const channelKind = value.channel_type === 'C' ? 'public' : value.channel_type === 'G' ? 'private' : undefined
    return {
      kind: 'member-joined',
      channelId,
      userId: value.user,
      ...(channelKind ? { channelKind } : {}),
      ...(isSlackTs(value.event_ts) ? { eventTs: value.event_ts } : {}),
    }
  }
  if (value.type === 'channel_left' || value.type === 'group_left') {
    if (!isSlackChannelId(channelId)) return undefined
    return { kind: 'bot-left', channelId, ...(isSlackTs(value.event_ts) ? { eventTs: value.event_ts } : {}) }
  }
  return undefined
}

/**
 * Parses a Slack Events API request body.
 *
 * @param value - Parsed JSON body.
 * @returns The envelope.
 * @throws TypeError when the body is not a Slack Events API request.
 */
export function parseSlackEnvelope(value: unknown): SlackEnvelope {
  if (!isRecord(value)) throw new TypeError('Slack request body must be an object.')
  if (value.type === 'url_verification') {
    if (typeof value.challenge !== 'string' || value.challenge.length === 0 || value.challenge.length > 256) {
      throw new TypeError('Slack challenge is invalid.')
    }
    return { kind: 'url-verification', challenge: value.challenge }
  }
  if (value.type === 'event_callback') {
    if (!isSlackTeamOrAppId(value.team_id)) throw new TypeError('Slack team ID is invalid.')
    if (typeof value.event_id !== 'string' || !/^Ev[A-Z0-9]{6,32}$/u.test(value.event_id)) {
      throw new TypeError('Slack event ID is invalid.')
    }
    const event = readSlackInboundEvent(value.event)
    return {
      kind: 'event-callback',
      teamId: value.team_id,
      ...(isSlackTeamOrAppId(value.api_app_id) ? { apiAppId: value.api_app_id } : {}),
      eventId: value.event_id,
      ...(event ? { event } : {}),
    }
  }
  throw new TypeError('Slack request type is not supported.')
}
