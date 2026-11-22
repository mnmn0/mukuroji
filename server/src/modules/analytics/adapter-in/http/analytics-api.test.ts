import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  analyticsApiRequest,
  app,
  configureFakeProjectClients,
  getTestAppDependencies,
  createAnalyticsAuditEvent,
  createAnalyticsQueryInput,
  createHistoricalAnalyticsWorkItem,
  createHistoricalAnalyticsWorkItemEvent,
  createTeamIssuesFake,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  createAnalyticsSnapshotListCursor,
  InMemoryAnalyticsRepository,
} from '../../analytics'
import {
  createDefaultTenantAdministrationSnapshot,
} from '../../../tenant-administration'
import { InMemoryPlanningClient } from '../../../planning/planning'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import type {
  AnalyticsQueryInput,
  AnalyticsSnapshotListResponse,
  AnalyticsSnapshotRecord,
  EnterpriseCustomRole,
  EnterpriseRoleAssignment,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/**
 * Creates the shared Analytics query with a period that starts before the fake Work Items were
 * last updated, so their entity timelines still have to be read.
 *
 * @returns Analytics query input whose period covers the fake Work Item updates.
 */
function createHistoryAnalyticsQueryInput(): AnalyticsQueryInput {
  const query = createAnalyticsQueryInput()
  query.filter.period = { ...query.filter.period, from: '2026-06-01T00:00:00.000Z' }
  return query
}

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
    ...createHistoryAnalyticsQueryInput(),
    filter: {
      ...createHistoryAnalyticsQueryInput().filter,
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
  expect(auditQueries).toHaveLength(250)
  expect(auditQueries.every((query) =>
    query.direction === 'ascending' &&
    query.entityType === 'work-item' &&
    typeof query.entityId === 'string'
  )).toBe(true)
  expect(new Set(auditQueries.map((query) => query.entityId)).size).toBe(250)
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

test('fails before audit reads when canonical entity fan-out exceeds the API cap', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 501 })
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
    ...createHistoryAnalyticsQueryInput(),
    filter: {
      ...createHistoryAnalyticsQueryInput().filter,
      teamIds: ['core-team'],
    },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    code: 'AnalyticsHistoryLimitExceeded',
  })
  expect(auditReads).toBe(0)
})

test('evaluates a 3,000-item Team without reading timelines untouched since the period start', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 3_000 })
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
  const query = createAnalyticsQueryInput()

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    filter: { ...query.filter, teamIds: ['core-team'] },
  })
  const snapshotResponse = await analyticsApiRequest('/api/analytics/export', {
    format: 'csv',
    query: { ...query, filter: { ...query.filter, teamIds: ['core-team'] } },
  })

  expect(response.status).toBe(200)
  const body = await response.json() as {
    snapshot: { widgets: Array<{ sampleSize: number; value: number | null }> }
  }
  expect(body.snapshot.widgets[0]).toMatchObject({ sampleSize: 3_000, value: 3_000 })
  expect(snapshotResponse.status).toBe(200)
  expect(auditReads).toBe(0)
})

test('narrows Analytics reads to the listed Work Items before the history fan-out cap', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 501 })
  const auditEntityIds: unknown[] = []
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        auditEntityIds.push(input.entityId)
        return { events: [] }
      },
    },
  })
  const query = createHistoryAnalyticsQueryInput()

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    filter: {
      ...query.filter,
      workItems: [
        { teamId: 'core-team', workItemId: 'work-item-7' },
        { teamId: 'core-team', workItemId: 'work-item-9' },
        { teamId: 'core-team', workItemId: 'missing-item' },
      ],
    },
    widgets: [{
      id: 'burndown',
      title: 'Burndown',
      type: 'chart',
      metric: 'remaining-scope',
      visualization: 'burndown',
    }],
  })

  expect(response.status).toBe(200)
  expect(new Set(auditEntityIds)).toEqual(new Set([
    'team/core-team/issue/work-item-7',
    'team/core-team/issue/work-item-9',
  ]))
})

