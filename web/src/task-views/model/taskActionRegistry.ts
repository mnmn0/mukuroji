import {
  WORK_ITEM_ACTION_IDS,
  WORK_ITEM_ACTION_SCHEMA_VERSION,
  type WorkItemActionContext,
  type WorkItemActionFailureCategory,
  type WorkItemActionId,
  type WorkItemActionResult,
  type WorkItemActionTarget,
  type WorkItemActionTrigger,
} from '@mukuroji/contracts'

/** Canonical Work Item actions in contract-defined registry order. */
export const taskActionIds: readonly WorkItemActionId[] = WORK_ITEM_ACTION_IDS

/** Canonical action identifier owned by the shared contract. */
export type TaskActionId = WorkItemActionId

/** Canonical invocation context owned by the shared contract. */
export type TaskActionContext = WorkItemActionContext

/** Canonical invocation trigger owned by the shared contract. */
export type TaskActionTrigger = WorkItemActionTrigger

/** Canonical Team-qualified target owned by the shared contract. */
export type TaskActionTarget = WorkItemActionTarget

/** Canonical executor result owned by the shared contract. */
export type TaskActionResult = WorkItemActionResult

/** Permission result returned by an action definition. */
export type TaskActionPermissionResult =
  | {
      /** Whether execution is permitted. */
      allowed: true
    }
  | {
      /** Whether execution is permitted. */
      allowed: false
      /** Safe reason shown by every invocation path. */
      reason: string
    }

/** Validation result returned by an action definition. */
export type TaskActionValidationResult =
  | {
      /** Whether the invocation is valid. */
      valid: true
    }
  | {
      /** Whether the invocation is valid. */
      valid: false
      /** Stable or localized issues shown by every invocation path. */
      issues: readonly string[]
    }

/** Platform-neutral keyboard chord assigned to an action. */
export type TaskActionShortcut = {
  /** Keyboard key, normalized case-insensitively. */
  key: string
  /** Whether Cmd on macOS or Ctrl elsewhere is required. */
  primary?: boolean
  /** Whether Alt is required. */
  alt?: boolean
  /** Whether Shift is required. */
  shift?: boolean
}

/** Definition executed consistently from every UI invocation path. */
export type TaskActionDefinition = {
  /** Canonical contract action identifier. */
  id: WorkItemActionId
  /** Optional platform-neutral keyboard shortcut. */
  shortcut?: TaskActionShortcut
  /** Evaluates current permission without mutating state. */
  permission: (context: WorkItemActionContext) => TaskActionPermissionResult
  /** Validates action-specific selection and route context without mutating state. */
  validate: (context: WorkItemActionContext) => TaskActionValidationResult
  /** Executes the already permitted and validated canonical action. */
  execute: (context: WorkItemActionContext) => WorkItemActionResult | Promise<WorkItemActionResult>
}

/** Collision that disables ambiguous shortcut dispatch. */
export type TaskActionShortcutCollision = {
  /** Normalized keyboard chord. */
  chord: string
  /** Actions claiming the chord in canonical contract order. */
  actionIds: readonly WorkItemActionId[]
  /** Whether the chord is also reserved outside the action registry. */
  reserved: boolean
}

/** Immutable lookup tables and diagnostics for canonical task actions. */
export type TaskActionRegistry = {
  /** Definitions indexed by canonical action ID. */
  actions: ReadonlyMap<WorkItemActionId, TaskActionDefinition>
  /** Unambiguous shortcuts indexed by normalized chord. */
  shortcuts: ReadonlyMap<string, WorkItemActionId>
  /** Ambiguous or externally reserved shortcut claims. */
  shortcutCollisions: readonly TaskActionShortcutCollision[]
  /** Canonical contract actions not registered by the current surface. */
  missingActionIds: readonly WorkItemActionId[]
}

/** Options used to construct an action registry. */
export type CreateTaskActionRegistryOptions = {
  /** Action definitions available in the current surface. */
  definitions: readonly TaskActionDefinition[]
  /** Shortcuts already owned by the application or surface. */
  reservedShortcuts?: readonly TaskActionShortcut[]
}

