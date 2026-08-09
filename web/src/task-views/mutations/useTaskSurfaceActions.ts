import {
  WORK_ITEM_ACTION_IDS,
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type TaskViewScope,
  type TaskViewSurface,
  type WorkItemActionContext,
  type WorkItemActionId,
  type WorkItemActionResult,
  type WorkItemActionSelection,
  type WorkItemActionTarget,
  type WorkItemActionTrigger,
} from '@mukuroji/contracts'
import { useCallback, useEffect, useMemo } from 'react'
import {
  useWorkspaceCommandMenu,
  type WorkspaceCommandMenuWorkItemActionDefinition,
} from '../../commands/ui/WorkspaceCommandMenuContext'
import {
  allowTaskAction,
  createTaskActionRegistry,
  denyTaskAction,
  executeTaskAction,
  formatTaskActionShortcut,
  invalidateTaskAction,
  resolveTaskActionDisabledReason,
  resolveTaskActionShortcut,
  validateTaskAction,
  type TaskActionDefinition,
  type TaskActionExecutionResult,
  type TaskActionKeyboardInput,
  type TaskActionPermissionResult,
  type TaskActionRegistry,
  type TaskActionShortcut,
  type TaskActionValidationResult,
} from '../model/taskActionRegistry'

/** Executes one task-surface action after the shared permission and validation pipeline. */
export type TaskSurfaceActionHandler = (
  context: WorkItemActionContext,
) => WorkItemActionResult | Promise<WorkItemActionResult>

/** Evaluates task-surface action access against the concrete target snapshot. */
export type TaskSurfaceActionPermission = (
  context: WorkItemActionContext,
) => TaskActionPermissionResult

/** Optional target-aware permission evaluators indexed by canonical action ID. */
export type TaskSurfaceActionPermissions = Partial<
  Record<WorkItemActionId, TaskSurfaceActionPermission>
>

/** Safe task entrances available to the canonical action registry. */
export type TaskSurfaceActionHandlers = {
  /** Opens the task creation experience. */
  create?: TaskSurfaceActionHandler
  /** Opens the focused or selected Work Item. */
  open?: TaskSurfaceActionHandler
  /** Opens the focused or selected Work Item for editing. */
  edit?: TaskSurfaceActionHandler
  /** Moves the focused or selected Work Item when a destination is already known. */
  move?: TaskSurfaceActionHandler
  /** Assigns the focused or selected Work Item when an assignee is already known. */
  assign?: TaskSurfaceActionHandler
  /** Opens scheduling controls for the focused or selected Work Item. */
  schedule?: TaskSurfaceActionHandler
  /** Opens relation controls for the focused or selected Work Item. */
  relation?: TaskSurfaceActionHandler
  /** Toggles the focused or selected Work Item watch state. */
  watch?: TaskSurfaceActionHandler
  /** Archives the focused or selected Work Item through a safe confirmation flow. */
  archive?: TaskSurfaceActionHandler
}

/** Localized labels shown for every canonical task action. */
export type TaskSurfaceActionLabels = {
  /** Label for creating a Work Item. */
  create: string
  /** Label for opening a Work Item. */
  open: string
  /** Label for editing a Work Item. */
  edit: string
  /** Label for moving a Work Item. */
  move: string
  /** Label for assigning a Work Item. */
  assign: string
  /** Label for scheduling a Work Item. */
  schedule: string
  /** Label for editing Work Item relations. */
  relation: string
  /** Label for toggling Work Item watch state. */
  watch: string
  /** Label for archiving a Work Item. */
  archive: string
}

/** Localized disabled reasons shared by every action entrance. */
export type TaskSurfaceActionDisabledReasons = {
  /** Reason shown when the current surface has no safe handler for an action. */
  unavailable: string
  /** Reason shown when an action requires a focused or selected Work Item. */
  selectionRequired: string
  /** Reason shown when an action cannot consume a multi-selection. */
  singleSelectionRequired: string
}

