import { AgentTaskError, type AgentRunFilters, type AgentWorkItemApi } from './work-item-api'

/** Active runs one hook call renews at most per Team; a member rarely holds more than a few. */
export const HOOK_HEARTBEAT_MAX_RUNS_PER_TEAM = 20

/** Team API a hook heartbeat renews runs through. */
export type HookHeartbeatTeam = {
  /** Team ID. */
  teamId: string
  /** Run reads and heartbeats of the Team. */
  api: Pick<AgentWorkItemApi, 'listActiveRuns' | 'heartbeat'>
}

/** Counts of one hook heartbeat. */
export type HookHeartbeatResult = {
  /** Runs whose lease was extended. */
  renewed: number
  /** Runs that already received a heartbeat in the last 10 seconds; their lease is current. */
  recent: number
  /** Teams or runs that could not be read or renewed. */
  failed: number
}

/**
 * Extends the lease of every active run this instance started, as an agent hook calls it between
 * tool calls. A heartbeat refused because one arrived within the last 10 seconds counts as
 * recent, since the lease was just extended. Failures are counted, never thrown, so a hook never
 * blocks the agent.
 *
 * @param teams - Configured Teams and their APIs.
 * @param owner - Assignee and instance of this agent process.
 * @param owner.assigneeUserId - Configured assignee.
 * @param owner.instanceId - Instance ID the runs were started with.
 * @returns Counts of the call.
 */
export async function heartbeatOwnRuns(
  teams: readonly HookHeartbeatTeam[],
  owner: Required<AgentRunFilters>,
): Promise<HookHeartbeatResult> {
  const result: HookHeartbeatResult = { renewed: 0, recent: 0, failed: 0 }
  for (const { api } of teams) {
    let runs
    try {
      runs = (await api.listActiveRuns(owner)).items
        .filter((run) => run.assigneeUserId === owner.assigneeUserId && run.state === 'active')
        .slice(0, HOOK_HEARTBEAT_MAX_RUNS_PER_TEAM)
    } catch {
      result.failed += 1
      continue
    }
    for (const run of runs) {
      try {
        await api.heartbeat(run.runId, owner.instanceId)
        result.renewed += 1
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'rate_limited') result.recent += 1
        else result.failed += 1
      }
    }
  }
  return result
}
