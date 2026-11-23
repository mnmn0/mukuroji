import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createMutationAuditContext } from '../../../audit/audit'
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
 * @param cleanupLocators - Webhook grant cleanup locators still waiting for an archive cleanup.
 * @param failedIndex - Index of the transaction item that fails its condition, when one does.
 * @param beforeTransaction - Runs when a transaction arrives, before it commits or fails.
 * @returns The client and the commands it sent.
 */
function createClient(
  rows: Array<Record<string, unknown>>,
  failTransactions = false,
  planningItems: Record<string, Record<string, unknown>> = {},
  cleanupLocators: Array<Record<string, unknown>> = [],
  failedIndex?: number,
  beforeTransaction?: () => void,
) {
  const sent: SentCommand[] = []
  const receiptFingerprints = new Map<unknown, unknown>()
  const send = async (command: SentCommand) => {
    sent.push(command)
    // Request receipts are written on their own and keep the first input of each key; the
    // failures and races below target the directory transactions that follow them.
    if (isReceiptTransaction(command.input.TransactItems)) {
      const [put] = listItems(command.input.TransactItems)
      const item: unknown = isRecord(put) && isRecord(put.Put) ? put.Put.Item : undefined
      const entryKey = isRecord(item) ? item.entryKey : undefined
      const fingerprint = isRecord(item) ? item.requestFingerprint : undefined
      if (receiptFingerprints.has(entryKey) && receiptFingerprints.get(entryKey) !== fingerprint) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        })
      }
      receiptFingerprints.set(entryKey, fingerprint)
      return {}
    }
    if ('TransactItems' in command.input) beforeTransaction?.()
    if ('KeyConditionExpression' in command.input) {
      const values = command.input.ExpressionAttributeValues
      const partition = typeof values === 'object' && values !== null
        ? Reflect.get(values, ':directoryId')
        : undefined
      if (typeof partition === 'string' && partition.startsWith('WEBHOOK_GRANT_CLEANUP#')) {
        return { Items: cleanupLocators.filter((locator) => locator.directoryId === partition) }
      }
      return { Items: rows }
    }
    const key = command.input.Key
    if (command.input.TableName === 'PlanningTable' && isPlanningKey(key)) {
      return { Item: planningItems[`${key.workspaceId}|${key.recordKey}`] }
    }
    if ('TransactItems' in command.input && (failTransactions || failedIndex !== undefined)) {
      const items = command.input.TransactItems
      const length = Array.isArray(items) ? items.length : 1
      throw Object.assign(new Error('Transaction was canceled.'), {
        name: 'TransactionCanceledException',
        CancellationReasons: Array.from({ length }, (_, index) => ({
          Code: failedIndex === undefined || failedIndex === index ? 'ConditionalCheckFailed' : 'None',
        })),
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
    .filter((command) => 'TransactItems' in command.input && !isReceiptTransaction(command.input.TransactItems))
    .map((command) => command.input.TransactItems)
  const receipts = () => sent
    .filter((command) => isReceiptTransaction(command.input.TransactItems))
    .map((command) => command.input.TransactItems)
  const queryCount = () => sent.filter((command) => 'KeyConditionExpression' in command.input).length
  return { client, transactions, receipts, queryCount }
}

/**
 * Tells whether sent transaction items are a lone request receipt write.
 *
 * @param items - Transaction items as sent.
 * @returns Whether the transaction only writes a `team-grant-request` receipt.
 */
function isReceiptTransaction(items: unknown) {
  if (!Array.isArray(items) || items.length !== 1) return false
  const [item]: unknown[] = items
  const put = isRecord(item) ? item.Put : undefined
  return isRecord(put) && isRecord(put.Item) && put.Item.entryType === 'team-grant-request'
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
        profileRevision: 0,
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
        profileRevision: 0,
        projects: [],
      },
    ],
  })
})

