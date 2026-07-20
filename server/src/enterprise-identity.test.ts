import { expect, test } from 'bun:test'
import type {
  EnterpriseCustomRole,
  EnterpriseIdentityProvider,
  EnterpriseIdentitySnapshot,
  EnterpriseRoleAssignment,
  EnterpriseRoutePermissionRule,
  EnterpriseSecurityPolicy,
} from '@mukuroji/contracts'
import { createMutationAuditContext } from './audit'
import {
  DynamoDbEnterpriseIdentityClient,
  DynamoDbEnterpriseIdentityMaintenanceClient,
  type EnterpriseScimGroupJobApplyInput,
  InMemoryEnterpriseIdentityClient,
  assertEnterpriseCognitoFederationBinding,
  assertEnterpriseCognitoProviderBinding,
  evaluateEnterpriseAccess,
  ipMatchesCidr,
  resolveEnterpriseDirectoryPrincipal,
  resolveRoutePermission,
  validateEnterpriseSession,
} from './enterprise-identity'

const workspaceId = 'workspace-1'
const now = new Date('2026-07-18T00:00:00.000Z')
const tokenSecret = '0123456789abcdef0123456789abcdef'

function createActiveProvider(
  providerId: string,
  cognitoProviderName = `Cognito-${providerId}`,
) {
  return {
    workspaceId,
    providerId,
    kind: 'oidc',
    displayName: providerId,
    cognitoProviderName,
    status: 'active',
    revision: 1,
    issuer: `https://${providerId}.example.com`,
    clientId: 'mukuroji',
    authorizationEndpoint: `https://${providerId}.example.com/authorize`,
    tokenEndpoint: `https://${providerId}.example.com/token`,
    jwksUri: `https://${providerId}.example.com/jwks`,
    scopes: ['openid', 'email'],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastTestedAt: now.toISOString(),
  } satisfies EnterpriseIdentityProvider
}

async function createScimUsers(
  client: InMemoryEnterpriseIdentityClient | DynamoDbEnterpriseIdentityClient,
  providerId: string,
  count: number,
  prefix: string,
) {
  const users = []
  for (let index = 0; index < count; index += 1) {
    users.push(await client.upsertScimUser({
      workspaceId,
      identityProviderId: providerId,
      externalId: `${prefix}-${index}`,
      userName: `${prefix}-${index}@example.com`,
      emails: [`${prefix}-${index}@example.com`],
      active: true,
      idempotencyKey: `${prefix}-${index}`,
    }))
  }
  return users
}

function enterpriseItemKey(item: Record<string, unknown>) {
  return `${String(item.scopeKey)}\0${String(item.recordKey)}`
}

function createDynamoHarness() {
  const items = new Map<string, Record<string, unknown>>()
  const transactions: Array<Record<string, unknown>> = []
  const batchWrites: Array<Record<string, unknown>> = []
  const queries: Array<Record<string, unknown>> = []
  let rejectBatchWritesFromCall: number | undefined
  const documentClient = {
    async send(command: unknown) {
      const commandName = (
        command as { constructor?: { name?: string } }
      ).constructor?.name
      const input = (command as { input: Record<string, unknown> }).input
      if (commandName === 'QueryCommand') {
        queries.push(structuredClone(input))
        const values = input.ExpressionAttributeValues as Record<string, unknown>
        const scopeKey = values[':scopeKey']
        const recordPrefix = values[':recordPrefix']
        const exclusiveStartKey = input.ExclusiveStartKey as
          | Record<string, unknown>
          | undefined
        const limit = typeof input.Limit === 'number'
          ? input.Limit
          : Number.POSITIVE_INFINITY
        const matchingItems = [...items.values()]
          .filter((item) =>
            item.scopeKey === scopeKey &&
            (
              typeof recordPrefix !== 'string' ||
              String(item.recordKey).startsWith(recordPrefix)
            )
          )
          .sort((left, right) =>
            String(left.recordKey).localeCompare(String(right.recordKey))
          )
        const startOffset = exclusiveStartKey
          ? matchingItems.findIndex((item) =>
              enterpriseItemKey(item) === enterpriseItemKey(exclusiveStartKey)
            ) + 1
          : 0
        const pageItems = matchingItems.slice(startOffset, startOffset + limit)
        const hasNextPage = startOffset + pageItems.length < matchingItems.length
        return {
          Items: pageItems.map((item) => structuredClone(item)),
          ...(hasNextPage && pageItems.length > 0
            ? {
                LastEvaluatedKey: {
                  scopeKey: pageItems.at(-1)?.scopeKey,
                  recordKey: pageItems.at(-1)?.recordKey,
                },
              }
            : {}),
        }
      }
      if (commandName === 'GetCommand') {
        const key = input.Key as Record<string, unknown>
        const item = items.get(enterpriseItemKey(key))
        return item ? { Item: structuredClone(item) } : {}
      }
      if (commandName === 'PutCommand') {
        const item = input.Item as Record<string, unknown>
        const current = items.get(enterpriseItemKey(item))
        const values = input.ExpressionAttributeValues as
          | Record<string, unknown>
          | undefined
        const revisionConflict = values?.[':expectedRevision'] !== undefined &&
          current?.controlRevision !== values[':expectedRevision']
        const generationConflict = values?.[':expectedGeneration'] !== undefined &&
          current?.activeStateGeneration !== values[':expectedGeneration']
        const retiredConflict =
          input.ConditionExpression &&
          current?.retiredStateGenerations !== undefined &&
          JSON.stringify(current.retiredStateGenerations) !==
            JSON.stringify(values?.[':emptyRetired'])
        if (revisionConflict || generationConflict || retiredConflict) {
          const error = new Error('Injected CONTROL condition conflict')
          error.name = 'ConditionalCheckFailedException'
          throw error
        }
        items.set(enterpriseItemKey(item), structuredClone(item))
        return {}
      }
      if (commandName === 'UpdateCommand') {
        const key = input.Key as Record<string, unknown>
        const current = items.get(enterpriseItemKey(key))
        const values = input.ExpressionAttributeValues as Record<string, unknown>
        if (
          !current ||
          current.controlRevision !== values[':expectedRevision'] ||
          current.activeStateGeneration !== values[':expectedGeneration'] ||
          JSON.stringify(current.retiredStateGenerations) !==
            JSON.stringify(values[':expectedRetired'])
        ) {
          const error = new Error('Injected CONTROL update conflict')
          error.name = 'ConditionalCheckFailedException'
          throw error
        }
        current.retiredStateGenerations = structuredClone(values[':emptyRetired'])
        current.maintenanceRequired = values[':nextMaintenanceRequired']
        items.set(enterpriseItemKey(current), current)
        return {}
      }
      if (commandName === 'BatchWriteCommand') {
        batchWrites.push(structuredClone(input))
        if (
          rejectBatchWritesFromCall !== undefined &&
          batchWrites.length >= rejectBatchWritesFromCall
        ) {
          throw new Error('Injected partial batch write failure')
        }
        const requestItems = input.RequestItems as Record<string, Array<{
          PutRequest?: { Item?: Record<string, unknown> }
          DeleteRequest?: { Key?: Record<string, unknown> }
        }>>
        for (const requests of Object.values(requestItems)) {
          for (const request of requests) {
            const item = request.PutRequest?.Item
            if (item?.scopeKey && item.recordKey) {
              items.set(enterpriseItemKey(item), structuredClone(item))
            }
            const key = request.DeleteRequest?.Key
            if (key) items.delete(enterpriseItemKey(key))
          }
        }
        return { UnprocessedItems: {} }
      }
      if (commandName === 'TransactWriteCommand') {
        transactions.push(structuredClone(input))
        const transactItems = input.TransactItems as Array<Record<string, unknown>>
        for (const operation of transactItems) {
          const put = operation.Put as
            | {
                Item?: Record<string, unknown>
                ConditionExpression?: string
                ExpressionAttributeValues?: Record<string, unknown>
              }
            | undefined
          if (put?.Item?.recordKey !== 'CONTROL') continue
          const current = items.get(enterpriseItemKey(put.Item))
          const expectedRevision = put.ExpressionAttributeValues?.[':expectedRevision']
          const expectedGeneration = put.ExpressionAttributeValues?.[':expectedGeneration']
          const createConflict = put.ConditionExpression?.includes(
            'attribute_not_exists(scopeKey)',
          ) && current !== undefined
          const revisionConflict = expectedRevision !== undefined &&
            current?.controlRevision !== expectedRevision
          const generationConflict = expectedGeneration !== undefined &&
            current?.activeStateGeneration !== expectedGeneration
          if (createConflict || revisionConflict || generationConflict) {
            const error = new Error('Injected CONTROL revision conflict')
            error.name = 'TransactionCanceledException'
            throw error
          }
        }
        for (const operation of transactItems) {
          const put = operation.Put as
            | { Item?: Record<string, unknown> }
            | undefined
          if (put?.Item?.scopeKey && put.Item.recordKey) {
            items.set(enterpriseItemKey(put.Item), structuredClone(put.Item))
          }
          const deletion = operation.Delete as
            | { Key?: Record<string, unknown> }
            | undefined
          if (deletion?.Key) items.delete(enterpriseItemKey(deletion.Key))
        }
        return {}
      }
      throw new Error(`Unexpected DynamoDB command: ${commandName ?? 'unknown'}`)
    },
  }
  return {
    documentClient,
    items,
    transactions,
    batchWrites,
    queries,
    rejectBatchWritesAfter(successfulCalls: number) {
      rejectBatchWritesFromCall = batchWrites.length + successfulCalls + 1
    },
    resumeBatchWrites() {
      rejectBatchWritesFromCall = undefined
    },
    resetQueries() {
      queries.length = 0
    },
  }
}

const policy = {
  workspaceId,
  loginMode: 'password-or-sso',
  mfaRequirement: 'required',
  sessionLifetimeMinutes: 480,
  idleTimeoutMinutes: 60,
  reauthenticationIntervalMinutes: 120,
  sensitiveActionReauthenticationMinutes: 15,
  ipAllowlistMode: 'all-users',
  ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'],
  externalAccess: {
    allowGuests: true,
    allowExternalCollaborators: true,
    requireMfa: true,
    maximumSessionLifetimeMinutes: 120,
    allowedGuestDomains: [],
    permissionCeiling: ['workspace.read', 'projects.read', 'work-items.read'],
  },
  revision: 1,
  updatedAt: now.toISOString(),
  updatedBy: 'owner@example.com',
} satisfies EnterpriseSecurityPolicy

test('resolves route permissions with parameters and wildcard rules and denies unregistered routes', () => {
  const rules = [
    {
      method: 'GET',
      pathPattern: '/api/projects/:projectId/*',
      permission: 'projects.read',
    },
    {
      method: '*',
      pathPattern: '/api/enterprise/security/*',
      permission: 'security.manage',
    },
  ] satisfies EnterpriseRoutePermissionRule[]

  expect(resolveRoutePermission('GET', '/api/projects/project-1/tasks', rules))
    .toBe('projects.read')
  expect(resolveRoutePermission('POST', '/api/enterprise/security/roles', rules))
    .toBe('security.manage')
  expect(resolveRoutePermission('GET', '/api/unregistered', rules)).toBeUndefined()
})

test('enforces custom role differences and the guest permission ceiling', () => {
  const customRole = {
    workspaceId,
    roleId: 'custom:approver',
    name: 'Approver',
    permissions: ['files.read', 'files.approve'],
    guestAssignable: true,
    revision: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  } satisfies EnterpriseCustomRole
  const baseInput = {
    assignments: [{
      workspaceId,
      assignmentId: 'assignment-1',
      principalKind: 'member',
      principalId: 'reviewer@example.com',
      roleId: customRole.roleId,
      scope: { workspaceId, kind: 'project', targetId: 'project-1' },
      source: 'direct',
    }] satisfies EnterpriseRoleAssignment[],
    customRoles: [customRole],
    groupMappings: [],
    resource: { workspaceId, kind: 'project', targetId: 'project-1' } as const,
  }

  expect(evaluateEnterpriseAccess({
    ...baseInput,
    permission: 'files.approve',
    principal: {
      kind: 'member',
      principalId: 'reviewer@example.com',
      directoryGroupIds: [],
      workspaceRole: 'member',
    },
  })).toMatchObject({ allowed: true })
  expect(evaluateEnterpriseAccess({
    ...baseInput,
    permission: 'files.write',
    principal: {
      kind: 'member',
      principalId: 'guest@example.com',
      directoryGroupIds: [],
      workspaceRole: 'guest',
      permissionCeiling: ['files.read'],
    },
  })).toMatchObject({ allowed: false, reason: 'guest-ceiling' })
})

