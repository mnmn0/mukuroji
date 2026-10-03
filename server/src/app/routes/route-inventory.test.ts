import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(417)
  expect(new Set(inventory).size).toBe(413)
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
  expect(inventory).toContain('POST /api/v1/work-items/:workItemId/comments')
  expect(inventory.filter((route) => route === 'ALL /api/*')).toHaveLength(5)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    'f0599e39234cce50e5c070845149d0fe775d7d764984d91ef414380b3520725a',
  )
})
