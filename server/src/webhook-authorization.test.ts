import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { WebhookSubscription } from '@mukuroji/contracts'
import type { WorkspaceAccessClient } from './workspace-access'
import { DynamoDbWebhookSubscriptionAuthorizer } from './webhook-authorization'

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

test('reuses the current ACL snapshot within one Lambda batch', async () => {
  const calls = { directoryReads: 0, memberReads: 0 }
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
    ),
  ])).resolves.toEqual([true, true])
  expect(calls).toEqual({ directoryReads: 1, memberReads: 1 })
})

test('does not fail closed solely because a directory contains more than 10,000 rows', async () => {
  const calls = { directoryReads: 0, memberReads: 0 }
  const fillerRows = Array.from({ length: 10_001 }, () => ({ entryType: 'other' }))
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
  ], calls)
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
  expect(calls).toEqual({ directoryReads: 1, memberReads: 1 })
})

test('uses the indexed Team, Project, and member relationships without cross-Team access', async () => {
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
  calls?: { directoryReads: number; memberReads: number },
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
  const documentClient = {
    async send() {
      if (calls) calls.directoryReads += 1
      return { Items: rows }
    },
  } as unknown as DynamoDBDocumentClient
  return new DynamoDbWebhookSubscriptionAuthorizer(
    workspaceAccess,
    documentClient,
    'project-directory-test',
  )
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
