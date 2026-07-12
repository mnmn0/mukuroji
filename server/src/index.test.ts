import { afterEach, expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createAuditEvent, createMutationAuditContext } from './audit'
import {
  app,
  CognitoServiceError,
  configureApiClientsForTest,
  DynamoDbDashboardSummaryClient,
  DynamoDbProjectDirectoryClient,
  DynamoDbProjectTasksClient,
  resetApiClientsForTest,
  WorkspaceAccessError,
  type ProjectRole,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from './index'

afterEach(() => {
  resetApiClientsForTest()
})

test('loads project directory from the authenticated user scoped partition', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/projects?locale=en', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'Core Team',
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
  expect(calls.directoryReads).toEqual([{ directoryId: 'user#demo@example.com', locale: 'en' }])
})

test('returns Cognito groups and system admin status for the current user', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/auth/me', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    groups: ['mukuroji-system-admins'],
    isSystemAdmin: true,
  })
})

test('returns Workspace role and active status for the current user', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/auth/me', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    workspaceRole: 'admin',
    workspaceMemberStatus: 'active',
  })
})

test('blocks a deactivated Workspace member before any business API read', async () => {
  const calls = configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })

  const response = await app.request('/api/teams/projects', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Workspace access is denied.' })
  expect(calls.directoryReads).toEqual([])
})

test('keeps guest Workspace members read-only even when they have a project role', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'guest' })

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Guest must not create this task',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
    }),
  })

  expect(response.status).toBe(403)
  expect(calls.taskCreates).toEqual([])
})

test('limits Workspace structure changes to owners and admins', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Unauthorized team' }),
  })

  expect(response.status).toBe(403)
  expect(calls.teamCreates).toEqual([])
})

test('rejects inactive Workspace members as task assignment candidates', async () => {
  const calls = configureFakeProjectClients(true, {
    inactiveWorkspaceMemberKeys: ['sato@example.com'],
  })

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Inactive assignee task',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
    }),
  })

  expect(response.status).toBe(409)
  expect(calls.taskCreates).toEqual([])
})

test('returns a NEW_PASSWORD_REQUIRED challenge without creating a session', async () => {
  const calls = configureFakeProjectClients(true, { passwordAuthChallenge: true })

  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'Temporary123!' }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    challenge: 'NEW_PASSWORD_REQUIRED',
    email: 'demo@example.com',
    session: 'new-password-session',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('returns a stable error when a new password violates the Cognito policy', async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeError: new CognitoServiceError(
      400,
      'InvalidPasswordException',
      'Password did not conform with policy.',
    ),
  })

  const response = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@example.com',
      newPassword: 'weak',
      session: 'new-password-session',
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidNewPassword',
    message: 'New password does not meet the password policy.',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('retries membership reconcile on normal login after password completion succeeded alone', async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeTokens: true,
    passwordAuthTokens: true,
    workspaceReconcileFailures: 1,
  })

  const challengeResponse = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })
  expect(challengeResponse.status).toBe(503)

  const loginResponse = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'Permanent123!' }),
  })

  expect(loginResponse.status).toBe(200)
  expect(await loginResponse.json()).toMatchObject({ accessToken: 'test-token' })
  expect(calls.workspaceReconciliations).toEqual([
    'demo@example.com',
    'demo@example.com',
  ])
})

test('returns owner and admin Workspace capabilities from the API source of truth', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/workspace/access', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    currentMember: { role: 'admin', status: 'active' },
    capabilities: {
      canInvite: true,
      canManageMembers: true,
      canManageAdmins: false,
    },
  })
})

test('rejects deactivating a Workspace member who still manages an active project', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion: 1, status: 'deactivated' }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    message: 'Transfer or remove all active project manager roles before deactivating this member.',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
  ])
})

test('resends credentials when inviting an existing unconfirmed Workspace identity', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'invitee@example.com',
      name: 'Invitee',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual(['invitee@example.com'])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'invitee@example.com',
      identityOwnership: 'pre-existing',
      status: 'pending',
    },
  })
})

test('records ownership when invitation provisioning creates a new Cognito identity', async () => {
  const calls = configureFakeProjectClients(true, { workspaceUserMissing: true })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'new-user@example.com',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual([])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'new-user@example.com',
      identityOwnership: 'workspace-created',
      status: 'pending',
    },
  })
})

test('keeps raced Cognito ownership ambiguous while resending temporary credentials', async () => {
  const calls = configureFakeProjectClients(true, { workspaceProvisionRace: true })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'raced-user@example.com',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual(['raced-user@example.com'])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'raced-user@example.com',
      identityOwnership: 'ambiguous',
      status: 'pending',
    },
  })
})

test('loads dashboard summary from the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/dashboard/summary', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projects: 1,
    tasks: 1,
    blocked: 0,
    updatedAt: '2026-06-03T00:00:00.000Z',
    source: 'dynamodb',
  })
  expect(calls.summaryReads).toEqual([
    {
      directoryId: 'user#demo@example.com',
      isSystemAdmin: false,
      userKey: 'demo@example.com',
    },
  ])
})

test('marks a workspace audit export as truncated when the 1,000 event cap leaves a cursor', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()
  let pageNumber = 0

  configureApiClientsForTest({
    auditEvents: {
      async query(input) {
        pageNumber += 1
        expect(input.limit).toBe(100)

        return {
          events: Array.from({ length: 100 }, () => event),
          nextCursor: `cursor-${pageNumber}`,
        }
      },
    },
  })

  const response = await app.request('/api/audit/events/export', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      Origin: 'http://localhost:5173',
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('Access-Control-Expose-Headers')).toBe(
    'X-Audit-Truncated,X-Audit-Next-Cursor',
  )
  expect(response.headers.get('X-Audit-Truncated')).toBe('true')
  expect(response.headers.get('X-Audit-Next-Cursor')).toBe('cursor-10')
  expect((await response.text()).trimEnd().split('\n')).toHaveLength(1_000)
  expect(pageNumber).toBe(10)
})

test('omits truncation headers when a workspace audit export reaches the final page', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()

  configureApiClientsForTest({
    auditEvents: {
      async query() {
        return { events: [event] }
      },
    },
  })

  const response = await app.request('/api/audit/events/export', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('X-Audit-Truncated')).toBeNull()
  expect(response.headers.get('X-Audit-Next-Cursor')).toBeNull()
  expect((await response.text()).trimEnd().split('\n')).toHaveLength(1)
})

test('denies project tasks when the project is outside the user directory', async () => {
  const calls = configureFakeProjectClients(false)

  const response = await app.request('/api/projects/secret/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'secret' },
  ])
  expect(calls.taskReads).toEqual([])
})

