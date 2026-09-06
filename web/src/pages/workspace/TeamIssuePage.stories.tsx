import { DEFAULT_WORK_ITEM_TYPE } from '@mukuroji/contracts'
import type { WorkItemRelation } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
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

/** Configuration with a Team Issue type that deliberately omits the Activity section. */
const activityOptionalTypeConfiguration = {
  ...teamWorkItemConfigurationFixture,
  workItemTypes: [
    DEFAULT_WORK_ITEM_TYPE,
    {
      ...DEFAULT_WORK_ITEM_TYPE,
      detailSections: DEFAULT_WORK_ITEM_TYPE.detailSections.filter((section) => section !== 'activity'),
      id: 'brief',
      name: 'Brief',
    },
  ],
}

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

const onSelectIssueAction = fn()

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
    onDeleteRelation: async () => undefined,
    onSelectIssue: onSelectIssueAction,
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

/** Confirms that a dirty Team Issue comment is retained when Activity would be removed. */
export const TypeChangeRemovingActivityProtectsCommentDraft: Story = {
  args: {
    onCommentDraftDirtyChange: fn(),
    resolvedConfiguration: { configuration: activityOptionalTypeConfiguration },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const commentBody = within(canvas.getByTestId('issue-collaboration-panel')).getByRole('textbox')
    const typeSelect = within(canvas.getByTestId('team-issue-detail-pane')).getByRole('combobox', {
      name: 'Work Item Type',
    })
    const composerButtons = within(canvas.getByTestId('issue-collaboration-panel'))
      .getAllByRole('button')
      .filter((button) => /コメント|送信|キャンセル|破棄|プレビュー/u.test(button.textContent ?? ''))
    for (const button of composerButtons) {
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)
    }
    await userEvent.type(commentBody, 'Team Issue の種別変更でも保持するコメント')

    const originalConfirm = globalThis.window.confirm
    let confirmCount = 0
    globalThis.window.confirm = () => {
      confirmCount += 1
      return false
    }
    try {
      await userEvent.selectOptions(typeSelect, 'brief')
      await expect(typeSelect).toHaveValue(DEFAULT_WORK_ITEM_TYPE.id)
      await expect(commentBody).toHaveValue('Team Issue の種別変更でも保持するコメント')
      expect(confirmCount).toBe(1)

      globalThis.window.confirm = () => true
      await userEvent.selectOptions(typeSelect, 'brief')
      await expect(typeSelect).toHaveValue('brief')
      await expect(canvas.queryByTestId('issue-collaboration-panel')).not.toBeInTheDocument()
      expect(args.onCommentDraftDirtyChange).toHaveBeenCalledWith(false, 'onboarding-friction')
    } finally {
      globalThis.window.confirm = originalConfirm
    }
  },
}

/** Shared J/K, Space, keyboard Open, and click Open behavior for the Team surface. */
export const SharedActionSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const firstButton = canvas.getByTestId('issue-row-onboarding-friction')
    const secondButton = canvas.getByTestId('issue-row-billing-copy')
    const firstRow = firstButton.closest('tr')
    const secondRow = secondButton.closest('tr')
    if (!firstRow || !secondRow) throw new Error('Expected Team Issue table rows.')
    onSelectIssueAction.mockClear()

    await userEvent.keyboard('j')
    await waitFor(() => expect(firstRow).toHaveAttribute('data-task-view-focused', 'true'))
    await expect(onSelectIssueAction).not.toHaveBeenCalled()

    await userEvent.keyboard(' ')
    await waitFor(() => expect(firstRow).toHaveAttribute('data-task-view-selected', 'true'))
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(onSelectIssueAction).toHaveBeenCalledWith(
      'onboarding-friction',
    ))

    onSelectIssueAction.mockClear()
    await userEvent.click(secondButton)
    await waitFor(() => expect(onSelectIssueAction).toHaveBeenCalledWith('billing-copy'))
    await expect(secondRow).toHaveAttribute('data-task-view-focused', 'true')
  },
}

/** Row overflow actions reuse the canonical registry and restore focus into Team detail controls. */
export const SharedActionContextMenu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    onSelectIssueAction.mockClear()

    await userEvent.click(canvas.getByTestId(
      'team-issue-row-actions-onboarding-friction',
    ))
    const menu = await body.findByTestId('team-issue-action-context-menu')
    const editAction = menu.querySelector<HTMLButtonElement>('[data-action-id="edit"]')
    if (!editAction) throw new Error('Expected the Team Issue Edit action.')
    await expect(editAction).toHaveAttribute('aria-disabled', 'false')
    await userEvent.click(editAction)

    await waitFor(() => expect(onSelectIssueAction).toHaveBeenCalledWith(
      'onboarding-friction',
    ))
    await waitFor(() => expect(document.activeElement).toBe(
      canvasElement.querySelector('[data-testid="team-issue-detail-pane"] input[name="title"]'),
    ))
  },
}

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

/** Compact grouped Team table using an explicit saved-view presentation. */
export const SavedViewPresentation: Story = {
  args: {
    taskViewPresentation: {
      columns: [
        { field: 'title', pin: 'start', width: 320 },
        { field: 'status', width: 170 },
        { field: 'priority', pin: 'end', width: 150 },
      ],
      density: 'compact',
      display: {
        showArchived: false,
        showAssigneeAvatars: true,
        showCompleted: true,
        showEmptyGroups: true,
        showSubtasks: true,
        wrapTitles: true,
      },
      groupBy: 'priority',
      subgroupBy: 'assignee',
    },
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