/** Input used to register and execute canonical task-surface actions. */
export type UseTaskSurfaceActionsOptions = {
  /** Saved task view active when an action is invoked. */
  activeViewId?: string
  /** Canonical action IDs that this surface can safely execute for multiple targets. */
  bulkActionIds?: readonly WorkItemActionId[]
  /** Localized reasons used for unavailable or invalid actions. */
  disabledReasons: TaskSurfaceActionDisabledReasons
  /** Existing safe UI or mutation entrances for canonical actions. */
  handlers: TaskSurfaceActionHandlers
  /** Localized action labels. */
  labels: TaskSurfaceActionLabels
  /** Receives every normalized pipeline result regardless of invocation path. */
  onExecutionResult?: (result: TaskActionExecutionResult) => void
  /** Target-aware permission checks evaluated before action-specific validation. */
  permissions?: TaskSurfaceActionPermissions
  /** Command-menu precedence used when multiple task surfaces are mounted. */
  precedence?: number
  /** Stable command-menu registration identity for this mounted surface. */
  registrationId: string
  /** Resource boundary inherited from the active task view. */
  scope: TaskViewScope
  /** Permission-pruned focus and selection snapshot. */
  selection: WorkItemActionSelection
  /** Product surface from which actions are invoked. */
  surface: TaskViewSurface
}

/** Action operations consumed by task-surface interaction adapters. */
export type TaskSurfaceActionController = {
  /** Executes a canonical action through permission, validation, and the registered handler. */
  execute: (
    actionId: WorkItemActionId,
    trigger: WorkItemActionTrigger,
    keyboardShortcut?: string,
    selectionOverride?: WorkItemActionSelection,
  ) => Promise<TaskActionExecutionResult>
  /** Resolves one guarded keyboard event to an unambiguous registered action. */
  resolveShortcut: (input: TaskActionKeyboardInput) => TaskActionDefinition | undefined
  /** Registry shared by click, context-menu, keyboard, and command-menu invocation. */
  registry: TaskActionRegistry
}

/** Options used by the pure task-surface action registry factory. */
export type CreateTaskSurfaceActionRegistryOptions = {
  /** Canonical action IDs that this surface can safely execute for multiple targets. */
  bulkActionIds?: readonly WorkItemActionId[]
  /** Existing safe UI or mutation entrances for canonical actions. */
  handlers: TaskSurfaceActionHandlers
  /** Localized reasons used for unavailable or invalid actions. */
  disabledReasons: TaskSurfaceActionDisabledReasons
  /** Target-aware permission checks evaluated before action-specific validation. */
  permissions?: TaskSurfaceActionPermissions
}

/** Keyboard shortcuts reserved by task selection or the Workspace command menu. */
const reservedTaskSurfaceShortcuts: readonly TaskActionShortcut[] = [
  { key: 'j' },
  { key: 'k' },
  { key: 'space' },
  { key: 'k', primary: true },
]

/** Default command-menu precedence for the currently active task surface. */
const defaultTaskSurfaceActionPrecedence = 100

/**
 * Registers canonical actions for any task surface and exposes shared execution operations.
 *
 * Every invocation path calls the same permission, validation, and execution pipeline. Callers
 * should memoize handler, permission, and label collections so registrations remain stable.
 *
 * @param options - Current surface, scope, selection, labels, and safe action entrances.
 * @returns Stable shared action registry and execution operations.
 */
