import {
  createApiTestHarness,
  type AppDependencyOverrides,
} from '../../../../api/test-support/api-test-harness'
import type {
  ProjectRole,
} from '../../../directory'
const {
  app,
  configureFakeProjectClients,
  createCollaborationStub,
  createDocumentFake,
  createFakeWorkItemConfigurationClient,
  createWorkspaceAccessFake,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  createApp,
  overrideAppDependencies,
} = createApiTestHarness()
import type {
  DocumentClient,
} from '../../../documents/documents'
import {
  DocumentError,
} from '../../../documents/documents'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import type {
  PlanningClient,
} from '../../../planning/planning'
import type {
  CreateTaskViewRequest,
  DeleteTaskViewRequest,
  DuplicateTaskViewRequest,
  GetTaskViewRequest,
  ListTaskViewsInput,
  ResolveTaskViewRelationIdsInput,
  TaskViewClient,
  UpdateTaskViewRequest,
  WorkspaceSearchClient,
  WorkspaceSearchQueryInput,
  WorkspaceSearchResolvedScope,
} from '../../workspace-search'
import {
  createWorkspaceSearchDocument,
  WorkspaceSearchError,
} from '../../workspace-search'
import type {
  DocumentDetail,
  EnterprisePermissionId,
  SavedTaskView,
  SavedTaskViewCapabilities,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import type {
  Hono,
} from 'hono'

afterEach(() => {
  resetTestApp()
})

/** Capability response used by task-view port fakes that do not exercise authorization math. */
const noTaskViewCapabilities: SavedTaskViewCapabilities = {
  canWrite: false,
  canManageSharedViews: false,
  canSetTeamDefault: false,
  writableTeamIds: [],
}

/**
 * Fails a Workspace Search fake when a test omitted a required operation.
 *
 * @returns Never returns because the operation is unexpected.
 */
function failUnexpectedWorkspaceSearchOperation(): never {
  throw new Error('Unexpected Workspace Search operation.')
}

/**
 * Creates a fail-closed Workspace Search fake with typed method overrides.
 *
 * @param overrides - Methods exercised by the current test.
 * @returns A complete Workspace Search port.
 */
function createWorkspaceSearchFake(
  overrides: Partial<WorkspaceSearchClient>,
): WorkspaceSearchClient {
  return {
    upsertDocument: async () => failUnexpectedWorkspaceSearchOperation(),
    deleteDocument: async () => failUnexpectedWorkspaceSearchOperation(),
    search: async () => failUnexpectedWorkspaceSearchOperation(),
    listSavedViews: async () => failUnexpectedWorkspaceSearchOperation(),
    createSavedView: async () => failUnexpectedWorkspaceSearchOperation(),
    updateSavedView: async () => failUnexpectedWorkspaceSearchOperation(),
    deleteSavedView: async () => failUnexpectedWorkspaceSearchOperation(),
    ...overrides,
  }
}

/** Task-view operation overrides with optional legacy-search fallback behavior. */
type TaskViewWorkspaceSearchOverrides = Partial<TaskViewClient> &
  Pick<Partial<WorkspaceSearchClient>, 'search'>

/**
 * Creates a fail-closed Workspace Search fake with every optional task-view method present.
 *
 * @param overrides - Task-view methods exercised by the current test.
 * @returns A Workspace Search port whose unconfigured task-view operations fail.
 */
function createTaskViewWorkspaceSearchFake(
  overrides: TaskViewWorkspaceSearchOverrides,
): WorkspaceSearchClient {
  return createWorkspaceSearchFake({
    listTaskViews: async () => failUnexpectedWorkspaceSearchOperation(),
    getTaskView: async () => failUnexpectedWorkspaceSearchOperation(),
    createTaskView: async () => failUnexpectedWorkspaceSearchOperation(),
    updateTaskView: async () => failUnexpectedWorkspaceSearchOperation(),
    duplicateTaskView: async () => failUnexpectedWorkspaceSearchOperation(),
    deleteTaskView: async () => failUnexpectedWorkspaceSearchOperation(),
    ...overrides,
  })
}

/**
 * Creates a direct Project-scoped Enterprise role for the current test member.
 *
 * @param roleSuffix - Stable custom role and assignment suffix.
 * @param permissions - Effective permissions granted only on the Refero Project.
 * @returns Enterprise Identity fake with one authoritative direct member assignment.
 */
async function createProjectScopedTaskViewIdentity(
  roleSuffix: string,
  permissions: EnterprisePermissionId[],
) {
  const workspaceId = 'user#demo@example.com'
  const roleId = `custom:${roleSuffix}` as const
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = '2026-08-09T00:00:00.000Z'
  await identity.putCustomRole({
    workspaceId,
    roleId,
    name: `Task View ${roleSuffix}`,
    permissions,
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  return new Proxy(identity, {
    get(target, property) {
      if (property === 'getSnapshot') {
        return async (requestedWorkspaceId: string) => ({
          ...await target.getSnapshot(requestedWorkspaceId),
          roleAssignments: [{
            workspaceId,
            assignmentId: `${roleSuffix}-assignment`,
            principalKind: 'member' as const,
            principalId: 'demo@example.com',
            roleId,
            scope: {
              workspaceId,
              kind: 'project' as const,
              targetId: 'refero',
            },
            source: 'direct' as const,
          }],
        })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Creates an Enterprise identity that can write one Project and only read another.
 *
 * @returns Enterprise Identity fake with two authoritative Project assignments.
 */
async function createMixedProjectTaskViewIdentity() {
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = '2026-08-09T00:00:00.000Z'
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:task-view-project-writer',
    name: 'Task View Project writer',
    permissions: ['work-items.read', 'work-items.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:task-view-project-reader',
    name: 'Task View Project reader',
    permissions: ['work-items.read'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  return new Proxy(identity, {
    get(target, property) {
      if (property === 'getSnapshot') {
        return async (requestedWorkspaceId: string) => ({
          ...await target.getSnapshot(requestedWorkspaceId),
          roleAssignments: [
            {
              workspaceId,
              assignmentId: 'task-view-project-writer-assignment',
              principalKind: 'member' as const,
              principalId: 'demo@example.com',
              roleId: 'custom:task-view-project-writer' as const,
              scope: {
                workspaceId,
                kind: 'project' as const,
                targetId: 'refero',
              },
              source: 'direct' as const,
            },
            {
              workspaceId,
              assignmentId: 'task-view-project-reader-assignment',
              principalKind: 'member' as const,
              principalId: 'demo@example.com',
              roleId: 'custom:task-view-project-reader' as const,
              scope: {
                workspaceId,
                kind: 'project' as const,
                targetId: 'restricted-project',
              },
              source: 'direct' as const,
            },
          ],
        })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('search endpoint parses filters and revalidates comment scope against current RBAC', async () => {
  configureFakeProjectClients(true)
  let capturedInput: WorkspaceSearchQueryInput | undefined
  let resolvedProjectId: string | undefined
  setTestAppDependencies({
    workspaceSearch: createWorkspaceSearchFake({
      async search(input) {
        capturedInput = input
        const document = createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'comment',
          entityId: 'team/core-team/issue/issue-1/comment/comment-1',
          parentId: 'team/core-team/issue/issue-1',
          title: 'Current scope comment',
          body: 'Search body',
          url: '/teams/core-team/issues?issueId=issue-1&commentId=comment-1',
          teamId: 'core-team',
        })
        resolvedProjectId = (await input.resolveCurrentScope?.(document))?.projectId
        return { schemaVersion: 1, results: [] }
      },
    }),
  })
  const filters = {
    keyword: 'scope',
    projectIds: ['refero'],
    customFields: [{ fieldId: 'score', operator: 'greater-than', value: 5 }],
  } satisfies WorkspaceSearchQueryInput['filters']

  const response = await app.request(
    `/api/search?filters=${encodeURIComponent(JSON.stringify(filters))}&limit=25`,
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(capturedInput?.filters).toEqual(filters)
  expect(capturedInput?.limit).toBe(25)
  expect(capturedInput?.access.projectIds.has('refero')).toBe(true)
  expect(capturedInput?.access.teamIds.has('core-team')).toBe(true)
  expect(resolvedProjectId).toBe('refero')
})

test('Work Item collection endpoints strictly propagate includeArchived and preserve its false default', async () => {
  configureFakeProjectClients(true)
  const baseTeamIssues = getTestAppDependencies().workItems.teamIssues
  const includeArchivedReads: boolean[] = []
  setTestAppDependencies({
    teamIssues: {
      ...baseTeamIssues,
      async getTeamIssues(directoryId, teamId, options) {
        includeArchivedReads.push(options?.includeArchived ?? false)
        const response = await baseTeamIssues.getTeamIssues(directoryId, teamId, options)
        const source = response.issues[0]
        return {
          ...response,
          issues: options?.includeArchived && source
            ? [
                ...response.issues,
                {
                  ...source,
                  id: `archived-${teamId}`,
                  archivedAt: '2026-08-08T00:00:00.000Z',
                  archivedBy: 'demo@example.com',
                },
              ]
            : response.issues,
        }
      },
      async getProjectIssues(directoryId, projectId, options) {
        includeArchivedReads.push(options?.includeArchived ?? false)
        const response = await baseTeamIssues.getProjectIssues(directoryId, projectId, options)
        const source = response.issues[0]
        return {
          ...response,
          issues: options?.includeArchived && source
            ? [
                ...response.issues,
                {
                  ...source,
                  id: `archived-${projectId}`,
                  archivedAt: '2026-08-08T00:00:00.000Z',
                  archivedBy: 'demo@example.com',
                },
              ]
            : response.issues,
        }
      },
    },
  })
  const headers = { Authorization: 'Bearer test-token' }

  const defaultResponse = await app.request('/api/work-items', { headers })
  const workspaceResponse = await app.request(
    '/api/work-items?includeArchived=true',
    { headers },
  )
  const teamResponse = await app.request(
    '/api/teams/core-team/issues?includeArchived=true',
    { headers },
  )
  const projectResponse = await app.request(
    '/api/projects/refero/issues?includeArchived=true',
    { headers },
  )
  const invalidResponse = await app.request(
    '/api/work-items?includeArchived=1',
    { headers },
  )

  expect([
    defaultResponse.status,
    workspaceResponse.status,
    teamResponse.status,
    projectResponse.status,
    invalidResponse.status,
  ]).toEqual([200, 200, 200, 200, 400])
  expect(JSON.stringify(await defaultResponse.json())).not.toContain('archived-core-team')
  expect(JSON.stringify(await workspaceResponse.json())).toContain('archived-core-team')
  expect(JSON.stringify(await teamResponse.json())).toContain('archived-core-team')
  expect(JSON.stringify(await projectResponse.json())).toContain('archived-refero')
  expect(await invalidResponse.json()).toMatchObject({ code: 'InvalidWorkItemQuery' })
  expect(includeArchivedReads).toEqual([false, true, true, true])
})

test('resolves later Document search hits with compact access reads beyond thirty candidates', async () => {
  configureFakeProjectClients(true)
  let compactAccessReads = 0
  let fullDocumentReads = 0
  let laterHitResolved = false
  const readContexts = new Set<unknown>()
  const fullBody =
    `${'x'.repeat(20_001)}tail-keyword`
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async get() {
        fullDocumentReads += 1
        throw new Error(
          'Workspace search must not read full Documents.',
        )
      },
      async resolveSearchAccess(input) {
        compactAccessReads += 1
        readContexts.add(input.readContext)
        return input.documentId === 'document-39'
          ? {
              scope: { type: 'workspace' },
              revision: 1,
              updatedAt:
                '2026-07-18T00:00:00.000Z',
              body: fullBody,
            }
          : undefined
      },
    },
    workspaceSearch: createWorkspaceSearchFake({
      async search(input) {
        const resolutions =
          await Promise.all(
            Array.from(
              { length: 40 },
              (_, index) =>
                input.resolveCurrentScope?.(
                  createWorkspaceSearchDocument({
                    workspaceId:
                      input.workspaceId,
                    entityType: 'document',
                    entityId:
                      `document-${index}`,
                    title:
                      `Document ${index}`,
                    url:
                      `/documents/document-${index}`,
                    updatedAt:
                      '2026-07-18T00:00:00.000Z',
                    sourceRevision: 1,
                  }),
                ),
            ),
          )
        laterHitResolved =
          resolutions.at(-1)?.permissionVerified ===
            true &&
          resolutions.at(-1)?.currentDocument
            ?.body === fullBody
        return { schemaVersion: 1, results: [] }
      },
    }),
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(compactAccessReads).toBe(40)
  expect(fullDocumentReads).toBe(0)
  expect(readContexts.size).toBe(1)
  expect([...readContexts][0]).toBeDefined()
  expect(laterHitResolved).toBeTrue()
})

test('skips Document access reads when Workspace search filters exclude Documents', async () => {
  configureFakeProjectClients(true)
  let compactAccessReads = 0
  let fullDocumentReads = 0
  let excludedDocuments = 0
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async get() {
        fullDocumentReads += 1
        throw new Error('Comment-only search must not read a Document source.')
      },
      async resolveSearchAccess() {
        compactAccessReads += 1
        throw new Error(
          'Comment-only search must not read Document access.',
        )
      },
    },
    workspaceSearch: createWorkspaceSearchFake({
      async search(input) {
        const resolutions = await Promise.all(Array.from({ length: 31 }, (_, index) =>
          input.resolveCurrentScope?.(createWorkspaceSearchDocument({
            workspaceId: input.workspaceId,
            entityType: 'document',
            entityId: `excluded-document-${index}`,
            title: `Excluded Document ${index}`,
            url: `/documents/excluded-document-${index}`,
          }))
        ))
        excludedDocuments = resolutions.filter((resolution) => resolution === undefined).length
        return { schemaVersion: 1, results: [] }
      },
    }),
  })
  const filters = encodeURIComponent(JSON.stringify({ entityTypes: ['comment'] }))

  const response = await app.request(`/api/search?filters=${filters}`, {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(compactAccessReads).toBe(0)
  expect(fullDocumentReads).toBe(0)
  expect(excludedDocuments).toBe(31)
})

test('binds cached Document roles to member and Planning authorization generations', async () => {
  configureFakeProjectClients(true)
  let workspaceMemberVersion = 1
  let planningRevision = 0
  let projectRole: ProjectRole | undefined = 'manager'
  let projectRoleReads = 0
  let advancePlanningDuringRoleRead = false
  const accesses: Array<
    Parameters<DocumentClient['get']>[0]['access']
  > = []
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async get(input) {
        accesses.push(input.access)
        throw new DocumentError(
          404,
          'DocumentNotFound',
          'Document was not found.',
        )
      },
    },
    planning: {
      async getAuthorizationRevision() {
        return planningRevision
      },
    } as unknown as PlanningClient,
    projectDirectory: {
      async getProjectAccessList() {
        projectRoleReads += 1
        const roleAtRead = projectRole
        if (advancePlanningDuringRoleRead) {
          advancePlanningDuringRoleRead = false
          planningRevision += 1
          projectRole = undefined
        }
        return roleAtRead === undefined
          ? []
          : [{ projectId: 'refero', role: roleAtRead }]
      },
    } as unknown as Parameters<
      typeof setTestAppDependencies
    >[0]['projectDirectory'],
    workspaceAccess: {
      ...createWorkspaceAccessFake(),
      async getActiveMember(_workspaceId, memberKey) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'member',
          status: 'active',
          version: workspaceMemberVersion,
          createdAt: '2026-07-18T00:00:00.000Z',
          updatedAt: '2026-07-18T00:00:00.000Z',
        }
      },
    },
  })
  const readDocument = () => app.request(
    '/api/documents/document-1',
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect((await readDocument()).status).toBe(404)
  expect((await readDocument()).status).toBe(404)
  workspaceMemberVersion = 2
  projectRole = 'viewer'
  expect((await readDocument()).status).toBe(404)
  planningRevision = 1
  projectRole = undefined
  expect((await readDocument()).status).toBe(404)
  planningRevision = 2
  projectRole = 'manager'
  advancePlanningDuringRoleRead = true
  expect((await readDocument()).status).toBe(404)

  expect(projectRoleReads).toBe(5)
  expect(accesses.map(({ projectRoles }) => projectRoles)).toEqual([
    { refero: 'manager' },
    { refero: 'manager' },
    { refero: 'viewer' },
    {},
    {},
  ])
  expect(accesses[0]?.authorizationSnapshots).toEqual([
    {
      workspaceId: 'user#demo@example.com',
      workspaceMemberKey: 'demo@example.com',
      workspaceMemberVersion: 1,
      planningRevision: 0,
    },
  ])
  expect(accesses[4]?.authorizationSnapshots).toEqual([{
    workspaceId: 'user#demo@example.com',
    workspaceMemberKey: 'demo@example.com',
    workspaceMemberVersion: 2,
    planningRevision: 3,
  }])
})

test('isolates cached Document roles between app dependency sets', async () => {
  configureFakeProjectClients(true)
  const baseDependencies = getTestAppDependencies()
  const firstAccesses: Array<
    Parameters<DocumentClient['get']>[0]['access']
  > = []
  const secondAccesses: Array<
    Parameters<DocumentClient['get']>[0]['access']
  > = []
  const createDocumentApp = (
    role: ProjectRole,
    accesses: Array<Parameters<DocumentClient['get']>[0]['access']>,
  ) =>
    createApp(overrideAppDependencies(baseDependencies, {
      documents: {
        ...baseDependencies.workItems.documents,
        async get(input) {
          accesses.push(input.access)
          throw new DocumentError(
            404,
            'DocumentNotFound',
            'Document was not found.',
          )
        },
      },
      projectDirectory: {
        async getProjectAccessList() {
          return [{ projectId: 'refero', role }]
        },
      } as unknown as NonNullable<AppDependencyOverrides['projectDirectory']>,
    }))
  const firstApp = createDocumentApp('manager', firstAccesses)
  const secondApp = createDocumentApp('viewer', secondAccesses)
  const requestDocument = (target: Hono) =>
    target.request('/api/documents/document-1', {
      headers: { Authorization: 'Bearer test-token' },
    })

  expect((await requestDocument(firstApp)).status).toBe(404)
  expect((await requestDocument(secondApp)).status).toBe(404)
  expect(firstAccesses[0]?.projectRoles).toEqual({ refero: 'manager' })
  expect(secondAccesses[0]?.projectRoles).toEqual({ refero: 'viewer' })
})

test('rejects missing, non-Goal, archived, and invisible Planning Goal relation targets', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
  })
  let applyCalls = 0
  let receivedGoalAuthorizationGuards:
    Parameters<
      DocumentClient['applyOperations']
    >[0]['relationTargetAuthorizationSnapshots']
  const editableDocument = {
    schemaVersion: 1,
    id: 'document-1',
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Goal relation test',
    position: 'a0',
    revision: 1,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: {
      canView: true,
      canEdit: true,
      canComment: true,
      canShare: true,
      canManagePermissions: true,
      canArchive: true,
      canRestore: false,
      canExport: true,
    },
    createdByUserId: 'demo@example.com',
    updatedByUserId: 'demo@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    blocks: [],
  } satisfies DocumentDetail
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async prepareOperations(input) {
        return { pendingInput: input.input }
      },
      async get() {
        return editableDocument
      },
      async applyOperations(input) {
        applyCalls += 1
        receivedGoalAuthorizationGuards =
          input.relationTargetAuthorizationSnapshots
        return {
          documentId: input.documentId,
          revision: 2,
          appliedOperationIds: input.input.operations.map(
            ({ operationId }) => operationId,
          ),
          updatedAt: '2026-07-18T00:01:00.000Z',
        }
      },
    },
    planning: {
      async getAuthorizationRevision() {
        return 2
      },
      async getAuthorizationState() {
        return {
          revision: 2,
          entities: [
            {
              id: 'goal-archived',
              type: 'goal',
              ownerMemberKey: 'demo@example.com',
              archivedAt: '2026-07-18T00:00:00.000Z',
            },
            {
              id: 'goal-private',
              type: 'goal',
              ownerMemberKey: 'demo@example.com',
              teamId: 'core-team',
              projectId: 'private-project',
            },
            {
              id: 'goal-active',
              type: 'goal',
              ownerMemberKey: 'demo@example.com',
              teamId: 'core-team',
              projectId: 'refero',
            },
            {
              id: 'cycle-not-goal',
              type: 'cycle',
              ownerMemberKey: 'demo@example.com',
              teamId: 'core-team',
              projectId: 'refero',
            },
          ],
          workItemLinks: [],
          workItemDependencies: [],
        }
      },
    } as unknown as PlanningClient,
  })

  const requestGoalOperation = (goalId: string) => app.request(
    '/api/documents/document-1/operations',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        baseRevision: 1,
        clientId: 'editor-1',
        operations: [{
          operationId: `operation-${goalId}`,
          type: 'upsert-relation',
          relation: {
            id: `relation-${goalId}`,
            source: { kind: 'document' },
            target: { kind: 'goal', goalId },
            createdByUserId: 'demo@example.com',
            createdAt: '2026-07-18T00:00:00.000Z',
          },
        }],
      }),
    },
  )

  const missing = await requestGoalOperation('goal-missing')
  const nonGoal = await requestGoalOperation('cycle-not-goal')
  const archived = await requestGoalOperation('goal-archived')
  const invisible = await requestGoalOperation('goal-private')
  const active = await requestGoalOperation('goal-active')

  expect(missing.status).toBe(400)
  expect(await missing.json()).toMatchObject({
    code: 'InvalidDocumentRelationTarget',
  })
  expect(nonGoal.status).toBe(400)
  expect(await nonGoal.json()).toMatchObject({
    code: 'InvalidDocumentRelationTarget',
  })
  expect(archived.status).toBe(400)
  expect(await archived.json()).toMatchObject({
    code: 'InvalidDocumentRelationTarget',
  })
  expect(invisible.status).toBe(403)
  expect(await invisible.json()).toMatchObject({
    code: 'DocumentRelationTargetDenied',
  })
  expect(active.status).toBe(200)
  expect(applyCalls).toBe(1)
  expect(
    receivedGoalAuthorizationGuards,
  ).toEqual([{
    workspaceId: 'user#demo@example.com',
    planningRevision: 2,
  }])
})