test('loads project tasks after project access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projectId: 'refero',
    tasks: [
      {
        id: 'wireframe',
        titleKey: 'tasks.item.wireframe',
        assigneeKey: 'tasks.assignee.sato',
        status: 'in-progress',
        dueDate: '2026/06/03',
        priority: 'high',
      },
    ],
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('lists Cognito users for project member assignment when the current user is project manager', async () => {
  const calls = configureFakeProjectClients(true, {
    cognitoUsersNextToken: 'following-page-token',
    role: 'manager',
  })

  const response = await app.request(
    '/api/projects/refero/users?query=sato&limit=1&nextToken=next-page-token',
    {
      headers: {
        Authorization: 'Bearer test-token',
      },
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    users: [
      {
        id: 'sato@example.com',
        username: 'sato@example.com',
        email: 'sato@example.com',
        name: '佐藤 花子',
        enabled: true,
        status: 'CONFIRMED',
        workspaceStatus: 'active',
      },
    ],
    nextToken: 'following-page-token',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.userLists).toEqual([{
    directoryId: 'user#demo@example.com',
    limit: 1,
    paginationToken: 'next-page-token',
    query: 'sato',
  }])
  expect(calls.userProfiles).toEqual([])
})

test('continues Cognito pagination until an active Workspace assignment candidate is found', async () => {
  const calls = configureFakeProjectClients(true, {
    cognitoUserPages: [
      { userIds: ['inactive@example.com'], nextToken: 'active-page' },
      { userIds: ['sato@example.com'], nextToken: 'following-page' },
    ],
    role: 'manager',
  })

  const response = await app.request('/api/projects/refero/users?limit=1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    users: [{ id: 'sato@example.com', workspaceStatus: 'active' }],
    nextToken: 'following-page',
  })
  expect(calls.userLists).toEqual([
    {
      directoryId: 'user#demo@example.com',
      limit: 1,
      paginationToken: undefined,
      query: undefined,
    },
    {
      directoryId: 'user#demo@example.com',
      limit: 1,
      paginationToken: 'active-page',
      query: undefined,
    },
  ])
})

test('keeps project members available when Cognito profile hydration fails', async () => {
  const calls = configureFakeProjectClients(true, {
    profileError: new Error('Cognito profile hydration failed.'),
  })

  const response = await app.request('/api/projects/refero/members', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projectId: 'refero',
    members: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
    ],
  })
  expect(calls.userProfiles).toEqual(['demo@example.com'])
})

test('keeps project tasks available when Cognito assignee hydration fails', async () => {
  const calls = configureFakeProjectClients(true, {
    profileError: new Error('Cognito profile hydration failed.'),
    taskAssigneeUserId: 'sato@example.com',
  })

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projectId: 'refero',
    tasks: [
      {
        id: 'wireframe',
        titleKey: 'tasks.item.wireframe',
        assigneeKey: 'tasks.assignee.sato',
        assigneeUserId: 'sato@example.com',
        status: 'in-progress',
        dueDate: '2026/06/03',
        priority: 'high',
      },
    ],
  })
  expect(calls.userProfiles).toEqual(['sato@example.com'])
})

test('creates a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規チーム',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    team: {
      id: 'new-team',
      name: '新規チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(calls.teamCreates).toEqual([
    { directoryId: 'user#demo@example.com', name: '新規チーム' },
  ])
})

test('creates a project under an authenticated team directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
      tone: 'green',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    project: {
      id: 'new-project',
      name: '新規プロジェクト',
      tone: 'green',
    },
  })
  expect(calls.projectCreates).toEqual([
    {
      creatorUserKey: 'demo@example.com',
      directoryId: 'user#demo@example.com',
      name: '新規プロジェクト',
      teamId: 'core-team',
    },
  ])
})

test('returns conflict when project creation transaction is canceled', async () => {
  configureFakeProjectClients(true)
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
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      if (command.constructor.name === 'GetCommand') {
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

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ message: 'The same item already exists.' })
})

test('returns bad gateway when project creation transaction has no cancellation reasons', async () => {
  configureFakeProjectClients(true)
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
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規プロジェクト' }),
  })

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ message: 'Project data is unavailable.' })
})

test('returns service unavailable when project creation transaction table is missing', async () => {
  configureFakeProjectClients(true)
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
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('missing table')
        error.name = 'ResourceNotFoundException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規プロジェクト' }),
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ message: 'Project data is not initialized.' })
})

test('returns not found when project creation transaction loses its active team', async () => {
  configureFakeProjectClients(true)
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
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
              ...(queryReads >= 2 ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
    }),
  })

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ message: 'Team was not found.' })
})

test('archives a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    archivedAt: '2026-06-06T00:00:00.000Z',
  })
  expect(calls.teamArchives).toEqual([
    { directoryId: 'user#demo@example.com', teamId: 'core-team' },
  ])
})

test('denies project task creation when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規タスク',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'high',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskCreates).toEqual([])
})

test('denies project member reads when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/projects/refero/members', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.memberReads).toEqual([])
})

test('updates a project member role when the current user is project manager', async () => {
  const calls = configureFakeProjectClients(true, { role: 'manager' })

  const response = await app.request('/api/projects/refero/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      username: 'sato@example.com',
      name: '佐藤 花子',
      enabled: true,
      status: 'CONFIRMED',
      role: 'member',
      updatedAt: '2026-06-08T00:00:00.000Z',
      workspaceStatus: 'active',
    },
  })
  expect(calls.memberUpdates).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'sato@example.com',
      projectId: 'refero',
      role: 'member',
    },
  ])
  expect(calls.userProfiles).toEqual(['sato@example.com', 'sato@example.com'])
})

test('lets a system admin update project members without a project role', async () => {
  const calls = configureFakeProjectClients(false, { role: undefined })

  const response = await app.request('/api/projects/refero/members/viewer%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'viewer@example.com',
      role: 'viewer',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    member: {
      id: 'viewer@example.com',
      email: 'viewer@example.com',
      username: 'viewer@example.com',
      name: 'Viewer User',
      enabled: true,
      status: 'CONFIRMED',
      role: 'viewer',
      updatedAt: '2026-06-08T00:00:00.000Z',
      workspaceStatus: 'active',
    },
  })
  expect(calls.roleChecks).toEqual([])
  expect(calls.accessChecks).toEqual([])
  expect(calls.memberUpdates).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'viewer@example.com',
      projectId: 'refero',
      role: 'viewer',
    },
  ])
  expect(calls.userProfiles).toEqual(['viewer@example.com', 'viewer@example.com'])
})

test('archives a project under an authenticated team directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: '2026-06-06T00:00:00.000Z',
  })
  expect(calls.projectArchives).toEqual([
    { directoryId: 'user#demo@example.com', teamId: 'core-team', projectId: 'refero' },
  ])
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
    TableName: 'DirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: '新規チーム-2',
      teamSortOrder: 20,
      entryKey: '000020#000000#TEAM#新規チーム-2',
    },
    ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
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
    TableName: 'MissingDirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: '復旧チーム',
    },
  })
})