export function useTaskSurfaceActions(
  options: UseTaskSurfaceActionsOptions,
): TaskSurfaceActionController {
  const { registerWorkItemActions } = useWorkspaceCommandMenu()
  const {
    activeViewId,
    bulkActionIds,
    disabledReasons,
    handlers,
    labels,
    onExecutionResult,
    permissions,
    precedence = defaultTaskSurfaceActionPrecedence,
    registrationId,
    scope,
    selection,
    surface,
  } = options
  const registry = useMemo(
    () => createTaskSurfaceActionRegistry({
      ...(bulkActionIds !== undefined ? { bulkActionIds } : {}),
      disabledReasons,
      handlers,
      permissions,
    }),
    [bulkActionIds, disabledReasons, handlers, permissions],
  )
  const baseContext = useMemo<
    Omit<WorkItemActionContext, 'actionId' | 'keyboardShortcut' | 'trigger'>
  >(
    () => createTaskSurfaceActionBaseContext(
      surface,
      scope,
      selection,
      activeViewId,
    ),
    [activeViewId, scope, selection, surface],
  )

  /** Executes an already-complete context and reports its normalized result. */
  const executeContext = useCallback(async (
    context: WorkItemActionContext,
  ): Promise<TaskActionExecutionResult> => {
    const result = await executeTaskAction(registry, context)
    onExecutionResult?.(result)
    return result
  }, [onExecutionResult, registry])

  /** Builds one complete context before entering the shared action pipeline. */
  const execute = useCallback(async (
    actionId: WorkItemActionId,
    trigger: WorkItemActionTrigger,
    keyboardShortcut?: string,
    selectionOverride?: WorkItemActionSelection,
  ): Promise<TaskActionExecutionResult> => executeContext(createTaskSurfaceActionContext(
    baseContext,
    actionId,
    trigger,
    keyboardShortcut,
    selectionOverride,
  )), [baseContext, executeContext])

  useEffect(() => {
    if (!registerWorkItemActions) return

    return registerWorkItemActions({
      actions: createTaskSurfaceCommandMenuDefinitions(
        registry,
        baseContext,
        labels,
        executeContext,
      ),
      context: baseContext,
      precedence,
      registrationId,
    })
  }, [
    baseContext,
    executeContext,
    labels,
    precedence,
    registerWorkItemActions,
    registrationId,
    registry,
  ])

  const resolveShortcut = useCallback(
    (input: TaskActionKeyboardInput) => resolveTaskActionShortcut(registry, input),
    [registry],
  )

  return useMemo(() => ({
    execute,
    registry,
    resolveShortcut,
  }), [execute, registry, resolveShortcut])
}

/**
 * Creates the immutable surface, scope, view, and selection context shared by every action.
 *
 * @param surface - Product surface from which actions are invoked.
 * @param scope - Resource boundary inherited from the active task view.
 * @param selection - Current permission-pruned focus and selection snapshot.
 * @param activeViewId - Optional saved view active during invocation.
 * @returns Canonical context fields shared by every trigger and action ID.
 */
export function createTaskSurfaceActionBaseContext(
  surface: TaskViewSurface,
  scope: TaskViewScope,
  selection: WorkItemActionSelection,
  activeViewId?: string,
): Omit<WorkItemActionContext, 'actionId' | 'keyboardShortcut' | 'trigger'> {
  return {
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    scope,
    selection,
    surface,
    ...(activeViewId !== undefined ? { viewId: activeViewId } : {}),
  }
}

/**
 * Completes one action context while preserving an optional entrance-specific selection.
 *
 * @param baseContext - Shared task-surface context.
 * @param actionId - Canonical action requested by the entrance.
 * @param trigger - Interaction path that invoked the action.
 * @param keyboardShortcut - Optional normalized keyboard chord.
 * @param selectionOverride - Optional row, card, or bulk selection owned by this entrance.
 * @returns Complete context ready for the shared executor.
 */
export function createTaskSurfaceActionContext(
  baseContext: Omit<WorkItemActionContext, 'actionId' | 'keyboardShortcut' | 'trigger'>,
  actionId: WorkItemActionId,
  trigger: WorkItemActionTrigger,
  keyboardShortcut?: string,
  selectionOverride?: WorkItemActionSelection,
): WorkItemActionContext {
  return {
    ...baseContext,
    actionId,
    trigger,
    ...(selectionOverride !== undefined ? { selection: selectionOverride } : {}),
    ...(keyboardShortcut !== undefined ? { keyboardShortcut } : {}),
  }
}

