import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureEnterpriseScimGuestRoleScenario,
  configureFakeProjectClients,
  drainEnterpriseScimGroupJob,
  processEnterpriseScimGroupJobPage,
  requireEnterpriseScimGroupJobProcessor,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import {
  createEnterpriseScimGroupJobWorkerHandler,
} from '../../../../handlers/enterprise-scim-group-job-worker-handler'
import type {
  WorkspaceAccessClient,
} from '../../../workspace-access/workspace-access'
import {
  WorkspaceAccessError,
} from '../../../workspace-access/workspace-access'
import {
  EnterpriseIdentityError,
  InMemoryEnterpriseIdentityClient,
  resolveEnterpriseDirectoryPrincipal,
} from '../../enterprise-identity'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('binds a route-issued SCIM credential to the active Cognito provider', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    configureFakeProjectClients(true)
    const workspaceId = 'user#demo@example.com'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    await identity.putIdentityProvider({
      workspaceId,
      providerId: 'idp-1',
      kind: 'oidc',
      displayName: 'Enterprise OIDC',
      cognitoProviderName: 'EnterpriseOidc',
      status: 'active',
      revision: 1,
      issuer: 'https://idp.example.com',
      clientId: 'enterprise-client',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      jwksUri: 'https://idp.example.com/jwks',
      scopes: ['openid', 'email'],
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
    })
    setTestAppDependencies({
      enterpriseIdentity: identity,
      enterpriseSessionActivity: {
        async getAuthenticationMethods() {
          return []
        },
        async recordAuthenticationAssurance() {
          return undefined
        },
        async validateAndTouch(input) {
          return [...input.authenticationMethods]
        },
      },
    })

    const response = await app.request('/api/enterprise/security/scim/token', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'route-scim-token',
      },
      body: JSON.stringify({ expectedVersion: 0 }),
    })

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body).toMatchObject({
      scim: {
        identityProviderId: 'idp-1',
        tokenGeneration: 1,
      },
    })
    expect(body.token).toStartWith('msc_')
    expect(body.scim.tokenLastFour).toBe(body.token.slice(-4))
    expect(await identity.authenticateScimToken(workspaceId, body.token))
      .toMatchObject({ identityProviderId: 'idp-1' })

    const snapshotResponse = await app.request('/api/enterprise/security', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(snapshotResponse.status).toBe(200)
    expect((await snapshotResponse.json()).scim.tokenLastFour)
      .toBe(body.token.slice(-4))
  })
})

