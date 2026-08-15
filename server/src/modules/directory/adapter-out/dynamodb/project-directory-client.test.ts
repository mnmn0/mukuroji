import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  createDirectoryMutationAuditContext,
  createProjectMemberFixtureItems,
  createSharedProjectCapacityClient,
  createWorkspaceBootstrapItems,
  resetTestApp,
} = createApiTestHarness()
import {
  DynamoDbProjectDirectoryClient,
} from './project-directory-client'
import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import type {
  DynamoDBDocumentClient,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  PROJECT_QUICK_ACCESS_IDENTIFIER_MAX_LENGTH,
  PROJECT_QUICK_ACCESS_MAX_ITEMS,
  PROJECT_QUICK_ACCESS_MAX_REVISION,
  type ProjectQuickAccessItem,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/** Creates the DynamoDB cancellation shape used for compare-and-swap failures. */
function createConditionalTransactionCancellation() {
  return Object.assign(new Error('Transaction was canceled.'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  })
}

/**
 * Creates one valid persisted quick-access sidecar fixture.
 *
 * @param workspaceId - Workspace that owns the preference.
 * @param memberKey - Member that owns the preference.
 * @param revision - Positive persisted revision.
 * @param items - Ordered Team-owned Project identities.
 * @returns A storage row accepted by the directory client.
 */
function createProjectQuickAccessStoredItem(
  workspaceId: string,
  memberKey: string,
  revision: number,
  items: readonly ProjectQuickAccessItem[],
) {
  return {
    directoryId:
      `PROJECT_QUICK_ACCESS#${encodeURIComponent(workspaceId)}#${encodeURIComponent(memberKey)}`,
    entryKey: 'PREFERENCE',
    entryType: 'project-quick-access',
    items: items.map((item) => ({ ...item })),
    memberKey,
    revision,
    updatedAt: '2026-08-01T00:00:00.000Z',
    workspaceId,
  }
}

test('DynamoDB directory client returns the revision-zero quick-access default', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectQuickAccess(
    'workspace/production',
    'demo+member@example.com',
    true,
  )).resolves.toEqual({ items: [], revision: 0 })
  expect(sentInputs).toEqual([{
    ConsistentRead: true,
    Key: {
      directoryId:
        'PROJECT_QUICK_ACCESS#workspace%2Fproduction#demo%2Bmember%40example.com',
      entryKey: 'PREFERENCE',
    },
    TableName: 'DirectoryTable',
  }])
})

test('DynamoDB directory client round-trips ordered quick-access preferences', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const items = [
    { projectId: 'shared-project', teamId: 'core-team' },
    { projectId: 'shared-project', teamId: 'design-team' },
  ]
  let stored = false
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      if ('TransactItems' in command.input) {
        stored = true
        return {}
      }
      return stored
        ? { Item: createProjectQuickAccessStoredItem('workspace#one', 'demo@example.com', 1, items) }
        : {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.replaceProjectQuickAccess(
    'workspace#one',
    'demo@example.com',
    { items, revision: 0 },
  )).resolves.toEqual({ items, revision: 1 })
  await expect(client.getProjectQuickAccess(
    'workspace#one',
    'demo@example.com',
  )).resolves.toEqual({ items, revision: 1 })
  expect(sentInputs[0]).toMatchObject({
    TransactItems: [{
      Put: {
        ConditionExpression:
          'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        Item: {
          directoryId:
            'PROJECT_QUICK_ACCESS#workspace%23one#demo%40example.com',
          entryKey: 'PREFERENCE',
          entryType: 'project-quick-access',
          items,
          memberKey: 'demo@example.com',
          revision: 1,
          workspaceId: 'workspace#one',
        },
        TableName: 'DirectoryTable',
      },
    }],
  })
})

test('DynamoDB directory client rejects a stale quick-access replacement', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      if ('TransactItems' in command.input) {
        throw createConditionalTransactionCancellation()
      }
      return {
        Item: createProjectQuickAccessStoredItem(
          'workspace-1',
          'demo@example.com',
          3,
          [{ projectId: 'other-project', teamId: 'core-team' }],
        ),
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.replaceProjectQuickAccess(
    'workspace-1',
    'demo@example.com',
    {
      items: [{ projectId: 'refero', teamId: 'core-team' }],
      revision: 2,
    },
  )).rejects.toMatchObject({
    code: 'ProjectQuickAccessConflict',
    status: 409,
  })
  expect(sentInputs[0]).toMatchObject({
    TransactItems: [{
      Put: {
        ConditionExpression:
          '#revision = :expectedRevision AND #entryType = :entryType AND #workspaceId = :workspaceId AND #memberKey = :memberKey',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#memberKey': 'memberKey',
          '#revision': 'revision',
          '#workspaceId': 'workspaceId',
        },
        ExpressionAttributeValues: {
          ':entryType': 'project-quick-access',
          ':expectedRevision': 2,
          ':memberKey': 'demo@example.com',
          ':workspaceId': 'workspace-1',
        },
      },
    }],
  })
  expect(sentInputs[1]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client rejects a terminal quick-access revision before persistence', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.replaceProjectQuickAccess(
    'workspace-1',
    'demo@example.com',
    {
      items: [{ projectId: 'refero', teamId: 'core-team' }],
      revision: PROJECT_QUICK_ACCESS_MAX_REVISION,
    },
  )).rejects.toMatchObject({
    code: 'InvalidProjectQuickAccessInput',
    status: 400,
  })
  expect(sentInputs).toEqual([])
})

