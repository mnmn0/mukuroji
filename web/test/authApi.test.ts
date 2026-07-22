import { afterEach, expect, test } from 'bun:test'
import {
  completeMfaChallenge,
  completeNewPasswordChallenge,
  discoverEnterpriseSso,
  exchangeEnterpriseSso,
  loginWithPassword,
  startEnterpriseSso,
} from '../src/auth/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  idempotencyKey: 'auth-mutation-1',
  correlationId: 'auth-correlation-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('sends stable mutation headers through login and password challenge retries', async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ input, init })

    if (String(input).endsWith('/auth/login')) {
      return new Response(JSON.stringify({
        challenge: 'NEW_PASSWORD_REQUIRED',
        email: 'invitee@example.com',
        session: 'challenge-session',
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      accessToken: 'access-token',
      expiresAt: Date.now() + 3_600_000,
      idToken: 'id-token',
      tokenType: 'Bearer',
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  await loginWithPassword({
    email: 'invitee@example.com',
    password: 'temporary-password',
    remember: true,
  }, mutationContext)
  await completeNewPasswordChallenge({
    email: 'invitee@example.com',
    newPassword: 'replacement-password',
    remember: true,
    session: 'challenge-session',
  }, mutationContext)

  expect(requests).toHaveLength(2)

  for (const request of requests) {
    const headers = new Headers(request.init?.headers)
    expect(headers.get('Idempotency-Key')).toBe(mutationContext.idempotencyKey)
    expect(headers.get('X-Correlation-Id')).toBe(mutationContext.correlationId)
  }
})

test('starts and exchanges enterprise SSO with PKCE inputs and mutation headers', async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ input, init })

    if (String(input).endsWith('/auth/sso/start')) {
      return new Response(
        JSON.stringify({
          authorizationUrl: 'https://auth.example.com/oauth2/authorize',
          codeVerifier:
            'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
          expiresAt: Date.now() + 600_000,
          returnTo: '/dashboard',
          state: 'signed-state',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({
        accessToken: 'sso-access-token',
        expiresAt: Date.now() + 3_600_000,
        idToken: 'sso-id-token',
        returnTo: '/dashboard',
        tokenType: 'Bearer',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  const start = await startEnterpriseSso(
    {
      email: 'member@example.com',
      returnTo: '/dashboard',
    },
    mutationContext,
  )
  const exchange = await exchangeEnterpriseSso(
    {
      code: 'authorization-code',
      codeVerifier: start.codeVerifier,
      remember: false,
      state: start.state,
    },
    mutationContext,
  )

  expect(start.authorizationUrl).toBe(
    'https://auth.example.com/oauth2/authorize',
  )
  expect(exchange.session.remember).toBe(false)
  expect(exchange.returnTo).toBe('/dashboard')
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
    code: 'authorization-code',
    codeVerifier:
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    state: 'signed-state',
  })
  for (const request of requests) {
    const headers = new Headers(request.init?.headers)
    expect(headers.get('Idempotency-Key')).toBe(mutationContext.idempotencyKey)
    expect(headers.get('X-Correlation-Id')).toBe(mutationContext.correlationId)
  }
})

test('discovers managed SSO domains before collecting a password', async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ input, init })

    return new Response(
      JSON.stringify({
        domain: 'example.com',
        loginMode: 'sso-for-claimed-domains',
        provider: {
          displayName: 'Example Identity',
          id: 'provider-1',
          kind: 'oidc',
        },
        ssoRequired: true,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  const discovery = await discoverEnterpriseSso(' Member@Example.com ')

  expect(discovery).toEqual({
    domain: 'example.com',
    loginMode: 'sso-for-claimed-domains',
    provider: {
      displayName: 'Example Identity',
      id: 'provider-1',
      kind: 'oidc',
    },
    ssoRequired: true,
  })
  expect(String(requests[0]?.input)).toBe(
    '/api/auth/sso/discovery?email=member%40example.com',
  )
  expect(requests[0]?.init).toBeUndefined()
})

test('allows password UI only after an explicit non-SSO discovery result', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        loginMode: 'password-or-sso',
        ssoRequired: false,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

  await expect(
    discoverEnterpriseSso('member@external.example'),
  ).resolves.toEqual({
    loginMode: 'password-or-sso',
    ssoRequired: false,
  })
})

test('fails closed when SSO discovery response is malformed', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        loginMode: 'password-or-sso',
        ssoRequired: true,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

  await expect(
    discoverEnterpriseSso('member@example.com'),
  ).rejects.toMatchObject({
    status: 502,
  })
})

test('continues password login through an MFA one-time code challenge', async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ input, init })

    if (String(input).endsWith('/auth/login')) {
      return new Response(
        JSON.stringify({
          challenge: 'SOFTWARE_TOKEN_MFA',
          email: 'recovery@example.com',
          session: 'mfa-session',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({
        accessToken: 'mfa-access-token',
        expiresAt: Date.now() + 3_600_000,
        idToken: 'mfa-id-token',
        tokenType: 'Bearer',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  const challenge = await loginWithPassword(
    {
      email: 'recovery@example.com',
      password: 'password',
      remember: false,
    },
    mutationContext,
  )
  if (!('challenge' in challenge) || challenge.challenge === 'NEW_PASSWORD_REQUIRED') {
    throw new Error('Expected an MFA challenge.')
  }

  const session = await completeMfaChallenge(
    {
      challenge: challenge.challenge,
      code: '123456',
      email: challenge.email,
      remember: false,
      session: challenge.session,
    },
    mutationContext,
  )

  expect('challenge' in session).toBe(false)
  expect(session).toMatchObject({
    accessToken: 'mfa-access-token',
    remember: false,
  })
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
    challenge: 'SOFTWARE_TOKEN_MFA',
    code: '123456',
    email: 'recovery@example.com',
    session: 'mfa-session',
  })
  const headers = new Headers(requests[1]?.init?.headers)
  expect(headers.get('Idempotency-Key')).toBe(mutationContext.idempotencyKey)
  expect(headers.get('X-Correlation-Id')).toBe(mutationContext.correlationId)
})

test('preserves an MFA challenge returned after setting a new password', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        challenge: 'EMAIL_OTP',
        deliveryDestination: 'm***@example.com',
        deliveryMedium: 'EMAIL',
        email: 'invitee@example.com',
        session: 'mfa-after-password-session',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

  await expect(
    completeNewPasswordChallenge(
      {
        email: 'invitee@example.com',
        newPassword: 'replacement-password',
        remember: true,
        session: 'new-password-session',
      },
      mutationContext,
    ),
  ).resolves.toMatchObject({
    challenge: 'EMAIL_OTP',
    session: 'mfa-after-password-session',
  })
})

test('fails closed when a recognized MFA challenge omits its opaque session', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        challenge: 'SOFTWARE_TOKEN_MFA',
        email: 'recovery@example.com',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

  await expect(
    loginWithPassword(
      {
        email: 'recovery@example.com',
        password: 'password',
        remember: false,
      },
      mutationContext,
    ),
  ).rejects.toMatchObject({
    status: 502,
  })
})
