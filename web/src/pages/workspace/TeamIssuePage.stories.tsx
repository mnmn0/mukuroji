import type { WorkItemRelation } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { TeamIssueScreen } from './TeamIssuePage'
import {
  collaborationWorkspaceMemberFixtures,
  issueCollaborationControllerFixture,
  teamIssueFixtures,
} from '../../issues/fixtures'
import type { TeamIssue } from '../../issues/api'
import type { ProjectMember } from '../../projects/api'
import { projectDirectoryFixtures } from '../../projects/fixtures'
import { fileArtifactsControllerFixture } from '../../files/fixtures'
import {
  teamWorkItemConfigurationFixture,
  workItemCustomFieldValueFixture,
} from '../../work-items/fixtures'

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

const configuredIssues = [
  {
    ...teamIssueFixtures[0]!,
    workflowSchemaVersion: teamWorkItemConfigurationFixture.schemaVersion,
    workflowStatusId: 'active',
    statusCategory: 'started',
    customFieldValues: workItemCustomFieldValueFixture,
  },
  {
    ...teamIssueFixtures[1]!,
    workflowSchemaVersion: teamWorkItemConfigurationFixture.schemaVersion,
    workflowStatusId: 'ready',
    statusCategory: 'unstarted',
    customFieldValues: workItemCustomFieldValueFixture,
  },
  {
    ...teamIssueFixtures[1]!,
    id: 'release-readiness',
    title: 'リリース準備の判断材料を揃える',
    workflowSchemaVersion: teamWorkItemConfigurationFixture.schemaVersion,
    workflowStatusId: 'backlog',
    statusCategory: 'backlog',
    customFieldValues: workItemCustomFieldValueFixture,
  },
] satisfies Extract<TeamIssue, { source: 'dynamodb' }>[]

const storyRelations = [
  {
    sourceWorkItemId: 'onboarding-friction',
    targetWorkItemId: 'billing-copy',
    type: 'blocks',
    createdAt: '2026-07-12T08:12:00.000Z',
  },
] satisfies readonly WorkItemRelation[]

const crowdedIssues = Array.from({ length: 20 }, (_, index) => {
  const baseIssue = configuredIssues[index % configuredIssues.length]!
  const workflowStatus = [
    { id: 'ready', category: 'unstarted' },
    { id: 'active', category: 'started' },
    { id: 'review', category: 'started' },
    { id: 'done', category: 'completed' },
  ] as const
  const selectedStatus = workflowStatus[index % workflowStatus.length]!

  return {
    ...baseIssue,
    id: `${baseIssue.id}-crowded-${index + 1}`,
    title: `${index + 1}. ${index % 2 === 0 ? '長い Issue 名の依存関係と担当者確認を完了する' : 'Operational backlog triage with release note follow-up'} ${index + 1}`,
    assignedProjectId: index % 2 === 0 ? 'refero' : 'brand-refresh',
    workflowStatusId: selectedStatus.id,
    statusCategory: selectedStatus.category,
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
    assigneeOptions,
    artifacts: fileArtifactsControllerFixture,
    collaboration: issueCollaborationControllerFixture,
    currentWorkspaceMemberKey: 'demo@example.com',
    issues: configuredIssues,
    relations: storyRelations,
    resolvedConfiguration: { configuration: teamWorkItemConfigurationFixture },
    onAddRelation: async () => undefined,
    onCreateIssue: async () => undefined,
    onCreateProject: async () => undefined,
    onCreateTeam: async () => undefined,
    onDeleteRelation: async () => undefined,
    onUpdateIssue: async () => undefined,
    selectedIssueId: 'onboarding-friction',
    teamId: 'core-team',
    teamName: 'コアチーム',
    teams: projectDirectoryFixtures,
    userInitial: 'J',
    workspaceMembers: collaborationWorkspaceMemberFixtures,
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
 * Command menu provider 外では desktop/mobile とも検索導線を表示しない状態です。
 */
export const WithoutCommandMenu: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    expect(canvas.queryByTestId('sidebar-search-trigger')).toBeNull()
    await userEvent.click(canvas.getByRole('button', { name: 'サイドバーを開く' }))
    expect(canvas.queryByTestId('sidebar-search-trigger')).toBeNull()
  },
}

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
