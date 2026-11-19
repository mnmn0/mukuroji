import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createPlanningUpdateProjectTargetRecordKey } from '../../../planning'
import { DynamoDbProjectDirectoryClient } from './project-directory-client'

const directoryId = 'user#demo@example.com'

/** Command shape the fake document client receives. */
type SentCommand = { input: Record<string, unknown> }

/**
 * Creates a stored Team row.
 *
 * @param teamId - Team identifier.
 * @param teamSortOrder - Creation position.
 * @param extra - Additional stored attributes.
 * @returns The stored row.
 */
function createTeamRow(teamId: string, teamSortOrder: number, extra: Record<string, unknown> = {}) {
  return {
    directoryId,
    entryKey: `${String(teamSortOrder).padStart(6, '0')}#000000#TEAM#${teamId}`,
    entryType: 'team',
    teamId,
    teamSortOrder,
    nameJa: `${teamId} 日本語`,
    nameEn: `${teamId} English`,
    expanded: true,
    ...extra,
  }
}

/**
 * Creates a stored Project row.
 *
 * @param teamId - Owning Team identifier.
 * @param teamSortOrder - Owning Team creation position.
 * @param projectId - Project identifier.
 * @param projectSortOrder - Creation position within the Team.
 * @param extra - Additional stored attributes.
 * @returns The stored row.
 */
function createProjectRow(
  teamId: string,
  teamSortOrder: number,
  projectId: string,
  projectSortOrder: number,
  extra: Record<string, unknown> = {},
) {
  return {
    directoryId,
    entryKey: `${String(teamSortOrder).padStart(6, '0')}#${String(projectSortOrder).padStart(6, '0')}#PROJECT#${projectId}`,
    entryType: 'project',
    teamId,
    teamSortOrder,
    projectId,
    projectSortOrder,
    nameJa: `${projectId} 日本語`,
    nameEn: `${projectId} English`,
    tone: 'blue',
    ...extra,
  }
}

/**
 * Creates a directory client over a fake document client that serves fixed rows.
 *
 * @param rows - Rows every directory query returns.
 * @param failTransactions - Whether transactions fail on a lost condition.
 * @param planningItems - Planning rows served by key reads, keyed by `workspaceId|recordKey`.
 * @returns The client and the commands it sent.
 */
function createClient(
  rows: Array<Record<string, unknown>>,
  failTransactions = false,
  planningItems: Record<string, Record<string, unknown>> = {},
) {
  const sent: SentCommand[] = []
  const send = async (command: SentCommand) => {
    sent.push(command)
    if ('KeyConditionExpression' in command.input) return { Items: rows }
    const key = command.input.Key
    if (command.input.TableName === 'PlanningTable' && isPlanningKey(key)) {
      return { Item: planningItems[`${key.workspaceId}|${key.recordKey}`] }
    }
    if ('TransactItems' in command.input && failTransactions) {
      throw Object.assign(new Error('Transaction was canceled.'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      })
    }
    return {}
  }
  // The fake implements only `send`, the one method the directory client calls.
  const documentClient = { send } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
    'PlanningTable',
  )
  const transactions = () => sent
    .filter((command) => 'TransactItems' in command.input)
    .map((command) => command.input.TransactItems)
  return { client, transactions }
}

/**
 * Checks whether a command key addresses a Planning row.
 *
 * @param key - Untrusted command key.
 * @returns Whether the key has string partition and sort values.
 */
function isPlanningKey(key: unknown): key is { workspaceId: string; recordKey: string } {
  return typeof key === 'object' && key !== null &&
    typeof Reflect.get(key, 'workspaceId') === 'string' &&
    typeof Reflect.get(key, 'recordKey') === 'string'
}

/**
 * Creates a stored Planning update target row of a Project.
 *
 * @param teamId - Owning Team identifier.
 * @param projectId - Project identifier.
 * @param extra - Additional stored attributes.
 * @returns The stored row.
 */
function createPlanningTargetRow(
  teamId: string,
  projectId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    workspaceId: directoryId,
    recordKey: createPlanningUpdateProjectTargetRecordKey(teamId, projectId),
    entryType: 'planning-update-target',
    target: { type: 'project', teamId, projectId },
    latestVersion: 0,
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...extra,
  }
}

test('orders the sidebar by display order and falls back to the creation position', async () => {
  const { client } = createClient([
    createTeamRow('alpha', 10, { displayOrder: 30 }),
    createProjectRow('alpha', 10, 'a-first', 10, { displayOrder: 20 }),
    createProjectRow('alpha', 10, 'a-second', 20, { displayOrder: 10 }),
    createTeamRow('beta', 20, { displayOrder: 10 }),
    createTeamRow('gamma', 30),
  ])

  const directory = await client.getProjectDirectory(directoryId, 'en')

  expect(directory.teams.map((team) => team.id)).toEqual(['beta', 'alpha', 'gamma'])
  expect(directory.teams[1]?.projects.map((project) => project.id)).toEqual([
    'a-second',
    'a-first',
  ])
})

