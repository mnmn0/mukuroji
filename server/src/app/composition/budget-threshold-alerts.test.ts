import { expect, test } from 'bun:test'
import type { EnterpriseIdentitySnapshot, EnterpriseRoleAssignment, TimeBudget } from '@mukuroji/contracts'
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
 * Builds an Enterprise snapshot of the test Workspace with the given role assignments.
 *
 * @param roleAssignments - Assignments in force.
 * @returns The snapshot.
 */
function enterprise(roleAssignments: EnterpriseRoleAssignment[]): EnterpriseIdentitySnapshot {
  return {
    workspaceId: 'w', identityProviders: [], domains: [], customRoles: [], groupMappings: [], roleAssignments,
    scimUsers: [], scimGroups: [], scimCredentials: [], serviceAccounts: [], breakGlassAccounts: [],
    provisioningRuns: [], provisioningLogs: [],
  }
}

/**
 * Builds a direct member assignment of a role on the test Project.
 *
 * @param principalId - Member key.
 * @param roleId - Role.
 * @returns The assignment.
 */
function grant(principalId: string, roleId: 'project:manager' | 'project:viewer'): EnterpriseRoleAssignment {
  return {
    workspaceId: 'w', assignmentId: `${principalId}-${roleId}`, principalKind: 'member', principalId, roleId,
    scope: { workspaceId: 'w', kind: 'project', targetId: 'p', parentTeamId: 't' }, source: 'direct',
  }
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
    listWorkspaceMembers: async () => ['owner', 'lead', 'boss'].map((name) => ({ memberKey: `${name}@example.com`, status: 'active' })),
    ...overrides,
  }
}

test('adds Enterprise managers and drops managers whose Enterprise role no longer manages the Project', async () => {
  const now = new Date('2026-01-10T00:00:00.000Z')
  const read = async (snapshot: EnterpriseIdentitySnapshot) =>
    (await createBudgetThresholdReader(sources({ readEnterpriseSnapshot: async () => snapshot })).listProjectBudgetStatuses('w', now))[0]

  expect(await read(enterprise([grant('owner@example.com', 'project:manager')]))).toMatchObject({
    consumedPercent: 50,
    alertPercent: 90,
    ownerMemberKey: 'owner@example.com',
    managerMemberKeys: ['lead@example.com', 'owner@example.com'],
  })
  // A role that only lets the lead view the Project wins over the lead's manager row.
  expect((await read(enterprise([grant('lead@example.com', 'project:viewer'), grant('boss@example.com', 'project:manager')])))?.managerMemberKeys)
    .toEqual(['boss@example.com'])
  // An owner whose role no longer manages the Project is not among the managers, so the alert goes
  // to the other managers instead.
  expect(await read(enterprise([grant('owner@example.com', 'project:viewer')]))).toMatchObject({ managerMemberKeys: ['lead@example.com'] })
  // A role given to a sign-in group could make the owner a manager or not, so the owner is not preferred.
  const withGroup = enterprise([{ ...grant('group-1', 'project:manager'), principalKind: 'directory-group' }])
  const unsure = await read(withGroup)
  expect(unsure?.ownerMemberKey).toBeUndefined()
  expect(unsure?.managerMemberKeys).toEqual(['lead@example.com'])

  const [legacyOnly] = await createBudgetThresholdReader(sources()).listProjectBudgetStatuses('w', now)
  expect(legacyOnly?.managerMemberKeys).toEqual(['lead@example.com'])
})

test('skips a Workspace that is not active', async () => {
  const reader = createBudgetThresholdReader(sources({ readProfile: async () => ({ status: 'closing' }) }))
  expect(await reader.listProjectBudgetStatuses('w', new Date('2026-01-10T00:00:00.000Z'))).toEqual([])
})

test('leaves out managers whose Workspace access ended, so an expired owner does not take the alert', async () => {
  const now = new Date('2026-01-10T00:00:00.000Z')
  const [status] = await createBudgetThresholdReader(sources({
    listWorkspaceMembers: async () => [
      { memberKey: 'Owner@example.com', status: 'active', accessExpiresAt: '2026-01-09T00:00:00.000Z' },
      { memberKey: 'lead@example.com', status: 'active' },
    ],
    readProjects: async () => [{ teamId: 't', projectId: 'p', ownerMemberKey: 'owner@example.com', managerMemberKeys: ['lead@example.com', 'owner@example.com'] }],
  })).listProjectBudgetStatuses('w', now)
  expect(status?.ownerMemberKey).toBeUndefined()
  expect(status?.managerMemberKeys).toEqual(['lead@example.com'])
})

test('counts Agent Run cost of a USD budget when the Workspace profile includes it (ADR 0119)', async () => {
  const now = new Date('2026-01-10T00:00:00.000Z')
  const base = sources()
  const withAgentCost = (includeInProjectBudgets: boolean, currency: string) => sources({
    readProfile: async () => ({ status: 'active', agentCost: { includeInProjectBudgets } }),
    getBudget: async () => ({ ...budget, currency }),
    listExpenses: async (...args) => (await base.listExpenses(...args)).map((expense) => ({ ...expense, currency })),
    listWorkItems: async () => ({ issues: [{ id: 'a', assignedProjectId: 'p' }] }),
    // $25 is 2,500 cents on top of the $50 expense of a $100 budget.
    listAgentRunCosts: async () => ({ runs: [{ finishedAt: '2026-01-06T00:00:00.000Z', costMicroUsd: 25_000_000 }], truncated: false }),
  })
  const [included] = await createBudgetThresholdReader(withAgentCost(true, 'USD')).listProjectBudgetStatuses('w', now)
  expect(included).toMatchObject({ actualCostMinor: 7_500, consumedPercent: 75 })
  const [excluded] = await createBudgetThresholdReader(withAgentCost(false, 'USD')).listProjectBudgetStatuses('w', now)
  expect(excluded).toMatchObject({ actualCostMinor: 5_000, consumedPercent: 50 })
  // The cost is not converted, so a yen budget leaves it out.
  const [yen] = await createBudgetThresholdReader(withAgentCost(true, 'JPY')).listProjectBudgetStatuses('w', now)
  expect(yen).toMatchObject({ actualCostMinor: 5_000, consumedPercent: 50 })
})
