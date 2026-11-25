import { afterEach, expect, test } from 'bun:test'
import { getWorkspaceMemberOffboarding } from '../src/workspace/api/members'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const summary = {
  memberKey: 'leaver@example.com',
  accessExpired: false,
  managedProjects: [{ teamId: 'core', projectId: 'refero', name: 'Refero' }],
  ownedPlanningEntities: [{ id: 'cycle-1', type: 'cycle', title: 'Cycle 1' }],
  planningRevision: 1,
  managesPrivateDocuments: false,
  credentials: [{ id: 'key-1', kind: 'api-key', name: 'CI' }],
  webhooks: [{ id: 'hook-1', name: 'Mine' }],
  canDeactivate: false,
}

/**
 * Answers every request with one JSON body.
 *
 * @param body - Response body.
 */
function stubResponse(body: unknown) {
  globalThis.fetch = Object.assign(
    async () => new Response(JSON.stringify(body)),
    { preconnect: originalFetch.preconnect },
  )
}

test('reads a well-formed handover summary', async () => {
  stubResponse(summary)

  expect(await getWorkspaceMemberOffboarding('token', 'leaver@example.com')).toEqual(summary)
})

test.each([
  ['managedProjects', [...summary.managedProjects, { projectId: 7 }]],
  ['ownedPlanningEntities', [...summary.ownedPlanningEntities, { id: 'cycle-2', type: 'cycle' }]],
  ['credentials', [...summary.credentials, { id: 'key-2', kind: 'api-key', name: 42 }]],
  ['webhooks', [...summary.webhooks, { id: 'hook-2' }]],
])('fails the whole summary when one %s element is malformed, instead of dropping it', async (field, value) => {
  stubResponse({ ...summary, [field]: value })

  await expect(getWorkspaceMemberOffboarding('token', 'leaver@example.com')).rejects.toMatchObject({ status: 502 })
})
