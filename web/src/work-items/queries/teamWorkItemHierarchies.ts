import type { TeamWorkItemHierarchyNode } from '@mukuroji/contracts'
import { getTeamWorkItemHierarchy } from '../api/hierarchy'

/** Hierarchies read for several Teams at once. */
export type TeamWorkItemHierarchies = {
  /** Hierarchy nodes in outline order, by Team ID, for the Teams that could be read. */
  nodesByTeam: ReadonlyMap<string, readonly TeamWorkItemHierarchyNode[]>
  /** Why each Team that could not be read failed, by Team ID. */
  errorsByTeam: ReadonlyMap<string, unknown>
}

/**
 * Reads the hierarchies of several Teams, keeping the ones that load when others fail.
 *
 * A Team can fail on its own, for example with `413` when it is too large for one tree, so one
 * failure never hides the WBS numbers of the other Teams.
 *
 * @param teamIds - Teams whose hierarchies are read.
 * @param accessToken - Access token sent as the bearer token.
 * @returns The hierarchies read and the failure of each other Team.
 */
export async function loadTeamWorkItemHierarchies(
  teamIds: readonly string[],
  accessToken: string,
): Promise<TeamWorkItemHierarchies> {
  const results = await Promise.allSettled(
    teamIds.map((teamId) => getTeamWorkItemHierarchy(teamId, accessToken)),
  )
  const nodesByTeam = new Map<string, readonly TeamWorkItemHierarchyNode[]>()
  const errorsByTeam = new Map<string, unknown>()
  results.forEach((result, index) => {
    const teamId = teamIds[index]
    if (teamId === undefined) return
    if (result.status === 'fulfilled') nodesByTeam.set(teamId, result.value.nodes)
    else errorsByTeam.set(teamId, result.reason)
  })
  return { nodesByTeam, errorsByTeam }
}
