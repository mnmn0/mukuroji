import type { ProjectRaidEntry, ProjectStatusReport, ProjectStatusShare } from '@mukuroji/contracts'
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

/** Status report of the Refero Project used by the report dialog and public page stories. */
export const projectStatusReportFixture: ProjectStatusReport = {
  schemaVersion: 1,
  locale: 'ja',
  projectName: 'Refero',
  teamName: 'コアチーム',
  asOf: '2026-11-23T03:00:00.000Z',
  health: {
    health: 'at-risk',
    risk: 'medium',
    summary: '結合試験が1週間遅れています。\n検収日程を顧客と調整中です。',
    publishedAt: '2026-11-22T09:00:00.000Z',
    authorName: '佐藤 リード',
  },
  schedule: {
    items: [
      { type: 'milestone', title: '結合試験完了', status: 'active', health: 'at-risk', progress: 60, forecastEndDate: '2026-12-08', baselineEndDate: '2026-12-01', delayDays: 7 },
      { type: 'release', title: '本番リリース', status: 'planned', health: 'on-track', progress: 0, forecastEndDate: '2027-01-15', baselineEndDate: '2027-01-15', delayDays: 0 },
    ],
    hiddenCount: 0,
    delayedCount: 1,
  },
  progress: { totalCount: 24, openCount: 14, inProgressCount: 6, doneCount: 10, completionRate: 42, overdueCount: 2, blockedCount: 1 },
  risks: {
    openRiskCount: 2,
    openIssueCount: 1,
    pendingDecisionCount: 1,
    items: [{ kind: 'risk', title: 'ベンダー納期の遅れ', severity: 'high', response: '代替ベンダーを確保する', reviewDueDate: '2026-11-28' }],
    hiddenCount: 2,
  },
  nextActions: {
    items: [
      { text: '試験環境を増強する', dueDate: '2026-11-30', ownerName: '鈴木 開発', overdue: false },
      { text: 'ベンダーに納期を再確認する', dueDate: '2026-11-20', overdue: true },
    ],
    hiddenCount: 0,
  },
}

/** Share links of the Refero Project: one open and one revoked. */
export const projectStatusShareFixtures: ProjectStatusShare[] = [
  {
    id: 'pss_open',
    teamId: 'core-team',
    projectId: 'refero',
    label: '顧客A 定例',
    sections: ['health', 'schedule', 'progress'],
    showPeopleNames: false,
    expiresAt: '2027-12-07T03:00:00.000Z',
    createdAt: '2026-11-23T03:00:00.000Z',
    createdByMemberKey: 'lead',
    reportAsOf: '2026-11-23T03:00:00.000Z',
    viewCount: 3,
    lastViewedAt: '2026-11-23T05:00:00.000Z',
  },
  {
    id: 'pss_revoked',
    teamId: 'core-team',
    projectId: 'refero',
    label: '旧ベンダー',
    sections: ['progress'],
    showPeopleNames: false,
    expiresAt: '2027-12-01T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    createdByMemberKey: 'lead',
    reportAsOf: '2026-11-01T00:00:00.000Z',
    revokedAt: '2026-11-10T00:00:00.000Z',
    viewCount: 1,
  },
]