test('renames a Team in place without changing its key or ID', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createTeamRow('beta', 20, { nameRevision: 3 }),
  ])

  await expect(client.renameTeam(directoryId, 'alpha', {
    nameJa: ' 新しい名前 ',
    nameEn: 'New name',
  })).resolves.toEqual({ teamId: 'alpha', nameJa: '新しい名前', nameEn: 'New name' })
  await client.renameTeam(directoryId, 'beta', { nameJa: '次' })
  expect(transactions()).toEqual([
    [{
      Update: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
        UpdateExpression:
          'SET nameJa = :nameJa, nameEn = :nameEn, #nameRevision = :nameRevision',
        ConditionExpression:
          '#entryType = :entryType AND #teamId = :teamId AND attribute_not_exists(#archivedAt) ' +
          'AND #nameJa = :readNameJa AND #nameEn = :readNameEn ' +
          'AND attribute_not_exists(#nameRevision)',
        ExpressionAttributeValues: {
          ':entryType': 'team',
          ':teamId': 'alpha',
          ':readNameJa': 'alpha 日本語',
          ':readNameEn': 'alpha English',
          ':nameJa': '新しい名前',
          ':nameEn': 'New name',
          ':nameRevision': 1,
        },
      }),
    }],
    [{
      Update: expect.objectContaining({
        ConditionExpression: expect.stringContaining('#nameRevision = :readNameRevision'),
        ExpressionAttributeValues: expect.objectContaining({
          ':readNameRevision': 3,
          ':nameRevision': 4,
        }),
      }),
    }],
  ])
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

test('applies the rename name limits when a Team or Project is created', async () => {
  const { client, transactions } = createClient([createTeamRow('beta', 20)])
  const creator = { userKey: 'owner@example.com', workspaceMemberVersion: 1 }

  await expect(client.createTeam(directoryId, { name: 'x'.repeat(501) }))
    .rejects.toMatchObject({ status: 400, code: 'InvalidProjectWrite' })
  await expect(client.createTeam(directoryId, { nameJa: 'ok', nameEn: 'y'.repeat(501) }))
    .rejects.toMatchObject({ status: 400, code: 'InvalidProjectWrite' })
  await expect(client.createProject(directoryId, 'beta', { name: 'x'.repeat(501) }, creator))
    .rejects.toMatchObject({ status: 400, code: 'InvalidProjectWrite' })
  await expect(client.createProject(directoryId, 'beta', { name: 'line\nbreak' }, creator))
    .rejects.toMatchObject({ status: 400, code: 'InvalidProjectWrite' })
  await expect(client.renameTeam(directoryId, 'beta', { nameJa: 'tab\there' }))
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
  // A rename that omits the color only commits while the color it read is still stored, and
  // only while the Team is still active.
  expect(transactions()[0]).toEqual([
    {
      Update: expect.objectContaining({
        ConditionExpression: expect.stringContaining('#tone = :readTone'),
        ExpressionAttributeValues: expect.objectContaining({
          ':readTone': 'green',
          ':tone': 'green',
        }),
      }),
    },
    {
      ConditionCheck: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
      }),
    },
  ])
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
      UpdateExpression: 'REMOVE archivedAt ADD lifecycleRevision :one',
      ConditionExpression:
        '#entryType = :entryType AND #teamId = :teamId AND #archivedAt = :readArchivedAt',
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
        UpdateExpression: 'REMOVE archivedAt ADD lifecycleRevision :one',
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

test('adds Project renames, archives, and restores to the charter revision of the search source', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createProjectRow('alpha', 10, 'live', 10, {
      nameRevision: 2,
      charterRevision: 5,
      lifecycleRevision: 2,
    }),
    createProjectRow('alpha', 10, 'gone', 20, { archivedAt: '2026-06-06T00:00:00.000Z' }),
  ])

  await client.renameProject(directoryId, 'alpha', 'live', { nameJa: '改名' })
  expect(transactions()[0]).toEqual(expect.arrayContaining([{
    Update: expect.objectContaining({
      UpdateExpression:
        'SET nameJa = :nameJa, nameEn = :nameEn, tone = :tone, #nameRevision = :nameRevision',
      ConditionExpression: expect.stringContaining('#nameRevision = :readNameRevision'),
      ExpressionAttributeValues: expect.objectContaining({
        ':readNameRevision': 2,
        ':nameRevision': 3,
      }),
    }),
  }]))
  await expect(client.getProjectSearchSource(directoryId, 'alpha', 'live')).resolves.toMatchObject({
    project: { id: 'live', name: 'live 日本語' },
    englishName: 'live English',
    archived: false,
    sourceRevision: 9,
  })
  await expect(client.getProjectSearchSource(directoryId, 'alpha', 'gone')).resolves.toMatchObject({
    archived: true,
  })
})

/**
 * Creates the audit context of one restore request.
 *
 * @param idempotencyKey - `Idempotency-Key` of the request.
 * @param path - Request path, part of the request fingerprint.
 * @returns The audit context.
 */
