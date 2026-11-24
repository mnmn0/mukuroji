import { describe, expect, test } from 'bun:test'
import type { OrgStructure, PortfolioProjectMetrics, TeamPortfolioResponse } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createPortfolioOrgUnitRollup,
  resolvePortfolioOrgUnitTeamIds,
} from '../src/features/portfolio-dashboard/model/orgUnitRollup'
import { createPortfolioDashboardModel } from '../src/features/portfolio-dashboard/model/portfolioDashboard'
import { PortfolioDashboardView } from '../src/features/portfolio-dashboard/ui/PortfolioDashboardView'
import type { ProjectDirectoryTeam } from '../src/projects/api'
import {
  addOrgUnit,
  assignTeamToOrgUnit,
  listOrgUnitParentCandidates,
  listOrgUnitTreeRows,
  moveOrgUnit,
  removeOrgUnit,
  renameOrgUnit,
  type OrgStructureDraft,
} from '../src/projects/model/orgStructure'
import { OrgStructurePanel } from '../src/projects/ui/OrgStructurePanel'
import { createWorkspaceSecurityScopeOptions } from '../src/security/model/workspaceSecurityScopes'
import { createTranslator } from '../src/shared/i18n/i18n'

/** Sales with East below it, and a separate Engineering unit. */
const structure: OrgStructure = {
  orgUnits: [
    { id: 'sales', name: 'Sales' },
    { id: 'east', name: 'East', parentId: 'sales' },
    { id: 'eng', name: 'Engineering' },
  ],
  teamAssignments: [
    { teamId: 'sales-hq', orgUnitId: 'sales' },
    { teamId: 'east-team', orgUnitId: 'east' },
    { teamId: 'core', orgUnitId: 'eng' },
  ],
  revision: 3,
}

const draft: OrgStructureDraft = { orgUnits: structure.orgUnits, teamAssignments: structure.teamAssignments }

const teams: ProjectDirectoryTeam[] = [
  { id: 'sales-hq', name: 'Sales HQ', projects: [{ id: 'crm', name: 'CRM' }] },
  { id: 'east-team', name: 'East Team', projects: [{ id: 'crm', name: 'CRM' }, { id: 'east-site', name: 'East site' }] },
  { id: 'core', name: 'Core', projects: [{ id: 'platform', name: 'Platform' }] },
  { id: 'misc', name: 'Misc', projects: [{ id: 'misc-ops', name: 'Misc ops' }] },
]

/**
 * Builds Project metrics with the given Work Item counts.
 *
 * @param projectId - Project ID.
 * @param total - Work Items.
 * @param open - Open Work Items.
 * @param overdueOpen - Overdue open Work Items.
 * @returns The metrics.
 */
function metrics(projectId: string, total: number, open: number, overdueOpen = 0): PortfolioProjectMetrics {
  return {
    projectId,
    workItems: { total, open, completed: total - open, overdueOpen },
    effort: { estimatedCount: 0, plannedMinutes: 0, remainingMinutes: 0 },
    schedule: { hasBaseline: false, delayedOpenCount: 0 },
    raid: { openRisks: 0, openIssues: 0, openChangeRequests: 0 },
    costHidden: false,
  }
}

/**
 * Builds a Team portfolio response.
 *
 * @param teamId - Team ID.
 * @param projects - Project metrics.
 * @returns The response.
 */
function portfolio(teamId: string, projects: PortfolioProjectMetrics[]): TeamPortfolioResponse {
  return {
    schemaVersion: 1,
    teamId,
    generatedAt: '2026-11-24T00:00:00.000Z',
    timeZone: 'Asia/Tokyo',
    projects,
    hiddenProjectCount: 0,
    costHiddenProjectCount: 0,
    viewer: { canCaptureSnapshot: false },
  }
}

const model = createPortfolioDashboardModel({
  teams,
  reads: [
    { teamId: 'sales-hq', agentBoardFailed: false, portfolio: portfolio('sales-hq', [metrics('crm', 10, 4, 1)]) },
    { teamId: 'east-team', agentBoardFailed: false, portfolio: portfolio('east-team', [metrics('crm', 10, 4, 1), metrics('east-site', 6, 6, 2)]) },
    { teamId: 'core', agentBoardFailed: false, portfolio: portfolio('core', [metrics('platform', 20, 5)]) },
    { teamId: 'misc', agentBoardFailed: false, portfolio: portfolio('misc', [metrics('misc-ops', 3, 1)]) },
  ],
  today: '2026-11-24',
})

