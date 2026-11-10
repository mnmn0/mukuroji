import type { PlanningUpdateTarget, UpdateFeedFilterOptions } from '@mukuroji/contracts'
import { PlanningError } from '../../planning'
import type { UpdateFeedReader } from './read-update-feed'

/** Reads selector labels only from current authorized targets and hierarchy scopes.
 * @param reader - Principal-bound current authorization and directory ports.
 * @returns Bounded selector metadata without report bodies or historical content.
 */
export async function readUpdateFeedFilterOptions(reader: UpdateFeedReader): Promise<UpdateFeedFilterOptions> {
  const snapshot = await reader.readSnapshot()
  if (snapshot.updateTargets.length > 2000) throw new PlanningError(413, 'UpdateFeedTargetLimitExceeded', 'Feed target projection exceeds its bounded read limit.')
  const identities = snapshot.updateTargets.map(({ target }) => JSON.stringify(target.type === 'project' ? ['project', target.teamId, target.projectId] : ['initiative', target.entityId]))
  if (new Set(identities).size !== identities.length) throw new PlanningError(409, 'UpdateFeedDuplicateTarget', 'Feed projection contains duplicate target identities.')
  const teams = new Map<string, string>()
  const projects = new Map<string, UpdateFeedFilterOptions['projects'][number]>()
  const portfolios = new Map<string, string>()
  const initiatives = new Map<string, string>()
  for (const candidate of snapshot.updateTargets) {
    if (candidate.archivedAt) continue
    const summary = await reader.authorizeTarget(candidate, snapshot)
    if (!summary) continue
    const scope = await reader.filterScope?.(summary, snapshot)
    const title = reader.describeTarget?.(summary, snapshot)
    if (summary.target.type === 'initiative' && title !== undefined) initiatives.set(summary.target.entityId, title)
    if (scope?.teamId) {
      teams.set(scope.teamId, reader.describeTeam?.(scope.teamId) ?? scope.teamId)
      if (scope.projectId) {
        const target: PlanningUpdateTarget = { type: 'project', teamId: scope.teamId, projectId: scope.projectId }
        projects.set(JSON.stringify([target.teamId, target.projectId]), { teamId: target.teamId, projectId: target.projectId, name: reader.describeTarget?.({ ...summary, target }, snapshot) ?? target.projectId })
      }
    }
    for (const id of scope?.portfolioIds ?? []) {
      const portfolio = snapshot.entities.find((entity) => entity.id === id && entity.type === 'portfolio' && !entity.archivedAt)
      if (portfolio) portfolios.set(id, portfolio.title)
    }
  }
  /** Orders labels consistently within the active UI language. */
  const named = (values: Map<string, string>) => [...values].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { teams: named(teams), projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId) || a.projectId.localeCompare(b.projectId)), portfolios: named(portfolios), initiatives: named(initiatives) }
}