test('DynamoDB directory client rejects malformed quick-access items before persistence', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)
  const invalidItems = [
    Array.from({ length: PROJECT_QUICK_ACCESS_MAX_ITEMS + 1 }, (_, index) => ({
      projectId: `project-${index}`,
      teamId: 'core-team',
    })),
    [{ projectId: 'refero', teamId: ' core-team' }],
    [{ projectId: 'refero/child', teamId: 'core-team' }],
    [{
      projectId: 'p'.repeat(PROJECT_QUICK_ACCESS_IDENTIFIER_MAX_LENGTH + 1),
      teamId: 'core-team',
    }],
    [
      { projectId: 'shared-project', teamId: 'core-team' },
      { projectId: 'shared-project', teamId: 'core-team' },
    ],
  ]

  for (const items of invalidItems) {
    await expect(client.replaceProjectQuickAccess(
      'workspace-1',
      'demo@example.com',
      { items, revision: 0 },
    )).rejects.toMatchObject({
      code: 'InvalidProjectQuickAccessInput',
      status: 400,
    })
  }
  expect(sentInputs).toEqual([])
})

test('DynamoDB directory client fails closed when quick-access CAS finds an invalid bound row', async () => {
  const validItem = createProjectQuickAccessStoredItem(
    'workspace-1',
    'demo@example.com',
    2,
    [{ projectId: 'refero', teamId: 'core-team' }],
  )
  const invalidItems = [
    { ...validItem, entryType: 'project' },
    { ...validItem, memberKey: 'other@example.com' },
    { ...validItem, revision: Number.MAX_SAFE_INTEGER },
    { ...validItem, workspaceId: 'workspace-2' },
  ]

  for (const invalidItem of invalidItems) {
    const sentInputs: Array<Record<string, unknown>> = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        sentInputs.push(command.input)
        if ('TransactItems' in command.input) {
          throw createConditionalTransactionCancellation()
        }
        return { Item: invalidItem }
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

    await expect(client.replaceProjectQuickAccess(
      'workspace-1',
      'demo@example.com',
      {
        items: [{ projectId: 'mobile-app', teamId: 'core-team' }],
        revision: 2,
      },
    )).rejects.toMatchObject({
      code: 'InvalidProjectQuickAccess',
      status: 503,
    })
    expect(sentInputs[1]).toMatchObject({ ConsistentRead: true })
  }
})

test('DynamoDB directory client replays a committed quick-access replacement', async () => {
  const items = [{ projectId: 'refero', teamId: 'core-team' }]
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      if ('TransactItems' in command.input) {
        throw createConditionalTransactionCancellation()
      }
      return {
        Item: createProjectQuickAccessStoredItem(
          'workspace-1',
          'demo@example.com',
          3,
          items,
        ),
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.replaceProjectQuickAccess(
    'workspace-1',
    'demo@example.com',
    { items, revision: 2 },
  )).resolves.toEqual({ items, revision: 3 })
  expect(sentInputs[1]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client isolates each quick-access preference in a sidecar partition', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await client.getProjectQuickAccess('workspace-1', 'first@example.com')
  await client.getProjectQuickAccess('workspace-1', 'second@example.com')

  expect(sentInputs.map((input) => input.Key)).toEqual([
    {
      directoryId: 'PROJECT_QUICK_ACCESS#workspace-1#first%40example.com',
      entryKey: 'PREFERENCE',
    },
    {
      directoryId: 'PROJECT_QUICK_ACCESS#workspace-1#second%40example.com',
      entryKey: 'PREFERENCE',
    },
  ])
})

test('DynamoDB directory client fails closed on a malformed quick-access sidecar row', async () => {
  const malformedItem = createProjectQuickAccessStoredItem(
    'workspace-1',
    'demo@example.com',
    1,
    [{ projectId: ' refero', teamId: 'core-team' }],
  )
  const documentClient = {
    async send() {
      return { Item: malformedItem }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectQuickAccess(
    'workspace-1',
    'demo@example.com',
  )).rejects.toMatchObject({
    code: 'InvalidProjectQuickAccess',
    status: 503,
  })
})

test('DynamoDB directory client rejects one canonical quick-access identity repeated', async () => {
  const malformedItem = createProjectQuickAccessStoredItem(
    'workspace-1',
    'demo@example.com',
    1,
    [
      { projectId: 'shared-project', teamId: 'core-team' },
      { projectId: 'shared-project', teamId: 'core-team' },
    ],
  )
  const documentClient = {
    async send() {
      return { Item: malformedItem }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectQuickAccess(
    'workspace-1',
    'demo@example.com',
  )).rejects.toMatchObject({
    code: 'InvalidProjectQuickAccess',
    status: 503,
  })
})

test('DynamoDB directory client validates and ignores workspace bootstrap rows for reads and writes', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            ...createWorkspaceBootstrapItems(),
            {
              directoryId: 'workspace#production',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'workspace#production',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'workspace#production',
              entryKey: 'PROJECT_MEMBER#refero#owner@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'owner@example.com',
              email: 'owner@example.com',
              role: 'manager',
              createdAt: '2026-07-11T00:00:00.000Z',
              updatedAt: '2026-07-11T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectDirectory('workspace#production', 'en')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'Core Team',
        expanded: true,
        projects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      },
    ],
  })
  await expect(client.createTeam('workspace#production', { name: 'New Team' })).resolves.toEqual({
    team: {
      id: 'new-team',
      name: 'New Team',
      expanded: true,
      projects: [],
    },
  })
  expect(sentInputs[2]).toMatchObject({
    TransactItems: [{
      Put: {
        Item: {
          directoryId: 'workspace#production',
          entryType: 'team',
          teamId: 'new-team',
          webhookAuthorizationKey:
            'WEBHOOK_ACL#RESOURCE#workspace#production',
          webhookAuthorizationSortKey: 'TEAM#new-team',
        },
      },
    }],
  })
})

