import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  type AnalyticsQueryInput,
  type AnalyticsReport,
  type CanonicalWorkItem,
  type CreateAnalyticsReportInput,
} from '@mukuroji/contracts'
import {
  createAuditEvent,
  createMutationAuditContext,
  type AuditEventQuery,
} from './audit'
import {
  AnalyticsError,
  type AnalyticsDeliveryReceipt,
  createAnalyticsSnapshot,
  InMemoryAnalyticsRepository,
} from './analytics'
import {
  createAnalyticsScheduleRenderer,
  processDueAnalyticsReport,
  resolveAnalyticsScheduleProcessingTime,
  type AnalyticsScheduleArtifactInput,
} from './analytics-schedule-handler'

const NOW = new Date('2026-07-18T08:30:00.000Z')
const SCHEDULED_FOR = '2026-07-18T08:00:00.000Z'

test('renders recipient-specific current ACL data and filters audit events by exact entity ID', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const openWorkItem = createWorkItem('open-item', 'open-project')
  const privateWorkItem = createWorkItem('private-item', 'private-project')
  const openEvent = createWorkItemEvent(openWorkItem, '2026-07-17T08:00:00.000Z')
  const privateEvent = createWorkItemEvent(privateWorkItem, '2026-07-17T09:00:00.000Z')
  const auditQueries: AuditEventQuery[] = []
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }, { id: 'private-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [{ projectId: 'open-project', role: 'viewer' }]
      },
    },
    workItems: {
      async getTeamIssues() {
        return {
          teamId: 'team-1',
          issues: [openWorkItem, privateWorkItem],
        }
      },
      async getProjectIssues() {
        throw new Error('The unfiltered report must use a Team partition read.')
      },
    },
    auditEvents: {
      async query(input) {
        auditQueries.push(input)
        return { events: [privateEvent, openEvent] }
      },
    },
  })

  const rendered = await renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })

  expect(rendered).toBeDefined()
  expect(rendered?.snapshot.widgets[0]).toMatchObject({
    metric: 'wip',
    sampleSize: 1,
    value: 1,
  })
  const expected = createAnalyticsSnapshot({
    workItems: [openWorkItem],
    events: [openEvent],
    query: createReportQuery(report),
    authorizedProjectIds: new Set(['open-project']),
  })
  expect(rendered?.snapshot.permissionScopeHash).toBe(expected.permissionScopeHash)
  expect(auditQueries).toEqual([expect.objectContaining({
    direction: 'ascending',
    entityType: 'work-item',
    to: NOW.toISOString(),
    workspaceId: report.workspaceId,
  })])
})

test('scheduled snapshots rewind later project, archive, and status changes', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  report.filter.projectIds = ['project-before']
  const current = {
    ...createWorkItem('historical-item', 'project-after'),
    workflowStatusId: 'completed',
    statusCategory: 'completed' as const,
    archivedAt: '2026-07-17T12:00:00.000Z',
    archivedBy: 'owner@example.com',
    updatedAt: '2026-07-17T12:00:00.000Z',
  }
  const futureEvent = createHistoricalWorkItemEvent(current)
  const includeArchivedReads: boolean[] = []
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'project-before' }, { id: 'project-after' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [
          { projectId: 'project-before', role: 'viewer' },
          { projectId: 'project-after', role: 'viewer' },
        ]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId, options) {
        includeArchivedReads.push(options.includeArchived)
        return { teamId, issues: [current] }
      },
      async getProjectIssues() {
        throw new Error('Historical Analytics must read the owning Team partition.')
      },
    },
    auditEvents: {
      async query(input) {
        return Date.parse(input.to ?? '') >= Date.parse(futureEvent.occurredAt)
          ? { events: [futureEvent] }
          : { events: [] }
      },
    },
  })

  const rendered = await renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: '2026-07-16T12:00:00.000Z',
    historyReadAt: NOW.toISOString(),
  })

  expect(rendered?.snapshot.widgets[0]).toMatchObject({
    metric: 'wip',
    sampleSize: 1,
    value: 1,
  })
  expect(includeArchivedReads).toEqual([true])
})

test('scheduled snapshots exclude historical Projects outside the active current ACL', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const current = {
    ...createWorkItem('historical-private-item', 'project-after'),
    workflowStatusId: 'completed',
    statusCategory: 'completed' as const,
    archivedAt: '2026-07-17T12:00:00.000Z',
    archivedBy: 'owner@example.com',
    updatedAt: '2026-07-17T12:00:00.000Z',
  }
  const futureEvent = createHistoricalWorkItemEvent(current)
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'project-after' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [
          { projectId: 'project-before', role: 'viewer' },
          { projectId: 'project-after', role: 'viewer' },
        ]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        return { teamId, issues: [current] }
      },
      async getProjectIssues() {
        throw new Error('Historical Analytics must read the owning Team partition.')
      },
    },
    auditEvents: {
      async query() {
        return { events: [futureEvent] }
      },
    },
  })

  const rendered = await renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: '2026-07-16T12:00:00.000Z',
    historyReadAt: NOW.toISOString(),
  })

  expect(rendered?.snapshot.widgets[0]).toMatchObject({
    metric: 'wip',
    sampleSize: 0,
    value: 0,
  })
})

