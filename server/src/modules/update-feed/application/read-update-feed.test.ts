import { expect, test } from 'bun:test'
import type { PlanningSnapshot, PlanningUpdateTargetSummary, UpdateFeedFilters } from '@mukuroji/contracts'
import { InMemoryPlanningClient } from '../../planning/planning'
import { readUpdateFeed, type UpdateFeedTargetSignals } from './read-update-feed'

/** Creates a latest-target fixture with independent health and submission status. */
function target(projectId: string, state: PlanningUpdateTargetSummary['updateState'] = 'current'): PlanningUpdateTargetSummary {
  return {
    target: { type: 'project', teamId: 'team', projectId },
    latestVersion: 1, updateState: state, updatedAt: '2026-08-01T00:00:00.000Z',
    cadence: {
      updateOwnerMemberKey: 'reader', cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC', nextDueAt: '2026-08-10T00:00:00.000Z', reminderHoursBefore: 24,
    },
    latestUpdate: {
      id: 'same-local-id', version: 1, health: 'on-track', risk: 'none', summary: projectId,
      authorMemberKey: 'reader', createdAt: '2026-08-01T00:00:00.000Z',
      coveredDueAt: '2026-08-01T00:00:00.000Z', progressSnapshot: { percent: 50, linkedWorkItemCount: 1 },
      capturedScope: { teamId: 'team', projectId },
    },
  }
}

/** Produces a bounded graph fixture without loading update history. */
async function snapshot(updateTargets: PlanningUpdateTargetSummary[]): Promise<PlanningSnapshot> {
  return { ...await new InMemoryPlanningClient().get('workspace', { workItems: [] }), updateTargets }
}

test('keeps health and submission predicates separate and emits one entry for multiple relevance reasons', async () => {
  const late = target('late', 'overdue')
  const risk = target('risk')
  if (risk.latestUpdate) risk.latestUpdate.health = 'off-track'
  const missing = target('missing', 'missing')
  delete missing.latestUpdate
  missing.latestVersion = 0
  const state = await snapshot([late, risk, missing])
  const before = structuredClone(state)
  const reader = { memberKey: 'READER', readSnapshot: async () => state, authorizeTarget: async (summary: PlanningUpdateTargetSummary) => summary }
  expect((await readUpdateFeed(reader, 'overdue')).entries.map((entry) => entry.health)).toEqual(['on-track'])
  expect((await readUpdateFeed(reader, 'at-risk')).entries.map((entry) => entry.updateState)).toEqual(['current'])
  expect((await readUpdateFeed(reader, 'missing')).entries[0]?.health).toBe('unknown')
  const feed = await readUpdateFeed(reader, 'for-me')
  expect(feed.total).toBe(3)
  expect(feed.entries[0]).toMatchObject({ reasons: ['update-owner', 'latest-author'], relevance: 3 })
  expect(feed.entries[0]?.latestUpdate).not.toHaveProperty('capturedScope')
  expect((await readUpdateFeed(reader)).total).toBe(2)
  expect(state).toEqual(before)
})

test('rechecks permissions each request, excludes archives, and propagates storage failures', async () => {
  const archived = { ...target('archived'), archivedAt: '2026-08-02T00:00:00.000Z' }
  const state = await snapshot([target('active'), archived])
  let allowed = true
  let checks = 0
  const reader = { memberKey: 'reader', readSnapshot: async () => state, authorizeTarget: async (summary: PlanningUpdateTargetSummary) => { checks++; return allowed ? summary : undefined } }
  expect((await readUpdateFeed(reader)).total).toBe(1)
  allowed = false
  expect((await readUpdateFeed(reader)).total).toBe(0)
  expect(checks).toBe(2)
  await expect(readUpdateFeed({ ...reader, authorizeTarget: async () => { throw new Error('unavailable') } })).rejects.toThrow('unavailable')
})

