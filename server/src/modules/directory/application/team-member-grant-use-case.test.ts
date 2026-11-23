import { expect, test } from 'bun:test'
import type { DirectoryAdministrationTeam } from '@mukuroji/contracts'
import {
  addMemberToTeamProjectsUseCase,
  type TeamMemberGrantPorts,
} from './team-member-grant-use-case'
import { ProjectDataError } from '../project-data-error'

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

/** One grant the fake store received, as the use case passed it in. */
type Grant = {
  /** Project granted. */
  projectId: string
  /** Workspace member version the use case expected, not the version after the grant. */
  expectedVersion: number
  /** Caller fences passed with the grant. */
  fences: string[]
  /** Audit context created for the Project. */
  audit: string
}

/** Options of {@link createPorts}. */
type PortOptions = {
  /** Whether the member is no longer active in the Workspace. */
  inactive?: boolean
  /** Whether the request's idempotency key already granted a Project with another input. */
  reusedKey?: boolean
}

/**
 * Creates fake ports over one Team.
 *
 * @param existing - Projects the member already belongs to.
 * @param manageable - Tells whether the caller manages a Project.
 * @param otherTeams - Other Teams of the Workspace, for Project ID sharing.
 * @param options - Member state and key reuse to simulate.
 * @returns The ports and the grants they received.
 */
function createPorts(
  existing: string[] = [],
  manageable = (_projectId: string) => true,
  otherTeams: DirectoryAdministrationTeam[] = [],
  options: PortOptions = {},
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
    requireUnusedGrantRequest: async () => {
      if (options.reusedKey) {
        throw new ProjectDataError(409, 'IdempotencyKeyConflict', 'The key was used with another request.')
      }
    },
    readActiveMemberVersion: async () => {
      if (options.inactive) throw new ProjectDataError(409, 'WorkspaceMemberInactive', 'Inactive.')
      return memberVersion
    },
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

test('refuses a Team whose Project ID is shared with another Team, archived or not', async () => {
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

  // Restoring an archived Team would show the grant there too, so its IDs block the add as well.
  const archived = createPorts([], () => true, [other('2026-01-01T00:00:00.000Z')])
  await expect(addMemberToTeamProjectsUseCase(archived.ports, {
    workspaceId: 'ws', teamId: 'core', member, role: 'member', caller,
  })).rejects.toMatchObject({ status: 409, code: 'TeamProjectIdShared' })
  expect(archived.grants).toEqual([])
})

test('refuses a reused idempotency key with another input before any grant', async () => {
  const { ports, grants } = createPorts([], () => true, [], { reusedKey: true })

  await expect(addMemberToTeamProjectsUseCase(ports, {
    workspaceId: 'ws', teamId: 'core', member, role: 'viewer', caller,
  })).rejects.toMatchObject({ status: 409, code: 'IdempotencyKeyConflict' })
  expect(grants).toEqual([])
})

test('refuses an inactive member even when the Team has no active Project', async () => {
  const { ports } = createPorts([], () => true, [], { inactive: true })
  const empty: DirectoryAdministrationTeam = { id: 'empty', nameJa: '空', nameEn: 'Empty', projects: [] }
  ports.getDirectoryAdministration = async () => ({ teams: [team, empty] })

  await expect(addMemberToTeamProjectsUseCase(ports, {
    workspaceId: 'ws', teamId: 'empty', member, role: 'member', caller,
  })).rejects.toMatchObject({ status: 409, code: 'WorkspaceMemberInactive' })
})
