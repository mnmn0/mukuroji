import type {
  TeamIssue,
  TeamIssueActivity,
  TeamIssueActivityEvent,
  TeamIssueComment,
} from './api'
import {
  COLLABORATION_CONTEXT_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import type {
  AcceptedResolution,
  CuratedContextItem,
} from '@mukuroji/contracts'
import type { WorkspaceMember } from '../workspace/api'
import type { IssueCollaborationController } from './mutations/useIssueCollaboration'
import type { IssueContextController } from './mutations/useIssueContext'

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
    creatorMemberKey: 'sato@example.com',
    assigneeEmail: 'sato@example.com',
    assigneeName: '佐藤 花子',
    workflowStatusId: 'active',
    statusCategory: 'started',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-18',
    schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
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
    creatorMemberKey: 'suzuki@example.com',
    assigneeEmail: 'suzuki@example.com',
    assigneeName: '鈴木 大輔',
    workflowStatusId: 'backlog',
    statusCategory: 'backlog',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-21',
    schedule: createDefaultDueDateWorkItemSchedule('2026-06-21'),
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
    resolvedAt: '2026-06-08T01:30:00.000Z',
    resolvedByMemberKey: 'demo@example.com',
    acceptedResolutions: [
      {
        id: 'resolution-current',
        sourceCommentId: 'comment-2',
        sourceRootCommentId: 'comment-1',
        capturedCommentRevision: 1,
        capturedCommentBody: '確認しました。`empty-state` の表示条件も一緒にテストします。',
        summary: '空状態の表示条件を含めてモバイルとデスクトップで確認する。',
        acceptedBy: { id: 'demo@example.com', displayName: 'Demo User' },
        acceptedAt: '2026-06-08T01:30:00.000Z',
        state: 'accepted',
      },
    ],
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
 * Independently fetched accepted-resolution history used by Storybook.
 */
export const acceptedResolutionHistoryFixtures = [
  {
    id: 'resolution-old',
    sourceCommentId: 'comment-1',
    sourceRootCommentId: 'comment-1',
    capturedCommentRevision: 1,
    capturedCommentBody: '判断待ちの項目を整理しました。',
    summary: '旧案では説明文だけを更新する。',
    acceptedBy: { id: 'demo@example.com', displayName: 'Demo User' },
    acceptedAt: '2026-06-08T01:12:00.000Z',
    state: 'superseded',
    supersededByResolutionId: 'resolution-current',
    supersededBy: { id: 'demo@example.com', displayName: 'Demo User' },
    supersededAt: '2026-06-08T01:30:00.000Z',
  },
] satisfies AcceptedResolution[]

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
 * Human-curated decision, action, risk, and retained-source fixtures.
 */
export const curatedContextItemFixtures = [
  {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: 'context-decision-1',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    kind: 'decision',
    state: 'accepted',
    title: '空状態からプロジェクト作成へ直接案内する',
    body: '初回利用者には説明文よりも、次の操作が明確な primary action を優先します。',
    source: {
      kind: 'comment',
      sourceId: 'comment-2',
      containerId: 'comment-1',
      originalBody: '確認しました。`empty-state` の表示条件も一緒にテストします。',
      quote: {
        text: '`empty-state` の表示条件も一緒にテストします。',
        startOffset: 7,
        endOffset: 37,
      },
      permalink: '?commentId=comment-2&rootCommentId=comment-1',
      actor: { id: 'sato@example.com', displayName: '佐藤 花子' },
      occurredAt: '2026-06-08T01:20:00.000Z',
      capturedRevision: 1,
      currentRevision: 1,
      availability: 'available',
    },
    mentionMemberKeys: ['sato@example.com'],
    createdBy: { id: 'demo@example.com', displayName: 'Demo User' },
    createdAt: '2026-06-08T01:25:00.000Z',
    updatedBy: { id: 'demo@example.com', displayName: 'Demo User' },
    updatedAt: '2026-06-08T01:25:00.000Z',
    revision: 1,
  },
  {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: 'context-action-1',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    kind: 'action',
    state: 'active',
    title: 'モバイル幅の空状態を確認する',
    body: '@佐藤 花子 が 390px 幅で操作と読み上げ順を確認します。',
    mentionMemberKeys: ['sato@example.com'],
    createdBy: { id: 'demo@example.com', displayName: 'Demo User' },
    createdAt: '2026-06-08T01:30:00.000Z',
    updatedBy: { id: 'sato@example.com', displayName: '佐藤 花子' },
    updatedAt: '2026-06-08T01:35:00.000Z',
    revision: 2,
  },
  {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: 'context-risk-old',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    kind: 'risk',
    state: 'superseded',
    title: '旧オンボーディング文言に依存している',
    body: 'この記録は新しい判断に置き換えられました。',
    mentionMemberKeys: [],
    createdBy: { id: 'demo@example.com', displayName: 'Demo User' },
    createdAt: '2026-06-07T09:00:00.000Z',
    updatedBy: { id: 'demo@example.com', displayName: 'Demo User' },
    updatedAt: '2026-06-08T01:25:00.000Z',
    revision: 2,
    supersededByItemId: 'context-decision-1',
  },
  {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: 'context-source-lost',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    kind: 'context',
    state: 'active',
    title: '顧客ヒアリングの引用',
    body: '外部会話の権限が失われても、採用時の引用と出典情報を保持します。',
    source: {
      kind: 'external-chat',
      sourceId: 'message-42',
      containerId: 'channel-customer-research',
      quote: { text: '最初に何をすればよいか分かりませんでした。' },
      permalink: 'https://example.com/messages/42',
      actor: { id: 'external-customer', displayName: 'Research participant' },
      occurredAt: '2026-06-05T03:00:00.000Z',
      capturedRevision: '1717556400.000100',
      availability: 'permission-lost',
      availabilityReason: 'The connected account no longer has access to this channel.',
    },
    mentionMemberKeys: [],
    createdBy: { id: 'demo@example.com', displayName: 'Demo User' },
    createdAt: '2026-06-08T01:40:00.000Z',
    updatedBy: { id: 'demo@example.com', displayName: 'Demo User' },
    updatedAt: '2026-06-08T01:40:00.000Z',
    revision: 1,
  },
] satisfies CuratedContextItem[]

/**
 * Immutable snapshots for the edited action fixture, newest revision first.
 */
export const curatedContextRevisionFixtures = [
  {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: 'context-action-1',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    kind: 'action',
    state: 'active',
    title: 'モバイル幅の空状態を確認する',
    body: '@佐藤 花子 が 390px 幅で操作と読み上げ順を確認します。',
    mentionMemberKeys: ['sato@example.com'],
    createdBy: { id: 'demo@example.com', displayName: 'Demo User' },
    createdAt: '2026-06-08T01:30:00.000Z',
    updatedBy: { id: 'sato@example.com', displayName: '佐藤 花子' },
    updatedAt: '2026-06-08T01:35:00.000Z',
    revision: 2,
  },
  {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: 'context-action-1',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    kind: 'action',
    state: 'active',
    title: '顧客ヒアリングを確認する',
    body: '権限付きのヒアリング記録を根拠として確認します。',
    source: {
      kind: 'external-chat',
      sourceId: 'private-message-7',
      containerId: 'private-research',
      actor: { id: 'participant-7', displayName: 'Research participant' },
      occurredAt: '2026-06-07T02:00:00.000Z',
      capturedRevision: '1717725600.000700',
      availability: 'permission-lost',
      availabilityReason: 'The viewer no longer has permission to this source.',
    },
    mentionMemberKeys: [],
    createdBy: { id: 'demo@example.com', displayName: 'Demo User' },
    createdAt: '2026-06-08T01:30:00.000Z',
    updatedBy: { id: 'demo@example.com', displayName: 'Demo User' },
    updatedAt: '2026-06-08T01:30:00.000Z',
    revision: 1,
  },
] satisfies CuratedContextItem[]

/**
 * Storybook context controller with deterministic create, edit, replace, and resolution actions.
 */
export const issueContextControllerFixture = {
  items: curatedContextItemFixtures,
  capabilities: {
    canAcceptResolution: true,
    canCreate: true,
    canEdit: true,
    canReplace: true,
  },
  isLoading: false,
  isLoadingMore: false,
  hasMore: true,
  hasLoadError: false,
  hasMutationError: false,
  revisionHistory: {
    items: [],
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    hasLoadError: false,
  },
  acceptedResolutionHistory: {
    items: [],
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    hasLoadError: false,
  },
  createItem: async () => true,
  updateItem: async () => true,
  setAcceptedResolution: async () => true,
  openRevisionHistory: () => undefined,
  closeRevisionHistory: () => undefined,
  loadMoreRevisions: async () => undefined,
  retryRevisionHistory: async () => undefined,
  openAcceptedResolutionHistory: () => undefined,
  closeAcceptedResolutionHistory: () => undefined,
  loadMoreAcceptedResolutions: async () => undefined,
  retryAcceptedResolutionHistory: async () => undefined,
  loadMore: async () => undefined,
  refresh: async () => undefined,
} satisfies IssueContextController

/**
 * API に接続せず collaboration panel を操作できる Storybook controller です。
 */
export const issueCollaborationControllerFixture = {
  activity: teamIssueCollaborationActivityFixtures,
  capabilities: { canComment: true, canReact: true, canWatch: true },
  comments: teamIssueCommentFixtures,
  context: issueContextControllerFixture,
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
