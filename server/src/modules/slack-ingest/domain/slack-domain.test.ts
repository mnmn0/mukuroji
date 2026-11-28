import { createHmac } from 'node:crypto'
import { expect, test } from 'bun:test'
import { parseSlackEnvelope, readSlackInboundEvent } from './slack-events'
import { buildSlackPermalink, extractWorkItemKeys, readSlackTeamOrigin, slackTsToIso } from './slack-message'
import { verifySlackSignature } from './slack-signature'

/** Signing secret of the tests. */
const secret = '0123456789abcdef0123456789abcdef'

/**
 * Signs a body like Slack does.
 *
 * @param timestamp - Request timestamp.
 * @param body - Raw body.
 * @returns The signature header.
 */
function sign(timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

test('accepts a fresh signed request and rejects stale, tampered, or malformed ones', () => {
  const body = '{"type":"event_callback"}'
  const signature = sign('1700000000', body)
  expect(verifySlackSignature(secret, { timestamp: '1700000000', signature, rawBody: body }, 1700000100)).toBe(true)
  expect(verifySlackSignature(secret, { timestamp: '1700000000', signature, rawBody: body }, 1700000301)).toBe(false)
  expect(verifySlackSignature(secret, { timestamp: '1700000000', signature, rawBody: `${body} ` }, 1700000000)).toBe(false)
  expect(verifySlackSignature(secret, { timestamp: '1700000000', signature: 'v0=abc', rawBody: body }, 1700000000)).toBe(false)
  expect(verifySlackSignature(secret, { timestamp: 'now', signature, rawBody: body }, 1700000000)).toBe(false)
  expect(verifySlackSignature('', { timestamp: '1700000000', signature, rawBody: body }, 1700000000)).toBe(false)
})

test('normalizes a person message and ignores bot, system, and direct messages', () => {
  const base = { type: 'message', channel: 'C012345678', channel_type: 'channel', user: 'U012345678', ts: '1700000000.000100', text: 'MK-12 done' }
  expect(readSlackInboundEvent(base)).toEqual({
    kind: 'message-posted',
    channelKind: 'public',
    message: { channelId: 'C012345678', ts: '1700000000.000100', userId: 'U012345678', text: 'MK-12 done', version: '1700000000.000100' },
  })
  expect(readSlackInboundEvent({ ...base, thread_ts: '1699999999.000100', channel_type: 'group' })).toMatchObject({
    channelKind: 'private',
    message: { threadTs: '1699999999.000100' },
  })
  expect(readSlackInboundEvent({ ...base, bot_id: 'B1' })).toBeUndefined()
  expect(readSlackInboundEvent({ ...base, subtype: 'channel_join' })).toBeUndefined()
  expect(readSlackInboundEvent({ ...base, channel_type: 'im', channel: 'D012345678' })).toBeUndefined()
  expect(readSlackInboundEvent({ ...base, subtype: 'thread_broadcast' })).toMatchObject({ kind: 'message-posted' })
})

test('normalizes edits, deletions, tombstones, joins, and leaves', () => {
  const channel = { channel: 'C012345678', channel_type: 'channel' }
  expect(readSlackInboundEvent({
    type: 'message', subtype: 'message_changed', ...channel, event_ts: '1700000500.000000',
    message: { user: 'U012345678', ts: '1700000000.000100', text: 'new', edited: { ts: '1700000400.000000' } },
  })).toMatchObject({ kind: 'message-changed', message: { text: 'new', version: '1700000400.000000', editedTs: '1700000400.000000' } })
  expect(readSlackInboundEvent({
    type: 'message', subtype: 'message_deleted', ...channel, deleted_ts: '1700000000.000100', event_ts: '1700000600.000000',
  })).toEqual({ kind: 'message-deleted', channelId: 'C012345678', ts: '1700000000.000100', eventTs: '1700000600.000000' })
  expect(readSlackInboundEvent({
    type: 'message', subtype: 'message_changed', ...channel, event_ts: '1700000700.000000',
    message: { subtype: 'tombstone', ts: '1700000000.000100', text: 'This message was deleted.' },
  })).toMatchObject({ kind: 'message-deleted', ts: '1700000000.000100' })
  expect(readSlackInboundEvent({ type: 'member_joined_channel', channel: 'G012345678', channel_type: 'G', user: 'U0BOT00001' }))
    .toEqual({ kind: 'member-joined', channelId: 'G012345678', userId: 'U0BOT00001', channelKind: 'private' })
  expect(readSlackInboundEvent({ type: 'channel_left', channel: 'C012345678' })).toEqual({ kind: 'bot-left', channelId: 'C012345678' })
  expect(readSlackInboundEvent({ type: 'reaction_added' })).toBeUndefined()
})

test('parses the Events API envelope', () => {
  expect(parseSlackEnvelope({ type: 'url_verification', challenge: 'abc' })).toEqual({ kind: 'url-verification', challenge: 'abc' })
  expect(parseSlackEnvelope({ type: 'event_callback', team_id: 'T012345678', api_app_id: 'A012345678', event_id: 'Ev012345', event: { type: 'reaction_added' } }))
    .toEqual({ kind: 'event-callback', teamId: 'T012345678', apiAppId: 'A012345678', eventId: 'Ev012345' })
  expect(() => parseSlackEnvelope({ type: 'event_callback', team_id: 'nope', event_id: 'Ev012345' })).toThrow(TypeError)
  expect(() => parseSlackEnvelope({ type: 'app_rate_limited' })).toThrow(TypeError)
})

test('extracts uppercase Work Item keys once each', () => {
  expect(extractWorkItemKeys('MK-12 と mk-13、MK-12 と ABC-7。utf-8 や X-1 や MK-012 や fooMK-5 は対象外')).toEqual(['MK-12', 'ABC-7'])
  const many = Array.from({ length: 30 }, (_, index) => `MK-${index + 1}`).join(' ')
  expect(extractWorkItemKeys(many)).toHaveLength(20)
})

test('builds permalinks only from Slack team URLs', () => {
  expect(readSlackTeamOrigin('https://example.slack.com/')).toBe('https://example.slack.com')
  expect(readSlackTeamOrigin('https://example.slack.com.evil.test/')).toBeUndefined()
  expect(readSlackTeamOrigin('http://example.slack.com/')).toBeUndefined()
  expect(buildSlackPermalink('https://example.slack.com', 'C012345678', '1700000000.000100'))
    .toBe('https://example.slack.com/archives/C012345678/p1700000000000100')
  expect(buildSlackPermalink('https://example.slack.com', 'C012345678', '1700000001.000100', '1700000000.000100'))
    .toBe('https://example.slack.com/archives/C012345678/p1700000001000100?thread_ts=1700000000.000100&cid=C012345678')
  expect(slackTsToIso('1700000000.123456')).toBe('2023-11-14T22:13:20.123Z')
})
