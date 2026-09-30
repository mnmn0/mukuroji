import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { createTestAppDependencies } from '../composition/api-dependencies'
import { createApp } from '../createApp'

test('preserves the complete HTTP method and canonical path inventory', () => {
  const application = createApp(createTestAppDependencies())
  const inventory = application.routes
    .map(({ method, path }) => `${method} ${path}`)
    .sort()

  expect(inventory).toHaveLength(406)
  expect(new Set(inventory).size).toBe(402)
  expect(inventory).toContain('GET /api/v1/work-items/:workItemId/comments')
  expect(inventory).toContain('POST /api/v1/work-items/:workItemId/comments')
  expect(inventory.filter((route) => route === 'ALL /api/*')).toHaveLength(5)
  expect(createHash('sha256').update(inventory.join('\n')).digest('hex')).toBe(
    '14a1f9cb880f5a8614e4969ebca38f9e6074aa04bd543fc8f4faab9e9e910fb2',
  )
})
