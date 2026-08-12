import type {
  CanonicalWorkItem,
  WorkItemActionContext,
  WorkItemActionId,
  WorkItemActionTarget,
  WorkItemPatch,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
} from '@mukuroji/contracts'

/** Canonical mutation actions selected by direct Project task controls. */
export type ProjectTaskDirectActionId = Extract<
  WorkItemActionId,
  'assign' | 'edit' | 'move' | 'schedule'
>

/** A direct Project task mutation payload retained until its canonical handler consumes it. */
export type ProjectTaskDirectActionInput =
  | {
      /** Identifies an inline, paste, fill, status, or assignee patch. */
      kind: 'patch'
      /** Complete patch selected by the direct control. */
      patch: WorkItemPatch
    }
  | {
      /** Identifies a Gantt or Calendar schedule gesture. */
      kind: 'schedule-operation'
      /** Original schedule operation selected before server preview. */
      operation: WorkItemScheduleOperation
    }

/** One exact, revision-bound Project action invocation installed by a direct control. */
export type ProjectTaskDirectActionRequest = {
  /** Canonical action selected from the direct mutation payload. */
  actionId: ProjectTaskDirectActionId
  /** Immutable direct mutation payload. */
  input: ProjectTaskDirectActionInput
  /** Project scope in which permission and validation must run. */
  projectId: string
  /** Revision snapshot evaluated by the canonical action pipeline. */
  target: WorkItemActionTarget
}

/** Mutable one-shot handoff from a direct control to the synchronous registry handler. */
export type ProjectTaskDirectActionRequestSlot = {
  /** Exact request awaiting canonical handler consumption. */
  current: ProjectTaskDirectActionRequest | undefined
}

/** Per-target ownership retained from handler consumption through terminal completion. */
export type ProjectTaskDirectActionInFlight = Map<string, ProjectTaskDirectActionRequest>

/** Phase of a direct Schedule request's preview and mutation handshake. */
export type ProjectTaskDirectSchedulePhase =
  | 'installed'
  | 'previewing'
  | 'awaiting-confirmation'
  | 'mutation-in-flight'
  | 'cancelled'
  | 'completed'
  | 'failed'

/** Exact preview controller returned to the Gantt, Calendar, or shared screen dialog. */
export type ProjectTaskDirectScheduleController = {
  /** Cancels only this invocation while it still awaits confirmation. */
  cancel: () => boolean
  /** Confirms only this invocation and waits for its actual persisted Work Item. */
  confirm: () => Promise<CanonicalWorkItem>
  /** Authoritative schedule preview displayed by the existing surface dialog. */
  preview: WorkItemScheduleChangePreview
  /** Object-identity token preventing an older dialog from settling a later request. */
  token: ProjectTaskDirectActionRequest
}

/** Synchronous ownership returned before a Gantt or Calendar preview request can await network. */
export type ProjectTaskDirectScheduleHandle = {
  /** Cancels only this invocation before mutation dispatch, including during network preview. */
  cancel: () => boolean
  /** Resolves only when permission, validation, and server preview all accept this invocation. */
  preview: Promise<ProjectTaskDirectScheduleController>
  /** Object-identity token used for exact view cleanup. */
  token: ProjectTaskDirectActionRequest
}

/** Deferred value used internally by the pure direct Schedule state machine. */
type Deferred<Value> = {
  /** Promise observed by the caller awaiting this transition. */
  promise: Promise<Value>
  /** Rejects the transition with its original failure. */
  reject: (error: unknown) => void
  /** Resolves the transition with its exact value. */
  resolve: (value: Value) => void
}

/** Decision returned from an existing preview dialog to the canonical Schedule handler. */
type ProjectTaskDirectScheduleDecision = 'cancelled' | 'confirmed'

/** Internal state retained weakly for one direct Schedule request token. */
type ProjectTaskDirectScheduleState = {
  /** Exact preview controller published for the request. */
  controller?: ProjectTaskDirectScheduleController
  /** Decision awaited by the canonical handler after preview. */
  decision: Deferred<ProjectTaskDirectScheduleDecision>
  /** Persisted task returned after confirmation. */
  completedTask?: CanonicalWorkItem
  /** Original terminal failure returned to the owning view. */
  error?: unknown
  /** Current cancellation and mutation phase. */
  phase: ProjectTaskDirectSchedulePhase
  /** Lazy waiter used only by Gantt or Calendar before a preview is available. */
  previewWaiter?: Deferred<ProjectTaskDirectScheduleController>
  /** Promise returned by an accepted confirm gesture. */
  mutationWaiter?: Deferred<CanonicalWorkItem>
}

