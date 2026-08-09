import { afterEach, expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  createAuditEvent,
  createMutationAuditContext,
  createWorkspaceInvitationAuditEntityId,
} from './audit'
import {
  createApp,
} from '../../app/createApp'
import {
  createTestAppDependencies,
  overrideAppDependencies,
} from '../../app/composition/api-dependencies'
import type {
  AppDependencyOverrides,
} from '../../app/composition/app-dependencies'
import {
  DynamoDbProjectDirectoryClient,
} from '../directory'
import {
  DynamoDbTeamIssuesClient,
} from '../work-items'

const workspaceId = 'workspace-1'
const actorUserId = 'demo@example.com'
const occurredAt = '2026-07-11T12:00:00.000Z'
const workspaceAuditPseudonymKey =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

let testAppDependencies = createTestAppDependencies()
let app = createApp(testAppDependencies)

function setTestAppDependencies(
  dependencies: AppDependencyOverrides,
) {
  testAppDependencies = overrideAppDependencies(testAppDependencies, dependencies)
  app = createApp(testAppDependencies)
}

function resetTestApp() {
  testAppDependencies = createTestAppDependencies()
  app = createApp(testAppDependencies)
}

afterEach(() => {
  resetTestApp()
})

test('project directory mutations write state and audit in one transaction', async () => {
  const recording = createRecordingDocumentClient((name) =>
    name === 'QueryCommand' ? { Items: [] } : {},
  )
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )

  await client.createTeam(
    workspaceId,
    { name: 'Core Team' },
    createAuditContext('create-core-team'),
  )

  const transaction = recording.commands.find((command) => command.name === 'TransactWriteCommand')
  const items = readTransactItems(transaction)

  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({
    Put: {
      TableName: 'DirectoryTable',
      Item: {
        directoryId: workspaceId,
        entryType: 'team',
        teamId: 'core-team',
      },
    },
  })
  expect(items[1]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'project.created',
        entityType: 'project',
        entityId: 'team/core-team',
        action: 'created',
      },
    },
  })
})

test('team issue mutations keep state, specialized activity, and generic audit atomic', async () => {
  const recording = createRecordingDocumentClient((name) =>
    name === 'QueryCommand' ? { Items: [] } : {},
  )
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )

  await client.createTeamIssue(
    workspaceId,
    'core-team',
    {
      title: 'Ship audit trail',
      assigneeUserId: actorUserId,
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      schedule: {
        calendarPolicy: {
          holidays: [],
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        dueDate: '2026-07-31',
        mode: 'due-date',
      },
      priority: 'high',
    },
    actorUserId,
    createAuditContext('create-team-issue'),
  )

  const transaction = recording.commands.find((command) => command.name === 'TransactWriteCommand')
  const items = readTransactItems(transaction)

  expect(items).toHaveLength(3)
  expect(items[0]).toMatchObject({
    Put: {
      TableName: 'IssuesTable',
      Item: {
        directoryId: workspaceId,
        teamId: 'core-team',
        issueId: 'ship-audit-trail',
        schemaVersion: 2,
        revision: 1,
        relationIds: [],
        schedule: {
          dueDate: '2026-07-31',
          mode: 'due-date',
        },
      },
    },
  })
  expect(items[1]).toMatchObject({
    Put: {
      TableName: 'IssueEventsTable',
      Item: {
        issueId: 'ship-audit-trail',
        eventType: 'created',
      },
    },
  })
  expect(items[2]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: 'team/core-team/issue/ship-audit-trail',
        action: 'created',
        metadata: {
          adapter: 'canonical-work-item',
          afterRevision: 1,
        },
      },
    },
  })
})

test('canonical Work Item audit diff is guarded by expected revision CAS', async () => {
  const issueItem = createTeamIssueItem('issue-1')
  const recording = createRecordingDocumentClient((name) =>
    name === 'GetCommand' ? { Item: issueItem } : {},
  )
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )

  await client.updateTeamIssue(
    workspaceId,
    'core-team',
    'issue-1',
    {
      expectedRevision: 1,
      workflowSchemaVersion: 1,
      workflowStatusId: 'done',
      statusCategory: 'completed',
    },
    actorUserId,
    createAuditContext('update-team-issue'),
  )

  const transaction = recording.commands.find((command) => command.name === 'TransactWriteCommand')
  const stateUpdate = readTransactItems(transaction)[0]?.Update

  expect(stateUpdate).toMatchObject({
    ConditionExpression:
      'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
      '#revision = :expectedRevision',
    ExpressionAttributeValues: {
      ':expectedRevision': 1,
      ':nextRevision': 2,
    },
  })
})

