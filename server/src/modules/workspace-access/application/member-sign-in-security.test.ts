import { expect, test } from 'bun:test'
import type { WorkspaceMember } from '../workspace-access'
import {
  listMembersSignInSecurity,
  summarizeMfaEnrollment,
  type MemberSignInProfile,
  type MemberSignInSecurityPorts,
} from './member-sign-in-security'

/**
 * Builds an active member.
 *
 * @param memberKey - Member key, also used as the email address.
 * @returns The member.
 */
function member(memberKey: string): WorkspaceMember {
  return {
    id: `member-${memberKey}`,
    memberKey,
    email: memberKey,
    role: 'member',
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    version: 1,
  }
}

const profile: MemberSignInProfile = {
  softwareTokenMfaConfigured: false,
  mfaConfigured: false,
  invitationPending: false,
  disabled: false,
}

/**
 * Builds ports over fixed members and profiles.
 *
 * @param profiles - Profile of each member key; an Error makes the lookup fail.
 * @param ssoEmails - Email addresses an identity provider owns.
 * @returns The ports and the reported failures.
 */
function createPorts(
  profiles: Record<string, MemberSignInProfile | Error | undefined>,
  ssoEmails: readonly string[] = [],
) {
  const failures: unknown[] = []
  const ports: MemberSignInSecurityPorts = {
    listActiveMembers: async () => Object.keys(profiles).map(member),
    isSsoManagedEmail: async (email) => ssoEmails.includes(email),
    async readSignInProfile(memberKey) {
      const value = profiles[memberKey]
      if (value instanceof Error) throw value
      return value
    },
    reportFailure: (error) => failures.push(error),
  }
  return { ports, failures }
}

test('reports MFA and password reset state of each member in order', async () => {
  const { ports, failures } = createPorts({
    'sato@example.com': { ...profile, softwareTokenMfaConfigured: true, mfaConfigured: true },
    'suzuki@example.com': profile,
    'viewer@example.com': { ...profile, invitationPending: true },
    'disabled@example.com': { ...profile, disabled: true },
    'sso@corp.example': profile,
    'missing@example.com': undefined,
    'broken@example.com': new Error('Cognito is unavailable.'),
  }, ['sso@corp.example'])

  expect(await listMembersSignInSecurity(ports, 'workspace#demo')).toEqual([
    { memberKey: 'sato@example.com', mfa: 'enrolled', passwordReset: 'available' },
    { memberKey: 'suzuki@example.com', mfa: 'not-enrolled', passwordReset: 'available' },
    { memberKey: 'viewer@example.com', mfa: 'not-enrolled', passwordReset: 'invitation-pending' },
    { memberKey: 'disabled@example.com', mfa: 'not-enrolled', passwordReset: 'unavailable' },
    { memberKey: 'sso@corp.example', mfa: 'sso', passwordReset: 'sso' },
    { memberKey: 'missing@example.com', mfa: 'unknown', passwordReset: 'unavailable' },
    { memberKey: 'broken@example.com', mfa: 'unknown', passwordReset: 'unavailable' },
  ])
  expect(failures).toHaveLength(1)
})

test('fails the roster when the SSO lookup fails, rather than offering a reset', async () => {
  const { ports } = createPorts({ 'sato@example.com': profile })
  ports.isSsoManagedEmail = async () => {
    throw new Error('SSO discovery is unavailable.')
  }

  await expect(listMembersSignInSecurity(ports, 'workspace#demo')).rejects.toThrow('SSO discovery is unavailable.')
})

test('counts the members an MFA requirement would send to setup', async () => {
  const { ports } = createPorts({
    'sato@example.com': { ...profile, softwareTokenMfaConfigured: true, mfaConfigured: true },
    // Sign-in accepts SMS MFA, so this member is not sent to setup.
    'sms@example.com': { ...profile, mfaConfigured: true },
    'suzuki@example.com': profile,
    'broken@example.com': new Error('Cognito is unavailable.'),
    'sso@corp.example': profile,
  }, ['sso@corp.example'])

  expect(await summarizeMfaEnrollment(ports, 'workspace#demo')).toEqual({
    activeMemberCount: 5,
    unenrolledMemberCount: 1,
    unknownMemberCount: 1,
  })
})
