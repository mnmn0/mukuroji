import { expect, test } from 'bun:test'
import type { EnterpriseIdentitySnapshot } from '@mukuroji/contracts'
import {
  evaluateRealtimeMemberBoundary,
  toRealtimeScopeAttributes,
  toRealtimeSessionItem,
} from './realtime'

/**
 * Builds the common attributes of a stored realtime row.
 *
 * @returns Row attributes without scope fields.
 */
function baseRow(): Record<string, unknown> {
  return {
    connectionId: 'connection-1',
    itemType: 'connection',
    workspaceId: 'workspace-1',
    memberKey: 'member@example.com',
    systemAdmin: false,
    canWrite: false,
    scopeKey: 'workspace-1#document#doc-1',
    expiresAt: 1_783_818_000,
    authorizationExpiresAt: 1_783_814_700,
    authenticatedAt: 1_783_814_400,
    tokenExpiresAt: 1_783_818_000,
    authenticationSessionId: 'session-digest-1',
    authenticationMethods: ['pwd'],
    clientIp: '203.0.113.42',
  }
}

test('reads a Document row as a Document scope with no team or issue', () => {
  const session = toRealtimeSessionItem({
    ...baseRow(),
    scopeType: 'document',
    documentId: 'doc-1',
  })

  expect(session).toMatchObject({
    scopeType: 'document',
    documentId: 'doc-1',
    teamId: '',
    issueId: '',
  })
  expect(session && toRealtimeScopeAttributes(session)).toEqual({
    scopeType: 'document',
    documentId: 'doc-1',
  })
})

test('rejects Document rows that also name a Work Item and rows with an unknown scope', () => {
  expect(toRealtimeSessionItem({
    ...baseRow(),
    scopeType: 'document',
    documentId: 'doc-1',
    teamId: 'core',
    issueId: 'issue-1',
  })).toBeUndefined()
  expect(toRealtimeSessionItem({
    ...baseRow(),
    scopeType: 'document',
  })).toBeUndefined()
  expect(toRealtimeSessionItem({
    ...baseRow(),
    scopeType: 'project',
    teamId: 'core',
    issueId: 'issue-1',
  })).toBeUndefined()
})

test('keeps Work Item rows unchanged and still requires their team and issue', () => {
  const session = toRealtimeSessionItem({
    ...baseRow(),
    teamId: 'core',
    issueId: 'issue-1',
  })

  expect(session?.scopeType).toBeUndefined()
  expect(session && toRealtimeScopeAttributes(session)).toEqual({
    teamId: 'core',
    issueId: 'issue-1',
  })
  expect(toRealtimeSessionItem({ ...baseRow(), teamId: 'core' })).toBeUndefined()
})

/**
 * Builds an enterprise snapshot whose only verified domain is example.com.
 *
 * @returns The snapshot.
 */
function verifiedDomainSnapshot(): EnterpriseIdentitySnapshot {
  return {
    workspaceId: 'workspace-1',
    identityProviders: [],
    domains: [{
      workspaceId: 'workspace-1',
      domainId: 'domain-1',
      domain: 'example.com',
      status: 'verified',
      revision: 1,
      verificationRecordName: '_mukuroji.example.com',
      verifiedAt: '2026-07-18T00:00:00.000Z',
      enforceSso: false,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }],
    customRoles: [],
    groupMappings: [],
    roleAssignments: [],
    scimUsers: [],
    scimGroups: [],
    scimCredentials: [],
    serviceAccounts: [],
    breakGlassAccounts: [],
    provisioningRuns: [],
    provisioningLogs: [],
  }
}

test('classifies members outside the verified domains as external for Document sessions', () => {
  const snapshot = verifiedDomainSnapshot()

  expect(evaluateRealtimeMemberBoundary(
    snapshot,
    'member@example.com',
    'member@example.com',
    'member',
    [],
  )).toMatchObject({ external: false, boundaryDenied: false })
  expect(evaluateRealtimeMemberBoundary(
    snapshot,
    'partner@partner.example',
    'partner@partner.example',
    'member',
    [],
  )).toMatchObject({ external: true, boundaryDenied: false })
  expect(evaluateRealtimeMemberBoundary(
    snapshot,
    'guest@example.com',
    'guest@example.com',
    'guest',
    [],
  )).toMatchObject({ external: true })
})