test('comment mutation condition-checks its parent and writes specialized and generic events atomically', async () => {
  const issueItem = createTeamIssueItem('issue-1')
  const recording = createRecordingDocumentClient((name) =>
    name === 'GetCommand' ? { Item: issueItem } : {},
  )
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )

  await client.createTeamIssueComment(
    workspaceId,
    'core-team',
    'issue-1',
    { body: 'Please review the audit event.' },
    actorUserId,
    createAuditContext('comment-request'),
  )

  const transaction = recording.commands.find((command) => command.name === 'TransactWriteCommand')
  const items = readTransactItems(transaction)

  expect(items).toHaveLength(3)
  expect(items[0]).toEqual({
    ConditionCheck: {
      TableName: 'IssuesTable',
      Key: {
        directoryTeamId: `${workspaceId}#team#core-team`,
        issueId: 'issue-1',
      },
      ConditionExpression: 'attribute_exists(directoryTeamId) AND attribute_exists(issueId)',
    },
  })
  expect(items[1]).toMatchObject({
    Put: {
      TableName: 'IssueEventsTable',
      Item: {
        issueId: 'issue-1',
        eventType: 'commented',
        body: 'Please review the audit event.',
      },
    },
  })
  const specializedEvent = readPutItem(items[1])

  expect(items[2]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'comment.created',
        entityType: 'work-item',
        entityId: 'team/core-team/issue/issue-1',
        targetType: 'comment',
        targetId: `team/core-team/issue/issue-1/comment/${String(specializedEvent.eventId)}`,
      },
    },
  })
})

test('workspace audit requires system admin and forwards pagination filters', async () => {
  const queries: Array<Record<string, unknown>> = []
  const auditWrites: Array<Record<string, unknown>> = []
  setTestAppDependencies({
    cognito: createCognitoClient(),
    workspaceAccess: createWorkspaceAccessClient(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async putEvent(event) {
        auditWrites.push(event as unknown as Record<string, unknown>)
      },
      async query(input) {
        queries.push({ ...input })
        return { events: [], nextCursor: 'next-audit-page' }
      },
    },
  })

  const denied = await app.request('/api/audit/events?limit=25', {
    headers: { Authorization: `Bearer ${createAccessToken([])}` },
  })

  expect(denied.status).toBe(403)
  expect(queries).toEqual([])

  const response = await app.request(
    '/api/audit/events?actorUserId=actor-2&eventType=work-item.updated&limit=25&cursor=cursor-1',
    {
      headers: {
        Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      },
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ events: [], nextCursor: 'next-audit-page' })
  expect(queries).toEqual([
    expect.objectContaining({
      workspaceId,
      actorId: 'actor-2',
      eventTypes: ['work-item.updated'],
      limit: 25,
      cursor: 'cursor-1',
      direction: 'descending',
    }),
  ])
  expect(auditWrites).toEqual([
    expect.objectContaining({
      workspaceId,
      eventType: 'audit.viewed',
      entityType: 'audit-log',
      entityId: workspaceId,
      metadata: expect.objectContaining({
        format: 'json',
        returnedEventCount: 0,
      }),
    }),
  ])
})

