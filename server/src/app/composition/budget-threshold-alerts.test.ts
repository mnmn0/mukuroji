import { expect, test } from 'bun:test'
import type { TimeBudget } from '@mukuroji/contracts'
import { createBudgetThresholdReader, type BudgetThresholdReaderSources } from './budget-threshold-alerts'

/** Budget of the test Project, half used by its approved expense. */
const budget: TimeBudget = {
  schemaVersion: 1,
  workspaceId: 'w',
  teamId: 't',
  scopeType: 'project',
  scopeId: 'p',
  amountMinor: 10_000,
  currency: 'JPY',
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/**
 * Builds reader sources around one Project with one approved expense.
 *
 * @param overrides - Sources to change.
 * @returns The sources.
 */
function sources(overrides: Partial<BudgetThresholdReaderSources> = {}): BudgetThresholdReaderSources {
  return {
    readProjects: async () => [{ teamId: 't', projectId: 'p', ownerMemberKey: 'owner@example.com', managerMemberKeys: ['lead@example.com'] }],
    readProfile: async () => undefined,
    getBudget: async () => budget,
    listEntries: async () => [],
    listExpenses: async () => [{
      id: 'x1',
      teamId: 't',
      projectId: 'p',
      date: '2026-01-05',
      category: 'License',
      amountMinor: 5_000,
      currency: 'JPY',
      receiptFileIds: [],
      status: 'approved',
      submittedByMemberId: 'lead@example.com',
      submittedAt: '2026-01-05T00:00:00.000Z',
      revision: 2,
      createdAt: '2026-01-05T00:00:00.000Z',
      updatedAt: '2026-01-05T00:00:00.000Z',
    }],
    ...overrides,
  }
}

test('adds the members an Enterprise role makes managers of the Project', async () => {
  const now = new Date('2026-01-10T00:00:00.000Z')
  const [status] = await createBudgetThresholdReader(sources({
    readEnterpriseSnapshot: async () => ({
      customRoles: [],
      roleAssignments: [
        { workspaceId: 'w', assignmentId: 'a1', principalKind: 'member', principalId: 'owner@example.com', roleId: 'project:manager', scope: { workspaceId: 'w', kind: 'project', targetId: 'p', parentTeamId: 't' }, source: 'direct' },
        { workspaceId: 'w', assignmentId: 'a2', principalKind: 'member', principalId: 'lead@example.com', roleId: 'project:manager', scope: { workspaceId: 'w', kind: 'project', targetId: 'p', parentTeamId: 't' }, source: 'direct' },
      ],
    }),
  })).listProjectBudgetStatuses('w', now)
  expect(status).toMatchObject({ consumedPercent: 50, alertPercent: 90, ownerMemberKey: 'owner@example.com', managerMemberKeys: ['lead@example.com', 'owner@example.com'] })

  const [legacyOnly] = await createBudgetThresholdReader(sources()).listProjectBudgetStatuses('w', now)
  expect(legacyOnly?.managerMemberKeys).toEqual(['lead@example.com'])
})

test('skips a Workspace that is not active', async () => {
  const reader = createBudgetThresholdReader(sources({ readProfile: async () => ({ status: 'closing' }) }))
  expect(await reader.listProjectBudgetStatuses('w', new Date('2026-01-10T00:00:00.000Z'))).toEqual([])
})
