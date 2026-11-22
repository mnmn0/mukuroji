import { DEFAULT_WORK_ITEM_TYPE } from '@mukuroji/contracts'
import type { TeamWorkItemHierarchyNode, WorkItemRelation } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef, useState, type ComponentProps } from 'react'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { TeamIssueScreen } from '../../issues/ui/TeamIssueScreen'
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

type ExternalTypeRevalidationHarnessProps = {
  /** Team Issue screen inputs rendered before and after the simulated refresh. */
  teamIssueScreenProps: ComponentProps<typeof TeamIssueScreen>
}

/** Simulates an authoritative refresh whose Work Item Type no longer exposes Activity. */
function ExternalTypeRevalidationHarness({
  teamIssueScreenProps,
}: ExternalTypeRevalidationHarnessProps) {
  const [isExternalTypeUpdateApplied, setIsExternalTypeUpdateApplied] = useState(false)
  const initialIssues = teamIssueScreenProps.issues ?? []
  const refreshedIssues = isExternalTypeUpdateApplied
    ? initialIssues.map((issue) => issue.id === 'onboarding-friction'
      ? { ...issue, revision: issue.revision + 1, workItemTypeId: 'brief' }
      : issue)
    : initialIssues

  return (
    <>
      <button
        data-testid="simulate-team-external-type-revalidation"
        onClick={() => setIsExternalTypeUpdateApplied(true)}
        type="button"
      >
        Simulate external type update
      </button>
      <TeamIssueScreen
        {...teamIssueScreenProps}
        issues={refreshedIssues}
      />
    </>
  )
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
    expect(composerButtons.length).toBeGreaterThan(0)
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

/** Retains a dirty Team Issue comment as read-only after external type revalidation. */
export const ExternalTypeRefreshRemovingActivityRetainsCommentDraft: Story = {
  args: {
    onCommentDraftDirtyChange: fn(),
    resolvedConfiguration: { configuration: activityOptionalTypeConfiguration },
  },
  render: (args) => (
    <ExternalTypeRevalidationHarness teamIssueScreenProps={args} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const panel = within(canvas.getByTestId('issue-collaboration-panel'))
    const commentBody = panel.getByRole('textbox', { name: 'コメント本文' })

    await userEvent.type(commentBody, '外部更新後も保持する Team Issue コメント')
    await userEvent.click(canvas.getByTestId('simulate-team-external-type-revalidation'))

    await waitFor(() => expect(commentBody).toHaveValue('外部更新後も保持する Team Issue コメント'))
    await expect(commentBody).toHaveAttribute('readonly')
    await expect(canvas.getByText('この Work Item でコメントを変更する権限がありません。')).toBeVisible()
    await expect(panel.getByRole('button', { name: /ウォッチ中/u })).toBeDisabled()
    await expect(panel.getByRole('button', { name: '削除' })).toBeDisabled()
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

/** Selecting Team table rows offers bulk edit, move, and archive for the selected Work Items. */
export const BulkSelection: Story = {
  args: {
    bulkWorkspaceId: 'workspace-1',
    onBulkApply: fn(),
    onBulkPreview: fn(),
    selectedIssueId: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('issue-row-select-onboarding-friction'))
    await expect(canvas.getByTestId('issue-row-select-onboarding-friction')).toBeChecked()
    await expect(canvas.getByTestId('bulk-operation-toolbar')).toBeVisible()
    await expect(canvas.getByTestId('bulk-selected-count')).toHaveTextContent('1')
  },
}

/** Team table bulk selection on a 390px-wide viewport. */
export const BulkSelectionMobile: Story = {
  args: {
    bulkWorkspaceId: 'workspace-1',
    onBulkApply: fn(),
    onBulkPreview: fn(),
    selectedIssueId: undefined,
  },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
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
 * Duplicates the selected Work Item into an editable create draft, drops the copied contributor
 * plan, and saves the edited copy.
 */
export const DuplicateIntoDraft: Story = {
  args: {
    issues: configuredIssues.map((issue) => issue.id === 'onboarding-friction'
      ? {
          ...issue,
          // The create form applies the field pattern `\S+` to the whole value, so use one word.
          customFieldValues: { ...issue.customFieldValues, 'customer-impact': 'Enterprise-setup-without-support' },
          contributorAssignments: [
            {
              assignmentId: 'onboarding-friction-review',
              memberUserId: 'suzuki@example.com',
              plannedEffortMinutes: 60,
              status: 'in-progress',
            },
          ],
        }
      : issue),
    onCreateIssue: fn(async () => undefined),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('team-issue-duplicate'))

    const form = await canvas.findByTestId('create-issue-form')
    await expect(within(form).getByTestId('create-issue-duplicate-note')).toBeVisible()
    const title = within(form).getByRole('textbox', { name: 'Issue 名' })
    await expect(title).toHaveValue('初回オンボーディングの離脱要因を減らす')
    await expect(args.onCreateIssue).not.toHaveBeenCalled()

    await userEvent.clear(title)
    await userEvent.type(title, 'オンボーディングの離脱要因を減らす（第2期）')
    await userEvent.click(within(form).getByTestId('create-issue-duplicate-contributors'))
    await userEvent.click(within(form).getByRole('button', { name: 'Issue を作成' }))

    await waitFor(() => expect(args.onCreateIssue).toHaveBeenCalledTimes(1))
    await expect(args.onCreateIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: 'オンボーディングの離脱要因を減らす（第2期）',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      priority: 'high',
      customFieldValues: expect.objectContaining({
        'customer-impact': 'Enterprise-setup-without-support',
        'story-points': 8,
      }),
    }))
    await expect(args.onCreateIssue).not.toHaveBeenCalledWith(expect.objectContaining({
      contributorAssignments: expect.anything(),
    }))
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

/** Hierarchy where the second Work Item sits under the first and the third is top-level. */
const outlineNodes: TeamWorkItemHierarchyNode[] = [
  {
    workItemId: 'onboarding-friction',
    parentWorkItemId: null,
    depth: 0,
    wbsNumber: '1',
    hierarchyRank: 'b',
    childWorkItemIds: [configuredIssues[1].id],
    rollup: {
      childCount: 1,
      descendantCount: 1,
      statusCategoryCounts: { backlog: 0, unstarted: 1, started: 0, completed: 0, canceled: 0 },
      openDescendantCount: 1,
      plannedEffortMinutes: 120,
      estimatedDescendantCount: 1,
      remainingEffortMinutes: 120,
      startDate: '2026-12-01',
      endDate: '2026-12-10',
    },
  },
  {
    workItemId: configuredIssues[1].id,
    parentWorkItemId: 'onboarding-friction',
    depth: 1,
    wbsNumber: '1.1',
    hierarchyRank: 'b',
    childWorkItemIds: [],
  },
  {
    workItemId: 'release-readiness',
    parentWorkItemId: null,
    depth: 0,
    wbsNumber: '2',
    hierarchyRank: 'd',
    childWorkItemIds: [],
  },
]

/** Records the outline moves {@link HierarchyOutline} saves. */
const onHierarchyOutlineMove = fn(async () => undefined)

/** Table shown as a hierarchy outline: collapse a parent, then indent a Work Item from the keyboard. */
export const HierarchyOutline: Story = {
  args: {
    issueOutline: {
      nodes: outlineNodes,
      onMove: onHierarchyOutlineMove,
    },
    issues: configuredIssues.slice(0, 3),
    selectedIssueId: undefined,
    taskViewPresentation: {
      columns: [{ field: 'title' }, { field: 'status' }, { field: 'dueDate' }],
      density: 'comfortable',
      display: {
        showArchived: false,
        showAssigneeAvatars: false,
        showCompleted: true,
        showEmptyGroups: true,
        showSubtasks: true,
        wrapTitles: false,
        showOutline: true,
      },
    },
  },
  beforeEach: () => {
    try {
      window.localStorage.removeItem('mukuroji.workItemOutline.collapsed.core-team')
    } catch {
      // Storage may be unavailable; the outline then starts expanded anyway.
    }
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const childId = configuredIssues[1].id
    await expect(canvas.getByTestId(`issue-row-wbs-${childId}`)).toHaveTextContent('1.1')
    await expect(canvas.getByTestId('work-item-hierarchy-rollup')).toHaveTextContent('完了 0/1')

    const toggle = canvas.getByTestId('issue-outline-toggle-onboarding-friction')
    await userEvent.click(toggle)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(canvas.queryByTestId(`issue-row-${childId}`)).not.toBeInTheDocument()
    await userEvent.click(toggle)
    await expect(canvas.getByTestId(`issue-row-${childId}`)).toBeInTheDocument()

    canvas.getByTestId('issue-row-release-readiness').focus()
    await userEvent.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}')
    await waitFor(() => expect(args.issueOutline?.onMove).toHaveBeenCalledWith(
      'release-readiness',
      expect.objectContaining({ parentWorkItemId: 'onboarding-friction' }),
    ))
    await waitFor(() => expect(canvas.getByTestId('team-issue-outline-status')).toHaveTextContent('移動しました'))

    await userEvent.keyboard('{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}')
    await expect(canvas.getByTestId('team-issue-outline-status')).toHaveTextContent('最上位の Work Item')

    // Choose the row with J from the page itself, as a keyboard user would after leaving the table.
    const releaseRow = canvas.getByTestId('issue-row-release-readiness').closest('tr')
    if (!releaseRow) throw new Error('Expected the release-readiness table row.')
    const activeElement = canvasElement.ownerDocument.activeElement
    if (activeElement instanceof HTMLElement) activeElement.blur()
    for (let press = 0; press < 5 && releaseRow.getAttribute('data-task-view-focused') !== 'true'; press += 1) {
      await userEvent.keyboard('j')
    }
    await expect(releaseRow).toHaveAttribute('data-task-view-focused', 'true')

    // With focus on another part of the page, such as a focusable heading outside the table, the
    // shortcut leaves the chosen row alone.
    const outsideTarget = canvasElement.ownerDocument.createElement('div')
    outsideTarget.tabIndex = -1
    canvasElement.prepend(outsideTarget)
    const movesBefore = onHierarchyOutlineMove.mock.calls.length
    const statusBefore = canvas.getByTestId('team-issue-outline-status').textContent
    try {
      outsideTarget.focus()
      await userEvent.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}')
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
      await expect(onHierarchyOutlineMove).toHaveBeenCalledTimes(movesBefore)
      await expect(canvas.getByTestId('team-issue-outline-status').textContent).toBe(statusBefore)
    } finally {
      outsideTarget.remove()
    }

    // From the page itself, the same shortcut moves the row chosen with J.
    await expect(canvasElement.ownerDocument.activeElement).toBe(canvasElement.ownerDocument.body)
    await expect(releaseRow).toHaveAttribute('data-task-view-focused', 'true')
    await userEvent.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}')
    await waitFor(() => expect(onHierarchyOutlineMove).toHaveBeenCalledTimes(movesBefore + 1))
    await expect(onHierarchyOutlineMove).toHaveBeenLastCalledWith(
      'release-readiness',
      expect.objectContaining({ parentWorkItemId: 'onboarding-friction' }),
    )
  },
}

