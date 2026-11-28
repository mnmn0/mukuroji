import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { listWorkItemAgentRuns, releaseAgentRun } from '../src/work-items/api/agentRuns'
import { agentRunFixtures, stalledAgentRunFixture } from '../src/work-items/agentRunFixtures'
import { readAgentRunDisplayState, splitAgentRuns } from '../src/work-items/model/agentRunDisplay'
import { WorkItemAgentRunsPanel } from '../src/work-items/ui/WorkItemAgentRunsPanel'
import { applyAgentRunToHistory, readAgentRunsRefreshDelay } from '../src/work-items/queries/useWorkItemAgentRuns'
import { createWorkItemAgentRunsLabels } from '../src/work-items/ui/agentRunLabels'
import { DEFAULT_WORK_ITEM_TYPE, type AgentRunView, type WorkItemDetailSectionId } from '@mukuroji/contracts'
import { createTranslator } from '../src/shared/i18n/i18n'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { TaskDetailPane } from '../src/tasks/ui/TaskDetailPane'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'

const labels = createWorkItemAgentRunsLabels('en')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('WorkItemAgentRunsPanel', () => {
  test('uses the shared locale dictionaries for both locales', () => {
    const ja = createWorkItemAgentRunsLabels('ja')
    expect(ja.title).toBe(createTranslator('ja')('workItems.agentRuns.title'))
    expect(labels.title).toBe(createTranslator('en')('workItems.agentRuns.title'))
    expect(ja.states.stalled).not.toBe(labels.states.stalled)
    expect(ja.runtimes['claude-code']).toBe('Claude Code')
  })

  test('appears on the task page detail even when the Work Item type hides the workflow section', () => {
    const task = referoTaskFixtures[0]
    const detailSections: WorkItemDetailSectionId[] = ['overview', 'description']
    const configuration = {
      ...teamWorkItemConfigurationFixture,
      workItemTypes: [{ ...DEFAULT_WORK_ITEM_TYPE, detailSections }],
    }
    /**
     * Renders the task page detail for the fixture task.
     *
     * @param accessToken - Session token, when signed in.
     * @returns Markup.
     */
    const render = (accessToken?: string) => renderToStaticMarkup(
      <TaskDetailPane
        accessToken={accessToken}
        assigneeOptions={[]}
        configuration={configuration}
        detail={{ issue: task, activity: [] }}
        isLoading={false}
        isRelationCandidatesLoading={false}
        locale="en"
        projects={[]}
        relationCandidates={[]}
        t={createTranslator('en')}
        task={task}
        workspaceMembers={[]}
      />,
    )
    expect(render('session-token')).toContain('data-testid="work-item-agent-runs-panel"')
    expect(render()).not.toContain('data-testid="work-item-agent-runs-panel"')
  })

  test('shows the active run with its release action and the finished history', () => {
    const html = renderToStaticMarkup(
      <WorkItemAgentRunsPanel formatDateTime={(value) => value} labels={labels} onRelease={async () => undefined} runs={agentRunFixtures} />,
    )
    expect(html).toContain('Running')
    expect(html).toContain('Claude Code')
    expect(html).toContain('>Release<')
    expect(html).toContain('Earlier runs')
    expect(html).toContain('Paused')
    expect(html).toContain('Released')
    // The active run resumed the paused one, and only that run carries the badge.
    expect(html.match(/data-testid="agent-run-resumed"/g)).toHaveLength(1)
    expect(html).toContain(`>${labels.resumed}<`)
    expect(html).not.toContain(labels.historyTruncated)
    const truncated = renderToStaticMarkup(
      <WorkItemAgentRunsPanel formatDateTime={(value) => value} hasMore labels={labels} runs={agentRunFixtures} />,
    )
    expect(truncated).toContain(labels.historyTruncated)
  })

  test('hides the release action when the viewer may not release and explains a stalled run', () => {
    const html = renderToStaticMarkup(
      <WorkItemAgentRunsPanel
        formatDateTime={(value) => value}
        labels={labels}
        onRelease={async () => undefined}
        runs={[{ ...stalledAgentRunFixture, canRelease: false }]}
      />,
    )
    expect(html).toContain('Stalled')
    expect(html).toContain(labels.stalledHint)
    expect(html).not.toContain('>Release<')
  })

  test('shows empty, loading, and error states', () => {
    /**
     * Renders the panel without runs.
     *
     * @param props - Props that override the defaults.
     * @returns Markup.
     */
    const render = (props: Partial<Parameters<typeof WorkItemAgentRunsPanel>[0]>) => renderToStaticMarkup(
      <WorkItemAgentRunsPanel formatDateTime={(value) => value} labels={labels} runs={[]} {...props} />,
    )
    expect(render({})).toContain(labels.empty)
    expect(render({ isLoading: true })).toContain(labels.loading)
    const failed = render({ errorMessage: labels.loadError, onRetry: () => undefined })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('>Reload agent runs<')
  })

  test('refreshes at the regular interval, or right after the active lease expires', () => {
    const now = Date.parse('2026-10-22T00:00:00.000Z')
    const active = { ...stalledAgentRunFixture, stalled: false }
    expect(readAgentRunsRefreshDelay(undefined, now)).toBe(30_000)
    expect(readAgentRunsRefreshDelay({ items: [], hasMore: false }, now)).toBe(30_000)
    expect(readAgentRunsRefreshDelay({ items: [{ ...active, leaseExpiresAt: '2026-10-22T00:00:10.000Z' }], hasMore: false }, now))
      .toBe(11_000)
    expect(readAgentRunsRefreshDelay({ items: [{ ...active, leaseExpiresAt: '2026-10-22T00:20:00.000Z' }], hasMore: false }, now))
      .toBe(30_000)
    expect(readAgentRunsRefreshDelay({ items: [{ ...active, leaseExpiresAt: '2026-10-21T23:00:00.000Z' }], hasMore: false }, now))
      .toBe(5_000)
    expect(readAgentRunsRefreshDelay({ items: [stalledAgentRunFixture], hasMore: false }, now)).toBe(30_000)
  })

  test('derives display states and separates the active run', () => {
    expect(readAgentRunDisplayState({ state: 'active', stalled: true })).toBe('stalled')
    expect(readAgentRunDisplayState({ state: 'finished', stalled: false, outcome: 'failed' })).toBe('failed')
    const { active, history } = splitAgentRuns(agentRunFixtures)
    expect(active?.runId).toBe(agentRunFixtures[0]?.runId)
    expect(history).toHaveLength(2)
  })

  test('shows a committed release from its response without waiting for a refresh', () => {
    const [active, ...rest] = agentRunFixtures
    if (!active) throw new Error('The fixtures need an active run.')
    const released: AgentRunView = { ...active, state: 'finished', outcome: 'released', canRelease: false }
    const updated = applyAgentRunToHistory({ items: agentRunFixtures, hasMore: true }, released)
    expect(updated).toEqual({ items: [released, ...rest], hasMore: true })
    expect(applyAgentRunToHistory(undefined, released)).toBeUndefined()
  })
})

