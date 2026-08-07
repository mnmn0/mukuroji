import {
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  type ScheduleDependencyConstraint,
  type WorkItemDependencyEndpoint,
  type WorkItemSchedule,
  type WorkItemScheduleChangePreview,
  type WorkItemScheduleDependency,
  type WorkItemScheduleDependencyConflict,
  type WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import {
  WorkItemScheduleError,
  addWorkItemScheduleCalendarDays,
  calculateWorkItemScheduleDateDeltaDays,
  calculateWorkItemScheduleDurationDays,
  calculateWorkItemScheduleEndDate,
  normalizeWorkItemSchedule,
  previewWorkItemScheduleChange,
} from './work-item-schedule'

/** Schedule state used to evaluate one visible Work Item dependency graph. */
export type WorkItemDependencyScheduleState = {
  /** Stable Team-owned Work Item identity. */
  endpoint: WorkItemDependencyEndpoint
  /** Canonical revision observed during the preview read. */
  revision: number
  /** Canonical schedule observed during the preview read. */
  schedule: WorkItemSchedule
  /** Assigned Project reached by this Work Item, when present. */
  projectId?: string
  /** Planning Milestones linked to this Work Item. */
  milestoneIds: readonly string[]
}

/** Inputs required to preview a transitive Work Item schedule dependency change. */
export type PreviewWorkItemDependencyScheduleChangeInput = {
  /** Work Item directly edited by the user. */
  root: WorkItemDependencyScheduleState
  /** Validated direct schedule operation. */
  operation: WorkItemScheduleOperation
  /** Visible schedule state for dependency endpoints. */
  workItems: readonly WorkItemDependencyScheduleState[]
  /** Canonical visible Work Item schedule dependencies. */
  dependencies: readonly WorkItemScheduleDependency[]
  /** Planning graph revision that owns the dependency snapshot. */
  planningRevision: number
  /** Semantic relation graph revision observed independently of schedule dependencies. */
  relationGraphRevision?: number
  /** Number of visible semantic `blocks` relations that do not move schedules. */
  semanticBlockerCount?: number
}

/** Aggregated lower bounds for one successor schedule. */
type ScheduleAnchorBounds = {
  /** Strongest predecessor-derived start bound before the direct edit. */
  beforeStart?: BoundDate
  /** Strongest predecessor-derived start bound after the direct edit. */
  afterStart?: BoundDate
  /** Strongest predecessor-derived finish bound before the direct edit. */
  beforeFinish?: BoundDate
  /** Strongest predecessor-derived finish bound after the direct edit. */
  afterFinish?: BoundDate
}

/** One date bound and the deterministic dependency that produced it. */
type BoundDate = {
  /** Required local ISO date. */
  date: string
  /** Canonical dependency identifier. */
  dependencyId: string
}

/** Resolved start or finish anchor used by dependency arithmetic. */
type DependencyAnchors = {
  /** Predecessor anchor that drives the dependency. */
  predecessor: 'start' | 'finish'
  /** Successor anchor constrained by the dependency. */
  successor: 'start' | 'finish'
  /** Extra inclusive calendar-day separation for the dependency type. */
  separationDays: number
}

/** Result of shifting a successor while preserving its explicit schedule mode. */
type ShiftResult = {
  /** Shifted schedule, or undefined when the anchor or supported date range is unavailable. */
  schedule?: WorkItemSchedule
  /** Whether the schedule changed. */
  changed: boolean
}

/** Maximum visible cascade size accepted by the pure preview boundary. */
export const WORK_ITEM_SCHEDULE_CASCADE_LIMIT = 24

/**
 * Lists every Work Item schedule whose revision participates in one cascade evaluation.
 *
 * The result contains every transitive successor reachable from the root plus every
 * visible predecessor that contributes an incoming bound to one of those successors.
 * Callers can condition-check these revisions when the preview is confirmed.
 *
 * @param root - Directly edited Work Item endpoint.
 * @param dependencies - Canonical visible dependency graph.
 * @returns Qualified endpoints in deterministic key order.
 */
export function collectWorkItemScheduleEvaluationEndpoints(
  root: WorkItemDependencyEndpoint,
  dependencies: readonly WorkItemScheduleDependency[],
): WorkItemDependencyEndpoint[] {
  const rootKey = createWorkItemDependencyKey(root)
  const normalizedDependencies = [...dependencies].sort(compareDependencies)
  const reachableKeys = collectReachableKeys(rootKey, normalizedDependencies)
  const byKey = new Map<string, WorkItemDependencyEndpoint>([[rootKey, root]])
  for (const dependency of normalizedDependencies) {
    const successorKey = createWorkItemDependencyKey(dependency.successor)
    if (!reachableKeys.has(successorKey)) continue
    byKey.set(successorKey, dependency.successor)
    byKey.set(createWorkItemDependencyKey(dependency.predecessor), dependency.predecessor)
  }
  return [...byKey].sort(([left], [right]) => left.localeCompare(right))
    .map(([, endpoint]) => endpoint)
}

/**
 * Recomputes a direct schedule operation and every visible transitive successor.
 *
 * FS uses an inclusive one-day separation (`finish + 1 + lag`); SS, FF, and SF
 * apply their signed lead/lag directly to the corresponding predecessor anchor.
 * Semantic `blocks` relations are intentionally represented only by a warning.
 *
 * @param input - Revision-bound graph and direct schedule operation.
 * @returns Deterministically ordered direct/dependency impacts and conflicts.
 */
export function previewWorkItemDependencyScheduleChange(
  input: PreviewWorkItemDependencyScheduleChangeInput,
): WorkItemScheduleChangePreview {
  validateGraphRevision(input.planningRevision, 'Planning revision')
  if (input.relationGraphRevision !== undefined) {
    validateGraphRevision(input.relationGraphRevision, 'Relation graph revision')
  }

  const states = createScheduleStateMap(input.root, input.workItems)
  const rootKey = createWorkItemDependencyKey(input.root.endpoint)
  const directPreview = previewWorkItemScheduleChange(
    input.root.endpoint.teamId,
    input.root.endpoint.workItemId,
    input.root.revision,
    input.root.schedule,
    input.operation,
  )
  const directImpact = directPreview.impacts[0]
  if (!directImpact) {
    throw new WorkItemScheduleError(
      503,
      'InvalidWorkItemScheduleDependencyGraph',
      'Direct schedule preview did not contain its root impact.',
    )
  }

  const dependencies = [...input.dependencies].sort(compareDependencies)
  const reachableKeys = collectReachableKeys(rootKey, dependencies)
  const evaluatedRevisions = collectWorkItemScheduleEvaluationEndpoints(
    input.root.endpoint,
    dependencies,
  ).flatMap((endpoint) => {
    const state = states.get(createWorkItemDependencyKey(endpoint))
    return state
      ? [{
          teamId: state.endpoint.teamId,
          workItemId: state.endpoint.workItemId,
          expectedRevision: state.revision,
        }]
      : []
  })
  assertAcyclicReachableGraph(reachableKeys, dependencies)
  if (reachableKeys.size > WORK_ITEM_SCHEDULE_CASCADE_LIMIT) {
    throw new WorkItemScheduleError(
      413,
      'WorkItemScheduleCascadeLimitExceeded',
      `A schedule cascade cannot exceed ${WORK_ITEM_SCHEDULE_CASCADE_LIMIT} Work Items.`,
    )
  }

  const proposedSchedules = new Map<string, WorkItemSchedule>([
    [rootKey, directImpact.after],
  ])
  const impacts = [directImpact]
  const rootIncoming = dependencies.filter((dependency) =>
    createWorkItemDependencyKey(dependency.successor) === rootKey
  )
  const conflicts: WorkItemScheduleDependencyConflict[] = [
    ...findDependencyViolations(
      directImpact.after,
      rootIncoming,
      states,
      proposedSchedules,
    ),
    ...findExplicitConstraintViolations(directImpact.after, rootIncoming),
  ]
  const order = topologicallySortReachableGraph(reachableKeys, dependencies)
  for (const successorKey of order) {
    if (successorKey === rootKey) continue
    const successorState = states.get(successorKey)
    const incoming = dependencies.filter((dependency) =>
      createWorkItemDependencyKey(dependency.successor) === successorKey,
    )
    if (!successorState) {
      for (const dependency of incoming) {
        conflicts.push(createMissingScheduleConflict(dependency))
      }
      continue
    }

    const resolved = resolveSuccessorSchedule(
      successorState,
      incoming,
      states,
      proposedSchedules,
    )
    conflicts.push(...resolved.conflicts)
    proposedSchedules.set(successorKey, resolved.schedule)
    if (!schedulesEqual(successorState.schedule, resolved.schedule)) {
      impacts.push({
        teamId: successorState.endpoint.teamId,
        workItemId: successorState.endpoint.workItemId,
        kind: 'dependency',
        expectedRevision: successorState.revision,
        before: normalizeWorkItemSchedule(successorState.schedule),
        after: resolved.schedule,
        dateDeltaDays: calculateWorkItemScheduleDateDeltaDays(
          successorState.schedule,
          resolved.schedule,
        ),
        ...(resolved.dependencyId ? { dependencyId: resolved.dependencyId } : {}),
      })
    }
  }

  const impactedKeys = new Set(impacts.map((impact) =>
    createWorkItemDependencyKey({ teamId: impact.teamId, workItemId: impact.workItemId })
  ))
  const affectedProjectIds = uniqueSorted([...impactedKeys].flatMap((key) => {
    const projectId = states.get(key)?.projectId
    return projectId ? [projectId] : []
  }))
  const affectedMilestoneIds = uniqueSorted([...impactedKeys].flatMap((key) =>
    states.get(key)?.milestoneIds ?? []
  ))
  const normalizedConflicts = uniqueConflicts(conflicts)
  const warnings = [
    ...(impacts.length > 1 ? ['DependencyRippleRequiresReview'] : []),
    ...((input.semanticBlockerCount ?? 0) > 0
      ? ['SemanticBlockRelationsDoNotReschedule']
      : []),
  ]

  return {
    expectedRevision: input.root.revision,
    impacts,
    evaluatedRevisions,
    planningRevision: input.planningRevision,
    ...(input.relationGraphRevision === undefined
      ? {}
      : { relationGraphRevision: input.relationGraphRevision }),
    conflicts: normalizedConflicts,
    affectedProjectIds,
    affectedMilestoneIds,
    requiresConfirmation: impacts.length > 1,
    warnings,
  }
}

/**
 * Resolves the proposed schedule and conflicts for one reachable successor.
 *
 * @param successor - Current successor schedule state.
 * @param incoming - Reachable incoming dependencies in deterministic order.
 * @param states - Original visible graph state keyed by endpoint.
 * @param proposedSchedules - Already resolved predecessor schedules.
 * @returns Shifted successor schedule, causing edge, and stable conflicts.
 */
function resolveSuccessorSchedule(
  successor: WorkItemDependencyScheduleState,
  incoming: readonly WorkItemScheduleDependency[],
  states: ReadonlyMap<string, WorkItemDependencyScheduleState>,
  proposedSchedules: ReadonlyMap<string, WorkItemSchedule>,
): {
  /** Resolved canonical successor schedule. */
  schedule: WorkItemSchedule
  /** Deterministic dependency that caused the movement. */
  dependencyId?: string
  /** Conflicts that prevent safe automatic application. */
  conflicts: WorkItemScheduleDependencyConflict[]
} {
  const current = normalizeWorkItemSchedule(successor.schedule)
  const bounds: ScheduleAnchorBounds = {}
  const conflicts: WorkItemScheduleDependencyConflict[] = []
  for (const dependency of incoming) {
    const predecessorKey = createWorkItemDependencyKey(dependency.predecessor)
    const predecessor = states.get(predecessorKey)
    const proposedPredecessor = proposedSchedules.get(predecessorKey) ?? predecessor?.schedule
    if (!predecessor || !proposedPredecessor) {
      conflicts.push(createMissingScheduleConflict(dependency))
      continue
    }
    const anchors = resolveDependencyAnchors(dependency)
    const beforeDriver = readScheduleAnchor(predecessor.schedule, anchors.predecessor)
    const afterDriver = readScheduleAnchor(proposedPredecessor, anchors.predecessor)
    const successorAnchor = readScheduleAnchor(current, anchors.successor)
    if (!afterDriver || !successorAnchor) {
      conflicts.push(createMissingScheduleConflict(dependency))
      continue
    }
    const offset = anchors.separationDays + dependency.lagDays
    const beforeBoundDate = beforeDriver
      ? tryAddDependencyCalendarDays(beforeDriver, offset)
      : undefined
    const afterBoundDate = tryAddDependencyCalendarDays(afterDriver, offset)
    if (anchors.successor === 'start') {
      if (beforeBoundDate) {
        bounds.beforeStart = strongestBound(bounds.beforeStart, {
          date: beforeBoundDate,
          dependencyId: dependency.id,
        })
      }
      if (afterBoundDate) {
        bounds.afterStart = strongestBound(bounds.afterStart, {
          date: afterBoundDate,
          dependencyId: dependency.id,
        })
      }
    } else {
      if (beforeBoundDate) {
        bounds.beforeFinish = strongestBound(bounds.beforeFinish, {
          date: beforeBoundDate,
          dependencyId: dependency.id,
        })
      }
      if (afterBoundDate) {
        bounds.afterFinish = strongestBound(bounds.afterFinish, {
          date: afterBoundDate,
          dependencyId: dependency.id,
        })
      }
    }
  }

  let schedule = current
  let dependencyId: string | undefined
  const startMovement = resolveBoundMovement(
    readScheduleAnchor(current, 'start'),
    bounds.beforeStart,
    bounds.afterStart,
  )
  if (startMovement) {
    const shifted = shiftScheduleToAnchor(schedule, 'start', startMovement.date)
    if (shifted.schedule) {
      schedule = shifted.schedule
      if (shifted.changed) dependencyId = startMovement.dependencyId
    }
  }
  const finishMovement = resolveBoundMovement(
    readScheduleAnchor(schedule, 'finish'),
    bounds.beforeFinish,
    bounds.afterFinish,
  )
  if (finishMovement) {
    const actualFinish = readScheduleAnchor(schedule, 'finish')
    const shouldShift = actualFinish !== undefined && (
      compareIsoDates(actualFinish, finishMovement.date) < 0 ||
      actualFinish === bounds.beforeFinish?.date
    )
    if (shouldShift) {
      const shifted = shiftScheduleToAnchor(schedule, 'finish', finishMovement.date)
      if (shifted.schedule) {
        schedule = shifted.schedule
        if (shifted.changed) dependencyId = finishMovement.dependencyId
      }
    }
  }
  const finalStart = readScheduleAnchor(schedule, 'start')
  if (
    finalStart !== undefined &&
    bounds.afterStart !== undefined &&
    compareIsoDates(finalStart, bounds.afterStart.date) < 0
  ) {
    const shifted = shiftScheduleToAnchor(schedule, 'start', bounds.afterStart.date)
    if (shifted.schedule) {
      schedule = shifted.schedule
      if (shifted.changed) dependencyId = bounds.afterStart.dependencyId
    }
  }

  const constrained = applyExplicitConstraints(schedule, incoming)
  schedule = constrained.schedule
  if (constrained.dependencyId) dependencyId = constrained.dependencyId
  conflicts.push(...constrained.conflicts)
  conflicts.push(...findDependencyViolations(schedule, incoming, states, proposedSchedules))
  conflicts.push(...findExplicitConstraintViolations(schedule, incoming))
  return { schedule, ...(dependencyId ? { dependencyId } : {}), conflicts }
}

/**
 * Applies explicit successor constraints after dependency lower-bound propagation.
 *
 * @param initial - Candidate schedule after dependency propagation.
 * @param dependencies - Incoming dependencies containing optional constraints.
 * @returns Constraint-adjusted schedule and stable conflicts.
 */
function applyExplicitConstraints(
  initial: WorkItemSchedule,
  dependencies: readonly WorkItemScheduleDependency[],
): {
  /** Constraint-adjusted canonical schedule. */
  schedule: WorkItemSchedule
  /** Dependency whose constraint moved the schedule. */
  dependencyId?: string
  /** Explicit constraint conflicts. */
  conflicts: WorkItemScheduleDependencyConflict[]
} {
  let schedule = initial
  let dependencyId: string | undefined
  const conflicts: WorkItemScheduleDependencyConflict[] = []
  for (const dependency of dependencies) {
    const constraint = dependency.constraint
    if (!constraint) continue
    const actual = readScheduleAnchor(schedule, constraint.anchor)
    if (!actual) {
      conflicts.push(createMissingScheduleConflict(dependency))
      continue
    }
    if (constraint.kind === 'not-before' && compareIsoDates(actual, constraint.date) < 0) {
      const shifted = shiftScheduleToAnchor(schedule, constraint.anchor, constraint.date)
      if (shifted.schedule) {
        schedule = shifted.schedule
        if (shifted.changed) dependencyId = dependency.id
      }
      continue
    }
    if (constraint.kind === 'on' && actual !== constraint.date) {
      if (compareIsoDates(actual, constraint.date) < 0) {
        const shifted = shiftScheduleToAnchor(schedule, constraint.anchor, constraint.date)
        if (shifted.schedule) {
          schedule = shifted.schedule
          if (shifted.changed) dependencyId = dependency.id
        }
      } else {
        conflicts.push(createConstraintConflict(dependency, constraint, actual))
      }
      continue
    }
    if (constraint.kind === 'not-after' && compareIsoDates(actual, constraint.date) > 0) {
      conflicts.push(createConstraintConflict(dependency, constraint, actual))
    }
  }
  return { schedule, ...(dependencyId ? { dependencyId } : {}), conflicts }
}

/**
 * Reports dependency lower bounds that remain unsatisfied after propagation.
 *
 * @param successor - Candidate successor schedule.
 * @param dependencies - Incoming dependencies to verify.
 * @param states - Original Work Item state map.
 * @param proposedSchedules - Resolved predecessor schedules.
 * @returns Stable dependency conflicts.
 */
function findDependencyViolations(
  successor: WorkItemSchedule,
  dependencies: readonly WorkItemScheduleDependency[],
  states: ReadonlyMap<string, WorkItemDependencyScheduleState>,
  proposedSchedules: ReadonlyMap<string, WorkItemSchedule>,
): WorkItemScheduleDependencyConflict[] {
  return dependencies.flatMap((dependency) => {
    const predecessorKey = createWorkItemDependencyKey(dependency.predecessor)
    const predecessor = proposedSchedules.get(predecessorKey) ?? states.get(predecessorKey)?.schedule
    const anchors = resolveDependencyAnchors(dependency)
    const driver = predecessor
      ? readScheduleAnchor(predecessor, anchors.predecessor)
      : undefined
    const actual = readScheduleAnchor(successor, anchors.successor)
    if (!driver || !actual) return [createMissingScheduleConflict(dependency)]
    const requiredDate = tryAddDependencyCalendarDays(
      driver,
      anchors.separationDays + dependency.lagDays,
    )
    return requiredDate === undefined || compareIsoDates(actual, requiredDate) < 0
      ? [{
          code: 'dependency-violation',
          dependencyId: dependency.id,
          workItem: dependency.successor,
          ...(requiredDate === undefined ? {} : { requiredDate }),
          actualDate: actual,
        } satisfies WorkItemScheduleDependencyConflict]
      : []
  })
}

/**
 * Reports explicit constraints violated by a schedule that must not be shifted.
 *
 * This is used for the directly edited root: the user's explicit operation remains
 * authoritative and incompatible incoming constraints are returned as conflicts.
 *
 * @param schedule - Directly proposed canonical schedule.
 * @param dependencies - Incoming dependencies whose constraints must be checked.
 * @returns Stable explicit-constraint conflicts.
 */
function findExplicitConstraintViolations(
  schedule: WorkItemSchedule,
  dependencies: readonly WorkItemScheduleDependency[],
): WorkItemScheduleDependencyConflict[] {
  return dependencies.flatMap((dependency) => {
    const constraint = dependency.constraint
    if (!constraint) return []
    const actual = readScheduleAnchor(schedule, constraint.anchor)
    if (!actual) return [createMissingScheduleConflict(dependency)]
    const comparison = compareIsoDates(actual, constraint.date)
    const violated = constraint.kind === 'on'
      ? comparison !== 0
      : constraint.kind === 'not-before'
        ? comparison < 0
        : comparison > 0
    return violated
      ? [createConstraintConflict(dependency, constraint, actual)]
      : []
  })
}

/**
 * Resolves whether a lower-bound change should move the current successor anchor.
 *
 * @param currentDate - Current successor anchor.
 * @param before - Strongest bound before the predecessor edit.
 * @param after - Strongest bound after the predecessor edit.
 * @returns The bound to apply, or undefined when existing slack should be retained.
 */
function resolveBoundMovement(
  currentDate: string | undefined,
  before: BoundDate | undefined,
  after: BoundDate | undefined,
): BoundDate | undefined {
  if (!currentDate || !after) return undefined
  if (compareIsoDates(currentDate, after.date) < 0) return after
  if (before && currentDate === before.date && before.date !== after.date) return after
  return undefined
}

/**
 * Shifts one explicit schedule anchor while preserving mode and duration.
 *
 * @param value - Schedule to shift.
 * @param anchor - Start or finish anchor to replace.
 * @param targetDate - New local ISO anchor date.
 * @returns Canonical shifted schedule, or no schedule when the anchor or date range is unavailable.
 */
function shiftScheduleToAnchor(
  value: WorkItemSchedule,
  anchor: 'start' | 'finish',
  targetDate: string,
): ShiftResult {
  const schedule = normalizeWorkItemSchedule(value)
  if (schedule.mode === 'unscheduled') return { changed: false }
  if (schedule.mode === 'due-date') {
    if (anchor === 'start') return { changed: false }
    const next = { ...schedule, dueDate: targetDate }
    return { schedule: next, changed: !schedulesEqual(schedule, next) }
  }
  if (schedule.mode === 'milestone') {
    const next = { ...schedule, startDate: targetDate, endDate: targetDate }
    return { schedule: next, changed: !schedulesEqual(schedule, next) }
  }
  try {
    if (anchor === 'start') {
      const next = {
        ...schedule,
        startDate: targetDate,
        endDate: calculateWorkItemScheduleEndDate(
          targetDate,
          schedule.durationDays,
          schedule.calendarPolicy,
        ),
      }
      return { schedule: next, changed: !schedulesEqual(schedule, next) }
    }
    const startDate = calculateScheduleStartDate(
      targetDate,
      schedule.durationDays,
      schedule.calendarPolicy,
    )
    const next = { ...schedule, startDate, endDate: targetDate }
    return { schedule: next, changed: !schedulesEqual(schedule, next) }
  } catch (error) {
    if (isUnsupportedDependencyDateArithmetic(error)) return { changed: false }
    throw error
  }
}

/**
 * Adds a dependency lead or lag without leaking supported-range overflow as a request error.
 *
 * @param date - Valid canonical driver date.
 * @param days - Signed dependency offset in calendar days.
 * @returns Shifted date, or undefined when it lies outside the supported schedule range.
 */
function tryAddDependencyCalendarDays(date: string, days: number): string | undefined {
  try {
    return addWorkItemScheduleCalendarDays(date, days)
  } catch (error) {
    if (isUnsupportedDependencyDateArithmetic(error)) return undefined
    throw error
  }
}

/**
 * Identifies otherwise-valid dependency arithmetic that leaves the supported ISO date range.
 *
 * @param error - Error raised while calculating a dependency bound or preserved range.
 * @returns Whether the error represents an unsupported boundary date.
 */
function isUnsupportedDependencyDateArithmetic(error: unknown): boolean {
  return error instanceof WorkItemScheduleError && error.code === 'InvalidWorkItemScheduleDate'
}

/**
 * Finds the first working date needed for an inclusive finish-anchored range.
 *
 * @param endDate - Inclusive target finish date.
 * @param durationDays - Positive working-day duration to preserve.
 * @param calendarPolicy - Canonical schedule calendar policy.
 * @returns Earliest counted working date for the requested finish.
 */
function calculateScheduleStartDate(
  endDate: string,
  durationDays: number,
  calendarPolicy: WorkItemSchedule['calendarPolicy'],
): string {
  let remaining = durationDays
  for (let offset = 0; offset < WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS; offset += 1) {
    const candidate = addWorkItemScheduleCalendarDays(endDate, -offset)
    if (calculateWorkItemScheduleDurationDays(candidate, candidate, calendarPolicy) === 1) {
      remaining -= 1
      if (remaining === 0) return candidate
    }
  }
  throw new WorkItemScheduleError(
    400,
    'InvalidWorkItemScheduleDuration',
    'Finish-anchored schedule exceeds the supported planning horizon.',
  )
}

/**
 * Resolves start/finish anchors and inclusive separation for one dependency type.
 *
 * @param dependency - Canonical Work Item schedule dependency.
 * @returns Driver anchor, constrained anchor, and base separation.
 */
function resolveDependencyAnchors(
  dependency: WorkItemScheduleDependency,
): DependencyAnchors {
  if (dependency.type === 'finish-to-start') {
    return { predecessor: 'finish', successor: 'start', separationDays: 1 }
  }
  if (dependency.type === 'start-to-start') {
    return { predecessor: 'start', successor: 'start', separationDays: 0 }
  }
  if (dependency.type === 'finish-to-finish') {
    return { predecessor: 'finish', successor: 'finish', separationDays: 0 }
  }
  return { predecessor: 'start', successor: 'finish', separationDays: 0 }
}

/**
 * Reads one available schedule anchor without inferring absent fields.
 *
 * @param schedule - Explicit canonical schedule mode.
 * @param anchor - Requested schedule boundary.
 * @returns Local ISO date, or undefined when the mode does not own that anchor.
 */
function readScheduleAnchor(
  schedule: WorkItemSchedule,
  anchor: 'start' | 'finish',
): string | undefined {
  const normalized = normalizeWorkItemSchedule(schedule)
  if (normalized.mode === 'unscheduled') return undefined
  if (normalized.mode === 'due-date') {
    return anchor === 'finish' ? normalized.dueDate : undefined
  }
  return anchor === 'start' ? normalized.startDate : normalized.endDate
}

/**
 * Selects the lexically deterministic strongest date lower bound.
 *
 * @param current - Previously selected bound.
 * @param candidate - New dependency bound.
 * @returns Later date, breaking date ties by dependency ID.
 */
function strongestBound(
  current: BoundDate | undefined,
  candidate: BoundDate,
): BoundDate {
  if (!current) return candidate
  const comparison = compareIsoDates(candidate.date, current.date)
  if (comparison > 0) return candidate
  if (comparison < 0) return current
  return candidate.dependencyId < current.dependencyId ? candidate : current
}

/**
 * Creates an endpoint-keyed state map and rejects ambiguous duplicate inputs.
 *
 * @param root - Directly edited Work Item state.
 * @param values - Visible dependency endpoint states.
 * @returns Detached state map containing the exact root state.
 */
function createScheduleStateMap(
  root: WorkItemDependencyScheduleState,
  values: readonly WorkItemDependencyScheduleState[],
): Map<string, WorkItemDependencyScheduleState> {
  const result = new Map<string, WorkItemDependencyScheduleState>()
  for (const value of [...values, root]) {
    validateWorkItemScheduleState(value)
    const key = createWorkItemDependencyKey(value.endpoint)
    if (result.has(key) && key !== createWorkItemDependencyKey(root.endpoint)) {
      throw new WorkItemScheduleError(
        400,
        'InvalidWorkItemScheduleDependencyGraph',
        `Dependency state contains duplicate Work Item "${key}".`,
      )
    }
    result.set(key, value)
  }
  return result
}

/**
 * Validates one dependency schedule state at the pure domain boundary.
 *
 * @param value - Candidate schedule state.
 */
function validateWorkItemScheduleState(value: WorkItemDependencyScheduleState): void {
  createWorkItemDependencyKey(value.endpoint)
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleDependencyGraph',
      'Dependency endpoint revision must be a positive safe integer.',
    )
  }
  normalizeWorkItemSchedule(value.schedule)
}

