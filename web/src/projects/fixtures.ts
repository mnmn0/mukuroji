import type { ProjectRaidEntry } from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from './api'

/**
 * DashboardPage、TaskPage、Storybook で使うチーム/プロジェクト directory fixture です。
 */
export const projectDirectoryFixtures = [
  {
    id: 'core-team',
    name: 'コアチーム',
    expanded: true,
    projects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'product-roadmap', name: 'プロダクトロードマップ', tone: 'yellow' },
      { id: 'shared-launch', name: '共通ローンチ', tone: 'green' },
    ],
  },
  {
    id: 'design-team',
    name: 'デザインチーム',
    expanded: true,
    projects: [
      { id: 'shared-launch', name: '共通ローンチ', tone: 'purple' },
      { id: 'brand-refresh', name: 'ブランド刷新', tone: 'yellow' },
    ],
  },
] satisfies ProjectDirectoryTeam[]

/**
 * Project log entries of the Refero Project: open risks and issues of each severity, an
 * awaiting change request, and decided change requests.
 */
export const projectRaidLogFixtures: ProjectRaidEntry[] = [
  {
    id: 'risk-vendor',
    kind: 'risk',
    title: '主要部品のベンダー納期遅延',
    probability: 4,
    impact: 5,
    response: '代替ベンダーと並行で見積もりを取る。',
    reviewDueDate: '2026-06-05',
    status: 'open',
    revision: 2,
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 'issue-staging',
    kind: 'issue',
    title: 'ステージング環境のビルドが失敗する',
    impact: 3,
    reviewDueDate: '2026-06-20',
    status: 'open',
    revision: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
  },
  {
    id: 'risk-capacity',
    kind: 'risk',
    title: 'QA 要員が 7 月に不足する',
    probability: 2,
    impact: 2,
    status: 'open',
    revision: 1,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
  },
  {
    id: 'cr-export',
    kind: 'change-request',
    title: 'CSV 出力を範囲に追加',
    impact: 3,
    status: 'open',
    revision: 1,
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
  },
  {
    id: 'cr-report',
    kind: 'change-request',
    title: '帳票出力を範囲に追加',
    impact: 5,
    response: '次フェーズで対応することで合意。',
    status: 'closed',
    revision: 3,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    closedAt: '2026-06-02T00:00:00.000Z',
  },
  {
    id: 'risk-closed',
    kind: 'risk',
    title: '認証基盤の移行',
    probability: 3,
    impact: 4,
    status: 'closed',
    revision: 2,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    closedAt: '2026-05-25T00:00:00.000Z',
  },
]
