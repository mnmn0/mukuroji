import { expect, test } from 'bun:test'
import { createDynamoDbBudgetAlertProjectReader } from './budget-alert-project-reader'

/**
 * Creates a fake DocumentClient that answers every query with one page of directory rows.
 *
 * @param items - Directory rows of the Workspace partition.
 * @returns The fake client.
 */
function createDocumentClient(items: Array<Record<string, unknown>>) {
  return {
    async send() {
      return { Items: items }
    },
  }
}

test('lists active Projects with their charter owner and current managers', async () => {
  const read = createDynamoDbBudgetAlertProjectReader({
    documentClient: createDocumentClient([
      { entryType: 'project', teamId: 'core', projectId: 'web', charter: { owner: { userId: 'Lead@Example.com', displayName: 'Lead' } } },
      { entryType: 'project', teamId: 'core', projectId: 'api', charter: {} },
      { entryType: 'project', teamId: 'core', projectId: 'old', archivedAt: '2026-01-01T00:00:00.000Z' },
      { entryType: 'project', teamId: 'gone', projectId: 'legacy' },
      // A Project ID two Teams use stays in the scan for each Team, with its own charter owner,
      // but its membership rows cannot be told apart, so neither pair gets legacy managers.
      { entryType: 'project', teamId: 'core', projectId: 'shared', charter: { owner: { userId: 'Core@Example.com' } } },
      { entryType: 'project', teamId: 'other', projectId: 'shared', charter: { owner: { userId: 'other@example.com' } } },
      { entryType: 'project-member', projectId: 'shared', memberKey: 'ambiguous@example.com', role: 'manager' },
      // Archiving one Team's Project leaves the other Team's Project with the same ID in the scan.
      { entryType: 'project', teamId: 'core', projectId: 'split', archivedAt: '2026-01-01T00:00:00.000Z' },
      { entryType: 'project', teamId: 'other', projectId: 'split' },
      { entryType: 'project-member', projectId: 'web', memberKey: 'pm@example.com', role: 'manager' },
      { entryType: 'project-member', projectId: 'web', memberKey: 'lead@example.com', role: 'manager' },
      { entryType: 'project-member', projectId: 'web', memberKey: 'dev@example.com', role: 'member' },
      { entryType: 'project-member', projectId: 'web', memberKey: 'former@example.com', role: 'manager', archivedAt: '2026-01-01T00:00:00.000Z' },
      { entryType: 'team', teamId: 'core' },
      { entryType: 'team', teamId: 'other' },
      { entryType: 'team', teamId: 'gone', archivedAt: '2026-01-01T00:00:00.000Z' },
    ]),
    tableName: 'ProjectDirectoryTable',
  })

  expect(await read('workspace-1')).toEqual([
    { teamId: 'core', projectId: 'api', managerMemberKeys: [] },
    { teamId: 'core', projectId: 'shared', ownerMemberKey: 'core@example.com', managerMemberKeys: [] },
    { teamId: 'core', projectId: 'web', ownerMemberKey: 'lead@example.com', managerMemberKeys: ['lead@example.com', 'pm@example.com'] },
    { teamId: 'other', projectId: 'shared', ownerMemberKey: 'other@example.com', managerMemberKeys: [] },
    { teamId: 'other', projectId: 'split', managerMemberKeys: [] },
  ])
})
