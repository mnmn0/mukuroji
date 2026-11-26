import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicWebLinkService } from './shared/public-web-link-access'
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
  scopes: ['work-items:read', 'work-items:write'],
}

const context = { requestId: 'request-1', idempotencyKey: '00000000-0000-4000-8000-000000000001' }

test('the Public API adds, lists, and removes the web links of a Work Item', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 1 })
  const service = createCanonicalPublicWebLinkService()

  await runWithTestAppDependencies(async () => {
    const added = await service.createWebLink(credential, 'core-team', 'work-item-1', {
      url: 'https://github.com/o/r/pull/1', title: 'Pull request',
    }, context, undefined)
    expect(added).toMatchObject({
      schemaVersion: 1, teamId: 'core-team', workItemId: 'work-item-1',
      link: { url: 'https://github.com/o/r/pull/1', title: 'Pull request', createdByMemberId: 'demo@example.com' },
    })
    expect(added.link.id).toMatch(/^[0-9a-f]{32}$/u)

    await expect(service.createWebLink(credential, 'core-team', 'work-item-1', {
      url: 'https://github.com/o/r/pull/1',
    }, context, undefined)).rejects.toMatchObject({ status: 409, code: 'WorkItemWebLinkDuplicate' })

    const list = await service.listWebLinks(credential, 'core-team', 'work-item-1')
    expect(list.items.map((link) => link.id)).toEqual([added.link.id])

    const removed = await service.deleteWebLink(credential, 'core-team', 'work-item-1', added.link.id, context, undefined)
    expect(removed.link.id).toBe(added.link.id)
    expect((await service.listWebLinks(credential, 'core-team', 'work-item-1')).items).toEqual([])
    await expect(service.deleteWebLink(credential, 'core-team', 'work-item-1', added.link.id, context, undefined))
      .rejects.toMatchObject({ status: 404, code: 'WorkItemWebLinkNotFound' })
  })
})

test('the Public API refuses links on a Work Item the owner cannot read', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 1 })
  const service = createCanonicalPublicWebLinkService()
  await runWithTestAppDependencies(async () => {
    await expect(service.listWebLinks(credential, 'core-team', 'wireframe')).rejects.toBeDefined()
    await expect(service.createWebLink(credential, 'core-team', 'wireframe', {
      url: 'https://example.com/',
    }, context, undefined)).rejects.toBeDefined()
  })
})
