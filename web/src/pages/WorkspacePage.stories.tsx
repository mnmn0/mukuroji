import type { Meta, StoryObj } from '@storybook/react-vite'
import type { DashboardSummary } from '../auth/api'
import { projectDirectoryFixtures } from '../projects/fixtures'
import { referoTaskFixtures } from '../tasks/fixtures'
import { WorkspaceScreen } from './WorkspacePage'

const storySummary: DashboardSummary = {
  projects: 9,
  tasks: 27,
  blocked: 3,
  updatedAt: '2026-06-03T00:00:00.000Z',
  source: 'dynamodb',
}

const defaultArgs = {
  activeTeamId: 'core-team',
  fontSizePreference: 'standard',
  locale: 'ja',
  summary: storySummary,
  tasks: referoTaskFixtures,
  teams: projectDirectoryFixtures,
  onCreateProject: async () => undefined,
  onCreateTeam: async () => undefined,
  onFontSizePreferenceChange: () => undefined,
  onOpenTask: () => undefined,
  userInitial: 'D',
  userLabel: 'demo@example.com',
  view: 'home',
} satisfies Partial<Parameters<typeof WorkspaceScreen>[0]>

const crowdedTasks = Array.from({ length: 18 }, (_, index) => {
  const baseTask = referoTaskFixtures[index % referoTaskFixtures.length]

  return {
    ...baseTask,
    id: `${baseTask.id}-${index + 1}`,
    title: `${index + 1}. ${index % 2 === 0 ? '長い名前の依存関係レビューと承認待ちタスク' : 'Design QA / release queue follow-up'} ${index + 1}`,
    status: (['todo', 'in-progress', 'review', 'done'] as const)[index % 4],
    priority: (['high', 'medium', 'low'] as const)[index % 3],
    projectId: index % 2 === 0 ? 'refero' : 'brand-refresh',
    source: 'dynamodb' as const,
    teamId: index % 2 === 0 ? 'core-team' : 'marketing',
  }
})

/**
 * WorkspaceScreen の Storybook meta です。ワークスペース各画面の単体確認に使います。
 */
const meta = {
  title: 'Application/Pages/WorkspacePage',
  component: WorkspaceScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: defaultArgs,
} satisfies Meta<typeof WorkspaceScreen>

export default meta

/**
 * WorkspaceScreen stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * サイドバーのホーム画面です。
 */
export const Home: Story = {}

/**
 * マイタスクのカンバン画面です。
 */
export const MyTasks: Story = {
  args: {
    view: 'my-tasks',
  },
}

/**
 * 混雑したカンバン列で密度とスクロールを確認する状態です。
 */
export const CrowdedKanban: Story = {
  args: {
    tasks: crowdedTasks,
    view: 'my-tasks',
  },
}

/**
 * マイタスク移動失敗時の alert 表示です。
 */
export const MoveError: Story = {
  args: {
    taskMoveErrorMessage: 'タスクの状態を更新できませんでした。',
    view: 'my-tasks',
  },
}

/**
 * 長いタスク名とプロジェクト名を含む判断キューです。
 */
export const LongNames: Story = {
  args: {
    tasks: crowdedTasks.slice(0, 8),
    view: 'home',
  },
}

/**
 * comfortable font preference で表示する作業台です。
 */
export const ComfortableFont: Story = {
  args: {
    fontSizePreference: 'comfortable',
    tasks: crowdedTasks.slice(0, 10),
  },
}

/**
 * 受信箱の判断キュー画面です。
 */
export const Inbox: Story = {
  args: {
    view: 'inbox',
  },
}

/**
 * ポートフォリオダッシュボード画面です。
 */
export const Dashboard: Story = {
  args: {
    view: 'dashboard',
  },
}

/**
 * レポート画面です。
 */
export const Reports: Story = {
  args: {
    view: 'reports',
  },
}

/**
 * 表示設定を含む設定画面です。
 */
export const Settings: Story = {
  args: {
    view: 'settings',
  },
}

/**
 * チーム概要画面です。
 */
export const TeamOverview: Story = {
  args: {
    view: 'team-overview',
  },
}

/**
 * チームメンバー画面です。
 */
export const TeamMembers: Story = {
  args: {
    view: 'team-members',
  },
}

/**
 * 認証と API 確認中の loading 表示です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
  },
}

/**
 * 英語 locale でワークスペースを表示する状態です。
 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}
