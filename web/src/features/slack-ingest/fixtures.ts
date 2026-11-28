import type { SlackIngestStatusResponse, SlackMessageView } from '@mukuroji/contracts'
import type { SlackIngestTeamOption } from './ui/SlackIngestPanel'

/** Teams offered as channel targets in stories. */
export const slackIngestTeamsFixture: SlackIngestTeamOption[] = [
  {
    id: 'core-team',
    name: 'Core',
    projects: [
      { id: 'refero', name: 'Refero' },
      { id: 'billing', name: '請求基盤の刷新' },
    ],
  },
]

/** Status of a Workspace with the Slack app set up and three channels. */
export const slackIngestStatusFixture: SlackIngestStatusResponse = {
  configured: true,
  workspaceId: 'workspace-demo',
  slackTeamId: 'T012345678',
  retentionDays: 90,
  settingsRevision: 2,
  channels: [
    {
      channelId: 'C0000000001',
      name: 'core-dev',
      isPrivate: false,
      membership: 'joined',
      target: { kind: 'team', teamId: 'core-team' },
      backfill: { status: 'completed', importedCount: 412 },
      updatedAt: '2026-11-27T09:00:00.000Z',
    },
    {
      channelId: 'G0000000002',
      name: 'billing-leads',
      isPrivate: true,
      membership: 'joined',
      target: { kind: 'project', teamId: 'core-team', projectId: 'billing' },
      backfill: { status: 'running', importedCount: 180 },
      updatedAt: '2026-11-28T01:00:00.000Z',
    },
    {
      channelId: 'C0000000003',
      name: 'random',
      isPrivate: false,
      membership: 'joined',
      updatedAt: '2026-11-28T01:10:00.000Z',
    },
  ],
}

/** Messages that mention a Work Item key. */
export const workItemSlackMessagesFixture: SlackMessageView[] = [
  {
    channelId: 'C0000000001',
    channelName: 'core-dev',
    ts: '1764291600.000200',
    threadTs: '1764288000.000100',
    authorId: 'U0000000001',
    authorName: '佐藤 花子',
    text: 'CORE-42 のレビュー指摘は直しました。明日リリースできます。',
    postedAt: '2025-11-28T01:00:00.000Z',
    permalink: 'https://example.slack.com/archives/C0000000001/p1764291600000200?thread_ts=1764288000.000100&cid=C0000000001',
  },
  {
    channelId: 'C0000000001',
    channelName: 'core-dev',
    ts: '1764288000.000100',
    authorId: 'U0000000002',
    authorName: 'Ken',
    text: 'CORE-42 のステージング確認お願いします',
    postedAt: '2025-11-28T00:00:00.000Z',
    editedAt: '2025-11-28T00:05:00.000Z',
    permalink: 'https://example.slack.com/archives/C0000000001/p1764288000000100',
  },
]
