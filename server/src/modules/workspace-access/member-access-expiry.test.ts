import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../documents/adapter-out/dynamodb/document-authorization'
import {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  type WorkspaceMember,
} from './workspace-access'
import {
  canMemberAccessExpire,
  isMemberAccessExpired,
  isWorkspaceMemberRowActive,
  readMemberAccessExpiry,
} from './domain/member-access-expiry'
import {
  createMemberAccessExpiryAuditContext,
  deactivateExpiredMembers,
  type MemberAccessExpiryPorts,
} from './application/member-access-expiry'

const workspaceId = 'user#demo@example.com'
const now = new Date('2026-11-24T00:00:00.000Z')

/** Recorded DynamoDB command. */
type RecordedCommand = {
  /** Command class name. */
  name: string
  /** Command input. */
  input: Record<string, unknown>
}

/**
 * Builds a stored member row.
 *
 * @param memberKey - Member key.
 * @param overrides - Fields replacing the defaults.
 * @returns A member row as DynamoDB returns it.
 */
function memberItem(memberKey: string, overrides: Partial<WorkspaceMember> = {}) {
  return {
    workspaceId,
    recordKey: `MEMBER#${memberKey}`,
    entryType: 'workspace-member',
    id: memberKey,
    memberKey,
    email: memberKey,
    role: 'guest',
    status: 'active',
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Creates a Workspace access client over a scripted document client.
 *
 * @param items - Member rows by member key.
 * @param commands - Receives every command sent.
 * @param onTransact - Optional transaction handler.
 * @returns The client.
 */
function createClient(
  items: Record<string, Record<string, unknown>>,
  commands: RecordedCommand[],
  onTransact?: (input: Record<string, unknown>) => unknown,
) {
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push({ name: command.constructor.name, input: command.input })
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key
        const recordKey = typeof key === 'object' && key !== null && 'recordKey' in key ? key.recordKey : ''
        const memberKey = String(recordKey).replace(/^MEMBER#/u, '')
        return { Item: items[memberKey] }
      }
      if (command.constructor.name === 'QueryCommand' || command.constructor.name === 'ScanCommand') {
        return { Items: Object.values(items) }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        return onTransact?.(command.input) ?? {}
      }
      return {}
    },
  }
  return new DynamoDbWorkspaceAccessClient(
    'WorkspaceAccessTable',
    // The scripted client answers only the commands the adapter sends.
    documentClient as unknown as DynamoDBDocumentClient,
    undefined,
    false,
    () => now,
    'PlanningTable',
    null,
    undefined,
    new DynamoDbDocumentAuthorizationRevisionMutationAdapter('DocumentsTable'),
  )
}

test('reads an access expiry only as a future timestamp within the allowed window', () => {
  expect(readMemberAccessExpiry('2026-12-31T15:00:00.000Z', now)).toBe('2026-12-31T15:00:00.000Z')
  expect(readMemberAccessExpiry('2026-12-31T15:00:00+09:00', now)).toBe('2026-12-31T06:00:00.000Z')
  expect(readMemberAccessExpiry(null, now)).toBeUndefined()
  expect(() => readMemberAccessExpiry('2026-11-23T00:00:00.000Z', now)).toThrow(RangeError)
  expect(() => readMemberAccessExpiry('2026-12-31', now)).toThrow(RangeError)
  expect(() => readMemberAccessExpiry('2040-01-01T00:00:00.000Z', now)).toThrow(RangeError)
  expect(() => readMemberAccessExpiry(1_800_000_000_000, now)).toThrow(RangeError)
})

test('treats a passed or unreadable expiry as expired and never expires an owner', () => {
  expect(isMemberAccessExpired({}, now)).toBe(false)
  expect(isMemberAccessExpired({ accessExpiresAt: '2026-11-24T00:00:00.000Z' }, now)).toBe(true)
  expect(isMemberAccessExpired({ accessExpiresAt: '2026-11-24T00:00:01.000Z' }, now)).toBe(false)
  expect(isMemberAccessExpired({ accessExpiresAt: 'not-a-date' }, now)).toBe(true)
  expect(canMemberAccessExpire('owner')).toBe(false)
  expect(canMemberAccessExpire('guest')).toBe(true)
})

