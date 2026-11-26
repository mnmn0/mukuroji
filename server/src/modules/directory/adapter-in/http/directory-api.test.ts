import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createCyclePlanningInput,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  DynamoDbProjectDirectoryClient,
} from '../../adapter-out/dynamodb/project-directory-client'
import {
  InMemoryPlanningClient,
  type PlanningWorkItemState,
} from '../../../planning/planning'
import type {
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import type {
  WorkspaceSearchClient,
  WorkspaceSearchDocument,
  WorkspaceSearchProjectionWriteOptions,
} from '../../../workspace-search/workspace-search'
import {
  createWorkspaceSearchDocument,
} from '../../../workspace-search/workspace-search'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/**
 * Creates a Planning graph with one dependency between canonical fixture Work Items.
 *
 * @returns Planning client whose global revision is one.
 */
async function createDirectoryDependencyPlanning() {
  const planningClient = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState: PlanningWorkItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 7,
        teamId: 'core-team',
        title: 'Predecessor',
        projectId: 'refero',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 9,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  await planningClient.createWorkItemDependency('user#demo@example.com', {
    id: 'directory-archive-dependency',
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, workItemState)
  return planningClient
}

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
  // The legacy ACL is read as a list so a Project ID that several Teams share fails closed.
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
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
        // Without Cognito the name still comes from the Workspace member row.
        name: 'Demo User',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
    ],
  })
  expect(calls.userProfiles).toEqual(['demo@example.com'])
})