/** Props of the story harness that fails and retries the hierarchy read. */
type OutlineRetryHarnessProps = {
  /** Team Issue screen inputs; the harness replaces `issueOutline` with its own source. */
  teamIssueScreenProps: ComponentProps<typeof TeamIssueScreen>
  /** Called each time the screen asks for a retry, so the story can count them. */
  onRetry: () => void
}

/**
 * Simulates a hierarchy read that failed while the previous hierarchy stays cached.
 *
 * A retry resolves on its own with the same nodes, unless a later failure asked the next retry
 * to wait for the finish button.
 */
function OutlineRetryHarness({ teamIssueScreenProps, onRetry }: OutlineRetryHarnessProps) {
  const [showOutline, setShowOutline] = useState(true)
  const presentation = teamIssueScreenProps.taskViewPresentation
  const [hasError, setHasError] = useState(true)
  const [isRetrying, setIsRetrying] = useState(false)
  const holdNextRetryRef = useRef(false)

  /** Clears the failure the way a successful SWR revalidation of the same data would. */
  const finishRetry = () => {
    setHasError(false)
    setIsRetrying(false)
  }

  return (
    <>
      <button
        data-testid="simulate-outline-failure"
        onClick={() => {
          holdNextRetryRef.current = true
          setHasError(true)
        }}
        type="button"
      >
        Simulate hierarchy failure
      </button>
      <button data-testid="finish-outline-retry" onClick={finishRetry} type="button">
        Finish hierarchy retry
      </button>
      <button data-testid="toggle-retry-outline" onClick={() => setShowOutline((shown) => !shown)} type="button">
        Toggle outline
      </button>
      <TeamIssueScreen
        {...teamIssueScreenProps}
        taskViewPresentation={presentation
          ? { ...presentation, display: { ...presentation.display, showOutline } }
          : presentation}
        issueOutline={{
          nodes: outlineNodes,
          ...(hasError
            ? {
                errorMessage: '階層を読み込めませんでした。',
                isRetrying,
                onRetry: () => {
                  onRetry()
                  setIsRetrying(true)
                  if (!holdNextRetryRef.current) window.setTimeout(finishRetry, 20)
                },
              }
            : {}),
        }}
      />
    </>
  )
}

