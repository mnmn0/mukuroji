import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createCyclePlanningInput,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import {
  createWorkItemAuthorizationChangedError,
  DynamoDbTeamIssuesClient,
} from '../../adapter-out/dynamodb/work-item-client'
import {
  InMemoryPlanningClient,
  type PlanningWorkItemState,
} from '../../../planning/planning'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import { createInMemoryDeveloperPlatformAdapters } from '../../../developer-platform/adapter-out/in-memory/developer-platform-adapters'
import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import type {
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  createDefaultDueDateWorkItemSchedule,
  type WorkItemSchedule,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/** Creates one strict persisted date-range Work Item for preview adapter tests. */
function createDateRangeWorkItem(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'onboarding-friction',
    sortOrder: 10,
    title: 'Scheduled Work Item',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-22',
    schedule: {
      mode: 'date-range',
      startDate: '2026-06-18',
      endDate: '2026-06-22',
      durationDays: 3,
      calendarPolicy: {
        timeZone: 'Asia/Tokyo',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        holidays: [],
      },
    },
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T02:00:00.000Z',
  }
}

/**
 * Configures an in-memory reservation port whose prepared receipt represents the fake transaction commit.
 *
 * @returns Isolated idempotency adapter retained across requests in one test.
 */
function configureScheduleConfirmationIdempotency() {
  const platform = createInMemoryDeveloperPlatformAdapters()
  setTestAppDependencies({
    idempotency: platform.idempotency,
    transactions: {
      async prepareIdempotencyCompletionTransactWrite(request) {
        await platform.idempotency.completeIdempotency(request)
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: { entryType: 'idempotency', state: 'completed' },
            },
          },
        }
      },
    },
  })
  return platform.idempotency
}

/**
 * Configures two visible due-date Work Items joined by one FF schedule dependency.
 *
 * @returns Harness call observations and the dependency-owning Planning client.
 */
async function configureDueDateScheduleDependency() {
  const calls = configureFakeProjectClients(true, { teamIssueCount: 2 })
  configureScheduleConfirmationIdempotency()
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: 'Predecessor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  await planning.createWorkItemDependency('user#demo@example.com', {
    id: 'dependency-ff',
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, workItemState)
  setTestAppDependencies({ planning })
  return { calls, planning }
}

/**
 * Configures an SS dependency whose successor cannot preserve duration at year 9999.
 *
 * @returns Harness call observations and the dependency-owning Planning client.
 */
async function configureUpperBoundaryScheduleDependency() {
  const calendarPolicy = {
    timeZone: 'UTC',
    workingWeekdays: [
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ],
    holidays: [],
  } satisfies WorkItemSchedule['calendarPolicy']
  const rootSchedule = {
    mode: 'milestone',
    startDate: '9999-12-29',
    endDate: '9999-12-29',
    durationDays: 0,
    calendarPolicy,
  } satisfies WorkItemSchedule
  const successorSchedule = {
    mode: 'date-range',
    startDate: '9999-12-29',
    endDate: '9999-12-30',
    durationDays: 2,
    calendarPolicy,
  } satisfies WorkItemSchedule
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    detailSchedules: {
      'onboarding-friction': rootSchedule,
      'work-item-1': successorSchedule,
    },
  })
  configureScheduleConfirmationIdempotency()
  const planning = new InMemoryPlanningClient()
  const workItemState: PlanningWorkItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: 'Predecessor',
        projectId: 'refero',
        statusCategory: 'started',
        dueDate: '9999-12-29',
        schedule: rootSchedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started',
        dueDate: '9999-12-30',
        schedule: successorSchedule,
      },
    ],
  }
  await planning.createWorkItemDependency('user#demo@example.com', {
    id: 'dependency-upper-bound',
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'start-to-start',
    lagDays: 0,
    expectedRevision: 0,
  }, workItemState)
  setTestAppDependencies({ planning })
  return { calls, planning }
}

/**
 * Configures a root-reachable dependency chain whose successors are outside the API principal's view.
 *
 * @param hiddenCount - Number of hidden successor Work Items in the chain.
 * @returns Harness call observations and the dependency-owning Planning client.
 */
async function configureHiddenScheduleDependencies(hiddenCount: number) {
  const calls = configureFakeProjectClients(true)
  configureScheduleConfirmationIdempotency()
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const hiddenWorkItems = Array.from({ length: hiddenCount }, (_, index) => ({
    id: `hidden-successor-${index}`,
    revision: 1,
    teamId: 'hidden-team',
    title: `Hidden successor ${index}`,
    projectId: 'hidden-project',
    statusCategory: 'started' as const,
    dueDate: '2026-06-18',
    schedule,
  }))
  const workItemState = {
    workItems: [{
      id: 'onboarding-friction',
      revision: 1,
      teamId: 'core-team',
      title: 'Visible predecessor',
      projectId: 'refero',
      statusCategory: 'started' as const,
      dueDate: '2026-06-18',
      schedule,
    }, ...hiddenWorkItems],
  }
  for (let index = 0; index < hiddenWorkItems.length; index += 1) {
    const predecessor = index === 0
      ? { teamId: 'core-team', workItemId: 'onboarding-friction' }
      : { teamId: 'hidden-team', workItemId: `hidden-successor-${index - 1}` }
    await planning.createWorkItemDependency('user#demo@example.com', {
      id: `hidden-dependency-${index}`,
      predecessor,
      successor: { teamId: 'hidden-team', workItemId: `hidden-successor-${index}` },
      type: 'finish-to-finish',
      lagDays: 0,
      expectedRevision: index,
    }, workItemState)
  }
  setTestAppDependencies({ planning })
  return { calls, planning }
}

/**
 * Configures a cross-Team dependency whose successor sorts before the edited root.
 *
 * @returns Harness calls and Planning client with unequal endpoint revisions.
 */