test('DynamoDB task client initializes a missing local table before reading tasks', async () => {
  const rawInputs: Array<Record<string, unknown>> = []
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
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
            GlobalSecondaryIndexes: [
              {
                IndexName: 'ProjectSortOrderIndex',
                KeySchema: [
                  { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
                  { AttributeName: 'sortOrder', KeyType: 'RANGE' },
                ],
              },
            ],
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'taskId', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectTasksClient(
    'MissingTasksTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(client.getProjectTasks('user#demo@example.com', 'new-project')).resolves.toEqual({
    projectId: 'new-project',
    tasks: [],
  })
  expect(rawInputs).toEqual([
    expect.objectContaining({
      commandName: 'CreateTableCommand',
      TableName: 'MissingTasksTable',
      KeySchema: [
        { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
        { AttributeName: 'taskId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        expect.objectContaining({
          IndexName: 'ProjectSortOrderIndex',
        }),
      ],
    }),
    expect.objectContaining({
      commandName: 'DescribeTableCommand',
      TableName: 'MissingTasksTable',
    }),
  ])
})

test('DynamoDB task client fails fast when a local table exists with the wrong schema', async () => {
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1
        const error = new Error('missing index')
        error.name = 'ResourceNotFoundException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'CreateTableCommand') {
        const error = new Error('table exists')
        error.name = 'ResourceInUseException'
        throw error
      }

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'taskId', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectTasksClient(
    'BrokenTasksTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(
    client.getProjectTasks('user#demo@example.com', 'broken-project'),
  ).rejects.toThrow('does not match the expected schema')
  expect(queryAttempts).toBe(1)
})

test('creates a project task after project access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規タスク',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'high',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    task: {
      id: 'new-task',
      title: '新規タスク',
      assigneeUserId: 'sato@example.com',
      assigneeEmail: 'sato@example.com',
      assigneeName: '佐藤 花子',
      status: 'todo',
      dueDate: '2026/06/20',
      priority: 'high',
    },
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskCreates).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero', title: '新規タスク' },
  ])
  expect(calls.userProfiles).toEqual(['sato@example.com', 'sato@example.com'])
})

test('rejects legacy project task status updates through the compatibility endpoint', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks/wireframe', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'done',
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    message: 'Legacy task issues are read-only.',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskStatusUpdates).toEqual([])
})

test('loads team-owned issues with legacy project tasks after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/teams/core-team/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.teamId).toBe('core-team')
  expect(body.issues).toHaveLength(2)
  expect(body.issues[0]).toMatchObject({
    id: 'onboarding-friction',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: '初回オンボーディングの離脱要因を減らす',
    assigneeEmail: 'sato@example.com',
  })
  expect(body.issues[1]).toMatchObject({
    id: 'wireframe',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    titleKey: 'tasks.item.wireframe',
  })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', teamId: 'core-team' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('loads legacy project task rows as team issue detail fallback', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/teams/core-team/issues/wireframe', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      id: 'wireframe',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      titleKey: 'tasks.item.wireframe',
      assigneeUserId: 'sato@example.com',
      assigneeEmail: 'sato@example.com',
      status: 'in-progress',
      dueDate: '2026/06/03',
      priority: 'high',
    },
    comments: [],
    activity: [],
  })
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'wireframe',
    },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('creates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規 Issue',
      description: 'Issue の説明',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    issue: {
      id: 'new-issue',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      title: '新規 Issue',
      description: 'Issue の説明',
      assigneeUserId: 'sato@example.com',
      assigneeEmail: 'sato@example.com',
      assigneeName: '佐藤 花子',
      status: 'todo',
      dueDate: '2026/06/20',
      priority: 'medium',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
  })
  expect(calls.issueCreates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: 'refero',
      directoryId: 'user#demo@example.com',
      reservedIssueIds: ['wireframe'],
      teamId: 'core-team',
      title: '新規 Issue',
    },
  ])
})

test('rejects a team issue assignment to a project outside the owning team', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '不正な割り当て',
      assignedProjectId: 'unknown-project',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(400)
  expect(calls.issueCreates).toEqual([])
})

test('rejects a team issue assignment when the user lacks target project member role', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [
      {
        projectId: 'refero',
        role: 'member',
      },
    ],
    teamProjects: [
      {
        id: 'refero',
        name: 'Refero',
        tone: 'blue',
      },
      {
        id: 'product-roadmap',
        name: 'プロダクトロードマップ',
        tone: 'yellow',
      },
    ],
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '権限外プロジェクトへの割り当て',
      assignedProjectId: 'product-roadmap',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(calls.issueCreates).toEqual([])
})

test('loads team issue detail and creates comments after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const detailResponse = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(detailResponse.status).toBe(200)
  expect(await detailResponse.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      assigneeEmail: 'sato@example.com',
    },
    comments: [
      {
        id: 'comment-1',
        body: '背景を確認します。',
      },
    ],
    activity: [
      {
        id: 'activity-1',
        type: 'created',
      },
    ],
  })

  const commentResponse = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: '追加コメント',
    }),
  })

  expect(commentResponse.status).toBe(201)
  expect(await commentResponse.json()).toEqual({
    comment: {
      id: 'comment-2',
      actorUserId: 'demo@example.com',
      body: '追加コメント',
      createdAt: '2026-06-08T02:00:00.000Z',
    },
    activity: {
      id: 'activity-2',
      type: 'commented',
      actorUserId: 'demo@example.com',
      summary: 'Comment was added.',
      createdAt: '2026-06-08T02:00:00.000Z',
    },
  })
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
    },
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
    },
  ])
  expect(calls.issueComments).toEqual([
    {
      actorUserId: 'demo@example.com',
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
    },
  ])
})

test('updates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '更新済み Issue',
      assignedProjectId: null,
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/22',
      priority: 'low',
      status: 'done',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      teamId: 'core-team',
      title: '更新済み Issue',
      assigneeEmail: 'sato@example.com',
      status: 'done',
      dueDate: '2026/06/22',
      priority: 'low',
    },
  })
  expect(calls.issueUpdates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: null,
      directoryId: 'user#demo@example.com',
      issueId: 'onboarding-friction',
      teamId: 'core-team',
    },
  ])
})

