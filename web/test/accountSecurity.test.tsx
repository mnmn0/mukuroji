import { afterEach, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import {
  ApiError,
  createTotpKeyUri,
  getAccountSecurity,
  isMfaSetupChallenge,
  requestPasswordReset,
  startSoftwareTokenSetup,
  verifySoftwareTokenSetup,
} from '../src/auth/api'
import { AccountSecurityPanel } from '../src/features/account-security/ui/AccountSecurityPanel'
import { LoginPage } from '../src/pages/auth/LoginPage'
import { ForgotPasswordPage } from '../src/pages/auth/ForgotPasswordPage'
import { previewEnterpriseSessionPolicy } from '../src/security/api'
import { enterpriseSecuritySnapshotFixture } from '../src/security/fixtures'
import { createEnterpriseSecurityConfirmationCopy } from '../src/security/model/enterpriseSecurityConfirmation'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  getWorkspaceMembersSignInSecurity,
  resetWorkspaceMemberCredential,
} from '../src/workspace/api'

const originalFetch = globalThis.fetch
const mutationContext = { idempotencyKey: 'credential-1', correlationId: 'correlation-1' }

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with a recorder that answers every request with one response.
 *
 * @param status - HTTP status of the response.
 * @param body - JSON body, or undefined for an empty body.
 * @returns The recorded requests.
 */
function recordFetch(status: number, body?: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(input), init })
      return new Response(body === undefined ? null : JSON.stringify(body), { status })
    },
    { preconnect: originalFetch.preconnect },
  )
  return requests
}

/**
 * Renders a page inside a memory router.
 *
 * @param element - Page element.
 * @param path - Initial path.
 * @returns The static markup.
 */
function renderWithRouter(element: ReactNode, path = '/') {
  const router = createMemoryRouter([{ element, path: path.split('?')[0] }], {
    initialEntries: [path],
  })
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

describe('account security API', () => {
  test('sends the reset request without a bearer token', async () => {
    const requests = recordFetch(202, { accepted: true })

    await requestPasswordReset('member@example.com')

    expect(requests[0]?.url).toEndWith('/auth/password-reset/request')
    expect(requests[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ email: 'member@example.com' })
    expect(new Headers(requests[0]?.init.headers).has('Authorization')).toBe(false)
  })

  test('rejects a malformed account security status', async () => {
    recordFetch(200, { passwordManaged: true })

    await expect(getAccountSecurity('token')).rejects.toMatchObject({ status: 502 })
  })

  test('starts and verifies authenticator setup with the bearer token', async () => {
    const requests = recordFetch(200, { secretCode: 'SECRET', accountName: 'member@example.com' })

    const setup = await startSoftwareTokenSetup('setup-token')
    await verifySoftwareTokenSetup('setup-token', '123456')

    expect(setup).toEqual({ secretCode: 'SECRET', accountName: 'member@example.com' })
    expect(requests.map((request) => request.url.replace(/^.*\/auth/u, '/auth'))).toEqual([
      '/auth/mfa/totp/associate',
      '/auth/mfa/totp/verify',
    ])
    expect(new Headers(requests[1]?.init.headers).get('Authorization')).toBe('Bearer setup-token')
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ code: '123456' })
  })

  test('keeps the API error code for a wrong authenticator code', async () => {
    recordFetch(400, { code: 'MfaCodeInvalid', message: 'Invalid code.' })

    const error = await verifySoftwareTokenSetup('token', '000000').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: 'MfaCodeInvalid' })
  })

  test('builds an otpauth URI with the issuer and account', () => {
    expect(createTotpKeyUri({ secretCode: 'ABC', accountName: 'a+b@example.com' })).toBe(
      'otpauth://totp/mukuroji:a%2Bb%40example.com?secret=ABC&issuer=mukuroji',
    )
  })

  test('accepts an MFA_SETUP challenge with exactly one continuation', () => {
    expect(isMfaSetupChallenge({ challenge: 'MFA_SETUP', email: 'a@example.com', session: 's' })).toBe(true)
    expect(isMfaSetupChallenge({
      challenge: 'MFA_SETUP',
      email: 'a@example.com',
      setupAccessToken: 't',
    })).toBe(true)
    expect(isMfaSetupChallenge({
      challenge: 'MFA_SETUP',
      email: 'a@example.com',
      session: 's',
      setupAccessToken: 't',
    })).toBe(false)
    expect(isMfaSetupChallenge({ challenge: 'MFA_SETUP', email: 'a@example.com' })).toBe(false)
  })
})

