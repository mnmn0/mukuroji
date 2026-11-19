import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  getTestAppDependencies,
  resetTestApp,
} = createApiTestHarness()
import type { ProjectRaidEntryResponse, ProjectRaidLogResponse } from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/**
 * Finds a Project of the fake Team that the demo user may use.
 *
 * @returns The Project ID of the first fake Team Work Item.
 */
async function readProjectId(): Promise<string> {
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(
    'user#demo@example.com',
    'core-team',
  )
  const projectId = issues[0]?.assignedProjectId
  if (!projectId) throw new Error('The fake Team has no Project Work Item.')
  return projectId
}

/**
 * Sends an authenticated request.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @param idempotencyKey - Idempotency key header, if any.
 * @returns The response.
 */
function request(path: string, method = 'GET', body?: unknown, idempotencyKey?: string) {
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('creates, edits, closes, and lists Project log entries', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/raid-log`

  const empty = await request(path)
  expect(empty.status).toBe(200)
  expect(await empty.json()).toEqual({ teamId: 'core-team', projectId, entries: [], viewer: { canEdit: true } })

  const created = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'risk', title: ' Vendor delay ', probability: 4, impact: 4, reviewDueDate: '2026-12-01', status: 'open' },
  }, 'create-1')
  expect(created.status).toBe(201)
  const createdEntry = (await created.json() as ProjectRaidEntryResponse).entry
  expect(createdEntry).toMatchObject({ kind: 'risk', title: 'Vendor delay', probability: 4, impact: 4, revision: 1, status: 'open' })

  const retried = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'risk', title: ' Vendor delay ', probability: 4, impact: 4, reviewDueDate: '2026-12-01', status: 'open' },
  }, 'create-1')
  expect(retried.status).toBe(201)
  expect((await retried.json() as ProjectRaidEntryResponse).entry.id).toBe(createdEntry.id)

  const reused = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'Other', impact: 2, status: 'open' },
  }, 'create-1')
  expect(reused.status).toBe(409)

  const closeBody = {
    expectedRevision: 1,
    entry: { kind: 'risk', title: 'Vendor delay', probability: 2, impact: 4, response: 'Second vendor signed', status: 'closed' },
  }
  const closed = await request(`${path}/entries/${createdEntry.id}`, 'PUT', closeBody, 'close-1')
  expect(closed.status).toBe(200)
  const closedEntry = (await closed.json() as ProjectRaidEntryResponse).entry

  const closeRetried = await request(`${path}/entries/${createdEntry.id}`, 'PUT', closeBody, 'close-1')
  expect(closeRetried.status).toBe(200)
  expect((await closeRetried.json() as ProjectRaidEntryResponse).entry).toEqual(closedEntry)
  expect(closedEntry).toMatchObject({ revision: 2, status: 'closed', response: 'Second vendor signed' })
  expect(closedEntry.reviewDueDate).toBeUndefined()
  expect(typeof closedEntry.closedAt).toBe('string')

  const stale = await request(`${path}/entries/${createdEntry.id}`, 'PUT', {
    expectedRevision: 1,
    entry: { kind: 'risk', title: 'Vendor delay', probability: 2, impact: 4, status: 'open' },
  })
  expect(stale.status).toBe(409)

  const kindChange = await request(`${path}/entries/${createdEntry.id}`, 'PUT', {
    expectedRevision: 2,
    entry: { kind: 'issue', title: 'Vendor delay', impact: 4, status: 'open' },
  })
  expect(kindChange.status).toBe(400)

  const listed = await request(path)
  expect((await listed.json() as ProjectRaidLogResponse).entries).toEqual([closedEntry])
})

test('rejects invalid entries and unknown entry IDs', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/raid-log/entries`

  const invalid = await request(path, 'POST', { entry: { kind: 'risk', title: 'No probability', impact: 3, status: 'open' } })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ code: 'InvalidProjectRaidEntry' })

  const missing = await request(`${path}/unknown`, 'PUT', {
    expectedRevision: 1,
    entry: { kind: 'issue', title: 'A', impact: 3, status: 'open' },
  })
  expect(missing.status).toBe(404)
})

test('answers 404 for a Project outside the Team', async () => {
  configureFakeProjectClients(true)
  const response = await request('/api/teams/core-team/projects/not-in-team/raid-log')
  expect(response.status).toBe(404)
})

test('lets a Project viewer read the log but not change it', async () => {
  configureFakeProjectClients(true, { projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  const path = '/api/teams/core-team/projects/refero/raid-log'
  const read = await request(path)
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ viewer: { canEdit: false } })
  const response = await request(`${path}/entries`, 'POST', {
    entry: { kind: 'issue', title: 'A', impact: 3, status: 'open' },
  })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'ProjectRaidLogForbidden' })
})

test('refuses a change by a member without Project access', async () => {
  configureFakeProjectClients(false)
  const projectId = await readProjectId()
  const response = await request(`/api/teams/core-team/projects/${projectId}/raid-log/entries`, 'POST', {
    entry: { kind: 'issue', title: 'A', impact: 3, status: 'open' },
  })
  expect([403, 404]).toContain(response.status)
})

test('requires a bearer token', async () => {
  const response = await app.request('/api/teams/core-team/projects/p/raid-log')
  expect(response.status).toBe(401)
})
