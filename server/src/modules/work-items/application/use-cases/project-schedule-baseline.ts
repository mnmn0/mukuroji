import {
  createProjectScheduleBaselineEntry,
  PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES,
  PROJECT_SCHEDULE_BASELINE_MAX_SAVED,
  type CanonicalWorkItem,
  type ProjectScheduleBaseline,
  type ProjectScheduleBaselineEntry,
  type ProjectScheduleBaselineResponse,
  type SavedProjectScheduleBaseline,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../../directory'

/** The active baseline of a Project with the list of its saved baselines. */
export type ActiveProjectScheduleBaseline = ProjectScheduleBaseline & {
  /** Saved baselines, newest first, including the active one once it has an ID. */
  savedBaselines: SavedProjectScheduleBaseline[]
}

/**
 * One write of a Project's active baseline: a new capture, or a switch to a saved baseline.
 * The persistence port stores every part in one transaction.
 */
export type WriteProjectScheduleBaselineInput<TCallerCheck, TAuditContext = undefined> = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project whose baseline is written. */
  projectId: string
  /** Whether a new baseline was captured or a saved one was made active. */
  kind: 'capture' | 'activate'
  /** ISO timestamp of the write, which the audit event records. */
  writtenAt: string
  /** New active baseline; its revision is `expectedRevision + 1`. */
  baseline: ProjectScheduleBaseline & { id: string }
  /**
   * Active baseline revision read before the write was prepared, or 0 when none existed.
   * The write fails when another write committed in between.
   */
  expectedRevision: number
  /** Saved baseline list after the write, newest first. */
  savedBaselines: SavedProjectScheduleBaseline[]
  /** Saved baselines to store as their own rows, which must not exist yet. */
  savedRowsToPut: (ProjectScheduleBaseline & { id: string })[]
  /** Saved baselines dropped from the list, whose rows are deleted. */
  savedIdsToDelete: string[]
  /** The active baseline being replaced, or `null` for the Project's first capture. */
  previous: ProjectScheduleBaselineSummary | null
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Request audit context; the store records the write in the same transaction. */
  auditContext: TAuditContext
}

/** What the audit event records about a baseline: no Work Item IDs, dates, or names. */
export type ProjectScheduleBaselineSummary = {
  /** Baseline ID; absent for a baseline saved before named baselines existed. */
  baselineId?: string
  /** Active baseline revision. */
  revision: number
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** Number of Work Items the baseline holds. */
  entryCount: number
}

/** Persistence port for the schedule baselines of each Project. */
export type ProjectScheduleBaselineStore<TCallerCheck, TAuditContext = undefined> = {
  /**
   * Reads the active baseline of a Project.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @returns The baseline with every entry and the saved list, or `null` when none was captured.
   */
  get(workspaceId: string, teamId: string, projectId: string): Promise<ActiveProjectScheduleBaseline | null>
  /**
   * Reads one saved baseline of a Project.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @param baselineId - Saved baseline ID.
   * @returns The baseline with every entry, or `null` when it is not stored.
   */
  getSaved(
    workspaceId: string,
    teamId: string,
    projectId: string,
    baselineId: string,
  ): Promise<ProjectScheduleBaseline | null>
  /**
   * Writes a new active baseline of a Project.
   *
   * @param input - Write input.
   * @returns The stored active baseline.
   */
  write(input: WriteProjectScheduleBaselineInput<TCallerCheck, TAuditContext>): Promise<ProjectScheduleBaseline>
}

/** Work Item fields the baseline use cases read. */
export type ScheduleBaselineWorkItem = Pick<CanonicalWorkItem, 'id' | 'schedule'> & {
  /** Project the Work Item is assigned to, if any. */
  assignedProjectId?: string
}

/** Dependencies shared by the baseline use cases. */
export type ProjectScheduleBaselineDependencies<
  TCallerCheck,
  TWorkItem extends ScheduleBaselineWorkItem,
  TAuditContext = undefined,
> = {
  /** Baseline persistence. */
  store: ProjectScheduleBaselineStore<TCallerCheck, TAuditContext>
  /**
   * Reads the Team's non-archived Work Items, at most `limit + 1` so a larger Team is detected.
   *
   * @param limit - Most Work Items the caller can use.
   */
  readTeamWorkItems(limit: number): Promise<TWorkItem[]>
  /**
   * Creates the ID of a new baseline.
   *
   * @returns A fresh baseline ID.
   */
  createBaselineId?: () => string
}