test('skips inactive recipients without reading directory, Work Item, or audit data', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['inactive@example.com'])
  let protectedReads = 0
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember() {
        return undefined
      },
    },
    directory: {
      async getProjectDirectory() {
        protectedReads += 1
        return { teams: [] }
      },
      async getProjectAccessList() {
        protectedReads += 1
        return []
      },
    },
    workItems: {
      async getTeamIssues() {
        protectedReads += 1
        return { teamId: 'team-1', issues: [] }
      },
      async getProjectIssues() {
        protectedReads += 1
        return { projectId: 'project-1', issues: [] }
      },
    },
    auditEvents: {
      async query() {
        protectedReads += 1
        return { events: [] }
      },
    },
  })

  const result = await processDueAnalyticsReport(report, NOW, {
    repository,
    render: renderer,
    renderArtifact: async () => {},
  })

  expect(result).toMatchObject({
    processed: true,
    receiptsCreated: 0,
    skippedRecipients: 1,
    snapshotsStored: 0,
  })
  expect(protectedReads).toBe(0)
  expect((await repository.getReport(report.workspaceId, report.id))?.revision).toBe(2)
})

test('retries a partial recipient failure without duplicating snapshots or receipts', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(
    repository,
    ['first@example.com', 'second@example.com'],
  )
  const originalPutReceipt = repository.putDeliveryReceipt.bind(repository)
  const createdReceipts: AnalyticsDeliveryReceipt[] = []
  repository.putDeliveryReceipt = async (receipt) => {
    const result = await originalPutReceipt(receipt)
    if (result.created) createdReceipts.push(result.receipt)
    return result
  }
  const renderedArtifacts: AnalyticsScheduleArtifactInput[] = []
  let failSecondRecipient = true
  const dependencies = {
    repository,
    async render(input: {
      report: AnalyticsReport
      recipientMemberKey: string
      scheduledFor: string
      historyReadAt: string
    }) {
      if (input.recipientMemberKey === 'second@example.com' && failSecondRecipient) {
        throw new AnalyticsError(
          503,
          'AnalyticsRecipientReadUnavailable',
          'Recipient data is temporarily unavailable.',
        )
      }
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    async renderArtifact(input: AnalyticsScheduleArtifactInput) {
      renderedArtifacts.push(input)
    },
  }

  await expect(processDueAnalyticsReport(report, NOW, dependencies)).rejects.toMatchObject({
    code: 'AnalyticsRecipientReadUnavailable',
  })
  expect((await repository.getReport(report.workspaceId, report.id))?.revision).toBe(1)
  expect(createdReceipts).toHaveLength(1)

  failSecondRecipient = false
  const retried = await processDueAnalyticsReport(report, NOW, dependencies)

  expect(retried).toMatchObject({
    processed: true,
    receiptsCreated: 1,
    snapshotsStored: 2,
  })
  expect(createdReceipts).toHaveLength(2)
  expect(new Set(createdReceipts.map((receipt) => receipt.occurrenceKey)).size).toBe(2)
  expect(new Set(createdReceipts.map((receipt) => receipt.snapshotId)).size).toBe(1)
  const snapshots = await repository.listSnapshots(report.workspaceId, report.id)
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]?.createdByMemberKey).toBe(report.ownerMemberKey)
  expect(renderedArtifacts).toHaveLength(3)
  const advanced = await repository.getReport(report.workspaceId, report.id)
  expect(advanced?.revision).toBe(2)
  expect(advanced?.schedule?.nextRunAt).toBe('2026-07-19T08:00:00.000Z')
}, 15_000)

test('advances the delivered occurrence after an unrelated report edit wins the first CAS', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const originalUpdate = repository.updateReport.bind(repository)
  let raced = false
  repository.updateReport = async (workspaceId, reportId, input) => {
    if (!raced) {
      raced = true
      await originalUpdate(workspaceId, reportId, {
        expectedRevision: input.expectedRevision,
        name: 'Edited during delivery',
      })
      throw new AnalyticsError(
        409,
        'AnalyticsRevisionConflict',
        'Analytics report changed. Reload and try again.',
      )
    }
    return await originalUpdate(workspaceId, reportId, input)
  }

  const result = await processDueAnalyticsReport(report, NOW, {
    repository,
    async render(input) {
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    renderArtifact: async () => {},
  })

  expect(result.processed).toBe(true)
  const current = await repository.getReport(report.workspaceId, report.id)
  expect(current?.name).toBe('Edited during delivery')
  expect(current?.revision).toBe(3)
  expect(current?.schedule?.nextRunAt).toBe('2026-07-19T08:00:00.000Z')
}, 10_000)

