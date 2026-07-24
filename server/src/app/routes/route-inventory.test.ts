import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(279)
  expect(new Set(inventory).size).toBe(276)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    'ca2624b304dbe0182627cea81fc7c20b2aa2063187d1729936e9a5fc0a8fcc21',
  )
})
