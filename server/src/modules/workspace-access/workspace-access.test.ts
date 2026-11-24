import { expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  WORKSPACE_AUDIT_PSEUDONYM_KEY_ENV,
  createMutationAuditContext,
  createWorkspaceInvitationAuditEntityId,
  createWorkspaceMemberAuditEntityId,
} from '../audit/audit'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../documents/adapter-out/dynamodb/document-authorization'
import {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  createWorkspaceMemberVersionConditionCheck,
  isWorkspaceIdentitySafeToDelete,
  type WorkspaceMember,
  type WorkspaceMembershipGuard,
  type WorkspaceMembershipMutationInput,
} from './workspace-access'

const workspaceId = 'user#demo@example.com'
const now = new Date('2026-07-11T00:00:00.000Z')
const workspaceAuditPseudonymKey =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env[WORKSPACE_AUDIT_PSEUDONYM_KEY_ENV] = workspaceAuditPseudonymKey

function createAuditContext(idempotencyKey: string, contextWorkspaceId = workspaceId) {
  return createMutationAuditContext({
    workspaceId: contextWorkspaceId,
    actor: { id: 'sub-demo', kind: 'user', displayName: 'demo@example.com' },
    idempotencyKey,
    correlationId: `correlation-${idempotencyKey}`,
    occurredAt: now.toISOString(),
    request: {
      method: 'POST',
      path: '/api/workspace/test-mutation',
      body: { idempotencyKey },
    },
    source: { kind: 'api', requestId: `request-${idempotencyKey}` },
  })
}

function createWorkspaceMember(
  memberKey: string,
  role: WorkspaceMember['role'] = 'owner',
  status: WorkspaceMember['status'] = 'active',
  version = 1,
): WorkspaceMember {
  return {
    id: memberKey,
    memberKey,
    email: memberKey,
    name: memberKey === 'demo@example.com' ? 'Demo User' : undefined,
    role,
    status,
    version,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

function toMemberItem(member: WorkspaceMember) {
  return {
    ...member,
    workspaceId,
    recordKey: `MEMBER#${member.memberKey}`,
    entryType: 'workspace-member',
  }
}

function createInvitationItem(
  status: 'provisioning' | 'pending' | 'delivery-failed' | 'revoked' | 'accepted' = 'pending',
  expiresAt = '2026-07-18T00:00:00.000Z',
) {
  return {
    workspaceId,
    recordKey: 'INVITATION#sato@example.com',
    entryType: 'workspace-invitation',
    id: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    role: 'member',
    status,
    deliveryStatus: status === 'delivery-failed' ? 'failed' : 'sent',
    identityOwnership: 'workspace-created',
    identityLifecycleVersion: 2,
    cognitoIdentityId: 'sub-sato',
    cognitoUsername: 'sato@example.com',
    version: 1,
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    invitedBy: 'demo@example.com',
  }
}

function createDocumentClient(
  handler: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown,
) {
  return {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      return handler(command)
    },
  } as unknown as DynamoDBDocumentClient
}

/**
 * Creates a Workspace Access adapter with the Documents revision port injected.
 *
 * @param tableName - Workspace Access table name.
 * @param documentClient - DynamoDB document client used by the adapter.
 * @param dynamoDbClient - Optional low-level DynamoDB client.
 * @param bootstrapLocalTable - Whether local tables should be bootstrapped.
 * @param clock - Optional test clock.
 * @param planningTableName - Optional Planning table name.
 * @param auditTableName - Optional Audit table name.
 * @param auditPseudonymKey - Optional audit pseudonym key.
 * @param documentsTableName - Optional Documents table name.
 * @param membershipGuard - Optional tenant lifecycle transaction contributor.
 * @returns Configured Workspace Access adapter.
 */
function createWorkspaceAccessClientWithDocumentAuthorization(
  tableName: string,
  documentClient: DynamoDBDocumentClient,
  dynamoDbClient?: DynamoDBClient,
  bootstrapLocalTable?: boolean,
  clock?: () => Date,
  planningTableName?: string,
  auditTableName?: string | null,
  auditPseudonymKey?: string,
  documentsTableName?: string,
  membershipGuard?: WorkspaceMembershipGuard,
): DynamoDbWorkspaceAccessClient {
  return new DynamoDbWorkspaceAccessClient(
    tableName,
    documentClient,
    dynamoDbClient,
    bootstrapLocalTable,
    clock,
    planningTableName,
    auditTableName,
    auditPseudonymKey,
    new DynamoDbDocumentAuthorizationRevisionMutationAdapter(
      documentsTableName,
    ),
    membershipGuard,
  )
}

function createConditionalTransactionError(transactionLength: number, failedIndex: number) {
  const error = new Error('conditional transaction canceled')
  error.name = 'TransactionCanceledException'
  Object.assign(error, {
    CancellationReasons: Array.from({ length: transactionLength }, (_, index) => ({
      Code: index === failedIndex ? 'ConditionalCheckFailed' : 'None',
    })),
  })
  return error
}

function createTransactionCancellationError(reasonCodes: string[]) {
  const error = new Error('transaction canceled')
  error.name = 'TransactionCanceledException'
  Object.assign(error, {
    CancellationReasons: reasonCodes.map((Code) => ({ Code })),
  })
  return error
}

function createInvitationLifecycleClient(
  status: 'pending' | 'delivery-failed' | 'revoked',
  inputs: Array<Record<string, unknown>>,
) {
  return new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return key.recordKey?.startsWith('MEMBER#')
          ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
          : { Item: createInvitationItem(status) }
      }

      return {}
    }),
    undefined,
    false,
    () => now,
  )
}

test('builds an active member admission guard bound to the persisted version', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const member = createWorkspaceMember('owner@example.com', 'member', 'active', 7)
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return { Item: toMemberItem(member) }
    }),
  )

  await expect(client.createActiveMemberConditionCheck(
    workspaceId,
    'Owner@Example.com',
  )).resolves.toEqual({
    ConditionCheck: {
      TableName: 'WorkspaceAccessTable',
      Key: {
        workspaceId,
        recordKey: 'MEMBER#owner@example.com',
      },
      ConditionExpression:
        '#entryType = :entryType AND #memberKey = :memberKey AND #status = :active AND #version = :version',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#memberKey': 'memberKey',
        '#status': 'status',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':entryType': 'workspace-member',
        ':memberKey': 'owner@example.com',
        ':version': 7,
      },
    },
  })
  expect(inputs).toEqual([expect.objectContaining({
    ConsistentRead: true,
    Key: {
      workspaceId,
      recordKey: 'MEMBER#owner@example.com',
    },
  })])
})

test('binds allowed Workspace roles to the active member guard', async () => {
  const member = createWorkspaceMember('owner@example.com', 'member', 'active', 7)
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient(() => ({ Item: toMemberItem(member) })),
  )

  await expect(client.createActiveMemberConditionCheck(
    workspaceId,
    'owner@example.com',
    { allowedRoles: ['owner', 'admin', 'member'] },
  )).resolves.toMatchObject({
    ConditionCheck: {
      ConditionExpression:
        '#entryType = :entryType AND #memberKey = :memberKey AND #status = :active AND #version = :version AND #role IN (:allowedRole0, :allowedRole1, :allowedRole2)',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: {
        ':allowedRole0': 'owner',
        ':allowedRole1': 'admin',
        ':allowedRole2': 'member',
      },
    },
  })
})

test('rejects a guest member when a non-guest role guard is requested', async () => {
  const member = createWorkspaceMember('guest@example.com', 'guest', 'active', 3)
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient(() => ({ Item: toMemberItem(member) })),
  )

  await expect(client.createActiveMemberConditionCheck(
    workspaceId,
    'guest@example.com',
    { allowedRoles: ['owner', 'admin', 'member'] },
  )).resolves.toBeUndefined()
})

test('creates a seven-day invitation reservation before Cognito provisioning', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {}
    }),
    undefined,
    false,
    () => now,
  )

  const invitation = await client.createInvitation(workspaceId, 'demo@example.com', {
    email: 'SATO@example.com',
    name: '佐藤 花子',
    role: 'member',
  })

  expect(invitation).toMatchObject({
    id: 'sato@example.com',
    status: 'provisioning',
    deliveryStatus: 'pending',
    identityOwnership: 'ambiguous',
    version: 1,
    expiresAt: '2026-07-18T00:00:00.000Z',
  })
  expect(inputs[1]).toMatchObject({
    TransactItems: [
      {},
      {},
      {
        Put: {
          TableName: 'WorkspaceAccessTable',
          ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          Item: {
            workspaceId,
            recordKey: 'INVITATION#sato@example.com',
          },
        },
      },
    ],
  })
})

test('maps an overdue pending invitation to expired without mutating it', async () => {
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient(() => ({
      Item: createInvitationItem('pending', '2026-07-10T00:00:00.000Z'),
    })),
    undefined,
    false,
    () => now,
  )

  await expect(client.getInvitation(workspaceId, 'sato@example.com')).resolves.toMatchObject({
    status: 'expired',
    deliveryStatus: 'sent',
  })
})

test('acquires and releases an invitation acceptance lock with version checks and no audit event', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const commandNames: string[] = []
  let invitationItem = createInvitationItem('pending')
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      commandNames.push(command.constructor.name)

      if (command.constructor.name === 'GetCommand') {
        return { Item: invitationItem }
      }

      const item = command.input.Item as typeof invitationItem | undefined

      if (item) {
        invitationItem = item
      }

      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    // The audit table is configured as in production; the unauthenticated lock must still not audit.
    'AuditTable',
  )

  const locked = await client.acquireInvitationAcceptanceLock(workspaceId, 'sato@example.com')
  expect(locked).toMatchObject({
    acceptanceLockExpiresAt: '2026-07-11T00:05:00.000Z',
    status: 'pending',
    version: 2,
  })
  expect(inputs.at(-1)).toMatchObject({
    ConditionExpression: 'version = :expectedVersion AND #status IN (:status0, :status1, :status2)',
    Item: { acceptanceLockExpiresAt: '2026-07-11T00:05:00.000Z', version: 2 },
  })

  const released = await client.releaseInvitationAcceptanceLock(
    workspaceId,
    'sato@example.com',
    2,
  )
  expect(released.acceptanceLockExpiresAt).toBeUndefined()
  expect(released.version).toBe(3)
  const releasedItem = inputs.at(-1)?.Item as Record<string, unknown> | undefined
  expect(releasedItem?.acceptanceLockExpiresAt).toBeUndefined()
  expect(commandNames).toEqual(['GetCommand', 'PutCommand', 'GetCommand', 'PutCommand'])
  expect(inputs.some((input) => 'TransactItems' in input)).toBe(false)
})

test('records delivery failure while preserving ambiguous identity ownership', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name === 'GetCommand') {
        return {
          Item: {
            ...createInvitationItem('provisioning'),
            identityOwnership: 'ambiguous',
            deliveryStatus: 'pending',
          },
        }
      }

      return {}
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.markInvitationDelivery(workspaceId, 'sato@example.com', {
    deliveryStatus: 'failed',
    identityOwnership: 'ambiguous',
    cognitoIdentityId: 'sub-sato',
    expectedVersion: 1,
    failureMessage: 'Email delivery failed.',
  })).resolves.toMatchObject({
    status: 'delivery-failed',
    deliveryStatus: 'failed',
    identityOwnership: 'ambiguous',
    cognitoIdentityId: 'sub-sato',
    failureMessage: 'Email delivery failed.',
    version: 2,
  })
  expect(inputs[1]).toMatchObject({
    ConditionExpression: 'version = :expectedVersion AND #status IN (:status0, :status1, :status2)',
    Item: {
      status: 'delivery-failed',
      identityOwnership: 'ambiguous',
      cognitoIdentityId: 'sub-sato',
    },
  })
})

