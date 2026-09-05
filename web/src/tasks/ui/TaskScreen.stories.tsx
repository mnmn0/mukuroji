import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type WorkItemScheduleChangePreview,
  type WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from 'react'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { TaskScreen } from './TaskScreen'
import {
  createWorkspaceCommandMenuWorkItemActionRegistry,
  WorkspaceCommandMenuContext,
  type WorkspaceCommandMenuContextValue,
} from '../../commands/ui/WorkspaceCommandMenuContext'
import { createDefaultDateRangeTaskSchedule } from '../model/taskSchedule'
import type { TeamIssueDetail, UpdateTeamIssueInput } from '../../issues/api'
import {
  collaborationWorkspaceMemberFixtures,
  issueCollaborationControllerFixture,
  teamIssueActivityFixtures,
} from '../../issues/fixtures'
import { projectDirectoryFixtures } from '../../projects/fixtures'
import type { ProjectMember, ProjectUser } from '../../projects/api'
import type { CanonicalWorkItem } from '../api/tasks'
import { referoTaskFixtures } from '../fixtures'
import { fileArtifactsControllerFixture } from '../../files/fixtures'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'

const projectFilesControllerFixture = {
  ...fileArtifactsControllerFixture,
  approvals: [],
  scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
} satisfies FileArtifactsController

/** Long destination labels used by the create-panel responsive story. */
const createOpenTeams = projectDirectoryFixtures.map((team) => team.id === 'core-team'
  ? {
      ...team,
      name: 'コアチーム・プロダクトオペレーション',
      projects: team.projects.map((project) => project.id === 'refero'
        ? { ...project, name: 'Refero Strategic Delivery Workspace' }
        : project),
    }
  : team)

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
    schedule: task.schedule,
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
  comments: [],
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
    dueDate: '2026-06-03',
    schedule: createDefaultDateRangeTaskSchedule('2026-06-01', '2026-06-03'),
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    source: 'dynamodb',
  },
}

const onProjectQuickAccessToggle = fn()
const onRetryPlanning = fn()
const onContextMenuSelectedIssueChange = fn()
const onReadOnlySelectedIssueChange = fn()
const onDirectPatchMutation = fn(async (task: CanonicalWorkItem, input: UpdateTeamIssueInput) => {
  void input
  return createStoryUpdatedTask(task)
})
const onDeniedDirectPatchMutation = fn(async (task: CanonicalWorkItem, input: UpdateTeamIssueInput) => {
  void input
  return createStoryUpdatedTask(task)
})
const onTimelinePreview = fn(async (task: CanonicalWorkItem) => createTimelinePreview(task))
const onTimelineConfirm = fn(async (task: CanonicalWorkItem) => createStoryUpdatedTask(task))
const onCancelledTimelinePreview = fn(async (task: CanonicalWorkItem) => createTimelinePreview(task))
const onCancelledTimelineConfirm = fn(async (task: CanonicalWorkItem) => createStoryUpdatedTask(task))
const onDeniedTimelinePreview = fn(async (task: CanonicalWorkItem) => createTimelinePreview(task))
const onDeniedTimelineConfirm = fn(async (task: CanonicalWorkItem) => createStoryUpdatedTask(task))

/** Returns the direct-impact preview used by Project timeline interaction stories. */
function createTimelinePreview(task: CanonicalWorkItem): WorkItemScheduleChangePreview {
  return {
    affectedMilestoneIds: [],
    affectedProjects: [{ projectId: 'refero', teamId: task.teamId }],
    conflicts: [],
    evaluatedRevisions: [{
      expectedRevision: task.revision,
      teamId: task.teamId,
      workItemId: task.id,
    }],
    expectedRevision: task.revision,
    impacts: [{
      after: structuredClone(task.schedule),
      before: structuredClone(task.schedule),
      dateDeltaDays: 0,
      expectedRevision: task.revision,
      kind: 'direct',
      teamId: task.teamId,
      workItemId: task.id,
    }],
    planningRevision: 1,
    relationGraphRevision: 1,
    requiresConfirmation: true,
    warnings: [],
  }
}

