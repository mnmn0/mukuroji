import type { PlanningSnapshot } from '@mukuroji/contracts'
import useSWR from 'swr'
import { getPlanningSnapshot } from '../../planning/api/snapshot'
import type { AutomationPlanningParentOption } from '../model/projectTemplatePlanning'

/**
 * Loads the Planning entities a Project template's Phases and Milestones can be created under.
 *
 * @param accessToken - Access token for the Planning API.
 * @param enabled - Whether any template needs a Planning parent; nothing is fetched otherwise.
 * @returns The SWR state of the candidate list.
 */
export function useAutomationPlanningParents(accessToken: string, enabled: boolean) {
  return useSWR<AutomationPlanningParentOption[]>(
    enabled ? ['automation-planning-parents', accessToken] : null,
    async () => listAutomationPlanningParents(await getPlanningSnapshot(accessToken)),
  )
}

/**
 * Lists the Planning entities a Project template's Phases and Milestones can be placed under:
 * active roadmaps, initiatives, and goals outside any Project.
 *
 * @param snapshot - Planning snapshot the viewer can read.
 * @returns Candidates sorted by title.
 */
function listAutomationPlanningParents(snapshot: PlanningSnapshot): AutomationPlanningParentOption[] {
  const options: AutomationPlanningParentOption[] = []
  for (const entity of snapshot.entities) {
    if (entity.archivedAt !== undefined || entity.projectId !== undefined) continue
    if (entity.type !== 'roadmap' && entity.type !== 'initiative' && entity.type !== 'goal') continue
    options.push({
      id: entity.id,
      title: entity.title,
      type: entity.type,
      ...(entity.teamId === undefined ? {} : { teamId: entity.teamId }),
    })
  }
  return options.sort((first, second) => first.title.localeCompare(second.title))
}