test('treats a stored member row as active only while it is active and unexpired', () => {
  expect(isWorkspaceMemberRowActive({ status: 'active' }, now)).toBe(true)
  expect(isWorkspaceMemberRowActive({ status: 'deactivated' }, now)).toBe(false)
  expect(isWorkspaceMemberRowActive({ status: 'active', accessExpiresAt: '2026-11-24T00:00:01.000Z' }, now)).toBe(true)
  expect(isWorkspaceMemberRowActive({ status: 'active', accessExpiresAt: '2026-11-24T00:00:00.000Z' }, now)).toBe(false)
  // A malformed expiry fails closed.
  expect(isWorkspaceMemberRowActive({ status: 'active', accessExpiresAt: 0 }, now)).toBe(false)
  expect(isWorkspaceMemberRowActive({ status: 'active', accessExpiresAt: 'soon' }, now)).toBe(false)
})

test('refuses sign-in and membership checks for a member whose access expired', async () => {
  const commands: RecordedCommand[] = []
  const client = createClient({
    'guest@example.com': memberItem('guest@example.com', { accessExpiresAt: '2026-11-23T23:00:00.000Z' }),
    'member@example.com': memberItem('member@example.com', {
      role: 'member',
      accessExpiresAt: '2026-12-01T00:00:00.000Z',
    }),
  }, commands)

  expect(await client.getActiveMember(workspaceId, 'guest@example.com')).toBeUndefined()
  expect((await client.getActiveMember(workspaceId, 'member@example.com'))?.accessExpiresAt)
    .toBe('2026-12-01T00:00:00.000Z')
  expect((await client.listActiveMembers(workspaceId)).map((member) => member.memberKey))
    .toEqual(['member@example.com'])
  await expect(client.reconcileAuthenticatedMember(workspaceId, {
    memberKey: 'guest@example.com',
    email: 'guest@example.com',
  })).rejects.toMatchObject({ status: 403, code: 'WorkspaceMemberAccessExpired' })
})

test('sets an access expiry on a guest with an actor and version fenced update', async () => {
  const commands: RecordedCommand[] = []
  const client = createClient({
    'demo@example.com': memberItem('demo@example.com', { role: 'owner', version: 1 }),
    'guest@example.com': memberItem('guest@example.com'),
  }, commands)

  const member = await client.updateMemberAccessExpiry(workspaceId, 'demo@example.com', 'guest@example.com', {
    accessExpiresAt: '2026-12-31T00:00:00.000Z',
    expectedVersion: 3,
  })

  expect(member).toMatchObject({ accessExpiresAt: '2026-12-31T00:00:00.000Z', version: 4 })
  const transaction = commands.find((command) => command.name === 'TransactWriteCommand')
  expect(transaction?.input.TransactItems).toEqual([
    {
      ConditionCheck: expect.objectContaining({
        Key: { workspaceId, recordKey: 'MEMBER#demo@example.com' },
      }),
    },
    {
      Update: expect.objectContaining({
        Key: { workspaceId, recordKey: 'MEMBER#guest@example.com' },
        UpdateExpression: 'SET accessExpiresAt = :accessExpiresAt, updatedAt = :now, version = version + :one',
        ConditionExpression:
          'attribute_exists(workspaceId) AND version = :expectedVersion AND #status = :active AND #role = :role',
        ExpressionAttributeValues: expect.objectContaining({
          ':accessExpiresAt': '2026-12-31T00:00:00.000Z',
          ':expectedVersion': 3,
          ':role': 'guest',
        }),
      }),
    },
  ])
})

test('refuses an access expiry on an owner, on oneself, and from an admin for an admin', async () => {
  const commands: RecordedCommand[] = []
  const client = createClient({
    'demo@example.com': memberItem('demo@example.com', { role: 'owner', version: 1 }),
    'admin@example.com': memberItem('admin@example.com', { role: 'admin', version: 1 }),
    'owner2@example.com': memberItem('owner2@example.com', { role: 'owner' }),
  }, commands)
  const input = { accessExpiresAt: '2026-12-31T00:00:00.000Z', expectedVersion: 3 }

  await expect(client.updateMemberAccessExpiry(workspaceId, 'demo@example.com', 'owner2@example.com', input))
    .rejects.toMatchObject({ code: 'WorkspaceMemberAccessExpiryNotAllowed' })
  await expect(client.updateMemberAccessExpiry(workspaceId, 'demo@example.com', 'demo@example.com', {
    ...input,
    expectedVersion: 1,
  })).rejects.toMatchObject({ code: 'WorkspaceMemberAccessExpiryNotAllowed' })
  await expect(client.updateMemberAccessExpiry(workspaceId, 'admin@example.com', 'owner2@example.com', input))
    .rejects.toMatchObject({ code: 'WorkspaceRoleDenied' })
  expect(commands.some((command) => command.name === 'TransactWriteCommand')).toBe(false)
})

