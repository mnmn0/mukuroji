import type { Meta, StoryObj } from '@storybook/react-vite'
import { TaskScreen } from './TaskPage'
import type { TeamIssueDetail } from '../issues/api'
import {
  teamIssueActivityFixtures,
  teamIssueCommentFixtures,
} from '../issues/fixtures'
import { projectDirectoryFixtures } from '../projects/fixtures'
import type { ProjectMember, ProjectUser } from '../projects/api'
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

const projectUsers: ProjectUser[] = [
  {
    id: 'sato@example.com',
    username: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    enabled: true,
    status: 'CONFIRMED',
  },
  {
    id: 'viewer@example.com',
    username: 'viewer@example.com',
    email: 'viewer@example.com',
    name: 'Viewer User',
    enabled: true,
    status: 'CONFIRMED',
  },
]

const storyTasks = referoTaskFixtures.map((task, index) => ({
  ...task,
  assigneeUserId: index % 2 === 0 ? 'sato@example.com' : 'suzuki@example.com',
  projectId: 'refero',
  source: 'dynamodb' as const,
  teamId: 'core-team',
}))

const selectedIssueDetail: TeamIssueDetail = {
  activity: teamIssueActivityFixtures,
  comments: teamIssueCommentFixtures,
  issue: {
    id: 'wireframe',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    titleKey: 'tasks.item.wireframe',
    description: 'Refero の初回作業面を確認し、次に進める判断材料をそろえます。',
    assigneeUserId: 'sato@example.com',
    assigneeEmail: 'sato@example.com',
    assigneeName: '佐藤 花子',
    status: 'in-progress',
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    source: 'dynamodb',
  },
}

const meta = {
  title: 'Application/Projects/Task Page',
  component: TaskScreen,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    locale: 'ja',
    assigneeOptions,
    canManageProjectMembers: true,
    projectId: 'refero',
    projectMembers: assigneeOptions,
    projectName: 'Refero',
    projectUserQuery: '',
    projectUsers,
    onCreateProject: async () => undefined,
    onCreateTeam: async () => undefined,
    onCreateIssueComment: async () => undefined,
    onUpdateIssue: async () => undefined,
    tasks: storyTasks,
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
 * ボードビューを初期表示する状態です。
 */
export const Board: Story = {
  args: {
    initialTab: 'board',
  },
}

/**
 * ガントビューを初期表示する状態です。
 */
export const Gantt: Story = {
  args: {
    initialTab: 'gantt',
  },
}

/**
 * カレンダービューを初期表示する状態です。
 */
export const Calendar: Story = {
  args: {
    initialTab: 'calendar',
  },
}

/**
 * ファイルビューを初期表示する状態です。
 */
export const File: Story = {
  args: {
    initialTab: 'file',
  },
}

/**
 * 権限管理ビューを初期表示する状態です。
 */
export const Permissions: Story = {
  args: {
    initialTab: 'permissions',
  },
}

/**
 * 新規タスク作成パネルを開いた状態です。
 */
export const CreateOpen: Story = {
  args: {
    defaultCreateTaskOpen: true,
  },
}

/**
 * 詳細ペインでタスクを選択済みにした状態です。
 */
export const DetailSelected: Story = {
  args: {
    initialSelectedTaskId: 'wireframe',
    selectedIssueDetail,
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
