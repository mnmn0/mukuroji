import type { PlanningUpdateTarget, UpdateFeedView } from '@mukuroji/contracts'

/** Standard views supported by the bounded server feed. */
export const updateFeedViews: readonly UpdateFeedView[] = ['for-me', 'recent', 'at-risk', 'missing', 'stale', 'overdue']

/** Narrows a URL or response value to a standard feed view.
 * @param value - Untrusted selector.
 * @returns Whether the selector is supported.
 */
export function isUpdateFeedView(value: unknown): value is UpdateFeedView {
  return typeof value === 'string' && updateFeedViews.some((view) => view === value)
}

/** Creates the existing Planning detail/history route using qualified target identity.
 * @param target - Authorized target identity.
 * @returns Application-relative encoded Planning route.
 */
export function updateFeedTargetPath(target: PlanningUpdateTarget): string {
  const params = target.type === 'project'
    ? new URLSearchParams({ targetType: 'project', teamId: target.teamId, projectId: target.projectId })
    : target.type === 'team'
    ? new URLSearchParams({ targetType: 'team', teamId: target.teamId })
    : new URLSearchParams({ targetType: 'initiative', entityId: target.entityId })
  return `/planning/portfolio?${params}`
}

/** Creates a stable row identity independent of nonunique update IDs.
 * @param target - Qualified target identity.
 * @returns Stable logical row key.
 */
export function updateFeedTargetKey(target: PlanningUpdateTarget): string {
  if (target.type === 'project') return JSON.stringify([target.type, target.teamId, target.projectId])
  return target.type === 'team' ? JSON.stringify([target.type, target.teamId]) : JSON.stringify([target.type, target.entityId])
}
