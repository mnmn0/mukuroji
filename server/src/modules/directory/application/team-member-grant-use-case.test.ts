import { expect, test } from 'bun:test'
import type { DirectoryAdministrationTeam } from '@mukuroji/contracts'
import {
  addMemberToTeamProjectsUseCase,
  type TeamMemberGrantPorts,
} from './team-member-grant-use-case'

const team: DirectoryAdministrationTeam = {
  id: 'core',
  nameJa: 'コア',
  nameEn: 'Core',
  projects: [
    { id: 'alpha', nameJa: 'アルファ', nameEn: 'Alpha', tone: 'blue' },
    { id: 'old', nameJa: '旧', nameEn: 'Old', tone: 'blue', archivedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'beta', nameJa: 'ベータ', nameEn: 'Beta', tone: 'green' },
    { id: 'gamma', nameJa: 'ガンマ', nameEn: 'Gamma', tone: 'green' },
  ],
}

/** One grant the fake store received. */
type Grant = { projectId: string; expectedVersion: number; fences: string[]; audit: string }

/**
 * Creates fake ports over one Team.
 *
 * @param existing - Projects the member already belongs to.
 * @param manageable - Tells whether the caller manages a Project.
 * @returns The ports and the grants they received.
 */
function createPorts(
  existing: string[] = [],
  manageable = (_projectId: string) => true,
  otherTeams: DirectoryAdministrationTeam[] = [],
) {
  const grants: Grant[] = []
  let memberVersion = 10
  const ports: TeamMemberGrantPorts<string, string> = {
    getDirectoryAdministration: async () => ({ teams: [team, ...otherTeams] }),
    addProjectMemberIfAbsent: async (
      _workspaceId, _teamId, projectId, _memberKey, _input, expectedVersion, audit, fences,
    ) => {
      if (existing.includes(projectId)) return { added: false }
      grants.push({ projectId, expectedVersion, fences, audit })
      memberVersion += 1
      return { added: true }
    },
    readActiveMemberVersion: async () => memberVersion,
    canManageProject: (_teamId, projectId) => manageable(projectId),
    createAuditContext: (projectId) => `audit:${projectId}`,
  }
  return { ports, grants }
}

const member = { id: 'sato@example.com', email: 'sato@example.com' }
const caller = { membership: { memberKey: 'admin@example.com', version: 3 }, fences: ['caller'] }

test('adds the member to every active Project, keeping existing roles, fenced by the caller', async () => {
  const { ports, grants } = createPorts(['beta'])

  await expect(addMemberToTeamProjectsUseCase(ports, {
    workspaceId: 'ws', teamId: 'core', member, role: 'member', caller,
  })).resolves.toEqual({
    teamId: 'core',
    memberKey: 'sato@example.com',
    addedProjectIds: ['alpha', 'gamma'],
    existingProjectIds: ['beta'],
  })
  // The member's version is read again before each grant, and each grant has a Project audit context.
  expect(grants).toEqual([
    { projectId: 'alpha', expectedVersion: 10, fences: ['caller'], audit: 'audit:alpha' },
    { projectId: 'gamma', expectedVersion: 11, fences: ['caller'], audit: 'audit:gamma' },
  ])
})

test('pins a caller adding themselves to the version they were authorized with', async () => {
  const { ports, grants } = createPorts(['beta'])

  await addMemberToTeamProjectsUseCase(ports, {
    workspaceId: 'ws',
    teamId: 'core',
    member: { id: 'Admin@example.com', email: 'admin@example.com' },
    role: 'viewer',
    caller,
  })

  expect(grants.map((grant) => grant.expectedVersion)).toEqual([3, 4])
})

test('refuses before any grant when one Project is not manageable, and an unknown Team', async () => {
  const { ports, grants } = createPorts([], (projectId) => projectId !== 'gamma')

  await expect(addMemberToTeamProjectsUseCase(ports, {
    workspaceId: 'ws', teamId: 'core', member, role: 'member', caller,
  })).rejects.toMatchObject({ status: 403, code: 'TeamProjectsManageDenied' })
  await expect(addMemberToTeamProjectsUseCase(ports, {
    workspaceId: 'ws', teamId: 'missing', member, role: 'member', caller,
  })).rejects.toMatchObject({ status: 404, code: 'TeamNotFound' })
  expect(grants).toEqual([])
})

test('refuses a Team whose Project ID is shared with another active Team', async () => {
  const other = (archivedAt?: string): DirectoryAdministrationTeam => ({
    id: 'other',
    nameJa: '他',
    nameEn: 'Other',
    ...(archivedAt ? { archivedAt } : {}),
    projects: [{ id: 'beta', nameJa: 'ベータ', nameEn: 'Beta', tone: 'blue' }],
  })
  const shared = createPorts([], () => true, [other()])

  await expect(addMemberToTeamProjectsUseCase(shared.ports, {
    workspaceId: 'ws', teamId: 'core', member, role: 'member', caller,
  })).rejects.toMatchObject({ status: 409, code: 'TeamProjectIdShared' })
  expect(shared.grants).toEqual([])

  // An archived Team no longer owns its Projects for access, so its IDs do not block the add.
  const archived = createPorts([], () => true, [other('2026-01-01T00:00:00.000Z')])
  await expect(addMemberToTeamProjectsUseCase(archived.ports, {
    workspaceId: 'ws', teamId: 'core', member, role: 'member', caller,
  })).resolves.toMatchObject({ addedProjectIds: ['alpha', 'beta', 'gamma'] })
})