test('does not overwrite a schedule cursor changed by a concurrent edit', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const originalUpdate = repository.updateReport.bind(repository)
  let raced = false
  repository.updateReport = async (workspaceId, reportId, input) => {
    if (!raced) {
      raced = true
      await originalUpdate(workspaceId, reportId, {
        expectedRevision: input.expectedRevision,
        schedule: {
          ...report.schedule!,
          nextRunAt: '2026-07-20T08:00:00.000Z',
        },
      })
      throw new AnalyticsError(
        409,
        'AnalyticsRevisionConflict',
        'Analytics report changed. Reload and try again.',
      )
    }
    return await originalUpdate(workspaceId, reportId, input)
  }

  await processDueAnalyticsReport(report, NOW, {
    repository,
    async render(input) {
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    renderArtifact: async () => {},
  })

  const current = await repository.getReport(report.workspaceId, report.id)
  expect(current?.revision).toBe(2)
  expect(current?.schedule?.nextRunAt).toBe('2026-07-20T08:00:00.000Z')
}, 10_000)

test('advances past the second DST-fold instant on the same local delivery date', async () => {
  const repository = new InMemoryAnalyticsRepository(
    () => new Date('2026-11-01T07:00:00.000Z'),
  )
  const report = await repository.createReport(
    'workspace-1',
    'owner@example.com',
    {
      id: 'dst-fold-report',
      name: 'DST fold report',
      visibility: 'shared',
      timeZone: 'America/New_York',
      filter: {
        period: {
          from: '2026-10-01T00:00:00.000Z',
          to: '2026-11-30T23:59:59.999Z',
        },
      },
      widgets: [{
        id: 'wip',
        type: 'metric',
        title: 'WIP',
        metric: 'wip',
      }],
      schedule: {
        enabled: true,
        frequency: 'daily',
        timeZone: 'America/New_York',
        localTime: '01:30',
        recipientMemberKeys: ['recipient@example.com'],
        format: 'csv',
        nextRunAt: '2026-11-01T05:30:00.000Z',
      },
    },
  )

  await processDueAnalyticsReport(report, new Date('2026-11-01T07:00:00.000Z'), {
    repository,
    async render(input) {
      return createRenderedSnapshot(
        input.report,
        input.recipientMemberKey,
        input.scheduledFor,
      )
    },
    renderArtifact: async () => {},
  })

  expect((await repository.getReport(report.workspaceId, report.id))?.schedule?.nextRunAt)
    .toBe('2026-11-02T06:30:00.000Z')
})

test('does not advance the schedule when every delivery attempt cannot complete', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])

  await expect(processDueAnalyticsReport(report, NOW, {
    repository,
    async render(input) {
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    async renderArtifact() {
      throw new AnalyticsError(
        503,
        'AnalyticsArtifactUnavailable',
        'Analytics artifact could not be rendered.',
      )
    },
  })).rejects.toMatchObject({ code: 'AnalyticsArtifactUnavailable' })

  const current = await repository.getReport(report.workspaceId, report.id)
  expect(current?.revision).toBe(1)
  expect(current?.schedule?.nextRunAt).toBe(SCHEDULED_FOR)
})

test('fails closed when an occurrence receipt has a different immutable payload', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const recipientMemberKey = 'recipient@example.com'
  const report = await createScheduledReport(repository, [recipientMemberKey])
  const recipientHash = createHash('sha256')
    .update(recipientMemberKey)
    .digest('hex')
    .slice(0, 24)
  await repository.putDeliveryReceipt({
    workspaceId: report.workspaceId,
    reportId: report.id,
    occurrenceKey: `${SCHEDULED_FOR}#${recipientHash}`,
    reportRevision: report.revision,
    format: 'csv',
    snapshotId: 'different-snapshot',
    recipientMemberKeys: [recipientMemberKey],
    createdAt: SCHEDULED_FOR,
  })

  await expect(processDueAnalyticsReport(report, NOW, {
    repository,
    async render(input) {
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    renderArtifact: async () => {},
  })).rejects.toMatchObject({ code: 'AnalyticsDeliveryConflict' })

  expect((await repository.getReport(report.workspaceId, report.id))?.revision).toBe(1)
})

test('rejects an invalid EventBridge timestamp', () => {
  expect(() => resolveAnalyticsScheduleProcessingTime({
    time: 'not-a-timestamp',
  }, NOW)).toThrow(AnalyticsError)
})

