import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { DashboardSummary } from '../auth/api'
import {
  notificationInboxControllerFixture,
  notificationPreferencesControllerFixture,
} from '../notifications/fixtures'
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

const storyWorkspaceTasks = [
  ...referoTaskFixtures.map((task) => ({
    ...task,
    assignedProjectId: 'refero',
    source: 'legacy' as const,
    teamId: 'core-team',
  })),
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    assigneeEmail: 'demo@example.com',
    assigneeName: 'Demo User',
    assigneeUserId: 'demo@example.com',
    dueDate: '2026/06/07',
    id: 'roadmap-risk',
    priority: 'high',
    assignedProjectId: 'product-roadmap',
    source: 'dynamodb' as const,
    status: 'review',
    teamId: 'core-team',
    title: 'ロードマップの依存リスクを確認',
  },
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    assigneeEmail: 'suzuki@example.com',
    assigneeName: '鈴木 大輔',
    assigneeUserId: 'suzuki@example.com',
    dueDate: '2026/06/10',
    id: 'launch-approval',
    priority: 'medium',
    assignedProjectId: 'shared-launch',
    source: 'dynamodb' as const,
    status: 'todo',
    teamId: 'core-team',
    title: '共通ローンチの承認導線を確認',
    approvalSummary: {
      approvedCount: 0,
      changesRequestedCount: 1,
      nextDueAt: '2026-07-15T14:59:59.000Z',
      overdueCount: 1,
      pendingCount: 2,
      rejectedCount: 0,
    },
  },
] satisfies Parameters<typeof WorkspaceScreen>[0]['tasks']

const storyTeamProjectMembers = [
  {
    member: {
      email: 'demo@example.com',
      id: 'demo@example.com',
      name: 'Demo User',
      role: 'manager',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    projectId: 'refero',
    projectName: 'Refero',
  },
  {
    member: {
      email: 'sato@example.com',
      id: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    projectId: 'refero',
    projectName: 'Refero',
  },
  {
    member: {
      email: 'suzuki@example.com',
      id: 'suzuki@example.com',
      name: '鈴木 大輔',
      role: 'viewer',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    projectId: 'refero',
    projectName: 'Refero',
  },
  {
    member: {
      email: 'demo@example.com',
      id: 'demo@example.com',
      name: 'Demo User',
      role: 'manager',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    projectId: 'product-roadmap',
    projectName: 'プロダクトロードマップ',
  },
  {
    member: {
      email: 'yamada@example.com',
      id: 'yamada@example.com',
      name: '山田 太郎',
      role: 'viewer',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    projectId: 'product-roadmap',
    projectName: 'プロダクトロードマップ',
  },
  {
    member: {
      email: 'suzuki@example.com',
      id: 'suzuki@example.com',
      name: '鈴木 大輔',
      role: 'member',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    projectId: 'shared-launch',
    projectName: '共通ローンチ',
  },
] satisfies NonNullable<Parameters<typeof WorkspaceScreen>[0]['teamProjectMembers']>

const defaultArgs = {
  activeTeamId: 'core-team',
  fontSizePreference: 'standard',
  inboxCount: 2,
  locale: 'ja',
  summary: storySummary,
  tasks: storyWorkspaceTasks,
  notificationInbox: notificationInboxControllerFixture,
  notificationPreferences: notificationPreferencesControllerFixture,
  teamProjectMembers: storyTeamProjectMembers,
  teams: projectDirectoryFixtures,
  onCreateProject: async () => undefined,
  onCreateTeam: async () => undefined,
  onFontSizePreferenceChange: () => undefined,
  onMoveTaskStatus: async () => undefined,
  onOpenTask: () => undefined,
  userIdentityAliases: ['demo@example.com'],
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
    assignedProjectId: index % 2 === 0 ? 'refero' : 'brand-refresh',
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
 * 通知がまだない受信箱です。
 */
export const InboxWithoutNotifications: Story = {
  args: {
    notificationInbox: {
      ...notificationInboxControllerFixture,
      hasMore: false,
      notifications: [],
      unreadCount: 0,
    },
    view: 'inbox',
  },
}

/**
 * 通知 API の初回 page を読み込み中の受信箱です。
 */
export const InboxLoading: Story = {
  args: {
    notificationInbox: {
      ...notificationInboxControllerFixture,
      isLoading: true,
      notifications: [],
    },
    view: 'inbox',
  },
}

/**
 * 通知 API の読み込みに失敗した受信箱です。
 */
export const InboxLoadError: Story = {
  args: {
    notificationInbox: {
      ...notificationInboxControllerFixture,
      hasLoadError: true,
      notifications: [],
    },
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
 * タスクがまだ登録されていないポートフォリオのレポート画面です。
 */
export const ReportsWithoutTasks: Story = {
  args: {
    tasks: [],
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
 * メンバーはいるが担当タスクがまだない状態です。
 */
export const TeamMembersWithoutAssignments: Story = {
  args: {
    tasks: [],
    view: 'team-members',
  },
}

/**
 * 一部プロジェクトのメンバー権限取得に失敗した状態です。
 */
export const TeamMembersPartialFailure: Story = {
  args: {
    teamProjectMembers: storyTeamProjectMembers.filter(
      (access) => access.projectId !== 'product-roadmap',
    ),
    teamProjectMembersFailedProjectIds: ['product-roadmap'],
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

/**
 * 英語 locale のチームメンバー画面です。
 */
export const EnglishTeamMembers: Story = {
  args: {
    locale: 'en',
    view: 'team-members',
  },
}
