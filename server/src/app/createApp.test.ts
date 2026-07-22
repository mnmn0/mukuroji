import { expect, test } from 'bun:test'
import { FlociCognitoClient } from '../api/api-router'
import {
  createTestAppDependencies,
  overrideAppDependencies,
} from './composition/api-dependencies'
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
  const cognitoFetch: typeof fetch = async (input) => {
    const endpoint = new URL(String(input)).hostname
    return Response.json({
      AuthenticationResult: {
        AccessToken: endpoint.startsWith('first-') ? 'first-token' : 'second-token',
      },
    })
  }
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