test('revalidates archived Planning Goal targets before restoring a Document version', async () => {
  configureFakeProjectClients(true)
  let committed = false
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async restoreVersion(input) {
        await input.validateRelationTargets([{
          kind: 'goal',
          goalId: 'goal-archived',
        }])
        committed = true
        throw new Error('Archived Goal validation must reject the restore.')
      },
    },
    planning: {
      async getAuthorizationRevision() {
        return 1
      },
      async getAuthorizationState() {
        return {
          revision: 1,
          entities: [{
            id: 'goal-archived',
            type: 'goal',
            ownerMemberKey: 'demo@example.com',
            archivedAt: '2026-07-18T00:00:00.000Z',
          }],
          workItemLinks: [],
          workItemDependencies: [],
        }
      },
    } as unknown as PlanningClient,
  })

  const response = await app.request(
    '/api/documents/document-1/versions/document-1%3A1/restore',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 2 }),
    },
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    code: 'InvalidDocumentRelationTarget',
  })
  expect(committed).toBeFalse()
})

test('validates Document relation target reads with bounded concurrency', async () => {
  let activeReads = 0
  let maximumActiveReads = 0
  configureFakeProjectClients(true, {
    async detailReadHook() {
      activeReads += 1
      maximumActiveReads = Math.max(maximumActiveReads, activeReads)
      await Promise.resolve()
      activeReads -= 1
    },
  })
  const editableDocument = {
    schemaVersion: 1,
    id: 'document-1',
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Bounded target reads',
    position: 'a0',
    revision: 1,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: {
      canView: true,
      canEdit: true,
      canComment: true,
      canShare: true,
      canManagePermissions: true,
      canArchive: true,
      canRestore: false,
      canExport: true,
    },
    createdByUserId: 'demo@example.com',
    updatedByUserId: 'demo@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    blocks: [],
  } satisfies DocumentDetail
  setTestAppDependencies({
    documents: {
      ...createDocumentFake(),
      async restoreVersion(input) {
        await input.validateRelationTargets(
          Array.from({ length: 14 }, (_, index) => ({
            kind: 'work-item',
            workItemId:
              `team/core-team/issue/target-${index}`,
          })),
        )
        return editableDocument
      },
    },
  })

  const response = await app.request(
    '/api/documents/document-1/versions/document-1%3A1/restore',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(maximumActiveReads).toBe(8)
})

test('search endpoint refreshes workflow, custom fields, and relations from current sources', async () => {
  configureFakeProjectClients(true, {
    detailCustomFieldValues: {},
    detailWorkflowStatusId: 'active-review',
  })
  let resolvedScope: WorkspaceSearchResolvedScope | undefined
  let relationFilters: string[] | undefined
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations(_workspaceId, _teamId, workItemId) {
        return {
          graphRevision: 3,
          relations: [{
            sourceWorkItemId: workItemId,
            targetWorkItemId: 'current-dependency',
            type: 'blocks',
          }],
        }
      },
    }),
    workspaceSearch: createWorkspaceSearchFake({
      async search(input) {
        relationFilters = input.filters?.relationIds
        resolvedScope = await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'work-item',
          entityId: 'team/core-team/issue/work-item-1',
          title: 'Stale Work Item',
          url: '/teams/core-team/issues?issueId=work-item-1',
          teamId: 'core-team',
          status: 'in-progress',
          customFields: { legacyScore: 13 },
          relationIds: ['stale-dependency'],
        }))
        return { schemaVersion: 1, results: [] }
      },
    }),
  })

  const filters = encodeURIComponent(JSON.stringify({
    relationIds: ['blocks:current-dependency'],
  }))
  const response = await app.request(`/api/search?filters=${filters}`, {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(relationFilters).toEqual(['blocks:current-dependency'])
  expect(resolvedScope).toMatchObject({
    teamId: 'core-team',
    projectId: 'refero',
    currentDocument: {
      status: 'active-review',
      customFields: {},
      relationIds: ['blocks:current-dependency'],
    },
  })
})

