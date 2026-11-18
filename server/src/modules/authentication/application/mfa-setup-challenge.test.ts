import { expect, test } from 'bun:test'
import {
  confirmMfaSetupChallenge,
  startMfaSetupChallenge,
  type MfaSetupChallengeAnswer,
  type MfaSetupChallengePorts,
} from './mfa-setup-challenge'

const signIn = { email: 'user@example.com', session: 'challenge-session' }

/**
 * Builds challenge operations that record every call.
 *
 * @param answer - Answer of the identity provider to the verified challenge.
 * @returns The ports and the recorded calls.
 */
function createPorts(answer: MfaSetupChallengeAnswer<string> = { tokens: 'tokens' }) {
  const calls: string[] = []
  const ports: MfaSetupChallengePorts<string> = {
    async associate(session) {
      calls.push(`associate:${session}`)
      return { secretCode: 'SECRET', session: 'associated-session' }
    },
    async verify(session, code) {
      calls.push(`verify:${session}:${code}`)
      return { session: 'verified-session' }
    },
    async respond(email, session) {
      calls.push(`respond:${email}:${session}`)
      return answer
    },
  }
  return { ports, calls }
}

test('issues a secret and continues the challenge with the session it returns', async () => {
  const { ports } = createPorts()

  await expect(startMfaSetupChallenge(ports, signIn))
    .resolves.toEqual({ secretCode: 'SECRET', session: 'associated-session' })
})

test('verifies the code before answering the challenge with the verified session', async () => {
  const { ports, calls } = createPorts()

  await expect(confirmMfaSetupChallenge(ports, signIn, '123456')).resolves.toBe('tokens')
  expect(calls).toEqual([
    'verify:challenge-session:123456',
    'respond:user@example.com:verified-session',
  ])
})

test('does not answer the challenge when the code is wrong', async () => {
  const { ports, calls } = createPorts()
  ports.verify = async () => {
    throw new Error('Code mismatch.')
  }

  await expect(confirmMfaSetupChallenge(ports, signIn, '000000')).rejects.toThrow('Code mismatch.')
  expect(calls).toEqual([])
})

test('reports a challenge it cannot finish instead of signing in', async () => {
  const { ports } = createPorts({ nextChallenge: 'SELECT_MFA_TYPE' })

  await expect(confirmMfaSetupChallenge(ports, signIn, '123456')).rejects.toMatchObject({
    status: 409,
    code: 'UnsupportedAuthenticationChallenge',
    message: 'Unsupported Cognito challenge: SELECT_MFA_TYPE',
  })
})