/** Returns an updated immutable task snapshot for direct mutation stories. */
function createStoryUpdatedTask(task: CanonicalWorkItem): CanonicalWorkItem {
  return {
    ...task,
    revision: task.revision + 1,
    updatedAt: '2026-06-09T00:00:00.000Z',
  }
}

/** Props for a harness that proves cancelled timeline previews cannot revive a modal. */
type LateTimelinePreviewHarnessProps = {
  /** Whether switching the active tab remounts the Project screen before preview completion. */
  remountOnTabSwitch: boolean
}

/**
 * Keeps the delayed preview resolver outside TaskScreen so a Story play function can settle it
 * after the active Gantt surface has unmounted.
 *
 * @param props - Determines whether the test removes the whole screen or remounts another tab.
 * @returns The delayed timeline-preview regression harness.
 */
function LateTimelinePreviewHarness({ remountOnTabSwitch }: LateTimelinePreviewHarnessProps) {
  const [isMounted, setIsMounted] = useState(true)
  const [activeTab, setActiveTab] = useState<'gantt' | 'table'>('gantt')
  const [previewCallCount, setPreviewCallCount] = useState(0)
  const resolvePreviewRef = useRef<((preview: WorkItemScheduleChangePreview) => void) | undefined>(undefined)

  /** Starts a deliberately unresolved preview until the story asks it to settle. */
  const onPreviewScheduleChange = (task: CanonicalWorkItem, operation: WorkItemScheduleOperation) => {
    void task
    void operation
    setPreviewCallCount((count) => count + 1)
    return new Promise<WorkItemScheduleChangePreview>((resolve) => {
      resolvePreviewRef.current = resolve
    })
  }

  /** Resolves the current delayed preview only after the active timeline has gone away. */
  const resolvePendingPreview = () => {
    const task = storyTasks[0]
    if (task) resolvePreviewRef.current?.(createTimelinePreview(task))
  }

  return (
    <div>
      <div className="flex gap-2 p-2">
        <button
          data-testid="late-timeline-unmount"
          onClick={() => setIsMounted(false)}
          type="button"
        >
          Unmount timeline
        </button>
        <button
          data-testid="late-timeline-switch-tab"
          onClick={() => setActiveTab('table')}
          type="button"
        >
          Switch tab
        </button>
        <button
          data-testid="late-timeline-resolve-preview"
          onClick={resolvePendingPreview}
          type="button"
        >
          Resolve preview
        </button>
        <output data-testid="late-timeline-preview-count">
          {previewCallCount}
        </output>
      </div>
      {isMounted ? (
        <TaskScreen
          {...meta.args}
          initialTab={activeTab}
          key={remountOnTabSwitch ? activeTab : 'gantt'}
          onConfirmScheduleChange={async (task) => createStoryUpdatedTask(task)}
          onPreviewScheduleChange={onPreviewScheduleChange}
        />
      ) : null}
    </div>
  )
}

/** Props for the command-provider render-loop regression harness. */
type CommandProviderTaskScreenProps = {
  /** TaskScreen props rendered directly beneath the observable command provider. */
  taskScreenProps: ComponentProps<typeof TaskScreen>
}

/** Props for the stale create rejection harness. */
type StaleCreateRejectionHarnessProps = {
  /** TaskScreen inputs used by the replacement-editor regression. */
  taskScreenProps: ComponentProps<typeof TaskScreen>
}

/**
 * Holds a create request until the story explicitly rejects it after a replacement editor opens.
 *
 * @param props - TaskScreen inputs for the stale invocation scenario.
 * @returns A deterministic rejection control and the nested TaskScreen.
 */
function StaleCreateRejectionHarness({ taskScreenProps }: StaleCreateRejectionHarnessProps) {
  const rejectCreateRef = useRef<(() => void) | undefined>(undefined)
  const onCreateTask = useCallback(async () => new Promise<void>((_resolve, reject) => {
    rejectCreateRef.current = () => reject(new Error('先行する登録に失敗しました。'))
  }), [])

  return (
    <>
      <button
        data-testid="reject-stale-create"
        onClick={() => rejectCreateRef.current?.()}
        type="button"
      >
        先行登録を失敗させる
      </button>
      <TaskScreen {...taskScreenProps} onCreateTask={onCreateTask} />
    </>
  )
}

