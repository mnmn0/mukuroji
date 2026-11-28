import { createHmac } from 'node:crypto'
import { expect, test } from 'bun:test'
import { InMemorySlackIngestStore } from './adapter-out/in-memory/in-memory-slack-ingest-store'
import { SlackIngestError, SlackRateLimitedError } from './errors'
import type { SlackIngestConfig, SlackIngestJob, SlackWebApi } from './application/ports/slack-ingest-ports'
import { readSlackIngestStatus, updateSlackChannelTarget, updateSlackIngestSettings } from './application/slack-ingest-admin'
import { receiveSlackEvent } from './application/slack-event-receiver'
import { runSlackIngestJob, type SlackIngestWorkerPorts } from './application/slack-ingest-worker'
import { listWorkItemSlackMessages } from './application/slack-message-read'

/** Workspace of the tests. */
const WS = 'workspace-1'
/** Channel of the tests. */
const CHANNEL = 'C012345678'
/** Bot user of the tests. */
const BOT = 'U0BOT00001'
/** Author of the tests. */
const AUTHOR = 'U012345678'
/** Test clock: 2026-11-28T00:00:00Z. */
const NOW = new Date('2026-11-28T00:00:00.000Z')
/** Slack timestamp one day before {@link NOW}. */
const RECENT_TS = `${NOW.getTime() / 1000 - 86_400}.000100`

/** Settings of the tests. */
const config: SlackIngestConfig = {
  signingSecret: '0123456789abcdef0123456789abcdef',
  botToken: 'xoxb-1234567890-abcdef',
  teamId: 'T012345678',
  workspaceId: WS,
}

/** Audit input of administrator changes. */
const audit = { context: { actor: 'admin' }, now: NOW.toISOString() }

/** Recording fake of the Slack Web API. */
class FakeSlack implements SlackWebApi {
  /** Calls made, by method. */
  readonly calls: string[] = []
  /** History pages by cursor (`''` is the first page). */
  pages = new Map<string, { messages: unknown[], nextCursor?: string }>()
  /** Replies by thread timestamp. */
  threads = new Map<string, unknown[]>()
  /** Error thrown by the next history call. */
  historyError: Error | undefined
  /** Error thrown by the next replies call of a thread. */
  repliesErrors = new Map<string, Error>()

  /**
   * Answers `auth.test`.
   *
   * @returns The team URL and bot user.
   */
  async authTest() {
    this.calls.push('auth.test')
    return { url: 'https://example.slack.com/', userId: BOT }
  }

  /**
   * Answers `conversations.info`.
   *
   * @returns A public channel.
   */
  async conversationInfo() {
    this.calls.push('conversations.info')
    return { name: 'general', isPrivate: false }
  }

  /**
   * Answers `conversations.history`.
   *
   * @param _channelId - Channel.
   * @param _oldest - Oldest timestamp.
   * @param cursor - Cursor.
   * @returns The page.
   */
  async history(_channelId: string, _oldest: string, cursor?: string) {
    this.calls.push('conversations.history')
    if (this.historyError) {
      const error = this.historyError
      this.historyError = undefined
      throw error
    }
    return this.pages.get(cursor ?? '') ?? { messages: [] }
  }

  /**
   * Answers `conversations.replies`.
   *
   * @param _channelId - Channel.
   * @param threadTs - Thread.
   * @returns The replies.
   */
  async replies(_channelId: string, threadTs: string) {
    this.calls.push('conversations.replies')
    const error = this.repliesErrors.get(threadTs)
    if (error) {
      this.repliesErrors.delete(threadTs)
      throw error
    }
    return { messages: this.threads.get(threadTs) ?? [] }
  }

  /**
   * Answers `users.info`.
   *
   * @returns A name.
   */
  async userName() {
    this.calls.push('users.info')
    return 'Hanako'
  }
}

/**
 * Builds worker ports around an in-memory store.
 *
 * @returns Ports, the store, the fake Slack, and the queued jobs.
 */
