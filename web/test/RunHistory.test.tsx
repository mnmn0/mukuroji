import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRunHistoryEntry, TeamAgentRunHistoryResponse } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createRunHistoryPeriod,
  mergeRunHistories,
  readRunHistoryPeriodDays,
  runDurationMinutes,
  runHistoryProjectKey,
  toRunHistoryCsv,
} from '../src/features/factory-board/model/runHistory'
import { RunHistoryView, type RunHistoryFilterState } from '../src/features/factory-board/ui/RunHistoryView'
import { createRunHistoryLabels } from '../src/features/factory-board/ui/runHistoryLabels'
import { getTeamAgentRunHistory } from '../src/work-items/api/agentRuns'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with one that returns a JSON body.
 *
 * @param body - Response body.
 * @returns Requested URLs.
 */
function respondWith(body: unknown): string[] {
  const urls: string[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }, { preconnect: originalFetch.preconnect })
  return urls
}

/**
 * Creates a finished run of the history.
 *
 * @param teamId - Team of the run.
 * @param sequence - Distinguishes runs; a higher number finished later.
 * @param patch - Fields to override.
 * @returns The run.
 */
function entry(teamId: string, sequence: number, patch: Partial<AgentRunHistoryEntry> = {}): AgentRunHistoryEntry {
  const finishedAt = new Date(Date.UTC(2026, 10, 20, sequence)).toISOString()
  return {
    schemaVersion: 1, runId: `run_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, teamId,
    workItemId: `task-${sequence}`, assigneeUserId: 'member-1', runtime: 'claude-code', agentName: 'agent', state: 'finished',
    outcome: 'completed', startRevision: 2, leaseMinutes: 30, startedAt: new Date(Date.UTC(2026, 10, 20, sequence) - 90 * 60_000).toISOString(),
    lastHeartbeatAt: finishedAt, leaseExpiresAt: finishedAt, stalled: false, finishedAt, finishedBy: 'agent', reportCount: 0,
    workItemTitle: `Task ${sequence}`, ...patch,
  }
}

/**
 * Wraps runs in a Team response.
 *
 * @param teamId - Team ID.
 * @param runs - Runs.
 * @param hasMore - Whether runs were left out.
 * @returns The response.
 */
function response(teamId: string, runs: AgentRunHistoryEntry[], hasMore = false): TeamAgentRunHistoryResponse {
  return { teamId, from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T23:59:59.000Z', runs, hasMore }
}

const filters: RunHistoryFilterState = { days: 7, teamId: '', outcome: '', runtime: '', projectId: '', mineOnly: false }

describe('Run history model', () => {
  test('merges Teams newest finish first and keeps hasMore from any Team', () => {
    const merged = mergeRunHistories([
      response('team-a', [entry('team-a', 3), entry('team-a', 1)]),
      response('team-b', [entry('team-b', 2)], true),
    ], { 'team-a': 'Alpha' })
    expect(merged.rows.map((row) => [row.teamName, row.workItemId])).toEqual([['Alpha', 'task-3'], ['team-b', 'task-2'], ['Alpha', 'task-1']])
    expect(merged.hasMore).toBe(true)
  })

  test('reads offered periods and builds their bounds', () => {
    expect(readRunHistoryPeriodDays('30')).toBe(30)
    expect(readRunHistoryPeriodDays('14')).toBeUndefined()
    expect(createRunHistoryPeriod(7, new Date('2026-11-20T00:00:00.000Z'))).toEqual({ from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' })
  })

  test('measures the duration in minutes', () => {
    expect(runDurationMinutes(entry('team-a', 1))).toBe(90)
    expect(runDurationMinutes({ startedAt: '2026-11-20T00:00:00.000Z', finishedAt: undefined })).toBeUndefined()
  })

  test('writes quoted CSV that a spreadsheet cannot run as a formula', () => {
    const labels = createRunHistoryLabels('ja')
    const { rows } = mergeRunHistories([response('team-a', [entry('team-a', 1, { workItemTitle: '=HYPERLINK("x")', projectId: 'p1', outcome: 'failed' })])], { 'team-a': 'Alpha' })
    const csv = toRunHistoryCsv(rows, labels, { [runHistoryProjectKey('team-a', 'p1')]: 'Refero', [runHistoryProjectKey('team-b', 'p1')]: 'Other' }, { 'member-1': 'Shinji' })
    const [header, line] = csv.trimEnd().split('\r\n')
    expect(header).toContain('"終了日時"')
    expect(line).toContain(`"'=HYPERLINK(""x"")"`)
    expect(line).toContain('"Refero"')
    expect(line).toContain('"Shinji"')
    expect(line).toContain(`"${labels.outcomes.failed}"`)
    expect(line).toContain('"90"')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  test('names a Project by its own Team when two Teams share a Project ID', () => {
    const labels = createRunHistoryLabels('ja')
    const { rows } = mergeRunHistories([
      response('team-a', [entry('team-a', 1, { projectId: 'p1' })]),
      response('team-b', [entry('team-b', 2, { projectId: 'p1' })]),
    ], { 'team-a': 'Alpha', 'team-b': 'Beta' })
    const names = { [runHistoryProjectKey('team-a', 'p1')]: 'Refero', [runHistoryProjectKey('team-b', 'p1')]: 'Other' }
    const lines = toRunHistoryCsv(rows, labels, names, {}).trimEnd().split('\r\n').slice(1)
    expect(lines.find((line) => line.includes('"Alpha"'))).toContain('"Refero"')
    expect(lines.find((line) => line.includes('"Beta"'))).toContain('"Other"')
  })
})

describe('Run history API', () => {
  test('sends the period and filters and validates the response', async () => {
    const urls = respondWith(response('team-a', [entry('team-a', 1, { projectId: 'p1' })]))
    const history = await getTeamAgentRunHistory('token', 'team-a', {
      from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z', outcome: 'failed', runtime: 'codex',
    })
    expect(history.runs[0]).toMatchObject({ workItemTitle: 'Task 1', projectId: 'p1' })
    expect(history.runs[0]).not.toHaveProperty('canRelease')
    const url = new URL(urls[0], 'http://localhost')
    expect(url.pathname).toEndWith('/teams/team-a/agent-runs/history')
    expect(url.searchParams.get('outcome')).toBe('failed')
    expect(url.searchParams.get('runtime')).toBe('codex')
    expect(url.searchParams.has('assigneeUserId')).toBe(false)
  })

  test('rejects a response for another Team or with an active run', async () => {
    respondWith(response('team-b', []))
    await expect(getTeamAgentRunHistory('token', 'team-a', { from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' })).rejects.toThrow()
    respondWith(response('team-a', [entry('team-a', 1, { state: 'active', outcome: undefined, finishedAt: undefined })]))
    await expect(getTeamAgentRunHistory('token', 'team-a', { from: '2026-11-13T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' })).rejects.toThrow()
  })
})

describe('RunHistoryView', () => {
  /**
   * Renders the view with Japanese text.
   *
   * @param overrides - Props to change.
   * @returns Static markup.
   */
  function render(overrides: Partial<Parameters<typeof RunHistoryView>[0]> = {}): string {
    return renderToStaticMarkup(
      <RunHistoryView
        filters={filters}
        formatDateTime={(value) => value}
        getWorkItemHref={(row) => `/teams/${row.teamId}/issues?issueId=${row.workItemId}`}
        isLoading={false}
        labels={createRunHistoryLabels('ja')}
        onDownload={() => undefined}
        onFiltersChange={() => undefined}
        onNavigate={() => undefined}
        onRetry={() => undefined}
        projectNames={{ [runHistoryProjectKey('team-a', 'p1')]: 'Refero', [runHistoryProjectKey('team-b', 'p1')]: 'Other' }}
        projects={[{ id: runHistoryProjectKey('team-a', 'p1'), name: 'Refero' }]}
        teams={[{ id: 'team-a', name: 'Alpha' }]}
        {...overrides}
      />,
    )
  }

  test('lists runs with their Team, Work Item link, outcome, and duration', () => {
    const history = mergeRunHistories([response('team-a', [entry('team-a', 1, { projectId: 'p1', outcome: 'failed', runtime: 'codex' })])], { 'team-a': 'Alpha' })
    const markup = render({ history })
    expect(markup.match(/data-testid="run-history-row"/g)).toHaveLength(1)
    expect(markup).toContain('href="/teams/team-a/issues?issueId=task-1"')
    expect(markup).toContain('Alpha')
    expect(markup).toContain('Refero')
    expect(markup).toContain('Codex')
    expect(markup).toContain('>90<')
    expect(markup).not.toContain('role="note"')
  })

  test('says when runs were left out, when nothing matches, and when loading failed', () => {
    expect(render({ history: { rows: [], hasMore: true } })).toContain('role="note"')
    expect(render({ history: { rows: [], hasMore: false } })).toContain('条件に一致する Run はありません。')
    const failed = render({ errorMessage: 'Run 履歴を読み込めませんでした。' })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('もう一度読み込む')
  })

  test('disables the download until runs are shown', () => {
    expect(render({ history: { rows: [], hasMore: false } })).toMatch(/<button[^>]*disabled=""[^>]*>CSV をダウンロード/u)
  })
})
