import type { EnterprisePermissionId, EnterpriseRoleAssignment, WorkspaceSearchResult } from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { InMemoryEnterpriseIdentityClient } from '../modules/enterprise-identity/enterprise-identity'
import { ProjectDataError } from '../modules/directory'
import { createApiTestHarness } from './test-support/api-test-harness'

const {
  configureFakeProjectClients,
  getTestAppDependencies,
  planningApiRequest,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Workspace used by every test. */
const WORKSPACE_ID = 'workspace-collections'

/**
 * Configures a member who can read Refero but not the Secret Project.
 *
 * @param role - Project role on Refero.
 * @param workspaceRole - Optional Workspace role override.
 */
function configureMember(role: 'member' | 'viewer' = 'member', workspaceRole?: 'guest', detailMissingIssueIds?: string[]) {
  configureFakeProjectClients(true, {
    directoryId: WORKSPACE_ID,
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'secret', name: 'Secret', tone: 'purple' },
    ],
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role }],
    detailAssignedProjectIds: { 'hidden-item': 'secret' },
    ...(workspaceRole ? { workspaceRole } : {}),
    ...(detailMissingIssueIds ? { detailMissingIssueIds } : {}),
  })
}

/**
 * Creates a Collection through the API.
 *
 * @param name - Collection name.
 * @param key - Idempotency key.
 * @returns Created Collection body.
 */
async function createCollection(name: string, key = `key-${name}`) {
  const response = await planningApiRequest('/api/collections', 'POST', { name }, key)
  expect(response.status).toBe(201)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('collectionId' in body) || typeof body.collectionId !== 'string') {
    throw new Error('Unexpected Collection response')
  }
  return { collectionId: body.collectionId, body }
}

test('creates Collections idempotently and lists them by name', async () => {
  configureMember()
  expect((await planningApiRequest('/api/collections', 'POST', { name: 'Launch' })).status).toBe(400)
  const first = await createCollection('Launch', 'retry-key')
  const replay = await planningApiRequest('/api/collections', 'POST', { name: 'Launch' }, 'retry-key')
  expect(replay.status).toBe(201)
  expect(await replay.json()).toEqual(first.body)
  expect((await planningApiRequest('/api/collections', 'POST', { name: 'Other' }, 'retry-key')).status).toBe(409)
  await createCollection('Accessibility')
  expect((await planningApiRequest('/api/collections', 'POST', { name: ' ', extra: true }, 'k')).status).toBe(400)

  const listed = await (await planningApiRequest('/api/collections')).json()
  expect(listed.collections.map((collection: { name: string }) => collection.name)).toEqual(['Accessibility', 'Launch'])
  expect(listed.canWrite).toBe(true)
})

test('references readable Work Items without copying them and hides unreadable ones', async () => {
  configureMember()
  const { collectionId } = await createCollection('Launch')
  const itemsPath = `/api/collections/${collectionId}/items`

  const added = await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'PUT')
  expect(added.status).toBe(200)
  const addedBody = await added.json()
  expect(addedBody.revision).toBe(2)
  // The response carries the added Work Item so a client can show it without reloading.
  expect(addedBody.item).toEqual({
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    title: expect.any(String),
    statusCategory: 'started',
    assignedProjectId: 'refero',
    addedAt: addedBody.updatedAt,
  })
  const again = await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'PUT')
  expect(await again.json()).toEqual(addedBody)

  expect((await planningApiRequest(`${itemsPath}/core-team/hidden-item`, 'PUT')).status).toBe(404)
  expect((await planningApiRequest(`${itemsPath}/core-team/wireframe`, 'PUT')).status).toBe(404)
  expect((await planningApiRequest(`${itemsPath}/missing-team/onboarding-friction`, 'PUT')).status).toBe(404)
  const unicode = await planningApiRequest(`${itemsPath}/${encodeURIComponent('チーム/日本')}/${encodeURIComponent('課題-１')}`, 'PUT')
  expect(unicode.status).toBe(404)
  expect(await unicode.json()).toMatchObject({ code: 'CollectionWorkItemNotFound' })
  expect((await planningApiRequest(`${itemsPath}/core-team/${encodeURIComponent(' padded')}`, 'PUT')).status).toBe(400)

  const store = getTestAppDependencies().workItems.collections
  const stored = await store.get(WORKSPACE_ID, collectionId)
  if (!stored) throw new Error('Collection was not stored in the test Workspace')
  await store.put(WORKSPACE_ID, {
    ...stored,
    items: [
      { teamId: 'core-team', issueId: 'hidden-item', addedAt: '2026-10-16T00:00:00.000Z', addedBy: 'someone@example.com' },
      ...stored.items,
    ],
    revision: stored.revision + 1,
  }, stored.revision)

  const listed = await planningApiRequest(itemsPath)
  expect(listed.status).toBe(200)
  const body = await listed.json()
  expect(body.items).toEqual([
    expect.objectContaining({ teamId: 'core-team', issueId: 'onboarding-friction', assignedProjectId: 'refero', statusCategory: 'started' }),
  ])
  expect(JSON.stringify(body)).not.toContain('hidden-item')

  const removed = await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'DELETE')
  expect(removed.status).toBe(200)
  expect((await (await planningApiRequest(itemsPath)).json()).items).toEqual([])
})