/**
 * Creates all nine canonical action definitions in contract order.
 *
 * Missing handlers stay registered with a permission-denied reason so every invocation surface
 * remains discoverable without pretending an unsafe mutation is available.
 *
 * @param options - Safe handlers and localized disabled reasons.
 * @returns Deterministic registry containing every canonical action identifier.
 */
export function createTaskSurfaceActionRegistry(
  options: CreateTaskSurfaceActionRegistryOptions,
): TaskActionRegistry {
  return createTaskActionRegistry({
    definitions: WORK_ITEM_ACTION_IDS.map((actionId) => createTaskSurfaceActionDefinition(
      actionId,
      resolveTaskSurfaceActionHandler(options.handlers, actionId),
      options.permissions?.[actionId],
      options.disabledReasons,
      options.bulkActionIds ?? [],
    )),
    reservedShortcuts: reservedTaskSurfaceShortcuts,
  })
}

/**
 * Resolves the sole selected target, or the focused target when nothing is selected.
 *
 * @param context - Canonical action invocation context.
 * @returns One actionable target, or undefined for an empty or multiple selection.
 */
export function resolveTaskSurfaceActionTarget(
  context: WorkItemActionContext,
): WorkItemActionTarget | undefined {
  if (context.selection.targets.length === 1) {
    return context.selection.targets[0]
  }
  return context.selection.targets.length === 0
    ? context.selection.focusedTarget
    : undefined
}

/**
 * Resolves selected targets, or the focused target when the selection is empty.
 *
 * @param context - Canonical action invocation context.
 * @returns Ordered actionable targets, including multiple bulk targets.
 */
export function resolveTaskSurfaceActionTargets(
  context: WorkItemActionContext,
): readonly WorkItemActionTarget[] {
  return context.selection.targets.length > 0
    ? context.selection.targets
    : context.selection.focusedTarget
      ? [context.selection.focusedTarget]
      : []
}

/**
 * Creates one action definition with common permission and single-target validation.
 *
 * @param actionId - Canonical action identifier.
 * @param handler - Safe task-surface entrance, when available.
 * @param permission - Optional target-aware permission evaluator.
 * @param disabledReasons - Localized disabled and validation messages.
 * @param bulkActionIds - Action IDs that this surface can execute for multiple targets.
 * @returns Registry definition for one canonical action.
 */
function createTaskSurfaceActionDefinition(
  actionId: WorkItemActionId,
  handler: TaskSurfaceActionHandler | undefined,
  permission: TaskSurfaceActionPermission | undefined,
  disabledReasons: TaskSurfaceActionDisabledReasons,
  bulkActionIds: readonly WorkItemActionId[],
): TaskActionDefinition {
  const shortcut = resolveTaskSurfaceActionShortcut(actionId)
  return {
    id: actionId,
    ...(shortcut ? { shortcut } : {}),
    execute: handler ?? ((context) => createUnavailableActionResult(
      context,
      disabledReasons.unavailable,
    )),
    permission: (context) => {
      if (!handler) return denyTaskAction(disabledReasons.unavailable)
      return permission?.(context) ?? allowTaskAction()
    },
    validate: (context) => validateTaskSurfaceAction(
      actionId,
      context,
      disabledReasons,
      bulkActionIds,
    ),
  }
}

/**
 * Validates the common task-surface action target cardinality.
 *
 * @param actionId - Canonical action identifier.
 * @param context - Current permission-pruned selection context.
 * @param reasons - Localized validation reasons.
 * @param bulkActionIds - Action IDs that this surface can execute for multiple targets.
 * @returns Valid for create, one target, or a supported bulk action; otherwise invalid.
 */
function validateTaskSurfaceAction(
  actionId: WorkItemActionId,
  context: WorkItemActionContext,
  reasons: TaskSurfaceActionDisabledReasons,
  bulkActionIds: readonly WorkItemActionId[],
): TaskActionValidationResult {
  if (actionId === 'create') return validateTaskAction()
  const targets = resolveTaskSurfaceActionTargets(context)
  if (targets.length === 0) {
    return invalidateTaskAction([reasons.selectionRequired])
  }
  if (targets.length > 1 && !bulkActionIds.includes(actionId)) {
    return invalidateTaskAction([reasons.singleSelectionRequired])
  }
  return validateTaskAction()
}

