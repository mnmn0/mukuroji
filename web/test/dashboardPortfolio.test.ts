import { describe, expect, test } from 'bun:test'
import type { PlanningHealth, PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import type { WorkspacePortfolioProject } from '../src/work-items/model/workspaceWorkItems'
import {
  arrangeDashboardPortfolioRows,
  createDashboardPortfolioRows,
  isDashboardPortfolioHealthFilter,
  isDashboardPortfolioSort,
  needsDashboardReportingAttention,
} from '../src/workspace/model/dashboardPortfolio'

/**
 * Creates a directory-backed portfolio Project row.
 *
 * @param projectId - Team-local Project ID, also used as the name.
 * @param progress - Completion percentage.
 * @param teamId - Owning Team ID.
 * @returns A portfolio Project row.
 */
function createProject(projectId: string, progress: number, teamId = 'core-team'): WorkspacePortfolioProject {
  return {
    id: `${teamId}-${projectId}`,
    name: projectId,
    progress,
    projectId,
    teamId,
    teamName: teamId,
  }
}

/**
 * Creates a Project update projection.
 *
 * @param projectId - Team-local Project ID.
 * @param health - Reported health.
 * @param createdAt - Creation instant of the latest update.
 * @param teamId - Owning Team ID.
 * @returns A Planning update projection.
 */
function createTarget(
  projectId: string,
  health: PlanningHealth,
  createdAt: string,
  teamId = 'core-team',
): PlanningUpdateTargetSummary {
  return {
    target: { type: 'project', teamId, projectId },
    updateState: 'current',
    latestVersion: 1,
    latestUpdate: {
      id: `${projectId}-update`,
      version: 1,
      health,
      risk: 'none',
      summary: projectId,
      progressSnapshot: { percent: 0, linkedWorkItemCount: 0 },
      authorMemberKey: 'demo@example.com',
      coveredDueAt: createdAt,
      createdAt,
    },
    updatedAt: createdAt,
  }
}

const projects = [
  createProject('alpha', 80),
  createProject('bravo', 20),
  createProject('charlie', 50),
  createProject('delta', 0),
]
const targets = [
  createTarget('alpha', 'on-track', '2026-08-03T00:00:00.000Z'),
  createTarget('bravo', 'off-track', '2026-08-01T00:00:00.000Z'),
  createTarget('charlie', 'at-risk', '2026-08-05T00:00:00.000Z'),
  createTarget('charlie', 'off-track', '2026-08-06T00:00:00.000Z', 'other-team'),
]

describe('dashboard portfolio rows', () => {
  test('uses reported health and joins targets by Team and Project', () => {
    const rows = createDashboardPortfolioRows(projects, targets, false)

    expect(rows.map((row) => [row.project.projectId, row.health, row.updateState])).toEqual([
      ['alpha', 'on-track', 'current'],
      ['bravo', 'off-track', 'current'],
      ['charlie', 'at-risk', 'current'],
      ['delta', 'unknown', 'not-configured'],
    ])
    expect(rows.filter(needsDashboardReportingAttention).map((row) => row.project.projectId)).toEqual(['delta'])
  })

  test('ignores Planning projections when they could not be loaded', () => {
    const rows = createDashboardPortfolioRows(projects, targets, true)

    expect(rows.every((row) => row.health === 'unknown' && row.updateTarget === undefined)).toBe(true)
  })

  test('sorts by health, update recency, and progress', () => {
    const rows = createDashboardPortfolioRows(projects, targets, false)
    const order = (sort: Parameters<typeof arrangeDashboardPortfolioRows>[1]) =>
      arrangeDashboardPortfolioRows(rows, sort, 'all').map((row) => row.project.projectId)

    expect(order('directory')).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    expect(order('health')).toEqual(['bravo', 'charlie', 'delta', 'alpha'])
    expect(order('update-oldest')).toEqual(['delta', 'bravo', 'alpha', 'charlie'])
    expect(order('update-newest')).toEqual(['charlie', 'alpha', 'bravo', 'delta'])
    expect(order('progress-ascending')).toEqual(['delta', 'bravo', 'charlie', 'alpha'])
    expect(order('progress-descending')).toEqual(['alpha', 'charlie', 'bravo', 'delta'])
    expect(rows.map((row) => row.project.projectId)).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
  })

  test('filters by reported health', () => {
    const rows = createDashboardPortfolioRows(projects, targets, false)

    expect(arrangeDashboardPortfolioRows(rows, 'directory', 'off-track').map((row) => row.project.projectId))
      .toEqual(['bravo'])
    expect(arrangeDashboardPortfolioRows(rows, 'directory', 'unknown').map((row) => row.project.projectId))
      .toEqual(['delta'])
  })

  test('accepts only supported select values', () => {
    expect(isDashboardPortfolioSort('health')).toBe(true)
    expect(isDashboardPortfolioSort('risk')).toBe(false)
    expect(isDashboardPortfolioHealthFilter('off-track')).toBe(true)
    expect(isDashboardPortfolioHealthFilter('blocked')).toBe(false)
  })
})
