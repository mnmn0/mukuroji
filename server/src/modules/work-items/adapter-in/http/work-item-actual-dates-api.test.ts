import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'

const { app, configureFakeProjectClients, resetTestApp } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/**
 * Sends a Work Item update to the first fake Team Work Item.
 *
 * @param body - JSON update body.
 * @param expectedRevision - Revision the client read.
 * @returns The HTTP response.
 */
function patchWorkItem(body: Record<string, unknown>, expectedRevision = 1) {
  return app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, expectedRevision }),
  })
}

test('passes a Project manager correction of the actual dates to the adapter', async () => {
  const corrections: unknown[] = []
  configureFakeProjectClients(true, {
    role: 'manager',
    issueUpdateHook: (input) => {
      corrections.push(input.actualDateCorrection)
    },
  })

  const response = await patchWorkItem({ actualStartDate: '2026-11-02', actualEndDate: null })

  expect(response.status).toBe(200)
  expect(corrections).toEqual([{ actualStartDate: '2026-11-02', actualEndDate: null }])
})

test('rejects a correction from a Project member without writing', async () => {
  let writes = 0
  configureFakeProjectClients(true, {
    role: 'member',
    issueUpdateHook: () => {
      writes += 1
    },
  })

  const response = await patchWorkItem({ actualStartDate: '2026-11-02' })

  expect(response.status).toBe(403)
  expect(writes).toBe(0)
})

test('rejects malformed values, stale revisions, and the internal correction field', async () => {
  let writes = 0
  configureFakeProjectClients(true, {
    role: 'manager',
    issueUpdateHook: () => {
      writes += 1
    },
  })

  const malformed = await patchWorkItem({ actualStartDate: 20261102 })
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toMatchObject({ code: 'InvalidWorkItemActualDates' })
  expect((await patchWorkItem({ actualStartDate: '2026-11-02' }, 2)).status).toBe(409)
  expect((await patchWorkItem({ actualDateCorrection: { actualStartDate: '2026-11-02' } })).status).toBe(400)
  expect(writes).toBe(0)
})

test('rejects a correction from a manager of another Project in the same Team', async () => {
  let writes = 0
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'refero',
    projectAccesses: [
      { teamId: 'core-team', projectId: 'refero', role: 'member' },
      { teamId: 'core-team', projectId: 'project-2', role: 'manager' },
    ],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'project-2', name: 'Project 2', tone: 'green' },
    ],
    issueUpdateHook: () => {
      writes += 1
    },
  })

  const response = await patchWorkItem({ actualStartDate: '2026-11-02' })

  expect(response.status).toBe(403)
  expect(writes).toBe(0)
})

test('lets a Team manager correct an unassigned Work Item', async () => {
  const corrections: unknown[] = []
  configureFakeProjectClients(true, {
    unassignedIssue: true,
    projectAccesses: [
      { teamId: 'core-team', projectId: 'project-2', role: 'manager' },
    ],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'project-2', name: 'Project 2', tone: 'green' },
    ],
    issueUpdateHook: (input) => {
      corrections.push(input.actualDateCorrection)
    },
  })

  const response = await patchWorkItem({ actualStartDate: '2026-11-02' })

  expect(response.status).toBe(200)
  expect(corrections).toEqual([{ actualStartDate: '2026-11-02' }])
})

test('rejects the internal actual date transition time', async () => {
  let writes = 0
  configureFakeProjectClients(true, {
    role: 'manager',
    issueUpdateHook: () => {
      writes += 1
    },
  })

  const response = await patchWorkItem({ actualDateTransitionAt: '2026-11-02T00:00:00.000Z' })

  expect(response.status).toBe(400)
  expect(writes).toBe(0)
})