/**
 * Collects every successor reachable from the directly edited Work Item.
 *
 * @param rootKey - Canonical root endpoint key.
 * @param dependencies - Canonical dependency graph.
 * @returns Reachable endpoint keys including the root.
 */
function collectReachableKeys(
  rootKey: string,
  dependencies: readonly WorkItemScheduleDependency[],
): Set<string> {
  const outgoing = new Map<string, WorkItemScheduleDependency[]>()
  for (const dependency of dependencies) {
    const predecessorKey = createWorkItemDependencyKey(dependency.predecessor)
    const entries = outgoing.get(predecessorKey) ?? []
    entries.push(dependency)
    outgoing.set(predecessorKey, entries)
  }
  const reachable = new Set([rootKey])
  const pending = [rootKey]
  while (pending.length > 0) {
    const predecessorKey = pending.shift()
    if (!predecessorKey) continue
    for (const dependency of outgoing.get(predecessorKey) ?? []) {
      const successorKey = createWorkItemDependencyKey(dependency.successor)
      if (reachable.has(successorKey)) continue
      reachable.add(successorKey)
      pending.push(successorKey)
    }
  }
  return reachable
}

/**
 * Rejects a cycle in the reachable stored dependency graph.
 *
 * @param reachable - Endpoint keys reachable from the edited root.
 * @param dependencies - Canonical dependencies.
 */
