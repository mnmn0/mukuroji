import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { ProjectCharter } from '@mukuroji/contracts'
import { describe, expect, test } from 'bun:test'
import { ProjectDataError } from '../../project-data-error'
import { DynamoDbProjectDirectoryClient } from './project-directory-client'

const workspaceId = 'workspace-1'

/** Creates the stored Team row used by every charter test. */
function teamRow() {
  return {
    directoryId: workspaceId,
    entryKey: '000010#000000#TEAM#core-team',
    entryType: 'team',
    teamId: 'core-team',
    teamSortOrder: 10,
    nameJa: 'コアチーム',
    nameEn: 'Core Team',
    expanded: true,
  }
}

/**
 * Creates a stored Project row.
 *
 * @param overrides - Attributes replacing the legacy defaults.
 * @returns One Project directory row.
 */
function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    directoryId: workspaceId,
    entryKey: '000010#000010#PROJECT#refero',
    entryType: 'project',
    teamId: 'core-team',
    teamSortOrder: 10,
    projectId: 'refero',
    projectSortOrder: 10,
    nameJa: 'Refero',
    nameEn: 'Refero',
    tone: 'blue',
    ...overrides,
  }
}

/**
 * Creates a fake DocumentClient that serves directory rows and records writes.
 *
 * @param rows - Directory partition rows returned by Query.
 * @param transactionError - Optional error thrown by TransactWrite.
 * @returns The fake client and the recorded inputs.
 */
function createFakeDocumentClient(rows: unknown[], transactionError?: Error) {
  const writes: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) return { Items: rows }
      writes.push(command.input)
      if (transactionError) throw transactionError
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  return { documentClient, writes }
}

/**
 * Creates a DynamoDB transaction cancellation failing at one index.
 *
 * @param failedIndex - Index of the conditional failure.
 * @param size - Number of transaction items.
 * @returns The cancellation error.
 */
function createCancellation(failedIndex: number, size: number) {
  return Object.assign(new Error('Transaction was canceled.'), {
    name: 'TransactionCanceledException',
    CancellationReasons: Array.from({ length: size }, (_, index) =>
      index === failedIndex ? { Code: 'ConditionalCheckFailed' } : { Code: 'None' }
    ),
  })
}

/** Reads the transaction items of one recorded TransactWrite input. */
function readTransactItems(input: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const items = input?.TransactItems
  if (!Array.isArray(items)) throw new Error('expected TransactItems')
  return items
}

const charter: ProjectCharter = {
  code: 'OPS-1',
  purpose: '社内基盤の刷新',
  owner: { userId: 'pm@example.com', displayName: '山田' },
  plannedStartDate: '2026-04-01',
  plannedEndDate: '2027-03-31',
  tags: ['基盤'],
  repositoryUrls: [],
}