test('validates MFA, reauthentication, session lifetime, and IPv4/IPv6 allowlists', () => {
  expect(validateEnterpriseSession(policy, {
    authenticatedAt: Math.floor(now.getTime() / 1000) - 5 * 60,
    now: Math.floor(now.getTime() / 1000),
    authenticationMethods: ['pwd', 'software_token_mfa'],
    clientIp: '203.0.113.42',
    privileged: true,
    external: false,
    breakGlass: false,
  })).toEqual({ valid: true })
  expect(validateEnterpriseSession(policy, {
    authenticatedAt: Math.floor(now.getTime() / 1000) - 16 * 60,
    now: Math.floor(now.getTime() / 1000),
    authenticationMethods: ['pwd', 'software_token_mfa'],
    clientIp: '2001:db8::1',
    privileged: true,
    external: false,
    breakGlass: false,
  })).toEqual({ valid: false, reason: 'reauthentication-required' })
  expect(validateEnterpriseSession(policy, {
    authenticatedAt: Math.floor(now.getTime() / 1000) - 5 * 60,
    now: Math.floor(now.getTime() / 1000),
    authenticationMethods: ['pwd', 'software_token_mfa'],
    clientIp: '198.51.100.42',
    privileged: true,
    external: true,
    breakGlass: true,
  })).toEqual({ valid: true })
  expect(ipMatchesCidr('203.0.113.255', '203.0.113.0/24')).toBe(true)
  expect(ipMatchesCidr('203.0.114.1', '203.0.113.0/24')).toBe(false)
  expect(ipMatchesCidr('2001:db8:1::1', '2001:db8::/32')).toBe(true)
  expect(ipMatchesCidr('2001:db9::1', '2001:db8::/32')).toBe(false)
})

test('issues one-time SCIM credentials, authenticates by digest, and revokes immediately', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const issued = await client.issueScimToken(workspaceId, 'idp-1', 'Okta')

  expect(issued.token).toStartWith('msc_')
  expect(issued.credential.identityProviderId).toBe('idp-1')
  expect(issued.credential.tokenLastFour).toBe(issued.token.slice(-4))
  expect(JSON.stringify(await client.getSnapshot(workspaceId))).not.toContain(issued.token)
  expect((await client.getSnapshot(workspaceId)).scimCredentials[0]?.tokenLastFour)
    .toBe(issued.token.slice(-4))
  expect(await client.authenticateScimToken(workspaceId, issued.token))
    .toEqual(issued.credential)
  await client.revokeScimToken(workspaceId, issued.credential.credentialId)
  expect(await client.authenticateScimToken(workspaceId, issued.token)).toBeUndefined()
})

test('expires and rotates scoped service-account credentials without persisting plaintext', async () => {
  let currentTime = now
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => currentTime)
  const issued = await client.createServiceAccountWithToken({
    workspaceId,
    accountId: 'automation-project-1',
    displayName: 'Project automation',
    permissions: ['projects.read', 'work-items.read', 'service-accounts.use'],
    roleId: 'project:viewer',
    scope: { workspaceId, kind: 'project', targetId: 'project-1' },
    credentialLifetimeDays: 30,
    allowedSourceCidrs: ['203.0.113.0/24'],
    status: 'active',
    credentialGeneration: 0,
    revision: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }, 'create-project-automation', 'create-project-automation-fingerprint')

  expect(issued.token).toStartWith('msa_')
  expect(issued.credential.expiresAt).toBe('2026-08-17T00:00:00.000Z')
  expect(issued.account).toMatchObject({
    scope: { kind: 'project', targetId: 'project-1' },
    credentialLifetimeDays: 30,
    allowedSourceCidrs: ['203.0.113.0/24'],
    credentialExpiresAt: '2026-08-17T00:00:00.000Z',
  })
  expect(JSON.stringify(await client.getSnapshot(workspaceId))).not.toContain(issued.token)
  expect(await client.authenticateServiceAccountToken(workspaceId, issued.token))
    .toMatchObject({ accountId: 'automation-project-1' })
  expect((await client.getSnapshot(workspaceId)).serviceAccounts[0]?.lastUsedAt)
    .toBeUndefined()
  await client.recordServiceAccountUse(workspaceId, 'automation-project-1')
  expect((await client.getSnapshot(workspaceId)).serviceAccounts[0]?.lastUsedAt)
    .toBe(now.toISOString())

  currentTime = new Date('2026-07-28T00:00:00.000Z')
  const rotated = await client.rotateServiceAccountToken(
    workspaceId,
    'automation-project-1',
    issued.account.revision,
    'rotate-project-automation',
    'rotate-project-automation-fingerprint',
  )
  expect(await client.authenticateServiceAccountToken(workspaceId, issued.token)).toBeUndefined()
  expect(rotated.credential.expiresAt).toBe('2026-08-27T00:00:00.000Z')

  currentTime = new Date('2026-08-27T00:00:00.000Z')
  expect(await client.authenticateServiceAccountToken(workspaceId, rotated.token)).toBeUndefined()
})

test('never issues a service-account credential without a bounded future expiry', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.createServiceAccount({
    workspaceId,
    accountId: 'bounded-service-account',
    displayName: 'Bounded automation',
    permissions: ['service-accounts.use'],
    roleId: 'project:viewer',
    scope: { workspaceId, kind: 'project', targetId: 'project-1' },
    credentialLifetimeDays: 30,
    allowedSourceCidrs: [],
    status: 'active',
    credentialGeneration: 0,
    revision: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  const defaultExpiry = await client.issueServiceAccountToken(
    workspaceId,
    'bounded-service-account',
  )
  expect(defaultExpiry.credential.expiresAt).toBe('2026-08-17T00:00:00.000Z')
  await expect(client.issueServiceAccountToken(
    workspaceId,
    'bounded-service-account',
    '2026-07-17T23:59:59.000Z',
  )).rejects.toMatchObject({ code: 'EnterpriseServiceAccountExpiryInvalid' })
  await expect(client.issueServiceAccountToken(
    workspaceId,
    'bounded-service-account',
    '2026-08-18T00:00:00.000Z',
  )).rejects.toMatchObject({ code: 'EnterpriseServiceAccountExpiryInvalid' })
  await expect(client.issueServiceAccountToken(
    workspaceId,
    'bounded-service-account',
    '2026-07-28T00:00:00.000Z',
  )).resolves.toMatchObject({
    credential: { expiresAt: '2026-07-28T00:00:00.000Z' },
  })
})

test('domain-separates idempotent one-time credentials by Workspace authority', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  const secondWorkspaceId = 'workspace-2'
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  await client.putIdentityProvider({
    ...createActiveProvider('idp-1'),
    workspaceId: secondWorkspaceId,
  })

  const first = await client.rotateScimToken(
    workspaceId,
    'idp-1',
    'Directory',
    0,
    'shared-idempotency-key',
    'shared-request-fingerprint',
  )
  const second = await client.rotateScimToken(
    secondWorkspaceId,
    'idp-1',
    'Directory',
    0,
    'shared-idempotency-key',
    'shared-request-fingerprint',
  )
  const firstReplay = await client.rotateScimToken(
    workspaceId,
    'idp-1',
    'Directory',
    0,
    'shared-idempotency-key',
    'shared-request-fingerprint',
  )
  expect(firstReplay).toEqual(first)
  expect(first.credential.tokenLastFour).toBe(first.token.slice(-4))
  expect(second.credential.tokenLastFour).toBe(second.token.slice(-4))
  expect(first.token).not.toBe(second.token)
  expect(await client.authenticateScimToken(secondWorkspaceId, first.token)).toBeUndefined()
})

test('expires SCIM idempotency receipts logically before DynamoDB TTL cleanup', async () => {
  let currentTime = now
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => currentTime)
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const input = {
    workspaceId,
    identityProviderId: 'idp-1',
    externalId: 'idempotent-user',
    userName: 'idempotent@example.com',
    emails: ['idempotent@example.com'],
    displayName: 'First name',
    active: true,
    idempotencyKey: 'reusable-after-expiry',
  }
  const first = await client.upsertScimUser(input)
  await expect(client.upsertScimUser({
    ...input,
    displayName: 'Changed too early',
  })).rejects.toMatchObject({ code: 'EnterpriseScimIdempotencyConflict' })

  currentTime = new Date(now.getTime() + 25 * 60 * 60_000)
  const afterExpiry = await client.upsertScimUser({
    ...input,
    displayName: 'Changed after expiry',
  })
  expect(afterExpiry).toMatchObject({
    userId: first.userId,
    displayName: 'Changed after expiry',
    version: first.version + 1,
  })
})

test('converges repeated SCIM user and provisioning requests idempotently', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const input = {
    workspaceId,
    externalId: 'external-user-1',
    identityProviderId: 'idp-1',
    userName: 'User@example.com',
    emails: ['USER@example.com'],
    active: true,
    linkedMemberKey: 'user@example.com',
    idempotencyKey: 'scim-user-request-1',
  }
  const first = await client.upsertScimUser(input)
  const replay = await client.upsertScimUser(input)

  expect(replay).toEqual(first)
  const preview = await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'preview-1',
  })
  const runInput = {
    workspaceId,
    source: 'directory-reconciliation' as const,
    idempotencyKey: 'reconcile-1',
    previewFingerprint: preview.fingerprint,
  }
  const run = await client.reconcileProvisioning(runInput)
  expect(run.status).toBe('running')
  await expect(client.finalizeProvisioningRun(
    workspaceId,
    run.runId,
    'succeeded',
  )).rejects.toMatchObject({ code: 'EnterpriseProvisioningCheckpointIncomplete' })
  await client.markScimUserApplied(workspaceId, first.userId, first.version)
  const finalized = await client.finalizeProvisioningRun(
    workspaceId,
    run.runId,
    'succeeded',
  )
  expect(finalized.status).toBe('succeeded')
  expect(await client.reconcileProvisioning(runInput)).toEqual(finalized)
})

test('processes SCIM group jobs in sequential five-user apply and settle pages', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-job-pages'))
  const users = await createScimUsers(
    client,
    'idp-job-pages',
    7,
    'job-page-user',
  )
  const groupInput = {
    workspaceId,
    identityProviderId: 'idp-job-pages',
    externalId: 'job-page-group',
    displayName: 'Job page group',
    active: true,
    memberUserIds: users.map((user) => user.userId),
    idempotencyKey: 'job-page-group',
  }
  const group = await client.upsertScimGroup(groupInput)
  const firstReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  expect(firstReference).toBeDefined()
  expect(await client.upsertScimGroup(groupInput)).toEqual(group)
  expect(await client.getScimGroupJobReference(workspaceId, group.groupId))
    .toEqual(firstReference)
  expect(await client.getSnapshot(workspaceId)).not.toHaveProperty('scimGroupJobs')

  let activeCallbacks = 0
  let maximumActiveCallbacks = 0
  const appliedPhases: string[] = []
  const appliedUserIds: string[] = []
  const applyUser = async (input: EnterpriseScimGroupJobApplyInput) => {
    activeCallbacks += 1
    maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks)
    appliedPhases.push(input.phase)
    appliedUserIds.push(input.user.userId)
    await Promise.resolve()
    activeCallbacks -= 1
  }
  if (!firstReference) throw new Error('Expected a pending SCIM group job.')

  const firstPage = await client.processScimGroupJob(firstReference, applyUser)
  expect(firstPage.status).toBe('continued')
  expect(firstPage.processedUserIds).toHaveLength(5)
  expect(maximumActiveCallbacks).toBe(1)
  expect(appliedPhases).toEqual(Array.from({ length: 5 }, () => 'apply'))
  expect((await client.getSnapshot(workspaceId)).scimGroups[0]).toMatchObject({
    version: 1,
    appliedVersion: 0,
  })

  const staleCallbackCount = appliedUserIds.length
  expect(await client.processScimGroupJob(firstReference, applyUser)).toEqual({
    status: 'stale',
  })
  expect(appliedUserIds).toHaveLength(staleCallbackCount)

  if (firstPage.status !== 'continued') {
    throw new Error('Expected the apply phase to continue.')
  }
  const applyCompleted = await client.processScimGroupJob(
    firstPage.nextReference,
    applyUser,
  )
  expect(applyCompleted.status).toBe('continued')
  expect(applyCompleted.processedUserIds).toHaveLength(2)
  expect((await client.getSnapshot(workspaceId)).scimGroups[0]).toMatchObject({
    version: 1,
    appliedVersion: 1,
  })

  if (applyCompleted.status !== 'continued') {
    throw new Error('Expected the settle phase to start.')
  }
  const firstSettlePage = await client.processScimGroupJob(
    applyCompleted.nextReference,
    applyUser,
  )
  expect(firstSettlePage.status).toBe('continued')
  expect(firstSettlePage.processedUserIds).toHaveLength(5)
  if (firstSettlePage.status !== 'continued') {
    throw new Error('Expected the settle phase to continue.')
  }
  const completed = await client.processScimGroupJob(
    firstSettlePage.nextReference,
    applyUser,
  )
  expect(completed.status).toBe('completed')
  expect(completed.processedUserIds).toHaveLength(2)
  expect(appliedPhases).toEqual([
    ...Array.from({ length: 7 }, () => 'apply'),
    ...Array.from({ length: 7 }, () => 'settle'),
  ])
  expect(await client.getScimGroupJobReference(workspaceId, group.groupId))
    .toBeUndefined()
  expect(await client.processScimGroupJob(
    firstSettlePage.nextReference,
    applyUser,
  )).toEqual({ status: 'stale' })
})