test('bounds shared Analytics page reads for paginated canonical events', async () => {
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
              id: 'non-canonical-entity',
            },
          }],
          nextCursor: `page-${auditReads}`,
        }
      },
    },
  })

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...createHistoryAnalyticsQueryInput(),
    filter: {
      ...createHistoryAnalyticsQueryInput().filter,
      teamIds: ['core-team'],
    },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    code: 'AnalyticsHistoryLimitExceeded',
  })
  expect(auditReads).toBe(500)
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
    createHistoryAnalyticsQueryInput(),
  )

  expect(response.status).toBe(200)
  const body = await response.json() as {
    snapshot: { widgets: Array<{ sampleSize: number; value: number | null }> }
  }
  expect(body.snapshot.widgets[0]).toMatchObject({ sampleSize: 1, value: 1 })
  expect(auditQueries).toHaveLength(2)
  expect(auditQueries.every((query) =>
    query.entityType === 'work-item' &&
    query.entityId === 'team/core-team/issue/work-item-1'
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
      ...createTeamIssuesFake(),
      async getTeamIssues(_workspaceId, teamId) {
        workItemReads += 1
        return { teamId, issues: [current] }
      },
    },
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
      ...createTeamIssuesFake(),
      async getTeamIssues(_workspaceId, teamId) {
        workItemReads += 1
        return { teamId, issues: [current] }
      },
    },
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
      ...createTeamIssuesFake(),
      async getTeamIssues(_workspaceId, teamId, options) {
        includeArchivedReads.push(options?.includeArchived === true)
        return { teamId, issues: [current] }
      },
    },
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
  expect(auditUpperBounds).toHaveLength(1)
  expect(auditUpperBounds.every((upperBound) =>
    Date.parse(upperBound) > Date.parse(futureEvent.occurredAt)
  )).toBe(true)
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
        ...createTeamIssuesFake(),
        async getTeamIssues(_workspaceId, teamId) {
          return { teamId, issues: [current] }
        },
      },
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

  const grouped = {
    ...query,
    widgets: [{
      id: 'wip-by-team',
      type: 'chart' as const,
      title: 'WIP',
      metric: 'wip' as const,
      groupBy: { dimension: 'team' as const },
    }],
  }
  const englishCsv = await analyticsApiRequest('/api/analytics/export', {
    query: grouped,
    format: 'csv',
    locale: 'en',
  })
  expect(englishCsv.status).toBe(200)
  const englishText = await englishCsv.text()
  expect(englishText).toContain('Group,Core Team,')
  expect(englishText).toContain(',core-team,,')
  const englishPdf = await analyticsApiRequest('/api/analytics/export', {
    query: grouped,
    format: 'pdf',
    locale: 'en',
  })
  expect(englishPdf.status).toBe(200)
  const pdfSource = Buffer.from(await englishPdf.arrayBuffer()).toString('latin1')
  expect(pdfSource).toContain('(    Core Team: ')
  expect(pdfSource).not.toContain('core-team')
})

/**
 * Makes the test Workspace read as having saved Sunday weeks and April fiscal years.
 */
function useSundayWeekWorkspaceCalendar() {
  const profile = {
    ...createDefaultTenantAdministrationSnapshot(
      'user#demo@example.com',
      'demo@example.com',
      '2026-11-01T00:00:00.000Z',
    ).profile,
    calendar: {
      fiscalYearStartMonth: 4,
      weekStartDay: 0 as const,
      workingWeekdays: ['monday' as const],
      holidays: [],
      publicHolidays: 'none' as const,
    },
  }
  return new Proxy(getTestAppDependencies().workspace.tenantAdministration, {
    get(target, property, receiver) {
      if (property === 'getProfile') return async () => profile
      return Reflect.get(target, property, receiver)
    },
  })
}

