import { describe, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type AnalyticsQueryInput,
  type AnalyticsWidget,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import {
  ANALYTICS_PLANNING_GROUPS_UNAVAILABLE_WARNING,
  analyticsSnapshotReadPlanningGroups,
  createAnalyticsCsv,
  createAnalyticsPdf,
  createAnalyticsPermissionScopeHash,
  createAnalyticsSnapshot,
  queryAnalyticsEvidence,
} from './analytics'
import {
  ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING,
  analyticsQueryReadsAgentCost,
  analyticsQueryReadsAgentUsage,
  analyticsSnapshotReadAgentCost,
  type AnalyticsAgentUsage,
  type AnalyticsAgentUsageRun,
} from './analytics-agent-usage'

/** Query period of every test. */
const period = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-07T00:00:00.000Z' }

/** Projects every test viewer may read. */
const authorizedProjectIds = new Set(['project-a', 'project-b'])

/** Directory of the predefined CMaps pdf.js needs to read the `UniJIS-UCS2-H` fallback font. */
const pdfCMapDirectory = `${dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))}/cmaps/`

/**
 * Extracts the text of every page of a PDF with pdf.js.
 *
 * @param bytes - PDF bytes.
 * @returns Page texts joined without separators.
 */
async function readPdfText(bytes: Uint8Array) {
  const loadingTask = getDocument({ data: bytes, cMapUrl: pdfCMapDirectory, cMapPacked: true })
  const document = await loadingTask.promise
  const pages = await Promise.all(
    Array.from({ length: document.numPages }, async (_, index) => {
      const page = await document.getPage(index + 1)
      const content = await page.getTextContent()
      return content.items.flatMap((item) => 'str' in item ? [item.str] : []).join('')
    }),
  )
  await loadingTask.destroy()
  return pages.join('')
}

/**
 * Creates a canonical Work Item that no audit event changed during the period.
 *
 * @param id - Work Item ID.
 * @param overrides - Fields to replace.
 * @returns The Work Item.
 */
function createWorkItem(id: string, overrides: Partial<CanonicalWorkItem> = {}): CanonicalWorkItem {
  const dueDate = '2026-01-10'
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id,
    teamId: 'core',
    title: `Work ${id}`,
    assigneeUserId: 'user-1',
    creatorMemberKey: 'member-1',
    priority: 'medium',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
    workflowStatusId: 'status-started',
    statusCategory: 'started',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    source: 'dynamodb',
    dueDate,
    schedule: createDefaultDueDateWorkItemSchedule(dueDate),
    ...overrides,
  }
}

/**
 * Creates the usage of one run.
 *
 * @param runId - Run ID.
 * @param finishedAt - Finish instant.
 * @param tokens - Total tokens.
 * @param estimatedCostMicroUsd - Estimated cost, when visible.
 * @param hasMore - Whether the usage read stopped early.
 * @returns The run usage.
 */
function createRun(
  runId: string,
  finishedAt: string,
  tokens: number,
  estimatedCostMicroUsd?: number,
  hasMore = false,
): AnalyticsAgentUsageRun {
  return {
    runId,
    finishedAt: Date.parse(finishedAt),
    tokens,
    ...(estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd }),
    hasMore,
    byModel: [{ model: 'm', tokens, ...(estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd }) }],
  }
}

/**
 * Creates an ad-hoc query over the test period.
 *
 * @param widgets - Widgets.
 * @returns The query.
 */
function createQuery(widgets: AnalyticsWidget[]): AnalyticsQueryInput {
  return { filter: { period }, widgets, asOf: period.to, timeZone: 'UTC' }
}

const coreItem = createWorkItem('item-1', { assignedProjectId: 'project-a' })
const otherItem = createWorkItem('item-2', { teamId: 'ops', assignedProjectId: 'project-b' })
const workItems = [coreItem, otherItem]

/** Usage of three runs on two Teams, plus one run before the period. */
const agentUsage: AnalyticsAgentUsage = {
  runs: new Map([
    ['core\0item-1', [
      createRun('run-1', '2026-01-02T10:00:00.000Z', 1_000, 120_000),
      createRun('run-2', '2026-01-04T10:00:00.000Z', 500, 30_000, true),
      createRun('run-old', '2025-12-31T23:59:59.000Z', 9_999, 999_999),
    ]],
    ['ops\0item-2', [createRun('run-3', '2026-01-04T12:00:00.000Z', 2_000, 400_000)]],
  ]),
  costTeamIds: ['core'],
}

