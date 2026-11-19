import { describe, expect, test } from 'bun:test'
import type { PlanningHealth, PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectDirectoryTeam } from '../src/projects/api'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { createWorkItemSummaryFromWorkItems } from '../src/work-items/model/workItemSummary'
import { createWorkspaceSummary } from '../src/work-items/model/workspaceWorkItems'
import { DashboardWorkspaceView } from '../src/workspace/ui/DashboardWorkspaceView'

describe('DashboardWorkspaceView', () => {
  test('does not project missing Planning data as attention when loading failed', () => {
    const workItemSummary = createWorkItemSummaryFromWorkItems(
      referoTaskFixtures,
      new Date('2026-06-10T00:00:00.000Z'),
    )
    const html = renderToStaticMarkup(
      <DashboardWorkspaceView
        planningUpdatesErrorMessage="Project update status could not be loaded."
        summary={createWorkspaceSummary(projectDirectoryFixtures, workItemSummary, 0)}
        t={createTranslator('en')}
        teams={projectDirectoryFixtures}
        workItemConfigurationsByTeam={{}}
        workItemSummary={workItemSummary}
      />,
    )

    expect(html).toContain('data-testid="dashboard-update-attention"')
    expect(html).toContain('>—</span>')
    expect(html).toContain('Project update status unavailable.')
    expect(html).not.toContain('Not configured')
    expect(html).not.toContain('>Unknown</span>')
    expect(html).toContain('disabled=""')
  })

  test('lists every visible Project with off-track Projects first and hides inaccessible targets', () => {
    const teams: ProjectDirectoryTeam[] = [{
      id: 'core-team',
      name: 'Core team',
      projects: Array.from({ length: 30 }, (_, index) => ({
        id: `project-${String(index + 1).padStart(2, '0')}`,
        name: `Project ${String(index + 1).padStart(2, '0')}`,
      })),
    }]
    const html = renderToStaticMarkup(
      <DashboardWorkspaceView
        planningUpdateTargets={[
          createProjectUpdateTarget('core-team', 'project-30', 'off-track'),
          createProjectUpdateTarget('core-team', 'project-02', 'on-track'),
          createProjectUpdateTarget('hidden-team', 'hidden-project', 'off-track'),
        ]}
        summary={createWorkspaceSummary(teams, undefined, 0)}
        t={createTranslator('en')}
        teams={teams}
        workItemConfigurationsByTeam={{}}
      />,
    )

    expect(html).toContain('Showing 30 of 30 projects')
    expect(html.match(/data-testid="dashboard-update-summary-/g)).toHaveLength(30)
    expect(html.indexOf('Project 30')).toBeLessThan(html.indexOf('Project 01'))
    expect(html).not.toContain('hidden-project')
    expect(html).not.toContain('Low risk')
  })
})

/**
 * Creates a Project update projection with the given reported health.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Team-local Project ID.
 * @param health - Reported health of the latest update.
 * @returns A Planning update projection for the Project.
 */
function createProjectUpdateTarget(
  teamId: string,
  projectId: string,
  health: PlanningHealth,
): PlanningUpdateTargetSummary {
  return {
    target: { type: 'project', teamId, projectId },
    updateState: 'current',
    latestVersion: 1,
    latestUpdate: {
      id: `${projectId}-update`,
      version: 1,
      health,
      risk: 'low',
      summary: `${projectId} summary`,
      progressSnapshot: { percent: 10, linkedWorkItemCount: 1 },
      authorMemberKey: 'demo@example.com',
      coveredDueAt: '2026-08-07T08:00:00.000Z',
      createdAt: '2026-08-07T07:30:00.000Z',
    },
    updatedAt: '2026-08-07T07:30:00.000Z',
  }
}
