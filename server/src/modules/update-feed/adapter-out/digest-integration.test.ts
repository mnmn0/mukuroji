import { expect, test } from 'bun:test'
import type { PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import { InMemoryPlanningClient } from '../../planning/planning'
import { InMemoryUpdateFeedDigestStore } from './digest-store'
import { InMemoryUpdateFeedReadStateStore } from './read-state-store'
import { parseDigestPreferences, parseDigestState, previewUpdateFeedDigest, replaceDigestPreferences } from '../application/digest'
import type { UpdateFeedReader } from '../application/read-update-feed'
import { InMemorySavedUpdateFeedsStore } from './saved-feeds-store'

const now = Date.parse('2026-10-03T12:00:00Z')

test('six overlapping sources authorize and enrich one 2000-target projection with lazy scopes', async () => {
  const f = await fixture(2000)
  const definitions = new InMemorySavedUpdateFeedsStore()
  const feeds = Array.from({ length: 6 }, (_, index) => ({ id: `source-${index}`, name: `Source ${index}`, view: 'recent' as const, filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }))
  await definitions.replace('w', 'reader', { expectedRevision: 0, feeds })
  f.reader.readSavedFeeds = () => definitions.get('w', 'reader')
  await replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: 1, preferences: { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: feeds.map((feed) => feed.id) } } }, definitions)
  let snapshotReads = 0
  let authorizationCalls = 0
  let finalChecks = 0
  let signalsCalls = 0
  const scopes = new Set<string>()
  f.reader.expandedSignals = true
  f.reader.readSnapshot = async () => { snapshotReads++; return f.snapshot }
  f.reader.authorizeTarget = async (target) => {
    authorizationCalls++
    if (snapshotReads === 2) finalChecks++
    return target.target.type === 'project' && target.target.projectId === 'project-0' ? undefined : target
  }
  f.reader.readSignals = async (targets) => {
    signalsCalls++
    expect(targets).toHaveLength(1999)
    expect(authorizationCalls).toBe(2000)
    return []
  }
  f.reader.filterScope = async (target) => {
    const key = JSON.stringify(target.target)
    expect(scopes.has(key)).toBe(false)
    expect(key).not.toContain('"project-0"')
    scopes.add(key)
    return { portfolioIds: [] }
  }
  let readKeys = 0
  const read = f.readState.getMany.bind(f.readState)
  f.readState.getMany = async (workspaceId, memberKey, reports) => { readKeys += reports.length; return read(workspaceId, memberKey, reports) }
  const result = await f.run()
  expect(snapshotReads).toBe(2)
  expect(authorizationCalls).toBe(2100)
  expect(finalChecks).toBe(100)
  expect(signalsCalls).toBe(1)
  expect(scopes.size).toBe(1999)
  expect(readKeys).toBe(100)
  expect(result.entries).toHaveLength(50)
  expect(result.truncated).toBe(true)
  expect(result.entries.some((entry) => entry.target.type === 'project' && entry.target.projectId === 'project-0')).toBe(false)
})

test('six disjoint sources bound final ACL and read-state work to 600 selected candidates', async () => {
  const f = await fixture(2000)
  const definitions = new InMemorySavedUpdateFeedsStore()
  const feeds = Array.from({ length: 6 }, (_, index) => ({ id: `source-${index}`, name: `Source ${index}`, view: 'recent' as const, filters: { teamIds: [`group-${index}`], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }))
  await definitions.replace('w', 'reader', { expectedRevision: 0, feeds })
  f.reader.readSavedFeeds = () => definitions.get('w', 'reader')
  await replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: 1, preferences: { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: feeds.map((feed) => feed.id) } } }, definitions)
  let authorizations = 0
  let scopeCalls = 0
  let readKeys = 0
  f.reader.authorizeTarget = async (target) => { authorizations++; return target }
  f.reader.filterScope = async (target) => { scopeCalls++; return { portfolioIds: [], teamId: `group-${target.target.type === 'project' ? Number(target.target.projectId.split('-')[1]) % 6 : 0}` } }
  const read = f.readState.getMany.bind(f.readState)
  f.readState.getMany = async (workspaceId, memberKey, reports) => { expect(reports.length).toBeLessThanOrEqual(100); readKeys += reports.length; return read(workspaceId, memberKey, reports) }
  const result = await f.run()
  expect(authorizations).toBe(2600)
  expect(scopeCalls).toBe(2000)
  expect(readKeys).toBe(600)
  expect(result.entries).toHaveLength(50)
  expect(result.truncated).toBe(true)
})