describe('Agent usage metrics', () => {
  test('adds up the tokens of runs that finished in the period, by bucket and dimension', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      agentUsage,
      query: createQuery([
        { id: 'total', title: 'Tokens', type: 'metric', metric: 'agent-tokens' },
        { id: 'by-team', title: 'By Team', type: 'metric', metric: 'agent-tokens', groupBy: { dimension: 'team' } },
        { id: 'daily', title: 'Daily', type: 'chart', visualization: 'bar', metric: 'agent-tokens' },
        { id: 'rows', title: 'Runs', type: 'table', metric: 'agent-tokens' },
      ]),
    })
    const [total, byTeam, daily, rows] = snapshot.widgets
    expect(total?.value).toBe(3_500)
    expect(total?.sampleSize).toBe(3)
    expect(total?.definition.unit).toBe('tokens')
    expect(total?.warnings).toEqual([
      '1 Agent Run(s) had more usage than one read returns, so the total is a lower bound.',
    ])
    expect(byTeam?.groups.map((group) => [group.key, group.value, group.sampleSize])).toEqual([
      ['core', 1_500, 2],
      ['ops', 2_000, 1],
    ])
    expect(daily?.series.map((point) => point.value)).toEqual([0, 1_000, 0, 2_500, 0, 0, 0])
    expect(rows?.rows.map((row) => [row.values.workItemId, row.values.value, row.values.occurredAt])).toEqual([
      ['item-2', 2_000, '2026-01-04T12:00:00.000Z'],
      ['item-1', 500, '2026-01-04T10:00:00.000Z'],
      ['item-1', 1_000, '2026-01-02T10:00:00.000Z'],
    ])
    expect(snapshot.evidenceCount).toBe(3)
  })

  test('counts estimated cost only for Teams the viewer manages', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      agentUsage,
      query: createQuery([
        { id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost' },
        { id: 'by-team', title: 'By Team', type: 'metric', metric: 'agent-cost', groupBy: { dimension: 'team' } },
      ]),
    })
    const [cost, byTeam] = snapshot.widgets
    expect(cost?.value).toBe(0.15)
    expect(cost?.definition.unit).toBe('usd')
    expect(cost?.sampleSize).toBe(2)
    expect(cost?.warnings).toContain('1 Agent Run(s) of Teams you do not manage were left out of the estimated cost.')
    // A Team whose cost the viewer cannot see has no value rather than zero.
    expect(byTeam?.groups.map((group) => [group.key, group.value])).toEqual([['core', 0.15], ['ops', null]])
  })

  test('splits tokens and cost by the model of each request', () => {
    const mixed: AnalyticsAgentUsage = {
      runs: new Map([
        ['core\0item-1', [{
          ...createRun('run-1', '2026-01-02T10:00:00.000Z', 1_000, 120_000),
          byModel: [
            { model: 'claude-opus-5-5', tokens: 700, estimatedCostMicroUsd: 100_000 },
            { model: 'claude-haiku-5-5', tokens: 300, estimatedCostMicroUsd: 20_000 },
          ],
        }]],
        ['ops\0item-2', [{ ...createRun('run-3', '2026-01-04T12:00:00.000Z', 2_000), byModel: [{ model: 'claude-haiku-5-5', tokens: 2_000 }] }]],
      ]),
      costTeamIds: ['core'],
    }
    const snapshot = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      agentUsage: mixed,
      query: createQuery([
        { id: 'tokens', title: 'Tokens', type: 'metric', metric: 'agent-tokens', groupBy: { dimension: 'model' } },
        { id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost', groupBy: { dimension: 'model' } },
      ]),
    })
    const [tokens, cost] = snapshot.widgets
    expect(tokens?.groups.map((group) => [group.key, group.value, group.sampleSize])).toEqual([
      ['claude-haiku-5-5', 2_300, 2],
      ['claude-opus-5-5', 700, 1],
    ])
    expect(cost?.groups.map((group) => [group.key, group.value])).toEqual([
      ['claude-haiku-5-5', 0.02],
      ['claude-opus-5-5', 0.1],
    ])
  })

  test('refuses the model dimension on other metrics', () => {
    expect(() => createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      query: createQuery([{ id: 'x', title: 'X', type: 'metric', metric: 'throughput', groupBy: { dimension: 'model' } }]),
    })).toThrow('Only Agent tokens and Agent estimated cost widgets group by model.')
  })

  test('counts a run without a reported cost as zero and says so', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems: [coreItem],
      events: [],
      authorizedProjectIds,
      agentUsage: { runs: new Map([['core\0item-1', [createRun('run-1', '2026-01-02T10:00:00.000Z', 10)]]]), costTeamIds: ['core'] },
      query: createQuery([{ id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost' }]),
    })
    expect(snapshot.widgets[0]?.value).toBe(0)
    expect(snapshot.widgets[0]?.warnings).toEqual(['1 Agent Run(s) reported no estimated cost and counted as zero.'])
  })

  test('keeps the evidence of runs of one Work Item that finished at the same instant', () => {
    const finishedAt = '2026-01-02T10:00:00.000Z'
    const snapshot = createAnalyticsSnapshot({
      workItems: [coreItem],
      events: [],
      authorizedProjectIds,
      agentUsage: { runs: new Map([['core\0item-1', [createRun('run-a', finishedAt, 10), createRun('run-b', finishedAt, 20)]]]) },
      query: createQuery([{ id: 'rows', title: 'Runs', type: 'table', metric: 'agent-tokens' }]),
    })
    expect(snapshot.widgets[0]?.rows.map((row) => row.values.value).sort()).toEqual([10, 20])
    expect(snapshot.evidenceCount).toBe(2)
  })

  test('leaves out runs of Work Items the filter excludes', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      agentUsage,
      query: { ...createQuery([{ id: 'total', title: 'Tokens', type: 'metric', metric: 'agent-tokens' }]), filter: { period, projectIds: ['project-b'] } },
    })
    expect(snapshot.widgets[0]?.value).toBe(2_000)
  })

  test('returns the unavailable warning when the run cannot read usage', () => {
    const query = createQuery([
      { id: 'tokens', title: 'Tokens', type: 'metric', metric: 'agent-tokens' },
      { id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost' },
    ])
    const snapshot = createAnalyticsSnapshot({ workItems, events: [], authorizedProjectIds, query })
    expect(snapshot.widgets.map((widget) => [widget.value, widget.warnings])).toEqual([
      [null, [ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING]],
      [null, [ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING]],
    ])
    expect(analyticsSnapshotReadAgentCost(snapshot)).toBe(false)
    // Without usage the hash is the one an existing snapshot of the same scope has.
    expect(snapshot.permissionScopeHash).toBe(
      createAnalyticsPermissionScopeHash(workItems, Date.parse(period.to), authorizedProjectIds),
    )
  })

  test('keeps both unavailable warnings on a cost widget grouped by Cycle when the run reads neither usage nor Planning', () => {
    const query = createQuery([{ id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost', groupBy: { dimension: 'cycle' } }])
    const snapshot = createAnalyticsSnapshot({ workItems, events: [], authorizedProjectIds, query })
    expect(snapshot.widgets[0]?.warnings).toEqual([
      ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING,
      ANALYTICS_PLANNING_GROUPS_UNAVAILABLE_WARNING,
    ])
    expect(analyticsSnapshotReadAgentCost(snapshot)).toBe(false)
    expect(analyticsSnapshotReadPlanningGroups(query, snapshot)).toBe(false)
    expect(snapshot.permissionScopeHash).toBe(
      createAnalyticsPermissionScopeHash(workItems, Date.parse(period.to), authorizedProjectIds),
    )
  })

  test('fixes the Teams whose cost the viewer could see in the permission scope', () => {
    const query = createQuery([{ id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost' }])
    const managed = createAnalyticsSnapshot({ workItems, events: [], authorizedProjectIds, agentUsage, query })
    const notManaged = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      agentUsage: { ...agentUsage, costTeamIds: [] },
      query,
    })
    expect(analyticsSnapshotReadAgentCost(managed)).toBe(true)
    expect(managed.permissionScopeHash).not.toBe(notManaged.permissionScopeHash)
    expect(managed.permissionScopeHash).toBe(createAnalyticsPermissionScopeHash(
      workItems,
      Date.parse(period.to),
      authorizedProjectIds,
      undefined,
      undefined,
      ['core'],
    ))
    // Token widgets do not depend on the managed Teams.
    const tokens = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      agentUsage,
      query: createQuery([{ id: 'tokens', title: 'Tokens', type: 'metric', metric: 'agent-tokens' }]),
    })
    expect(tokens.permissionScopeHash).toBe(
      createAnalyticsPermissionScopeHash(workItems, Date.parse(period.to), authorizedProjectIds),
    )
  })

  test('drills down into the runs behind a total', () => {
    const page = queryAnalyticsEvidence({
      workItems,
      events: [],
      authorizedProjectIds,
      agentUsage,
      evidence: { metric: 'agent-cost', filter: { period }, asOf: period.to, timeZone: 'UTC' },
    })
    expect(page.items.map((item) => [item.workItemId, item.value])).toEqual([['item-1', 0.03], ['item-1', 0.12]])
  })

  test('exports the metric and unit labels', async () => {
    const snapshot = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      agentUsage,
      query: createQuery([
        { id: 'tokens', title: 'Tokens', type: 'metric', metric: 'agent-tokens' },
        { id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost' },
      ]),
    })
    const csv = createAnalyticsCsv(snapshot)
    expect(csv).toContain('tokens,agent-tokens,Agent tokens,3500')
    expect(csv).toContain('cost,agent-cost,Agent estimated cost,0.15')
    const japanese = await readPdfText(createAnalyticsPdf(snapshot, 'ja'))
    expect(japanese).toContain('エージェントのトークン')
    expect(japanese).toContain('3500 トークン')
    expect(japanese).toContain('0.15 USD')
  })

  test('tells which queries read usage and cost', () => {
    const tokens = createQuery([{ id: 'tokens', title: 'Tokens', type: 'metric', metric: 'agent-tokens' }])
    const cost = createQuery([{ id: 'cost', title: 'Cost', type: 'metric', metric: 'agent-cost' }])
    const throughput = createQuery([{ id: 'done', title: 'Done', type: 'metric', metric: 'throughput' }])
    expect([tokens, cost, throughput].map(analyticsQueryReadsAgentUsage)).toEqual([true, true, false])
    expect([tokens, cost, throughput].map(analyticsQueryReadsAgentCost)).toEqual([false, true, false])
  })
})
