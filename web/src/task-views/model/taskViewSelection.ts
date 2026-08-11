import type {
  WorkItemActionSelection,
  WorkItemActionTarget,
} from '@mukuroji/contracts'

const taskViewItemKeySeparator = '\u0000'

/** Team-qualified identity owned by the shared Work Item action contract. */
export type TaskViewItemIdentity = WorkItemActionTarget

/** Shared focus, anchor, and multi-selection state. */
export type TaskViewSelectionState = {
  /** Item currently targeted by keyboard navigation. */
  focusedKey?: string
  /** Selected item keys in visible-order preference. */
  selectedKeys: readonly string[]
  /** Range-selection origin. */
  anchorKey?: string
}

/** Moves focus by one visible item. */
export type TaskViewMoveFocusAction = {
  /** Reducer discriminator. */
  type: 'move-focus'
  /** Direction within the current visible order. */
  direction: 'next' | 'previous'
  /** Current visible item order. */
  orderedKeys: readonly string[]
  /** Whether movement replaces selection with the anchor-to-focus range. */
  extendSelection: boolean
}

/** Focuses an explicit item without selecting it. */
export type TaskViewFocusAction = {
  /** Reducer discriminator. */
  type: 'focus'
  /** Team-qualified item key to focus. */
  key: string
}

/** Toggles the currently focused item. */
export type TaskViewToggleFocusedAction = {
  /** Reducer discriminator. */
  type: 'toggle-focused'
}

/** Selection behavior for an explicit item. */
export type TaskViewSelectionMode = 'replace' | 'toggle' | 'range'

/** Selects an explicit item using pointer or keyboard semantics. */
export type TaskViewSelectAction = {
  /** Reducer discriminator. */
  type: 'select'
  /** Team-qualified item key to select. */
  key: string
  /** Replacement, toggle, or anchored-range behavior. */
  mode: TaskViewSelectionMode
  /** Current visible order required by range selection. */
  orderedKeys: readonly string[]
}

/** Removes identities no longer available to the current view. */
export type TaskViewPruneSelectionAction = {
  /** Reducer discriminator. */
  type: 'prune'
  /** Permission-safe keys still available to the surface. */
  availableKeys: readonly string[]
}

/** Clears selected items while retaining valid keyboard focus. */
export type TaskViewClearSelectionAction = {
  /** Reducer discriminator. */
  type: 'clear-selection'
}

/** Clears selection, anchor, and keyboard focus. */
export type TaskViewResetSelectionAction = {
  /** Reducer discriminator. */
  type: 'reset'
}

/** Event accepted by the shared selection reducer. */
export type TaskViewSelectionAction =
  | TaskViewMoveFocusAction
  | TaskViewFocusAction
  | TaskViewToggleFocusedAction
  | TaskViewSelectAction
  | TaskViewPruneSelectionAction
  | TaskViewClearSelectionAction
  | TaskViewResetSelectionAction

/** Pure keyboard event facts required by task-view navigation. */
export type TaskViewSelectionKeyboardInput = {
  /** Keyboard key reported by the event. */
  key: string
  /** Whether Meta is pressed. */
  metaKey: boolean
  /** Whether Control is pressed. */
  ctrlKey: boolean
  /** Whether Alt is pressed. */
  altKey: boolean
  /** Whether Shift is pressed. */
  shiftKey: boolean
  /** Whether the event is an auto-repeat. */
  repeat: boolean
  /** Whether an IME composition is active. */
  isComposing: boolean
  /** Whether the target accepts text or direct editing. */
  isEditableTarget: boolean
  /** Whether a modal surface currently owns keyboard input. */
  isModalOpen: boolean
}

/**
 * Creates the empty shared task-view selection state.
 *
 * @returns Empty focus and selection state.
 */
export function createTaskViewSelectionState(): TaskViewSelectionState {
  return { selectedKeys: [] }
}

/**
 * Creates a collision-safe Team-qualified Work Item key.
 *
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Composite selection key.
 */
export function createTaskViewItemKey(teamId: string, workItemId: string): string {
  return `${teamId}${taskViewItemKeySeparator}${workItemId}`
}