test('search endpoint refreshes comment content from its current source snapshot', async () => {
  configureFakeProjectClients(true)
  let resolvedScope: WorkspaceSearchResolvedScope | undefined
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: 'Current private decision',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-07-12T02:00:00.000Z',
          reactions: [],
        }
      },
    }),
    workspaceSearch: createWorkspaceSearchFake({
      async search(input) {
        resolvedScope = await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'comment',
          entityId: 'team/core-team/issue/issue-1/comment/comment-1',
          parentId: 'team/core-team/issue/issue-1',
          title: 'Stale title',
          body: 'Stale private decision',
          url: '/teams/core-team/issues?issueId=issue-1&commentId=comment-1',
          teamId: 'core-team',
          updatedAt: '2026-06-08T01:00:00.000Z',
        }))
        return { schemaVersion: 1, results: [] }
      },
    }),
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScope).toMatchObject({
    teamId: 'core-team',
    projectId: 'refero',
    currentDocument: {
      body: 'Current private decision',
      creatorUserId: 'sato@example.com',
      updatedAt: '2026-07-12T02:00:00.000Z',
    },
  })
})

test('search endpoint fails closed for missing, deleted, or malformed comment sources', async () => {
  configureFakeProjectClients(true)
  const resolvedScopes: Array<WorkspaceSearchResolvedScope | undefined> = []
  let snapshotReads = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCommentSnapshot(input) {
        snapshotReads += 1
        if (input.commentId === 'missing') return undefined
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-07-12T02:00:00.000Z',
          deletedAt: '2026-07-12T02:00:00.000Z',
          reactions: [],
        }
      },
    }),
    workspaceSearch: createWorkspaceSearchFake({
      async search(input) {
        for (const [commentId, parentId] of [
          ['missing', 'team/core-team/issue/issue-1'],
          ['deleted', 'team/core-team/issue/issue-1'],
          ['malformed', 'team/core-team/issue/other'],
        ] as const) {
          resolvedScopes.push(await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
            workspaceId: input.workspaceId,
            entityType: 'comment',
            entityId: `team/core-team/issue/issue-1/comment/${commentId}`,
            parentId,
            title: 'Stale title',
            body: 'Stale body',
            url: `/teams/core-team/issues?issueId=issue-1&commentId=${commentId}`,
            teamId: 'core-team',
          })))
        }
        return { schemaVersion: 1, results: [] }
      },
    }),
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScopes).toEqual([undefined, undefined, undefined])
  expect(snapshotReads).toBe(2)
})