/** Counts the retries the outline asks for. */
const onOutlineRetry = fn()

/** A retry that returns the same hierarchy hands focus to the view, unless the person moved on. */
export const HierarchyOutlineRetryFocus: Story = {
  args: {
    issues: configuredIssues.slice(0, 3),
    selectedIssueId: undefined,
    taskViewPresentation: HierarchyOutline.args?.taskViewPresentation,
  },
  render: (args) => <OutlineRetryHarness onRetry={onOutlineRetry} teamIssueScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onOutlineRetry.mockClear()
    const viewPanel = canvas.getByRole('region', { name: 'テーブル' })

    canvas.getByRole('button', { name: '階層を再読み込み' }).focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(canvas.queryByTestId('team-issue-outline-unavailable')).not.toBeInTheDocument())
    await waitFor(() => expect(viewPanel).toHaveFocus())

    await userEvent.click(canvas.getByTestId('simulate-outline-failure'))
    const retry = canvas.getByRole('button', { name: '階層を再読み込み' })
    retry.focus()
    await userEvent.keyboard('{Enter}')
    await expect(retry).toHaveAttribute('aria-disabled', 'true')
    await expect(retry).toHaveTextContent('階層を読み込み中…')
    // The busy button keeps focus, so the second press below really reaches it.
    await expect(retry).toHaveFocus()
    // A second press while the read runs does not start another one.
    await userEvent.keyboard('{Enter}')
    await expect(onOutlineRetry).toHaveBeenCalledTimes(2)
    const finish = canvas.getByTestId('finish-outline-retry')
    await userEvent.click(finish)
    await waitFor(() => expect(canvas.queryByTestId('team-issue-outline-unavailable')).not.toBeInTheDocument())
    await expect(finish).toHaveFocus()

    // The failure is announced on its own, apart from the retry button.
    await userEvent.click(canvas.getByTestId('simulate-outline-failure'))
    const unavailable = canvas.getByTestId('team-issue-outline-unavailable')
    await expect(within(unavailable).getByRole('alert')).toHaveTextContent('階層を読み込めませんでした。')
    await expect(within(unavailable).getByRole('alert')).not.toContainElement(
      within(unavailable).getByRole('button', { name: '階層を再読み込み' }),
    )

    // A retry started before the outline was turned off does not take focus once it is back.
    const heldRetry = within(unavailable).getByRole('button', { name: '階層を再読み込み' })
    heldRetry.focus()
    await userEvent.keyboard('{Enter}')
    await expect(heldRetry).toHaveAttribute('aria-disabled', 'true')
    const toggleOutline = canvas.getByTestId('toggle-retry-outline')
    await userEvent.click(toggleOutline)
    await expect(canvas.queryByTestId('team-issue-outline-unavailable')).not.toBeInTheDocument()
    await userEvent.click(toggleOutline)
    await expect(canvas.getByTestId('team-issue-outline-unavailable')).toBeInTheDocument()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    // A plain click() finishes the read without taking focus from the page.
    finish.click()
    await waitFor(() => expect(canvas.queryByTestId('team-issue-outline-unavailable')).not.toBeInTheDocument())
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
    await expect(canvas.getByRole('region', { name: 'テーブル' })).not.toHaveFocus()
  },
}