/**
 * Reads a Team-qualified key back into its canonical identity.
 *
 * @param key - Composite key created by {@link createTaskViewItemKey}.
 * @returns Parsed identity, or undefined for a malformed key.
 */
export function parseTaskViewItemKey(key: string): TaskViewItemIdentity | undefined {
  const separatorIndex = key.indexOf(taskViewItemKeySeparator)
  if (separatorIndex <= 0 || separatorIndex === key.length - 1) {
    return undefined
  }

  return {
    teamId: key.slice(0, separatorIndex),
    workItemId: key.slice(separatorIndex + taskViewItemKeySeparator.length),
  }
}

/**
 * Converts reducer state into the canonical action-selection contract.
 *
 * Unknown or newly inaccessible keys are omitted, so permission-pruned targets cannot leak into
 * a shared action context.
 *
 * @param state - Current focus and selection state.
 * @param availableTargets - Permission-safe targets in visible order.
 * @returns Canonical action selection snapshot.
 */
export function createTaskViewActionSelection(
  state: TaskViewSelectionState,
  availableTargets: readonly WorkItemActionTarget[],
): WorkItemActionSelection {
  const targetsByKey = new Map(
    availableTargets.map((target) => [
      createTaskViewItemKey(target.teamId, target.workItemId),
      target,
    ]),
  )
  const targets = state.selectedKeys.flatMap((key) => {
    const target = targetsByKey.get(key)
    return target ? [cloneWorkItemActionTarget(target)] : []
  })
  const focusedTarget = state.focusedKey
    ? targetsByKey.get(state.focusedKey)
    : undefined
  const anchorTarget = state.anchorKey
    ? targetsByKey.get(state.anchorKey)
    : undefined

  return {
    mode: targets.length === 0 ? 'none' : targets.length === 1 ? 'single' : 'multiple',
    targets,
    ...(focusedTarget ? { focusedTarget: cloneWorkItemActionTarget(focusedTarget) } : {}),
    ...(anchorTarget ? { anchorTarget: cloneWorkItemActionTarget(anchorTarget) } : {}),
  }
}

/**
 * Creates a revision-bound single-item focus snapshot for direct row or card actions.
 *
 * @param target - Team-qualified Work Item selected by the direct entrance.
 * @returns Canonical focused selection that does not inherit unrelated multi-selection.
 */
export function createFocusedTaskViewActionSelection(
  target: WorkItemActionTarget,
): WorkItemActionSelection {
  return {
    focusedTarget: cloneWorkItemActionTarget(target),
    mode: 'none',
    targets: [],
  }
}

/**
 * Applies focus, selection, range, and pruning actions without mutating the current state.
 *
 * @param state - Current shared selection state.
 * @param action - State transition to apply.
 * @returns Next normalized selection state.
 */
export function reduceTaskViewSelection(
  state: TaskViewSelectionState,
  action: TaskViewSelectionAction,
): TaskViewSelectionState {
  if (action.type === 'reset') {
    return createTaskViewSelectionState()
  }

  if (action.type === 'clear-selection') {
    return {
      ...(state.focusedKey ? { focusedKey: state.focusedKey, anchorKey: state.focusedKey } : {}),
      selectedKeys: [],
    }
  }

  if (action.type === 'focus') {
    return {
      ...state,
      anchorKey: action.key,
      focusedKey: action.key,
      selectedKeys: uniqueKeys(state.selectedKeys),
    }
  }

  if (action.type === 'toggle-focused') {
    if (!state.focusedKey) {
      return normalizeSelectionState(state)
    }
    return selectKey(state, state.focusedKey, 'toggle', [state.focusedKey])
  }

  if (action.type === 'select') {
    return selectKey(state, action.key, action.mode, action.orderedKeys)
  }

  if (action.type === 'prune') {
    return pruneTaskViewSelection(state, action.availableKeys)
  }

  return moveTaskViewFocus(
    state,
    action.orderedKeys,
    action.direction,
    action.extendSelection,
  )
}

/**
 * Converts guarded J/K and Space input into a reducer action.
 *
 * Shift+J/K extends an anchored range. Space toggles the focused item; Shift+Space selects the
 * complete anchor-to-focus range.
 *
 * @param input - Pure keyboard event facts.
 * @param state - Current selection state.
 * @param orderedKeys - Current visible order.
 * @returns A reducer action, or undefined when the event must remain untouched.
 */
