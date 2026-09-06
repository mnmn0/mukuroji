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
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test'
import { TaskScreen } from './TaskScreen'
import type { TaskDetailAiAssistanceRenderContext } from './TaskDetailPane'
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

const ambiguousSelectionTasks = [
  ...storyTasks,
  {
    ...storyTasks[0],
    teamId: 'design-team',
  },
]

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
const onRetryTasks = fn()
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

/** Props for a harness that resolves a Gantt schedule preview on demand. */
type PendingCreateDraftPreviewHarnessProps = {
  /** TaskScreen inputs used by the pending create-draft preview scenario. */
  taskScreenProps: ComponentProps<typeof TaskScreen>
}

/** Pending preview state controlled by the Story play function. */
type PendingCreateDraftPreview = {
  /** Completes the delayed preview with a canonical server response. */
  resolve: (preview: WorkItemScheduleChangePreview) => void
  /** Task used to build the canonical preview response. */
  task: CanonicalWorkItem
}

/**
 * Holds a Gantt preview until the Story play function has entered a create draft.
 *
 * @param props - TaskScreen inputs for the pending preview scenario.
 * @returns A preview resolver control and the nested TaskScreen.
 */
function PendingCreateDraftPreviewHarness({ taskScreenProps }: PendingCreateDraftPreviewHarnessProps) {
  const [previewCallCount, setPreviewCallCount] = useState(0)
  const pendingPreviewRef = useRef<PendingCreateDraftPreview | undefined>(undefined)

  /** Defers the server preview until the Story explicitly resolves it. */
  const onPreviewScheduleChange = useCallback((
    task: CanonicalWorkItem,
    operation: WorkItemScheduleOperation,
  ) => {
    void operation
    setPreviewCallCount((count) => count + 1)
    return new Promise<WorkItemScheduleChangePreview>((resolve) => {
      pendingPreviewRef.current = { resolve, task }
    })
  }, [])

  /** Resolves the currently pending preview with the existing canonical fixture. */
  const resolvePendingPreview = () => {
    const pendingPreview = pendingPreviewRef.current
    if (!pendingPreview) return
    pendingPreview.resolve(createTimelinePreview(pendingPreview.task))
    pendingPreviewRef.current = undefined
  }

  return (
    <div>
      <div className="flex gap-2 p-2">
        <button
          data-testid="create-draft-preview-resolve"
          onClick={resolvePendingPreview}
          type="button"
        >
          Resolve preview
        </button>
        <output data-testid="create-draft-preview-count">
          {previewCallCount}
        </output>
      </div>
      <TaskScreen
        {...taskScreenProps}
        onPreviewScheduleChange={onPreviewScheduleChange}
      />
    </div>
  )
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

/** Props for the AI operation tab-guard Story harness. */
type AiOperationPendingHarnessProps = {
  /** TaskScreen inputs rendered below the deterministic pending control. */
  taskScreenProps: ComponentProps<typeof TaskScreen>
}

/** Exposes a deterministic pending AI operation for guarded task-tab interactions. */
function AiOperationPendingHarness({ taskScreenProps }: AiOperationPendingHarnessProps) {
  const renderAiAssistance = useCallback((context: TaskDetailAiAssistanceRenderContext) => ({
    planning: (
      <>
        <button
          data-testid="begin-ai-operation"
          onClick={() => context.onPlanningOperationPendingChange?.(true)}
          type="button"
        >
          Begin AI operation
        </button>
        <button
          data-testid="finish-ai-operation"
          onClick={() => context.onPlanningOperationPendingChange?.(false)}
          type="button"
        >
          Finish AI operation
        </button>
      </>
    ),
  }), [])

  return (
    <TaskScreen
      {...taskScreenProps}
      aiAssistanceEnabled
      renderAiAssistance={renderAiAssistance}
    />
  )
}

/**
 * Holds a create request until the story explicitly rejects it after a replacement editor opens.
 *
 * @param props - TaskScreen inputs for the stale invocation scenario.
 * @returns A deterministic rejection control and the nested TaskScreen.
 */
function StaleCreateRejectionHarness({ taskScreenProps }: StaleCreateRejectionHarnessProps) {
  const rejectCreateRef = useRef<(() => void) | undefined>(undefined)
  /** Holds the story create request until the regression control rejects it. */
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

/** Props for the canonical create failure and retry harness. */
type CreateFailureRetryHarnessProps = {
  /** TaskScreen inputs used by the create failure and retry scenario. */
  taskScreenProps: ComponentProps<typeof TaskScreen>
}

/** Fails the first create request and lets the next request complete successfully. */
function CreateFailureRetryHarness({ taskScreenProps }: CreateFailureRetryHarnessProps) {
  const createAttemptRef = useRef(0)
  const [createAttemptCount, setCreateAttemptCount] = useState(0)
  const onCreateTask = useCallback(async () => {
    createAttemptRef.current += 1
    setCreateAttemptCount(createAttemptRef.current)
    if (createAttemptRef.current === 1) {
      throw new Error('作成 API が一時的に失敗しました。')
    }
  }, [])

  return (
    <>
      <output data-testid="create-failure-attempt-count">{createAttemptCount}</output>
      <TaskScreen {...taskScreenProps} onCreateTask={onCreateTask} />
    </>
  )
}

/** Props for the same-scope create draft permission revalidation scenario. */
type CreatePermissionRevalidationHarnessProps = {
  /** TaskScreen inputs used by the permission revalidation scenario. */
  taskScreenProps: ComponentProps<typeof TaskScreen>
}

/** Props for the canonical detail focus harness. */
type CanonicalDetailFocusHarnessProps = {
  /** Whether the selected canonical detail permits editor controls. */
  canMutate: boolean
  /** TaskScreen inputs used by the canonical detail focus scenario. */
  taskScreenProps: ComponentProps<typeof TaskScreen>
}

/** Keeps a Team-qualified detail available while routed selection permission changes. */
function CanonicalDetailFocusHarness({
  canMutate,
  taskScreenProps,
}: CanonicalDetailFocusHarnessProps) {
  const selectedTask = taskScreenProps.tasks?.find((task) => task.id === 'wireframe')
  const [selectedIssueId, setSelectedIssueId] = useState<string>()
  const listTasks = taskScreenProps.tasks ?? []
  const [detail, setDetail] = useState<TeamIssueDetail | undefined>()
  const [detailCanMutate, setDetailCanMutate] = useState(true)
  const selectTask = useCallback((task: CanonicalWorkItem) => {
    setSelectedIssueId(task.id)
    setDetailCanMutate(canMutate)
    setDetail({
      ...selectedIssueDetail,
      issue: task,
    })
    taskScreenProps.onSelectedIssueChange?.(task)
  }, [canMutate, taskScreenProps])

  if (!selectedTask) throw new Error('Expected the canonical focus fixture task.')

  return (
    <TaskScreen
      {...taskScreenProps}
      canMutateTask={() => detailCanMutate}
      onSelectedIssueChange={selectTask}
      selectedIssueDetail={detail}
      selectedIssueId={selectedIssueId}
      tasks={listTasks}
    />
  )
}

/** Toggles create permission without remounting the same Project editor. */
function CreatePermissionRevalidationHarness({
  taskScreenProps,
}: CreatePermissionRevalidationHarnessProps) {
  const [canCreate, setCanCreate] = useState(true)
  const [createAttemptCount, setCreateAttemptCount] = useState(0)
  const onCreateTask = useCallback(async () => {
    setCreateAttemptCount((count) => count + 1)
  }, [])

  return (
    <>
      <button
        data-testid="revoke-create-permission"
        onClick={() => setCanCreate(false)}
        type="button"
      >
        Revoke create permission
      </button>
      <button
        data-testid="restore-create-permission"
        onClick={() => setCanCreate(true)}
        type="button"
      >
        Restore create permission
      </button>
      <output data-testid="permission-create-attempt-count">{createAttemptCount}</output>
      <TaskScreen
        {...taskScreenProps}
        defaultCreateTaskOpen
        onCreateTask={canCreate ? onCreateTask : undefined}
      />
    </>
  )
}

/** Props for a harness that settles an older create request successfully. */
type StaleCreateSuccessHarnessProps = {
  /** TaskScreen inputs used by the replacement-editor success scenario. */
  taskScreenProps: ComponentProps<typeof TaskScreen>
}

/** Holds a create request until the story resolves it after a replacement editor opens. */
function StaleCreateSuccessHarness({ taskScreenProps }: StaleCreateSuccessHarnessProps) {
  const resolveCreateRef = useRef<(() => void) | undefined>(undefined)
  const [createCallCount, setCreateCallCount] = useState(0)
  /** Holds the story create request until the regression control resolves it. */
  const onCreateTask = useCallback(async () => {
    setCreateCallCount((count) => count + 1)
    await new Promise<void>((resolve) => {
      resolveCreateRef.current = resolve
    })
  }, [])

  return (
    <>
      <button
        data-testid="resolve-stale-create"
        onClick={() => resolveCreateRef.current?.()}
        type="button"
      >
        先行登録を完了させる
      </button>
      <output data-testid="stale-create-call-count">{createCallCount}</output>
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

/** AI operations reject a guarded Files transition without clearing local detail ownership. */
export const AiOperationPendingBlocksDetailTab: Story = {
  args: {
    initialSelectedTaskId: 'wireframe',
    onBulkApply: fn(),
    onBulkPreview: fn(),
    selectedIssueDetail,
    workspaceId: 'workspace-1',
  },
  render: (args) => <AiOperationPendingHarness taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = await canvas.findByRole('textbox', { name: 'コメント本文' })
    await userEvent.type(body, 'AI処理中も保持するコメント下書き')
    await userEvent.click(canvas.getByTestId('begin-ai-operation'))

    const fileTab = canvas.getByRole('tab', { name: 'ファイル' })
    let confirmCount = 0
    const originalConfirm = globalThis.window.confirm
    globalThis.window.confirm = () => {
      confirmCount += 1
      return true
    }
    try {
      await userEvent.click(fileTab)
      const secondTaskRow = canvas.getByTestId('task-row-brand-guideline')
      const secondTaskCheckbox = within(secondTaskRow).getByRole('checkbox')
      await expect(secondTaskCheckbox).toBeEnabled()
      await userEvent.click(secondTaskCheckbox)
      await expect(secondTaskCheckbox).toBeChecked()
      await waitFor(() => expect(canvas.getByTestId('task-row-brand-guideline')).toHaveAttribute(
        'data-selected',
        'true',
      ))
      secondTaskRow.focus()
      await userEvent.keyboard('e')
      await expect(fileTab).toHaveAttribute('aria-selected', 'false')
      await expect(body).toHaveValue('AI処理中も保持するコメント下書き')
      expect(confirmCount).toBe(0)

      await userEvent.click(canvas.getByTestId('finish-ai-operation'))
      confirmCount = 0
      globalThis.window.confirm = () => {
        confirmCount += 1
        return false
      }
      secondTaskRow.focus()
      await userEvent.keyboard('e')
    } finally {
      globalThis.window.confirm = originalConfirm
    }
    await expect(fileTab).toHaveAttribute('aria-selected', 'false')
    await expect(body).toHaveValue('AI処理中も保持するコメント下書き')
    expect(confirmCount).toBe(1)
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

/** An explicit ambiguous route selection stays unresolved instead of opening another task. */
export const ExplicitAmbiguousSelection: Story = {
  args: {
    activeProjectTeamId: undefined,
    detailErrorMessage: 'タスク詳細を取得できませんでした',
    selectedIssueId: 'wireframe',
    tasks: ambiguousSelectionTasks,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const detailPaneElement = canvas.getByTestId('task-detail-pane')
    const detailPane = within(detailPaneElement)

    await expect(detailPaneElement).toHaveTextContent('タスク詳細を取得できませんでした')
    await expect(detailPane.queryByRole('heading', {
      name: 'ワイヤーフレームを確認する',
    })).not.toBeInTheDocument()
  },
}

/** Keeps a stale Project-list row closed when its detail response belongs elsewhere. */
export const DetailScopeUnavailable: Story = {
  args: {
    detailErrorMessage: 'タスク詳細を取得できませんでした',
    selectedIssueDetailUnavailable: true,
    selectedIssueId: 'wireframe',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const detailPane = canvas.getByTestId('task-detail-pane')

    await expect(detailPane).toHaveTextContent('タスク詳細を取得できませんでした')
    await expect(detailPane).not.toHaveTextContent('ワイヤーフレームを確認する')
    await expect(canvas.queryByTestId('project-task-error')).toBeNull()
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

/** Keeps a same-Project draft visible while create permission is revalidated. */
export const CreateDraftRetainsPermissionLoss: Story = {
  args: {
    currentUserProjectKey: 'sato@example.com',
  },
  render: (args) => <CreatePermissionRevalidationHarness taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const createTaskForm = canvas.getByTestId('create-task-form')
    const formQueries = within(createTaskForm)

    await userEvent.type(formQueries.getByRole('textbox', { name: 'タスク名' }), 'permission draft')
    await userEvent.click(canvas.getByTestId('revoke-create-permission'))

    await expect(canvas.getByTestId('create-task-form')).toBeInTheDocument()
    await expect(formQueries.getByRole('alert')).toHaveTextContent(
      'このプロジェクトでタスクを登録する権限がなくなりました。',
    )
    await expect(formQueries.getByRole('button', { name: /^登録$/u })).toBeDisabled()
    await expect(formQueries.getByRole('textbox', { name: 'タスク名' })).toHaveValue(
      'permission draft',
    )
    if (!(createTaskForm instanceof HTMLFormElement)) {
      throw new Error('Expected the create task panel to render a form.')
    }
    createTaskForm.requestSubmit()
    await expect(canvas.getByTestId('permission-create-attempt-count')).toHaveTextContent('0')

    await userEvent.click(canvas.getByTestId('restore-create-permission'))
    await expect(formQueries.queryByRole('alert')).toBeNull()
    await expect(formQueries.getByRole('button', { name: /^登録$/u })).toBeEnabled()
    await userEvent.click(formQueries.getByRole('button', { name: /^登録$/u }))
    await expect(canvas.queryByTestId('create-task-form')).not.toBeInTheDocument()
    await expect(canvas.getByTestId('permission-create-attempt-count')).toHaveTextContent('1')
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

    const originalConfirm = globalThis.window.confirm
    globalThis.window.confirm = () => true
    try {
      await userEvent.click(canvas.getByRole('button', { name: '新規タスク' }))
    } finally {
      globalThis.window.confirm = originalConfirm
    }
    await expect(canvas.queryByTestId('create-task-form')).toBeNull()
    await userEvent.click(canvas.getByRole('button', { name: '新規タスク' }))
    const replacementForm = canvas.getByTestId('create-task-form')
    await expect(within(replacementForm).getByRole('button', { name: '登録中' })).toBeDisabled()
    await expect(within(replacementForm).getByRole('textbox', { name: 'タスク名' })).toBeDisabled()
    fireEvent.submit(replacementForm)
    await userEvent.click(canvas.getByTestId('reject-stale-create'))

    const replacementFormQueries = within(replacementForm)
    await expect(replacementFormQueries.queryByRole('alert')).toBeNull()
    await expect(replacementFormQueries.getByRole('textbox', { name: 'タスク名' })).toHaveValue('')
    await expect(replacementFormQueries.getByRole('textbox', { name: 'タスク名' })).toBeEnabled()
    await expect(replacementFormQueries.getByRole('button', { name: '登録' })).toBeEnabled()
  },
}

/** Surfaces a rejected create after its editor was explicitly closed. */
export const ClosedCreateFailureUsesGlobalAlert: Story = {
  args: {
    currentUserProjectKey: 'sato@example.com',
  },
  render: (args) => <StaleCreateRejectionHarness taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('button', { name: '新規タスク' }))
    const createTaskForm = canvas.getByTestId('create-task-form')
    const form = within(createTaskForm)
    await userEvent.type(form.getByRole('textbox', { name: 'タスク名' }), 'closed failure')
    await userEvent.click(form.getByRole('button', { name: '登録' }))
    await expect(form.getByRole('button', { name: '登録中' })).toBeDisabled()

    const originalConfirm = globalThis.window.confirm
    globalThis.window.confirm = () => true
    try {
      await userEvent.click(canvas.getByRole('button', { name: '新規タスク' }))
    } finally {
      globalThis.window.confirm = originalConfirm
    }
    await expect(canvas.queryByTestId('create-task-form')).toBeNull()
    await userEvent.click(canvas.getByTestId('reject-stale-create'))

    const globalFailure = await canvas.findByTestId('task-action-feedback')
    await expect(globalFailure).toHaveTextContent('先行する登録に失敗しました。')
    await expect(canvas.getAllByRole('alert')).toHaveLength(1)
    await userEvent.click(within(globalFailure).getByRole('button', { name: '通知を閉じる' }))
    await expect(canvas.queryByTestId('task-action-feedback')).toBeNull()

    await userEvent.click(canvas.getByRole('button', { name: '新規タスク' }))
    const reopenedForm = canvas.getByTestId('create-task-form')
    await expect(within(reopenedForm).queryByRole('alert')).toBeNull()
  },
}

/** Shows a rejected create in its form and clears the error after a successful retry. */
export const CreateFailureUsesFormAlertOnly: Story = {
  args: {
    initialTab: 'board',
    currentUserProjectKey: 'sato@example.com',
  },
  render: (args) => <CreateFailureRetryHarness taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const boardCreateButton = canvasElement.querySelector<HTMLElement>(
      '[data-testid^="project-task-add-"]',
    )
    if (!boardCreateButton) throw new Error('Expected a Board column create button.')

    await userEvent.click(boardCreateButton)
    const createTaskForm = canvas.getByTestId('create-task-form')
    const form = within(createTaskForm)
    await userEvent.type(form.getByRole('textbox', { name: 'タスク名' }), 'story retry')

    await userEvent.click(form.getByRole('button', { name: /^登録$/u }))
    await expect(form.getByRole('alert')).toHaveTextContent(
      '作成 API が一時的に失敗しました。',
    )
    await expect(canvas.queryByTestId('task-action-feedback')).not.toBeInTheDocument()
    await expect(canvas.getAllByRole('alert')).toHaveLength(1)
    await expect(form.getByRole('button', { name: /^登録$/u })).toBeEnabled()
    await expect(form.getByRole('textbox', { name: 'タスク名' })).toHaveValue('story retry')

    await userEvent.click(form.getByRole('button', { name: /^登録$/u }))
    await expect(canvas.queryByTestId('create-task-form')).not.toBeInTheDocument()
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument()
    await expect(canvas.getByTestId('create-failure-attempt-count')).toHaveTextContent('2')
  },
}

/** Keeps detailed-only validation visible after a failed detailed create switches to quick mode. */
export const DetailedFailureKeepsQuickValidation: Story = {
  args: {
    initialTab: 'board',
    currentUserProjectKey: 'sato@example.com',
  },
  render: (args) => <CreateFailureRetryHarness taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const boardCreateButton = canvasElement.querySelector<HTMLElement>(
      '[data-testid^="project-task-add-"]',
    )
    if (!boardCreateButton) throw new Error('Expected a Board column create button.')

    await userEvent.click(boardCreateButton)
    const createTaskForm = canvas.getByTestId('create-task-form')
    const form = within(createTaskForm)
    await userEvent.click(form.getByRole('button', { name: /^詳細登録$/u }))
    await userEvent.type(form.getByRole('textbox', { name: 'タスク名' }), 'detailed failure')
    const assignee = createTaskForm.querySelector<HTMLSelectElement>(
      'select[name="assigneeUserId"]',
    )
    if (!assignee) throw new Error('Expected an assignee input.')
    fireEvent.change(assignee, { target: { value: 'sato@example.com' } })
    await userEvent.selectOptions(form.getByLabelText('スケジュール種別'), 'date-range')
    fireEvent.change(form.getByLabelText('開始日'), { target: { value: '2026-07-01' } })
    fireEvent.change(form.getByLabelText('終了日'), { target: { value: '2026-07-03' } })
    const riskLevel = createTaskForm.querySelector<HTMLSelectElement>(
      'select[name="custom-field:risk-level"]',
    )
    if (!riskLevel) throw new Error('Expected a risk level input.')
    await userEvent.selectOptions(riskLevel, 'moderate')
    const customerImpact = createTaskForm.querySelector<HTMLInputElement>(
      'input[name="custom-field:customer-impact"]',
    )
    if (!customerImpact) throw new Error('Expected a Customer impact input.')
    fireEvent.change(customerImpact, { target: { value: 'DetailedFailureContext' } })
    await expect(assignee).toHaveValue('sato@example.com')
    await expect(customerImpact).toHaveValue('DetailedFailureContext')
    await userEvent.click(form.getByRole('button', { name: /^登録$/u }))
    await expect(form.getByRole('alert')).toHaveTextContent(
      '作成 API が一時的に失敗しました。',
    )

    await userEvent.click(form.getByRole('button', { name: /^クイック登録$/u }))
    await userEvent.click(form.getByRole('button', { name: /^登録$/u }))
    await expect(createTaskForm).toHaveTextContent('詳細登録に戻ってから登録してください。')
    await expect(canvas.getByTestId('create-failure-attempt-count')).toHaveTextContent('1')
    await expect(form.getByRole('textbox', { name: 'タスク名' })).toHaveValue('detailed failure')
  },
}

/** Resets a same-context replacement editor after an older create succeeds. */
export const StaleCreateSuccessResetsReplacement: Story = {
  args: {
    initialTab: 'board',
    currentUserProjectKey: 'sato@example.com',
  },
  render: (args) => <StaleCreateSuccessHarness taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const boardCreateButton = canvasElement.querySelector<HTMLElement>(
      '[data-testid^="project-task-add-"]',
    )
    if (!boardCreateButton) throw new Error('Expected a Board column create button.')

    await userEvent.click(boardCreateButton)
    const firstForm = within(canvas.getByTestId('create-task-form'))
    await userEvent.type(firstForm.getByRole('textbox', { name: 'タスク名' }), '先行登録')
    await userEvent.click(firstForm.getByRole('button', { name: '登録' }))
    await expect(firstForm.getByRole('button', { name: '登録中' })).toBeDisabled()

    const originalConfirm = globalThis.window.confirm
    globalThis.window.confirm = () => true
    try {
      await userEvent.click(boardCreateButton)
    } finally {
      globalThis.window.confirm = originalConfirm
    }
    const replacementForm = within(canvas.getByTestId('create-task-form'))
    await expect(replacementForm.getByRole('textbox', { name: 'タスク名' })).toHaveValue('')
    await expect(replacementForm.getByRole('textbox', { name: 'タスク名' })).toBeDisabled()

    await userEvent.click(canvas.getByTestId('resolve-stale-create'))
    await expect(replacementForm.getByRole('textbox', { name: 'タスク名' })).toHaveValue('')
    await expect(replacementForm.getByRole('textbox', { name: 'タスク名' })).toBeEnabled()
    await expect(replacementForm.getByRole('button', { name: '登録' })).toBeEnabled()
    await expect(canvas.getByTestId('stale-create-call-count')).toHaveTextContent('1')
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

/** Read-only Table title focus survives Board/Table workspace remounts. */
export const ReadOnlyTableRemountRestoresFocus: Story = {
  args: {
    canMutateTask: () => false,
    initialTab: 'table',
    onSelectedIssueChange: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const titleButton = canvas.getByTestId('task-open-detail-wireframe')

    await userEvent.click(titleButton)
    await userEvent.click(canvas.getByRole('tab', { name: 'ボード' }))
    await userEvent.click(canvas.getByRole('tab', { name: 'テーブル' }))
    const remountedTitleButton = canvas.getByTestId('task-open-detail-wireframe')
    await userEvent.click(canvas.getByTestId('task-detail-close'))
    await waitFor(() => expect(remountedTitleButton).toHaveFocus())
  },
}

/** Canonical detail permission keeps the edit control focus after routed selection. */
export const CanonicalDetailKeepsEditFocus: Story = {
  render: (args) => <CanonicalDetailFocusHarness canMutate taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.pointer({ keys: '[MouseRight]', target: canvas.getByTestId('task-row-wireframe') })
    const menu = within(await documentBody.findByTestId('project-task-action-context-menu'))
    await userEvent.click(menu.getByRole('menuitem', { name: /Work Item を編集/u }))
    const detailPane = within(canvas.getByTestId('task-detail-pane'))
    await waitFor(() => expect(detailPane.getByRole('textbox', { name: 'Issue' })).toHaveFocus())
  },
}

/** Canonical detail permission falls back to the safe heading when edit focus is denied. */
export const CanonicalDetailDeniedFocusFallsBackToHeading: Story = {
  render: (args) => <CanonicalDetailFocusHarness canMutate={false} taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.pointer({ keys: '[MouseRight]', target: canvas.getByTestId('task-row-wireframe') })
    const menu = within(await documentBody.findByTestId('project-task-action-context-menu'))
    await userEvent.click(menu.getByRole('menuitem', { name: /Work Item を編集/u }))
    await waitFor(() => expect(within(canvas.getByTestId('task-detail-pane')).getByRole('heading', {
      name: 'ワイヤーフレームを確認する',
    })).toHaveFocus())
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
    onRetryTasks,
    taskErrorMessage: 'Lambda returned 500.',
    tasks: [],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onRetryTasks.mockClear()

    await expect(canvas.getByTestId('tasks-error')).toHaveTextContent('Lambda returned 500.')
    expect(canvas.getAllByRole('alert')).toHaveLength(1)
    const taskRetry = canvas.getByTestId('project-task-error')
    await userEvent.click(within(taskRetry).getByRole('button', { name: '再読み込み' }))
    await expect(onRetryTasks).toHaveBeenCalledTimes(1)
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

/** Keeps a create draft safe while a delayed Gantt preview is accepted or cancelled. */
export const TimelinePreviewCancelWithCreateDraft: Story = {
  args: {
    defaultCreateTaskOpen: true,
    initialTab: 'gantt',
    onConfirmScheduleChange: onCancelledTimelineConfirm,
  },
  render: (args) => <PendingCreateDraftPreviewHarness taskScreenProps={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onCancelledTimelineConfirm.mockClear()
    const form = canvas.getByTestId('create-task-form')
    const titleInput = within(form).getByRole('textbox', { name: 'タスク名' })

    const modeSelect = canvasElement.querySelector<HTMLSelectElement>(
      'select[id^="gantt-mode-"]',
    )
    if (!modeSelect) throw new Error('Expected the first Gantt schedule mode selector.')
    await userEvent.selectOptions(modeSelect, 'milestone')

    await expect(canvas.getByTestId('create-draft-preview-count')).toHaveTextContent('1')
    await expect(titleInput).toHaveValue('')
    await userEvent.type(titleInput, '保留中の作成下書き')

    const originalConfirm = globalThis.window.confirm
    let discardConfirmCount = 0
    globalThis.window.confirm = () => {
      discardConfirmCount += 1
      return false
    }
    try {
      await userEvent.click(await canvas.findByTestId('task-gantt-add-wireframe'))
      await expect(titleInput).toHaveValue('保留中の作成下書き')
    } finally {
      globalThis.window.confirm = originalConfirm
    }
    expect(discardConfirmCount).toBe(1)

    await userEvent.click(canvas.getByTestId('create-draft-preview-resolve'))
    const dialog = await canvas.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument()
    await expect(titleInput).toHaveValue('保留中の作成下書き')
    await expect(onCancelledTimelineConfirm).toHaveBeenCalledTimes(0)
  },
}

/** Rejecting a dirty create draft leaves Gantt schedule selection available for retry. */
export const TimelinePreviewDiscardRejectedKeepsCreateDraft: Story = {
  args: {
    defaultCreateTaskOpen: true,
    initialTab: 'gantt',
    onPreviewScheduleChange: onDeniedTimelinePreview,
    onConfirmScheduleChange: onDeniedTimelineConfirm,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    onDeniedTimelinePreview.mockClear()
    const form = canvas.getByTestId('create-task-form')
    const titleInput = within(form).getByRole('textbox', { name: 'タスク名' })
    const modeSelect = canvasElement.querySelector<HTMLSelectElement>(
      'select[id^="gantt-mode-"]',
    )
    if (!modeSelect) throw new Error('Expected the first Gantt schedule mode selector.')

    await userEvent.type(titleInput, '破棄拒否の作成下書き')
    const originalConfirm = globalThis.window.confirm
    let discardConfirmCount = 0
    globalThis.window.confirm = () => {
      discardConfirmCount += 1
      return false
    }
    try {
      await userEvent.selectOptions(modeSelect, 'milestone')
      await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument()
      await expect(onDeniedTimelinePreview).toHaveBeenCalledTimes(0)
      expect(discardConfirmCount).toBe(1)
      await expect(titleInput).toHaveValue('破棄拒否の作成下書き')

      await userEvent.selectOptions(modeSelect, 'milestone')
      await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument()
      await expect(onDeniedTimelinePreview).toHaveBeenCalledTimes(0)
      expect(discardConfirmCount).toBe(2)
    } finally {
      globalThis.window.confirm = originalConfirm
    }
    await expect(titleInput).toHaveValue('破棄拒否の作成下書き')
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
