import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(432)
  expect(new Set(inventory).size).toBe(428)
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
  expect(inventory).toContain('GET /api/collections/candidates')
  expect(inventory).toContain('GET /api/collections/:collectionId/items')
  expect(inventory).toContain('PUT /api/collections/:collectionId/items/:teamId/:issueId')
  expect(inventory).toContain('GET /api/push/config')
  expect(inventory).toContain('PUT /api/push-subscriptions')
  expect(inventory).toContain('DELETE /api/push-subscriptions')
  expect(inventory.filter((route) => route === 'ALL /api/*')).toHaveLength(5)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    '81f6791a8438190a6e189cb8156e51023023aeeb9b38e06dcd17d4b7533ca08a',
  )
})
