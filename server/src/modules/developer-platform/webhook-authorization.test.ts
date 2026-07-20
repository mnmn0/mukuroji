import { expect, test } from 'bun:test'
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  EnterpriseIdentitySnapshot,
  EnterpriseRoleAssignment,
  EnterpriseSecurityPolicy,
  WebhookSubscription,
} from '@mukuroji/contracts'
import type { EnterpriseIdentityReadClient } from '../enterprise-identity/enterprise-identity'
import type { WorkspaceAccessClient, WorkspaceMember } from '../workspace-access/workspace-access'
import {
  AwsWebhookCognitoGroupsProvider,
  DynamoDbWebhookSubscriptionAuthorizer,
  type WebhookCognitoGroupsProvider,
} from './webhook-authorization'
import { createWebhookTeamGrantItem } from './webhook-authorization-projection'

test('allows only an active creator with a current role in an active Team project', async () => {
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ])

  expect(await authorizer.canDeliver('workspace-1', createSubscription(), 'team-1'))
    .toBe(true)
  expect(await authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
    'project-2',
  )).toBe(false)
  expect(await authorizer.canDeliver('workspace-1', createSubscription(), 'team-2'))
    .toBe(false)
})

test('fails closed after the creator loses project access or the Team is archived', async () => {
  const noRole = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
  ])
  const archived = createAuthorizer([
    { entryType: 'team', teamId: 'team-1', archivedAt: '2026-07-18T00:00:00.000Z' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'manager',
    },
  ])

  expect(await noRole.canDeliver('workspace-1', createSubscription(), 'team-1'))
    .toBe(false)
  expect(await archived.canDeliver('workspace-1', createSubscription(), 'team-1'))
    .toBe(false)
})

test('fails closed before policy reads when the subscription creator is no longer active', async () => {
  const calls = {
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 0,
    enterpriseReads: 0,
    groupReads: 0,
  }
  const authorizer = createAuthorizer(
    [{ entryType: 'team', teamId: 'team-1' }],
    calls,
    Number.POSITIVE_INFINITY,
    { member: null },
  )

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  expect(calls).toEqual({
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 1,
    enterpriseReads: 0,
    groupReads: 0,
  })
})

test('fails closed for an archived Project member row', async () => {
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'manager',
      archivedAt: '2026-07-18T00:00:00.000Z',
    },
  ])

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
    'project-1',
  )).resolves.toBe(false)
})

test('continues after 25 stale Team grants to find a current grant', async () => {
  const staleProjects = Array.from({ length: 25 }, (_, index) => ({
    entryType: 'project',
    teamId: 'team-1',
    projectId: `stale-${String(index).padStart(2, '0')}`,
  }))
  const staleMembers = staleProjects.map((project) => ({
    entryType: 'project-member',
    projectId: project.projectId,
    memberKey: 'creator-1',
    role: 'removed',
  }))
  const calls = {
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 0,
    teamGrantLimits: [] as number[],
    teamGrantConsistentReads: [] as boolean[],
  }
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    ...staleProjects,
    { entryType: 'project', teamId: 'team-1', projectId: 'valid-project' },
    ...staleMembers,
    {
      entryType: 'project-member',
      projectId: 'valid-project',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ], calls)

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(true)
  expect(calls.teamGrantLimits).toEqual([25, 25])
  expect(calls.teamGrantConsistentReads).toEqual([true, true])
})

test('fails closed after a repeated Team grant pagination token', async () => {
  const calls = {
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 0,
    teamGrantQueries: 0,
  }
  const authorizer = createAuthorizer(
    [{ entryType: 'team', teamId: 'team-1' }],
    calls,
    Number.POSITIVE_INFINITY,
    { grantPaginationMode: 'repeated-token' },
  )

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  expect(calls.teamGrantQueries).toBe(2)
  expect(calls.directoryQueries).toBe(3)
})

test('fails closed after 100 distinct Team grant pagination tokens', async () => {
  const calls = {
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 0,
    teamGrantQueries: 0,
  }
  const authorizer = createAuthorizer(
    [{ entryType: 'team', teamId: 'team-1' }],
    calls,
    Number.POSITIVE_INFINITY,
    { grantPaginationMode: 'unbounded-distinct' },
  )

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  expect(calls.teamGrantQueries).toBe(100)
  expect(calls.directoryQueries).toBe(101)
})