async function createScheduledReport(
  repository: InMemoryAnalyticsRepository,
  recipientMemberKeys: string[],
) {
  return await repository.createReport(
    'workspace-1',
    'owner@example.com',
    {
      id: 'report-1',
      name: 'Delivery report',
      visibility: 'shared',
      timeZone: 'UTC',
      filter: {
        period: {
          from: '2026-07-01T00:00:00.000Z',
          to: '2026-07-31T23:59:59.999Z',
        },
      },
      forecastBaseline: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T23:59:59.999Z',
      },
      widgets: [{
        id: 'wip',
        type: 'metric',
        title: 'WIP',
        metric: 'wip',
      }],
      schedule: {
        enabled: true,
        frequency: 'daily',
        timeZone: 'UTC',
        localTime: '08:00',
        recipientMemberKeys,
        format: 'csv',
        nextRunAt: SCHEDULED_FOR,
      },
    } satisfies CreateAnalyticsReportInput,
  )
}

function createRenderedSnapshot(
  report: AnalyticsReport,
  recipientMemberKey: string,
  scheduledFor = SCHEDULED_FOR,
) {
  const query = createReportQuery(report, scheduledFor)
  return {
    workspaceId: report.workspaceId,
    reportId: report.id,
    reportRevision: report.revision,
    createdByMemberKey: recipientMemberKey,
    createdAt: scheduledFor,
    query,
    snapshot: createAnalyticsSnapshot({
      workItems: [],
      events: [],
      query,
      authorizedProjectIds: new Set(),
    }),
  }
}

function createReportQuery(
  report: AnalyticsReport,
  scheduledFor = SCHEDULED_FOR,
): AnalyticsQueryInput {
  return {
    filter: structuredClone(report.filter),
    widgets: structuredClone(report.widgets),
    asOf: scheduledFor,
    timeZone: report.timeZone,
    ...(report.forecastBaseline === undefined
      ? {}
      : { forecastBaseline: structuredClone(report.forecastBaseline) }),
  }
}

function createWorkItem(id: string, assignedProjectId: string): CanonicalWorkItem {
  return {
    schemaVersion: 1,
    revision: 1,
    id,
    teamId: 'team-1',
    assignedProjectId,
    title: id,
    assigneeUserId: 'assignee@example.com',
    creatorMemberKey: 'owner@example.com',
    workflowStatusId: 'started',
    statusCategory: 'started',
    workflowSchemaVersion: 1,
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-31',
    priority: 'medium',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    source: 'dynamodb',
  }
}

function createWorkItemEvent(workItem: CanonicalWorkItem, occurredAt: string) {
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'owner@example.com', kind: 'user' },
    idempotencyKey: `${workItem.id}-${occurredAt}`,
    correlationId: `correlation-${workItem.id}`,
    occurredAt,
    request: {
      method: 'PATCH',
      path: `/api/teams/${workItem.teamId}/issues/${workItem.id}`,
      body: { id: workItem.id },
    },
    source: {
      kind: 'api',
      method: 'PATCH',
      route: '/api/teams/:teamId/issues/:issueId',
    },
  })
  return createAuditEvent({
    context,
    eventType: 'work-item.updated',
    entity: {
      type: 'work-item',
      id: `team/${workItem.teamId}/issue/${workItem.id}`,
    },
    before: { statusCategory: 'unstarted' },
    after: { statusCategory: workItem.statusCategory },
    expiresAt: 2_000_000_000,
  })
}

function createHistoricalWorkItemEvent(workItem: CanonicalWorkItem) {
  const occurredAt = '2026-07-17T12:00:00.000Z'
  const context = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'owner@example.com', kind: 'user' },
    idempotencyKey: 'scheduled-historical-change',
    correlationId: 'scheduled-historical-correlation',
    occurredAt,
    request: {
      method: 'PATCH',
      path: `/api/teams/${workItem.teamId}/issues/${workItem.id}`,
      body: { expectedRevision: 3 },
    },
    source: {
      kind: 'api',
      method: 'PATCH',
      route: '/api/teams/:teamId/issues/:issueId',
    },
  })
  return createAuditEvent({
    context,
    eventType: 'work-item.updated',
    entity: {
      type: 'work-item',
      id: `team/${workItem.teamId}/issue/${workItem.id}`,
    },
    before: {
      assignedProjectId: 'project-before',
      archivedAt: undefined,
      statusCategory: 'started',
    },
    after: {
      assignedProjectId: workItem.assignedProjectId,
      archivedAt: workItem.archivedAt,
      statusCategory: workItem.statusCategory,
    },
    expiresAt: 2_000_000_000,
  })
}

function createActiveMember(workspaceId: string, memberKey: string) {
  return {
    id: memberKey,
    memberKey,
    email: memberKey,
    role: 'member' as const,
    status: 'active' as const,
    version: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    workspaceId,
  }
}
