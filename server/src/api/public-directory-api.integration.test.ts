import { afterEach, describe, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicDirectoryService } from './shared/public-directory-access'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'

const {
  configureFakeProjectClients,
  resetTestApp,
  runWithTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const workspaceId = 'user#demo@example.com'
const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId,
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read'],
}

describe('Public API directory', () => {
  test('reads the credential owner from the Workspace membership', async () => {
    configureFakeProjectClients(true, { directoryId: workspaceId })

    const owner = await runWithTestAppDependencies(() => createCanonicalPublicDirectoryService()
      .getCredentialOwner(credential))

    expect(owner).toMatchObject({ schemaVersion: 1, workspaceId, memberId: 'demo@example.com', email: 'demo@example.com' })
  })

  test('lists only the Projects the credential owner can view and the Teams that hold them', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
      teamProjects: [
        { id: 'refero', name: 'Refero', tone: 'blue' },
        { id: 'hidden', name: 'Hidden', tone: 'blue' },
      ],
      additionalTeams: [{ id: 'other-team', name: 'Other', projects: [{ id: 'secret', name: 'Secret', tone: 'blue' }] }],
    })

    const teams = await runWithTestAppDependencies(() => createCanonicalPublicDirectoryService()
      .listTeams(credential, 'en'))

    expect(teams).toEqual({
      schemaVersion: 1,
      items: [{
        id: 'core-team',
        name: 'Core Team',
        projects: [{ id: 'refero', name: 'Refero', lifecycleState: 'active' }],
      }],
    })
  })

  test('matches access by Team, so a Project ID shared with another Team stays hidden', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'viewer', teamId: 'core-team' }],
      role: 'viewer',
      workspaceRole: 'member',
      teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      additionalTeams: [{ id: 'other-team', name: 'Other', projects: [{ id: 'refero', name: 'Other Refero', tone: 'blue' }] }],
    })

    const teams = await runWithTestAppDependencies(() => createCanonicalPublicDirectoryService()
      .listTeams(credential, 'en'))

    expect(teams.items.map((team) => ({ id: team.id, projects: team.projects.map((project) => project.name) })))
      .toEqual([{ id: 'core-team', projects: ['Refero'] }])

    resetTestApp()
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
      teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      additionalTeams: [{ id: 'other-team', name: 'Other', projects: [{ id: 'refero', name: 'Other Refero', tone: 'blue' }] }],
    })
    const legacy = await runWithTestAppDependencies(() => createCanonicalPublicDirectoryService()
      .listTeams(credential, 'en'))
    expect(legacy.items.flatMap((team) => team.projects)).toEqual([])
  })

  test('lists active Project members for a member of the Project and refuses a viewer', async () => {
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'member' }],
      role: 'member',
      workspaceRole: 'member',
    })

    const members = await runWithTestAppDependencies(() => createCanonicalPublicDirectoryService()
      .listProjectMembers(credential, 'core-team', 'refero'))

    expect(members).toMatchObject({
      schemaVersion: 1,
      teamId: 'core-team',
      projectId: 'refero',
      items: [{ id: 'demo@example.com', email: 'demo@example.com', role: 'manager' }],
    })

    resetTestApp()
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    await expect(runWithTestAppDependencies(() => createCanonicalPublicDirectoryService()
      .listProjectMembers(credential, 'core-team', 'refero'))).rejects.toMatchObject({ status: 403 })
  })

  test('resolves a readable key and answers 404 alike for unused, stale, and unreadable keys', async () => {
    const locations = {
      'CT-11': { key: 'CT-11', teamId: 'core-team', workItemId: 'onboarding-friction' },
      'CT-12': { key: 'CT-12', teamId: 'core-team', workItemId: 'onboarding-friction' },
    }
    configureFakeProjectClients(true, {
      directoryId: workspaceId,
      workItemKeyLocations: locations,
      detailKeys: { 'onboarding-friction': 'CT-12' },
    })
    const service = createCanonicalPublicDirectoryService()

    expect(await runWithTestAppDependencies(() => service.lookupWorkItemKey(credential, 'ct-12'))).toEqual({
      schemaVersion: 1, key: 'CT-12', teamId: 'core-team', workItemId: 'onboarding-friction',
    })
    await expect(runWithTestAppDependencies(() => service.lookupWorkItemKey(credential, 'CT-99')))
      .rejects.toMatchObject({ status: 404 })
    await expect(runWithTestAppDependencies(() => service.lookupWorkItemKey(credential, 'CT-11')))
      .rejects.toMatchObject({ status: 404 })

    resetTestApp()
    configureFakeProjectClients(false, {
      directoryId: workspaceId,
      workItemKeyLocations: locations,
      detailKeys: { 'onboarding-friction': 'CT-12' },
    })
    await expect(runWithTestAppDependencies(() => createCanonicalPublicDirectoryService()
      .lookupWorkItemKey(credential, 'CT-12'))).rejects.toMatchObject({ status: 404 })
  })
})