/** Props of the story harness that hides and shows the outline while a move saves. */
type OutlineReshowHarnessProps = {
  /** Team Issue screen inputs; the harness owns `issueOutline` and the outline setting. */
  teamIssueScreenProps: ComponentProps<typeof TeamIssueScreen>
}

/**
 * Holds each outline move open and lets the story turn the outline off and on meanwhile.
 *
 * The move resolves only when the story presses the finish button, which this render shows
 * while it holds a move, so a run never finishes a move another run started.
 */
function OutlineReshowHarness({ teamIssueScreenProps }: OutlineReshowHarnessProps) {
  const [showOutline, setShowOutline] = useState(true)
  const [settleMove, setSettleMove] = useState<() => void>()
  const presentation = teamIssueScreenProps.taskViewPresentation
  return (
    <>
      <button data-testid="toggle-outline" onClick={() => setShowOutline((shown) => !shown)} type="button">
        Toggle outline
      </button>
      {settleMove ? (
        <button
          data-testid="finish-held-move"
          onClick={() => {
            settleMove()
            setSettleMove(undefined)
          }}
          type="button"
        >
          Finish held move
        </button>
      ) : null}
      <TeamIssueScreen
        {...teamIssueScreenProps}
        issueOutline={{
          nodes: outlineNodes,
          onMove: () => new Promise<void>((resolve) => {
            setSettleMove(() => resolve)
          }),
        }}
        taskViewPresentation={presentation
          ? { ...presentation, display: { ...presentation.display, showOutline } }
          : presentation}
      />
    </>
  )
}