test('starts Analytics weeks on the Workspace week start and re-resolves saved relative periods', async () => {
  configureFakeProjectClients(true, { teamIssueCount: 0 })
  const repository = new InMemoryAnalyticsRepository()
  const weekly = [{
    id: 'weekly',
    type: 'chart' as const,
    title: 'Weekly throughput',
    metric: 'throughput' as const,
    groupBy: { dimension: 'week' as const },
  }]
  await repository.createReport('user#demo@example.com', 'demo@example.com', {
    id: 'this-week',
    name: 'This week',
    visibility: 'personal',
    timeZone: 'UTC',
    filter: {
      period: { from: '2026-01-04T00:00:00.000Z', to: '2026-01-10T23:59:59.999Z' },
      periodPreset: 'this-week',
    },
    widgets: weekly,
  })
  setTestAppDependencies({
    analytics: repository,
    tenantAdministration: useSundayWeekWorkspaceCalendar(),
    tenantLifecycleEnforcement: { async assertActive() {} },
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })

  // A client asking for Monday weeks still gets the Workspace's Sunday weeks.
  const adHoc = await analyticsApiRequest('/api/analytics/query', {
    ...createAnalyticsQueryInput(),
    weekStartDay: 1,
    widgets: weekly,
  })
  expect(adHoc.status).toBe(200)
  const adHocBody = await adHoc.json() as {
    snapshot: { widgets: Array<{ series: Array<{ from: string }> }> }
  }
  // 2026-07-01 is a Wednesday, so the second week starts on Sunday 2026-07-05.
  expect(adHocBody.snapshot.widgets[0]?.series[1]?.from).toBe('2026-07-05T00:00:00.000Z')

  // Thursday 2026-11-26: the saved "this week" report covers Sunday 11-22 up to the run time.
  const saved = await analyticsApiRequest('/api/analytics/query', {
    reportId: 'this-week',
    asOf: '2026-11-26T12:00:00.000Z',
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({
    snapshot: {
      filter: {
        period: { from: '2026-11-22T00:00:00.000Z', to: '2026-11-26T12:00:00.000Z' },
        periodPreset: 'this-week',
      },
    },
  })

  const snapshot = await analyticsApiRequest('/api/analytics/reports/this-week/snapshots', {
    asOf: '2026-11-26T12:00:00.000Z',
  })
  expect(snapshot.status).toBe(201)
  expect(await snapshot.json()).toMatchObject({
    snapshotRecord: {
      query: {
        filter: { period: { from: '2026-11-22T00:00:00.000Z' }, periodPreset: 'this-week' },
        weekStartDay: 0,
      },
    },
  })
})

/**
 * Creates a Milestone input for the in-memory Planning client.
 *
 * @param id - Milestone ID.
 * @param expectedRevision - Planning revision before the create.
 * @param scope - Team and Project scope; both undefined for a Workspace Milestone.
 * @returns Planning entity creation input.
 */
function createMilestoneInput(
  id: string,
  expectedRevision: number,
  scope: { teamId?: string, projectId?: string },
) {
  return {
    id,
    type: 'milestone' as const,
    title: `Milestone ${id}`,
    parentId: 'trend-roadmap',
    ...scope,
    ownerMemberKey: 'demo@example.com',
    status: 'active' as const,
    health: 'on-track' as const,
    risk: 'low' as const,
    progressMode: 'automatic' as const,
    baseline: { startDate: '2026-08-10', endDate: '2026-08-10' },
    forecast: { startDate: '2026-08-20', endDate: '2026-08-20' },
    expectedRevision,
  }
}

test('draws the Milestone trend from the readable Milestones and their Planning audit history', async () => {
  configureFakeProjectClients(true)
  const planning = new InMemoryPlanningClient(() => new Date('2026-07-01T00:00:00.000Z'))
  const workspaceParent = (id: string, type: 'portfolio' | 'roadmap', expectedRevision: number) => ({
    ...createMilestoneInput(id, expectedRevision, {}),
    type,
    title: id,
    parentId: type === 'roadmap' ? 'trend-portfolio' : undefined,
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
  })
  await planning.create('user#demo@example.com', workspaceParent('trend-portfolio', 'portfolio', 0), {
    workItems: [],
  })
  await planning.create('user#demo@example.com', workspaceParent('trend-roadmap', 'roadmap', 1), {
    workItems: [],
  })
  await planning.create('user#demo@example.com', createMilestoneInput('milestone-core', 2, {
    teamId: 'core-team',
    projectId: 'refero',
  }), { workItems: [] })
  await planning.create('user#demo@example.com', createMilestoneInput('milestone-workspace', 3, {}), {
    workItems: [],
  })
  const auditQueries: Array<Record<string, unknown>> = []
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    planning,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        auditQueries.push({ ...input })
        if (input.entityType !== 'planning-entity' || input.entityId !== 'milestone-core') {
          return { events: [] }
        }
        const event = createAnalyticsAuditEvent(
          'planning-entity',
          'milestone-core',
          '2026-07-10T09:00:00.000Z',
        )
        return {
          events: [{
            ...event,
            metadata: { teamId: 'core-team', projectId: 'refero' },
            changes: [{ field: 'forecast.endDate', before: '2026-08-10', after: '2026-08-20' }],
          }],
        }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  const widgets = [{
    id: 'trend',
    type: 'chart' as const,
    title: 'Milestone trend',
    metric: 'milestone-trend' as const,
    visualization: 'line' as const,
    groupBy: { dimension: 'week' as const },
  }]

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    filter: { ...query.filter, projectIds: ['refero'] },
    widgets,
  })

  expect(response.status).toBe(200)
  const { snapshot } = await response.json()
  expect(snapshot.widgets[0].groups).toEqual([
    { key: 'milestone-core', label: 'Milestone milestone-core', value: 10, sampleSize: 1 },
  ])
  expect(snapshot.widgets[0].series[0].segments).toEqual([{ key: 'milestone-core', value: 20675 }])
  expect(snapshot.widgets[0].series.at(-1).segments).toEqual([{ key: 'milestone-core', value: 20685 }])
  // The Project filter leaves out the Workspace Milestone, so only one timeline is read.
  expect(auditQueries.filter((input) => input.entityType === 'planning-entity')).toEqual([
    expect.objectContaining({ entityId: 'milestone-core', direction: 'ascending' }),
  ])

  // A guest who can read only the Project never sees the Workspace Milestone.
  configureFakeProjectClients(false, {
    workspaceRole: 'guest',
    role: 'viewer',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }],
  })
  const guest = await analyticsApiRequest('/api/analytics/query', { ...query, widgets })
  expect(guest.status).toBe(200)
  expect((await guest.json()).snapshot.widgets[0].groups.map((group: { key: string }) => group.key))
    .toEqual(['milestone-core'])

  // An audit index that has not caught up with the latest forecast fails closed.
  setTestAppDependencies({
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        if (input.entityType !== 'planning-entity' || input.entityId !== 'milestone-core') {
          return { events: [] }
        }
        const event = createAnalyticsAuditEvent('planning-entity', 'milestone-core', '2026-07-10T09:00:00.000Z')
        return {
          events: [{
            ...event,
            metadata: { teamId: 'core-team', projectId: 'refero' },
            changes: [{ field: 'forecast.endDate', before: '2026-08-10', after: '2026-08-15' }],
          }],
        }
      },
    },
  })
  const stale = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    filter: { ...query.filter, projectIds: ['refero'] },
    widgets,
  })
  expect(stale.status).toBe(503)
  expect(await stale.json()).toMatchObject({ code: 'AnalyticsReadBarrierUnavailable' })

  // An ancestor moved the Milestone to another Team and back without events of its own. The date
  // changed while it sat in the other Team stays hidden, and so does the earlier date.
  setTestAppDependencies({
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        if (input.entityType !== 'planning-entity' || input.entityId !== 'milestone-core') {
          return { events: [] }
        }
        const event = createAnalyticsAuditEvent('planning-entity', 'milestone-core', '2026-07-10T09:00:00.000Z')
        return {
          events: [{
            ...event,
            metadata: { teamId: 'other-team' },
            changes: [{ field: 'forecast.endDate', before: '2026-08-10', after: '2026-08-20' }],
          }],
        }
      },
    },
  })
  const roundTrip = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    filter: { ...query.filter, projectIds: ['refero'] },
    widgets,
  })
  expect(roundTrip.status).toBe(200)
  const roundTripWidget = (await roundTrip.json()).snapshot.widgets[0]
  expect(roundTripWidget.groups).toEqual([
    { key: 'milestone-core', label: 'Milestone milestone-core', value: 0, sampleSize: 0 },
  ])
  expect(roundTripWidget.series.flatMap((point: { segments: Array<{ value: number }> }) =>
    point.segments.map((segment) => segment.value))).not.toContain(20675)
})