function createRestoreContext(idempotencyKey: string, path: string) {
  return createMutationAuditContext({
    workspaceId: directoryId,
    actor: { id: 'sub-demo', kind: 'user', displayName: 'demo@example.com' },
    idempotencyKey,
    request: { method: 'PATCH', path, body: undefined },
    source: { kind: 'api', requestId: `request-${idempotencyKey}` },
  })
}

test('answers a retried restore with its recorded success and refuses a reused key', async () => {
  const archivedAt = '2026-06-06T00:00:00.000Z'
  const teamPath = '/api/teams/alpha/restore'
  const projectPath = '/api/teams/alpha/projects/gone/restore'
  const first = createClient([
    createTeamRow('alpha', 10, { archivedAt }),
    createProjectRow('alpha', 10, 'gone', 10, { archivedAt }),
  ])

  await first.client.restoreTeam(directoryId, 'alpha', createRestoreContext('restore-1', teamPath))
  const teamTransaction = first.transactions()[0]
  const teamUpdate: unknown = Array.isArray(teamTransaction) ? teamTransaction[0] : undefined
  expect(teamUpdate).toMatchObject({
    Update: {
      UpdateExpression: 'SET restoreReceipt = :restoreReceipt REMOVE archivedAt ADD lifecycleRevision :one',
    },
  })
  const receipt = Reflect.get(
    Reflect.get(Reflect.get(teamUpdate ?? {}, 'Update') ?? {}, 'ExpressionAttributeValues') ?? {},
    ':restoreReceipt',
  )

  // The response was lost; the stored rows now carry the receipt of the committed restores.
  const retried = createClient([
    createTeamRow('alpha', 10, { restoreReceipt: receipt }),
    createProjectRow('alpha', 10, 'gone', 10, {
      restoreReceipt: {
        ...receipt,
        requestFingerprint: createRestoreContext('restore-2', projectPath).requestFingerprint,
        idempotencyKeyHash: createRestoreContext('restore-2', projectPath).idempotencyKeyHash,
      },
    }),
  ])
  await expect(retried.client.restoreTeam(
    directoryId,
    'alpha',
    createRestoreContext('restore-1', teamPath),
  )).resolves.toEqual({ teamId: 'alpha' })
  await expect(retried.client.restoreProject(
    directoryId,
    'alpha',
    'gone',
    createRestoreContext('restore-2', projectPath),
  )).resolves.toEqual({ teamId: 'alpha', projectId: 'gone' })
  expect(retried.transactions()).toEqual([])

  // A new key is a new request, and the Team is no longer archived.
  await expect(retried.client.restoreTeam(
    directoryId,
    'alpha',
    createRestoreContext('restore-3', teamPath),
  )).rejects.toMatchObject({ status: 409, code: 'TeamNotArchived' })
  // The same key with another request is refused.
  await expect(retried.client.restoreTeam(
    directoryId,
    'alpha',
    createRestoreContext('restore-1', '/api/teams/alpha/restore?other'),
  )).rejects.toMatchObject({ status: 409, code: 'IdempotencyKeyConflict' })
})

test('keeps the search sources of Projects under an archived Team', async () => {
  const archivedAt = '2026-06-06T00:00:00.000Z'
  const { client } = createClient([
    createTeamRow('alpha', 10, { archivedAt, lifecycleRevision: 1 }),
    createProjectRow('alpha', 10, 'gone', 10, { archivedAt, lifecycleRevision: 1 }),
    createProjectRow('alpha', 10, 'kept', 20),
  ])

  // The archived Project's document must still be removed after its Team was archived too.
  await expect(client.getProjectSearchSource(directoryId, 'alpha', 'gone')).resolves.toMatchObject({
    archived: true,
    sourceRevision: 1,
  })
  // A rename committed before the Team archive is still projected.
  await expect(client.getProjectSearchSource(directoryId, 'alpha', 'kept')).resolves.toMatchObject({
    archived: false,
  })
})