function createWorld() {
  const store = new InMemorySlackIngestStore()
  const slack = new FakeSlack()
  const queued: { job: SlackIngestJob, delaySeconds?: number }[] = []
  const queue = {
    async send(job: SlackIngestJob, delaySeconds?: number) {
      queued.push({ job, ...(delaySeconds === undefined ? {} : { delaySeconds }) })
    },
  }
  const ports: SlackIngestWorkerPorts = {
    config: { read: async () => config },
    store,
    queue,
    createSlackWebApi: () => slack,
    now: () => NOW,
    isWorkspaceActive: async () => true,
  }
  return { store, slack, queued, queue, ports }
}

/**
 * Builds a posted-message event job.
 *
 * @param ts - Message timestamp.
 * @param text - Text.
 * @returns The job.
 */
function posted(ts: string, text: string): SlackIngestJob {
  return {
    kind: 'event',
    workspaceId: WS,
    eventId: 'Ev012345',
    event: {
      kind: 'message-posted',
      channelKind: 'public',
      message: { channelId: CHANNEL, ts, userId: AUTHOR, text, version: ts },
    },
  }
}

/**
 * Signs a body like Slack does.
 *
 * @param timestamp - Request timestamp.
 * @param body - Raw body.
 * @returns The signature header.
 */
