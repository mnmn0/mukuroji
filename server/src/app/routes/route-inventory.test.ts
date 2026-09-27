import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(407)
  expect(new Set(inventory).size).toBe(403)
  expect(inventory).toContain('GET /api/v1/work-items/:workItemId/comments')
  expect(inventory).toContain('POST /api/v1/work-items/:workItemId/comments')
  expect(inventory.filter((route) => route === 'ALL /api/*')).toHaveLength(5)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    'e8630fab6b2e4b8b9652d1f5712d2421c1e876718ad5791198d362ece808d0c0',
  )
})
