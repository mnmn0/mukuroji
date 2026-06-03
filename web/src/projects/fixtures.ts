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
