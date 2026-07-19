import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { WebhookSubscription } from '@mukuroji/contracts'
import type { WorkspaceAccessClient } from './workspace-access'
import { DynamoDbWebhookSubscriptionAuthorizer } from './webhook-authorization'
import { createWebhookTeamGrantItem } from './webhook-authorization-projection'

test('allows only an active creator with a current role in an active Team project', async () => {
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ])

  expect(await authorizer.canDeliver('workspace-1', createSubscription(), 'team-1'))
    .toBe(true)
  expect(await authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
    'project-2',
  )).toBe(false)
  expect(await authorizer.canDeliver('workspace-1', createSubscription(), 'team-2'))
    .toBe(false)
})

test('fails closed after the creator loses project access or the Team is archived', async () => {
  const noRole = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
  ])
  const archived = createAuthorizer([
    { entryType: 'team', teamId: 'team-1', archivedAt: '2026-07-18T00:00:00.000Z' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'manager',
    },
  ])

  expect(await noRole.canDeliver('workspace-1', createSubscription(), 'team-1'))
    .toBe(false)
  expect(await archived.canDeliver('workspace-1', createSubscription(), 'team-1'))
    .toBe(false)
})

test('fails closed for an archived Project member row', async () => {
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'manager',
      archivedAt: '2026-07-18T00:00:00.000Z',
    },
  ])

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
    'project-1',
  )).resolves.toBe(false)
})

test('continues after 25 stale Team grants to find a current grant', async () => {
  const staleProjects = Array.from({ length: 25 }, (_, index) => ({
    entryType: 'project',
    teamId: 'team-1',
    projectId: `stale-${String(index).padStart(2, '0')}`,
  }))
  const staleMembers = staleProjects.map((project) => ({
    entryType: 'project-member',
    projectId: project.projectId,
    memberKey: 'creator-1',
    role: 'removed',
  }))
  const calls = {
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 0,
    teamGrantLimits: [] as number[],
    teamGrantConsistentReads: [] as boolean[],
  }
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    ...staleProjects,
    { entryType: 'project', teamId: 'team-1', projectId: 'valid-project' },
    ...staleMembers,
    {
      entryType: 'project-member',
      projectId: 'valid-project',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ], calls)

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(true)
  expect(calls.teamGrantLimits).toEqual([25, 25])
  expect(calls.teamGrantConsistentReads).toEqual([true, true])
})

test('reuses the current ACL snapshot within one Lambda batch', async () => {
  const calls = { authoritativeReads: 0, directoryQueries: 0, memberReads: 0 }
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'member',
    },
  ], calls)
  const batch = authorizer.createBatch()

  expect(batch).toBeDefined()
  await expect(Promise.all([
    batch!.canDeliver('workspace-1', createSubscription(), 'team-1'),
    batch!.canDeliver(
      'workspace-1',
      { ...createSubscription(), id: 'webhook-2' },
      'team-1',
      'project-1',
    ),
  ])).resolves.toEqual([true, true])
  expect(calls).toEqual({
    authoritativeReads: 4,
    directoryQueries: 1,
    memberReads: 1,
  })
})

test('does not scan unrelated creator Project memberships for Team-only authorization', async () => {
  const calls = {
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 0,
    teamGrantLimits: [] as number[],
    teamGrantConsistentReads: [] as boolean[],
  }
  const fillerRows = Array.from({ length: 10_001 }, (_, index) => ({
    entryType: 'project-member',
    projectId: `inaccessible-${index}`,
    memberKey: 'creator-1',
    role: 'removed',
  }))
  const authorizer = createAuthorizer([
    ...fillerRows,
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ], calls, 10_001)
  const batch = authorizer.createBatch()

  await expect(Promise.all([
    batch!.canDeliver('workspace-1', createSubscription(), 'team-1'),
    batch!.canDeliver(
      'workspace-1',
      { ...createSubscription(), id: 'webhook-large-2' },
      'team-1',
      'project-1',
    ),
  ])).resolves.toEqual([true, true])
  expect(calls.memberReads).toBe(1)
  expect(calls.directoryQueries).toBe(1)
  expect(calls.authoritativeReads).toBe(4)
  expect(calls.teamGrantLimits).toEqual([25])
  expect(calls.teamGrantConsistentReads).toEqual([true])
})