test('projection bound rejects 2001 targets before authorization and standard-only sources never resolve scopes', async () => {
  const f = await fixture(2001)
  let authorizations = 0
  f.reader.authorizeTarget = async (target) => { authorizations++; return target }
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedTargetLimitExceeded' })
  expect(authorizations).toBe(0)
  const g = await fixture(2000)
  let scopes = 0
  g.reader.filterScope = async () => { scopes++; return { portfolioIds: [] } }
  expect((await g.run()).entries).toHaveLength(50)
  expect(scopes).toBe(0)
})

test('custom digest sources resolve only owned current definitions, deduplicate and reauthorize', async () => {
  const f = await fixture(60)
  const definitions = new InMemorySavedUpdateFeedsStore()
  const filters = { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] }
  await definitions.replace('w', 'reader', { expectedRevision: 0, feeds: [{ id: 'mine', name: 'Private selection name', view: 'recent', filters }] })
  let reads = 0
  f.reader.readSavedFeeds = () => { reads++; return definitions.get('w', 'reader') }
  await replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: 1, preferences: { enabled: true, frequency: 'daily', views: ['recent'], savedFeeds: { revision: 1, ids: ['mine'] } } }, definitions)
  const result = await f.run()
  expect(reads).toBe(2)
  expect(result.entries).toHaveLength(50)
  expect(result.truncated).toBe(true)
  expect(JSON.stringify(await f.store.get('w', 'reader'))).not.toContain('Private selection name')
  expect(JSON.stringify(result)).not.toContain('Private selection name')
  f.reader.authorizeTarget = async () => undefined
  expect((await f.run()).entries).toHaveLength(0)
  await definitions.replace('w', 'reader', { expectedRevision: 1, feeds: [] })
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestSelectionStale' })
  await expect(replaceDigestPreferences(f.store, 'w', 'other', { expectedRevision: 0, preferences: { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: ['mine'] } } }, definitions)).rejects.toMatchObject({ code: 'UpdateFeedDigestSelectionStale' })
})

test('saved filters constrain custom-only digests and changing definitions aborts generation', async () => {
  const f = await fixture(2)
  const definitions = new InMemorySavedUpdateFeedsStore()
  const feeds = [{ id: 'mine', name: 'One project', view: 'recent' as const, filters: { teamIds: [], projects: [{ teamId: 'team', projectId: 'project-0' }], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }]
  await definitions.replace('w', 'reader', { expectedRevision: 0, feeds })
  f.reader.readSavedFeeds = () => definitions.get('w', 'reader')
  await replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: 1, preferences: { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: ['mine'] } } }, definitions)
  expect((await f.run()).entries.map((entry) => entry.target)).toEqual([{ type: 'project', teamId: 'team', projectId: 'project-0' }])
  let reads = 0
  f.reader.readSnapshot = async () => {
    if (++reads === 2) await definitions.replace('w', 'reader', { expectedRevision: 1, feeds: [{ ...feeds[0]!, name: 'Changed' }] })
    return f.snapshot
  }
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestSelectionStale' })
  expect(parseDigestPreferences({ enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 2, ids: ['mine'] } }).savedFeeds?.revision).toBe(2)
  expect(() => parseDigestPreferences({ enabled: true, frequency: 'daily', views: ['recent'], savedFeeds: { revision: 1, ids: ['mine', 'mine'] } })).toThrow()
  expect(() => parseDigestPreferences({ enabled: true, frequency: 'daily', views: ['for-me', 'recent', 'at-risk', 'missing', 'stale', 'overdue'], savedFeeds: { revision: 1, ids: ['mine'] } })).toThrow()
})

