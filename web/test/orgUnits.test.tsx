import { afterEach, describe, expect, test } from 'bun:test'
import type { OrgStructure, PortfolioProjectMetrics, TeamPortfolioResponse } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createPortfolioOrgUnitRollup,
  resolvePortfolioOrgUnitTeamIds,
} from '../src/features/portfolio-dashboard/model/orgUnitRollup'
import {
  createPortfolioDashboardModel,
  type PortfolioDashboardRow,
} from '../src/features/portfolio-dashboard/model/portfolioDashboard'
import { PortfolioDashboardView } from '../src/features/portfolio-dashboard/ui/PortfolioDashboardView'
import type { ProjectDirectoryTeam } from '../src/projects/api'
import { ProjectDirectoryApiError } from '../src/projects/api/errors'
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
import { readOrgStructureForDisplay } from '../src/projects/queries/useOrgStructure'
import { OrgStructurePanel } from '../src/projects/ui/OrgStructurePanel'
import { OrgUnitScopesUnavailableNotice } from '../src/security/ui/OrgUnitScopesUnavailableNotice'
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

  test('locks every editing control while a save is in flight', () => {
    /**
     * Lists the opening tags of the panel's form controls.
     *
     * @param html - Rendered panel.
     * @returns Each input, select, and button tag.
     */
    const controls = (html: string) => html.match(/<(input|select|button)\b[^>]*>/g) ?? []
    const render = (isSaving: boolean) => renderToStaticMarkup(
      <OrgStructurePanel isSaving={isSaving} structure={structure} t={createTranslator('en')} teams={teams} onSave={async () => true} />,
    )

    const saving = controls(render(true))
    // Add form (name, parent, add), three OrgUnits (name, parent, remove), three Teams, and save.
    expect(saving).toHaveLength(3 + 3 * 3 + teams.length + 1)
    expect(saving.filter((tag) => !/\sdisabled=""/.test(tag))).toEqual([])
    expect(render(true)).toContain('aria-busy="true"')

    const idle = controls(render(false))
    // Idle, only the empty add form and the unchanged save stay disabled.
    expect(idle.filter((tag) => /\sdisabled=""/.test(tag))).toHaveLength(2)
  })
})

describe('OrgUnit portfolio roll-up', () => {
  test('sums descendants, counting a shared Project once but every Team share of its Work Items', () => {
    const rollup = createPortfolioOrgUnitRollup(model.rows, teams.map((team) => team.id), structure)
    const sales = rollup.rows.find((row) => row.orgUnitId === 'sales')
    // CRM appears in both Sales HQ and East Team; each Team reports only its own Work Items.
    expect(sales).toMatchObject({ depth: 0, teamCount: 2, projectCount: 2, workItems: { total: 26, open: 14, completed: 12, overdueOpen: 4 } })
    expect(rollup.rows.find((row) => row.orgUnitId === 'east')).toMatchObject({ depth: 1, teamCount: 1, projectCount: 2, workItems: { total: 16 } })
    expect(rollup.rows.find((row) => row.orgUnitId === 'eng')).toMatchObject({ teamCount: 1, workItems: { total: 20 } })
    expect(rollup.unassigned).toMatchObject({ teamCount: 1, projectCount: 1, workItems: { total: 3 } })
  })

  test('counts a shared Project as off track when any of its Teams reports it off track', () => {
    const rows = model.rows.map((row): PortfolioDashboardRow => {
      if (row.projectId !== 'crm') return row
      return { ...row, health: row.teamId === 'east-team' ? 'off-track' : 'on-track' }
    })
    const rollup = createPortfolioOrgUnitRollup(rows, teams.map((team) => team.id), structure)
    expect(rollup.rows.find((row) => row.orgUnitId === 'sales')).toMatchObject({ projectCount: 2, offTrackCount: 1 })
    // Sales HQ alone reports CRM on track, so the roll-up of only its Teams has nothing off track.
    const salesHqOnly = { ...structure, teamAssignments: structure.teamAssignments.filter((assignment) => assignment.teamId !== 'east-team') }
    expect(createPortfolioOrgUnitRollup(rows, teams.map((team) => team.id), salesHqOnly).rows.find((row) => row.orgUnitId === 'sales'))
      .toMatchObject({ projectCount: 1, offTrackCount: 0 })
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

describe('OrgUnit structure read failures', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /**
   * Replaces fetch with one that answers every request with a status and JSON body.
   *
   * @param status - HTTP status.
   * @param body - JSON body.
   */
  function answerWith(status: number, body: unknown) {
    const fakeFetch: typeof fetch = async () => Response.json(body, { status })
    globalThis.fetch = fakeFetch
  }

  test('shows a refused reader no OrgUnits, but keeps session-policy, server, and network failures as errors', async () => {
    answerWith(403, { code: 'WorkspaceRoleDenied', message: 'Guests cannot read the OrgUnit structure.' })
    expect(await readOrgStructureForDisplay('token')).toEqual({ orgUnits: [], teamAssignments: [], revision: 0 })

    answerWith(503, { code: 'OrgStructureUnavailable', message: 'Unavailable' })
    await expect(readOrgStructureForDisplay('token')).rejects.toBeInstanceOf(ProjectDirectoryApiError)

    answerWith(403, { code: 'EnterpriseSessionIdleTimeout', message: 'Sign in again.' })
    await expect(readOrgStructureForDisplay('token')).rejects.toMatchObject({ status: 403, code: 'EnterpriseSessionIdleTimeout' })

    answerWith(403, { code: 'EnterpriseSessionIpDenied', message: 'Source IP is not allowed.' })
    await expect(readOrgStructureForDisplay('token')).rejects.toMatchObject({ status: 403, code: 'EnterpriseSessionIpDenied' })

    const failingFetch: typeof fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    globalThis.fetch = failingFetch
    await expect(readOrgStructureForDisplay('token')).rejects.toBeInstanceOf(TypeError)
  })

  test('tells the reader the OrgUnit roll-up is missing and offers the retry', () => {
    const html = renderToStaticMarkup(
      <PortfolioDashboardView
        canSaveSnapshot={false}
        compareMonthOptions={[]}
        isOrgStructureUnavailable
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
    expect(html).toContain(createTranslator('en')('portfolioDashboard.error.orgStructure'))
    expect(html).toContain('data-testid="portfolio-retry"')
    expect(html).not.toContain('portfolio-org-units')
  })

  test('tells an administrator that OrgUnits are missing from the scope choices', () => {
    const html = renderToStaticMarkup(<OrgUnitScopesUnavailableNotice locale="ja" onRetry={() => undefined} />)
    expect(html).toContain(createTranslator('ja')('security.scope.orgUnitsUnavailable'))
    expect(html).toContain(createTranslator('ja')('security.action.retryLoad'))
  })
})

test('offers OrgUnits as security scopes named by their path', () => {
  const options = createWorkspaceSecurityScopeOptions(teams, 'Workspace', structure.orgUnits)
  expect(options.filter((option) => option.type === 'org-unit').map((option) => option.name)).toEqual(['Sales', 'Sales / East', 'Engineering'])
  expect(createWorkspaceSecurityScopeOptions(teams, 'Workspace').some((option) => option.type === 'org-unit')).toBe(false)
})