/** Scope of one baseline request, after the route authorized it. */
export type ProjectScheduleBaselineScope = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project whose baseline is read or written. */
  projectId: string
}

/** Commit-time inputs shared by the baseline writes. */
export type ProjectScheduleBaselineWriteContext<TCallerCheck, TAuditContext> = {
  /** Write time as an ISO timestamp. */
  capturedAt: string
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Request audit context. */
  auditContext: TAuditContext
}

/**
 * Captures the current plan of every Work Item in a Project as a new named baseline and makes it
 * the active one. The previous baselines stay saved, up to the saved limit; the oldest one that
 * is not active is dropped beyond it.
 *
 * @param dependencies - Store and Work Item reader.
 * @param scope - Authorized Team and Project.
 * @param capture - Capture time, optional name, the caller's commit-time fences, and the audit context.
 * @returns The response with the stored baseline.
 */
export async function captureProjectScheduleBaselineUseCase<
  TCallerCheck,
  TWorkItem extends ScheduleBaselineWorkItem,
  TAuditContext,
>(
  dependencies: ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem, TAuditContext>,
  scope: ProjectScheduleBaselineScope,
  capture: ProjectScheduleBaselineWriteContext<TCallerCheck, TAuditContext> & { name?: string },
): Promise<ProjectScheduleBaselineResponse> {
  // Pin the revision before reading the plan, so an older snapshot cannot replace a newer capture.
  const previous = await dependencies.store.get(scope.workspaceId, scope.teamId, scope.projectId)
  const workItems = (await readBoundedTeamWorkItems(dependencies))
    .filter((workItem) => workItem.assignedProjectId === scope.projectId)
  const entries: ProjectScheduleBaselineEntry[] = workItems
    .map((workItem) => createProjectScheduleBaselineEntry(workItem.id, workItem.schedule))
  const baseline: ProjectScheduleBaseline & { id: string } = {
    revision: (previous?.revision ?? 0) + 1,
    id: (dependencies.createBaselineId ?? createDefaultBaselineId)(),
    ...(capture.name === undefined ? {} : { name: capture.name }),
    capturedAt: capture.capturedAt,
    entries,
  }
  const legacy = previous ? keepLegacyBaseline(previous) : undefined
  const listed = [summarize(baseline), ...(legacy ? [summarize(legacy)] : []), ...(previous?.savedBaselines ?? [])]
  const { kept, dropped } = trimSavedBaselines(listed, baseline.id)
  const stored = await dependencies.store.write({
    ...scope,
    kind: 'capture',
    writtenAt: capture.capturedAt,
    baseline,
    expectedRevision: previous?.revision ?? 0,
    savedBaselines: kept,
    savedRowsToPut: [baseline, ...(legacy && kept.some((item) => item.id === legacy.id) ? [legacy] : [])],
    savedIdsToDelete: dropped.filter((id) => id !== legacy?.id),
    previous: previous ? summarizeForAudit(previous) : null,
    callerAuthorization: capture.callerAuthorization,
    auditContext: capture.auditContext,
  })
  return { ...responseScope(scope), baseline: stored, activeBaselineId: baseline.id, savedBaselines: kept }
}

/**
 * Makes a saved baseline the active one that every view compares against.
 *
 * @param dependencies - Store and Work Item reader.
 * @param scope - Authorized Team and Project.
 * @param request - Saved baseline ID and the active revision the caller read.
 * @param context - Write time, the caller's commit-time fences, and the audit context.
 * @returns The response with the new active baseline.
 * @throws ProjectDataError 404 when the baseline is not saved, 409 when the active baseline changed.
 */
export async function activateProjectScheduleBaselineUseCase<
  TCallerCheck,
  TWorkItem extends ScheduleBaselineWorkItem,
  TAuditContext,