test('reads the search source of a Team with its revision, archive state, and creator', async () => {
  const { client } = createClient([
    createTeamRow('alpha', 10, {
      nameRevision: 3,
      lifecycleRevision: 2,
      creatorUserId: 'owner@example.com',
    }),
    createTeamRow('beta', 20),
    createTeamRow('gone', 30, { archivedAt: '2026-06-06T00:00:00.000Z', lifecycleRevision: 1 }),
  ])

  await expect(client.getTeamSearchSource(directoryId, 'alpha')).resolves.toEqual({
    archived: false,
    nameJa: 'alpha 日本語',
    nameEn: 'alpha English',
    creatorUserId: 'owner@example.com',
    sourceRevision: 5,
  })
  await expect(client.getTeamSearchSource(directoryId, 'beta')).resolves.toEqual({
    archived: false,
    nameJa: 'beta 日本語',
    nameEn: 'beta English',
    sourceRevision: 0,
  })
  await expect(client.getTeamSearchSource(directoryId, 'gone')).resolves.toMatchObject({
    archived: true,
    sourceRevision: 1,
  })
  await expect(client.getTeamSearchSource(directoryId, 'missing')).resolves.toBeUndefined()
})

test('refuses a restore while the archive Webhook grant cleanup is still running', async () => {
  const archivedAt = '2026-06-06T00:00:00.000Z'
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10, { archivedAt }),
    createTeamRow('beta', 20),
    createProjectRow('beta', 20, 'gone', 10, { archivedAt }),
  ], false, {}, [
    { directoryId: `WEBHOOK_GRANT_CLEANUP#${directoryId}#alpha`, entryKey: 'PROJECT#x#MEMBER#m' },
    { directoryId: `WEBHOOK_GRANT_CLEANUP#${directoryId}#beta`, entryKey: 'PROJECT#gone#MEMBER#m' },
  ])

  await expect(client.restoreTeam(directoryId, 'alpha'))
    .rejects.toMatchObject({ status: 409, code: 'DirectoryArchiveCleanupPending' })
  await expect(client.restoreProject(directoryId, 'beta', 'gone'))
    .rejects.toMatchObject({ status: 409, code: 'DirectoryArchiveCleanupPending' })
  expect(transactions()).toEqual([])
})

test('binds a restore to the archive it read and fences every change by the caller authorization', async () => {
  const archivedAt = '2026-06-06T00:00:00.000Z'
  const authorization = [{
    ConditionCheck: {
      TableName: 'WorkspaceAccessTable',
      Key: { workspaceId: directoryId, recordKey: 'MEMBER#admin' },
      ConditionExpression: '#version = :expectedVersion',
    },
  }]
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10, { archivedAt }),
  ])

  await client.restoreTeam(directoryId, 'alpha', undefined, authorization)
  expect(transactions()).toEqual([[
    {
      Update: expect.objectContaining({
        ConditionExpression: expect.stringContaining('#archivedAt = :readArchivedAt'),
        ExpressionAttributeValues: expect.objectContaining({ ':readArchivedAt': archivedAt }),
      }),
    },
    ...authorization,
  ]])

  const revoked = createClient([createTeamRow('alpha', 10)], false, {}, [], 1)
  await expect(revoked.client.renameTeam(directoryId, 'alpha', { nameJa: '改名' }, undefined, authorization))
    .rejects.toMatchObject({ status: 403, code: 'DirectoryAuthorizationChanged' })
})

test('sets a Team description and leader, guarding the revision and the active leader', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10),
    createTeamRow('beta', 20, { description: '古い説明', leaderMemberKey: 'old', profileRevision: 2 }),
  ])

  await expect(client.updateTeamProfile(directoryId, 'alpha', {
    description: ' 1行目\r\n\t2行目 ',
    leaderMemberKey: 'Leader-User',
    expectedProfileRevision: 0,
  })).resolves.toEqual({ teamId: 'alpha', description: '1行目\n\t2行目', leaderMemberKey: 'leader-user' })
  await expect(client.updateTeamProfile(directoryId, 'beta', {
    description: '',
    leaderMemberKey: null,
    expectedProfileRevision: 2,
  })).resolves.toEqual({ teamId: 'beta' })

  expect(transactions()).toEqual([
    [
      {
        Update: expect.objectContaining({
          Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
          UpdateExpression:
            'SET #profileRevision = :profileRevision, #description = :description, #leaderMemberKey = :leaderMemberKey REMOVE #profileRequestKey',
          ConditionExpression: expect.stringContaining('attribute_not_exists(#profileRevision)'),
          ExpressionAttributeValues: expect.objectContaining({
            ':description': '1行目\n\t2行目',
            ':leaderMemberKey': 'leader-user',
            ':profileRevision': 1,
          }),
        }),
      },
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'WorkspaceAccessTable',
          Key: { workspaceId: directoryId, recordKey: 'MEMBER#leader-user' },
          ConditionExpression: '#entryType = :memberEntryType AND #status = :active',
        }),
      },
    ],
    [{
      Update: expect.objectContaining({
        UpdateExpression: 'SET #profileRevision = :profileRevision REMOVE #profileRequestKey, #description, #leaderMemberKey',
        ConditionExpression: expect.stringContaining('#profileRevision = :readProfileRevision'),
        ExpressionAttributeValues: expect.objectContaining({
          ':readProfileRevision': 2,
          ':profileRevision': 3,
        }),
      }),
    }],
  ])
})

