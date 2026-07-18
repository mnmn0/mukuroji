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

function createAuthorizer(rows: Record<string, unknown>[]) {
  const workspaceAccess = {
    async getActiveMember() {
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
