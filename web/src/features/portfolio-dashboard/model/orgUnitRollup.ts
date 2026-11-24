import {
  listOrgUnitTeamIds,
  type OrgStructure,
  type PortfolioProjectWorkItems,
} from '@mukuroji/contracts'
import { listOrgUnitTreeRows } from '../../../projects/model/orgStructure'
import type { PortfolioDashboardRow } from './portfolioDashboard'

/** Totals of the Teams and Projects under one OrgUnit, its descendants included. */
export type PortfolioOrgUnitRollupRow = {
  /** OrgUnit identifier. */
  orgUnitId: string
  /** OrgUnit name. */
  name: string
  /** Level below the top, 0 for a top-level OrgUnit. */
  depth: number
  /** Teams in the OrgUnit and the OrgUnits below it. */
  teamCount: number
  /** Distinct Projects of those Teams that the reader may read. */
  projectCount: number
  /** Projects reported off track. */
  offTrackCount: number
  /** Work Item counts summed over those Projects. */
  workItems: PortfolioProjectWorkItems
}

/** Roll-up of the portfolio by OrgUnit. */
export type PortfolioOrgUnitRollup = {
  /** One row per OrgUnit, parents before children. */
  rows: PortfolioOrgUnitRollupRow[]
  /** Totals of the Teams that belong to no OrgUnit, when there are any. */
  unassigned?: Omit<PortfolioOrgUnitRollupRow, 'orgUnitId' | 'name' | 'depth'>
}

/**
 * Sums the portfolio rows of each OrgUnit, counting every Project once even when several Teams
 * under the OrgUnit share it.
 *
 * @param rows - Portfolio rows of every Team the reader could read.
 * @param teamIds - Directory Teams, so Teams without readable Projects still count.
 * @param structure - OrgUnit tree and Team memberships.
 * @returns The roll-up; empty rows when the Workspace has no OrgUnits.
 */
export function createPortfolioOrgUnitRollup(
  rows: readonly PortfolioDashboardRow[],
  teamIds: readonly string[],
  structure: Pick<OrgStructure, 'orgUnits' | 'teamAssignments'>,
): PortfolioOrgUnitRollup {
  if (structure.orgUnits.length === 0) return { rows: [] }
  const knownTeamIds = new Set(teamIds)
  const rollupRows = listOrgUnitTreeRows(structure.orgUnits).map(({ orgUnit, depth }) => ({
    orgUnitId: orgUnit.id,
    name: orgUnit.name,
    depth,
    ...summarizeTeams(rows, new Set(listOrgUnitTeamIds(structure, orgUnit.id).filter((teamId) => knownTeamIds.has(teamId)))),
  }))
  const assignedTeamIds = new Set(structure.teamAssignments.map((assignment) => assignment.teamId))
  const unassignedTeamIds = new Set(teamIds.filter((teamId) => !assignedTeamIds.has(teamId)))
  return {
    rows: rollupRows,
    ...(unassignedTeamIds.size > 0 ? { unassigned: summarizeTeams(rows, unassignedTeamIds) } : {}),
  }
}

/**
 * Lists the Teams under an OrgUnit, for narrowing the dashboard to it.
 *
 * @param structure - OrgUnit tree and Team memberships.
 * @param orgUnitId - Chosen OrgUnit, or `all`.
 * @returns The Team identifiers, or undefined when every Team is shown.
 */
export function resolvePortfolioOrgUnitTeamIds(
  structure: Pick<OrgStructure, 'orgUnits' | 'teamAssignments'>,
  orgUnitId: string,
): ReadonlySet<string> | undefined {
  if (orgUnitId === 'all' || !structure.orgUnits.some((orgUnit) => orgUnit.id === orgUnitId)) return undefined
  return new Set(listOrgUnitTeamIds(structure, orgUnitId))
}

/**
 * Sums the rows of a set of Teams.
 *
 * @param rows - Portfolio rows.
 * @param teamIds - Teams to include.
 * @returns Team and Project counts and Work Item totals.
 */
function summarizeTeams(rows: readonly PortfolioDashboardRow[], teamIds: ReadonlySet<string>) {
  const projects = new Map<string, PortfolioDashboardRow>()
  for (const row of rows) {
    if (!teamIds.has(row.teamId) || projects.has(row.projectId)) continue
    projects.set(row.projectId, row)
  }
  const workItems: PortfolioProjectWorkItems = { total: 0, open: 0, completed: 0, overdueOpen: 0 }
  let offTrackCount = 0
  for (const row of projects.values()) {
    workItems.total += row.metrics.workItems.total
    workItems.open += row.metrics.workItems.open
    workItems.completed += row.metrics.workItems.completed
    workItems.overdueOpen += row.metrics.workItems.overdueOpen
    if (row.health === 'off-track') offTrackCount += 1
  }
  return { teamCount: teamIds.size, projectCount: projects.size, offTrackCount, workItems }
}