/** Pure keyboard input used to resolve a registered action. */
export type TaskActionKeyboardInput = {
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

/** Result of running one canonical task action through the Web registry. */
export type TaskActionExecutionResult =
  | {
      /** Registry outcome. */
      status: 'not-registered'
      /** Requested canonical action. */
      actionId: WorkItemActionId
    }
  | {
      /** Registry outcome. */
      status: 'denied'
      /** Requested canonical action. */
      actionId: WorkItemActionId
      /** Safe permission reason. */
      reason: string
    }
  | {
      /** Registry outcome. */
      status: 'invalid'
      /** Requested canonical action. */
      actionId: WorkItemActionId
      /** Validation issues. */
      issues: readonly string[]
    }
  | {
      /** Registry outcome. */
      status: 'executed'
      /** Requested canonical action. */
      actionId: WorkItemActionId
      /** Canonical result shared by every invocation path. */
      result: WorkItemActionResult
    }
  | {
      /** Registry outcome. */
      status: 'failed'
      /** Requested canonical action. */
      actionId: WorkItemActionId
      /** Unknown executor or policy failure retained for the caller's error boundary. */
      error: unknown
    }

/**
 * Creates deterministic action and shortcut lookup tables.
 *
 * Duplicate action identifiers are rejected. Ambiguous or reserved shortcuts remain visible in
 * diagnostics but are excluded from keyboard dispatch.
 *
 * @param options - Definitions and externally reserved shortcuts.
 * @returns Immutable registry lookups and collision diagnostics.
 */
export function createTaskActionRegistry(
  options: CreateTaskActionRegistryOptions,
): TaskActionRegistry {
  const definitionsById = new Map<WorkItemActionId, TaskActionDefinition>()

  for (const definition of options.definitions) {
    if (definitionsById.has(definition.id)) {
      throw new RangeError(`Duplicate task action definition: ${definition.id}`)
    }
    definitionsById.set(definition.id, definition)
  }

  const actions = new Map<WorkItemActionId, TaskActionDefinition>()
  for (const actionId of taskActionIds) {
    const definition = definitionsById.get(actionId)
    if (definition) actions.set(actionId, definition)
  }

  const shortcutClaims = new Map<string, WorkItemActionId[]>()
  for (const definition of actions.values()) {
    if (!definition.shortcut) continue
    const chord = createTaskActionShortcutChord(definition.shortcut)
    shortcutClaims.set(chord, [...(shortcutClaims.get(chord) ?? []), definition.id])
  }

  const reservedChords = new Set(
    (options.reservedShortcuts ?? []).map(createTaskActionShortcutChord),
  )
  const shortcuts = new Map<string, WorkItemActionId>()
  const shortcutCollisions: TaskActionShortcutCollision[] = []

  for (const [chord, actionIds] of [...shortcutClaims.entries()].sort(
    ([first], [second]) => first.localeCompare(second),
  )) {
    const reserved = reservedChords.has(chord)
    if (actionIds.length !== 1 || reserved) {
      shortcutCollisions.push({ actionIds, chord, reserved })
      continue
    }
    const actionId = actionIds[0]
    if (actionId) shortcuts.set(chord, actionId)
  }

  return {
    actions,
    shortcuts,
    shortcutCollisions,
    missingActionIds: taskActionIds.filter((actionId) => !actions.has(actionId)),
  }
}

/**
 * Runs permission and validation before invoking the canonical action executor.
 *
 * @param registry - Registry containing the requested action.
 * @param context - Contract context shared by every invocation path.
 * @returns A normalized registry outcome containing the canonical action result.
 */
export async function executeTaskAction(
  registry: TaskActionRegistry,
  context: WorkItemActionContext,
): Promise<TaskActionExecutionResult> {
  const actionId = context.actionId
  const definition = registry.actions.get(actionId)
  if (!definition) return { actionId, status: 'not-registered' }

  try {
    const permission = definition.permission(context)
    if (!permission.allowed) {
      return { actionId, reason: permission.reason, status: 'denied' }
    }

    const validation = definition.validate(context)
    if (!validation.valid) {
      return { actionId, issues: [...validation.issues], status: 'invalid' }
    }

    const result = await definition.execute(context)
    if (result.actionId !== actionId) {
      return {
        actionId,
        error: new RangeError('Task action executor returned a different action ID.'),
        status: 'failed',
      }
    }
    return { actionId, result, status: 'executed' }
  } catch (error) {
    return { actionId, error, status: 'failed' }
  }
}

/**
 * Resolves an unambiguous action shortcut after common keyboard guards.
 *
 * @param registry - Registry containing shortcut lookups.
 * @param input - Platform-neutral keyboard input.
 * @returns Matching action definition, or undefined when guarded or ambiguous.
 */
export function resolveTaskActionShortcut(
  registry: TaskActionRegistry,
  input: TaskActionKeyboardInput,
): TaskActionDefinition | undefined {
  if (
    input.repeat ||
    input.isComposing ||
    input.isEditableTarget ||
    input.isModalOpen
  ) return undefined

  const actionId = registry.shortcuts.get(createKeyboardInputChord(input))
  return actionId ? registry.actions.get(actionId) : undefined
}

/**
 * Creates a normalized chord for collision detection and event lookup.
 *
 * @param shortcut - Platform-neutral shortcut.
 * @returns Stable chord with modifiers in canonical order.
 */
export function createTaskActionShortcutChord(shortcut: TaskActionShortcut): string {
  return [
    shortcut.primary ? 'primary' : undefined,
    shortcut.alt ? 'alt' : undefined,
    shortcut.shift ? 'shift' : undefined,
    normalizeShortcutKey(shortcut.key),
  ].filter((part) => part !== undefined).join('+')
}

/**
 * Creates an allowed permission result.
 *
 * @returns An allowed result reusable by simple actions.
 */
export function allowTaskAction(): TaskActionPermissionResult {
  return { allowed: true }
}

/**
 * Creates a denied permission result.
 *
 * @param reason - Safe reason shown by every invocation path.
 * @returns A denied result.
 */
export function denyTaskAction(reason: string): TaskActionPermissionResult {
  return { allowed: false, reason }
}

/**
 * Creates a successful validation result.
 *
 * @returns A valid result reusable by actions without extra input.
 */
export function validateTaskAction(): TaskActionValidationResult {
  return { valid: true }
}

/**
 * Creates a failed validation result.
 *
 * @param issues - Stable or localized validation issues.
 * @returns An invalid result.
 */
export function invalidateTaskAction(
  issues: readonly string[],
): TaskActionValidationResult {
  return { issues: [...issues], valid: false }
}

/**
 * Evaluates display-time permission and validation without mutating state.
 *
 * Menu and command surfaces use this helper to display the same first blocking reason that the
 * canonical executor will enforce again at activation time.
 *
 * @param definition - Registered action definition.
 * @param context - Complete action context for the current invocation surface.
 * @returns First permission or validation reason, when disabled.
 */
export function resolveTaskActionDisabledReason(
  definition: TaskActionDefinition,
  context: WorkItemActionContext,
): string | undefined {
  const permission = definition.permission(context)
  if (!permission.allowed) return permission.reason
  const validation = definition.validate(context)
  return validation.valid ? undefined : validation.issues.join(' ')
}

/**
 * Formats a platform-neutral shortcut for compact action-menu metadata.
 *
 * @param shortcut - Shortcut declared by a shared registry definition.
 * @returns Compact cross-platform display label.
 */
export function formatTaskActionShortcut(shortcut: TaskActionShortcut): string {
  return [
    shortcut.primary ? '⌘/Ctrl' : undefined,
    shortcut.alt ? 'Alt' : undefined,
    shortcut.shift ? 'Shift' : undefined,
    shortcut.key.toLowerCase() === 'enter'
      ? 'Enter'
      : shortcut.key.length === 1
        ? shortcut.key.toUpperCase()
        : shortcut.key,
  ].filter((part) => part !== undefined).join(' + ')
}

/**
 * Creates a canonical successful action result for one optional target.
 *
 * @param actionId - Canonical action that completed.
 * @param target - Optional target evaluated by the action.
 * @returns Shared successful result.
 */
export function createSucceededTaskActionResult(
  actionId: WorkItemActionId,
  target?: WorkItemActionTarget,
): WorkItemActionResult {
  return createSucceededTaskActionResults(actionId, target ? [target] : [])
}

/**
 * Creates a canonical successful action result for every accepted target.
 *
 * @param actionId - Canonical action that completed.
 * @param targets - Ordered Team-qualified target snapshots.
 * @returns Shared successful result retaining every target revision.
 */
export function createSucceededTaskActionResults(
  actionId: WorkItemActionId,
  targets: readonly WorkItemActionTarget[],
): WorkItemActionResult {
  return {
    actionId,
    items: targets.map((target) => ({ status: 'succeeded', target })),
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    status: 'succeeded',
  }
}

/**
 * Creates a successful Create result retaining the persisted target and navigation destination.
 *
 * @param createdTarget - Revision-bound Work Item returned by persistence, when available.
 * @param navigationPath - Application-relative destination opened for the created Work Item.
 * @returns Shared successful Create result.
 */
export function createSucceededTaskCreateActionResult(
  createdTarget?: WorkItemActionTarget,
  navigationPath?: string,
): WorkItemActionResult {
  return {
    actionId: 'create',
    items: [],
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    status: 'succeeded',
    ...(createdTarget !== undefined ? { createdTarget } : {}),
    ...(navigationPath !== undefined ? { navigationPath } : {}),
  }
}

/**
 * Creates a canonical successful mutation result with its persisted revision and undo token.
 *
 * @param actionId - Canonical action that completed.
 * @param target - Revision-bound target evaluated by the mutation.
 * @param resultingRevision - Canonical revision returned by persistence, when available.
 * @param undoToken - Opaque token consumed by the existing undo entrance, when available.
 * @returns Shared successful mutation result.
 */
export function createSucceededTaskActionMutationResult(
  actionId: WorkItemActionId,
  target: WorkItemActionTarget,
  resultingRevision?: number,
  undoToken?: string,
): WorkItemActionResult {
  return {
    actionId,
    items: [{
      status: 'succeeded',
      target,
      ...(resultingRevision !== undefined ? { resultingRevision } : {}),
    }],
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    status: 'succeeded',
    ...(undoToken !== undefined ? { undoToken } : {}),
  }
}

/**
 * Creates a canonical cancelled result for an editor or preview dismissed before persistence.
 *
 * @param actionId - Canonical action that was cancelled.
 * @param targets - Ordered targets retained from the accepted action context.
 * @returns Shared cancelled result.
 */
export function createCancelledTaskActionResult(
  actionId: WorkItemActionId,
  targets: readonly WorkItemActionTarget[],
): WorkItemActionResult {
  return {
    actionId,
    items: targets.map((target) => ({ status: 'cancelled', target })),
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    status: 'cancelled',
  }
}

/**
 * Creates a canonical safe failure for a missing or unavailable action entrance.
 *
 * @param actionId - Canonical action that failed.
 * @param target - Optional target evaluated by the action.
 * @param code - Stable failure code.
 * @param category - Stable failure category.
 * @param message - Safe localized failure message.
 * @param retryable - Whether retrying after refresh may succeed.
 * @returns Shared failed result.
 */
export function createFailedTaskActionResult(
  actionId: WorkItemActionId,
  target: WorkItemActionTarget | undefined,
  code: string,
  category: WorkItemActionFailureCategory,
  message: string,
  retryable = false,
): WorkItemActionResult {
  return createFailedTaskActionResults(
    actionId,
    target ? [target] : [],
    code,
    category,
    message,
    retryable,
  )
}

/**
 * Creates a canonical safe failure for every target rejected by one mutation attempt.
 *
 * @param actionId - Canonical action that failed.
 * @param targets - Ordered Team-qualified targets evaluated by the mutation.
 * @param code - Stable failure code.
 * @param category - Stable failure category.
 * @param message - Safe localized failure message.
 * @param retryable - Whether retrying the same normalized action may succeed.
 * @returns Shared failed result containing one failure per target.
 */
export function createFailedTaskActionResults(
  actionId: WorkItemActionId,
  targets: readonly WorkItemActionTarget[],
  code: string,
  category: WorkItemActionFailureCategory,
  message: string,
  retryable = false,
): WorkItemActionResult {
  const failure = { category, code, message, retryable }
  return {
    actionId,
    failure,
    items: targets.map((target) => ({ failure, status: 'failed', target })),
    schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
    status: 'failed',
  }
}

/**
 * Resolves the safe user-facing failure from a normalized registry execution.
 *
 * @param result - Permission, validation, executor, or canonical action outcome.
 * @param fallbackMessage - Safe message used when the outcome has no specific reason.
 * @returns Specific failure text, or undefined after a successful execution.
 */
export function resolveTaskActionExecutionFailureMessage(
  result: TaskActionExecutionResult,
  fallbackMessage: string,
): string | undefined {
  if (result.status === 'denied') return result.reason
  if (result.status === 'invalid') return result.issues.join(' ')
  if (result.status === 'failed' || result.status === 'not-registered') {
    return fallbackMessage
  }
  if (result.result.status === 'failed' || result.result.status === 'partial') {
    return result.result.failure?.message ??
      result.result.items.find((item) => item.failure)?.failure?.message ??
      fallbackMessage
  }
  return undefined
}

/**
 * Converts keyboard input into the same chord format used by definitions.
 *
 * @param input - Platform-neutral keyboard input.
 * @returns Stable chord.
 */
function createKeyboardInputChord(input: TaskActionKeyboardInput): string {
  return createTaskActionShortcutChord({
    key: input.key,
    primary: input.metaKey || input.ctrlKey,
    alt: input.altKey,
    shift: input.shiftKey,
  })
}

/**
 * Normalizes browser key values for registry matching.
 *
 * @param key - Keyboard key or shortcut declaration.
 * @returns Lowercase canonical key.
 */
function normalizeShortcutKey(key: string): string {
  const normalized = key.trim().toLowerCase()
  return normalized === '' || normalized === 'spacebar' || normalized === 'space'
    ? 'space'
    : normalized
}