test('reports a Project member whose access expired as deactivated, so pickers do not offer them (ADR 0095)', async () => {
  configureFakeProjectClients(true, { role: 'manager' })
  const { workspaceAccess, projectDirectory } = getTestAppDependencies().workspace
  setTestAppDependencies({
    workspaceAccess: {
      ...workspaceAccess,
      async getMember(workspaceId, memberKey) {
        const member = await workspaceAccess.getMember(workspaceId, memberKey)
        // The row stays active until handover or the scheduled job writes the deactivation.
        return member && memberKey === 'sato@example.com'
          ? { ...member, accessExpiresAt: '2020-01-01T00:00:00.000Z' }
          : member
      },
    },
    projectDirectory: {
      ...projectDirectory,
      async getProjectMembers(directoryId, projectId, teamId) {
        const response = await projectDirectory.getProjectMembers(directoryId, projectId, teamId)
        return {
          ...response,
          members: [
            ...response.members,
            { id: 'sato@example.com', email: 'sato@example.com', role: 'member', updatedAt: '2026-06-08T00:00:00.000Z' },
          ],
        }
      },
    },
  })

  const response = await app.request('/api/projects/refero/members', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({
    members: [
      { id: 'demo@example.com', workspaceStatus: 'active' },
      { id: 'sato@example.com', workspaceStatus: 'deactivated' },
    ],
  })
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
      lifecycleState: 'active',
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

  setTestAppDependencies({
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

  setTestAppDependencies({
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

  setTestAppDependencies({
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

  setTestAppDependencies({
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
    { directoryId: 'user#demo@example.com', expectedPlanningRevision: 0, teamId: 'core-team' },
  ])
})

/**
 * Installs a search store fake that applies the same revision fences as the DynamoDB store.
 *
 * @param hooks - Run before the first upsert or delete is applied, to model a request that
 *   commits while that write is in flight.
 * @returns The stored source revision of each document (`null` when it has none).
 */
function installRevisionedSearch(hooks: {
  beforeFirstUpsert?: () => Promise<void>
  beforeFirstDelete?: () => Promise<void>
} = {}) {
  const documents = new Map<string, number | null>()
  let upserts = 0
  let deletes = 0
  setTestAppDependencies({
    workspaceSearch: {
      async upsertDocument(
        document: Parameters<WorkspaceSearchClient['upsertDocument']>[0],
        options?: WorkspaceSearchProjectionWriteOptions,
      ) {
        upserts += 1
        if (upserts === 1) await hooks.beforeFirstUpsert?.()
        const stored = documents.get(document.entityId)
        const revision = options?.sourceRevision
        const stale = revision === undefined
          ? options?.unrevisioned === true && typeof stored === 'number'
          : typeof stored === 'number' && stored > revision
        if (!stale) documents.set(document.entityId, revision ?? null)
        return createWorkspaceSearchDocument(document)
      },
      async deleteDocument(
        _workspaceId: string,
        _entityType: WorkspaceSearchDocument['entityType'],
        entityId: string,
        options?: WorkspaceSearchProjectionWriteOptions,
      ) {
        deletes += 1
        if (deletes === 1) await hooks.beforeFirstDelete?.()
        const stored = documents.get(entityId)
        const fence = options?.sourceRevision
        if (fence !== undefined && typeof stored === 'number' && stored > fence) return false
        return documents.delete(entityId)
      },
    } as unknown as WorkspaceSearchClient,
  })
  return documents
}

/**
 * Sends one administrator PATCH request.
 *
 * @param path - Route to call.
 * @returns The response status.
 */
async function patchAsAdministrator(path: string) {
  const response = await app.request(path, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}` },
  })
  return response.status
}

test('does not let a delayed Team creation projection undo a renamed search document', async () => {
  configureFakeProjectClients(true)
  const documents = installRevisionedSearch()
  // A rename committed and projected revision 1 before the creation's projection landed.
  documents.set('team/new-team', 1)

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規チーム' }),
  })

  expect(response.status).toBe(201)
  expect(documents.get('team/new-team')).toBe(1)
})

test('removes an archived Team from search', async () => {
  configureFakeProjectClients(true)
  const documents = installRevisionedSearch()
  documents.set('team/core-team', null)

  expect(await patchAsAdministrator('/api/teams/core-team/archive')).toBe(200)
  expect(documents.has('team/core-team')).toBe(false)
})

test('keeps a Team restored while its archive was removing the search document', async () => {
  configureFakeProjectClients(true)
  const documents = installRevisionedSearch({
    beforeFirstDelete: async () => {
      expect(await patchAsAdministrator('/api/teams/core-team/restore')).toBe(200)
    },
  })
  documents.set('team/core-team', null)

  expect(await patchAsAdministrator('/api/teams/core-team/archive')).toBe(200)
  // The restore projected revision 2; the archive's delete was fenced at revision 1.
  expect(documents.get('team/core-team')).toBe(2)
})

test('removes a Team document that a rename projected after the archive removed it', async () => {
  configureFakeProjectClients(true)
  const documents = installRevisionedSearch({
    // The rename read the active Team; the archive commits before the rename's write lands.
    beforeFirstUpsert: async () => {
      expect(await patchAsAdministrator('/api/teams/core-team/archive')).toBe(200)
    },
  })
  documents.set('team/core-team', null)

  const response = await app.request('/api/teams/core-team', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ nameJa: 'リネーム', nameEn: 'Renamed' }),
  })

  expect(response.status).toBe(200)
  expect(documents.has('team/core-team')).toBe(false)
})

test('keeps a Project restored while its archive was removing the search document', async () => {
  configureFakeProjectClients(true)
  const documents = installRevisionedSearch({
    beforeFirstDelete: async () => {
      expect(await patchAsAdministrator('/api/teams/core-team/projects/refero/restore')).toBe(200)
    },
  })
  documents.set('team/core-team/project/refero', null)

  expect(await patchAsAdministrator('/api/teams/core-team/projects/refero/archive')).toBe(200)
  expect(documents.get('team/core-team/project/refero')).toBe(2)
})

test('rejects archiving a Team referenced by an active Planning entity', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    createCyclePlanningInput('cycle-team-scope', 0),
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'PlanningTeamScopeInUse',
    message:
      'Move or archive active Planning entities and remove Work Item links and dependencies before archiving this Team.',
  })
  expect(calls.teamArchives).toEqual([])
})

test('rejects archiving a Team with an incident Work Item dependency', async () => {
  const planningClient = await createDirectoryDependencyPlanning()
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'PlanningTeamScopeInUse',
    message:
      'Move or archive active Planning entities and remove Work Item links and dependencies before archiving this Team.',
  })
  expect(calls.teamArchives).toEqual([])
  expect(calls.issueDetails).toEqual([])
})

test('denies project-assigned Work Item creation when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規タスク',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      priority: 'high',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
  ])
  expect(calls.issueCreates).toEqual([])
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
  // The legacy ACL is read as a list so a Project ID that several Teams share fails closed.
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
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

test('lets a manager only lower the Project role of a member whose access expired (ADR 0095)', async () => {
  configureFakeProjectClients(true, { role: 'manager', inactiveWorkspaceMemberKeys: ['ito@example.com'] })
  const { workspaceAccess, projectDirectory } = getTestAppDependencies().workspace
  const options: unknown[] = []
  setTestAppDependencies({
    workspaceAccess: {
      ...workspaceAccess,
      async getActiveMember(workspaceId, memberKey) {
        return memberKey === 'sato@example.com' ? undefined : workspaceAccess.getActiveMember(workspaceId, memberKey)
      },
      async getMember(workspaceId, memberKey) {
        const member = await workspaceAccess.getMember(workspaceId, memberKey)
        return member && memberKey === 'sato@example.com'
          ? { ...member, accessExpiresAt: '2020-01-01T00:00:00.000Z' }
          : member
      },
    },
    projectDirectory: {
      ...projectDirectory,
      async updateProjectMember(directoryId, projectId, memberKey, input, version, auditContext, memberOptions) {
        options.push(memberOptions)
        return projectDirectory.updateProjectMember(directoryId, projectId, memberKey, input, version, auditContext, memberOptions)
      },
    },
  })
  const patch = (memberKey: string) => app.request(`/api/projects/refero/members/${encodeURIComponent(memberKey)}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: memberKey, role: 'viewer' }),
  })

  expect((await patch('sato@example.com')).status).toBe(200)
  expect(options).toEqual([{ demotionOnly: true }])
  // A deactivated member still cannot be given a Project role.
  const deactivated = await patch('ito@example.com')
  expect(deactivated.status).toBe(409)
  expect(await deactivated.json()).toMatchObject({ code: 'WorkspaceMemberInactive' })
  expect(options).toHaveLength(1)
})

test('lets a system admin update project members without a project role', async () => {
  const calls = configureFakeProjectClients(false, {
    role: undefined,
    systemAdminMemberKeys: ['demo@example.com'],
  })

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
    {
      directoryId: 'user#demo@example.com',
      expectedPlanningRevision: 0,
      teamId: 'core-team',
      projectId: 'refero',
    },
  ])
})

