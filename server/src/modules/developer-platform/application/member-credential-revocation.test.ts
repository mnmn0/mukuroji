import { expect, test } from 'bun:test'
import type { ApiKeySummary, OAuthAppSummary } from '@mukuroji/contracts'
import {
  revokeMemberCredentials,
  type MemberCredentialRevocationPorts,
} from './member-credential-revocation'

/**
 * Creates fake credential ports holding one active API key and one active OAuth application
 * created by the member, and recording each revocation with its actor.
 *
 * @returns The ports and the recorded revocations.
 */
function createPorts() {
  const revocations: string[] = []
  const apiKey: ApiKeySummary = {
    id: 'key-1',
    name: 'CI',
    prefix: 'mk_1',
    scopes: [],
    status: 'active',
    createdByUserId: 'sato@example.com',
    createdAt: '2026-07-01T00:00:00.000Z',
  }
  const oauthApp: OAuthAppSummary = {
    id: 'app-1',
    name: 'Sync',
    clientId: 'client-1',
    grantTypes: ['client_credentials'],
    scopes: [],
    status: 'active',
    createdByUserId: 'sato@example.com',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  }
  const ports: MemberCredentialRevocationPorts = {
    apiKeys: {
      async listApiKeys() {
        return [apiKey]
      },
      async revokeApiKey(request) {
        revocations.push(`api-key:${request.apiKeyId}:${request.actorUserId}`)
        return { ...apiKey, status: 'revoked' }
      },
    },
    oauthCredentials: {
      async listOAuthApps() {
        return [oauthApp]
      },
      async revokeOAuthApp(request) {
        revocations.push(`oauth-app:${request.oauthAppId}:${request.actorUserId}`)
        return { ...oauthApp, status: 'revoked' }
      },
    },
  }
  return { ports, revocations }
}

test('records the acting administrator on every revoked credential', async () => {
  const { ports, revocations } = createPorts()

  expect(await revokeMemberCredentials(ports, 'workspace-1', 'sato@example.com', 'admin@example.com'))
    .toEqual({ revokedApiKeyIds: ['key-1'], revokedOAuthAppIds: ['app-1'] })
  expect(revocations).toEqual([
    'api-key:key-1:admin@example.com',
    'oauth-app:app-1:admin@example.com',
  ])
})

test('revokes only the listed credentials when a set is given', async () => {
  const { ports, revocations } = createPorts()

  expect(await revokeMemberCredentials(ports, 'workspace-1', 'sato@example.com', 'admin@example.com', {
    revokedApiKeyIds: ['key-0'],
    revokedOAuthAppIds: ['app-1'],
  })).toEqual({ revokedApiKeyIds: [], revokedOAuthAppIds: ['app-1'] })
  expect(revocations).toEqual(['oauth-app:app-1:admin@example.com'])
})