function assertAcyclicReachableGraph(
  reachable: ReadonlySet<string>,
  dependencies: readonly WorkItemScheduleDependency[],
): void {
  topologicallySortReachableGraph(reachable, dependencies)
}

/**
 * Topologically orders the reachable graph with lexical endpoint tie-breaking.
 *
 * @param reachable - Endpoint keys reachable from the edited root.
 * @param dependencies - Canonical dependencies.
 * @returns Stable predecessor-before-successor endpoint order.
 */
function topologicallySortReachableGraph(
  reachable: ReadonlySet<string>,
  dependencies: readonly WorkItemScheduleDependency[],
): string[] {
  const incomingCount = new Map([...reachable].map((key) => [key, 0]))
  const outgoing = new Map<string, string[]>()
  for (const dependency of dependencies) {
    const predecessorKey = createWorkItemDependencyKey(dependency.predecessor)
    const successorKey = createWorkItemDependencyKey(dependency.successor)
    if (!reachable.has(predecessorKey) || !reachable.has(successorKey)) continue
    incomingCount.set(successorKey, (incomingCount.get(successorKey) ?? 0) + 1)
    const entries = outgoing.get(predecessorKey) ?? []
    entries.push(successorKey)
    outgoing.set(predecessorKey, entries)
  }
  const pending = [...incomingCount]
    .filter(([, count]) => count === 0)
    .map(([key]) => key)
    .sort()
  const result: string[] = []
  while (pending.length > 0) {
    const key = pending.shift()
    if (!key) continue
    result.push(key)
    for (const successorKey of uniqueSorted(outgoing.get(key) ?? [])) {
      const count = (incomingCount.get(successorKey) ?? 0) - 1
      incomingCount.set(successorKey, count)
      if (count === 0) {
        pending.push(successorKey)
        pending.sort()
      }
    }
  }
  if (result.length !== reachable.size) {
    throw new WorkItemScheduleError(
      409,
      'WorkItemScheduleDependencyCycle',
      'Stored Work Item schedule dependencies contain a cycle.',
    )
  }
  return result
}

