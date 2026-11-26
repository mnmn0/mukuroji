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
      // A Project ID two Teams use cannot be told apart by its membership rows.
      { entryType: 'project', teamId: 'core', projectId: 'shared' },
      { entryType: 'project', teamId: 'other', projectId: 'shared' },
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
    { teamId: 'core', projectId: 'web', ownerMemberKey: 'lead@example.com', managerMemberKeys: ['lead@example.com', 'pm@example.com'] },
  ])
})