test('reads Enterprise Milestones by planning.read instead of the Work Item scopes', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', projectAccesses: [], teamProjects: [] })
  const workspaceId = 'user#demo@example.com'
  const planning = new InMemoryPlanningClient(() => new Date('2026-07-01T00:00:00.000Z'))
  const parent = (id: string, type: 'portfolio' | 'roadmap', expectedRevision: number) => ({
    ...createMilestoneInput(id, expectedRevision, {}),
    type,
    title: id,
    parentId: type === 'roadmap' ? 'trend-portfolio' : undefined,
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
  })
  await planning.create(workspaceId, parent('trend-portfolio', 'portfolio', 0), { workItems: [] })
  await planning.create(workspaceId, parent('trend-roadmap', 'roadmap', 1), { workItems: [] })
  await planning.create(workspaceId, createMilestoneInput('milestone-core', 2, { teamId: 'core-team' }), {
    workItems: [],
  })
  await planning.create(workspaceId, createMilestoneInput('milestone-planning', 3, {
    teamId: 'planning-team',
  }), { workItems: [] })
  const identity = new InMemoryEnterpriseIdentityClient()
  const readIdentity = identity.getSnapshot.bind(identity)
  const assignments: EnterpriseRoleAssignment[] = [
    {
      workspaceId, assignmentId: 'core-member', principalKind: 'member', principalId: 'demo@example.com',
      roleId: 'team:member', scope: { workspaceId, kind: 'team', targetId: 'core-team' }, source: 'direct',
    },
    {
      workspaceId, assignmentId: 'planning-reader', principalKind: 'member', principalId: 'demo@example.com',
      roleId: 'custom:planning-reader', scope: { workspaceId, kind: 'team', targetId: 'planning-team' },
      source: 'direct',
    },
  ]
  const customRole: EnterpriseCustomRole = {
    workspaceId, roleId: 'custom:planning-reader', name: 'Planning reader',
    permissions: ['planning.read'], guestAssignable: false, revision: 1,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  }
  identity.getSnapshot = async (id) => ({
    ...await readIdentity(id),
    roleAssignments: assignments,
    customRoles: [customRole],
  })
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    planning,
    enterpriseIdentity: identity,
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

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    filter: { ...query.filter, teamIds: ['core-team', 'planning-team'] },
    widgets: [{
      id: 'trend',
      type: 'table' as const,
      title: 'Milestone trend',
      metric: 'milestone-trend' as const,
    }],
  })

  expect(response.status).toBe(200)
  // The Planning-only Team grant shows its Milestone although it gives no Work Item access.
  expect((await response.json()).snapshot.widgets[0].rows.map((row: { id: string }) => row.id).sort())
    .toEqual(['milestone-core', 'milestone-planning'])
})