test('lists archived Teams and Projects with both names for administration', async () => {
  const { client } = createClient([
    createTeamRow('alpha', 10),
    createProjectRow('alpha', 10, 'live', 10, { tone: 'green' }),
    createProjectRow('alpha', 10, 'gone', 20, { archivedAt: '2026-06-06T00:00:00.000Z' }),
    createTeamRow('beta', 20, { archivedAt: '2026-06-07T00:00:00.000Z' }),
  ])

  await expect(client.getDirectoryAdministration(directoryId)).resolves.toEqual({
    teams: [
      {
        id: 'alpha',
        nameJa: 'alpha 日本語',
        nameEn: 'alpha English',
        projects: [
          { id: 'live', nameJa: 'live 日本語', nameEn: 'live English', tone: 'green' },
          {
            id: 'gone',
            nameJa: 'gone 日本語',
            nameEn: 'gone English',
            tone: 'blue',
            archivedAt: '2026-06-06T00:00:00.000Z',
          },
        ],
      },
      {
        id: 'beta',
        nameJa: 'beta 日本語',
        nameEn: 'beta English',
        archivedAt: '2026-06-07T00:00:00.000Z',
        projects: [],
      },
    ],
  })
})

test('renames a Team in place without changing its key or ID', async () => {
  const { client, transactions } = createClient([createTeamRow('alpha', 10)])

  await expect(client.renameTeam(directoryId, 'alpha', {
    nameJa: ' 新しい名前 ',
    nameEn: 'New name',
  })).resolves.toEqual({ teamId: 'alpha', nameJa: '新しい名前', nameEn: 'New name' })
  expect(transactions()).toEqual([[{
    Update: expect.objectContaining({
      Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
      UpdateExpression: 'SET nameJa = :nameJa, nameEn = :nameEn',
      ConditionExpression:
        '#entryType = :entryType AND #teamId = :teamId AND attribute_not_exists(#archivedAt) ' +
        'AND #nameJa = :readNameJa AND #nameEn = :readNameEn',
      ExpressionAttributeValues: {
        ':entryType': 'team',
        ':teamId': 'alpha',
        ':readNameJa': 'alpha 日本語',
        ':readNameEn': 'alpha English',
        ':nameJa': '新しい名前',
        ':nameEn': 'New name',
      },
    }),
  }]])
})

test('rejects renaming an archived Team, an empty name, and a name over 500 characters', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10, { archivedAt: '2026-06-06T00:00:00.000Z' }),
    createTeamRow('beta', 20),
  ])

  await expect(client.renameTeam(directoryId, 'alpha', { nameJa: 'x' }))
    .rejects.toMatchObject({ status: 404, code: 'TeamNotFound' })
  await expect(client.renameTeam(directoryId, 'beta', { nameJa: '  ' }))
    .rejects.toMatchObject({ status: 400, code: 'InvalidProjectWrite' })
  await expect(client.renameTeam(directoryId, 'beta', { nameJa: 'x'.repeat(501) }))
    .rejects.toMatchObject({ status: 400, code: 'InvalidProjectWrite' })
  expect(transactions()).toEqual([])
})

test('renames a Project and keeps its color unless a new one is given', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createProjectRow('alpha', 10, 'live', 10, { tone: 'green' }),
  ])

  await expect(client.renameProject(directoryId, 'alpha', 'live', { nameJa: '改名' }))
    .resolves.toEqual({
      teamId: 'alpha',
      projectId: 'live',
      nameJa: '改名',
      nameEn: '改名',
      tone: 'green',
    })
  await expect(client.renameProject(directoryId, 'alpha', 'live', {
    nameJa: 'live 日本語',
    nameEn: 'live English',
    tone: 'purple',
  })).resolves.toMatchObject({ tone: 'purple' })
  // A rename that omits the color only commits while the color it read is still stored.
  expect(transactions()[0]).toEqual([{
    Update: expect.objectContaining({
      ConditionExpression: expect.stringContaining('#tone = :readTone'),
      ExpressionAttributeValues: expect.objectContaining({
        ':readTone': 'green',
        ':tone': 'green',
      }),
    }),
  }])
  await expect(client.renameProject(directoryId, 'alpha', 'live', {
    nameJa: 'x',
    tone: 'red',
  })).rejects.toMatchObject({ status: 400 })
  expect(transactions()).toHaveLength(2)
})