test('retries a failed SCIM group page without advancing its durable reference', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-job-retry'))
  const users = await createScimUsers(
    client,
    'idp-job-retry',
    3,
    'job-retry-user',
  )
  const group = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-job-retry',
    externalId: 'job-retry-group',
    displayName: 'Job retry group',
    active: true,
    memberUserIds: users.map((user) => user.userId),
    idempotencyKey: 'job-retry-group',
  })
  const reference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  if (!reference) throw new Error('Expected a pending SCIM group job.')
  let callbackCount = 0
  await expect(client.processScimGroupJob(reference, async () => {
    callbackCount += 1
    if (callbackCount === 2) throw new Error('Injected user apply failure')
  })).rejects.toThrow('Injected user apply failure')
  expect(callbackCount).toBe(2)
  expect(await client.getScimGroupJobReference(workspaceId, group.groupId))
    .toEqual(reference)
  expect((await client.getSnapshot(workspaceId)).scimGroups[0]).toMatchObject({
    version: 1,
    appliedVersion: 0,
  })

  const retried = await client.processScimGroupJob(reference, async () => undefined)
  expect(retried.status).toBe('continued')
  const nextReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  expect(nextReference).toBeDefined()
  await client.markScimGroupApplied(workspaceId, group.groupId, group.version)
  expect(await client.getScimGroupJobReference(workspaceId, group.groupId))
    .toEqual(nextReference)
  if (!nextReference) throw new Error('Expected a continued SCIM group job.')
  expect(await client.processScimGroupJob(
    nextReference,
    async () => undefined,
  )).toMatchObject({ status: 'completed' })
  expect(await client.getScimGroupJobReference(workspaceId, group.groupId))
    .toBeUndefined()
})

test('keeps removed group members in provisioning preview until the durable job settles', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-job-preview'))
  const user = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-job-preview',
    externalId: 'job-preview-user',
    userName: 'job-preview-user@example.com',
    emails: ['job-preview-user@example.com'],
    active: true,
    idempotencyKey: 'job-preview-user',
  })
  const group = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-job-preview',
    externalId: 'job-preview-group',
    displayName: 'Job preview group',
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: 'job-preview-group',
  })
  const initialReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  if (!initialReference) throw new Error('Expected the initial group job.')
  const initialApply = await client.processScimGroupJob(
    initialReference,
    async () => undefined,
  )
  if (initialApply.status !== 'continued') {
    throw new Error('Expected the initial settle phase.')
  }
  await expect(client.processScimGroupJob(
    initialApply.nextReference,
    async () => undefined,
  )).resolves.toMatchObject({ status: 'completed' })

  const updatedGroup = await client.upsertScimGroup({
    workspaceId,
    groupId: group.groupId,
    identityProviderId: group.identityProviderId,
    externalId: group.externalId,
    displayName: group.displayName,
    active: true,
    memberUserIds: [],
    idempotencyKey: 'job-preview-group-remove-user',
  })
  const pendingReference = await client.getScimGroupJobReference(
    workspaceId,
    updatedGroup.groupId,
  )
  if (!pendingReference) throw new Error('Expected the removal group job.')
  const preview = await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'job-preview-after-removal',
  })
  expect(preview.changes.find((change) =>
    change.entityType === 'user' && change.entityId === user.userId
  )).toMatchObject({ action: 'update' })

  await client.markScimGroupApplied(
    workspaceId,
    updatedGroup.groupId,
    updatedGroup.version,
  )
  expect(await client.getScimGroupJobReference(
    workspaceId,
    updatedGroup.groupId,
  )).toEqual(pendingReference)
  const removalApply = await client.processScimGroupJob(
    pendingReference,
    async () => undefined,
  )
  if (removalApply.status !== 'continued') {
    throw new Error('Expected the removal settle phase.')
  }
  await expect(client.processScimGroupJob(
    removalApply.nextReference,
    async () => undefined,
  )).resolves.toMatchObject({ status: 'completed' })
  expect(await client.getScimGroupJobReference(
    workspaceId,
    updatedGroup.groupId,
  )).toBeUndefined()
})

test('atomically rejects a SCIM group target union above the durable backlog cap', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-job-backlog'))
  const state = (client as unknown as {
    states: Map<string, {
      scimUsers: EnterpriseIdentitySnapshot['scimUsers']
    }>
  }).states.get(workspaceId)
  if (!state) throw new Error('Expected seeded enterprise identity state.')
  state.scimUsers.push(...Array.from({ length: 2_001 }, (_, index) => ({
    workspaceId,
    userId: `backlog-user-${index}`,
    externalId: `backlog-user-${index}`,
    identityProviderId: 'idp-job-backlog',
    userName: `backlog-user-${index}@example.com`,
    emails: [`backlog-user-${index}@example.com`],
    active: true,
    groupIds: [],
    version: 1,
    appliedVersion: 1,
    appliedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })))
  const firstMembers = Array.from(
    { length: 1_000 },
    (_, index) => `backlog-user-${index}`,
  )
  const secondMembers = Array.from(
    { length: 1_000 },
    (_, index) => `backlog-user-${index + 1_000}`,
  )
  const first = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-job-backlog',
    externalId: 'backlog-group',
    displayName: 'Backlog group',
    active: true,
    memberUserIds: firstMembers,
    idempotencyKey: 'backlog-group-a',
  })
  const second = await client.upsertScimGroup({
    workspaceId,
    groupId: first.groupId,
    identityProviderId: 'idp-job-backlog',
    externalId: first.externalId,
    displayName: first.displayName,
    active: true,
    memberUserIds: secondMembers,
    idempotencyKey: 'backlog-group-b',
  })
  const referenceBeforeOverflow = await client.getScimGroupJobReference(
    workspaceId,
    first.groupId,
  )

  await expect(client.upsertScimGroup({
    workspaceId,
    groupId: first.groupId,
    identityProviderId: 'idp-job-backlog',
    externalId: first.externalId,
    displayName: first.displayName,
    active: true,
    memberUserIds: ['backlog-user-2000'],
    idempotencyKey: 'backlog-group-c',
  })).rejects.toMatchObject({
    status: 429,
    code: 'EnterpriseScimGroupJobBacklogExceeded',
    retryable: true,
  })
  expect((await client.getSnapshot(workspaceId)).scimGroups[0]).toEqual(second)
  expect(await client.getScimGroupJobReference(workspaceId, first.groupId))
    .toEqual(referenceBeforeOverflow)
})

test('restarts pending apply and settle pages when guest mappings change', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-job-mapping'))
  const users = await createScimUsers(
    client,
    'idp-job-mapping',
    6,
    'job-mapping-user',
  )
  const group = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-job-mapping',
    externalId: 'job-mapping-group',
    displayName: 'Job mapping group',
    active: true,
    memberUserIds: users.map((user) => user.userId),
    idempotencyKey: 'job-mapping-group',
  })
  const initialReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  if (!initialReference) throw new Error('Expected a pending SCIM group job.')
  const firstApplyPage = await client.processScimGroupJob(
    initialReference,
    async () => undefined,
  )
  if (firstApplyPage.status !== 'continued') {
    throw new Error('Expected the first apply page to continue.')
  }

  await client.putGroupMapping({
    workspaceId,
    mappingId: 'job-mapping',
    identityProviderId: 'idp-job-mapping',
    directoryGroupId: group.groupId,
    roleId: 'workspace:guest',
    scope: { workspaceId, kind: 'workspace' },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now.toISOString(),
  })
  const restartedApplyReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  if (!restartedApplyReference) {
    throw new Error('Expected the mapping change to retain the job.')
  }
  expect(restartedApplyReference.revision).toBeGreaterThan(
    firstApplyPage.nextReference.revision,
  )
  expect(await client.processScimGroupJob(
    firstApplyPage.nextReference,
    async () => {
      throw new Error('A mapping-stale apply reference must not run.')
    },
  )).toEqual({ status: 'stale' })
  const restartedApplyPage = await client.processScimGroupJob(
    restartedApplyReference,
    async (input) => {
      expect(input.phase).toBe('apply')
    },
  )
  if (restartedApplyPage.status !== 'continued') {
    throw new Error('Expected the restarted apply page to continue.')
  }
  expect(restartedApplyPage.processedUserIds).toEqual(
    firstApplyPage.processedUserIds,
  )
  const applyCompleted = await client.processScimGroupJob(
    restartedApplyPage.nextReference,
    async (input) => {
      expect(input.phase).toBe('apply')
    },
  )
  if (applyCompleted.status !== 'continued') {
    throw new Error('Expected the job to enter its settle phase.')
  }
  const firstSettlePage = await client.processScimGroupJob(
    applyCompleted.nextReference,
    async (input) => {
      expect(input.phase).toBe('settle')
    },
  )
  if (firstSettlePage.status !== 'continued') {
    throw new Error('Expected the first settle page to continue.')
  }
  expect(firstSettlePage.processedUserIds).toHaveLength(5)

  await client.deleteGroupMapping(workspaceId, 'job-mapping', 1)
  const restartedSettleReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  if (!restartedSettleReference) {
    throw new Error('Expected mapping deletion to retain the settle job.')
  }
  expect(restartedSettleReference.revision).toBeGreaterThan(
    firstSettlePage.nextReference.revision,
  )
  expect(await client.processScimGroupJob(
    firstSettlePage.nextReference,
    async () => {
      throw new Error('A mapping-stale settle reference must not run.')
    },
  )).toEqual({ status: 'stale' })
  const restartedSettlePage = await client.processScimGroupJob(
    restartedSettleReference,
    async (input) => {
      expect(input.phase).toBe('settle')
    },
  )
  expect(restartedSettlePage.status).toBe('continued')
  expect(restartedSettlePage.processedUserIds).toEqual(
    firstSettlePage.processedUserIds,
  )
})