test('search endpoint excludes archived Team documents for system administrators', async () => {
  configureFakeProjectClients(true, { systemAdminMemberKeys: ['demo@example.com'] })
  let resolvedScope: unknown = 'not-called'
  setTestAppDependencies({
    workspaceSearch: createWorkspaceSearchFake({
      async search(input) {
        resolvedScope = await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'work-item',
          entityId: 'team/archived-team/issue/issue-1',
          title: 'Archived Team item',
          url: '/teams/archived-team/issues?issueId=issue-1',
          teamId: 'archived-team',
        }))
        return { schemaVersion: 1, results: [] }
      },
    }),
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScope).toBeUndefined()
})

test('saved view endpoints forward create update list and revision delete contracts', async () => {
  configureFakeProjectClients(true)
  const calls = {
    creates: [] as unknown[],
    deletes: [] as unknown[],
    lists: [] as unknown[],
    updates: [] as unknown[],
  }
  const view = {
    schemaVersion: 1 as const,
    id: 'view-1',
    name: 'Review queue',
    visibility: 'personal' as const,
    ownerUserId: 'demo@example.com',
    filters: { statuses: ['review'] },
    layout: { mode: 'table' as const, sort: [], columns: ['title'] },
    revision: 1,
    canEdit: true,
    favorite: false,
    pinned: false,
    isDefault: false,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  setTestAppDependencies({
    workspaceSearch: createWorkspaceSearchFake({
      async listSavedViews(input) {
        calls.lists.push(input)
        return { views: [view] }
      },
      async createSavedView(input) {
        calls.creates.push(input)
        return view
      },
      async updateSavedView(input) {
        calls.updates.push(input)
        return { ...view, revision: 2, favorite: true }
      },
      async deleteSavedView(input) {
        calls.deletes.push(input)
        return { id: input.viewId, revision: input.expectedRevision }
      },
    }),
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'saved-view-request-1',
  }
  const listResponse = await app.request('/api/saved-views', { headers })
  const createResponse = await app.request('/api/saved-views', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Review queue',
      visibility: 'personal',
      filters: { statuses: ['review'] },
      layout: { mode: 'table', sort: [], columns: ['title'] },
    }),
  })
  const updateResponse = await app.request('/api/saved-views/view-1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ expectedRevision: 1, favorite: true }),
  })
  const deleteResponse = await app.request('/api/saved-views/view-1?expectedRevision=2', {
    method: 'DELETE',
    headers,
  })

  expect([listResponse.status, createResponse.status, updateResponse.status, deleteResponse.status])
    .toEqual([200, 201, 200, 200])
  expect(calls.lists).toHaveLength(1)
  expect(calls.creates).toHaveLength(1)
  expect(calls.creates[0]).toMatchObject({ idempotencyKey: 'saved-view-request-1' })
  expect(calls.updates).toHaveLength(1)
  expect(calls.deletes).toEqual([
    expect.objectContaining({ viewId: 'view-1', expectedRevision: 2 }),
  ])
})

