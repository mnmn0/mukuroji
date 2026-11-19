import type {
  EnterpriseIdentitySnapshot,
  EnterpriseScimUser,
  EnterpriseScimUserInput,
} from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import type { WorkspaceMember } from '../../../workspace-access'
import {
  deactivateEnterpriseScimUserDesiredState,
  saveEnterpriseScimUserDesiredState,
  type EnterpriseScimUserDesiredStateDependencies,
} from './scim-user-desired-state'

const workspaceId = 'workspace-scim-link'
const now = '2026-11-19T00:00:00.000Z'

/**
 * Creates a Workspace member fixture.
 *
 * @param overrides - Fields that differ from an active, manually invited member.
 * @returns The member fixture.
 */
function createMember(overrides: Partial<WorkspaceMember>): WorkspaceMember {
  return {
    id: 'member@example.com',
    memberKey: 'member@example.com',
    email: 'member@example.com',
    role: 'member',
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/**
 * Creates SCIM user desired state linked to `member@example.com`.
 *
 * @param overrides - Fields that differ from the default desired state.
 * @returns The SCIM user input.
 */
function createInput(overrides: Partial<EnterpriseScimUserInput> = {}): EnterpriseScimUserInput {
  return {
    workspaceId,
    externalId: 'external-user',
    identityProviderId: 'idp-1',
    userName: 'external-user@directory.example.com',
    emails: ['member@example.com'],
    active: true,
    linkedMemberKey: 'member@example.com',
    idempotencyKey: 'scim-link',
    ...overrides,
  }
}

/**
 * Creates an Enterprise Identity snapshot that holds the given SCIM users.
 *
 * @param scimUsers - Stored SCIM users.
 * @returns The snapshot.
 */
function createSnapshot(scimUsers: EnterpriseScimUser[] = []): EnterpriseIdentitySnapshot {
  return {
    workspaceId,
    identityProviders: [],
    domains: [],
    customRoles: [],
    groupMappings: [],
    roleAssignments: [],
    scimUsers,
    scimGroups: [],
    scimCredentials: [],
    serviceAccounts: [],
    breakGlassAccounts: [],
    provisioningRuns: [],
    provisioningLogs: [],
  }
}

/**
 * Creates ports that record writes and return the given member.
 *
 * @param member - Member returned for every member key, if any.
 * @returns The ports and the list of recorded writes.
 */
function createDependencies(member: WorkspaceMember | undefined) {
  const writes: string[] = []
  const dependencies: EnterpriseScimUserDesiredStateDependencies = {
    workspaceAccess: {
      async getMember() {
        return member
      },
    },
    scimDirectory: {
      async upsertScimUser(input) {
        writes.push(`upsert:${input.externalId}`)
        return {
          ...input,
          userId: input.userId ?? 'scim-user-new',
          linkedMemberKey: input.linkedMemberKey,
          groupIds: input.groupIds ?? [],
          version: 1,
          appliedVersion: 0,
          createdAt: now,
          updatedAt: now,
        }
      },
      async deactivateScimUser(_workspaceId, _providerId, userId) {
        writes.push(`deactivate:${userId}`)
        return undefined
      },
    },
  }
  return { dependencies, writes }
}

test('stores SCIM desired state only for members this directory user provisions', async () => {
  const owner = createDependencies(createMember({ role: 'owner' }))
  await expect(saveEnterpriseScimUserDesiredState(
    owner.dependencies,
    createSnapshot(),
    createInput(),
  )).rejects.toMatchObject({ status: 409, code: 'EnterpriseProvisioningProtectedOwner' })
  expect(owner.writes).toEqual([])

  const manual = createDependencies(createMember({ role: 'admin', provisioningSource: 'manual' }))
  await expect(saveEnterpriseScimUserDesiredState(
    manual.dependencies,
    createSnapshot(),
    createInput({ active: false }),
  )).rejects.toMatchObject({ status: 409, code: 'EnterpriseScimMemberNotDirectoryManaged' })
  expect(manual.writes).toEqual([])

  const otherDirectoryUser = createDependencies(createMember({
    provisioningSource: 'directory',
    externalIdentityId: 'scim-user-other',
  }))
  await expect(saveEnterpriseScimUserDesiredState(
    otherDirectoryUser.dependencies,
    createSnapshot(),
    createInput(),
  )).rejects.toMatchObject({ code: 'EnterpriseScimMemberNotDirectoryManaged' })
  expect(otherDirectoryUser.writes).toEqual([])

  const absent = createDependencies(undefined)
  await saveEnterpriseScimUserDesiredState(absent.dependencies, createSnapshot(), createInput())
  expect(absent.writes).toEqual(['upsert:external-user'])
})

test('lets a directory user keep updating and deactivating the member it provisioned', async () => {
  const stored: EnterpriseScimUser = {
    workspaceId,
    userId: 'scim-user-1',
    externalId: 'external-user',
    identityProviderId: 'idp-1',
    userName: 'external-user@directory.example.com',
    emails: ['member@example.com'],
    active: true,
    linkedMemberKey: 'member@example.com',
    groupIds: [],
    version: 1,
    appliedVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
  const { dependencies, writes } = createDependencies(createMember({
    provisioningSource: 'directory',
    externalIdentityId: 'scim-user-1',
  }))

  // A POST without a user ID resolves the stored user by provider and externalId.
  await saveEnterpriseScimUserDesiredState(dependencies, createSnapshot([stored]), createInput())
  await deactivateEnterpriseScimUserDesiredState(
    dependencies,
    createSnapshot([stored]),
    stored,
    'delete-user',
  )
  expect(writes).toEqual(['upsert:external-user', 'deactivate:scim-user-1'])
})