export function createTaskViewSelectionKeyboardAction(
  input: TaskViewSelectionKeyboardInput,
  state: TaskViewSelectionState,
  orderedKeys: readonly string[],
): TaskViewSelectionAction | undefined {
  if (shouldGuardTaskViewSelectionKeyboard(input)) {
    return undefined
  }

  const key = normalizeSelectionKey(input.key)
  if (key === 'j' || key === 'k') {
    return {
      direction: key === 'j' ? 'next' : 'previous',
      extendSelection: input.shiftKey,
      orderedKeys,
      type: 'move-focus',
    }
  }

  if (key !== 'space' || input.repeat || !state.focusedKey) {
    return undefined
  }

  return input.shiftKey
    ? {
        key: state.focusedKey,
        mode: 'range',
        orderedKeys,
        type: 'select',
      }
    : { type: 'toggle-focused' }
}

/**
 * Reports whether editing, composition, modal ownership, or action modifiers guard navigation.
 *
 * @param input - Pure keyboard event facts.
 * @returns Whether task-view selection must ignore the event.
 */
export function shouldGuardTaskViewSelectionKeyboard(
  input: TaskViewSelectionKeyboardInput,
): boolean {
  return input.isComposing ||
    input.isEditableTarget ||
    input.isModalOpen ||
    input.metaKey ||
    input.ctrlKey ||
    input.altKey
}

/**
 * Moves focus within a visible ordering and optionally replaces selection with an anchored range.
 *
 * @param state - Current selection state.
 * @param orderedKeys - Current visible ordering.
 * @param direction - Previous or next movement.
 * @param extendSelection - Whether to select the anchor-to-focus range.
 * @returns Next selection state.
 */
function moveTaskViewFocus(
  state: TaskViewSelectionState,
  orderedKeys: readonly string[],
  direction: 'next' | 'previous',
  extendSelection: boolean,
): TaskViewSelectionState {
  const keys = uniqueKeys(orderedKeys)
  if (keys.length === 0) {
    return normalizeSelectionState(state)
  }

  const currentIndex = state.focusedKey ? keys.indexOf(state.focusedKey) : -1
  const nextIndex = currentIndex < 0
    ? direction === 'next' ? 0 : keys.length - 1
    : Math.max(0, Math.min(
        keys.length - 1,
        currentIndex + (direction === 'next' ? 1 : -1),
      ))
  const focusedKey = keys[nextIndex]
  if (!focusedKey) {
    return normalizeSelectionState(state)
  }

  if (!extendSelection) {
    return {
      ...state,
      anchorKey: focusedKey,
      focusedKey,
      selectedKeys: uniqueKeys(state.selectedKeys),
    }
  }

  const anchorKey = state.anchorKey && keys.includes(state.anchorKey)
    ? state.anchorKey
    : state.focusedKey && keys.includes(state.focusedKey)
      ? state.focusedKey
      : focusedKey

  return {
    anchorKey,
    focusedKey,
    selectedKeys: createVisibleRange(keys, anchorKey, focusedKey),
  }
}

/**
 * Applies explicit replacement, toggle, or range selection.
 *
 * @param state - Current selection state.
 * @param key - Explicit item key.
 * @param mode - Selection behavior.
 * @param orderedKeys - Current visible ordering.
 * @returns Next selection state.
 */
function selectKey(
  state: TaskViewSelectionState,
  key: string,
  mode: TaskViewSelectionMode,
  orderedKeys: readonly string[],
): TaskViewSelectionState {
  const selectedKeys = uniqueKeys(state.selectedKeys)
  if (mode === 'replace') {
    return { anchorKey: key, focusedKey: key, selectedKeys: [key] }
  }

  if (mode === 'toggle') {
    return {
      anchorKey: key,
      focusedKey: key,
      selectedKeys: selectedKeys.includes(key)
        ? selectedKeys.filter((selectedKey) => selectedKey !== key)
        : [...selectedKeys, key],
    }
  }

  const keys = uniqueKeys(orderedKeys)
  const anchorKey = state.anchorKey && keys.includes(state.anchorKey)
    ? state.anchorKey
    : state.focusedKey && keys.includes(state.focusedKey)
      ? state.focusedKey
      : key

  return {
    anchorKey,
    focusedKey: key,
    selectedKeys: createVisibleRange(keys, anchorKey, key),
  }
}

