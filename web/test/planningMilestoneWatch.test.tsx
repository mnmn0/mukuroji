import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getPlanningEntityWatch, PlanningApiError, setPlanningEntityWatch } from '../src/planning/api'
import { createPlanningLabels } from '../src/planning/ui/labels'
import { PlanningMilestoneWatchButton } from '../src/planning/ui/PlanningMilestoneWatch'

const labels = createPlanningLabels('en').milestoneWatch
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with a recorder that answers every request with one JSON body.
 *
 * @param body - Response body.
 * @returns The recorded request URLs, methods, and headers.
 */
function recordFetch(body: unknown) {
  const requests: Array<{ url: string; method: string | undefined; headers: HeadersInit | undefined }> = []
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        method: init.method,
        headers: init.headers,
      })
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  return requests
}

describe('Milestone watch', () => {
  test('reads and changes the watch of one Milestone', async () => {
    const watch = { subscribed: true, explicit: true, automatic: false, reasons: ['manual'], watcherCount: 2 }
    const requests = recordFetch({ watch })
    const context = { idempotencyKey: 'key-1', correlationId: 'correlation-1' }

    await expect(getPlanningEntityWatch('access-token', 'beta/launch')).resolves.toEqual({ subscribed: true, watcherCount: 2 })
    await setPlanningEntityWatch('access-token', 'beta/launch', true, context)
    await setPlanningEntityWatch('access-token', 'beta/launch', false, context)

    expect(requests.map(({ method, url }) => [method ?? 'GET', url])).toEqual([
      ['GET', '/api/planning/entities/beta%2Flaunch/watch'],
      ['PUT', '/api/planning/entities/beta%2Flaunch/watch'],
      ['DELETE', '/api/planning/entities/beta%2Flaunch/watch'],
    ])
    expect(requests[1]?.headers).toMatchObject({ Authorization: 'Bearer access-token', 'Idempotency-Key': 'key-1' })
  })

  test('rejects a malformed watch response', async () => {
    recordFetch({ watch: { subscribed: 'yes', watcherCount: 1 } })
    await expect(getPlanningEntityWatch('access-token', 'beta')).rejects.toBeInstanceOf(PlanningApiError)
  })

  test('shows the watch state, the watcher count, and what watching does', () => {
    const watching = renderToStaticMarkup(
      <PlanningMilestoneWatchButton labels={labels} watch={{ subscribed: true, watcherCount: 3 }} onToggle={() => {}} />,
    )
    expect(watching).toContain('aria-pressed="true"')
    expect(watching).toContain('Watching')
    expect(watching).toContain('3 watching')
    expect(watching).toContain(labels.description)

    const readOnly = renderToStaticMarkup(
      <PlanningMilestoneWatchButton labels={labels} watch={{ subscribed: false, watcherCount: 0 }} />,
    )
    expect(readOnly).toContain('Watch milestone')
    expect(readOnly).toContain('disabled=""')
    expect(renderToStaticMarkup(<PlanningMilestoneWatchButton hasError labels={labels} />)).toContain(labels.error)
  })
})
