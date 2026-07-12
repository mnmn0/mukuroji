import type {
  TeamIssue,
  TeamIssueActivity,
  TeamIssueActivityEvent,
  TeamIssueComment,
} from './api'
import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'
import type { WorkspaceMember } from '../workspace/api'
import type { IssueCollaborationController } from './useIssueCollaboration'

/**
 * TeamIssuePage の Storybook と E2E で共有する Issue fixture です。
 */
export const teamIssueFixtures = [
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'onboarding-friction',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: '初回オンボーディングの離脱要因を減らす',
    description: '初回ログイン後に迷う導線を整理し、最初のプロジェクト作成までの摩擦を下げる。',
    assigneeUserId: 'sato@example.com',
    assigneeEmail: 'sato@example.com',
    assigneeName: '佐藤 花子',
    status: 'in-progress',
    dueDate: '2026/06/18',
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    source: 'dynamodb',
  },
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'billing-copy',
    teamId: 'core-team',
    title: '料金導線の説明不足を解消する',
    description: '料金ページでプラン差分が判断しづらい状態を解消する。',
    assigneeUserId: 'suzuki@example.com',
    assigneeEmail: 'suzuki@example.com',
    assigneeName: '鈴木 大輔',
    status: 'todo',
    dueDate: '2026/06/21',
    priority: 'medium',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    source: 'dynamodb',
  },
] satisfies TeamIssue[]

/**
 * Issue 詳細 Story で表示するコメント fixture です。
 */
export const teamIssueCommentFixtures = [
  {
    id: 'comment-1',
    rootCommentId: 'comment-1',
    authorMemberKey: 'demo@example.com',
    bodyMarkdown: '**判断待ち**の項目を整理しました。\n\n- [x] 空状態を確認\n- [ ] @佐藤 花子 さんがプロジェクト作成導線を確認',
    version: 2,
    createdAt: '2026-06-08T01:00:00.000Z',
    updatedAt: '2026-06-08T01:10:00.000Z',
    editedAt: '2026-06-08T01:10:00.000Z',
    mentionMemberKeys: ['sato@example.com'],
    reactions: [
      { emoji: '👍', count: 2, reactedByMe: true },
      { emoji: '👀', count: 1, reactedByMe: false },
    ],
    capabilities: { canEdit: true, canDelete: true, canResolve: true },
  },
  {
    id: 'comment-2',
    rootCommentId: 'comment-1',
    parentCommentId: 'comment-1',
    authorMemberKey: 'sato@example.com',
    bodyMarkdown: '確認しました。`empty-state` の表示条件も一緒にテストします。',
    version: 1,
    createdAt: '2026-06-08T01:20:00.000Z',
    updatedAt: '2026-06-08T01:20:00.000Z',
    mentionMemberKeys: [],
    reactions: [],
    capabilities: { canEdit: false, canDelete: false, canResolve: false },
  },
] satisfies TeamIssueComment[]

/**
 * Issue 詳細 Story で表示する活動履歴 fixture です。
 */
export const teamIssueActivityFixtures = [
  {
    id: 'activity-1',
    type: 'created',
    actorUserId: 'demo@example.com',
    summary: 'Issue was created.',
    createdAt: '2026-06-08T00:00:00.000Z',
  },
  {
    id: 'activity-2',
    type: 'commented',
    actorUserId: 'demo@example.com',
    summary: 'Comment was added.',
    createdAt: '2026-06-08T01:00:00.000Z',
  },
] satisfies TeamIssueActivity[]

/**
 * collaboration panel が actor 表示と mention 候補に使う Workspace member fixture です。
 */
export const collaborationWorkspaceMemberFixtures = [
  {
    id: 'demo@example.com',
    memberKey: 'demo@example.com',
    email: 'demo@example.com',
    name: 'Demo User',
    role: 'owner',
    status: 'active',
    version: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  },
  {
    id: 'sato@example.com',
    memberKey: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    role: 'member',
    status: 'active',
    version: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  },
  {
    id: 'former@example.com',
    memberKey: 'former@example.com',
    email: 'former@example.com',
    name: '旧メンバー',
    role: 'member',
    status: 'deactivated',
    version: 2,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    deactivatedAt: '2026-06-08T00:00:00.000Z',
  },
] satisfies WorkspaceMember[]

/**
 * Storybook で append-only activity を表示する fixture です。
 */
export const teamIssueCollaborationActivityFixtures = [
  {
    eventId: 'event-comment-created',
    eventType: 'comment.created',
    occurredAt: '2026-06-08T01:00:00.000Z',
    actorUserId: 'demo@example.com',
  },
  {
    eventId: 'event-comment-edited',
    eventType: 'comment.edited',
    occurredAt: '2026-06-08T01:10:00.000Z',
    actorUserId: 'demo@example.com',
  },
] satisfies TeamIssueActivityEvent[]

/**
 * API に接続せず collaboration panel を操作できる Storybook controller です。
 */
export const issueCollaborationControllerFixture = {
  activity: teamIssueCollaborationActivityFixtures,
  capabilities: { canComment: true, canReact: true, canWatch: true },
  comments: teamIssueCommentFixtures,
  watch: {
    subscribed: true,
    explicit: false,
    automatic: true,
    reasons: ['commented'],
    watcherCount: 4,
    projectSubscribed: true,
    projectWatcherCount: 8,
  },
  presence: [
    { memberKey: 'sato@example.com', typing: true, lastSeenAt: '2026-06-08T01:21:00.000Z' },
  ],
  isLoading: false,
  isLoadingMore: false,
  isActivityLoading: false,
  isLoadingMoreActivity: false,
  hasMore: true,
  hasMoreActivity: false,
  hasLoadError: false,
  hasActivityLoadError: false,
  hasMutationError: false,
  replyPagination: {},
  createComment: async () => true,
  updateComment: async () => true,
  deleteComment: async () => true,
  setResolved: async () => true,
  toggleReaction: async () => true,
  toggleProjectWatch: async () => true,
  toggleWatch: async () => true,
  loadMore: async () => undefined,
  loadMoreActivity: async () => undefined,
  loadMoreReplies: async () => undefined,
  markTyping: () => undefined,
  refresh: async () => undefined,
} satisfies IssueCollaborationController