test('enqueues applied group jobs for guest mapping create, retarget, and delete', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-job-mapping-applied'))
  const users = await createScimUsers(
    client,
    'idp-job-mapping-applied',
    2,
    'job-mapping-applied-user',
  )
  const [firstUser, secondUser] = users
  if (!firstUser || !secondUser) {
    throw new Error('Expected two SCIM mapping users.')
  }
  const firstGroup = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-job-mapping-applied',
    externalId: 'job-mapping-applied-external',
    displayName: 'First applied mapping group',
    active: true,
    memberUserIds: [firstUser.userId],
    idempotencyKey: 'job-mapping-applied-first-group',
  })
  const secondGroup = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-job-mapping-applied',
    externalId: 'job-mapping-applied-second-external',
    displayName: 'Second applied mapping group',
    active: true,
    memberUserIds: [secondUser.userId],
    idempotencyKey: 'job-mapping-applied-second-group',
  })
  const drainJob = async (groupId: string) => {
    let reference = await client.getScimGroupJobReference(workspaceId, groupId)
    if (!reference) throw new Error('Expected a pending SCIM group job.')
    while (reference) {
      const result = await client.processScimGroupJob(
        reference,
        async () => undefined,
      )
      if (result.status === 'stale') {
        throw new Error('Expected a current SCIM group job reference.')
      }
      reference = result.status === 'continued'
        ? result.nextReference
        : undefined
    }
  }
  await drainJob(firstGroup.groupId)
  await drainJob(secondGroup.groupId)

  const mapping = {
    workspaceId,
    mappingId: 'applied-job-mapping',
    identityProviderId: 'idp-job-mapping-applied',
    directoryGroupId: firstGroup.externalId,
    roleId: 'workspace:guest',
    scope: { workspaceId, kind: 'workspace' as const },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now.toISOString(),
  }
  await client.putGroupMapping(mapping)
  const createReference = await client.getScimGroupJobReference(
    workspaceId,
    firstGroup.groupId,
  )
  if (!createReference) {
    throw new Error('Expected externalId mapping to enqueue an applied group job.')
  }
  const createCallbacks: Array<{ phase: string; userId: string }> = []
  expect(await client.processScimGroupJob(
    createReference,
    async (input) => {
      createCallbacks.push({
        phase: input.phase,
        userId: input.user.userId,
      })
    },
  )).toMatchObject({ status: 'completed' })
  expect(createCallbacks).toEqual([{
    phase: 'settle',
    userId: firstUser.userId,
  }])

  const retargetedMapping = {
    ...mapping,
    directoryGroupId: secondGroup.groupId,
    revision: 2,
  }
  await client.putGroupMapping(retargetedMapping)
  const firstRetargetReference = await client.getScimGroupJobReference(
    workspaceId,
    firstGroup.groupId,
  )
  const secondRetargetReference = await client.getScimGroupJobReference(
    workspaceId,
    secondGroup.groupId,
  )
  expect(firstRetargetReference).toBeDefined()
  expect(secondRetargetReference).toBeDefined()
  await expect(client.putGroupMapping(retargetedMapping)).rejects.toMatchObject({
    code: 'EnterpriseGroupMappingConflict',
  })
  expect(await client.getScimGroupJobReference(
    workspaceId,
    firstGroup.groupId,
  )).toEqual(firstRetargetReference)
  expect(await client.getScimGroupJobReference(
    workspaceId,
    secondGroup.groupId,
  )).toEqual(secondRetargetReference)

  const retargetedUserIds: string[] = []
  for (const reference of [firstRetargetReference, secondRetargetReference]) {
    if (!reference) throw new Error('Expected both retargeted group jobs.')
    expect(await client.processScimGroupJob(
      reference,
      async (input) => {
        expect(input.phase).toBe('settle')
        retargetedUserIds.push(input.user.userId)
      },
    )).toMatchObject({ status: 'completed' })
  }
  expect(retargetedUserIds.sort()).toEqual(
    users.map((user) => user.userId).sort(),
  )

  await client.deleteGroupMapping(workspaceId, mapping.mappingId, 2)
  expect(await client.getScimGroupJobReference(
    workspaceId,
    firstGroup.groupId,
  )).toBeUndefined()
  const deleteReference = await client.getScimGroupJobReference(
    workspaceId,
    secondGroup.groupId,
  )
  if (!deleteReference) {
    throw new Error('Expected mapping deletion to enqueue its previous group.')
  }
  const deletedMappingUserIds: string[] = []
  expect(await client.processScimGroupJob(
    deleteReference,
    async (input) => {
      expect(input.phase).toBe('settle')
      deletedMappingUserIds.push(input.user.userId)
    },
  )).toMatchObject({ status: 'completed' })
  expect(deletedMappingUserIds).toEqual([secondUser.userId])
})

test('allows only one running provisioning run per Workspace', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-1',
    externalId: 'exclusive-run-user',
    userName: 'exclusive@example.com',
    emails: ['exclusive@example.com'],
    active: true,
    idempotencyKey: 'exclusive-run-user',
  })
  const firstPreview = await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'exclusive-preview-1',
  })
  const secondPreview = await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'exclusive-preview-2',
  })
  await client.reconcileProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'exclusive-run-1',
    previewFingerprint: firstPreview.fingerprint,
  })

  await expect(client.reconcileProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'exclusive-run-2',
    previewFingerprint: secondPreview.fingerprint,
  })).rejects.toMatchObject({ code: 'EnterpriseProvisioningRunInProgress' })
})

test('previews deterministic session revocation with directory-user deprovisioning', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const active = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-1',
    externalId: 'deprovision-user',
    userName: 'deprovision@example.com',
    emails: ['deprovision@example.com'],
    linkedMemberKey: 'deprovision@example.com',
    active: true,
    idempotencyKey: 'deprovision-user-active',
  })
  await client.markScimUserApplied(workspaceId, active.userId, active.version)
  const inactive = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-1',
    externalId: 'deprovision-user',
    userName: 'deprovision@example.com',
    emails: ['deprovision@example.com'],
    linkedMemberKey: 'deprovision@example.com',
    active: false,
    idempotencyKey: 'deprovision-user-inactive',
  })
  const first = await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'deprovision-preview-1',
  })
  const second = await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'deprovision-preview-2',
  })
  const userChange = first.changes.find((change) =>
    change.entityType === 'user' && change.entityId === inactive.userId
  )
  const sessionChange = first.changes.find((change) =>
    change.entityType === 'session' && change.entityId === inactive.userId
  )

  expect(userChange?.action).toBe('deactivate')
  expect(sessionChange).toMatchObject({
    entityType: 'session',
    entityId: inactive.userId,
    desiredVersion: inactive.version,
    action: 'revoke',
    blocking: false,
  })
  expect(second.changes.find((change) => change.entityType === 'session')?.changeId)
    .toBe(sessionChange?.changeId)
})

test('does not enforce SSO before provider and domain prerequisites are active', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider({
    workspaceId,
    providerId: 'idp-1',
    kind: 'oidc',
    displayName: 'Example IdP',
    cognitoProviderName: 'ExampleCognitoProvider',
    status: 'draft',
    revision: 1,
    issuer: 'https://idp.example.com',
    clientId: 'mukuroji',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email'],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  await expect(client.putVerifiedDomain({
    workspaceId,
    domainId: 'domain-1',
    domain: 'example.com',
    status: 'verified',
    revision: 1,
    verificationRecordName: '_mukuroji.example.com',
    enforceSso: true,
    identityProviderId: 'idp-1',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })).rejects.toMatchObject({ code: 'EnterpriseSsoPrerequisiteMissing' })
})

test('rejects break-glass activation when its recovery domain becomes managed', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putBreakGlassAccount({
    workspaceId,
    accountId: 'break-glass-1',
    linkedMemberKey: 'recovery-user',
    email: 'recovery@outside.example',
    status: 'active',
    requireMfa: true,
    maximumActivationMinutes: 15,
    mfaVerifiedAt: now.toISOString(),
    revision: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  const routeSnapshot = await client.getSnapshot(workspaceId)
  expect(routeSnapshot.domains).toEqual([])
  await client.putVerifiedDomain({
    workspaceId,
    domainId: 'outside-example',
    domain: 'outside.example',
    status: 'verified',
    revision: 1,
    verificationRecordName: '_mukuroji.outside.example',
    verifiedAt: now.toISOString(),
    enforceSso: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  await expect(client.activateBreakGlass(
    workspaceId,
    'break-glass-1',
    'recovery-user',
    'authentication-session',
    'Recover access',
    15,
  )).rejects.toMatchObject({
    code: 'EnterpriseBreakGlassRecoveryDomainManaged',
    status: 409,
  })
  expect(await client.getActiveBreakGlassActivation(
    workspaceId,
    'recovery-user',
    'authentication-session',
  )).toBeUndefined()
  const persistedAccount = (await client.getSnapshot(workspaceId))
    .breakGlassAccounts[0]
  expect(persistedAccount?.revision).toBe(1)
  expect(persistedAccount?.lastTestedAt).toBeUndefined()
})

test('claims and releases domains atomically with in-memory state', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await expect(client.putVerifiedDomain({
    workspaceId,
    domainId: 'invalid-domain',
    domain: 'atomic.example.com',
    status: 'pending',
    revision: 2,
    verificationRecordName: '_mukuroji.atomic.example.com',
    enforceSso: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })).rejects.toMatchObject({ code: 'EnterpriseDomainConflict' })

  const secondWorkspaceId = 'workspace-2'
  const claimed = await client.putVerifiedDomain({
    workspaceId: secondWorkspaceId,
    domainId: 'domain-2',
    domain: 'atomic.example.com',
    status: 'pending',
    revision: 1,
    verificationRecordName: '_mukuroji.atomic.example.com',
    enforceSso: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })
  expect(claimed.workspaceId).toBe(secondWorkspaceId)

  await client.putVerifiedDomain({
    ...claimed,
    domain: 'replacement.example.com',
    verificationRecordName: '_mukuroji.replacement.example.com',
    revision: 2,
    updatedAt: new Date(now.getTime() + 1_000).toISOString(),
  })
  await expect(client.putVerifiedDomain({
    workspaceId: 'workspace-3',
    domainId: 'domain-3',
    domain: 'atomic.example.com',
    status: 'pending',
    revision: 1,
    verificationRecordName: '_mukuroji.atomic.example.com',
    enforceSso: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })).resolves.toMatchObject({ workspaceId: 'workspace-3' })
})

test('stages versioned state before atomically checkpointing domain claims and CONTROL', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  const domain = await client.putVerifiedDomain({
    workspaceId,
    domainId: 'domain-1',
    domain: 'atomic.example.com',
    status: 'pending',
    revision: 1,
    verificationRecordName: '_mukuroji.atomic.example.com',
    enforceSso: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  expect(harness.transactions).toHaveLength(1)
  const createTransaction = JSON.stringify(harness.transactions[0]?.TransactItems)
  expect(createTransaction).toContain('"recordKey":"CONTROL"')
  expect(createTransaction).toContain('"scopeKey":"DOMAIN#atomic.example.com"')
  expect(createTransaction).not.toContain('"recordType":"DOMAIN"')
  expect(JSON.stringify(harness.batchWrites)).toContain('"recordType":"DOMAIN"')

  await client.putVerifiedDomain({
    ...domain,
    domain: 'replacement.example.com',
    verificationRecordName: '_mukuroji.replacement.example.com',
    revision: 2,
    updatedAt: new Date(now.getTime() + 1_000).toISOString(),
  })
  const renameItems = harness.transactions[1]?.TransactItems as Array<Record<string, unknown>>
  expect(renameItems.some((item) =>
    (item.Delete as { Key?: { scopeKey?: string } } | undefined)?.Key?.scopeKey ===
      'DOMAIN#atomic.example.com'
  )).toBe(true)
  expect(renameItems.some((item) =>
    (item.Put as { Item?: { scopeKey?: string } } | undefined)?.Item?.scopeKey ===
      'DOMAIN#replacement.example.com'
  )).toBe(true)
  expect(renameItems.some((item) =>
    (item.Put as { Item?: { recordKey?: string } } | undefined)?.Item?.recordKey === 'CONTROL'
  )).toBe(true)
})

test('atomically writes reference-only SCIM job rows through apply and settle continuation', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-job-storage'))
  const users = await createScimUsers(
    client,
    'idp-job-storage',
    6,
    'job-storage-user',
  )
  const group = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-job-storage',
    externalId: 'job-storage-group',
    displayName: 'Job storage group',
    active: true,
    memberUserIds: users.map((user) => user.userId),
    idempotencyKey: 'job-storage-group',
  })
  const initialReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  if (!initialReference) throw new Error('Expected a pending SCIM group job.')
  const initialItems = harness.transactions.at(-1)?.TransactItems as
    | Array<Record<string, unknown>>
    | undefined
  if (!initialItems) throw new Error('Expected the group transaction.')
  const initialControlIndex = initialItems.findIndex((item) =>
    (item.Put as { Item?: { recordKey?: string } } | undefined)
      ?.Item?.recordKey === 'CONTROL'
  )
  const initialJobIndex = initialItems.findIndex((item) =>
    (item.Put as { Item?: { entryType?: string } } | undefined)
      ?.Item?.entryType === 'enterprise-scim-group-job'
  )
  expect(initialControlIndex).toBe(0)
  expect(initialJobIndex).toBeGreaterThan(initialControlIndex)
  const initialJobPut = initialItems[initialJobIndex]?.Put as
    | { Item?: Record<string, unknown> }
    | undefined
  expect(initialJobPut?.Item).toEqual({
    scopeKey: `WORKSPACE#${workspaceId}`,
    recordKey: `SCIM_GROUP_JOB#${initialReference.jobId}`,
    entryType: 'enterprise-scim-group-job',
    workspaceId,
    jobId: initialReference.jobId,
    revision: initialReference.revision,
  })

  const firstPage = await client.processScimGroupJob(
    initialReference,
    async (input) => {
      expect(input.phase).toBe('apply')
    },
  )
  if (firstPage.status !== 'continued') {
    throw new Error('Expected the first apply page to continue.')
  }
  expect(firstPage.processedUserIds).toHaveLength(5)
  const applyCompleted = await client.processScimGroupJob(
    firstPage.nextReference,
    async (input) => {
      expect(input.phase).toBe('apply')
    },
  )
  if (applyCompleted.status !== 'continued') {
    throw new Error('Expected the completed apply phase to continue settling.')
  }
  expect(applyCompleted.processedUserIds).toHaveLength(1)
  expect((await client.getSnapshot(workspaceId)).scimGroups[0]).toMatchObject({
    version: 1,
    appliedVersion: 1,
  })
  const applyCheckpointItems = harness.transactions.at(-1)?.TransactItems as
    Array<Record<string, unknown>>
  const applyCheckpointJob = applyCheckpointItems.find((item) =>
    (item.Put as { Item?: { entryType?: string } } | undefined)
      ?.Item?.entryType === 'enterprise-scim-group-job'
  )
  const applyCheckpointPut = applyCheckpointJob?.Put as
    | { Item?: { revision?: number } }
    | undefined
  expect(applyCheckpointPut?.Item?.revision).toBe(
    applyCompleted.nextReference.revision,
  )

  const firstSettlePage = await client.processScimGroupJob(
    applyCompleted.nextReference,
    async (input) => {
      expect(input.phase).toBe('settle')
    },
  )
  if (firstSettlePage.status !== 'continued') {
    throw new Error('Expected the first settle page to continue.')
  }
  expect(firstSettlePage.processedUserIds).toHaveLength(5)
  const finalReference = firstSettlePage.nextReference
  const completed = await client.processScimGroupJob(
    finalReference,
    async (input) => {
      expect(input.phase).toBe('settle')
    },
  )
  expect(completed.status).toBe('completed')
  const completionItems = harness.transactions.at(-1)?.TransactItems as
    Array<Record<string, unknown>>
  expect(completionItems[0]).toHaveProperty('Put.Item.recordKey', 'CONTROL')
  expect(completionItems.some((item) =>
    (item.Delete as {
      Key?: { recordKey?: string }
    } | undefined)?.Key?.recordKey ===
      `SCIM_GROUP_JOB#${initialReference.jobId}`
  )).toBe(true)
  expect(await client.getScimGroupJobReference(workspaceId, group.groupId))
    .toBeUndefined()

  await client.putGroupMapping({
    workspaceId,
    mappingId: 'job-storage-mapping',
    identityProviderId: group.identityProviderId,
    directoryGroupId: group.externalId,
    roleId: 'workspace:guest',
    scope: { workspaceId, kind: 'workspace' },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now.toISOString(),
  })
  const mappingReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  if (!mappingReference) {
    throw new Error('Expected mapping mutation to persist a group job.')
  }
  const mappingItems = harness.transactions.at(-1)?.TransactItems as
    Array<Record<string, unknown>>
  expect(mappingItems[0]).toHaveProperty('Put.Item.recordKey', 'CONTROL')
  expect(mappingItems.some((item) =>
    (item.Put as {
      Item?: { jobId?: string; revision?: number }
    } | undefined)?.Item?.jobId === mappingReference.jobId &&
    (item.Put as {
      Item?: { revision?: number }
    } | undefined)?.Item?.revision === mappingReference.revision
  )).toBe(true)
  const mappingPhases: string[] = []
  expect(await client.processScimGroupJob(
    mappingReference,
    async (input) => {
      mappingPhases.push(input.phase)
    },
  )).toMatchObject({ status: 'continued' })
  const mappingSettleReference = await client.getScimGroupJobReference(
    workspaceId,
    group.groupId,
  )
  if (!mappingSettleReference) {
    throw new Error('Expected the multi-page mapping job to continue.')
  }
  expect(await client.processScimGroupJob(
    mappingSettleReference,
    async (input) => {
      mappingPhases.push(input.phase)
    },
  )).toMatchObject({ status: 'completed' })
  expect(mappingPhases).toEqual(
    Array.from({ length: users.length }, () => 'settle'),
  )

  const recreatedGroup = await client.upsertScimGroup({
    workspaceId,
    groupId: group.groupId,
    identityProviderId: group.identityProviderId,
    externalId: group.externalId,
    displayName: 'Recreated job group',
    active: true,
    memberUserIds: group.memberUserIds,
    idempotencyKey: 'job-storage-group-recreated',
  })
  const recreatedReference = await client.getScimGroupJobReference(
    workspaceId,
    recreatedGroup.groupId,
  )
  expect(recreatedReference?.jobId).toBe(initialReference.jobId)
  expect(recreatedReference?.revision).toBeGreaterThan(finalReference.revision)
  expect(await client.processScimGroupJob(
    finalReference,
    async () => {
      throw new Error('An ABA-stale job reference must not run.')
    },
  )).toEqual({ status: 'stale' })
})