async function configureCrossTeamScheduleDependency() {
  const calls = configureFakeProjectClients(true, {
    additionalTeams: [
      {
        id: 'a-team',
        name: 'A Team',
        projects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      },
      {
        id: 'z-team',
        name: 'Z Team',
        projects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      },
    ],
    detailRevisions: {
      ['a-team\0onboarding-friction']: 7,
      ['z-team\0onboarding-friction']: 3,
    },
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })
  configureScheduleConfirmationIdempotency()
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 3,
        teamId: 'z-team',
        title: 'Root',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'onboarding-friction',
        revision: 7,
        teamId: 'a-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  await planning.createWorkItemDependency('user#demo@example.com', {
    id: 'cross-team-dependency',
    predecessor: { teamId: 'z-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'a-team', workItemId: 'onboarding-friction' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, workItemState)
  setTestAppDependencies({ planning })
  return { calls, planning }
}

/**
 * Configures a cross-Team cascade with independently revocable Project grants.
 *
 * @returns Initial transaction observations, Planning state, and directory fixture options.
 */
async function configureCrossTeamScheduleReplayDependency() {
  const directoryOptions = {
    additionalTeams: [
      {
        id: 'a-team',
        name: 'A Team',
        projects: [{ id: 'a-project', name: 'A Project', tone: 'blue' }],
      },
      {
        id: 'z-team',
        name: 'Z Team',
        projects: [{ id: 'z-project', name: 'Z Project', tone: 'purple' }],
      },
    ],
    detailAssignedProjectIds: {
      'onboarding-friction': 'z-project',
      'work-item-1': 'a-project',
      'work-item-2': 'a-project',
    },
    detailRevisions: {
      ['a-team\0work-item-1']: 7,
      ['a-team\0work-item-2']: 5,
      ['z-team\0onboarding-friction']: 3,
    },
    teamIssueCount: 3,
  } satisfies Parameters<typeof configureFakeProjectClients>[1]
  const calls = configureFakeProjectClients(true, {
    ...directoryOptions,
    projectAccesses: [
      { projectId: 'a-project', role: 'manager' },
      { projectId: 'z-project', role: 'manager' },
    ],
  })
  configureScheduleConfirmationIdempotency()
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  await planning.createWorkItemDependency('user#demo@example.com', {
    id: 'cross-team-replay-dependency',
    predecessor: { teamId: 'z-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'a-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 3,
        teamId: 'z-team',
        title: 'Root',
        projectId: 'z-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 7,
        teamId: 'a-team',
        title: 'Successor',
        projectId: 'a-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-2',
        revision: 5,
        teamId: 'a-team',
        title: 'Stronger predecessor',
        projectId: 'a-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  })
  await planning.createWorkItemDependency('user#demo@example.com', {
    id: 'cross-team-replay-stronger-bound',
    predecessor: { teamId: 'a-team', workItemId: 'work-item-2' },
    successor: { teamId: 'a-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 1,
  }, {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 3,
        teamId: 'z-team',
        title: 'Root',
        projectId: 'z-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 7,
        teamId: 'a-team',
        title: 'Successor',
        projectId: 'a-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-2',
        revision: 5,
        teamId: 'a-team',
        title: 'Stronger predecessor',
        projectId: 'a-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  })
  setTestAppDependencies({ planning })
  return { calls, directoryOptions }
}

/**
 * Configures a directory-managed principal and a cross-Team schedule dependency.
 *
 * @param includeSuccessorAccess - Whether the principal can write the successor Project.
 * @returns Harness call observations for the configured schedule cascade.
 */
async function configureEnterpriseCrossTeamScheduleDependency(
  includeSuccessorAccess: boolean,
) {
  const calls = configureFakeProjectClients(false, {
    additionalTeams: [
      {
        id: 'a-team',
        name: 'A Team',
        projects: [{ id: 'a-project', name: 'A Project', tone: 'blue' }],
      },
      {
        id: 'z-team',
        name: 'Z Team',
        projects: [{ id: 'z-project', name: 'Z Project', tone: 'purple' }],
      },
    ],
    detailAssignedProjectIds: {
      'onboarding-friction': 'z-project',
      'work-item-1': 'a-project',
    },
    detailRevisions: {
      ['a-team\0work-item-1']: 7,
      ['z-team\0onboarding-friction']: 3,
    },
    teamIssueCount: 2,
    workspaceRole: 'member',
  })
  configureScheduleConfirmationIdempotency()

  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = new Date().toISOString()
  await identity.putIdentityProvider({
    workspaceId,
    providerId: 'schedule-idp',
    kind: 'oidc',
    displayName: 'Schedule directory',
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
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:schedule-writer',
    name: 'Schedule writer',
    permissions: ['work-items.read', 'work-items.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  const user = await identity.upsertScimUser({
    workspaceId,
    identityProviderId: 'schedule-idp',
    externalId: 'schedule-user',
    userName: 'demo@example.com',
    emails: ['demo@example.com'],
    active: true,
    linkedMemberKey: 'demo@example.com',
    idempotencyKey: 'schedule-user',
  })
  const group = await identity.upsertScimGroup({
    workspaceId,
    identityProviderId: 'schedule-idp',
    externalId: 'schedule-writers',
    displayName: 'Schedule writers',
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: 'schedule-writers',
  })
  const desiredUser = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
    candidate.userId === user.userId
  )
  if (!desiredUser) throw new Error('Expected the enterprise schedule user to exist.')
  await identity.markScimUserApplied(workspaceId, desiredUser.userId, desiredUser.version)
  await identity.markScimGroupApplied(workspaceId, group.groupId, group.version)
  const projectIds = includeSuccessorAccess
    ? ['z-project', 'a-project']
    : ['z-project']
  for (const [index, projectId] of projectIds.entries()) {
    await identity.putGroupMapping({
      workspaceId,
      mappingId: `schedule-writer-${projectId}`,
      identityProviderId: 'schedule-idp',
      directoryGroupId: group.groupId,
      roleId: 'custom:schedule-writer',
      scope: { workspaceId, kind: 'project', targetId: projectId },
      enabled: true,
      priority: index,
      revision: 1,
      updatedAt: now,
    })
  }

  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  await planning.createWorkItemDependency(workspaceId, {
    id: 'enterprise-cross-team-dependency',
    predecessor: { teamId: 'z-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'a-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 3,
        teamId: 'z-team',
        title: 'Enterprise root',
        projectId: 'z-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 7,
        teamId: 'a-team',
        title: 'Enterprise successor',
        projectId: 'a-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  })
  setTestAppDependencies({ enterpriseIdentity: identity, planning })
  return calls
}

/**
 * Configures a Team-scoped enterprise principal against duplicate Project IDs.
 *
 * The injected cross-scope link simulates stale persisted state so API filtering remains the
 * final confidentiality boundary before Planning data contributes to a schedule preview.
 *
 * @returns Authorization header for the Team A enterprise principal.
 */
async function configureEnterpriseDuplicateProjectPlanningScope(): Promise<string> {
  configureFakeProjectClients(false, {
    additionalTeams: [
      {
        id: 'team-a',
        name: 'Team A',
        projects: [{ id: 'shared-project', name: 'Shared Project A', tone: 'blue' }],
      },
      {
        id: 'team-b',
        name: 'Team B',
        projects: [{ id: 'shared-project', name: 'Shared Project B', tone: 'purple' }],
      },
    ],
    detailAssignedProjectIds: { 'onboarding-friction': 'shared-project' },
    teamIssueCount: 1,
    workspaceRole: 'member',
  })

  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = new Date().toISOString()
  await identity.putIdentityProvider({
    workspaceId,
    providerId: 'duplicate-project-idp',
    kind: 'oidc',
    displayName: 'Duplicate Project directory',
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
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:team-a-schedule-writer',
    name: 'Team A schedule writer',
    permissions: ['planning.read', 'work-items.read', 'work-items.write'],
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  const user = await identity.upsertScimUser({
    workspaceId,
    identityProviderId: 'duplicate-project-idp',
    externalId: 'duplicate-project-user',
    userName: 'demo@example.com',
    emails: ['demo@example.com'],
    active: true,
    linkedMemberKey: 'demo@example.com',
    idempotencyKey: 'duplicate-project-user',
  })
  const group = await identity.upsertScimGroup({
    workspaceId,
    identityProviderId: 'duplicate-project-idp',
    externalId: 'team-a-schedule-writers',
    displayName: 'Team A schedule writers',
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: 'team-a-schedule-writers',
  })
  const desiredUser = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
    candidate.userId === user.userId
  )
  if (!desiredUser) throw new Error('Expected the duplicate Project enterprise user to exist.')
  await identity.markScimUserApplied(workspaceId, desiredUser.userId, desiredUser.version)
  await identity.markScimGroupApplied(workspaceId, group.groupId, group.version)
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'team-a-schedule-writer-mapping',
    identityProviderId: 'duplicate-project-idp',
    directoryGroupId: group.groupId,
    roleId: 'custom:team-a-schedule-writer',
    scope: { workspaceId, kind: 'team', targetId: 'team-a' },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now,
  })

  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState: PlanningWorkItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'team-a',
        title: 'Team A root',
        projectId: 'shared-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'team-b',
        title: 'Team B hidden root',
        projectId: 'shared-project',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  const planning = new InMemoryPlanningClient()
  await planning.create(workspaceId, {
    ...createCyclePlanningInput('duplicate-project-portfolio', 0),
    type: 'portfolio',
    title: 'Duplicate Project portfolio',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, workItemState)
  await planning.create(workspaceId, {
    ...createCyclePlanningInput('team-b-roadmap', 1),
    type: 'roadmap',
    title: 'Team B hidden roadmap',
    parentId: 'duplicate-project-portfolio',
    teamId: 'team-b',
    projectId: 'shared-project',
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, workItemState)
  await planning.create(workspaceId, {
    ...createCyclePlanningInput('team-b-milestone', 2),
    type: 'milestone',
    title: 'Team B hidden milestone',
    parentId: 'team-b-roadmap',
    teamId: 'team-b',
    projectId: 'shared-project',
    baseline: { startDate: '2026-06-30', endDate: '2026-06-30' },
    forecast: { startDate: '2026-06-30', endDate: '2026-06-30' },
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, workItemState)
  await planning.putWorkItemLink(workspaceId, {
    teamId: 'team-b',
    workItemId: 'onboarding-friction',
    projectId: 'shared-project',
    milestoneId: 'team-b-milestone',
    goalIds: [],
    expectedRevision: 3,
  }, workItemState)

  const readPlanningSnapshot = planning.get.bind(planning)
  planning.get = async (...input) => {
    const snapshot = await readPlanningSnapshot(...input)
    return {
      ...snapshot,
      workItemLinks: [
        ...snapshot.workItemLinks,
        {
          teamId: 'team-a',
          workItemId: 'onboarding-friction',
          projectId: 'shared-project',
          milestoneId: 'team-b-milestone',
          goalIds: [],
          createdAt: now,
        },
      ],
    }
  }
  setTestAppDependencies({ enterpriseIdentity: identity, planning })
  return `Bearer ${createAccessToken([], {
    client_id: 'mukuroji-main-client',
    token_use: 'access',
  })}`
}

/**
 * Creates the canonical impacts for the common due-date move fixture.
 *
 * @param includeSuccessor - Whether to include the FF dependency successor impact.
 * @returns Preview-compatible direct and optional dependency impacts.
 */
function createExpectedDueDateMoveImpacts(includeSuccessor: boolean) {
  const before = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const after = createDefaultDueDateWorkItemSchedule('2026-06-24')
  return [
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      kind: 'direct' as const,
      expectedRevision: 1,
      before,
      after,
      dateDeltaDays: 6,
    },
    ...(includeSuccessor
      ? [{
          teamId: 'core-team',
          workItemId: 'work-item-1',
          kind: 'dependency' as const,
          expectedRevision: 1,
          before,
          after,
          dateDeltaDays: 6,
          dependencyId: 'dependency-ff',
        }]
      : []),
  ]
}

test('updates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '更新済み Issue',
      assignedProjectId: null,
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-22'),
      priority: 'low',
      workflowStatusId: 'done',
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      teamId: 'core-team',
      title: '更新済み Issue',
      assigneeEmail: 'sato@example.com',
      workflowStatusId: 'done',
      statusCategory: 'completed',
      dueDate: '2026-06-22',
      schedule: {
        mode: 'due-date',
        dueDate: '2026-06-22',
      },
      priority: 'low',
    },
  })
  expect(calls.issueDetails).toContainEqual({
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: { consistentIssueRead: true, eventLimit: 0 },
  })
  expect(calls.issueUpdates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: null,
      authorizationSnapshot: {
        workspaceId: 'user#demo@example.com',
        memberKey: 'demo@example.com',
        workspaceMemberVersion: 1,
        planningRevision: 0,
        enterpriseControlRevision: 0,
      },
      directoryId: 'user#demo@example.com',
      issueId: 'onboarding-friction',
      teamId: 'core-team',
    },
  ])
})

test('fences a direct Project assignment change with the Planning revision', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assignedProjectId: null,
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(200)
  expect(calls.issueUpdates).toHaveLength(1)
  expect(calls.issueUpdates[0]?.authorizationSnapshot).toMatchObject({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    workspaceMemberVersion: 1,
    planningRevision: 0,
  })
})

test('updates and returns an explicit canonical Work Item schedule', async () => {
  const calls = configureFakeProjectClients(true)
  const schedule = {
    mode: 'date-range',
    startDate: '2026-06-22',
    endDate: '2026-06-26',
    durationDays: 5,
    plannedEffortMinutes: 900,
    calendarPolicy: {
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: [],
    },
  }

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schedule,
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      revision: 2,
      dueDate: '2026-06-26',
      schedule,
    },
  })
  expect(calls.issueUpdates[0]?.authorizationSnapshot).toMatchObject({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    workspaceMemberVersion: 1,
    planningRevision: 0,
  })
})

test('requires preview confirmation before directly patching a dependency-owned schedule', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    code: 'WorkItemScheduleConfirmationRequired',
  })
  expect(calls.issueUpdates).toEqual([])
  expect(calls.scheduleCascades).toEqual([])
})

