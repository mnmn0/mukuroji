import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(404)
  expect(new Set(inventory).size).toBe(400)
  expect(inventory.filter((route) => route === 'ALL /api/*')).toHaveLength(5)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    '39324a64e15647dd68173225e1cb17f83baccc883b9a57be69d3ca66c76f68f2',
  )
})