test('task view endpoints forward the complete lifecycle with current permission capabilities', async () => {
  configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    additionalTeams: [{
      id: 'restricted-team',
      name: 'Restricted Team',
      projects: [{ id: 'restricted-project', name: 'Restricted', tone: 'purple' }],
    }],
  })
  let listInput: ListTaskViewsInput | undefined
  let getInput: GetTaskViewRequest | undefined
  let createInput: CreateTaskViewRequest | undefined
  let updateInput: UpdateTaskViewRequest | undefined
  let duplicateInput: DuplicateTaskViewRequest | undefined
  let deleteInput: DeleteTaskViewRequest | undefined
  const definition = {
    surface: 'project',
    scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
    filters: {
      workflowStatuses: [{ teamId: 'core-team', statusId: 'review' }],
      customFields: [{ fieldId: 'score', operator: 'greater-than', value: 3 }],
    },
    layout: {
      mode: 'table',
      sort: [{ field: 'priority', direction: 'desc' }],
      columns: [{ field: 'title' }, { field: 'custom:score', width: 160 }],
      density: 'comfortable',
      displayOptions: { showCompleted: false },
    },
  } satisfies SavedTaskView['definition']
  const view = {
    schemaVersion: 1,
    id: 'task-view-1',
    name: 'Project review queue',
    visibility: 'personal',
    ownerUserId: 'demo@example.com',
    definition,
    revision: 1,
    canEdit: true,
    preference: {
      favorite: false,
      pinned: false,
      isDefault: false,
      isPersonalDefault: false,
      isTeamDefault: false,
    },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  } satisfies SavedTaskView
  const workflow = {
    id: 'project-workflow',
    name: 'Project workflow',
    initialStatusId: 'review',
    statuses: [{
      id: 'review',
      name: 'Review',
      category: 'started',
      sortOrder: 10,
    }],
    transitions: [],
  } satisfies WorkItemConfiguration['workflow']
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getWorkspaceConfiguration(workspaceId) {
        return {
          configuration: {
            scopeType: 'workspace',
            scopeId: workspaceId,
            schemaVersion: 1,
            revision: 1,
            workflow,
            customFields: [],
          },
        }
      },
      async getTeamConfiguration(_workspaceId, teamId) {
        const customFields: WorkItemConfiguration['customFields'] = teamId === 'restricted-team'
          ? [{
              id: 'restricted-score',
              name: 'Restricted score',
              type: 'number',
              sortOrder: 10,
              required: false,
            }]
          : [{
              id: 'score',
              name: 'Score',
              type: 'number',
              sortOrder: 10,
              required: false,
            }]
        return {
          configuration: {
            scopeType: 'team',
            scopeId: teamId,
            schemaVersion: 1,
            revision: 2,
            workflow,
            customFields,
          },
        }
      },
    }),
    workspaceSearch: createTaskViewWorkspaceSearchFake({
      async listTaskViews(input) {
        listInput = input
        return {
          capabilities: noTaskViewCapabilities,
          views: [view],
          nextCursor: 'next-task-view-cursor',
        }
      },
      async getTaskView(input) {
        getInput = input
        return view
      },
      async createTaskView(input) {
        createInput = input
        return view
      },
      async updateTaskView(input) {
        updateInput = input
        return {
          ...view,
          revision: 2,
          preference: { ...view.preference, favorite: true },
        }
      },
      async duplicateTaskView(input) {
        duplicateInput = input
        return { ...view, id: 'task-view-copy', name: 'Review queue copy' }
      },
      async deleteTaskView(input) {
        deleteInput = input
        return { id: input.viewId, revision: input.expectedRevision }
      },
    }),
  })
  const scope = encodeURIComponent(JSON.stringify(definition.scope))
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'task-view-request-1',
  }

  const listResponse = await app.request(
    `/api/task-views?surface=project&scope=${scope}&limit=10&cursor=cursor-1`,
    { headers },
  )
  const createResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: view.name,
      visibility: view.visibility,
      definition,
      favorite: true,
    }),
  })
  const getResponse = await app.request('/api/task-views/task-view-1', { headers })
  const updateResponse = await app.request('/api/task-views/task-view-1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      expectedRevision: 1,
      favorite: true,
      clearDefaultSource: 'personal',
    }),
  })
  const duplicateResponse = await app.request('/api/task-views/task-view-1/duplicate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Review queue copy', visibility: 'personal' }),
  })
  const deleteResponse = await app.request(
    '/api/task-views/task-view-1?expectedRevision=2',
    { method: 'DELETE', headers },
  )

  expect([
    listResponse.status,
    createResponse.status,
    getResponse.status,
    updateResponse.status,
    duplicateResponse.status,
    deleteResponse.status,
  ]).toEqual([200, 201, 200, 200, 201, 200])
  expect(listInput).toMatchObject({
    surface: 'project',
    scope: definition.scope,
    limit: 10,
    cursor: 'cursor-1',
  })
  expect(listInput?.access.projectIds.has('refero')).toBeTrue()
  expect(listInput?.access.projectScopeKeys.has('core-team\0refero')).toBeTrue()
  expect(listInput?.access.projectScopeKeys.has('restricted-team\0restricted-project')).toBeFalse()
  expect(listInput?.access.teamIds.has('core-team')).toBeTrue()
  expect(listInput?.access.teamIds.has('restricted-team')).toBeFalse()
  expect(listInput?.access.manageableTeamIds.has('core-team')).toBeTrue()
  expect(listInput?.access.manageableTeamIds.has('restricted-team')).toBeFalse()
  expect(listInput?.access.activeCustomFieldIds?.has('score')).toBeTrue()
  expect(listInput?.access.activeCustomFieldIds?.has('restricted-score')).toBeTrue()
  expect(listInput?.access.readableCustomFieldIds?.has('score')).toBeTrue()
  expect(listInput?.access.readableCustomFieldIds?.has('restricted-score')).toBeFalse()
  expect(listInput?.access.activeStatusIds?.has('core-team\0review')).toBeTrue()
  expect(listInput?.access.readableActorIds?.has('demo@example.com')).toBeTrue()
  expect(listInput?.access.readableActorIds?.has('sato@example.com')).toBeTrue()
  expect(listInput?.access.resolveReadableRelationIds).toBeFunction()
  expect(await listResponse.json()).toMatchObject({ capabilities: noTaskViewCapabilities })
  expect(createInput).toMatchObject({
    idempotencyKey: 'task-view-request-1',
    input: { name: view.name, visibility: 'personal', favorite: true, definition },
  })
  expect(getInput).toMatchObject({ viewId: 'task-view-1' })
  expect(updateInput).toMatchObject({
    viewId: 'task-view-1',
    idempotencyKey: 'task-view-request-1',
    input: { expectedRevision: 1, favorite: true, clearDefaultSource: 'personal' },
  })
  expect(duplicateInput).toMatchObject({
    sourceViewId: 'task-view-1',
    idempotencyKey: 'task-view-request-1',
    input: { name: 'Review queue copy', visibility: 'personal' },
  })
  expect(deleteInput).toMatchObject({
    viewId: 'task-view-1',
    expectedRevision: 2,
    idempotencyKey: 'task-view-request-1',
  })
})

