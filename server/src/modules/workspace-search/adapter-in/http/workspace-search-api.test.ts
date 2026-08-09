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
import type {
  PlanningClient,
} from '../../../planning/planning'
import type {
  WorkspaceSearchClient,
  WorkspaceSearchQueryInput,
  WorkspaceSearchResolvedScope,
} from '../../workspace-search'
import {
  createWorkspaceSearchDocument,
} from '../../workspace-search'
import type {
  DocumentDetail,
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
          acceptedResolutions: [],
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

test('search endpoint rehydrates curated context and drops superseded projections', async () => {
  configureFakeProjectClients(true)
  const resolvedScopes: Array<WorkspaceSearchResolvedScope | undefined> = []
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCuratedContextItemSnapshot(input) {
        return {
          schemaVersion: 1,
          id: input.itemId,
          teamId: 'core-team',
          workItemId: 'issue-1',
          kind: 'decision',
          state: input.itemId === 'superseded' ? 'superseded' : 'accepted',
          title: 'Current release decision',
          body: 'Current source-of-truth decision body',
          mentionMemberKeys: [],
          createdBy: { id: 'sato@example.com', displayName: 'Sato' },
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedBy: { id: 'demo@example.com', displayName: 'Demo' },
          updatedAt: '2026-07-12T02:00:00.000Z',
          revision: 4,
        }
      },
    }),
    workspaceSearch: createWorkspaceSearchFake({
      async search(input) {
        for (const itemId of ['current', 'superseded']) {
          resolvedScopes.push(await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
            workspaceId: input.workspaceId,
            entityType: 'context-item',
            entityId: `team/core-team/issue/issue-1/context-item/${itemId}`,
            parentId: 'team/core-team/issue/issue-1',
            title: 'Stale context',
            body: 'Stale context body',
            url: `/teams/core-team/issues?issueId=issue-1&contextItemId=${itemId}`,
            teamId: 'core-team',
            sourceRevision: 1,
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
  expect(resolvedScopes[0]).toMatchObject({
    teamId: 'core-team',
    projectId: 'refero',
    currentDocument: {
      entityType: 'context-item',
      title: 'Current release decision',
      body: 'Current source-of-truth decision body',
      status: 'accepted',
      sourceRevision: 4,
    },
  })
  expect(resolvedScopes[1]).toBeUndefined()
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
          acceptedResolutions: [],
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
