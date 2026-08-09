import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSidebarLabels } from '../src/shared/i18n/i18n'
import { Sidebar } from '../src/shared/ui/sidebar/Sidebar'
import type {
  SidebarQuickAccessProject,
  SidebarProjectTone,
  SidebarTeam,
} from '../src/shared/ui/sidebar/Sidebar'

const defaultProjectTone: SidebarProjectTone = 'blue'

/** Creates the twenty-by-twenty directory required by the sidebar acceptance fixture. */
function createLargeDirectory(): SidebarTeam[] {
  return Array.from({ length: 20 }, (_, teamIndex) => ({
    id: `team-${teamIndex + 1}`,
    name: `Team ${String(teamIndex + 1).padStart(2, '0')}`,
    projects: Array.from({ length: 20 }, (_, projectIndex) => ({
      id: `project-${teamIndex + 1}-${projectIndex + 1}`,
      name: `Project ${teamIndex + 1}.${projectIndex + 1}`,
      tone: defaultProjectTone,
    })),
  }))
}

/** Creates ordered Quick Access entries from the first eight Projects. */
function createQuickAccessProjects(teams: SidebarTeam[]): SidebarQuickAccessProject[] {
  const team = teams[0]
  if (!team) return []

  return (team.projects ?? []).slice(0, 8).map((project) => ({
    name: project.name,
    projectId: project.id,
    teamId: team.id,
    teamName: team.name,
    tone: project.tone,
  }))
}

describe('Sidebar information architecture', () => {
  test('shows only five Quick Access entries and only the current Team hierarchy', () => {
    const teams = createLargeDirectory()
    const labels = createSidebarLabels('en')
    const html = renderToStaticMarkup(
      <Sidebar
        defaultActiveTeamId="team-1"
        labels={labels}
        quickAccessProjects={createQuickAccessProjects(teams)}
        teams={teams}
        onShowAllQuickAccess={() => undefined}
      />,
    )

    expect(html).toContain(labels.quickAccess)
    expect(html).toContain('Project 1.5')
    expect(html).not.toContain('Project 1.6')
    expect(html).toContain(labels.showAllQuickAccess)
    expect(html).toContain('Team 01')
    expect(html).not.toContain('Team 20')
    expect(html).toContain(labels.projectCount(20))
    expect(html).toContain(labels.triage)
    expect(html).not.toContain('Project 2.20')
  })

  test('renders accessible ordering and removal controls in the manager', () => {
    const teams = createLargeDirectory()
    const labels = createSidebarLabels('en')
    const html = renderToStaticMarkup(
      <Sidebar
        defaultActiveTeamId="team-1"
        defaultQuickAccessManagerOpen
        labels={labels}
        quickAccessProjects={createQuickAccessProjects(teams).slice(0, 2)}
        teams={teams}
        onMoveQuickAccessProject={() => undefined}
        onRemoveQuickAccessProject={() => undefined}
      />,
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain(`${labels.moveQuickAccessUp}: Project 1.1`)
    expect(html).toContain(`${labels.moveQuickAccessDown}: Project 1.1`)
    expect(html).toContain(`${labels.removeQuickAccess}: Project 1.1`)
    expect(html).toContain('Team 01')
  })

  test('keeps meaningful accessible labels when collapsed', () => {
    const teams = createLargeDirectory()
    const labels = createSidebarLabels('en')
    const html = renderToStaticMarkup(
      <Sidebar
        defaultActiveTeamId="team-1"
        defaultCollapsed
        labels={labels}
        quickAccessProjects={createQuickAccessProjects(teams).slice(0, 1)}
        teams={teams}
      />,
    )

    expect(html).toContain(`aria-label="${labels.expand}"`)
    expect(html).toContain(`aria-label="${labels.switchTeam}: Team 01"`)
    expect(html).toContain('Project 1.1')
  })

})