test('custom source permutations normalize API input and select the same fifty reports from legacy rows', async () => {
  const results = []
  for (const ids of [['a-recent', 'z-risk'], ['z-risk', 'a-recent']]) {
    const f = await fixture(51)
    f.snapshot.updateTargets.forEach((target, index) => {
      if (target.latestUpdate) {
        target.latestUpdate.health = index === 50 ? 'at-risk' : 'on-track'
        target.latestUpdate.createdAt = index === 50 ? '2026-10-02T00:00:00Z' : '2026-10-03T00:00:00Z'
      }
    })
    const definitions = new InMemorySavedUpdateFeedsStore()
    const filters = { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] }
    await definitions.replace('w', 'reader', { expectedRevision: 0, feeds: [{ id: 'z-risk', name: 'Risks', view: 'at-risk', filters }, { id: 'a-recent', name: 'Recent', view: 'recent', filters }] })
    f.reader.readSavedFeeds = () => definitions.get('w', 'reader')
    const preferences = parseDigestPreferences({ enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids } })
    expect(preferences.savedFeeds?.ids).toEqual(['a-recent', 'z-risk'])
    await replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: 1, preferences }, definitions)
    const legacy = await f.store.get('w', 'reader')
    legacy.preferences.savedFeeds = { revision: 1, ids }
    legacy.history = [{ id: 'daily:2026-10-03', status: 'completed', attempts: 1, token: 'legacy', leaseUntil: 0, count: 50 }]
    const result = await previewUpdateFeedDigest(f.reader, f.readState, { get: async () => legacy, replace: f.store.replace.bind(f.store) }, 'w', now)
    expect(result.entries).toHaveLength(50)
    expect(result.entries.some((entry) => entry.target.type === 'project' && entry.target.projectId === 'project-50')).toBe(false)
    results.push(result.entries.map((entry) => entry.target))
  }
  expect(results[0]).toEqual(results[1])
})

test('selection permutations normalize API input and choose the same fifty reports from legacy rows', async () => {
  const results = []
  for (const views of [['recent', 'at-risk'], ['at-risk', 'recent']]) {
    const f = await fixture(51)
    f.snapshot.updateTargets.forEach((target, index) => {
      if (target.latestUpdate) {
        target.latestUpdate.health = index === 50 ? 'at-risk' : 'on-track'
        target.latestUpdate.createdAt = index === 50 ? '2026-10-02T00:00:00Z' : '2026-10-03T00:00:00Z'
      }
    })
    const preferences = parseDigestPreferences({ enabled: true, frequency: 'daily', views })
    expect(preferences.views).toEqual(['recent', 'at-risk'])
    const current = await f.store.get('w', 'reader')
    await replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: current.revision, preferences })
    // Simulate an existing noncanonical adapter row, bypassing input normalization.
    const legacy = await f.store.get('w', 'reader')
    legacy.history = [{ id: 'daily:2026-10-03', status: 'completed', attempts: 1, token: 'legacy', leaseUntil: 0, count: 50 }]
    legacy.preferences.views.reverse()
    if (views[0] === 'recent') legacy.preferences.views.reverse()
    const store = { get: async () => legacy, replace: f.store.replace.bind(f.store) }
    const result = await previewUpdateFeedDigest(f.reader, f.readState, store, 'w', now)
    expect(result.entries).toHaveLength(50)
    results.push(result.entries.map((entry) => entry.target))
  }
  expect(results[0]).toEqual(results[1])
})

/** Creates canonical reports and isolated personal persistence with no delivery dependency. */
async function fixture(count = 1) {
  const targets: PlanningUpdateTargetSummary[] = Array.from({ length: count }, (_, index) => ({
    target: { type: 'project', teamId: 'team', projectId: `project-${index}` }, latestVersion: 1,
    updateState: 'current', updatedAt: '2026-10-03T00:00:00Z',
    latestUpdate: { id: `report-${index}`, version: 1, health: 'at-risk', risk: 'none', summary: 'Confidential canonical summary', authorMemberKey: 'reader', coveredDueAt: '2026-10-03T00:00:00Z', createdAt: '2026-10-03T00:00:00Z', progressSnapshot: { percent: 20, linkedWorkItemCount: 2 }, capturedScope: { teamId: 'team', projectId: `project-${index}` } },
  }))
  const snapshot = { ...await new InMemoryPlanningClient().get('w', { workItems: [] }), updateTargets: targets }
  const reader: UpdateFeedReader = { memberKey: 'reader', now: () => now, readSnapshot: async () => snapshot, authorizeTarget: async (target) => target }
  const store = new InMemoryUpdateFeedDigestStore()
  const readState = new InMemoryUpdateFeedReadStateStore()
  await replaceDigestPreferences(store, 'w', 'reader', { expectedRevision: 0, preferences: { enabled: true, frequency: 'daily', views: ['recent', 'at-risk', 'for-me'] }, memberKey: 'attacker' })
  return { snapshot, reader, store, readState, run: () => previewUpdateFeedDigest(reader, readState, store, 'w', now) }
}