/**
 * Renders TaskScreen beneath the same observable registry shape used by the authenticated layout.
 *
 * The wrapper deliberately recreates route-level callbacks whenever its registry or local probe
 * state renders. TaskScreen must keep its action contribution stable unless an action capability,
 * selection, or executor actually changes.
 *
 * @param props - TaskScreen inputs for the provider regression scenario.
 * @returns An observable command provider and the nested TaskScreen.
 */
function CommandProviderTaskScreen({
  taskScreenProps,
}: CommandProviderTaskScreenProps) {
  const [registry] = useState(
    () => createWorkspaceCommandMenuWorkItemActionRegistry(),
  )
  const [providerRenderCount, setProviderRenderCount] = useState(0)
  const [publishCount, setPublishCount] = useState(0)
  const subscribe = useCallback((listener: () => void) => registry.subscribe(() => {
    setPublishCount((count) => count + 1)
    listener()
  }), [registry])
  const registeredActions = useSyncExternalStore(
    subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  )
  const contextValue = useMemo<WorkspaceCommandMenuContextValue>(() => ({
    registerWorkItemActions: registry.register,
  }), [registry])
  const onCreateTask = taskScreenProps.onCreateTask
  const onUpdateIssue = taskScreenProps.onUpdateIssue
  const onUpdateTask = taskScreenProps.onUpdateTask

  return (
    <WorkspaceCommandMenuContext.Provider value={contextValue}>
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white p-2">
        <button
          className="rounded border border-slate-300 px-2 py-1 text-xs"
          data-testid="command-provider-rerender"
          onClick={() => setProviderRenderCount((count) => count + 1)}
          type="button"
        >
          Provider render {providerRenderCount}
        </button>
        <output data-testid="command-provider-action-count">
          {registeredActions.length}
        </output>
        <output data-testid="command-provider-publish-count">
          {publishCount}
        </output>
        <output data-testid="command-provider-action-summary">
          {registeredActions.map((action) => (
            `${action.id}:${action.disabledReason === undefined ? 'enabled' : 'disabled'}`
          )).join(',')}
        </output>
      </div>
      <TaskScreen
        {...taskScreenProps}
        onCreateTask={onCreateTask
          ? (input, context) => onCreateTask(input, context)
          : undefined}
        onSelectedIssueChange={(task) => taskScreenProps.onSelectedIssueChange?.(task)}
        onUpdateIssue={onUpdateIssue
          ? (teamId, issueId, input) => onUpdateIssue(teamId, issueId, input)
          : undefined}
        onUpdateTask={onUpdateTask
          ? (task, input) => onUpdateTask(task, input)
          : undefined}
      />
    </WorkspaceCommandMenuContext.Provider>
  )
}

const meta = {
  title: 'Application/Projects/Task Screen',
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
    onCreateTask: async () => undefined,
    onProjectQuickAccessToggle,
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
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const quickAccessButton = canvas.getByRole('button', {
      name: 'プロジェクトをクイックアクセスに追加',
    })
    onProjectQuickAccessToggle.mockClear()

    await expect(quickAccessButton).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(quickAccessButton)
    await expect(onProjectQuickAccessToggle).toHaveBeenCalledTimes(1)
    const statusButton = canvas.getByRole('button', { name: 'ステータス' })

    await userEvent.click(statusButton)
    await expect(statusButton).toHaveAttribute('aria-expanded', 'true')
    const statusOptions = within(canvas.getByRole('menu')).getAllByRole(
      'menuitemradio',
    )
    const firstStatusOption = statusOptions[0]
    const secondStatusOption = statusOptions[1]
    const lastStatusOption = statusOptions.at(-1)

    if (!firstStatusOption || !secondStatusOption || !lastStatusOption) {
      throw new Error('Expected at least two task status options.')
    }

    await expect(firstStatusOption).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(secondStatusOption).toHaveFocus()
    await userEvent.keyboard('{End}')
    await expect(lastStatusOption).toHaveFocus()
    await userEvent.keyboard('{Home}')
    await expect(firstStatusOption).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect(statusButton).toHaveFocus()
    await expect(statusButton).toHaveAttribute('aria-expanded', 'false')
    await expect(canvas.queryByRole('menu')).not.toBeInTheDocument()

    await userEvent.click(statusButton)
    await userEvent.click(canvas.getByRole('searchbox', { name: '検索...' }))
    await expect(statusButton).toHaveAttribute('aria-expanded', 'false')
    await expect(canvas.queryByRole('menu')).not.toBeInTheDocument()

    await userEvent.click(statusButton)
    await expect(canvas.getByRole('menuitemradio', {
      name: 'すべてのステータス',
    })).toHaveFocus()
    await userEvent.tab()
    await expect(statusButton).toHaveAttribute('aria-expanded', 'false')
    await expect(canvas.queryByRole('menu')).not.toBeInTheDocument()

    await userEvent.click(statusButton)
    await userEvent.click(canvas.getByRole('menuitemradio', {
      name: 'すべてのステータス',
    }))
    await expect(statusButton).toHaveAttribute('aria-expanded', 'false')
    await expect(canvas.queryByRole('menu')).not.toBeInTheDocument()
  },
}