test('queries provider-scoped SCIM pages and authentication from direct projections', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-direct-a'))
  await client.putIdentityProvider(createActiveProvider('idp-direct-b'))
  const credential = await client.issueScimToken(
    workspaceId,
    'idp-direct-a',
    'Direct query credential',
  )
  const first = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-direct-a',
    externalId: 'direct-user-a',
    userName: 'alpha@example.com',
    displayName: 'Shared display name',
    emails: ['alpha@example.com'],
    active: true,
    idempotencyKey: 'direct-user-a',
  })
  const second = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-direct-a',
    externalId: 'direct-user-b',
    userName: 'beta@example.com',
    displayName: 'Shared display name',
    emails: ['beta@example.com'],
    active: true,
    idempotencyKey: 'direct-user-b',
  })
  await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-direct-b',
    externalId: 'direct-user-a',
    userName: 'other-provider@example.com',
    emails: ['other-provider@example.com'],
    active: true,
    idempotencyKey: 'direct-user-other-provider',
  })
  const group = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-direct-a',
    externalId: 'direct-group',
    displayName: 'Direct group',
    active: true,
    memberUserIds: [first.userId, second.userId],
    idempotencyKey: 'direct-group',
  })

  harness.resetQueries()
  const authentication = await client.authenticateScimWorkspace(
    workspaceId,
    credential.token,
  )
  const sortedUserIds = [first.userId, second.userId].sort()
  const secondPage = await client.listScimUsers({
    workspaceId,
    identityProviderId: 'idp-direct-a',
    startIndex: 2,
    count: 1,
  })
  const filteredUsers = await client.listScimUsers({
    workspaceId,
    identityProviderId: 'idp-direct-a',
    startIndex: 1,
    count: 200,
    filter: {
      field: 'displayName',
      value: 'SHARED DISPLAY NAME',
    },
  })
  const filteredGroups = await client.listScimGroups({
    workspaceId,
    identityProviderId: 'idp-direct-a',
    startIndex: 1,
    count: 20,
    filter: {
      field: 'externalId',
      value: 'direct-group',
    },
  })
  const caseChangedExternalGroups = await client.listScimGroups({
    workspaceId,
    identityProviderId: 'idp-direct-a',
    startIndex: 1,
    count: 20,
    filter: {
      field: 'externalId',
      value: 'DIRECT-GROUP',
    },
  })

  expect(authentication).toMatchObject({
    credential: {
      identityProviderId: 'idp-direct-a',
      tokenLastFour: credential.token.slice(-4),
    },
    provider: { providerId: 'idp-direct-a' },
  })
  const persistedState = JSON.stringify([...harness.items.values()])
  expect(persistedState).not.toContain(credential.token)
  expect(persistedState).toContain(
    `"tokenLastFour":"${credential.token.slice(-4)}"`,
  )
  expect(secondPage).toMatchObject({
    totalResults: 2,
    startIndex: 2,
    resources: [{ userId: sortedUserIds[1] }],
  })
  expect(filteredUsers.resources.map((user) => user.userId).sort()).toEqual(
    sortedUserIds,
  )
  expect(filteredUsers.totalResults).toBe(2)
  expect(filteredGroups).toMatchObject({
    totalResults: 1,
    resources: [{
      groupId: group.groupId,
      memberUserIds: [first.userId, second.userId],
    }],
  })
  expect(caseChangedExternalGroups).toMatchObject({
    totalResults: 0,
    resources: [],
  })
  await expect(client.listScimGroups({
    workspaceId,
    identityProviderId: 'idp-direct-a',
    startIndex: 1,
    count: 21,
  })).rejects.toMatchObject({
    status: 400,
    code: 'EnterpriseScimPaginationInvalid',
  })
  expect(harness.queries.length).toBeGreaterThanOrEqual(4)
  expect(harness.queries.every((query) => {
    const values = query.ExpressionAttributeValues as Record<string, unknown>
    return !String(values[':scopeKey']).startsWith('WORKSPACE_STATE#')
  })).toBe(true)
  expect(harness.queries.some((query) => {
    const values = query.ExpressionAttributeValues as Record<string, unknown>
    return String(values[':scopeKey']).startsWith('SCIM_LOOKUP#')
  })).toBe(true)
})

test('deletes empty direct SCIM lookup partitions after resource attributes change', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-direct-retired'))
  const user = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-direct-retired',
    externalId: 'retired-external-id',
    userName: 'retired-user@example.com',
    displayName: 'Retired display name',
    emails: ['retired-user@example.com'],
    active: true,
    idempotencyKey: 'direct-retired-user',
  })
  const retiredScopeKeys = new Set(
    [...harness.items.values()]
      .filter((item) =>
        item.entryType === 'enterprise-scim-lookup' &&
        item.resourceId === user.userId
      )
      .map((item) => String(item.scopeKey)),
  )
  expect(retiredScopeKeys.size).toBe(3)
  for (const scopeKey of retiredScopeKeys) {
    expect([...harness.items.values()].filter((item) =>
      item.scopeKey === scopeKey
    ).map((item) => item.recordKey).sort()).toEqual([
      'META',
      `RESOURCE#${user.userId}`,
    ])
  }

  await client.upsertScimUser({
    workspaceId,
    userId: user.userId,
    identityProviderId: user.identityProviderId,
    externalId: 'current-external-id',
    userName: 'current-user@example.com',
    displayName: 'Current display name',
    emails: user.emails,
    active: true,
    idempotencyKey: 'direct-retired-user-update',
  })

  expect([...harness.items.values()].filter((item) =>
    retiredScopeKeys.has(String(item.scopeKey))
  )).toEqual([])
  for (const filter of [
    { field: 'externalId' as const, value: 'retired-external-id' },
    { field: 'userName' as const, value: 'retired-user@example.com' },
    { field: 'displayName' as const, value: 'Retired display name' },
  ]) {
    await expect(client.listScimUsers({
      workspaceId,
      identityProviderId: user.identityProviderId,
      startIndex: 1,
      count: 100,
      filter,
    })).resolves.toMatchObject({
      totalResults: 0,
      resources: [],
    })
  }
})

