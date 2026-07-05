import type { Meta, StoryObj } from '@storybook/react-vite'
import { TeamIssueScreen } from './TeamIssuePage'
import {
  teamIssueActivityFixtures,
  teamIssueCommentFixtures,
  teamIssueFixtures,
} from '../issues/fixtures'
import type { ProjectMember } from '../projects/api'
import { projectDirectoryFixtures } from '../projects/fixtures'

const assigneeOptions: ProjectMember[] = [
  {
    id: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
  },
  {
    id: 'suzuki@example.com',
    email: 'suzuki@example.com',
    name: '鈴木 大輔',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
  },
]

const legacyIssues = teamIssueFixtures.map((issue) => ({
  ...issue,
  source: 'legacy' as const,
}))

const crowdedIssues = Array.from({ length: 20 }, (_, index) => {
  const baseIssue = teamIssueFixtures[index % teamIssueFixtures.length]

  return {
    ...baseIssue,
    id: `${baseIssue.id}-crowded-${index + 1}`,
    title: `${index + 1}. ${index % 2 === 0 ? '長い Issue 名の依存関係と担当者確認を完了する' : 'Operational backlog triage with release note follow-up'} ${index + 1}`,
    assignedProjectId: index % 2 === 0 ? 'refero' : 'brand-refresh',
    status: (['todo', 'in-progress', 'review', 'done'] as const)[index % 4],
    priority: (['high', 'medium', 'low'] as const)[index % 3],
  }
})

const meta = {
  title: 'Application/Teams/Issue Page',
  component: TeamIssueScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    locale: 'ja',
    activity: teamIssueActivityFixtures,
    assigneeOptions,
    comments: teamIssueCommentFixtures,
    issues: teamIssueFixtures,
    selectedIssueId: 'onboarding-friction',
    teamId: 'core-team',
    teamName: 'コアチーム',
    teams: projectDirectoryFixtures,
    userInitial: 'J',
  },
} satisfies Meta<typeof TeamIssueScreen>

/**
 * TeamIssueScreen を fullscreen layout で確認する Storybook metadata です。
 */
export default meta

/**
 * チーム Issue 画面 Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * チーム所有 Issue を一覧と詳細ペインで表示する標準状態です。
 */
export const Default: Story = {}

/**
 * TaskPage の詳細ペインと視覚密度を比較するための詳細選択状態です。
 */
export const DetailPaneAlignment: Story = {
  args: {
    selectedIssueId: 'onboarding-friction',
  },
}

/**
 * Issue board view の初期表示です。
 */
export const Board: Story = {
  args: {
    initialViewMode: 'board',
  },
}

/**
 * Issue 作成フォームを開いた状態です。
 */
export const CreateOpen: Story = {
  args: {
    defaultCreateIssueOpen: true,
  },
}

/**
 * legacy Issue の読み取り専用詳細です。
 */
export const LegacyReadOnly: Story = {
  args: {
    issues: legacyIssues,
    selectedIssueId: 'onboarding-friction',
  },
}

/**
 * Issue 詳細取得失敗時の表示です。
 */
export const DetailError: Story = {
  args: {
    detailErrorMessage: 'Issue 詳細を取得できませんでした。',
  },
}

/**
 * 詳細ペインで Issue が未選択の状態です。
 */
export const Unselected: Story = {
  args: {
    selectedIssueId: undefined,
  },
}

/**
 * 長い Issue 名と混雑データの表示です。
 */
export const LongCrowdedData: Story = {
  args: {
    issues: crowdedIssues,
    selectedIssueId: 'onboarding-friction-crowded-1',
  },
}

/**
 * Issue が未登録の空状態です。
 */
export const Empty: Story = {
  args: {
    activity: [],
    comments: [],
    issues: [],
    selectedIssueId: undefined,
  },
}

/**
 * Issue 一覧取得失敗時の表示です。
 */
export const LoadingError: Story = {
  args: {
    issueErrorMessage: 'Issue 一覧を取得できませんでした',
    issues: [],
    selectedIssueId: undefined,
  },
}