test('drops cleanup provenance when delivery binds a replacement Cognito identity', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      return command.constructor.name === 'GetCommand'
        ? {
            Item: {
              ...createInvitationItem('provisioning'),
              identityOwnership: 'workspace-created',
              cognitoIdentityId: 'sub-original',
              directoryClaimCleanupRequired: true,
            },
          }
        : {}
    }),
    undefined,
    false,
    () => now,
  )

  const delivered = await client.markInvitationDelivery(
    workspaceId,
    'sato@example.com',
    {
      deliveryStatus: 'not-required',
      identityOwnership: 'pre-existing',
      cognitoIdentityId: 'sub-replacement',
      cognitoUsername: 'ReplacementIdentity',
      directoryClaimCleanupRequired: false,
      expectedVersion: 1,
    },
  )

  expect(delivered).toMatchObject({
    status: 'pending',
    identityOwnership: 'pre-existing',
    cognitoIdentityId: 'sub-replacement',
    cognitoUsername: 'ReplacementIdentity',
  })
  expect(delivered.directoryClaimCleanupRequired).toBeUndefined()
  const updatedItem = inputs.at(-1)?.Item as Record<string, unknown> | undefined
  expect(updatedItem).toMatchObject({
    identityOwnership: 'pre-existing',
    cognitoIdentityId: 'sub-replacement',
  })
  expect(updatedItem?.directoryClaimCleanupRequired).toBeUndefined()
})

test('records directory claim cleanup responsibility before Cognito mutation', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? {
            Item: {
              ...createInvitationItem('provisioning'),
              identityOwnership: 'ambiguous',
              deliveryStatus: 'pending',
            },
          }
        : {}
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.markInvitationDirectoryClaimCleanupRequired(
    workspaceId,
    'sato@example.com',
    1,
    'sub-sato',
    'CaseSensitiveSato',
  )).resolves.toMatchObject({
    cognitoIdentityId: 'sub-sato',
    cognitoUsername: 'CaseSensitiveSato',
    directoryClaimCleanupRequired: true,
    status: 'provisioning',
    version: 2,
  })
  expect(inputs.at(-1)).toMatchObject({
    ConditionExpression: 'version = :expectedVersion AND #status IN (:status0)',
    Item: {
      directoryClaimCleanupRequired: true,
      cognitoIdentityId: 'sub-sato',
      cognitoUsername: 'CaseSensitiveSato',
      status: 'provisioning',
      version: 2,
    },
  })
})

test('downgrades ownership before adding claims to a replacement Cognito identity', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? {
            Item: {
              ...createInvitationItem('provisioning'),
              identityOwnership: 'workspace-created',
              cognitoIdentityId: 'sub-original',
              cognitoUsername: 'OriginalIdentity',
            },
          }
        : {}
    }),
    undefined,
    false,
    () => now,
  )

  const marked = await client.markInvitationDirectoryClaimCleanupRequired(
    workspaceId,
    'sato@example.com',
    1,
    'sub-replacement',
    'ReplacementIdentity',
  )

  expect(marked).toMatchObject({
    identityOwnership: 'ambiguous',
    cognitoIdentityId: 'sub-replacement',
    cognitoUsername: 'ReplacementIdentity',
    directoryClaimCleanupRequired: true,
  })
  expect(inputs.at(-1)).toMatchObject({
    Item: {
      identityOwnership: 'ambiguous',
      cognitoIdentityId: 'sub-replacement',
      cognitoUsername: 'ReplacementIdentity',
      directoryClaimCleanupRequired: true,
    },
  })
})

test('rejects a stale directory claim marker after invitation state changes', async () => {
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient(() => ({
      Item: {
        ...createInvitationItem('revoked'),
        directoryClaimCleanupRequired: true,
        version: 2,
      },
    })),
    undefined,
    false,
    () => now,
  )

  await expect(client.markInvitationDirectoryClaimCleanupRequired(
    workspaceId,
    'sato@example.com',
    1,
    'sub-sato',
    'CaseSensitiveSato',
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceVersionConflict',
  })
})

test('treats invitation-owned directory claims as retryable revoke cleanup', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('pending'),
              identityOwnership: 'pre-existing',
              directoryClaimCleanupRequired: true,
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.revokeInvitation(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).resolves.toMatchObject({
    directoryClaimCleanupRequired: true,
    failureMessage: 'Cognito cleanup is pending and can be retried safely.',
    identityOwnership: 'pre-existing',
    status: 'revoked',
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      {},
      {
        Put: {
          Item: {
            directoryClaimCleanupRequired: true,
            failureMessage: 'Cognito cleanup is pending and can be retried safely.',
          },
        },
      },
    ],
  })
})

test('prepares a failed invitation for resend with an actor/version transaction', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = createInvitationLifecycleClient('delivery-failed', inputs)

  await expect(client.prepareResend(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).resolves.toMatchObject({
    status: 'provisioning',
    deliveryStatus: 'pending',
    identityOwnership: 'workspace-created',
    expiresAt: '2026-07-18T00:00:00.000Z',
    version: 2,
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      { ConditionCheck: { ConditionExpression: '#status = :active AND #role = :role AND version = :version' } },
      { Put: { ConditionExpression: 'version = :expectedVersion' } },
    ],
  })
})

test('rejects resend while Cognito provisioning is still in progress', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : { Item: createInvitationItem('provisioning') }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.prepareResend(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceInvitationNotResendable',
  })
  expect(inputs).toHaveLength(2)
})

test('revokes an invitation with an actor/version transaction', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = createInvitationLifecycleClient('pending', inputs)

  await expect(client.revokeInvitation(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).resolves.toMatchObject({
    status: 'revoked',
    deliveryStatus: 'not-required',
    failureMessage: 'Cognito cleanup is pending and can be retried safely.',
    version: 2,
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      { ConditionCheck: { ConditionExpression: '#status = :active AND #role = :role AND version = :version' } },
      { Put: { Item: { status: 'revoked' }, ConditionExpression: 'version = :expectedVersion' } },
    ],
  })
})

test('migrates a legacy revoked invitation to explicit manual Cognito cleanup', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('revoked'),
              identityOwnership: 'pre-existing',
              identityLifecycleVersion: undefined,
              cognitoIdentityId: undefined,
              cognitoUsername: undefined,
              failureMessage: undefined,
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  const invitation = await client.revokeInvitation(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )

  expect(invitation).toMatchObject({
    status: 'revoked',
    identityCleanupManualRequired: true,
    failureMessage:
      'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.',
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      {},
      {
        Put: {
          Item: {
            identityCleanupManualRequired: true,
            failureMessage:
              'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.',
          },
        },
      },
    ],
  })
})

test('persists Cognito cleanup failure on a revoked invitation', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: createInvitationItem('revoked') }
        : {}
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.markInvitationCleanupFailure(workspaceId, 'sato@example.com', {
    expectedVersion: 1,
    failureMessage: 'Cognito cleanup failed and can be retried safely.',
  })).resolves.toMatchObject({
    status: 'revoked',
    failureMessage: 'Cognito cleanup failed and can be retried safely.',
    version: 2,
  })
  expect(inputs.at(-1)).toMatchObject({
    ConditionExpression: 'version = :expectedVersion AND #status IN (:status0)',
    Item: {
      status: 'revoked',
      failureMessage: 'Cognito cleanup failed and can be retried safely.',
    },
  })
})

test('clears the retry marker and claim responsibility only after Cognito cleanup succeeds', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? {
            Item: {
              ...createInvitationItem('revoked'),
              identityOwnership: 'pre-existing',
              directoryClaimCleanupRequired: true,
              failureMessage: 'Cognito cleanup failed and can be retried safely.',
            },
          }
        : {}
    }),
    undefined,
    false,
    () => now,
  )

  const invitation = await client.clearInvitationCleanupFailure(
    workspaceId,
    'sato@example.com',
    1,
  )

  expect(invitation).toMatchObject({ status: 'revoked', version: 2 })
  expect(invitation.failureMessage).toBeUndefined()
  expect(invitation.directoryClaimCleanupRequired).toBeUndefined()
  expect(invitation.identityCleanupCompleted).toBe(true)
  expect(inputs.at(-1)).toMatchObject({
    ConditionExpression: 'version = :expectedVersion AND #status IN (:status0)',
    Item: { status: 'revoked' },
  })
  const clearedItem = inputs.at(-1)?.Item as Record<string, unknown> | undefined
  expect(clearedItem?.failureMessage).toBeUndefined()
  expect(clearedItem?.directoryClaimCleanupRequired).toBeUndefined()
  expect(clearedItem?.identityCleanupCompleted).toBe(true)
})

test('records explicit completion after an administrator verifies manual Cognito cleanup', async () => {
  const inputs: Array<Record<string, unknown>> = []
  let invitationItem = {
    ...createInvitationItem('revoked'),
    directoryClaimCleanupRequired: true,
    identityCleanupManualRequired: true,
    identityMutationAttempted: true,
    failureMessage:
      'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.',
  }
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return key.recordKey?.startsWith('MEMBER#')
          ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
          : { Item: invitationItem }
      }

      const transaction = command.input.TransactItems as Array<{
        Put?: { Item?: typeof invitationItem }
      }> | undefined
      const updatedItem = transaction?.at(-1)?.Put?.Item

      if (updatedItem) {
        invitationItem = updatedItem
      }

      return {}
    }),
    undefined,
    false,
    () => now,
  )

  const acknowledged = await client.acknowledgeInvitationManualCleanup(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    1,
  )

  expect(acknowledged).toMatchObject({
    status: 'revoked',
    identityCleanupCompleted: true,
    version: 2,
  })
  expect(acknowledged.identityCleanupManualRequired).toBeUndefined()
  expect(acknowledged.directoryClaimCleanupRequired).toBeUndefined()
  expect(acknowledged.identityMutationAttempted).toBeUndefined()
  expect(acknowledged.failureMessage).toBeUndefined()
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      { ConditionCheck: {} },
      { Put: { Item: { identityCleanupCompleted: true, version: 2 } } },
    ],
  })

  await expect(client.prepareReinvite(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).resolves.toMatchObject({ status: 'provisioning', version: 3 })
})

test('rejects stale or unauthorized manual Cognito cleanup acknowledgements', async () => {
  const createClient = (actorRole: WorkspaceMember['role']) => new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('admin@example.com', actorRole)) }
        : {
            Item: {
              ...createInvitationItem('revoked'),
              role: 'owner',
              identityCleanupManualRequired: true,
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(createClient('owner').acknowledgeInvitationManualCleanup(
    workspaceId,
    'admin@example.com',
    'sato@example.com',
    99,
  )).rejects.toMatchObject({ code: 'WorkspaceVersionConflict', status: 409 })
  await expect(createClient('admin').acknowledgeInvitationManualCleanup(
    workspaceId,
    'admin@example.com',
    'sato@example.com',
    1,
  )).rejects.toMatchObject({ code: 'WorkspaceRoleDenied', status: 403 })
})

