import { expect, test } from 'bun:test'
import { createDynamoDbMemberProjectReader } from './member-project-reader'

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

test('leaves out the Projects of an archived Team, whose Project rows stay unarchived', async () => {
  const read = createDynamoDbMemberProjectReader({
    // The Project rows come before the Team rows, as the directory may sort them.
    documentClient: createDocumentClient([
      { entryType: 'project', teamId: 'a-archived', projectId: 'old' },
      { entryType: 'project', teamId: 'b-live', projectId: 'live' },
      { entryType: 'project-member', projectId: 'old', memberKey: 'guest@example.com', role: 'member' },
      { entryType: 'project-member', projectId: 'old', memberKey: 'lead@example.com', role: 'manager' },
      { entryType: 'project-member', projectId: 'live', memberKey: 'guest@example.com', role: 'member' },
      { entryType: 'project-member', projectId: 'live', memberKey: 'lead@example.com', role: 'manager' },
      { entryType: 'team', teamId: 'a-archived', archivedAt: '2026-07-01T00:00:00.000Z' },
      { entryType: 'team', teamId: 'b-live' },
    ]),
    tableName: 'ProjectDirectoryTable',
  })

  expect(await read('workspace-1', 'guest@example.com')).toEqual([
    { teamId: 'b-live', projectId: 'live', managerMemberKeys: ['lead@example.com'] },
  ])
})