>(
  dependencies: ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem, TAuditContext>,
  scope: ProjectScheduleBaselineScope,
  request: { baselineId: string; expectedRevision: number },
  context: ProjectScheduleBaselineWriteContext<TCallerCheck, TAuditContext>,
  isReadable: (workItem: TWorkItem) => boolean,
): Promise<ProjectScheduleBaselineResponse> {
  const previous = await dependencies.store.get(scope.workspaceId, scope.teamId, scope.projectId)
  if (!previous) throw baselineNotFound()
  if (previous.revision !== request.expectedRevision) throw baselineConflict()
  const legacy = keepLegacyBaseline(previous)
  const activeId = previous.id ?? legacy?.id
  const listed = [...(legacy ? [summarize(legacy)] : []), ...previous.savedBaselines]
  if (!listed.some((item) => item.id === request.baselineId)) throw baselineNotFound()
  if (activeId === request.baselineId) {
    return {
      ...responseScope(scope),
      baseline: await keepReadableEntries(dependencies, withoutList(previous), isReadable),
      activeBaselineId: request.baselineId,
      savedBaselines: listed,
    }
  }
  const saved = await dependencies.store.getSaved(scope.workspaceId, scope.teamId, scope.projectId, request.baselineId)
  if (!saved) throw baselineNotFound()
  const baseline: ProjectScheduleBaseline & { id: string } = {
    ...saved,
    id: request.baselineId,
    revision: previous.revision + 1,
  }
  const { kept, dropped } = trimSavedBaselines(listed, baseline.id)
  const stored = await dependencies.store.write({
    ...scope,
    kind: 'activate',
    writtenAt: context.capturedAt,
    baseline,
    expectedRevision: previous.revision,
    savedBaselines: kept,
    savedRowsToPut: legacy && kept.some((item) => item.id === legacy.id) ? [legacy] : [],
    savedIdsToDelete: dropped.filter((id) => id !== legacy?.id),
    previous: summarizeForAudit(previous),
    callerAuthorization: context.callerAuthorization,
    auditContext: context.auditContext,
  })
  return {
    ...responseScope(scope),
    // The stored baseline keeps every entry; the response shows only what the caller may see now.
    baseline: await keepReadableEntries(dependencies, stored, isReadable),
    activeBaselineId: baseline.id,
    savedBaselines: kept,
  }
}

/**
 * Keeps only the entries of Work Items the reader may currently see.
 *
 * @param dependencies - Work Item reader.
 * @param baseline - Baseline with every entry.
 * @param isReadable - Whether the reader may see a Work Item.
 * @returns A copy of the baseline with the readable entries.
 */
async function keepReadableEntries<
  TCallerCheck,
  TWorkItem extends ScheduleBaselineWorkItem,
  TAuditContext,
>(
  dependencies: ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem, TAuditContext>,
  baseline: ProjectScheduleBaseline,
  isReadable: (workItem: TWorkItem) => boolean,
): Promise<ProjectScheduleBaseline> {
  const readableIds = new Set(
    (await readBoundedTeamWorkItems(dependencies)).filter(isReadable).map((workItem) => workItem.id),
  )
  return { ...baseline, entries: baseline.entries.filter((entry) => readableIds.has(entry.workItemId)) }
}

/**
 * Reads the active baseline of a Project, or one saved baseline by ID, keeping only the entries
 * of Work Items the reader may currently see.
 *
 * @param dependencies - Store and Work Item reader.
 * @param scope - Authorized Team and Project.
 * @param isReadable - Whether the reader may see a Work Item.
 * @param baselineId - Saved baseline to read instead of the active one.
 * @returns The response; `baseline` is `null` when none was captured.
 * @throws ProjectDataError 404 when the requested saved baseline does not exist.
 */
export async function readProjectScheduleBaselineUseCase<
  TCallerCheck,
  TWorkItem extends ScheduleBaselineWorkItem,
  TAuditContext,
>(
  dependencies: ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem, TAuditContext>,
  scope: ProjectScheduleBaselineScope,
  isReadable: (workItem: TWorkItem) => boolean,
  baselineId?: string,
): Promise<ProjectScheduleBaselineResponse> {
  const active = await dependencies.store.get(scope.workspaceId, scope.teamId, scope.projectId)
  if (!active) {
    if (baselineId !== undefined) throw baselineNotFound()
    return { ...responseScope(scope), baseline: null, savedBaselines: [] }
  }
  const legacy = keepLegacyBaseline(active)
  const activeBaselineId = active.id ?? legacy?.id
  const savedBaselines = [...(legacy ? [summarize(legacy)] : []), ...active.savedBaselines]
  let requested: ProjectScheduleBaseline
  if (baselineId === undefined || baselineId === activeBaselineId) {
    requested = legacy ?? withoutList(active)
  } else {
    if (!savedBaselines.some((item) => item.id === baselineId)) throw baselineNotFound()
    const saved = await dependencies.store.getSaved(scope.workspaceId, scope.teamId, scope.projectId, baselineId)
    if (!saved) throw baselineNotFound()
    requested = saved
  }
  return {
    ...responseScope(scope),
    baseline: await keepReadableEntries(dependencies, requested, isReadable),
    ...(activeBaselineId === undefined ? {} : { activeBaselineId }),
    savedBaselines,
  }
}

