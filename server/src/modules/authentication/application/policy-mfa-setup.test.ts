import { expect, test } from 'bun:test'
import { decidePolicyMfaSetup, type PolicyMfaSetupPorts } from './policy-mfa-setup'

type User = { name: string; mfa: boolean }

/**
 * Builds ports that record which checks ran.
 *
 * @param user - User the ports read, or undefined when none can be read.
 * @param mfaRequired - Whether the policy requires MFA.
 * @returns The ports and the recorded checks.
 */
function createPorts(user: User | undefined, mfaRequired: boolean) {
  const calls: string[] = []
  const ports: PolicyMfaSetupPorts<User> = {
    async readUser(accessToken) {
      calls.push(`read:${accessToken}`)
      return user
    },
    hasEnabledMfa: (candidate) => candidate.mfa,
    async isMfaRequiredByPolicy(candidate, accessToken) {
      calls.push(`policy:${candidate.name}:${accessToken}`)
      return mfaRequired
    },
  }
  return { ports, calls }
}

test('asks a user without MFA to register an app when the policy requires MFA', async () => {
  const { ports, calls } = createPorts({ name: 'sato', mfa: false }, true)

  expect(await decidePolicyMfaSetup(ports, 'token-1'))
    .toEqual({ setupRequired: true, setupAccessToken: 'token-1' })
  expect(calls).toEqual(['read:token-1', 'policy:sato:token-1'])
})

test('lets a user with MFA sign in without reading the policy', async () => {
  const user = { name: 'sato', mfa: true }
  const { ports, calls } = createPorts(user, true)

  expect(await decidePolicyMfaSetup(ports, 'token-1')).toEqual({ setupRequired: false, user })
  expect(calls).toEqual(['read:token-1'])
})

test('lets a user without MFA sign in when the policy does not require it', async () => {
  const user = { name: 'sato', mfa: false }
  const { ports } = createPorts(user, false)

  expect(await decidePolicyMfaSetup(ports, 'token-1')).toEqual({ setupRequired: false, user })
})

test('skips the check when there is no access token or no readable user', async () => {
  const withoutToken = createPorts({ name: 'sato', mfa: false }, true)
  const unreadable = createPorts(undefined, true)

  expect(await decidePolicyMfaSetup(withoutToken.ports, undefined)).toEqual({ setupRequired: false })
  expect(await decidePolicyMfaSetup(unreadable.ports, 'opaque')).toEqual({ setupRequired: false })
  expect(withoutToken.calls).toEqual([])
  expect(unreadable.calls).toEqual(['read:opaque'])
})
