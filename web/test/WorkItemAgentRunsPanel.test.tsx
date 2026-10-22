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
    expect((await listWorkItemAgentRuns('token', 'core', 'task/1')).items).toHaveLength(3)
    expect(requests[0]).toBe('/api/teams/core/work-items/task%2F1/agent-runs')
    globalThis.fetch = async () => Response.json({ items: [{ ...agentRunFixtures[0], runtime: 'unknown' }], hasMore: false })
    await expect(listWorkItemAgentRuns('token', 'core', 'task')).rejects.toMatchObject({ status: 502 })
    globalThis.fetch = async () => Response.json({ items: agentRunFixtures })
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