test('retries and fails closed while a new Milestone has no visible audit event', async () => {
  configureFakeProjectClients(true)
  const workspaceId = 'user#demo@example.com'
  const planning = new InMemoryPlanningClient(() => new Date())
  const parent = (id: string, type: 'portfolio' | 'roadmap', expectedRevision: number) => ({
    ...createMilestoneInput(id, expectedRevision, {}),
    type,
    title: id,
    parentId: type === 'roadmap' ? 'trend-portfolio' : undefined,
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
  })
  await planning.create(workspaceId, parent('trend-portfolio', 'portfolio', 0), { workItems: [] })
  await planning.create(workspaceId, parent('trend-roadmap', 'roadmap', 1), { workItems: [] })
  await planning.create(workspaceId, createMilestoneInput('milestone-new', 2, {
    teamId: 'core-team',
    projectId: 'refero',
  }), { workItems: [] })
  let milestoneQueries = 0
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    planning,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        if (input.entityType === 'planning-entity') milestoneQueries += 1
        return { events: [] }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  const now = new Date()

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    asOf: now.toISOString(),
    filter: {
      ...query.filter,
      period: { from: new Date(now.getTime() - 86_400_000).toISOString(), to: now.toISOString() },
      projectIds: ['refero'],
    },
    widgets: [{
      id: 'trend',
      type: 'table' as const,
      title: 'Milestone trend',
      metric: 'milestone-trend' as const,
    }],
  })

  // The creation event is not visible yet, so the empty history is not taken as pre-audit.
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'AnalyticsReadBarrierUnavailable' })
  expect(milestoneQueries).toBe(3)
})

