import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createMutationAuditContext } from '../../../audit/audit'
import { ProjectDataError } from '../../project-data-error'
import { createOrgStructureRevisionConditionCheck } from './org-structure-item'
import { DynamoDbProjectDirectoryClient } from './project-directory-client'

const workspaceId = 'workspace/1'

/** Command shape the fake document client receives. */
type SentCommand = { input: Record<string, unknown> }

/**
 * Creates a stored Team row of the Workspace directory partition.
 *
 * @param teamId - Team identifier.
 * @param teamSortOrder - Creation position.
 * @returns The stored row.
 */
function createTeamRow(teamId: string, teamSortOrder: number) {
  return {
    directoryId: workspaceId,
    entryKey: `${String(teamSortOrder).padStart(6, '0')}#000000#TEAM#${teamId}`,
    entryType: 'team',
    teamId,
    teamSortOrder,
    nameJa: teamId,
    nameEn: teamId,
  }
}

/**
 * Tells whether a value is a non-array object.
 *
 * @param value - Value to test.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Builds the map key of a stored row.
 *
 * @param key - Row or key with `directoryId` and `entryKey`.
 * @returns The map key, or undefined when the value has no primary key.
 */
function toRowKey(key: unknown): string | undefined {
  if (!isRecord(key) || typeof key.directoryId !== 'string' || typeof key.entryKey !== 'string') return undefined
  return `${key.directoryId}\0${key.entryKey}`
}

/**
 * Creates a directory client whose fake table holds Team rows, one OrgUnit structure row, and
 * idempotency receipts.
 *
 * @param stored - Stored OrgUnit structure row, if any.
 * @param failTransaction - Whether the next transaction loses its condition.
 * @param beforeTransaction - Runs before each transaction, to change rows concurrently.
 * @returns The client, the sent commands, the stored structure row, and every stored row.
 */
function createClient(
  stored?: Record<string, unknown>,
  failTransaction = false,
  beforeTransaction?: (rows: Map<string, Record<string, unknown>>) => void,
) {
  const sent: SentCommand[] = []
  const rows = new Map<string, Record<string, unknown>>()
  const structureKey = 'ORG_STRUCTURE#workspace%2F1\0STRUCTURE'
  if (stored) rows.set(structureKey, stored)
  const send = async (command: SentCommand) => {
    sent.push(command)
    if ('KeyConditionExpression' in command.input) {
      return { Items: [createTeamRow('east-team', 1), createTeamRow('platform', 2)] }
    }
    if ('TransactItems' in command.input) {
      const items = command.input.TransactItems
      beforeTransaction?.(rows)
      if (failTransaction) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: (Array.isArray(items) ? items : []).map(() => ({ Code: 'ConditionalCheckFailed' })),
        })
      }
      for (const item of Array.isArray(items) ? items : []) {
        if (!isRecord(item) || !isRecord(item.Put) || !isRecord(item.Put.Item)) continue
        const rowKey = toRowKey(item.Put.Item)
        if (rowKey !== undefined) rows.set(rowKey, item.Put.Item)
      }
      return {}
    }
    const rowKey = toRowKey(command.input.Key)
    return { Item: rowKey === undefined ? undefined : rows.get(rowKey) }
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
  return { client, sent, stored: () => rows.get(structureKey), rows }
}

const storedRow = {
  directoryId: 'ORG_STRUCTURE#workspace%2F1',
  entryKey: 'STRUCTURE',
  entryType: 'org-structure',
  workspaceId,
  orgUnits: [{ id: 'sales', name: 'Sales' }],
  teamAssignments: [{ teamId: 'east-team', orgUnitId: 'sales' }],
  revision: 1,
  updatedAt: '2026-11-20T00:00:00.000Z',
}

test('reads an empty structure before the first save from the Workspace sidecar row', async () => {
  const { client, sent } = createClient()

  expect(await client.getOrgStructure(workspaceId, true)).toEqual({
    orgUnits: [],
    teamAssignments: [],
    revision: 0,
  })
  expect(sent[0]?.input).toEqual({
    TableName: 'DirectoryTable',
    ConsistentRead: true,
    Key: { directoryId: 'ORG_STRUCTURE#workspace%2F1', entryKey: 'STRUCTURE' },
  })
})

test('fails closed on a stored structure of another Workspace or with a broken tree', async () => {
  await expect(createClient({ ...storedRow, workspaceId: 'other' }).client.getOrgStructure(workspaceId))
    .rejects.toMatchObject({ status: 503, code: 'OrgStructureUnavailable' })
  await expect(createClient({
    ...storedRow,
    orgUnits: [{ id: 'sales', name: 'Sales', parentId: 'sales' }],
  }).client.getOrgStructure(workspaceId))
    .rejects.toMatchObject({ status: 503, code: 'OrgStructureUnavailable' })
})

