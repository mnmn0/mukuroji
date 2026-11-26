import { afterEach, expect, test } from 'bun:test'
import type { AnalyticsQueryInput, AnalyticsSnapshot, AnalyticsSnapshotRecord, AnalyticsWidget } from '@mukuroji/contracts'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import {
  InMemoryAgentRunStore,
  InMemoryAgentRunUsageStore,
  createActiveAgentRun,
  finishAgentRun,
  formatUsageBucketStart,
  hashAgentInstanceId,
  readStartAgentRunRequest,
} from '../../../agent-runs'
import { InMemoryAnalyticsRepository } from '../../analytics'
import { ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING, MAX_ANALYTICS_AGENT_USAGE_RUNS } from '../../analytics-agent-usage'

const {
  analyticsApiRequest,
  app,
  configureFakeProjectClients,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

const workspaceId = 'user#demo@example.com'
const memberKey = 'sato@example.com'
const hourMs = 3_600_000

afterEach(() => {
  resetTestApp()
  delete process.env.SOFTWARE_FACTORY
})

/** Query period; the fake Work Items exist from June. */
const period = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z' }

/**
 * Creates a query over July with the given widgets.
 *
 * @param widgets - Widgets.
 * @returns Query.
 */
function createQuery(widgets: AnalyticsWidget[]): AnalyticsQueryInput {
  return { filter: { period }, widgets, asOf: '2026-08-01T00:00:00.000Z', timeZone: 'UTC' }
}

/** Token and cost widgets. */
const usageWidgets: AnalyticsWidget[] = [
  { id: 'tokens', title: 'Tokens', type: 'metric', metric: 'agent-tokens' },
  { id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost' },
]

/**
 * Configures the fake Workspace, an Agent Run store with finished runs, and their usage.
 *
 * @param role - Team role of the viewer.
 * @param archivedTeamIssueCount - Fake Work Items archived from the start; the first is `onboarding-friction`.
 * @param projectOptions - Projects of the fake Team and the viewer's access to them.
 * @returns The stores.
 */
async function configure(
  role: 'manager' | 'member',
  archivedTeamIssueCount = 0,
  projectOptions: Pick<NonNullable<Parameters<typeof configureFakeProjectClients>[1]>, 'teamProjects' | 'projectAccesses'> = {},
) {
  configureFakeProjectClients(true, { teamIssueCount: 2, role, archivedTeamIssueCount, ...projectOptions })
  const runs = new InMemoryAgentRunStore()
  const usage = new InMemoryAgentRunUsageStore()
  const repository = new InMemoryAnalyticsRepository()
  setTestAppDependencies({
    analytics: repository,
    agentRuns: runs,
    agentRunUsage: usage,
    auditEvents: {
      async getEvent() {
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })
  /**
   * Seeds a run that worked from `start` for one hour and the usage of its member and instance.
   *
   * @param workItemId - Work Item ID.
   * @param start - Start instant.
   * @param inputTokens - Input tokens of its usage.
   */
  const seed = async (workItemId: string, start: string, inputTokens: number) => {
    const startedAt = new Date(start)
    const run = createActiveAgentRun({
      directoryId: workspaceId,
      teamId: 'core-team',
      workItemId,
      assigneeUserId: memberKey,
      start: readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'in-progress', runtime: 'claude-code', agentName: 'Claude Code', instanceId: 'laptop' }),
      credentialId: 'agent-key',
      startRevision: 2,
      leaseMinutes: 30,
      now: startedAt,
    })
    runs.seed(finishAgentRun(run, 'completed', 'agent', new Date(startedAt.getTime() + hourMs)))
    await usage.recordBatch(workspaceId, memberKey, `batch-${workItemId}-${start}`, [{
      bucketStart: formatUsageBucketStart(startedAt.getTime() + 10 * 60_000),
      instanceIdHash: hashAgentInstanceId('laptop'),
      model: 'claude-sonnet-5-5',
      inputTokens,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costMicroUsd: inputTokens * 100,
      requestCount: 1,
    }])
  }
  await seed('onboarding-friction', '2026-07-10T00:00:00.000Z', 1_000)
  await seed('work-item-1', '2026-07-20T00:00:00.000Z', 400)
  // A run before the period is not counted.
  await seed('work-item-1', '2026-06-20T00:00:00.000Z', 9_000)
  return { runs, repository }
}

/**
 * Runs an Analytics query and returns its snapshot.
 *
 * @param query - Query.
 * @returns Snapshot.
 */
async function readSnapshot(query: AnalyticsQueryInput): Promise<AnalyticsSnapshot> {
  const response = await analyticsApiRequest('/api/analytics/query', query)
  expect(response.status).toBe(200)
  const body: { snapshot: AnalyticsSnapshot } = await response.json()
  return body.snapshot
}

test('adds up the tokens and, for Team managers, the estimated cost of the period\'s Agent Runs', async () => {
  await configure('manager')
  const snapshot = await readSnapshot(createQuery(usageWidgets))
  expect(snapshot.widgets.map((widget) => [widget.metric, widget.value, widget.sampleSize])).toEqual([
    ['agent-tokens', 1_600, 2],
    ['agent-cost', 0.14, 2],
  ])

  const evidence = await analyticsApiRequest('/api/analytics/evidence', {
    metric: 'agent-tokens',
    filter: { period },
    asOf: '2026-08-01T00:00:00.000Z',
    timeZone: 'UTC',
  })
  expect(evidence.status).toBe(200)
  const page: { items: Array<{ workItemId: string; value?: number }> } = await evidence.json()
  expect(page.items.map((item) => [item.workItemId, item.value])).toEqual([['work-item-1', 500], ['onboarding-friction', 1_100]])
})

test('leaves the estimated cost out for members who do not manage the Team', async () => {
  await configure('member')
  const snapshot = await readSnapshot(createQuery(usageWidgets))
  expect(snapshot.widgets[0]?.value).toBe(1_600)
  expect(snapshot.widgets[1]).toMatchObject({ value: null, sampleSize: 0 })
  expect(snapshot.widgets[1]?.warnings).toContain('2 Agent Run(s) of Teams you do not manage were left out of the estimated cost.')
})

test('leaves the estimated cost out for managers of only some Projects of the Team', async () => {
  await configure('manager', 0, {
    teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }, { id: 'beta', name: 'Beta', tone: 'green' }],
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'manager' }, { teamId: 'core-team', projectId: 'beta', role: 'member' }],
  })
  const snapshot = await readSnapshot(createQuery(usageWidgets))
  expect(snapshot.widgets[0]?.value).toBe(1_600)
  expect(snapshot.widgets[1]).toMatchObject({ value: null, sampleSize: 0 })
})

