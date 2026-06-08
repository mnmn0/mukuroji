import type { Meta, StoryObj } from '@storybook/react-vite'
import { TaskScreen } from './TaskPage'
import { projectDirectoryFixtures } from '../projects/fixtures'
import type { ProjectMember } from '../projects/api'
import { referoTaskFixtures } from '../tasks/fixtures'

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

const meta = {
  title: 'Application/Projects/Task Page',
  component: TaskScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    locale: 'ja',
    assigneeOptions,
    projectId: 'refero',
    projectName: 'Refero',
    onCreateProject: async () => undefined,
    onCreateTeam: async () => undefined,
    tasks: referoTaskFixtures,
    teamName: 'コアチーム',
    teams: projectDirectoryFixtures,
    userInitial: 'J',
  },
} satisfies Meta<typeof TaskScreen>

/**
 * TaskScreen を fullscreen layout で確認する Storybook metadata です。
 */
export default meta

/**
 * タスク専用画面 Story の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * DynamoDB から取得したタスク一覧を表示する標準状態です。
 */
export const Default: Story = {}

/**
 * 認証とタスク取得中の loading 表示です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
  },
}

/**
 * 英語 locale でタスク一覧を表示する状態です。
 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}

/**
 * Lambda API の取得失敗を表示する状態です。
 */
export const LoadingError: Story = {
  args: {
    taskErrorMessage: 'Lambda returned 500.',
    tasks: [],
  },
}