test('rejects a direct schedule patch when a dependency is created after its precheck', async () => {
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: 'Root',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    async issueUpdateHook({ authorizationSnapshot }) {
      expect(authorizationSnapshot?.planningRevision).toBe(0)
      await planning.createWorkItemDependency('user#demo@example.com', {
        id: 'dependency-created-during-patch',
        predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
        successor: { teamId: 'core-team', workItemId: 'work-item-1' },
        type: 'finish-to-finish',
        lagDays: 0,
        expectedRevision: 0,
      }, workItemState)
      throw createWorkItemAuthorizationChangedError()
    },
  })
  setTestAppDependencies({ planning })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'WorkItemAuthorizationChanged' })
  expect(calls.issueUpdates).toEqual([])
})

test('rejects a direct dueDate field even when update also includes a schedule', async () => {
  const calls = configureFakeProjectClients(true)
  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dueDate: '2026-06-24',
      expectedRevision: 1,
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidWorkItemSchedule',
    message: 'dueDate is derived from schedule and cannot be written directly.',
  })
  expect(calls.issueUpdates).toEqual([])
})

test('rejects internal adapter fields at the Work Item update boundary', async () => {
  const calls = configureFakeProjectClients(true)
  const internalFields: ReadonlyArray<readonly [string, unknown]> = [
    ['archivedAt', '2026-07-16T00:00:00.000Z'],
    ['archivedBy', 'demo@example.com'],
    ['authorizationConditionChecks', []],
    ['authorizationSnapshot', { planningRevision: 0 }],
    ['configurationConditionChecks', []],
    ['planningRevisionFence', { expectedRevision: 0 }],
    ['statusCategory', 'completed'],
    ['workflowSchemaVersion', 99],
  ]

  for (const [field, value] of internalFields) {
    const response = await app.request(
      '/api/teams/core-team/issues/onboarding-friction',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedRevision: 1,
          title: 'Internal field injection',
          [field]: value,
        }),
      },
    )

    expect(response.status).toBe(400)
  }
  expect(calls.issueUpdates).toEqual([])
})

