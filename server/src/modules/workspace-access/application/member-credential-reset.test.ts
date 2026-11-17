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
    readActionProgress: async () => 'none',
    async recordAction(_workspaceId, actor, memberKey, action) {
      calls.push(`record:${actor}:${memberKey}:${action}`)
      return { completed: false }
    },
    async markActionApplying(_workspaceId, memberKey, action) {
      calls.push(`applying:${memberKey}:${action}`)
    },
    async completeAction(_workspaceId, memberKey, action) {
      calls.push(`complete:${memberKey}:${action}`)
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

test('records a password reset and signs the member out before and after resetting', async () => {
  const { ports, calls } = createPorts()

  await resetMemberCredential(ports, { ...input, action: 'password-reset-requested' })

  expect(calls).toEqual([
    'record:demo@example.com:sato@example.com:password-reset-requested',
    'sign-out:sato@example.com',
    'applying:sato@example.com:password-reset-requested',
    'reset:sato@example.com',
    'sign-out:sato@example.com',
    'complete:sato@example.com:password-reset-requested',
  ])
})

test('leaves the password and the progress unchanged when the first sign-out fails', async () => {
  const { ports, calls } = createPorts({
    async signOutEverywhere() {
      throw new Error('Cognito is unavailable.')
    },
  })

  await expect(resetMemberCredential(ports, { ...input, action: 'password-reset-requested' }))
    .rejects.toThrow('Cognito is unavailable.')

  // The action stays recorded but not completed, so a retry with the same key signs out again.
  expect(calls).toEqual(['record:demo@example.com:sato@example.com:password-reset-requested'])
})

test('retries the second sign-out after a password reset', async () => {
  let signOuts = 0
  const { ports, calls } = createPorts({
    async signOutEverywhere() {
      signOuts += 1
      if (signOuts === 2) throw new Error('Cognito is unavailable.')
    },
  })

  await resetMemberCredential(ports, { ...input, action: 'password-reset-requested' })

  expect(signOuts).toBe(3)
  expect(calls.at(-1)).toBe('complete:sato@example.com:password-reset-requested')
  expect(calls.some((call) => call.startsWith('failure:'))).toBe(false)
})

test('keeps a completed password reset when every second sign-out attempt fails', async () => {
  let signOuts = 0
  const { ports, calls } = createPorts({
    async signOutEverywhere() {
      signOuts += 1
      if (signOuts > 1) throw new Error('Cognito is unavailable.')
    },
  })

  await resetMemberCredential(ports, { ...input, action: 'password-reset-requested' })

  expect(signOuts).toBe(4)
  expect(calls.slice(-2)).toEqual([
    'failure:Failed to sign the member out again after a password reset.',
    'complete:sato@example.com:password-reset-requested',
  ])
})

test('records an authenticator reset before removing the app', async () => {
  const { ports, calls } = createPorts()

  await resetMemberCredential(ports, { ...input, action: 'mfa-reset' })

  expect(calls).toEqual([
    'record:demo@example.com:sato@example.com:mfa-reset',
    'applying:sato@example.com:mfa-reset',
    'disable:sato@example.com',
    'complete:sato@example.com:mfa-reset',
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

test('resumes a recorded reset whose earlier attempt stopped before finishing', async () => {
  const { ports, calls } = createPorts(
    { readActionProgress: async () => 'recorded' },
    { invitationPending: false, mfaEnrolled: false },
  )

  await resetMemberCredential(ports, { ...input, action: 'mfa-reset' })

  expect(calls).toEqual([
    'record:demo@example.com:sato@example.com:mfa-reset',
    'applying:sato@example.com:mfa-reset',
    'disable:sato@example.com',
    'complete:sato@example.com:mfa-reset',
  ])
})

test('checks authority again before resuming a recorded reset', async () => {
  const { ports, calls } = createPorts({
    readActionProgress: async () => 'recorded',
    async recordAction() {
      throw Object.assign(new Error('The Workspace role cannot manage this member.'), {
        status: 403,
        code: 'WorkspaceRoleDenied',
      })
    },
  })

  await expect(resetMemberCredential(ports, { ...input, action: 'mfa-reset' }))
    .rejects.toMatchObject({ status: 403, code: 'WorkspaceRoleDenied' })
  expect(calls).toEqual([])
})

test('does not change the account when a concurrent attempt completed the reset first', async () => {
  const { ports, calls } = createPorts({
    async recordAction() {
      return { completed: true }
    },
  })

  await resetMemberCredential(ports, { ...input, action: 'password-reset-requested' })

  expect(calls).toEqual([])
})

test('does nothing for a retry of a completed reset', async () => {
  const { ports, calls } = createPorts({ readActionProgress: async () => 'completed' })

  await resetMemberCredential(ports, { ...input, action: 'password-reset-requested' })

  expect(calls).toEqual([])
})

test('keeps a finished reset when marking it completed fails', async () => {
  let completionCalls = 0
  const { ports, calls } = createPorts({
    async completeAction() {
      completionCalls += 1
      throw new Error('DynamoDB is unavailable.')
    },
  })

  await resetMemberCredential(ports, { ...input, action: 'mfa-reset' })

  expect(completionCalls).toBe(3)
  expect(calls.at(-1)).toBe('failure:Failed to mark the credential reset as completed.')
})

test('marks a finished reset completed after a transient failure', async () => {
  let completionCalls = 0
  const { ports, calls } = createPorts({
    async completeAction() {
      completionCalls += 1
      if (completionCalls === 1) throw new Error('DynamoDB throttled the write.')
    },
  })

  await resetMemberCredential(ports, { ...input, action: 'mfa-reset' })

  expect(completionCalls).toBe(2)
  expect(calls.filter((call) => call.startsWith('failure:'))).toEqual([])
})

test('changes nothing when marking the change as started fails', async () => {
  const { ports, calls } = createPorts({
    async markActionApplying() {
      throw Object.assign(new Error('Another request took the action over.'), {
        status: 409,
        code: 'WorkspaceCredentialActionInProgress',
      })
    },
  })

  await expect(resetMemberCredential(ports, { ...input, action: 'mfa-reset' }))
    .rejects.toMatchObject({ status: 409, code: 'WorkspaceCredentialActionInProgress' })

  // Once the change is marked as started, the store refuses to resume it, so a removal followed
  // by a failed completion mark never removes an app the member registered afterwards.
  expect(calls).toEqual(['record:demo@example.com:sato@example.com:mfa-reset'])
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
