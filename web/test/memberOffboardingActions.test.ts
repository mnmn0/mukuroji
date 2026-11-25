import { afterEach, expect, test } from 'bun:test'
import type { WorkspaceMemberOffboarding } from '@mukuroji/contracts'
import { createMemberOffboardingActions } from '../src/workspace/mutations/useMemberOffboardingActions'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const offboarding: WorkspaceMemberOffboarding = {
  memberKey: 'leaver@example.com',
  accessExpired: true,
  managedProjects: [{ projectId: 'refero' }],
  ownedPlanningEntities: [],
  planningRevision: 1,
  managesPrivateDocuments: false,
  credentials: [],
  webhooks: [],
  canDeactivate: false,
}

/**
 * Stubs the Project member API, answering each role change or failing every request.
 *
 * @param fail - Whether every request fails.
 * @returns The PATCH bodies sent, by request URL.
 */
function stubProjectMemberApi(fail: boolean) {
  const requests: Array<{ url: string, body: unknown }> = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ url, body })
    if (fail) return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 })
    const role = typeof body === 'object' && body !== null && 'role' in body ? body.role : undefined
    const memberKey = decodeURIComponent(url.split('/').pop() ?? '')
    return new Response(JSON.stringify({
      member: { id: memberKey, email: memberKey, role, updatedAt: '2026-11-24T00:00:00.000Z' },
    }))
  }, { preconnect: originalFetch.preconnect })
  return requests
}

test('reads the summary and the member list again after a Project handover', async () => {
  const requests = stubProjectMemberApi(false)
  const reloads: string[] = []
  const actions = createMemberOffboardingActions(
    'token',
    'leaver@example.com',
    async () => reloads.push('summary'),
    async () => reloads.push('members'),
  )

  await actions.transferProjects(offboarding, 'successor@example.com')

  // The successor is made a manager before the leaver is lowered.
  expect(requests.map((request) => [request.url.split('/members/').pop(), request.body])).toEqual([
    ['successor%40example.com', { role: 'manager' }],
    ['leaver%40example.com', { role: 'member' }],
  ])
  // Both role changes raised Workspace member versions the member list must show.
  expect(reloads.sort()).toEqual(['members', 'summary'])
})

test('reads the member list again even when a handover step fails', async () => {
  stubProjectMemberApi(true)
  const reloads: string[] = []
  const actions = createMemberOffboardingActions(
    'token',
    'leaver@example.com',
    async () => reloads.push('summary'),
    async () => reloads.push('members'),
  )

  await expect(actions.transferProjects(offboarding, 'successor@example.com')).rejects.toBeDefined()
  expect(reloads.sort()).toEqual(['members', 'summary'])
})