/**
 * Removes stale or newly inaccessible identities and restores a valid focus fallback.
 *
 * @param state - Current selection state.
 * @param availableKeys - Keys still available to the current viewer.
 * @returns Permission-safe selection state.
 */
function pruneTaskViewSelection(
  state: TaskViewSelectionState,
  availableKeys: readonly string[],
): TaskViewSelectionState {
  const available = uniqueKeys(availableKeys)
  const selectedSet = new Set(state.selectedKeys)
  const selectedKeys = available.filter((key) => selectedSet.has(key))
  const focusedKey = state.focusedKey && available.includes(state.focusedKey)
    ? state.focusedKey
    : selectedKeys[0] ?? available[0]
  const anchorKey = state.anchorKey && available.includes(state.anchorKey)
    ? state.anchorKey
    : focusedKey

  const nextState: TaskViewSelectionState = {
    ...(focusedKey ? { focusedKey } : {}),
    ...(anchorKey ? { anchorKey } : {}),
    selectedKeys,
  }

  return areTaskViewSelectionStatesEqual(state, nextState) ? state : nextState
}

/**
 * Compares normalized task-view selections without relying on object or array identity.
 *
 * @param first - Current selection state.
 * @param second - Candidate selection state.
 * @returns Whether focus, anchor, and ordered selected keys are structurally equal.
 */
function areTaskViewSelectionStatesEqual(
  first: TaskViewSelectionState,
  second: TaskViewSelectionState,
): boolean {
  return first.focusedKey === second.focusedKey &&
    first.anchorKey === second.anchorKey &&
    first.selectedKeys.length === second.selectedKeys.length &&
    first.selectedKeys.every((key, index) => key === second.selectedKeys[index])
}

/**
 * Creates an inclusive visible range.
 *
 * @param orderedKeys - Current visible ordering.
 * @param firstKey - First range endpoint.
 * @param secondKey - Second range endpoint.
 * @returns Keys between both endpoints in visible order.
 */
function createVisibleRange(
  orderedKeys: readonly string[],
  firstKey: string,
  secondKey: string,
): string[] {
  const firstIndex = orderedKeys.indexOf(firstKey)
  const secondIndex = orderedKeys.indexOf(secondKey)
  if (firstIndex < 0 || secondIndex < 0) {
    return orderedKeys.includes(secondKey) ? [secondKey] : []
  }

  return orderedKeys.slice(
    Math.min(firstIndex, secondIndex),
    Math.max(firstIndex, secondIndex) + 1,
  )
}

/**
 * Deduplicates non-empty keys while preserving order.
 *
 * @param keys - Candidate keys.
 * @returns Stable unique keys.
 */
function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.filter(Boolean))]
}

/**
 * Normalizes an existing state without changing valid focus or anchor values.
 *
 * @param state - State to normalize.
 * @returns State with unique selected keys.
 */
function normalizeSelectionState(state: TaskViewSelectionState): TaskViewSelectionState {
  return {
    ...(state.focusedKey ? { focusedKey: state.focusedKey } : {}),
    ...(state.anchorKey ? { anchorKey: state.anchorKey } : {}),
    selectedKeys: uniqueKeys(state.selectedKeys),
  }
}

/**
 * Normalizes browser Space values and letter case.
 *
 * @param key - Browser keyboard key.
 * @returns Canonical selection key.
 */
function normalizeSelectionKey(key: string): string {
  const normalized = key.trim().toLowerCase()
  return normalized === '' || normalized === 'spacebar' || normalized === 'space'
    ? 'space'
    : normalized
}

/**
 * Clones one canonical action target.
 *
 * @param target - Target to detach.
 * @returns Detached target.
 */
function cloneWorkItemActionTarget(target: WorkItemActionTarget): WorkItemActionTarget {
  return {
    teamId: target.teamId,
    workItemId: target.workItemId,
    ...(target.expectedRevision !== undefined
      ? { expectedRevision: target.expectedRevision }
      : {}),
  }
}