test('deactivates an expired member fenced by Planning and Document revisions', async () => {
  const commands: RecordedCommand[] = []
  const client = createClient({
    'guest@example.com': memberItem('guest@example.com', { accessExpiresAt: '2026-11-23T00:00:00.000Z' }),
  }, commands)

  const member = await client.expireMember(workspaceId, 'guest@example.com', {
    expectedVersion: 3,
    expectedPlanningRevision: 7,
    expectedDocumentAuthorizationRevision: 2,
  })

  expect(member).toMatchObject({
    status: 'deactivated',
    deactivatedAt: now.toISOString(),
    signInsRevokedAt: now.toISOString(),
    version: 4,
  })
  const items = commands.find((command) => command.name === 'TransactWriteCommand')?.input.TransactItems
  expect(Array.isArray(items) ? items.length : 0).toBe(3)
  expect(items).toEqual([
    {
      Update: expect.objectContaining({
        Key: { workspaceId, recordKey: 'MEMBER#guest@example.com' },
        ConditionExpression: expect.stringContaining('accessExpiresAt <= :now'),
      }),
    },
    { Put: expect.objectContaining({ TableName: 'PlanningTable' }) },
    { Put: expect.objectContaining({ TableName: 'DocumentsTable' }) },
  ])
})

test('leaves a member whose expiry was cleared or moved out alone', async () => {
  const commands: RecordedCommand[] = []
  const client = createClient({
    'guest@example.com': memberItem('guest@example.com', { accessExpiresAt: '2026-12-23T00:00:00.000Z' }),
    'member@example.com': memberItem('member@example.com', { role: 'member' }),
  }, commands)
  const fences = { expectedVersion: 3, expectedPlanningRevision: 7, expectedDocumentAuthorizationRevision: 2 }

  expect(await client.expireMember(workspaceId, 'guest@example.com', fences)).toBeUndefined()
  expect(await client.expireMember(workspaceId, 'member@example.com', fences)).toBeUndefined()
  expect(commands.some((command) => command.name === 'TransactWriteCommand')).toBe(false)
})

test('classifies a Planning revision change during the expiry deactivation as a conflict', async () => {
  const commands: RecordedCommand[] = []
  const client = createClient({
    'guest@example.com': memberItem('guest@example.com', { accessExpiresAt: '2026-11-23T00:00:00.000Z' }),
  }, commands, () => {
    const error = new Error('transaction canceled')
    error.name = 'TransactionCanceledException'
    Object.assign(error, {
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    })
    throw error
  })

  await expect(client.expireMember(workspaceId, 'guest@example.com', {
    expectedVersion: 3,
    expectedPlanningRevision: 7,
    expectedDocumentAuthorizationRevision: 2,
  })).rejects.toMatchObject({ status: 409, code: 'PlanningRevisionConflict' })
})

/**
 * Builds expiry job ports over in-memory state.
 *
 * @param members - Expiring members the job lists.
 * @param options - Blockers and failures to simulate.
 * @returns The ports and the deactivations they recorded.
 */