test('bounds output, exposes truncation, and orders ties independently of storage order', async () => {
  const state = await snapshot([target('z'), target('a')])
  const reader = { memberKey: 'reader', readSnapshot: async () => state, authorizeTarget: async (summary: PlanningUpdateTargetSummary) => summary }
  expect(await readUpdateFeed(reader, 'recent', '1')).toMatchObject({ total: 2, truncated: true, entries: [{ target: { projectId: 'a' } }] })
  state.updateTargets.reverse()
  expect((await readUpdateFeed(reader, 'recent', '1')).entries[0]?.target).toMatchObject({ projectId: 'a' })
  state.updateTargets = Array.from({ length: 2001 }, () => target('x'))
  await expect(readUpdateFeed(reader)).rejects.toMatchObject({ code: 'UpdateFeedTargetLimitExceeded' })
})

test('keeps overdue and owned targets when authorization redacts their old latest report', async () => {
  const state = await snapshot([target('moved', 'overdue')])
  const reader = {
    memberKey: 'reader', readSnapshot: async () => state,
    authorizeTarget: async (summary: PlanningUpdateTargetSummary) => ({ ...summary, latestUpdate: undefined }),
  }
  expect(await readUpdateFeed(reader, 'overdue')).toMatchObject({ total: 1, entries: [{ health: 'unknown', updateState: 'overdue' }] })
  expect((await readUpdateFeed(reader, 'for-me')).entries[0]).toMatchObject({ reasons: ['update-owner'], relevance: 2 })
  expect((await readUpdateFeed(reader, 'recent')).total).toBe(0)
  expect((await readUpdateFeed(reader, 'at-risk')).total).toBe(0)
})

test('validates query input before reading and rejects duplicate projection identities', async () => {
  const state = await snapshot([target('x'), target('x')])
  let reads = 0
  const reader = { memberKey: 'reader', readSnapshot: async () => { reads++; return state }, authorizeTarget: async (summary: PlanningUpdateTargetSummary) => summary }
  for (const limit of ['0', '-1', '101', '1.5', '1e1', '', ' 1']) {
    await expect(readUpdateFeed(reader, 'recent', limit)).rejects.toMatchObject({ code: 'UpdateFeedLimitInvalid' })
  }
  await expect(readUpdateFeed(reader, 'invalid')).rejects.toMatchObject({ code: 'UpdateFeedViewInvalid' })
  expect(reads).toBe(0)
  await expect(readUpdateFeed(reader)).rejects.toMatchObject({ code: 'UpdateFeedDuplicateTarget' })
  const overdue = target('x', 'overdue')
  delete overdue.latestUpdate
  state.updateTargets = [target('x'), overdue]
  for (const view of ['recent', 'overdue', 'at-risk', 'missing', 'stale', 'for-me']) {
    await expect(readUpdateFeed(reader, view)).rejects.toMatchObject({ code: 'UpdateFeedDuplicateTarget' })
  }
  overdue.archivedAt = '2026-08-02T00:00:00.000Z'
  await expect(readUpdateFeed({ ...reader, authorizeTarget: async () => undefined })).rejects.toMatchObject({ code: 'UpdateFeedDuplicateTarget' })
})

