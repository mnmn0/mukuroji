import { expect, test } from 'bun:test'
import { FlociCognitoClient } from '../api/api-router'
import {
  createTestAppDependencies,
  overrideAppDependencies,
} from './composition/api-dependencies'
import type {
  RuntimeControlSnapshot,
} from '../infrastructure/runtime/runtime-control'
import { createApp } from './createApp'

test('binds concurrent app instances to independent immutable dependencies', async () => {
  const names: ReadonlyArray<'COGNITO_CLIENT_ID' | 'COGNITO_USER_POOL_ID'> = [
    'COGNITO_CLIENT_ID',
    'COGNITO_USER_POOL_ID',
  ]
  const originalEnvironment = new Map(names.map((name) => [name, Bun.env[name]]))
  const originalFetch = globalThis.fetch
  Bun.env.COGNITO_CLIENT_ID = 'isolated-client'
  Bun.env.COGNITO_USER_POOL_ID = 'us-east-1_isolated'
  const cognitoFetch = Object.assign(
    async (input: URL | RequestInfo) => {
      const endpoint = new URL(String(input)).hostname
      return Response.json({
        AuthenticationResult: {
          AccessToken: endpoint.startsWith('first-') ? 'first-token' : 'second-token',
        },
      })
    },
    { preconnect() {} },
  ) satisfies typeof fetch
  globalThis.fetch = cognitoFetch

  try {
    const firstDependencies = overrideAppDependencies(createTestAppDependencies(), {
      cognito: new FlociCognitoClient('https://first-cognito.example.com'),
    })
    const mutableAuthentication = { ...firstDependencies.authentication }
    const firstApp = createApp({
      ...firstDependencies,
      authentication: mutableAuthentication,
    })
    const secondApp = createApp(overrideAppDependencies(createTestAppDependencies(), {
      cognito: new FlociCognitoClient('https://second-cognito.example.com'),
    }))
    mutableAuthentication.cognito = new FlociCognitoClient(
      'https://mutated-cognito.example.com',
    )
    const request = (application: ReturnType<typeof createApp>, email: string) =>
      application.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password' }),
      })

    const [firstResponse, secondResponse] = await Promise.all([
      request(firstApp, 'first@example.com'),
      request(secondApp, 'second@example.com'),
    ])

    expect(await firstResponse.json()).toMatchObject({ accessToken: 'first-token' })
    expect(await secondResponse.json()).toMatchObject({ accessToken: 'second-token' })
  } finally {
    globalThis.fetch = originalFetch
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete Bun.env[name]
      else Bun.env[name] = value
    }
  }
})

test('applies common CORS middleware around the mounted route inventory', async () => {
  const originalAllowedOrigins = Bun.env.ALLOWED_ORIGINS
  Bun.env.ALLOWED_ORIGINS = 'https://app.example.com, https://admin.example.com'

  try {
    const app = createApp(createTestAppDependencies())
    const allowedResponse = await app.request('/api/health', {
      headers: { Origin: 'https://admin.example.com' },
    })
    const deniedResponse = await app.request('/api/health', {
      headers: { Origin: 'https://other.example.com' },
    })

    expect(allowedResponse.status).toBe(200)
    expect(allowedResponse.headers.get('access-control-allow-origin')).toBe(
      'https://admin.example.com',
    )
    expect(deniedResponse.headers.get('access-control-allow-origin')).toBeNull()
  } finally {
    if (originalAllowedOrigins === undefined) delete Bun.env.ALLOWED_ORIGINS
    else Bun.env.ALLOWED_ORIGINS = originalAllowedOrigins
  }
})

test('keeps liveness independent from the runtime-control provider', async () => {
  let providerCalls = 0
  let readinessCalls = 0
  const app = createApp(overrideAppDependencies(
    createTestAppDependencies(),
    {
      readiness: {
        async check() {
          readinessCalls += 1
          return { checks: [], ready: true }
        },
      },
      runtimeControl: {
        async getSnapshot() {
          providerCalls += 1
          throw new Error('runtime provider must not serve liveness')
        },
      },
    },
  ))

  const response = await app.request('/api/health')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ok: true,
    status: 'alive',
  })
  expect(providerCalls).toBe(0)
  expect(readinessCalls).toBe(0)
})

test('wires deployment commit provenance into liveness', async () => {
  const app = createApp(overrideAppDependencies(
    createTestAppDependencies(),
    {
      applicationCommitSha: '0123456789abcdef0123456789abcdef01234567',
    },
  ))

  const response = await app.request('/api/health')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    applicationCommitSha: '0123456789abcdef0123456789abcdef01234567',
    ok: true,
    status: 'alive',
  })
})

test('fails readiness before dependency probes unless runtime control is current and enabled', async () => {
  const blockedSnapshots: RuntimeControlSnapshot[] = [
    {
      mode: 'disabled',
      revision: 1,
      status: 'current',
    },
    {
      ageMilliseconds: 1,
      mode: 'enabled',
      revision: 1,
      status: 'stale',
    },
    {
      mode: 'disabled',
      status: 'unavailable',
    },
  ]

  for (const snapshot of blockedSnapshots) {
    let providerCalls = 0
    let readinessCalls = 0
    const app = createApp(overrideAppDependencies(
      createTestAppDependencies(),
      {
        readiness: {
          async check() {
            readinessCalls += 1
            return { checks: [], ready: true }
          },
        },
        runtimeControl: {
          async getSnapshot() {
            providerCalls += 1
            return snapshot
          },
        },
      },
    ))

    const response = await app.request('/api/ready')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      ok: false,
      status: 'not-ready',
      checks: [{ name: 'runtime-control', ready: false }],
    })
    expect(providerCalls).toBe(1)
    expect(readinessCalls).toBe(0)
  }
})

test('runs dependency readiness after current enabled runtime admission', async () => {
  let providerCalls = 0
  let readinessCalls = 0
  const app = createApp(overrideAppDependencies(
    createTestAppDependencies(),
    {
      readiness: {
        async check() {
          readinessCalls += 1
          return {
            checks: [{ name: 'database', ready: true }],
            ready: true,
          }
        },
      },
      runtimeControl: {
        async getSnapshot() {
          providerCalls += 1
          return {
            mode: 'enabled',
            revision: 1,
            status: 'current',
          }
        },
      },
    },
  ))

  const response = await app.request('/api/ready')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ok: true,
    status: 'ready',
    checks: [
      { name: 'database', ready: true },
      { name: 'runtime-control', ready: true },
    ],
  })
  expect(providerCalls).toBe(1)
  expect(readinessCalls).toBe(1)
})

test('never caches readiness across enabled and disabled control states', async () => {
  let snapshot: RuntimeControlSnapshot = {
    mode: 'enabled',
    revision: 1,
    status: 'current',
  }
  const app = createApp(overrideAppDependencies(
    createTestAppDependencies(),
    {
      readiness: {
        async check() {
          return { checks: [], ready: true }
        },
      },
      runtimeControl: {
        async getSnapshot() {
          return snapshot
        },
      },
    },
  ))

  const readyResponse = await app.request('/api/ready')
  snapshot = {
    mode: 'disabled',
    revision: 2,
    status: 'current',
  }
  const blockedResponse = await app.request('/api/ready')

  expect(readyResponse.status).toBe(200)
  expect(blockedResponse.status).toBe(503)
  for (const response of [readyResponse, blockedResponse]) {
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Pragma')).toBe('no-cache')
  }
})