function sign(timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', config.signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

test('the receiver answers not configured, rejects bad signatures and other teams, and queues events', async () => {
  const queued: SlackIngestJob[] = []
  const active: string[] = []
  const ports = {
    config: { read: async (): Promise<SlackIngestConfig | undefined> => config },
    queue: { send: async (job: SlackIngestJob) => { queued.push(job) } },
    assertWorkspaceActive: async (workspaceId: string) => { active.push(workspaceId) },
  }
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  const request = (body: string, signature = sign(timestamp, body)) => ({ rawBody: body, timestamp, signature, now: NOW })

  expect(await receiveSlackEvent(request('{}'), { ...ports, config: { read: async () => undefined } }))
    .toEqual({ status: 404, body: { code: 'SlackIngestNotConfigured' } })
  expect((await receiveSlackEvent(request('{}', 'v0=' + '0'.repeat(64)), ports)).status).toBe(401)
  expect(await receiveSlackEvent(request('{"type":"url_verification","challenge":"xyz"}'), ports))
    .toEqual({ status: 200, body: { challenge: 'xyz' } })

  const event = {
    type: 'event_callback',
    team_id: 'T012345678',
    event_id: 'Ev012345',
    event: { type: 'message', channel: CHANNEL, channel_type: 'channel', user: AUTHOR, ts: RECENT_TS, text: 'hello' },
  }
  expect((await receiveSlackEvent(request(JSON.stringify({ ...event, team_id: 'T999999999' })), ports)).status).toBe(403)
  expect(await receiveSlackEvent(request(JSON.stringify(event)), ports)).toEqual({ status: 200, body: { ok: true } })
  expect(active).toEqual([WS])
  expect(queued).toEqual([{
    kind: 'event',
    workspaceId: WS,
    eventId: 'Ev012345',
    event: {
      kind: 'message-posted',
      channelKind: 'public',
      message: { channelId: CHANNEL, ts: RECENT_TS, userId: AUTHOR, text: 'hello', version: RECENT_TS },
    },
  }])
  expect((await receiveSlackEvent(request('not json'), ports)).status).toBe(400)
})

test('messages of an unmapped channel are not stored, and the channel appears for mapping', async () => {
  const { store, ports } = createWorld()
  expect(await runSlackIngestJob(posted(RECENT_TS, 'MK-1'), ports)).toBe('unmapped')
  expect(store.messages.size).toBe(0)
  const status = await readSlackIngestStatus(WS, { config: ports.config, store, queue: ports.queue })
  expect(status).toMatchObject({ configured: true, slackTeamId: 'T012345678', retentionDays: 90, channels: [{ channelId: CHANNEL, name: 'general', membership: 'joined' }] })
  expect(status.channels[0]?.target).toBeUndefined()
})

test('a mapped channel stores messages with keys, keeps the newest version, and honours deletion', async () => {
  const { store, queued, ports } = createWorld()
  await store.recordMembership(WS, { channelId: CHANNEL, name: 'general', isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, { config: ports.config, store, queue: ports.queue }, audit)
  expect(queued.map((entry) => entry.job.kind)).toEqual(['backfill'])
  expect(store.audits.map((entry) => entry.eventType)).toEqual(['slack_ingest.channel_mapped'])

  expect(await runSlackIngestJob(posted(RECENT_TS, 'MK-1 を見て'), ports)).toBe('stored')
  const stored = (await store.getMessages(WS, [{ channelId: CHANNEL, ts: RECENT_TS }]))[0]
  expect(stored).toMatchObject({
    keys: ['MK-1'],
    authorName: 'Hanako',
    permalink: `https://example.slack.com/archives/${CHANNEL}/p${RECENT_TS.replace('.', '')}`,
  })

  const editTs = `${NOW.getTime() / 1000 - 3_600}.000000`
  const edit = (version: string, text: string): SlackIngestJob => ({
    kind: 'event', workspaceId: WS, eventId: 'Ev012346',
    event: { kind: 'message-changed', channelKind: 'public', message: { channelId: CHANNEL, ts: RECENT_TS, userId: AUTHOR, text, version, editedTs: version } },
  })
  expect(await runSlackIngestJob(edit(editTs, 'MK-2 に変更'), ports)).toBe('stored')
  // An older version that arrives late does not overwrite the edit.
  expect(await runSlackIngestJob(posted(RECENT_TS, 'MK-1 を見て'), ports)).toBe('skipped')
  expect((await store.getMessages(WS, [{ channelId: CHANNEL, ts: RECENT_TS }]))[0]?.keys).toEqual(['MK-2'])

  await runSlackIngestJob({
    kind: 'event', workspaceId: WS, eventId: 'Ev012347',
    event: { kind: 'message-deleted', channelId: CHANNEL, ts: RECENT_TS, eventTs: `${NOW.getTime() / 1000}.000000` },
  }, ports)
  expect(await store.getMessages(WS, [{ channelId: CHANNEL, ts: RECENT_TS }])).toEqual([])
  expect(await runSlackIngestJob(edit(`${NOW.getTime() / 1000 - 60}.000000`, 'late'), ports)).toBe('skipped')
})

test('messages older than the retention are not stored', async () => {
  const { store, ports } = createWorld()
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await store.setChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, 0, audit)
  const old = `${NOW.getTime() / 1000 - 91 * 86_400}.000000`
  expect(await runSlackIngestJob(posted(old, 'MK-1'), ports)).toBe('skipped')
})

test('the bot joining a mapped channel loads earlier messages page by page with thread replies', async () => {
  const { store, slack, queued, ports } = createWorld()
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'left', now: NOW.toISOString() })
  await store.setChannelTarget(WS, CHANNEL, { kind: 'project', teamId: 'team-a', projectId: 'p1' }, 0, audit)
  const parent = `${NOW.getTime() / 1000 - 7_200}.000100`
  slack.pages.set('', {
    messages: [
      { type: 'message', user: AUTHOR, ts: parent, text: 'MK-3 parent', thread_ts: parent, reply_count: 1 },
      { type: 'message', bot_id: 'B1', ts: `${NOW.getTime() / 1000 - 7_100}.000100`, text: 'bot' },
    ],
    nextCursor: 'next',
  })
  slack.pages.set('next', { messages: [{ type: 'message', user: AUTHOR, ts: RECENT_TS, text: 'older' }] })
  slack.threads.set(parent, [
    { type: 'message', user: AUTHOR, ts: parent, text: 'MK-3 parent', thread_ts: parent },
    { type: 'message', user: AUTHOR, ts: `${NOW.getTime() / 1000 - 7_000}.000100`, text: 'reply MK-3', thread_ts: parent },
  ])

  expect(await runSlackIngestJob({
    kind: 'event', workspaceId: WS, eventId: 'Ev012348',
    event: { kind: 'member-joined', channelId: CHANNEL, userId: BOT },
  }, ports)).toBe('bot-joined')
  expect((await store.getChannel(WS, CHANNEL))?.membership).toBe('joined')
  const first = queued.shift()
  expect(first?.job).toEqual({ kind: 'backfill', workspaceId: WS, channelId: CHANNEL, mappingRevision: 1 })
  if (!first) throw new Error('backfill was not queued')

  expect(await runSlackIngestJob(first.job, ports)).toBe('page-loaded')
  expect((await store.getChannel(WS, CHANNEL))?.backfill).toEqual({ status: 'running', importedCount: 2 })
  const second = queued.shift()
  expect(second?.job).toMatchObject({ kind: 'backfill', cursor: 'next' })
  if (!second) throw new Error('next page was not queued')
  expect(await runSlackIngestJob(second.job, ports)).toBe('completed')
  expect((await store.getChannel(WS, CHANNEL))?.backfill).toEqual({ status: 'completed', importedCount: 3 })
  expect(queued).toEqual([])

  // A user other than the bot joining does nothing.
  expect(await runSlackIngestJob({
    kind: 'event', workspaceId: WS, eventId: 'Ev012349',
    event: { kind: 'member-joined', channelId: CHANNEL, userId: AUTHOR },
  }, ports)).toBe('ignored-member')
  // auth.test runs once a day, not once per job.
  expect(slack.calls.filter((call) => call === 'auth.test')).toHaveLength(1)
})

