import { expect, test } from 'bun:test'
import {
  type AnalyticsQueryInput,
  type AnalyticsReport,
  type CanonicalWorkItem,
  type CreateAnalyticsReportInput,
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  createAuditEvent,
  createMutationAuditContext,
  type AuditEventQuery,
  type AuditEventV1,
} from '../../../audit/audit'
import {
  AnalyticsError,
  type AnalyticsDeliveryReceipt,
  type AnalyticsRepository,
  createAnalyticsScheduleShard,
  createAnalyticsSnapshot,
  InMemoryAnalyticsRepository,
} from '../../analytics'
import {
  createAnalyticsScheduleRenderer,
  processAnalyticsSchedule,
  processDueAnalyticsReport,
  resolveAnalyticsScheduleProcessingTime,
  type AnalyticsFeatureEntitlementPort,
  type AnalyticsScheduleArtifactInput,
} from './analytics-schedule'

const NOW = new Date('2026-07-18T08:30:00.000Z')
const SCHEDULED_FOR = '2026-07-18T08:00:00.000Z'

const enabledAnalyticsEntitlement: AnalyticsFeatureEntitlementPort = {
  /** Allows Analytics execution in tests focused on schedule behavior. */
  async isAnalyticsEnabled() {
    return true
  },
}

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
    systemAdmin: {
      async isSystemAdmin() {
        return false
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
  expect(auditQueries).toHaveLength(1)
  expect(auditQueries.map((query) => query.entityId).sort()).toEqual([
    'team/team-1/issue/open-item',
  ])
  for (const query of auditQueries) {
    expect(query).toEqual(expect.objectContaining({
      direction: 'ascending',
      entityType: 'work-item',
      to: NOW.toISOString(),
      workspaceId: report.workspaceId,
    }))
  }
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
    systemAdmin: {
      async isSystemAdmin() {
        return false
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
  expect(includeArchivedReads).toEqual([true, true])
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
    systemAdmin: {
      async isSystemAdmin() {
        return false
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

test('scheduled Cognito system administrators can read every active Project', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const recipientMemberKey = 'admin@example.com'
  const report = await createScheduledReport(repository, [recipientMemberKey])
  report.visibility = 'team'
  report.teamId = 'team-1'
  const adminWorkItem = createWorkItem('admin-item', 'private-project')
  let projectAccessReads = 0
  const systemAdminReads: string[] = []
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin(userId) {
        systemAdminReads.push(userId)
        return true
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [
              { id: 'open-project' },
              { id: 'private-project' },
            ],
          }],
        }
      },
      async getProjectAccessList() {
        projectAccessReads += 1
        return []
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        return { teamId, issues: [adminWorkItem] }
      },
      async getProjectIssues() {
        throw new Error('System administrators must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query() {
        return { events: [] }
      },
    },
  })

  const rendered = await renderer({
    report,
    recipientMemberKey,
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })

  expect(rendered?.snapshot.widgets[0]).toMatchObject({
    metric: 'wip',
    sampleSize: 1,
    value: 1,
  })
  expect(projectAccessReads).toBe(0)
  expect(systemAdminReads).toEqual([recipientMemberKey, recipientMemberKey])
  const expected = createAnalyticsSnapshot({
    workItems: [adminWorkItem],
    events: [],
    query: createReportQuery(report),
    authorizedProjectIds: new Set(['open-project', 'private-project']),
  })
  expect(rendered?.snapshot.permissionScopeHash).toBe(expected.permissionScopeHash)
})

test('retries when canonical Work Items are newer than the audit history cutoff', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const newerWorkItem = {
    ...createWorkItem('newer-item', 'open-project'),
    updatedAt: '2026-07-18T08:30:00.001Z',
  }
  let auditReads = 0
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin() {
        return false
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [{ projectId: 'open-project', role: 'viewer' }]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        return { teamId, issues: [newerWorkItem] }
      },
      async getProjectIssues() {
        throw new Error('The renderer must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query() {
        auditReads += 1
        return { events: [] }
      },
    },
  })

  await expect(renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })).rejects.toMatchObject({
    code: 'AnalyticsScheduleReadBarrierUnavailable',
    status: 503,
  })
  expect(auditReads).toBe(0)
})

