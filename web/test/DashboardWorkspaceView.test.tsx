import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
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
    expect(html).not.toContain('Unknown')
  })
})
