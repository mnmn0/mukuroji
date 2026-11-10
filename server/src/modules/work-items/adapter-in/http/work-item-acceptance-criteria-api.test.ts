import { afterEach, expect, test } from 'bun:test'
import type { WorkItemAcceptanceCriterion } from '@mukuroji/contracts'
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