test('loads project execution issues with legacy task compatibility', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/projects/refero/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.projectId).toBe('refero')
  expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([
    'onboarding-friction',
    'wireframe',
  ])
  expect(calls.projectIssueReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('DynamoDB task client queries the scoped project partition across pages', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              directoryProjectId: 'user#demo@example.com#project#refero',
              projectId: 'refero',
              taskId: 'wireframe',
              sortOrder: 10,
              titleKey: 'tasks.item.wireframe',
              assigneeKey: 'tasks.assignee.sato',
              status: 'in-progress',
              dueDate: '2026/06/03',
              priority: 'high',
            },
          ],
          LastEvaluatedKey: {
            directoryProjectId: 'user#demo@example.com#project#refero',
            taskId: 'wireframe',
          },
        }
      }

      return {
        Items: [
          {
            directoryId: 'user#demo@example.com',
            directoryProjectId: 'user#demo@example.com#project#refero',
            projectId: 'refero',
            taskId: 'brand-guideline',
            sortOrder: 20,
            titleKey: 'tasks.item.brandGuideline',
            assigneeKey: 'tasks.assignee.suzuki',
            status: 'review',
            dueDate: '2026/06/05',
            priority: 'medium',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectTasksClient('TasksTable', documentClient)

  await expect(client.getProjectTasks('user#demo@example.com', 'refero')).resolves.toEqual({
    projectId: 'refero',
    tasks: [
      {
        id: 'wireframe',
        titleKey: 'tasks.item.wireframe',
        assigneeKey: 'tasks.assignee.sato',
        status: 'in-progress',
        dueDate: '2026/06/03',
        priority: 'high',
      },
      {
        id: 'brand-guideline',
        titleKey: 'tasks.item.brandGuideline',
        assigneeKey: 'tasks.assignee.suzuki',
        status: 'review',
        dueDate: '2026/06/05',
        priority: 'medium',
      },
    ],
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: {
        directoryProjectId: 'user#demo@example.com#project#refero',
        taskId: 'wireframe',
      },
      ScanIndexForward: true,
    },
  ])
})

test('DynamoDB task client creates duplicate titled tasks with unique IDs', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              directoryProjectId: 'user#demo@example.com#project#refero',
              projectId: 'refero',
              taskId: '新規タスク',
              sortOrder: 10,
              title: '新規タスク',
              assignee: '佐藤 花子',
              status: 'todo',
              dueDate: '2026/06/20',
              priority: 'high',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectTasksClient('TasksTable', documentClient)

  await expect(
    client.createProjectTask('user#demo@example.com', 'refero', {
      title: '新規タスク',
      assigneeUserId: 'suzuki@example.com',
      status: 'todo',
      dueDate: '2026/06/21',
      priority: 'medium',
    }),
  ).resolves.toEqual({
    task: {
      id: '新規タスク-2',
      title: '新規タスク',
      assigneeUserId: 'suzuki@example.com',
      status: 'todo',
      dueDate: '2026/06/21',
      priority: 'medium',
    },
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'TasksTable',
      Item: {
        directoryId: 'user#demo@example.com',
        directoryProjectId: 'user#demo@example.com#project#refero',
        projectId: 'refero',
        taskId: '新規タスク-2',
        sortOrder: 20,
        title: '新規タスク',
        assigneeUserId: 'suzuki@example.com',
        status: 'todo',
        dueDate: '2026/06/21',
        priority: 'medium',
      },
      ConditionExpression: 'attribute_not_exists(directoryProjectId) AND attribute_not_exists(taskId)',
    },
  ])
})

test('DynamoDB task client updates a task status with a conditional write', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      return {
        Attributes: {
          directoryId: 'user#demo@example.com',
          directoryProjectId: 'user#demo@example.com#project#refero',
          projectId: 'refero',
          taskId: 'wireframe',
          sortOrder: 10,
          titleKey: 'tasks.item.wireframe',
          assigneeKey: 'tasks.assignee.sato',
          status: 'done',
          dueDate: '2026/06/03',
          priority: 'high',
        },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectTasksClient('TasksTable', documentClient)

  await expect(
    client.updateProjectTaskStatus('user#demo@example.com', 'refero', 'wireframe', {
      status: 'done',
    }),
  ).resolves.toEqual({
    task: {
      id: 'wireframe',
      titleKey: 'tasks.item.wireframe',
      assigneeKey: 'tasks.assignee.sato',
      status: 'done',
      dueDate: '2026/06/03',
      priority: 'high',
    },
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'TasksTable',
      Key: {
        directoryProjectId: 'user#demo@example.com#project#refero',
        taskId: 'wireframe',
      },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': 'done',
      },
      ConditionExpression: 'attribute_exists(directoryProjectId) AND attribute_exists(taskId)',
      ReturnValues: 'ALL_NEW',
    },
  ])
})

test('DynamoDB task client classifies audited transaction conditions from a consistent base-table read', async () => {
  const currentTask = {
    directoryId: 'user#demo@example.com',
    directoryProjectId: 'user#demo@example.com#project#refero',
    projectId: 'refero',
    taskId: 'wireframe',
    sortOrder: 10,
    titleKey: 'tasks.item.wireframe',
    assigneeKey: 'tasks.assignee.sato',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
  }
  const auditContext = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'request-1',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/projects/refero/tasks/wireframe/status' },
    source: { kind: 'api', requestId: 'request-1' },
  })
  const runUpdate = (
    cancellationReasons: Array<{ Code: string }> | undefined,
    latestTask: Record<string, unknown> | undefined,
  ) => {
    const sentInputs: Array<Record<string, unknown>> = []
    let taskReads = 0
    const documentClient = {
      async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
        sentInputs.push(command.input)

        if (command.constructor.name === 'GetCommand') {
          taskReads += 1
          return { Item: taskReads === 1 ? currentTask : latestTask }
        }

        if (command.constructor.name === 'TransactWriteCommand') {
          const error = new Error('Transaction was canceled.')
          error.name = 'TransactionCanceledException'

          if (cancellationReasons) {
            Object.assign(error, { CancellationReasons: cancellationReasons })
          }

          throw error
        }

        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbProjectTasksClient(
      'TasksTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    )
    const result = client.updateProjectTaskStatus(
      'user#demo@example.com',
      'refero',
      'wireframe',
      { status: 'done' },
      auditContext,
    )

    return { result, sentInputs }
  }

  const stateConflict = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    currentTask,
  )
  await expect(stateConflict.result).rejects.toMatchObject({
    code: 'ConditionalCheckFailedException',
    status: 409,
  })
  expect(stateConflict.sentInputs[0]).toMatchObject({
    TableName: 'TasksTable',
    ConsistentRead: true,
  })
  expect(stateConflict.sentInputs.at(-1)).toEqual({
    TableName: 'TasksTable',
    Key: {
      directoryProjectId: 'user#demo@example.com#project#refero',
      taskId: 'wireframe',
    },
    ConsistentRead: true,
  })

  const auditConflict = runUpdate(
    [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    currentTask,
  )
  await expect(auditConflict.result).rejects.toMatchObject({
    code: 'ConditionalCheckFailedException',
    status: 409,
  })
  expect(auditConflict.sentInputs).toHaveLength(2)

  const deletedTask = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    undefined,
  )
  await expect(deletedTask.result).rejects.toMatchObject({
    code: 'ProjectTaskNotFound',
    status: 404,
  })

  const missingReasons = runUpdate(undefined, undefined)
  await expect(missingReasons.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(missingReasons.sentInputs).toHaveLength(2)

  const unknownReason = runUpdate([{ Code: 'TransactionConflict' }], undefined)
  await expect(unknownReason.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(unknownReason.sentInputs).toHaveLength(2)

  const mixedReasons = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'ProvisionedThroughputExceeded' }],
    undefined,
  )
  await expect(mixedReasons.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(mixedReasons.sentInputs).toHaveLength(2)
})