test('retries when the entity GSI has not reached a post-occurrence canonical update', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const updatedWorkItem = {
    ...createWorkItem('gsi-lagged-item', 'open-project'),
    revision: 2,
    workflowStatusId: 'completed',
    statusCategory: 'completed' as const,
    updatedAt: '2026-07-18T08:15:00.000Z',
  }
  let workItemReads = 0
  let auditReads = 0
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin() {
        return false
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [{ projectId: 'open-project', role: 'viewer' }]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        workItemReads += 1
        return { teamId, issues: [updatedWorkItem] }
      },
      async getProjectIssues() {
        throw new Error('The renderer must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query() {
        auditReads += 1
        return { events: [] }
      },
    },
  })

  await expect(renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })).rejects.toMatchObject({
    code: 'AnalyticsScheduleReadBarrierUnavailable',
    status: 503,
  })
  expect(workItemReads).toBe(2)
  expect(auditReads).toBe(1)
})

test('does not treat same-time stale or unrelated events as latest update coverage', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const workItem = {
    ...createWorkItem('same-time-stale-item', 'open-project'),
    revision: 3,
    workflowStatusId: 'completed',
    statusCategory: 'completed' as const,
    updatedAt: '2026-07-18T08:15:00.000Z',
  }
  const latestEvent = createWorkItemEvent(
    workItem,
    workItem.updatedAt,
    'started',
  )
  const staleRevisionEvent = {
    ...latestEvent,
    eventId: `${latestEvent.eventId}-stale-revision`,
    metadata: {
      ...latestEvent.metadata,
      afterRevision: workItem.revision - 1,
    },
  }
  const commentTargetId =
    `team/${workItem.teamId}/issue/${workItem.id}/comment/comment-1`
  const unrelatedCommentEvent = {
    ...latestEvent,
    eventId: `${latestEvent.eventId}-comment`,
    eventType: 'work-item.comment.created',
    action: 'created',
    target: { type: 'comment' as const, id: commentTargetId },
    targetType: 'comment' as const,
    targetId: commentTargetId,
  }
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin() {
        return false
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [{ projectId: 'open-project', role: 'viewer' }]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        return { teamId, issues: [workItem] }
      },
      async getProjectIssues() {
        throw new Error('The renderer must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query(input) {
        return input.entityId ===
            `team/${workItem.teamId}/issue/${workItem.id}`
          ? { events: [staleRevisionEvent, unrelatedCommentEvent] }
          : { events: [] }
      },
    },
  })

  await expect(renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })).rejects.toMatchObject({
    code: 'AnalyticsScheduleReadBarrierUnavailable',
    status: 503,
  })
})

test('restarts the audit read when canonical Work Items change across the read barrier', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const before = createWorkItem('raced-item', 'open-project')
  const after = {
    ...before,
    revision: 2,
    workflowStatusId: 'completed',
    statusCategory: 'completed' as const,
    updatedAt: '2026-07-17T12:00:00.000Z',
  }
  const event = createWorkItemEvent(after, after.updatedAt, 'started')
  let workItemReads = 0
  let auditReads = 0
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin() {
        return false
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [{ projectId: 'open-project', role: 'viewer' }]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        workItemReads += 1
        return {
          teamId,
          issues: [workItemReads === 1 ? before : after],
        }
      },
      async getProjectIssues() {
        throw new Error('The renderer must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query() {
        auditReads += 1
        return { events: [event] }
      },
    },
  })

  const rendered = await renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: '2026-07-16T08:00:00.000Z',
    historyReadAt: NOW.toISOString(),
  })

  expect(rendered?.snapshot.widgets[0]).toMatchObject({
    metric: 'wip',
    sampleSize: 1,
    value: 1,
  })
  expect(workItemReads).toBe(3)
  expect(auditReads).toBe(2)
})

