import type { TeamIssue, TeamIssueActivity, TeamIssueComment } from './api'

/**
 * TeamIssuePage の Storybook と E2E で共有する Issue fixture です。
 */
export const teamIssueFixtures = [
  {
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
  },
  {
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
  },
] satisfies TeamIssue[]

/**
 * Issue 詳細 Story で表示するコメント fixture です。
 */
export const teamIssueCommentFixtures = [
  {
    id: 'comment-1',
    actorUserId: 'demo@example.com',
    body: 'ユーザー登録直後の空状態とプロジェクト作成導線を同時に確認します。',
    createdAt: '2026-06-08T01:00:00.000Z',
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