test('task view relation resolution strongly authorizes targets with bounded request-wide caching', async () => {
  const observedCalls = configureFakeProjectClients(true, {
    projectAccesses: [
      { projectId: 'refero', teamId: 'core-team', role: 'viewer' },
      { projectId: 'other-project', teamId: 'other-team', role: 'viewer' },
    ],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
    additionalTeams: [{
      id: 'other-team',
      name: 'Other Team',
      projects: [{ id: 'other-project', name: 'Other', tone: 'green' }],
    }],
  })
  const baseTeamIssues = getTestAppDependencies().workItems.teamIssues
  let activeTargetReads = 0
  let maximumActiveTargetReads = 0
  let releaseParallelReads: (() => void) | undefined
  const parallelReadGate = new Promise<void>((resolve) => {
    releaseParallelReads = resolve
  })
  const directReadCount = new Map<string, number>()
  const legacySearchIds: string[] = []
  const resolutionResults: string[][] = []
  setTestAppDependencies({
    teamIssues: {
      ...baseTeamIssues,
      async getTeamIssueDetail(workspaceId, teamId, issueId, options) {
        const readKey = `${teamId}\0${issueId}`
        directReadCount.set(readKey, (directReadCount.get(readKey) ?? 0) + 1)
        expect(options).toMatchObject({ consistentIssueRead: true, eventLimit: 0 })
        if (issueId === 'deleted-target' || teamId === 'core-team' && issueId === 'other-only-target') {
          throw { status: 404, code: 'TeamIssueNotFound', message: 'Issue was not found.' }
        }
        if (issueId.startsWith('parallel-')) {
          activeTargetReads += 1
          maximumActiveTargetReads = Math.max(maximumActiveTargetReads, activeTargetReads)
          if (maximumActiveTargetReads === 8) releaseParallelReads?.()
          try {
            await parallelReadGate
          } finally {
            activeTargetReads -= 1
          }
        }
        const detail = await baseTeamIssues.getTeamIssueDetail(
          workspaceId,
          teamId,
          issueId,
          options,
        )
        return {
          ...detail,
          issue: {
            ...detail.issue,
            assignedProjectId: issueId === 'private-target'
              ? 'private-project'
              : teamId === 'other-team'
                ? 'other-project'
                : 'refero',
          },
        }
      },
    },
    workspaceSearch: createTaskViewWorkspaceSearchFake({
      async search(input) {
        const relationId = input.filters?.relationIds?.[0]
        if (relationId) legacySearchIds.push(relationId)
        return {
          schemaVersion: 1,
          results: relationId === 'legacy-visible'
            ? [{
                id: 'legacy-source',
                entityType: 'work-item',
                title: 'Legacy source',
                url: '/teams/core-team/issues?issueId=legacy-source',
                highlights: [],
              }]
            : [],
        }
      },
      async createTaskView(input) {
        const resolver = input.access.resolveReadableRelationIds
        if (!resolver) throw new Error('Expected a current-source relation resolver.')
        const parallelIds = Array.from(
          { length: 9 },
          (_unused, index) => `blocks:parallel-${index}`,
        )
        const relationIds = [
          ...parallelIds,
          'blocks:valid-target',
          'related:valid-target',
          'blocks:deleted-target',
          'blocks:private-target',
          'blocks:other-only-target',
          'work-item:team/core-team/issue/valid-target',
          'project:refero',
          'legacy-visible',
          'legacy-hidden',
        ]
        const resolutionInput: ResolveTaskViewRelationIdsInput = {
          relationIds,
          surface: 'team',
          scope: { kind: 'team', teamId: 'core-team' },
        }
        resolutionResults.push([...await resolver(resolutionInput)].sort())
        resolutionResults.push([...await resolver(resolutionInput)].sort())
        return {
          schemaVersion: 1,
          id: 'relation-view',
          name: input.input.name,
          visibility: input.input.visibility,
          ownerUserId: input.access.viewerUserId,
          definition: input.input.definition,
          revision: 1,
          canEdit: true,
          preference: {
            favorite: false,
            pinned: false,
            isDefault: false,
            isPersonalDefault: false,
            isTeamDefault: false,
          },
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
        } satisfies SavedTaskView
      },
    }),
  })

  const response = await app.request('/api/task-views', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Relation authorization',
      visibility: 'personal',
      definition: {
        surface: 'team',
        scope: { kind: 'team', teamId: 'core-team' },
        filters: { relationIds: ['blocks:valid-target'] },
        layout: {
          mode: 'table',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'comfortable',
          displayOptions: {},
        },
      },
    }),
  })

  expect(response.status).toBe(201)
  expect(maximumActiveTargetReads).toBe(8)
  expect(directReadCount.get('core-team\0valid-target')).toBe(1)
  expect(directReadCount.get('other-team\0other-only-target')).toBeUndefined()
  expect(legacySearchIds).toEqual(['legacy-visible', 'legacy-hidden'])
  expect(resolutionResults).toHaveLength(2)
  expect(resolutionResults[0]).toEqual(resolutionResults[1])
  expect(resolutionResults[0]).toContain('blocks:valid-target')
  expect(resolutionResults[0]).toContain('related:valid-target')
  expect(resolutionResults[0]).toContain('work-item:team/core-team/issue/valid-target')
  expect(resolutionResults[0]).toContain('project:refero')
  expect(resolutionResults[0]).toContain('legacy-visible')
  expect(resolutionResults[0]).not.toContain('blocks:deleted-target')
  expect(resolutionResults[0]).not.toContain('blocks:private-target')
  expect(resolutionResults[0]).not.toContain('blocks:other-only-target')
  expect(resolutionResults[0]).not.toContain('legacy-hidden')
  expect(observedCalls.issueDetails).toHaveLength(11)
})

