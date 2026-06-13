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
  userInitial: 'D',
  userLabel: 'demo@example.com',
  view: 'home',
} satisfies Partial<Parameters<typeof WorkspaceScreen>[0]>

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
 * チームメンバー画面です。
 */
export const TeamMembers: Story = {
  args: {
    view: 'team-members',
  },
}
