import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import type { CognitoClient } from '../..'
import type { MutationAuditContext } from '../../../audit'
import {
  WorkspaceAccessError,
  type WorkspaceAccessClient,
  type WorkspaceMemberCredentialAction,
} from '../../../workspace-access'

const {
  app,
  configureFakeProjectClients,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Workspace that the fake Cognito user `demo@example.com` belongs to. */
const workspaceId = 'user#demo@example.com'

/**
 * Replaces Cognito methods on top of the configured fake.
 *
 * @param overrides - Cognito methods the test needs.
 */
function overrideCognito(overrides: Partial<CognitoClient>) {
  setTestAppDependencies({
    cognito: {
      ...getTestAppDependencies().authentication.cognito,
      ...overrides,
    },
  })
}

/**
 * Replaces Workspace Access methods on top of the configured fake.
 *
 * @param overrides - Workspace Access methods the test needs.
 */
function overrideWorkspaceAccess(overrides: Partial<WorkspaceAccessClient>) {
  setTestAppDependencies({
    workspaceAccess: {
      markMemberCredentialActionApplying: async () => undefined,
      ...getTestAppDependencies().workspace.workspaceAccess,
      ...overrides,
    },
  })
}

/**
 * Installs Cognito system administrator group operations that keep the group in memory.
 *
 * @param initial - Emails in the group at the start.
 * @returns The group and the log of Cognito calls.
 */
function installSystemAdministratorGroup(initial: string[] = []) {
  const group = new Set(initial)
  const calls: string[] = []
  overrideCognito({
    async isSystemAdmin(userId) {
      return group.has(userId.toLowerCase())
    },
    async addSystemAdmin(userId) {
      calls.push(`add:${userId}`)
      group.add(userId.toLowerCase())
    },
    async removeSystemAdmin(userId) {
      calls.push(`remove:${userId}`)
      group.delete(userId.toLowerCase())
    },
    async listSystemAdminEmails() {
      return [...group]
    },
  })
  return { group, calls }
}

/**
 * Records the actions written to the store, answering as the real store does on success.
 *
 * @returns The recorded actions.
 */
function recordActions() {
  const recorded: Array<{
    actor: string
    target: string
    action: WorkspaceMemberCredentialAction
    auditContext?: MutationAuditContext
  }> = []
  overrideWorkspaceAccess({
    async recordMemberCredentialAction(_workspaceId, actor, target, action, auditContext) {
      recorded.push({ actor, target, action, auditContext })
      const member = (await getTestAppDependencies().workspace.workspaceAccess.getMember(workspaceId, target))!
      return { member, alreadyRecorded: false, completed: false }
    },
  })
  return recorded
}

/**
 * Sends a system administrator change.
 *
 * @param memberKey - Member to change.
 * @param body - Request body.
 * @returns The response.
 */
function sendChange(memberKey: string, body: unknown) {
  return app.request(`/api/workspace/members/${encodeURIComponent(memberKey)}/system-administrator`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      'Idempotency-Key': `system-admin-${memberKey}-${JSON.stringify(body)}`,
    },
    body: JSON.stringify(body),
  })
}

test('lets an owner grant and revoke system administrator access with an audit record first', async () => {
  configureFakeProjectClients(true)
  const { group, calls } = installSystemAdministratorGroup()
  const recorded = recordActions()

  const granted = await sendChange('sato@example.com', { systemAdministrator: true })

  expect(granted.status).toBe(200)
  expect(await granted.json()).toEqual({ systemAdministrator: true })
  expect(group.has('sato@example.com')).toBe(true)

  const revoked = await sendChange('sato@example.com', { systemAdministrator: false })

  expect(revoked.status).toBe(200)
  expect(group.has('sato@example.com')).toBe(false)
  expect(calls).toEqual(['add:sato@example.com', 'remove:sato@example.com'])
  expect(recorded.map(({ actor, target, action }) => ({ actor, target, action }))).toEqual([
    { actor: 'demo@example.com', target: 'sato@example.com', action: 'system-administrator-granted' },
    { actor: 'demo@example.com', target: 'sato@example.com', action: 'system-administrator-revoked' },
  ])
  expect(recorded[0].auditContext?.workspaceId).toBe(workspaceId)
})

test('records a request for the state the member already has without changing Cognito', async () => {
  configureFakeProjectClients(true)
  const { calls } = installSystemAdministratorGroup(['sato@example.com'])
  const recorded = recordActions()

  const response = await sendChange('sato@example.com', { systemAdministrator: true })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ systemAdministrator: true })
  expect(calls).toEqual([])
  expect(recorded.map(({ action }) => action)).toEqual(['system-administrator-granted'])
})

test('refuses system administrator changes to administrators who are not owners', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })
  const { calls } = installSystemAdministratorGroup()
  const recorded = recordActions()

  const response = await sendChange('sato@example.com', { systemAdministrator: true })

  expect(response.status).toBe(403)
  expect(calls).toEqual([])
  expect(recorded).toEqual([])
})

test('does not grant a member whose sign-in account belongs to another Workspace', async () => {
  configureFakeProjectClients(true)
  const { calls } = installSystemAdministratorGroup()
  const recorded = recordActions()
  const cognito = getTestAppDependencies().authentication.cognito
  overrideCognito({
    async findWorkspaceUser(userId) {
      const user = await cognito.findWorkspaceUser(userId)
      return user ? { ...user, directoryId: 'workspace-other' } : undefined
    },
  })

  const response = await sendChange('sato@example.com', { systemAdministrator: true })

  expect(response.status).toBe(409)
  expect((await response.json()).code).toBe('MemberSystemAdministratorUnavailable')
  expect(calls).toEqual([])
  expect(recorded).toEqual([])
})

test('reports the store refusal and leaves Cognito unchanged', async () => {
  configureFakeProjectClients(true)
  const { calls } = installSystemAdministratorGroup()
  overrideWorkspaceAccess({
    async recordMemberCredentialAction() {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceGuestSystemAdministrator',
        'A guest cannot be a system administrator. Change the role first.',
      )
    },
  })

  const response = await sendChange('sato@example.com', { systemAdministrator: true })

  expect(response.status).toBe(409)
  expect((await response.json()).code).toBe('WorkspaceGuestSystemAdministrator')
  expect(calls).toEqual([])
})

test('rejects a body without a boolean systemAdministrator', async () => {
  configureFakeProjectClients(true)
  installSystemAdministratorGroup()

  const response = await sendChange('sato@example.com', { systemAdministrator: 'yes' })

  expect(response.status).toBe(400)
})

test('answers 503 when the deployment cannot change the group', async () => {
  configureFakeProjectClients(true)
  overrideCognito({ addSystemAdmin: undefined, removeSystemAdmin: undefined })

  const response = await sendChange('sato@example.com', { systemAdministrator: true })

  expect(response.status).toBe(503)
})

test('lists the active members who are system administrators with the sign-in security', async () => {
  configureFakeProjectClients(true)
  installSystemAdministratorGroup(['sato@example.com', 'someone-else@example.com'])

  const response = await app.request('/api/workspace/members/sign-in-security', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect((await response.json()).systemAdministratorMemberKeys).toEqual(['sato@example.com'])
})

test('still lists sign-in security when the groups cannot be read', async () => {
  configureFakeProjectClients(true)
  overrideCognito({
    async listSystemAdminEmails() {
      throw new Error('Cognito is unavailable.')
    },
  })

  const response = await app.request('/api/workspace/members/sign-in-security', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.members.length).toBeGreaterThan(0)
  expect(body.systemAdministratorMemberKeys).toBeUndefined()
})