/**
 * A move that finishes after the outline was turned off and on again leaves focus alone, since
 * the row it started from was rebuilt.
 */
export const HierarchyOutlineMoveAfterReshow: Story = {
  args: {
    issues: configuredIssues.slice(0, 3),
    selectedIssueId: undefined,
    taskViewPresentation: HierarchyOutline.args?.taskViewPresentation,
  },
  beforeEach: HierarchyOutline.beforeEach,
  render: (args) => <OutlineReshowHarness teamIssueScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    canvas.getByTestId('issue-row-release-readiness').focus()
    await userEvent.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}')
    const finishMove = await canvas.findByTestId('finish-held-move')

    const toggle = canvas.getByTestId('toggle-outline')
    await userEvent.click(toggle)
    await expect(canvas.queryByTestId('issue-row-wbs-release-readiness')).not.toBeInTheDocument()
    await userEvent.click(toggle)
    await expect(canvas.getByTestId('issue-row-wbs-release-readiness')).toBeInTheDocument()
    // Leave focus on the page, where a finished move would otherwise reclaim it for the row.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()

    // A plain click() finishes the move without taking focus from the page.
    finishMove.click()
    await waitFor(() => expect(canvas.getByTestId('team-issue-outline-status')).toHaveTextContent('移動しました'))
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
    await expect(canvas.getByTestId('issue-row-release-readiness')).not.toHaveFocus()
    await expect(document.activeElement).toBe(document.body)
  },
}

/** Props of the story harness that switches Team without remounting the screen. */
type OutlineTeamSwitchHarnessProps = {
  /** Team Issue screen inputs; the harness owns `teamId`. */
  teamIssueScreenProps: ComponentProps<typeof TeamIssueScreen>
}

