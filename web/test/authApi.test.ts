import { afterEach, expect, test } from 'bun:test'
import { completeNewPasswordChallenge, loginWithPassword } from '../src/auth/api'

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
      expiresIn: 3600,
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