test('waits for pending Milestone audit reads before failing at the event limit', async () => {
  configureFakeProjectClients(true)
  const workspaceId = 'user#demo@example.com'
  const planning = new InMemoryPlanningClient(() => new Date('2026-07-01T00:00:00.000Z'))
  const parent = (id: string, type: 'portfolio' | 'roadmap', expectedRevision: number) => ({
    ...createMilestoneInput(id, expectedRevision, {}),
    type,
    title: id,
    parentId: type === 'roadmap' ? 'trend-portfolio' : undefined,
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
  })
  await planning.create(workspaceId, parent('trend-portfolio', 'portfolio', 0), { workItems: [] })
  await planning.create(workspaceId, parent('trend-roadmap', 'roadmap', 1), { workItems: [] })
  // Six long timelines and one slow short one: 9,953 events, under the 10,000-event limit.
  const eventCounts = new Map([
    ['milestone-slow', 5],
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((suffix): [string, number] => [`milestone-${suffix}`, 1_658]),
  ])
  let revision = 2
  for (const id of eventCounts.keys()) {
    await planning.create(workspaceId, createMilestoneInput(id, revision, {
      teamId: 'core-team',
      projectId: 'refero',
    }), { workItems: [] })
    revision += 1
  }
  const base = createAnalyticsAuditEvent('planning-entity', 'milestone-template', '2026-06-01T00:00:00.000Z')
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    planning,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        const total = input.entityType === 'planning-entity' && input.entityId !== undefined
          ? eventCounts.get(input.entityId) ?? 0
          : 0
        // The slow timeline holds its reservation while the long timelines reach the limit.
        if (input.entityId === 'milestone-slow') await new Promise((resolve) => setTimeout(resolve, 50))
        const offset = Number(input.cursor ?? '0')
        const end = Math.min(total, offset + (input.limit ?? 100))
        return {
          events: Array.from({ length: end - offset }, (_, index) => ({
            ...base,
            eventId: `${input.entityId}-${offset + index}`,
            entityId: input.entityId ?? '',
            metadata: { teamId: 'core-team', projectId: 'refero' },
            changes: [],
          })),
          ...(end < total ? { nextCursor: String(end) } : {}),
        }
      },
    },
  })
  const query = createAnalyticsQueryInput()

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    filter: { ...query.filter, projectIds: ['refero'] },
    widgets: [{
      id: 'trend',
      type: 'table' as const,
      title: 'Milestone trend',
      metric: 'milestone-trend' as const,
    }],
  })

  expect(response.status).toBe(200)
  expect((await response.json()).snapshot.widgets[0].rows).toHaveLength(7)
})

