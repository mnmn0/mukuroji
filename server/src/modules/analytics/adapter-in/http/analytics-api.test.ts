import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  analyticsApiRequest,
  app,
  configureFakeProjectClients,
  createAnalyticsAuditEvent,
  createAnalyticsQueryInput,
  createHistoricalAnalyticsWorkItem,
  createHistoricalAnalyticsWorkItemEvent,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  createAnalyticsSnapshotListCursor,
  InMemoryAnalyticsRepository,
} from '../../analytics'
import type {
  AnalyticsQueryInput,
  AnalyticsSnapshotListResponse,
  AnalyticsSnapshotRecord,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('keeps Analytics queries independent from the 200-item aggregate list limit', async () => {
  const calls = configureFakeProjectClients(true, { teamIssueCount: 250 })
  const auditQueries: Array<Record<string, unknown>> = []
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        auditQueries.push(input)
        return { events: [] }
      },
    },
  })

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...createAnalyticsQueryInput(),
    filter: {
      ...createAnalyticsQueryInput().filter,
      teamIds: ['core-team'],
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json() as {
    snapshot: { widgets: Array<{ sampleSize: number; value: number | null }> }
  }
  expect(body.snapshot.widgets[0]).toMatchObject({ sampleSize: 250, value: 250 })
  expect(calls.issueReads).toContainEqual({
    directoryId: 'user#demo@example.com',
    limit: 10_001,
    teamId: 'core-team',
  })
  expect(auditQueries).toHaveLength(500)
  expect(auditQueries.every((query) =>
    query.direction === 'ascending' &&
    query.entityType === 'work-item' &&
    typeof query.entityId === 'string'
  )).toBe(true)
  expect(new Set(auditQueries.map((query) => query.entityId)).size).toBe(500)
})

test('uses the canonical Analytics filter for query and evidence ACL reads', async () => {
  const calls = configureFakeProjectClients(true, { teamIssueCount: 0 })
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  query.filter.teamIds = [' core-team ']

  const queryResponse = await analyticsApiRequest('/api/analytics/query', query)
  const evidenceResponse = await analyticsApiRequest('/api/analytics/evidence', {
    metric: 'wip',
    filter: query.filter,
    asOf: query.asOf,
    timeZone: query.timeZone,
  })

  expect(queryResponse.status).toBe(200)
  expect(evidenceResponse.status).toBe(200)
  expect(calls.issueReads).toHaveLength(4)
  expect(calls.issueReads.every(({ teamId }) => teamId === 'core-team')).toBe(true)
})

test('fails before audit reads when Analytics identity fan-out exceeds the API cap', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 251 })
  let auditReads = 0
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        auditReads += 1
        return { events: [] }
      },
    },
  })

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...createAnalyticsQueryInput(),
    filter: {
      ...createAnalyticsQueryInput().filter,
      teamIds: ['core-team'],
    },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    code: 'AnalyticsHistoryLimitExceeded',
  })
  expect(auditReads).toBe(0)
})

test('bounds shared Analytics page reads even when paginated raw events are rejected', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 6 })
  let auditReads = 0
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        auditReads += 1
        if (input.entityId?.startsWith('team/')) {
          return { events: [] }
        }
        const event = createAnalyticsAuditEvent(
          'work-item',
          input.entityId ?? 'missing-entity',
          '2026-07-17T12:00:00.000Z',
        )
        return {
          events: [{
            ...event,
            entity: {
              type: 'work-item',
              id: 'conflicting-raw-entity',
            },
          }],
          nextCursor: `page-${auditReads}`,
        }
      },
    },
  })

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...createAnalyticsQueryInput(),
    filter: {
      ...createAnalyticsQueryInput().filter,
      teamIds: ['core-team'],
    },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    code: 'AnalyticsHistoryLimitExceeded',
  })
  expect(auditReads).toBe(500)
})

test('counts rejected raw events toward the shared Analytics read budget', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 2 })
  let rawAuditReads = 0
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        if (input.entityId?.startsWith('team/')) {
          return { events: [] }
        }
        rawAuditReads += 1
        const event = createAnalyticsAuditEvent(
          'work-item',
          input.entityId ?? 'missing-entity',
          '2026-07-17T12:00:00.000Z',
        )
        const rejectedEvent = {
          ...event,
          entity: {
            type: 'work-item',
            id: 'conflicting-raw-entity',
          },
        }
        return {
          events: Array<ReturnType<typeof createAnalyticsAuditEvent>>(100)
            .fill(rejectedEvent),
          nextCursor: `raw-page-${rawAuditReads}`,
        }
      },
    },
  })

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...createAnalyticsQueryInput(),
    filter: {
      ...createAnalyticsQueryInput().filter,
      teamIds: ['core-team'],
    },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    code: 'AnalyticsHistoryLimitExceeded',
  })
  expect(rawAuditReads).toBeGreaterThanOrEqual(101)
  expect(rawAuditReads).toBeLessThanOrEqual(102)
})