test('retries when current Project authorization changes during the history read', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const workItem = createWorkItem('authorization-race-item', 'open-project')
  let memberReads = 0
  let directoryReads = 0
  let systemAdminReads = 0
  let projectAccessReads = 0
  let workItemReads = 0
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        memberReads += 1
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin() {
        systemAdminReads += 1
        return false
      },
    },
    directory: {
      async getProjectDirectory() {
        directoryReads += 1
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        projectAccessReads += 1
        return projectAccessReads === 1
          ? [{ projectId: 'open-project', role: 'viewer' }]
          : []
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        workItemReads += 1
        return { teamId, issues: [workItem] }
      },
      async getProjectIssues() {
        throw new Error('The renderer must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query() {
        return { events: [] }
      },
    },
  })

  await expect(renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })).rejects.toMatchObject({
    code: 'AnalyticsScheduleReadBarrierUnavailable',
    status: 503,
  })
  expect(memberReads).toBe(2)
  expect(directoryReads).toBe(2)
  expect(systemAdminReads).toBe(2)
  expect(projectAccessReads).toBe(2)
  expect(workItemReads).toBe(2)
})

test('rejects an oversized canonical entity-query fan-out before reading audit history', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const workItems = Array.from({ length: 501 }, (_, index) =>
    createWorkItem(`identity-${index}`, 'open-project')
  )
  let workItemReads = 0
  let auditReads = 0
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin() {
        return false
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [{ projectId: 'open-project', role: 'viewer' }]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        workItemReads += 1
        return { teamId, issues: workItems }
      },
      async getProjectIssues() {
        throw new Error('The renderer must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query() {
        auditReads += 1
        return { events: [] }
      },
    },
  })

  await expect(renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })).rejects.toMatchObject({
    code: 'AnalyticsHistoryLimitExceeded',
    status: 413,
  })
  expect(workItemReads).toBe(1)
  expect(auditReads).toBe(0)
})

test('bounds shared schedule page reads across paginated canonical entities', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const workItems = Array.from({ length: 6 }, (_, index) =>
    createWorkItem(`paginated-item-${index}`, 'open-project')
  )
  const rejectedEvents = new Map<string, AuditEventV1>()
  for (const workItem of workItems) {
    const event = createWorkItemEvent(workItem, workItem.updatedAt, 'started')
    const canonicalEntityId = `team/${workItem.teamId}/issue/${workItem.id}`
    rejectedEvents.set(canonicalEntityId, {
      ...event,
      entity: {
        type: 'work-item',
        id: 'non-canonical-entity',
      },
    })
  }
  const entityReads = new Map<string, number>()
  let auditReads = 0
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin() {
        return false
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [{ projectId: 'open-project', role: 'viewer' }]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        return { teamId, issues: workItems }
      },
      async getProjectIssues() {
        throw new Error('The renderer must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query(input) {
        auditReads += 1
        const event = rejectedEvents.get(input.entityId ?? '')
        if (!event) return { events: [] }

        const readCount = (entityReads.get(input.entityId ?? '') ?? 0) + 1
        entityReads.set(input.entityId ?? '', readCount)
        return {
          events: [event],
          ...(readCount < 99
            ? { nextCursor: `${input.entityId}-page-${readCount}` }
            : {}),
        }
      },
    },
  })

  await expect(renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })).rejects.toMatchObject({
    code: 'AnalyticsHistoryLimitExceeded',
    status: 413,
  })
  expect(auditReads).toBe(500)
  expect(Math.max(...entityReads.values())).toBeLessThan(100)
})