test('never lets parallel Milestone audit reads reserve past the event limit', async () => {
  configureFakeProjectClients(true)
  const workspaceId = 'user#demo@example.com'
  const planning = new InMemoryPlanningClient(() => new Date('2026-07-01T00:00:00.000Z'))
  const parent = (id: string, type: 'portfolio' | 'roadmap', expectedRevision: number) => ({
    ...createMilestoneInput(id, expectedRevision, {}),
    type,
    title: id,
    parentId: type === 'roadmap' ? 'trend-portfolio' : undefined,
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
  })
  await planning.create(workspaceId, parent('trend-portfolio', 'portfolio', 0), { workItems: [] })
  await planning.create(workspaceId, parent('trend-roadmap', 'roadmap', 1), { workItems: [] })
  // Eight timelines of 1,290 events: 10,320 events, over the limit, all read in parallel.
  const ids = Array.from({ length: 8 }, (_, index) => `milestone-${index}`)
  for (const [index, id] of ids.entries()) {
    await planning.create(workspaceId, createMilestoneInput(id, index + 2, {
      teamId: 'core-team',
      projectId: 'refero',
    }), { workItems: [] })
  }
  const base = createAnalyticsAuditEvent('planning-entity', 'milestone-template', '2026-06-01T00:00:00.000Z')
  let delivered = 0
  let outstanding = 0
  let maxCommitted = 0
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    planning,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        const limit = input.limit ?? 100
        outstanding += limit
        maxCommitted = Math.max(maxCommitted, delivered + outstanding)
        await new Promise((resolve) => setTimeout(resolve, 0))
        const offset = Number(input.cursor ?? '0')
        const end = Math.min(1_290, offset + limit)
        outstanding -= limit
        delivered += end - offset
        return {
          events: Array.from({ length: end - offset }, (_, index) => ({
            ...base,
            eventId: `${input.entityId}-${offset + index}`,
            entityId: input.entityId ?? '',
            metadata: { teamId: 'core-team', projectId: 'refero' },
            changes: [],
          })),
          ...(end < 1_290 ? { nextCursor: String(end) } : {}),
        }
      },
    },
  })
  const query = createAnalyticsQueryInput()

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    filter: { ...query.filter, projectIds: ['refero'] },
    widgets: [{
      id: 'trend',
      type: 'table' as const,
      title: 'Milestone trend',
      metric: 'milestone-trend' as const,
    }],
  })

  expect(response.status).toBe(413)
  expect(maxCommitted).toBeLessThanOrEqual(10_000)
  expect(delivered).toBeLessThanOrEqual(10_000)
})

test('shares the Milestone audit event budget across history retries', async () => {
  configureFakeProjectClients(true)
  const workspaceId = 'user#demo@example.com'
  const planning = new InMemoryPlanningClient(() => new Date())
  const parent = (id: string, type: 'portfolio' | 'roadmap', expectedRevision: number) => ({
    ...createMilestoneInput(id, expectedRevision, {}),
    type,
    title: id,
    parentId: type === 'roadmap' ? 'trend-portfolio' : undefined,
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
  })
  await planning.create(workspaceId, parent('trend-portfolio', 'portfolio', 0), { workItems: [] })
  await planning.create(workspaceId, parent('trend-roadmap', 'roadmap', 1), { workItems: [] })
  // Three timelines of 1,500 events: 4,500 per attempt, so the third attempt passes 10,000.
  const ids = ['milestone-a', 'milestone-b', 'milestone-c']
  for (const [index, id] of ids.entries()) {
    await planning.create(workspaceId, createMilestoneInput(id, index + 2, {
      teamId: 'core-team',
      projectId: 'refero',
    }), { workItems: [] })
  }
  const base = createAnalyticsAuditEvent('planning-entity', 'milestone-template', '2026-06-01T00:00:00.000Z')
  let delivered = 0
  setTestAppDependencies({
    analytics: new InMemoryAnalyticsRepository(),
    planning,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query(input) {
        const offset = Number(input.cursor ?? '0')
        const end = Math.min(1_500, offset + (input.limit ?? 100))
        delivered += end - offset
        // Every event predates the Milestone's latest write, so each attempt retries.
        return {
          events: Array.from({ length: end - offset }, (_, index) => ({
            ...base,
            eventId: `${input.entityId}-${offset + index}`,
            entityId: input.entityId ?? '',
            metadata: { teamId: 'core-team', projectId: 'refero' },
            changes: [],
          })),
          ...(end < 1_500 ? { nextCursor: String(end) } : {}),
        }
      },
    },
  })
  const query = createAnalyticsQueryInput()
  const now = new Date()

  const response = await analyticsApiRequest('/api/analytics/query', {
    ...query,
    asOf: now.toISOString(),
    filter: {
      ...query.filter,
      period: { from: new Date(now.getTime() - 86_400_000).toISOString(), to: now.toISOString() },
      projectIds: ['refero'],
    },
    widgets: [{
      id: 'trend',
      type: 'table' as const,
      title: 'Milestone trend',
      metric: 'milestone-trend' as const,
    }],
  })

  // A per-attempt budget would read 13,500 events and answer 503 instead.
  expect(response.status).toBe(413)
  expect(delivered).toBeLessThanOrEqual(10_000)
})
