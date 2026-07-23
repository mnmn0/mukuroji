import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { getWorkItemConfiguration } from '../api/configuration'

/**
 * Result of loading Work Item configurations for multiple Teams.
 */
export type TeamWorkItemConfigurationLoadResult = {
  /** Resolved configurations indexed by Team ID. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Load errors also used to evaluate Enterprise session policy. */
  errors: unknown[]
  /** Team IDs whose configurations could not be loaded. */
  failedTeamIds: string[]
}

/**
 * Loads Work Item configurations for multiple Teams.
 *
 * @param accessToken - Access token used by the Work Item configuration API.
 * @param teamIds - Team IDs whose configurations should be loaded.
 * @returns Configurations, failed Team IDs, and load errors.
 */
export async function loadTeamWorkItemConfigurations(
  accessToken: string,
  teamIds: readonly string[],
): Promise<TeamWorkItemConfigurationLoadResult> {
  const results = await Promise.allSettled(
    teamIds.map(async (teamId) => ({
      configuration: await getWorkItemConfiguration(accessToken, { kind: 'team', teamId }),
      teamId,
    })),
  )

  const configurationsByTeam: Record<string, ResolvedWorkItemConfiguration> = {}
  const errors: unknown[] = []
  const failedTeamIds: string[] = []

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      configurationsByTeam[result.value.teamId] = result.value.configuration
      continue
    }

    errors.push(result.reason)
    const failedTeamId = teamIds[index]

    if (failedTeamId) {
      failedTeamIds.push(failedTeamId)
    }
  }

  return {
    configurationsByTeam,
    errors,
    failedTeamIds,
  }
}