test('DynamoDB directory client rejects malformed workspace bootstrap rows', async () => {
  const documentClient = {
    async send() {
      return {
        Items: [
          {
            directoryId: 'workspace#production',
            entryKey: 'WORKSPACE#METADATA',
            entryType: 'workspace-metadata',
            workspaceId: 'workspace#other',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectDirectory('workspace#production', 'en')).rejects.toMatchObject({
    status: 503,
    code: 'InvalidProjectDirectory',
  })
})

test('builds exact active Team and Project admission guards from a strong directory read', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {
        Items: [{
          directoryId: 'workspace-1',
          entryKey: '000010#000000#TEAM#support',
          entryType: 'team',
          teamId: 'support',
          teamSortOrder: 10,
          nameJa: 'Support',
          nameEn: 'Support',
        }, {
          directoryId: 'workspace-1',
          entryKey: '000010#000010#PROJECT#intake',
          entryType: 'project',
          teamId: 'support',
          teamSortOrder: 10,
          projectId: 'intake',
          projectSortOrder: 10,
          nameJa: 'Intake',
          nameEn: 'Intake',
          tone: 'blue',
        }],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.createActiveReferenceConditionChecks(
    'workspace-1',
    'support',
    'intake',
  )).resolves.toEqual([{
    ConditionCheck: {
      TableName: 'DirectoryTable',
      Key: {
        directoryId: 'workspace-1',
        entryKey: '000010#000000#TEAM#support',
      },
      ConditionExpression:
        '#entryType = :entryType AND #teamId = :teamId AND attribute_not_exists(#archivedAt)',
      ExpressionAttributeNames: {
        '#archivedAt': 'archivedAt',
        '#entryType': 'entryType',
        '#teamId': 'teamId',
      },
      ExpressionAttributeValues: {
        ':entryType': 'team',
        ':teamId': 'support',
      },
    },
  }, {
    ConditionCheck: {
      TableName: 'DirectoryTable',
      Key: {
        directoryId: 'workspace-1',
        entryKey: '000010#000010#PROJECT#intake',
      },
      ConditionExpression:
        '#entryType = :entryType AND #teamId = :teamId AND #projectId = :projectId AND attribute_not_exists(#archivedAt)',
      ExpressionAttributeNames: {
        '#archivedAt': 'archivedAt',
        '#entryType': 'entryType',
        '#projectId': 'projectId',
        '#teamId': 'teamId',
      },
      ExpressionAttributeValues: {
        ':entryType': 'project',
        ':projectId': 'intake',
        ':teamId': 'support',
      },
    },
  }])
  expect(sentInputs).toEqual([expect.objectContaining({
    ConsistentRead: true,
    TableName: 'DirectoryTable',
  })])
})

test('DynamoDB directory client creates duplicate named teams with a unique id suffix', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#新規チーム',
              entryType: 'team',
              teamId: '新規チーム',
              teamSortOrder: 10,
              nameJa: '新規チーム',
              nameEn: 'New Team',
              expanded: true,
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.createTeam('user#demo@example.com', { name: '新規チーム' })).resolves.toEqual({
    team: {
      id: '新規チーム-2',
      name: '新規チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [{
      Put: {
        TableName: 'DirectoryTable',
        Item: {
          directoryId: 'user#demo@example.com',
          teamId: '新規チーム-2',
          teamSortOrder: 20,
          entryKey: '000020#000000#TEAM#新規チーム-2',
          webhookAuthorizationKey:
            'WEBHOOK_ACL#RESOURCE#user#demo@example.com',
          webhookAuthorizationSortKey: 'TEAM#新規チーム-2',
        },
        ConditionExpression:
          'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
      },
    }],
  })
})