test('fails closed when relevant entity history exceeds the schedule event limit', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const workItem = createWorkItem('large-history-item', 'open-project')
  const event = createWorkItemEvent(
    workItem,
    '2026-07-17T12:00:00.000Z',
  )
  const renderer = createAnalyticsScheduleRenderer({
    workspaceAccess: {
      async getActiveMember(workspaceId, memberKey) {
        return createActiveMember(workspaceId, memberKey)
      },
    },
    systemAdmin: {
      async isSystemAdmin() {
        return false
      },
    },
    directory: {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'team-1',
            projects: [{ id: 'open-project' }],
          }],
        }
      },
      async getProjectAccessList() {
        return [{ projectId: 'open-project', role: 'viewer' }]
      },
    },
    workItems: {
      async getTeamIssues(_workspaceId, teamId) {
        return { teamId, issues: [workItem] }
      },
      async getProjectIssues() {
        throw new Error('The renderer must use the owning Team partition.')
      },
    },
    auditEvents: {
      async query(input) {
        return {
          events: input.entityId === `team/team-1/issue/${workItem.id}`
            ? Array.from({ length: 10_001 }, () => event)
            : [],
        }
      },
    },
  })

  await expect(renderer({
    report,
    recipientMemberKey: 'recipient@example.com',
    scheduledFor: SCHEDULED_FOR,
    historyReadAt: NOW.toISOString(),
  })).rejects.toMatchObject({
    code: 'AnalyticsHistoryLimitExceeded',
    status: 413,
  })
})