const directScheduleStates = new WeakMap<
  ProjectTaskDirectActionRequest,
  ProjectTaskDirectScheduleState
>()

/** Error name used to suppress expected UI errors after exact preview cancellation. */
const projectTaskDirectScheduleCancelledErrorName = 'ProjectTaskDirectScheduleCancelledError'

/**
 * Creates a one-shot direct Project patch request and classifies its canonical action.
 *
 * @param projectId - Project scope owning the visible task surface.
 * @param target - Revision-bound task selected by the direct control.
 * @param patch - Complete inline, paste, fill, status, or assignee patch.
 * @returns Immutable request whose object identity is its invocation token.
 */
export function createProjectTaskDirectPatchRequest(
  projectId: string,
  target: WorkItemActionTarget,
  patch: WorkItemPatch,
): ProjectTaskDirectActionRequest {
  const request: ProjectTaskDirectActionRequest = {
    actionId: classifyProjectTaskDirectPatch(patch),
    input: { kind: 'patch', patch: structuredClone(patch) },
    projectId,
    target: { ...target },
  }
  if (isProjectTaskDirectScheduleRequest(request)) initializeDirectScheduleState(request)
  return request
}

/**
 * Creates a one-shot direct Schedule request for a Gantt or Calendar gesture.
 *
 * @param projectId - Project scope owning the timeline surface.
 * @param target - Revision-bound task selected by the gesture.
 * @param operation - Move, resize, or replacement operation selected before preview.
 * @returns Immutable Schedule request whose object identity is its invocation token.
 */
export function createProjectTaskDirectScheduleRequest(
  projectId: string,
  target: WorkItemActionTarget,
  operation: WorkItemScheduleOperation,
): ProjectTaskDirectActionRequest {
  const request: ProjectTaskDirectActionRequest = {
    actionId: 'schedule',
    input: { kind: 'schedule-operation', operation: structuredClone(operation) },
    projectId,
    target: { ...target },
  }
  initializeDirectScheduleState(request)
  return request
}

/**
 * Creates synchronous view ownership before an asynchronous timeline preview begins.
 *
 * @param request - Exact direct Schedule request installed before registry execution.
 * @returns Handle whose cancel operation is available before its preview Promise settles.
 */
export function createProjectTaskDirectScheduleHandle(
  request: ProjectTaskDirectActionRequest,
): ProjectTaskDirectScheduleHandle {
  requireDirectScheduleState(request)
  return {
    cancel: () => cancelAwaitingProjectTaskDirectSchedule(request),
    preview: waitForProjectTaskDirectSchedulePreview(request),
    token: request,
  }
}

/**
 * Classifies a complete Project patch without splitting its atomic mutation or undo state.
 *
 * @param patch - Complete patch emitted by an inline, paste, fill, or direct field control.
 * @returns Canonical action used for permission, validation, and mutation execution.
 */
export function classifyProjectTaskDirectPatch(
  patch: WorkItemPatch,
): ProjectTaskDirectActionId {
  const fields = resolveDefinedProjectTaskPatchFields(patch)
  if (fields.length === 1 && fields[0] === 'schedule') return 'schedule'
  if (fields.length === 1 && fields[0] === 'assigneeUserId') return 'assign'
  if (
    fields.length > 0 &&
    fields.every((field) => field === 'assignedProjectId' || field === 'workflowStatusId')
  ) return 'move'
  return 'edit'
}

/**
 * Checks whether a direct patch can retain one atomic canonical mutation.
 *
 * Schedule plus content, assignment, or move fields cannot use the schedule confirmation endpoint
 * atomically and must fail validation instead of silently splitting revision and undo ownership.
 *
 * @param request - Direct request synchronously consumed by the matching action handler.
 * @returns Whether the request has at least one field and no schedule-plus-other compound patch.
 */
export function isSupportedProjectTaskDirectPatch(
  request: ProjectTaskDirectActionRequest,
): boolean {
  if (request.input.kind !== 'patch') return true
  const fields = resolveDefinedProjectTaskPatchFields(request.input.patch)
  return fields.length > 0 && !(fields.includes('schedule') && fields.length > 1)
}