test('system administrators can address task views for an active Team without Projects', async () => {
  configureFakeProjectClients(false, {
    projectAccesses: [],
    systemAdminMemberKeys: ['demo@example.com'],
    additionalTeams: [{ id: 'empty-team', name: 'Empty Team', projects: [] }],
  })
  let listInput: ListTaskViewsInput | undefined
  setTestAppDependencies({
    workspaceSearch: createTaskViewWorkspaceSearchFake({
      async listTaskViews(input) {
        listInput = input
        return { capabilities: noTaskViewCapabilities, views: [] }
      },
    }),
  })
  const scope = encodeURIComponent(JSON.stringify({ kind: 'team', teamId: 'empty-team' }))

  const response = await app.request(`/api/task-views?surface=team&scope=${scope}`, {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(listInput?.access.isSystemAdmin).toBeTrue()
  expect(listInput?.access.teamIds.has('empty-team')).toBeTrue()
  expect(listInput?.access.manageableTeamIds.has('empty-team')).toBeTrue()
})

test('Project-scoped Enterprise readers see Project and viewer task views without Workspace definitions', async () => {
  configureFakeProjectClients(false, {
    workspaceRole: 'admin',
    projectAccesses: [],
  })
  const identity = await createProjectScopedTaskViewIdentity(
    'project-task-view-reader',
    ['work-items.read'],
  )
  let listInput: ListTaskViewsInput | undefined
  let createCalls = 0
  const createView = (
    id: string,
    scope: SavedTaskView['definition']['scope'],
    visibility: SavedTaskView['visibility'],
  ): SavedTaskView => ({
    schemaVersion: 1,
    id,
    name: id,
    visibility,
    ownerUserId: 'demo@example.com',
    definition: {
      surface: scope.kind === 'viewer' ? 'my-tasks' : 'project',
      scope,
      filters: {},
      layout: {
        mode: 'list',
        sort: [],
        columns: [{ field: 'title' }],
        density: 'comfortable',
        displayOptions: {},
      },
    },
    revision: 1,
    canEdit: false,
    preference: {
      favorite: false,
      pinned: false,
      isDefault: false,
      isPersonalDefault: false,
      isTeamDefault: false,
    },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  })
  const projectView = createView(
    'project-view',
    { kind: 'project', teamId: 'core-team', projectId: 'refero' },
    'team',
  )
  const viewerView = createView('viewer-view', { kind: 'viewer' }, 'personal')
  const workspaceView = createView('workspace-view', { kind: 'workspace' }, 'shared')
  setTestAppDependencies({
    enterpriseIdentity: identity,
    workspaceSearch: createTaskViewWorkspaceSearchFake({
      async listTaskViews(input) {
        listInput = input
        return {
          capabilities: noTaskViewCapabilities,
          views: [
            ...(input.access.projectScopeKeys.has('core-team\0refero')
              ? [projectView]
              : []),
            viewerView,
            ...(input.access.canAccessWorkspaceScope ? [workspaceView] : []),
          ].map((view) => ({ ...view, canEdit: input.access.canWrite })),
        }
      },
      async getTaskView(input) {
        return { ...viewerView, canEdit: input.access.canWrite }
      },
      async createTaskView() {
        createCalls += 1
        return projectView
      },
    }),
  })

  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const listResponse = await app.request('/api/task-views', { headers })
  const getResponse = await app.request('/api/task-views/viewer-view', { headers })
  const createResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Denied Project view',
      visibility: 'personal',
      definition: projectView.definition,
    }),
  })
  const listBody = await listResponse.json() as { views?: SavedTaskView[] }

  expect([listResponse.status, getResponse.status, createResponse.status]).toEqual([200, 200, 403])
  expect(listBody.views?.map((view) => view.id)).toEqual(['project-view', 'viewer-view'])
  expect(listBody.views?.every((view) => view.canEdit === false)).toBeTrue()
  expect((await getResponse.json() as SavedTaskView).canEdit).toBeFalse()
  expect(listInput?.access.canAccessWorkspaceScope).toBeFalse()
  expect(listInput?.access.canManageSharedViews).toBeFalse()
  expect(listInput?.access.canWrite).toBeFalse()
  expect(listInput?.access.manageableTeamIds.has('core-team')).toBeFalse()
  expect(createCalls).toBe(0)
})

test('Project-scoped Enterprise writers can mutate Project task views but cannot manage Team defaults', async () => {
  configureFakeProjectClients(false, {
    workspaceRole: 'admin',
    projectAccesses: [],
  })
  const identity = await createProjectScopedTaskViewIdentity(
    'project-task-view-writer',
    ['work-items.read', 'work-items.write'],
  )
  let listInput: ListTaskViewsInput | undefined
  let createCalls = 0
  const projectView = {
    schemaVersion: 1,
    id: 'project-writer-view',
    name: 'Project writer view',
    visibility: 'personal',
    ownerUserId: 'demo@example.com',
    definition: {
      surface: 'project',
      scope: { kind: 'project', teamId: 'core-team', projectId: 'refero' },
      filters: {},
      layout: {
        mode: 'list',
        sort: [],
        columns: [{ field: 'title' }],
        density: 'comfortable',
        displayOptions: {},
      },
    },
    revision: 1,
    canEdit: true,
    preference: {
      favorite: false,
      pinned: false,
      isDefault: false,
      isPersonalDefault: false,
      isTeamDefault: false,
    },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  } satisfies SavedTaskView
  setTestAppDependencies({
    enterpriseIdentity: identity,
    workspaceSearch: createTaskViewWorkspaceSearchFake({
      async listTaskViews(input) {
        listInput = input
        return {
          capabilities: noTaskViewCapabilities,
          views: [{ ...projectView, canEdit: input.access.canWrite }],
        }
      },
      async createTaskView(input) {
        createCalls += 1
        if (
          input.input.defaultSource === 'team' &&
          !input.access.manageableTeamIds.has(input.input.teamId ?? '')
        ) {
          throw new WorkspaceSearchError(
            403,
            'TaskViewAccessDenied',
            'Team task view default management is denied.',
          )
        }
        return projectView
      },
    }),
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const listResponse = await app.request('/api/task-views', { headers })
  const createResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'My scoped Work Items',
      visibility: 'personal',
      definition: {
        ...projectView.definition,
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
      },
    }),
  })
  const teamDefaultResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Denied Team default',
      visibility: 'team',
      teamId: 'core-team',
      defaultSource: 'team',
      definition: {
        ...projectView.definition,
        surface: 'team',
        scope: { kind: 'team', teamId: 'core-team' },
      },
    }),
  })
  const listBody = await listResponse.json() as { views?: SavedTaskView[] }

  expect([listResponse.status, createResponse.status, teamDefaultResponse.status])
    .toEqual([200, 201, 403])
  expect(listBody.views?.[0]?.canEdit).toBeTrue()
  expect(listInput?.access.canAccessWorkspaceScope).toBeFalse()
  expect(listInput?.access.canWrite).toBeTrue()
  expect(listInput?.access.manageableTeamIds.has('core-team')).toBeFalse()
  expect(createCalls).toBe(2)
})