/**
 * クイックアクセスへ追加済みの Project header です。
 */
export const QuickAccess: Story = {
  args: {
    isProjectQuickAccess: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const quickAccessButton = canvas.getByRole('button', {
      name: 'プロジェクトをクイックアクセスから削除',
    })

    await expect(quickAccessButton).toHaveAttribute('aria-pressed', 'true')
    await expect(quickAccessButton).toBeEnabled()
  },
}

/**
 * モバイル幅でも Project のクイックアクセス操作へ到達できる状態です。
 */
export const MobileQuickAccess: Story = {
  args: {
    isProjectQuickAccess: true,
  },
  globals: {
    viewport: {
      value: 'mobile1',
      isRotated: false,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByRole('button', {
      name: 'プロジェクトをクイックアクセスから削除',
    })).toBeVisible()
  },
}

/**
 * クイックアクセス設定の保存中に重複操作を防ぐ状態です。
 */
export const QuickAccessSaving: Story = {
  args: {
    isProjectQuickAccess: true,
    isProjectQuickAccessSaving: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const quickAccessButton = canvas.getByRole('button', {
      name: 'プロジェクトをクイックアクセスから削除',
    })

    await expect(quickAccessButton).toBeDisabled()
    await expect(quickAccessButton).toHaveAttribute('aria-busy', 'true')
  },
}

