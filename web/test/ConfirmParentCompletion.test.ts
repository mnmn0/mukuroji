import { expect, test } from 'bun:test'
import { confirmParentCompletion } from '../src/issues/mutations/confirmParentCompletion'

const workItem = { id: 'phase-1', teamId: 'core-team', statusCategory: 'started' as const }

/**
 * Runs the check with a fixed open child count and records what it asked.
 *
 * @param overrides - Inputs replacing the defaults.
 * @param count - Open child count the fake API returns, or an error to throw.
 * @param answer - Answer given when asked.
 * @returns The result, the counted Work Item IDs, and the counts the person was asked about.
 */
async function check(
  overrides: Partial<Parameters<typeof confirmParentCompletion>[0]>,
  count: number | Error = 2,
  answer = false,
) {
  const counted: string[] = []
  const asked: Array<number | null> = []
  const result = await confirmParentCompletion({
    workItem,
    nextStatusCategory: 'completed',
    configuration: undefined,
    accessToken: 'token',
    confirm: (openChildCount) => {
      asked.push(openChildCount)
      return answer
    },
    countOpenChildren: async (_teamId, workItemId) => {
      counted.push(workItemId)
      if (count instanceof Error) throw count
      return count
    },
    ...overrides,
  })
  return { result, counted, asked }
}

test('asks before completing a parent with open children under the default warn policy', async () => {
  expect(await check({})).toEqual({ result: false, counted: ['phase-1'], asked: [2] })
  expect((await check({}, 2, true)).result).toBe(true)
})

test('asks when a canceled parent with open children moves to completed', async () => {
  expect(await check({ workItem: { ...workItem, statusCategory: 'canceled' } }))
    .toEqual({ result: false, counted: ['phase-1'], asked: [2] })
})

test('does not ask when nothing is open, the change does not complete, or the Team rejects', async () => {
  expect(await check({}, 0)).toEqual({ result: true, counted: ['phase-1'], asked: [] })
  expect(await check({ nextStatusCategory: 'started' })).toEqual({ result: true, counted: [], asked: [] })
  expect(await check({ nextStatusCategory: undefined })).toEqual({ result: true, counted: [], asked: [] })
  expect(await check({ workItem: { ...workItem, statusCategory: 'completed' } }))
    .toEqual({ result: true, counted: [], asked: [] })
  expect(await check({ configuration: { parentCompletionPolicy: 'reject' } }))
    .toEqual({ result: true, counted: [], asked: [] })
})

test('still asks, without a count, when the open children cannot be counted', async () => {
  expect(await check({}, new Error('offline'))).toEqual({ result: false, counted: ['phase-1'], asked: [null] })
  expect(await check({}, new Error('offline'), true))
    .toEqual({ result: true, counted: ['phase-1'], asked: [null] })
})
