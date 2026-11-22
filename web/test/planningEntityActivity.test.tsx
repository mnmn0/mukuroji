import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getPlanningEntityActivity, PlanningApiError } from '../src/planning/api'
import { planningEntityActivityFixture, planningSnapshotFixture } from '../src/planning/fixtures'
import { createPlanningEntityActivityRows } from '../src/planning/model/entityActivity'
import { createPlanningLabels } from '../src/planning/ui/labels'
import { PlanningEntityActivityPanel } from '../src/planning/ui/PlanningEntityActivityPanel'
import { PlanningEntityDetailTabs } from '../src/planning/ui/PlanningEntityDetailTabs'
import { PlanningScreen } from '../src/planning/ui/PlanningScreen'

const labels = createPlanningLabels('en')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with a recorder that answers every request with one JSON body.
 *
 * @param body - Response body.
 * @param status - Response status.
 * @returns The recorded request URLs and headers.
 */
function recordFetch(body: unknown, status = 200) {
  const requests: Array<{ url: string; headers: HeadersInit | undefined }> = []
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        headers: init.headers,
      })
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
        status,
      })
    },
    { preconnect: originalFetch.preconnect },
  )
  return requests
}

describe('Planning entity activity API', () => {
  test('reads activity pages by cursor and keeps only the shown fields', async () => {
    const requests = recordFetch({
      events: [{
        eventId: 'event-1',
        eventType: 'planning-entity.updated',
        action: 'updated',
        occurredAt: '2026-08-05T02:15:00.000Z',
        actor: { id: 'sub-1', kind: 'user', displayName: 'owner@example.com' },
        entity: { type: 'planning-entity', id: 'goal/new' },
        changes: [{ field: 'risk', before: 'low', after: 'high' }, { field: 'description', after: 'New' }],
        correlationId: 'correlation-1',
        source: { kind: 'api' },
        summary: 'Updated goal: New',
      }],
      nextCursor: 'cursor/2',
    })

    await expect(getPlanningEntityActivity('access-token', 'goal/new', { limit: 25 })).resolves.toEqual({
      events: [{
        eventId: 'event-1',
        eventType: 'planning-entity.updated',
        action: 'updated',
        occurredAt: '2026-08-05T02:15:00.000Z',
        actor: { kind: 'user', displayName: 'owner@example.com' },
        changes: [{ field: 'risk', before: 'low', after: 'high' }, { field: 'description', after: 'New' }],
        summary: 'Updated goal: New',
      }],
      nextCursor: 'cursor/2',
    })
    await getPlanningEntityActivity('access-token', 'goal/new', { cursor: 'cursor/2', limit: 25 })

    expect(requests.map((request) => request.url)).toEqual([
      '/api/planning/entities/goal%2Fnew/activity?limit=25',
      '/api/planning/entities/goal%2Fnew/activity?limit=25&cursor=cursor%2F2',
    ])
    expect(requests[0]?.headers).toMatchObject({ Authorization: 'Bearer access-token' })
  })

  test('rejects a malformed activity response', async () => {
    recordFetch({ events: [{ eventId: 'event-1', eventType: 'planning-entity.updated' }] })
    const error = await getPlanningEntityActivity('access-token', 'goal-1').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(PlanningApiError)
    expect(error).toMatchObject({ status: 502, code: 'InvalidPlanningActivityResponse' })
  })

  test('reports the server error of a hidden entity', async () => {
    recordFetch({ code: 'PlanningEntityNotFound', message: 'Planning entity was not found.' }, 404)
    const error = await getPlanningEntityActivity('access-token', 'goal-1').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 404, code: 'PlanningEntityNotFound' })
  })
})

