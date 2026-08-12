import type {
  CreateWorkItemScheduleDependencyInput,
  PlanningSnapshot,
  PlanningWorkItemSummary,
  ScheduleDependencyConstraint,
  ScheduleDependencyType,
  WorkItemDependencyEndpoint,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyConflict,
  WorkItemScheduleDependencyPatch,
} from '@mukuroji/contracts'

const MILLISECONDS_PER_DAY = 86_400_000

/** Editable canonical dependency fields emitted by schedule-dependency create forms. */
export type WorkItemDependencyCreateDraft = Omit<
  CreateWorkItemScheduleDependencyInput,
  'expectedRevision' | 'id'
>

/**
 * Derives a stable dependency resource ID from one retained mutation request.
 *
 * @param idempotencyKey - Idempotency key shared by the original request and its retries.
 * @returns Workspace-local dependency ID reused by every retry of the logical create.
 */
export function createWorkItemDependencyMutationId(idempotencyKey: string): string {
  return `work-item-dependency-${idempotencyKey}`
}

/** Compact dependency state displayed beside one Work Item. */
export type WorkItemDependencySummary = {
  /** Canonical Team/Work Item identity. */
  endpoint: WorkItemDependencyEndpoint
  /** Number of unresolved predecessors constraining this item. */
  blockedByCount: number
  /** Number of visible successors constrained by this item. */
  blocksCount: number
  /** Number of current graph conflicts involving this item. */
  conflictCount: number
  /** Largest positive calendar-day shift required by a visible conflict. */
  requiredShiftDays: number
  /** Whether this item belongs to the current Work Item critical path. */
  critical: boolean
}

/** Display-ready canonical dependency and its endpoint projections. */
export type WorkItemDependencyRow = {
  /** Canonical dependency edge. */
  dependency: WorkItemScheduleDependency
  /** Visible predecessor projection, when authorized and present in the snapshot. */
  predecessor?: PlanningWorkItemSummary
  /** Visible successor projection, when authorized and present in the snapshot. */
  successor?: PlanningWorkItemSummary
  /** Conflicts reported for this edge. */
  conflicts: WorkItemScheduleDependencyConflict[]
  /** Whether this edge joins one consecutive pair on the critical path. */
  critical: boolean
}

/** Complete editable scheduling rule collected by dependency forms. */
export type WorkItemDependencyRuleDraft = {
  /** Optional explicit successor date constraint. */
  constraint?: ScheduleDependencyConstraint
  /** Signed calendar-day lead or lag. */
  lagDays: number
  /** Start/finish boundary relationship. */
  type: ScheduleDependencyType
}

/**
 * Builds a replacement dependency patch and explicitly clears an omitted constraint.
 *
 * @param rule - Complete rule selected by an update form.
 * @returns Patch that replaces type/lag and sets a constraint or null.
 */
export function createWorkItemScheduleDependencyPatch(
  rule: WorkItemDependencyRuleDraft,
): WorkItemScheduleDependencyPatch {
  return {
    constraint: rule.constraint ?? null,
    lagDays: rule.lagDays,
    type: rule.type,
  }
}

/**
 * Creates a collision-safe key for a Team-owned Work Item dependency endpoint.
 *
 * @param endpoint - Team-qualified Work Item identity.
 * @returns A key safe for in-memory maps and records.
 */
export function createWorkItemDependencyEndpointKey(endpoint: WorkItemDependencyEndpoint): string {
  return `${endpoint.teamId}\0${endpoint.workItemId}`
}

/**
 * Creates per-item blocker summaries from one authoritative planning snapshot.
 *
 * @param snapshot - Planning snapshot shared by task and management surfaces.
 * @returns Summaries keyed by canonical Team/Work Item identity.
 */
export function createWorkItemDependencySummaries(
  snapshot: PlanningSnapshot | undefined,
): Readonly<Record<string, WorkItemDependencySummary>> {
  if (!snapshot) return {}

  const itemsByKey = new Map(snapshot.workItems.map((item) => [
    createWorkItemDependencyEndpointKey({ teamId: item.teamId, workItemId: item.id }),
    item,
  ]))
  const criticalKeys = new Set(
    snapshot.workItemDependencySummary.criticalPath.workItems.map(
      createWorkItemDependencyEndpointKey,
    ),
  )
  const summaries = new Map<string, WorkItemDependencySummary>()

  /** Returns an existing summary or creates its empty display state. */
  const readSummary = (endpoint: WorkItemDependencyEndpoint): WorkItemDependencySummary => {
    const key = createWorkItemDependencyEndpointKey(endpoint)
    const existing = summaries.get(key)
    if (existing) return existing
    const created: WorkItemDependencySummary = {
      blockedByCount: 0,
      blocksCount: 0,
      conflictCount: 0,
      critical: criticalKeys.has(key),
      endpoint,
      requiredShiftDays: 0,
    }
    summaries.set(key, created)
    return created
  }

  for (const item of snapshot.workItems) {
    readSummary({ teamId: item.teamId, workItemId: item.id })
  }

  for (const dependency of snapshot.workItemDependencies) {
    const predecessor = itemsByKey.get(createWorkItemDependencyEndpointKey(dependency.predecessor))
    const successorSummary = readSummary(dependency.successor)
    const predecessorSummary = readSummary(dependency.predecessor)
    predecessorSummary.blocksCount += 1
    if (!predecessor || !['completed', 'canceled'].includes(predecessor.statusCategory)) {
      successorSummary.blockedByCount += 1
    }
  }

  for (const conflict of snapshot.workItemDependencySummary.conflicts) {
    const summary = readSummary(conflict.workItem)
    summary.conflictCount += 1
    summary.requiredShiftDays = Math.max(
      summary.requiredShiftDays,
      resolveRequiredShiftDays(conflict),
    )
  }

  return Object.fromEntries(summaries)
}