describe('Agent Run API', () => {
  test('validates the history response and rejects unexpected shapes', async () => {
    const requests: string[] = []
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      return Response.json({ items: agentRunFixtures, hasMore: false })
    }
    const listed = await listWorkItemAgentRuns('token', 'core', 'task/1')
    expect(listed.items).toHaveLength(3)
    expect(listed.items[0]?.resumedFromRunId).toBe('run_00000000-0000-4000-8000-000000000002')
    expect(requests[0]).toBe('/api/teams/core/work-items/task%2F1/agent-runs')
    globalThis.fetch = async () => Response.json({ items: [{ ...agentRunFixtures[0], runtime: 'unknown' }], hasMore: false })
    await expect(listWorkItemAgentRuns('token', 'core', 'task')).rejects.toMatchObject({ status: 502 })
    globalThis.fetch = async () => Response.json({ items: [{ ...agentRunFixtures[0], resumedFromRunId: '' }], hasMore: false })
    await expect(listWorkItemAgentRuns('token', 'core', 'task')).rejects.toMatchObject({ status: 502 })
    globalThis.fetch = async () => Response.json({ items: agentRunFixtures })
    await expect(listWorkItemAgentRuns('token', 'core', 'task')).rejects.toMatchObject({ status: 502 })
  })

  test('shows managers the credential and instance that started each run, and nothing to other viewers', async () => {
    const startedBy = { credentialId: 'key-1', credentialName: 'Laptop agent', instanceIdHash: 'a'.repeat(64) }
    const [active, ...rest] = agentRunFixtures
    if (!active) throw new Error('The fixtures need an active run.')
    const runs: AgentRunView[] = [{ ...active, startedBy }, ...rest.map((run) => ({ ...run, startedBy: { credentialId: 'key-2', instanceIdHash: 'b'.repeat(64) } }))]
    const html = renderToStaticMarkup(<WorkItemAgentRunsPanel formatDateTime={(value) => value} labels={labels} runs={runs} />)
    expect(html).toContain('Laptop agent (key-1)')
    expect(html).toContain(`>${'a'.repeat(12)}<`)
    expect(html).toContain(`${labels.startedByCredential}: key-2`)
    const viewer = renderToStaticMarkup(<WorkItemAgentRunsPanel formatDateTime={(value) => value} labels={labels} runs={agentRunFixtures} />)
    expect(viewer).not.toContain(labels.startedByCredential)

    globalThis.fetch = async () => Response.json({ items: runs, hasMore: false })
    expect((await listWorkItemAgentRuns('token', 'core', 'task')).items[0]?.startedBy).toEqual(startedBy)
    globalThis.fetch = async () => Response.json({ items: [{ ...active, startedBy: { credentialId: '', instanceIdHash: 'x' } }], hasMore: false })
    await expect(listWorkItemAgentRuns('token', 'core', 'task')).rejects.toMatchObject({ status: 502 })
  })

  test('shows the model time of a run that sent requests but no activity', () => {
    const usage = {
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 2,
      models: ['claude-sonnet-5-5'], aiDurationMs: 4_000, byModel: [], hasMore: false,
    }
    const [active, ...rest] = agentRunFixtures
    if (!active) throw new Error('Expected a fixture run.')
    const runs = [{ ...active, usage, activity: undefined }, ...rest.map((run) => ({ ...run, usage, activity: undefined }))]
    const html = renderToStaticMarkup(
      <WorkItemAgentRunsPanel formatDateTime={(value) => value} labels={labels} runs={runs} />,
    )
    expect(html.split('data-testid="agent-run-activity"').length - 1).toBe(runs.length)
    expect(html).toContain('model 4 s')
  })

  test('shows token usage per run and for the Work Item, with the cost only when the server sends it', async () => {
    const usage = {
      inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 40_000, cacheCreationTokens: 500, requestCount: 7,
      models: ['claude-sonnet-5-5'], aiDurationMs: 0, byModel: [], hasMore: false,
    }
    const [active, ...rest] = agentRunFixtures
    if (!active) throw new Error('Expected a fixture run.')
    const runs = [{ ...active, usage }, ...rest]
    const html = renderToStaticMarkup(
      <WorkItemAgentRunsPanel formatDateTime={(value) => value} labels={labels} runs={runs} usageTotal={usage} />,
    )
    expect(html).toContain('data-testid="work-item-agent-run-usage"')
    expect(html).toContain('Input 1,200 · output 300 · cache read 40,000 · cache write 500')
    expect(html).toContain('42,000 tokens')
    expect(html).not.toContain('Est.')
    const managed = renderToStaticMarkup(
      <WorkItemAgentRunsPanel
        formatDateTime={(value) => value}
        labels={labels}
        runs={runs}
        usageTotal={{ ...usage, estimatedCostMicroUsd: 1_234_567, hasMore: true }}
      />,
    )
    expect(managed).toContain('7 requests · Est. $1.23')
    expect(managed).toContain(labels.usagePartial)

    globalThis.fetch = async () => Response.json({ items: runs, hasMore: false, usageTotal: usage })
    expect((await listWorkItemAgentRuns('token', 'core', 'task')).usageTotal).toEqual(usage)
    globalThis.fetch = async () => Response.json({ items: runs, hasMore: false, usageTotal: { ...usage, inputTokens: -1 } })
    await expect(listWorkItemAgentRuns('token', 'core', 'task')).rejects.toMatchObject({ status: 502 })
    globalThis.fetch = async () => Response.json({ items: [{ ...active, usage: { ...usage, models: [1] } }], hasMore: false })
    await expect(listWorkItemAgentRuns('token', 'core', 'task')).rejects.toMatchObject({ status: 502 })
  })

  test('shows where the time went and the totals per model, and validates them', async () => {
    const usage = {
      inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 3,
      models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], aiDurationMs: 65_000,
      byModel: [
        { model: 'claude-haiku-5-5', inputTokens: 400, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 2, aiDurationMs: 5_000 },
        { model: 'claude-sonnet-5-5', inputTokens: 600, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 1, aiDurationMs: 60_000 },
      ],
      hasMore: false,
    }
    const activity = {
      toolCount: 3, toolDurationMs: 200_000, toolFailureCount: 1,
      tools: [
        { kind: 'builtin' as const, name: 'Bash', count: 2, durationMs: 190_000, failureCount: 1 },
        { kind: 'mcp' as const, name: 'github/get_issue', count: 1, durationMs: 10_000, failureCount: 0 },
      ],
      approvalWait: { count: 1, durationMs: 30_000 }, promptWait: { count: 1, durationMs: 3_900_000 }, hasMore: false,
    }
    const [active, ...rest] = agentRunFixtures
    if (!active) throw new Error('Expected a fixture run.')
    const runs = [{ ...active, usage, activity }, ...rest]
    const html = renderToStaticMarkup(
      <WorkItemAgentRunsPanel activityTotal={activity} formatDateTime={(value) => value} labels={labels} runs={runs} usageTotal={usage} />,
    )
    expect(html).toContain(labels.activityTitle)
    expect(html).toContain('Model 1 min 5 s · tools 3 min 20 s · waiting for approval 30 s · waiting for the next prompt 1 h 5 min')
    expect(html).toContain('Bash: 3 min 10 s · 2 calls · 1 failed')
    expect(html).toContain('MCP github/get_issue: 10 s · 1 call')
    expect(html).toContain('claude-sonnet-5-5: 700 tokens · 1 request · 1 min 0 s')
    expect(html).toContain('data-testid="agent-run-activity"')

    globalThis.fetch = async () => Response.json({ items: runs, hasMore: false, usageTotal: usage, activityTotal: activity })
    const listed = await listWorkItemAgentRuns('token', 'core', 'task')
    expect(listed.activityTotal).toEqual(activity)
    expect(listed.items[0]?.usage?.byModel).toEqual(usage.byModel)
    globalThis.fetch = async () => Response.json({ items: runs, hasMore: false, activityTotal: { ...activity, tools: [{ kind: 'other' }] } })
    await expect(listWorkItemAgentRuns('token', 'core', 'task')).rejects.toMatchObject({ status: 502 })
  })

  test('sends release with idempotency headers and surfaces server errors', async () => {
    let headers: Headers | undefined
    globalThis.fetch = async (_input, init) => {
      headers = new Headers(init?.headers)
      return Response.json({ code: 'agent_run_not_active', message: 'Finished.' }, { status: 409 })
    }
    await expect(releaseAgentRun('token', 'core', 'run_1', { idempotencyKey: 'key', correlationId: 'correlation' }))
      .rejects.toMatchObject({ status: 409, code: 'agent_run_not_active' })
    expect(headers?.get('Idempotency-Key')).toBe('key')
    expect(headers?.get('Authorization')).toBe('Bearer token')
  })
})
