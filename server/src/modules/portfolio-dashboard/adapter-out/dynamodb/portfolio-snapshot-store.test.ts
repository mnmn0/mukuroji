import { expect, test } from 'bun:test'
import type { PortfolioProjectMetrics } from '@mukuroji/contracts'
import { createMutationAuditContext } from '../../../audit'
import { captureTeamPortfolioSnapshot } from '../../application/team-portfolio'
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
 * @param keyHash - Idempotency key hash of the save.
 * @returns The write input.
 */
function save(revision: number, keyHash = `key-${revision}`) {
  return {
    snapshot: { workspaceId: 'w', teamId: 't', month: '2026-11', capturedAt: `2026-11-2${revision}T00:00:00.000Z`, revision, projects: [] },
    callerAuthorization: [],
    auditContext,
    receipt: { keyHash, requestFingerprint: 'f', month: '2026-11', revision },
  }
}

test('replaces a month only from the revision the capture read', async () => {
  const store = new InMemoryTeamPortfolioSnapshotStore()
  await store.put(save(1))
  await expect(store.put(save(1, 'other'))).rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotConflict' })
  await store.put(save(2))
  await expect(store.put(save(2, 'another'))).rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotConflict' })
  await expect(store.put(save(3, 'key-1'))).rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotConflict' })
  expect(await store.get('w', 't', '2026-11')).toMatchObject({ revision: 2, capturedAt: '2026-11-22T00:00:00.000Z' })
  expect(await store.getReceipt('w', 't', 'key-2')).toEqual({ keyHash: 'key-2', requestFingerprint: 'f', month: '2026-11', revision: 2 })
  await expect(store.put(save(0))).rejects.toMatchObject({ status: 400 })
})

test('returns the completed save on a retry with the same key without capturing again', async () => {
  const store = new InMemoryTeamPortfolioSnapshotStore()
  let captures = 0
  const ports = {
    store,
    computeProjects: async (): Promise<PortfolioProjectMetrics[]> => {
      captures += 1
      return []
    },
  }
  const input = {
    workspaceId: 'w',
    teamId: 't',
    month: '2026-11',
    currentMonth: '2026-11',
    now: new Date('2026-11-23T00:00:00.000Z'),
    canCapture: true,
    callerAuthorization: [],
    auditContext,
    idempotencyKeyHash: 'retry-key',
    requestFingerprint: 'fingerprint',
  }

  const first = await captureTeamPortfolioSnapshot(ports, input)
  const retried = await captureTeamPortfolioSnapshot(ports, { ...input, now: new Date('2026-11-23T00:01:00.000Z') })
  expect(retried).toEqual(first)
  expect(captures).toBe(1)

  await expect(captureTeamPortfolioSnapshot(ports, { ...input, requestFingerprint: 'other' }))
    .rejects.toMatchObject({ status: 409, code: 'PortfolioSnapshotIdempotencyConflict' })
  await expect(captureTeamPortfolioSnapshot(ports, { ...input, idempotencyKeyHash: 'new', canCapture: false }))
    .rejects.toMatchObject({ status: 403 })
  await expect(captureTeamPortfolioSnapshot(ports, { ...input, idempotencyKeyHash: 'new', month: '2026-10' }))
    .rejects.toMatchObject({ status: 400 })
  const second = await captureTeamPortfolioSnapshot(ports, { ...input, idempotencyKeyHash: 'new' })
  expect(second.revision).toBe(2)
  expect(captures).toBe(2)
})