test('renames with optimistic concurrency and deletes only the Collection', async () => {
  configureMember()
  const { collectionId } = await createCollection('Launch')
  const path = `/api/collections/${collectionId}`
  expect((await planningApiRequest(path, 'PATCH', { expectedRevision: 2, name: 'Stale' })).status).toBe(409)
  const renamed = await planningApiRequest(path, 'PATCH', { expectedRevision: 1, name: 'Launch v2', description: 'Q4' })
  expect(renamed.status).toBe(200)
  expect(await renamed.json()).toEqual(expect.objectContaining({ name: 'Launch v2', description: 'Q4', revision: 2 }))
  const cleared = await planningApiRequest(path, 'PATCH', { expectedRevision: 2, description: '' })
  expect(await cleared.json()).not.toHaveProperty('description')

  expect((await planningApiRequest(`${path}?expectedRevision=1`, 'DELETE')).status).toBe(409)
  expect((await planningApiRequest(`${path}?expectedRevision=3`, 'DELETE')).status).toBe(204)
  expect((await planningApiRequest(`${path}/items`)).status).toBe(404)
})

test('lets guests neither read nor change Collections', async () => {
  configureMember('viewer', 'guest')
  expect((await planningApiRequest('/api/collections')).status).toBe(403)
  expect((await planningApiRequest('/api/collections', 'POST', { name: 'Launch' }, 'k')).status).toBe(403)
  expect((await planningApiRequest('/api/collections/candidates?keyword=onboarding')).status).toBe(403)
})

test('searches addable Work Item candidates under the Collection permission', async () => {
  // No canonical Work Item has the keyword as its ID, so only the index answers.
  configureMember('member', undefined, ['onboarding'])
  const missing = await planningApiRequest('/api/collections/candidates?keyword=%20')
  expect(missing.status).toBe(400)
  expect(await missing.json()).toMatchObject({ code: 'InvalidCollectionCandidateQuery' })
  let capturedFilters: unknown
  let capturedLimit: number | undefined
  setTestAppDependencies({
    workspaceSearch: {
      ...getTestAppDependencies().workItems.workspaceSearch,
      async search(input) {
        capturedFilters = input.filters
        capturedLimit = input.limit
        return { schemaVersion: 1, results: [] }
      },
    },
  })
  const response = await planningApiRequest('/api/collections/candidates?keyword=%20onboarding%20&limit=5')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ schemaVersion: 1, results: [] })
  expect(capturedFilters).toEqual({ keyword: 'onboarding', entityTypes: ['work-item'] })
  expect(capturedLimit).toBe(5)
})

test('offers a readable Work Item by exact ID even when its search projection is missing', async () => {
  configureMember()
  let indexed: WorkspaceSearchResult[] = []
  setTestAppDependencies({
    workspaceSearch: {
      ...getTestAppDependencies().workItems.workspaceSearch,
      async search() {
        return { schemaVersion: 1, results: indexed, nextCursor: 'next' }
      },
    },
  })
  const exact: WorkspaceSearchResult = {
    id: 'team/core-team/issue/onboarding-friction',
    entityType: 'work-item',
    title: '初回オンボーディングの離脱要因を減らす',
    subtitle: 'onboarding-friction',
    url: '/projects/refero/issues?teamId=core-team&issueId=onboarding-friction',
    teamId: 'core-team',
    projectId: 'refero',
    highlights: [],
  }
  // The index has no document for the Work Item, as after a failed projection.
  const response = await planningApiRequest('/api/collections/candidates?keyword=onboarding-friction')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ schemaVersion: 1, results: [exact], nextCursor: 'next' })

  // An indexed match is not repeated: the canonical match leads, and later pages never return it again.
  indexed = [{ ...exact, title: 'Indexed title' }]
  expect((await (await planningApiRequest('/api/collections/candidates?keyword=onboarding-friction')).json()).results)
    .toEqual([exact])
  expect((await (await planningApiRequest('/api/collections/candidates?keyword=onboarding-friction&cursor=next')).json()).results)
    .toEqual([])

  // A Work Item the caller cannot read is never offered by its ID.
  indexed = []
  expect((await (await planningApiRequest('/api/collections/candidates?keyword=hidden-item')).json()).results).toEqual([])
})

