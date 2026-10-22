import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { listWorkItemAgentRuns, releaseAgentRun } from '../src/work-items/api/agentRuns'
import { agentRunFixtures, stalledAgentRunFixture } from '../src/work-items/agentRunFixtures'
import { readAgentRunDisplayState, splitAgentRuns } from '../src/work-items/model/agentRunDisplay'
import { WorkItemAgentRunsPanel } from '../src/work-items/ui/WorkItemAgentRunsPanel'
import { createWorkItemAgentRunsLabels } from '../src/work-items/ui/agentRunLabels'

const labels = createWorkItemAgentRunsLabels('en')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('WorkItemAgentRunsPanel', () => {
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
    const render = (props: Partial<Parameters<typeof WorkItemAgentRunsPanel>[0]>) => renderToStaticMarkup(
      <WorkItemAgentRunsPanel formatDateTime={(value) => value} labels={labels} runs={[]} {...props} />,
    )
    expect(render({})).toContain(labels.empty)
    expect(render({ isLoading: true })).toContain(labels.loading)
    const failed = render({ errorMessage: labels.loadError, onRetry: () => undefined })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('>Retry<')
  })

  test('derives display states and separates the active run', () => {
    expect(readAgentRunDisplayState({ state: 'active', stalled: true })).toBe('stalled')
    expect(readAgentRunDisplayState({ state: 'finished', stalled: false, outcome: 'failed' })).toBe('failed')
    const { active, history } = splitAgentRuns(agentRunFixtures)
    expect(active?.runId).toBe(agentRunFixtures[0]?.runId)
    expect(history).toHaveLength(2)
  })
})

describe('Agent Run API', () => {
  test('validates the history response and rejects unexpected shapes', async () => {
    const requests: string[] = []
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      return Response.json({ items: agentRunFixtures })
    }
    expect((await listWorkItemAgentRuns('token', 'core', 'task/1')).items).toHaveLength(3)
    expect(requests[0]).toBe('/api/teams/core/work-items/task%2F1/agent-runs')
    globalThis.fetch = async () => Response.json({ items: [{ ...agentRunFixtures[0], runtime: 'unknown' }] })
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