test('restores an archived Team and reports a Team that is not archived', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10, { archivedAt: '2026-06-06T00:00:00.000Z' }),
    createTeamRow('beta', 20),
  ])

  await expect(client.restoreTeam(directoryId, 'alpha')).resolves.toEqual({ teamId: 'alpha' })
  await expect(client.restoreTeam(directoryId, 'beta'))
    .rejects.toMatchObject({ status: 409, code: 'TeamNotArchived' })
  await expect(client.restoreTeam(directoryId, 'missing'))
    .rejects.toMatchObject({ status: 404, code: 'TeamNotFound' })
  expect(transactions()).toEqual([[{
    Update: expect.objectContaining({
      Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
      UpdateExpression: 'REMOVE archivedAt',
      ConditionExpression:
        '#entryType = :entryType AND #teamId = :teamId AND attribute_exists(#archivedAt)',
    }),
  }]])
})

test('restores an archived Project only while its Team is active', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createProjectRow('alpha', 10, 'gone', 10, { archivedAt: '2026-06-06T00:00:00.000Z' }),
    createTeamRow('beta', 20, { archivedAt: '2026-06-06T00:00:00.000Z' }),
    createProjectRow('beta', 20, 'hidden', 10, { archivedAt: '2026-06-06T00:00:00.000Z' }),
  ])

  await expect(client.restoreProject(directoryId, 'alpha', 'gone'))
    .resolves.toEqual({ teamId: 'alpha', projectId: 'gone' })
  await expect(client.restoreProject(directoryId, 'beta', 'hidden'))
    .rejects.toMatchObject({ status: 409, code: 'TeamArchived' })
  expect(transactions()).toEqual([[
    {
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000010#PROJECT#gone' },
        UpdateExpression: 'REMOVE archivedAt',
      }),
    },
    {
      ConditionCheck: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
      }),
    },
  ]])
})

test('makes the archived Planning update targets of restored Projects usable again', async () => {
  const archivedAt = '2026-06-06T00:00:00.000Z'
  const planningItems: Record<string, Record<string, unknown>> = Object.fromEntries([
    createPlanningTargetRow('alpha', 'gone', { archivedAt, cadence: { unit: 'week' } }),
    createPlanningTargetRow('beta', 'shown', { archivedAt }),
    createPlanningTargetRow('beta', 'separately-archived', { archivedAt }),
    createPlanningTargetRow('beta', 'unarchived'),
  ].map((row) => [`${row.workspaceId}|${row.recordKey}`, row]))
  planningItems[`FENCE#${directoryId}|META`] = { revision: 7 }
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createProjectRow('alpha', 10, 'gone', 10, { archivedAt }),
    createTeamRow('beta', 20, { archivedAt }),
    createProjectRow('beta', 20, 'shown', 10),
    createProjectRow('beta', 20, 'separately-archived', 20, { archivedAt }),
    createProjectRow('beta', 20, 'unarchived', 30),
  ], false, planningItems)

  await client.restoreProject(directoryId, 'alpha', 'gone')
  await client.restoreTeam(directoryId, 'beta')

  const restoreTarget = (teamId: string, projectId: string) => ({
    Update: expect.objectContaining({
      TableName: 'PlanningTable',
      Key: {
        workspaceId: directoryId,
        recordKey: createPlanningUpdateProjectTargetRecordKey(teamId, projectId),
      },
      UpdateExpression:
        'SET updatedAt = :restoredAt REMOVE archivedAt, cadence, cadenceAnchorDay, ' +
        'updateScheduleShard, nextNotificationAtRecordKey',
      ConditionExpression: expect.stringContaining('attribute_exists(archivedAt)'),
    }),
  })
  const revisionBump = {
    Put: expect.objectContaining({
      TableName: 'PlanningTable',
      Item: expect.objectContaining({ workspaceId: `FENCE#${directoryId}`, revision: 8 }),
      ConditionExpression: '#revision = :expectedPlanningRevision',
    }),
  }
  const [projectRestore, teamRestore] = transactions()
  expect(Array.isArray(projectRestore) ? projectRestore.slice(2) : undefined).toEqual([revisionBump, restoreTarget('alpha', 'gone')])
  // Only the Project that was active when the Team was archived gets its target back.
  expect(Array.isArray(teamRestore) ? teamRestore.slice(1) : undefined).toEqual([revisionBump, restoreTarget('beta', 'shown')])
})

