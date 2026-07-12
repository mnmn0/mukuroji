import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { TaskScreen } from './TaskPage'
import type { TeamIssueDetail } from '../issues/api'
import {
  collaborationWorkspaceMemberFixtures,
  issueCollaborationControllerFixture,
  teamIssueActivityFixtures,
  teamIssueCommentFixtures,
} from '../issues/fixtures'
import { projectDirectoryFixtures } from '../projects/fixtures'
import type { ProjectMember, ProjectUser } from '../projects/api'
import { referoTaskFixtures } from '../tasks/fixtures'
import { fileArtifactsControllerFixture } from '../files/fixtures'
import type { FileArtifactsController } from '../files/useFileArtifacts'

const projectFilesControllerFixture = {
  ...fileArtifactsControllerFixture,
  approvals: [],
  scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
} satisfies FileArtifactsController

const assigneeOptions: ProjectMember[] = [
  {
    id: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
    workspaceStatus: 'active',
  },
  {
    id: 'suzuki@example.com',
    email: 'suzuki@example.com',
    name: '鈴木 大輔',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
    workspaceStatus: 'active',
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
    workspaceStatus: 'active',
  },
  {
    id: 'viewer@example.com',
    username: 'viewer@example.com',
    email: 'viewer@example.com',
    name: 'Viewer User',
    enabled: true,
    status: 'CONFIRMED',
    workspaceStatus: 'active',
  },
]

const storyTasks = referoTaskFixtures.map((task, index) => ({
  ...task,
  assigneeUserId: index % 2 === 0 ? 'sato@example.com' : 'suzuki@example.com',
  assignedProjectId: 'refero',
  source: 'dynamodb' as const,
  teamId: 'core-team',
}))

const denseStoryTasks = Array.from({ length: 24 }, (_, index) => {
  const baseTask = storyTasks[index % storyTasks.length]

  return {
    ...baseTask,
    id: `${baseTask.id}-dense-${index + 1}`,
    title: `${index + 1}. ${index % 2 === 0 ? '長いラベルのワークストリーム確認と承認依頼' : 'Cross-functional launch readiness checklist'} ${index + 1}`,
    status: (['todo', 'in-progress', 'review', 'done'] as const)[index % 4],
    priority: (['high', 'medium', 'low'] as const)[index % 3],
  }
})

const legacyTasks = storyTasks.map((task) => ({
  ...task,
  source: 'legacy' as const,
}))

const selectedIssueDetail: TeamIssueDetail = {
  activity: teamIssueActivityFixtures,
  comments: teamIssueCommentFixtures,
  issue: {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
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
    collaboration: issueCollaborationControllerFixture,
    artifacts: fileArtifactsControllerFixture,
    currentWorkspaceMemberKey: 'demo@example.com',
    projectId: 'refero',
    projectFiles: projectFilesControllerFixture,
    projectMembers: assigneeOptions,
    projectName: 'Refero',
    projectUserQuery: '',
    projectUsers,
    onCreateProject: async () => undefined,
    onCreateTeam: async () => undefined,
    onCreateTask: async () => undefined,
    onUpdateIssue: async () => undefined,
    tasks: storyTasks,
    teamName: 'コアチーム',
    teams: projectDirectoryFixtures,
    userInitial: 'J',
    workspaceMembers: collaborationWorkspaceMemberFixtures,
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
 * 期限順リストを初期表示する状態です。
 */
export const DueDates: Story = {
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
 * タスクが未登録の空状態です。
 */
export const Empty: Story = {
  args: {
    tasks: [],
  },
}

/**
 * 作成フォームで担当者候補を読み込み中の状態です。
 */
export const AssigneeLoading: Story = {
  args: {
    defaultCreateTaskOpen: true,
    isAssigneeOptionsLoading: true,
  },
}

/**
 * 作成フォームで担当者候補取得に失敗した状態です。
 */
export const AssigneeError: Story = {
  args: {
    assigneeErrorMessage: '担当者候補を取得できませんでした。',
    defaultCreateTaskOpen: true,
  },
}

/**
 * 作成フォームで担当者候補が空の状態です。
 */
export const NoAssignees: Story = {
  args: {
    assigneeOptions: [],
    defaultCreateTaskOpen: true,
  },
}

/**
 * 詳細ペインが読み込み中の状態です。
 */
export const DetailLoading: Story = {
  args: {
    initialSelectedTaskId: 'wireframe',
    isSelectedIssueDetailLoading: true,
  },
}

/**
 * 詳細ペインの取得または保存エラー表示です。
 */
export const DetailError: Story = {
  args: {
    detailErrorMessage: 'Issue 詳細を取得できませんでした。',
    initialSelectedTaskId: 'wireframe',
  },
}

/**
 * legacy task の読み取り専用詳細です。
 */
export const LegacyReadOnly: Story = {
  args: {
    initialSelectedTaskId: 'wireframe',
    tasks: legacyTasks,
  },
}

/**
 * 行数と長いラベルが多い高密度テーブルです。
 */
export const DenseRows: Story = {
  args: {
    tasks: denseStoryTasks,
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