test('blocks reinvite until Workspace-owned Cognito cleanup completes', async () => {
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('revoked'),
              failureMessage: 'Cognito cleanup is pending and can be retried safely.',
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.prepareReinvite(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceInvitationCleanupPending',
  })
})

test('prepares a revoked invitation for reinvite with a fresh expiry', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = createInvitationLifecycleClient('revoked', inputs)

  await expect(client.prepareReinvite(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).resolves.toMatchObject({
    status: 'provisioning',
    deliveryStatus: 'pending',
    identityOwnership: 'ambiguous',
    expiresAt: '2026-07-18T00:00:00.000Z',
    version: 2,
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      { ConditionCheck: { ConditionExpression: '#status = :active AND #role = :role AND version = :version' } },
      {
        Put: {
          Item: { status: 'provisioning', identityOwnership: 'ambiguous' },
          ConditionExpression: 'version = :expectedVersion',
        },
      },
    ],
  })
})

test('rejects reinvite while an expired invitation still has an active acceptance lock', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('pending', '2026-07-10T00:00:00.000Z'),
              acceptanceLockExpiresAt: '2026-07-11T00:05:00.000Z',
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.prepareReinvite(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceInvitationAcceptanceInProgress',
  })
  expect(inputs).toHaveLength(2)
})

test('preserves cleanup provenance when reinviting an expired invitation', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('pending', '2026-07-10T00:00:00.000Z'),
              identityOwnership: 'pre-existing',
              directoryClaimCleanupRequired: true,
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.prepareReinvite(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).resolves.toMatchObject({
    status: 'provisioning',
    identityOwnership: 'pre-existing',
    directoryClaimCleanupRequired: true,
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      {},
      {
        Put: {
          Item: {
            status: 'provisioning',
            identityOwnership: 'pre-existing',
            directoryClaimCleanupRequired: true,
          },
        },
      },
    ],
  })
})

test('does not rerun cleanup for an already completed revoked invitation', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('revoked'),
              identityCleanupCompleted: true,
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.revokeInvitation(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).resolves.toMatchObject({
    status: 'revoked',
    identityCleanupCompleted: true,
    version: 1,
  })
  expect(inputs).toHaveLength(2)
})

test('does not rewrite an unchanged revoked invitation when cleanup is retried', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const failureMessage = 'Cognito cleanup is pending and can be retried safely.'
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('revoked'),
              failureMessage,
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.revokeInvitation(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    createAuditContext('retry-revoke'),
  )).resolves.toMatchObject({
    status: 'revoked',
    failureMessage,
    version: 1,
  })
  expect(inputs).toHaveLength(2)
})

test('rejects revoke while Cognito provisioning is still in progress', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : { Item: createInvitationItem('provisioning') }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.revokeInvitation(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceInvitationProvisioning',
  })
  expect(inputs).toHaveLength(2)
})

test('recovers a stale provisioning invitation into manual cleanup', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('provisioning'),
              cognitoIdentityId: undefined,
              cognitoUsername: undefined,
              identityMutationAttempted: true,
              updatedAt: '2026-07-10T23:50:00.000Z',
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.revokeInvitation(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).resolves.toMatchObject({
    status: 'revoked',
    identityCleanupManualRequired: true,
    failureMessage:
      'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.',
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      {},
      { Put: { Item: { status: 'revoked', identityCleanupManualRequired: true } } },
    ],
  })
})

test('rejects revoke while password challenge acceptance is locked', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)

      if (command.constructor.name !== 'GetCommand') {
        return {}
      }

      const key = command.input.Key as { recordKey?: string }
      return key.recordKey?.startsWith('MEMBER#')
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {
            Item: {
              ...createInvitationItem('pending'),
              acceptanceLockExpiresAt: '2026-07-11T00:01:00.000Z',
            },
          }
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.revokeInvitation(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceInvitationAcceptanceInProgress',
  })
  expect(inputs).toHaveLength(2)
})

test('prevents an admin from inviting another admin or owner', async () => {
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient(() => ({
      Item: toMemberItem(createWorkspaceMember('admin@example.com', 'admin')),
    })),
  )

  await expect(client.createInvitation(workspaceId, 'admin@example.com', {
    email: 'next-admin@example.com',
    role: 'admin',
  })).rejects.toMatchObject({
    status: 403,
    code: 'WorkspaceRoleDenied',
  })
})

test('prevents a member from deactivating their own membership', async () => {
  const owner = createWorkspaceMember('demo@example.com')
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient(() => ({ Item: toMemberItem(owner) })),
  )

  await expect(client.updateMember(workspaceId, owner.memberKey, owner.memberKey, {
    status: 'deactivated',
    expectedVersion: owner.version,
    expectedPlanningRevision: 0,
  })).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceSelfDeactivation',
  })
})

test('protects the last active owner with metadata and member conditions in one transaction', async () => {
  const owner = createWorkspaceMember('demo@example.com')
  const secondOwner = createWorkspaceMember('second-owner@example.com')
  const transactionInputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('second-owner') ? secondOwner : owner) }
      }

      transactionInputs.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
  )

  await client.updateMember(workspaceId, secondOwner.memberKey, owner.memberKey, {
    role: 'admin',
    expectedVersion: 1,
    expectedPlanningRevision: 0,
  })

  expect(transactionInputs[0]).toMatchObject({
    TransactItems: [
      {},
      {
        Update: {
          ConditionExpression: 'attribute_exists(workspaceId) AND version = :expectedVersion',
        },
      },
      {
        Update: {
          Key: { workspaceId, recordKey: 'WORKSPACE' },
          ConditionExpression: 'attribute_exists(workspaceId) AND activeOwnerCount > :one',
          ExpressionAttributeValues: {
            ':delta': -1,
          },
        },
      },
      {
        Put: {
          TableName: 'mukuroji-planning-local',
          Item: {
            workspaceId: `FENCE#${workspaceId}`,
            recordKey: 'META',
            revision: 1,
          },
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        },
      },
    ],
  })
})

test('serializes member deactivation with the Planning graph revision', async () => {
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('member@example.com', 'member')
  const transactionInputs: Array<Record<string, unknown>> = []
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('member@example.com') ? target : actor) }
      }
      transactionInputs.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )

  await client.updateMember(workspaceId, actor.memberKey, target.memberKey, {
    status: 'deactivated',
    expectedVersion: target.version,
    expectedPlanningRevision: 7,
    expectedDocumentAuthorizationRevision: 3,
  })

  expect(transactionInputs[0]).toMatchObject({
    TransactItems: [
      {},
      {},
      {
        Put: {
          TableName: 'PlanningTable',
          Item: {
            workspaceId: `FENCE#${workspaceId}`,
            recordKey: 'META',
            entryType: 'planning-meta',
            schemaVersion: 1,
            revision: 8,
          },
          ConditionExpression: '#revision = :expectedPlanningRevision',
          ExpressionAttributeValues: { ':expectedPlanningRevision': 7 },
        },
      },
      {
        Put: {
          TableName: 'mukuroji-documents-local',
          Item: {
            workspaceId,
            recordKey:
              'DOCUMENT_AUTHORIZATION_REVISION',
            revision: 4,
          },
          ConditionExpression:
            'revision = :expectedDocumentAuthorizationRevision',
        },
      },
    ],
  })
})

test.each(['deactivate', 'role', 'directory'])(
  'joins the lifecycle condition to the %s membership transaction', async (operation) => {
  const actor = createWorkspaceMember('demo@example.com')
  const target: WorkspaceMember = {
    ...createWorkspaceMember('member@example.com', 'member'),
    ...(operation === 'directory' ? {
      provisioningSource: 'directory',
      externalIdentityId: 'directory-member-1',
    } : {}),
  }
  const transactionInputs: Array<Record<string, unknown>> = []
  const membershipInputs: WorkspaceMembershipMutationInput[] = []
  const membershipGuard: WorkspaceMembershipGuard = {
    async prepareMembershipMutation(input) {
      membershipInputs.push(input)
      return [{
        ConditionCheck: {
          TableName: 'TenantAdministrationTable',
          Key: {
            workspaceId: input.workspaceId,
            recordKey: 'PROFILE',
          },
          ConditionExpression: 'lifecycleStatus = :active',
          ExpressionAttributeValues: { ':active': 'active' },
        },
      }]
    },
  }
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('member@example.com') ? target : actor) }
      }
      transactionInputs.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    undefined,
    undefined,
    'DocumentsTable',
    membershipGuard,
  )

  if (operation === 'directory') {
    await client.reconcileDirectoryMember(workspaceId, {
      memberKey: target.memberKey,
      email: target.email,
      name: 'Directory managed member',
      role: 'member',
      externalIdentityId: 'directory-member-1',
      expectedVersion: target.version,
      expectedPlanningRevision: 7,
    })
  } else {
    await client.updateMember(workspaceId, actor.memberKey, target.memberKey, {
      ...(operation === 'deactivate' ? { status: 'deactivated' } : { role: 'admin' }),
      expectedVersion: target.version,
      expectedPlanningRevision: 7,
      expectedDocumentAuthorizationRevision: 3,
    })
  }

  expect(membershipInputs).toEqual([{
    workspaceId,
    memberKey: target.memberKey,
    direction: operation === 'deactivate' ? 'deactivate' : 'activate',
    occurredAt: now.toISOString(),
  }])
  expect(transactionInputs[0]).toMatchObject({
    TransactItems: expect.arrayContaining([
      {
        ConditionCheck: {
          TableName: 'TenantAdministrationTable',
          Key: { workspaceId, recordKey: 'PROFILE' },
          ConditionExpression: 'lifecycleStatus = :active',
          ExpressionAttributeValues: { ':active': 'active' },
        },
      },
    ]),
  })
})

test('fails before writing when the Documents revision port is not configured', async () => {
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('member@example.com', 'member')
  const transactionInputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return {
          Item: toMemberItem(
            key.recordKey?.includes('member@example.com') ? target : actor,
          ),
        }
      }
      transactionInputs.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )

  await expect(
    client.updateMember(workspaceId, actor.memberKey, target.memberKey, {
      status: 'deactivated',
      expectedVersion: target.version,
      expectedPlanningRevision: 7,
      expectedDocumentAuthorizationRevision: 3,
    }),
  ).rejects.toMatchObject({
    status: 503,
    code: 'DocumentAuthorizationRevisionPortMissing',
  })
  expect(transactionInputs).toHaveLength(0)
})

test('increments the Document authorization generation when deactivating a guest', async () => {
  const actor = createWorkspaceMember(
    'demo@example.com',
  )
  const target = createWorkspaceMember(
    'guest@example.com',
    'guest',
  )
  const transactionInputs:
    Array<Record<string, unknown>> = []
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (
        command.constructor.name ===
        'GetCommand'
      ) {
        const key = command.input.Key as {
          recordKey?: string
        }
        return {
          Item: toMemberItem(
            key.recordKey?.includes(
                'guest@example.com',
              )
              ? target
              : actor,
          ),
        }
      }
      transactionInputs.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )

  await client.updateMember(
    workspaceId,
    actor.memberKey,
    target.memberKey,
    {
      status: 'deactivated',
      expectedVersion: target.version,
      expectedPlanningRevision: 7,
      expectedDocumentAuthorizationRevision: 3,
    },
  )

  expect(
    transactionInputs[0],
  ).toMatchObject({
    TransactItems: [
      {},
      {},
      {},
      {
        Put: {
          TableName:
            'mukuroji-documents-local',
          Item: {
            workspaceId,
            recordKey:
              'DOCUMENT_AUTHORIZATION_REVISION',
            revision: 4,
          },
        },
      },
    ],
  })
})