test('skips an unchanged Team profile and rejects an invalid one', async () => {
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10, { description: '説明' }),
    createTeamRow('gone', 20, { archivedAt: '2026-01-01T00:00:00.000Z' }),
  ])

  await expect(client.updateTeamProfile(directoryId, 'alpha', {
    description: '説明',
    leaderMemberKey: null,
    expectedProfileRevision: 0,
  })).resolves.toEqual({ teamId: 'alpha', description: '説明' })
  expect(transactions()).toEqual([])

  // A form loaded before another administrator's save is refused instead of overwriting it.
  await expect(client.updateTeamProfile(directoryId, 'alpha', {
    description: '別の説明',
    leaderMemberKey: null,
    expectedProfileRevision: 3,
  })).rejects.toMatchObject({ status: 409, code: 'TeamProfileConflict' })
  expect(transactions()).toEqual([])

  await expect(client.updateTeamProfile(directoryId, 'gone', {
    description: '',
    leaderMemberKey: null,
    expectedProfileRevision: 0,
  }))
    .rejects.toMatchObject({ status: 404, code: 'TeamNotFound' })
  for (const input of [
    { description: 'x'.repeat(2001), leaderMemberKey: null, expectedProfileRevision: 0 },
    { description: 'nul\u0000', leaderMemberKey: null, expectedProfileRevision: 0 },
    // A control character at either end is refused, not trimmed away.
    { description: '\u000bleading tab', leaderMemberKey: null, expectedProfileRevision: 0 },
    { description: 'trailing\u001f', leaderMemberKey: null, expectedProfileRevision: 0 },
    { description: '', leaderMemberKey: 7, expectedProfileRevision: 0 },
    { leaderMemberKey: null, expectedProfileRevision: 0 },
    { description: '', leaderMemberKey: null },
    { description: '', leaderMemberKey: null, expectedProfileRevision: -1 },
  ]) {
    await expect(client.updateTeamProfile(directoryId, 'alpha', input))
      .rejects.toMatchObject({ status: 400, code: 'InvalidProjectWrite' })
  }
})

test('lists the Team description and leader for administration', async () => {
  const { client } = createClient([
    createTeamRow('alpha', 10, { description: '説明', leaderMemberKey: 'leader', profileRevision: 1 }),
  ])

  const directory = await client.getDirectoryAdministration(directoryId)

  expect(directory.teams[0]).toMatchObject({
    id: 'alpha',
    description: '説明',
    leaderMemberKey: 'leader',
    profileRevision: 1,
  })
})

/**
 * Creates a stored Project member row.
 *
 * @param projectId - Project identifier.
 * @param memberKey - Normalized member key.
 * @returns The stored row.
 */
function createProjectMemberRow(projectId: string, memberKey: string) {
  return {
    directoryId,
    entryKey: `PROJECT_MEMBER#${projectId}#${memberKey}`,
    entryType: 'project-member',
    projectId,
    memberKey,
    email: memberKey,
    role: 'manager',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }
}

/**
 * Counts the items of a sent transaction.
 *
 * @param value - Transaction items as sent.
 * @returns The number of items, or 0 when none were sent.
 */
function lengthOf(value: unknown) {
  return listItems(value).length
}

/**
 * Narrows an untrusted value to a plain record.
 *
 * @param value - Value to inspect.
 * @returns Whether the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads the items of a sent transaction.
 *
 * @param value - Transaction items as sent.
 * @returns The items, or an empty list when none were sent.
 */
function listItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Caller authorization guards: the caller's member row and the Enterprise control row. */
const callerAuthorization = [
  {
    ConditionCheck: {
      TableName: 'WorkspaceAccessTable',
      Key: { workspaceId: directoryId, recordKey: 'MEMBER#admin@example.com' },
      ConditionExpression: '#version = :expectedVersion',
    },
  },
  {
    ConditionCheck: {
      TableName: 'EnterpriseTable',
      Key: { scopeKey: `WORKSPACE#${directoryId}`, recordKey: 'CONTROL' },
      ConditionExpression: '#controlRevision = :expectedControlRevision',
    },
  },
]

test('adds a Project member insert-only, fenced by the caller authorization', async () => {
  const rows = [
    createTeamRow('alpha', 10),
    createProjectRow('alpha', 10, 'refero', 1),
    createProjectMemberRow('refero', 'kept@example.com'),
  ]
  const { client, transactions } = createClient(rows)
  const input = { role: 'viewer', email: 'sato@example.com' }

  await expect(client.addProjectMemberIfAbsent(
    directoryId, 'alpha', 'refero', 'Sato@example.com', input, 3, undefined, callerAuthorization,
  )).resolves.toEqual({ added: true })
  await expect(client.addProjectMemberIfAbsent(
    directoryId, 'alpha', 'refero', 'kept@example.com', input, 3, undefined, callerAuthorization,
  )).resolves.toEqual({ added: false })
  await expect(client.addProjectMemberIfAbsent(
    directoryId, 'alpha', 'refero', 'admin@example.com', input, 7, undefined, callerAuthorization,
  )).resolves.toEqual({ added: true })
  await expect(client.addProjectMemberIfAbsent(
    directoryId, 'beta', 'refero', 'sato@example.com', input, 3, undefined, callerAuthorization,
  )).rejects.toMatchObject({ status: 404 })

  const [toOther, toSelf] = transactions().map(listItems)
  expect(transactions()).toHaveLength(2)
  expect(toOther?.slice(0, 2)).toEqual([
    {
      Put: expect.objectContaining({
        Item: expect.objectContaining({ memberKey: 'sato@example.com', role: 'viewer' }),
        ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
      }),
    },
    {
      Update: expect.objectContaining({
        Key: { workspaceId: directoryId, recordKey: 'MEMBER#sato@example.com' },
        ExpressionAttributeValues: expect.objectContaining({ ':expectedVersion': 3 }),
      }),
    },
  ])
  expect(toOther?.slice(-2)).toEqual(callerAuthorization)
  // A caller adding themselves is guarded by the version update of their own row instead.
  expect(toSelf?.[1]).toEqual({
    Update: expect.objectContaining({
      Key: { workspaceId: directoryId, recordKey: 'MEMBER#admin@example.com' },
    }),
  })
  expect(toSelf).not.toContainEqual(callerAuthorization[0])
  expect(toSelf?.at(-1)).toEqual(callerAuthorization[1])
  expect(toSelf).toHaveLength(lengthOf(toOther) - 1)
})

test('keeps a Project role granted concurrently and refuses a revoked caller', async () => {
  const rows: Array<Record<string, unknown>> = [
    createTeamRow('alpha', 10),
    createProjectRow('alpha', 10, 'refero', 1),
  ]
  // Another administrator's grant lands after the first read, so the insert-only write fails.
  const raced = createClient(rows, false, {}, [], 0, () => {
    rows.push(createProjectMemberRow('refero', 'sato@example.com'))
  })
  const input = { role: 'viewer', email: 'sato@example.com' }
  await expect(raced.client.addProjectMemberIfAbsent(
    directoryId, 'alpha', 'refero', 'sato@example.com', input, 3, undefined, callerAuthorization,
  )).resolves.toEqual({ added: false })
  // The failed insert is followed by a read that finds the concurrent role.
  expect(raced.transactions()).toHaveLength(1)
  expect(raced.queryCount()).toBe(2)

  const projectRows = [createTeamRow('alpha', 10), createProjectRow('alpha', 10, 'refero', 1)]
  const probe = createClient(projectRows)
  await probe.client.addProjectMemberIfAbsent(
    directoryId, 'alpha', 'refero', 'sato@example.com', input, 3, undefined, callerAuthorization,
  )
  const lastIndex = lengthOf(probe.transactions()[0]) - 1
  // The Enterprise control row, the caller's last guard, has changed.
  const revoked = createClient(projectRows, false, {}, [], lastIndex)
  await expect(revoked.client.addProjectMemberIfAbsent(
    directoryId, 'alpha', 'refero', 'sato@example.com', input, 3, undefined, callerAuthorization,
  )).rejects.toMatchObject({ status: 403, code: 'DirectoryAuthorizationChanged' })
})