test('enforces SCIM resource and collection limits before state persistence', async () => {
  const client = new InMemoryEnterpriseIdentityClient(
    tokenSecret,
    () => now,
    { maximumUsers: 1, maximumGroups: 1 },
  )
  await client.putIdentityProvider(createActiveProvider('idp-limits'))
  const user = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-limits',
    externalId: 'limited-user',
    userName: 'limited@example.com',
    emails: ['limited@example.com'],
    active: true,
    idempotencyKey: 'limited-user',
  })
  await expect(client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-limits',
    externalId: 'overflow-user',
    userName: 'overflow@example.com',
    emails: ['overflow@example.com'],
    active: true,
    idempotencyKey: 'overflow-user',
  })).rejects.toMatchObject({
    status: 413,
    code: 'EnterpriseScimUserLimitExceeded',
  })
  await expect(client.upsertScimUser({
    workspaceId,
    userId: user.userId,
    identityProviderId: 'idp-limits',
    externalId: user.externalId,
    userName: user.userName,
    displayName: 'Updated at the cap',
    emails: user.emails,
    active: true,
    idempotencyKey: 'limited-user-update',
  })).resolves.toMatchObject({ displayName: 'Updated at the cap' })

  const group = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-limits',
    externalId: 'limited-group',
    displayName: 'Limited group',
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: 'limited-group',
  })
  await expect(client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-limits',
    externalId: 'overflow-group',
    displayName: 'Overflow group',
    active: true,
    memberUserIds: [],
    idempotencyKey: 'overflow-group',
  })).rejects.toMatchObject({
    status: 413,
    code: 'EnterpriseScimGroupLimitExceeded',
  })
  await expect(client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-limits',
    externalId: 'oversized-members',
    displayName: 'Oversized members',
    active: true,
    memberUserIds: Array.from({ length: 1_001 }, () => user.userId),
    idempotencyKey: 'oversized-members',
  })).rejects.toMatchObject({
    status: 413,
    code: 'EnterpriseScimGroupMemberLimitExceeded',
  })
  await expect(client.upsertScimUser({
    workspaceId,
    userId: user.userId,
    identityProviderId: 'idp-limits',
    externalId: user.externalId,
    userName: user.userName,
    emails: Array.from(
      { length: 11 },
      (_, index) => `limited-${index}@example.com`,
    ),
    active: true,
    idempotencyKey: 'oversized-emails',
  })).rejects.toMatchObject({
    status: 413,
    code: 'EnterpriseScimUserEmailLimitExceeded',
  })
  await expect(client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-limits',
    externalId: 'u'.repeat(257),
    userName: 'bounded@example.com',
    emails: ['bounded@example.com'],
    active: true,
    idempotencyKey: 'oversized-user-external-id',
  })).rejects.toMatchObject({
    status: 400,
    code: 'EnterpriseScimTextLimitExceeded',
  })
  await expect(client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-limits',
    externalId: 'bounded-group',
    displayName: 'g'.repeat(257),
    active: true,
    memberUserIds: [],
    idempotencyKey: 'oversized-group-display-name',
  })).rejects.toMatchObject({
    status: 400,
    code: 'EnterpriseScimTextLimitExceeded',
  })
  await expect(client.upsertScimUser({
    workspaceId,
    userId: user.userId,
    identityProviderId: 'idp-limits',
    externalId: user.externalId,
    userName: user.userName,
    emails: user.emails,
    active: true,
    idempotencyKey: `${'i'.repeat(256)} `,
  })).rejects.toMatchObject({
    status: 400,
    code: 'EnterpriseScimTextLimitExceeded',
  })
  await expect(client.deactivateScimUser(
    workspaceId,
    'idp-limits',
    `${user.userId}${' '.repeat(129)}`,
    'bounded-user-deactivate',
  )).rejects.toMatchObject({
    status: 400,
    code: 'EnterpriseScimTextLimitExceeded',
  })
  await expect(client.deactivateScimGroup(
    workspaceId,
    'idp-limits',
    group.groupId,
    `${'i'.repeat(256)} `,
  )).rejects.toMatchObject({
    status: 400,
    code: 'EnterpriseScimTextLimitExceeded',
  })
})

test('caps active SCIM credentials per identity provider', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-credential-cap'))
  for (let index = 0; index < 10; index += 1) {
    await client.issueScimToken(
      workspaceId,
      'idp-credential-cap',
      `Credential ${index}`,
    )
  }
  await expect(client.issueScimToken(
    workspaceId,
    'idp-credential-cap',
    'Overflow credential',
  )).rejects.toMatchObject({
    status: 413,
    code: 'EnterpriseScimCredentialLimitExceeded',
  })
})

test('caps active SCIM credentials across a Workspace while allowing replacement', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  const providerIds = Array.from(
    { length: 6 },
    (_, index) => `idp-workspace-credential-cap-${index}`,
  )
  for (const providerId of providerIds) {
    await client.putIdentityProvider(createActiveProvider(providerId))
  }
  for (const providerId of providerIds.slice(0, 5)) {
    for (let index = 0; index < 10; index += 1) {
      await client.issueScimToken(
        workspaceId,
        providerId,
        `${providerId} credential ${index}`,
      )
    }
  }
  await expect(client.issueScimToken(
    workspaceId,
    providerIds[5]!,
    'Overflow Workspace credential',
  )).rejects.toMatchObject({
    status: 413,
    code: 'EnterpriseScimWorkspaceCredentialLimitExceeded',
  })
  await expect(client.rotateScimToken(
    workspaceId,
    providerIds[5]!,
    'Overflow rotation',
    0,
    'overflow-workspace-rotation',
    'overflow-workspace-rotation',
  )).rejects.toMatchObject({
    status: 413,
    code: 'EnterpriseScimWorkspaceCredentialLimitExceeded',
  })
  await expect(client.rotateScimToken(
    workspaceId,
    providerIds[0]!,
    'Replacement rotation',
    10,
    'replacement-workspace-rotation',
    'replacement-workspace-rotation',
  )).resolves.toMatchObject({
    credential: { identityProviderId: providerIds[0] },
  })
})

test('hashes long provider IDs in direct SCIM authentication record keys', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  const longProviderId = 'provider-'.repeat(150)
  await client.putIdentityProvider({
    ...createActiveProvider('bounded-provider'),
    providerId: longProviderId,
    displayName: 'Long provider ID',
    cognitoProviderName: 'LongProvider',
  })
  const authProviderItems = harness.transactions.flatMap((transaction) =>
    (transaction.TransactItems as Array<Record<string, unknown>>)
      .map((operation) =>
        (operation.Put as { Item?: Record<string, unknown> } | undefined)?.Item
      )
      .filter((item) => item?.entryType === 'enterprise-scim-auth-provider')
  )
  expect(authProviderItems).toHaveLength(1)
  expect(String(authProviderItems[0]?.recordKey)).toStartWith('PROVIDER#')
  expect(Buffer.byteLength(String(authProviderItems[0]?.recordKey), 'utf8'))
    .toBeLessThan(1_024)
  expect(String(authProviderItems[0]?.recordKey)).not.toContain(longProviderId)

  const issued = await client.issueScimToken(
    workspaceId,
    longProviderId,
    'Long provider credential',
  )
  expect(await client.authenticateScimWorkspace(workspaceId, issued.token))
    .toMatchObject({
      provider: { providerId: longProviderId },
      credential: { identityProviderId: longProviderId },
    })
})

test('rejects an active generation with a missing manifest record', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const control = harness.items.get(
    enterpriseItemKey({ scopeKey: `WORKSPACE#${workspaceId}`, recordKey: 'CONTROL' }),
  )
  const activeGeneration = String(control?.activeStateGeneration)
  const activeScopeKey = `WORKSPACE_STATE#${workspaceId}#${activeGeneration}`
  const activeRecord = [...harness.items.values()].find((item) =>
    item.scopeKey === activeScopeKey &&
    item.entryType === 'enterprise-identity-record'
  )
  expect(activeRecord).toBeDefined()
  harness.items.delete(enterpriseItemKey(activeRecord!))

  await expect(client.getSnapshot(workspaceId)).rejects.toMatchObject({
    code: 'EnterpriseIdentityStateInvalid',
  })
})

test('keeps request writes delta-only and asynchronously compacts a bounded chain', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  const maintenance = new DynamoDbEnterpriseIdentityMaintenanceClient(
    'enterprise-identity',
    harness.documentClient as never,
    () => now,
  )
  for (let index = 0; index < 20; index += 1) {
    const batchStart = harness.batchWrites.length
    await client.putIdentityProvider(createActiveProvider(`idp-${index}`))
    expect(harness.batchWrites.length - batchStart).toBe(1)
  }
  const preCompactionControl = harness.items.get(
    enterpriseItemKey({ scopeKey: `WORKSPACE#${workspaceId}`, recordKey: 'CONTROL' }),
  )!
  const preCompactionGenerations =
    preCompactionControl.activeStateGenerations as string[]
  expect(preCompactionGenerations).toHaveLength(20)
  expect(preCompactionControl.maintenanceRequired).toBe(true)

  await expect(maintenance.maintainWorkspace(workspaceId)).resolves.toEqual({
    status: 'compacted',
  })
  const control = harness.items.get(
    enterpriseItemKey({ scopeKey: `WORKSPACE#${workspaceId}`, recordKey: 'CONTROL' }),
  )!
  const activeStateGenerations = control.activeStateGenerations as string[]
  expect(activeStateGenerations).toHaveLength(1)
  expect(control.retiredStateGenerations).toEqual([])
  expect(control.maintenanceRequired).toBe(false)
  const retiredItems = [...harness.items.values()].filter((item) =>
    preCompactionGenerations.some((generation) =>
      item.scopeKey === `WORKSPACE_STATE#${workspaceId}#${generation}`
    )
  )
  expect(retiredItems.length).toBeGreaterThan(20)
  expect(retiredItems.every((item) =>
    item.expiresAt === Math.floor(now.getTime() / 1_000) + 60 * 60
  )).toBe(true)

  const orphanGeneration = 'orphan-generation'
  harness.items.set(enterpriseItemKey({
    scopeKey: `WORKSPACE_STATE#${workspaceId}#${orphanGeneration}`,
    recordKey: 'GENERATION',
  }), {
    scopeKey: `WORKSPACE_STATE#${workspaceId}#${orphanGeneration}`,
    recordKey: 'GENERATION',
    entryType: 'enterprise-identity-generation',
    workspaceId,
    stateGeneration: orphanGeneration,
  })
  harness.resetQueries()
  const snapshot = await client.getSnapshot(workspaceId)
  expect(snapshot.identityProviders).toHaveLength(20)
  expect(harness.queries).toHaveLength(activeStateGenerations.length)
  expect(harness.queries.length).toBeLessThanOrEqual(64)
  expect(harness.queries.map((query) =>
    (query.ExpressionAttributeValues as Record<string, string>)[':scopeKey']
  )).toEqual(activeStateGenerations.map((generation) =>
    `WORKSPACE_STATE#${workspaceId}#${generation}`
  ))
  expect(JSON.stringify(harness.queries)).not.toContain(orphanGeneration)

  let servePreCompactionControl = true
  const inFlightReader = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    {
      async send(command: unknown) {
        const commandName = (
          command as { constructor?: { name?: string } }
        ).constructor?.name
        const input = (command as { input: Record<string, unknown> }).input
        if (
          commandName === 'GetCommand' &&
          (input.Key as { recordKey?: string }).recordKey === 'CONTROL' &&
          servePreCompactionControl
        ) {
          servePreCompactionControl = false
          return { Item: structuredClone(preCompactionControl) }
        }
        return await harness.documentClient.send(command)
      },
    } as never,
    undefined,
    () => now,
  )
  await expect(inFlightReader.getSnapshot(workspaceId)).resolves.toMatchObject({
    identityProviders: expect.arrayContaining([
      expect.objectContaining({ providerId: 'idp-19' }),
    ]),
  })
})

test('hard-stops a saturated chain until asynchronous compaction succeeds', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  const maintenance = new DynamoDbEnterpriseIdentityMaintenanceClient(
    'enterprise-identity',
    harness.documentClient as never,
    () => now,
  )
  for (let index = 0; index < 64; index += 1) {
    await client.putIdentityProvider(createActiveProvider(`saturated-${index}`))
  }
  const batchWritesBeforeRejection = harness.batchWrites.length
  await expect(client.putIdentityProvider(
    createActiveProvider('saturated-retry'),
  )).rejects.toMatchObject({
    code: 'EnterpriseIdentityCompactionRequired',
    retryable: true,
  })
  expect(harness.batchWrites).toHaveLength(batchWritesBeforeRejection)

  await expect(maintenance.maintainWorkspace(workspaceId)).resolves.toEqual({
    status: 'compacted',
  })
  await expect(client.putIdentityProvider(
    createActiveProvider('saturated-retry'),
  )).resolves.toMatchObject({ providerId: 'saturated-retry' })
  expect((await client.getSnapshot(workspaceId)).identityProviders).toHaveLength(65)
})