/**
 * Returns a stable key for a qualified Work Item endpoint.
 *
 * @param endpoint - Team-owned Work Item identity.
 * @returns Collision-resistant in-memory key.
 */
export function createWorkItemDependencyKey(endpoint: WorkItemDependencyEndpoint): string {
  if (
    typeof endpoint.teamId !== 'string' ||
    endpoint.teamId.length === 0 ||
    endpoint.teamId.trim() !== endpoint.teamId ||
    typeof endpoint.workItemId !== 'string' ||
    endpoint.workItemId.length === 0 ||
    endpoint.workItemId.trim() !== endpoint.workItemId
  ) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleDependencyGraph',
      'Dependency endpoints require non-empty canonical Team and Work Item IDs.',
    )
  }
  return `${endpoint.teamId}\0${endpoint.workItemId}`
}

/**
 * Creates a missing-anchor or missing-endpoint conflict.
 *
 * @param dependency - Dependency that cannot be evaluated.
 * @returns Stable missing-schedule conflict.
 */
function createMissingScheduleConflict(
  dependency: WorkItemScheduleDependency,
): WorkItemScheduleDependencyConflict {
  return {
    code: 'missing-schedule',
    dependencyId: dependency.id,
    workItem: dependency.successor,
  }
}

/**
 * Creates an explicit constraint violation.
 *
 * @param dependency - Dependency that owns the constraint.
 * @param constraint - Violated explicit constraint.
 * @param actualDate - Candidate successor anchor date.
 * @returns Stable constraint conflict.
 */