test('scopes SCIM collection reads to the credential identity provider', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    const calls = configureFakeProjectClients(true)
    const workspaceId = 'workspace-scim-provider-scope'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    for (const providerId of ['idp-a', 'idp-b']) {
      await identity.putIdentityProvider({
        workspaceId,
        providerId,
        kind: 'oidc',
        displayName: providerId,
        cognitoProviderName: 'EnterpriseOidc',
        status: 'active',
        revision: 1,
        issuer: 'https://idp.example.com',
        clientId: 'enterprise-client',
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        jwksUri: 'https://idp.example.com/jwks',
        scopes: ['openid', 'email'],
        createdAt: now,
        updatedAt: now,
        lastTestedAt: now,
      })
    }
    const credentialA = await identity.issueScimToken(
      workspaceId,
      'idp-a',
      'Provider A',
    )
    const credentialB = await identity.issueScimToken(
      workspaceId,
      'idp-b',
      'Provider B',
    )
    const userA = await identity.upsertScimUser({
      workspaceId,
      identityProviderId: 'idp-a',
      externalId: 'shared-user',
      userName: 'a@example.com',
      emails: ['a@example.com'],
      active: true,
      idempotencyKey: 'create-shared-user',
    })
    await identity.upsertScimUser({
      workspaceId,
      identityProviderId: 'idp-b',
      externalId: 'shared-user',
      userName: 'b@example.com',
      emails: ['b@example.com'],
      active: true,
      idempotencyKey: 'create-shared-user',
    })
    for (let index = 0; index < 21; index += 1) {
      await identity.upsertScimGroup({
        workspaceId,
        identityProviderId: 'idp-a',
        externalId: `paged-group-${index}`,
        displayName: `Paged group ${index}`,
        active: true,
        memberUserIds: [],
        idempotencyKey: `paged-group-${index}`,
      })
    }
    setTestAppDependencies({ enterpriseIdentity: identity })

    const responseA = await app.request(
      `/api/scim/v2/${workspaceId}/Users`,
      { headers: { Authorization: `Bearer ${credentialA.token}` } },
    )
    const responseB = await app.request(
      `/api/scim/v2/${workspaceId}/Users`,
      { headers: { Authorization: `Bearer ${credentialB.token}` } },
    )
    const caseFoldedUserName = await app.request(
      `/api/scim/v2/${workspaceId}/Users?filter=${
        encodeURIComponent('UsErNaMe eq "A@EXAMPLE.COM"')
      }`,
      { headers: { Authorization: `Bearer ${credentialA.token}` } },
    )
    const boundedGroups = await app.request(
      `/api/scim/v2/${workspaceId}/Groups?count=200`,
      { headers: { Authorization: `Bearer ${credentialA.token}` } },
    )
    const serviceProviderConfig = await app.request(
      `/api/scim/v2/${workspaceId}/ServiceProviderConfig`,
      { headers: { Authorization: `Bearer ${credentialA.token}` } },
    )

    expect(responseA.status).toBe(200)
    expect(responseB.status).toBe(200)
    expect(caseFoldedUserName.status).toBe(200)
    expect(await caseFoldedUserName.json()).toMatchObject({
      totalResults: 1,
      Resources: [{ id: userA.userId }],
    })
    expect(boundedGroups.status).toBe(200)
    expect(await boundedGroups.json()).toMatchObject({
      totalResults: 21,
      itemsPerPage: 20,
    })
    expect(serviceProviderConfig.status).toBe(200)
    expect(await serviceProviderConfig.json()).toMatchObject({
      filter: { supported: true, maxResults: 200 },
    })
    const responseABody = await responseA.json()
    expect(responseABody).toMatchObject({
      totalResults: 1,
      Resources: [{ id: userA.userId, externalId: 'shared-user' }],
    })
    expect(responseABody.Resources[0]).not.toHaveProperty('groups')
    expect((await responseB.json()).Resources[0].id).not.toBe(userA.userId)
    expect(calls.cognitoIdentityProviderDescriptions).toEqual(['EnterpriseOidc'])

    const unavailableIdentity = new Proxy(identity, {
      get(target, property) {
        if (property === 'listScimUsers') {
          return async () => {
            throw new EnterpriseIdentityError(
              503,
              'EnterpriseScimProjectionUnavailable',
              'SCIM projection is temporarily unavailable.',
              true,
            )
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    setTestAppDependencies({ enterpriseIdentity: unavailableIdentity })
    const unavailable = await app.request(
      `/api/scim/v2/${workspaceId}/Users`,
      { headers: { Authorization: `Bearer ${credentialA.token}` } },
    )
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ status: '503' })

    configureFakeProjectClients(true, {
      cognitoProviderDetails: {
        oidc_issuer: 'https://replacement.example.com',
        client_id: 'enterprise-client',
      },
    })
    setTestAppDependencies({ enterpriseIdentity: identity })
    const drifted = await app.request(
      `/api/scim/v2/${workspaceId}/Users`,
      { headers: { Authorization: `Bearer ${credentialA.token}` } },
    )
    expect(drifted.status).toBe(409)
  })
})