test('requires authentication and enforces Team report viewer/manager ACLs', async () => {
  const unauthenticated = await app.request('/api/analytics/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createAnalyticsQueryInput()),
  })
  expect(unauthenticated.status).toBe(401)

  const repository = new InMemoryAnalyticsRepository()
  await repository.createReport('user#demo@example.com', 'demo@example.com', {
    id: 'team-report',
    name: 'Team report',
    visibility: 'team',
    teamId: 'core-team',
    timeZone: 'UTC',
    filter: createAnalyticsQueryInput().filter,
    widgets: createAnalyticsQueryInput().widgets,
  })
  configureFakeProjectClients(false, { workspaceRole: 'member' })
  setTestAppDependencies({ analytics: repository })
  const hidden = await app.request('/api/analytics/reports', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(hidden.status).toBe(200)
  expect(await hidden.json()).toEqual({ reports: [] })
  const deniedQuery = await analyticsApiRequest('/api/analytics/query', {
    reportId: 'team-report',
    asOf: createAnalyticsQueryInput().asOf,
  })
  expect(deniedQuery.status).toBe(403)

  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const visible = await app.request('/api/analytics/reports', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(visible.status).toBe(200)
  expect(await visible.json()).toMatchObject({
    reports: [expect.objectContaining({ id: 'team-report' })],
  })
  const viewerWrite = await analyticsApiRequest(
    '/api/analytics/reports/team-report',
    { expectedRevision: 1, name: 'Viewer edit' },
    'PATCH',
  )
  expect(viewerWrite.status).toBe(403)

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const managerWrite = await analyticsApiRequest(
    '/api/analytics/reports/team-report',
    { expectedRevision: 1, name: 'Manager edit' },
    'PATCH',
  )
  expect(managerWrite.status).toBe(200)
  expect(await managerWrite.json()).toMatchObject({
    report: { name: 'Manager edit', revision: 2 },
  })
})

test('paginates Analytics reports with a Workspace-bound cursor', async () => {
  const repository = new InMemoryAnalyticsRepository()
  const query = createAnalyticsQueryInput()
  for (const id of ['alpha-report', 'beta-report']) {
    await repository.createReport('user#demo@example.com', 'demo@example.com', {
      id,
      name: id,
      visibility: 'personal',
      timeZone: query.timeZone,
      filter: query.filter,
      widgets: query.widgets,
    })
  }
  configureFakeProjectClients(true)
  setTestAppDependencies({ analytics: repository })

  const first = await app.request('/api/analytics/reports?limit=1', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(first.status).toBe(200)
  const firstPage = await first.json() as {
    reports: Array<{ id: string }>
    nextCursor?: string
  }
  expect(firstPage.reports.map(({ id }) => id)).toEqual(['alpha-report'])
  expect(firstPage.nextCursor).toBeString()

  const second = await app.request(
    `/api/analytics/reports?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(second.status).toBe(200)
  expect(await second.json()).toMatchObject({
    reports: [{ id: 'beta-report' }],
  })

  const invalid = await app.request('/api/analytics/reports?limit=201', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(invalid.status).toBe(400)
})

test('fails closed instead of returning a partial Analytics aggregate above its safe cap', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 10_001 })
  let auditReads = 0
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        auditReads += 1
        return { events: [] }
      },
    },
  })

  const response = await analyticsApiRequest(
    '/api/analytics/query',
    createAnalyticsQueryInput(),
  )

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    code: 'AnalyticsWorkItemLimitExceeded',
  })
  expect(auditReads).toBe(0)
}, 10_000)

test('filters inaccessible Work Items and unrelated audit pages before Analytics execution', async () => {
  configureFakeProjectClients(true, {
    inaccessibleTeamIssueCount: 1,
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    teamIssueCount: 2,
  })
  const auditQueries: Array<Record<string, unknown>> = []
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        auditQueries.push(input)
        return input.entityId === 'team/core-team/issue/work-item-1' && !input.cursor
          ? {
              events: [createAnalyticsAuditEvent(
                'workspace-member',
                'private-member',
                '2026-07-10T00:00:00.000Z',
              )],
              nextCursor: 'next-page',
            }
          : { events: [] }
      },
    },
  })

  const response = await analyticsApiRequest(
    '/api/analytics/query',
    createAnalyticsQueryInput(),
  )

  expect(response.status).toBe(200)
  const body = await response.json() as {
    snapshot: { widgets: Array<{ sampleSize: number; value: number | null }> }
  }
  expect(body.snapshot.widgets[0]).toMatchObject({ sampleSize: 1, value: 1 })
  expect(auditQueries).toHaveLength(3)
  expect(auditQueries.every((query) =>
    query.entityType === 'work-item' &&
    (
      query.entityId === 'team/core-team/issue/work-item-1' ||
      query.entityId === 'work-item-1'
    )
  )).toBe(true)
})

test('retries Analytics history reads until the latest canonical revision reaches the entity GSI', async () => {
  const current = createHistoricalAnalyticsWorkItem()
  const latestEvent = createHistoricalAnalyticsWorkItemEvent(current)
  const canonicalEntityId = `team/${current.teamId}/issue/${current.id}`
  let canonicalReads = 0
  let workItemReads = 0
  configureFakeProjectClients(true, {
    projectAccesses: [
      { projectId: 'project-before', role: 'viewer' },
      { projectId: 'project-after', role: 'viewer' },
    ],
    teamProjects: [
      { id: 'project-before', name: 'Before', tone: 'blue' },
      { id: 'project-after', name: 'After', tone: 'green' },
    ],
  })
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    teamIssues: {
      async getTeamIssues(_workspaceId, teamId) {
        workItemReads += 1
        return { teamId, issues: [current] }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['teamIssues']
    >,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        if (input.entityId !== canonicalEntityId) return { events: [] }
        canonicalReads += 1
        return canonicalReads === 1
          ? { events: [] }
          : { events: [latestEvent] }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  query.asOf = '2026-07-16T12:00:00.000Z'

  const response = await analyticsApiRequest('/api/analytics/query', query)

  expect(response.status).toBe(200)
  expect(canonicalReads).toBe(2)
  expect(workItemReads).toBe(3)
})

test('fails closed when Analytics history never reaches the latest canonical revision', async () => {
  const current = createHistoricalAnalyticsWorkItem()
  let workItemReads = 0
  configureFakeProjectClients(true, {
    projectAccesses: [
      { projectId: 'project-before', role: 'viewer' },
      { projectId: 'project-after', role: 'viewer' },
    ],
    teamProjects: [
      { id: 'project-before', name: 'Before', tone: 'blue' },
      { id: 'project-after', name: 'After', tone: 'green' },
    ],
  })
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    teamIssues: {
      async getTeamIssues(_workspaceId, teamId) {
        workItemReads += 1
        return { teamId, issues: [current] }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['teamIssues']
    >,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })

  const response = await analyticsApiRequest(
    '/api/analytics/query',
    createAnalyticsQueryInput(),
  )

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({
    code: 'AnalyticsReadBarrierUnavailable',
  })
  expect(workItemReads).toBe(4)
})

test('rewinds post-asOf status, project, and archive changes from current authorized state', async () => {
  const current = createHistoricalAnalyticsWorkItem()
  const futureEvent = createHistoricalAnalyticsWorkItemEvent(current)
  const includeArchivedReads: boolean[] = []
  const auditUpperBounds: string[] = []
  configureFakeProjectClients(true, {
    projectAccesses: [
      { projectId: 'project-before', role: 'viewer' },
      { projectId: 'project-after', role: 'viewer' },
    ],
    teamProjects: [
      { id: 'project-before', name: 'Before', tone: 'blue' },
      { id: 'project-after', name: 'After', tone: 'green' },
    ],
  })
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    teamIssues: {
      async getTeamIssues(_workspaceId, teamId, options) {
        includeArchivedReads.push(options?.includeArchived === true)
        return { teamId, issues: [current] }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['teamIssues']
    >,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        auditUpperBounds.push(input.to ?? '')
        return Date.parse(input.to ?? '') >= Date.parse(futureEvent.occurredAt)
          ? { events: [futureEvent] }
          : { events: [] }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  query.asOf = '2026-07-16T12:00:00.000Z'
  query.filter.projectIds = ['project-before']

  const response = await analyticsApiRequest('/api/analytics/query', query)

  expect(response.status).toBe(200)
  const body = await response.json() as {
    snapshot: { widgets: Array<{ sampleSize: number; value: number | null }> }
  }
  expect(body.snapshot.widgets[0]).toMatchObject({ sampleSize: 1, value: 1 })
  expect(includeArchivedReads).toEqual([true, true])
  expect(auditUpperBounds).toHaveLength(2)
  expect(auditUpperBounds.every((upperBound) =>
    Date.parse(upperBound) > Date.parse(futureEvent.occurredAt)
  )).toBe(true)
})

test('reads resolvable legacy raw Work Item audit identities through entity scope', async () => {
  const current = createHistoricalAnalyticsWorkItem()
  const futureEvent = createHistoricalAnalyticsWorkItemEvent(current)
  const rawEntityId = current.id
  const legacyEvent = {
    ...futureEvent,
    entity: { type: 'work-item' as const, id: rawEntityId },
    entityId: rawEntityId,
    entityKey: `user#demo@example.com#work-item#${rawEntityId}`,
    target: { type: 'work-item' as const, id: rawEntityId },
    targetId: rawEntityId,
    targetKey: `user#demo@example.com#work-item#${rawEntityId}`,
    metadata: {
      ...futureEvent.metadata,
      teamId: current.teamId,
      issueId: current.id,
    },
  }
  const auditQueries: Array<Record<string, unknown>> = []
  configureFakeProjectClients(true, {
    projectAccesses: [
      { projectId: 'project-before', role: 'viewer' },
      { projectId: 'project-after', role: 'viewer' },
    ],
    teamProjects: [
      { id: 'project-before', name: 'Before', tone: 'blue' },
      { id: 'project-after', name: 'After', tone: 'green' },
    ],
  })
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    teamIssues: {
      async getTeamIssues(_workspaceId, teamId) {
        return { teamId, issues: [current] }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['teamIssues']
    >,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        auditQueries.push(input)
        return input.entityId === rawEntityId
          ? { events: [legacyEvent] }
          : { events: [] }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  query.asOf = '2026-07-16T12:00:00.000Z'
  query.filter.projectIds = ['project-before']

  const response = await analyticsApiRequest('/api/analytics/query', query)

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    snapshot: {
      widgets: [{
        metric: 'wip',
        sampleSize: 1,
        value: 1,
      }],
    },
  })
  expect(auditQueries.map((input) => input.entityId).sort()).toEqual([
    rawEntityId,
    `team/${current.teamId}/issue/${current.id}`,
  ].sort())
})

test('rejects legacy raw Work Item events whose identity sources disagree', async () => {
  const current = createHistoricalAnalyticsWorkItem()
  const futureEvent = createHistoricalAnalyticsWorkItemEvent(current)
  const rawEntityId = current.id
  const rawIdentityFields = {
    entity: { type: 'work-item' as const, id: rawEntityId },
    entityId: rawEntityId,
    entityKey: `user#demo@example.com#work-item#${rawEntityId}`,
    target: { type: 'work-item' as const, id: rawEntityId },
    targetId: rawEntityId,
    targetKey: `user#demo@example.com#work-item#${rawEntityId}`,
    metadata: {
      ...futureEvent.metadata,
      teamId: current.teamId,
      issueId: current.id,
    },
  }
  const conflictingTarget = {
    ...futureEvent,
    ...rawIdentityFields,
    eventId: `${futureEvent.eventId}-target-conflict`,
    target: {
      type: 'work-item' as const,
      id: `team/inaccessible-team/issue/${rawEntityId}`,
    },
    targetId: `team/inaccessible-team/issue/${rawEntityId}`,
  }
  const conflictingMetadata = {
    ...futureEvent,
    ...rawIdentityFields,
    eventId: `${futureEvent.eventId}-metadata-conflict`,
    metadata: {
      ...rawIdentityFields.metadata,
      workItemId: 'different-item',
    },
  }
  const conflictingEntity = {
    ...futureEvent,
    ...rawIdentityFields,
    eventId: `${futureEvent.eventId}-entity-conflict`,
    entity: { type: 'work-item' as const, id: 'different-item' },
  }
  const nonWorkItemTarget = {
    ...futureEvent,
    ...rawIdentityFields,
    eventId: `${futureEvent.eventId}-target-type-conflict`,
    target: { type: 'project' as const, id: rawEntityId },
    targetType: 'project' as const,
    targetId: rawEntityId,
  }
  configureFakeProjectClients(true, {
    projectAccesses: [
      { projectId: 'project-before', role: 'viewer' },
      { projectId: 'project-after', role: 'viewer' },
    ],
    teamProjects: [
      { id: 'project-before', name: 'Before', tone: 'blue' },
      { id: 'project-after', name: 'After', tone: 'green' },
    ],
  })
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    teamIssues: {
      async getTeamIssues(_workspaceId, teamId) {
        return { teamId, issues: [current] }
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['teamIssues']
    >,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        return input.entityId === rawEntityId
          ? {
              events: [
                conflictingTarget,
                conflictingMetadata,
                conflictingEntity,
                nonWorkItemTarget,
              ],
            }
          : {
              events: [{
                ...futureEvent,
                changes: [],
              }],
            }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  query.asOf = '2026-07-16T12:00:00.000Z'
  query.filter.projectIds = ['project-before']

  const response = await analyticsApiRequest('/api/analytics/query', query)

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    snapshot: {
      widgets: [{
        metric: 'wip',
        sampleSize: 0,
        value: 0,
      }],
    },
  })
})

test('excludes historical Project state outside current ACL and invalidates its snapshots', async () => {
  const repository = new InMemoryAnalyticsRepository()
  const current = createHistoricalAnalyticsWorkItem()
  const futureEvent = createHistoricalAnalyticsWorkItemEvent(current)
  const projectDefinitions = [
    { id: 'project-before', name: 'Before', tone: 'blue' as const },
    { id: 'project-after', name: 'After', tone: 'green' as const },
  ]
  const configureHistoricalAccess = (
    projectIds: string[],
    activeProjectIds = ['project-before', 'project-after'],
  ) => {
    configureFakeProjectClients(true, {
      workspaceRole: 'owner',
      projectAccesses: projectIds.map((projectId) => ({
        projectId,
        role: 'viewer' as const,
      })),
      teamProjects: projectDefinitions.filter((project) =>
        activeProjectIds.includes(project.id)
      ),
    })
    setTestAppDependencies({
      analytics: repository,
      teamIssues: {
        async getTeamIssues(_workspaceId, teamId) {
          return { teamId, issues: [current] }
        },
      } as unknown as NonNullable<
        Parameters<typeof setTestAppDependencies>[0]['teamIssues']
      >,
      auditEvents: {
        async getEvent() {
          return undefined
        },
        async query() {
          return { events: [futureEvent] }
        },
      },
    })
  }
  const query = createAnalyticsQueryInput()
  query.asOf = '2026-07-16T12:00:00.000Z'

  configureHistoricalAccess(['project-after'])
  const excludedQuery = await analyticsApiRequest('/api/analytics/query', query)
  expect(excludedQuery.status).toBe(200)
  expect(await excludedQuery.json()).toMatchObject({
    snapshot: {
      widgets: [{
        metric: 'wip',
        sampleSize: 0,
        value: 0,
      }],
    },
  })
  const excludedEvidence = await analyticsApiRequest('/api/analytics/evidence', {
    metric: 'wip',
    filter: query.filter,
    asOf: query.asOf,
    timeZone: query.timeZone,
  })
  expect(excludedEvidence.status).toBe(200)
  expect(await excludedEvidence.json()).toMatchObject({ items: [] })

  configureHistoricalAccess(
    ['project-before', 'project-after'],
    ['project-after'],
  )
  const staleAccessQuery = await analyticsApiRequest('/api/analytics/query', query)
  expect(staleAccessQuery.status).toBe(200)
  expect(await staleAccessQuery.json()).toMatchObject({
    snapshot: {
      widgets: [{
        sampleSize: 0,
        value: 0,
      }],
    },
  })

  configureHistoricalAccess(['project-before', 'project-after'])
  await repository.createReport('user#demo@example.com', 'demo@example.com', {
    id: 'historical-scope-report',
    name: 'Historical scope report',
    visibility: 'personal',
    timeZone: query.timeZone,
    filter: query.filter,
    widgets: query.widgets,
  })
  const createdSnapshot = await analyticsApiRequest(
    '/api/analytics/reports/historical-scope-report/snapshots',
    query,
  )
  expect(createdSnapshot.status).toBe(201)
  const createdSnapshotBody = await createdSnapshot.json() as {
    snapshotRecord: AnalyticsSnapshotRecord
  }
  expect(createdSnapshotBody.snapshotRecord.snapshot.widgets[0]).toMatchObject({
    sampleSize: 1,
    value: 1,
  })

  configureHistoricalAccess(['project-after'])
  const hiddenSnapshots = await app.request(
    '/api/analytics/reports/historical-scope-report/snapshots',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(hiddenSnapshots.status).toBe(200)
  expect(await hiddenSnapshots.json()).toEqual({
    snapshots: [],
    inspectedCount: 1,
  })
  const deniedExport = await analyticsApiRequest('/api/analytics/export', {
    snapshotId: createdSnapshotBody.snapshotRecord.id,
    format: 'csv',
  })
  expect(deniedExport.status).toBe(403)
  expect(await deniedExport.json()).toMatchObject({
    code: 'AnalyticsSnapshotScopeChanged',
  })
})

test('continues snapshot ACL filtering past hidden rows with a bounded inspection cursor', async () => {
  const repository = new InMemoryAnalyticsRepository(
    () => new Date('2026-07-18T08:00:00.000Z'),
  )
  configureFakeProjectClients(true, { workspaceRole: 'owner' })
  setTestAppDependencies({
    analytics: repository,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  await repository.createReport('user#demo@example.com', 'demo@example.com', {
    id: 'snapshot-pagination-report',
    name: 'Snapshot pagination report',
    visibility: 'personal',
    timeZone: query.timeZone,
    filter: query.filter,
    widgets: query.widgets,
  })
  const created = await analyticsApiRequest(
    '/api/analytics/reports/snapshot-pagination-report/snapshots',
    query,
  )
  expect(created.status).toBe(201)
  const visibleRecord = (await created.json() as {
    snapshotRecord: AnalyticsSnapshotRecord
  }).snapshotRecord
  const hiddenRecords = Array.from({ length: 1_000 }, (_, offset) => {
    const index = offset + 1
    return {
      ...visibleRecord,
      id: `hidden-${String(index).padStart(4, '0')}`,
      createdAt: new Date(
        Date.parse(visibleRecord.createdAt) + index * 1_000,
      ).toISOString(),
      snapshot: {
        ...visibleRecord.snapshot,
        permissionScopeHash: '0'.repeat(64),
      },
    } satisfies AnalyticsSnapshotRecord
  })
  const visibleRecords = hiddenRecords.map((record) => ({
    ...record,
    snapshot: {
      ...record.snapshot,
      permissionScopeHash: visibleRecord.snapshot.permissionScopeHash,
    },
  }))
  let snapshotHistory: AnalyticsSnapshotRecord[] = []
  let repositoryPhysicalPageSize: number | undefined
  const snapshotCursorOffsets = new Map<string, number>()
  const snapshotPageLimits: number[] = []
  const setSnapshotHistory = (records: AnalyticsSnapshotRecord[]) => {
    snapshotHistory = records
    snapshotCursorOffsets.clear()
    for (const [index, record] of snapshotHistory.entries()) {
      snapshotCursorOffsets.set(
        createAnalyticsSnapshotListCursor(
          visibleRecord.workspaceId,
          visibleRecord.reportId!,
          record,
        ),
        index + 1,
      )
    }
    snapshotPageLimits.length = 0
    repositoryPhysicalPageSize = undefined
  }
  repository.listSnapshots = async (workspaceId, reportId, limit = 100, cursor) => {
    snapshotPageLimits.push(limit)
    const offset = cursor === undefined ? 0 : snapshotCursorOffsets.get(cursor)
    if (offset === undefined) {
      throw new TypeError('Snapshot cursor scope mismatch.')
    }
    const effectiveLimit = Math.min(
      limit,
      repositoryPhysicalPageSize ?? limit,
    )
    const snapshots = snapshotHistory.slice(offset, offset + effectiveLimit)
    const nextOffset = offset + snapshots.length
    const lastSnapshot = snapshots.at(-1)
    return {
      snapshots,
      ...(nextOffset < snapshotHistory.length && lastSnapshot !== undefined
        ? {
            nextCursor: createAnalyticsSnapshotListCursor(
              workspaceId,
              reportId,
              lastSnapshot,
            ),
          }
        : {}),
    }
  }

  setSnapshotHistory([...hiddenRecords.slice(0, 100).reverse(), visibleRecord])
  const pastFirstStoragePage = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(pastFirstStoragePage.status).toBe(200)
  expect(await pastFirstStoragePage.json()).toEqual({
    snapshots: [visibleRecord],
    inspectedCount: 101,
  } satisfies AnalyticsSnapshotListResponse)
  expect(snapshotPageLimits).toEqual([100, 100])

  setSnapshotHistory([...hiddenRecords].reverse().concat(visibleRecord))
  const inspectionLimited = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(inspectionLimited.status).toBe(200)
  const inspectionLimitedBody =
    await inspectionLimited.json() as AnalyticsSnapshotListResponse
  expect(inspectionLimitedBody).toMatchObject({
    snapshots: [],
    inspectedCount: 1_000,
  })
  expect(inspectionLimitedBody.nextCursor).toBeDefined()
  expect(snapshotPageLimits).toEqual(Array.from({ length: 10 }, () => 100))

  snapshotPageLimits.length = 0
  const continued = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots?' +
      `cursor=${encodeURIComponent(inspectionLimitedBody.nextCursor!)}`,
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(continued.status).toBe(200)
  expect(await continued.json()).toEqual({
    snapshots: [visibleRecord],
    inspectedCount: 1,
  } satisfies AnalyticsSnapshotListResponse)
  expect(snapshotPageLimits).toEqual([100])

  setSnapshotHistory([
    ...visibleRecords.slice(0, 99),
    ...hiddenRecords.slice(99, 999),
    visibleRecords[999]!,
  ])
  const sparseVisiblePage = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(sparseVisiblePage.status).toBe(200)
  expect(await sparseVisiblePage.json()).toEqual({
    snapshots: [
      ...visibleRecords.slice(0, 99),
      visibleRecords[999]!,
    ],
    inspectedCount: 1_000,
  } satisfies AnalyticsSnapshotListResponse)
  expect(snapshotPageLimits).toEqual(Array.from({ length: 10 }, () => 100))

  setSnapshotHistory([
    ...visibleRecords.slice(0, 99),
    hiddenRecords[99]!,
    ...visibleRecords.slice(100, 201),
  ])
  const partialPage = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(partialPage.status).toBe(200)
  const partialPageBody = await partialPage.json() as AnalyticsSnapshotListResponse
  expect(partialPageBody).toEqual({
    snapshots: [
      ...visibleRecords.slice(0, 99),
      visibleRecords[100]!,
    ],
    inspectedCount: 101,
    nextCursor: createAnalyticsSnapshotListCursor(
      visibleRecord.workspaceId,
      visibleRecord.reportId!,
      visibleRecords[100]!,
    ),
  } satisfies AnalyticsSnapshotListResponse)
  expect(snapshotPageLimits).toEqual([100, 100])

  snapshotPageLimits.length = 0
  const partialPageContinuation = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots?' +
      `cursor=${encodeURIComponent(partialPageBody.nextCursor!)}`,
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(partialPageContinuation.status).toBe(200)
  expect(await partialPageContinuation.json()).toEqual({
    snapshots: visibleRecords.slice(101, 201),
    inspectedCount: 100,
  } satisfies AnalyticsSnapshotListResponse)
  expect(snapshotPageLimits).toEqual([100])

  setSnapshotHistory([...hiddenRecords.slice(0, 12), visibleRecord])
  repositoryPhysicalPageSize = 1
  const readLimited = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(readLimited.status).toBe(200)
  const readLimitedBody = await readLimited.json() as AnalyticsSnapshotListResponse
  expect(readLimitedBody).toMatchObject({
    snapshots: [],
    inspectedCount: 10,
  })
  expect(readLimitedBody.nextCursor).toBeDefined()
  expect(snapshotPageLimits).toEqual(Array.from({ length: 10 }, () => 100))

  snapshotPageLimits.length = 0
  const readLimitedContinuation = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots?' +
      `cursor=${encodeURIComponent(readLimitedBody.nextCursor!)}`,
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(readLimitedContinuation.status).toBe(200)
  expect(await readLimitedContinuation.json()).toEqual({
    snapshots: [visibleRecord],
    inspectedCount: 3,
  } satisfies AnalyticsSnapshotListResponse)
  expect(snapshotPageLimits).toEqual([100, 100, 100])

  const invalidCursor = await app.request(
    '/api/analytics/reports/snapshot-pagination-report/snapshots?cursor=%24',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(invalidCursor.status).toBe(400)
  expect(await invalidCursor.json()).toMatchObject({
    code: 'InvalidAnalyticsInput',
  })
}, 15_000)

test('preserves report-bound snapshot queries, saved baselines, and server-owned schedule cursors', async () => {
  const repository = new InMemoryAnalyticsRepository(
    () => new Date('2026-07-18T08:00:00.000Z'),
  )
  configureFakeProjectClients(true, { workspaceRole: 'owner' })
  setTestAppDependencies({
    analytics: repository,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })
  const createInput = {
    id: 'analytics-api-report',
    name: 'Analytics API report',
    visibility: 'personal',
    timeZone: 'UTC',
    filter: createAnalyticsQueryInput().filter,
    forecastBaseline: {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:59:59.999Z',
    },
    widgets: createAnalyticsQueryInput().widgets,
    schedule: {
      enabled: true,
      frequency: 'daily',
      timeZone: 'UTC',
      localTime: '09:00',
      recipientMemberKeys: ['demo@example.com'],
      format: 'csv',
      nextRunAt: '2099-01-01T00:00:00.000Z',
    },
  }
  const createdResponse = await analyticsApiRequest(
    '/api/analytics/reports',
    createInput,
  )
  expect(createdResponse.status).toBe(201)
  const created = await createdResponse.json() as {
    report: {
      revision: number
      forecastBaseline?: { from: string; to: string }
      schedule?: { nextRunAt?: string }
    }
  }
  expect(created.report.forecastBaseline).toEqual(createInput.forecastBaseline)
  expect(created.report.schedule?.nextRunAt).toBe('2026-07-18T09:00:00.000Z')

  const savedQueryResponse = await analyticsApiRequest('/api/analytics/query', {
    reportId: createInput.id,
    asOf: '2026-07-18T08:30:00.000Z',
    forecastBaseline: {
      from: '2099-01-01T00:00:00.000Z',
      to: '2099-01-31T23:59:59.999Z',
    },
  })
  expect(savedQueryResponse.status).toBe(200)
  expect(await savedQueryResponse.json()).toMatchObject({
    snapshot: {
      forecast: {
        baseline: createInput.forecastBaseline,
      },
    },
  })

  const sameScheduleResponse = await analyticsApiRequest(
    `/api/analytics/reports/${createInput.id}`,
    {
      expectedRevision: 1,
      name: 'Renamed report',
      schedule: {
        ...createInput.schedule,
        nextRunAt: '2000-01-01T00:00:00.000Z',
      },
    },
    'PATCH',
  )
  expect(sameScheduleResponse.status).toBe(200)
  const sameSchedule = await sameScheduleResponse.json() as {
    report: { revision: number; schedule?: { nextRunAt?: string } }
  }
  expect(sameSchedule.report.revision).toBe(2)
  expect(sameSchedule.report.schedule?.nextRunAt).toBe('2026-07-18T09:00:00.000Z')

  const changedScheduleResponse = await analyticsApiRequest(
    `/api/analytics/reports/${createInput.id}`,
    {
      expectedRevision: 2,
      schedule: {
        ...createInput.schedule,
        localTime: '10:00',
        nextRunAt: '2099-01-01T00:00:00.000Z',
      },
    },
    'PATCH',
  )
  expect(changedScheduleResponse.status).toBe(200)
  const changedSchedule = await changedScheduleResponse.json() as {
    report: { revision: number; schedule?: { nextRunAt?: string } }
  }
  expect(changedSchedule.report.revision).toBe(3)
  expect(changedSchedule.report.schedule?.nextRunAt).toBe('2026-07-18T10:00:00.000Z')

  const inlineQuery = {
    ...createAnalyticsQueryInput(),
    filter: {
      ...createAnalyticsQueryInput().filter,
      teamIds: ['core-team'],
    },
    forecastBaseline: {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
    },
    timeZone: 'Asia/Tokyo',
    widgets: [{
      id: 'inline-wip',
      type: 'metric',
      title: 'Inline WIP',
      metric: 'wip',
    }],
  } satisfies AnalyticsQueryInput
  const snapshotResponse = await analyticsApiRequest(
    `/api/analytics/reports/${createInput.id}/snapshots`,
    inlineQuery,
  )
  expect(snapshotResponse.status).toBe(201)
  const snapshotBody = await snapshotResponse.json() as {
    snapshotRecord: AnalyticsSnapshotRecord
  }
  expect(snapshotBody.snapshotRecord.query).toEqual({
    filter: {
      ...createInput.filter,
      period: {
        ...createInput.filter.period,
        to: inlineQuery.asOf,
      },
    },
    widgets: createInput.widgets,
    asOf: inlineQuery.asOf,
    timeZone: createInput.timeZone,
    forecastBaseline: createInput.forecastBaseline,
  })
  expect(snapshotBody.snapshotRecord.reportRevision).toBe(3)

  configureFakeProjectClients(false, { workspaceRole: 'owner' })
  const hiddenSnapshots = await app.request(
    `/api/analytics/reports/${createInput.id}/snapshots`,
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(hiddenSnapshots.status).toBe(200)
  expect(await hiddenSnapshots.json()).toEqual({
    snapshots: [],
    inspectedCount: 1,
  })
  const deniedExport = await analyticsApiRequest('/api/analytics/export', {
    snapshotId: snapshotBody.snapshotRecord.id,
    format: 'csv',
  })
  expect(deniedExport.status).toBe(403)
  expect(await deniedExport.json()).toMatchObject({
    code: 'AnalyticsSnapshotScopeChanged',
  })

  const stalePatch = await analyticsApiRequest(
    `/api/analytics/reports/${createInput.id}`,
    { expectedRevision: 1, name: 'Stale edit' },
    'PATCH',
  )
  expect(stalePatch.status).toBe(409)
  expect(await stalePatch.json()).toMatchObject({ code: 'AnalyticsRevisionConflict' })
})

test('returns current-ACL evidence and CSV exports from Analytics endpoints', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  const evidence = await analyticsApiRequest('/api/analytics/evidence', {
    metric: 'wip',
    filter: query.filter,
    asOf: query.asOf,
    timeZone: query.timeZone,
  })
  expect(evidence.status).toBe(200)
  expect(await evidence.json()).toMatchObject({
    items: [expect.objectContaining({ workItemId: 'onboarding-friction' })],
  })

  const exported = await analyticsApiRequest('/api/analytics/export', {
    query,
    format: 'csv',
    locale: 'ja-JP',
  })
  expect(exported.status).toBe(200)
  expect(exported.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
  expect(await exported.text()).toContain('ウィジェットID,指標キー,指標,値')
})