test('does not block archive for a same-named Project scoped to another Team', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    {
      ...createCyclePlanningInput('cycle-other-team-project', 0),
      teamId: 'other-team',
      projectId: 'refero',
    },
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const projectResponse = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })
  const teamResponse = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(projectResponse.status).toBe(200)
  expect(teamResponse.status).toBe(200)
  expect(calls.projectArchives).toEqual([
    {
      directoryId: 'user#demo@example.com',
      expectedPlanningRevision: 1,
      teamId: 'core-team',
      projectId: 'refero',
    },
  ])
  expect(calls.teamArchives).toEqual([
    { directoryId: 'user#demo@example.com', expectedPlanningRevision: 1, teamId: 'core-team' },
  ])
})

test('rejects archiving a Project referenced by an active Planning entity', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    createCyclePlanningInput('cycle-project-scope', 0),
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'PlanningProjectScopeInUse',
    message:
      'Move or archive active Planning entities and remove Work Item links before archiving this Project.',
  })
  expect(calls.projectArchives).toEqual([])
})

test('rejects archiving a Project assigned to a dependency endpoint', async () => {
  const planningClient = await createDirectoryDependencyPlanning()
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'PlanningProjectScopeInUse',
    message:
      'Move dependency Work Items to another Project or remove their dependencies before archiving this Project.',
  })
  expect(calls.projectArchives).toEqual([])
  expect(calls.issueDetails).toHaveLength(2)
  expect(calls.issueDetails.every((call) =>
    call.readOptions?.consistentIssueRead === true && call.readOptions.includeEvents === false
  )).toBe(true)
})