test('rejects oversized or structurally unbounded SCIM inputs before mutation', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    const workspaceId = 'workspace-scim-input-limits'
    const scenario = await configureEnterpriseScimGuestRoleScenario(workspaceId)
    const scimBaseUrl = `/api/scim/v2/${encodeURIComponent(workspaceId)}`
    const headers = {
      Authorization: `Bearer ${scenario.scimToken}`,
      'Content-Type': 'application/scim+json',
    }
    const oversizedHeader = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': String(512 * 1024 + 1),
      },
      body: '{}',
    })
    const oversizedBody = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ padding: 'x'.repeat(512 * 1024) }),
    })
    const malformedBody = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers,
      body: '{',
    })
    const nonObjectBody = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers,
      body: '[]',
    })
    const excessiveEmails = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        externalId: 'too-many-emails',
        userName: 'too-many-emails@example.com',
        emails: Array.from(
          { length: 11 },
          (_, index) => ({ value: `email-${index}@example.com` }),
        ),
        active: true,
      }),
    })
    const excessiveMembers = await app.request(`${scimBaseUrl}/Groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        externalId: 'too-many-members',
        displayName: 'Too many members',
        members: Array.from(
          { length: 1_001 },
          (_, index) => ({ value: `member-${index}` }),
        ),
        active: true,
      }),
    })
    const oversizedMemberId = await app.request(`${scimBaseUrl}/Groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        externalId: 'oversized-member-id',
        displayName: 'Oversized member ID',
        members: [{ value: 'm'.repeat(129) }],
        active: true,
      }),
    })
    const oversizedUserName = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        externalId: 'oversized-user-name',
        userName: 'u'.repeat(321),
        emails: [{ value: 'bounded@example.com' }],
        active: true,
      }),
    })
    const oversizedGroupDisplayName = await app.request(`${scimBaseUrl}/Groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        externalId: 'oversized-group-display-name',
        displayName: 'g'.repeat(257),
        members: [],
        active: true,
      }),
    })
    const oversizedResourceId = await app.request(
      `${scimBaseUrl}/Users/${'r'.repeat(129)}`,
      { headers },
    )
    const oversizedIdempotencyKey = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'k'.repeat(257),
      },
      body: JSON.stringify({
        externalId: 'oversized-idempotency-key',
        userName: 'bounded@example.com',
        emails: [{ value: 'bounded@example.com' }],
        active: true,
      }),
    })
    const groupResponse = await app.request(`${scimBaseUrl}/Groups`, {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'bounded-patch-group',
      },
      body: JSON.stringify({
        externalId: 'bounded-patch-group',
        displayName: 'Bounded patch group',
        members: [],
        active: true,
      }),
    })
    const group = await groupResponse.json()
    const excessivePatchOperations = await app.request(
      `${scimBaseUrl}/Groups/${encodeURIComponent(group.id)}`,
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'If-Match': 'W/"1"',
        },
        body: JSON.stringify({
          Operations: Array.from(
            { length: 101 },
            () => ({
              op: 'replace',
              path: 'displayName',
              value: 'Repeated update',
            }),
          ),
        }),
      },
    )
    const oversizedFilter = await app.request(
      `${scimBaseUrl}/Users?filter=${
        encodeURIComponent(`externalId eq "${'f'.repeat(513)}"`)
      }`,
      { headers },
    )

    expect(oversizedHeader.status).toBe(413)
    expect(await oversizedHeader.json()).toMatchObject({ status: '413' })
    expect(oversizedBody.status).toBe(413)
    expect(await oversizedBody.json()).toMatchObject({ status: '413' })
    expect(malformedBody.status).toBe(400)
    expect(nonObjectBody.status).toBe(400)
    expect(excessiveEmails.status).toBe(413)
    expect(excessiveMembers.status).toBe(413)
    expect(oversizedMemberId.status).toBe(400)
    expect(oversizedUserName.status).toBe(400)
    expect(oversizedGroupDisplayName.status).toBe(400)
    expect(oversizedResourceId.status).toBe(400)
    expect(oversizedIdempotencyKey.status).toBe(400)
    expect(groupResponse.status).toBe(202)
    expect(groupResponse.headers.get('Retry-After')).toBe('1')
    expect(excessivePatchOperations.status).toBe(413)
    expect(oversizedFilter.status).toBe(400)
  })
})

test('uses provider-qualified SCIM authority and never grants failed desired state', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    configureFakeProjectClients(true)
    const workspaceId = 'workspace-scim-authority'
    const identity = new InMemoryEnterpriseIdentityClient()
    const now = new Date().toISOString()
    const credentials = new Map<string, string>()
    for (const providerId of ['idp-a', 'idp-b', 'idp-c']) {
      await identity.putIdentityProvider({
        workspaceId,
        providerId,
        kind: 'oidc',
        displayName: providerId,
        cognitoProviderName: 'EnterpriseOidc',
        status: 'active',
        revision: 1,
        issuer: 'https://idp.example.com',
        clientId: 'enterprise-client',
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        jwksUri: 'https://idp.example.com/jwks',
        scopes: ['openid', 'email'],
        createdAt: now,
        updatedAt: now,
        lastTestedAt: now,
      })
      credentials.set(
        providerId,
        (await identity.issueScimToken(workspaceId, providerId, providerId)).token,
      )
    }

    let currentMember: Awaited<ReturnType<WorkspaceAccessClient['getMember']>>
    const reconciledAuthorityIds: string[] = []
    setTestAppDependencies({
      enterpriseIdentity: identity,
      workspaceAccess: {
        async getMember(_workspaceId: string, memberKey: string) {
          return currentMember?.memberKey === memberKey ? currentMember : undefined
        },
        async reconcileDirectoryMember(_workspaceId, input) {
          reconciledAuthorityIds.push(input.externalIdentityId)
          if (
            currentMember?.externalIdentityId &&
            currentMember.externalIdentityId !== input.externalIdentityId
          ) {
            throw new WorkspaceAccessError(
              409,
              'WorkspaceDirectoryIdentityConflict',
              'Directory identity does not own this member.',
            )
          }
          currentMember = {
            id: input.memberKey,
            memberKey: input.memberKey,
            email: input.email,
            name: input.name,
            role: input.role,
            status: 'active',
            provisioningSource: 'directory',
            externalIdentityId: input.externalIdentityId,
            version: (currentMember?.version ?? 0) + 1,
            createdAt: currentMember?.createdAt ?? now,
            updatedAt: now,
          }
          return currentMember
        },
      } as unknown as WorkspaceAccessClient,
    })

    const postUser = (
      providerId: string,
      externalId: string,
      userName: string,
    ) => app.request(`/api/scim/v2/${workspaceId}/Users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.get(providerId)}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `${providerId}:${externalId}`,
      },
      body: JSON.stringify({
        externalId,
        userName,
        emails: [{ value: 'shared-member@example.com', primary: true }],
        active: true,
      }),
    })

    const providerAResponse = await postUser('idp-a', 'shared-user', 'a@example.com')
    const providerBResponse = await postUser('idp-b', 'shared-user', 'b@example.com')
    const providerCResponse = await postUser('idp-c', 'different-user', 'c@example.com')
    expect(providerAResponse.status).toBe(201)
    expect(providerBResponse.status).toBe(409)
    expect(providerCResponse.status).toBe(409)

    const providerAResource = await providerAResponse.json()
    const snapshot = await identity.getSnapshot(workspaceId)
    const providerBUser = snapshot.scimUsers.find((user) =>
      user.identityProviderId === 'idp-b'
    )
    expect(currentMember?.externalIdentityId).toBe(providerAResource.id)
    expect(new Set(reconciledAuthorityIds)).toEqual(
      new Set(snapshot.scimUsers.map((user) => user.userId)),
    )
    expect(snapshot.scimUsers.map((user) => user.userId)).not.toContain('shared-user')
    expect(providerBUser).toMatchObject({
      externalId: 'shared-user',
      linkedMemberKey: 'shared-member@example.com',
      appliedVersion: 0,
    })
    if (!providerBUser) throw new Error('Expected provider B desired user state.')

    const providerBGroup = await identity.upsertScimGroup({
      workspaceId,
      identityProviderId: 'idp-b',
      externalId: 'shared-group',
      displayName: 'Provider B administrators',
      active: true,
      memberUserIds: [providerBUser.userId],
      idempotencyKey: 'provider-b-group',
    })
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'provider-b-admins',
      identityProviderId: 'idp-b',
      directoryGroupId: providerBGroup.groupId,
      roleId: 'workspace:admin',
      scope: { workspaceId, kind: 'workspace' },
      enabled: true,
      priority: 0,
      revision: 1,
      updatedAt: now,
    })
    const afterMapping = await identity.getSnapshot(workspaceId)
    expect(
      resolveEnterpriseDirectoryPrincipal(
        afterMapping,
        'shared-member@example.com',
        [],
      ).compatibleGroupMappings,
    ).toEqual([])
  })
})