test('DynamoDB directory client creates duplicate named projects with a unique id suffix', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#新規プロジェクト',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: '新規プロジェクト',
              projectSortOrder: 10,
              nameJa: '新規プロジェクト',
              nameEn: 'New Project',
              tone: 'blue',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(
    client.createProject(
      'user#demo@example.com',
      'core-team',
      {
        name: '新規プロジェクト',
        tone: 'green',
      },
      { userKey: 'demo@example.com', workspaceMemberVersion: 1 },
    ),
  ).resolves.toEqual({
    project: {
      id: '新規プロジェクト-2',
      name: '新規プロジェクト',
      tone: 'green',
    },
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
          ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: '新規プロジェクト-2',
            projectSortOrder: 20,
            entryKey: '000010#000020#PROJECT#新規プロジェクト-2',
            webhookAuthorizationKey:
              'WEBHOOK_ACL#RESOURCE#user#demo@example.com',
            webhookAuthorizationSortKey: 'PROJECT#新規プロジェクト-2',
          },
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#新規プロジェクト-2#demo@example.com',
            entryType: 'project-member',
            projectId: '新規プロジェクト-2',
            memberKey: 'demo@example.com',
            email: 'demo@example.com',
            role: 'manager',
            webhookAuthorizationKey:
              'WEBHOOK_ACL#MEMBER#user#demo@example.com#demo@example.com',
            webhookAuthorizationSortKey: 'PROJECT#新規プロジェクト-2',
          },
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      },
      {
        Update: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
          },
          UpdateExpression: 'SET updatedAt = :updatedAt ADD #version :one',
          ConditionExpression:
            '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
          ExpressionAttributeNames: {
            '#entryType': 'entryType',
            '#status': 'status',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':memberEntryType': 'workspace-member',
            ':active': 'active',
            ':expectedVersion': 1,
            ':one': 1,
          },
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#demo@example.com',
            entryKey: 'TEAM#core-team#PROJECT#新規プロジェクト-2',
            entryType: 'webhook-team-grant',
            workspaceId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: '新規プロジェクト-2',
            memberKey: 'demo@example.com',
            sourceEntryKey:
              'PROJECT_MEMBER#新規プロジェクト-2#demo@example.com',
            teamSourceEntryKey: '000010#000000#TEAM#core-team',
            projectSourceEntryKey:
              '000010#000020#PROJECT#新規プロジェクト-2',
            webhookAuthorizationKey:
              'WEBHOOK_ACL#TEAM_MEMBER#user#demo@example.com#core-team#demo@example.com',
            webhookAuthorizationSortKey: 'PROJECT#新規プロジェクト-2',
          },
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId:
              'WEBHOOK_GRANT_CLEANUP#user#demo@example.com#core-team',
            entryKey:
              'PROJECT#新規プロジェクト-2#MEMBER#demo@example.com',
            entryType: 'webhook-team-grant-cleanup',
            workspaceId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: '新規プロジェクト-2',
            memberKey: 'demo@example.com',
            grantDirectoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#demo@example.com',
            grantEntryKey:
              'TEAM#core-team#PROJECT#新規プロジェクト-2',
          },
        },
      },
    ],
  })
})

test('DynamoDB directory client strongly replays a deterministic Project and keeps receipt completion atomic', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let projectCommitted = false
  let loseFirstResponse = true
  const projectId = 'application_123'
  const team = {
    directoryId: 'workspace-1',
    entryKey: '000010#000000#TEAM#core-team',
    entryType: 'team',
    teamId: 'core-team',
    teamSortOrder: 10,
    nameJa: 'コアチーム',
    nameEn: 'Core Team',
    expanded: true,
  }
  const project = {
    directoryId: 'workspace-1',
    entryKey: `000010#000010#PROJECT#${projectId}`,
    entryType: 'project',
    teamId: 'core-team',
    teamSortOrder: 10,
    projectId,
    projectSortOrder: 10,
    nameJa: '障害対応',
    nameEn: 'Incident response',
    tone: 'purple',
  }
  const completion = {
    Update: {
      TableName: 'AutomationTable',
      Key: { scopeKey: 'workspace-1#automation', recordKey: 'TEMPLATE_APPLICATION#application_123' },
      UpdateExpression: 'SET #status = :succeeded',
    },
  } satisfies NonNullable<TransactWriteCommandInput['TransactItems']>[number]
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      if ('KeyConditionExpression' in command.input) {
        return { Items: projectCommitted ? [team, project] : [team] }
      }
      if (Array.isArray(command.input.TransactItems) && !projectCommitted) {
        projectCommitted = true
        if (loseFirstResponse) {
          loseFirstResponse = false
          throw Object.assign(new Error('Committed response was lost.'), { name: 'TimeoutError' })
        }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )
  const create = () => client.createProject(
    'workspace-1',
    'core-team',
    {
      idempotencyResourceId: projectId,
      nameJa: '障害対応',
      nameEn: 'Incident response',
      tone: 'purple',
    },
    { userKey: 'demo@example.com', workspaceMemberVersion: 1 },
    undefined,
    [completion],
  )

  await expect(create()).rejects.toMatchObject({ status: 502, code: 'TimeoutError' })
  await expect(create()).resolves.toEqual({
    project: { id: projectId, name: '障害対応', tone: 'purple' },
  })
  const queryInputs = sentInputs.filter((input) => 'KeyConditionExpression' in input)
  expect(queryInputs).toHaveLength(2)
  expect(queryInputs.every((input) => input.ConsistentRead === true)).toBe(true)
  expect(sentInputs[1]).toMatchObject({
    TransactItems: expect.arrayContaining([completion]),
  })
  expect(sentInputs[3]).toMatchObject({
    TransactItems: [
      { ConditionCheck: { TableName: 'DirectoryTable' } },
      completion,
    ],
  })
})

