import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicWorkItemService } from './api-router'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'

const { configureFakeProjectClients, resetTestApp, runWithTestAppDependencies } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId: 'user#demo@example.com',
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read'],
}

test('the Public API Work Item list keeps only titles that contain every word of query', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 3 })
  const list = (filters: Record<string, string>) => runWithTestAppDependencies(() =>
    createCanonicalPublicWorkItemService().list(credential, { teamId: 'core-team', ...filters }, undefined, 50))

  const unfiltered = await list({})
  const matching = await list({ query: 'ＷＯＲＫ　item 2' })
  const none = await list({ query: 'オンボーディング 存在しない語' })

  expect(unfiltered.items.map((item) => item.id)).toEqual(['onboarding-friction', 'work-item-1', 'work-item-2'])
  expect(matching.items.map((item) => item.id)).toEqual(['work-item-2'])
  expect(none.items).toEqual([])
})