test('reconciles workspace guest roles for SCIM membership and mapping changes', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    const workspaceId = 'user#demo@example.com'
    const scenario = await configureEnterpriseScimGuestRoleScenario(workspaceId)
    const scimBaseUrl = `/api/scim/v2/${encodeURIComponent(workspaceId)}`
    const scimHeaders = {
      Authorization: `Bearer ${scenario.scimToken}`,
      'Content-Type': 'application/scim+json',
    }
    const userResponse = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers: { ...scimHeaders, 'Idempotency-Key': 'guest-role-user' },
      body: JSON.stringify({
        externalId: 'managed-user',
        userName: 'managed@example.com',
        displayName: 'Managed user',
        emails: [{ value: 'managed@example.com', primary: true }],
        active: true,
      }),
    })
    expect(userResponse.status).toBe(201)
    const user = await userResponse.json()
    const removeDisplayNameResponse = await app.request(
      `${scimBaseUrl}/Users/${user.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'remove-managed-user-display-name',
          'If-Match': 'W/"1"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'remove',
            path: 'DisplayName',
          }],
        }),
      },
    )
    expect(removeDisplayNameResponse.status).toBe(200)
    expect(await removeDisplayNameResponse.json()).not.toHaveProperty('displayName')
    const removeRequiredUserNameResponse = await app.request(
      `${scimBaseUrl}/Users/${user.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'remove-managed-user-name',
          'If-Match': 'W/"2"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'remove',
            path: 'UserName',
          }],
        }),
      },
    )
    expect(removeRequiredUserNameResponse.status).toBe(400)
    const removeRequiredEmailsResponse = await app.request(
      `${scimBaseUrl}/Users/${user.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'remove-managed-user-emails',
          'If-Match': 'W/"2"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'remove',
            path: 'Emails',
          }],
        }),
      },
    )
    expect(removeRequiredEmailsResponse.status).toBe(400)
    const groupResponse = await app.request(`${scimBaseUrl}/Groups`, {
      method: 'POST',
      headers: { ...scimHeaders, 'Idempotency-Key': 'guest-role-group' },
      body: JSON.stringify({
        externalId: 'workspace-guests',
        displayName: 'Workspace guests',
        members: [{ value: user.id }],
        active: true,
      }),
    })
    expect(groupResponse.status).toBe(202)
    expect(groupResponse.headers.get('Retry-After')).toBe('1')
    const group = await groupResponse.json()
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )

    const mappingResponse = await app.request(
      '/api/enterprise/security/group-mappings',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'workspace-guest-mapping',
        },
        body: JSON.stringify({
          identityProviderId: 'idp-guest-role',
          directoryGroupId: group.id,
          scopeType: 'workspace',
          roleId: 'workspace:guest',
        }),
      },
    )
    expect(mappingResponse.status).toBe(201)
    const mapping = (await mappingResponse.json()).mapping
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')
    expect(await scenario.identity.getScimGroupJobReference(
      workspaceId,
      group.id,
    )).toBeDefined()
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    expect(scenario.members.get('managed@example.com')?.role).toBe('guest')
    const replayMappingResponse = await app.request(
      '/api/enterprise/security/group-mappings',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'workspace-guest-mapping',
        },
        body: JSON.stringify({
          identityProviderId: 'idp-guest-role',
          directoryGroupId: group.id,
          scopeType: 'workspace',
          roleId: 'workspace:guest',
        }),
      },
    )
    expect(replayMappingResponse.status).toBe(200)
    expect(await scenario.identity.getScimGroupJobReference(
      workspaceId,
      group.id,
    )).toBeUndefined()

    const removeMemberResponse = await app.request(
      `${scimBaseUrl}/Groups/${group.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'remove-workspace-guest',
          'If-Match': 'W/"1"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'remove',
            path: 'MeMbErS',
          }],
        }),
      },
    )
    expect(removeMemberResponse.status).toBe(202)
    expect(removeMemberResponse.headers.get('Retry-After')).toBe('1')
    expect(scenario.members.get('managed@example.com')?.role).toBe('guest')
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')

    const addMemberResponse = await app.request(
      `${scimBaseUrl}/Groups/${group.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'add-workspace-guest',
          'If-Match': 'W/"2"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'add',
            path: 'MEMBERS',
            value: { value: user.id },
          }],
        }),
      },
    )
    expect(addMemberResponse.status).toBe(202)
    expect(addMemberResponse.headers.get('Retry-After')).toBe('1')
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    expect(scenario.members.get('managed@example.com')?.role).toBe('guest')

    const renameGroupResponse = await app.request(
      `${scimBaseUrl}/Groups/${group.id}`,
      {
        method: 'PUT',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'rename-workspace-guests',
          'If-Match': 'W/"3"',
        },
        body: JSON.stringify({
          displayName: 'Renamed workspace guests',
          members: [{ value: user.id }],
          active: true,
        }),
      },
    )
    expect(renameGroupResponse.status).toBe(202)
    expect(renameGroupResponse.headers.get('Retry-After')).toBe('1')
    expect(await renameGroupResponse.json()).toMatchObject({
      displayName: 'Renamed workspace guests',
      members: [{ value: user.id }],
    })
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    const removeRequiredGroupNameResponse = await app.request(
      `${scimBaseUrl}/Groups/${group.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'remove-workspace-guest-name',
          'If-Match': 'W/"4"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'remove',
            path: 'DisplayName',
          }],
        }),
      },
    )
    expect(removeRequiredGroupNameResponse.status).toBe(400)

    const memberMappingResponse = await app.request(
      `/api/enterprise/security/group-mappings/${mapping.id}`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: 1,
          directoryGroupId: group.id,
          scopeType: 'workspace',
          roleId: 'workspace:member',
        }),
      },
    )
    expect(memberMappingResponse.status).toBe(200)
    expect(scenario.members.get('managed@example.com')?.role).toBe('guest')
    expect(await scenario.identity.getScimGroupJobReference(
      workspaceId,
      group.id,
    )).toBeDefined()
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')

    const guestMappingResponse = await app.request(
      `/api/enterprise/security/group-mappings/${mapping.id}`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: 2,
          directoryGroupId: group.id,
          scopeType: 'workspace',
          roleId: 'workspace:guest',
        }),
      },
    )
    expect(guestMappingResponse.status).toBe(200)
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')
    expect(await scenario.identity.getScimGroupJobReference(
      workspaceId,
      group.id,
    )).toBeDefined()
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    expect(scenario.members.get('managed@example.com')?.role).toBe('guest')

    const deleteMappingResponse = await app.request(
      `/api/enterprise/security/group-mappings/${mapping.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expectedVersion: 3 }),
      },
    )
    expect(deleteMappingResponse.status).toBe(204)
    expect(scenario.members.get('managed@example.com')?.role).toBe('guest')
    expect(await scenario.identity.getScimGroupJobReference(
      workspaceId,
      group.id,
    )).toBeDefined()
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')

    const deleteGroupResponse = await app.request(
      `${scimBaseUrl}/Groups/${group.id}`,
      {
        method: 'DELETE',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'delete-workspace-guests',
          'If-Match': 'W/"4"',
        },
      },
    )
    expect(deleteGroupResponse.status).toBe(202)
    expect(deleteGroupResponse.headers.get('Retry-After')).toBe('1')
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    expect(
      (await scenario.identity.getSnapshot(workspaceId)).scimGroups.find(
        (candidate) => candidate.groupId === group.id,
      ),
    ).toMatchObject({
      active: false,
      appliedVersion: 5,
      version: 5,
    })
  })
})

test('settles interleaved multi-page SCIM group jobs to the final guest role', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    const workspaceId = 'user#demo@example.com'
    const scenario = await configureEnterpriseScimGuestRoleScenario(workspaceId)
    const scimBaseUrl = `/api/scim/v2/${encodeURIComponent(workspaceId)}`
    const scimHeaders = {
      Authorization: `Bearer ${scenario.scimToken}`,
      'Content-Type': 'application/scim+json',
    }
    const users = []
    for (let index = 0; index < 6; index += 1) {
      const email = `interleaved-user-${index}@example.com`
      const response = await app.request(`${scimBaseUrl}/Users`, {
        method: 'POST',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': `interleaved-user-${index}`,
        },
        body: JSON.stringify({
          externalId: `interleaved-user-${index}`,
          userName: email,
          emails: [{ value: email, primary: true }],
          active: true,
        }),
      })
      expect(response.status).toBe(201)
      users.push(await response.json())
    }
    const createGroup = async (suffix: string) => {
      const response = await app.request(`${scimBaseUrl}/Groups`, {
        method: 'POST',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': `interleaved-group-${suffix}`,
        },
        body: JSON.stringify({
          externalId: `interleaved-group-${suffix}`,
          displayName: `Interleaved group ${suffix}`,
          members: users.map((user) => ({ value: user.id })),
          active: true,
        }),
      })
      expect(response.status).toBe(202)
      expect(response.headers.get('Retry-After')).toBe('1')
      return await response.json()
    }
    const firstGroup = await createGroup('a')
    const secondGroup = await createGroup('b')
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      firstGroup.id,
    )
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      secondGroup.id,
    )

    for (const [index, group] of [firstGroup, secondGroup].entries()) {
      const mappingResponse = await app.request(
        '/api/enterprise/security/group-mappings',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
            'Idempotency-Key': `interleaved-mapping-${index}`,
          },
          body: JSON.stringify({
            identityProviderId: 'idp-guest-role',
            directoryGroupId: group.id,
            scopeType: 'workspace',
            roleId: 'workspace:guest',
          }),
        },
      )
      expect(mappingResponse.status).toBe(201)
      await drainEnterpriseScimGroupJob(
        scenario.identity,
        workspaceId,
        group.id,
      )
    }
    expect(users.every((user) =>
      scenario.members.get(user.userName)?.role === 'guest'
    )).toBe(true)

    const updateFirstGroup = await app.request(
      `${scimBaseUrl}/Groups/${firstGroup.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'interleaved-update-a',
          'If-Match': 'W/"1"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'replace',
            path: 'displayName',
            value: 'Updated interleaved group A',
          }],
        }),
      },
    )
    expect(updateFirstGroup.status).toBe(202)
    expect(updateFirstGroup.headers.get('Retry-After')).toBe('1')
    const removeSecondGroupMembers = await app.request(
      `${scimBaseUrl}/Groups/${secondGroup.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'interleaved-remove-b',
          'If-Match': 'W/"1"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'remove',
            path: 'members',
          }],
        }),
      },
    )
    expect(removeSecondGroupMembers.status).toBe(202)
    expect(removeSecondGroupMembers.headers.get('Retry-After')).toBe('1')
    expect(await processEnterpriseScimGroupJobPage(
      scenario.identity,
      workspaceId,
      firstGroup.id,
      'INSERT',
    )).toBe(true)
    expect(await processEnterpriseScimGroupJobPage(
      scenario.identity,
      workspaceId,
      secondGroup.id,
      'INSERT',
    )).toBe(true)

    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      firstGroup.id,
    )
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      secondGroup.id,
    )
    expect(users.every((user) =>
      scenario.members.get(user.userName)?.role === 'guest'
    )).toBe(true)
  })
})

test('settles a user mutation that races after an early SCIM group page', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    const workspaceId = 'user#demo@example.com'
    const scenario = await configureEnterpriseScimGuestRoleScenario(workspaceId)
    const scimBaseUrl = `/api/scim/v2/${encodeURIComponent(workspaceId)}`
    const scimHeaders = {
      Authorization: `Bearer ${scenario.scimToken}`,
      'Content-Type': 'application/scim+json',
    }
    const users = []
    for (let index = 0; index < 6; index += 1) {
      const email = `settle-race-user-${index}@example.com`
      const response = await app.request(`${scimBaseUrl}/Users`, {
        method: 'POST',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': `settle-race-user-${index}`,
        },
        body: JSON.stringify({
          externalId: `settle-race-user-${index}`,
          userName: email,
          emails: [{ value: email, primary: true }],
          active: true,
        }),
      })
      expect(response.status).toBe(201)
      users.push(await response.json())
    }
    const groupResponse = await app.request(`${scimBaseUrl}/Groups`, {
      method: 'POST',
      headers: {
        ...scimHeaders,
        'Idempotency-Key': 'settle-race-group',
      },
      body: JSON.stringify({
        externalId: 'settle-race-group',
        displayName: 'Settle race group',
        members: users.map((user) => ({ value: user.id })),
        active: true,
      }),
    })
    expect(groupResponse.status).toBe(202)
    const group = await groupResponse.json()
    const mappingResponse = await app.request(
      '/api/enterprise/security/group-mappings',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'settle-race-mapping',
        },
        body: JSON.stringify({
          identityProviderId: 'idp-guest-role',
          directoryGroupId: group.id,
          scopeType: 'workspace',
          roleId: 'workspace:guest',
        }),
      },
    )
    expect(mappingResponse.status).toBe(201)
    expect(users.every((user) =>
      scenario.members.get(user.userName)?.role === 'member'
    )).toBe(true)

    expect(await processEnterpriseScimGroupJobPage(
      scenario.identity,
      workspaceId,
      group.id,
      'MODIFY',
    )).toBe(true)
    const earlyPageUser = users.find((user) =>
      scenario.members.get(user.userName)?.role === 'guest'
    )
    if (!earlyPageUser) {
      throw new Error('Expected a user reconciled by the early group page.')
    }
    const userPatchResponse = await app.request(
      `${scimBaseUrl}/Users/${earlyPageUser.id}`,
      {
        method: 'PATCH',
        headers: {
          ...scimHeaders,
          'Idempotency-Key': 'settle-race-user-patch',
          'If-Match': 'W/"1"',
        },
        body: JSON.stringify({
          Operations: [{
            op: 'replace',
            path: 'displayName',
            value: 'Updated during group reconciliation',
          }],
        }),
      },
    )
    expect(userPatchResponse.status).toBe(200)
    expect(scenario.members.get(earlyPageUser.userName)?.role).toBe('member')

    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
    expect(scenario.members.get(earlyPageUser.userName)?.role).toBe('guest')
  })
})

test('changes group job audit identity when a callback loses its state checkpoint race', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    const workspaceId = 'user#demo@example.com'
    const scenario = await configureEnterpriseScimGuestRoleScenario(workspaceId)
    const scimBaseUrl = `/api/scim/v2/${encodeURIComponent(workspaceId)}`
    const scimHeaders = {
      Authorization: `Bearer ${scenario.scimToken}`,
      'Content-Type': 'application/scim+json',
    }
    const userResponse = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers: {
        ...scimHeaders,
        'Idempotency-Key': 'checkpoint-race-user',
      },
      body: JSON.stringify({
        externalId: 'checkpoint-race-user',
        userName: 'managed@example.com',
        emails: [{ value: 'managed@example.com', primary: true }],
        active: true,
      }),
    })
    expect(userResponse.status).toBe(201)
    const user = await userResponse.json()
    const groupResponse = await app.request(`${scimBaseUrl}/Groups`, {
      method: 'POST',
      headers: {
        ...scimHeaders,
        'Idempotency-Key': 'checkpoint-race-group',
      },
      body: JSON.stringify({
        externalId: 'checkpoint-race-group',
        displayName: 'Checkpoint race group',
        members: [{ value: user.id }],
        active: true,
      }),
    })
    expect(groupResponse.status).toBe(202)
    const group = await groupResponse.json()
    const reference = await scenario.identity.getScimGroupJobReference(
      workspaceId,
      group.id,
    )
    if (!reference) throw new Error('Expected a pending group job.')
    const desiredUser = (await scenario.identity.getSnapshot(workspaceId))
      .scimUsers.find((candidate) => candidate.userId === user.id)
    if (!desiredUser) throw new Error('Expected the desired SCIM user.')
    scenario.reconcileAuditContexts.length = 0
    scenario.setAfterNextDirectoryReconcile(async () => {
      await scenario.identity.upsertScimUser({
        workspaceId,
        userId: desiredUser.userId,
        identityProviderId: desiredUser.identityProviderId,
        externalId: desiredUser.externalId,
        userName: desiredUser.userName,
        displayName: 'Changed during callback checkpoint',
        emails: desiredUser.emails,
        active: desiredUser.active,
        linkedMemberKey: desiredUser.linkedMemberKey,
        idempotencyKey: 'checkpoint-race-user-update',
      })
    })
    const streamEvent = {
      Records: [{
        eventSource: 'aws:dynamodb',
        eventName: 'INSERT',
        dynamodb: {
          SequenceNumber: `sequence-${reference.revision}`,
          NewImage: {
            scopeKey: { S: `WORKSPACE#${workspaceId}` },
            recordKey: { S: `SCIM_GROUP_JOB#${reference.jobId}` },
            entryType: { S: 'enterprise-scim-group-job' },
            workspaceId: { S: workspaceId },
            jobId: { S: reference.jobId },
            revision: { N: String(reference.revision) },
          },
        },
      }],
    }

    const workerHandler = createEnterpriseScimGroupJobWorkerHandler(
      requireEnterpriseScimGroupJobProcessor(scenario.identity),
    )
    expect(await workerHandler(streamEvent)).toEqual({
      batchItemFailures: [{
        itemIdentifier: `sequence-${reference.revision}`,
      }],
    })
    expect(await scenario.identity.getScimGroupJobReference(
      workspaceId,
      group.id,
    )).toEqual(reference)
    expect(scenario.reconcileAuditContexts).toHaveLength(1)

    expect(await workerHandler(streamEvent)).toEqual({ batchItemFailures: [] })
    expect(scenario.reconcileAuditContexts).toHaveLength(2)
    expect(scenario.reconcileAuditContexts[1]?.idempotencyKeyHash)
      .not.toBe(scenario.reconcileAuditContexts[0]?.idempotencyKeyHash)
    expect(scenario.reconcileAuditContexts[1]?.requestFingerprint)
      .not.toBe(scenario.reconcileAuditContexts[0]?.requestFingerprint)
    await drainEnterpriseScimGroupJob(
      scenario.identity,
      workspaceId,
      group.id,
    )
  })
})

