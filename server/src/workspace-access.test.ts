import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  isWorkspaceIdentitySafeToDelete,
  type WorkspaceMember,
} from './workspace-access'

const workspaceId = 'user#demo@example.com'
const now = new Date('2026-07-11T00:00:00.000Z')

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
    expectedVersion: 1,
    failureMessage: 'Email delivery failed.',
  })).resolves.toMatchObject({
    status: 'delivery-failed',
    deliveryStatus: 'failed',
    identityOwnership: 'ambiguous',
    failureMessage: 'Email delivery failed.',
    version: 2,
  })
  expect(inputs[1]).toMatchObject({
    ConditionExpression: 'version = :expectedVersion AND #status IN (:status0, :status1, :status2)',
    Item: {
      status: 'delivery-failed',
      identityOwnership: 'ambiguous',
    },
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

test('clears the cleanup retry marker only after Cognito deletion succeeds', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const client = new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    createDocumentClient((command) => {
      inputs.push(command.input)
      return command.constructor.name === 'GetCommand'
        ? {
            Item: {
              ...createInvitationItem('revoked'),
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
  expect(inputs.at(-1)).toMatchObject({
    ConditionExpression: 'version = :expectedVersion AND #status IN (:status0)',
    Item: { status: 'revoked' },
  })
  const clearedItem = inputs.at(-1)?.Item as Record<string, unknown> | undefined
  expect(clearedItem?.failureMessage).toBeUndefined()
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
    ],
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

      const error = new Error('canceled')
      error.name = 'TransactionCanceledException'
      throw error
    }),
  )

  await expect(client.updateMember(workspaceId, secondOwner.memberKey, owner.memberKey, {
    role: 'admin',
    expectedVersion: 1,
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
  const client = new DynamoDbWorkspaceAccessClient(
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

      const error = new Error('canceled')
      error.name = 'TransactionCanceledException'
      throw error
    }),
  )

  await expect(client.updateMember(workspaceId, actor.memberKey, original.memberKey, {
    role: 'guest',
    expectedVersion: 1,
  })).rejects.toMatchObject({
    status: 409,
    code: 'WorkspaceVersionConflict',
  })
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
      const error = new Error('unknown transaction outcome')
      error.name = 'TransactionCanceledException'
      throw error
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

test('never marks pre-existing or ambiguous Cognito identities as safe to delete', () => {
  expect(isWorkspaceIdentitySafeToDelete('workspace-created')).toBe(true)
  expect(isWorkspaceIdentitySafeToDelete('pre-existing')).toBe(false)
  expect(isWorkspaceIdentitySafeToDelete('ambiguous')).toBe(false)
})

test('exposes WorkspaceAccessError status and code for API mapping', () => {
  const error = new WorkspaceAccessError(409, 'WorkspaceVersionConflict', 'conflict')
  expect(error).toMatchObject({ status: 409, code: 'WorkspaceVersionConflict' })
})
