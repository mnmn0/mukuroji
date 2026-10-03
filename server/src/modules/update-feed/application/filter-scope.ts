import type { PlanningEntity, PlanningSnapshot, PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import type { UpdateFeedFilterScope } from './read-update-feed'

/** Resolves current scope and readable Portfolio ancestry from the bounded canonical graph.
 * @param summary - Already authorized target projection.
 * @param snapshot - Current bounded graph.
 * @param canReadScope - Current active-scope authorization, cached by the request adapter.
 * @returns Qualified scope and unique readable Portfolio identities.
 */
export async function resolveUpdateFeedFilterScope(summary: PlanningUpdateTargetSummary, snapshot: PlanningSnapshot, canReadScope: (scope: Pick<PlanningEntity, 'teamId' | 'projectId'>) => Promise<boolean>): Promise<UpdateFeedFilterScope> {
  const target = summary.target
  const entity = target.type === 'initiative' ? snapshot.entities.find((item) => item.id === target.entityId && item.type === 'initiative' && !item.archivedAt) : undefined
  const scope = target.type === 'project' ? target : entity
  const candidates = target.type === 'project' ? snapshot.entities.filter((item) => !item.archivedAt && item.teamId === target.teamId && item.projectId === target.projectId) : entity ? [entity] : []
  const byId = new Map(snapshot.entities.map((item) => [item.id, item]))
  const portfolioIds = new Set<string>()
  for (const candidate of candidates) {
    let cursor: PlanningEntity | undefined = candidate
    const visited = new Set<string>()
    while (cursor && !cursor.archivedAt && !visited.has(cursor.id)) {
      visited.add(cursor.id)
      if (!await canReadScope(cursor)) break
      if (cursor.type === 'portfolio') { portfolioIds.add(cursor.id); break }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
  }
  return { ...(scope?.teamId ? { teamId: scope.teamId } : {}), ...(scope?.projectId ? { projectId: scope.projectId } : {}), portfolioIds: [...portfolioIds] }
}
