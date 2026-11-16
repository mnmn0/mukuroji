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
 * @returns The HTTP response.
 */
function patchWorkItem(body: Record<string, unknown>) {
  return app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, expectedRevision: 1 }),
  })
}

test('records and clears remaining effort and manual progress', async () => {
  const updates: unknown[] = []
  configureFakeProjectClients(true, {
    issueUpdateHook: (input) => {
      updates.push({ remainingEffortMinutes: input.remainingEffortMinutes, progressPercent: input.progressPercent })
    },
  })
  const recorded = await patchWorkItem({ remainingEffortMinutes: 90, progressPercent: 40 })
  expect(recorded.status).toBe(200)
  expect((await recorded.json()).issue).toMatchObject({ remainingEffortMinutes: 90, progressPercent: 40 })
  const cleared = await patchWorkItem({ remainingEffortMinutes: null, progressPercent: null })
  expect(cleared.status).toBe(200)
  expect(updates).toEqual([
    { remainingEffortMinutes: 90, progressPercent: 40 },
    { remainingEffortMinutes: null, progressPercent: null },
  ])
})

test('rejects invalid remaining effort and progress without writing', async () => {
  let writes = 0
  configureFakeProjectClients(true, {
    issueUpdateHook: () => {
      writes += 1
    },
  })
  for (const [body, code] of [
    [{ remainingEffortMinutes: -1 }, 'InvalidWorkItemEffort'],
    [{ remainingEffortMinutes: 1.5 }, 'InvalidWorkItemEffort'],
    [{ remainingEffortMinutes: '60' }, 'InvalidWorkItemEffort'],
    [{ progressPercent: 101 }, 'InvalidWorkItemProgress'],
    [{ progressPercent: 50.5 }, 'InvalidWorkItemProgress'],
  ] as const) {
    const response = await patchWorkItem(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code })
  }
  expect(writes).toBe(0)
})