test('retries a provisioning plan with desired guest groups before checkpointing them', async () => {
  await withTestEnvironment({
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  }, async () => {
    const workspaceId = 'user#demo@example.com'
    const scenario = await configureEnterpriseScimGuestRoleScenario(workspaceId)
    const scimBaseUrl = `/api/scim/v2/${encodeURIComponent(workspaceId)}`
    const userResponse = await app.request(`${scimBaseUrl}/Users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${scenario.scimToken}`,
        'Content-Type': 'application/scim+json',
        'Idempotency-Key': 'provisioning-guest-user',
      },
      body: JSON.stringify({
        externalId: 'provisioning-managed-user',
        userName: 'managed@example.com',
        emails: [{ value: 'managed@example.com', primary: true }],
        active: true,
      }),
    })
    expect(userResponse.status).toBe(201)
    const user = await userResponse.json()
    const group = await scenario.identity.upsertScimGroup({
      workspaceId,
      identityProviderId: 'idp-guest-role',
      externalId: 'pending-workspace-guests',
      displayName: 'Pending workspace guests',
      active: true,
      memberUserIds: [user.id],
      idempotencyKey: 'pending-workspace-guests',
    })
    await scenario.identity.putGroupMapping({
      workspaceId,
      mappingId: 'pending-workspace-guest-mapping',
      identityProviderId: 'idp-guest-role',
      directoryGroupId: group.groupId,
      roleId: 'workspace:guest',
      scope: { workspaceId, kind: 'workspace' },
      enabled: true,
      priority: 0,
      revision: 1,
      updatedAt: new Date().toISOString(),
    })
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')

    const previewResponse = await app.request(
      '/api/enterprise/security/provisioning/preview',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'guest-provisioning-preview',
        },
        body: '{}',
      },
    )
    expect(previewResponse.status).toBe(200)
    const preview = (await previewResponse.json()).impact
    scenario.setReconcileFailures(1)
    const failedResponse = await app.request(
      '/api/enterprise/security/provisioning/reconcile',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'guest-provisioning-run',
        },
        body: JSON.stringify({
          previewId: preview.previewId,
          previewExpiresAt: preview.expiresAt,
        }),
      },
    )
    expect(failedResponse.status).toBe(503)
    const failedSnapshot = await scenario.identity.getSnapshot(workspaceId)
    const failedGroup = failedSnapshot.scimGroups.find((candidate) =>
      candidate.groupId === group.groupId
    )
    expect(failedGroup?.appliedVersion).toBe(0)
    expect(scenario.members.get('managed@example.com')?.role).toBe('member')
    const failedRun = failedSnapshot.provisioningRuns.find((run) =>
      run.status === 'failed'
    )
    expect(failedRun).toBeDefined()
    if (!failedRun) throw new Error('Expected a failed provisioning run.')

    const retryResponse = await app.request(
      `/api/enterprise/security/provisioning/logs/${failedRun.runId}/retry`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      },
    )
    expect(retryResponse.status).toBe(200)
    expect(scenario.members.get('managed@example.com')?.role).toBe('guest')
    const succeededGroup = (await scenario.identity.getSnapshot(workspaceId))
      .scimGroups.find((candidate) => candidate.groupId === group.groupId)
    expect(succeededGroup?.appliedVersion).toBe(succeededGroup?.version)
  })
})