test('applies saved dimensions before top-N and rechecks access on every saved-feed read', async () => {
  const targets = Array.from({ length: 150 }, (_, i) => target(String(i).padStart(3, '0')))
  const chosen = targets[149]
  if (!chosen?.latestUpdate) throw new Error('Missing fixture')
  chosen.latestUpdate.health = 'off-track'
  chosen.updateState = 'overdue'
  const state = await snapshot(targets)
  let allowed = true
  const reader = { memberKey: 'reader', readSnapshot: async () => state, authorizeTarget: async (summary: PlanningUpdateTargetSummary) => allowed ? summary : undefined, filterScope: async (summary: PlanningUpdateTargetSummary) => ({ ...(summary.target.type === 'project' ? summary.target : {}), portfolioIds: ['portfolio'] }) }
  const filters: UpdateFeedFilters = { teamIds: ['team', 'other'], projects: [{ teamId: 'team', projectId: '149' }], portfolioIds: ['portfolio'], initiativeIds: [], health: ['off-track'], updateStates: ['overdue'] }
  expect(await readUpdateFeed(reader, 'recent', '1', filters)).toMatchObject({ total: 1, truncated: false, entries: [{ target: { projectId: '149' }, health: 'off-track', updateState: 'overdue' }] })
  expect((await readUpdateFeed(reader, 'recent', '1', { ...filters, teamIds: ['denied'] })).total).toBe(0)
  expect((await readUpdateFeed(reader, 'recent', '1', { ...filters, updateStates: ['current'] })).total).toBe(0)
  expect((await readUpdateFeed(reader, 'recent', '1', { ...filters, initiativeIds: ['portfolio'] })).total).toBe(0)
  allowed = false
  expect((await readUpdateFeed(reader, 'recent', '1', filters)).total).toBe(0)
})

test('ranks current relationships once, expires activity and never promotes attention alone into For me', async () => {
  const targets = ['combined', 'member', 'popular', 'denied'].map((id) => {
    const item = target(id)
    item.cadence = undefined
    if (item.latestUpdate) item.latestUpdate.authorMemberKey = 'another-member'
    return item
  })
  const state = await snapshot(targets)
  const now = Date.parse('2026-08-15T00:00:00.000Z')
  const reader = { expandedSignals: true, memberKey: ' Reader ', now: () => now, readSnapshot: async () => state, authorizeTarget: async (item: PlanningUpdateTargetSummary) => item.target.type === 'project' && item.target.projectId !== 'denied' ? item : undefined, readSignals: async (items: readonly PlanningUpdateTargetSummary[]): Promise<UpdateFeedTargetSignals[]> => {
    expect(items).toHaveLength(3)
    return items.map(({ target }) => ({ target, projectMember: target.type === 'project' && target.projectId !== 'popular', watching: target.type === 'project' && target.projectId === 'combined', activity: { target, version: 1, revision: 1, commentAt: '2026-08-14T00:00:00.000Z', reactionAt: '2026-08-14T00:00:00.000Z', participants: target.type === 'project' && target.projectId === 'combined' ? [{ memberKey: 'reader', at: '2026-08-01T00:00:00.000Z' }] : [] } }))
  } }
  const feed = await readUpdateFeed(reader, 'for-me')
  expect(feed.entries).toHaveLength(2)
  expect(feed.entries[0]).toMatchObject({ reasons: ['project-member', 'watching', 'recent-interaction'], relevance: 9, attention: { score: 3, reasons: ['recent-comment', 'recent-reaction'] } })
  expect(JSON.stringify(feed)).not.toContain('participants')
  expect((await readUpdateFeed({ ...reader, now: () => now + 31 * 86_400_000 }, 'for-me')).entries[0]).toMatchObject({ relevance: 7, reasons: ['project-member', 'watching'], attention: { score: 0, reasons: [] } })
  expect((await readUpdateFeed({ ...reader, now: () => now - 31 * 86_400_000 }, 'for-me')).entries[0]?.attention?.score).toBe(0)
  const redacted = await readUpdateFeed({ ...reader, authorizeTarget: async (item) => item.target.type === 'project' && item.target.projectId !== 'denied' ? { ...item, latestUpdate: undefined } : undefined }, 'for-me')
  expect(redacted.entries[0]).toMatchObject({ relevance: 7, attention: { score: 0, reasons: [] } })
  const newVersion = targets[0]?.latestUpdate
  if (!newVersion) throw new Error('Missing latest fixture')
  newVersion.version = 2
  expect((await readUpdateFeed(reader, 'for-me')).entries[0]).toMatchObject({ relevance: 7, attention: { score: 0, reasons: [] } })
})