test('deduplicates overlapping views, caps fifty, persists no content and never changes canonical reports', async () => {
  const f = await fixture(60)
  const before = structuredClone(f.snapshot)
  const result = await f.run()
  expect(result).toMatchObject({ id: 'daily:2026-10-03', replay: false, truncated: true, transport: 'preview' })
  expect(result.entries).toHaveLength(50)
  expect(new Set(result.entries.map((entry) => JSON.stringify(entry.target))).size).toBe(50)
  const persisted = await f.store.get('w', 'reader')
  expect(persisted.history).toHaveLength(1)
  expect(persisted.history[0]).toMatchObject({ status: 'completed', attempts: 1, count: 50 })
  expect(JSON.stringify(persisted)).not.toContain('Confidential')
  expect(JSON.stringify(persisted)).not.toContain('project-')
  expect(f.snapshot).toEqual(before)
})

test('replays reauthorize content and recheck read state without creating duplicate receipts', async () => {
  const f = await fixture(2)
  expect((await f.run()).entries).toHaveLength(2)
  await f.readState.set('w', 'reader', { target: f.snapshot.updateTargets[0]!.target, version: 1, read: true, expectedRevision: 0 })
  expect((await f.run()).entries).toHaveLength(1)
  f.reader.authorizeTarget = async () => undefined
  expect((await f.run()).entries).toHaveLength(0)
  expect((await f.store.get('w', 'reader')).history).toHaveLength(1)
  expect((await f.store.get('w', 'reader')).history[0]?.attempts).toBe(1)
})

test('final authorization and read-state checks drop access lost or read during generation', async () => {
  const f = await fixture()
  let reads = 0
  f.reader.readSnapshot = async () => {
    reads += 1
    if (reads === 2) f.snapshot.updateTargets[0]!.archivedAt = new Date(now).toISOString()
    return f.snapshot
  }
  expect((await f.run()).entries).toHaveLength(0)
  const g = await fixture()
  let calls = 0
  g.reader.readSnapshot = async () => {
    if (++calls === 2) await g.readState.set('w', 'reader', { target: g.snapshot.updateTargets[0]!.target, version: 1, read: true, expectedRevision: 0 })
    return g.snapshot
  }
  expect((await g.run()).entries).toHaveLength(0)
})

test('final read-state wins for both transitions after bounded overlapping view collection', async () => {
  const f = await fixture(2)
  const first = f.snapshot.updateTargets[0]!.target
  const second = f.snapshot.updateTargets[1]!.target
  await f.readState.set('w', 'reader', { target: first, version: 1, read: true, expectedRevision: 0 })
  let reads = 0
  f.reader.readSnapshot = async () => {
    if (++reads === 2) {
      await f.readState.set('w', 'reader', { target: first, version: 1, read: false, expectedRevision: 1 })
      await f.readState.set('w', 'reader', { target: second, version: 1, read: true, expectedRevision: 0 })
    }
    return f.snapshot
  }
  const result = await f.run()
  expect(reads).toBe(2)
  expect(result.entries.map((entry) => entry.target)).toEqual([first])
  expect(result.entries[0]?.readState?.read).toBe(false)
  expect((await f.store.get('w', 'reader')).history[0]?.count).toBe(1)
})

test('claims fence concurrent generators and reclaim expired leases with bounded attempts', async () => {
  const f = await fixture()
  const state = await f.store.get('w', 'reader')
  await f.store.replace('w', 'reader', { ...state, history: [{ id: 'daily:2026-10-03', status: 'pending', token: 'old', attempts: 1, leaseUntil: now + 1, count: 0 }] })
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  expect((await previewUpdateFeedDigest(f.reader, f.readState, f.store, 'w', now + 2)).entries).toHaveLength(1)
  expect((await f.store.get('w', 'reader')).history[0]?.attempts).toBe(2)
  const g = await fixture()
  const outcomes = await Promise.allSettled([g.run(), g.run()])
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
  expect((await g.store.get('w', 'reader')).history).toHaveLength(1)
})