test('hides a cost snapshot once its creator no longer manages the Team', async () => {
  const { repository } = await configure('manager')
  const query = createQuery([usageWidgets[1]!])
  await repository.createReport(workspaceId, 'demo@example.com', {
    id: 'cost-report',
    name: 'Cost report',
    visibility: 'personal',
    timeZone: query.timeZone,
    filter: query.filter,
    widgets: query.widgets,
  })
  const created = await analyticsApiRequest('/api/analytics/reports/cost-report/snapshots', { asOf: query.asOf })
  expect(created.status).toBe(201)
  const { snapshotRecord }: { snapshotRecord: AnalyticsSnapshotRecord } = await created.json()
  expect(snapshotRecord.snapshot.widgets[0]?.value).toBe(0.14)
  const list = async () => {
    const response = await app.request('/api/analytics/reports/cost-report/snapshots', { headers: { Authorization: 'Bearer test-token' } })
    expect(response.status).toBe(200)
    const body: { snapshots: AnalyticsSnapshotRecord[] } = await response.json()
    return body.snapshots.length
  }
  expect(await list()).toBe(1)

  configureFakeProjectClients(true, { teamIssueCount: 2, role: 'member' })
  setTestAppDependencies({ analytics: repository })
  expect(await list()).toBe(0)
})

test('fails with 413 instead of a partial total when the period holds too many runs', async () => {
  const { runs } = await configure('manager')
  for (let index = 0; index < MAX_ANALYTICS_AGENT_USAGE_RUNS; index += 1) {
    const run = createActiveAgentRun({
      directoryId: workspaceId,
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      assigneeUserId: memberKey,
      start: readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'in-progress', runtime: 'claude-code', agentName: 'Claude Code', instanceId: 'laptop' }),
      credentialId: 'agent-key',
      startRevision: 2,
      leaseMinutes: 30,
      now: new Date(Date.parse('2026-07-15T00:00:00.000Z') + index * 60_000),
    })
    runs.seed(finishAgentRun(run, 'failed', 'agent', new Date(Date.parse('2026-07-15T00:00:30.000Z') + index * 60_000)))
  }
  const response = await analyticsApiRequest('/api/analytics/query', createQuery([usageWidgets[0]!]))
  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'AnalyticsAgentUsageLimitExceeded' })
  // Other metrics never read Agent Runs.
  const throughput = await analyticsApiRequest('/api/analytics/query', createQuery([{ id: 'done', title: 'Done', type: 'metric', metric: 'throughput' }]))
  expect(throughput.status).toBe(200)
})

test('spends the run budget only on Work Items the report filter keeps', async () => {
  const { runs } = await configure('manager', 1)
  // The archived Work Item is accessible but left out by the filter, so its runs do not count.
  for (let index = 0; index < MAX_ANALYTICS_AGENT_USAGE_RUNS; index += 1) {
    const run = createActiveAgentRun({
      directoryId: workspaceId,
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      assigneeUserId: memberKey,
      start: readStartAgentRunRequest({ expectedRevision: 1, workflowStatusId: 'in-progress', runtime: 'claude-code', agentName: 'Claude Code', instanceId: 'laptop' }),
      credentialId: 'agent-key',
      startRevision: 2,
      leaseMinutes: 30,
      now: new Date(Date.parse('2026-07-15T00:00:00.000Z') + index * 60_000),
    })
    runs.seed(finishAgentRun(run, 'failed', 'agent', new Date(Date.parse('2026-07-15T00:00:30.000Z') + index * 60_000)))
  }
  const snapshot = await readSnapshot(createQuery([usageWidgets[0]!]))
  expect(snapshot.widgets[0]).toMatchObject({ value: 500, sampleSize: 1 })
})

test('bounds the index pages it reads when other Work Items fill them', async () => {
  const { runs } = await configure('manager')
  let pages = 0
  runs.listFinishedRunsByTime = async () => {
    pages += 1
    return {
      runs: [{ runId: `run-${pages}`, workItemId: 'hidden-work-item', outcome: 'completed', finishedAt: '2026-07-15T00:00:00.000Z' }],
      nextCursor: `page-${pages}`,
    }
  }
  const response = await analyticsApiRequest('/api/analytics/query', createQuery([usageWidgets[0]!]))
  expect(response.status).toBe(413)
  expect(pages).toBe(100)
})

test('returns the unavailable warning when the deployment has no Software factory', async () => {
  await configure('manager')
  process.env.SOFTWARE_FACTORY = 'disabled'
  const snapshot = await readSnapshot(createQuery(usageWidgets))
  expect(snapshot.widgets.map((widget) => [widget.value, widget.warnings])).toEqual([
    [null, [ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING]],
    [null, [ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING]],
  ])
})