test('workspace audit projects invitation lifecycle events without storage fields', async () => {
  const invitationId = 'invitation-1'
  const invitationEntityId = createWorkspaceInvitationAuditEntityId(
    workspaceId,
    invitationId,
    workspaceAuditPseudonymKey,
  )
  const actor = {
    id: 'owner-sub',
    kind: 'user' as const,
    displayName: 'owner@example.com',
  }
  const changes = [
    { field: 'status', before: 'pending', after: 'revoked' },
    { field: 'deliveryStatus', before: 'sent', after: 'not-required' },
  ]
  const event = createAuditEvent({
    context: createMutationAuditContext({
      workspaceId,
      actor,
      idempotencyKey: 'workspace-invitation-revoke',
      correlationId: 'workspace-invitation-correlation',
      occurredAt,
      request: {
        method: 'POST',
        path: `/api/workspace/invitations/${invitationId}/revoke`,
      },
      source: {
        kind: 'api',
        requestId: 'request-workspace-invitation',
        method: 'POST',
        route: '/api/workspace/invitations/:invitationId/revoke',
        ipAddress: '203.0.113.10',
        userAgent: 'audit-integration-test',
      },
    }),
    eventType: 'invitation.revoked',
    entity: { type: 'invitation', id: invitationEntityId },
    target: { type: 'invitation', id: invitationEntityId },
    action: 'revoked',
    changes,
    summary: 'Workspace invitation was revoked.',
    metadata: { kind: 'workspace-invitation', invitationId },
    expiresAt: 1_999_999_999,
    outboxStatus: 'pending',
  })
  const queries: Array<Record<string, unknown>> = []
  const auditWrites: Array<Record<string, unknown>> = []
  setTestAppDependencies({
    cognito: createCognitoClient(),
    workspaceAccess: createWorkspaceAccessClient(),
    auditEvents: {
      async putEvent(auditEvent) {
        auditWrites.push(auditEvent as unknown as Record<string, unknown>)
      },
      async getEvent() {
        return undefined
      },
      async query(input) {
        queries.push({ ...input })
        return { events: [event] }
      },
    },
  })

  const response = await app.request(
    `/api/audit/events?targetType=invitation&targetId=${encodeURIComponent(invitationEntityId)}&limit=10`,
    {
      headers: {
        Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      },
    },
  )

  expect(response.status).toBe(200)
  expect(queries).toEqual([
    expect.objectContaining({
      workspaceId,
      targetType: 'invitation',
      targetId: invitationEntityId,
      limit: 10,
      direction: 'descending',
    }),
  ])
  const body = await response.json() as { events: Array<Record<string, unknown>> }
  expect(body.events).toHaveLength(1)
  const projectedEvent = body.events[0] ?? {}
  expect(projectedEvent).toMatchObject({
    eventId: event.eventId,
    eventType: 'invitation.revoked',
    occurredAt,
    actor,
    entity: { type: 'invitation', id: invitationEntityId },
    target: { type: 'invitation', id: invitationEntityId },
    changes,
    action: 'revoked',
    correlationId: 'workspace-invitation-correlation',
    source: 'api',
    summary: 'Workspace invitation was revoked.',
    metadata: { kind: 'workspace-invitation' },
  })

  for (const field of [
    'schemaVersion',
    'directoryId',
    'workspaceId',
    'occurredAtEventId',
    'workspaceKey',
    'workspaceEventKey',
    'actorKey',
    'actorEventKey',
    'actorUserId',
    'entityType',
    'entityId',
    'entityKey',
    'entityEventKey',
    'targetKey',
    'targetEventKey',
    'targetType',
    'targetId',
    'idempotencyKeyHash',
    'requestFingerprint',
    'sourceDetails',
    'expiresAt',
    'outboxStatus',
  ]) {
    expect(projectedEvent).not.toHaveProperty(field)
  }
  expect(auditWrites).toEqual([
    expect.objectContaining({
      workspaceId,
      eventType: 'audit.viewed',
      metadata: expect.objectContaining({
        filtered: true,
        returnedEventCount: 1,
      }),
    }),
  ])
})

