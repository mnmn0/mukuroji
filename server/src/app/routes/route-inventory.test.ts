import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(421)
  expect(new Set(inventory).size).toBe(417)
  expect(inventory).toContain('GET /api/planning/update-feed')
  expect(inventory).toContain('PUT /api/planning/update-feed/read-state')
  expect(inventory).toContain('GET /api/planning/update-feed/saved')
  expect(inventory).toContain('PUT /api/planning/update-feed/saved')
  expect(inventory).toContain('GET /api/planning/update-feed/options')
  expect(inventory).toContain('GET /api/planning/update-feed/digest')
  expect(inventory).toContain('PUT /api/planning/update-feed/digest')
  expect(inventory).toContain('POST /api/planning/update-feed/digest/preview')
  expect(inventory).toContain('GET /api/planning/update-feed/digest/inbox')
  expect(inventory).toContain('PUT /api/planning/update-feed/digest/inbox')
  expect(inventory).toContain('GET /api/v1/work-items/:workItemId/comments')
  expect(inventory).toContain('POST /api/audit/exports')
  expect(inventory).toContain('GET /api/audit/exports/:exportId/download')
  expect(inventory).toContain('POST /api/v1/work-items/:workItemId/comments')
  expect(inventory.filter((route) => route === 'ALL /api/*')).toHaveLength(5)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    '096775e68e2113c9bf3a4d2fa9d8535f4c3f829a99e3c1ccb25c92fcc2f07ced',
  )
})