test('classifies a Planning revision race during member deactivation', async () => {
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('member@example.com', 'member')
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('member@example.com') ? target : actor) }
      }
      const error = new Error('canceled')
      error.name = 'TransactionCanceledException'
      Object.assign(error, {
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
      })
      throw error
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )

  await expect(client.updateMember(workspaceId, actor.memberKey, target.memberKey, {
    status: 'deactivated',
    expectedVersion: target.version,
    expectedPlanningRevision: 7,
    expectedDocumentAuthorizationRevision: 3,
  })).rejects.toMatchObject({
    status: 409,
    code: 'PlanningRevisionConflict',
  })
})

test('classifies a private Document ACL race during member deactivation', async () => {
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember(
    'member@example.com',
    'member',
  )
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as {
          recordKey?: string
        }
        return {
          Item: toMemberItem(
            key.recordKey?.includes(
                'member@example.com',
              )
              ? target
              : actor,
          ),
        }
      }
      throw createConditionalTransactionError(
        4,
        3,
      )
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    null,
    undefined,
    'DocumentsTable',
  )

  await expect(client.updateMember(
    workspaceId,
    actor.memberKey,
    target.memberKey,
    {
      status: 'deactivated',
      expectedVersion: target.version,
      expectedPlanningRevision: 7,
      expectedDocumentAuthorizationRevision: 11,
    },
  )).rejects.toMatchObject({
    status: 409,
    code:
      'DocumentAuthorizationRevisionConflict',
  })
})

test('preserves mixed Planning cancellation reasons as an infrastructure failure', async () => {
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('member@example.com', 'member')
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('member@example.com') ? target : actor) }
      }

      throw createTransactionCancellationError([
        'None',
        'TransactionConflict',
        'ConditionalCheckFailed',
      ])
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )

  await expect(client.updateMember(workspaceId, actor.memberKey, target.memberKey, {
    status: 'deactivated',
    expectedVersion: target.version,
    expectedPlanningRevision: 7,
    expectedDocumentAuthorizationRevision: 3,
  })).rejects.toMatchObject({
    status: 502,
    code: 'WorkspaceAccessUnavailable',
  })
})

test('classifies a canceled last-owner transaction as a domain conflict', async () => {
  const owner = createWorkspaceMember('demo@example.com')
  const secondOwner = createWorkspaceMember('second-owner@example.com')
  let getCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        getCount += 1
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('second-owner') ? secondOwner : owner) }
      }

      throw createConditionalTransactionError(3, 2)
    }),
  )

  await expect(client.updateMember(workspaceId, secondOwner.memberKey, owner.memberKey, {
    role: 'admin',
    expectedVersion: 1,
    expectedPlanningRevision: 0,
  })).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceLastOwner',
  })
  expect(getCount).toBe(4)
})

test('classifies concurrent member updates through optimistic version checks', async () => {
  const original = createWorkspaceMember('member@example.com', 'member', 'active', 1)
  const latest = createWorkspaceMember('member@example.com', 'guest', 'active', 2)
  const actor = createWorkspaceMember('demo@example.com')
  let targetReadCount = 0
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }

        if (key.recordKey?.includes('demo@example.com')) {
          return { Item: toMemberItem(actor) }
        }

        targetReadCount += 1
        return { Item: toMemberItem(targetReadCount === 1 ? original : latest) }
      }

      throw createConditionalTransactionError(2, 1)
    }),
  )

  await expect(client.updateMember(workspaceId, actor.memberKey, original.memberKey, {
    role: 'guest',
    expectedVersion: 1,
    expectedPlanningRevision: 0,
    expectedDocumentAuthorizationRevision: 0,
  })).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceVersionConflict',
  })
})

test('preserves non-conditional transaction cancellations as infrastructure failures', async () => {
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('member@example.com', 'member')
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('demo@example.com') ? actor : target) }
      }

      const error = new Error('transaction capacity is unavailable')
      error.name = 'TransactionCanceledException'
      Object.assign(error, {
        CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
      })
      throw error
    }),
  )

  await expect(client.updateMember(workspaceId, actor.memberKey, target.memberKey, {
    role: 'guest',
    expectedVersion: 1,
    expectedPlanningRevision: 0,
    expectedDocumentAuthorizationRevision: 0,
  })).rejects.toMatchObject({
    status: 502,
    code: 'WorkspaceAccessUnavailable',
  })
})

test('returns a semantic member no-op without a state or audit write', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('member@example.com', 'member')
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      const key = command.input.Key as { recordKey?: string }
      return { Item: toMemberItem(key.recordKey?.includes('demo@example.com') ? actor : target) }
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await expect(client.updateMember(
    workspaceId,
    actor.memberKey,
    target.memberKey,
    {
      role: target.role,
      status: target.status,
      expectedVersion: target.version,
      expectedPlanningRevision: 0,
    },
    createAuditContext('member-no-op'),
  )).resolves.toEqual(target)
  expect(inputs).toHaveLength(2)
})

test('resumes authentication after a reconcile transaction committed but its response failed', async () => {
  const member = createWorkspaceMember('sato@example.com', 'member')
  let getCount = 0
  const transactionInputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        getCount += 1

        if (getCount === 1) {
          return {}
        }

        if (getCount === 2) {
          return { Item: createInvitationItem('pending') }
        }

        return { Item: toMemberItem(member) }
      }

      transactionInputs.push(command.input)
      throw createConditionalTransactionError(2, 0)
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.reconcileAuthenticatedMember(workspaceId, {
    memberKey: member.memberKey,
    email: member.email,
    name: '佐藤 花子',
  })).resolves.toMatchObject({
    memberKey: 'sato@example.com',
    status: 'active',
  })
  expect(transactionInputs[0]).toMatchObject({
    TransactItems: [
      {},
      {
        Update: {
          ConditionExpression:
            'version = :expectedVersion AND #status IN (:pending, :provisioning, :deliveryFailed) AND expiresAt > :now',
        },
      },
    ],
  })
})

test('writes invitation creation state and its scoped audit event atomically', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await client.createInvitation(
    workspaceId,
    'demo@example.com',
    { email: 'sato@example.com', name: '佐藤 花子', role: 'member' },
    7,
    createAuditContext('create-invitation'),
  )

  const transactItems = inputs.at(-1)?.TransactItems as Array<Record<string, unknown>>
  expect(transactItems).toHaveLength(4)
  expect(transactItems[2]).toMatchObject({
    Put: {
      TableName: 'WorkspaceAccessTable',
      Item: { recordKey: 'INVITATION#sato@example.com', updatedAt: now.toISOString() },
    },
  })
  expect(transactItems[3]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'invitation.created',
        entityType: 'invitation',
        entityId: createWorkspaceInvitationAuditEntityId(
          workspaceId,
          'sato@example.com',
          workspaceAuditPseudonymKey,
        ),
        occurredAt: now.toISOString(),
        correlationId: 'correlation-create-invitation',
        metadata: { kind: 'workspace-invitation' },
        changes: expect.arrayContaining([
          { field: 'email', after: '[REDACTED]', redacted: true },
          { field: 'role', after: 'member' },
          { field: 'status', after: 'provisioning' },
        ]),
      },
      ConditionExpression: 'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
    },
  })
})

test('converts an invitation conditional Put into an atomic audit transaction', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: createInvitationItem('provisioning') }
        : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await client.markInvitationDelivery(
    workspaceId,
    'sato@example.com',
    {
      deliveryStatus: 'failed',
      identityOwnership: 'ambiguous',
      expectedVersion: 1,
      failureMessage: 'This value must not enter the audit diff.',
    },
    createAuditContext('delivery-result'),
  )

  const transactItems = inputs.at(-1)?.TransactItems as Array<Record<string, unknown>>
  expect(transactItems).toHaveLength(2)
  expect(transactItems[0]).toMatchObject({
    Put: {
      TableName: 'WorkspaceAccessTable',
      Item: { status: 'delivery-failed', deliveryStatus: 'failed', updatedAt: now.toISOString() },
      ConditionExpression: 'version = :expectedVersion AND #status IN (:status0, :status1, :status2)',
    },
  })
  expect(transactItems[1]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'invitation.delivery-updated',
        occurredAt: now.toISOString(),
        changes: expect.arrayContaining([
          { field: 'deliveryStatus', before: 'sent', after: 'failed' },
          { field: 'failureMessage', after: '[REDACTED]', redacted: true },
          { field: 'identityOwnership', before: 'workspace-created', after: 'ambiguous' },
          { field: 'status', before: 'provisioning', after: 'delivery-failed' },
        ]),
      },
    },
  })
  const auditItem = (transactItems[1]?.Put as { Item?: Record<string, unknown> } | undefined)?.Item
  expect(auditItem?.changes).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'cognitoIdentityId' }),
    expect.objectContaining({ field: 'cognitoUsername' }),
  ]))
})

test('reuses the audit event ID when an invitation delivery request is retried', async () => {
  const transactions: Array<Record<string, unknown>> = []
  let invitationReadCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }

        if (key.recordKey?.startsWith('MEMBER#')) {
          return { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        }

        invitationReadCount += 1
        return {
          Item: {
            ...createInvitationItem('delivery-failed'),
            version: invitationReadCount === 1 ? 1 : 4,
          },
        }
      }

      transactions.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )
  const auditContext = createAuditContext('retry-delivery')

  await client.prepareResend(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    7,
    auditContext,
  )
  await client.prepareResend(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    7,
    auditContext,
  )

  const eventIds = transactions.map((transaction) => {
    const items = transaction.TransactItems as Array<{ Put?: { TableName?: string; Item?: { eventId?: string } } }>
    return items.find((item) => item.Put?.TableName === 'AuditTable')?.Put?.Item?.eventId
  })
  expect(eventIds).toHaveLength(2)
  expect(eventIds[0]).toBeTruthy()
  expect(eventIds[1]).toBeTruthy()
  expect(eventIds[0]).toBe(eventIds[1])
})

test('reconciles member and invitation with two deterministic audit events', async () => {
  const inputs: Array<Record<string, unknown>> = []
  let getCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        getCount += 1
        return getCount === 1 ? {} : { Item: createInvitationItem('pending') }
      }

      inputs.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await client.reconcileAuthenticatedMember(
    workspaceId,
    { memberKey: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子' },
    createAuditContext('accept-invitation'),
  )

  const transactItems = inputs[0]?.TransactItems as Array<Record<string, unknown>>
  expect(transactItems).toHaveLength(4)
  const memberEvent = (transactItems[2]?.Put as { Item?: Record<string, unknown> } | undefined)?.Item
  const invitationEvent = (transactItems[3]?.Put as { Item?: Record<string, unknown> } | undefined)?.Item
  expect(memberEvent).toMatchObject({
    eventType: 'member.created',
    entityType: 'member',
    entityId: createWorkspaceMemberAuditEntityId(
      workspaceId,
      'sato@example.com',
      workspaceAuditPseudonymKey,
    ),
    occurredAt: now.toISOString(),
    changes: expect.arrayContaining([
      { field: 'role', after: 'member' },
      { field: 'status', after: 'active' },
    ]),
  })
  expect(invitationEvent).toMatchObject({
    eventType: 'invitation.accepted',
    entityType: 'invitation',
    entityId: createWorkspaceInvitationAuditEntityId(
      workspaceId,
      'sato@example.com',
      workspaceAuditPseudonymKey,
    ),
    occurredAt: now.toISOString(),
    changes: expect.arrayContaining([
      { field: 'acceptedAt', after: now.toISOString() },
      { field: 'deliveryStatus', before: 'sent', after: 'not-required' },
      { field: 'status', before: 'pending', after: 'accepted' },
    ]),
  })
  expect(memberEvent?.eventId).not.toBe(invitationEvent?.eventId)
})