test('DynamoDB dashboard summary client derives counts from directory and task data', async () => {
  const accessListReads: Array<{ directoryId: string; memberKey: string }> = []
  const directoryReads: Array<{ directoryId: string; locale: Locale }> = []
  const taskReads: Array<{ directoryId: string; projectId: string }> = []
  const client = new DynamoDbDashboardSummaryClient(
    {
      async getProjectDirectory(directoryId, locale) {
        directoryReads.push({ directoryId, locale })
        expect(directoryId).toBe('user#demo@example.com')
        expect(locale).toBe('ja')

        return {
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
                {
                  id: 'new-project',
                  name: '新規プロジェクト',
                  tone: 'green',
                },
              ],
            },
          ],
        }
      },
      async getProjectAccess(_directoryId, projectId) {
        return projectId === 'refero'
          ? {
              projectId,
              role: 'manager' as ProjectRole,
            }
          : undefined
      },
      async getProjectAccessList(directoryId, memberKey) {
        accessListReads.push({ directoryId, memberKey })

        return [
          {
            projectId: 'refero',
            role: 'manager' as ProjectRole,
          },
        ]
      },
      async hasProjectAccess() {
        return true
      },
      async getProjectRole() {
        return 'manager' as ProjectRole
      },
      async getProjectMembers() {
        return {
          projectId: 'unused',
          members: [],
        }
      },
      async updateProjectMember() {
        return {
          member: {
            id: 'unused',
            email: 'unused@example.com',
            role: 'viewer',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        }
      },
      async removeProjectMember() {
        return {
          projectId: 'unused',
          memberId: 'unused@example.com',
        }
      },
      async createTeam() {
        return {
          team: {
            id: 'unused',
            name: 'unused',
            projects: [],
          },
        }
      },
      async createProject() {
        return {
          project: {
            id: 'unused',
            name: 'unused',
          },
        }
      },
      async archiveTeam() {
        return {
          teamId: 'unused',
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
      async archiveProject() {
        return {
          teamId: 'unused',
          projectId: 'unused',
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
    },
    {
      async getProjectTasks(directoryId, projectId) {
        taskReads.push({ directoryId, projectId })

        return {
          projectId,
          tasks: projectId === 'refero'
            ? [
                {
                  id: 'wireframe',
                  title: 'ワイヤーフレーム',
                  assignee: '佐藤 花子',
                  status: 'in-progress',
                  dueDate: '2026/06/03',
                  priority: 'high',
                },
                {
                  id: 'archive',
                  title: '完了済み',
                  assignee: '鈴木 太郎',
                  status: 'done',
                  dueDate: '2026/06/01',
                  priority: 'high',
                },
              ]
            : [
                {
                  id: 'planning',
                  title: '計画',
                  assignee: '田中 一郎',
                  status: 'todo',
                  dueDate: '2026/06/12',
                  priority: 'medium',
                },
              ],
        }
      },
      async createProjectTask() {
        return {
          task: {
            id: 'unused',
            title: 'unused',
            assignee: 'unused',
            status: 'todo',
            dueDate: '2026/06/03',
            priority: 'medium',
          },
        }
      },
      async updateProjectTaskStatus() {
        return {
          task: {
            id: 'unused',
            title: 'unused',
            assignee: 'unused',
            status: 'done',
            dueDate: '2026/06/03',
            priority: 'medium',
          },
        }
      },
    },
  )

  const summary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
  })

  expect(summary.projects).toBe(1)
  expect(summary.tasks).toBe(1)
  expect(summary.blocked).toBe(1)
  expect(summary.source).toBe('dynamodb')
  expect(Date.parse(summary.updatedAt)).not.toBeNaN()
  expect(directoryReads).toEqual([])
  expect(accessListReads).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'demo@example.com',
    },
  ])
  expect(taskReads).toEqual([{ directoryId: 'user#demo@example.com', projectId: 'refero' }])
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
  expect(sentInputs).toEqual([
    expect.objectContaining({
      TableName: 'DirectoryTable',
      ConsistentRead: true,
    }),
  ])
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

  await expect(client.archiveTeam('user#demo@example.com', 'core-team')).resolves.toEqual({
    teamId: 'core-team',
    archivedAt: expect.any(String),
  })
  await expect(
    client.archiveProject('user#demo@example.com', 'core-team', 'refero'),
  ).resolves.toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: expect.any(String),
  })
  expect(sentInputs[1]).toMatchObject({
    TableName: 'DirectoryTable',
    Key: {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000000#TEAM#core-team',
    },
    UpdateExpression: 'SET archivedAt = :archivedAt',
    ConditionExpression:
      'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
  })
  expect(sentInputs[3]).toMatchObject({
    TableName: 'DirectoryTable',
    Key: {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000010#PROJECT#refero',
    },
    UpdateExpression: 'SET archivedAt = :archivedAt',
    ConditionExpression:
      'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
  })
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
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
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
    ],
  })
  expect(sentInputs[4]).toMatchObject({ ConsistentRead: true })
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

function createProjectMemberFixtureItems(
  options: {
    archivedProject?: boolean
    archivedTeam?: boolean
    includeOtherManager?: boolean
    includeTargetMember?: boolean
    targetRole?: ProjectRole
  } = {},
) {
  const includeOtherManager = options.includeOtherManager ?? true
  const includeTargetMember = options.includeTargetMember ?? true
  const targetRole = options.targetRole ?? 'manager'

  return [
    {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000000#TEAM#core-team',
      entryType: 'team',
      teamId: 'core-team',
      teamSortOrder: 10,
      nameJa: 'コアチーム',
      nameEn: 'Core Team',
      expanded: true,
      ...(options.archivedTeam ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
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
      ...(options.archivedProject ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
    },
    ...(includeTargetMember
      ? [
          {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'demo@example.com',
            email: 'demo@example.com',
            role: targetRole,
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        ]
      : []),
    ...(includeOtherManager
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
  ]
}

function createDirectoryMutationAuditContext() {
  return createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo-sub', kind: 'user' },
    idempotencyKey: 'directory-mutation-request',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/projects/refero/members/demo@example.com' },
    source: { kind: 'api', requestId: 'directory-mutation-request' },
  })
}

function createFakeAuditEvent() {
  const context = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo-sub', kind: 'user' },
    idempotencyKey: 'audit-export-request',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'GET', path: '/api/audit/events/export' },
    source: { kind: 'api', requestId: 'audit-export-request' },
  })

  return createAuditEvent({
    context,
    eventType: 'project.updated',
    entity: { type: 'project', id: 'refero' },
  })
}