test('a Slack 429 queues the same job again after the delay', async () => {
  const { store, slack, queued, ports } = createWorld()
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await store.setChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, 0, audit)
  slack.historyError = new SlackRateLimitedError(42)
  const job: SlackIngestJob = { kind: 'backfill', workspaceId: WS, channelId: CHANNEL, mappingRevision: 1 }
  expect(await runSlackIngestJob(job, ports)).toBe('rate-limited')
  expect(queued).toEqual([{ job, delaySeconds: 42 }])
})

test('a 429 in the middle of a page resumes after the messages already loaded', async () => {
  const { store, slack, queued, ports } = createWorld()
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await store.setChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, 0, audit)
  const first = `${NOW.getTime() / 1000 - 600}.000100`
  const second = `${NOW.getTime() / 1000 - 1_200}.000100`
  slack.pages.set('', {
    messages: [
      { type: 'message', user: AUTHOR, ts: first, text: 'MK-1', thread_ts: first, reply_count: 1 },
      { type: 'message', user: AUTHOR, ts: second, text: 'MK-2', thread_ts: second, reply_count: 1 },
    ],
  })
  slack.threads.set(first, [{ type: 'message', user: AUTHOR, ts: `${NOW.getTime() / 1000 - 500}.000100`, text: 'r1', thread_ts: first }])
  slack.threads.set(second, [{ type: 'message', user: AUTHOR, ts: `${NOW.getTime() / 1000 - 1_100}.000100`, text: 'r2', thread_ts: second }])
  slack.repliesErrors.set(second, new SlackRateLimitedError(30))
  const job: SlackIngestJob = { kind: 'backfill', workspaceId: WS, channelId: CHANNEL, mappingRevision: 1 }

  expect(await runSlackIngestJob(job, ports)).toBe('rate-limited')
  expect(queued).toEqual([{ job: { ...job, resumeBeforeTs: first }, delaySeconds: 30 }])
  expect((await store.getChannel(WS, CHANNEL))?.backfill).toEqual({ status: 'running', importedCount: 3 })
  const retry = queued.shift()
  if (!retry) throw new Error('retry was not queued')
  slack.calls.length = 0
  expect(await runSlackIngestJob(retry.job, ports)).toBe('completed')
  // The retry asks only for the unfinished thread.
  expect(slack.calls.filter((call) => call === 'conversations.replies')).toHaveLength(1)
  expect((await store.getChannel(WS, CHANNEL))?.backfill).toEqual({ status: 'completed', importedCount: 4 })
})

test('a message write after an unmap is fenced out, and cleanup runs without the Slack app', async () => {
  const { store, queued, ports } = createWorld()
  const admin = { config: ports.config, store, queue: ports.queue }
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, admin, audit)
  await updateSlackChannelTarget(WS, CHANNEL, null, admin, audit)
  const message = {
    channelId: CHANNEL, ts: RECENT_TS, userId: AUTHOR, text: 'MK-1', version: RECENT_TS,
    keys: ['MK-1'], permalink: 'https://example.slack.com/x', expiresAt: 9_999_999_999,
  }
  expect(await store.putMessage(WS, message, 1)).toBe('unmapped')
  expect(store.messages.size).toBe(0)
  const purge = queued.find((entry) => entry.job.kind === 'prune')
  if (!purge) throw new Error('purge was not queued')
  const unconfigured = { ...ports, config: { read: async () => undefined } }
  expect(await runSlackIngestJob(purge.job, unconfigured)).toBe('pruned')
})

