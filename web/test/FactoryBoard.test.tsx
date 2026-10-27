import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { classifyFactoryBoardItem, type FactoryBoardItem } from '@mukuroji/contracts'
import { getTeamAgentRunBoard } from '../src/work-items/api/agentRuns'
import {
  factoryBoardFixture,
  factoryBoardFixtureItems,
  factoryBoardFixtureNow,
  factoryBoardFixtureProjectNames,
} from '../src/features/factory-board/fixtures'
import {
  defaultFactoryBoardFilters,
  filterFactoryBoardItems,
  groupFactoryBoardItems,
  isFactoryBoardIncomplete,
  readFactoryBoardFilterOptions,
  readLeaseMinutesRemaining,
} from '../src/features/factory-board/model/factoryBoard'
import { FactoryBoard } from '../src/features/factory-board/ui/FactoryBoard'
import { createFactoryBoardLabels } from '../src/features/factory-board/ui/factoryBoardLabels'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch
const now = new Date(factoryBoardFixtureNow)

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with one that returns a JSON body.
 *
 * @param body - Response body.
 * @param status - HTTP status.
 * @returns Requested URLs.
 */
function respondWith(body: unknown, status = 200): string[] {
  const urls: string[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }, { preconnect: originalFetch.preconnect })
  return urls
}

/**
 * Finds a fixture item by Work Item ID.
 *
 * @param id - Work Item ID.
 * @returns Fixture item.
 */
function fixtureItem(id: string): FactoryBoardItem {
  const item = factoryBoardFixtureItems.find((candidate) => candidate.workItem.id === id)
  if (!item) throw new Error(`Missing fixture ${id}`)
  return item
}

describe('Factory board API', () => {
  test('reads and validates the Team board', async () => {
    const urls = respondWith(factoryBoardFixture)
    expect(await getTeamAgentRunBoard('token', 'core team')).toEqual(factoryBoardFixture)
    expect(urls).toEqual(['/api/teams/core%20team/agent-runs'])
  })

  test('rejects a malformed item instead of showing a smaller board', async () => {
    const base = fixtureItem('auth-flow')
    const malformed = [
      { ...base, workItem: { ...base.workItem, statusCategory: 'unknown' } },
      { ...base, run: { ...base.run, runtime: 'gpt' } },
      { ...base, run: { ...base.run, workItemId: 'another-item' } },
      { ...base, latestReport: { ...base.latestReport, runId: 'run_other' } },
      { ...base, latestReport: { ...base.latestReport, verificationCounts: { passed: -1, failed: 0, skipped: 0 } } },
      { workItem: base.workItem, latestReport: base.latestReport },
    ]
    for (const item of malformed) {
      respondWith({ ...factoryBoardFixture, items: [item] })
      await expect(getTeamAgentRunBoard('token', 'core')).rejects.toMatchObject({ status: 502 })
    }
    respondWith({ ...factoryBoardFixture, finishedRunsHasMore: 'yes' })
    await expect(getTeamAgentRunBoard('token', 'core')).rejects.toMatchObject({ status: 502 })
  })

  test('keeps the server status of a failed read', async () => {
    respondWith({ code: 'temporarily_unavailable', message: 'Agent Run records are inconsistent.' }, 503)
    await expect(getTeamAgentRunBoard('token', 'core')).rejects.toMatchObject({ status: 503, code: 'temporarily_unavailable' })
  })
})