function createConstraintConflict(
  dependency: WorkItemScheduleDependency,
  constraint: ScheduleDependencyConstraint,
  actualDate: string,
): WorkItemScheduleDependencyConflict {
  return {
    code: 'constraint-violation',
    dependencyId: dependency.id,
    workItem: dependency.successor,
    requiredDate: constraint.date,
    actualDate,
  }
}

/**
 * Compares two canonical local dates lexically.
 *
 * @param left - First `YYYY-MM-DD` date.
 * @param right - Second `YYYY-MM-DD` date.
 * @returns Negative, zero, or positive lexical ordering.
 */
function compareIsoDates(left: string, right: string): number {
  return left.localeCompare(right)
}

/**
 * Orders dependencies by ID and qualified endpoints.
 *
 * @param left - First dependency.
 * @param right - Second dependency.
 * @returns Stable lexical ordering.
 */
function compareDependencies(
  left: WorkItemScheduleDependency,
  right: WorkItemScheduleDependency,
): number {
  return left.id.localeCompare(right.id) ||
    createWorkItemDependencyKey(left.predecessor)
      .localeCompare(createWorkItemDependencyKey(right.predecessor)) ||
    createWorkItemDependencyKey(left.successor)
      .localeCompare(createWorkItemDependencyKey(right.successor))
}