test('saving the same retention again queues its cleanup again', async () => {
  const { store, queued, ports } = createWorld()
  const admin = { config: ports.config, store, queue: ports.queue }
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, admin, audit)
  queued.length = 0
  await updateSlackIngestSettings(WS, { retentionDays: 14, expectedRevision: 0 }, admin, audit)
  await updateSlackIngestSettings(WS, { retentionDays: 14, expectedRevision: 1 }, admin, audit)
  expect(queued.filter((entry) => entry.job.kind === 'prune')).toHaveLength(2)
  queued.length = 0
  await updateSlackIngestSettings(WS, { retentionDays: 30, expectedRevision: 2 }, admin, audit)
  expect(queued).toEqual([])
})

test('a shorter retention also shortens the expiry of messages it keeps', async () => {
  const { store, queued, ports } = createWorld()
  const admin = { config: ports.config, store, queue: ports.queue }
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, admin, audit)
  await runSlackIngestJob(posted(RECENT_TS, 'MK-1 new'), ports)
  queued.length = 0
  await updateSlackIngestSettings(WS, { retentionDays: 7, expectedRevision: 0 }, admin, audit)
  const prune = queued.shift()
  if (!prune) throw new Error('prune was not queued')
  expect(await runSlackIngestJob(prune.job, ports)).toBe('pruned')
  const [kept] = await store.getMessages(WS, [{ channelId: CHANNEL, ts: RECENT_TS }])
  expect(kept?.expiresAt).toBe(Math.floor(Number(RECENT_TS)) + 7 * 86_400)
})

test('retrying a saved change that could not queue its job queues it instead of conflicting', async () => {
  const { store, queued, ports } = createWorld()
  let failSend = true
  const flakyQueue = {
    async send(job: SlackIngestJob, delaySeconds?: number) {
      if (failSend) throw new Error('queue down')
      await ports.queue.send(job, delaySeconds)
    },
  }
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  const admin = { config: ports.config, store, queue: flakyQueue }
  await expect(updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, admin, audit))
    .rejects.toMatchObject({ code: 'SlackIngestQueueUnavailable' })
  failSend = false
  // The retry reuses the audit event, so the store reports a conflict for the same target.
  store.setChannelTarget = async () => {
    throw new SlackIngestError('conflict', 'SlackChannelMappingConflict', 'The channel changed.')
  }
  const retried = await updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, admin, audit)
  expect(retried.target).toEqual({ kind: 'team', teamId: 'team-a' })
  expect(queued.map((entry) => entry.job.kind)).toEqual(['backfill'])
  await expect(updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-b' }, admin, audit))
    .rejects.toMatchObject({ code: 'SlackChannelMappingConflict' })
})

test('a superseded backfill stops, and jobs for another Workspace end', async () => {
  const { store, ports } = createWorld()
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await store.setChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, 0, audit)
  expect(await runSlackIngestJob({ kind: 'backfill', workspaceId: WS, channelId: CHANNEL, mappingRevision: 0 }, ports)).toBe('superseded')
  expect(await runSlackIngestJob({ kind: 'backfill', workspaceId: 'other', channelId: CHANNEL, mappingRevision: 1 }, ports)).toBe('not-configured')
  const closing = { ...ports, isWorkspaceActive: async () => false }
  expect(await runSlackIngestJob({ kind: 'backfill', workspaceId: WS, channelId: CHANNEL, mappingRevision: 1 }, closing)).toBe('workspace-inactive')
})

test('a cleanup queued before a remap does not delete what the new mapping keeps', async () => {
  const { store, queued, ports } = createWorld()
  const admin = { config: ports.config, store, queue: ports.queue }
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, admin, audit)
  await updateSlackChannelTarget(WS, CHANNEL, null, admin, audit)
  await updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-b' }, admin, audit)
  await runSlackIngestJob(posted(RECENT_TS, 'MK-1 kept'), ports)
  const purge = queued.find((entry) => entry.job.kind === 'prune')
  if (!purge) throw new Error('purge was not queued')
  expect(await runSlackIngestJob(purge.job, ports)).toBe('superseded')
  expect((await store.listMessageRefsByKey(WS, 'MK-1', 10)).refs).toHaveLength(1)
})

