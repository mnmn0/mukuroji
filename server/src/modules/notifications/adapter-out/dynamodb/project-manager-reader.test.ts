import { describe, expect, test } from 'bun:test'
import { createDynamoDbProjectManagerReader } from './project-manager-reader'

/** Document client type accepted by createDynamoDbProjectManagerReader in tests. */
type ProjectManagerReaderClient = Parameters<typeof createDynamoDbProjectManagerReader>[0]['documentClient']

/** Creates a DocumentClient fake that returns the given Query pages in order. */
function createPagedClient(pages: readonly Record<string, unknown>[]) {
  const inputs: Record<string, unknown>[] = []
  const send = async (command: { input: object }) => {
    inputs.push({ ...command.input })
    return pages[inputs.length - 1] ?? {}
  }
  const client: ProjectManagerReaderClient = { send } as ProjectManagerReaderClient
  return { inputs, client }
}

describe('DynamoDB Project manager reader', () => {
  test('pages through the Workspace directory and keeps managers of active Projects', async () => {
    const { client, inputs } = createPagedClient([
      {
        Items: [
          { entryType: 'project', projectId: 'platform' },
          { entryType: 'project-member', projectId: 'platform', memberKey: 'Lead@Example.com', role: 'manager' },
          { entryType: 'project-member', projectId: 'platform', memberKey: 'viewer@example.com', role: 'viewer' },
        ],
        LastEvaluatedKey: { directoryId: 'workspace-1', entryKey: 'page-1' },
      },
      {
        Items: [
          { entryType: 'project', projectId: 'archived', archivedAt: '2026-07-01T00:00:00.000Z' },
          { entryType: 'project-member', projectId: 'archived', memberKey: 'old@example.com', role: 'manager' },
          { entryType: 'project-member', projectId: 'platform', memberKey: 'ada@example.com', role: 'manager' },
          {
            entryType: 'project-member',
            projectId: 'platform',
            memberKey: 'former@example.com',
            role: 'manager',
            archivedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
    ])

    const managers = await createDynamoDbProjectManagerReader({
      documentClient: client,
      tableName: 'ProjectDirectoryTable',
      pageSize: 3,
    }).readActiveProjectManagers('workspace-1')

    expect([...managers]).toEqual([['platform', ['ada@example.com', 'lead@example.com']]])
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).toMatchObject({
      TableName: 'ProjectDirectoryTable',
      ExpressionAttributeValues: { ':directoryId': 'workspace-1' },
      ConsistentRead: true,
      Limit: 3,
    })
    expect(inputs[1]?.ExclusiveStartKey).toEqual({ directoryId: 'workspace-1', entryKey: 'page-1' })
  })

  test('fails closed past the page bound or on a malformed member row', async () => {
    const endless = createPagedClient([{ Items: [], LastEvaluatedKey: { directoryId: 'workspace-1' } }])
    await expect(createDynamoDbProjectManagerReader({
      documentClient: endless.client,
      tableName: 'ProjectDirectoryTable',
      maxPages: 1,
    }).readActiveProjectManagers('workspace-1')).rejects.toThrow('1 page limit')

    const malformed = createPagedClient([{
      Items: [{ entryType: 'project-member', projectId: 'platform', role: 'manager' }],
    }])
    await expect(createDynamoDbProjectManagerReader({
      documentClient: malformed.client,
      tableName: 'ProjectDirectoryTable',
    }).readActiveProjectManagers('workspace-1')).rejects.toThrow('Project member key')
  })
})