/** Switches the screen between two Teams the way route navigation reuses it. */
function OutlineTeamSwitchHarness({ teamIssueScreenProps }: OutlineTeamSwitchHarnessProps) {
  const [teamId, setTeamId] = useState('core-team')
  return (
    <>
      <button
        data-testid="switch-team"
        onClick={() => setTeamId((current) => current === 'core-team' ? 'growth-team' : 'core-team')}
        type="button"
      >
        Switch Team
      </button>
      <TeamIssueScreen {...teamIssueScreenProps} teamId={teamId} />
    </>
  )
}

/** Each Team keeps its own collapsed rows when the person switches Team on the same screen. */
export const HierarchyOutlineCollapseFollowsTeam: Story = {
  args: {
    issueOutline: HierarchyOutline.args?.issueOutline,
    issues: configuredIssues.slice(0, 3),
    selectedIssueId: undefined,
    taskViewPresentation: HierarchyOutline.args?.taskViewPresentation,
  },
  beforeEach: () => {
    try {
      window.localStorage.removeItem('mukuroji.workItemOutline.collapsed.core-team')
      window.localStorage.removeItem('mukuroji.workItemOutline.collapsed.growth-team')
    } catch {
      // Storage may be unavailable; both Teams then start expanded anyway.
    }
  },
  render: (args) => <OutlineTeamSwitchHarness teamIssueScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const childId = configuredIssues[1].id
    await userEvent.click(canvas.getByTestId('issue-outline-toggle-onboarding-friction'))
    await expect(canvas.queryByTestId(`issue-row-${childId}`)).not.toBeInTheDocument()

    await userEvent.click(canvas.getByTestId('switch-team'))
    await expect(canvas.getByTestId(`issue-row-${childId}`)).toBeInTheDocument()
    await expect(window.localStorage.getItem('mukuroji.workItemOutline.collapsed.growth-team')).toBeNull()

    await userEvent.click(canvas.getByTestId('switch-team'))
    await expect(canvas.queryByTestId(`issue-row-${childId}`)).not.toBeInTheDocument()
  },
}

/** Team Work Items that carry keys, with a description that names other Work Items by key. */
const keyedIssues = configuredIssues.map((issue, index) => ({
  ...issue,
  key: `PT-${12 + index}`,
  ...(index === 0
    ? { description: `${issue.description ?? ''} 前提は PT-14 と PT-13 を参照。PT-12 自身は並べない。` }
    : {}),
})) satisfies Extract<TeamIssue, { source: 'dynamodb' }>[]

/**
 * Shows each Work Item key before its title in the table, the key and its copy actions in the
 * detail pane, and the keys named in the description as links to their key URLs.
 */
export const WithWorkItemKeys: Story = {
  args: {
    issues: keyedIssues,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('issue-row-key-onboarding-friction')).toHaveTextContent('PT-12')
    await expect(canvas.getByTestId('issue-row-key-release-readiness')).toHaveTextContent('PT-14')
    const detail = within(canvas.getByTestId('team-issue-detail-pane'))
    await expect(detail.getByRole('button', { name: 'key をコピー' })).toBeVisible()
    const mentioned = within(detail.getByTestId('work-item-mentioned-keys'))
    await expect(mentioned.getByRole('link', { name: 'PT-14' })).toHaveAttribute('href', '/browse/PT-14')
    await expect(mentioned.getByRole('link', { name: 'PT-13' })).toHaveAttribute('href', '/browse/PT-13')
    await expect(mentioned.queryByRole('link', { name: 'PT-12' })).toBeNull()
  },
}

/** Shows each Work Item key before its title on the board cards. */
export const BoardWithWorkItemKeys: Story = {
  args: {
    initialViewMode: 'board',
    issues: keyedIssues,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByRole('button', { name: /^PT-14\s*リリース準備の判断材料を揃える/ })).toBeVisible()
  },
}