test('DynamoDB directory client initializes a missing local table before creating a team', async () => {
  const documentInputs: Array<Record<string, unknown>> = []
  const rawInputs: Array<Record<string, unknown>> = []
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      documentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1

        if (queryAttempts === 1) {
          const error = new Error('missing table')
          error.name = 'ResourceNotFoundException'
          throw error
        }

        return { Items: [] }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      rawInputs.push({
        ...command.input,
        commandName: command.constructor.name,
      })

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'directoryId', KeyType: 'HASH' },
              { AttributeName: 'entryKey', KeyType: 'RANGE' },
            ],
            GlobalSecondaryIndexes: [{
              IndexName: 'WebhookAuthorizationIndex',
              KeySchema: [
                { AttributeName: 'webhookAuthorizationKey', KeyType: 'HASH' },
                { AttributeName: 'webhookAuthorizationSortKey', KeyType: 'RANGE' },
              ],
            }],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectDirectoryClient(
    'MissingDirectoryTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(client.createTeam('user#demo@example.com', { name: '復旧チーム' })).resolves.toEqual({
    team: {
      id: '復旧チーム',
      name: '復旧チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(rawInputs).toEqual([
    expect.objectContaining({
      commandName: 'CreateTableCommand',
      TableName: 'MissingDirectoryTable',
      KeySchema: [
        { AttributeName: 'directoryId', KeyType: 'HASH' },
        { AttributeName: 'entryKey', KeyType: 'RANGE' },
      ],
    }),
    expect.objectContaining({
      commandName: 'DescribeTableCommand',
      TableName: 'MissingDirectoryTable',
    }),
  ])
  expect(documentInputs.at(-1)).toMatchObject({
    TransactItems: [{
      Put: {
        TableName: 'MissingDirectoryTable',
        Item: {
          directoryId: 'user#demo@example.com',
          teamId: '復旧チーム',
        },
      },
    }],
  })
})

test('DynamoDB directory client reads project access consistently for Workspace guards', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return { Items: createProjectMemberFixtureItems() }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.getProjectAccessList('user#demo@example.com', 'demo@example.com'),
  ).resolves.toEqual([{ projectId: 'refero', role: 'manager' }])
  await expect(
    client.getProjectAccess(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
    ),
  ).resolves.toEqual({ projectId: 'refero', role: 'manager' })
  expect(sentInputs).toEqual([
    expect.objectContaining({
      TableName: 'DirectoryTable',
      ConsistentRead: true,
    }),
    expect.objectContaining({
      TableName: 'DirectoryTable',
      ConsistentRead: true,
    }),
  ])
})

test('DynamoDB directory client excludes archived member roles from access', async () => {
  const items = createProjectMemberFixtureItems()
  const member = items.find((item) =>
    item.entryType === 'project-member' &&
    item.memberKey === 'demo@example.com'
  )
  Object.assign(member!, {
    archivedAt: '2026-07-18T00:00:00.000Z',
  })
  const documentClient = {
    async send() {
      return { Items: items }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.getProjectAccessList('user#demo@example.com', 'demo@example.com'),
  ).resolves.toEqual([{ projectId: 'refero', role: undefined }])
  await expect(
    client.getProjectMembers('user#demo@example.com', 'refero'),
  ).resolves.toEqual({
    projectId: 'refero',
    members: [
      expect.objectContaining({ id: 'zmanager@example.com' }),
    ],
  })
})

test('DynamoDB directory client reads every page from the user partition', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
          LastEvaluatedKey: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
        }
      }

      return {
        Items: [
          {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000010#PROJECT#refero',
            entryType: 'project',
            teamId: 'core-team',
            teamSortOrder: 10,
            projectId: 'refero',
            projectSortOrder: 10,
            nameJa: 'Refero',
            nameEn: 'Refero',
            tone: 'blue',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.getProjectDirectory('user#demo@example.com', 'ja')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'コアチーム',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': 'user#demo@example.com',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': 'user#demo@example.com',
      },
      ExclusiveStartKey: {
        directoryId: 'user#demo@example.com',
        entryKey: '000010#000000#TEAM#core-team',
      },
      ScanIndexForward: true,
    },
  ])
})

test('DynamoDB directory client omits archived teams and projects', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000020#PROJECT#archived-project',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'archived-project',
              projectSortOrder: 20,
              nameJa: 'Archived Project',
              nameEn: 'Archived Project',
              tone: 'green',
              archivedAt: '2026-06-06T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000020#000000#TEAM#archived-team',
              entryType: 'team',
              teamId: 'archived-team',
              teamSortOrder: 20,
              nameJa: 'Archived Team',
              nameEn: 'Archived Team',
              expanded: true,
              archivedAt: '2026-06-06T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000020#000010#PROJECT#hidden-project',
              entryType: 'project',
              teamId: 'archived-team',
              teamSortOrder: 20,
              projectId: 'hidden-project',
              projectSortOrder: 10,
              nameJa: 'Hidden Project',
              nameEn: 'Hidden Project',
              tone: 'yellow',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.getProjectDirectory('user#demo@example.com', 'ja')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'コアチーム',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  await expect(client.hasProjectAccess('user#demo@example.com', 'refero')).resolves.toBe(true)
  await expect(
    client.hasProjectAccess('user#demo@example.com', 'archived-project'),
  ).resolves.toBe(false)
  await expect(
    client.hasProjectAccess('user#demo@example.com', 'hidden-project'),
  ).resolves.toBe(false)
})