test('fences each Team-wide grant on its Team and Project still being active', async () => {
  const rows = [createTeamRow('alpha', 10), createProjectRow('alpha', 10, 'refero', 1)]
  const { client, transactions } = createClient(rows)
  await client.addProjectMemberIfAbsent(
    directoryId, 'alpha', 'refero', 'sato@example.com', { role: 'viewer', email: 'sato@example.com' }, 3,
  )

  // An archive that commits after the read fails these checks, so the grant is not written.
  expect(listItems(transactions()[0])).toEqual(expect.arrayContaining([
    {
      ConditionCheck: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000000#TEAM#alpha' },
        ConditionExpression: '#entryType = :teamEntryType AND attribute_not_exists(archivedAt)',
      }),
    },
    {
      ConditionCheck: expect.objectContaining({
        Key: { directoryId, entryKey: '000010#000001#PROJECT#refero' },
        ConditionExpression: '#entryType = :projectEntryType AND attribute_not_exists(archivedAt)',
      }),
    },
  ]))
})

test('binds a Team-wide grant key to its input with a conditional receipt', async () => {
  const { client, receipts } = createClient([])
  const grantRequest = { idempotencyKeyHash: 'key-hash', requestFingerprint: 'member-request' }

  await client.bindTeamGrantRequest(directoryId, grantRequest)

  // The receipt sits outside the directory partition, and only the same input meets its condition.
  expect(receipts()).toEqual([[{
    Put: {
      TableName: 'DirectoryTable',
      Item: {
        directoryId: `TEAM_GRANT_REQUEST#${encodeURIComponent(directoryId)}`,
        entryKey: 'KEY#key-hash',
        entryType: 'team-grant-request',
        workspaceId: directoryId,
        requestFingerprint: 'member-request',
        createdAt: expect.any(String),
      },
      ConditionExpression: 'attribute_not_exists(#entryKey) OR #requestFingerprint = :requestFingerprint',
      ExpressionAttributeNames: { '#entryKey': 'entryKey', '#requestFingerprint': 'requestFingerprint' },
      ExpressionAttributeValues: { ':requestFingerprint': 'member-request' },
    },
  }]])

  // Against stored receipts, the first input wins: it may repeat, and another input is refused.
  const stored = new Map<string, string>()
  /**
   * Stores receipts and evaluates their write condition like DynamoDB does.
   *
   * @param command - Sent command; only receipt transactions are expected.
   * @returns An empty response once the receipt is written.
   */
  const sendReceipt = async (command: SentCommand) => {
    const [put] = listItems(command.input.TransactItems)
    const item: unknown = isRecord(put) && isRecord(put.Put) ? put.Put.Item : undefined
    if (!isRecord(item) || typeof item.entryKey !== 'string' || typeof item.requestFingerprint !== 'string') {
      throw new Error('Expected a receipt Put.')
    }
    const fingerprint = stored.get(item.entryKey)
    if (fingerprint !== undefined && fingerprint !== item.requestFingerprint) {
      throw Object.assign(new Error('Transaction was canceled.'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      })
    }
    stored.set(item.entryKey, item.requestFingerprint)
    return {}
  }
  const stateful = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    // The fake implements only `send`, the one method the receipt write calls.
    { send: sendReceipt } as unknown as DynamoDBDocumentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
    'PlanningTable',
  )
  await stateful.bindTeamGrantRequest(directoryId, grantRequest)
  await expect(stateful.bindTeamGrantRequest(directoryId, grantRequest)).resolves.toBeUndefined()
  await expect(stateful.bindTeamGrantRequest(
    directoryId,
    { idempotencyKeyHash: 'key-hash', requestFingerprint: 'other-member-request' },
  )).rejects.toMatchObject({ status: 409, code: 'IdempotencyKeyConflict' })
  await expect(stateful.bindTeamGrantRequest(
    directoryId,
    { idempotencyKeyHash: 'other-hash', requestFingerprint: 'other-member-request' },
  )).resolves.toBeUndefined()
})

