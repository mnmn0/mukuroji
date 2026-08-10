import { describe, expect, test } from 'bun:test'
import type { PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import {
  createProjectDirectoryAssigneeOptions,
  createProjectDirectoryRows,
} from '../src/projects/model/projectDirectoryView'
import { ProjectDirectoryView } from '../src/projects/ui/ProjectDirectoryView'
import { createTranslator } from '../src/shared/i18n/i18n'
import { referoTaskFixtures } from '../src/tasks/fixtures'

const rows = createProjectDirectoryRows(
  projectDirectoryFixtures,
  referoTaskFixtures,
  () => false,
)
const assigneeOptions = createProjectDirectoryAssigneeOptions(rows)

describe('ProjectDirectoryView', () => {
  test('shows reported health, freshness, latest updater, and next due in every Project row', () => {
    const planningUpdateTargets: readonly PlanningUpdateTargetSummary[] = [{
      target: { type: 'project', teamId: 'core-team', projectId: 'refero' },
      cadence: {
        updateOwnerMemberKey: 'demo@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC',
        nextDueAt: '2026-08-14T08:00:00.000Z',
        reminderHoursBefore: 24,
      },
      updateState: 'overdue',
      latestVersion: 3,
      latestUpdate: {
        id: 'project-directory-update-3',
        version: 3,
        health: 'on-track',
        risk: 'low',
        summary: 'Release scope is stable.',
        progressSnapshot: { percent: 78, linkedWorkItemCount: 6 },
        authorMemberKey: 'demo@example.com',
        coveredDueAt: '2026-08-07T08:00:00.000Z',
        createdAt: '2026-08-07T07:30:00.000Z',
      },
      updatedAt: '2026-08-07T07:30:00.000Z',
    }]
    const html = renderToStaticMarkup(
      <ProjectDirectoryView
        assignees={assigneeOptions.assignees}
        filteredCount={rows.length}
        filters={{ query: '', quickAccessOnly: false, status: 'all' }}
        hasUnassignedProjects={assigneeOptions.hasUnassignedProjects}
        page={1}
        pageCount={1}
        planningUpdateTargets={planningUpdateTargets}
        rows={rows}
        t={createTranslator('en')}
        teams={projectDirectoryFixtures}
        totalCount={rows.length}
        onAssigneeChange={() => undefined}
        onClearFilters={() => undefined}
        onOpenPlanningUpdate={() => undefined}
        onOpenProject={() => undefined}
        onPageChange={() => undefined}
        onQuickAccessOnlyChange={() => undefined}
        onSearchChange={() => undefined}
        onStatusChange={() => undefined}
        onTeamChange={() => undefined}
        onToggleQuickAccess={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="project-update-summary-core-team-refero"')
    expect(html).toContain('On track')
    expect(html).toContain('Overdue')
    expect(html).toContain('Release scope is stable.')
    expect(html).toContain('demo@example.com · Aug 7, 2026 at 7:30 AM')
    expect(html).toContain('Next due: Aug 14, 2026 at 8:00 AM')
  })
})