test('keeps exact-ID candidates within the page limit and never repeats them on later pages', async () => {
  configureMember()
  const other: WorkspaceSearchResult = {
    id: 'team/core-team/issue/onboarding-friction-notes',
    entityType: 'work-item',
    title: 'Onboarding friction notes',
    subtitle: 'onboarding-friction-notes',
    url: '/teams/core-team/issues?issueId=onboarding-friction-notes',
    teamId: 'core-team',
    highlights: [],
  }
  const indexedExact: WorkspaceSearchResult = {
    ...other,
    id: 'team/core-team/issue/onboarding-friction',
    title: 'Indexed title',
    subtitle: 'onboarding-friction',
  }
  const searches: { limit?: number; cursor?: string }[] = []
  setTestAppDependencies({
    workspaceSearch: {
      ...getTestAppDependencies().workItems.workspaceSearch,
      async search(input) {
        searches.push({ ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor ? { cursor: input.cursor } : {}) })
        // The index pages hold the exact match on both pages, as when the projection is indexed twice by key order.
        return input.cursor
          ? { schemaVersion: 1, results: [indexedExact] }
          : { schemaVersion: 1, results: [indexedExact, other].slice(0, input.limit), nextCursor: 'index-next' }
      },
    },
  })
  const path = '/api/collections/candidates?keyword=onboarding-friction'

  // The exact match takes the only slot, so the index is not read until the next page.
  const first = await (await planningApiRequest(`${path}&limit=1`)).json()
  expect(first.results.map((result: WorkspaceSearchResult) => result.id)).toEqual([indexedExact.id])
  expect(first.nextCursor).toBe('exact:1')
  expect(searches).toEqual([])
  const second = await (await planningApiRequest(`${path}&limit=1&cursor=${first.nextCursor}`)).json()
  // The index match of the exact Work Item is dropped rather than shown again.
  expect(second).toEqual({ schemaVersion: 1, results: [], nextCursor: 'index-next' })
  expect(searches).toEqual([{ limit: 1 }])

  // With room left, the index fills only the remaining slots.
  searches.length = 0
  const mixed = await (await planningApiRequest(`${path}&limit=2`)).json()
  expect(mixed.results.map((result: WorkspaceSearchResult) => result.id)).toEqual([indexedExact.id])
  expect(mixed.results[0].title).not.toBe('Indexed title')
  expect(mixed.nextCursor).toBe('index-next')
  expect(searches).toEqual([{ limit: 1 }])
  const later = await (await planningApiRequest(`${path}&limit=2&cursor=index-next`)).json()
  expect(later).toEqual({ schemaVersion: 1, results: [] })
  expect(searches).toEqual([{ limit: 1 }, { limit: 2, cursor: 'index-next' }])

  for (const query of ['&cursor=exact:x', '&cursor=exact:101', '&cursor=exact:01', '&limit=101']) {
    const invalid = await planningApiRequest(`${path}${query}`)
    expect(invalid.status).toBe(400)
  }
})

/** One custom role and where it is assigned to the test member. */
type TestRoleGrant = {
  /** Custom role ID. */
  roleId: `custom:${string}`
  /** Permissions of the role. */
  permissions: EnterprisePermissionId[]
  /** Assignment scope kind. */
  kind: 'workspace' | 'team' | 'project'
  /** Scope target; the Workspace ID, a Team ID, or a Project ID. */
  targetId: string
}

/**
 * Creates an Enterprise identity whose only grants are the given custom roles.
 *
 * @param workspaceId - Workspace the roles apply to.
 * @param grants - Roles and their assignment scopes for the test member.
 * @returns Enterprise Identity fake with those direct assignments.
 */
