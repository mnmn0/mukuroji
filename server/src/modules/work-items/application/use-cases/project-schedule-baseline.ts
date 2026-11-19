import {
  createProjectScheduleBaselineEntry,
  PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES,
  type CanonicalWorkItem,
  type ProjectScheduleBaseline,
  type ProjectScheduleBaselineEntry,
  type ProjectScheduleBaselineResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../../directory'

/** Input of one Project schedule baseline capture, as the persistence port receives it. */
export type CaptureProjectScheduleBaselineInput<TCallerCheck> = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project whose baseline is captured. */
  projectId: string
  /** Frozen planned dates of every Work Item in the Project. */
  entries: readonly ProjectScheduleBaselineEntry[]
  /** Capture time as an ISO timestamp. */
  capturedAt: string
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
}

/** Persistence port for the latest schedule baseline of each Project. */
export type ProjectScheduleBaselineStore<TCallerCheck> = {
  /**
   * Reads the latest baseline of a Project.
   *
   * @param workspaceId - Workspace directory ID.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project whose baseline is read.
   * @returns The baseline with every entry, or `null` when none was captured.
   */
  get(workspaceId: string, teamId: string, projectId: string): Promise<ProjectScheduleBaseline | null>
  /**
   * Replaces the latest baseline of a Project.
   *
   * @param input - Capture input.
   * @returns The stored baseline.
   */
  capture(input: CaptureProjectScheduleBaselineInput<TCallerCheck>): Promise<ProjectScheduleBaseline>
}

/** Work Item fields the baseline use cases read. */
export type ScheduleBaselineWorkItem = Pick<CanonicalWorkItem, 'id' | 'schedule'> & {
  /** Project the Work Item is assigned to, if any. */
  assignedProjectId?: string
}

/** Dependencies shared by the baseline use cases. */
export type ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem extends ScheduleBaselineWorkItem> = {
  /** Baseline persistence. */
  store: ProjectScheduleBaselineStore<TCallerCheck>
  /**
   * Reads the Team's non-archived Work Items, at most `limit + 1` so a larger Team is detected.
   *
   * @param limit - Most Work Items the caller can use.
   */
  readTeamWorkItems(limit: number): Promise<TWorkItem[]>
}

/** Scope of one baseline request, after the route authorized it. */
export type ProjectScheduleBaselineScope = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project whose baseline is read or captured. */
  projectId: string
}

/**
 * Captures the current plan of every Work Item in a Project as its new baseline.
 *
 * @param dependencies - Store and Work Item reader.
 * @param scope - Authorized Team and Project.
 * @param capture - Capture time and the caller's commit-time authorization fences.
 * @returns The response with the stored baseline.
 */
export async function captureProjectScheduleBaselineUseCase<TCallerCheck, TWorkItem extends ScheduleBaselineWorkItem>(
  dependencies: ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem>,
  scope: ProjectScheduleBaselineScope,
  capture: { capturedAt: string; callerAuthorization: readonly TCallerCheck[] },
): Promise<ProjectScheduleBaselineResponse> {
  const workItems = (await readBoundedTeamWorkItems(dependencies))
    .filter((workItem) => workItem.assignedProjectId === scope.projectId)
  const baseline = await dependencies.store.capture({
    ...scope,
    entries: workItems.map((workItem) => createProjectScheduleBaselineEntry(workItem.id, workItem.schedule)),
    capturedAt: capture.capturedAt,
    callerAuthorization: capture.callerAuthorization,
  })
  return { teamId: scope.teamId, projectId: scope.projectId, baseline }
}

/**
 * Reads the latest baseline of a Project, keeping only the entries of Work Items the reader
 * may currently see.
 *
 * @param dependencies - Store and Work Item reader.
 * @param scope - Authorized Team and Project.
 * @param isReadable - Whether the reader may see a Work Item.
 * @returns The response; `baseline` is `null` when none was captured.
 */
export async function readProjectScheduleBaselineUseCase<TCallerCheck, TWorkItem extends ScheduleBaselineWorkItem>(
  dependencies: ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem>,
  scope: ProjectScheduleBaselineScope,
  isReadable: (workItem: TWorkItem) => boolean,
): Promise<ProjectScheduleBaselineResponse> {
  const baseline = await dependencies.store.get(scope.workspaceId, scope.teamId, scope.projectId)
  if (!baseline) return { teamId: scope.teamId, projectId: scope.projectId, baseline: null }
  const readableIds = new Set(
    (await readBoundedTeamWorkItems(dependencies)).filter(isReadable).map((workItem) => workItem.id),
  )
  return {
    teamId: scope.teamId,
    projectId: scope.projectId,
    baseline: { ...baseline, entries: baseline.entries.filter((entry) => readableIds.has(entry.workItemId)) },
  }
}

/**
 * Reads the Team's Work Items, refusing a Team too large for one baseline.
 *
 * @param dependencies - Work Item reader.
 * @returns The Team's Work Items.
 * @throws ProjectDataError 413 when the Team has more Work Items than one baseline holds.
 */
async function readBoundedTeamWorkItems<TCallerCheck, TWorkItem extends ScheduleBaselineWorkItem>(
  dependencies: ProjectScheduleBaselineDependencies<TCallerCheck, TWorkItem>,
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
