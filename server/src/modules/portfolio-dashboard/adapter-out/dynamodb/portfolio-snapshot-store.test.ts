import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { InMemoryTeamPortfolioSnapshotStore } from './portfolio-snapshot-store'

/** Audit context of the test writes. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'u', kind: 'user', displayName: 'U' },
  idempotencyKey: 'key',
  request: { method: 'PUT', path: '/x', body: {} },
  source: { kind: 'api' },
})

/**
 * Builds a save of the November snapshot at one revision.
 *
 * @param revision - Revision the save writes.
 * @returns The write input.
 */
function save(revision: number) {
  return {
    snapshot: { workspaceId: 'w', teamId: 't', month: '2026-11', capturedAt: `2026-11-2${revision}T00:00:00.000Z`, revision, projects: [] },
    callerAuthorization: [],
    auditContext,
  }
}

test('replaces a month only from the revision the capture read', async () => {
  const store = new InMemoryTeamPortfolioSnapshotStore()
  await store.put(save(1))
  await expect(store.put(save(1))).rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotConflict' })
  await store.put(save(2))
  await expect(store.put(save(2))).rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotConflict' })
  expect(await store.get('w', 't', '2026-11')).toMatchObject({ revision: 2, capturedAt: '2026-11-22T00:00:00.000Z' })
  await expect(store.put(save(0))).rejects.toMatchObject({ status: 400 })
})