test('rejects non-object Work Item update bodies before reading schedule fields', async () => {
  const calls = configureFakeProjectClients(true)

  for (const body of [JSON.stringify('not-an-object'), JSON.stringify([])]) {
    const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body,
    })

    expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: 'Work Item body must be an object.',
      })
  }

  expect(calls.issueDetails).toEqual([])
  expect(calls.issueUpdates).toEqual([])
})

test('previews moving a due-date Work Item without mutating it', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    expectedRevision: 1,
    impacts: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      kind: 'direct',
      expectedRevision: 1,
      before: {
        mode: 'due-date',
        dueDate: '2026-06-18',
        calendarPolicy: {
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          holidays: [],
        },
      },
      after: {
        mode: 'due-date',
        dueDate: '2026-06-24',
        calendarPolicy: {
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          holidays: [],
        },
      },
      dateDeltaDays: 6,
    }],
    evaluatedRevisions: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
    }],
    relationGraphRevision: 0,
    planningRevision: 0,
    conflicts: [],
    affectedProjectIds: ['refero'],
    affectedMilestoneIds: [],
    requiresConfirmation: false,
    warnings: [],
  })
  expect(calls.issueDetails).toEqual([{
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: { consistentIssueRead: true, eventLimit: 0 },
  }])
})

test.each(['blocks', 'blockedBy'] as const)(
  'keeps semantic %s relations as a warning without creating schedule dependency impacts',
  async (relationType) => {
  const calls = configureFakeProjectClients(true, {
    workItemRelationGraphRevision: 12,
    workItemRelations: [{
      sourceWorkItemId: 'onboarding-friction',
      targetWorkItemId: 'release-follow-up',
      type: relationType,
    }],
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    expectedRevision: 1,
    impacts: [
      {
        teamId: 'core-team',
        workItemId: 'onboarding-friction',
        kind: 'direct',
        expectedRevision: 1,
        before: { mode: 'due-date', dueDate: '2026-06-18' },
        after: { mode: 'due-date', dueDate: '2026-06-24' },
      },
    ],
    planningRevision: 0,
    relationGraphRevision: 12,
    conflicts: [],
    requiresConfirmation: false,
    warnings: ['SemanticBlockRelationsDoNotReschedule'],
  })
  expect(calls.issueDetails.filter(({ issueId }) => issueId === 'release-follow-up'))
    .toHaveLength(1)
  },
)

