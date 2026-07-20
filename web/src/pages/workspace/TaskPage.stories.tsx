import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { TaskScreen } from './TaskPage'
import type { TeamIssueDetail } from '../../issues/api'
import {
  collaborationWorkspaceMemberFixtures,
  issueCollaborationControllerFixture,
  teamIssueActivityFixtures,
  teamIssueCommentFixtures,
} from '../../issues/fixtures'
import { projectDirectoryFixtures } from '../../projects/fixtures'
import type { ProjectMember, ProjectUser } from '../../projects/api'
import { referoTaskFixtures } from '../../tasks/fixtures'
import { fileArtifactsControllerFixture } from '../../files/fixtures'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'

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

const storyTaskTitles = [
  'ワイヤーフレームを確認する',
  'ブランドガイドラインを更新する',
  'SEOリサーチをまとめる',
  '競合調査レポートを完成する',
] as const

const storyTaskWorkflowStatuses = [
  { id: 'active', category: 'started' },
  { id: 'review', category: 'started' },
  { id: 'ready', category: 'unstarted' },
  { id: 'done', category: 'completed' },
] as const

const storyTasks = referoTaskFixtures.map((task, index) => {
  const workflowStatus = storyTaskWorkflowStatuses[index % storyTaskWorkflowStatuses.length]!

  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: task.revision,
    id: task.id,
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: storyTaskTitles[index % storyTaskTitles.length]!,
    assigneeUserId: index % 2 === 0 ? 'sato@example.com' : 'suzuki@example.com',
    creatorMemberKey: index % 2 === 0 ? 'sato@example.com' : 'suzuki@example.com',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: workflowStatus.id,
    statusCategory: workflowStatus.category,
    customFieldValues: {},
    relationIds: [],
    dueDate: task.dueDate,
    priority: task.priority,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    source: 'dynamodb' as const,
  }
})

const denseStoryTasks = Array.from({ length: 24 }, (_, index) => {
  const baseTask = storyTasks[index % storyTasks.length]

  return {
    ...baseTask,
    id: `${baseTask.id}-dense-${index + 1}`,
    title: `${index + 1}. ${index % 2 === 0 ? '長いラベルのワークストリーム確認と承認依頼' : 'Cross-functional launch readiness checklist'} ${index + 1}`,
    workflowStatusId: storyTaskWorkflowStatuses[index % storyTaskWorkflowStatuses.length]!.id,
    statusCategory: storyTaskWorkflowStatuses[index % storyTaskWorkflowStatuses.length]!.category,
    priority: (['high', 'medium', 'low'] as const)[index % 3],
  }
})

const selectedIssueDetail: TeamIssueDetail = {
  activity: teamIssueActivityFixtures,
  comments: teamIssueCommentFixtures,
  issue: {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'wireframe',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: 'ワイヤーフレームを確認する',
    description: 'Refero の初回作業面を確認し、次に進める判断材料をそろえます。',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'sato@example.com',
    assigneeEmail: 'sato@example.com',
    assigneeName: '佐藤 花子',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'active',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
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
    activeProjectTeamId: 'core-team',
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
    resolvedConfiguration: { configuration: teamWorkItemConfigurationFixture },
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
