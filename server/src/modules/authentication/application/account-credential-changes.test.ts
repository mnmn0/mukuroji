import { expect, test } from 'bun:test'
import {
  AccountCredentialChangeError,
  changeAccountPassword,
  confirmAccountPasswordReset,
  removeSoftwareToken,
  requestAccountPasswordReset,
  type PasswordChangePorts,
  type PasswordResetPorts,
  type SoftwareTokenRemovalPorts,
} from './account-credential-changes'

/**
 * Builds identity provider operations that record every call.
 *
 * @returns The ports and the recorded calls.
 */
function createPorts() {
  const calls: string[] = []
  const ports: PasswordChangePorts & SoftwareTokenRemovalPorts = {
    async changePassword(accessToken, currentPassword, newPassword) {
      calls.push(`change:${accessToken}:${currentPassword}:${newPassword}`)
    },
    async disable(accessToken) {
      calls.push(`disable:${accessToken}`)
    },
  }
  return { ports, calls }
}

test('changes the password of a password sign-in', async () => {
  const { ports, calls } = createPorts()

  await changeAccountPassword(ports, { accessToken: 'token', ssoSession: false }, 'old', 'new')

  expect(calls).toEqual(['change:token:old:new'])
})

test('leaves the password of an SSO sign-in to the identity provider', async () => {
  const { ports, calls } = createPorts()

  await expect(changeAccountPassword(ports, { accessToken: 'token', ssoSession: true }, 'old', 'new'))
    .rejects.toMatchObject({ status: 409, code: 'PasswordManagedBySso' })
  expect(calls).toEqual([])
})

test('passes a wrong current password through as the identity provider reports it', async () => {
  const { ports } = createPorts()
  ports.changePassword = async () => {
    throw new AccountCredentialChangeError(400, 'CurrentPasswordIncorrect', 'Wrong password.')
  }

  await expect(changeAccountPassword(ports, { accessToken: 'token', ssoSession: false }, 'bad', 'new'))
    .rejects.toMatchObject({ status: 400, code: 'CurrentPasswordIncorrect' })
})

test('turns the authenticator app off after a recent sign-in when no policy requires MFA', async () => {
  const { ports, calls } = createPorts()

  await removeSoftwareToken(ports, {
    accessToken: 'token',
    mfaRequiredByPolicy: false,
    recentlyAuthenticated: true,
  })

  expect(calls).toEqual(['disable:token'])
})

test('keeps the authenticator app while a policy requires MFA or the sign-in is old', async () => {
  const { ports, calls } = createPorts()

  await expect(removeSoftwareToken(ports, {
    accessToken: 'token',
    mfaRequiredByPolicy: true,
    recentlyAuthenticated: true,
  })).rejects.toMatchObject({ status: 409, code: 'MfaRequiredByPolicy' })
  await expect(removeSoftwareToken(ports, {
    accessToken: 'token',
    mfaRequiredByPolicy: false,
    recentlyAuthenticated: false,
  })).rejects.toMatchObject({ status: 403, code: 'RecentSignInRequired' })
  expect(calls).toEqual([])
})

test('requests and confirms a password reset through the identity provider', async () => {
  const calls: string[] = []
  const ports: PasswordResetPorts = {
    async sendCode(email) {
      calls.push(`send:${email}`)
    },
    async confirm(email, code, newPassword) {
      calls.push(`confirm:${email}:${code}:${newPassword}`)
    },
  }

  await requestAccountPasswordReset(ports, 'user@example.com')
  await confirmAccountPasswordReset(ports, 'user@example.com', '123456', 'new')

  expect(calls).toEqual(['send:user@example.com', 'confirm:user@example.com:123456:new'])
})