test('previews and atomically confirms a canonical Work Item dependency cascade', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const operation = { type: 'move', targetDate: '2026-06-24' }

  const previewResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 1, operation }),
    },
  )

  expect(previewResponse.status).toBe(200)
  const preview = await previewResponse.json()
  expect(preview).toMatchObject({
    planningRevision: 1,
    relationGraphRevision: 0,
    conflicts: [],
    requiresConfirmation: true,
    warnings: ['DependencyRippleRequiresReview'],
    impacts: [
      {
        kind: 'direct',
        workItemId: 'onboarding-friction',
        before: { dueDate: '2026-06-18' },
        after: { dueDate: '2026-06-24' },
        dateDeltaDays: 6,
      },
      {
        kind: 'dependency',
        workItemId: 'work-item-1',
        dependencyId: 'dependency-ff',
        before: { dueDate: '2026-06-18' },
        after: { dueDate: '2026-06-24' },
        dateDeltaDays: 6,
      },
    ],
  })
  expect(calls.scheduleCascades).toEqual([])

  const confirmResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/confirm',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'schedule-cascade-confirm-1',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation,
        expectedPlanningRevision: 1,
        expectedRelationGraphRevision: 0,
        expectedEvaluatedRevisions: preview.evaluatedRevisions,
        expectedImpacts: preview.impacts,
        confirmed: true,
      }),
    },
  )

  expect(confirmResponse.status).toBe(200)
  expect(await confirmResponse.json()).toMatchObject({
    workItems: [
      { id: 'onboarding-friction', revision: 2, dueDate: '2026-06-24' },
      { id: 'work-item-1', revision: 2, dueDate: '2026-06-24' },
    ],
  })
  expect(calls.scheduleCascades).toEqual([{
    directoryId: 'user#demo@example.com',
    guardedWorkItemIds: [],
    updatedWorkItemIds: ['onboarding-friction', 'work-item-1'],
  }])
})

test('previews a year-9999 dependency conflict and rejects its confirmation', async () => {
  const { calls } = await configureUpperBoundaryScheduleDependency()
  const operation = { type: 'move', targetDate: '9999-12-31' }
  const path = '/api/teams/core-team/issues/onboarding-friction/schedule'
  const previewResponse = await app.request(`${path}/preview`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedRevision: 1, operation }),
  })

  expect(previewResponse.status).toBe(200)
  const preview = await previewResponse.json()
  expect(preview.impacts).toEqual([expect.objectContaining({
    kind: 'direct',
    workItemId: 'onboarding-friction',
    after: expect.objectContaining({
      startDate: '9999-12-31',
      endDate: '9999-12-31',
    }),
  })])
  expect(preview.conflicts).toEqual([{
    code: 'dependency-violation',
    dependencyId: 'dependency-upper-bound',
    workItem: { teamId: 'core-team', workItemId: 'work-item-1' },
    requiredDate: '9999-12-31',
    actualDate: '9999-12-29',
  }])

  const confirmResponse = await app.request(`${path}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'schedule-upper-bound-conflict',
    },
    body: JSON.stringify({
      expectedRevision: 1,
      operation,
      expectedPlanningRevision: preview.planningRevision,
      expectedRelationGraphRevision: preview.relationGraphRevision,
      expectedEvaluatedRevisions: preview.evaluatedRevisions,
      expectedImpacts: preview.impacts,
      confirmed: true,
    }),
  })

  expect(confirmResponse.status).toBe(409)
  expect(await confirmResponse.json()).toEqual({
    code: 'WorkItemScheduleDependencyConflict',
    message: 'Resolve schedule dependency conflicts before confirming this change.',
  })
  expect(calls.scheduleCascades).toEqual([])
})

test('replays the exact confirmed cascade after response loss without another transaction', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const path = '/api/teams/core-team/issues/onboarding-friction/schedule'
  const operation = { type: 'move', targetDate: '2026-06-24' }
  const previewResponse = await app.request(`${path}/preview`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedRevision: 1, operation }),
  })
  const preview = await previewResponse.json()
  const confirmation = {
    expectedRevision: 1,
    operation,
    expectedPlanningRevision: preview.planningRevision,
    expectedRelationGraphRevision: preview.relationGraphRevision,
    expectedEvaluatedRevisions: preview.evaluatedRevisions,
    expectedImpacts: preview.impacts,
    confirmed: true,
  }
  const request = () => app.request(`${path}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'schedule-response-loss',
    },
    body: JSON.stringify(confirmation),
  })

  const committed = await request()
  expect(committed.status).toBe(200)
  const committedBody = await committed.json()
  const replay = await request()

  expect(replay.status).toBe(200)
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await replay.json()).toEqual(committedBody)
  expect(calls.scheduleCascades).toHaveLength(1)
})

test('rejects reuse of a schedule confirmation key with a different body', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const path = '/api/teams/core-team/issues/onboarding-friction/schedule'
  const operation = { type: 'move', targetDate: '2026-06-24' }
  const previewResponse = await app.request(`${path}/preview`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedRevision: 1, operation }),
  })
  const preview = await previewResponse.json()
  const confirmation = {
    expectedRevision: 1,
    operation,
    expectedPlanningRevision: preview.planningRevision,
    expectedRelationGraphRevision: preview.relationGraphRevision,
    expectedEvaluatedRevisions: preview.evaluatedRevisions,
    expectedImpacts: preview.impacts,
    confirmed: true,
  }
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'schedule-key-body-conflict',
  }
  const committed = await app.request(`${path}/confirm`, {
    method: 'POST',
    headers,
    body: JSON.stringify(confirmation),
  })
  expect(committed.status).toBe(200)

  const conflict = await app.request(`${path}/confirm`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...confirmation,
      operation: { type: 'move', targetDate: '2026-06-25' },
    }),
  })

  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({
    code: 'WorkItemScheduleIdempotencyConflict',
    message: 'Idempotency-Key was already used for a different schedule confirmation.',
  })
  expect(calls.scheduleCascades).toHaveLength(1)
})