test('creates the first structure insert-only and then updates it by revision', async () => {
  const { client, sent, stored } = createClient()

  const created = await client.replaceOrgStructure(workspaceId, {
    expectedRevision: 0,
    orgUnits: [{ id: 'sales', name: 'Sales' }],
    teamAssignments: [{ teamId: 'east-team', orgUnitId: 'sales' }],
  })
  expect(created).toMatchObject({ revision: 1, orgUnits: [{ id: 'sales', name: 'Sales' }] })
  const firstPut = sent.find((command) => 'TransactItems' in command.input)?.input.TransactItems
  expect(firstPut).toEqual([{
    Put: {
      TableName: 'DirectoryTable',
      Item: { ...stored(), revision: 1 },
      ConditionExpression: 'attribute_not_exists(entryKey)',
    },
  }])

  const updated = await client.replaceOrgStructure(workspaceId, {
    expectedRevision: 1,
    orgUnits: [],
    teamAssignments: [],
  })
  expect(updated.revision).toBe(2)
  const secondPut = sent.filter((command) => 'TransactItems' in command.input)[1]?.input.TransactItems
  expect(secondPut).toMatchObject([{
    Put: {
      ConditionExpression: '#revision = :expectedRevision AND #entryType = :entryType',
      ExpressionAttributeValues: { ':expectedRevision': 1, ':entryType': 'org-structure' },
    },
  }])
})

test('refuses unknown Teams, a stale revision, and a lost condition', async () => {
  await expect(createClient().client.replaceOrgStructure(workspaceId, {
    expectedRevision: 0,
    orgUnits: [{ id: 'sales', name: 'Sales' }],
    teamAssignments: [{ teamId: 'future-team', orgUnitId: 'sales' }],
  })).rejects.toMatchObject({ status: 409, code: 'OrgStructureTeamNotFound' })

  await expect(createClient(storedRow).client.replaceOrgStructure(workspaceId, {
    expectedRevision: 0,
    orgUnits: [],
    teamAssignments: [],
  })).rejects.toMatchObject({ status: 409, code: 'OrgStructureConflict' })

  const lost = createClient(storedRow, true).client.replaceOrgStructure(workspaceId, {
    expectedRevision: 1,
    orgUnits: [],
    teamAssignments: [],
  })
  await expect(lost).rejects.toBeInstanceOf(ProjectDataError)
  await expect(lost).rejects.toMatchObject({ status: 409, code: 'OrgStructureConflict' })
})

test('fences an authorization on the structure revision it read', () => {
  expect(createOrgStructureRevisionConditionCheck('DirectoryTable', workspaceId, 3)).toEqual({
    ConditionCheck: {
      TableName: 'DirectoryTable',
      Key: { directoryId: 'ORG_STRUCTURE#workspace%2F1', entryKey: 'STRUCTURE' },
      ConditionExpression: '#entryType = :orgStructureEntryType AND #revision = :expectedOrgStructureRevision',
      ExpressionAttributeNames: { '#entryType': 'entryType', '#revision': 'revision' },
      ExpressionAttributeValues: { ':orgStructureEntryType': 'org-structure', ':expectedOrgStructureRevision': 3 },
    },
  })
  // Before the first save no row exists, and creating one must also invalidate the decision.
  expect(createOrgStructureRevisionConditionCheck('DirectoryTable', workspaceId, 0)).toEqual({
    ConditionCheck: {
      TableName: 'DirectoryTable',
      Key: { directoryId: 'ORG_STRUCTURE#workspace%2F1', entryKey: 'STRUCTURE' },
      ConditionExpression: 'attribute_not_exists(#entryKey)',
      ExpressionAttributeNames: { '#entryKey': 'entryKey' },
    },
  })
})

test('drops a caller fence on the structure row it replaces, since a transaction names a row once', async () => {
  const { client, sent } = createClient(storedRow)
  const memberFence = {
    ConditionCheck: {
      TableName: 'WorkspaceAccessTable',
      Key: { workspaceId, recordKey: 'MEMBER#admin' },
      ConditionExpression: 'attribute_exists(recordKey)',
    },
  }

  await client.replaceOrgStructure(workspaceId, {
    expectedRevision: 1,
    orgUnits: [],
    teamAssignments: [],
  }, undefined, [createOrgStructureRevisionConditionCheck('DirectoryTable', workspaceId, 1), memberFence])

  const items = sent.find((command) => 'TransactItems' in command.input)?.input.TransactItems
  expect(Array.isArray(items) ? items.length : 0).toBe(2)
  expect(items).toMatchObject([{ Put: { TableName: 'DirectoryTable' } }, memberFence])
})