/**
 * Picks the Team and Project a response names.
 *
 * @param scope - Request scope.
 * @returns The response identifiers, without the Workspace.
 */
function responseScope(scope: ProjectScheduleBaselineScope) {
  return { teamId: scope.teamId, projectId: scope.projectId }
}

/**
 * Gives an active baseline saved before named baselines existed a stable ID, so the next write
 * keeps it in the saved list instead of losing it.
 *
 * @param active - Active baseline as stored.
 * @returns The legacy baseline under its `legacy-r<revision>` ID, or undefined when it has an ID.
 */
function keepLegacyBaseline(active: ActiveProjectScheduleBaseline): (ProjectScheduleBaseline & { id: string }) | undefined {
  if (active.id !== undefined) return undefined
  return { ...withoutList(active), id: `legacy-r${active.revision}` }
}

/**
 * Copies the active baseline without its saved list.
 *
 * @param active - Active baseline as stored.
 * @returns The baseline alone.
 */
function withoutList(active: ActiveProjectScheduleBaseline): ProjectScheduleBaseline {
  return {
    revision: active.revision,
    ...(active.id === undefined ? {} : { id: active.id }),
    ...(active.name === undefined ? {} : { name: active.name }),
    capturedAt: active.capturedAt,
    entries: active.entries,
  }
}

/**
 * Drops the oldest saved baselines beyond the limit, never the active one.
 *
 * @param listed - Saved baselines, newest first.
 * @param activeId - ID of the active baseline after the write.
 * @returns The kept list and the IDs of the dropped baselines.
 */
function trimSavedBaselines(listed: readonly SavedProjectScheduleBaseline[], activeId: string) {
  const unique = listed.filter((item, index) => listed.findIndex((other) => other.id === item.id) === index)
  const kept = [...unique]
  const dropped: string[] = []
  while (kept.length > PROJECT_SCHEDULE_BASELINE_MAX_SAVED) {
    const index = kept.findLastIndex((item) => item.id !== activeId)
    const [removed] = kept.splice(index, 1)
    if (removed) dropped.push(removed.id)
  }
  return { kept, dropped }
}

/**
 * Builds the list entry of a baseline.
 *
 * @param baseline - Baseline with an ID.
 * @returns Its list entry.
 */
function summarize(baseline: ProjectScheduleBaseline & { id: string }): SavedProjectScheduleBaseline {
  return {
    id: baseline.id,
    ...(baseline.name === undefined ? {} : { name: baseline.name }),
    capturedAt: baseline.capturedAt,
    entryCount: baseline.entries.length,
  }
}

/**
 * Builds the audit summary of the active baseline being replaced.
 *
 * @param baseline - Active baseline.
 * @returns Its audit summary.
 */
function summarizeForAudit(baseline: ProjectScheduleBaseline): ProjectScheduleBaselineSummary {
  return {
    ...(baseline.id === undefined ? {} : { baselineId: baseline.id }),
    revision: baseline.revision,
    capturedAt: baseline.capturedAt,
    entryCount: baseline.entries.length,
  }
}

/**
 * Creates a random baseline ID.
 *
 * @returns An ID such as `b-1f0c…`.
 */
function createDefaultBaselineId() {
  return `b-${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * Creates the error for a baseline that is not saved.
 *
 * @returns The error.
 */
function baselineNotFound() {
  return new ProjectDataError(404, 'ScheduleBaselineNotFound', 'The schedule baseline was not found.')
}

/**
 * Creates the error for a write based on an outdated active baseline.
 *
 * @returns The error.
 */
function baselineConflict() {
  return new ProjectDataError(409, 'ScheduleBaselineConflict', 'The schedule baseline changed. Reload and try again.')
}

/**
 * Reads the Team's Work Items, refusing a Team too large for one baseline.
 *
 * @param dependencies - Work Item reader.
 * @returns The Team's Work Items.
 * @throws ProjectDataError 413 when the Team has more Work Items than one baseline holds.
 */
async function readBoundedTeamWorkItems<
  TCallerCheck,
  TWorkItem extends ScheduleBaselineWorkItem,
  TAuditContext,
>(
  dependencies: ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem, TAuditContext>,
): Promise<TWorkItem[]> {
  const workItems = await dependencies.readTeamWorkItems(PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES)
  if (workItems.length > PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES) {
    throw new ProjectDataError(
      413,
      'WorkItemListLimitExceeded',
      `This Team has more than ${PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES} Work Items, so its schedule baseline cannot be read at once.`,
    )
  }
  return workItems
}
