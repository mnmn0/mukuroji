import type {
  SavedTaskView,
  TaskViewLayoutMode,
  TaskViewUrlOverride,
} from '@mukuroji/contracts'

/** Reserved URL identifier that explicitly selects the built-in route definition. */
export const BUILT_IN_TASK_VIEW_ID = '__built-in__'

/** Saved views that form the base definition of one task-view route. */
export type TaskViewBaseSelection = {
  /** Saved view named by the URL, when it exists. */
  explicitlySelectedView?: SavedTaskView
  /** Personal default, used only without an explicit URL selection. */
  personalDefault?: SavedTaskView
  /** Team default, used only without an explicit URL selection. */
  teamDefault?: SavedTaskView
  /** Saved view that supplies the base definition, if any. */
  activeSavedView?: SavedTaskView
}

/**
 * Chooses the saved views that form the base definition, in the canonical precedence order.
 *
 * @param savedViews - Saved views of the route's surface and scope.
 * @param viewId - Saved-view identifier from the URL, if any.
 * @returns The explicit selection, the defaults, and the active saved view.
 */
export function selectTaskViewBase(
  savedViews: readonly SavedTaskView[],
  viewId: string | undefined,
): TaskViewBaseSelection {
  const explicitlySelectedView = viewId === undefined || viewId === BUILT_IN_TASK_VIEW_ID
    ? undefined
    : savedViews.find((view) => view.id === viewId)
  const hasExplicitSelection = viewId !== undefined
  const personalDefault = hasExplicitSelection
    ? undefined
    : savedViews.find((view) => view.preference.isPersonalDefault)
  const teamDefault = hasExplicitSelection
    ? undefined
    : savedViews.find((view) => view.preference.isTeamDefault)
  const activeSavedView = viewId ? explicitlySelectedView : personalDefault ?? teamDefault
  return {
    ...(explicitlySelectedView ? { explicitlySelectedView } : {}),
    ...(personalDefault ? { personalDefault } : {}),
    ...(teamDefault ? { teamDefault } : {}),
    ...(activeSavedView ? { activeSavedView } : {}),
  }
}

/**
 * Resolves the layout mode of a task-view route from its URL state and saved views.
 *
 * It follows the same precedence as the full definition: a URL layout override, then the
 * active saved view, then the built-in layout.
 *
 * @param input - Built-in layout, saved views, and parsed URL state.
 * @returns The effective layout mode before capability sanitization.
 */
export function resolveTaskViewLayoutMode(input: {
  /** Layout of the built-in definition. */
  builtInMode: TaskViewLayoutMode
  /** Saved views of the route's surface and scope. */
  savedViews: readonly SavedTaskView[]
  /** Saved-view identifier from the URL, if any. */
  viewId?: string
  /** Temporary URL override, if any. */
  override?: TaskViewUrlOverride
}): TaskViewLayoutMode {
  return input.override?.layout?.mode ??
    selectTaskViewBase(input.savedViews, input.viewId).activeSavedView?.definition.layout.mode ??
    input.builtInMode
}

/** Last settled layout of a route, remembered for scope changes within the same identity. */
export type ContinuedTaskViewLayoutMode = {
  /** Identity the layout was settled for, such as a Project ID. */
  continuityKey: string
  /** Settled layout mode. */
  mode: TaskViewLayoutMode
}

/**
 * Chooses the layout to use while the current scope's saved views may still be loading.
 *
 * @param current - Layout of the current scope, or `undefined` while it is not settled.
 * @param last - Last settled layout, if any.
 * @param continuityKey - Identity of the current route, such as a Project ID.
 * @returns The current layout, else the last one of the same identity, else `undefined`.
 */
export function continueTaskViewLayoutMode(
  current: TaskViewLayoutMode | undefined,
  last: ContinuedTaskViewLayoutMode | undefined,
  continuityKey: string,
): TaskViewLayoutMode | undefined {
  if (current !== undefined) return current
  return last?.continuityKey === continuityKey ? last.mode : undefined
}
