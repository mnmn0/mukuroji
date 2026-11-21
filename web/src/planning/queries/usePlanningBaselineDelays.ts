import { useMemo } from 'react'
import useSWR from 'swr'
import type { PlanningSnapshot, PlanningUpdate } from '@mukuroji/contracts'
import { getProjectScheduleBaseline } from '../../work-items/api/scheduleBaseline'
import { WorkItemConfigurationApiError } from '../../work-items/api/errors'
import {
  collectWorkItemBaselineProjects,
  createWorkItemBaselineLookup,
  type WorkItemBaselineProject,
  type WorkItemBaselineProjectResult,
} from '../../work-items/model/workItemScheduleBaselines'
import { WORK_ITEM_SCHEDULE_BASELINES_KEY } from '../../work-items/queries/useWorkItemScheduleBaselines'
import {
  createPlanningBaselineDelayCandidates,
  listPlanningTargetBaselineWorkItems,
  type PlanningBaselineDelaysView,
} from '../model/baselineDelayEvidence'
import type { PlanningUpdateTargetView } from '../model/statusUpdateView'

/**
 * Reads the active baselines of the selected update target and lists what is behind them.
 *
 * Unlike the Gantt overlay, a Project whose baseline fails to load fails the whole list, so the
 * composer never presents an incomplete list as "nothing is behind".
 *
 * @param accessToken - Bearer token, or undefined before sign-in.
 * @param snapshot - Authorized Planning snapshot.
 * @param target - Selected Project or Initiative.
 * @param updates - Published updates of the target, newest first; the first one is the previous update.
 * @param enabled - Whether the viewer can publish an update for the target.
 * @returns The delay view, or undefined when the composer shows no delay section.
 */
export function usePlanningBaselineDelays(
  accessToken: string | undefined,
  snapshot: PlanningSnapshot | undefined,
  target: PlanningUpdateTargetView | undefined,
  updates: readonly PlanningUpdate[] | undefined,
  enabled: boolean,
): PlanningBaselineDelaysView | undefined {
  const active = Boolean(accessToken && snapshot && target && enabled)
  const projects = useMemo(
    () => active && snapshot && target
      ? collectWorkItemBaselineProjects(listPlanningTargetBaselineWorkItems(snapshot, target))
      : [],
    [active, snapshot, target],
  )
  const projectsKey = JSON.stringify(projects.map((project) => [project.teamId, project.projectId]))
  const query = useSWR(
    active && accessToken && projects.length > 0
      ? [WORK_ITEM_SCHEDULE_BASELINES_KEY, accessToken, projectsKey, 'planning-delays'] as const
      : null,
    ([, token]) => readAllProjectBaselines(token, projects),
    { shouldRetryOnError: false },
  )
  const { data, error, mutate } = query
  return useMemo(() => {
    if (!active || !snapshot || !target) return undefined
    if (projects.length > 0 && !data) {
      return error === undefined ? { status: 'loading' } : { status: 'error', retry: () => void mutate() }
    }
    const baselineFor = createWorkItemBaselineLookup(data ?? [])
    return {
      status: 'ready',
      candidates: createPlanningBaselineDelayCandidates(snapshot, target, baselineFor, updates?.[0]?.evidence ?? []),
    }
  }, [active, data, error, mutate, projects.length, snapshot, target, updates])
}

/**
 * Reads every Project's active baseline, failing when any read fails.
 *
 * A Project that answers 404 has no readable baseline and contributes no entries.
 *
 * @param accessToken - Bearer token.
 * @param projects - Projects to read.
 * @returns The baselines.
 */
async function readAllProjectBaselines(
  accessToken: string,
  projects: readonly WorkItemBaselineProject[],
): Promise<WorkItemBaselineProjectResult[]> {
  return Promise.all(projects.map(async (project) => {
    try {
      const response = await getProjectScheduleBaseline(project.teamId, project.projectId, accessToken)
      return { ...project, baseline: response.baseline }
    } catch (error) {
      if (error instanceof WorkItemConfigurationApiError && error.status === 404) return { ...project, baseline: null }
      throw error
    }
  }))
}