test('clears expired retirement metadata after DynamoDB TTL removes old partitions', async () => {
  let currentTime = now
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => currentTime,
  )
  const maintenance = new DynamoDbEnterpriseIdentityMaintenanceClient(
    'enterprise-identity',
    harness.documentClient as never,
    () => currentTime,
  )
  for (let index = 0; index < 16; index += 1) {
    await client.putIdentityProvider(createActiveProvider(`ttl-race-${index}`))
  }
  harness.rejectBatchWritesAfter(1)
  await expect(maintenance.maintainWorkspace(workspaceId)).rejects.toMatchObject({
    code: 'EnterpriseIdentityUnavailable',
  })
  const controlKey = enterpriseItemKey({
    scopeKey: `WORKSPACE#${workspaceId}`,
    recordKey: 'CONTROL',
  })
  const interruptedControl = harness.items.get(controlKey)!
  const retired = interruptedControl.retiredStateGenerations as Array<{
    stateGeneration: string
    expiresAt: number
  }>
  expect(retired).toHaveLength(16)
  for (const [key, item] of harness.items) {
    if (
      item.scopeKey ===
        `WORKSPACE_STATE#${workspaceId}#${retired[0]!.stateGeneration}`
    ) {
      harness.items.delete(key)
    }
  }
  currentTime = new Date((retired[0]!.expiresAt + 1) * 1_000)
  harness.resumeBatchWrites()

  await expect(maintenance.maintainWorkspace(workspaceId)).resolves.toEqual({
    status: 'retirement-expired',
  })
  expect(harness.items.get(controlKey)?.retiredStateGenerations).toEqual([])
  const recoveryExpiresAt = Math.floor(currentTime.getTime() / 1_000) + 60 * 60
  const remainingRetiredItems = [...harness.items.values()].filter((item) =>
    retired.slice(1).some((entry) =>
      item.scopeKey ===
        `WORKSPACE_STATE#${workspaceId}#${entry.stateGeneration}`
    )
  )
  expect(remainingRetiredItems.length).toBeGreaterThan(0)
  expect(remainingRetiredItems.every((item) =>
    item.expiresAt === recoveryExpiresAt
  )).toBe(true)
  await expect(client.getSnapshot(workspaceId)).resolves.toMatchObject({
    identityProviders: expect.arrayContaining([
      expect.objectContaining({ providerId: 'ttl-race-15' }),
    ]),
  })
})

test('fails closed when a physical TTL appears on an active generation', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('active-ttl'))
  const activeItem = [...harness.items.values()].find((item) =>
    item.entryType === 'enterprise-identity-record'
  )!
  activeItem.expiresAt = Math.floor(now.getTime() / 1_000) + 60 * 60
  harness.items.set(enterpriseItemKey(activeItem), activeItem)

  await expect(client.getSnapshot(workspaceId)).rejects.toMatchObject({
    code: 'EnterpriseIdentityStateInvalid',
  })
})

test('stores large SCIM group memberships as one bounded resource projection', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const users = []
  for (let index = 0; index < 60; index += 1) {
    users.push(await client.upsertScimUser({
      workspaceId,
      identityProviderId: 'idp-1',
      externalId: `large-group-user-${index}`,
      userName: `large-group-user-${index}@example.com`,
      emails: [`large-group-user-${index}@example.com`],
      active: true,
      idempotencyKey: `large-group-user-${index}`,
    }))
  }
  const memberUserIds = users.map((user) => user.userId)
  const largeGroupInput = {
    workspaceId,
    identityProviderId: 'idp-1',
    externalId: 'large-group',
    displayName: 'Large group',
    active: true,
    memberUserIds,
    idempotencyKey: 'large-group-create',
  }

  const groupBatchStart = harness.batchWrites.length
  await client.upsertScimGroup(largeGroupInput)
  expect(harness.batchWrites.length - groupBatchStart).toBe(1)
  const afterLargeGroup = await client.getSnapshot(workspaceId)
  expect(afterLargeGroup.scimGroups[0]?.memberUserIds).toHaveLength(60)
  expect(afterLargeGroup.scimUsers.every((user) =>
    user.groupIds.length === 0
  )).toBe(true)
  const directGroupProjection = [...harness.items.values()].find((item) =>
    item.entryType === 'enterprise-scim-resource' &&
    item.resourceKind === 'group'
  )
  const directGroupResource = directGroupProjection?.resource as
    | { memberUserIds?: string[] }
    | undefined
  expect(directGroupResource?.memberUserIds).toHaveLength(60)

  await Promise.all([
    client.upsertScimGroup({
      ...largeGroupInput,
      externalId: 'concurrent-group-a',
      displayName: 'Concurrent group A',
      idempotencyKey: 'concurrent-group-a',
    }),
    client.upsertScimGroup({
      ...largeGroupInput,
      externalId: 'concurrent-group-b',
      displayName: 'Concurrent group B',
      idempotencyKey: 'concurrent-group-b',
    }),
  ])
  const afterConflictRetry = await client.getSnapshot(workspaceId)
  expect(afterConflictRetry.scimGroups).toHaveLength(3)
  expect(afterConflictRetry.scimUsers.every((user) => user.groupIds.length === 0)).toBe(true)
  expect(harness.transactions.every((transaction) =>
    (transaction.TransactItems as Array<Record<string, unknown>>).length <= 100
  )).toBe(true)
})

test('persists and retries a 102-change provisioning run without oversized root records', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  for (let index = 0; index < 51; index += 1) {
    await client.upsertScimUser({
      workspaceId,
      identityProviderId: 'idp-1',
      externalId: `deprovision-all-${index}`,
      userName: `deprovision-all-${index}@example.com`,
      emails: [`deprovision-all-${index}@example.com`],
      linkedMemberKey: `deprovision-all-${index}@example.com`,
      active: false,
      idempotencyKey: `deprovision-all-${index}`,
    })
  }

  const previewBatchStart = harness.batchWrites.length
  const preview = await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'full-deprovision-preview',
  })
  expect(preview.changes.filter((change) => change.action === 'deactivate')).toHaveLength(51)
  expect(preview.changes.filter((change) => change.action === 'revoke')).toHaveLength(51)
  expect(harness.batchWrites.length - previewBatchStart).toBeGreaterThan(4)
  const storedPreview = await client.getProvisioningPreview(workspaceId, preview.previewId)
  expect(storedPreview?.changes.map((change) => change.changeId).sort()).toEqual(
    preview.changes.map((change) => change.changeId).sort(),
  )
  expect(harness.transactions.at(-1)?.TransactItems).toHaveLength(1)

  const run = await client.reconcileProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'full-deprovision-run',
    previewFingerprint: preview.fingerprint,
  })
  expect(run.changes).toHaveLength(102)
  const restoredRun = (await client.getSnapshot(workspaceId)).provisioningRuns.find(
    (candidate) => candidate.runId === run.runId,
  )
  expect(restoredRun?.changes.map((change) => change.changeId).sort()).toEqual(
    run.changes.map((change) => change.changeId).sort(),
  )

  const storedRunRoots = [...harness.items.values()].filter((item) =>
    item.entryType === 'enterprise-identity-record' &&
    item.recordType === 'PROVISIONING_RUN' &&
    (item.payload as { runId?: string }).runId === run.runId
  )
  expect(storedRunRoots.length).toBeGreaterThan(0)
  expect(storedRunRoots.every((item) =>
    Array.isArray((item.payload as { changes?: unknown }).changes) &&
    (item.payload as { changes: unknown[] }).changes.length === 0
  )).toBe(true)
  expect([...harness.items.values()].filter((item) =>
    item.entryType === 'enterprise-identity-record' &&
    item.recordType === 'PROVISIONING_RUN_CHANGE' &&
    (item.payload as { runId?: string }).runId === run.runId
  )).toHaveLength(102)

  await client.finalizeProvisioningRun(
    workspaceId,
    run.runId,
    'failed',
    'InjectedProvisioningFailure',
  )
  const retried = await client.retryProvisioning(workspaceId, run.runId)
  expect(retried).toMatchObject({ status: 'running', attempt: 2 })
  expect(retried.changes.map((change) => change.changeId).sort()).toEqual(
    run.changes.map((change) => change.changeId).sort(),
  )
  expect((await client.getSnapshot(workspaceId)).provisioningRuns.find(
    (candidate) => candidate.runId === run.runId,
  )?.changes).toHaveLength(102)
})

test('appends an immutable audit event for an administrator provisioning preview', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    'audit-events',
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const auditContext = createMutationAuditContext({
    workspaceId,
    actor: { id: 'administrator-1', kind: 'user' },
    idempotencyKey: 'preview-audit-request',
    request: {
      method: 'POST',
      path: '/api/enterprise/security/provisioning/preview',
      body: {},
    },
    source: { kind: 'api' },
    occurredAt: now.toISOString(),
  })
  const preview = await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'preview-audit-request',
  }, auditContext)
  const transactItems = harness.transactions.at(-1)?.TransactItems as Array<
    Record<string, unknown>
  >
  const auditPut = transactItems.find((item) =>
    (item.Put as { TableName?: string } | undefined)?.TableName === 'audit-events'
  )?.Put as { Item?: Record<string, unknown> } | undefined

  expect(auditPut?.Item).toMatchObject({
    workspaceId,
    eventType: 'provisioning.previewed',
    entityId: preview.previewId,
    actor: {
      id: 'administrator-1',
      kind: 'user',
    },
  })
})

test('uses canonical payload hashes across DynamoDB map key reordering', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const providerItem = [...harness.items.values()].find((item) =>
    item.recordType === 'PROVIDER'
  )
  expect(providerItem).toBeDefined()
  const payload = providerItem?.payload as Record<string, unknown>
  providerItem!.payload = Object.fromEntries(Object.entries(payload).reverse())
  harness.items.set(enterpriseItemKey(providerItem!), providerItem!)

  await expect(client.getSnapshot(workspaceId)).resolves.toMatchObject({
    identityProviders: [{ providerId: 'idp-1' }],
  })
})

test('logically expires preview generations without DynamoDB TTL deletion', async () => {
  let currentTime = now
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    undefined,
    () => currentTime,
  )
  const maintenance = new DynamoDbEnterpriseIdentityMaintenanceClient(
    'enterprise-identity',
    harness.documentClient as never,
    () => currentTime,
  )
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-1',
    externalId: 'expiring-preview-user',
    userName: 'preview@example.com',
    emails: ['preview@example.com'],
    active: true,
    idempotencyKey: 'expiring-preview-user',
  })
  await client.previewProvisioning({
    workspaceId,
    source: 'directory-reconciliation',
    idempotencyKey: 'expiring-preview',
  })
  const previewRoot = [...harness.items.values()].find((item) =>
    item.recordType === 'PROVISIONING_PREVIEW'
  )
  const previewChild = [...harness.items.values()].find((item) =>
    item.recordType === 'PROVISIONING_PREVIEW_CHANGE'
  )
  expect(previewRoot).toBeDefined()
  expect(previewChild).toBeDefined()
  expect(harness.transactions.every((transaction) =>
    (transaction.TransactItems as Array<Record<string, unknown>>).some((item) =>
      (item.Put as { Item?: { recordKey?: string } } | undefined)?.Item?.recordKey === 'CONTROL'
    )
  )).toBe(true)
  expect(previewRoot?.logicalExpiresAt).toBeDefined()
  expect(previewRoot?.expiresAt).toBeUndefined()
  expect(previewChild?.logicalExpiresAt).toBeDefined()
  expect(previewChild?.expiresAt).toBeUndefined()
  const previewId = (previewRoot?.payload as { previewId?: string } | undefined)
    ?.previewId
  expect(previewId).toBeDefined()
  for (let index = 0; index < 13; index += 1) {
    await client.putIdentityProvider(createActiveProvider(`preview-chain-${index}`))
  }
  currentTime = new Date(now.getTime() + 11 * 60_000)

  await expect(maintenance.maintainWorkspace(workspaceId)).resolves.toEqual({
    status: 'compacted',
  })
  await expect(client.getSnapshot(workspaceId)).resolves.toMatchObject({
    scimUsers: [{ userName: 'preview@example.com' }],
  })
  await expect(client.getProvisioningPreview(
    workspaceId,
    String(previewId),
  )).resolves.toBeUndefined()
  const control = harness.items.get(enterpriseItemKey({
    scopeKey: `WORKSPACE#${workspaceId}`,
    recordKey: 'CONTROL',
  }))!
  const activeScopeKey =
    `WORKSPACE_STATE#${workspaceId}#${String(control.activeStateGeneration)}`
  expect([...harness.items.values()].filter((item) =>
    item.scopeKey === activeScopeKey &&
    (
      item.recordType === 'PROVISIONING_PREVIEW' ||
      item.recordType === 'PROVISIONING_PREVIEW_CHANGE'
    )
  )).toEqual([])
})

