import type { PlanningUpdateTarget } from '@mukuroji/contracts'

/**
 * Creates the stable UI operation key for a Team-qualified Project, a Team, or an Initiative.
 *
 * @param target - Canonical Planning update target.
 * @returns Collision-resistant target key.
 */
export function createPlanningUpdateTargetKey(target: PlanningUpdateTarget): string {
  if (target.type === 'project') return `project:${target.teamId}\0${target.projectId}`
  return target.type === 'team' ? `team:${target.teamId}` : `initiative:${target.entityId}`
}
