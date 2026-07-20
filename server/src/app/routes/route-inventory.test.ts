import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createApp, createTestAppDependencies } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(277)
  expect(new Set(inventory).size).toBe(275)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    'edd9ee6542d767cb2eaf3a4096b0ba591c864e1b66e3994bf6aaa1e44e3d9b1f',
  )
})
