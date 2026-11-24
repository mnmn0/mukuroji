import { afterEach, expect, test } from 'bun:test'
import { createDefaultDueDateWorkItemSchedule, type WorkItemAcceptanceCriterion } from '@mukuroji/contracts'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'

const { app, configureFakeProjectClients, resetTestApp } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const stored: WorkItemAcceptanceCriterion = { id: 'a'.repeat(32), text: 'Tests pass', satisfied: false }

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

test('replaces acceptance criteria, keeping existing IDs and assigning new ones', async () => {
  const updates: unknown[] = []
  configureFakeProjectClients(true, {
    detailAcceptanceCriteria: [stored],
    issueUpdateHook: (input) => {
      updates.push(input.acceptanceCriteria)
    },
  })
  const response = await patchWorkItem({
    acceptanceCriteria: [{ id: stored.id, text: 'Tests pass on CI', satisfied: true }, { text: ' Docs updated ' }],
  })
  expect(response.status).toBe(200)
  const sent = updates[0]
  expect(sent).toMatchObject([{ id: stored.id, text: 'Tests pass on CI', satisfied: true }, { text: 'Docs updated', satisfied: false }])
  expect(Array.isArray(sent) && typeof sent[1]?.id === 'string' && /^[0-9a-f]{32}$/u.test(sent[1].id)).toBe(true)
  expect((await response.json()).issue.acceptanceCriteria).toEqual(sent)
})

test('removes every criterion with an empty list', async () => {
  const updates: unknown[] = []
  configureFakeProjectClients(true, {
    detailAcceptanceCriteria: [stored],
    issueUpdateHook: (input) => {
      updates.push(input.acceptanceCriteria)
    },
  })
  const response = await patchWorkItem({ acceptanceCriteria: [] })
  expect(response.status).toBe(200)
  expect(updates).toEqual([[]])
  expect((await response.json()).issue).not.toHaveProperty('acceptanceCriteria')
})

test('rejects invented IDs, invalid criteria, and stale revisions without writing', async () => {
  let writes = 0
  configureFakeProjectClients(true, {
    detailAcceptanceCriteria: [stored],
    issueUpdateHook: () => {
      writes += 1
    },
  })
  for (const acceptanceCriteria of [
    [{ id: 'b'.repeat(32), text: 'Invented' }],
    [{ text: '   ' }],
    [{ text: 'x'.repeat(1025) }],
    [{ text: 'Done', satisfied: 'yes' }],
    [{ text: 'Done', note: 'extra' }],
    [stored, stored],
    Array.from({ length: 21 }, (_, index) => ({ text: `Condition ${index}` })),
    'Tests pass',
  ]) {
    const response = await patchWorkItem({ acceptanceCriteria })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidAcceptanceCriteria' })
  }
  expect((await patchWorkItem({ acceptanceCriteria: [stored] }, 2)).status).toBe(409)
  expect(writes).toBe(0)
})

/**
 * Creates a Work Item in the fake Team with the given acceptance criteria.
 *
 * @param acceptanceCriteria - Untrusted `acceptanceCriteria` create value.
 * @returns The HTTP response.
 */
function createWorkItem(acceptanceCriteria: unknown) {
  return app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Plan the launch',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      acceptanceCriteria,
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })
}

test('creates a Work Item with acceptance criteria and assigns their IDs', async () => {
  const creates: unknown[] = []
  configureFakeProjectClients(true, {
    issueCreateHook: (input) => {
      creates.push(input.acceptanceCriteria)
    },
  })
  const response = await createWorkItem([{ text: ' Tests pass ' }, { text: 'Docs updated', satisfied: true }])
  expect(response.status).toBe(201)
  const { issue } = await response.json()
  expect(issue.acceptanceCriteria).toEqual([
    { id: expect.stringMatching(/^[0-9a-f]{32}$/u), text: 'Tests pass', satisfied: false },
    { id: expect.stringMatching(/^[0-9a-f]{32}$/u), text: 'Docs updated', satisfied: true },
  ])
  expect(creates).toEqual([issue.acceptanceCriteria])
})

test('creates a Work Item without criteria from an empty list', async () => {
  const creates: unknown[] = []
  configureFakeProjectClients(true, {
    issueCreateHook: (input) => {
      creates.push(input.acceptanceCriteria)
    },
  })
  const response = await createWorkItem([])
  expect(response.status).toBe(201)
  expect((await response.json()).issue).not.toHaveProperty('acceptanceCriteria')
  expect(creates).toEqual([undefined])
})

test('rejects IDs and invalid criteria on create without writing', async () => {
  let writes = 0
  configureFakeProjectClients(true, {
    issueCreateHook: () => {
      writes += 1
    },
  })
  for (const acceptanceCriteria of [
    [{ id: stored.id, text: 'Copied ID' }],
    [{ text: '   ' }],
    [{ text: 'x'.repeat(1025) }],
    [{ text: 'Done', satisfied: 'yes' }],
    [{ text: 'Done', note: 'extra' }],
    Array.from({ length: 21 }, (_, index) => ({ text: `Condition ${index}` })),
    'Tests pass',
  ]) {
    const response = await createWorkItem(acceptanceCriteria)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidAcceptanceCriteria' })
  }
  expect(writes).toBe(0)
})