describe('Factory board lanes', () => {
  test('places each fixture item in the lane the doc defines', () => {
    expect(Object.fromEntries(factoryBoardFixtureItems.map((item) => [item.workItem.id, classifyFactoryBoardItem(item, now)]))).toEqual({
      'auth-flow': 'processing',
      'release-notes': 'processing',
      'manual-start': 'no-run',
      'schema-change': 'decision',
      'review-wait': 'decision',
      'stalled-import': 'stalled',
      'flaky-test': 'failed',
      'docs-link': 'completed',
    })
  })

  test('moves tiles as time passes and drops items that belong to no lane', () => {
    const processing = fixtureItem('auth-flow')
    expect(classifyFactoryBoardItem(processing, new Date('2026-10-22T02:13:00.000Z'))).toBe('stalled')
    const completed = fixtureItem('docs-link')
    expect(classifyFactoryBoardItem(completed, new Date('2026-10-22T22:59:00.000Z'))).toBe('completed')
    expect(classifyFactoryBoardItem(completed, new Date('2026-10-22T23:01:00.000Z'))).toBeUndefined()
    // A paused run asks for a decision only while its Work Item is still started.
    const paused = fixtureItem('review-wait')
    expect(classifyFactoryBoardItem({ ...paused, workItem: { ...paused.workItem, statusCategory: 'completed' } }, now)).toBeUndefined()
    // A released run leaves a started Work Item without a run.
    const released = { ...paused, run: paused.run && { ...paused.run, outcome: 'released' as const } }
    expect(classifyFactoryBoardItem(released, now)).toBe('no-run')
    expect(classifyFactoryBoardItem({ workItem: { ...paused.workItem, statusCategory: 'unstarted' } }, now)).toBeUndefined()
    // A handoff of another run does not make the active run wait for a decision.
    const blocked = fixtureItem('schema-change')
    expect(classifyFactoryBoardItem({ ...blocked, latestReport: blocked.latestReport && { ...blocked.latestReport, runId: 'run_other' } }, now)).toBe('processing')
  })

  test('groups lanes in display order with leases expiring first', () => {
    const groups = groupFactoryBoardItems(factoryBoardFixtureItems, now)
    expect(groups.map((group) => group.lane)).toEqual(['processing', 'no-run', 'decision', 'stalled', 'failed', 'completed'])
    expect(groups[0]?.items.map((item) => item.workItem.id)).toEqual(['auth-flow', 'release-notes'])
  })

  test('keeps selected filter choices listed after a refresh removes their last item', () => {
    const remaining = factoryBoardFixtureItems.filter((item) => item.workItem.assigneeUserId !== 'tanaka@example.com')
    const selected = { runtime: 'kiro' as const, assigneeUserId: 'tanaka@example.com', projectId: 'gone-project' }
    const options = readFactoryBoardFilterOptions(remaining, selected)
    expect(options.assigneeUserIds).toContain('tanaka@example.com')
    expect(options.projectIds).toContain('gone-project')
    expect(options.runtimes).toContain('kiro')
    expect(readFactoryBoardFilterOptions([], { ...defaultFactoryBoardFilters, projectId: 'none' }).hasUnassignedProject).toBe(true)
  })

  test('filters by runtime, assignee, and Project', () => {
    const options = readFactoryBoardFilterOptions(factoryBoardFixtureItems)
    expect(options).toEqual({
      runtimes: ['claude-code', 'codex', 'kiro'],
      assigneeUserIds: ['sato@example.com', 'tanaka@example.com'],
      projectIds: ['refero'],
      hasUnassignedProject: true,
    })
    const ids = (filters: Partial<typeof defaultFactoryBoardFilters>) =>
      filterFactoryBoardItems(factoryBoardFixtureItems, { ...defaultFactoryBoardFilters, ...filters }).map((item) => item.workItem.id)
    expect(ids({ runtime: 'codex' })).toEqual(['release-notes', 'flaky-test'])
    expect(ids({ assigneeUserId: 'tanaka@example.com' })).toEqual(['release-notes', 'stalled-import'])
    expect(ids({ projectId: 'none' })).toEqual(['release-notes', 'stalled-import'])
    expect(ids({ projectId: 'refero', runtime: 'kiro' })).toEqual(['schema-change'])
  })

  test('reads lease time and whether the board is incomplete', () => {
    expect(readLeaseMinutesRemaining('2026-10-22T02:12:00.000Z', now)).toBe(12)
    expect(readLeaseMinutesRemaining('2026-10-22T01:40:00.000Z', now)).toBe(-20)
    expect(isFactoryBoardIncomplete(factoryBoardFixture)).toBe(false)
    expect(isFactoryBoardIncomplete({ ...factoryBoardFixture, startedWorkItemsHasMore: true })).toBe(true)
  })
})

describe('Factory board view', () => {
  const labels = createFactoryBoardLabels('en')
  /**
   * Renders the board with fixture data.
   *
   * @param overrides - Props that differ.
   * @returns Markup.
   */
  const render = (overrides: Partial<Parameters<typeof FactoryBoard>[0]> = {}) => renderToStaticMarkup(
    <FactoryBoard
      board={factoryBoardFixture}
      formatDateTime={(value) => value}
      getWorkItemHref={(item) => `/teams/core/issues?issueId=${item.workItem.id}`}
      isLoading={false}
      labels={labels}
      onNavigate={() => undefined}
      onRefresh={() => undefined}
      onSelect={() => undefined}
      projectNames={factoryBoardFixtureProjectNames}
      reports={{ isLoading: false }}
      {...overrides}
    />,
  )

  test('uses the shared locale dictionaries for both locales', () => {
    expect(createFactoryBoardLabels('ja').lanes.decision).toBe(createTranslator('ja')('factoryBoard.lane.decision'))
    expect(labels.lanes.decision).toBe(createTranslator('en')('factoryBoard.lane.decision'))
  })

  test('shows lanes, lease time, and the release action only for releasable active runs', () => {
    const html = render({ selectedWorkItemId: 'auth-flow', onRelease: async () => undefined })
    expect(html).toContain('aria-label="Processing"')
    expect(html).toContain('data-testid="factory-board-no-run"')
    expect(html).toContain('12 min left on lease')
    expect(html).toContain('Lease expired 20 min ago')
    expect(html).toContain('>Release<')
    expect(html).toContain('Open Work Item')
    expect(html).not.toContain('%')
    expect(render({ selectedWorkItemId: 'flaky-test', onRelease: async () => undefined })).not.toContain('>Release<')
  })

  test('shows an error with retry instead of an empty board', () => {
    const html = render({ board: undefined, errorMessage: labels.loadError })
    expect(html).toContain('role="alert"')
    expect(html).toContain(labels.retry)
    expect(html).not.toContain(labels.empty)
    expect(render({ board: { ...factoryBoardFixture, items: [] } })).toContain(labels.empty)
  })
})