test('failure propagates, stores bodyless failure and permits only three attempts', async () => {
  const f = await fixture()
  f.reader.readSnapshot = async () => { throw new Error('storage unavailable: sensitive') }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect(f.run()).rejects.toThrow('storage unavailable')
    expect((await f.store.get('w', 'reader')).history[0]).toMatchObject({ attempts: attempt, status: 'failed', leaseUntil: 0 })
  }
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestAttemptsExhausted' })
  expect(JSON.stringify(await f.store.get('w', 'reader'))).not.toContain('sensitive')
})

test('isolates preferences, rejects stale settings, defaults disabled and uses UTC Monday weeks', async () => {
  const f = await fixture()
  expect((await f.store.get('other', 'reader')).preferences.enabled).toBe(false)
  expect((await f.store.get('w', 'other')).preferences.enabled).toBe(false)
  await expect(previewUpdateFeedDigest(f.reader, f.readState, f.store, 'other', now)).rejects.toMatchObject({ code: 'UpdateFeedDigestDisabled' })
  await expect(replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: 0, preferences: { enabled: false, frequency: 'daily', views: ['recent'] } })).rejects.toMatchObject({ status: 409 })
  await replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: 1, preferences: { enabled: true, frequency: 'weekly', views: ['recent'] } })
  expect((await f.run()).id).toBe('weekly:2026-09-28')
  expect((await previewUpdateFeedDigest(f.reader, f.readState, f.store, 'w', Date.parse('2026-10-05T00:00:00Z'))).id).toBe('weekly:2026-10-05')
})

test('rejects malformed preferences and receipts and retains twenty intervals only', async () => {
  for (const bad of [null, {}, { enabled: true, frequency: 'hourly', views: ['recent'] }, { enabled: true, frequency: 'daily', views: ['recent', 'recent'] }, { enabled: true, frequency: 'daily', views: ['bad'] }, { enabled: true, frequency: 'daily', views: [] }]) expect(() => parseDigestPreferences(bad)).toThrow()
  expect(() => parseDigestState({ revision: 1, preferences: { enabled: true, frequency: 'daily', views: ['recent'] }, history: [{}] })).toThrow()
  const f = await fixture()
  for (let day = 0; day < 22; day++) await previewUpdateFeedDigest(f.reader, f.readState, f.store, 'w', now + day * 86_400_000)
  expect((await f.store.get('w', 'reader')).history).toHaveLength(20)
})

test('settings changed during generation fence completion and return no stale preview', async () => {
  const f = await fixture()
  let changed = false
  f.reader.readSnapshot = async () => {
    if (!changed) {
      changed = true
      const state = await f.store.get('w', 'reader')
      await replaceDigestPreferences(f.store, 'w', 'reader', { expectedRevision: state.revision, preferences: { ...state.preferences, enabled: false } })
    }
    return f.snapshot
  }
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  expect((await f.store.get('w', 'reader')).preferences.enabled).toBe(false)
})

test('an expired worker cannot finish or overwrite the successor receipt', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const oldReader: UpdateFeedReader = { ...f.reader, readSnapshot: async () => { started?.(); await gate; return f.snapshot } }
  const old = previewUpdateFeedDigest(oldReader, f.readState, f.store, 'w', now)
  await waiting
  await previewUpdateFeedDigest(f.reader, f.readState, f.store, 'w', now + 60_001)
  const before = await f.store.get('w', 'reader')
  release?.()
  await expect(old).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  expect(await f.store.get('w', 'reader')).toEqual(before)
  expect(before.history[0]).toMatchObject({ status: 'completed', attempts: 2 })
})

test('source bounds remain explicit and new daily intervals receive independent receipts', async () => {
  const f = await fixture(101)
  for (const target of f.snapshot.updateTargets) await f.readState.set('w', 'reader', { target: target.target, version: 1, read: true, expectedRevision: 0 })
  expect(await f.run()).toMatchObject({ entries: [], truncated: true })
  expect((await previewUpdateFeedDigest(f.reader, f.readState, f.store, 'w', Date.parse('2026-10-04T00:00:00Z'))).id).toBe('daily:2026-10-04')
  expect((await f.store.get('w', 'reader')).history).toHaveLength(2)
})

test('a changed Planning revision aborts before content returns', async () => {
  const f = await fixture()
  let reads = 0
  f.reader.readSnapshot = async () => ({ ...f.snapshot, revision: f.snapshot.revision + reads++ })
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  expect((await f.store.get('w', 'reader')).history[0]?.status).toBe('failed')
})