/**
 * Creates display rows from exactly the dependency graph contained in a snapshot.
 *
 * @param snapshot - Authoritative planning snapshot.
 * @returns Dependency rows in snapshot order.
 */
export function createWorkItemDependencyRows(
  snapshot: PlanningSnapshot | undefined,
): WorkItemDependencyRow[] {
  if (!snapshot) return []
  const itemsByKey = new Map(snapshot.workItems.map((item) => [
    createWorkItemDependencyEndpointKey({ teamId: item.teamId, workItemId: item.id }),
    item,
  ]))
  const criticalPath = snapshot.workItemDependencySummary.criticalPath.workItems

  return snapshot.workItemDependencies.map((dependency) => ({
    conflicts: snapshot.workItemDependencySummary.conflicts.filter(
      (conflict) => conflict.dependencyId === dependency.id,
    ),
    critical: isConsecutiveCriticalPathDependency(dependency, criticalPath),
    dependency,
    predecessor: itemsByKey.get(createWorkItemDependencyEndpointKey(dependency.predecessor)),
    successor: itemsByKey.get(createWorkItemDependencyEndpointKey(dependency.successor)),
  }))
}

/** Returns whether an edge joins one consecutive pair on the authoritative critical path. */
function isConsecutiveCriticalPathDependency(
  dependency: WorkItemScheduleDependency,
  criticalPath: readonly WorkItemDependencyEndpoint[],
): boolean {
  const predecessorKey = createWorkItemDependencyEndpointKey(dependency.predecessor)
  const successorKey = createWorkItemDependencyEndpointKey(dependency.successor)
  return criticalPath.some((endpoint, index) => {
    const next = criticalPath[index + 1]
    return next !== undefined &&
      createWorkItemDependencyEndpointKey(endpoint) === predecessorKey &&
      createWorkItemDependencyEndpointKey(next) === successorKey
  })
}

/**
 * Returns the summary for one task-like endpoint.
 *
 * @param summaries - Summaries keyed by canonical endpoint identity.
 * @param endpoint - Team-qualified Work Item identity to resolve.
 * @returns The matching dependency summary, when visible.
 */
export function resolveWorkItemDependencySummary(
  summaries: Readonly<Record<string, WorkItemDependencySummary>>,
  endpoint: WorkItemDependencyEndpoint,
): WorkItemDependencySummary | undefined {
  return summaries[createWorkItemDependencyEndpointKey(endpoint)]
}

/**
 * Returns dependencies entering or leaving one Work Item.
 *
 * @param rows - Display-ready dependency rows.
 * @param endpoint - Team-qualified Work Item identity to filter around.
 * @returns Every incoming or outgoing visible edge.
 */
export function filterWorkItemDependencyRows(
  rows: readonly WorkItemDependencyRow[],
  endpoint: WorkItemDependencyEndpoint,
): WorkItemDependencyRow[] {
  const key = createWorkItemDependencyEndpointKey(endpoint)
  return rows.filter((row) =>
    createWorkItemDependencyEndpointKey(row.dependency.predecessor) === key ||
    createWorkItemDependencyEndpointKey(row.dependency.successor) === key,
  )
}

/** Calculates the positive date movement still required by a conflict. */
function resolveRequiredShiftDays(conflict: WorkItemScheduleDependencyConflict): number {
  if (!conflict.actualDate || !conflict.requiredDate) return 0
  const required = new Date(`${conflict.requiredDate}T00:00:00.000Z`).getTime()
  const actual = new Date(`${conflict.actualDate}T00:00:00.000Z`).getTime()
  if (!Number.isFinite(required) || !Number.isFinite(actual)) return 0
  return Math.max(0, Math.round((required - actual) / MILLISECONDS_PER_DAY))
}