test('DynamoDB directory client archives teams and projects with conditional updates', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.archiveTeam('user#demo@example.com', 'core-team', undefined, 0)).resolves.toEqual({
    teamId: 'core-team',
    archivedAt: expect.any(String),
  })
  await expect(
    client.archiveProject(
      'user#demo@example.com',
      'core-team',
      'refero',
      undefined,
      1,
      [
        { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 7 },
        { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 9 },
      ],
    ),
  ).resolves.toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: expect.any(String),
  })
  expect(sentInputs[2]).toMatchObject({
    TransactItems: [{
      Update: {
        TableName: 'DirectoryTable',
        Key: {
          directoryId: 'user#demo@example.com',
          entryKey: '000010#000000#TEAM#core-team',
        },
        UpdateExpression: 'SET archivedAt = :archivedAt',
        ConditionExpression:
          'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
      },
    }, {
      Put: {
        TableName: 'mukuroji-planning-local',
        Item: {
          workspaceId: 'FENCE#user#demo@example.com',
          recordKey: 'META',
          revision: 1,
        },
        ConditionExpression:
          'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      },
    }],
  })
  expect(sentInputs[5]).toMatchObject({
    TransactItems: [{
      Update: {
        TableName: 'DirectoryTable',
        Key: {
          directoryId: 'user#demo@example.com',
          entryKey: '000010#000010#PROJECT#refero',
        },
        UpdateExpression: 'SET archivedAt = :archivedAt',
        ConditionExpression:
          'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
      },
    }, {}, {
      ConditionCheck: {
        TableName: 'mukuroji-team-issues-local',
        Key: {
          directoryTeamId: 'user#demo@example.com#team#core-team',
          issueId: 'onboarding-friction',
        },
        ConditionExpression:
          'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
          '#revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': 7 },
      },
    }, {
      ConditionCheck: {
        TableName: 'mukuroji-team-issues-local',
        Key: {
          directoryTeamId: 'user#demo@example.com#team#core-team',
          issueId: 'work-item-1',
        },
        ConditionExpression:
          'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
          '#revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': 9 },
      },
    }],
  })
})

test('serializes directory archive with the Planning graph revision', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [{
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
            entryType: 'team',
            teamId: 'core-team',
            teamSortOrder: 10,
            nameJa: 'コアチーム',
            nameEn: 'Core Team',
            expanded: true,
          }],
        }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
    'PlanningTable',
  )

  await client.archiveTeam('user#demo@example.com', 'core-team', undefined, 4)

  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      { Update: { TableName: 'DirectoryTable' } },
      {
        Put: {
          TableName: 'PlanningTable',
          Item: {
            workspaceId: 'FENCE#user#demo@example.com',
            recordKey: 'META',
            entryType: 'planning-meta',
            schemaVersion: 1,
            revision: 5,
          },
          ConditionExpression: '#revision = :expectedPlanningRevision',
          ExpressionAttributeValues: { ':expectedPlanningRevision': 4 },
        },
      },
    ],
  })
})

test('classifies a Planning revision race during directory archive', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
          ],
        }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('canceled')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        })
        throw error
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
    'PlanningTable',
  )

  await expect(client.archiveProject(
    'user#demo@example.com',
    'core-team',
    'refero',
    undefined,
    4,
  )).rejects.toMatchObject({
    status: 409,
    code: 'PlanningRevisionConflict',
  })
})

test('classifies a dependency endpoint Project-move race during directory archive', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
          ],
        }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('canceled')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        })
        throw error
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
    'PlanningTable',
    'WorkItemsTable',
  )

  await expect(client.archiveProject(
    'user#demo@example.com',
    'core-team',
    'refero',
    undefined,
    4,
    [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 7 }],
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkItemRevisionConflict',
  })
})

test('rejects a Project archive whose dependency guards exceed transaction capacity', async () => {
  let transactWrites = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
          ],
        }
      }
      if (command.constructor.name === 'TransactWriteCommand') transactWrites += 1
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)
  // DynamoDB's 100-item transaction limit leaves 98 slots after the two directory writes.
  const guards = Array.from({ length: 98 }, (_, index) => ({
    teamId: 'core-team',
    workItemId: `work-item-${index}`,
    expectedRevision: 1,
  }))

  await expect(client.archiveProject(
    'user#demo@example.com',
    'core-team',
    'refero',
    undefined,
    4,
    guards,
  )).rejects.toMatchObject({
    status: 413,
    code: 'PlanningProjectScopeDependencyLimitExceeded',
  })
  expect(transactWrites).toBe(0)
})

