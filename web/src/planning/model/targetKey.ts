import type { PlanningUpdateTarget } from '@mukuroji/contracts'

/**
 * Creates the stable UI operation key for a Team-qualified Project or Initiative.
 *
 * @param target - Canonical Planning update target.
 * @returns Collision-resistant target key.
 */
export function createPlanningUpdateTargetKey(target: PlanningUpdateTarget): string {
  return target.type === 'project'
    ? `project:${target.teamId}\0${target.projectId}`
    : `initiative:${target.entityId}`
}
