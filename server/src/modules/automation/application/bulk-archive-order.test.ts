import { expect, test } from 'bun:test'
import { orderBulkArchiveItems } from './bulk-archive-order'

const parents = new Map([
  ['child', 'parent'],
  ['grandchild', 'child'],
  ['parent', 'outside'],
])

/**
 * Reads the parent of a fixture Work Item.
 *
 * @param _teamId - Team of the Work Item.
 * @param workItemId - Work Item whose parent is read.
 * @returns The fixture parent, if any.
 */
async function readParent(_teamId: string, workItemId: string) {
  return parents.get(workItemId)
}

const items = ['parent', 'other', 'grandchild', 'child'].map((workItemId) => ({
  teamId: 'core',
  workItemId,
  expectedRevision: 1,
}))

test('archives the deepest items of a Bulk archive first and keeps request order among equals', async () => {
  expect(await orderBulkArchiveItems(items, true, readParent)).toEqual([2, 3, 0, 1])
})

test('restores the shallowest items of a Bulk restore first', async () => {
  expect(await orderBulkArchiveItems(items, false, readParent)).toEqual([0, 1, 3, 2])
})

test('does not loop on a parent cycle among the items', async () => {
  const cycle = new Map([['a', 'b'], ['b', 'a']])
  const order = await orderBulkArchiveItems(
    [{ teamId: 'core', workItemId: 'a' }, { teamId: 'core', workItemId: 'b' }],
    true,
    async (_teamId, workItemId) => cycle.get(workItemId),
  )
  expect([...order].sort()).toEqual([0, 1])
})

test('does not treat a Work Item of another Team as a parent among the items', async () => {
  const order = await orderBulkArchiveItems(
    [{ teamId: 'other', workItemId: 'parent' }, { teamId: 'core', workItemId: 'child' }],
    true,
    readParent,
  )
  expect(order).toEqual([0, 1])
})