test('requires a valid idempotency key before confirming a schedule cascade', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const path = '/api/teams/core-team/issues/onboarding-friction/schedule'
  const operation = { type: 'move', targetDate: '2026-06-24' }
  const previewResponse = await app.request(`${path}/preview`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedRevision: 1, operation }),
  })
  const preview = await previewResponse.json()
  const body = JSON.stringify({
    expectedRevision: 1,
    operation,
    expectedPlanningRevision: preview.planningRevision,
    expectedRelationGraphRevision: preview.relationGraphRevision,
    expectedEvaluatedRevisions: preview.evaluatedRevisions,
    expectedImpacts: preview.impacts,
    confirmed: true,
  })
  for (const idempotencyKey of [undefined, 'x'.repeat(257)]) {
    const response = await app.request(`${path}/confirm`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'InvalidWorkItemScheduleIdempotencyKey',
    })
  }
  expect(calls.scheduleCascades).toEqual([])
})

test('classifies an in-progress schedule confirmation with a stable conflict code', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const currentIdempotency = getTestAppDependencies().developerPlatform.idempotency
  setTestAppDependencies({
    idempotency: {
      reserveIdempotency: async () => ({ status: 'in-progress' }),
      completeIdempotency: (request) => currentIdempotency.completeIdempotency(request),
      releaseIdempotency: (request) => currentIdempotency.releaseIdempotency(request),
    },
  })
  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/confirm',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'schedule-in-progress',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
        expectedPlanningRevision: 1,
        expectedRelationGraphRevision: 0,
        expectedEvaluatedRevisions: [
          { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
          { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 1 },
        ],
        expectedImpacts: createExpectedDueDateMoveImpacts(true),
        confirmed: true,
      }),
    },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkItemScheduleIdempotencyInProgress',
    message: 'The same schedule confirmation is still in progress.',
  })
  expect(calls.scheduleCascades).toEqual([])
})

test('denies a cross-Team replay after access to one evaluated endpoint is revoked', async () => {
  const { calls, directoryOptions } = await configureCrossTeamScheduleReplayDependency()
  const path = '/api/teams/z-team/issues/onboarding-friction/schedule'
  const operation = { type: 'move', targetDate: '2026-06-17' }
  const previewResponse = await app.request(`${path}/preview`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedRevision: 3, operation }),
  })
  const preview = await previewResponse.json()
  expect(preview.evaluatedRevisions).toHaveLength(3)
  expect(preview.impacts).toHaveLength(1)
  const request = () => app.request(`${path}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'schedule-cross-team-replay-revoked',
    },
    body: JSON.stringify({
      expectedRevision: 3,
      operation,
      expectedPlanningRevision: preview.planningRevision,
      expectedRelationGraphRevision: preview.relationGraphRevision,
      expectedEvaluatedRevisions: preview.evaluatedRevisions,
      expectedImpacts: preview.impacts,
      confirmed: true,
    }),
  })
  const committed = await request()
  expect(committed.status).toBe(200)
  expect((await committed.json()).workItems).toHaveLength(1)
  configureFakeProjectClients(true, {
    ...directoryOptions,
    projectAccesses: [{ projectId: 'z-project', role: 'manager' }],
  })

  const denied = await request()
  expect(denied.status).toBe(403)
  expect(denied.headers.get('Idempotency-Replayed')).toBeNull()
  const deniedBody = await denied.text()
  expect(deniedBody).not.toContain('work-item-1')
  expect(deniedBody).not.toContain('a-team')
  expect(calls.scheduleCascades).toHaveLength(1)
})

test('rejects unconfirmed and stale-Planning schedule cascade applications without writes', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const request = {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'schedule-cascade-validation',
    },
  }
  const path = '/api/teams/core-team/issues/onboarding-friction/schedule/confirm'
  const operation = { type: 'move', targetDate: '2026-06-24' }

  const unconfirmed = await app.request(path, {
    ...request,
    body: JSON.stringify({
      expectedRevision: 1,
      operation,
      expectedPlanningRevision: 1,
      expectedRelationGraphRevision: 0,
      expectedEvaluatedRevisions: [
        { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
        { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 1 },
      ],
      expectedImpacts: createExpectedDueDateMoveImpacts(true),
      confirmed: false,
    }),
  })
  expect(unconfirmed.status).toBe(400)
  expect(await unconfirmed.json()).toMatchObject({
    code: 'WorkItemScheduleConfirmationRequired',
  })

  const missingRelationRevision = await app.request(path, {
    ...request,
    body: JSON.stringify({
      expectedRevision: 1,
      operation,
      expectedPlanningRevision: 1,
      expectedEvaluatedRevisions: [
        { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
        { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 1 },
      ],
      expectedImpacts: createExpectedDueDateMoveImpacts(true),
      confirmed: true,
    }),
  })
  expect(missingRelationRevision.status).toBe(400)
  expect(await missingRelationRevision.json()).toMatchObject({
    code: 'InvalidWorkItemScheduleConfirmation',
  })

  const missingImpacts = await app.request(path, {
    ...request,
    body: JSON.stringify({
      expectedRevision: 1,
      operation,
      expectedPlanningRevision: 1,
      expectedRelationGraphRevision: 0,
      expectedEvaluatedRevisions: [
        { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
        { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 1 },
      ],
      confirmed: true,
    }),
  })
  expect(missingImpacts.status).toBe(400)
  expect(await missingImpacts.json()).toMatchObject({
    code: 'InvalidWorkItemScheduleConfirmation',
  })

  const stale = await app.request(path, {
    ...request,
    body: JSON.stringify({
      expectedRevision: 1,
      operation,
      expectedPlanningRevision: 0,
      expectedRelationGraphRevision: 0,
      expectedEvaluatedRevisions: [
        { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
        { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 1 },
      ],
      expectedImpacts: createExpectedDueDateMoveImpacts(true),
      confirmed: true,
    }),
  })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ code: 'PlanningRevisionConflict' })
  expect(calls.scheduleCascades).toEqual([])
})

test('rejects confirmation when any evaluated Work Item revision differs from preview', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/confirm',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'schedule-cascade-stale-revision',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
        expectedPlanningRevision: 1,
        expectedRelationGraphRevision: 0,
        expectedEvaluatedRevisions: [
          { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
          { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 2 },
        ],
        expectedImpacts: createExpectedDueDateMoveImpacts(true),
        confirmed: true,
      }),
    },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkItemSchedulePreviewStale',
    message: 'A Work Item evaluated by the schedule preview changed. Preview the change again.',
  })
  expect(calls.scheduleCascades).toEqual([])
})

test('rejects confirmation of an operation that differs from the viewed preview impacts', async () => {
  const { calls } = await configureDueDateScheduleDependency()
  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/confirm',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'schedule-cascade-impact-mismatch',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-25' },
        expectedPlanningRevision: 1,
        expectedRelationGraphRevision: 0,
        expectedEvaluatedRevisions: [
          { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
          { teamId: 'core-team', workItemId: 'work-item-1', expectedRevision: 1 },
        ],
        expectedImpacts: createExpectedDueDateMoveImpacts(true),
        confirmed: true,
      }),
    },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'WorkItemSchedulePreviewStale' })
  expect(calls.scheduleCascades).toEqual([])
})

test('validates the edited root revision independently of cross-Team snapshot ordering', async () => {
  const { calls } = await configureCrossTeamScheduleDependency()
  const path = '/api/teams/z-team/issues/onboarding-friction/schedule'
  const operation = { type: 'move', targetDate: '2026-06-24' }
  const previewResponse = await app.request(`${path}/preview`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedRevision: 3, operation }),
  })
  expect(previewResponse.status).toBe(200)
  const preview = await previewResponse.json()
  expect(preview.evaluatedRevisions).toEqual([
    { teamId: 'a-team', workItemId: 'onboarding-friction', expectedRevision: 7 },
    { teamId: 'z-team', workItemId: 'onboarding-friction', expectedRevision: 3 },
  ])

  const confirm = await app.request(`${path}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'schedule-cascade-cross-team',
    },
    body: JSON.stringify({
      expectedRevision: 3,
      operation,
      expectedPlanningRevision: 1,
      expectedRelationGraphRevision: 0,
      expectedEvaluatedRevisions: preview.evaluatedRevisions,
      expectedImpacts: preview.impacts,
      confirmed: true,
    }),
  })

  expect(confirm.status).toBe(200)
  expect(calls.scheduleCascades).toEqual([{
    directoryId: 'user#demo@example.com',
    guardedWorkItemIds: [],
    updatedWorkItemIds: ['onboarding-friction', 'onboarding-friction'],
  }])
})

