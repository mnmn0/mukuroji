import type {
  CanonicalWorkItem,
  ProjectScheduleBaseline,
  ProjectScheduleBaselineEntry,
} from '@mukuroji/contracts'

/** Table column showing how far each Work Item ends behind its Project baseline. */
export const WORK_ITEM_BASELINE_END_DELAY_COLUMN = 'baselineEndDelayDays'

/** Most Projects whose baselines one list reads at once. */
export const WORK_ITEM_BASELINE_PROJECT_LIMIT = 50

/** Team and Project whose baseline covers a Work Item. */
export type WorkItemBaselineProject = {
  /** Team that owns the Project. */
  teamId: string
  /** Project ID. */
  projectId: string
}

/** Finds the baseline entry of a Work Item, or undefined when its Project has none for it. */
export type WorkItemBaselineLookup = (
  workItem: Pick<CanonicalWorkItem, 'id' | 'teamId' | 'assignedProjectId'>,
) => ProjectScheduleBaselineEntry | undefined

/** A read baseline of one Project. */
export type WorkItemBaselineProjectResult = WorkItemBaselineProject & {
  /** Latest baseline, or `null` when none was saved. */
  baseline: ProjectScheduleBaseline | null
}

/**
 * Lists the distinct Projects of the Work Items, in a stable order, up to the read limit.
 *
 * A Project is keyed by its owner Team too, because Project IDs may repeat across Teams.
 *
 * @param workItems - Work Items shown.
 * @param limit - Most Projects to return; a list that must stay complete passes `Infinity`.
 * @returns The Projects whose baselines the list needs.
 */
export function collectWorkItemBaselineProjects(
  workItems: readonly Pick<CanonicalWorkItem, 'teamId' | 'assignedProjectId'>[],
  limit: number = WORK_ITEM_BASELINE_PROJECT_LIMIT,
): WorkItemBaselineProject[] {
  const projects = new Map<string, WorkItemBaselineProject>()
  for (const workItem of workItems) {
    if (!workItem.assignedProjectId) continue
    const project = { teamId: workItem.teamId, projectId: workItem.assignedProjectId }
    projects.set(createBaselineProjectKey(project), project)
  }
  return [...projects.entries()]
    .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
    .slice(0, limit)
    .map(([, project]) => project)
}

/**
 * Builds the lookup from Work Item to its baseline entry.
 *
 * @param results - Baselines read per Project; a Project missing here has no entries.
 * @returns The lookup.
 */
export function createWorkItemBaselineLookup(
  results: readonly WorkItemBaselineProjectResult[],
): WorkItemBaselineLookup {
  const entriesByProject = new Map<string, ReadonlyMap<string, ProjectScheduleBaselineEntry>>()
  for (const result of results) {
    if (!result.baseline) continue
    entriesByProject.set(
      createBaselineProjectKey(result),
      new Map(result.baseline.entries.map((entry) => [entry.workItemId, entry])),
    )
  }
  return (workItem) => workItem.assignedProjectId
    ? entriesByProject
        .get(createBaselineProjectKey({ teamId: workItem.teamId, projectId: workItem.assignedProjectId }))
        ?.get(workItem.id)
    : undefined
}

/**
 * Builds the map key of a Team-owned Project.
 *
 * @param project - Team and Project.
 * @returns A key that keeps equal Project IDs of different Teams apart.
 */
function createBaselineProjectKey(project: WorkItemBaselineProject): string {
  return JSON.stringify([project.teamId, project.projectId])
}