test('issue activity authorizes the parent and forwards its pagination cursor', async () => {
  const queries: Array<Record<string, unknown>> = []
  const activityActorUserId = 'automation:workflow-runner'
  const activityEvent = createAuditEvent({
    context: createMutationAuditContext({
      workspaceId,
      actor: {
        id: activityActorUserId,
        kind: 'service',
        displayName: 'Workflow automation',
      },
      idempotencyKey: 'issue-activity-read',
      correlationId: 'issue-activity-read',
      occurredAt,
      request: {
        method: 'POST',
        path: '/internal/automation/work-item',
        body: { issueId: 'issue-1' },
      },
      source: { kind: 'system' },
    }),
    eventType: 'work-item.updated',
    entity: { type: 'work-item', id: 'team/core-team/issue/issue-1' },
    target: { type: 'work-item', id: 'team/core-team/issue/issue-1' },
    action: 'updated',
    summary: 'Work Item was updated.',
    metadata: { adapter: 'workflow-automation' },
    expiresAt: 2_000_000_000,
  })
  const systemActorEvent = createAuditEvent({
    context: createMutationAuditContext({
      workspaceId,
      actor: {
        id: 'system:rule-engine',
        kind: 'system',
        displayName: 'Rule engine',
      },
      idempotencyKey: 'issue-system-activity',
      correlationId: 'issue-system-activity',
      occurredAt,
      request: {
        method: 'POST',
        path: '/internal/rules/work-item',
        body: { issueId: 'issue-1' },
      },
      source: { kind: 'api' },
    }),
    eventType: 'work-item.updated',
    entity: { type: 'work-item', id: 'team/core-team/issue/issue-1' },
    target: { type: 'work-item', id: 'team/core-team/issue/issue-1' },
    action: 'updated',
    summary: 'A rule updated the Work Item.',
    metadata: { kind: 'rule-evaluation' },
    expiresAt: 2_000_000_000,
  })
  const projectDirectory = {
    async getProjectDirectory() {
      return {
        teams: [
          {
            id: 'core-team',
            name: 'Core Team',
            expanded: true,
            projects: [],
          },
          {
            id: 'design-team',
            name: 'Design Team',
            expanded: true,
            projects: [],
          },
        ],
      }
    },
  } as unknown as NonNullable<
    Parameters<typeof setTestAppDependencies>[0]['projectDirectory']
  >
  const teamIssues = {
    async getTeamIssueDetail(_directoryId: string, teamId: string) {
      return {
        issue: {
          schemaVersion: 2 as const,
          revision: 1,
          id: 'issue-1',
          teamId,
          title: 'Audit integration',
          assigneeUserId: actorUserId,
          creatorMemberKey: actorUserId,
          workflowSchemaVersion: 1 as const,
          workflowStatusId: 'todo',
          statusCategory: 'unstarted' as const,
          customFieldValues: {},
          relationIds: [],
          dueDate: '2026-07-31',
          schedule: createDefaultDueDateWorkItemSchedule('2026-07-31'),
          priority: 'high' as const,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          source: 'dynamodb' as const,
        },
        comments: [],
        activity: [],
      }
    },
  } as unknown as NonNullable<Parameters<typeof setTestAppDependencies>[0]['teamIssues']>
  setTestAppDependencies({
    cognito: createCognitoClient(),
    workspaceAccess: createWorkspaceAccessClient(),
    projectDirectory,
    teamIssues,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        queries.push({ ...input })
        return { events: [activityEvent, systemActorEvent], nextCursor: 'next-activity-page' }
      },
    },
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/activity?limit=2&cursor=activity-cursor',
    {
      headers: {
        Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      },
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    events: [{
      eventId: activityEvent.eventId,
      actor: {
        id: activityActorUserId,
        kind: 'service',
        displayName: 'Workflow automation',
      },
      actorUserId: activityActorUserId,
      metadata: {
        actorKind: 'service',
        systemChange: true,
        adapter: 'workflow-automation',
      },
    }, {
      eventId: systemActorEvent.eventId,
      actor: {
        id: 'system:rule-engine',
        kind: 'system',
        displayName: 'Rule engine',
      },
      actorUserId: 'system:rule-engine',
      metadata: {
        actorKind: 'system',
        systemChange: true,
        kind: 'rule-evaluation',
      },
    }],
    nextCursor: 'next-activity-page',
  })
  const otherTeamResponse = await app.request(
    '/api/teams/design-team/issues/issue-1/activity?limit=2',
    {
      headers: {
        Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      },
    },
  )

  expect(otherTeamResponse.status).toBe(200)
  expect(queries).toEqual([
    expect.objectContaining({
      workspaceId,
      entityType: 'work-item',
      entityId: 'team/core-team/issue/issue-1',
      limit: 2,
      cursor: 'activity-cursor',
    }),
    expect.objectContaining({
      workspaceId,
      entityType: 'work-item',
      entityId: 'team/design-team/issue/issue-1',
      limit: 2,
    }),
  ])
})

