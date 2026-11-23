import { describe, expect, test } from 'bun:test'
import type { PortfolioProjectMetrics, TeamPortfolioResponse } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  arrangePortfolioDashboardRows,
  createPortfolioDashboardCsv,
  createPortfolioDashboardModel,
  evaluatePortfolioDashboardAttention,
  listPortfolioDashboardErrors,
} from '../src/features/portfolio-dashboard/model/portfolioDashboard'
import { isPortfolioSnapshotsKeyOfMonth } from '../src/features/portfolio-dashboard/queries/usePortfolioDashboard'
import { PortfolioDashboardView } from '../src/features/portfolio-dashboard/ui/PortfolioDashboardView'
import type { ProjectDirectoryTeam } from '../src/projects/api'
import { createTranslator } from '../src/shared/i18n/i18n'

/**
 * Builds Project metrics.
 *
 * @param projectId - Project ID.
 * @param overrides - Fields that differ from an on-schedule Project without a budget.
 * @returns The metrics.
 */
function metrics(projectId: string, overrides: Partial<PortfolioProjectMetrics> = {}): PortfolioProjectMetrics {
  return {
    projectId,
    workItems: { total: 10, open: 5, completed: 5, overdueOpen: 0 },
    effort: { estimatedCount: 2, plannedMinutes: 600, remainingMinutes: 300 },
    schedule: { hasBaseline: true, delayedOpenCount: 0 },
    raid: { openRisks: 0, openIssues: 0, openChangeRequests: 0 },
    costHidden: false,
    ...overrides,
  }
}

/**
 * Builds a Team portfolio response.
 *
 * @param teamId - Team ID.
 * @param projects - Rows.
 * @param hiddenProjectCount - Projects the reader cannot read.
 * @returns The response.
 */
function portfolio(teamId: string, projects: PortfolioProjectMetrics[], hiddenProjectCount = 0): TeamPortfolioResponse {
  return {
    schemaVersion: 1,
    teamId,
    generatedAt: '2026-11-23T00:00:00.000Z',
    timeZone: 'Asia/Tokyo',
    projects,
    hiddenProjectCount,
    costHiddenProjectCount: projects.filter((project) => project.costHidden).length,
    viewer: { canCaptureSnapshot: true },
  }
}

