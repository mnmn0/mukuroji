import type {
  WorkItemActionContext,
  WorkItemActionId,
  WorkItemActionResult,
  WorkItemActionSelection,
  WorkItemActionTarget,
} from '@mukuroji/contracts'
import { createCancelledTaskActionResult } from './taskActionRegistry'

/** One accepted action whose editor or preview still awaits a terminal mutation outcome. */
type PendingTaskActionCompletion = {
  /** Canonical context retained from the original click, menu, command, or keyboard entrance. */
  context: WorkItemActionContext
  /** Resolves the shared executor only after mutation success, failure, or cancellation. */
  resolve: (result: WorkItemActionResult) => void
  /** Dismisses the editor that owned an awaiting-input invocation when it is superseded. */
  onCancel?: (context: WorkItemActionContext) => void
}

/** Imperative completion bridge shared by a task surface and its existing mutation controls. */
export type TaskActionCompletionBridge = {
  /**
   * Starts one pending action and cancels a previously uncompleted editor request.
   *
   * @param context - Accepted action context from the shared registry.
   * @param onCancel - Optional owner cleanup that dismisses awaiting editor state.
   * @returns Promise resolved by an actual mutation outcome or explicit cancellation.
   */
  begin: (
    context: WorkItemActionContext,
    onCancel?: (context: WorkItemActionContext) => void,
  ) => Promise<WorkItemActionResult>
  /**
   * Cancels the current request when it matches an optional action identifier.
   *
   * @param actionId - Optional action that must own the current request.
   * @returns Whether a pending action was cancelled.
   */
  cancel: (actionId?: WorkItemActionId) => boolean
  /**
   * Cancels only the exact accepted invocation captured by an asynchronous control.
   *
   * @param context - Original context object returned by {@link current} before mutation.
   * @returns Whether that exact invocation remained pending and was cancelled.
   */
  cancelContext: (context: WorkItemActionContext) => boolean
  /**
   * Claims an awaiting invocation immediately before irreversible mutation dispatch.
   *
   * Claimed invocations are no longer cancelled by selection, unmount, or a newer editor and
   * remain independently settleable while another invocation starts.
   *
   * @param context - Exact accepted context captured by the mutation wrapper.
   * @returns Whether the invocation transitioned from awaiting input to in flight.
   */
  claim: (context: WorkItemActionContext) => boolean
  /**
   * Reads the accepted context for mutation wrappers that need to match a concrete target.
   *
   * @returns Current pending context, or undefined when no editor action is awaiting completion.
   */
  current: () => WorkItemActionContext | undefined
  /**
   * Resolves the current request with a canonical terminal result when its action ID matches.
   *
   * @param context - Original context object captured before the asynchronous mutation.
   * @param result - Mutation success, failure, partial outcome, or cancellation.
   * @returns Whether the terminal result completed a pending action.
   */
  settle: (
    context: WorkItemActionContext,
    result: WorkItemActionResult,
  ) => boolean
}

/**
 * Creates a surface-local bridge between registry execution and existing mutation controls.
 *
 * The bridge intentionally stores no server state. It only retains the canonical invocation
 * context while a pre-existing editor, preview, or form owns the user interaction.
 *
 * @returns Stable pending-action operations suitable for storing in React state or a ref.
 */
export function createTaskActionCompletionBridge(): TaskActionCompletionBridge {
  let waiting: PendingTaskActionCompletion | undefined
  const inFlight = new Map<WorkItemActionContext, PendingTaskActionCompletion>()

  const cancel = (actionId?: WorkItemActionId): boolean => {
    if (!waiting || (actionId !== undefined && waiting.context.actionId !== actionId)) {
      return false
    }
    const current = waiting
    waiting = undefined
    current.onCancel?.(current.context)
    current.resolve(createCancelledTaskActionResult(
      current.context.actionId,
      resolveTaskActionContextTargets(current.context),
    ))
    return true
  }

  return {
    begin: (context, onCancel) => {
      cancel()
      return new Promise<WorkItemActionResult>((resolve) => {
        waiting = {
          context: createTaskActionInvocationContext(context),
          resolve,
          ...(onCancel !== undefined ? { onCancel } : {}),
        }
      })
    },
    cancel,
    cancelContext: (context) => {
      if (waiting?.context !== context) return false
      return cancel(context.actionId)
    },
    claim: (context) => {
      if (waiting?.context !== context) return false
      const current = waiting
      waiting = undefined
      inFlight.set(context, current)
      return true
    },
    current: () => waiting?.context,
    settle: (context, result) => {
      if (context.actionId !== result.actionId) return false
      const current = waiting?.context === context
        ? waiting
        : inFlight.get(context)
      if (!current) return false
      if (waiting?.context === context) waiting = undefined
      inFlight.delete(context)
      current.resolve(result)
      return true
    },
  }
}

/**
 * Creates one bridge-private context identity for an accepted registry execution.
 *
 * @param context - Canonical context supplied by an action entrance.
 * @returns Fresh context whose identity cannot be reused by another completion invocation.
 */
function createTaskActionInvocationContext(
  context: WorkItemActionContext,
): WorkItemActionContext {
  return {
    ...context,
    selection: {
      ...context.selection,
      targets: context.selection.targets.map((target) => ({ ...target })),
      ...(context.selection.anchorTarget
        ? { anchorTarget: { ...context.selection.anchorTarget } }
        : {}),
      ...(context.selection.focusedTarget
        ? { focusedTarget: { ...context.selection.focusedTarget } }
        : {}),
    },
  }
}

