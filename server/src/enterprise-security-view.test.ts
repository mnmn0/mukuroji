import { expect, test } from 'bun:test'
import type { EnterpriseIdentitySnapshot } from '@mukuroji/contracts'
import {
  createDefaultEnterpriseSecurityPolicy,
  toEnterpriseSecuritySnapshotView,
} from './enterprise-security-view'

test('uses a non-enforcing security policy until an administrator opts in', () => {
  expect(createDefaultEnterpriseSecurityPolicy('workspace-1')).toMatchObject({
    workspaceId: 'workspace-1',
    loginMode: 'password-or-sso',
    mfaRequirement: 'optional',
    ipAllowlistMode: 'disabled',
    externalAccess: {
      allowGuests: true,
      allowExternalCollaborators: true,
    },
    revision: 0,
  })
})

test('maps provider, domain, role, and provisioning state to the security UI contract', () => {
  const snapshot = {
    workspaceId: 'workspace-1',
    identityProviders: [{
      workspaceId: 'workspace-1',
      providerId: 'idp-1',
      kind: 'oidc',
      displayName: 'Example IdP',
      cognitoProviderName: 'ExampleProvider',
      status: 'active',
      revision: 1,
      issuer: 'https://idp.example.com',
      clientId: 'mukuroji',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/jwks',
      scopes: ['openid', 'email'],
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      lastTestedAt: '2026-07-18T00:00:00.000Z',
    }],
    domains: [{
      workspaceId: 'workspace-1',
      domainId: 'domain-1',
      domain: 'example.com',
      status: 'verified',
      revision: 1,
      verificationRecordName: '_mukuroji.example.com',
      verifiedAt: '2026-07-18T00:00:00.000Z',
      enforceSso: true,
      identityProviderId: 'idp-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }],
    customRoles: [{
      workspaceId: 'workspace-1',
      roleId: 'custom:reviewer',
      name: 'Reviewer',
      permissions: ['files.read', 'files.approve'],
      guestAssignable: true,
      revision: 2,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }],
    groupMappings: [],
    roleAssignments: [],
    scimUsers: [],
    scimGroups: [],
    scimCredentials: [{
      workspaceId: 'workspace-1',
      identityProviderId: 'idp-1',
      credentialId: 'credential-1',
      label: 'Okta',
      createdAt: '2026-07-18T00:00:00.000Z',
    }],
    serviceAccounts: [],
    breakGlassAccounts: [],
    provisioningRuns: [],
    provisioningLogs: [],
  } satisfies EnterpriseIdentitySnapshot

  expect(toEnterpriseSecuritySnapshotView(
    snapshot,
    'https://api.example.com/api/scim/v2/workspace-1',
  )).toMatchObject({
    identityProvider: {
      status: 'verified',
      protocol: 'oidc',
      issuer: 'https://idp.example.com',
      ssoUrl: 'https://idp.example.com/authorize',
      enforced: true,
    },
    domains: [{ domain: 'example.com', status: 'verified' }],
    scim: {
      status: 'ready',
      endpointUrl: 'https://api.example.com/api/scim/v2/workspace-1',
      tokenGeneration: 1,
    },
    roles: expect.arrayContaining([
      expect.objectContaining({
        id: 'custom:reviewer',
        permissionIds: ['files.read', 'files.approve'],
      }),
    ]),
  })
})
