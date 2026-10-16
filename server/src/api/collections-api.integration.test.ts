import type { EnterprisePermissionId, EnterpriseRoleAssignment, WorkspaceSearchResult } from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { InMemoryEnterpriseIdentityClient } from '../modules/enterprise-identity/enterprise-identity'
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
  expect((await added.json()).revision).toBe(2)
  const again = await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'PUT')
  expect((await again.json()).revision).toBe(2)

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

  // An indexed match is not repeated, and later pages read the index only.
  indexed = [{ ...exact, title: 'Indexed title' }]
  expect((await (await planningApiRequest('/api/collections/candidates?keyword=onboarding-friction')).json()).results)
    .toEqual(indexed)
  indexed = []
  expect((await (await planningApiRequest('/api/collections/candidates?keyword=onboarding-friction&cursor=next')).json()).results)
    .toEqual([])

  // A Work Item the caller cannot read is never offered by its ID.
  expect((await (await planningApiRequest('/api/collections/candidates?keyword=hidden-item')).json()).results).toEqual([])
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
  const { collectionId } = await createCollection('Launch')
  const itemsPath = `/api/collections/${collectionId}/items`
  expect((await planningApiRequest(`${itemsPath}/core-team/onboarding-friction`, 'PUT')).status).toBe(200)
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
