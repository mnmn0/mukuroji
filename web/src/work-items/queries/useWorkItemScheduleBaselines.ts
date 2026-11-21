import { useMemo } from 'react'
import useSWR from 'swr'
import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { getProjectScheduleBaseline } from '../api/scheduleBaseline'
import {
  collectWorkItemBaselineProjects,
  createWorkItemBaselineLookup,
  type WorkItemBaselineLookup,
  type WorkItemBaselineProject,
  type WorkItemBaselineProjectResult,
} from '../model/workItemScheduleBaselines'

/** First element of every multi-Project baseline cache key, so a new capture can refresh them. */
export const WORK_ITEM_SCHEDULE_BASELINES_KEY = 'work-item-schedule-baselines'

/**
 * Reads the latest baseline of every Project the Work Items belong to.
 *
 * A Project the reader cannot open, or whose baseline fails to load, simply contributes no
 * entries, so its Work Items show no baseline instead of failing the whole view.
 *
 * @param accessToken - Bearer token, or undefined before sign-in.
 * @param workItems - Work Items shown.
 * @param enabled - Whether the view shows baseline differences right now.
 * @returns The lookup, or undefined until the baselines are read.
 */
export function useWorkItemScheduleBaselines(
  accessToken: string | undefined,
  workItems: readonly Pick<CanonicalWorkItem, 'teamId' | 'assignedProjectId'>[],
  enabled: boolean,
): WorkItemBaselineLookup | undefined {
  const projects = collectWorkItemBaselineProjects(workItems)
  const projectsKey = JSON.stringify(projects.map((project) => [project.teamId, project.projectId]))
  const { data } = useSWR(
    enabled && accessToken && projects.length > 0
      ? [WORK_ITEM_SCHEDULE_BASELINES_KEY, accessToken, projectsKey] as const
      : null,
    ([, token, key]) => readProjectBaselines(token, parseProjectsKey(key)),
    { shouldRetryOnError: false },
  )
  return useMemo(() => data ? createWorkItemBaselineLookup(data) : undefined, [data])
}

/**
 * Reads each Project's baseline, keeping the ones that loaded.
 *
 * @param accessToken - Bearer token.
 * @param projects - Projects to read.
 * @returns The baselines that were read.
 */
async function readProjectBaselines(
  accessToken: string,
  projects: readonly WorkItemBaselineProject[],
): Promise<WorkItemBaselineProjectResult[]> {
  const settled = await Promise.allSettled(projects.map(async (project) => {
    const response = await getProjectScheduleBaseline(project.teamId, project.projectId, accessToken)
    return { ...project, baseline: response.baseline }
  }))
  return settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
}

/**
 * Restores the Projects from their cache-key form.
 *
 * @param key - JSON list of `[teamId, projectId]` pairs.
 * @returns The Projects.
 */
function parseProjectsKey(key: string): WorkItemBaselineProject[] {
  const value: unknown = JSON.parse(key)
  if (!Array.isArray(value)) return []
  return value.flatMap((pair: unknown) =>
    Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      ? [{ teamId: pair[0], projectId: pair[1] }]
      : [])
}
