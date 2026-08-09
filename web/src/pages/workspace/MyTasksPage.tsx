import type {
  TaskViewScope,
  WorkItemActionContext,
  WorkItemActionId,
  WorkItemActionResult,
  WorkItemActionSelection,
} from '@mukuroji/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  createBuiltInTaskViewDefinition,
  applyTaskViewDefinitionToTasks,
  presentationSettingsToTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
} from '../../task-views/model/taskViewSurfaceState'
import { useTaskViewController } from '../../task-views/mutations/useTaskViewController'
import {
  createFocusedTaskViewActionSelection,
  createTaskViewActionSelection,
  createTaskViewItemKey,
  createTaskViewSelectionKeyboardAction,
  createTaskViewSelectionState,
  reduceTaskViewSelection,
  type TaskViewSelectionState,
} from '../../task-views/model/taskViewSelection'
import {
  allowTaskAction,
  createFailedTaskActionResult,
  createSucceededTaskActionResult,
  denyTaskAction,
  resolveTaskActionExecutionFailureMessage,
  type TaskActionExecutionResult,
} from '../../task-views/model/taskActionRegistry'
import type { TaskActionContextMenuAnchorPoint } from '../../task-views/model/taskActionContextMenu'
import {
  createTaskSurfaceActionBaseContext,
  resolveTaskSurfaceActionTarget,
  resolveTaskSurfaceActionTargets,
  useTaskSurfaceActions,
  type TaskSurfaceActionDisabledReasons,
  type TaskSurfaceActionHandlers,
  type TaskSurfaceActionLabels,
  type TaskSurfaceActionPermissions,
} from '../../task-views/mutations/useTaskSurfaceActions'
import { TaskActionContextMenu } from '../../task-views/ui/TaskActionContextMenu'
import {
  createTaskSurfaceKeyboardInput,
  formatTaskSurfaceKeyboardShortcut,
} from '../../task-views/ui/taskSurfaceKeyboard'
import {
  TaskViewToolbar,
  type TaskViewFieldOption,
} from '../../task-views/ui/TaskViewToolbar'
import {
  createTaskViewOption,
  formatTaskViewMigrationWarning,
} from '../../task-views/ui/taskViewToolbarAdapter'
import {
  isOpenableWorkspaceTask,
  isWorkspaceTaskAssignedToUser,
} from '../../work-items/model/workspaceWorkItems'
import { resolveEditableWorkflowStatuses } from '../../work-items/model/workItemDisplay'
import { useWorkspaceTaskStatusMutation } from '../../workspace/mutations/useWorkspaceTaskStatusMutation'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import {
  WorkspaceConfigurationLoadNotice,
  WorkspaceTaskLoadNotice,
} from '../../workspace/ui/WorkspaceDataNotices'
import { MyTasksWorkspaceView } from '../../workspace/ui/MyTasksWorkspaceView'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

const taskViewBuiltInFields = [
  'title',
  'status',
  'assignee',
  'dueDate',
  'priority',
  'project',
  'team',
]

/** Transient My Tasks context-menu target retained independently from keyboard selection. */
type MyTaskActionContextMenuState = {
  /** Pointer or overflow-control position used by the responsive menu layout. */
  anchorPoint: TaskActionContextMenuAnchorPoint
  /** Element that regains focus after the menu closes. */
  returnFocusElement: HTMLElement
  /** Revision-bound Work Item selected by this card entrance. */
  selection: WorkItemActionSelection
}

/**
 * Renders the URL-specific My Tasks route and owns its status mutation controller.
 *
 * @returns My Tasks content rendered inside the shared Workspace shell.
 */