test('reorders Teams by reusing their positions and writes only the rows that move', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createTeamRow('beta', 20),
    createTeamRow('gamma', 30),
    createTeamRow('archived', 40, { archivedAt: '2026-06-06T00:00:00.000Z' }),
  ])

  await expect(client.reorderTeams(directoryId, { teamIds: ['gamma', 'alpha', 'beta'] }))
    .resolves.toEqual({ teamIds: ['gamma', 'alpha', 'beta'] })
  const [transaction] = transactions()
  expect(transaction).toEqual([
    {
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000030#000000#TEAM#gamma' },
        UpdateExpression: 'SET #displayOrder = :displayOrder',
        ConditionExpression:
          '#entryType = :entryType AND #teamId = :teamId AND attribute_not_exists(#archivedAt) ' +
          'AND attribute_not_exists(#displayOrder)',
        ExpressionAttributeValues: expect.objectContaining({ ':displayOrder': 10 }),
      }),
    },
    {
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
        ExpressionAttributeValues: expect.objectContaining({ ':displayOrder': 20 }),
      }),
    },
    {
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000020#000000#TEAM#beta' },
        ExpressionAttributeValues: expect.objectContaining({ ':displayOrder': 30 }),
      }),
    },
  ])
})

test('guards rows that keep their place with the position read, so concurrent reorders conflict', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10, { displayOrder: 10 }),
    createTeamRow('beta', 20, { displayOrder: 20 }),
    createTeamRow('gamma', 30, { displayOrder: 30 }),
  ])

  await client.reorderTeams(directoryId, { teamIds: ['alpha', 'gamma', 'beta'] })

  expect(transactions()).toEqual([[
    {
      ConditionCheck: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
        ConditionExpression: expect.stringContaining('#displayOrder = :readDisplayOrder'),
        ExpressionAttributeValues: expect.objectContaining({ ':readDisplayOrder': 10 }),
      }),
    },
    {
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000030#000000#TEAM#gamma' },
        ExpressionAttributeValues: expect.objectContaining({
          ':readDisplayOrder': 30,
          ':displayOrder': 20,
        }),
      }),
    },
    {
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000020#000000#TEAM#beta' },
        ExpressionAttributeValues: expect.objectContaining({
          ':readDisplayOrder': 20,
          ':displayOrder': 30,
        }),
      }),
    },
  ]])
})

test('skips the write when the requested Team order is already stored', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10, { displayOrder: 10 }),
    createTeamRow('beta', 20, { displayOrder: 20 }),
  ])

  await expect(client.reorderTeams(directoryId, { teamIds: ['alpha', 'beta'] }))
    .resolves.toEqual({ teamIds: ['alpha', 'beta'] })
  expect(transactions()).toEqual([])
})

test('rejects a Team order that does not list every active Team exactly once', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createTeamRow('beta', 20),
  ])

  await expect(client.reorderTeams(directoryId, { teamIds: ['alpha'] }))
    .rejects.toMatchObject({ status: 409, code: 'DirectoryOrderConflict' })
  await expect(client.reorderTeams(directoryId, { teamIds: ['alpha', 'missing'] }))
    .rejects.toMatchObject({ status: 409, code: 'DirectoryOrderConflict' })
  await expect(client.reorderTeams(directoryId, { teamIds: ['alpha', 'alpha'] }))
    .rejects.toMatchObject({ status: 400, code: 'InvalidDirectoryOrder' })
  await expect(client.reorderTeams(directoryId, { teamIds: [] }))
    .rejects.toMatchObject({ status: 400, code: 'InvalidDirectoryOrder' })
  await expect(client.reorderTeams(directoryId, { teamIds: ['alpha', 7] }))
    .rejects.toMatchObject({ status: 400, code: 'InvalidDirectoryOrder' })
  expect(transactions()).toEqual([])
})

test('reorders the active Projects of one Team and guards the Team', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createProjectRow('alpha', 10, 'first', 10),
    createProjectRow('alpha', 10, 'second', 20),
    createProjectRow('alpha', 10, 'gone', 30, { archivedAt: '2026-06-06T00:00:00.000Z' }),
  ])

  await expect(client.reorderProjects(directoryId, 'alpha', { projectIds: ['second', 'first'] }))
    .resolves.toEqual({ projectIds: ['second', 'first'] })
  await expect(client.reorderProjects(directoryId, 'alpha', { projectIds: ['first', 'second'] }))
    .resolves.toEqual({ projectIds: ['first', 'second'] })
  const [transaction] = transactions()
  expect(transaction).toEqual([
    {
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000020#PROJECT#second' },
        ExpressionAttributeValues: expect.objectContaining({ ':displayOrder': 10 }),
      }),
    },
    {
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000010#PROJECT#first' },
        ExpressionAttributeValues: expect.objectContaining({ ':displayOrder': 20 }),
      }),
    },
    {
      ConditionCheck: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
      }),
    },
  ])
})

test('maps a lost rename condition to a conflict', async () => {
  const { client } = createClient([createTeamRow('alpha', 10)], true)

  await expect(client.renameTeam(directoryId, 'alpha', { nameJa: '改名' }))
    .rejects.toMatchObject({ status: 409 })
})