test('unmapping deletes stored messages and a shorter retention prunes old ones', async () => {
  const { store, queued, ports } = createWorld()
  const admin = { config: ports.config, store, queue: ports.queue }
  await store.recordMembership(WS, { channelId: CHANNEL, isPrivate: false, membership: 'joined', now: NOW.toISOString() })
  await updateSlackChannelTarget(WS, CHANNEL, { kind: 'team', teamId: 'team-a' }, admin, audit)
  queued.length = 0
  const older = `${NOW.getTime() / 1000 - 20 * 86_400}.000000`
  await runSlackIngestJob(posted(older, 'MK-1 old'), ports)
  await runSlackIngestJob(posted(RECENT_TS, 'MK-1 new'), ports)

  expect(await updateSlackIngestSettings(WS, { retentionDays: 14, expectedRevision: 0 }, admin, audit))
    .toEqual({ retentionDays: 14, settingsRevision: 1 })
  const prune = queued.shift()
  expect(prune?.job).toEqual({ kind: 'prune', workspaceId: WS, channelId: CHANNEL, mode: 'expired', mappingRevision: 1 })
  if (!prune) throw new Error('prune was not queued')
  expect(await runSlackIngestJob(prune.job, ports)).toBe('pruned')
  expect((await store.listMessageRefsByKey(WS, 'MK-1', 10)).refs).toEqual([{ channelId: CHANNEL, ts: RECENT_TS }])

  await updateSlackChannelTarget(WS, CHANNEL, null, admin, audit)
  const purge = queued.shift()
  expect(purge?.job).toEqual({ kind: 'prune', workspaceId: WS, channelId: CHANNEL, mode: 'all', mappingRevision: 2 })
  if (!purge) throw new Error('purge was not queued')
  expect(await runSlackIngestJob(purge.job, ports)).toBe('pruned')
  expect(store.messages.size).toBe(0)
  await expect(updateSlackIngestSettings(WS, { retentionDays: 30, expectedRevision: 0 }, admin, audit)).rejects.toMatchObject({ code: 'SlackIngestSettingsConflict' })
})

test('a Work Item lists only messages in channels the caller can read, newest first', async () => {
  const { store, ports } = createWorld()
  const visible = 'C0VISIBLE1'
  const hidden = 'C0HIDDEN01'
  for (const [channelId, teamId] of [[visible, 'team-a'], [hidden, 'team-b']] as const) {
    await store.recordMembership(WS, { channelId, name: channelId.toLowerCase(), isPrivate: false, membership: 'joined', now: NOW.toISOString() })
    await store.setChannelTarget(WS, channelId, { kind: 'team', teamId }, 0, audit)
  }
  const older = `${NOW.getTime() / 1000 - 7_200}.000000`
  for (const [channelId, ts] of [[visible, older], [visible, RECENT_TS], [hidden, RECENT_TS]] as const) {
    await store.putMessage(WS, {
      channelId, ts, userId: AUTHOR, text: 'MK-9', version: ts, keys: ['MK-9'], permalink: 'https://example.slack.com/x', expiresAt: 9_999_999_999,
    }, 1)
  }
  const result = await listWorkItemSlackMessages(WS, 'MK-9', {
    store,
    canReadTarget: async (target) => target.teamId === 'team-a',
    now: () => NOW,
  })
  expect(result.truncated).toBe(false)
  expect(result.messages.map((message) => [message.channelId, message.ts])).toEqual([[visible, older], [visible, RECENT_TS]])
  expect(result.messages[0]).toMatchObject({ channelName: 'c0visible1', authorId: AUTHOR, text: 'MK-9' })
  expect((await listWorkItemSlackMessages(WS, 'MK-404', { store, canReadTarget: async () => true, now: () => NOW })).messages).toEqual([])
  expect(ports.config).toBeDefined()
})
