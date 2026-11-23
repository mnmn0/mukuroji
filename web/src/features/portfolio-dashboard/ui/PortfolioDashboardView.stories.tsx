import type { Meta, StoryObj } from '@storybook/react-vite'
import type { PortfolioProjectMetrics, TeamPortfolioResponse } from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../../projects/api'
import { createTranslator } from '../../../shared/i18n/i18n'
import { createPortfolioDashboardModel } from '../model/portfolioDashboard'
import { PortfolioDashboardView } from './PortfolioDashboardView'

/**
 * Builds Project metrics for the stories.
 *
 * @param projectId - Project ID.
 * @param overrides - Fields that differ from an on-schedule Project without a budget.
 * @returns The metrics.
 */
function metrics(projectId: string, overrides: Partial<PortfolioProjectMetrics> = {}): PortfolioProjectMetrics {
  return {
    projectId,
    workItems: { total: 24, open: 12, completed: 12, overdueOpen: 0 },
    effort: { estimatedCount: 20, plannedMinutes: 9_600, remainingMinutes: 4_200 },
    schedule: { hasBaseline: true, delayedOpenCount: 0 },
    raid: { openRisks: 0, openIssues: 0, openChangeRequests: 0 },
    costHidden: false,
    ...overrides,
  }
}

/**
 * Builds a Team portfolio for the stories.
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
  {
    id: 'core',
    name: '基盤チーム',
    projects: [
      { id: 'billing', name: '請求基盤の刷新', charter: { owner: { userId: 'u1', displayName: '佐藤 花子' } } },
      { id: 'portal', name: '顧客ポータル', lifecycleState: 'on-hold' },
    ],
  },
  { id: 'apps', name: 'アプリチーム', projects: [{ id: 'mobile', name: 'モバイルアプリ' }] },
]

const model = createPortfolioDashboardModel({
  teams,
  reads: [
    {
      teamId: 'core',
      agentBoardFailed: false,
      portfolio: portfolio('core', [
        metrics('billing', {
          workItems: { total: 40, open: 22, completed: 18, overdueOpen: 3 },
          schedule: { hasBaseline: true, delayedOpenCount: 4, maxDelayDays: 6 },
          nextMilestone: { workItemId: 'm1', key: 'BIL-12', title: '結合テスト完了', dueDate: '2026-12-04' },
          raid: { openRisks: 3, openIssues: 1, openChangeRequests: 1, highestOpenSeverity: 'critical' },
          budget: { amountMinor: 12_000_000, currency: 'JPY', periodFrom: '2026-10-01', periodTo: '2027-01-31', actualCostMinor: 9_400_000, hasOtherCurrencyCost: false },
        }),
        metrics('portal', { costHidden: true, schedule: { hasBaseline: false, delayedOpenCount: 0 } }),
      ], 2),
    },
    {
      teamId: 'apps',
      agentBoardFailed: false,
      portfolio: portfolio('apps', [
        metrics('mobile', {
          nextMilestone: { workItemId: 'm2', title: 'ストア申請', dueDate: '2026-12-20' },
          raid: { openRisks: 1, openIssues: 0, openChangeRequests: 0, highestOpenSeverity: 'medium' },
          budget: { amountMinor: 5_000_000, currency: 'JPY', periodFrom: '2026-09-01', periodTo: '2027-03-31', actualCostMinor: 2_100_000, hasOtherCurrencyCost: false },
        }),
      ]),
    },
  ],
  snapshots: [{
    teamId: 'core',
    failed: false,
    snapshot: {
      schemaVersion: 1,
      teamId: 'core',
      month: '2026-10',
      capturedAt: '2026-10-31T00:00:00.000Z',
      projects: [metrics('billing', {
        workItems: { total: 38, open: 28, completed: 10, overdueOpen: 1 },
        schedule: { hasBaseline: true, delayedOpenCount: 1, maxDelayDays: 2 },
        raid: { openRisks: 2, openIssues: 0, openChangeRequests: 0, highestOpenSeverity: 'high' },
        budget: { amountMinor: 12_000_000, currency: 'JPY', periodFrom: '2026-10-01', periodTo: '2027-01-31', actualCostMinor: 5_000_000, hasOtherCurrencyCost: false },
      })],
      hiddenProjectCount: 0,
      costHiddenProjectCount: 0,
    },
  }],
  today: '2026-11-23',
})

const meta = {
  title: 'Workspace/PortfolioDashboardView',
  component: PortfolioDashboardView,
  args: {
    canSaveSnapshot: true,
    compareMonth: '2026-10',
    compareMonthOptions: ['2026-11', '2026-10', '2026-09'],
    isPlanningUnavailable: false,
    isSavingSnapshot: false,
    locale: 'ja',
    model,
    showAgentRuns: false,
    t: createTranslator('ja'),
    teams,
    onCompareMonthChange: () => undefined,
    onOpenProject: () => undefined,
    onRetry: () => undefined,
    onSaveSnapshot: () => undefined,
  },
} satisfies Meta<typeof PortfolioDashboardView>

export default meta

/** Story shape for the portfolio dashboard view. */
type Story = StoryObj<typeof meta>

/** Projects of two Teams compared with last month, with hidden Projects and costs. */
export const Default: Story = {}

/** The same dashboard in English. */
export const English: Story = {
  args: { locale: 'en', t: createTranslator('en') },
}