test('reuses the current ACL and Enterprise snapshot within one Lambda batch', async () => {
  const calls = {
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 0,
    enterpriseReads: 0,
    groupReads: 0,
    authoritativeConsistentReads: [] as boolean[],
    resourceQueryIndexes: [] as Array<string | undefined>,
  }
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'member',
    },
  ], calls)
  const batch = authorizer.createBatch()

  expect(batch).toBeDefined()
  await expect(Promise.all([
    batch!.canDeliver('workspace-1', createSubscription(), 'team-1'),
    batch!.canDeliver(
      'workspace-1',
      { ...createSubscription(), id: 'webhook-2' },
      'team-1',
      'project-1',
    ),
    batch!.canDeliver(
      'workspace-1',
      { ...createSubscription(), id: 'webhook-3' },
      'team-1',
    ),
  ])).resolves.toEqual([true, true, true])
  expect(calls).toEqual({
    authoritativeReads: 4,
    directoryQueries: 3,
    memberReads: 1,
    enterpriseReads: 1,
    groupReads: 1,
    authoritativeConsistentReads: [true, true, true, true],
    resourceQueryIndexes: [
      'WebhookAuthorizationIndex',
      'WebhookAuthorizationIndex',
    ],
  })
})

test('does not scan unrelated creator Project memberships for Team-only authorization', async () => {
  const calls = {
    authoritativeReads: 0,
    directoryQueries: 0,
    memberReads: 0,
    enterpriseReads: 0,
    groupReads: 0,
    teamGrantLimits: [] as number[],
    teamGrantConsistentReads: [] as boolean[],
    resourceQueryIndexes: [] as Array<string | undefined>,
  }
  const fillerRows = Array.from({ length: 10_001 }, (_, index) => ({
    entryType: 'project-member',
    projectId: `inaccessible-${index}`,
    memberKey: 'creator-1',
    role: 'removed',
  }))
  const authorizer = createAuthorizer([
    ...fillerRows,
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ], calls, 10_001)
  const batch = authorizer.createBatch()

  await expect(Promise.all([
    batch!.canDeliver('workspace-1', createSubscription(), 'team-1'),
    batch!.canDeliver(
      'workspace-1',
      { ...createSubscription(), id: 'webhook-large-2' },
      'team-1',
      'project-1',
    ),
  ])).resolves.toEqual([true, true])
  expect(calls.memberReads).toBe(1)
  expect(calls.enterpriseReads).toBe(1)
  expect(calls.groupReads).toBe(1)
  expect(calls.directoryQueries).toBe(3)
  expect(calls.authoritativeReads).toBe(4)
  expect(calls.teamGrantLimits).toEqual([25])
  expect(calls.teamGrantConsistentReads).toEqual([true])
  expect(calls.resourceQueryIndexes).toEqual([
    'WebhookAuthorizationIndex',
    'WebhookAuthorizationIndex',
  ])
})

test('uses strongly consistent grant source locators without cross-Team access', async () => {
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'team', teamId: 'team-2' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    { entryType: 'project', teamId: 'team-2', projectId: 'project-2' },
    {
      entryType: 'project-member',
      projectId: 'project-2',
      memberKey: 'creator-1',
      role: 'manager',
    },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'removed',
    },
  ])
  const subscription = {
    ...createSubscription(),
    teamIds: ['team-1', 'team-2'],
  }

  await expect(authorizer.canDeliver(
    'workspace-1',
    subscription,
    'team-1',
  )).resolves.toBe(false)
  await expect(authorizer.canDeliver(
    'workspace-1',
    subscription,
    'team-2',
    'project-2',
  )).resolves.toBe(true)
})

test('ignores a stale legacy ACL when current Enterprise authority lacks Team access', async () => {
  const snapshot = createEnterpriseSnapshot({
    roleAssignments: [createRoleAssignment({
      assignmentId: 'unrelated-project',
      roleId: 'project:viewer',
      scope: {
        workspaceId: 'workspace-1',
        kind: 'project',
        targetId: 'project-other',
      },
    })],
  })
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ], undefined, Number.POSITIVE_INFINITY, {
    readSnapshot: async () => snapshot,
  })

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
})

