import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(412)
  expect(new Set(inventory).size).toBe(408)
  expect(inventory).toContain('GET /api/planning/update-feed')
  expect(inventory).toContain('PUT /api/planning/update-feed/read-state')
  expect(inventory).toContain('GET /api/planning/update-feed/saved')
  expect(inventory).toContain('PUT /api/planning/update-feed/saved')
  expect(inventory).toContain('GET /api/planning/update-feed/options')
  expect(inventory).toContain('GET /api/v1/work-items/:workItemId/comments')
  expect(inventory).toContain('POST /api/v1/work-items/:workItemId/comments')
  expect(inventory.filter((route) => route === 'ALL /api/*')).toHaveLength(5)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    'f6fe165654d5bba0de8626aa6c0b7a1ab746f032f04c516b1a85bfe3de808bb5',
  )
})