test('writes member role changes and their safe field diff atomically', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('sato@example.com', 'member')
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('demo@example.com') ? actor : target) }
      }

      inputs.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await client.updateMember(
    workspaceId,
    actor.memberKey,
    target.memberKey,
    {
      role: 'guest',
      expectedVersion: 1,
      expectedPlanningRevision: 0,
      expectedDocumentAuthorizationRevision: 0,
    },
    createAuditContext('change-role'),
  )

  const transactItems = inputs[0]?.TransactItems as Array<Record<string, unknown>>
  expect(transactItems).toHaveLength(5)
  expect(transactItems[3]).toMatchObject({
    Put: {
      TableName: 'mukuroji-documents-local',
      Item: {
        workspaceId,
        recordKey:
          'DOCUMENT_AUTHORIZATION_REVISION',
        revision: 1,
      },
      ConditionExpression:
        'attribute_not_exists(workspaceId)',
    },
  })
  expect(transactItems[4]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'member.role-changed',
        entityType: 'member',
        entityId: createWorkspaceMemberAuditEntityId(
          workspaceId,
          'sato@example.com',
          workspaceAuditPseudonymKey,
        ),
        occurredAt: now.toISOString(),
        changes: [{ field: 'role', before: 'member', after: 'guest' }],
      },
    },
  })
})

test('preserves deactivatedAt when changing only the role of a deactivated member', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const actor = createWorkspaceMember('demo@example.com')
  const deactivatedAt = '2026-07-10T00:00:00.000Z'
  const target = {
    ...createWorkspaceMember('sato@example.com', 'member', 'deactivated'),
    deactivatedAt,
  }
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('demo@example.com') ? actor : target) }
      }

      inputs.push(command.input)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  const member = await client.updateMember(
    workspaceId,
    actor.memberKey,
    target.memberKey,
    { role: 'guest', expectedVersion: 1, expectedPlanningRevision: 0 },
    createAuditContext('change-deactivated-role'),
  )

  expect(member.deactivatedAt).toBe(deactivatedAt)
  const transactItems = inputs[0]?.TransactItems as Array<Record<string, unknown>>
  expect(transactItems[1]).toMatchObject({
    Update: {
      UpdateExpression:
        'SET #role = :role, #status = :status, updatedAt = :now, version = version + :one',
    },
  })
  expect(transactItems[3]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'member.role-changed',
        changes: [{ field: 'role', before: 'member', after: 'guest' }],
      },
    },
  })
})

test('fails closed before a Workspace state write when audit context is missing', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await expect(client.createInvitation(
    workspaceId,
    'demo@example.com',
    { email: 'sato@example.com', role: 'member' },
  )).rejects.toMatchObject({
    status: 500,
    code: 'WorkspaceAuditContextMissing',
  })
  expect(inputs.some((input) => Array.isArray(input.TransactItems))).toBe(false)
})

test('fails closed before a Workspace state write when the audit context targets another Workspace', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await expect(client.createInvitation(
    workspaceId,
    'demo@example.com',
    { email: 'sato@example.com', role: 'member' },
    undefined,
    createAuditContext('workspace-mismatch', 'workspace#other'),
  )).rejects.toMatchObject({
    status: 500,
    code: 'WorkspaceAuditContextMismatch',
  })
  expect(inputs.some((input) => Array.isArray(input.TransactItems))).toBe(false)
})

test('fails closed before a Workspace state write when the audit pseudonym key is missing', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
    '',
  )

  await expect(client.createInvitation(
    workspaceId,
    'demo@example.com',
    { email: 'sato@example.com', role: 'member' },
    undefined,
    createAuditContext('missing-pseudonym-key'),
  )).rejects.toMatchObject({
    status: 500,
    code: 'WorkspaceAuditPseudonymKeyMissing',
  })
  expect(inputs.some((input) => Array.isArray(input.TransactItems))).toBe(false)
})

test('rejects surrounding whitespace in an injected audit pseudonym key', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
    ` ${workspaceAuditPseudonymKey} `,
  )

  await expect(client.createInvitation(
    workspaceId,
    'demo@example.com',
    { email: 'sato@example.com', role: 'member' },
    undefined,
    createAuditContext('invalid-pseudonym-key'),
  )).rejects.toMatchObject({
    status: 500,
    code: 'WorkspaceAuditPseudonymKeyInvalid',
  })
  expect(inputs.some((input) => Array.isArray(input.TransactItems))).toBe(false)
})

test('preserves mixed invitation cancellation reasons as an infrastructure failure', async () => {
  let invitationReadCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        invitationReadCount += 1
        return { Item: createInvitationItem('pending') }
      }

      throw createTransactionCancellationError([
        'ConditionalCheckFailed',
        'TransactionConflict',
      ])
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await expect(client.markInvitationIdentityMutationStarted(
    workspaceId,
    'sato@example.com',
    1,
    undefined,
    undefined,
    createAuditContext('mixed-invitation-cancellation'),
  )).rejects.toMatchObject({
    status: 502,
    code: 'WorkspaceAccessUnavailable',
  })
  expect(invitationReadCount).toBe(1)
})

test('classifies a duplicate owner audit event separately from the last-owner guard', async () => {
  const actor = createWorkspaceMember('second-owner@example.com')
  const target = createWorkspaceMember('demo@example.com')
  let getCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        getCount += 1
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes(actor.memberKey) ? actor : target) }
      }

      throw createConditionalTransactionError(5, 4)
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await expect(client.updateMember(workspaceId, actor.memberKey, target.memberKey, {
    role: 'admin',
    expectedVersion: 1,
    expectedPlanningRevision: 0,
  }, createAuditContext('duplicate-owner-audit'))).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceTransactionConflict',
  })
  expect(getCount).toBe(2)
})

test('does not classify a failed owner-count promotion as the last-owner guard', async () => {
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('member@example.com', 'member')
  let getCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        getCount += 1
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes(actor.memberKey) ? actor : target) }
      }

      throw createConditionalTransactionError(5, 2)
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await expect(client.updateMember(workspaceId, actor.memberKey, target.memberKey, {
    role: 'owner',
    expectedVersion: 1,
    expectedPlanningRevision: 0,
  }, createAuditContext('owner-promotion-guard'))).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceTransactionConflict',
  })
  expect(getCount).toBe(4)
})

test('classifies an invitation deleted during resend as not found', async () => {
  let invitationReadCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }

        if (key.recordKey?.startsWith('MEMBER#')) {
          return { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
        }

        invitationReadCount += 1
        return invitationReadCount === 1
          ? { Item: createInvitationItem('delivery-failed') }
          : {}
      }

      throw createConditionalTransactionError(3, 1)
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await expect(client.prepareResend(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    undefined,
    createAuditContext('resend-deleted-invitation'),
  )).rejects.toMatchObject({
    status: 404,
    code: 'WorkspaceInvitationNotFound',
  })
  expect(invitationReadCount).toBe(2)
})

test('never marks pre-existing or ambiguous Cognito identities as safe to delete', () => {
  expect(isWorkspaceIdentitySafeToDelete('workspace-created')).toBe(true)
  expect(isWorkspaceIdentitySafeToDelete('pre-existing')).toBe(false)
  expect(isWorkspaceIdentitySafeToDelete('ambiguous')).toBe(false)
})

test('provisions a new directory member with an immutable external identity', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand' ? {} : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  const member = await client.reconcileDirectoryMember(workspaceId, {
    memberKey: 'sato@example.com',
    email: 'SATO@example.com',
    name: '佐藤 花子',
    role: 'member',
    externalIdentityId: 'scim-user-123',
    expectedPlanningRevision: 0,
  }, createAuditContext('directory-provision'))

  expect(member).toMatchObject({
    memberKey: 'sato@example.com',
    email: 'sato@example.com',
    provisioningSource: 'directory',
    externalIdentityId: 'scim-user-123',
    status: 'active',
    version: 1,
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      {
        Put: {
          TableName: 'WorkspaceAccessTable',
          Item: {
            recordKey: 'MEMBER#sato@example.com',
            provisioningSource: 'directory',
            externalIdentityId: 'scim-user-123',
          },
        },
      },
      {
        Put: {
          TableName: 'PlanningTable',
          Item: {
            recordKey: 'META',
            revision: 1,
          },
        },
      },
      {
        Put: {
          TableName: 'AuditTable',
          Item: {
            eventType: 'member.directory-provisioned',
            action: 'directory-provisioned',
          },
        },
      },
    ],
  })
})

test('deprovisions a directory member atomically with the Planning revision and audit event', async () => {
  const target = {
    ...createWorkspaceMember('sato@example.com', 'member', 'active', 4),
    provisioningSource: 'directory' as const,
    externalIdentityId: 'scim-user-123',
  }
  const inputs: Array<Record<string, unknown>> = []
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(target) }
        : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  const member = await client.deprovisionDirectoryMember(
    workspaceId,
    target.memberKey,
    {
      externalIdentityId: target.externalIdentityId,
      expectedVersion: target.version,
      expectedPlanningRevision: 9,
      expectedDocumentAuthorizationRevision: 3,
    },
    createAuditContext('directory-deprovision'),
  )

  expect(member).toMatchObject({
    status: 'deactivated',
    provisioningSource: 'directory',
    externalIdentityId: 'scim-user-123',
    version: 5,
    deactivatedAt: now.toISOString(),
    signInsRevokedAt: now.toISOString(),
  })
  expect(inputs.at(-1)).toMatchObject({
    TransactItems: [
      {
        Update: {
          TableName: 'WorkspaceAccessTable',
          ConditionExpression:
            'version = :expectedVersion AND #role <> :owner AND provisioningSource = :directory AND externalIdentityId = :externalIdentityId AND (attribute_not_exists(signInsRevokedAt) OR signInsRevokedAt < :signInsRevokedAt)',
        },
      },
      {
        Put: {
          TableName: 'PlanningTable',
          Item: {
            recordKey: 'META',
            revision: 10,
          },
        },
      },
      {
        Put: {
          TableName: 'mukuroji-documents-local',
          Item: {
            workspaceId,
            recordKey:
              'DOCUMENT_AUTHORIZATION_REVISION',
            entryType:
              'document-authorization-revision',
            revision: 4,
            updatedAt: now.toISOString(),
          },
          ConditionExpression:
            'revision = :expectedDocumentAuthorizationRevision',
          ExpressionAttributeValues: {
            ':expectedDocumentAuthorizationRevision': 3,
          },
        },
      },
      {
        Put: {
          TableName: 'AuditTable',
          Item: {
            eventType: 'member.directory-deprovisioned',
            action: 'directory-deprovisioned',
          },
        },
      },
    ],
  })
})

