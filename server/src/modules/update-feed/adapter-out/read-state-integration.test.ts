import { expect, test } from 'bun:test'
import type { PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import { InMemoryPlanningClient } from '../../planning/planning'
import { InMemoryUpdateFeedReadStateStore } from '../adapter-out/read-state-store'
import { readUpdateFeed } from '../application/read-update-feed'
import { parseUpdateFeedReadState, setUpdateFeedReadState, updateFeedReportKey, withUpdateFeedReadState } from '../application/read-state'

/** Creates a visible versioned report without history or annotations. */
async function fixture() {
  const summary: PlanningUpdateTargetSummary = {
    target: { type: 'project', teamId: 'team', projectId: 'project' }, latestVersion: 1,
    updateState: 'current', updatedAt: '2026-08-01T00:00:00Z',
    latestUpdate: { id: 'report', version: 1, health: 'on-track', risk: 'none', summary: 'Canonical', authorMemberKey: 'author', coveredDueAt: '2026-08-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', progressSnapshot: { percent: 20, linkedWorkItemCount: 2 }, capturedScope: { teamId: 'team', projectId: 'project' } },
  }
  const snapshot = { ...await new InMemoryPlanningClient().get('workspace', { workItems: [] }), updateTargets: [summary] }
  const reader = { memberKey: 'reader', readSnapshot: async () => snapshot, authorizeTarget: async (target: PlanningUpdateTargetSummary) => target }
  return { reader, summary, snapshot, input: { target: summary.target, version: 1, read: true, expectedRevision: 0 } }
}

test('persists across fresh feed readers while isolating members, workspaces, and new report versions', async () => {
  const { reader, snapshot, input } = await fixture()
  const store = new InMemoryUpdateFeedReadStateStore()
  const before = structuredClone(snapshot)
  expect(await setUpdateFeedReadState(reader, store, 'workspace', input)).toEqual({ read: true, revision: 1 })
  const feed = await readUpdateFeed({ ...reader })
  expect((await withUpdateFeedReadState(store, 'workspace', 'READER', feed)).entries[0]?.readState).toEqual({ read: true, revision: 1 })
  expect((await withUpdateFeedReadState(store, 'workspace', 'another', feed)).entries[0]?.readState?.read).toBe(false)
  expect((await withUpdateFeedReadState(store, 'other-workspace', 'reader', feed)).entries[0]?.readState?.read).toBe(false)
  expect((await store.getMany('workspace', 'reader', [{ ...input, version: 2 }])).size).toBe(0)
  await expect(setUpdateFeedReadState(reader, store, 'workspace', { ...input, read: false })).rejects.toMatchObject({ code: 'UpdateFeedReadStateConflict' })
  expect(await setUpdateFeedReadState(reader, store, 'workspace', { ...input, read: false, expectedRevision: 1 })).toEqual({ read: false, revision: 2 })
  expect(snapshot).toEqual(before)
})

test('rejects revoked, archived, moved-scope, and obsolete reports before writes', async () => {
  const { reader, summary, input } = await fixture()
  const store = new InMemoryUpdateFeedReadStateStore()
  await expect(setUpdateFeedReadState({ ...reader, authorizeTarget: async () => undefined }, store, 'workspace', input)).rejects.toMatchObject({ status: 404 })
  await expect(setUpdateFeedReadState({ ...reader, authorizeTarget: async (target) => ({ ...target, latestUpdate: undefined }) }, store, 'workspace', input)).rejects.toMatchObject({ status: 404 })
  await expect(setUpdateFeedReadState(reader, store, 'workspace', { ...input, version: 2 })).rejects.toMatchObject({ status: 404 })
  summary.archivedAt = '2026-08-02T00:00:00Z'
  await expect(setUpdateFeedReadState(reader, store, 'workspace', input)).rejects.toMatchObject({ status: 404 })
  expect((await store.getMany('workspace', 'reader', [input])).size).toBe(0)
})

test('validates unknown commands and disambiguates identical local IDs', async () => {
  const { input } = await fixture()
  for (const bad of [null, [], { ...input, read: 'yes' }, { ...input, expectedRevision: -1 }, { ...input, version: 0 }, { ...input, target: { type: 'project', projectId: 'p' } }]) {
    expect(() => parseUpdateFeedReadState(bad)).toThrow()
  }
  expect(parseUpdateFeedReadState({ ...input, memberKey: 'attacker' })).toEqual(input)
  expect(updateFeedReportKey(input)).not.toEqual(updateFeedReportKey({ ...input, target: { type: 'project', teamId: 'other', projectId: 'project' } }))
})