/**
 * Checks whether a pending action targets the Work Item currently being mutated.
 *
 * @param bridge - Surface-local completion bridge.
 * @param actionIds - Mutation actions accepted by the existing control.
 * @param target - Concrete Work Item being persisted.
 * @returns Matching pending context, or undefined for unrelated mutations.
 */
export function resolvePendingTaskActionContext(
  bridge: TaskActionCompletionBridge,
  actionIds: readonly WorkItemActionId[],
  target?: Pick<WorkItemActionTarget, 'teamId' | 'workItemId'>,
): WorkItemActionContext | undefined {
  const context = bridge.current()
  if (!context || !actionIds.includes(context.actionId)) return undefined
  if (!target) return context
  return resolveTaskActionContextTargets(context).some((candidate) =>
    candidate.teamId === target.teamId && candidate.workItemId === target.workItemId
  )
    ? context
    : undefined
}

/**
 * Cancels the exact awaiting invocation for one semantic action and concrete Work Item.
 *
 * This is used by explicit no-op controls that intentionally skip persistence but must still
 * return a terminal canonical result to their accepted registry execution.
 *
 * @param bridge - Surface-local completion bridge.
 * @param actionIds - Canonical actions owned by the control.
 * @param target - Concrete Work Item whose no-op input was submitted.
 * @returns Whether an exact awaiting invocation was cancelled.
 */
export function cancelPendingTaskActionContext(
  bridge: TaskActionCompletionBridge,
  actionIds: readonly WorkItemActionId[],
  target: Pick<WorkItemActionTarget, 'teamId' | 'workItemId'>,
): boolean {
  const context = resolvePendingTaskActionContext(bridge, actionIds, target)
  return context ? bridge.cancelContext(context) : false
}

/**
 * Checks whether terminal cleanup may dismiss the editor owned by one completed invocation.
 *
 * An older in-flight mutation must not close an editor opened by a newer waiting invocation.
 *
 * @param bridge - Surface-local completion bridge.
 * @param completedContext - Exact invocation whose terminal result is being returned.
 * @returns Whether no newer waiting invocation owns the surface editor.
 */
export function canDismissCompletedTaskActionOwner(
  bridge: TaskActionCompletionBridge,
  completedContext: WorkItemActionContext,
): boolean {
  const currentContext = bridge.current()
  return currentContext === undefined || currentContext === completedContext
}

/**
 * Checks whether a bulk editor still owns the exact explicit checkbox selection it accepted.
 *
 * @param context - Pending bulk action context.
 * @param selection - Current explicit bulk selection snapshot.
 * @returns Whether every accepted target remains explicitly selected in the same order.
 */
export function isPendingTaskActionExplicitSelectionCurrent(
  context: WorkItemActionContext,
  selection: WorkItemActionSelection,
): boolean {
  const pendingTargets = resolveTaskActionContextTargets(context)
  return pendingTargets.length === selection.targets.length && pendingTargets.every(
    (target, index) => {
      const currentTarget = selection.targets[index]
      return currentTarget?.teamId === target.teamId &&
        currentTarget.workItemId === target.workItemId
    },
  )
}

/**
 * Checks whether every pending target remains visible and authorized on the mounted surface.
 *
 * Unlike selection equality, this guard permits a row context menu to retain its focused target
 * while unrelated global multi-selection keys remain selected.
 *
 * @param context - Pending canonical action context.
 * @param availableTargets - Current permission-pruned targets rendered by the surface.
 * @returns Whether every pending target remains available to its existing editor.
 */
export function isPendingTaskActionTargetAvailable(
  context: WorkItemActionContext,
  availableTargets: readonly WorkItemActionTarget[],
): boolean {
  if (context.actionId === 'create') return true
  return resolveTaskActionContextTargets(context).every((target) =>
    availableTargets.some((candidate) =>
      candidate.teamId === target.teamId && candidate.workItemId === target.workItemId
    )
  )
}

/**
 * Checks whether the focused Work Item still owns a single-target editor invocation.
 *
 * A row context-menu entrance updates focus to its own target while intentionally retaining
 * unrelated checkbox selection. Comparing focus therefore dismisses an editor when navigation
 * moves to another row without incorrectly cancelling a context-menu action.
 *
 * @param context - Pending single-target canonical action context.
 * @param selection - Current surface selection containing the focused target.
 * @returns Whether the same Team-qualified Work Item remains focused.
 */
export function isPendingTaskActionFocusCurrent(
  context: WorkItemActionContext,
  selection: WorkItemActionSelection,
): boolean {
  if (context.actionId === 'create') return true
  const pendingTargets = resolveTaskActionContextTargets(context)
  if (pendingTargets.length !== 1 || !selection.focusedTarget) return false
  const target = pendingTargets[0]
  return target?.teamId === selection.focusedTarget.teamId &&
    target.workItemId === selection.focusedTarget.workItemId
}

/**
 * Resolves the ordered selected or focused targets retained by an accepted action context.
 *
 * @param context - Canonical action context.
 * @returns Selected targets, or the focused target when the explicit selection is empty.
 */
function resolveTaskActionContextTargets(
  context: WorkItemActionContext,
): readonly WorkItemActionTarget[] {
  if (context.actionId === 'create') return []
  return context.selection.targets.length > 0
    ? context.selection.targets
    : context.selection.focusedTarget
      ? [context.selection.focusedTarget]
      : []
}