describe('OrgUnit structure draft', () => {
  test('lists the tree parents first and offers only parents outside the subtree', () => {
    expect(listOrgUnitTreeRows(structure.orgUnits).map((row) => `${row.depth}:${row.orgUnit.id}`)).toEqual(['0:sales', '1:east', '0:eng'])
    expect(listOrgUnitParentCandidates(structure.orgUnits, 'sales').map((orgUnit) => orgUnit.id)).toEqual(['eng'])
  })

  test('refuses a move into its own subtree and moves elsewhere', () => {
    expect(moveOrgUnit(draft, 'sales', 'east')).toBe(draft)
    const moved = moveOrgUnit(draft, 'east', undefined)
    expect(moved.orgUnits.find((orgUnit) => orgUnit.id === 'east')).toEqual({ id: 'east', name: 'East' })
    expect(moveOrgUnit(draft, 'eng', 'sales').orgUnits.find((orgUnit) => orgUnit.id === 'eng')?.parentId).toBe('sales')
  })

  test('removing an OrgUnit hands its children and Teams to its parent', () => {
    const removedChild = removeOrgUnit(draft, 'east')
    expect(removedChild.teamAssignments).toContainEqual({ teamId: 'east-team', orgUnitId: 'sales' })
    const removedTop = removeOrgUnit(draft, 'sales')
    expect(removedTop.orgUnits.find((orgUnit) => orgUnit.id === 'east')).toEqual({ id: 'east', name: 'East' })
    expect(removedTop.teamAssignments.some((assignment) => assignment.teamId === 'sales-hq')).toBe(false)
  })

  test('adds, renames, and reassigns', () => {
    const added = addOrgUnit(draft, { id: 'west', name: 'West', parentId: 'sales' })
    expect(renameOrgUnit(added, 'west', 'West 2').orgUnits.at(-1)?.name).toBe('West 2')
    const assigned = assignTeamToOrgUnit(added, 'core', 'west')
    expect(assigned.teamAssignments.filter((assignment) => assignment.teamId === 'core')).toEqual([{ teamId: 'core', orgUnitId: 'west' }])
    expect(assignTeamToOrgUnit(assigned, 'core', undefined).teamAssignments.some((assignment) => assignment.teamId === 'core')).toBe(false)
  })

  test('renders the editor with the Teams and their OrgUnits', () => {
    const html = renderToStaticMarkup(
      <OrgStructurePanel isSaving={false} structure={structure} t={createTranslator('en')} teams={teams} onSave={async () => true} />,
    )
    expect(html).toContain('data-testid="org-structure-units"')
    expect(html).toContain('Remove East')
    expect(html).toContain('Sales HQ')
  })
})

describe('OrgUnit portfolio roll-up', () => {
  test('sums descendants and counts a shared Project once', () => {
    const rollup = createPortfolioOrgUnitRollup(model.rows, teams.map((team) => team.id), structure)
    const sales = rollup.rows.find((row) => row.orgUnitId === 'sales')
    expect(sales).toMatchObject({ depth: 0, teamCount: 2, projectCount: 2, workItems: { total: 16, open: 10, completed: 6, overdueOpen: 3 } })
    expect(rollup.rows.find((row) => row.orgUnitId === 'east')).toMatchObject({ depth: 1, teamCount: 1, projectCount: 2 })
    expect(rollup.rows.find((row) => row.orgUnitId === 'eng')).toMatchObject({ teamCount: 1, workItems: { total: 20 } })
    expect(rollup.unassigned).toMatchObject({ teamCount: 1, projectCount: 1, workItems: { total: 3 } })
  })

  test('a Workspace without OrgUnits has no roll-up and no OrgUnit filter', () => {
    const empty = { orgUnits: [], teamAssignments: [] }
    expect(createPortfolioOrgUnitRollup(model.rows, teams.map((team) => team.id), empty)).toEqual({ rows: [] })
    expect(resolvePortfolioOrgUnitTeamIds(empty, 'sales')).toBeUndefined()
    const html = renderToStaticMarkup(
      <PortfolioDashboardView
        canSaveSnapshot={false}
        compareMonthOptions={[]}
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
    expect(html).not.toContain('portfolio-org-units')
    expect(html).not.toContain('portfolio-filter-org-unit')
  })

  test('narrows to the Teams of an OrgUnit and its descendants', () => {
    expect([...(resolvePortfolioOrgUnitTeamIds(structure, 'sales') ?? [])]).toEqual(['sales-hq', 'east-team'])
    expect(resolvePortfolioOrgUnitTeamIds(structure, 'all')).toBeUndefined()
    const html = renderToStaticMarkup(
      <PortfolioDashboardView
        canSaveSnapshot={false}
        compareMonthOptions={[]}
        isPlanningUnavailable={false}
        isSavingSnapshot={false}
        locale="ja"
        model={model}
        orgStructure={structure}
        showAgentRuns={false}
        t={createTranslator('ja')}
        teams={teams}
        onCompareMonthChange={() => undefined}
        onOpenProject={() => undefined}
        onRetry={() => undefined}
        onSaveSnapshot={() => undefined}
      />,
    )
    expect(html).toContain('data-testid="portfolio-org-units"')
    expect(html).toContain('data-testid="portfolio-filter-org-unit"')
    expect(html).toContain('所属なし')
  })
})

test('offers OrgUnits as security scopes named by their path', () => {
  const options = createWorkspaceSecurityScopeOptions(teams, 'Workspace', structure.orgUnits)
  expect(options.filter((option) => option.type === 'org-unit').map((option) => option.name)).toEqual(['Sales', 'Sales / East', 'Engineering'])
  expect(createWorkspaceSecurityScopeOptions(teams, 'Workspace').some((option) => option.type === 'org-unit')).toBe(false)
})
