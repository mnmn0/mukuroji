import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS,
  resolveAnalyticsGroupLabel,
  type WorkspaceWorkPhaseSettings,
} from '@mukuroji/contracts'
import { createAnalyticsDisplayNames, createAnalyticsGroupLabelLookup } from '../src/analytics/model/groupLabels'
import { factoryAnalyticsWithUsageFixture } from '../src/features/factory-board/fixtures'
import { FactoryAnalyticsSummary } from '../src/features/factory-board/ui/FactoryAnalyticsSummary'
import { createFactoryAnalyticsLabels } from '../src/features/factory-board/ui/factoryBoardLabels'
import { createTranslator } from '../src/shared/i18n/i18n'
import { getTeamFactoryAnalytics } from '../src/work-items/api/agentRuns'
import {
  addWorkPhase,
  hasWorkPhaseProblem,
  readWorkPhaseDisplayName,
  setWorkCategoryPhase,
} from '../src/workspace/model/workPhases'

const ja = createTranslator('ja')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with one that returns a JSON body.
 *
 * @param body - Response body.
 */
function respondWith(body: unknown) {
  globalThis.fetch = Object.assign(
    async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    { preconnect: originalFetch.preconnect },
  )
}

const settings: WorkspaceWorkPhaseSettings = {
  phases: [
    { key: 'requirements', label: '要求分析', active: true },
    { key: 'implementation', active: true },
    { key: 'custom-qa', label: '受入', active: false },
  ],
  categoryPhases: { implementation: 'implementation' },
}

test('names phases by the Workspace name, the built-in name, or the key', () => {
  expect(readWorkPhaseDisplayName('requirements', settings, ja)).toBe('要求分析')
  expect(readWorkPhaseDisplayName('implementation', settings, ja)).toBe(ja('workspace.workPhase.implementation'))
  expect(readWorkPhaseDisplayName('no-phase', settings, ja)).toBe(ja('workspace.workPhase.none'))
  expect(readWorkPhaseDisplayName('custom-gone', settings, ja)).toBe('custom-gone')
})

test('adds a phase, maps a category, and reports settings the server would refuse', () => {
  const added = addWorkPhase(settings, ' 運用 ')
  expect(added.phases).toHaveLength(4)
  expect(added.phases.at(-1)).toMatchObject({ label: '運用', active: true })
  expect(added.phases.at(-1)?.key).toStartWith('custom-')
  expect(addWorkPhase(settings, '   ')).toBe(settings)

  expect(setWorkCategoryPhase(settings, 'meeting', 'requirements').categoryPhases).toEqual({
    implementation: 'implementation',
    meeting: 'requirements',
  })
  expect(setWorkCategoryPhase(settings, 'implementation', '').categoryPhases).toEqual({})

  expect(hasWorkPhaseProblem(DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS)).toBe(false)
  expect(hasWorkPhaseProblem({ ...settings, categoryPhases: { meeting: 'custom-unknown' } })).toBe(true)
})

test('translates phase groups the server left unnamed in Analytics', () => {
  const lookup = createAnalyticsGroupLabelLookup(createAnalyticsDisplayNames([], []), ja)
  const groupBy = { dimension: 'phase' } as const
  expect(resolveAnalyticsGroupLabel(groupBy, { key: 'review', label: 'review' }, lookup)).toBe(ja('workspace.workPhase.review'))
  expect(resolveAnalyticsGroupLabel(groupBy, { key: 'review', label: '検収' }, lookup)).toBe('検収')
})

test('reads phase usage and pull request intervals, and shows both', async () => {
  respondWith(factoryAnalyticsWithUsageFixture)
  const analytics = await getTeamFactoryAnalytics('token', 'core', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' })
  expect(analytics).toEqual(factoryAnalyticsWithUsageFixture)

  respondWith({ ...factoryAnalyticsWithUsageFixture, pullRequestLeadTimes: [{ interval: 'unknown', medianHours: 1, sampleSize: 1 }] })
  await expect(getTeamFactoryAnalytics('token', 'core', { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' })).rejects.toThrow()

  const markup = renderToStaticMarkup(
    <FactoryAnalyticsSummary
      analytics={factoryAnalyticsWithUsageFixture}
      formatNumber={(value) => String(value)}
      isLoading={false}
      labels={createFactoryAnalyticsLabels('ja')}
      onPeriodDaysChange={() => undefined}
      onRetry={() => undefined}
      periodDays={30}
    />,
  )
  expect(markup).toContain('data-testid="factory-analytics-usage-phases"')
  expect(markup).toContain(ja('workspace.workPhase.implementation'))
  expect(markup).toContain(ja('workspace.workPhase.none'))
  expect(markup).toContain('data-testid="factory-analytics-pull-requests"')
  expect(markup).toContain('作成から最初のレビュー')
})