/**
 * Consumes a direct request only for its exact Project, action, target, and revision context.
 *
 * A mismatch consumes the stale slot so a later command, context menu, or keyboard action cannot
 * inherit a destination selected by another invocation.
 *
 * @param slot - Surface-local one-shot request slot.
 * @param context - Canonical action context accepted by permission and shared validation.
 * @returns Exact matching request, or undefined after an empty or stale handoff.
 */
export function consumeProjectTaskDirectActionRequest(
  slot: ProjectTaskDirectActionRequestSlot,
  context: WorkItemActionContext,
): ProjectTaskDirectActionRequest | undefined {
  const request = slot.current
  if (!request) return undefined
  slot.current = undefined
  const target = resolveProjectTaskDirectActionTarget(context)
  return target &&
      context.surface === 'project' &&
      context.scope.kind === 'project' &&
      context.scope.projectId === request.projectId &&
      context.actionId === request.actionId &&
      isProjectTaskDirectActionTarget(request, target)
    ? request
    : undefined
}

/**
 * Clears a denied, invalid, or failed dispatch without erasing a newer direct request.
 *
 * @param slot - Surface-local one-shot request slot.
 * @param request - Exact request installed by the direct entrance.
 * @returns Whether that request still owned and cleared the slot.
 */
export function clearProjectTaskDirectActionRequest(
  slot: ProjectTaskDirectActionRequestSlot,
  request: ProjectTaskDirectActionRequest,
): boolean {
  if (slot.current !== request) return false
  slot.current = undefined
  return true
}

/**
 * Claims one Work Item for a direct action until its preview or mutation reaches terminal state.
 *
 * @param inFlight - Surface-local target ownership map.
 * @param request - Exact request synchronously consumed by the canonical handler.
 * @returns Whether no older invocation already owned the same Team-local Work Item.
 */
export function claimProjectTaskDirectActionTarget(
  inFlight: ProjectTaskDirectActionInFlight,
  request: ProjectTaskDirectActionRequest,
): boolean {
  const key = createProjectTaskDirectActionTargetKey(request.target)
  if (inFlight.has(key)) return false
  inFlight.set(key, request)
  return true
}

/**
 * Releases only the exact invocation that currently owns a direct action target.
 *
 * @param inFlight - Surface-local target ownership map.
 * @param request - Exact terminal request attempting cleanup.
 * @returns Whether that request owned and released the target.
 */
export function releaseProjectTaskDirectActionTarget(
  inFlight: ProjectTaskDirectActionInFlight,
  request: ProjectTaskDirectActionRequest,
): boolean {
  const key = createProjectTaskDirectActionTargetKey(request.target)
  if (inFlight.get(key) !== request) return false
  inFlight.delete(key)
  return true
}

/**
 * Checks complete Team, Work Item, and revision identity for a direct Project request.
 *
 * @param request - Direct request awaiting canonical execution.
 * @param target - Target accepted by the shared action registry.
 * @returns Whether both snapshots identify the same revision-bound Work Item.
 */
export function isProjectTaskDirectActionTarget(
  request: ProjectTaskDirectActionRequest,
  target: WorkItemActionTarget,
): boolean {
  return request.target.teamId === target.teamId &&
    request.target.workItemId === target.workItemId &&
    request.target.expectedRevision !== undefined &&
    request.target.expectedRevision === target.expectedRevision
}

/**
 * Resolves the exact single target carried by a direct canonical action context.
 *
 * @param context - Canonical Project action context.
 * @returns Sole selected or focused target, or undefined for an ambiguous selection.
 */
export function resolveProjectTaskDirectActionTarget(
  context: WorkItemActionContext,
): WorkItemActionTarget | undefined {
  if (context.selection.targets.length === 1) return context.selection.targets[0]
  return context.selection.targets.length === 0
    ? context.selection.focusedTarget
    : undefined
}

/**
 * Starts server preview for an exact direct Schedule request.
 *
 * @param request - Schedule request consumed and target-claimed by the canonical handler.
 * @returns Whether the request was still installed instead of previously cancelled.
 */
export function beginProjectTaskDirectSchedulePreview(
  request: ProjectTaskDirectActionRequest,
): boolean {
  const state = directScheduleStates.get(request)
  if (!state || state.phase !== 'installed') return false
  state.phase = 'previewing'
  return true
}