function configureFakeProjectClients(
  hasProjectAccess: boolean,
  options: {
    /** Cognito user pagination fake が page ごとに返す user ID と token です。 */
    cognitoUserPages?: Array<{ userIds: string[]; nextToken?: string }>
    /** Cognito user 一覧 fake が返す次 page token です。 */
    cognitoUsersNextToken?: string
    profileError?: Error
    inactiveWorkspaceMemberKeys?: string[]
    /** NEW_PASSWORD_REQUIRED challenge で Cognito が返す error です。 */
    newPasswordChallengeError?: CognitoServiceError
    newPasswordChallengeTokens?: boolean
    passwordAuthChallenge?: boolean
    passwordAuthTokens?: boolean
    projectAccesses?: Array<{ projectId: string; role?: ProjectRole }>
    role?: ProjectRole
    taskAssigneeUserId?: string
    teamProjects?: Array<{ id: string; name: string; tone: 'blue' | 'purple' | 'green' | 'yellow' }>
    workspaceRole?: WorkspaceRole
    workspaceReconcileFailures?: number
    workspaceStatus?: WorkspaceMemberStatus
    /** Invitation provisioning 時に Cognito user が存在しない状態を再現します。 */
    workspaceUserMissing?: boolean
    /** AdminCreateUser と競合して temporary-password user が作成された状態を再現します。 */
    workspaceProvisionRace?: boolean
  } = {},
) {
  const role = 'role' in options ? options.role : 'manager'
  const workspaceRole = options.workspaceRole ?? 'owner'
  const workspaceStatus = options.workspaceStatus ?? 'active'
  let workspaceReconcileFailures = options.workspaceReconcileFailures ?? 0
  const calls = {
    accessChecks: [] as Array<{ directoryId: string; projectId: string }>,
    directoryReads: [] as Array<{ directoryId: string; locale: string }>,
    memberDeletes: [] as Array<{ directoryId: string; projectId: string; memberKey: string }>,
    memberReads: [] as Array<{ directoryId: string; projectId: string }>,
    memberUpdates: [] as Array<{
      directoryId: string
      memberKey: string
      projectId: string
      role: string
    }>,
    projectArchives: [] as Array<{ directoryId: string; teamId: string; projectId: string }>,
    projectCreates: [] as Array<{
      creatorUserKey: string
      directoryId: string
      name: string
      teamId: string
    }>,
    roleChecks: [] as Array<{ directoryId: string; memberKey: string; projectId: string }>,
    summaryReads: [] as Array<{
      directoryId: string
      isSystemAdmin: boolean
      userKey: string
    }>,
    teamArchives: [] as Array<{ directoryId: string; teamId: string }>,
    teamCreates: [] as Array<{ directoryId: string; name: string }>,
    issueComments: [] as Array<{ actorUserId: string; directoryId: string; issueId: string; teamId: string }>,
    issueCreates: [] as Array<{
      actorUserId: string
      assignedProjectId?: unknown
      directoryId: string
      reservedIssueIds?: string[]
      teamId: string
      title: string
    }>,
    issueDetails: [] as Array<{ directoryId: string; issueId: string; teamId: string }>,
    issueReads: [] as Array<{ directoryId: string; teamId: string }>,
    issueUpdates: [] as Array<{
      actorUserId: string
      assignedProjectId?: unknown
      directoryId: string
      issueId: string
      teamId: string
    }>,
    projectIssueReads: [] as Array<{ directoryId: string; projectId: string }>,
    taskCreates: [] as Array<{ directoryId: string; projectId: string; title: string }>,
    taskReads: [] as Array<{ directoryId: string; projectId: string }>,
    taskStatusUpdates: [] as Array<{
      directoryId: string
      projectId: string
      status: string
      taskId: string
    }>,
    userLists: [] as Array<{
      directoryId?: string
      limit?: number
      paginationToken?: string
      query?: string
    }>,
    userProfiles: [] as string[],
    workspaceInvitationResends: [] as string[],
    workspaceReconciliations: [] as string[],
  }
  const createWorkspaceMember = (memberKey: string) => ({
    id: memberKey,
    memberKey,
    email: memberKey,
    name: memberKey === 'demo@example.com' ? 'Demo User' : undefined,
    role: memberKey === 'demo@example.com' ? workspaceRole : 'member' as WorkspaceRole,
    status: memberKey === 'demo@example.com'
      ? workspaceStatus
      : options.inactiveWorkspaceMemberKeys?.includes(memberKey)
        ? 'deactivated' as WorkspaceMemberStatus
        : 'active' as WorkspaceMemberStatus,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  })

  configureApiClientsForTest({
    cognito: {
      async initiatePasswordAuth() {
        if (options.passwordAuthChallenge) {
          return {
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: 'new-password-session',
          }
        }

        if (options.passwordAuthTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }

        return {}
      },
      async respondToNewPasswordChallenge() {
        if (options.newPasswordChallengeError) {
          throw options.newPasswordChallengeError
        }

        if (options.newPasswordChallengeTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }

        return {}
      },
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            {
              Name: 'email',
              Value: 'Demo@Example.com',
            },
          ],
        }
      },
      async listUsers(input) {
        calls.userLists.push(input)
        const page = options.cognitoUserPages?.[calls.userLists.length - 1]

        if (page) {
          return {
            users: page.userIds.map(createFakeCognitoProfile),
            nextToken: page.nextToken,
          }
        }

        return {
          users: [createFakeCognitoProfile('sato@example.com')],
          nextToken: options.cognitoUsersNextToken,
        }
      },
      async getUserProfile(userId) {
        calls.userProfiles.push(userId)

        if (options.profileError) {
          throw options.profileError
        }

        return createFakeCognitoProfile(userId)
      },
      async findWorkspaceUser(userId) {
        if (options.workspaceUserMissing || options.workspaceProvisionRace) {
          return undefined
        }

        return {
          profile: {
            ...createFakeCognitoProfile(userId),
            status: 'FORCE_CHANGE_PASSWORD',
          },
          directoryId: 'user#demo@example.com',
        }
      },
      async provisionWorkspaceUser(input) {
        if (options.workspaceProvisionRace) {
          calls.workspaceInvitationResends.push(input.email)
          return {
            profile: {
              ...createFakeCognitoProfile(input.email),
              status: 'FORCE_CHANGE_PASSWORD',
            },
            identityOwnership: 'ambiguous',
            deliveryStatus: 'sent',
          }
        }

        return {
          profile: createFakeCognitoProfile(input.email),
          identityOwnership: input.existingUser ? 'pre-existing' : 'workspace-created',
          deliveryStatus: input.existingUser ? 'not-required' : 'sent',
        }
      },
      async resendWorkspaceUserInvitation(userId) {
        calls.workspaceInvitationResends.push(userId)
      },
      async deleteWorkspaceUser() {},
    },
    dashboardSummary: {
      async getSummary(directoryId, accessContext) {
        calls.summaryReads.push({
          directoryId,
          isSystemAdmin: accessContext.isSystemAdmin,
          userKey: accessContext.userKey,
        })

        return {
          projects: 1,
          tasks: 1,
          blocked: 0,
          updatedAt: '2026-06-03T00:00:00.000Z',
          source: 'dynamodb',
        }
      },
    },
    projectDirectory: {
      async getProjectDirectory(directoryId, locale) {
        calls.directoryReads.push({ directoryId, locale })

        return {
          teams: [
            {
              id: 'core-team',
              name: locale === 'en' ? 'Core Team' : 'コアチーム',
              expanded: true,
              projects: options.teamProjects ?? [
                {
                  id: 'refero',
                  name: 'Refero',
                  tone: 'blue',
                },
              ],
            },
          ],
        }
      },
      async getProjectAccess(directoryId, projectId) {
        calls.accessChecks.push({ directoryId, projectId })

        if (options.projectAccesses) {
          return options.projectAccesses.find((access) => access.projectId === projectId)
        }

        if (!hasProjectAccess) {
          return undefined
        }

        return {
          projectId,
          role,
        }
      },
      async getProjectAccessList(directoryId) {
        calls.accessChecks.push({ directoryId, projectId: '*' })

        if (options.projectAccesses) {
          return options.projectAccesses
        }

        if (!hasProjectAccess) {
          return []
        }

        return [
          {
            projectId: 'refero',
            role,
          },
        ]
      },
      async hasProjectAccess(directoryId, projectId) {
        calls.accessChecks.push({ directoryId, projectId })

        return hasProjectAccess
      },
      async getProjectRole(directoryId, projectId, memberKey) {
        calls.roleChecks.push({ directoryId, projectId, memberKey })

        if (options.projectAccesses) {
          return options.projectAccesses.find((access) => access.projectId === projectId)?.role
        }

        return role
      },
      async getProjectMembers(directoryId, projectId) {
        calls.memberReads.push({ directoryId, projectId })

        return {
          projectId,
          members: [
            {
              id: 'demo@example.com',
              email: 'demo@example.com',
              role: 'manager',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async updateProjectMember(directoryId, projectId, memberKey, input) {
        calls.memberUpdates.push({
          directoryId,
          memberKey,
          projectId,
          role: String(input.role),
        })

        return {
          member: {
            id: memberKey,
            email: String(input.email ?? memberKey),
            name: typeof input.name === 'string' ? input.name : undefined,
            role: input.role === 'member' ? 'member' : input.role === 'manager' ? 'manager' : 'viewer',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        }
      },
      async removeProjectMember(directoryId, projectId, memberKey) {
        calls.memberDeletes.push({ directoryId, projectId, memberKey })

        return {
          projectId,
          memberId: memberKey,
        }
      },
      async createTeam(directoryId, input) {
        calls.teamCreates.push({ directoryId, name: String(input.name) })

        return {
          team: {
            id: 'new-team',
            name: String(input.name),
            expanded: true,
            projects: [],
          },
        }
      },
      async createProject(directoryId, teamId, input, creator) {
        calls.projectCreates.push({
          creatorUserKey: creator.userKey,
          directoryId,
          name: String(input.name),
          teamId,
        })

        return {
          project: {
            id: 'new-project',
            name: String(input.name),
            tone: 'green',
          },
        }
      },
      async archiveTeam(directoryId, teamId) {
        calls.teamArchives.push({ directoryId, teamId })

        return {
          teamId,
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
      async archiveProject(directoryId, teamId, projectId) {
        calls.projectArchives.push({ directoryId, teamId, projectId })

        return {
          teamId,
          projectId,
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
    },
    workspaceAccess: {
      async getMember(_workspaceId, memberKey) {
        return createWorkspaceMember(memberKey)
      },
      async getActiveMember(_workspaceId, memberKey) {
        const member = createWorkspaceMember(memberKey)
        return member.status === 'active' ? member : undefined
      },
      async listActiveMembers() {
        return [
          createWorkspaceMember('demo@example.com'),
          createWorkspaceMember('sato@example.com'),
          createWorkspaceMember('suzuki@example.com'),
          createWorkspaceMember('viewer@example.com'),
        ].filter((member) => member.status === 'active')
      },
      async getAccessSnapshot(_workspaceId, memberKey) {
        const currentMember = createWorkspaceMember(memberKey)
        return {
          currentMember,
          members: [currentMember, createWorkspaceMember('sato@example.com')],
          invitations: [],
          capabilities: {
            canInvite: currentMember.role === 'owner' || currentMember.role === 'admin',
            canManageMembers: currentMember.role === 'owner' || currentMember.role === 'admin',
            canManageAdmins: currentMember.role === 'owner',
          },
        }
      },
      async getInvitation() {
        return undefined
      },
      async createInvitation(_workspaceId, _actorMemberKey, input) {
        return {
          id: input.email,
          email: input.email,
          name: input.name,
          role: input.role,
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          version: 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationDelivery(_workspaceId, invitationId, input) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: input.deliveryStatus === 'failed' ? 'delivery-failed' : 'pending',
          deliveryStatus: input.deliveryStatus,
          identityOwnership: input.identityOwnership,
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationCleanupFailure(_workspaceId, invitationId, input) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: input.failureMessage,
        }
      },
      async clearInvitationCleanupFailure(_workspaceId, invitationId, expectedVersion) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async prepareResend() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async revokeInvitation() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async prepareReinvite() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async reconcileAuthenticatedMember(_workspaceId, input) {
        calls.workspaceReconciliations.push(input.memberKey)

        if (workspaceReconcileFailures > 0) {
          workspaceReconcileFailures -= 1
          throw new WorkspaceAccessError(
            503,
            'WorkspaceAccessUnavailable',
            'Workspace membership update failed.',
          )
        }

        return createWorkspaceMember(input.memberKey)
      },
      async updateMember(_workspaceId, _actorMemberKey, memberKey, input) {
        return {
          ...createWorkspaceMember(memberKey),
          role: input.role ?? createWorkspaceMember(memberKey).role,
          status: input.status ?? createWorkspaceMember(memberKey).status,
          version: input.expectedVersion + 1,
        }
      },
    },
    projectTasks: {
      async getProjectTasks(directoryId, projectId) {
        calls.taskReads.push({ directoryId, projectId })

        return {
          projectId,
          tasks: [
            {
              id: 'wireframe',
              titleKey: 'tasks.item.wireframe',
              assigneeKey: 'tasks.assignee.sato',
              assigneeUserId: options.taskAssigneeUserId,
              status: 'in-progress',
              dueDate: '2026/06/03',
              priority: 'high',
            },
          ],
        }
      },
      async createProjectTask(directoryId, projectId, input) {
        calls.taskCreates.push({ directoryId, projectId, title: String(input.title) })

        return {
          task: {
            id: 'new-task',
            title: String(input.title),
            assigneeUserId: String(input.assigneeUserId),
            status: 'todo',
            dueDate: String(input.dueDate),
            priority: 'high',
          },
        }
      },
      async updateProjectTaskStatus(directoryId, projectId, taskId, input) {
        calls.taskStatusUpdates.push({
          directoryId,
          projectId,
          status: String(input.status),
          taskId,
        })

        return {
          task: {
            id: taskId,
            titleKey: 'tasks.item.wireframe',
            assigneeKey: 'tasks.assignee.sato',
            status: input.status === 'done' ? 'done' : 'todo',
            dueDate: '2026/06/03',
            priority: 'high',
          },
        }
      },
    },
    teamIssues: {
      async getTeamIssues(directoryId, teamId) {
        calls.issueReads.push({ directoryId, teamId })

        return {
          teamId,
          issues: [
            {
              id: 'onboarding-friction',
              teamId,
              assignedProjectId: 'refero',
              title: '初回オンボーディングの離脱要因を減らす',
              description: '初回体験の摩擦を下げる。',
              assigneeUserId: 'sato@example.com',
              status: 'in-progress',
              dueDate: '2026/06/18',
              priority: 'high',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async getProjectIssues(directoryId, projectId) {
        calls.projectIssueReads.push({ directoryId, projectId })

        return {
          projectId,
          issues: [
            {
              id: 'onboarding-friction',
              teamId: 'core-team',
              assignedProjectId: projectId,
              title: '初回オンボーディングの離脱要因を減らす',
              assigneeUserId: 'sato@example.com',
              status: 'in-progress',
              dueDate: '2026/06/18',
              priority: 'high',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async getTeamIssueDetail(directoryId, teamId, issueId) {
        calls.issueDetails.push({ directoryId, teamId, issueId })

        if (issueId === 'wireframe') {
          throw {
            status: 404,
            code: 'TeamIssueNotFound',
            message: 'Issue was not found.',
          }
        }

        return {
          issue: {
            id: issueId,
            teamId,
            assignedProjectId: 'refero',
            title: '初回オンボーディングの離脱要因を減らす',
            description: '初回体験の摩擦を下げる。',
            assigneeUserId: 'sato@example.com',
            status: 'in-progress',
            dueDate: '2026/06/18',
            priority: 'high',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
          comments: [
            {
              id: 'comment-1',
              actorUserId: 'demo@example.com',
              body: '背景を確認します。',
              createdAt: '2026-06-08T01:00:00.000Z',
            },
          ],
          activity: [
            {
              id: 'activity-1',
              type: 'created',
              actorUserId: 'demo@example.com',
              summary: 'Issue was created.',
              createdAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async createTeamIssue(directoryId, teamId, input, actorUserId, reservedIssueIds = []) {
        calls.issueCreates.push({
          actorUserId,
          assignedProjectId: input.assignedProjectId,
          directoryId,
          reservedIssueIds,
          teamId,
          title: String(input.title),
        })

        return {
          issue: {
            id: 'new-issue',
            teamId,
            assignedProjectId: typeof input.assignedProjectId === 'string'
              ? input.assignedProjectId
              : undefined,
            title: String(input.title),
            description: typeof input.description === 'string' ? input.description : undefined,
            assigneeUserId: String(input.assigneeUserId),
            status: 'todo',
            dueDate: String(input.dueDate),
            priority: 'medium',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        }
      },
      async updateTeamIssue(directoryId, teamId, issueId, input, actorUserId) {
        calls.issueUpdates.push({
          actorUserId,
          assignedProjectId: input.assignedProjectId,
          directoryId,
          issueId,
          teamId,
        })

        return {
          issue: {
            id: issueId,
            teamId,
            assignedProjectId: typeof input.assignedProjectId === 'string'
              ? input.assignedProjectId
              : undefined,
            title: typeof input.title === 'string' ? input.title : '初回オンボーディングの離脱要因を減らす',
            assigneeUserId: typeof input.assigneeUserId === 'string' ? input.assigneeUserId : 'sato@example.com',
            status: input.status === 'done' ? 'done' : 'in-progress',
            dueDate: typeof input.dueDate === 'string' ? input.dueDate : '2026/06/18',
            priority: input.priority === 'low' ? 'low' : 'high',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T02:00:00.000Z',
          },
        }
      },
      async createTeamIssueComment(directoryId, teamId, issueId, input, actorUserId) {
        calls.issueComments.push({ actorUserId, directoryId, issueId, teamId })

        return {
          comment: {
            id: 'comment-2',
            actorUserId,
            body: String(input.body),
            createdAt: '2026-06-08T02:00:00.000Z',
          },
          activity: {
            id: 'activity-2',
            type: 'commented',
            actorUserId,
            summary: 'Comment was added.',
            createdAt: '2026-06-08T02:00:00.000Z',
          },
        }
      },
    },
  })

  return calls
}

function createFakeCognitoProfile(userId: string) {
  const id = userId.trim().toLowerCase()
  const names: Record<string, string> = {
    'demo@example.com': 'Demo User',
    'sato@example.com': '佐藤 花子',
    'suzuki@example.com': '鈴木 太郎',
    'viewer@example.com': 'Viewer User',
  }

  return {
    id,
    username: id,
    email: id,
    name: names[id],
    enabled: true,
    status: 'CONFIRMED',
  }
}

function createFakeAuthTokenSet() {
  return {
    AccessToken: 'test-token',
    IdToken: 'test-id-token',
    RefreshToken: 'test-refresh-token',
    ExpiresIn: 3600,
    TokenType: 'Bearer',
  }
}

function createAccessToken(groups: string[] = []) {
  const payload = Buffer
    .from(JSON.stringify({ 'cognito:groups': groups }))
    .toString('base64url')

  return `header.${payload}.signature`
}