export function MyTasksPage() {
  const workspace = useWorkspaceRouteContext()
  const [searchParams, setSearchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const [taskViewSelection, setTaskViewSelection] = useState<TaskViewSelectionState>(
    createTaskViewSelectionState,
  )
  const [taskActionErrorMessage, setTaskActionErrorMessage] = useState<string>()
  const [taskActionContextMenuState, setTaskActionContextMenuState] = useState<
    MyTaskActionContextMenuState
  >()
  const [revealedStatusTaskKey, setRevealedStatusTaskKey] = useState<string>()
  const onOpenTaskRef = useRef(workspace.onOpenTask)

  useEffect(() => {
    onOpenTaskRef.current = workspace.onOpenTask
  }, [workspace.onOpenTask])
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
    workspace.teams,
    true,
  )
  const myTasks = useMemo(
    () => workItems.tasks.filter((task) => isWorkspaceTaskAssignedToUser(
      task,
      workspace.userIdentityAliases,
    )),
    [workItems.tasks, workspace.userIdentityAliases],
  )
  const taskViewScope = useMemo<TaskViewScope>(() => ({ kind: 'viewer' }), [])
  const taskViewConfigurations = useMemo(
    () => Object.entries(workItems.configurationsByTeam),
    [workItems.configurationsByTeam],
  )
  const taskViewCustomFields = useMemo(
    () => [
      ...new Map(
        taskViewConfigurations.flatMap(([, resolvedConfiguration]) =>
          resolvedConfiguration.configuration.customFields.map((field) => [field.id, field]),
        ),
      ).values(),
    ],
    [taskViewConfigurations],
  )
  const builtInTaskViewDefinition = useMemo(
    () => createBuiltInTaskViewDefinition(
      'my-tasks',
      taskViewScope,
      'board',
      taskViewCustomFields.length > 0 ? ['customFields'] : [],
    ),
    [taskViewCustomFields.length, taskViewScope],
  )
  const taskViewColumns = [
    ...taskViewBuiltInFields,
    ...(taskViewCustomFields.length > 0 ? ['customFields'] : []),
    ...taskViewCustomFields.map((field) => `custom:${field.id}`),
  ]
  const taskViewFields = [
    ...taskViewBuiltInFields,
    ...taskViewCustomFields.map((field) => `custom:${field.id}`),
  ]
  const taskViewWorkflowStatuses = taskViewConfigurations.flatMap(
    ([teamId, resolvedConfiguration]) =>
      resolvedConfiguration.configuration.workflow.statuses.map((status) => ({
        statusId: status.id,
        teamId,
      })),
  )
  const taskViewController = useTaskViewController({
    accessToken: workspace.accessToken,
    builtInDefinition: builtInTaskViewDefinition,
    capabilities: {
      columns: taskViewColumns,
      fields: taskViewFields,
      layoutModes: ['board'],
      legacyStatusIds: taskViewWorkflowStatuses.map((status) => status.statusId),
      requiredColumns: ['title'],
      workflowStatuses: taskViewWorkflowStatuses,
    },
    enabled: workspace.canLoadWorkspaceData,
    onSearchParamsChange: (nextSearchParams) => {
      setSearchParams(nextSearchParams, { replace: true })
    },
    scope: taskViewScope,
    searchParams,
    surface: 'my-tasks',
  })
  const visibleMyTasks = useMemo(
    () => applyTaskViewDefinitionToTasks(
      myTasks,
      taskViewController.effectiveDefinition,
    ),
    [myTasks, taskViewController.effectiveDefinition],
  )
  const visibleMyTaskActionTargets = useMemo(
    () => visibleMyTasks.map((task) => ({
      expectedRevision: task.revision,
      teamId: task.teamId,
      workItemId: task.id,
    })),
    [visibleMyTasks],
  )
  const visibleMyTaskKeys = useMemo(
    () => visibleMyTaskActionTargets.map((target) =>
      createTaskViewItemKey(target.teamId, target.workItemId)
    ),
    [visibleMyTaskActionTargets],
  )
  const myTaskActionSelection = useMemo(
    () => createTaskViewActionSelection(taskViewSelection, visibleMyTaskActionTargets),
    [taskViewSelection, visibleMyTaskActionTargets],
  )
  const myTaskActionLabels = useMemo<TaskSurfaceActionLabels>(() => ({
    archive: t('taskViews.action.archive'),
    assign: t('taskViews.action.assign'),
    create: t('taskViews.action.create'),
    edit: t('taskViews.action.edit'),
    move: t('taskViews.action.move'),
    open: t('taskViews.action.open'),
    relation: t('taskViews.action.relation'),
    schedule: t('taskViews.action.schedule'),
    watch: t('taskViews.action.watch'),
  }), [t])
  const myTaskActionDisabledReasons = useMemo<TaskSurfaceActionDisabledReasons>(() => ({
    selectionRequired: t('taskViews.action.selectionRequired'),
    singleSelectionRequired: t('taskViews.action.singleSelectionRequired'),
    unavailable: t('taskViews.action.unavailable'),
  }), [t])

  /** Resolves one permission-pruned personal Work Item from a canonical action context. */
  const resolveMyTaskActionTarget = useCallback((context: WorkItemActionContext) => {
    const target = resolveTaskSurfaceActionTarget(context)
    const task = target
      ? visibleMyTasks.find((candidate) =>
          candidate.teamId === target.teamId && candidate.id === target.workItemId
        )
      : undefined
    return { target, task }
  }, [visibleMyTasks])

  /** Checks whether the current permission and configuration expose a safe status entrance. */
  const canMoveMyTaskStatus = useCallback((task: (typeof visibleMyTasks)[number]) => {
    const configuration = workItems.configurationsByTeam[task.teamId]?.configuration
    return workspace.canMutateTeamConfiguration &&
      configuration !== undefined &&
      !workItems.configurationFailedTeamIds.includes(task.teamId) &&
      resolveEditableWorkflowStatuses(task, configuration).some(
        (status) => status.id !== task.workflowStatusId,
      )
  }, [
    workspace.canMutateTeamConfiguration,
    workItems.configurationFailedTeamIds,
    workItems.configurationsByTeam,
  ])

  /** Opens one personal Work Item through the existing route action. */
  const executeMyTaskOpenAction = useCallback((
    context: WorkItemActionContext,
  ): WorkItemActionResult => {
    const { target, task } = resolveMyTaskActionTarget(context)
    if (!target || !task || !isOpenableWorkspaceTask(task)) {
      return createFailedTaskActionResult(
        context.actionId,
        target,
        'MyTasksActionTargetNotFound',
        'not-found',
        t('taskViews.action.notFound'),
      )
    }
    onOpenTaskRef.current(task)
    return createSucceededTaskActionResult(context.actionId, target)
  }, [resolveMyTaskActionTarget, t])

  /** Reveals and focuses the existing status selector after canonical Move validation. */
  const executeMyTaskMoveAction = useCallback((
    context: WorkItemActionContext,
  ): WorkItemActionResult => {
    const { target, task } = resolveMyTaskActionTarget(context)
    if (
      !target ||
      !task ||
      !canMoveMyTaskStatus(task)
    ) {
      return createFailedTaskActionResult(
        context.actionId,
        target,
        'MyTasksMoveUnavailable',
        'unavailable',
        myTaskActionDisabledReasons.unavailable,
      )
    }
    const taskKey = createTaskViewItemKey(task.teamId, task.id)
    setRevealedStatusTaskKey(taskKey)
    focusMyTaskStatusControl(taskKey)
    return createSucceededTaskActionResult(context.actionId, target)
  }, [
    myTaskActionDisabledReasons.unavailable,
    canMoveMyTaskStatus,
    resolveMyTaskActionTarget,
  ])

  const myTaskActionHandlers = useMemo<TaskSurfaceActionHandlers>(() => ({
    move: executeMyTaskMoveAction,
    open: executeMyTaskOpenAction,
  }), [executeMyTaskMoveAction, executeMyTaskOpenAction])
  const myTaskActionPermissions = useMemo<TaskSurfaceActionPermissions>(() => ({
    move: (context) => {
      const targets = resolveTaskSurfaceActionTargets(context)
      if (targets.length === 0) return allowTaskAction()
      if (targets.length !== 1) {
        return denyTaskAction(myTaskActionDisabledReasons.singleSelectionRequired)
      }
      const { task } = resolveMyTaskActionTarget(context)
      return task && canMoveMyTaskStatus(task)
        ? allowTaskAction()
        : denyTaskAction(myTaskActionDisabledReasons.unavailable)
    },
    open: (context) => {
      const { target, task } = resolveMyTaskActionTarget(context)
      if (!target) return allowTaskAction()
      return task && isOpenableWorkspaceTask(task)
        ? allowTaskAction()
        : denyTaskAction(myTaskActionDisabledReasons.unavailable)
    },
  }), [
    myTaskActionDisabledReasons.singleSelectionRequired,
    myTaskActionDisabledReasons.unavailable,
    canMoveMyTaskStatus,
    resolveMyTaskActionTarget,
  ])

  /**
   * Projects normalized My Tasks action failures into an accessible local notice.
   *
   * @param result - Canonical action execution result to present.
   * @returns Nothing.
   */
  const handleMyTaskActionExecution = useCallback((result: TaskActionExecutionResult) => {
    setTaskActionErrorMessage(resolveTaskActionExecutionFailureMessage(
      result,
      t('taskViews.action.failed'),
    ))
  }, [t])

  const myTaskActions = useTaskSurfaceActions({
    ...(taskViewController.activeSavedView?.id
      ? { activeViewId: taskViewController.activeSavedView.id }
      : {}),
    disabledReasons: myTaskActionDisabledReasons,
    handlers: myTaskActionHandlers,
    labels: myTaskActionLabels,
    onExecutionResult: handleMyTaskActionExecution,
    permissions: myTaskActionPermissions,
    registrationId: 'my-task-actions',
    scope: taskViewScope,
    selection: myTaskActionSelection,
    surface: 'my-tasks',
  })
  const taskActionContextMenuContext = useMemo(() => {
    if (!taskActionContextMenuState) return undefined
    return createTaskSurfaceActionBaseContext(
      'my-tasks',
      taskViewScope,
      taskActionContextMenuState.selection,
      taskViewController.activeSavedView?.id,
    )
  }, [
    taskActionContextMenuState,
    taskViewController.activeSavedView?.id,
    taskViewScope,
  ])

  useEffect(() => {
    queueMicrotask(() => {
      setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
        availableKeys: visibleMyTaskKeys,
        type: 'prune',
      }))
    })
  }, [visibleMyTaskKeys])

  /**
   * Opens one clicked personal task through the canonical action registry.
   *
   * @param task - Visible personal task activated by pointer input.
   * @returns Nothing.
   */
  const handleOpenMyTask = useCallback((task: (typeof visibleMyTasks)[number]) => {
    const taskKey = createTaskViewItemKey(task.teamId, task.id)
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: taskKey,
      type: 'focus',
    }))
    void myTaskActions.execute(
      'open',
      'click',
      undefined,
      createFocusedTaskViewActionSelection({
        expectedRevision: task.revision,
        teamId: task.teamId,
        workItemId: task.id,
      }),
    )
  }, [myTaskActions])

  /** Opens a revision-bound card menu without inheriting an unrelated multi-selection. */
  const handleMyTaskActionMenuOpen = useCallback((
    task: (typeof visibleMyTasks)[number],
    anchorPoint: TaskActionContextMenuAnchorPoint,
    returnFocusElement: HTMLElement,
  ) => {
    const taskKey = createTaskViewItemKey(task.teamId, task.id)
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: taskKey,
      type: 'focus',
    }))
    setTaskActionContextMenuState({
      anchorPoint,
      returnFocusElement,
      selection: createFocusedTaskViewActionSelection({
        expectedRevision: task.revision,
        teamId: task.teamId,
        workItemId: task.id,
      }),
    })
  }, [])

  /** Routes one personal-task menu activation through the canonical action registry. */
  const handleMyTaskActionMenuExecute = useCallback((actionId: WorkItemActionId) => {
    if (!taskActionContextMenuState) return
    void myTaskActions.execute(
      actionId,
      'context-menu',
      undefined,
      taskActionContextMenuState.selection,
    )
  }, [myTaskActions, taskActionContextMenuState])

  useEffect(() => {
    /**
     * Routes personal-task navigation and shortcuts through shared reducers and registry policy.
     *
     * @param event - Document keydown event to normalize and route.
     * @returns Nothing.
     */
    const handleMyTaskKeyboard = (event: KeyboardEvent) => {
      const input = createTaskSurfaceKeyboardInput(
        event,
        Boolean(taskActionContextMenuState),
      )
      const selectionAction = createTaskViewSelectionKeyboardAction(
        input,
        taskViewSelection,
        visibleMyTaskKeys,
      )
      if (selectionAction) {
        event.preventDefault()
        setTaskActionErrorMessage(undefined)
        setTaskViewSelection(reduceTaskViewSelection(taskViewSelection, selectionAction))
        return
      }

      const definition = myTaskActions.resolveShortcut(input)
      if (!definition) return
      event.preventDefault()
      void myTaskActions.execute(
        definition.id,
        'keyboard',
        definition.shortcut
          ? formatTaskSurfaceKeyboardShortcut(definition.shortcut)
          : undefined,
      )
    }

    document.addEventListener('keydown', handleMyTaskKeyboard)
    return () => document.removeEventListener('keydown', handleMyTaskKeyboard)
  }, [
    myTaskActions,
    taskActionContextMenuState,
    taskViewSelection,
    visibleMyTaskKeys,
  ])
  const statusMutation = useWorkspaceTaskStatusMutation({
    accessToken: workspace.accessToken,
    configurationsByTeam: workItems.configurationsByTeam,
    enabled: workspace.canMutateTeamConfiguration,
    guardAuthenticatedRequest: workspace.guardEnterpriseSession,
    mutateWorkItems: workItems.mutateWorkItems,
    t,
    tasks: workItems.tasks,
  })
  const taskViewFieldOptions: TaskViewFieldOption[] = [
    { id: 'title', label: t('tasks.column.name') },
    { id: 'status', label: t('tasks.column.status') },
    { id: 'assignee', label: t('tasks.column.assignee') },
    { id: 'dueDate', label: t('tasks.column.dueDate') },
    { id: 'priority', label: t('tasks.column.priority') },
    { id: 'project', label: t('workspace.column.project') },
    { id: 'team', label: t('workspace.column.team') },
    ...(taskViewCustomFields.length > 0
      ? [{ id: 'customFields', label: t('workItems.fields.title') }]
      : []),
    ...taskViewCustomFields.map((field) => ({
      id: `custom:${field.id}`,
      label: field.name,
    })),
  ]
  const taskViewGroupOptions = taskViewFieldOptions.filter(
    (option) => option.id !== 'customFields',
  )
  const taskViewOptions = taskViewController.views.map(createTaskViewOption)
  const selectedTaskView = taskViewController.activeSavedView
    ? createTaskViewOption(taskViewController.activeSavedView)
    : undefined
  const taskViewTeams = useMemo(() => {
    const writableTeamIds = new Set(taskViewController.writableTeamIds)
    return workspace.teams
      .filter((team) => writableTeamIds.has(team.id))
      .map((team) => ({ id: team.id, name: team.name }))
  }, [taskViewController.writableTeamIds, workspace.teams])
  const taskViewPresentation = taskViewDefinitionToPresentationSettings(
    taskViewController.effectiveDefinition,
  )
  const taskViewToolbar = (
    <TaskViewToolbar
      builtInName={t('workspace.myTasks.title')}
      canManageShared={taskViewController.canManageShared}
      canSetTeamDefault={taskViewController.canSetTeamDefault}
      canWrite={taskViewController.canWrite}
      columnOptions={taskViewFieldOptions}
      errorMessage={taskViewController.errorMessage}
      groupOptions={taskViewGroupOptions}
      isDirty={taskViewController.isDirty}
      isSaving={taskViewController.isSaving}
      migrationWarnings={taskViewController.migrationWarnings.map(
        formatTaskViewMigrationWarning,
      )}
      onCopyLink={taskViewController.copyPermalink}
      onDelete={taskViewController.deleteView}
      onDuplicate={taskViewController.duplicateView}
      onPatchPreference={taskViewController.patchPreference}
      onReset={taskViewController.resetOverrides}
      onSaveAs={taskViewController.saveAs}
      onSelectView={taskViewController.selectView}
      onSettingsChange={(settings) => {
        taskViewController.setEffectiveDefinition(
          presentationSettingsToTaskViewDefinition(
            taskViewController.effectiveDefinition,
            settings,
          ),
        )
      }}
      onUpdate={taskViewController.updateActiveView}
      selectedView={selectedTaskView}
      settings={taskViewPresentation}
      supportsEmptyGroups
      t={t}
      teams={taskViewTeams}
      views={taskViewOptions}
    />
  )
  return (
    <WorkspaceRouteContent
      isLoading={workItems.isLoading}
      sessionErrors={[
        workItems.workItemsError,
        workItems.configurationsError,
        ...workItems.configurationErrors,
      ]}
    >
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice failedProjectCount={workItems.failedProjectCount} t={t} />
        <WorkspaceConfigurationLoadNotice
          failedTeamCount={workItems.configurationFailedTeamIds.length}
          onRetry={() => void workItems.mutateConfigurations()}
          t={t}
        />
        {taskActionErrorMessage ? (
          <p
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"
            role="alert"
          >
            {taskActionErrorMessage}
          </p>
        ) : null}
        <MyTasksWorkspaceView
          configurationFailedTeamIds={workItems.configurationFailedTeamIds}
          configurationsByTeam={workItems.configurationsByTeam}
          locale={workspace.locale}
          onMoveTaskStatus={statusMutation.moveTaskStatus}
          focusedTaskKey={taskViewSelection.focusedKey}
          onOpenTask={handleOpenMyTask}
          onStatusActionConsumed={(task) => {
            const taskKey = createTaskViewItemKey(task.teamId, task.id)
            setRevealedStatusTaskKey((currentKey) =>
              currentKey === taskKey ? undefined : currentKey
            )
          }}
          onTaskActionMenuOpen={handleMyTaskActionMenuOpen}
          revealedStatusTaskKey={revealedStatusTaskKey}
          selectedTaskKeys={taskViewSelection.selectedKeys}
          t={t}
          taskMoveErrorMessage={statusMutation.errorMessage}
          taskViewToolbar={taskViewToolbar}
          presentation={taskViewPresentation}
          tasks={visibleMyTasks}
          teams={workspace.teams}
        />
        {taskActionContextMenuState && taskActionContextMenuContext ? (
          <TaskActionContextMenu
            anchorPoint={taskActionContextMenuState.anchorPoint}
            context={taskActionContextMenuContext}
            labels={myTaskActionLabels}
            menuLabel={t('tasks.action.more')}
            onClose={() => setTaskActionContextMenuState(undefined)}
            onExecute={handleMyTaskActionMenuExecute}
            registry={myTaskActions.registry}
            returnFocusElement={taskActionContextMenuState.returnFocusElement}
            testId="my-tasks-action-context-menu"
          />
        ) : null}
      </div>
    </WorkspaceRouteContent>
  )
}

/**
 * Focuses the status selector revealed by a canonical My Tasks Move entrance.
 *
 * @param taskKey - Team-qualified task-view item key rendered on the target card.
 * @returns Nothing.
 */
function focusMyTaskStatusControl(taskKey: string): void {
  requestAnimationFrame(() => {
    const card = [...document.querySelectorAll<HTMLElement>('[data-task-view-item-key]')]
      .find((candidate) => candidate.dataset.taskViewItemKey === taskKey)
    const statusControl = card?.querySelector<HTMLSelectElement>('select')
    statusControl?.focus()
    statusControl?.scrollIntoView({ block: 'nearest' })
  })
}