test('allows Enterprise-only work-items.read grants at Team and Project scope', async () => {
  const rows = [
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
  ]
  const teamAuthorizer = createAuthorizer(
    rows,
    undefined,
    Number.POSITIVE_INFINITY,
    {
      readSnapshot: async () => createEnterpriseSnapshot({
        roleAssignments: [createRoleAssignment({
          assignmentId: 'team-reader',
          roleId: 'team:member',
          scope: {
            workspaceId: 'workspace-1',
            kind: 'team',
            targetId: 'team-1',
          },
        })],
      }),
    },
  )
  const projectAuthorizer = createAuthorizer(
    rows,
    undefined,
    Number.POSITIVE_INFINITY,
    {
      readSnapshot: async () => createEnterpriseSnapshot({
        roleAssignments: [createRoleAssignment({
          assignmentId: 'project-reader',
          roleId: 'project:viewer',
          scope: {
            workspaceId: 'workspace-1',
            kind: 'project',
            targetId: 'project-1',
          },
        })],
      }),
    },
  )

  await expect(teamAuthorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(true)
  await expect(projectAuthorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
    'project-1',
  )).resolves.toBe(true)
})

test('denies a later delivery after the Enterprise CONTROL grant is revoked', async () => {
  let currentSnapshot = createEnterpriseSnapshot({
    controlRevision: 1,
    roleAssignments: [createRoleAssignment({
      assignmentId: 'team-reader',
      roleId: 'team:member',
      scope: {
        workspaceId: 'workspace-1',
        kind: 'team',
        targetId: 'team-1',
      },
    })],
  })
  const authorizer = createAuthorizer(
    [{ entryType: 'team', teamId: 'team-1' }],
    undefined,
    Number.POSITIVE_INFINITY,
    { readSnapshot: async () => currentSnapshot },
  )

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(true)
  currentSnapshot = createEnterpriseSnapshot({
    controlRevision: 2,
    roleAssignments: [],
  })
  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
})

test('denies a creator after applied SCIM deprovisioning', async () => {
  const timestamp = '2026-07-19T00:00:00.000Z'
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ], undefined, Number.POSITIVE_INFINITY, {
    readSnapshot: async () => createEnterpriseSnapshot({
      scimUsers: [{
        workspaceId: 'workspace-1',
        userId: 'scim-user-1',
        externalId: 'external-user-1',
        identityProviderId: 'idp-1',
        userName: 'creator@example.test',
        emails: ['creator@example.test'],
        active: false,
        linkedMemberKey: 'creator-1',
        groupIds: [],
        version: 2,
        appliedVersion: 2,
        appliedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    }),
  })

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
})

test('rechecks direct Cognito directory-group grants before every delivery', async () => {
  let groups = ['delivery-readers']
  const snapshot = createEnterpriseSnapshot({
    roleAssignments: [createRoleAssignment({
      assignmentId: 'cognito-team-reader',
      principalKind: 'directory-group',
      principalId: 'delivery-readers',
      roleId: 'team:member',
      scope: {
        workspaceId: 'workspace-1',
        kind: 'team',
        targetId: 'team-1',
      },
    })],
  })
  const authorizer = createAuthorizer(
    [{ entryType: 'team', teamId: 'team-1' }],
    undefined,
    Number.POSITIVE_INFINITY,
    {
      readSnapshot: async () => snapshot,
      readGroups: async () => groups,
    },
  )

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(true)
  groups = []
  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
})

test('loads all Cognito group pages and rejects a pagination cycle', async () => {
  const requestedTokens: Array<string | undefined> = []
  const client = {
    async send(command: { input: { NextToken?: string } }) {
      requestedTokens.push(command.input.NextToken)
      if (!command.input.NextToken) {
        return {
          Groups: [{ GroupName: 'group-a' }],
          NextToken: 'page-2',
        }
      }
      return {
        Groups: [{ GroupName: 'group-b' }, { GroupName: 'group-a' }],
      }
    },
  } as unknown as CognitoIdentityProviderClient
  const provider = new AwsWebhookCognitoGroupsProvider('pool-1', client)

  expect(() => new AwsWebhookCognitoGroupsProvider(' ', client))
    .toThrow('COGNITO_USER_POOL_ID is required')
  await expect(provider.getGroups('creator-1')).resolves.toEqual([
    'group-a',
    'group-b',
  ])
  expect(requestedTokens).toEqual([undefined, 'page-2'])

  const cyclingClient = {
    async send() {
      return { NextToken: 'same-token' }
    },
  } as unknown as CognitoIdentityProviderClient
  const cyclingProvider = new AwsWebhookCognitoGroupsProvider(
    'pool-1',
    cyclingClient,
  )
  await expect(cyclingProvider.getGroups('creator-1')).rejects.toThrow(
    'pagination token repeated',
  )
})