/**
 * Reads one explicit handler property without widening action identifiers.
 *
 * @param handlers - Safe task-surface action entrances.
 * @param actionId - Canonical action to read.
 * @returns Matching handler when that entrance is safe and available.
 */
function resolveTaskSurfaceActionHandler(
  handlers: TaskSurfaceActionHandlers,
  actionId: WorkItemActionId,
): TaskSurfaceActionHandler | undefined {
  switch (actionId) {
    case 'create': return handlers.create
    case 'open': return handlers.open
    case 'edit': return handlers.edit
    case 'move': return handlers.move
    case 'assign': return handlers.assign
    case 'schedule': return handlers.schedule
    case 'relation': return handlers.relation
    case 'watch': return handlers.watch
    case 'archive': return handlers.archive
  }
}

/**
 * Resolves shortcuts that are safe outside editable and modal surfaces.
 *
 * @param actionId - Canonical action identifier.
 * @returns Platform-neutral shortcut, or undefined for parameterized actions.
 */
function resolveTaskSurfaceActionShortcut(
  actionId: WorkItemActionId,
): TaskActionShortcut | undefined {
  switch (actionId) {
    case 'create': return { key: 'c' }
    case 'open': return { key: 'enter' }
    case 'edit': return { key: 'e' }
    case 'schedule': return { key: 's' }
    case 'relation': return { key: 'r' }
    case 'watch': return { key: 'w' }
    case 'move':
    case 'assign':
    case 'archive':
      return undefined
  }
}

/**
 * Adapts registry definitions to command-menu display metadata and the shared executor.
 *
 * @param registry - Current task-surface action registry.
 * @param baseContext - Scope and selection shared by every action.
 * @param labels - Localized action labels.
 * @param executeContext - Shared permission and validation executor.
 * @returns Canonical command-menu contributions in contract order.
 */
function createTaskSurfaceCommandMenuDefinitions(
  registry: TaskActionRegistry,
  baseContext: Omit<WorkItemActionContext, 'actionId' | 'keyboardShortcut' | 'trigger'>,
  labels: TaskSurfaceActionLabels,
  executeContext: (context: WorkItemActionContext) => Promise<TaskActionExecutionResult>,
): WorkspaceCommandMenuWorkItemActionDefinition[] {
  return WORK_ITEM_ACTION_IDS.flatMap((actionId) => {
    const definition = registry.actions.get(actionId)
    if (!definition) return []
    const context = createTaskSurfaceActionContext(
      baseContext,
      actionId,
      'command-menu',
    )
    const disabledReason = resolveTaskActionDisabledReason(definition, context)
    const shortcut = definition.shortcut
      ? formatTaskActionShortcut(definition.shortcut)
      : undefined

    return [{
      id: actionId,
      label: labels[actionId],
      ...(disabledReason !== undefined ? { disabledReason } : {}),
      ...(shortcut !== undefined ? { shortcut } : {}),
      execute: executeContext,
    }]
  })
}

/**
 * Creates a defensive failed result for a handler that cannot be invoked.
 *
 * Permission evaluation normally prevents this executor from running; the result keeps the
 * definition total if a caller invokes it after a stale permission snapshot.
 *
 * @param context - Canonical action context.
 * @param message - Safe localized failure message.
 * @returns Canonical unavailable result.
 */
function createUnavailableActionResult(
  context: WorkItemActionContext,
  message: string,
): WorkItemActionResult {
  return {
    actionId: context.actionId,
    failure: {
      category: 'unavailable',
      code: 'TaskSurfaceActionUnavailable',
      message,
      retryable: false,
    },
    items: [],
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    status: 'failed',
  }
}
