import { expect, test } from 'bun:test'
import {
  confirmSoftwareTokenEnrollment,
  startSoftwareTokenEnrollment,
  type SoftwareTokenEnrollee,
  type SoftwareTokenEnrollmentPorts,
} from './software-token-enrollment'

const enrollee: SoftwareTokenEnrollee = {
  accessToken: 'access-token',
  ssoSession: false,
  softwareTokenEnabled: false,
}

/**
 * Builds ports that record every call.
 *
 * @param overrides - Ports to replace.
 * @returns The ports and the recorded calls.
 */
function createPorts(overrides: Partial<SoftwareTokenEnrollmentPorts> = {}) {
  const calls: string[] = []
  const ports: SoftwareTokenEnrollmentPorts = {
    async associate(accessToken) {
      calls.push(`associate:${accessToken}`)
      return { secretCode: 'SECRET' }
    },
    async verify(accessToken, code) {
      calls.push(`verify:${accessToken}:${code}`)
    },
    async enable(accessToken) {
      calls.push(`enable:${accessToken}`)
    },
    ...overrides,
  }
  return { ports, calls }
}

test('issues a shared secret and turns the app on only after its code is verified', async () => {
  const { ports, calls } = createPorts()

  await expect(startSoftwareTokenEnrollment(ports, enrollee)).resolves.toEqual({ secretCode: 'SECRET' })
  await confirmSoftwareTokenEnrollment(ports, enrollee, '123456')

  expect(calls).toEqual([
    'associate:access-token',
    'verify:access-token:123456',
    'enable:access-token',
  ])
})

test('leaves MFA unchanged when the code is wrong', async () => {
  const { ports, calls } = createPorts({
    async verify() {
      throw new Error('Code mismatch.')
    },
  })

  await expect(confirmSoftwareTokenEnrollment(ports, enrollee, '000000')).rejects.toThrow('Code mismatch.')
  expect(calls).toEqual([])
})

test('refuses registration for an SSO sign-in or a user who already has an app', async () => {
  const { ports, calls } = createPorts()

  await expect(startSoftwareTokenEnrollment(ports, { ...enrollee, ssoSession: true }))
    .rejects.toMatchObject({ status: 409, code: 'MfaManagedBySso' })
  await expect(confirmSoftwareTokenEnrollment(ports, { ...enrollee, softwareTokenEnabled: true }, '123456'))
    .rejects.toMatchObject({ status: 409, code: 'MfaAlreadyEnabled' })
  expect(calls).toEqual([])
})