/**
 * 認証とタスク取得中の loading 表示です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const status = canvas.getByRole('status')
    const busyRegion = status.closest('section')

    if (!busyRegion) {
      throw new Error('Expected the loading status inside the busy task region.')
    }

    await expect(status).toHaveTextContent('タスク一覧を確認しています。')
    await expect(busyRegion).toHaveAttribute('aria-busy', 'true')
  },
}

/** Planning dependency failure that leaves the primary task table usable and retryable. */
export const PlanningUnavailable: Story = {
  args: {
    onRetryPlanning,
    planningErrorMessage: 'Planning の依存関係を取得できませんでした。',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onRetryPlanning.mockClear()

    await expect(canvas.getByTestId('task-row-wireframe')).toBeVisible()
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      'Planning の依存関係を取得できませんでした。',
    )
    await userEvent.click(canvas.getByRole('button', { name: '再試行' }))
    await expect(onRetryPlanning).toHaveBeenCalledTimes(1)
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
 * Desktop row context click opens the canonical Project action popover.
 */
export const ProjectContextMenuDesktop: Story = {
  args: {
    onSelectedIssueChange: onContextMenuSelectedIssueChange,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    const taskRow = canvas.getByTestId('task-row-wireframe')
    onContextMenuSelectedIssueChange.mockClear()

    await userEvent.pointer({ keys: '[MouseRight]', target: taskRow })
    const menu = await documentBody.findByTestId('project-task-action-context-menu')
    const menuItems = within(menu)
    const openItem = menuItems.getByRole('menuitem', { name: /Work Item を開く/u })
    const moveItem = menuItems.getByRole('menuitem', { name: /Work Item を移動/u })

    await expect(
      documentBody.getByTestId('project-task-action-context-menu-backdrop'),
    ).toHaveAttribute('data-layout', 'popover')
    await expect(openItem).toHaveFocus()
    await expect(moveItem).toHaveAttribute('aria-disabled', 'true')
    await expect(moveItem).toHaveTextContent(
      'この操作には移動先の指定または確認が必要なため、ここからは実行できません。',
    )

    await userEvent.click(openItem)
    await waitFor(() => expect(onContextMenuSelectedIssueChange).toHaveBeenCalledTimes(1))
    await expect(documentBody.queryByTestId('project-task-action-context-menu')).not
      .toBeInTheDocument()
    await expect(taskRow).toHaveFocus()
  },
}

/**
 * Mobile Board overflow control opens a touch-sized bottom sheet and restores scroll/focus.
 */
export const ProjectContextMenuMobile: Story = {
  args: {
    initialTab: 'board',
  },
  globals: {
    viewport: {
      value: 'mobile1',
      isRotated: false,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBodyElement = canvasElement.ownerDocument.body
    const documentBody = within(documentBodyElement)
    const menuButton = await canvas.findByTestId('task-card-actions-wireframe')
    const previousOverflow = documentBodyElement.style.overflow

    await userEvent.click(menuButton)
    const menu = await documentBody.findByTestId('project-task-action-context-menu')
    const openItem = within(menu).getByRole('menuitem', { name: /Work Item を開く/u })

    await expect(
      documentBody.getByTestId('project-task-action-context-menu-backdrop'),
    ).toHaveAttribute('data-layout', 'sheet')
    await expect(openItem).toHaveFocus()
    expect(window.getComputedStyle(openItem).minHeight).toBe('52px')
    expect(documentBodyElement.style.overflow).toBe('hidden')

    await userEvent.keyboard('{Escape}')
    await expect(documentBody.queryByTestId('project-task-action-context-menu')).not
      .toBeInTheDocument()
    await expect(menuButton).toHaveFocus()
    expect(documentBodyElement.style.overflow).toBe(previousOverflow)
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
    currentUserProjectKey: 'sato@example.com',
    projectName: 'Refero Strategic Delivery Workspace',
    teamName: 'コアチーム・プロダクトオペレーション',
    teams: createOpenTeams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByTestId('create-task-destination')).toHaveTextContent(
      'コアチーム・プロダクトオペレーション / Refero Strategic Delivery Workspace',
    )
    await expect(canvas.getByRole('combobox', { name: '担当者' })).toHaveValue(
      'sato@example.com',
    )
  },
}

/** Keeps a replacement create editor intact when an older invocation rejects. */
export const StaleCreateFailureDoesNotOverwriteReplacement: Story = {
  args: {
    currentUserProjectKey: 'sato@example.com',
  },
  render: (args) => <StaleCreateRejectionHarness taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('button', { name: '新規タスク' }))
    const firstFormElement = canvas.getByTestId('create-task-form')
    const firstForm = within(firstFormElement)
    await userEvent.type(firstForm.getByRole('textbox', { name: 'タスク名' }), '先行登録')
    await userEvent.click(firstForm.getByRole('button', { name: '登録' }))
    await expect(firstForm.getByRole('button', { name: '登録中' })).toBeDisabled()

    await userEvent.click(canvas.getByRole('button', { name: '新規タスク' }))
    await expect(canvas.queryByTestId('create-task-form')).toBeNull()
    await userEvent.click(canvas.getByRole('button', { name: '新規タスク' }))
    const replacementForm = canvas.getByTestId('create-task-form')
    await userEvent.click(canvas.getByTestId('reject-stale-create'))

    const replacementFormQueries = within(replacementForm)
    await expect(replacementFormQueries.queryByRole('alert')).toBeNull()
    await expect(replacementFormQueries.getByRole('textbox', { name: 'タスク名' })).toHaveValue('')
    await expect(replacementFormQueries.getByRole('button', { name: '登録' })).toBeEnabled()
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

/** Read-only Project members can still open a task detail pane. */
export const ReadOnlyOpen: Story = {
  args: {
    canMutateTask: () => false,
    onSelectedIssueChange: onReadOnlySelectedIssueChange,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onReadOnlySelectedIssueChange.mockClear()

    await userEvent.click(canvas.getByTestId('task-row-wireframe'))

    await waitFor(() => expect(onReadOnlySelectedIssueChange).toHaveBeenCalledTimes(1))
    expect(onReadOnlySelectedIssueChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wireframe', teamId: 'core-team' }),
    )
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

/** Inline status changes pass through one canonical mutation before the editor closes. */
export const DirectInlinePatch: Story = {
  args: {
    onUpdateTask: onDirectPatchMutation,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onDirectPatchMutation.mockClear()

    await userEvent.click(canvas.getByTestId('task-inline-status-wireframe'))
    await userEvent.selectOptions(
      canvas.getByTestId('task-inline-status-wireframe-input'),
      'review',
    )

    await waitFor(() => expect(onDirectPatchMutation).toHaveBeenCalledTimes(1))
    const [task, patch] = onDirectPatchMutation.mock.calls[0] ?? []
    expect(task).toMatchObject({ id: 'wireframe', revision: 1, teamId: 'core-team' })
    expect(patch).toEqual({ workflowStatusId: 'review' })
  },
}

/** Configuration access rejection prevents a direct inline edit from reaching persistence. */
export const DirectInlinePatchPermissionDenied: Story = {
  args: {
    configurationFailedTeamIds: ['core-team'],
    onUpdateTask: onDeniedDirectPatchMutation,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onDeniedDirectPatchMutation.mockClear()

    await userEvent.click(canvas.getByTestId('task-inline-title-wireframe'))
    const titleInput = canvas.getByTestId('task-inline-title-wireframe-input')
    await userEvent.clear(titleInput)
    await userEvent.type(titleInput, '更新できないタイトル')
    await userEvent.tab()

    await canvas.findByTestId('task-action-feedback')
    await expect(onDeniedDirectPatchMutation).toHaveBeenCalledTimes(0)
  },
}

/** A Gantt edit previews exactly once, then persists only after explicit confirmation. */
export const TimelinePreviewAndConfirm: Story = {
  args: {
    initialTab: 'gantt',
    onConfirmScheduleChange: onTimelineConfirm,
    onPreviewScheduleChange: onTimelinePreview,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onTimelinePreview.mockClear()
    onTimelineConfirm.mockClear()
    const modeSelect = canvas.getAllByLabelText('スケジュール種別')[0]

    if (!modeSelect) throw new Error('Expected the first Gantt schedule mode selector.')
    await userEvent.selectOptions(modeSelect, 'milestone')

    const dialog = await canvas.findByRole('dialog')
    await expect(onTimelinePreview).toHaveBeenCalledTimes(1)
    await expect(onTimelineConfirm).toHaveBeenCalledTimes(0)
    await userEvent.click(within(dialog).getByRole('button', { name: '適用' }))
    await waitFor(() => expect(onTimelineConfirm).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument())
  },
}

/** Cancelling a Gantt preview leaves the canonical mutation callback untouched. */
export const TimelinePreviewCancel: Story = {
  args: {
    initialTab: 'gantt',
    onConfirmScheduleChange: onCancelledTimelineConfirm,
    onPreviewScheduleChange: onCancelledTimelinePreview,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onCancelledTimelinePreview.mockClear()
    onCancelledTimelineConfirm.mockClear()
    const modeSelect = canvas.getAllByLabelText('スケジュール種別')[0]

    if (!modeSelect) throw new Error('Expected the first Gantt schedule mode selector.')
    await userEvent.selectOptions(modeSelect, 'milestone')

    const dialog = await canvas.findByRole('dialog')
    await expect(onCancelledTimelinePreview).toHaveBeenCalledTimes(1)
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await expect(onCancelledTimelineConfirm).toHaveBeenCalledTimes(0)
    await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument()
  },
}

/** Timeline permission rejection occurs before the server preview request or dialog. */
export const TimelinePreviewPermissionDenied: Story = {
  args: {
    configurationFailedTeamIds: ['core-team'],
    initialTab: 'gantt',
    onConfirmScheduleChange: onDeniedTimelineConfirm,
    onPreviewScheduleChange: onDeniedTimelinePreview,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onDeniedTimelinePreview.mockClear()
    onDeniedTimelineConfirm.mockClear()
    const modeSelect = canvas.getAllByLabelText('スケジュール種別')[0]

    if (!modeSelect) throw new Error('Expected the first Gantt schedule mode selector.')
    await userEvent.selectOptions(modeSelect, 'milestone')

    await canvas.findByTestId('task-action-feedback')
    await expect(onDeniedTimelinePreview).toHaveBeenCalledTimes(0)
    await expect(onDeniedTimelineConfirm).toHaveBeenCalledTimes(0)
    await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument()
  },
}

/** An unmounted timeline cannot show a late schedule-preview dialog. */
export const TimelinePreviewUnmounted: Story = {
  render: () => <LateTimelinePreviewHarness remountOnTabSwitch={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    const modeSelect = canvas.getAllByLabelText('スケジュール種別')[0]

    if (!modeSelect) throw new Error('Expected the first Gantt schedule mode selector.')
    await userEvent.selectOptions(modeSelect, 'milestone')
    await waitFor(() => expect(
      canvas.getByTestId('late-timeline-preview-count'),
    ).toHaveTextContent('1'))
    await userEvent.click(canvas.getByTestId('late-timeline-unmount'))
    await waitFor(() => expect(
      canvas.queryByTestId('task-gantt-timeline-wireframe'),
    ).not.toBeInTheDocument())
    await userEvent.click(canvas.getByTestId('late-timeline-resolve-preview'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(documentBody.queryByRole('dialog')).not.toBeInTheDocument()
  },
}

/** Switching from Gantt while a preview is pending cannot let the old tab create a modal. */
export const TimelinePreviewAfterTabSwitch: Story = {
  render: () => <LateTimelinePreviewHarness remountOnTabSwitch />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    const modeSelect = canvas.getAllByLabelText('スケジュール種別')[0]

    if (!modeSelect) throw new Error('Expected the first Gantt schedule mode selector.')
    await userEvent.selectOptions(modeSelect, 'milestone')
    await waitFor(() => expect(
      canvas.getByTestId('late-timeline-preview-count'),
    ).toHaveTextContent('1'))
    await userEvent.click(canvas.getByTestId('late-timeline-switch-tab'))
    await waitFor(() => expect(canvas.getByTestId('tasks-count')).toBeInTheDocument())
    await userEvent.click(canvas.getByTestId('late-timeline-resolve-preview'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(documentBody.queryByRole('dialog')).not.toBeInTheDocument()
    expect(canvas.queryByTestId('task-gantt-timeline-wireframe')).not.toBeInTheDocument()
  },
}

/**
 * Command-provider renders keep one stable Project action contribution, including Watch.
 */
export const CommandProviderRegistrationStable: Story = {
  render: (args) => <CommandProviderTaskScreen taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const actionCount = canvas.getByTestId('command-provider-action-count')
    const actionSummary = canvas.getByTestId('command-provider-action-summary')
    const publishCount = canvas.getByTestId('command-provider-publish-count')

    await waitFor(() => expect(actionCount).toHaveTextContent('9'))
    const taskRow = canvas.getByTestId('task-row-wireframe')
    await userEvent.click(within(taskRow).getByRole('button', {
      name: 'ワイヤーフレームを確認する',
    }))
    await waitFor(() => expect(actionSummary).toHaveTextContent('watch:enabled'))

    const publishCountBeforeProviderRender = publishCount.textContent
    await userEvent.click(canvas.getByTestId('command-provider-rerender'))

    await expect(canvas.getByTestId('command-provider-rerender')).toHaveTextContent(
      'Provider render 1',
    )
    await expect(actionCount).toHaveTextContent('9')
    await expect(actionSummary).toHaveTextContent('watch:enabled')
    expect(publishCount.textContent).toBe(publishCountBeforeProviderRender)
  },
}