async function createWorkItemRoleIdentity(workspaceId: string, grants: readonly TestRoleGrant[]) {
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = '2026-10-16T00:00:00.000Z'
  for (const grant of grants) {
    await identity.putCustomRole({
      workspaceId,
      roleId: grant.roleId,
      name: grant.roleId,
      permissions: grant.permissions,
      guestAssignable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
  }
  return new Proxy(identity, {
    get(target, property) {
      if (property === 'getSnapshot') {
        return async (requestedWorkspaceId: string) => {
          const snapshot = await target.getSnapshot(requestedWorkspaceId)
          const roleAssignments = grants.map((grant): EnterpriseRoleAssignment => ({
            workspaceId,
            assignmentId: `${grant.roleId}-assignment`,
            principalKind: 'member',
            principalId: 'demo@example.com',
            roleId: grant.roleId,
            scope: { workspaceId, kind: grant.kind, targetId: grant.targetId },
            source: 'direct',
          }))
          return { ...snapshot, roleAssignments }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('lets a Workspace-scoped Work Item role add and read Collection items', async () => {
  configureFakeProjectClients(false, { directoryId: WORKSPACE_ID, workspaceRole: 'admin', projectAccesses: [] })
  setTestAppDependencies({
    enterpriseIdentity: await createWorkItemRoleIdentity(WORKSPACE_ID, [{
      roleId: 'custom:work-item-editor',
      permissions: ['work-items.read', 'work-items.write'],
      kind: 'workspace',
      targetId: WORKSPACE_ID,
    }]),
  })
  // The Enterprise grant reaches the Work Item through the Refero Project, which stays active.
  const existingProjectDirectory = getTestAppDependencies().workspace.projectDirectory
  const activeChecked: unknown[] = []
  setTestAppDependencies({
    projectDirectory: {
      ...existingProjectDirectory,
      async createActiveReferenceConditionChecks(directoryId, teamId, projectId) {
        activeChecked.push([teamId, projectId])
        return [{ ConditionCheck: { TableName: 'DirectoryTable', Key: { directoryId, entryKey: `PROJECT#${projectId}` }, ConditionExpression: 'attribute_exists(directoryId)' } }]
      },
    },
  })
  const { collectionId } = await createCollection('Launch')
  const itemsPath = `/api/collections/${collectionId}/items`
  expect((await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'PUT')).status).toBe(200)
  expect(activeChecked).toEqual([['core-team', 'refero']])
  const listed = await (await planningApiRequest(itemsPath)).json()
  expect(listed.items).toEqual([expect.objectContaining({ teamId: 'core-team', issueId: 'onboarding-friction' })])
})

test('does not let a Team-scoped Work Item grant change Workspace-wide Collections', async () => {
  configureFakeProjectClients(false, { directoryId: WORKSPACE_ID, workspaceRole: 'admin', projectAccesses: [] })
  const { collectionId } = await createCollection('Launch')
  const revision = 1
  // Collections belong to the Workspace, so a Team grant alone, or one that only adds
  // write to a Workspace read grant, must not authorize a Collection change.
  for (const grants of [
    [{ roleId: 'custom:team-editor', permissions: ['work-items.read', 'work-items.write'], kind: 'team', targetId: 'core-team' }],
    [
      { roleId: 'custom:reader', permissions: ['work-items.read'], kind: 'workspace', targetId: WORKSPACE_ID },
      { roleId: 'custom:team-editor', permissions: ['work-items.read', 'work-items.write'], kind: 'team', targetId: 'core-team' },
    ],
  ] satisfies TestRoleGrant[][]) {
    setTestAppDependencies({ enterpriseIdentity: await createWorkItemRoleIdentity(WORKSPACE_ID, grants) })
    expect((await planningApiRequest(`/api/collections/${collectionId}`, 'PATCH', { expectedRevision: revision, name: 'Renamed' })).status).toBe(403)
    expect((await planningApiRequest(`/api/collections/${collectionId}?expectedRevision=${revision}`, 'DELETE')).status).toBe(403)
    expect((await planningApiRequest(`/api/collections/${collectionId}/items/core-team/onboarding-friction`, 'PUT')).status).toBe(403)
  }
})

test('does not let a Team or Project segment in a Collection item path select a narrower grant', async () => {
  configureFakeProjectClients(false, {
    directoryId: WORKSPACE_ID,
    workspaceRole: 'admin',
    projectAccesses: [],
    teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
  })
  const { collectionId } = await createCollection('Launch')
  const itemsPath = `/api/collections/${collectionId}/items`
  // `projects/refero` and `teams/core-team` are a Team ID and a Work Item ID here, not resources.
  for (const grant of [
    { roleId: 'custom:project-editor', permissions: ['work-items.read', 'work-items.write'], kind: 'project', targetId: 'refero' },
    { roleId: 'custom:team-editor', permissions: ['work-items.read', 'work-items.write'], kind: 'team', targetId: 'core-team' },
  ] satisfies TestRoleGrant[]) {
    setTestAppDependencies({ enterpriseIdentity: await createWorkItemRoleIdentity(WORKSPACE_ID, [grant]) })
    for (const path of [`${itemsPath}/projects/refero`, `${itemsPath}/teams/core-team`]) {
      expect((await planningApiRequest(path, 'PUT')).status).toBe(403)
      expect((await planningApiRequest(path, 'DELETE')).status).toBe(403)
    }
  }
})

test('fences an item change on the Project membership that authorized reading the Work Item', async () => {
  // A non-Enterprise member reads the Refero Work Item only through Refero membership.
  configureMember()
  const { collectionId } = await createCollection('Launch')
  const itemsPath = `/api/collections/${collectionId}/items`
  const existingProjectDirectory = getTestAppDependencies().workspace.projectDirectory
  const fenced: unknown[] = []
  let membershipRevoked = false
  setTestAppDependencies({
    projectDirectory: {
      ...existingProjectDirectory,
      async createProjectAccessConditionCheck(directoryId, projectId, memberKey, minimumRole) {
        fenced.push([projectId, minimumRole])
        // The membership was revoked after the readability check: nothing to fence on.
        if (membershipRevoked) return undefined
        return await existingProjectDirectory.createProjectAccessConditionCheck?.(directoryId, projectId, memberKey, minimumRole)
      },
    },
  })

  membershipRevoked = true
  const revoked = await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'PUT')
  expect(revoked.status).toBe(409)
  expect(await revoked.json()).toMatchObject({ code: 'CollectionWorkItemChanged' })
  expect((await getTestAppDependencies().workItems.collections.get(WORKSPACE_ID, collectionId))?.items).toEqual([])

  membershipRevoked = false
  fenced.length = 0
  expect((await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'PUT')).status).toBe(200)
  expect(fenced).toEqual([['refero', 'viewer']])
  membershipRevoked = true
  expect((await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'DELETE')).status).toBe(409)
  expect((await getTestAppDependencies().workItems.collections.get(WORKSPACE_ID, collectionId))?.items).toHaveLength(1)
})

test('fences an item change on the authorizing Project staying active', async () => {
  // Archiving a Project changes the Project row, not the member's membership row.
  configureMember()
  const { collectionId } = await createCollection('Launch')
  const itemPath = `/api/collections/${collectionId}/items/core-team/onboarding-friction`
  const existingProjectDirectory = getTestAppDependencies().workspace.projectDirectory
  const fenced: unknown[] = []
  let projectArchived = false
  setTestAppDependencies({
    projectDirectory: {
      ...existingProjectDirectory,
      async createActiveReferenceConditionChecks(directoryId, teamId, projectId) {
        fenced.push([teamId, projectId])
        // The Project was archived after the readability check.
        if (projectArchived) throw new ProjectDataError(404, 'ProjectNotFound', 'Project was not found.')
        return await existingProjectDirectory.createActiveReferenceConditionChecks?.(directoryId, teamId, projectId) ?? []
      },
    },
  })

  projectArchived = true
  const archived = await planningApiRequest(itemPath, 'PUT')
  expect(archived.status).toBe(409)
  expect(await archived.json()).toMatchObject({ code: 'CollectionWorkItemChanged' })
  expect((await getTestAppDependencies().workItems.collections.get(WORKSPACE_ID, collectionId))?.items).toEqual([])

  projectArchived = false
  fenced.length = 0
  expect((await planningApiRequest(itemPath, 'PUT')).status).toBe(200)
  expect(fenced).toEqual([['core-team', 'refero']])
})

test('reloads Project access before retrying an item change after a membership is revoked', async () => {
  /**
   * Configures a member whose Project grants are revoked once their membership is fenced.
   *
   * @param grants - Projects that grant the member the core Team.
   * @returns The Collection items path and the fenced Projects.
   */
  const configureRevocableMember = async (grants: string[]) => {
    configureFakeProjectClients(true, {
      directoryId: WORKSPACE_ID,
      teamProjects: grants.map((id) => ({ id, name: id, tone: 'blue' })),
      projectAccesses: grants.map((projectId) => ({ teamId: 'core-team', projectId, role: 'member' })),
      unassignedIssue: true,
    })
    const { collectionId } = await createCollection('Launch')
    const existingProjectDirectory = getTestAppDependencies().workspace.projectDirectory
    const granted = new Set(grants)
    const fenced: string[] = []
    setTestAppDependencies({
      projectDirectory: {
        ...existingProjectDirectory,
        async getProjectAccessList(directoryId, memberKey) {
          const accesses = await existingProjectDirectory.getProjectAccessList(directoryId, memberKey)
          return accesses.filter((access) => granted.has(access.projectId))
        },
        async createProjectAccessConditionCheck(directoryId, projectId, memberKey, minimumRole) {
          fenced.push(projectId)
          // The first fenced grant is revoked after the readability check that relied on it.
          if (fenced.length === 1) granted.delete(projectId)
          if (!granted.has(projectId)) return undefined
          return await existingProjectDirectory.createProjectAccessConditionCheck?.(directoryId, projectId, memberKey, minimumRole)
        },
      },
    })
    return { itemsPath: `/api/collections/${collectionId}/items`, collectionId, fenced }
  }

  // With no other grant, the retry finds the Work Item unreadable: the documented not-found.
  const revoked = await configureRevocableMember(['refero'])
  const notFound = await planningApiRequest(`${revoked.itemsPath}/core-team/onboarding-friction`, 'PUT')
  expect(notFound.status).toBe(404)
  expect(await notFound.json()).toMatchObject({ code: 'CollectionWorkItemNotFound' })
  expect(revoked.fenced).toEqual(['refero'])
  expect((await getTestAppDependencies().workItems.collections.get(WORKSPACE_ID, revoked.collectionId))?.items).toEqual([])

  // Another qualifying grant authorizes the retry instead of the stale snapshot.
  resetTestApp()
  const switched = await configureRevocableMember(['refero', 'alpha'])
  expect((await planningApiRequest(`${switched.itemsPath}/core-team/onboarding-friction`, 'PUT')).status).toBe(200)
  expect(switched.fenced).toEqual(['refero', 'alpha'])
  expect((await getTestAppDependencies().workItems.collections.get(WORKSPACE_ID, switched.collectionId))?.items).toHaveLength(1)
})

test('looks an exact candidate up only in readable Teams, beyond the first hundred Teams', async () => {
  // 101 Teams: the member can read only the last one, through its single Project.
  const additionalTeams = Array.from({ length: 100 }, (_, index) => ({
    id: `team-${index}`,
    name: `Team ${index}`,
    projects: [{ id: `project-${index}`, name: `Project ${index}`, tone: 'blue' as const }],
  }))
  configureFakeProjectClients(true, {
    directoryId: WORKSPACE_ID,
    additionalTeams,
    projectAccesses: [{ teamId: 'team-99', projectId: 'project-99', role: 'viewer' }],
    detailAssignedProjectIds: { 'onboarding-friction': 'project-99' },
  })
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  const detailReads: string[] = []
  setTestAppDependencies({
    teamIssues: {
      ...teamIssues,
      async getTeamIssueDetail(workspaceId, teamId, issueId, options) {
        detailReads.push(teamId)
        return await teamIssues.getTeamIssueDetail(workspaceId, teamId, issueId, options)
      },
    },
    workspaceSearch: {
      ...getTestAppDependencies().workItems.workspaceSearch,
      async search() {
        return { schemaVersion: 1, results: [] }
      },
    },
  })
  const response = await planningApiRequest('/api/collections/candidates?keyword=onboarding-friction')
  expect(response.status).toBe(200)
  expect((await response.json()).results).toEqual([expect.objectContaining({ id: 'team/team-99/issue/onboarding-friction', projectId: 'project-99' })])
  // No Work Item row is read in a Team the member cannot read.
  expect(detailReads).toEqual(['team-99'])
})