test('refuses a member whose stored sign-in cutoff is not a UTC timestamp', async () => {
  for (const signInsRevokedAt of [123, '2026-07-11', 'not-a-time']) {
    const member = createWorkspaceMember('sato@example.com', 'member')
    const client = createWorkspaceAccessClientWithDocumentAuthorization(
      'WorkspaceAccessTable',
      createDocumentClient(() => ({ Item: { ...toMemberItem(member), signInsRevokedAt } })),
      undefined,
      false,
      () => now,
      'PlanningTable',
      'AuditTable',
    )

    await expect(client.getMember(workspaceId, member.memberKey))
      .rejects.toMatchObject({ status: 503, code: 'InvalidWorkspaceAccessData' })
  }
})

test('deprovisioning keeps a later sign-in cutoff written by a concurrent sign-out', async () => {
  const laterCutoff = new Date(now.getTime() + 5_000).toISOString()
  let target = {
    ...createWorkspaceMember('sato@example.com', 'member', 'active', 4),
    provisioningSource: 'directory' as const,
    externalIdentityId: 'scim-user-123',
  }
  const transactions: Array<Record<string, unknown>> = []
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') return { Item: toMemberItem(target) }
      if (command.constructor.name !== 'TransactWriteCommand') return {}
      transactions.push(command.input)
      if (transactions.length === 1) {
        // A password reset signs the member out between the read and this transaction.
        target = { ...target, signInsRevokedAt: laterCutoff }
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        })
      }
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  const member = await client.deprovisionDirectoryMember(
    workspaceId,
    target.memberKey,
    {
      externalIdentityId: target.externalIdentityId,
      expectedVersion: target.version,
      expectedPlanningRevision: 9,
      expectedDocumentAuthorizationRevision: 3,
    },
    createAuditContext('directory-deprovision'),
  )

  const expectedCutoff = new Date(now.getTime() + 5_001).toISOString()
  expect(transactions).toHaveLength(2)
  expect(member).toMatchObject({ status: 'deactivated', signInsRevokedAt: expectedCutoff })
  expect(transactions[1]).toMatchObject({
    TransactItems: expect.arrayContaining([{
      Update: expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({ ':signInsRevokedAt': expectedCutoff }),
      }),
    }]),
  })
})

test('directory provisioning cannot take ownership of a Workspace owner', async () => {
  const owner = createWorkspaceMember('demo@example.com', 'owner')
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(owner) }
        : {}
    }),
    undefined,
    false,
    () => now,
  )

  await expect(client.reconcileDirectoryMember(workspaceId, {
    memberKey: owner.memberKey,
    email: owner.email,
    role: 'member',
    externalIdentityId: 'scim-owner',
    expectedVersion: owner.version,
    expectedPlanningRevision: 0,
  })).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceDirectoryOwnerProtected',
  })
})

test('directory deprovisioning cannot silently adopt a manual member', async () => {
  const manualMember = createWorkspaceMember('manual@example.com', 'member')
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      return command.constructor.name === 'GetCommand'
        ? { Item: toMemberItem(manualMember) }
        : {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )

  await expect(client.deprovisionDirectoryMember(
    workspaceId,
    manualMember.memberKey,
    {
      externalIdentityId: 'scim-manual',
      expectedVersion: manualMember.version,
      expectedPlanningRevision: 0,
      expectedDocumentAuthorizationRevision: 0,
    },
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceDirectoryIdentityConflict',
  })
})

test('directory reconcile replay returns exact desired state before stale version rejection', async () => {
  const directoryMember = {
    ...createWorkspaceMember('directory@example.com', 'member', 'active', 4),
    provisioningSource: 'directory' as const,
    externalIdentityId: 'scim-directory',
  }
  let transactionCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        return { Item: toMemberItem(directoryMember) }
      }
      transactionCount += 1
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )

  if (directoryMember.role === 'owner') {
    throw new Error('Directory-managed members cannot use the owner role.')
  }
  await expect(client.reconcileDirectoryMember(workspaceId, {
    memberKey: directoryMember.memberKey,
    email: directoryMember.email,
    role: directoryMember.role,
    externalIdentityId: directoryMember.externalIdentityId,
    expectedVersion: 3,
    expectedPlanningRevision: 8,
  })).resolves.toEqual(directoryMember)
  expect(transactionCount).toBe(0)
})

test('directory create race rejects a different desired role', async () => {
  const racedMember = {
    ...createWorkspaceMember('race@example.com', 'admin'),
    provisioningSource: 'directory' as const,
    externalIdentityId: 'scim-race',
  }
  let getCount = 0
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        getCount += 1
        return getCount === 1 ? {} : { Item: toMemberItem(racedMember) }
      }
      throw createConditionalTransactionError(2, 0)
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )

  await expect(client.reconcileDirectoryMember(workspaceId, {
    memberKey: racedMember.memberKey,
    email: racedMember.email,
    role: 'guest',
    externalIdentityId: racedMember.externalIdentityId,
    expectedPlanningRevision: 0,
  })).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceDirectoryIdentityConflict',
  })
})

test('exposes WorkspaceAccessError status and code for API mapping', () => {
  const error = new WorkspaceAccessError(409, 'WorkspaceVersionConflict', 'conflict')
  expect(error).toMatchObject({ status: 409, code: 'WorkspaceVersionConflict' })
})

/**
 * Creates a client whose members are read from a fixed map and whose transactions are recorded.
 *
 * @param members - Members returned by member reads.
 * @param transactions - Receives each transaction input.
 * @param auditTableName - Audit table, or null to disable audit.
 * @returns The configured client.
 */
function createCredentialActionClient(
  members: WorkspaceMember[],
  transactions: Array<Record<string, unknown>>,
  auditTableName: string | null = 'AuditTable',
) {
  return new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        const member = members.find((candidate) =>
          `MEMBER#${candidate.memberKey}` === key.recordKey
        )
        return member ? { Item: toMemberItem(member) } : {}
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        transactions.push(command.input)
      }
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    auditTableName ?? undefined,
    auditTableName ? workspaceAuditPseudonymKey : undefined,
  )
}

test('records a member credential reset with actor and target conditions', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const client = createCredentialActionClient([
    createWorkspaceMember('demo@example.com', 'admin'),
    createWorkspaceMember('sato@example.com', 'member', 'active', 3),
  ], transactions)

  const record = await client.recordMemberCredentialAction(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    'password-reset-requested',
    createAuditContext('credential-reset'),
  )

  expect(record).toMatchObject({ member: { memberKey: 'sato@example.com' }, alreadyRecorded: false, completed: false })
  expect(transactions).toHaveLength(1)
  const items = transactions[0].TransactItems as Array<Record<string, Record<string, unknown>>>
  expect(items).toHaveLength(4)
  expect(items[0].ConditionCheck?.Key).toEqual({
    workspaceId,
    recordKey: 'MEMBER#demo@example.com',
  })
  expect(items[1].ConditionCheck?.ExpressionAttributeValues).toEqual({
    ':active': 'active',
    ':version': 3,
  })
  const auditItem = items[2].Put?.Item as Record<string, unknown>
  expect(auditItem.eventType).toBe('member.password-reset-requested')
  expect(auditItem.entityId).toBe(createWorkspaceMemberAuditEntityId(
    workspaceId,
    'sato@example.com',
    workspaceAuditPseudonymKey,
  ))
  expect(JSON.stringify(auditItem)).not.toContain('sato@example.com')
  expect(items[3].Put?.Item).toMatchObject({
    workspaceId,
    recordKey: `CREDENTIAL_ACTION#${String(auditItem.eventId)}`,
    memberKey: 'sato@example.com',
    action: 'password-reset-requested',
    status: 'recorded',
    leaseUntil: now.getTime() + 60_000,
  })
  expect(items[3].Put?.ConditionExpression).toBe('attribute_not_exists(recordKey)')
})

test('lets an admin reset members but not owners, and nobody reset themselves', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const client = createCredentialActionClient([
    createWorkspaceMember('demo@example.com', 'admin'),
    createWorkspaceMember('owner@example.com', 'owner'),
  ], transactions)

  await expect(client.recordMemberCredentialAction(
    workspaceId,
    'demo@example.com',
    'owner@example.com',
    'mfa-reset',
    createAuditContext('credential-owner'),
  )).rejects.toMatchObject({ status: 403, code: 'WorkspaceRoleDenied' })
  await expect(client.recordMemberCredentialAction(
    workspaceId,
    'demo@example.com',
    'demo@example.com',
    'mfa-reset',
    createAuditContext('credential-self'),
  )).rejects.toMatchObject({ status: 409, code: 'WorkspaceSelfCredentialReset' })
  expect(transactions).toEqual([])
})

test('refuses a member credential reset when no audit table keeps its progress', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const client = createCredentialActionClient([
    createWorkspaceMember('demo@example.com', 'admin'),
    createWorkspaceMember('sato@example.com', 'member'),
  ], transactions, null)

  await expect(client.recordMemberCredentialAction(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    'mfa-reset',
    createAuditContext('credential-no-audit'),
  )).rejects.toMatchObject({ status: 503, code: 'AccountSecurityUnavailable' })
  expect(transactions).toEqual([])
})

test('reports a member that changed during a credential reset as a conflict', async () => {
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return key.recordKey === 'MEMBER#demo@example.com'
          ? { Item: toMemberItem(createWorkspaceMember('demo@example.com')) }
          : { Item: toMemberItem(createWorkspaceMember('sato@example.com', 'member')) }
      }
      throw createConditionalTransactionError(3, 1)
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
    workspaceAuditPseudonymKey,
  )

  await expect(client.recordMemberCredentialAction(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    'mfa-reset',
    createAuditContext('credential-conflict'),
  )).rejects.toMatchObject({ status: 409, code: 'WorkspaceVersionConflict' })
})