test('allows an enterprise schedule cascade when every server-derived Project is writable', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
    const calls = await configureEnterpriseCrossTeamScheduleDependency(true)
    const authorization = `Bearer ${createAccessToken([], {
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })}`
    const path = '/api/teams/z-team/issues/onboarding-friction/schedule'
    const operation = { type: 'move', targetDate: '2026-06-24' }
    const previewResponse = await app.request(`${path}/preview`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 3, operation }),
    })

    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json()
    expect(preview.evaluatedRevisions).toEqual([
      { teamId: 'a-team', workItemId: 'work-item-1', expectedRevision: 7 },
      { teamId: 'z-team', workItemId: 'onboarding-friction', expectedRevision: 3 },
    ])

    const confirmationResponse = await app.request(`${path}/confirm`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'enterprise-cross-team-confirmation',
      },
      body: JSON.stringify({
        expectedRevision: 3,
        operation,
        expectedPlanningRevision: preview.planningRevision,
        expectedRelationGraphRevision: preview.relationGraphRevision,
        expectedEvaluatedRevisions: preview.evaluatedRevisions,
        expectedImpacts: preview.impacts,
        confirmed: true,
      }),
    })

    expect(confirmationResponse.status).toBe(200)
    expect(await confirmationResponse.json()).toEqual({
      workItems: [
        {
          id: 'onboarding-friction',
          teamId: 'z-team',
          revision: 4,
          schedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
          dueDate: '2026-06-24',
          assignedProjectId: 'z-project',
        },
        {
          id: 'work-item-1',
          teamId: 'a-team',
          revision: 8,
          schedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
          dueDate: '2026-06-24',
          assignedProjectId: 'a-project',
        },
      ],
    })
    expect(calls.scheduleCascades).toHaveLength(1)
  })
})

test('denies an enterprise schedule cascade when one server-derived Project is hidden', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
    const calls = await configureEnterpriseCrossTeamScheduleDependency(false)
    const authorization = `Bearer ${createAccessToken([], {
      client_id: 'mukuroji-main-client',
      token_use: 'access',
    })}`
    const response = await app.request(
      '/api/teams/z-team/issues/onboarding-friction/schedule/preview',
      {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedRevision: 3,
          operation: { type: 'move', targetDate: '2026-06-24' },
        }),
      },
    )

    expect(response.status).toBe(403)
    const responseBody = await response.text()
    expect(responseBody).toContain('WorkItemScheduleDependencyAccessDenied')
    expect(responseBody).not.toContain('a-team')
    expect(responseBody).not.toContain('work-item-1')
    expect(calls.scheduleCascades).toEqual([])
  })
})