/**
 * Compares canonical schedules structurally after normalization.
 *
 * @param left - First schedule.
 * @param right - Second schedule.
 * @returns True when both canonical representations are identical.
 */
function schedulesEqual(left: WorkItemSchedule, right: WorkItemSchedule): boolean {
  return JSON.stringify(normalizeWorkItemSchedule(left)) ===
    JSON.stringify(normalizeWorkItemSchedule(right))
}

/**
 * Sorts and de-duplicates string identifiers.
 *
 * @param values - Candidate identifiers.
 * @returns Unique lexical identifiers.
 */
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * Sorts and de-duplicates stable dependency conflicts.
 *
 * @param conflicts - Candidate conflict collection.
 * @returns Deterministic conflict list.
 */
function uniqueConflicts(
  conflicts: readonly WorkItemScheduleDependencyConflict[],
): WorkItemScheduleDependencyConflict[] {
  const byKey = new Map<string, WorkItemScheduleDependencyConflict>()
  for (const conflict of conflicts) {
    const key = [
      conflict.dependencyId,
      conflict.code,
      createWorkItemDependencyKey(conflict.workItem),
      conflict.requiredDate ?? '',
      conflict.actualDate ?? '',
    ].join('\0')
    byKey.set(key, conflict)
  }
  return [...byKey].sort(([left], [right]) => left.localeCompare(right))
    .map(([, conflict]) => conflict)
}

/**
 * Validates a non-negative graph revision.
 *
 * @param value - Candidate revision.
 * @param label - Human-readable revision kind.
 */
function validateGraphRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleDependencyGraph',
      `${label} must be a non-negative safe integer.`,
    )
  }
}