test('DynamoDB directory client manages project member roles', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              name: 'Demo User',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'zmanager@example.com',
              email: 'zmanager@example.com',
              name: 'Z Manager',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(
    client.getProjectMembers('user#demo@example.com', 'refero'),
  ).resolves.toEqual({
    projectId: 'refero',
    members: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        name: 'Demo User',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
      {
        id: 'zmanager@example.com',
        email: 'zmanager@example.com',
        name: 'Z Manager',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
    ],
  })
  await expect(
    client.getProjectRole('user#demo@example.com', 'refero', 'DEMO@example.com'),
  ).resolves.toBe('manager')
  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'sato@example.com', {
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
    }, 1),
  ).resolves.toEqual({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
      updatedAt: expect.any(String),
    },
  })
  await expect(
    client.removeProjectMember(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
      undefined,
      { exists: true, version: 1, status: 'deactivated' },
    ),
  ).resolves.toEqual({
    projectId: 'refero',
    memberId: 'demo@example.com',
  })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[3]).toMatchObject({
    TransactItems: [
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#sato@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'sato@example.com',
            email: 'sato@example.com',
            name: '佐藤 花子',
            role: 'member',
          },
        },
      },
      {
        Update: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#sato@example.com',
          },
          ConditionExpression:
            '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
          ExpressionAttributeValues: {
            ':expectedVersion': 1,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
          ConditionExpression:
            '#entryType = :teamEntryType AND attribute_not_exists(archivedAt)',
        },
      },
      {
        ConditionCheck: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000010#PROJECT#refero',
          },
          ConditionExpression:
            '#entryType = :projectEntryType AND attribute_not_exists(archivedAt)',
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#sato@example.com',
            entryKey: 'TEAM#core-team#PROJECT#refero',
            entryType: 'webhook-team-grant',
            workspaceId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: 'refero',
            memberKey: 'sato@example.com',
            sourceEntryKey: 'PROJECT_MEMBER#refero#sato@example.com',
            teamSourceEntryKey: '000010#000000#TEAM#core-team',
            projectSourceEntryKey: '000010#000010#PROJECT#refero',
            webhookAuthorizationKey:
              'WEBHOOK_ACL#TEAM_MEMBER#user#demo@example.com#core-team#sato@example.com',
            webhookAuthorizationSortKey: 'PROJECT#refero',
          },
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId:
              'WEBHOOK_GRANT_CLEANUP#user#demo@example.com#core-team',
            entryKey: 'PROJECT#refero#MEMBER#sato@example.com',
            entryType: 'webhook-team-grant-cleanup',
            workspaceId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: 'refero',
            memberKey: 'sato@example.com',
            grantDirectoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#sato@example.com',
            grantEntryKey: 'TEAM#core-team#PROJECT#refero',
          },
        },
      },
    ],
  })
  expect(sentInputs[5]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
          ConditionExpression: '#role = :manager',
          ExpressionAttributeNames: {
            '#role': 'role',
          },
          ExpressionAttributeValues: {
            ':manager': 'manager',
          },
        },
      },
      {
        Delete: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
          },
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND #updatedAt = :expectedUpdatedAt AND #role = :expectedRole',
          ExpressionAttributeNames: {
            '#updatedAt': 'updatedAt',
            '#role': 'role',
          },
          ExpressionAttributeValues: {
            ':expectedUpdatedAt': '2026-06-08T00:00:00.000Z',
            ':expectedRole': 'manager',
          },
        },
      },
      {
        Update: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
          },
          UpdateExpression: 'SET updatedAt = :updatedAt ADD #version :one',
          ConditionExpression:
            '#entryType = :memberEntryType AND #status = :expectedStatus AND #version = :expectedVersion',
          ExpressionAttributeValues: {
            ':expectedStatus': 'deactivated',
            ':expectedVersion': 1,
            ':one': 1,
          },
        },
      },
      {
        Delete: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#demo@example.com',
            entryKey: 'TEAM#core-team#PROJECT#refero',
          },
        },
      },
      {
        Delete: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId:
              'WEBHOOK_GRANT_CLEANUP#user#demo@example.com#core-team',
            entryKey: 'PROJECT#refero#MEMBER#demo@example.com',
          },
        },
      },
    ],
  })
  expect(sentInputs[4]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client rejects membership grant fan-out above 100 actions', async () => {
  const atLimit = createSharedProjectCapacityClient(24)
  await expect(atLimit.client.updateProjectMember(
    'workspace-1',
    'shared-project',
    'viewer@example.com',
    {
      email: 'viewer@example.com',
      role: 'viewer',
    },
    1,
  )).resolves.toMatchObject({
    member: { id: 'viewer@example.com' },
  })
  expect(atLimit.transactions).toHaveLength(1)
  expect(atLimit.transactions[0]?.TransactItems).toHaveLength(98)

  const aboveLimit = createSharedProjectCapacityClient(25)
  await expect(aboveLimit.client.updateProjectMember(
    'workspace-1',
    'shared-project',
    'viewer@example.com',
    {
      email: 'viewer@example.com',
      role: 'viewer',
    },
    1,
  )).rejects.toMatchObject({
    code: 'ProjectMembershipTransactionTooLarge',
    status: 409,
  })
  expect(aboveLimit.transactions).toEqual([])
})

test('DynamoDB directory client rejects a concurrent Workspace member creation during role removal', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: createProjectMemberFixtureItems({ targetRole: 'member' }),
        }
      }

      if ('TransactItems' in command.input) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        })
      }

      return {
        Item: {
          workspaceId: 'user#demo@example.com',
          recordKey: 'MEMBER#demo@example.com',
          entryType: 'workspace-member',
          status: 'active',
          version: 1,
        },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(
    client.removeProjectMember(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
      undefined,
      { exists: false },
    ),
  ).rejects.toMatchObject({
    code: 'WorkspaceMemberVersionConflict',
    status: 409,
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        Delete: {
          TableName: 'DirectoryTable',
        },
      },
      {
        ConditionCheck: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
          },
          ConditionExpression: 'attribute_not_exists(workspaceId)',
        },
      },
      {
        Delete: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#demo@example.com',
            entryKey: 'TEAM#core-team#PROJECT#refero',
          },
        },
      },
      {
        Delete: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId:
              'WEBHOOK_GRANT_CLEANUP#user#demo@example.com#core-team',
            entryKey: 'PROJECT#refero#MEMBER#demo@example.com',
          },
        },
      },
    ],
  })
  expect(sentInputs[2]).toMatchObject({
    TableName: 'WorkspaceAccessTable',
    ConsistentRead: true,
  })
})

