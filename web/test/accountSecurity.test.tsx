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
import {
  resolveAccountSecurityLoadFailure,
  withAuthenticatorState,
} from '../src/features/account-security/mutations/useAccountSecurityController'
import { AccountSecurityPanel } from '../src/features/account-security/ui/AccountSecurityPanel'
import { LoginPage } from '../src/pages/auth/LoginPage'
import { ForgotPasswordPage } from '../src/pages/auth/ForgotPasswordPage'
import { previewEnterpriseSessionPolicy } from '../src/security/api'
import { enterpriseSecuritySnapshotFixture } from '../src/security/fixtures'
import { createEnterpriseSecurityConfirmationCopy } from '../src/security/model/enterpriseSecurityConfirmation'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  getWorkspaceMembersSignInSecurity,
  getWorkspaceMembersSignInSecurityReport,
  resetWorkspaceMemberCredential,
  setWorkspaceMemberSystemAdministrator,
  WorkspaceAccessApiError,
} from '../src/workspace/api'
import { groupMemberRoleAssignments } from '../src/workspace/model/memberRoleAssignments'
import {
  shouldCloseCredentialResetDialog,
  shouldRetainCredentialResetContext,
} from '../src/workspace/mutations/useWorkspaceMemberCredentialReset'
import {
  createWorkspaceAccessMutationSession,
  getCredentialResetRunner,
} from '../src/workspace/mutations/workspaceAccessMutationSession'

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

describe('system administrators in the member list', () => {
  test('reads the system administrators with the sign-in security and drops non-strings', async () => {
    recordFetch(200, {
      members: [{ memberKey: 'a@example.com', mfa: 'enrolled', passwordReset: 'available' }],
      systemAdministratorMemberKeys: ['a@example.com', 7],
    })

    const report = await getWorkspaceMembersSignInSecurityReport('token')

    expect(report.systemAdministratorMemberKeys).toEqual(['a@example.com'])
  })

  test('leaves the system administrators unknown when the API omits them', async () => {
    recordFetch(200, { members: [] })

    const report = await getWorkspaceMembersSignInSecurityReport('token')

    expect(report.systemAdministratorMemberKeys).toBeUndefined()
    expect(report.systemAdministratorsLoadFailed).toBe(false)
  })

  test('reports a failed system administrator lookup so the screen can offer a retry', async () => {
    recordFetch(200, { members: [], systemAdministratorsUnavailable: true })

    const report = await getWorkspaceMembersSignInSecurityReport('token')

    expect(report.systemAdministratorsLoadFailed).toBe(true)
  })

  test('puts the requested state with idempotency headers', async () => {
    const requests = recordFetch(200, { systemAdministrator: true, changed: true })

    await setWorkspaceMemberSystemAdministrator('token', 'a@example.com', true, mutationContext)

    expect(requests[0]?.url).toEndWith('/workspace/members/a%40example.com/system-administrator')
    expect(requests[0]?.init.method).toBe('PUT')
    expect(requests[0]?.init.body).toBe('{"systemAdministrator":true}')
    expect(new Headers(requests[0]?.init.headers).get('Idempotency-Key')).toBe('credential-1')
  })

  test('groups direct roles by member with role names, Workspace scope first', () => {
    const grouped = groupMemberRoleAssignments({
      memberRoleAssignments: [
        { id: 'a-project', memberKey: 'a@example.com', roleId: 'custom:editor', scopeType: 'project' },
        { id: 'a-workspace', memberKey: 'a@example.com', roleId: 'workspace:portfolio-viewer', scopeType: 'workspace' },
        { id: 'b-team', memberKey: 'b@example.com', roleId: 'custom:missing', scopeType: 'team' },
        { id: 'a-org-unit', memberKey: 'a@example.com', roleId: 'org-unit:manager', scopeType: 'org-unit' },
      ],
      roles: [
        { id: 'workspace:portfolio-viewer', name: 'Portfolio viewer' },
        { id: 'custom:editor', name: 'Editor' },
        { id: 'org-unit:manager', name: 'OrgUnit manager' },
      ],
    })

    // An OrgUnit role sits between the Workspace and the narrower Team and Project scopes.
    expect(grouped.get('a@example.com')?.map((label) => label.roleName))
      .toEqual(['Portfolio viewer', 'OrgUnit manager', 'Editor'])
    expect(grouped.get('b@example.com')).toEqual([{ id: 'b-team', roleName: 'custom:missing', scopeType: 'team' }])
  })
})

