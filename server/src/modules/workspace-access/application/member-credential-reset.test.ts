import { expect, test } from 'bun:test'
import type { WorkspaceMember } from '../workspace-access'
import {
  resetMemberCredential,
  type MemberCredentialResetPorts,
  type MemberSignInAccount,
} from './member-credential-reset'

const workspaceId = 'workspace#demo'

/**
 * Builds in-memory ports that record every call.
 *
 * @param overrides - Ports to replace.
 * @param account - Password account state of the member.
 * @returns The ports and the recorded calls.
 */
function createPorts(
  overrides: Partial<MemberCredentialResetPorts> = {},
  account: MemberSignInAccount = { invitationPending: false, mfaEnrolled: true },
) {
  const calls: string[] = []
  const member: WorkspaceMember = {
    id: 'member-sato',
    memberKey: 'sato@example.com',
    email: 'sato@example.com',
    role: 'member',
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    version: 1,
  }
  const ports: MemberCredentialResetPorts = {
    getActiveMember: async (_workspaceId, memberKey) => memberKey === member.memberKey ? member : undefined,
    isSsoManagedEmail: async () => false,
    readSignInAccount: async () => account,
    hasRecordedAction: async () => false,
    async recordAction(_workspaceId, actor, memberKey, action) {
      calls.push(`record:${actor}:${memberKey}:${action}`)
    },
    async resetPassword(memberKey) {
      calls.push(`reset:${memberKey}`)
    },
    async disableAuthenticator(memberKey) {
      calls.push(`disable:${memberKey}`)
    },
    async signOutEverywhere(memberKey) {
      calls.push(`sign-out:${memberKey}`)
    },
    reportFailure(message) {
      calls.push(`failure:${message}`)
    },
    ...overrides,
  }
  return { ports, calls }
}

const input = {
  workspaceId,
  actorMemberKey: 'demo@example.com',
  memberKey: 'sato@example.com',
} as const

test('records a password reset before resetting and signing the member out', async () => {
  const { ports, calls } = createPorts()

  await resetMemberCredential(ports, { ...input, action: 'password-reset-requested' })

  expect(calls).toEqual([
    'record:demo@example.com:sato@example.com:password-reset-requested',
    'reset:sato@example.com',
    'sign-out:sato@example.com',
  ])
})

test('keeps a completed password reset when signing out fails', async () => {
  const { ports, calls } = createPorts({
    async signOutEverywhere() {
      throw new Error('Cognito is unavailable.')
    },
  })

  await resetMemberCredential(ports, { ...input, action: 'password-reset-requested' })

  expect(calls.at(-1)).toBe('failure:Failed to sign the member out after a password reset.')
})

test('records an authenticator reset before removing the app', async () => {
  const { ports, calls } = createPorts()

  await resetMemberCredential(ports, { ...input, action: 'mfa-reset' })

  expect(calls).toEqual([
    'record:demo@example.com:sato@example.com:mfa-reset',
    'disable:sato@example.com',
  ])
})

test('rejects a reset that does not apply and records nothing', async () => {
  const pending = createPorts({}, { invitationPending: true, mfaEnrolled: false })
  const withoutMfa = createPorts({}, { invitationPending: false, mfaEnrolled: false })

  await expect(resetMemberCredential(pending.ports, { ...input, action: 'password-reset-requested' }))
    .rejects.toMatchObject({ status: 409, code: 'MemberInvitationPending' })
  await expect(resetMemberCredential(withoutMfa.ports, { ...input, action: 'mfa-reset' }))
    .rejects.toMatchObject({ status: 409, code: 'MemberMfaNotEnrolled' })
  expect([...pending.calls, ...withoutMfa.calls]).toEqual([])
})

test('reports success for a retry whose earlier attempt already removed the app', async () => {
  const { ports, calls } = createPorts(
    { hasRecordedAction: async () => true },
    { invitationPending: false, mfaEnrolled: false },
  )

  await resetMemberCredential(ports, { ...input, action: 'mfa-reset' })

  expect(calls).toEqual([])
})

test('leaves single sign-on members and missing members untouched', async () => {
  const sso = createPorts({ isSsoManagedEmail: async () => true })

  await expect(resetMemberCredential(sso.ports, { ...input, action: 'mfa-reset' }))
    .rejects.toMatchObject({ status: 409, code: 'MemberSignInManagedBySso' })
  await expect(resetMemberCredential(sso.ports, {
    ...input,
    memberKey: 'missing@example.com',
    action: 'mfa-reset',
  })).rejects.toMatchObject({ status: 404, code: 'WorkspaceMemberNotFound' })
  expect(sso.calls).toEqual([])
})