test('leaves due reports paused when tenant Analytics is disabled', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])

  const result = await processDueAnalyticsReport(report, NOW, {
    repository,
    entitlement: {
      /** Denies Analytics while preserving the due report cursor. */
      async isAnalyticsEnabled(workspaceId) {
        expect(workspaceId).toBe(report.workspaceId)
        return false
      },
    },
    async render() {
      throw new Error('Disabled Analytics must not render snapshots.')
    },
    async renderArtifact() {
      throw new Error('Disabled Analytics must not render artifacts.')
    },
  })

  expect(result).toEqual({
    processed: false,
    receiptsCreated: 0,
    skippedRecipients: 0,
    snapshotsStored: 0,
  })
  expect((await repository.getReport(report.workspaceId, report.id))?.revision)
    .toBe(report.revision)
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
    systemAdmin: {
      async isSystemAdmin() {
        protectedReads += 1
        return false
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
    entitlement: enabledAnalyticsEntitlement,
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

test('retries a partial recipient failure across an ACL change without poisoning receipts', async () => {
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
  let authorizationVersion = 'before-change'
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
      return createRenderedSnapshot(
        input.report,
        input.recipientMemberKey,
        SCHEDULED_FOR,
        new Set([`project-${authorizationVersion}`]),
      )
    },
    entitlement: enabledAnalyticsEntitlement,
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
  authorizationVersion = 'after-change'
  const retried = await processDueAnalyticsReport(report, NOW, dependencies)

  expect(retried).toMatchObject({
    processed: true,
    receiptsCreated: 1,
    snapshotsStored: 1,
  })
  expect(createdReceipts).toHaveLength(2)
  expect(new Set(createdReceipts.map((receipt) => receipt.occurrenceKey)).size).toBe(2)
  expect(new Set(createdReceipts.map((receipt) => receipt.snapshotId)).size).toBe(2)
  const { snapshots } = await repository.listSnapshots(report.workspaceId, report.id)
  expect(snapshots).toHaveLength(2)
  expect(snapshots[0]?.createdByMemberKey).toBe(report.ownerMemberKey)
  expect(renderedArtifacts).toHaveLength(2)
  const advanced = await repository.getReport(report.workspaceId, report.id)
  expect(advanced?.revision).toBe(2)
  expect(advanced?.schedule?.nextRunAt).toBe('2026-07-19T08:00:00.000Z')
}, 15_000)

test('restarts a partially delivered occurrence under a new semantic report definition', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(
    repository,
    ['first@example.com', 'second@example.com'],
  )
  const originalPutReceipt = repository.putDeliveryReceipt.bind(repository)
  const createdOccurrenceKeys: string[] = []
  repository.putDeliveryReceipt = async (receipt) => {
    const result = await originalPutReceipt(receipt)
    if (result.created) createdOccurrenceKeys.push(result.receipt.occurrenceKey)
    return result
  }
  const renderedRevisions: number[] = []
  let failSecondRecipient = true
  const dependencies = {
    repository,
    async render(input: {
      report: AnalyticsReport
      recipientMemberKey: string
      scheduledFor: string
      historyReadAt: string
    }) {
      renderedRevisions.push(input.report.revision)
      if (input.recipientMemberKey === 'second@example.com' && failSecondRecipient) {
        throw new AnalyticsError(
          503,
          'AnalyticsRecipientReadUnavailable',
          'Recipient data is temporarily unavailable.',
        )
      }
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    entitlement: enabledAnalyticsEntitlement,
    renderArtifact: async () => {},
  }

  await expect(processDueAnalyticsReport(report, NOW, dependencies)).rejects.toMatchObject({
    code: 'AnalyticsRecipientReadUnavailable',
  })
  const edited = await repository.updateReport(report.workspaceId, report.id, {
    expectedRevision: report.revision,
    filter: {
      period: {
        from: '2026-07-08T00:00:00.000Z',
        to: '2026-07-31T23:59:59.999Z',
      },
    },
  })
  failSecondRecipient = false

  const retried = await processDueAnalyticsReport(edited, NOW, dependencies)

  expect(retried).toMatchObject({
    processed: true,
    receiptsCreated: 2,
    snapshotsStored: 2,
  })
  expect(renderedRevisions).toEqual([1, 1, 2, 2])
  expect(new Set(createdOccurrenceKeys).size).toBe(3)
  expect((await repository.listSnapshots(report.workspaceId, report.id)).snapshots)
    .toHaveLength(2)
  const advanced = await repository.getReport(report.workspaceId, report.id)
  expect(advanced?.revision).toBe(3)
  expect(advanced?.schedule?.nextRunAt).toBe('2026-07-19T08:00:00.000Z')
}, 15_000)

test('resumes after durable recipient checkpoints instead of restarting from the first recipient', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(
    repository,
    ['first@example.com', 'second@example.com', 'third@example.com'],
  )
  const renderedRecipients: string[] = []
  let failThirdRecipient = true
  const dependencies = {
    repository,
    async render(input: {
      report: AnalyticsReport
      recipientMemberKey: string
      scheduledFor: string
      historyReadAt: string
    }) {
      renderedRecipients.push(input.recipientMemberKey)
      if (input.recipientMemberKey === 'third@example.com' && failThirdRecipient) {
        throw new AnalyticsError(
          503,
          'AnalyticsRecipientReadUnavailable',
          'Recipient data is temporarily unavailable.',
        )
      }
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    entitlement: enabledAnalyticsEntitlement,
    renderArtifact: async () => {},
  }

  await expect(processDueAnalyticsReport(report, NOW, dependencies)).rejects.toMatchObject({
    code: 'AnalyticsRecipientReadUnavailable',
  })
  expect(renderedRecipients).toEqual([
    'first@example.com',
    'second@example.com',
    'third@example.com',
  ])

  failThirdRecipient = false
  const retried = await processDueAnalyticsReport(report, NOW, dependencies)

  expect(renderedRecipients).toEqual([
    'first@example.com',
    'second@example.com',
    'third@example.com',
    'third@example.com',
  ])
  expect(retried).toMatchObject({
    processed: true,
    receiptsCreated: 1,
    snapshotsStored: 1,
  })
  expect((await repository.getReport(report.workspaceId, report.id))?.schedule?.nextRunAt)
    .toBe('2026-07-19T08:00:00.000Z')
}, 15_000)

test('advances the delivered occurrence after an unrelated report edit wins the first CAS', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const originalUpdate = repository.updateReport.bind(repository)
  let didRace = false
  repository.updateReport = async (workspaceId, reportId, input) => {
    if (!didRace) {
      didRace = true
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
    entitlement: enabledAnalyticsEntitlement,
    renderArtifact: async () => {},
  })

  expect(result.processed).toBe(true)
  const current = await repository.getReport(report.workspaceId, report.id)
  expect(current?.name).toBe('Edited during delivery')
  expect(current?.revision).toBe(3)
  expect(current?.schedule?.nextRunAt).toBe('2026-07-19T08:00:00.000Z')
}, 10_000)

