import { expect, test } from 'bun:test'
import { parsePortfolioProjectMetrics } from '../src/portfolio-dashboard'

/** A consistent Project row. */
const row = {
  projectId: 'alpha',
  workItems: { total: 3, open: 2, completed: 1, overdueOpen: 1 },
  effort: { estimatedCount: 0, plannedMinutes: 0, remainingMinutes: 0 },
  schedule: { hasBaseline: false, delayedOpenCount: 0 },
  raid: { openRisks: 0, openIssues: 0, openChangeRequests: 0 },
  costHidden: false,
}

test('rejects Work Item counts that do not add up', () => {
  expect(parsePortfolioProjectMetrics(row)).toBeDefined()
  expect(parsePortfolioProjectMetrics({ ...row, workItems: { total: 2, open: 1, completed: 3, overdueOpen: 0 } })).toBeUndefined()
  expect(parsePortfolioProjectMetrics({ ...row, workItems: { total: 3, open: 2, completed: 1, overdueOpen: 3 } })).toBeUndefined()
})

test('accepts only calendar dates for the next milestone', () => {
  const withDue = (dueDate: string) => ({ ...row, nextMilestone: { workItemId: 'm', key: 'A-1', title: 'M', dueDate } })
  expect(parsePortfolioProjectMetrics(withDue('2026-02-28'))).toBeDefined()
  expect(parsePortfolioProjectMetrics(withDue('2028-02-29'))).toBeDefined()
  expect(parsePortfolioProjectMetrics(withDue('2026-02-30'))).toBeUndefined()
})