describe('Project charter persistence', () => {
  test('reads a legacy Project as active with an empty charter and lists lifecycle in the directory', async () => {
    const { documentClient } = createFakeDocumentClient([teamRow(), projectRow()])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await expect(client.getProjectCharter(workspaceId, 'core-team', 'refero')).resolves.toEqual({
      teamId: 'core-team',
      projectId: 'refero',
      lifecycleState: 'active',
      charter: { tags: [], repositoryUrls: [] },
      revision: 0,
    })
    await expect(client.getProjectDirectory(workspaceId, 'ja')).resolves.toEqual({
      teams: [{
        id: 'core-team',
        name: 'コアチーム',
        expanded: true,
        projects: [{ id: 'refero', name: 'Refero', tone: 'blue', lifecycleState: 'active' }],
      }],
    })
  })

  test('lists the stored lifecycle and charter summary in the directory', async () => {
    const { documentClient } = createFakeDocumentClient([
      teamRow(),
      projectRow({ lifecycleState: 'on-hold', charter, charterRevision: 3 }),
    ])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    const directory = await client.getProjectDirectory(workspaceId, 'ja')
    expect(directory.teams[0]?.projects[0]).toEqual({
      id: 'refero',
      name: 'Refero',
      tone: 'blue',
      lifecycleState: 'on-hold',
      charter: {
        code: 'OPS-1',
        owner: { userId: 'pm@example.com', displayName: '山田' },
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2027-03-31',
      },
    })
  })

  test('fails closed on a malformed stored lifecycle', async () => {
    const { documentClient } = createFakeDocumentClient([
      teamRow(),
      projectRow({ lifecycleState: 'archived' }),
    ])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await expect(client.getProjectDirectory(workspaceId, 'ja')).rejects.toMatchObject({
      code: 'InvalidProjectDirectory',
    })
  })

  test('replaces a charter, reserves its code, and guards the revision in one transaction', async () => {
    const { documentClient, writes } = createFakeDocumentClient([teamRow(), projectRow()])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await expect(client.updateProjectCharter(workspaceId, 'core-team', 'refero', 0, charter))
      .resolves.toMatchObject({ charter, revision: 1, lifecycleState: 'active' })

    const items = readTransactItems(writes[0])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      Update: {
        TableName: 'DirectoryTable',
        Key: { directoryId: workspaceId, entryKey: '000010#000010#PROJECT#refero' },
        ConditionExpression: expect.stringContaining(
          'attribute_not_exists(#charterRevision) OR #charterRevision = :expectedRevision',
        ),
        ExpressionAttributeValues: expect.objectContaining({
          ':charter': charter,
          ':expectedRevision': 0,
          ':nextRevision': 1,
        }),
      },
    })
    expect(items[1]).toMatchObject({
      Put: {
        Item: {
          directoryId: 'PROJECT_CODE#workspace-1',
          entryKey: 'CODE#OPS-1',
          entryType: 'project-code',
          workspaceId,
          teamId: 'core-team',
          projectId: 'refero',
          code: 'OPS-1',
        },
        ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
      },
    })
  })

  test('releases the previous code when the code changes', async () => {
    const { documentClient, writes } = createFakeDocumentClient([
      teamRow(),
      projectRow({ charter: { ...charter, code: 'OLD' }, charterRevision: 4 }),
    ])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await client.updateProjectCharter(workspaceId, 'core-team', 'refero', 4, charter)

    const items = readTransactItems(writes[0])
    expect(items[0]).toMatchObject({
      Update: { ConditionExpression: expect.stringContaining('#charterRevision = :expectedRevision') },
    })
    expect(items[2]).toMatchObject({
      Delete: {
        Key: { directoryId: 'PROJECT_CODE#workspace-1', entryKey: 'CODE#OLD' },
        ExpressionAttributeValues: { ':projectId': 'refero', ':teamId': 'core-team' },
      },
    })
  })

  test('does not touch the code reservation when the code is unchanged', async () => {
    const { documentClient, writes } = createFakeDocumentClient([
      teamRow(),
      projectRow({ charter, charterRevision: 1 }),
    ])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await client.updateProjectCharter(workspaceId, 'core-team', 'refero', 1, { ...charter, purpose: '更新' })

    expect(readTransactItems(writes[0])).toHaveLength(1)
  })

  test('classifies a code claimed by another Project', async () => {
    const { documentClient } = createFakeDocumentClient(
      [teamRow(), projectRow()],
      createCancellation(1, 2),
    )
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await expect(client.updateProjectCharter(workspaceId, 'core-team', 'refero', 0, charter))
      .rejects.toEqual(new ProjectDataError(409, 'ProjectCodeAlreadyUsed', 'The Project code is already used in this Workspace.'))
  })

  test('rejects a stale revision before writing and a concurrent write at commit', async () => {
    const stale = createFakeDocumentClient([teamRow(), projectRow({ charterRevision: 2 })])
    const staleClient = new DynamoDbProjectDirectoryClient('DirectoryTable', stale.documentClient)
    await expect(staleClient.updateProjectCharter(workspaceId, 'core-team', 'refero', 1, charter))
      .rejects.toMatchObject({ code: 'ProjectCharterRevisionConflict', status: 409 })
    expect(stale.writes).toHaveLength(0)

    const raced = createFakeDocumentClient([teamRow(), projectRow()], createCancellation(0, 2))
    const racedClient = new DynamoDbProjectDirectoryClient('DirectoryTable', raced.documentClient)
    await expect(racedClient.updateProjectCharter(workspaceId, 'core-team', 'refero', 0, charter))
      .rejects.toMatchObject({ code: 'ProjectCharterRevisionConflict', status: 409 })
  })

  test('rejects charter and lifecycle changes on an archived Project', async () => {
    const { documentClient, writes } = createFakeDocumentClient([
      teamRow(),
      projectRow({ archivedAt: '2026-06-01T00:00:00.000Z' }),
    ])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await expect(client.getProjectCharter(workspaceId, 'core-team', 'refero'))
      .resolves.toMatchObject({ lifecycleState: 'archived' })
    await expect(client.updateProjectCharter(workspaceId, 'core-team', 'refero', 0, charter))
      .rejects.toMatchObject({ code: 'ProjectArchived' })
    await expect(client.transitionProjectLifecycle(workspaceId, 'core-team', 'refero', 0, 'active'))
      .rejects.toMatchObject({ code: 'ProjectArchived' })
    expect(writes).toHaveLength(0)
  })

  test('stores a decided lifecycle state behind the charter revision', async () => {
    const { documentClient, writes } = createFakeDocumentClient([
      teamRow(),
      projectRow({ lifecycleState: 'proposed', charterRevision: 1 }),
    ])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await expect(client.transitionProjectLifecycle(workspaceId, 'core-team', 'refero', 1, 'approved'))
      .resolves.toMatchObject({ lifecycleState: 'approved', revision: 2 })
    expect(readTransactItems(writes[0])[0]).toMatchObject({
      Update: {
        UpdateExpression: expect.stringContaining('#lifecycleState = :lifecycleState'),
        ExpressionAttributeValues: expect.objectContaining({
          ':lifecycleState': 'approved',
          ':expectedRevision': 1,
          ':nextRevision': 2,
        }),
      },
    })
  })

  test('creates a Project in an initial lifecycle state and rejects a closed start', async () => {
    const { documentClient, writes } = createFakeDocumentClient([teamRow()])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await expect(client.createProject(
      workspaceId,
      'core-team',
      { name: 'New Project', lifecycleState: 'proposed' },
      { userKey: 'demo@example.com', workspaceMemberVersion: 1 },
    )).resolves.toMatchObject({ project: { lifecycleState: 'proposed' } })
    expect(readTransactItems(writes[0])[1]).toMatchObject({
      Put: { Item: { entryType: 'project', lifecycleState: 'proposed' } },
    })

    await expect(client.createProject(
      workspaceId,
      'core-team',
      { name: 'Closed Project', lifecycleState: 'closed' },
      { userKey: 'demo@example.com', workspaceMemberVersion: 1 },
    )).rejects.toMatchObject({ code: 'InvalidProjectCharter', status: 400 })
  })

  test('builds a commit-time fence that rejects new Work Items in a closed Project', async () => {
    const { documentClient } = createFakeDocumentClient([teamRow(), projectRow({ lifecycleState: 'on-hold' })])
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    const fence = await client.createNewWorkItemProjectConditionCheck(workspaceId, 'core-team', 'refero')

    expect(fence).toEqual({
      ConditionCheck: {
        TableName: 'DirectoryTable',
        Key: { directoryId: workspaceId, entryKey: '000010#000010#PROJECT#refero' },
        ConditionExpression:
          '#entryType = :entryType AND #teamId = :teamId AND #projectId = :projectId AND ' +
          'attribute_not_exists(#archivedAt) AND ' +
          '(attribute_not_exists(#lifecycleState) OR NOT (#lifecycleState IN (:rejectingState0)))',
        ExpressionAttributeNames: {
          '#archivedAt': 'archivedAt',
          '#entryType': 'entryType',
          '#lifecycleState': 'lifecycleState',
          '#projectId': 'projectId',
          '#teamId': 'teamId',
        },
        ExpressionAttributeValues: {
          ':entryType': 'project',
          ':projectId': 'refero',
          ':teamId': 'core-team',
          ':rejectingState0': 'closed',
        },
      },
    })
    await expect(client.createNewWorkItemProjectConditionCheck(workspaceId, 'core-team', 'missing'))
      .rejects.toMatchObject({ code: 'ProjectNotFound', status: 404 })
  })
})