describe('member sign-in security API', () => {
  test('drops entries the Web cannot read', async () => {
    recordFetch(200, {
      members: [
        { memberKey: 'a@example.com', mfa: 'enrolled', passwordReset: 'available' },
        { memberKey: 'b@example.com', mfa: 'maybe', passwordReset: 'available' },
        { memberKey: 'c@example.com', mfa: 'sso', passwordReset: 'sso' },
      ],
    })

    const members = await getWorkspaceMembersSignInSecurity('token')

    expect(members.map((member) => member.memberKey)).toEqual(['a@example.com', 'c@example.com'])
  })

  test('posts the credential action with idempotency headers', async () => {
    const requests = recordFetch(202, { sent: true })

    await resetWorkspaceMemberCredential('token', 'a@example.com', 'mfa-reset', mutationContext)

    expect(requests[0]?.url).toEndWith('/workspace/members/a%40example.com/mfa-reset')
    expect(requests[0]?.init.method).toBe('POST')
    expect(new Headers(requests[0]?.init.headers).get('Idempotency-Key')).toBe('credential-1')
  })
})

describe('MFA requirement preview', () => {
  const sessionPolicy = enterpriseSecuritySnapshotFixture.sessionPolicy
  const input = {
    allowedGuestDomains: [],
    expectedVersion: sessionPolicy.version,
    externalCollaboratorsAllowed: false,
    guestSessionLifetimeMinutes: 480,
    guestsAllowed: false,
    idleTimeoutMinutes: 60,
    ipAllowlist: [],
    mfaRequired: true,
    reauthenticationMinutes: 480,
    sensitiveActionReauthenticationMinutes: 15,
    sessionLifetimeMinutes: 720,
  }

  test('rejects malformed member counts', async () => {
    recordFetch(200, {
      impact: {
        callerAllowed: true,
        mfaImpact: { activeMemberCount: 3, unenrolledMemberCount: -1, unknownMemberCount: 0 },
        requiresConfirmation: false,
        warnings: [],
      },
    })

    await expect(previewEnterpriseSessionPolicy('token', input, mutationContext)).rejects.toBeDefined()
  })

  test('describes unenrolled and unknown members in the confirmation', () => {
    const copy = createEnterpriseSecurityConfirmationCopy(
      {
        impact: {
          callerAllowed: true,
          mfaImpact: { activeMemberCount: 10, unenrolledMemberCount: 3, unknownMemberCount: 2 },
          requiresConfirmation: false,
          warnings: [],
        },
        input,
        kind: 'session-policy',
      },
      createTranslator('en'),
    )

    expect(copy.title).toBe('Require MFA?')
    expect(copy.description).toContain('3 active members have no MFA')
    expect(copy.description).toContain('The status of 2 members could not be checked.')
  })
})

describe('account security screens', () => {
  test('asks for authenticator registration at sign-in when the workspace requires MFA', () => {
    const html = renderWithRouter(
      <LoginPage
        initialChallenge={{
          challenge: 'MFA_SETUP',
          email: 'member@example.com',
          setupAccessToken: 'setup-token',
        }}
        initialLocale="en"
      />,
    )

    expect(html).toContain('data-testid="authenticator-setup"')
    expect(html).not.toContain('name="password"')
  })

  test('opens the code step after an admin reset', () => {
    const html = renderWithRouter(
      <ForgotPasswordPage initialLocale="en" />,
      '/forgot-password?email=member%40example.com&reason=admin-reset',
    )

    expect(html).toContain('Set a new password')
    expect(html).toContain('member@example.com')
  })

  test('hides turning MFA off while the workspace requires it', () => {
    const html = renderToStaticMarkup(
      <AccountSecurityPanel
        locale="en"
        status={{ mfaRequiredByPolicy: true, passwordManaged: true, softwareTokenMfaEnabled: true }}
        onDisableMfa={async () => undefined}
      />,
    )

    expect(html).toContain('On')
    expect(html).not.toContain('>Turn off<')
  })

  test('explains that single sign-on manages the password', () => {
    const html = renderToStaticMarkup(
      <AccountSecurityPanel
        locale="en"
        status={{ mfaRequiredByPolicy: false, passwordManaged: false, softwareTokenMfaEnabled: false }}
      />,
    )

    expect(html).not.toContain('Current password')
  })
})