/**
 * Publishes an authoritative preview and creates its exact confirm/cancel controller.
 *
 * @param request - Schedule request whose server preview completed.
 * @param preview - Authoritative direct and dependency impacts.
 * @returns Exact controller, or undefined when cancellation won the race.
 */
export function publishProjectTaskDirectSchedulePreview(
  request: ProjectTaskDirectActionRequest,
  preview: WorkItemScheduleChangePreview,
): ProjectTaskDirectScheduleController | undefined {
  const state = directScheduleStates.get(request)
  if (!state || state.phase !== 'previewing') return undefined
  const controller: ProjectTaskDirectScheduleController = {
    cancel: () => cancelAwaitingProjectTaskDirectSchedule(request),
    confirm: () => confirmProjectTaskDirectSchedule(request),
    preview: structuredClone(preview),
    token: request,
  }
  state.controller = controller
  state.phase = 'awaiting-confirmation'
  state.previewWaiter?.resolve(controller)
  return controller
}

/**
 * Waits until an accepted timeline Schedule request has an authoritative preview controller.
 *
 * @param request - Exact Gantt or Calendar request installed before registry execution.
 * @returns Controller bound to that invocation token.
 */
export function waitForProjectTaskDirectSchedulePreview(
  request: ProjectTaskDirectActionRequest,
): Promise<ProjectTaskDirectScheduleController> {
  const state = requireDirectScheduleState(request)
  if (state.controller) return Promise.resolve(state.controller)
  if (state.phase === 'failed') return Promise.reject(state.error)
  if (state.phase === 'cancelled') return Promise.reject(createScheduleCancelledError())
  state.previewWaiter ??= createDeferred<ProjectTaskDirectScheduleController>()
  return state.previewWaiter.promise
}

/**
 * Waits for the exact existing preview dialog to confirm or cancel a Schedule request.
 *
 * @param request - Schedule request whose controller was published.
 * @returns Exact user decision for the canonical handler.
 */
export function waitForProjectTaskDirectScheduleDecision(
  request: ProjectTaskDirectActionRequest,
): Promise<ProjectTaskDirectScheduleDecision> {
  const state = requireDirectScheduleState(request)
  if (state.phase === 'cancelled') return Promise.resolve('cancelled')
  if (state.phase === 'failed') return Promise.reject(state.error)
  if (state.phase === 'mutation-in-flight' || state.phase === 'completed') {
    return Promise.resolve('confirmed')
  }
  return state.decision.promise
}

/**
 * Completes a confirmed direct Schedule controller with its persisted Work Item.
 *
 * @param request - Exact request whose mutation is in flight.
 * @param task - Canonical Work Item returned by persistence.
 * @returns Whether the request was completed from the mutation-in-flight phase.
 */
export function completeProjectTaskDirectScheduleMutation(
  request: ProjectTaskDirectActionRequest,
  task: CanonicalWorkItem,
): boolean {
  const state = directScheduleStates.get(request)
  if (!state || state.phase !== 'mutation-in-flight') return false
  state.completedTask = task
  state.phase = 'completed'
  state.mutationWaiter?.resolve(task)
  return true
}

/**
 * Fails an accepted direct Schedule request and rejects only promises already owned by its UI.
 *
 * @param request - Exact request that failed permission, preview, validation, or persistence.
 * @param error - Original failure retained for the owning control.
 * @returns Whether this call established the terminal failure.
 */
export function failProjectTaskDirectSchedule(
  request: ProjectTaskDirectActionRequest,
  error: unknown,
): boolean {
  const state = directScheduleStates.get(request)
  if (!state || isTerminalDirectSchedulePhase(state.phase)) return false
  const failedDuringMutation = state.phase === 'mutation-in-flight'
  state.error = error
  state.phase = 'failed'
  if (!state.controller) state.previewWaiter?.reject(error)
  if (failedDuringMutation) state.mutationWaiter?.reject(error)
  state.decision.resolve('cancelled')
  return true
}

/**
 * Cancels a direct Schedule request only before irreversible mutation dispatch.
 *
 * @param request - Exact request owned by an existing preview or queued preview operation.
 * @returns Whether an installed, previewing, or awaiting-confirmation request was cancelled.
 */