test('fences dependency endpoint revisions while archiving an otherwise unused Project', async () => {
  const planningClient = await createDirectoryDependencyPlanning()
  const calls = configureFakeProjectClients(true, {
    detailAssignedProjectIds: {
      'onboarding-friction': 'archive-safe',
      'work-item-1': 'archive-safe',
    },
    detailRevisions: {
      ['core-team\0onboarding-friction']: 7,
      ['core-team\0work-item-1']: 9,
    },
  })
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(calls.projectArchives).toEqual([{
    directoryId: 'user#demo@example.com',
    expectedPlanningRevision: 1,
    teamId: 'core-team',
    projectId: 'refero',
    workItemRevisionGuards: [
      { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 7 },
      { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 9 },
    ],
  }])
})

test('rejects Project archive dependency fan-out above the atomic guard limit', async () => {
  const planningClient = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState: PlanningWorkItemState = {
    workItems: Array.from({ length: 97 }, (_, index) => ({
      id: `work-item-${index}`,
      revision: 1,
      teamId: 'core-team',
      title: `Work Item ${index}`,
      projectId: 'archive-safe',
      statusCategory: 'started',
      dueDate: '2026-06-18',
      schedule,
    })),
  }
  for (let index = 0; index < 96; index += 1) {
    await planningClient.createWorkItemDependency('user#demo@example.com', {
      id: `directory-archive-dependency-${index}`,
      predecessor: { teamId: 'core-team', workItemId: `work-item-${index}` },
      successor: { teamId: 'core-team', workItemId: `work-item-${index + 1}` },
      type: 'finish-to-finish',
      lagDays: 0,
      expectedRevision: index,
    }, workItemState)
  }
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({
    code: 'PlanningProjectScopeDependencyLimitExceeded',
    message: 'The Project has too many dependency endpoints to archive atomically.',
  })
  expect(calls.issueDetails).toEqual([])
  expect(calls.projectArchives).toEqual([])
})

test('rejects archiving scopes referenced only by a stored Planning Work Item link', async () => {
  // A link to an active Goal without Team or Project scope is the only reference to the scopes.
  const planningClient = new InMemoryPlanningClient()
  const workItemState = {
    workItems: [{
      id: 'linked-work-item',
      revision: 1,
      teamId: 'core-team',
      title: 'Linked Work Item',
      projectId: 'refero',
      statusCategory: 'completed' as const,
      dueDate: '2026-08-31',
      schedule: createDefaultDueDateWorkItemSchedule('2026-08-31'),
    }],
  }
  const hierarchy = [
    ['portfolio-link-scope', 'portfolio', undefined],
    ['roadmap-link-scope', 'roadmap', 'portfolio-link-scope'],
    ['initiative-link-scope', 'initiative', 'roadmap-link-scope'],
    ['goal-link-scope', 'goal', 'initiative-link-scope'],
  ] as const
  for (const [index, [id, type, parentId]] of hierarchy.entries()) {
    await planningClient.create('user#demo@example.com', {
      ...createCyclePlanningInput(id, index),
      type,
      ...(parentId === undefined ? {} : { parentId }),
      teamId: undefined,
      projectId: undefined,
      cadence: undefined,
      capacity: undefined,
      carryOverPolicy: undefined,
    }, workItemState)
  }
  await planningClient.putWorkItemLink('user#demo@example.com', {
    teamId: 'core-team',
    workItemId: 'linked-work-item',
    projectId: 'refero',
    goalIds: ['goal-link-scope'],
    expectedRevision: hierarchy.length,
  }, workItemState)
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const teamResponse = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })
  const projectResponse = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(teamResponse.status).toBe(409)
  expect(projectResponse.status).toBe(409)
  expect(calls.teamArchives).toEqual([])
  expect(calls.projectArchives).toEqual([])
})