const teams: ProjectDirectoryTeam[] = [
  { id: 'core', name: 'Core', projects: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta', lifecycleState: 'on-hold' }] },
  { id: 'ops', name: 'Ops', projects: [] },
]

const model = createPortfolioDashboardModel({
  teams,
  reads: [
    {
      teamId: 'core',
      agentBoardFailed: false,
      portfolio: portfolio('core', [
        metrics('alpha', {
          schedule: { hasBaseline: true, delayedOpenCount: 2, maxDelayDays: 5 },
          budget: { amountMinor: 1_000_000, currency: 'JPY', periodFrom: '2026-11-01', periodTo: '2026-11-30', actualCostMinor: 950_000, hasOtherCurrencyCost: false },
          raid: { openRisks: 2, openIssues: 1, openChangeRequests: 0, highestOpenSeverity: 'high' },
        }),
        metrics('beta', { costHidden: true }),
      ], 3),
    },
    { teamId: 'ops', agentBoardFailed: false, error: Object.assign(new Error('x'), { status: 413 }) },
  ],
  snapshots: [{
    teamId: 'core',
    failed: false,
    snapshot: {
      schemaVersion: 1,
      teamId: 'core',
      month: '2026-10',
      capturedAt: '2026-10-31T00:00:00.000Z',
      projects: [metrics('alpha', { workItems: { total: 10, open: 8, completed: 2, overdueOpen: 0 } })],
      hiddenProjectCount: 0,
      costHiddenProjectCount: 0,
    },
  }],
  today: '2026-11-23',
})

describe('createPortfolioDashboardModel', () => {
  test('joins reads with the directory, counts hidden Projects, and compares with the snapshot', () => {
    expect(model.rows.map((row) => row.key)).toEqual(['core/alpha', 'core/beta'])
    expect(model.hiddenProjectCount).toBe(3)
    expect(model.costHiddenProjectCount).toBe(1)
    expect(model.tooLargeTeamNames).toEqual(['Ops'])
    const [alpha, beta] = model.rows
    expect(alpha).toMatchObject({ countProgress: 50, effortProgress: 50, budgetConsumption: 95, delta: { progress: 30, delay: 5, risks: 3 } })
    expect(alpha?.budgetForecast).toBeGreaterThan(100)
    expect(beta).toMatchObject({ projectName: 'Beta', lifecycleState: 'on-hold' })
    expect(beta?.budgetConsumption).toBeUndefined()
  })

  test('highlights, filters, and sorts by the thresholds', () => {
    const thresholds = { budgetPercent: 90, delayDays: 3 }
    const [alpha, beta] = model.rows
    if (!alpha || !beta) throw new Error('Rows are missing.')
    expect(evaluatePortfolioDashboardAttention(alpha, thresholds)).toEqual({ budget: true, delay: true })
    expect(evaluatePortfolioDashboardAttention(beta, thresholds)).toEqual({ budget: false, delay: false })
    const filters = { teamId: 'all', lifecycle: 'all' as const, health: 'all' as const, portfolioId: 'all', attentionOnly: true }
    expect(arrangePortfolioDashboardRows(model.rows, filters, thresholds, { key: 'project', descending: false }).map((row) => row.projectId)).toEqual(['alpha'])
    expect(arrangePortfolioDashboardRows(model.rows, { ...filters, attentionOnly: false }, thresholds, { key: 'budget', descending: true }).map((row) => row.projectId)).toEqual(['alpha', 'beta'])
  })

  test('exports CSV without costs the reader may not see and neutralizes formulas', () => {
    const rows = [...model.rows]
    const [first] = rows
    if (first) rows[0] = { ...first, projectName: '=HYPERLINK("x")' }
    const csv = createPortfolioDashboardCsv(rows, (column) => column, (_kind, value) => value)
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('"\'=HYPERLINK(""x"")"')
    expect(lines[1]).toContain('"1000000","JPY","950000"')
    expect(lines[2]).toContain('"Beta"')
    expect(lines[2]).toContain(',,,')
  })
})

describe('PortfolioDashboardView', () => {
  test('renders hidden counts, highlights, and cost cells the reader may not see', () => {
    const html = renderToStaticMarkup(
      <PortfolioDashboardView
        canSaveSnapshot
        compareMonth="2026-10"
        compareMonthOptions={['2026-11', '2026-10']}
        isPlanningUnavailable={false}
        isSavingSnapshot={false}
        locale="en"
        model={model}
        showAgentRuns={false}
        t={createTranslator('en')}
        teams={teams}
        onCompareMonthChange={() => undefined}
        onOpenProject={() => undefined}
        onRetry={() => undefined}
        onSaveSnapshot={() => undefined}
      />,
    )
    expect(html).toContain('3 Projects you cannot view are not shown.')
    expect(html).toContain('1 Projects have a budget and cost you cannot view.')
    expect(html).toContain('These Teams have too many Projects to list: Ops')
    expect(html).toContain('data-attention="budget"')
    expect(html).toContain('data-attention="delay"')
    expect(html).toContain('No access')
    expect(html).toContain('data-testid="portfolio-save-snapshot"')
    expect(html).toContain('+30pt since then')
    expect(html).toContain('data-testid="portfolio-retry"')
  })
})

describe('listPortfolioDashboardErrors', () => {
  test('keeps every Team read failure so an expired session reaches the Workspace shell', () => {
    const expired = { status: 401, code: 'EnterpriseSessionExpired' }
    const boardDenied = { status: 403, code: 'EnterpriseSessionIpDenied' }
    const snapshotFailure = { status: 502 }
    expect(listPortfolioDashboardErrors(
      [
        { teamId: 'a', error: expired, agentBoardFailed: false },
        { teamId: 'b', agentBoardFailed: true, agentBoardError: boardDenied },
        { teamId: 'c', agentBoardFailed: false },
      ],
      [{ teamId: 'a', failed: true, error: snapshotFailure }, { teamId: 'b', snapshot: null, failed: false }],
    )).toEqual([expired, boardDenied, snapshotFailure])
  })
})

test('matches the saved snapshot reads of a month whichever month the page compares', () => {
  expect(isPortfolioSnapshotsKeyOfMonth(['portfolio-snapshots', 'token', 'a\nb', '2026-11'], '2026-11')).toBe(true)
  expect(isPortfolioSnapshotsKeyOfMonth(['portfolio-snapshots', 'token', 'a\nb', '2026-10'], '2026-11')).toBe(false)
  expect(isPortfolioSnapshotsKeyOfMonth(['portfolio-team', 'token', 'a', '2026-11'], '2026-11')).toBe(false)
  expect(isPortfolioSnapshotsKeyOfMonth('portfolio-snapshots', '2026-11')).toBe(false)
})