test('Enterprise task view mutations stay inside each authoritative writable Project scope', async () => {
  configureFakeProjectClients(false, {
    workspaceRole: 'admin',
    projectAccesses: [],
    additionalTeams: [{
      id: 'restricted-team',
      name: 'Restricted Team',
      projects: [{ id: 'restricted-project', name: 'Restricted', tone: 'purple' }],
    }],
  })
  const identity = await createMixedProjectTaskViewIdentity()
  let listInput: ListTaskViewsInput | undefined
  let createAttempts = 0
  setTestAppDependencies({
    enterpriseIdentity: identity,
    workspaceSearch: createTaskViewWorkspaceSearchFake({
      async listTaskViews(input) {
        listInput = input
        return { capabilities: noTaskViewCapabilities, views: [] }
      },
      async createTaskView(input) {
        createAttempts += 1
        const scope = input.input.definition.scope
        const canWriteScope = scope.kind === 'viewer'
          ? input.access.canWrite
          : scope.kind === 'workspace'
            ? input.access.canWriteWorkspaceScope
            : scope.kind === 'team'
              ? input.access.writableTeamIds.has(scope.teamId)
              : scope.teamId
                ? input.access.writableProjectScopeKeys.has(
                    `${scope.teamId}\0${scope.projectId}`,
                  )
                : input.access.writableProjectIds.has(scope.projectId)
        const canWriteAudience = input.input.visibility !== 'team' || Boolean(
          input.input.teamId && input.access.writableTeamIds.has(input.input.teamId),
        )
        if (!canWriteScope || !canWriteAudience) {
          throw new WorkspaceSearchError(
            403,
            'TaskViewAccessDenied',
            'Task view scope mutation is denied.',
          )
        }
        return {
          schemaVersion: 1,
          id: `created-${createAttempts}`,
          name: input.input.name,
          visibility: input.input.visibility,
          ownerUserId: input.access.viewerUserId,
          ...(input.input.teamId ? { teamId: input.input.teamId } : {}),
          definition: input.input.definition,
          revision: 1,
          canEdit: true,
          preference: {
            favorite: false,
            pinned: false,
            isDefault: false,
            isPersonalDefault: false,
            isTeamDefault: false,
          },
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
        }
      },
    }),
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const createBody = (
    name: string,
    scope: SavedTaskView['definition']['scope'],
    visibility: SavedTaskView['visibility'] = 'personal',
    teamId?: string,
  ) => JSON.stringify({
    name,
    visibility,
    ...(teamId ? { teamId } : {}),
    definition: {
      surface: scope.kind === 'viewer' ? 'my-tasks' : 'project',
      scope,
      filters: {},
      layout: {
        mode: 'list',
        sort: [],
        columns: [{ field: 'title' }],
        density: 'comfortable',
        displayOptions: {},
      },
    },
  })

  const listResponse = await app.request('/api/task-views', { headers })
  const projectAResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: createBody(
      'Project A queue',
      { kind: 'project', teamId: 'core-team', projectId: 'refero' },
    ),
  })
  const viewerResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: createBody('My Tasks queue', { kind: 'viewer' }),
  })
  const projectBResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: createBody(
      'Denied Project B queue',
      { kind: 'project', teamId: 'restricted-team', projectId: 'restricted-project' },
    ),
  })
  const teamBResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: createBody('Denied Team B audience', { kind: 'viewer' }, 'team', 'restricted-team'),
  })

  expect([
    listResponse.status,
    projectAResponse.status,
    viewerResponse.status,
    projectBResponse.status,
    teamBResponse.status,
  ]).toEqual([200, 201, 201, 403, 403])
  expect(listInput?.access.canWrite).toBeTrue()
  expect(listInput?.access.canWriteWorkspaceScope).toBeFalse()
  expect(listInput?.access.projectScopeKeys.has('core-team\0refero')).toBeTrue()
  expect(listInput?.access.projectScopeKeys.has('restricted-team\0restricted-project')).toBeTrue()
  expect(listInput?.access.writableProjectScopeKeys.has('core-team\0refero')).toBeTrue()
  expect(listInput?.access.writableProjectScopeKeys.has('restricted-team\0restricted-project'))
    .toBeFalse()
  expect(listInput?.access.writableTeamIds.size).toBe(0)
  expect(createAttempts).toBe(4)
})

test('task view endpoints reject malformed query and JSON contracts before invoking the port', async () => {
  configureFakeProjectClients(true)
  let operationCount = 0
  setTestAppDependencies({
    workspaceSearch: createTaskViewWorkspaceSearchFake({
      async listTaskViews() {
        operationCount += 1
        return { capabilities: noTaskViewCapabilities, views: [] }
      },
      async createTaskView() {
        operationCount += 1
        throw new Error('Malformed task view create must not reach the port.')
      },
    }),
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const invalidScope = encodeURIComponent(JSON.stringify({
    kind: 'project',
    projectId: 42,
  }))

  const listResponse = await app.request(
    `/api/task-views?surface=project&scope=${invalidScope}`,
    { headers },
  )
  const createResponse = await app.request('/api/task-views', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Invalid layout',
      visibility: 'personal',
      definition: {
        surface: 'project',
        scope: { kind: 'project', projectId: 'refero' },
        filters: {},
        layout: {
          mode: 'table',
          sort: [],
          columns: [{ field: 'title', width: 12 }],
          density: 'comfortable',
          displayOptions: {},
        },
      },
    }),
  })
  const invalidIdempotencyHeaders = {
    ...headers,
    'Idempotency-Key': 'x'.repeat(257),
  }
  const updateResponse = await app.request('/api/task-views/task-view-1', {
    method: 'PATCH',
    headers: invalidIdempotencyHeaders,
    body: JSON.stringify({ expectedRevision: 1, favorite: true }),
  })
  const deleteResponse = await app.request(
    '/api/task-views/task-view-1?expectedRevision=1',
    { method: 'DELETE', headers: invalidIdempotencyHeaders },
  )

  expect([
    listResponse.status,
    createResponse.status,
    updateResponse.status,
    deleteResponse.status,
  ]).toEqual([400, 400, 400, 400])
  expect(await listResponse.json()).toMatchObject({ code: 'InvalidTaskView' })
  expect(await createResponse.json()).toMatchObject({ code: 'InvalidTaskView' })
  expect(await updateResponse.json()).toMatchObject({ code: 'InvalidTaskView' })
  expect(await deleteResponse.json()).toMatchObject({ code: 'InvalidTaskView' })
  expect(operationCount).toBe(0)
})

test('task view endpoints fail closed when the configured Workspace Search port is legacy-only', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({ workspaceSearch: createWorkspaceSearchFake({}) })

  const response = await app.request('/api/task-views', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    code: 'TaskViewUnavailable',
    message: 'Task view storage is unavailable.',
  })
})

test('keeps a primary mutation successful when search projection fails', async () => {
  configureFakeProjectClients(true)
  let projectedTitle: string | undefined
  setTestAppDependencies({
    workspaceSearch: createWorkspaceSearchFake({
      async upsertDocument(document) {
        projectedTitle = document.title
        throw new Error('Search index unavailable')
      },
    }),
  })
  const originalConsoleError = console.error
  let projectionErrors = 0
  console.error = () => {
    projectionErrors += 1
  }
  try {
    const response = await app.request('/api/teams', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Search resilient Team' }),
    })

    expect(response.status).toBe(201)
    expect(projectedTitle).toBe('Search resilient Team')
    expect(projectionErrors).toBe(1)
  } finally {
    console.error = originalConsoleError
  }
})

test('keeps a committed mutation successful when search document construction fails', async () => {
  configureFakeProjectClients(true)
  let projectionWrites = 0
  setTestAppDependencies({
    workspaceSearch: createWorkspaceSearchFake({
      async upsertDocument(document) {
        projectionWrites += 1
        return createWorkspaceSearchDocument(document)
      },
    }),
  })
  const originalConsoleError = console.error
  let projectionErrors = 0
  console.error = () => {
    projectionErrors += 1
  }
  try {
    const response = await app.request('/api/teams', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'x'.repeat(501) }),
    })

    expect(response.status).toBe(201)
    expect(projectionWrites).toBe(0)
    expect(projectionErrors).toBe(1)
  } finally {
    console.error = originalConsoleError
  }
})
