import { expect, test } from 'bun:test'
import type { PlanningUpdateCadence, ProjectCharterUpdateOwnerSync } from '@mukuroji/contracts'
import { PlanningError } from '../planning'
import { syncCharterUpdateOwner, type CharterUpdateOwnerSyncPorts } from './charter-update-owner-sync'

/** Recipient the fake ports resolve. */
type FakeRecipient = {
  /** Member key. */
  memberKey: string
}

/** Cadence the fake Planning read returns. */
const CADENCE: PlanningUpdateCadence = {
  updateOwnerMemberKey: 'old-owner',
  cadence: { unit: 'week', count: 1 },
  timeZone: 'Asia/Tokyo',
  nextDueAt: '2026-12-01T00:00:00.000Z',
  reminderHoursBefore: 24,
  escalationMemberKey: 'escalation',
}

/**
 * Builds fake ports that record the cadence writes and their conditions.
 *
 * @param overrides - Ports to replace.
 * @returns The ports and the recorded writes and failures.
 */
function createPorts(overrides: Partial<CharterUpdateOwnerSyncPorts<string, FakeRecipient, string>> = {}) {
  const writes: Array<{ cadence: PlanningUpdateCadence; expectedRevision: number; checks: string[] }> = []
  const failures: unknown[] = []
  let revision = 0
  const ports: CharterUpdateOwnerSyncPorts<string, FakeRecipient, string> = {
    readTarget: async () => {
      revision += 1
      return { read: `read-${revision}`, revision, cadence: CADENCE, archived: false }
    },
    mayChangeCadence: async () => true,
    resolveRecipient: async (_read, memberKey) => ({ memberKey }),
    readCharterOwner: async () => 'new-owner',
    createAuthorizationChecks: (recipients) => recipients.map((recipient) => `member:${recipient.memberKey}`),
    createCharterOwnerCheck: async (owner) => `charter:${owner}`,
    writeCadence: async (_read, cadence, expectedRevision, checks) => {
      writes.push({ cadence, expectedRevision, checks })
    },
    reportFailure: (error) => failures.push(error),
    ...overrides,
  }
  return { ports, writes, failures }
}

test('moves the update owner under the recipient and charter owner conditions', async () => {
  const { ports, writes } = createPorts()
  await expect(syncCharterUpdateOwner(ports, 'new-owner')).resolves.toBe('synced')
  expect(writes).toEqual([{
    cadence: { ...CADENCE, updateOwnerMemberKey: 'new-owner' },
    expectedRevision: 1,
    // Without an explicit reviewer the escalation recipient reviews, so it is checked twice.
    checks: ['member:new-owner', 'member:escalation', 'member:escalation', 'charter:new-owner'],
  }])
})

test('reports each refusal without writing the cadence', async () => {
  for (const [overrides, result] of [
    [{ readTarget: async () => undefined }, 'not-configured'],
    [{ readTarget: async () => ({ read: 'r', revision: 1, cadence: CADENCE, archived: true }) }, 'not-configured'],
    [{ readTarget: async () => ({ read: 'r', revision: 1, cadence: { ...CADENCE, updateOwnerMemberKey: 'NEW-OWNER' }, archived: false }) }, 'unchanged'],
    [{ mayChangeCadence: async () => false }, 'not-permitted'],
    [{ resolveRecipient: async (_read: string, memberKey: string) => memberKey === 'new-owner' ? undefined : { memberKey } }, 'owner-not-eligible'],
    [{ resolveRecipient: async (_read: string, memberKey: string, role: string) => role === 'viewer' ? undefined : { memberKey } }, 'failed'],
    [{ resolveRecipient: async (_read: string, memberKey: string, _role: string, permission?: string) => permission ? undefined : { memberKey } }, 'failed'],
    [{ readCharterOwner: async () => 'newer-owner' }, 'superseded'],
  ] satisfies Array<[Partial<CharterUpdateOwnerSyncPorts<string, FakeRecipient, string>>, ProjectCharterUpdateOwnerSync]>) {
    const { ports, writes } = createPorts(overrides)
    await expect(syncCharterUpdateOwner(ports, 'new-owner')).resolves.toBe(result)
    expect(writes).toEqual([])
  }
})

test('reads Planning again after a revision conflict and gives up after three attempts', async () => {
  let attempts = 0
  const { ports, failures } = createPorts({
    writeCadence: async (_read, _cadence, expectedRevision) => {
      attempts += 1
      if (expectedRevision < 3) throw new PlanningError(409, 'PlanningRevisionConflict', 'moved')
    },
  })
  await expect(syncCharterUpdateOwner(ports, 'new-owner')).resolves.toBe('synced')
  expect(attempts).toBe(3)
  expect(failures).toEqual([])

  const always = createPorts({
    writeCadence: async () => {
      throw new PlanningError(409, 'PlanningRevisionConflict', 'moved')
    },
  })
  await expect(syncCharterUpdateOwner(always.ports, 'new-owner')).resolves.toBe('failed')
  expect(always.failures).toHaveLength(1)
})

test('treats a failed authorization fence as superseded only when the charter moved on', async () => {
  let owner = 'new-owner'
  const { ports } = createPorts({
    readCharterOwner: async () => owner,
    writeCadence: async () => {
      owner = 'newer-owner'
      throw new PlanningError(409, 'PlanningAuthorizationChanged', 'changed')
    },
  })
  await expect(syncCharterUpdateOwner(ports, 'new-owner')).resolves.toBe('superseded')

  const unchanged = createPorts({
    writeCadence: async () => {
      throw new PlanningError(409, 'PlanningAuthorizationChanged', 'changed')
    },
  })
  await expect(syncCharterUpdateOwner(unchanged.ports, 'new-owner')).resolves.toBe('failed')
})
