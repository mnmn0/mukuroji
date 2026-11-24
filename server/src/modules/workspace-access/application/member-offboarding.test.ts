import { expect, test } from 'bun:test'
import type { PlanningEntityType } from '@mukuroji/contracts'
import { WorkspaceAccessError, type WorkspaceMember } from '../workspace-access'
import {
  isActivePlanningEntityOwnedBy,
  isManagerProjectAccess,
  listMemberDeactivationBlockers,
} from '../domain/member-deactivation-blockers'
import { readMemberOffboarding, type MemberOffboardingPorts } from './member-offboarding'

const workspaceId = 'workspace-1'
const leaver = 'leaver@example.com'
const now = new Date('2026-11-24T00:00:00.000Z')
const cycleType: PlanningEntityType = 'cycle'

/** What the fake ports hold. */
type FakeState = {
  /** The leaver's member row; undefined when absent. */
  member?: Partial<WorkspaceMember>
  /** The leaver's Project roles. */
  accesses?: Array<{ teamId?: string, projectId: string, role?: string }>
  /** Owner of each Planning entity, by entity ID, with archived entities marked. */
  planning?: Array<{ id: string, ownerMemberKey: string, archivedAt?: string }>
  /** Whether a private Document would lose its last manager. */
  managesPrivateDocuments?: boolean
}

/**
 * Creates handover summary ports over fixed state.
 *
 * @param state - Member, Project, Planning, and Document state.
 * @returns The ports.
 */
function createPorts(state: FakeState): MemberOffboardingPorts {
  return {
    workspaceAccess: {
      async getMember() {
        return state.member === undefined
          ? undefined
          : {
              id: leaver,
              memberKey: leaver,
              email: leaver,
              role: 'member',
              status: 'active',
              version: 2,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              ...state.member,
            }
      },
      async listActiveMembers() {
        return [{ memberKey: leaver, role: 'member' }, { memberKey: 'other@example.com', role: 'admin' }]
      },
    },
    documents: {
      async getAuthorizationRevision() {
        return 7
      },
      async getManagerLifecycleSnapshot() {
        return state.managesPrivateDocuments
          ? { authorizationRevision: 7, blockingDocumentId: 'document-1' }
          : { authorizationRevision: 7 }
      },
    },
    projects: {
      async listProjectAccesses() {
        return state.accesses ?? []
      },
      async listTeams() {
        return [{ id: 'core', projects: [{ id: 'refero', name: 'Refero' }, { id: 'other', name: 'Other' }] }]
      },
    },
    planning: {
      async readEntities() {
        return {
          revision: 11,
          entities: (state.planning ?? []).map((entity) => ({ ...entity, type: cycleType, title: entity.id })),
        }
      },
    },
    developerPlatform: {
      async listActiveCredentials() {
        return { apiKeys: [{ id: 'key-1', name: 'CI' }], oauthApps: [{ id: 'app-1', name: 'Sync' }] }
      },
      async listWebhooks() {
        return [
          { id: 'hook-1', name: 'Mine', status: 'active', createdByUserId: leaver },
          { id: 'hook-2', name: 'Paused', status: 'paused', createdByUserId: leaver },
          { id: 'hook-3', name: 'Theirs', status: 'active', createdByUserId: 'other@example.com' },
        ]
      },
    },
    now: () => now,
  }
}

test('lists what a leaver must hand over and refuses deactivation until it is done', async () => {
  const summary = await readMemberOffboarding(createPorts({
    member: { accessExpiresAt: '2026-11-01T00:00:00.000Z' },
    accesses: [{ projectId: 'refero', role: 'manager' }, { projectId: 'other', role: 'member' }],
    planning: [
      { id: 'cycle-1', ownerMemberKey: leaver },
      { id: 'cycle-2', ownerMemberKey: leaver, archivedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'cycle-3', ownerMemberKey: 'other@example.com' },
    ],
    managesPrivateDocuments: true,
  }), workspaceId, leaver)

  expect(summary).toEqual({
    memberKey: leaver,
    accessExpiresAt: '2026-11-01T00:00:00.000Z',
    accessExpired: true,
    managedProjects: [{ teamId: 'core', projectId: 'refero', name: 'Refero' }],
    ownedPlanningEntities: [{ id: 'cycle-1', type: 'cycle', title: 'cycle-1' }],
    planningRevision: 11,
    managesPrivateDocuments: true,
    credentials: [{ id: 'key-1', kind: 'api-key', name: 'CI' }, { id: 'app-1', kind: 'oauth-app', name: 'Sync' }],
    webhooks: [{ id: 'hook-1', name: 'Mine' }],
    canDeactivate: false,
  })
})

test('allows deactivation only of an active member with nothing left to hand over', async () => {
  const read = (state: FakeState) => readMemberOffboarding(createPorts(state), workspaceId, leaver)

  expect((await read({ member: {} })).canDeactivate).toBe(true)
  expect((await read({ member: {}, accesses: [{ projectId: 'refero', role: 'manager' }] })).canDeactivate).toBe(false)
  expect((await read({ member: {}, planning: [{ id: 'cycle-1', ownerMemberKey: leaver }] })).canDeactivate).toBe(false)
  expect((await read({ member: {}, managesPrivateDocuments: true })).canDeactivate).toBe(false)
  expect((await read({ member: { status: 'deactivated' } })).canDeactivate).toBe(false)
})

test('reports a missing member as not found', async () => {
  await expect(readMemberOffboarding(createPorts({}), workspaceId, leaver)).rejects.toMatchObject({
    code: 'WorkspaceMemberNotFound',
    status: 404,
  })
  await expect(readMemberOffboarding(createPorts({}), workspaceId, leaver)).rejects.toBeInstanceOf(WorkspaceAccessError)
})

test('applies one deactivation blocker policy in a fixed order', () => {
  expect(listMemberDeactivationBlockers({
    managesProjects: true,
    ownsPlanningEntities: true,
    managesPrivateDocuments: true,
  })).toEqual(['manages-projects', 'owns-planning-entities', 'manages-private-documents'])
  expect(listMemberDeactivationBlockers({
    managesProjects: false,
    ownsPlanningEntities: false,
    managesPrivateDocuments: false,
  })).toEqual([])
  expect(isManagerProjectAccess({ role: 'manager' })).toBe(true)
  expect(isManagerProjectAccess({ role: 'member' })).toBe(false)
  expect(isActivePlanningEntityOwnedBy({ ownerMemberKey: leaver }, leaver)).toBe(true)
  expect(isActivePlanningEntityOwnedBy({ ownerMemberKey: leaver, archivedAt: '2026-01-01T00:00:00.000Z' }, leaver)).toBe(false)
  expect(isActivePlanningEntityOwnedBy({ ownerMemberKey: 'other@example.com' }, leaver)).toBe(false)
})