/**
 * 固定 actor と timestamp を使う mutation audit context を作成します。
 */
function createAuditContext(idempotencyKey: string) {
  return createMutationAuditContext({
    workspaceId,
    actor: {
      id: actorUserId,
      kind: 'user',
      displayName: 'Demo User',
    },
    idempotencyKey,
    correlationId: idempotencyKey,
    occurredAt,
    request: {
      method: 'POST',
      path: '/api/test-mutation',
      body: { stable: true },
    },
    source: {
      kind: 'api',
      requestId: 'request-1',
    },
  })
}

/**
 * AWS command を記録する mock DocumentClient を作成します。
 */
function createRecordingDocumentClient(
  respond: (name: string, input: Record<string, unknown>) => Record<string, unknown>,
) {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name
      commands.push({ name, input: command.input })

      return respond(name, command.input)
    },
  } as unknown as DynamoDBDocumentClient

  return { client, commands }
}

/**
 * 記録済み command から transaction item を厳格に読み取ります。
 */
function readTransactItems(
  command: { name: string; input: Record<string, unknown> } | undefined,
) {
  const items = command?.input.TransactItems

  if (!Array.isArray(items) || !items.every(isRecord)) {
    throw new TypeError('Expected a TransactWriteCommand with object TransactItems.')
  }

  return items
}

/**
 * transaction item の Put payload から保存 item を読み取ります。
 */
function readPutItem(item: Record<string, unknown> | undefined) {
  const put = item?.Put

  if (!isRecord(put) || !isRecord(put.Item)) {
    throw new TypeError('Expected a transaction Put item.')
  }

  return put.Item
}

/**
 * comment integration test 用の有効な Team Issue item を作成します。
 */
function createTeamIssueItem(issueId: string) {
  return {
    directoryId: workspaceId,
    directoryTeamId: `${workspaceId}#team#core-team`,
    teamId: 'core-team',
    issueId,
    schemaVersion: 2,
    revision: 1,
    sortOrder: 10,
    title: 'Audit integration',
    assigneeUserId: actorUserId,
    creatorMemberKey: actorUserId,
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-31',
    schedule: {
      calendarPolicy: {
        holidays: [],
        timeZone: 'UTC',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
      dueDate: '2026-07-31',
      mode: 'due-date',
    },
    priority: 'high',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
}

/**
 * app integration test で使う Cognito client stub を作成します。
 */
function createCognitoClient() {
  return {
    async initiatePasswordAuth(_email: string, _password: string) {
      return {}
    },
    async getUser(_accessToken: string) {
      return {
        Username: actorUserId,
        UserAttributes: [
          { Name: 'email', Value: actorUserId },
          { Name: 'custom:directory_id', Value: workspaceId },
        ],
      }
    },
    async listUsers(_input: unknown) {
      return { users: [] }
    },
    async getUserProfile(userId: string) {
      return {
        id: userId,
        username: userId,
        email: userId,
      }
    },
  } as unknown as NonNullable<Parameters<typeof setTestAppDependencies>[0]['cognito']>
}

/**
 * app integration test で active Workspace membership を返す client stub を作成します。
 */
function createWorkspaceAccessClient() {
  return {
    async getActiveMember(_workspaceId: string, memberKey: string) {
      return {
        id: memberKey,
        memberKey,
        email: memberKey,
        role: 'member' as const,
        status: 'active' as const,
        version: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }
    },
  } as unknown as NonNullable<
    Parameters<typeof setTestAppDependencies>[0]['workspaceAccess']
  >
}

/**
 * Cognito group claim を含む test access token を作成します。
 */
function createAccessToken(groups: string[]) {
  const payload = Buffer.from(JSON.stringify({ 'cognito:groups': groups })).toString('base64url')

  return `header.${payload}.signature`
}

/**
 * 値が non-array object かどうかを判定します。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