test('does not check the leader twice when the caller leads the Team', async () => {
  const { client, transactions } = createClient([createTeamRow('alpha', 10)])

  await client.updateTeamProfile(
    directoryId,
    'alpha',
    { description: '', leaderMemberKey: 'Admin@example.com', expectedProfileRevision: 0 },
    undefined,
    callerAuthorization,
  )

  expect(transactions()).toEqual([[
    expect.objectContaining({ Update: expect.anything() }),
    ...callerAuthorization,
  ]])
})

test('answers a retried profile save as its success and refuses another stale request', async () => {
  const saved = createRestoreContext('profile-key', '/api/teams/alpha/profile')
  const { client, transactions } = createClient([
    createTeamRow('alpha', 10, {
      description: '説明',
      profileRevision: 1,
      profileRequestKey: `${saved.idempotencyKeyHash}:${saved.requestFingerprint}`,
    }),
  ])
  const input = { description: '説明', leaderMemberKey: null, expectedProfileRevision: 0 }

  // The first save committed but its response was lost; the same request is answered again.
  await expect(client.updateTeamProfile(directoryId, 'alpha', input, saved))
    .resolves.toEqual({ teamId: 'alpha', description: '説明' })
  await expect(client.updateTeamProfile(
    directoryId,
    'alpha',
    input,
    createRestoreContext('another-key', '/api/teams/alpha/profile'),
  )).rejects.toMatchObject({ status: 409, code: 'TeamProfileConflict' })
  expect(transactions()).toEqual([])
})

test('answers the same profile save sent twice at once as one success', async () => {
  const context = createRestoreContext('profile-key', '/api/teams/alpha/profile')
  const input = { description: '新しい説明', leaderMemberKey: null, expectedProfileRevision: 0 }
  const rows: Array<Record<string, unknown>> = [createTeamRow('alpha', 10)]
  // The twin request commits after this one read the Team, so this one loses the revision.
  const raced = createClient(rows, false, {}, [], 0, () => {
    rows[0] = createTeamRow('alpha', 10, {
      description: '新しい説明',
      profileRevision: 1,
      profileRequestKey: `${context.idempotencyKeyHash}:${context.requestFingerprint}`,
    })
  })
  await expect(raced.client.updateTeamProfile(directoryId, 'alpha', input, context))
    .resolves.toEqual({ teamId: 'alpha', description: '新しい説明' })

  // Another request losing the same race is still refused.
  rows[0] = createTeamRow('alpha', 10)
  const other = createRestoreContext('other-key', '/api/teams/alpha/profile')
  await expect(raced.client.updateTeamProfile(directoryId, 'alpha', input, other))
    .rejects.toMatchObject({ status: 409 })
})

test('refuses a profile save under a key already used with another input', async () => {
  const { client, transactions } = createClient([createTeamRow('alpha', 10)])
  const input = { description: '新しい説明', leaderMemberKey: null, expectedProfileRevision: 0 }
  await client.updateTeamProfile(
    directoryId, 'alpha', input, createRestoreContext('profile-key', '/api/teams/alpha/profile'),
  )

  // The same key with another request is refused before the profile is written again.
  await expect(client.updateTeamProfile(
    directoryId,
    'alpha',
    { ...input, description: '別の説明', expectedProfileRevision: 1 },
    createRestoreContext('profile-key', '/api/teams/alpha/profile/other'),
  )).rejects.toMatchObject({ status: 409, code: 'IdempotencyKeyConflict' })
  expect(transactions()).toHaveLength(1)
})

test('records the request of a profile save so its retry is recognized', async () => {
  const context = createRestoreContext('profile-key', '/api/teams/alpha/profile')
  const { client, transactions, receipts } = createClient([createTeamRow('alpha', 10)])

  await client.updateTeamProfile(
    directoryId,
    'alpha',
    { description: '新しい説明', leaderMemberKey: null, expectedProfileRevision: 0 },
    context,
  )

  // The key is bound to this input before the profile is written.
  expect(receipts()).toEqual([[{
    Put: expect.objectContaining({
      Item: expect.objectContaining({
        entryKey: `KEY#${context.idempotencyKeyHash}`,
        requestFingerprint: context.requestFingerprint,
      }),
    }),
  }]])

  expect(transactions()[0]).toEqual(expect.arrayContaining([{
    Update: expect.objectContaining({
      ExpressionAttributeValues: expect.objectContaining({
        ':profileRequestKey': `${context.idempotencyKeyHash}:${context.requestFingerprint}`,
      }),
    }),
  }]))
})