export function cancelAwaitingProjectTaskDirectSchedule(
  request: ProjectTaskDirectActionRequest,
): boolean {
  const state = directScheduleStates.get(request)
  if (
    !state ||
    (state.phase !== 'installed' &&
      state.phase !== 'previewing' &&
      state.phase !== 'awaiting-confirmation')
  ) return false
  state.phase = 'cancelled'
  if (!state.controller) state.previewWaiter?.reject(createScheduleCancelledError())
  state.decision.resolve('cancelled')
  return true
}

/**
 * Reads the phase of an exact direct Schedule token for lifecycle guards and tests.
 *
 * @param request - Direct request created with a schedule payload.
 * @returns Current state-machine phase, or undefined for a non-schedule request.
 */
export function readProjectTaskDirectSchedulePhase(
  request: ProjectTaskDirectActionRequest,
): ProjectTaskDirectSchedulePhase | undefined {
  return directScheduleStates.get(request)?.phase
}

/**
 * Identifies expected cancellation raised while a timeline request awaited preview.
 *
 * @param error - Unknown direct Schedule failure.
 * @returns Whether the state machine cancelled before mutation dispatch.
 */
export function isProjectTaskDirectScheduleCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === projectTaskDirectScheduleCancelledErrorName
}

/** Confirms one exact controller and returns the persisted terminal Work Item. */
function confirmProjectTaskDirectSchedule(
  request: ProjectTaskDirectActionRequest,
): Promise<CanonicalWorkItem> {
  const state = requireDirectScheduleState(request)
  if (state.phase === 'completed' && state.completedTask) {
    return Promise.resolve(state.completedTask)
  }
  if (state.phase === 'failed') return Promise.reject(state.error)
  if (state.phase === 'cancelled') return Promise.reject(createScheduleCancelledError())
  if (state.phase === 'mutation-in-flight' && state.mutationWaiter) {
    return state.mutationWaiter.promise
  }
  if (state.phase !== 'awaiting-confirmation') {
    return Promise.reject(new Error('Direct Schedule preview is not awaiting confirmation.'))
  }
  state.mutationWaiter = createDeferred<CanonicalWorkItem>()
  state.phase = 'mutation-in-flight'
  state.decision.resolve('confirmed')
  return state.mutationWaiter.promise
}

/** Initializes weak state for one schedule-bearing request token. */
function initializeDirectScheduleState(request: ProjectTaskDirectActionRequest): void {
  directScheduleStates.set(request, {
    decision: createDeferred<ProjectTaskDirectScheduleDecision>(),
    phase: 'installed',
  })
}

/** Requires schedule state for a request supplied to a Schedule-only lifecycle operation. */
function requireDirectScheduleState(
  request: ProjectTaskDirectActionRequest,
): ProjectTaskDirectScheduleState {
  const state = directScheduleStates.get(request)
  if (!state) throw new TypeError('Direct Project request does not own a Schedule lifecycle.')
  return state
}

/** Returns whether a request carries one supported, isolated schedule operation. */
function isProjectTaskDirectScheduleRequest(
  request: ProjectTaskDirectActionRequest,
): boolean {
  return request.input.kind === 'schedule-operation' ||
    (request.input.kind === 'patch' &&
      resolveDefinedProjectTaskPatchFields(request.input.patch).length === 1 &&
      request.input.patch.schedule !== undefined)
}

/** Resolves explicitly defined patch fields without treating optional undefined values as mutations. */
function resolveDefinedProjectTaskPatchFields(patch: WorkItemPatch): string[] {
  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field)
}

/** Creates the Team-local lock key shared by every revision of one Work Item. */
function createProjectTaskDirectActionTargetKey(target: WorkItemActionTarget): string {
  return `${target.teamId}\u0000${target.workItemId}`
}

/** Returns whether a direct Schedule phase can no longer change terminal outcome. */
function isTerminalDirectSchedulePhase(phase: ProjectTaskDirectSchedulePhase): boolean {
  return phase === 'cancelled' || phase === 'completed' || phase === 'failed'
}

/** Creates an expected cancellation error distinguishable from permission or mutation failures. */
function createScheduleCancelledError(): Error {
  const error = new Error('Direct Schedule request was cancelled.')
  error.name = projectTaskDirectScheduleCancelledErrorName
  return error
}

/** Creates one externally awaited transition without exposing mutable resolver ownership. */
function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined
  let rejectPromise: (error: unknown) => void = () => undefined
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, reject: rejectPromise, resolve: resolvePromise }
}