test('tracks a credential reset by its idempotency key so that a retry resumes, refuses or skips it', async () => {
  const progressRecords = new Map<string, Record<string, unknown>>()
  const leaseTransactions: unknown[][] = []
  let clock = now
  const members = [
    createWorkspaceMember('demo@example.com', 'admin'),
    createWorkspaceMember('sato@example.com', 'member', 'active', 3),
  ]
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      const input: Record<string, unknown> = command.input
      const key = command.input.Key as { recordKey?: string } | undefined
      if (command.constructor.name === 'GetCommand' && key?.recordKey?.startsWith('CREDENTIAL_ACTION#')) {
        const record = progressRecords.get(key.recordKey)
        return record ? { Item: record } : {}
      }
      if (command.constructor.name === 'GetCommand') {
        const member = members.find((candidate) => `MEMBER#${candidate.memberKey}` === key?.recordKey)
        return member ? { Item: toMemberItem(member) } : {}
      }
      if (command.constructor.name === 'UpdateCommand' && key?.recordKey) {
        const record = progressRecords.get(key.recordKey)
        const values = input.ExpressionAttributeValues as Record<string, unknown>
        if (record && values[':completed']) {
          progressRecords.set(key.recordKey, { ...record, status: 'completed' })
          return {}
        }
        if (values[':applying']) {
          if (record?.status !== 'recorded') {
            throw Object.assign(new Error('Condition failed.'), { name: 'ConditionalCheckFailedException' })
          }
          progressRecords.set(key.recordKey, { ...record, status: 'applying' })
        }
        return {}
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const items = input.TransactItems as Array<{
          Put?: { Item: Record<string, unknown> }
          Update?: { Key: { recordKey: string }; ExpressionAttributeValues: Record<string, unknown> }
        }>
        const leaseUpdate = items[2]?.Update
        if (leaseUpdate) {
          leaseTransactions.push(items)
          const record = progressRecords.get(leaseUpdate.Key.recordKey)
          const values = leaseUpdate.ExpressionAttributeValues
          if (record?.status !== 'recorded' || record.leaseUntil !== values[':observedLeaseUntil']) {
            throw Object.assign(new Error('Transaction cancelled.'), {
              name: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
            })
          }
          progressRecords.set(leaseUpdate.Key.recordKey, { ...record, leaseUntil: values[':leaseUntil'] })
          return {}
        }
        const progress = items[3]?.Put?.Item
        const recordKey = String(progress?.recordKey)
        if (progressRecords.has(recordKey)) {
          throw Object.assign(new Error('Transaction cancelled.'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              { Code: 'None' },
              { Code: 'None' },
              { Code: 'ConditionalCheckFailed' },
              { Code: 'ConditionalCheckFailed' },
            ],
          })
        }
        if (progress) progressRecords.set(recordKey, progress)
      }
      return {}
    }),
    undefined,
    false,
    () => clock,
    'PlanningTable',
    'AuditTable',
    workspaceAuditPseudonymKey,
  )
  const auditContext = createAuditContext('credential-reset-retry')
  const record = () => client.recordMemberCredentialAction(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    'mfa-reset',
    auditContext,
  )
  const readProgress = () => client.readMemberCredentialActionProgress(
    workspaceId,
    'sato@example.com',
    'mfa-reset',
    auditContext,
  )

  await expect(readProgress()).resolves.toBe('none')
  await expect(record()).resolves.toMatchObject({ alreadyRecorded: false, completed: false })
  await expect(readProgress()).resolves.toBe('recorded')
  // While the first attempt holds its lease, a concurrent retry must not change Cognito too.
  await expect(record()).rejects.toMatchObject({ status: 409, code: 'WorkspaceCredentialActionInProgress' })
  // Once the lease runs out, one retry takes the action over and the next waits again.
  clock = new Date(now.getTime() + 61_000)
  await expect(record()).resolves.toMatchObject({ alreadyRecorded: true, completed: false })
  await expect(record()).rejects.toMatchObject({ status: 409, code: 'WorkspaceCredentialActionInProgress' })
  // The takeover checks in the same transaction that the actor and target are unchanged.
  expect(leaseTransactions[0]).toMatchObject([
    { ConditionCheck: { Key: { recordKey: 'MEMBER#demo@example.com' } } },
    { ConditionCheck: { Key: { recordKey: 'MEMBER#sato@example.com' }, ExpressionAttributeValues: { ':version': 3 } } },
    { Update: {} },
  ])
  // The progress record expires with the audit event that keeps its key taken.
  expect(typeof [...progressRecords.values()][0]?.expiresAt).toBe('number')
  // Once an attempt marks the Cognito change as started, no retry repeats it, even inside the
  // resume window, because the member may have set up a new app since.
  const markApplying = () => client.markMemberCredentialActionApplying(
    workspaceId,
    'sato@example.com',
    'mfa-reset',
    auditContext,
  )
  await markApplying()
  await expect(markApplying()).rejects.toMatchObject({ status: 409, code: 'WorkspaceCredentialActionInProgress' })
  clock = new Date(now.getTime() + 3 * 60_000)
  await expect(record()).rejects.toMatchObject({ status: 409, code: 'WorkspaceCredentialActionExpired' })
  await expect(readProgress()).resolves.toBe('recorded')
  // An action left unfinished past the resume window is not repeated automatically either.
  clock = new Date(now.getTime() + 11 * 60_000)
  await expect(record()).rejects.toMatchObject({ status: 409, code: 'WorkspaceCredentialActionExpired' })
  await client.completeMemberCredentialAction(workspaceId, 'sato@example.com', 'mfa-reset', auditContext)
  await expect(readProgress()).resolves.toBe('completed')
  await expect(record()).resolves.toMatchObject({ alreadyRecorded: true, completed: true })
  // Reusing the key for a different action is a conflict, not a silent success.
  await expect(client.recordMemberCredentialAction(
    workspaceId,
    'demo@example.com',
    'sato@example.com',
    'password-reset-requested',
    auditContext,
  )).rejects.toMatchObject({ code: 'WorkspaceIdempotencyConflict', status: 409 })
  expect(progressRecords.size).toBe(1)
})

test('records a sign-out of every session on the member, keeping a later cutoff and ignoring a missing member', async () => {
  const inputs: Array<Record<string, unknown>> = []
  let missing = false
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      if (missing) {
        throw Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        })
      }
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )

  await client.revokeMemberSignIns(workspaceId, 'Sato@Example.com')
  missing = true
  await expect(client.revokeMemberSignIns(workspaceId, 'gone@example.com')).resolves.toBeUndefined()

  expect(inputs[0]).toEqual({
    TableName: 'WorkspaceAccessTable',
    Key: { workspaceId, recordKey: 'MEMBER#sato@example.com' },
    UpdateExpression: 'SET signInsRevokedAt = :now',
    ConditionExpression:
      'attribute_exists(recordKey) AND (attribute_not_exists(signInsRevokedAt) OR signInsRevokedAt < :now)',
    ExpressionAttributeValues: { ':now': now.toISOString() },
  })
})

test('commits a member update together with the authorization conditions it was checked against', async () => {
  const actor = createWorkspaceMember('demo@example.com')
  const target = createWorkspaceMember('member@example.com', 'member')
  const enterpriseCheck = {
    ConditionCheck: {
      TableName: 'EnterpriseIdentityTable',
      Key: { scopeKey: `WORKSPACE#${workspaceId}`, recordKey: 'CONTROL' },
      ConditionExpression: '#controlRevision = :expectedControlRevision',
      ExpressionAttributeNames: { '#controlRevision': 'controlRevision' },
      ExpressionAttributeValues: { ':expectedControlRevision': 5 },
    },
  }
  const transactions: Array<Record<string, unknown>> = []
  let cancelNext = false
  const client = createWorkspaceAccessClientWithDocumentAuthorization(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { recordKey?: string }
        return { Item: toMemberItem(key.recordKey?.includes('member@example.com') ? target : actor) }
      }
      transactions.push(command.input)
      if (cancelNext) throw createConditionalTransactionError(4, 3)
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
  )
  const input = {
    role: 'admin' as const,
    expectedVersion: target.version,
    expectedPlanningRevision: 7,
    authorizationConditionChecks: [enterpriseCheck],
  }

  await expect(client.updateMember(workspaceId, actor.memberKey, target.memberKey, input))
    .resolves.toMatchObject({ role: 'admin' })
  expect(transactions[0]?.TransactItems).toContainEqual(enterpriseCheck)

  // An assignment created after the route read the Enterprise state cancels the promotion.
  cancelNext = true
  await expect(client.updateMember(workspaceId, actor.memberKey, target.memberKey, input))
    .rejects.toMatchObject({ status: 409, code: 'WorkspaceMemberAuthorizationChanged' })
})

test('pins a member record to the version read, or to its absence', () => {
  expect(createWorkspaceMemberVersionConditionCheck({
    workspaceId,
    memberKey: 'Member@Example.com',
    expectedVersion: 3,
    tableName: 'WorkspaceAccessTable',
  })).toEqual({
    ConditionCheck: {
      TableName: 'WorkspaceAccessTable',
      Key: { workspaceId, recordKey: 'MEMBER#member@example.com' },
      ConditionExpression: '#entryType = :entryType AND #version = :version',
      ExpressionAttributeNames: { '#entryType': 'entryType', '#version': 'version' },
      ExpressionAttributeValues: { ':entryType': 'workspace-member', ':version': 3 },
    },
  })
  expect(createWorkspaceMemberVersionConditionCheck({
    workspaceId,
    memberKey: 'gone@example.com',
    tableName: 'WorkspaceAccessTable',
  })).toEqual({
    ConditionCheck: {
      TableName: 'WorkspaceAccessTable',
      Key: { workspaceId, recordKey: 'MEMBER#gone@example.com' },
      ConditionExpression: 'attribute_not_exists(#recordKey)',
      ExpressionAttributeNames: { '#recordKey': 'recordKey' },
    },
  })
})

/**
 * Creates a Workspace Access adapter over the given member rows that records each write.
 *
 * @param members - Stored member rows, by member key.
 * @returns The adapter and the recorded write inputs.
 */
function createMemberNameClient(
  members: readonly WorkspaceMember[],
  auditItems: ReadonlyArray<Record<string, unknown>> = [],
) {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      if (command.constructor.name === 'GetCommand' && command.input.TableName === 'AuditTable') {
        const key = command.input.Key
        const eventId = typeof key === 'object' && key !== null && 'eventId' in key ? String(key.eventId) : ''
        return { Item: auditItems.find((item) => item.eventId === eventId) }
      }
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key
        const recordKey = typeof key === 'object' && key !== null && 'recordKey' in key
          ? String(key.recordKey)
          : ''
        const member = members.find((candidate) => recordKey === `MEMBER#${candidate.memberKey}`)
        return { Item: member ? toMemberItem(member) : undefined }
      }
      inputs.push(command.input)
      // An audit Put whose event already exists fails its condition, as DynamoDB would.
      const transactItems = command.input.TransactItems
      if (command.constructor.name === 'TransactWriteCommand' && Array.isArray(transactItems)) {
        const failedIndex = transactItems.findIndex((item: unknown) => {
          if (typeof item !== 'object' || item === null || !('Put' in item)) return false
          const put = item.Put
          const eventId = typeof put === 'object' && put !== null && 'Item' in put &&
            typeof put.Item === 'object' && put.Item !== null && 'eventId' in put.Item
            ? put.Item.eventId
            : undefined
          return eventId !== undefined && auditItems.some((audit) => audit.eventId === eventId)
        })
        if (failedIndex >= 0) throw createConditionalTransactionError(transactItems.length, failedIndex)
      }
      return {}
    }),
    undefined,
    false,
    () => now,
    'PlanningTable',
    'AuditTable',
  )
  return { client, inputs }
}

test('lets a member change their own display name with a version condition', async () => {
  const member = createWorkspaceMember('sato@example.com', 'member')
  const { client, inputs } = createMemberNameClient([member])

  const renamed = await client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '  佐藤 花子 ', expectedVersion: 1 },
    createAuditContext('rename-self'),
  )

  expect(renamed).toMatchObject({ name: '佐藤 花子', version: 2 })
  const transactItems = inputs[0]?.TransactItems
  expect(Array.isArray(transactItems) ? transactItems : []).toHaveLength(2)
  expect(inputs[0]).toMatchObject({
    TransactItems: [
      {
        Update: {
          Key: { workspaceId, recordKey: 'MEMBER#sato@example.com' },
          UpdateExpression: 'SET #name = :name, updatedAt = :now, version = version + :one',
          ExpressionAttributeValues: { ':name': '佐藤 花子', ':expectedVersion': 1 },
        },
      },
      {
        Put: {
          TableName: 'AuditTable',
          Item: { eventType: 'member.renamed', action: 'renamed' },
        },
      },
    ],
  })
})

