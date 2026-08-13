import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(352)
  expect(new Set(inventory).size).toBe(348)
  expect(inventory.filter((route) => route === 'ALL /api/*')).toHaveLength(5)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    '70d48b0eba107b3f9bfa920c81a7f5bd1e06ae1592f33c6b2714dbb520a0342c',
  )
})