test('reprocesses the occurrence when a semantic report edit wins the first CAS', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const report = await createScheduledReport(repository, ['recipient@example.com'])
  const originalUpdate = repository.updateReport.bind(repository)
  let raced = false
  repository.updateReport = async (workspaceId, reportId, input) => {
    if (!raced) {
      raced = true
      await originalUpdate(workspaceId, reportId, {
        expectedRevision: input.expectedRevision,
        filter: {
          period: {
            from: '2026-07-08T00:00:00.000Z',
            to: '2026-07-31T23:59:59.999Z',
          },
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
  const renderedRevisions: number[] = []
  const dependencies = {
    repository,
    async render(input: {
      report: AnalyticsReport
      recipientMemberKey: string
      scheduledFor: string
      historyReadAt: string
    }) {
      renderedRevisions.push(input.report.revision)
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    entitlement: enabledAnalyticsEntitlement,
    renderArtifact: async () => {},
  }

  await processDueAnalyticsReport(report, NOW, dependencies)

  const currentAfterRace = await repository.getReport(report.workspaceId, report.id)
  expect(currentAfterRace?.revision).toBe(2)
  expect(currentAfterRace?.schedule?.nextRunAt).toBe(SCHEDULED_FOR)

  await processDueAnalyticsReport(currentAfterRace!, NOW, dependencies)

  expect(renderedRevisions).toEqual([1, 2])
  const advanced = await repository.getReport(report.workspaceId, report.id)
  expect(advanced?.revision).toBe(3)
  expect(advanced?.schedule?.nextRunAt).toBe('2026-07-19T08:00:00.000Z')
  expect((await repository.listSnapshots(report.workspaceId, report.id)).snapshots)
    .toHaveLength(2)
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
    entitlement: enabledAnalyticsEntitlement,
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
    entitlement: enabledAnalyticsEntitlement,
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
    entitlement: enabledAnalyticsEntitlement,
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
  repository.getDeliveryReceipt = async (workspaceId, reportId, occurrenceKey) => ({
    workspaceId,
    reportId,
    occurrenceKey,
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
    entitlement: enabledAnalyticsEntitlement,
    renderArtifact: async () => {},
  })).rejects.toMatchObject({ code: 'AnalyticsDeliveryConflict' })

  expect((await repository.getReport(report.workspaceId, report.id))?.revision).toBe(1)
})

test('fails closed when a receipt checkpoint identity does not match its lookup key', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const recipientMemberKey = 'recipient@example.com'
  const report = await createScheduledReport(repository, [recipientMemberKey])
  repository.getDeliveryReceipt = async (workspaceId, reportId, occurrenceKey) => ({
    workspaceId,
    reportId,
    occurrenceKey: `${occurrenceKey}#corrupt`,
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
    entitlement: enabledAnalyticsEntitlement,
    renderArtifact: async () => {},
  })).rejects.toMatchObject({ code: 'AnalyticsDeliveryConflict' })

  expect((await repository.getReport(report.workspaceId, report.id))?.revision).toBe(1)
})

test('rejects schedules whose recipient list exceeds the processing limit', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const recipients = Array.from(
    { length: 101 },
    (_, index) => `recipient-${index}@example.com`,
  )

  await expect(createScheduledReport(repository, recipients)).rejects.toMatchObject({
    code: 'AnalyticsScheduleRecipientLimitExceeded',
    status: 413,
  })
})

test('processes due reports with a bounded worker pool and preserves every settlement', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const reportIds = Array.from({ length: 9 }, (_, index) => `report-${index + 1}`)
  for (const reportId of reportIds) {
    await createScheduledReport(
      repository,
      [`${reportId}@example.com`],
      reportId,
    )
  }
  const attemptedReportIds: string[] = []
  let activeWorkers = 0
  let maximumActiveWorkers = 0

  let caught: unknown
  try {
    await processAnalyticsSchedule(NOW, {
      repository,
      async render(input) {
        attemptedReportIds.push(input.report.id)
        activeWorkers += 1
        maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers)
        await new Promise((resolve) => setTimeout(resolve, 10))
        activeWorkers -= 1
        if (input.report.id === 'report-3') {
          throw new AnalyticsError(
            503,
            'AnalyticsRecipientReadUnavailable',
            'Recipient data is temporarily unavailable.',
          )
        }
        return createRenderedSnapshot(input.report, input.recipientMemberKey)
      },
      entitlement: enabledAnalyticsEntitlement,
      renderArtifact: async () => {},
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(AggregateError)
  expect(maximumActiveWorkers).toBe(4)
  expect([...attemptedReportIds].sort()).toEqual([...reportIds].sort())
  expect(activeWorkers).toBe(0)
}, 15_000)

test('processes every due report when a shard spans multiple mutating pages', async () => {
  const repository = new InMemoryAnalyticsRepository(() => NOW)
  const reportIds: string[] = []
  for (let index = 0; reportIds.length < 101; index += 1) {
    const reportId = `paged-report-${index}`
    if (createAnalyticsScheduleShard('workspace-1', reportId) === 'schedule-00') {
      reportIds.push(reportId)
    }
  }
  for (const reportId of reportIds) {
    await createScheduledReport(
      repository,
      [`${reportId}@example.com`],
      reportId,
    )
  }
  const attemptedReportIds: string[] = []

  const result = await processAnalyticsSchedule(NOW, {
    repository,
    async render(input) {
      attemptedReportIds.push(input.report.id)
      return createRenderedSnapshot(input.report, input.recipientMemberKey)
    },
    entitlement: enabledAnalyticsEntitlement,
    renderArtifact: async () => {},
  })

  expect(result).toMatchObject({
    dueReports: 101,
    processedReports: 101,
    receiptsCreated: 101,
    snapshotsStored: 101,
  })
  expect([...attemptedReportIds].sort()).toEqual([...reportIds].sort())
  for (const reportId of reportIds) {
    const report = await repository.getReport('workspace-1', reportId)
    expect(report?.schedule?.nextRunAt).toBe('2026-07-19T08:00:00.000Z')
  }
}, 15_000)

test('bounds empty due pages that keep returning continuation cursors', async () => {
  let continuedPageReads = 0
  const repository = {
    async listDueReports(scheduleShard: string) {
      if (scheduleShard !== 'schedule-00') return { reports: [] }
      continuedPageReads += 1
      return {
        reports: [],
        nextCursor: `empty-page-${continuedPageReads}`,
      }
    },
  } as unknown as AnalyticsRepository

  await expect(processAnalyticsSchedule(NOW, {
    repository,
    async render() {
      throw new Error('Empty due pages must not invoke the renderer.')
    },
    entitlement: enabledAnalyticsEntitlement,
    renderArtifact: async () => {},
  })).rejects.toMatchObject({
    code: 'AnalyticsScheduleLimitExceeded',
  })
  expect(continuedPageReads).toBe(101)
})

test('rejects an invalid EventBridge timestamp', () => {
  expect(() => resolveAnalyticsScheduleProcessingTime({
    time: 'not-a-timestamp',
  }, NOW)).toThrow(AnalyticsError)
})

async function createScheduledReport(
  repository: InMemoryAnalyticsRepository,
  recipientMemberKeys: string[],
  reportId = 'report-1',
) {
  return await repository.createReport(
    'workspace-1',
    'owner@example.com',
    {
      id: reportId,
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
  authorizedProjectIds: ReadonlySet<string> = new Set(),
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
      authorizedProjectIds,
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    schedule: createDefaultDueDateWorkItemSchedule('2026-07-31'),
    priority: 'medium',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    source: 'dynamodb',
  }
}

function createWorkItemEvent(
  workItem: CanonicalWorkItem,
  occurredAt: string,
  beforeStatusCategory: 'unstarted' | 'started' = 'unstarted',
) {
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
    before: { statusCategory: beforeStatusCategory },
    after: { statusCategory: workItem.statusCategory },
    metadata: {
      adapter: 'canonical-work-item',
      teamId: workItem.teamId,
      issueId: workItem.id,
      afterRevision: workItem.revision,
    },
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
