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
type Grant = { projectId: string; expectedVersion: number; fences: string[]; auditSequence: number }

/**
 * Creates fake ports over one Team.
 *
 * @param existing - Projects the member already belongs to.
 * @param manageable - Tells whether the caller manages a Project.
 * @returns The ports and the grants they received.
 */
function createPorts(existing: string[] = [], manageable = (_projectId: string) => true) {
  const grants: Grant[] = []
  let memberVersion = 10
  const ports: TeamMemberGrantPorts<string, string> = {
    getDirectoryAdministration: async () => ({ teams: [team] }),
    addProjectMemberIfAbsent: async (
      _workspaceId, _teamId, projectId, _memberKey, _input, expectedVersion, _audit, fences, auditSequence,
    ) => {
      if (existing.includes(projectId)) return { added: false }
      grants.push({ projectId, expectedVersion, fences, auditSequence })
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
  // The member's version is read again before each grant, and each grant has its own audit slot.
  expect(grants).toEqual([
    { projectId: 'alpha', expectedVersion: 10, fences: ['caller'], auditSequence: 0 },
    { projectId: 'gamma', expectedVersion: 11, fences: ['caller'], auditSequence: 2 },
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