describe('member credential reset retry', () => {
  test('reuses the idempotency key only while the outcome is unknown or still running', () => {
    expect(shouldRetainCredentialResetContext(new TypeError('Failed to fetch'))).toBe(true)
    expect(shouldRetainCredentialResetContext(new WorkspaceAccessApiError(502, 'Bad gateway'))).toBe(true)
    expect(shouldRetainCredentialResetContext(new WorkspaceAccessApiError(500, 'Failed'))).toBe(true)
    // An expired session is refused before the reset runs, so the retry after a token refresh
    // still resumes the earlier attempt.
    expect(shouldRetainCredentialResetContext(new WorkspaceAccessApiError(401, 'Unauthorized'))).toBe(true)
    expect(shouldRetainCredentialResetContext(new WorkspaceAccessApiError(403, 'Forbidden'))).toBe(false)
    expect(shouldRetainCredentialResetContext(
      new WorkspaceAccessApiError(409, 'Running', 'WorkspaceCredentialActionInProgress'),
    )).toBe(true)
    expect(shouldRetainCredentialResetContext(
      new WorkspaceAccessApiError(409, 'Not enrolled', 'MemberMfaNotEnrolled'),
    )).toBe(false)
    expect(shouldRetainCredentialResetContext(
      new WorkspaceAccessApiError(409, 'Expired', 'WorkspaceCredentialActionExpired'),
    )).toBe(false)
  })

  test('closes the confirmation only when the reset expired', () => {
    expect(shouldCloseCredentialResetDialog(
      new WorkspaceAccessApiError(409, 'Expired', 'WorkspaceCredentialActionExpired'),
    )).toBe(true)
    expect(shouldCloseCredentialResetDialog(
      new WorkspaceAccessApiError(409, 'Running', 'WorkspaceCredentialActionInProgress'),
    )).toBe(false)
    expect(shouldCloseCredentialResetDialog(new TypeError('Failed to fetch'))).toBe(false)
  })

  test('keeps an unknown reset outcome across a snapshot refresh and an access token refresh', async () => {
    const session = createWorkspaceAccessMutationSession('token-1')
    const keys: string[] = []
    const reset = () => getCredentialResetRunner('owner@example.com').run(
      'workspace-member:mfa-reset:sato@example.com',
      'fingerprint',
      async (context) => {
        keys.push(context.idempotencyKey)
        if (keys.length === 1) throw new TypeError('Failed to fetch')
      },
      shouldRetainCredentialResetContext,
    )

    await expect(reset()).rejects.toThrow('Failed to fetch')
    // An invitation succeeds and its snapshot refresh discards the retained membership contexts.
    await session.requestRunner.run('workspace-invitation', 'fingerprint', async () => undefined)
    session.requestRunner.discardRetainedContexts()
    // The access token is refreshed, which starts a new session for the same administrator.
    createWorkspaceAccessMutationSession('token-2')
    await reset()

    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
  })

  test('keeps the key when a retry is refused for an expired session', async () => {
    const keys: string[] = []
    const reset = () => getCredentialResetRunner('session-expiry@example.com').run(
      'workspace-member:password-reset:sato@example.com',
      'fingerprint',
      async (context) => {
        keys.push(context.idempotencyKey)
        if (keys.length === 1) throw new TypeError('Failed to fetch')
        if (keys.length === 2) throw new WorkspaceAccessApiError(401, 'Unauthorized')
      },
      shouldRetainCredentialResetContext,
    )

    await expect(reset()).rejects.toThrow('Failed to fetch')
    await expect(reset()).rejects.toThrow('Unauthorized')
    // The access token is refreshed and the administrator tries again.
    createWorkspaceAccessMutationSession('token-refreshed')
    await reset()

    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(1)
  })

  test('keeps the reset keys of each administrator apart', () => {
    expect(getCredentialResetRunner('owner@example.com')).toBe(getCredentialResetRunner('owner@example.com'))
    expect(getCredentialResetRunner('admin@example.com')).not.toBe(getCredentialResetRunner('owner@example.com'))
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

  test('keeps the confirmed authenticator state when the reload after a change fails', () => {
    const before = { mfaRequiredByPolicy: false, passwordManaged: true, softwareTokenMfaEnabled: false }
    const registered = withAuthenticatorState(before, true)
    const failure = resolveAccountSecurityLoadFailure(true, new Error('Network error'))

    expect(registered).toEqual({ ...before, softwareTokenMfaEnabled: true })
    expect(withAuthenticatorState(undefined, true)).toBeUndefined()
    expect(failure).toEqual({ loadFailed: false, reloadFailed: true })
    expect(resolveAccountSecurityLoadFailure(false, new Error('Network error')))
      .toEqual({ loadFailed: true, reloadFailed: false })

    const html = renderToStaticMarkup(
      <AccountSecurityPanel locale="en" status={registered} {...failure} onRetry={() => undefined} />,
    )

    expect(html).toContain('Sign-in settings could not be reloaded.')
    expect(html).toContain('data-testid="account-security-reload"')
    expect(html).toContain('On')
  })
})