test('uses strongly consistent grant source locators without cross-Team access', async () => {
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'team', teamId: 'team-2' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    { entryType: 'project', teamId: 'team-2', projectId: 'project-2' },
    {
      entryType: 'project-member',
      projectId: 'project-2',
      memberKey: 'creator-1',
      role: 'manager',
    },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'removed',
    },
  ])
  const subscription = {
    ...createSubscription(),
    teamIds: ['team-1', 'team-2'],
  }

  await expect(authorizer.canDeliver(
    'workspace-1',
    subscription,
    'team-1',
  )).resolves.toBe(false)
  await expect(authorizer.canDeliver(
    'workspace-1',
    subscription,
    'team-2',
    'project-2',
  )).resolves.toBe(true)
})

function createAuthorizer(
  rows: Record<string, unknown>[],
  calls?: {
    authoritativeReads: number
    directoryQueries: number
    memberReads: number
    teamGrantLimits?: number[]
    teamGrantConsistentReads?: boolean[]
  },
  pageSize = Number.POSITIVE_INFINITY,
) {
  const workspaceAccess = {
    async getActiveMember() {
      if (calls) calls.memberReads += 1
      return {
        id: 'member-1',
        memberKey: 'creator-1',
        email: 'creator@example.test',
        role: 'admin',
        status: 'active',
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
    },
  } as unknown as WorkspaceAccessClient
  const sourceRows = rows.map((row, index) => withAuthorizationProjection(row, index))
  const teams = new Map<string, typeof sourceRows[number]>()
  for (const row of sourceRows) {
    if (row.entryType === 'team' && typeof row.teamId === 'string') {
      teams.set(row.teamId, row)
    }
  }
  const projectSources = new Map<string, Array<{
    teamId: string
    teamSourceEntryKey: string
    projectSourceEntryKey: string
  }>>()
  for (const row of sourceRows) {
    if (
      row.entryType === 'project' &&
      typeof row.projectId === 'string' &&
      typeof row.teamId === 'string' &&
      row.archivedAt === undefined
    ) {
      const team = teams.get(row.teamId)
      if (!team) continue
      projectSources.set(row.projectId, [
        ...(projectSources.get(row.projectId) ?? []),
        {
          teamId: row.teamId,
          teamSourceEntryKey: team.entryKey,
          projectSourceEntryKey: row.entryKey,
        },
      ])
    }
  }
  const grantRows = sourceRows.flatMap((row) => {
    if (
      row.entryType !== 'project-member' ||
      typeof row.projectId !== 'string' ||
      typeof row.memberKey !== 'string'
    ) {
      return []
    }
    return (projectSources.get(row.projectId) ?? []).map((source) =>
      createWebhookTeamGrantItem({
        workspaceId: 'workspace-1',
        teamId: source.teamId,
        projectId: row.projectId as string,
        memberKey: row.memberKey as string,
        teamSourceEntryKey: source.teamSourceEntryKey,
        projectSourceEntryKey: source.projectSourceEntryKey,
      })
    )
  })
  const storedRows: Array<Record<string, unknown> & {
    directoryId: string
    entryKey: string
  }> = [...sourceRows, ...grantRows]
  const storedRowsByKey = new Map(storedRows.map((row) => [
    `${row.directoryId}\0${row.entryKey}`,
    row,
  ]))
  const documentClient = {
    async send(command: {
      constructor: { name: string }
      input: Record<string, unknown>
    }) {
      if (command.constructor.name === 'GetCommand') {
        if (calls) calls.authoritativeReads += 1
        const key = command.input.Key as { directoryId?: string; entryKey?: string }
        return {
          Item: storedRowsByKey.get(`${key.directoryId}\0${key.entryKey}`),
        }
      }
      if (command.constructor.name !== 'QueryCommand') {
        throw new Error(`Unexpected command: ${command.constructor.name}`)
      }
      if (calls) calls.directoryQueries += 1
      const values = command.input.ExpressionAttributeValues as Record<string, string>
      const isGrantQuery =
        values[':grantDirectoryId']?.startsWith('WEBHOOK_TEAM_GRANT#')
      if (isGrantQuery) {
        calls?.teamGrantLimits?.push(command.input.Limit as number)
        calls?.teamGrantConsistentReads?.push(command.input.ConsistentRead === true)
      }
      const matching = storedRows.filter((row) => isGrantQuery
        ? row.directoryId === values[':grantDirectoryId'] &&
          typeof row.entryKey === 'string' &&
          row.entryKey.startsWith(values[':grantEntryKeyPrefix'])
        : row.webhookAuthorizationKey === values[':authorizationKey'] &&
          (
            values[':authorizationSortKey'] === undefined ||
            row.webhookAuthorizationSortKey === values[':authorizationSortKey']
          )
      )
      const startKey = command.input.ExclusiveStartKey as { entryKey?: string } | undefined
      const startIndex = startKey?.entryKey
        ? matching.findIndex((row) => row.entryKey === startKey.entryKey) + 1
        : 0
      const requestedLimit = typeof command.input.Limit === 'number'
        ? command.input.Limit
        : Number.POSITIVE_INFINITY
      const page = matching.slice(
        startIndex,
        startIndex + Math.min(pageSize, requestedLimit),
      )
      const hasNextPage = startIndex + page.length < matching.length
      return {
        Count: page.length,
        Items: isGrantQuery
          ? page
          : page.map((row) => ({
              directoryId: row.directoryId,
              entryKey: row.entryKey,
            })),
        ...(hasNextPage && page.at(-1)
          ? {
              LastEvaluatedKey: {
                directoryId: page.at(-1)!.directoryId,
                entryKey: page.at(-1)!.entryKey,
                webhookAuthorizationKey:
                  page.at(-1)!.webhookAuthorizationKey,
                webhookAuthorizationSortKey:
                  page.at(-1)!.webhookAuthorizationSortKey,
              },
            }
          : {}),
      }
    },
  } as unknown as DynamoDBDocumentClient
  return new DynamoDbWebhookSubscriptionAuthorizer(
    workspaceAccess,
    documentClient,
    'project-directory-test',
  )
}

function withAuthorizationProjection(
  row: Record<string, unknown>,
  index: number,
): Record<string, unknown> & {
  directoryId: string
  entryKey: string
} {
  const directoryId = 'workspace-1'
  const entryType = row.entryType
  if (entryType === 'team' && typeof row.teamId === 'string') {
    return {
      directoryId,
      entryKey: `TEAM#${index}`,
      webhookAuthorizationKey: `WEBHOOK_ACL#RESOURCE#${directoryId}`,
      webhookAuthorizationSortKey: `TEAM#${row.teamId}`,
      ...row,
    }
  }
  if (entryType === 'project' && typeof row.projectId === 'string') {
    return {
      directoryId,
      entryKey: `PROJECT#${index}`,
      webhookAuthorizationKey: `WEBHOOK_ACL#RESOURCE#${directoryId}`,
      webhookAuthorizationSortKey: `PROJECT#${row.projectId}`,
      ...row,
    }
  }
  if (
    entryType === 'project-member' &&
    typeof row.projectId === 'string' &&
    typeof row.memberKey === 'string'
  ) {
    return {
      directoryId,
      entryKey: `PROJECT_MEMBER#${row.projectId}#${row.memberKey}`,
      webhookAuthorizationKey:
        `WEBHOOK_ACL#MEMBER#${directoryId}#${row.memberKey}`,
      webhookAuthorizationSortKey: `PROJECT#${row.projectId}`,
      ...row,
    }
  }
  return { directoryId, entryKey: `OTHER#${index}`, ...row }
}

function createSubscription() {
  return {
    id: 'webhook-1',
    name: 'Team automation',
    url: 'https://hooks.example.test/mukuroji',
    createdByUserId: 'creator-1',
    teamIds: ['team-1'],
    eventTypes: ['work-item.created'],
    scopes: ['work-items:read'],
    status: 'active',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    failureCount: 0,
  } satisfies WebhookSubscription
}