test('uses an opaque SCIM entity ID in immutable audit records', async () => {
  const harness = createDynamoHarness()
  const client = new DynamoDbEnterpriseIdentityClient(
    'enterprise-identity',
    tokenSecret,
    harness.documentClient as never,
    'audit-events',
    () => now,
  )
  await client.putIdentityProvider(createActiveProvider('idp-1'))
  const externalId = 'private-employee-id@example.com'
  const user = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-1',
    externalId,
    userName: 'private-user@example.com',
    emails: ['private-user@example.com'],
    active: true,
    idempotencyKey: 'private-user-create',
  }, createMutationAuditContext({
    workspaceId,
    actor: { id: 'scim-idp-1', kind: 'service' },
    idempotencyKey: 'private-user-create',
    request: {
      method: 'POST',
      path: '/scim/Users',
      body: { externalId },
    },
    source: { kind: 'api' },
    occurredAt: now.toISOString(),
  }))
  const transactItems = harness.transactions.at(-1)?.TransactItems as Array<
    Record<string, unknown>
  >
  const auditPut = transactItems.find((item) =>
    (item.Put as { TableName?: string } | undefined)?.TableName === 'audit-events'
  )?.Put as { Item?: Record<string, unknown> } | undefined

  expect(auditPut?.Item?.entityId).toBe(user.userId)
  expect(JSON.stringify(auditPut?.Item)).not.toContain(externalId)
})

test('isolates SCIM credentials and directory mappings by identity provider', async () => {
  const client = new InMemoryEnterpriseIdentityClient(tokenSecret, () => now)
  await client.putIdentityProvider(createActiveProvider('idp-a'))
  await client.putIdentityProvider(createActiveProvider('idp-b'))

  const credentialA = await client.issueScimToken(workspaceId, 'idp-a', 'Provider A')
  const credentialB = await client.issueScimToken(workspaceId, 'idp-b', 'Provider B')
  const rotatedA = await client.rotateScimToken(
    workspaceId,
    'idp-a',
    'Provider A rotated',
    1,
    'rotate-a',
    'rotate-a-fingerprint',
  )
  expect(await client.authenticateScimToken(workspaceId, credentialA.token)).toBeUndefined()
  expect(await client.authenticateScimToken(workspaceId, credentialB.token))
    .toMatchObject({ identityProviderId: 'idp-b' })
  expect(await client.authenticateScimToken(workspaceId, rotatedA.token))
    .toMatchObject({ identityProviderId: 'idp-a' })

  const userA = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-a',
    externalId: 'shared-user',
    userName: 'shared@example.com',
    emails: ['shared@example.com'],
    linkedMemberKey: 'provider-a@example.com',
    active: true,
    idempotencyKey: 'create-user',
  })
  const userB = await client.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-b',
    externalId: 'shared-user',
    userName: 'shared@example.com',
    emails: ['shared@example.com'],
    linkedMemberKey: 'provider-b@example.com',
    active: true,
    idempotencyKey: 'create-user',
  })
  expect(userA.userId).not.toBe(userB.userId)

  const groupA = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-a',
    externalId: 'shared-group',
    displayName: 'Provider A group',
    active: true,
    memberUserIds: [userA.userId],
    idempotencyKey: 'create-group',
  })
  const groupB = await client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-b',
    externalId: 'shared-group',
    displayName: 'Provider B group',
    active: true,
    memberUserIds: [userB.userId],
    idempotencyKey: 'create-group',
  })
  expect(groupA.groupId).not.toBe(groupB.groupId)
  await expect(client.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-a',
    externalId: 'cross-provider-members',
    displayName: 'Invalid group',
    active: true,
    memberUserIds: [userB.userId],
    idempotencyKey: 'cross-provider-members',
  })).rejects.toMatchObject({ code: 'EnterpriseScimProviderMismatch' })

  await client.putGroupMapping({
    workspaceId,
    mappingId: 'mapping-a',
    identityProviderId: 'idp-a',
    directoryGroupId: 'shared-group',
    roleId: 'workspace:admin',
    scope: { workspaceId, kind: 'workspace' },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now.toISOString(),
  })
  const snapshot = await client.getSnapshot(workspaceId)
  const principalB = resolveEnterpriseDirectoryPrincipal(
    snapshot,
    'provider-b@example.com',
    [],
  )
  expect(principalB.compatibleGroupMappings).toEqual([])
  expect(evaluateEnterpriseAccess({
    permission: 'workspace.manage',
    principal: {
      kind: 'member',
      principalId: 'provider-b@example.com',
      directoryGroupIds: principalB.directoryGroupIds,
      directoryGroupMemberships: principalB.directoryGroupMemberships,
    },
    assignments: principalB.compatibleRoleAssignments,
    customRoles: snapshot.customRoles,
    groupMappings: snapshot.groupMappings,
    resource: { workspaceId, kind: 'workspace' },
  })).toMatchObject({ allowed: false })
})

test('fails closed when a stored provider does not match the Cognito provider name', () => {
  const provider = createActiveProvider('idp-1', 'ConfiguredProvider')
  expect(() =>
    assertEnterpriseCognitoProviderBinding(provider, 'DifferentProvider')
  ).toThrow()
  expect(() =>
    assertEnterpriseCognitoProviderBinding(provider, 'ConfiguredProvider')
  ).not.toThrow()
})

test('fails closed when the real Cognito provider drifts from stored authority', () => {
  const provider = createActiveProvider('idp-1', 'ConfiguredProvider')
  expect(() =>
    assertEnterpriseCognitoFederationBinding(
      provider,
      'ConfiguredProvider',
      {
        providerName: 'ConfiguredProvider',
        providerType: 'OIDC',
        providerDetails: {
          oidc_issuer: provider.issuer,
          client_id: provider.clientId,
        },
      },
    )
  ).not.toThrow()
  expect(() =>
    assertEnterpriseCognitoFederationBinding(
      provider,
      'ConfiguredProvider',
      {
        providerName: 'ConfiguredProvider',
        providerType: 'OIDC',
        providerDetails: {
          oidc_issuer: 'https://replacement.example.com',
          client_id: provider.clientId,
        },
      },
    )
  ).toThrow()

  const samlProvider = {
    workspaceId,
    providerId: 'saml-1',
    kind: 'saml',
    displayName: 'SAML',
    cognitoProviderName: 'ConfiguredSaml',
    status: 'active',
    revision: 1,
    entityId: 'https://saml.example.com/entity',
    singleSignOnUrl: 'https://saml.example.com/sso',
    metadataUrl: 'https://saml.example.com/metadata',
    certificateFingerprints: ['fingerprint'],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastTestedAt: now.toISOString(),
  } satisfies EnterpriseIdentityProvider
  expect(() =>
    assertEnterpriseCognitoFederationBinding(
      samlProvider,
      'ConfiguredSaml',
      {
        providerName: 'ConfiguredSaml',
        providerType: 'SAML',
        providerDetails: {},
      },
    )
  ).toThrow()
})

test('grants directory mappings only from applied state on a ready provider', () => {
  const provider = createActiveProvider('idp-1')
  const snapshot: EnterpriseIdentitySnapshot = {
    workspaceId,
    identityProviders: [provider],
    domains: [],
    customRoles: [],
    groupMappings: [{
      workspaceId,
      mappingId: 'mapping-1',
      identityProviderId: provider.providerId,
      directoryGroupId: 'directory-group-1',
      roleId: 'workspace:admin' as const,
      scope: { workspaceId, kind: 'workspace' as const },
      enabled: true,
      priority: 0,
      revision: 1,
      updatedAt: now.toISOString(),
    }],
    roleAssignments: [],
    scimUsers: [{
      workspaceId,
      userId: 'directory-user-1',
      externalId: 'external-user-1',
      identityProviderId: provider.providerId,
      userName: 'member@example.com',
      emails: ['member@example.com'],
      active: true,
      linkedMemberKey: 'member@example.com',
      groupIds: ['directory-group-1'],
      version: 1,
      appliedVersion: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }],
    scimGroups: [{
      workspaceId,
      groupId: 'directory-group-1',
      externalId: 'external-group-1',
      identityProviderId: provider.providerId,
      displayName: 'Directory readers',
      active: true,
      memberUserIds: ['directory-user-1'],
      version: 1,
      appliedVersion: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }],
    scimCredentials: [],
    serviceAccounts: [],
    breakGlassAccounts: [],
    provisioningRuns: [],
    provisioningLogs: [],
  }

  const pendingResolution = resolveEnterpriseDirectoryPrincipal(
    snapshot,
    'member@example.com',
    [],
  )
  expect(pendingResolution).toMatchObject({
    directoryManaged: true,
    deprovisioned: false,
    compatibleGroupMappings: [],
  })

  snapshot.scimUsers[0]!.appliedVersion = 1
  snapshot.scimGroups[0]!.appliedVersion = 1
  expect(
    resolveEnterpriseDirectoryPrincipal(snapshot, 'member@example.com', [])
      .compatibleGroupMappings,
  ).toHaveLength(1)

  snapshot.scimGroups[0]!.memberUserIds = []
  expect(
    resolveEnterpriseDirectoryPrincipal(snapshot, 'member@example.com', [])
      .compatibleGroupMappings,
  ).toEqual([])
  snapshot.scimGroups[0]!.memberUserIds = ['directory-user-1']

  snapshot.identityProviders[0] = { ...provider, status: 'draft', lastTestedAt: undefined }
  expect(resolveEnterpriseDirectoryPrincipal(snapshot, 'member@example.com', []))
    .toMatchObject({
      directoryManaged: true,
      deprovisioned: false,
      compatibleGroupMappings: [],
    })

  snapshot.identityProviders = []
  snapshot.scimUsers[0]!.active = false
  expect(resolveEnterpriseDirectoryPrincipal(snapshot, 'member@example.com', []))
    .toMatchObject({
      directoryManaged: true,
      deprovisioned: true,
      compatibleGroupMappings: [],
    })
  snapshot.scimUsers.push({
    ...snapshot.scimUsers[0]!,
    userId: 'directory-user-2',
    externalId: 'external-user-2',
    identityProviderId: 'idp-2',
    active: true,
  })
  expect(resolveEnterpriseDirectoryPrincipal(snapshot, 'member@example.com', []))
    .toMatchObject({
      directoryManaged: true,
      deprovisioned: false,
      compatibleGroupMappings: [],
    })
})

test('keeps pending inactive SCIM desired state provisioned until it is applied', () => {
  const provider = createActiveProvider('idp-1')
  const snapshot: EnterpriseIdentitySnapshot = {
    workspaceId,
    identityProviders: [provider],
    domains: [],
    customRoles: [],
    groupMappings: [],
    roleAssignments: [],
    scimUsers: [{
      workspaceId,
      userId: 'directory-user-1',
      externalId: 'external-user-1',
      identityProviderId: provider.providerId,
      userName: 'member@example.com',
      emails: ['member@example.com'],
      active: false,
      linkedMemberKey: 'member@example.com',
      groupIds: [],
      version: 2,
      appliedVersion: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }],
    scimGroups: [],
    scimCredentials: [],
    serviceAccounts: [],
    breakGlassAccounts: [],
    provisioningRuns: [],
    provisioningLogs: [],
  }

  expect(resolveEnterpriseDirectoryPrincipal(snapshot, 'member@example.com', []))
    .toMatchObject({
      directoryManaged: true,
      deprovisioned: false,
    })

  snapshot.scimUsers[0]!.appliedVersion = 2
  expect(resolveEnterpriseDirectoryPrincipal(snapshot, 'member@example.com', []))
    .toMatchObject({
      directoryManaged: true,
      deprovisioned: true,
    })
})