/**
 * Creates the audit context of one `PUT /api/org-structure` request.
 *
 * @param idempotencyKey - Caller's `Idempotency-Key`.
 * @param body - Request body, which the fingerprint covers.
 * @returns The mutation audit context.
 */
function createSaveContext(idempotencyKey: string, body: unknown) {
  return createMutationAuditContext({
    workspaceId,
    actor: { id: 'sub-admin', kind: 'user', displayName: 'admin@example.com' },
    idempotencyKey,
    request: { method: 'PUT', path: '/api/org-structure', body },
    source: { kind: 'api', requestId: `request-${idempotencyKey}` },
  })
}

const savedBody = {
  expectedRevision: 1,
  orgUnits: [{ id: 'sales', name: 'Sales' }, { id: 'engineering', name: 'Engineering' }],
  teamAssignments: [{ teamId: 'platform', orgUnitId: 'engineering' }],
}

test('answers a retried save with the structure it saved and refuses a reused key', async () => {
  const { client, sent, rows } = createClient(storedRow)

  const saved = await client.replaceOrgStructure(workspaceId, savedBody, createSaveContext('save-1', savedBody))
  expect(saved).toMatchObject({ revision: 2, orgUnits: savedBody.orgUnits })
  const transaction = sent.find((command) => 'TransactItems' in command.input)?.input.TransactItems
  // The receipt commits in the same transaction as the structure, insert-only.
  expect(transaction).toMatchObject([
    { Put: { Item: { entryKey: 'STRUCTURE', revision: 2 } } },
    {
      Put: {
        TableName: 'DirectoryTable',
        Item: {
          directoryId: 'TEAM_GRANT_REQUEST#workspace%2F1',
          entryType: 'team-grant-request',
          workspaceId,
          createdAt: saved.updatedAt,
        },
        ConditionExpression: 'attribute_not_exists(#entryKey)',
      },
    },
  ])
  expect([...rows.keys()].filter((key) => key.startsWith('TEAM_GRANT_REQUEST#')).length).toBe(1)

  // The response was lost: the retry finds the receipt instead of losing to its own revision.
  const transactionCount = sent.filter((command) => 'TransactItems' in command.input).length
  expect(await client.replaceOrgStructure(workspaceId, savedBody, createSaveContext('save-1', savedBody)))
    .toEqual(saved)
  expect(sent.filter((command) => 'TransactItems' in command.input).length).toBe(transactionCount)

  const otherBody = { ...savedBody, teamAssignments: [] }
  await expect(client.replaceOrgStructure(workspaceId, otherBody, createSaveContext('save-1', otherBody)))
    .rejects.toMatchObject({ status: 409, code: 'IdempotencyKeyConflict' })
  // Another key on the stale revision stays a conflict.
  await expect(client.replaceOrgStructure(workspaceId, savedBody, createSaveContext('save-2', savedBody)))
    .rejects.toMatchObject({ status: 409, code: 'OrgStructureConflict' })
})

test('answers a lost transaction with success only when its receipt committed', async () => {
  // A duplicate of the same request committed first: its receipt proves the save.
  const duplicate = createClient(storedRow, true, (rows) => {
    const receipt = createSaveContext('save-1', savedBody)
    rows.set(`TEAM_GRANT_REQUEST#workspace%2F1\0KEY#${receipt.idempotencyKeyHash}`, {
      directoryId: 'TEAM_GRANT_REQUEST#workspace%2F1',
      entryKey: `KEY#${receipt.idempotencyKeyHash}`,
      entryType: 'team-grant-request',
      workspaceId,
      requestFingerprint: receipt.requestFingerprint,
      createdAt: '2026-11-21T00:00:00.000Z',
    })
  })
  expect(await duplicate.client.replaceOrgStructure(workspaceId, savedBody, createSaveContext('save-1', savedBody)))
    .toEqual({
      orgUnits: savedBody.orgUnits,
      teamAssignments: savedBody.teamAssignments,
      revision: 2,
      updatedAt: '2026-11-21T00:00:00.000Z',
    })

  // Another administrator saved first and no receipt of this key exists: still a conflict.
  const raced = createClient(storedRow, true)
  await expect(raced.client.replaceOrgStructure(workspaceId, savedBody, createSaveContext('save-1', savedBody)))
    .rejects.toMatchObject({ status: 409, code: 'OrgStructureConflict' })
})