describe('Planning entity activity rows', () => {
  test('lists edited fields in form order and hides derived fields', () => {
    const rows = createPlanningEntityActivityRows(planningEntityActivityFixture)

    expect(rows.map((row) => row.kind)).toEqual(['moved', 'updated', 'created'])
    expect(rows[1]?.changes.map((change) => change.field)).toEqual([
      'description',
      'health',
      'risk',
      'forecast.startDate',
      'forecast.endDate',
    ])
    expect(rows[1]?.changes[0]).toEqual({
      field: 'description',
      before: { kind: 'empty' },
      after: { kind: 'value', value: 'API の安定化を待って延期' },
    })
    // Creation lists every field, which is not a change worth repeating.
    expect(rows[2]?.changes).toEqual([])
    expect(rows[0]?.changes[0]?.before).toEqual({ kind: 'redacted' })
    expect(rows[0]?.actor).toEqual({ kind: 'member', memberKey: 'lead@example.com' })
  })

  test('names system changes and unknown actions, and drops repeated events', () => {
    const [first] = planningEntityActivityFixture
    if (!first) throw new Error('The activity fixture is empty.')
    const rows = createPlanningEntityActivityRows([
      { ...first, eventId: 'rolled-over', action: 'rolled-over', actor: { kind: 'system' }, summary: 'Rolled over' },
      { ...first, eventId: 'rolled-over', action: 'rolled-over', actor: { kind: 'system' } },
      { ...first, eventId: 'break-glass', actor: { kind: 'break-glass', displayName: 'admin@example.com' } },
    ])

    expect(rows[1]?.actor).toEqual({ kind: 'member', memberKey: 'admin@example.com' })
    expect(rows.slice(0, 1)).toEqual([{
      eventId: 'rolled-over',
      kind: 'other',
      occurredAt: first.occurredAt,
      actor: { kind: 'system' },
      summary: 'Rolled over',
      changes: [],
    }])
  })
})

describe('Planning entity activity tab', () => {
  test('shows who changed which field from what to what', () => {
    const html = renderToStaticMarkup(
      <PlanningEntityActivityPanel
        events={planningEntityActivityFixture}
        hasError={false}
        hasMore
        isLoading={false}
        labels={labels.entityActivity}
        memberName={(memberKey) => memberKey === 'owner@example.com' ? 'Owner Name' : memberKey}
        referenceValue={(field, value) => field === 'parentId' && value === 'initiative-onboarding'
          ? 'Onboarding'
          : undefined}
      />,
    )

    expect(html).toContain('Owner Name')
    expect(html).toContain(labels.entityActivity.kinds.updated)
    expect(html).toContain(labels.entityActivity.kinds.moved)
    expect(html).toContain(labels.entityActivity.kinds.created)
    expect(html).toContain('>Forecast end</dt>')
    expect(html).toContain('>2026-08-14</span>')
    expect(html).toContain('>2026-08-21</span>')
    expect(html).toContain('>On track</span>')
    expect(html).toContain('>At risk</span>')
    expect(html).toContain(`>${labels.entityActivity.emptyValue}</span>`)
    expect(html).toContain(`>${labels.entityActivity.redactedValue}</span>`)
    expect(html).toContain('>Onboarding</span>')
    expect(html).not.toContain('>Progress</dt>')
    expect(html).toContain(`>${labels.entityActivity.before} </span>`)
    expect(html).toContain(labels.entityActivity.loadMore)
  })

  test('shows the empty, loading, and error states', () => {
    /** Renders the panel with no events. */
    const render = (state: { isLoading?: boolean; hasError?: boolean }) => renderToStaticMarkup(
      <PlanningEntityActivityPanel
        events={[]}
        hasError={state.hasError ?? false}
        hasMore={false}
        isLoading={state.isLoading ?? false}
        labels={labels.entityActivity}
        onRetry={() => undefined}
      />,
    )

    expect(render({})).toContain(labels.entityActivity.empty)
    expect(render({ isLoading: true })).toContain(labels.entityActivity.loading)
    const error = render({ hasError: true })
    expect(error).toContain(labels.entityActivity.error)
    expect(error).toContain(labels.entityActivity.retry)
    expect(error).not.toContain(labels.entityActivity.empty)
  })

  test('opens on the details tab and renders the activity only when asked', () => {
    let activityRenders = 0
    const html = renderToStaticMarkup(
      <PlanningEntityDetailTabs
        details={<p>editor</p>}
        labels={labels.entityDetailTabs}
        renderActivity={() => {
          activityRenders += 1
          return <p>activity</p>
        }}
      />,
    )

    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('editor')
    expect(activityRenders).toBe(0)
  })

  test('adds the activity tab to the selected entity only when the page supplies it', () => {
    /** Renders the Planning screen with a selected Milestone. */
    const render = (withActivity: boolean) => renderToStaticMarkup(
      <PlanningScreen
        activeView="timeline"
        initialSelectedEntityId="milestone-beta"
        labels={labels}
        renderEntityActivity={withActivity ? () => <p>activity</p> : undefined}
        snapshot={planningSnapshotFixture}
      />,
    )

    const withTabs = render(true)
    expect(withTabs).toContain('data-testid="planning-entity-detail-tab-activity"')
    expect(withTabs).toContain('data-testid="planning-entity-editor"')
    const withoutTabs = render(false)
    expect(withoutTabs).not.toContain('data-testid="planning-entity-detail"')
    expect(withoutTabs).toContain('data-testid="planning-entity-editor"')
  })
})