test('enforces external guest, collaborator, and permission-ceiling policy', async () => {
  const teamRows = [{ entryType: 'team', teamId: 'team-1' }]
  const deniedGuest = createAuthorizer(
    teamRows,
    undefined,
    Number.POSITIVE_INFINITY,
    {
      member: createWorkspaceMember({
        email: 'guest@partner.test',
        role: 'guest',
      }),
      readSnapshot: async () => createEnterpriseSnapshot({
        policy: createEnterprisePolicy({
          allowGuests: false,
        }),
      }),
    },
  )
  const deniedCollaborator = createAuthorizer(
    teamRows,
    undefined,
    Number.POSITIVE_INFINITY,
    {
      member: createWorkspaceMember({
        email: 'creator@partner.test',
        role: 'member',
      }),
      readSnapshot: async () => createEnterpriseSnapshot({
        domains: [{
          workspaceId: 'workspace-1',
          domainId: 'domain-1',
          domain: 'company.test',
          status: 'verified',
          enforceSso: false,
          verificationRecordName: '_mukuroji.company.test',
          verifiedAt: '2026-07-19T00:00:00.000Z',
          revision: 1,
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
        }],
        policy: createEnterprisePolicy({
          allowExternalCollaborators: false,
        }),
      }),
    },
  )
  const ceilingDenied = createAuthorizer(
    teamRows,
    undefined,
    Number.POSITIVE_INFINITY,
    {
      member: createWorkspaceMember({
        email: 'guest@partner.test',
        role: 'guest',
      }),
      readSnapshot: async () => createEnterpriseSnapshot({
        policy: createEnterprisePolicy({
          permissionCeiling: ['workspace.read', 'teams.read'],
        }),
      }),
    },
  )

  await expect(deniedGuest.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  await expect(deniedCollaborator.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  await expect(ceilingDenied.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
})

test('fails closed when Enterprise, Cognito, or ProjectDirectory reads fail', async () => {
  const rows = [{ entryType: 'team', teamId: 'team-1' }]
  const enterpriseFailure = createAuthorizer(
    rows,
    undefined,
    Number.POSITIVE_INFINITY,
    {
      readSnapshot: async () => {
        throw new Error('Enterprise unavailable')
      },
    },
  )
  const cognitoFailure = createAuthorizer(
    rows,
    undefined,
    Number.POSITIVE_INFINITY,
    {
      readGroups: async () => {
        throw new Error('Cognito unavailable')
      },
    },
  )
  const directoryFailure = createAuthorizer(
    rows,
    undefined,
    Number.POSITIVE_INFINITY,
    { failDirectory: true },
  )

  await expect(enterpriseFailure.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  await expect(cognitoFailure.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
  await expect(directoryFailure.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(false)
})

test('keeps current ProjectDirectory ACL fallback for a legacy Workspace', async () => {
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    { entryType: 'project', teamId: 'team-1', projectId: 'project-1' },
    {
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
  ])

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
  )).resolves.toBe(true)
})

test('does not let system administrator status bypass an inactive Project', async () => {
  const authorizer = createAuthorizer([
    { entryType: 'team', teamId: 'team-1' },
    {
      entryType: 'project',
      teamId: 'team-1',
      projectId: 'project-1',
      archivedAt: '2026-07-19T00:00:00.000Z',
    },
  ], undefined, Number.POSITIVE_INFINITY, {
    readGroups: async () => ['system-admins'],
    systemAdminGroups: ['system-admins'],
  })

  await expect(authorizer.canDeliver(
    'workspace-1',
    createSubscription(),
    'team-1',
    'project-1',
  )).resolves.toBe(false)
})

/** Test double の current-state read 回数です。 */
type AuthorizerTestCalls = {
  /** ProjectDirectory base-table Get 回数です。 */
  authoritativeReads: number
  /** ProjectDirectory Query 回数です。 */
  directoryQueries: number
  /** Workspace membership read 回数です。 */
  memberReads: number
  /** Enterprise CONTROL snapshot read 回数です。 */
  enterpriseReads?: number
  /** Cognito group 全ページ read 回数です。 */
  groupReads?: number
  /** Legacy Team grant Query 回数です。 */
  teamGrantQueries?: number
  /** Base-table Get が強整合だったかどうかです。 */
  authoritativeConsistentReads?: boolean[]
  /** Legacy Team grant Query の Limit 一覧です。 */
  teamGrantLimits?: number[]
  /** Legacy Team grant Query の ConsistentRead 一覧です。 */
  teamGrantConsistentReads?: boolean[]
  /** Resource locator GSI Query の index 名一覧です。 */
  resourceQueryIndexes?: Array<string | undefined>
}

/** Authorizer test double の current-state override です。 */
type AuthorizerTestOptions = {
  /** Active Workspace member。null は deactivated/missing member です。 */
  member?: WorkspaceMember | null
  /** Current Enterprise snapshot を返す reader override です。 */
  readSnapshot?: () => Promise<EnterpriseIdentitySnapshot>
  /** Current Cognito groups を返す reader override です。 */
  readGroups?: () => Promise<string[]>
  /** ProjectDirectory dependency failure を発生させるかどうかです。 */
  failDirectory?: boolean
  /** Legacy Team grant Query の異常 pagination response です。 */
  grantPaginationMode?: 'repeated-token' | 'unbounded-distinct'
  /** System administrator とみなす group names です。 */
  systemAdminGroups?: string[]
}

function createAuthorizer(
  rows: Record<string, unknown>[],
  calls?: AuthorizerTestCalls,
  pageSize = Number.POSITIVE_INFINITY,
  options: AuthorizerTestOptions = {},
) {
  const defaultMember = {
    id: 'member-1',
    memberKey: 'creator-1',
    email: 'creator@example.test',
    role: 'admin',
    status: 'active',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } satisfies WorkspaceMember
  const workspaceAccess = {
    async getActiveMember() {
      if (calls) calls.memberReads += 1
      return options.member === undefined ? defaultMember : options.member ?? undefined
    },
  } as unknown as WorkspaceAccessClient
  const sourceRows = rows.map((row, index) => withAuthorizationProjection(row, index))
  const teams = new Map<string, typeof sourceRows[number]>()
  for (const row of sourceRows) {
    if (row.entryType === 'team' && typeof row.teamId === 'string') {
      teams.set(row.teamId, row)
    }
  }
  const projectSources = new Map<string, Array<{
    teamId: string
    teamSourceEntryKey: string
    projectSourceEntryKey: string
  }>>()
  for (const row of sourceRows) {
    if (
      row.entryType === 'project' &&
      typeof row.projectId === 'string' &&
      typeof row.teamId === 'string' &&
      row.archivedAt === undefined
    ) {
      const team = teams.get(row.teamId)
      if (!team) continue
      projectSources.set(row.projectId, [
        ...(projectSources.get(row.projectId) ?? []),
        {
          teamId: row.teamId,
          teamSourceEntryKey: team.entryKey,
          projectSourceEntryKey: row.entryKey,
        },
      ])
    }
  }
  const grantRows = sourceRows.flatMap((row) => {
    if (
      row.entryType !== 'project-member' ||
      typeof row.projectId !== 'string' ||
      typeof row.memberKey !== 'string'
    ) {
      return []
    }
    return (projectSources.get(row.projectId) ?? []).map((source) =>
      createWebhookTeamGrantItem({
        workspaceId: 'workspace-1',
        teamId: source.teamId,
        projectId: row.projectId as string,
        memberKey: row.memberKey as string,
        teamSourceEntryKey: source.teamSourceEntryKey,
        projectSourceEntryKey: source.projectSourceEntryKey,
      })
    )
  })
  const storedRows: Array<Record<string, unknown> & {
    directoryId: string
    entryKey: string
  }> = [...sourceRows, ...grantRows]
  const storedRowsByKey = new Map(storedRows.map((row) => [
    `${row.directoryId}\0${row.entryKey}`,
    row,
  ]))
  let teamGrantQueryCount = 0
  const documentClient = {
    async send(command: {
      constructor: { name: string }
      input: Record<string, unknown>
    }) {
      if (options.failDirectory) {
        throw new Error('ProjectDirectory unavailable')
      }
      if (command.constructor.name === 'GetCommand') {
        if (calls) calls.authoritativeReads += 1
        calls?.authoritativeConsistentReads?.push(
          command.input.ConsistentRead === true,
        )
        const key = command.input.Key as { directoryId?: string; entryKey?: string }
        return {
          Item: storedRowsByKey.get(`${key.directoryId}\0${key.entryKey}`),
        }
      }
      if (command.constructor.name !== 'QueryCommand') {
        throw new Error(`Unexpected command: ${command.constructor.name}`)
      }
      if (calls) calls.directoryQueries += 1
      const values = command.input.ExpressionAttributeValues as Record<string, string>
      const isGrantQuery =
        values[':grantDirectoryId']?.startsWith('WEBHOOK_TEAM_GRANT#')
      if (isGrantQuery) {
        teamGrantQueryCount += 1
        if (calls?.teamGrantQueries !== undefined) calls.teamGrantQueries += 1
        calls?.teamGrantLimits?.push(command.input.Limit as number)
        calls?.teamGrantConsistentReads?.push(command.input.ConsistentRead === true)
        if (options.grantPaginationMode) {
          return {
            Count: 0,
            Items: [],
            LastEvaluatedKey: {
              directoryId: values[':grantDirectoryId'],
              entryKey: options.grantPaginationMode === 'repeated-token'
                ? 'REPEATED'
                : `PAGE#${teamGrantQueryCount}`,
            },
          }
        }
      } else {
        calls?.resourceQueryIndexes?.push(command.input.IndexName as string | undefined)
      }
      const matching = storedRows.filter((row) => isGrantQuery
        ? row.directoryId === values[':grantDirectoryId'] &&
          typeof row.entryKey === 'string' &&
          row.entryKey.startsWith(values[':grantEntryKeyPrefix'])
        : row.webhookAuthorizationKey === values[':authorizationKey'] &&
          (
            values[':authorizationSortKey'] === undefined ||
            row.webhookAuthorizationSortKey === values[':authorizationSortKey']
          )
      )
      const startKey = command.input.ExclusiveStartKey as { entryKey?: string } | undefined
      const startIndex = startKey?.entryKey
        ? matching.findIndex((row) => row.entryKey === startKey.entryKey) + 1
        : 0
      const requestedLimit = typeof command.input.Limit === 'number'
        ? command.input.Limit
        : Number.POSITIVE_INFINITY
      const page = matching.slice(
        startIndex,
        startIndex + Math.min(pageSize, requestedLimit),
      )
      const hasNextPage = startIndex + page.length < matching.length
      return {
        Count: page.length,
        Items: isGrantQuery
          ? page
          : page.map((row) => ({
              directoryId: row.directoryId,
              entryKey: row.entryKey,
            })),
        ...(hasNextPage && page.at(-1)
          ? {
              LastEvaluatedKey: {
                directoryId: page.at(-1)!.directoryId,
                entryKey: page.at(-1)!.entryKey,
                webhookAuthorizationKey:
                  page.at(-1)!.webhookAuthorizationKey,
                webhookAuthorizationSortKey:
                  page.at(-1)!.webhookAuthorizationSortKey,
              },
            }
          : {}),
      }
    },
  } as unknown as DynamoDBDocumentClient
  const enterpriseIdentity = {
    async getSnapshot() {
      if (calls?.enterpriseReads !== undefined) calls.enterpriseReads += 1
      return options.readSnapshot
        ? await options.readSnapshot()
        : createEnterpriseSnapshot()
    },
  } as unknown as EnterpriseIdentityReadClient
  const cognitoGroups = {
    async getGroups() {
      if (calls?.groupReads !== undefined) calls.groupReads += 1
      return options.readGroups ? await options.readGroups() : []
    },
  } satisfies WebhookCognitoGroupsProvider
  return new DynamoDbWebhookSubscriptionAuthorizer({
    workspaceAccess,
    enterpriseIdentity,
    documentClient,
    projectDirectoryTableName: 'project-directory-test',
    cognitoGroups,
    authorizationIndexName: 'WebhookAuthorizationIndex',
    systemAdminGroups: options.systemAdminGroups ?? ['mukuroji-system-admins'],
  })
}

function withAuthorizationProjection(
  row: Record<string, unknown>,
  index: number,
): Record<string, unknown> & {
  directoryId: string
  entryKey: string
} {
  const directoryId = 'workspace-1'
  const entryType = row.entryType
  if (entryType === 'team' && typeof row.teamId === 'string') {
    return {
      directoryId,
      entryKey: `TEAM#${index}`,
      webhookAuthorizationKey: `WEBHOOK_ACL#RESOURCE#${directoryId}`,
      webhookAuthorizationSortKey: `TEAM#${row.teamId}`,
      ...row,
    }
  }
  if (entryType === 'project' && typeof row.projectId === 'string') {
    return {
      directoryId,
      entryKey: `PROJECT#${index}`,
      webhookAuthorizationKey: `WEBHOOK_ACL#RESOURCE#${directoryId}`,
      webhookAuthorizationSortKey: `PROJECT#${row.projectId}`,
      ...row,
    }
  }
  if (
    entryType === 'project-member' &&
    typeof row.projectId === 'string' &&
    typeof row.memberKey === 'string'
  ) {
    return {
      directoryId,
      entryKey: `PROJECT_MEMBER#${row.projectId}#${row.memberKey}`,
      webhookAuthorizationKey:
        `WEBHOOK_ACL#MEMBER#${directoryId}#${row.memberKey}`,
      webhookAuthorizationSortKey: `PROJECT#${row.projectId}`,
      ...row,
    }
  }
  return { directoryId, entryKey: `OTHER#${index}`, ...row }
}

function createRoleAssignment(
  overrides: Partial<EnterpriseRoleAssignment> = {},
): EnterpriseRoleAssignment {
  return {
    workspaceId: 'workspace-1',
    assignmentId: 'assignment-1',
    principalKind: 'member',
    principalId: 'creator-1',
    roleId: 'team:member',
    scope: {
      workspaceId: 'workspace-1',
      kind: 'team',
      targetId: 'team-1',
    },
    source: 'direct',
    ...overrides,
  }
}

function createWorkspaceMember(
  overrides: Partial<WorkspaceMember> = {},
): WorkspaceMember {
  return {
    id: 'member-1',
    memberKey: 'creator-1',
    email: 'creator@example.test',
    role: 'admin',
    status: 'active',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function createEnterprisePolicy(
  externalOverrides: Partial<EnterpriseSecurityPolicy['externalAccess']> = {},
): EnterpriseSecurityPolicy {
  const timestamp = '2026-07-19T00:00:00.000Z'
  return {
    workspaceId: 'workspace-1',
    loginMode: 'password-or-sso',
    mfaRequirement: 'optional',
    sessionLifetimeMinutes: 480,
    idleTimeoutMinutes: 60,
    reauthenticationIntervalMinutes: 120,
    sensitiveActionReauthenticationMinutes: 15,
    ipAllowlistMode: 'disabled',
    ipAllowlist: [],
    externalAccess: {
      allowGuests: true,
      allowExternalCollaborators: true,
      requireMfa: false,
      maximumSessionLifetimeMinutes: 120,
      allowedGuestDomains: [],
      permissionCeiling: [
        'workspace.read',
        'teams.read',
        'projects.read',
        'work-items.read',
      ],
      ...externalOverrides,
    },
    revision: 1,
    updatedAt: timestamp,
    updatedBy: 'owner-1',
  }
}

function createEnterpriseSnapshot(
  overrides: Partial<EnterpriseIdentitySnapshot> = {},
): EnterpriseIdentitySnapshot {
  return {
    workspaceId: 'workspace-1',
    controlRevision: 1,
    identityProviders: [],
    domains: [],
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
    ...overrides,
  }
}

function createSubscription() {
  return {
    id: 'webhook-1',
    name: 'Team automation',
    url: 'https://hooks.example.test/mukuroji',
    createdByUserId: 'creator-1',
    teamIds: ['team-1'],
    eventTypes: ['work-item.created'],
    scopes: ['work-items:read'],
    status: 'active',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    failureCount: 0,
  } satisfies WebhookSubscription
}
