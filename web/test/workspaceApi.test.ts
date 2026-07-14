import { afterEach, expect, test } from 'bun:test'
import {
  acknowledgeWorkspaceInvitationCleanup,
  createWorkspaceInvitation,
  WorkspaceAccessApiError,
} from '../src/workspace/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('sends the current invitation version when confirming manual Cognito cleanup', async () => {
  let request: { input: string | URL | Request; init?: RequestInit } | undefined
  globalThis.fetch = (async (input, init) => {
    request = { input, init }
    return new Response(JSON.stringify({
      invitation: {
        id: 'legacy@example.com',
        status: 'revoked',
        identityCleanupCompleted: true,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  await acknowledgeWorkspaceInvitationCleanup(
    'access-token',
    'legacy@example.com',
    7,
  )

  expect(String(request?.input)).toEndWith(
    '/workspace/invitations/legacy%40example.com/cleanup/acknowledge',
  )
  expect(request?.init).toMatchObject({
    body: JSON.stringify({ expectedVersion: 7 }),
    method: 'POST',
  })
})

test('preserves the Cognito disabled error code for Workspace invitation UI', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 'CognitoUserDisabled',
    message: 'The existing Cognito user is disabled.',
  }), {
    headers: { 'Content-Type': 'application/json' },
    status: 409,
  })) as typeof fetch

  const error = await createWorkspaceInvitation('access-token', {
    email: 'disabled@example.com',
    role: 'member',
  }).catch((reason: unknown) => reason)

  expect(error).toBeInstanceOf(WorkspaceAccessApiError)
  expect(error).toMatchObject({
    code: 'CognitoUserDisabled',
    status: 409,
  })
})