test('qualifies enterprise Planning Project scope by Team before schedule preview', async () => {
  await withTestEnvironment({
    COGNITO_CLIENT_ID: 'mukuroji-main-client',
    COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
    COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
    COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
  }, async () => {
    const authorization = await configureEnterpriseDuplicateProjectPlanningScope()
    const planningResponse = await app.request('/api/planning', {
      headers: { Authorization: authorization },
    })

    expect(planningResponse.status).toBe(200)
    const planningSnapshot = await planningResponse.json()
    expect(planningSnapshot.entities).toEqual([])
    expect(planningSnapshot.workItems).toEqual([
      expect.objectContaining({
        id: 'onboarding-friction',
        teamId: 'team-a',
        projectId: 'shared-project',
      }),
    ])
    expect(planningSnapshot.workItemLinks).toEqual([
      expect.objectContaining({
        teamId: 'team-a',
        workItemId: 'onboarding-friction',
        projectId: 'shared-project',
        goalIds: [],
      }),
    ])
    expect(planningSnapshot.workItemLinks[0]).not.toHaveProperty('milestoneId')

    const previewResponse = await app.request(
      '/api/teams/team-a/issues/onboarding-friction/schedule/preview',
      {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedRevision: 1,
          operation: { type: 'move', targetDate: '2026-06-24' },
        }),
      },
    )

    expect(previewResponse.status).toBe(200)
    expect(await previewResponse.json()).toMatchObject({
      affectedMilestoneIds: [],
      evaluatedRevisions: [{
        teamId: 'team-a',
        workItemId: 'onboarding-friction',
        expectedRevision: 1,
      }],
    })
  })
})

test('fails closed without exposing hidden schedule dependency endpoints', async () => {
  const { calls } = await configureHiddenScheduleDependencies(1)
  const path = '/api/teams/core-team/issues/onboarding-friction/schedule'
  const preview = await app.request(`${path}/preview`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedRevision: 1,
      operation: { type: 'move', targetDate: '2026-06-24' },
    }),
  })
  const confirm = await app.request(`${path}/confirm`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'schedule-cascade-hidden-endpoint',
    },
    body: JSON.stringify({
      expectedRevision: 1,
      operation: { type: 'move', targetDate: '2026-06-24' },
      expectedPlanningRevision: 1,
      expectedRelationGraphRevision: 0,
      expectedEvaluatedRevisions: [{
        teamId: 'core-team',
        workItemId: 'onboarding-friction',
        expectedRevision: 1,
      }],
      expectedImpacts: createExpectedDueDateMoveImpacts(false),
      confirmed: true,
    }),
  })

  for (const response of [preview, confirm]) {
    expect(response.status).toBe(403)
    const body = await response.text()
    expect(body).toContain('WorkItemScheduleDependencyAccessDenied')
    expect(body).not.toContain('hidden-successor-0')
    expect(body).not.toContain('hidden-team')
  }
  expect(calls.scheduleCascades).toEqual([])
})

test('returns generic access denial before reporting the size of a hidden cascade', async () => {
  await configureHiddenScheduleDependencies(25)
  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )

  expect(response.status).toBe(403)
  const body = await response.text()
  expect(body).toContain('WorkItemScheduleDependencyAccessDenied')
  expect(body).not.toContain('WorkItemScheduleCascadeLimitExceeded')
  expect(body).not.toContain('hidden-successor')
})

test('previews resizing a date-range Work Item with calendar-aware duration', async () => {
  configureFakeProjectClients(true)
  const currentIssue = createDateRangeWorkItem()
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      return command.constructor.name === 'GetCommand'
        ? { Item: currentIssue }
        : { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  setTestAppDependencies({
    teamIssues: new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    ),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'resize', endDate: '2026-06-24' },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    expectedRevision: 1,
    impacts: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      kind: 'direct',
      expectedRevision: 1,
      before: {
        mode: 'date-range',
        startDate: '2026-06-18',
        endDate: '2026-06-22',
        durationDays: 3,
      },
      after: {
        mode: 'date-range',
        startDate: '2026-06-18',
        endDate: '2026-06-24',
        durationDays: 5,
      },
    }],
    warnings: [],
  })
})

test('rejects stale, invalid, and unauthorized schedule previews', async () => {
  let calls = configureFakeProjectClients(true)
  const staleResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 2,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )
  expect(staleResponse.status).toBe(409)
  expect(await staleResponse.json()).toEqual({
    code: 'WorkItemRevisionConflict',
    message: 'Work Item changed. Reload and try again.',
  })

  const invalidResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'resize', endDate: '2026-06-24' },
      }),
    },
  )
  expect(invalidResponse.status).toBe(400)
  expect(await invalidResponse.json()).toMatchObject({
    code: 'InvalidWorkItemScheduleOperation',
  })

  resetTestApp()
  calls = configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const forbiddenResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )
  expect(forbiddenResponse.status).toBe(403)
  expect(calls.issueDetails).toEqual([])
})

test('rejects internal archive fields on the public Work Item update endpoint', async () => {
  const calls = configureFakeProjectClients(true)
  const archiveFields = [
    { archivedAt: '2026-07-17T00:00:00.000Z' },
    { archivedBy: 'attacker@example.com' },
  ]

  for (const archiveField of archiveFields) {
    const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...archiveField,
        expectedRevision: 1,
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      code: 'InvalidWorkItemArchiveUpdate',
      message: 'Work Item archive fields cannot be updated through this endpoint.',
    })
  }

  expect(calls.issueUpdates).toEqual([])
})

test('returns a stable conflict code when a Work Item revision is stale', async () => {
  configureFakeProjectClients(true)
  const currentIssue = {
    schemaVersion: 2,
    revision: 2,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'onboarding-friction',
    sortOrder: 10,
    title: '初回オンボーディングの離脱要因を減らす',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-18',
    schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T02:00:00.000Z',
  }
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      return command.constructor.name === 'GetCommand'
        ? { Item: currentIssue }
        : { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  setTestAppDependencies({
    teamIssues: new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    ),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflowStatusId: 'done', expectedRevision: 1 }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkItemRevisionConflict',
    message: 'Work Item changed. Reload and try again.',
  })
})

test('requires a positive expected revision for Work Item updates', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflowStatusId: 'done' }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidWorkItemRevision',
    message: 'Work Item expected revision is required.',
  })
})

test('loads only canonical project execution Work Items', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/projects/refero/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.projectId).toBe('refero')
  expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([
    'onboarding-friction',
  ])
  expect(calls.projectIssueReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([])
})