test('DynamoDB directory client keeps at least one project manager', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              name: 'Demo User',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'demo@example.com', {
      email: 'demo@example.com',
      role: 'viewer',
    }, 1),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs).toHaveLength(2)
})

test('DynamoDB directory client treats manager guard transaction cancellation as last manager conflict', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
            ...(queryReads === 1
              ? [
                  {
                    directoryId: 'user#demo@example.com',
                    entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
                    entryType: 'project-member',
                    projectId: 'refero',
                    memberKey: 'zmanager@example.com',
                    email: 'zmanager@example.com',
                    role: 'manager',
                    createdAt: '2026-06-08T00:00:00.000Z',
                    updatedAt: '2026-06-08T00:00:00.000Z',
                  },
                ]
              : []),
          ],
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      if ('Key' in command.input) {
        return {
          Item: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
            entryType: 'workspace-member',
            memberKey: 'demo@example.com',
            role: 'owner',
            status: 'active',
            version: 1,
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
        },
      },
      {
        Delete: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
          },
        },
      },
      {
        Delete: {
          Key: {
            directoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#demo@example.com',
            entryKey: 'TEAM#core-team#PROJECT#refero',
          },
        },
      },
      {
        Delete: {
          Key: {
            directoryId:
              'WEBHOOK_GRANT_CLEANUP#user#demo@example.com#core-team',
            entryKey: 'PROJECT#refero#MEMBER#demo@example.com',
          },
        },
      },
    ],
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[0]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client treats deleted target member transaction cancellation as member not found', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            ...(queryReads === 1
              ? [
                  {
                    directoryId: 'user#demo@example.com',
                    entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
                    entryType: 'project-member',
                    projectId: 'refero',
                    memberKey: 'demo@example.com',
                    email: 'demo@example.com',
                    role: 'manager',
                    createdAt: '2026-06-08T00:00:00.000Z',
                    updatedAt: '2026-06-08T00:00:00.000Z',
                  },
                ]
              : []),
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'zmanager@example.com',
              email: 'zmanager@example.com',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[0]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client treats manager downgrade transaction cancellation as last manager conflict', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeOtherManager: queryReads === 1,
          }),
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'demo@example.com', {
      email: 'demo@example.com',
      role: 'viewer',
    }, 1),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
        },
      },
      {
        Put: {
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
            role: 'viewer',
          },
        },
      },
      {
        Update: {
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
          },
          ExpressionAttributeValues: {
            ':expectedVersion': 1,
          },
        },
      },
      {
        ConditionCheck: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
        },
      },
      {
        ConditionCheck: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000010#PROJECT#refero',
          },
        },
      },
      {
        Put: {
          Item: {
            directoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#demo@example.com',
            entryKey: 'TEAM#core-team#PROJECT#refero',
            entryType: 'webhook-team-grant',
            workspaceId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: 'refero',
            memberKey: 'demo@example.com',
            sourceEntryKey: 'PROJECT_MEMBER#refero#demo@example.com',
            teamSourceEntryKey: '000010#000000#TEAM#core-team',
            projectSourceEntryKey: '000010#000010#PROJECT#refero',
            webhookAuthorizationKey:
              'WEBHOOK_ACL#TEAM_MEMBER#user#demo@example.com#core-team#demo@example.com',
            webhookAuthorizationSortKey: 'PROJECT#refero',
          },
        },
      },
      {
        Put: {
          Item: {
            directoryId:
              'WEBHOOK_GRANT_CLEANUP#user#demo@example.com#core-team',
            entryKey: 'PROJECT#refero#MEMBER#demo@example.com',
            entryType: 'webhook-team-grant-cleanup',
            workspaceId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: 'refero',
            memberKey: 'demo@example.com',
            grantDirectoryId:
              'WEBHOOK_TEAM_GRANT#user#demo@example.com#demo@example.com',
            grantEntryKey: 'TEAM#core-team#PROJECT#refero',
          },
        },
      },
    ],
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client returns not found when a non-manager update loses its target member', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeTargetMember: queryReads === 1,
            targetRole: 'member',
          }),
        }
      }

      if ('TransactItems' in command.input) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await expect(
    client.updateProjectMember(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
      {
        email: 'demo@example.com',
        role: 'viewer',
      },
      1,
      createDirectoryMutationAuditContext(),
    ),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
    status: 404,
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client returns not found when a non-manager removal loses its target member', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeTargetMember: queryReads === 1,
            targetRole: 'member',
          }),
        }
      }

      if ('TransactItems' in command.input) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await expect(
    client.removeProjectMember(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
      createDirectoryMutationAuditContext(),
    ),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
    status: 404,
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client does not reread manager state when cancellation reasons are missing', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: createProjectMemberFixtureItems(),
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'TransactionCanceledException',
  })
  expect(sentInputs).toHaveLength(2)
})