function createExpiryPorts(
  members: Array<{ workspaceId: string; member: WorkspaceMember }>,
  options: {
    /** Members that still manage a Project. */
    managers?: readonly string[]
    /** Members that own an unarchived Planning entity. */
    planningOwners?: readonly string[]
    /** Members that are the last manager of a private Document. */
    documentManagers?: readonly string[]
    /** Error the deactivation throws for a member. */
    failures?: Readonly<Record<string, Error>>
  } = {},
) {
  const deactivations: Array<{ memberKey: string; input: unknown; idempotencyKey?: string }> = []
  const ports: MemberAccessExpiryPorts = {
    workspaceAccess: {
      async listMembersWithAccessExpiringBefore() {
        return members
      },
      async listActiveMembers() {
        return [{ memberKey: 'demo@example.com', role: 'owner' }]
      },
      async expireMember(_workspaceId, memberKey, input, auditContext) {
        const failure = options.failures?.[memberKey]
        if (failure) throw failure
        deactivations.push({ memberKey, input, idempotencyKey: auditContext?.idempotencyKeyHash })
        const member = members.find((candidate) => candidate.member.memberKey === memberKey)?.member
        return member ? { ...member, status: 'deactivated' } : undefined
      },
    },
    documents: {
      async getAuthorizationRevision() {
        return 5
      },
      async getManagerLifecycleSnapshot(_workspaceId, memberKey) {
        return {
          authorizationRevision: 5,
          ...(options.documentManagers?.includes(memberKey) ? { blockingDocumentId: 'document-1' } : {}),
        }
      },
    },
    planning: {
      async getAuthorizationState() {
        return {
          revision: 9,
          entities: (options.planningOwners ?? []).map((ownerMemberKey) => ({ ownerMemberKey })),
        }
      },
    },
    projectManagerGuard: {
      async hasManagedProject(_workspaceId, memberKey) {
        return options.managers?.includes(memberKey) ?? false
      },
    },
    now: () => now,
  }
  return { ports, deactivations }
}

/**
 * Builds an expired guest.
 *
 * @param memberKey - Member key.
 * @returns The member.
 */
function expiredGuest(memberKey: string): WorkspaceMember {
  return {
    id: memberKey,
    memberKey,
    email: memberKey,
    role: 'guest',
    status: 'active',
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    accessExpiresAt: '2026-11-23T00:00:00.000Z',
  }
}

test('deactivates expired members and leaves those who still manage or own something', async () => {
  const { ports, deactivations } = createExpiryPorts([
    { workspaceId, member: expiredGuest('free@example.com') },
    { workspaceId, member: expiredGuest('manager@example.com') },
    { workspaceId, member: expiredGuest('owner@example.com') },
    { workspaceId, member: expiredGuest('documents@example.com') },
  ], {
    managers: ['manager@example.com'],
    planningOwners: ['owner@example.com'],
    documentManagers: ['documents@example.com'],
  })

  const result = await deactivateExpiredMembers(ports)

  expect(result).toEqual({
    deactivated: 1,
    blocked: [
      { workspaceId, blocker: 'manages-projects' },
      { workspaceId, blocker: 'owns-planning-entities' },
      { workspaceId, blocker: 'manages-private-documents' },
    ],
    deferred: 0,
  })
  expect(deactivations).toEqual([{
    memberKey: 'free@example.com',
    input: { expectedVersion: 2, expectedPlanningRevision: 9, expectedDocumentAuthorizationRevision: 5 },
    idempotencyKey: createMemberAccessExpiryAuditContext(workspaceId, expiredGuest('free@example.com'))
      .idempotencyKeyHash,
  }])
})

test('defers conflicts and closing tenants, and fails the run after trying every member', async () => {
  const { ports, deactivations } = createExpiryPorts([
    { workspaceId, member: expiredGuest('changed@example.com') },
    { workspaceId, member: expiredGuest('closing@example.com') },
    { workspaceId, member: expiredGuest('broken@example.com') },
    { workspaceId, member: expiredGuest('free@example.com') },
  ], {
    failures: {
      'changed@example.com': new WorkspaceAccessError(409, 'WorkspaceVersionConflict', 'changed'),
      'closing@example.com': new WorkspaceAccessError(403, 'TenantClosing', 'closing'),
      'broken@example.com': new Error('throttled'),
    },
  })

  await expect(deactivateExpiredMembers(ports)).rejects.toThrow('throttled')
  expect(deactivations.map((deactivation) => deactivation.memberKey)).toEqual(['free@example.com'])
})

test('keys the expiry audit event by the member and the expiry it acted on, without the email', () => {
  const first = createMemberAccessExpiryAuditContext(workspaceId, expiredGuest('guest@example.com'))
  const again = createMemberAccessExpiryAuditContext(workspaceId, expiredGuest('guest@example.com'))
  const moved = createMemberAccessExpiryAuditContext(workspaceId, {
    ...expiredGuest('guest@example.com'),
    accessExpiresAt: '2026-11-20T00:00:00.000Z',
  })

  expect(first.idempotencyKeyHash).toBe(again.idempotencyKeyHash)
  expect(first.idempotencyKeyHash).not.toBe(moved.idempotencyKeyHash)
  expect(first.source.requestId).not.toContain('guest@example.com')
  expect(first.actor).toMatchObject({ kind: 'system', id: 'system:member-access-expiry' })
})