test('removes the display name when it is blank and leaves an unchanged name as it is', async () => {
  const owner = createWorkspaceMember('demo@example.com')
  const { client, inputs } = createMemberNameClient([owner])

  const unchanged = await client.updateMemberName(
    workspaceId,
    owner.memberKey,
    owner.memberKey,
    { name: 'Demo User', expectedVersion: 1 },
    createAuditContext('same-name'),
  )
  expect(unchanged).toEqual(owner)
  // Only the version is checked and the request's audit event written; the member row is untouched.
  expect(inputs[0]).toMatchObject({
    TransactItems: [
      { ConditionCheck: { Key: { recordKey: 'MEMBER#demo@example.com' }, ExpressionAttributeValues: { ':expectedVersion': 1 } } },
      { Put: { TableName: 'AuditTable', Item: { eventType: 'member.renamed', changes: [], metadata: { unchanged: true } } } },
    ],
  })
  inputs.length = 0

  const cleared = await client.updateMemberName(
    workspaceId,
    owner.memberKey,
    owner.memberKey,
    { name: ' ', expectedVersion: 1 },
    createAuditContext('clear-name'),
  )
  expect(cleared.name).toBeUndefined()
  const clearItems = inputs[0]?.TransactItems
  expect(Array.isArray(clearItems) ? clearItems[0] : undefined).toMatchObject({
    Update: { UpdateExpression: 'SET updatedAt = :now, version = version + :one REMOVE #name' },
  })
})

test('lets an admin rename a member but not an owner, and pins the admin', async () => {
  const admin = createWorkspaceMember('admin@example.com', 'admin')
  const member = createWorkspaceMember('sato@example.com', 'member')
  const owner = createWorkspaceMember('demo@example.com')
  const { client, inputs } = createMemberNameClient([admin, member, owner])

  await client.updateMemberName(
    workspaceId,
    admin.memberKey,
    member.memberKey,
    { name: 'Sato', expectedVersion: 1 },
    createAuditContext('admin-rename'),
  )
  const adminItems = inputs[0]?.TransactItems
  expect(Array.isArray(adminItems) ? adminItems.slice(0, 2) : []).toMatchObject([
    { ConditionCheck: { Key: { recordKey: 'MEMBER#admin@example.com' } } },
    { Update: { Key: { recordKey: 'MEMBER#sato@example.com' } } },
  ])

  await expect(client.updateMemberName(
    workspaceId,
    admin.memberKey,
    owner.memberKey,
    { name: 'Owner', expectedVersion: 1 },
  )).rejects.toMatchObject({ status: 403, code: 'WorkspaceRoleDenied' })
})

test('refuses a member renaming someone else', async () => {
  const member = createWorkspaceMember('sato@example.com', 'member')
  const other = createWorkspaceMember('suzuki@example.com', 'member')
  const { client, inputs } = createMemberNameClient([member, other])

  await expect(client.updateMemberName(
    workspaceId,
    member.memberKey,
    other.memberKey,
    { name: 'Suzuki', expectedVersion: 1 },
  )).rejects.toMatchObject({ status: 403, code: 'WorkspaceRoleDenied' })
  expect(inputs).toHaveLength(0)
})

test('refuses renaming a directory member and a stale version', async () => {
  const owner = createWorkspaceMember('demo@example.com')
  const directoryMember = {
    ...createWorkspaceMember('scim@example.com', 'member'),
    provisioningSource: 'directory' as const,
    externalIdentityId: 'ext-1',
  }
  const { client } = createMemberNameClient([owner, directoryMember])

  await expect(client.updateMemberName(
    workspaceId,
    directoryMember.memberKey,
    directoryMember.memberKey,
    { name: 'Self', expectedVersion: 1 },
  )).rejects.toMatchObject({ status: 409, code: 'WorkspaceMemberNameDirectoryManaged' })
  await expect(client.updateMemberName(
    workspaceId,
    owner.memberKey,
    owner.memberKey,
    { name: 'New', expectedVersion: 3 },
  )).rejects.toMatchObject({ status: 409, code: 'WorkspaceVersionConflict' })
})

/**
 * Builds the audit context of a rename request whose fingerprint covers the requested change.
 *
 * @param idempotencyKey - Idempotency key of the request.
 * @param name - Requested name.
 * @returns Audit context of the request.
 */
function createRenameAuditContext(idempotencyKey: string, name: string) {
  return createMutationAuditContext({
    workspaceId,
    actor: { id: 'sub-demo', kind: 'user', displayName: 'demo@example.com' },
    idempotencyKey,
    occurredAt: now.toISOString(),
    request: { method: 'PUT', path: '/api/me/profile', body: { expectedVersion: 1, name } },
    source: { kind: 'api' },
  })
}

test('returns the saved member when a committed rename is retried with the same idempotency key', async () => {
  const member = createWorkspaceMember('sato@example.com', 'member')
  const first = createMemberNameClient([member])
  await first.client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '佐藤 花子', expectedVersion: 1 },
    createRenameAuditContext('rename-retry', '佐藤 花子'),
  )
  const transactItems = first.inputs[0]?.TransactItems
  const auditPut = Array.isArray(transactItems) ? transactItems[1] : undefined
  const auditItem = typeof auditPut === 'object' && auditPut !== null && 'Put' in auditPut
    ? auditPut.Put.Item
    : undefined
  expect(auditItem).toMatchObject({ metadata: { expectedVersion: 1 } })
  const saved = { ...member, name: '佐藤 花子', version: 2 }
  const retry = createMemberNameClient([saved], auditItem ? [auditItem] : [])

  await expect(retry.client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '佐藤 花子', expectedVersion: 1 },
    createRenameAuditContext('rename-retry', '佐藤 花子'),
  )).resolves.toEqual(saved)
  expect(retry.inputs).toEqual([])

  await expect(retry.client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '佐藤 花子', expectedVersion: 1 },
    createRenameAuditContext('rename-other', '佐藤 花子'),
  )).rejects.toMatchObject({ status: 409, code: 'WorkspaceVersionConflict' })
  await expect(retry.client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '別の名前', expectedVersion: 1 },
    createRenameAuditContext('rename-retry', '別の名前'),
  )).rejects.toMatchObject({ status: 409, code: 'WorkspaceIdempotencyConflict' })

  // After a later change, the same key with another name is still refused, not taken as saved.
  const later = createMemberNameClient([{ ...saved, name: '後の名前', version: 3 }], auditItem ? [auditItem] : [])
  await expect(later.client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '別の名前', expectedVersion: 1 },
    createRenameAuditContext('rename-retry', '別の名前'),
  )).rejects.toMatchObject({ status: 409, code: 'WorkspaceIdempotencyConflict' })
})

test('binds the idempotency key of an unchanged-name request to its input', async () => {
  const member = { ...createWorkspaceMember('sato@example.com', 'member'), name: '佐藤' }
  const first = createMemberNameClient([member])
  await first.client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '佐藤', expectedVersion: 1 },
    createRenameAuditContext('same-key', '佐藤'),
  )
  const transactItems = first.inputs[0]?.TransactItems
  const auditPut = Array.isArray(transactItems) ? transactItems[1] : undefined
  const auditItem = typeof auditPut === 'object' && auditPut !== null && 'Put' in auditPut
    ? auditPut.Put.Item
    : undefined
  expect(auditItem).toMatchObject({ metadata: { expectedVersion: 1, unchanged: true } })
  const recorded = createMemberNameClient([member], auditItem ? [auditItem] : [])

  // The same request again is answered as before.
  await expect(recorded.client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '佐藤', expectedVersion: 1 },
    createRenameAuditContext('same-key', '佐藤'),
  )).resolves.toEqual(member)
  // The same key with another name is refused instead of renaming the member.
  await expect(recorded.client.updateMemberName(
    workspaceId,
    member.memberKey,
    member.memberKey,
    { name: '別の名前', expectedVersion: 1 },
    createRenameAuditContext('same-key', '別の名前'),
  )).rejects.toMatchObject({ status: 409, code: 'WorkspaceIdempotencyConflict' })
})

test('lists every member row, deactivated members included, for name readers', async () => {
  const active = createWorkspaceMember('sato@example.com', 'member')
  const deactivated = { ...createWorkspaceMember('suzuki@example.com', 'member', 'deactivated'), name: '鈴木 改名' }
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient(() => ({ Items: [toMemberItem(active), toMemberItem(deactivated)] })),
    undefined,
    false,
    () => now,
  )

  expect((await client.listMembers(workspaceId)).map((member) => [member.memberKey, member.status, member.name]))
    .toEqual([
      ['sato@example.com', 'active', undefined],
      ['suzuki@example.com', 'deactivated', '鈴木 改名'],
    ])
  expect((await client.listActiveMembers(workspaceId)).map((member) => member.memberKey)).toEqual(['sato@example.com'])
})

test('records a new sign-in without changing the member version, keeping a later time and ignoring others', async () => {
  const inputs: Array<Record<string, unknown>> = []
  let refused = false
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      if (refused) {
        throw Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        })
      }
      return {}
    }),
    undefined,
    false,
    () => now,
  )

  await client.recordMemberSignIn(workspaceId, 'Sato@Example.com')
  refused = true
  await expect(client.recordMemberSignIn(workspaceId, 'gone@example.com')).resolves.toBeUndefined()

  expect(inputs[0]).toEqual({
    TableName: 'WorkspaceAccessTable',
    Key: { workspaceId, recordKey: 'MEMBER#sato@example.com' },
    UpdateExpression: 'SET lastSignedInAt = :now',
    ConditionExpression:
      'attribute_exists(recordKey) AND #status = :active AND ' +
      '(attribute_not_exists(lastSignedInAt) OR lastSignedInAt < :now)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':active': 'active', ':now': now.toISOString() },
  })
})

test('shows the last sign-in in the access snapshot to owners and admins only', async () => {
  const signedInAt = '2026-07-10T09:30:00.000Z'
  const createClient = (actorRole: WorkspaceMember['role']) => new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient(() => ({
      Items: [
        toMemberItem(createWorkspaceMember('demo@example.com', actorRole)),
        { ...toMemberItem(createWorkspaceMember('sato@example.com', 'member')), lastSignedInAt: signedInAt },
        { ...toMemberItem(createWorkspaceMember('suzuki@example.com', 'member')), lastSignedInAt: 'yesterday' },
      ],
    })),
    undefined,
    false,
    () => now,
  )
  const lastSignIns = async (actorRole: WorkspaceMember['role']) =>
    (await createClient(actorRole).getAccessSnapshot(workspaceId, 'demo@example.com')).members
      .map((member) => [member.memberKey, member.lastSignedInAt])
  const administratorRoles: WorkspaceMember['role'][] = ['owner', 'admin']
  const otherRoles: WorkspaceMember['role'][] = ['member', 'guest']

  for (const role of administratorRoles) {
    expect(await lastSignIns(role)).toEqual([
      ['demo@example.com', undefined],
      ['sato@example.com', signedInAt],
      // A malformed stored value reads as no record instead of failing the list.
      ['suzuki@example.com', undefined],
    ])
  }
  for (const role of otherRoles) {
    expect((await lastSignIns(role)).every(([, value]) => value === undefined)).toBe(true)
  }
  // Other readers of member rows never carry the time.
  expect(await createClient('owner').getActiveMember(workspaceId, 'sato@example.com'))
    .not.toHaveProperty('lastSignedInAt')
})
