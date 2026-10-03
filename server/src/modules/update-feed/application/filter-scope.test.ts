import { expect, test } from 'bun:test'
import type { PlanningEntity, PlanningSnapshot, PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import { InMemoryPlanningClient } from '../../planning/planning'
import { resolveUpdateFeedFilterScope } from './filter-scope'
import { readUpdateFeedFilterOptions } from './filter-options'

/** Produces a complete current graph entity without historical reports. */
function entity(id: string, type: PlanningEntity['type'], parentId?: string): PlanningEntity {
  return { id, type, title: id, parentId, teamId: 'team', projectId: 'project', ownerMemberKey: 'owner', status: 'active', health: 'on-track', rollupHealth: 'on-track', risk: 'none', progressMode: 'automatic', progress: 0, linkedWorkItemCount: 0, baseline: { startDate: '2026-01-01', endDate: '2026-12-01' }, forecast: { startDate: '2026-01-01', endDate: '2026-12-01' }, statusUpdates: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
}
/** Creates a bounded source graph with both qualified Project and Initiative targets. */
async function graph(): Promise<PlanningSnapshot> {
  const base = await new InMemoryPlanningClient().get('w', { workItems: [] })
  return { ...base, entities: [entity('portfolio', 'portfolio'), entity('roadmap', 'roadmap', 'portfolio'), entity('initiative', 'initiative', 'roadmap')], updateTargets: [{ target: { type: 'initiative', entityId: 'initiative' }, latestVersion: 0, updateState: 'missing', updatedAt: '2026-01-01T00:00:00Z' }, { target: { type: 'project', teamId: 'team', projectId: 'project' }, latestVersion: 0, updateState: 'missing', updatedAt: '2026-01-01T00:00:00Z' }] }
}

test('resolves active qualified Portfolio ancestry and hides denied or archived ancestors', async () => {
  const snapshot = await graph()
  for (const target of snapshot.updateTargets) expect(await resolveUpdateFeedFilterScope(target, snapshot, async () => true)).toEqual({ teamId: 'team', projectId: 'project', portfolioIds: ['portfolio'] })
  const initiative = snapshot.updateTargets[0]
  if (!initiative || !snapshot.entities[0]) throw new Error('Missing fixtures')
  expect((await resolveUpdateFeedFilterScope(initiative, snapshot, async () => false)).portfolioIds).toEqual([])
  snapshot.entities[0].archivedAt = '2026-02-01T00:00:00Z'
  expect((await resolveUpdateFeedFilterScope(initiative, snapshot, async () => true)).portfolioIds).toEqual([])
  delete snapshot.entities[0].archivedAt
  const roadmap = snapshot.entities[1]
  if (!roadmap) throw new Error('Missing roadmap')
  roadmap.parentId = 'initiative'
  expect((await resolveUpdateFeedFilterScope(initiative, snapshot, async () => true)).portfolioIds).toEqual([])
})

test('selector metadata is bounded, authorized, body-free and revalidated after access loss', async () => {
  const snapshot = await graph()
  let allowed = true
  const reader = { memberKey: 'reader', readSnapshot: async () => snapshot, authorizeTarget: async (summary: PlanningUpdateTargetSummary) => allowed ? summary : undefined, describeTarget: () => 'Current title', describeTeam: () => 'Current team', filterScope: (summary: PlanningUpdateTargetSummary) => resolveUpdateFeedFilterScope(summary, snapshot, async () => allowed) }
  expect(await readUpdateFeedFilterOptions(reader)).toEqual({ teams: [{ id: 'team', name: 'Current team' }], projects: [{ teamId: 'team', projectId: 'project', name: 'Current title' }], portfolios: [{ id: 'portfolio', name: 'portfolio' }], initiatives: [{ id: 'initiative', name: 'Current title' }] })
  allowed = false
  expect(await readUpdateFeedFilterOptions(reader)).toEqual({ teams: [], projects: [], portfolios: [], initiatives: [] })
  const duplicate = snapshot.updateTargets[0]
  if (!duplicate) throw new Error('Missing target fixture')
  snapshot.updateTargets.push(duplicate)
  await expect(readUpdateFeedFilterOptions(reader)).rejects.toMatchObject({ status: 409 })
})
